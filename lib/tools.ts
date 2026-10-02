import { tool } from 'ai';
import { z } from 'zod';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { enviarCorreoLibre, fechaLegible, type Adjunto as AdjuntoCorreo } from '@/lib/email';
import { CATEGORIAS_GASTO, formatearMonto, resumirGastos } from '@/lib/gastos';
import {
  consultaFlexible,
  extraerTexto,
  fragmentar,
  MAX_CARACTERES,
  MAX_DOCUMENTOS,
  tipoSoportado,
} from '@/lib/documentos';
import { formatearEnZona, horaLocalAUtc, partesLocales } from '@/lib/zona-horaria';
import { REPETICIONES, textoRepeticion } from '@/lib/repeticion';
import { buscarLugar, pronostico } from '@/lib/clima';
import { eventosEntre, probarCalendario, validarEnlace } from '@/lib/calendario';
import { BUCKET_ADJUNTOS, MAX_BYTES_CORREO } from '@/lib/adjuntos';
import type { Ajustes } from '@/lib/contexto';
import { randomBytes } from 'node:crypto';
import {
  borrarEventoGoogle,
  crearEventoGoogle,
  desconectarGoogle,
  googleConectado,
  googleConfigurado,
  leerEventoGoogle,
  listarEventosGoogle,
  modificarEventoGoogle,
  momento,
  type EventoGoogle,
} from '@/lib/google';
import { URL_APP } from '@/lib/marca';

/** Tope de preferencias guardadas por persona. */
const MAX_PREFERENCIAS = 40;

/** Tope de apodos por contacto. */
const MAX_APODOS = 10;

/** Tope de tareas que una persona puede asignar a otras en 24 horas. */
const LIMITE_ASIGNACIONES_DIARIO = 30;

/** "2026-10-05T15:00" + 60 minutos, en la hora local de la zona. */
function sumarMinutosLocal(fechaHora: string, minutos: number, zona: string): string | null {
  const instante = horaLocalAUtc(fechaHora, zona);
  if (!instante) return null;
  const p = partesLocales(new Date(instante.getTime() + minutos * 60_000), zona);
  return `${p.fecha}T${p.hora.slice(0, 5)}`;
}

/** Evento de Google para mostrarle al modelo, con las horas en la zona del usuario. */
function eventoLegible(e: EventoGoogle, zona: string) {
  return {
    id: e.id,
    titulo: e.titulo,
    cuando: e.todo_el_dia ? `${e.inicio} (todo el día)` : formatearEnZona(new Date(e.inicio), zona),
    hasta: e.todo_el_dia ? undefined : formatearEnZona(new Date(e.fin), zona),
    lugar: e.lugar,
    invitados: e.invitados,
  };
}

/** Personas del equipo con cuenta creada: email -> id. */
async function miembrosDelEquipo(): Promise<Map<string, string>> {
  const admin = createAdminClient();
  const [{ data: invitados }, { data: usuarios }] = await Promise.all([
    admin.from('invitaciones').select('email'),
    admin.auth.admin.listUsers({ perPage: 1000 }),
  ]);
  const invitadosSet = new Set((invitados ?? []).map((i) => i.email.toLowerCase()));
  const miembros = new Map<string, string>();
  for (const u of usuarios?.users ?? []) {
    const email = u.email?.toLowerCase();
    if (email && invitadosSet.has(email)) miembros.set(email, u.id);
  }
  return miembros;
}

/** Campos de repetición que comparten tareas y recordatorios. */
const esquemaRepeticion = {
  repeticion: z
    .enum(REPETICIONES)
    .nullable()
    .optional()
    .describe(
      'Si se repite: "diaria", "laborables" (lunes a viernes), "semanal" o "mensual". null para que deje de repetirse.'
    ),
  dias_semana: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .optional()
    .describe(
      'Solo con "semanal": días en que se repite, 0 = domingo ... 6 = sábado. Ej. "todos los lunes y jueves" = [1, 4]. Sin días, cada 7 días desde la fecha.'
    ),
};

/** Tope de destinatarios por correo, para evitar envíos masivos. */
export const MAX_DESTINATARIOS = 10;

/** Tope de correos (contando cada destinatario) por usuario en 24 horas. */
export const LIMITE_CORREOS_DIARIO = 50;

/** Escapa comodines de LIKE para que un nombre se compare literalmente. */
function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => '\\' + c);
}

function normalizarEmails(emails: string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()))];
}

/** true si el correo va únicamente al email de la cuenta (no necesita aprobación). */
export function soloAlPropioEmail(
  destinatarios: string[] | undefined,
  userEmail: string | undefined
): boolean {
  if (!destinatarios || destinatarios.length === 0) return true;
  if (!userEmail) return false;
  const propio = userEmail.toLowerCase();
  return normalizarEmails(destinatarios).every((e) => e === propio);
}

/**
 * `crearHerramientas(userId)` devuelve las herramientas ya atadas a un
 * usuario. Así, cada operación (crear, listar, completar tarea) queda
 * automáticamente limitada a las tareas de esa persona.
 */
export function crearHerramientas(
  userId: string,
  userEmail: string | undefined,
  zonaHoraria: string,
  esAdmin = false,
  ajustes: Ajustes | null = null
) {
  const soloAdmin = { ok: false as const, error: 'Solo un administrador del equipo puede hacer esto.' };

  return {
    crear_tarea: tool({
      description:
        'Crea una nueva tarea para el usuario, opcionalmente con fecha límite. Puede repetirse ("pagar el alquiler todos los meses"): al completarla aparece sola la siguiente.',
      inputSchema: z.object({
        titulo: z.string().describe('Título breve de la tarea'),
        descripcion: z.string().optional().describe('Detalles adicionales, opcional'),
        fecha_limite: z
          .string()
          .optional()
          .describe('Fecha límite en formato YYYY-MM-DD. Obligatoria si se repite: es la primera vez.'),
        ...esquemaRepeticion,
      }),
      execute: async ({ titulo, descripcion, fecha_limite, repeticion, dias_semana }) => {
        if (repeticion && !fecha_limite) {
          return { ok: false, error: 'Una tarea que se repite necesita la fecha de la primera vez.' };
        }
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('tareas')
          .insert({
            user_id: userId,
            titulo,
            descripcion,
            fecha_limite,
            repeticion: repeticion ?? null,
            dias_semana: repeticion === 'semanal' && dias_semana?.length ? dias_semana : null,
          })
          .select()
          .single();

        if (error) return { ok: false, error: error.message };
        return { ok: true, tarea: data };
      },
    }),

    listar_tareas: tool({
      description: 'Lista las tareas del usuario. Por defecto solo las pendientes.',
      inputSchema: z.object({
        incluir_completadas: z.boolean().optional().default(false),
      }),
      execute: async ({ incluir_completadas }) => {
        const supabase = await createClient();
        let query = supabase.from('tareas').select('*').eq('user_id', userId);
        if (!incluir_completadas) query = query.eq('completada', false);

        const { data, error } = await query.order('fecha_limite', {
          ascending: true,
          nullsFirst: false,
        });

        if (error) return { ok: false, error: error.message };
        return { ok: true, tareas: data };
      },
    }),

    completar_tarea: tool({
      description: 'Marca una tarea como completada, dado su id.',
      inputSchema: z.object({ id: z.string().describe('El id de la tarea a completar') }),
      execute: async ({ id }) => {
        const supabase = await createClient();
        const { error } = await supabase
          .from('tareas')
          .update({ completada: true })
          .eq('id', id)
          .eq('user_id', userId);

        if (error) return { ok: false, error: error.message };
        return { ok: true };
      },
    }),

    editar_tarea: tool({
      description:
        'Modifica una tarea existente del usuario (título, descripción, fecha límite o repetición), dado su id. Solo se cambian los campos que se pasan.',
      inputSchema: z.object({
        id: z.string().describe('El id de la tarea a editar'),
        titulo: z.string().optional().describe('Nuevo título'),
        descripcion: z.string().optional().describe('Nueva descripción'),
        fecha_limite: z
          .string()
          .nullable()
          .optional()
          .describe('Nueva fecha límite YYYY-MM-DD, o null para quitarla'),
        ...esquemaRepeticion,
      }),
      execute: async ({ id, titulo, descripcion, fecha_limite, repeticion, dias_semana }) => {
        const cambios: Record<string, unknown> = {};
        if (titulo !== undefined) cambios.titulo = titulo;
        if (descripcion !== undefined) cambios.descripcion = descripcion;
        if (repeticion !== undefined) {
          cambios.repeticion = repeticion;
          cambios.dias_semana = repeticion === 'semanal' && dias_semana?.length ? dias_semana : null;
        }
        if (fecha_limite !== undefined) {
          cambios.fecha_limite = fecha_limite;
          // Con fecha nueva, los avisos escalonados empiezan de cero.
          cambios.ultimo_aviso_dia = null;
        }
        if (Object.keys(cambios).length === 0) {
          return { ok: false, error: 'No se indicó ningún cambio.' };
        }

        const supabase = await createClient();
        const { data, error } = await supabase
          .from('tareas')
          .update(cambios)
          .eq('id', id)
          .eq('user_id', userId)
          .select()
          .single();

        if (error) return { ok: false, error: error.message };
        return { ok: true, tarea: data };
      },
    }),

    borrar_tarea: tool({
      description:
        'Borra definitivamente una tarea del usuario, dado su id. El usuario debe aprobarlo con un botón.',
      inputSchema: z.object({
        id: z.string().describe('El id de la tarea a borrar'),
        titulo: z.string().describe('El título de la tarea, para mostrarlo en la confirmación'),
      }),
      execute: async ({ id }) => {
        const supabase = await createClient();
        const { error } = await supabase
          .from('tareas')
          .delete()
          .eq('id', id)
          .eq('user_id', userId);

        if (error) return { ok: false, error: error.message };
        return { ok: true, borrada: true };
      },
    }),

    guardar_contacto: tool({
      description:
        'Guarda (o actualiza) un contacto en la libreta del usuario: un nombre y su email. Usar solo con emails que el usuario escribió explícitamente.',
      inputSchema: z.object({
        nombre: z.string().min(1).max(80).describe('Nombre del contacto, ej. "Ana" o "mi jefe"'),
        email: z.email().describe('Email del contacto'),
      }),
      execute: async ({ nombre, email }) => {
        const supabase = await createClient();
        const limpio = nombre.trim();
        const emailNormal = email.trim().toLowerCase();

        const { data: existente } = await supabase
          .from('contactos')
          .select('id')
          .eq('user_id', userId)
          .ilike('nombre', escaparLike(limpio))
          .maybeSingle();

        const { error } = existente
          ? await supabase.from('contactos').update({ email: emailNormal }).eq('id', existente.id)
          : await supabase
              .from('contactos')
              .insert({ user_id: userId, nombre: limpio, email: emailNormal });

        if (error) return { ok: false, error: error.message };
        return { ok: true, contacto: { nombre: limpio, email: emailNormal } };
      },
    }),

    agregar_apodo: tool({
      description:
        'Anota otra forma en que el usuario llama a un contacto que ya existe ("Anita" o "mi hermana" para Ana). Usar sola, sin preguntar, cuando quedó claro a quién se refería.',
      inputSchema: z.object({
        nombre: z.string().describe('Nombre del contacto tal como está guardado'),
        apodo: z.string().min(1).max(40).describe('El apodo o forma de llamarlo'),
      }),
      execute: async ({ nombre, apodo }) => {
        const supabase = await createClient();
        const { data: contacto, error } = await supabase
          .from('contactos')
          .select('id, nombre, apodos')
          .eq('user_id', userId)
          .ilike('nombre', escaparLike(nombre.trim()))
          .maybeSingle();
        if (error) return { ok: false, error: error.message };
        if (!contacto) return { ok: false, error: `No hay ningún contacto llamado "${nombre}".` };

        const limpio = apodo.trim();
        const apodos: string[] = contacto.apodos ?? [];
        if (apodos.some((a) => a.toLowerCase() === limpio.toLowerCase())) {
          return { ok: true, ya_estaba: true };
        }
        if (apodos.length >= MAX_APODOS) {
          return { ok: false, error: `Ese contacto ya tiene ${MAX_APODOS} apodos.` };
        }
        const { error: errorGuardar } = await supabase
          .from('contactos')
          .update({ apodos: [...apodos, limpio] })
          .eq('id', contacto.id);
        if (errorGuardar) return { ok: false, error: errorGuardar.message };
        return { ok: true, apodo: { nombre: contacto.nombre, apodo: limpio } };
      },
    }),

    listar_contactos: tool({
      description:
        'Lista la libreta de contactos del usuario (nombre, email y apodos). Usar para averiguar el email de alguien que el usuario nombra.',
      inputSchema: z.object({}),
      execute: async () => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('contactos')
          .select('nombre, email, apodos')
          .eq('user_id', userId)
          .order('nombre');

        if (error) return { ok: false, error: error.message };
        return { ok: true, contactos: data };
      },
    }),

    borrar_contacto: tool({
      description: 'Borra un contacto de la libreta del usuario, por su nombre.',
      inputSchema: z.object({ nombre: z.string().describe('Nombre del contacto a borrar') }),
      execute: async ({ nombre }) => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('contactos')
          .delete()
          .eq('user_id', userId)
          .ilike('nombre', escaparLike(nombre.trim()))
          .select('nombre');

        if (error) return { ok: false, error: error.message };
        if (!data?.length) return { ok: false, error: `No hay ningún contacto llamado "${nombre}".` };
        return { ok: true };
      },
    }),

    enviar_correo: tool({
      description: `Envía por correo electrónico información que el usuario pidió (un resumen, su lista de tareas, una nota, etc.). Si no se indican destinatarios, se envía al email de la cuenta del usuario. Puede enviarse a hasta ${MAX_DESTINATARIOS} direcciones que el usuario haya escrito explícitamente; en ese caso el usuario debe aprobar el envío con un botón antes de que salga. Usar únicamente cuando el usuario pide explícitamente enviar un correo.`,
      inputSchema: z.object({
        destinatarios: z
          .array(z.email())
          .min(1)
          .max(MAX_DESTINATARIOS)
          .optional()
          .describe(
            'Emails de destino, tal cual los escribió el usuario. Omitir para enviarlo solo al usuario.'
          ),
        asunto: z.string().max(150).describe('Asunto breve del correo'),
        contenido: z
          .string()
          .max(8000)
          .describe('Cuerpo del correo en texto plano, con saltos de línea. Sin HTML.'),
        adjuntos: z
          .array(z.object({ nombre: z.string(), ruta: z.string() }))
          .max(5)
          .optional()
          .describe(
            'Archivos que el usuario adjuntó en el chat, con el nombre y la ruta exactos que aparecen en "[Adjuntos del usuario]". Nunca inventar rutas.'
          ),
      }),
      execute: async ({ destinatarios, asunto, contenido, adjuntos }) => {
        if (!userEmail) {
          return { ok: false, error: 'La cuenta no tiene un email vinculado.' };
        }
        const lista = destinatarios?.length ? normalizarEmails(destinatarios) : [userEmail];

        const supabase = await createClient();

        // Los archivos se bajan con la sesión del usuario: RLS impide leer
        // los de otra persona aunque el modelo pase una ruta ajena.
        const archivos: AdjuntoCorreo[] = [];
        let bytes = 0;
        for (const a of adjuntos ?? []) {
          if (!a.ruta.startsWith(`${userId}/`)) {
            return { ok: false, error: `El adjunto "${a.nombre}" no es de esta cuenta.` };
          }
          const { data: archivo, error: errorArchivo } = await supabase.storage
            .from(BUCKET_ADJUNTOS)
            .download(a.ruta);
          if (errorArchivo || !archivo) {
            return { ok: false, error: `No encontré el adjunto "${a.nombre}". Pedile que lo vuelva a adjuntar.` };
          }
          bytes += archivo.size;
          if (bytes > MAX_BYTES_CORREO) {
            return { ok: false, error: 'Los adjuntos pasan de 25 MB en total: mandalos en dos correos.' };
          }
          archivos.push({
            nombre: a.nombre,
            contenido: Buffer.from(await archivo.arrayBuffer()),
            tipo: archivo.type || undefined,
          });
        }
        const haceUnDia = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count, error: errorConteo } = await supabase
          .from('correos_enviados')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gte('created_at', haceUnDia);

        if (errorConteo) return { ok: false, error: errorConteo.message };
        const disponibles = LIMITE_CORREOS_DIARIO - (count ?? 0);
        if (lista.length > disponibles) {
          return {
            ok: false,
            error: `Límite diario alcanzado: se pueden enviar ${LIMITE_CORREOS_DIARIO} correos cada 24 horas y quedan ${Math.max(disponibles, 0)}.`,
          };
        }

        // Un envío por destinatario: nadie ve las direcciones de los demás.
        const resultados = await Promise.all(
          lista.map(async (destinatario) => ({
            destinatario,
            resultado: await enviarCorreoLibre({
              destinatario,
              asunto,
              contenido,
              remitenteHumano: userEmail,
              adjuntos: archivos,
            }),
          }))
        );

        const enviados = resultados.filter((r) => r.resultado.ok).map((r) => r.destinatario);
        if (enviados.length > 0) {
          await supabase
            .from('correos_enviados')
            .insert(enviados.map((destinatario) => ({ user_id: userId, destinatario })));
        }
        const fallidos = resultados
          .filter((r) => !r.resultado.ok)
          .map((r) => ({
            destinatario: r.destinatario,
            error: r.resultado.ok ? '' : r.resultado.error,
          }));

        if (enviados.length === 0) {
          return { ok: false, error: fallidos[0]?.error ?? 'No se envió ningún correo.', fallidos };
        }
        return {
          ok: true,
          enviado_a: enviados,
          fallidos,
          adjuntos: archivos.map((a) => a.nombre),
        };
      },
    }),

    programar_recordatorio: tool({
      description:
        'Programa un aviso para un momento exacto, con precisión de segundos ("recordame a las 6:45", "avisame en 30 segundos"). Puede repetirse ("todos los lunes a las 8"). La hora es la hora local del usuario.',
      inputSchema: z.object({
        mensaje: z.string().min(1).max(300).describe('Qué hay que recordarle, en pocas palabras'),
        cuando: z
          .string()
          .optional()
          .describe(
            'Fecha y hora local en formato YYYY-MM-DDTHH:mm o YYYY-MM-DDTHH:mm:ss, ej. 2026-09-29T06:45. Si se repite, es la primera vez.'
          ),
        dentro_de_segundos: z
          .number()
          .int()
          .min(5)
          .max(86_400)
          .optional()
          .describe(
            'En vez de "cuando": cuántos segundos desde ahora, para pedidos relativos cortos ("en 30 segundos" = 30, "en 2 minutos" = 120).'
          ),
        tarea_id: z
          .string()
          .optional()
          .describe('Id de la tarea relacionada, si el recordatorio es sobre una tarea existente'),
        ...esquemaRepeticion,
      }),
      execute: async ({ mensaje, cuando, dentro_de_segundos, tarea_id, repeticion, dias_semana }) => {
        const ahora = Date.now();
        const instante = dentro_de_segundos
          ? new Date(ahora + dentro_de_segundos * 1000)
          : cuando
            ? horaLocalAUtc(cuando, zonaHoraria)
            : null;
        if (!instante) {
          return {
            ok: false,
            error: 'Indicá "cuando" (YYYY-MM-DDTHH:mm[:ss]) o "dentro_de_segundos".',
          };
        }
        if (instante.getTime() < ahora - 60_000) {
          return {
            ok: false,
            error: `Esa hora (${formatearEnZona(instante, zonaHoraria)}) ya pasó.`,
          };
        }
        if (instante.getTime() > ahora + 366 * 24 * 60 * 60 * 1000) {
          return { ok: false, error: 'Solo se pueden programar recordatorios hasta un año adelante.' };
        }

        const supabase = await createClient();
        const { data, error } = await supabase
          .from('recordatorios')
          .insert({
            user_id: userId,
            tarea_id: tarea_id || null,
            mensaje,
            enviar_en: instante.toISOString(),
            zona_horaria: zonaHoraria,
            repeticion: repeticion ?? null,
            dias_semana: repeticion === 'semanal' && dias_semana?.length ? dias_semana : null,
          })
          .select('id, mensaje, enviar_en, repeticion, dias_semana')
          .single();

        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          recordatorio: {
            ...data,
            cuando_local: formatearEnZona(instante, zonaHoraria),
            se_repite: textoRepeticion(data.repeticion, data.dias_semana) || undefined,
          },
        };
      },
    }),

    listar_recordatorios: tool({
      description:
        'Lista los recordatorios con hora que todavía no se enviaron, incluidos los que se repiten.',
      inputSchema: z.object({}),
      execute: async () => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('recordatorios')
          .select('id, mensaje, enviar_en, repeticion, dias_semana')
          .eq('user_id', userId)
          .is('enviado_en', null)
          .order('enviar_en');

        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          recordatorios: (data ?? []).map((r) => ({
            ...r,
            cuando_local: formatearEnZona(new Date(r.enviar_en), zonaHoraria),
            se_repite: textoRepeticion(r.repeticion, r.dias_semana) || undefined,
          })),
        };
      },
    }),

    cancelar_recordatorio: tool({
      description:
        'Cancela un recordatorio que todavía no se envió, dado su id. Si se repite, se cancelan también todas las repeticiones futuras.',
      inputSchema: z.object({ id: z.string().describe('El id del recordatorio') }),
      execute: async ({ id }) => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('recordatorios')
          .delete()
          .eq('id', id)
          .eq('user_id', userId)
          .is('enviado_en', null)
          .select('id');

        if (error) return { ok: false, error: error.message };
        if (!data?.length) return { ok: false, error: 'No existe o ya se envió.' };
        return { ok: true, cancelado: true };
      },
    }),

    fecha_hora_actual: tool({
      description:
        'Devuelve la fecha y hora actual en la zona horaria del usuario. Usar siempre que haya que calcular una fecha relativa como "el viernes" o "en dos semanas".',
      inputSchema: z.object({}),
      execute: async () => {
        const ahora = new Date();
        const local = partesLocales(ahora, zonaHoraria);
        return {
          fecha_local: new Intl.DateTimeFormat('es', {
            timeZone: zonaHoraria,
            dateStyle: 'full',
            timeStyle: 'medium',
            hour12: true,
          }).format(ahora),
          // Mismo formato que fecha_limite (YYYY-MM-DD) y que "cuando" de los recordatorios.
          hoy: local.fecha,
          ahora_local: `${local.fecha}T${local.hora}`,
          zona_horaria: zonaHoraria,
        };
      },
    }),

    consultar_clima: tool({
      description:
        'Clima actual y pronóstico de hasta 7 días. Sin "lugar", usa la ubicación que compartió el usuario. Devuelve llevar_paraguas por día.',
      inputSchema: z.object({
        lugar: z
          .string()
          .optional()
          .describe('Ciudad, ej. "Bogotá" o "Rosario, Argentina". Omitir para usar la ubicación del usuario.'),
        dias: z.number().int().min(1).max(7).optional().default(1).describe('Cuántos días de pronóstico'),
      }),
      execute: async ({ lugar, dias }) => {
        try {
          const destino = lugar
            ? await buscarLugar(lugar)
            : ajustes?.latitud != null && ajustes.longitud != null
              ? { nombre: ajustes.lugar ?? 'tu ubicación', latitud: ajustes.latitud, longitud: ajustes.longitud }
              : null;
          if (!destino) {
            return {
              ok: false,
              error: lugar
                ? `No encontré "${lugar}". Probá con la ciudad y el país.`
                : 'No sé dónde está el usuario: pedile la ciudad o que toque "Usar mi ubicación" en el panel.',
            };
          }
          return { ok: true, clima: await pronostico(destino, dias) };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'El servicio del clima no respondió.' };
        }
      },
    }),

    recordar_preferencia: tool({
      description:
        'Guarda algo que el usuario quiere que recuerdes siempre (gustos, costumbres, cómo quiere que le hables, datos personales que te pidió recordar). Para el día/hora del resumen semanal o el aviso de lluvia usá configurar_avisos.',
      inputSchema: z.object({
        texto: z
          .string()
          .min(3)
          .max(300)
          .describe('La preferencia en una frase en tercera persona, ej. "Prefiere los recordatorios a las 8 de la mañana"'),
      }),
      execute: async ({ texto }) => {
        const supabase = await createClient();
        const { count } = await supabase
          .from('preferencias')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId);
        if ((count ?? 0) >= MAX_PREFERENCIAS) {
          return {
            ok: false,
            error: `Ya hay ${MAX_PREFERENCIAS} preferencias guardadas: hay que olvidar alguna primero.`,
          };
        }
        const { data, error } = await supabase
          .from('preferencias')
          .insert({ user_id: userId, texto: texto.trim() })
          .select('id, texto')
          .single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, preferencia: data };
      },
    }),

    olvidar_preferencia: tool({
      description:
        'Borra una preferencia guardada, dado su id (aparece entre corchetes en "Preferencias guardadas").',
      inputSchema: z.object({ id: z.string().describe('El id de la preferencia') }),
      execute: async ({ id }) => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('preferencias')
          .delete()
          .eq('id', id)
          .eq('user_id', userId)
          .select('texto');
        if (error) return { ok: false, error: error.message };
        if (!data?.length) return { ok: false, error: 'No existe esa preferencia.' };
        return { ok: true, olvidada: data[0].texto };
      },
    }),

    configurar_avisos: tool({
      description:
        'Cambia los avisos automáticos: el "buenos días" de cada mañana, el resumen semanal, el aviso de lluvia, el horario de no molestar y cuántos minutos antes de cada evento avisar. Solo se cambian los campos que se pasan.',
      inputSchema: z.object({
        resumen_semanal: z.boolean().optional().describe('true para recibirlo, false para dejar de recibirlo'),
        resumen_dia: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe('Día del resumen: 0 = domingo, 1 = lunes ... 6 = sábado'),
        resumen_hora: z.number().int().min(0).max(23).optional().describe('Hora local del resumen, 0 a 23'),
        aviso_lluvia: z
          .boolean()
          .optional()
          .describe(
            'Aviso suelto a las 7 de la mañana si va a llover (necesita la ubicación). Con el buenos días activado, la lluvia ya viene ahí.'
          ),
        buenos_dias: z
          .boolean()
          .optional()
          .describe('true para recibir cada mañana el resumen del día (clima, eventos, tareas y avisos de hoy)'),
        buenos_dias_hora: z
          .number()
          .int()
          .min(0)
          .max(23)
          .optional()
          .describe('Hora local del buenos días, 0 a 23 (por defecto 7)'),
        no_molestar: z
          .boolean()
          .optional()
          .describe('true: de noche no llegan avisos automáticos (los recordatorios con hora exacta llegan igual)'),
        no_molestar_desde: z.number().int().min(0).max(23).optional().describe('Hora local en que empieza, 0 a 23 (por defecto 22)'),
        no_molestar_hasta: z.number().int().min(0).max(23).optional().describe('Hora local en que termina, 0 a 23 (por defecto 7)'),
        aviso_evento_minutos: z
          .number()
          .int()
          .min(0)
          .max(240)
          .optional()
          .describe('Minutos antes de cada evento del calendario para avisar. 0 lo apaga (por defecto 30)'),
      }),
      execute: async (cambios) => {
        const limpios = Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== undefined));
        if (Object.keys(limpios).length === 0) return { ok: false, error: 'No se indicó ningún cambio.' };
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('ajustes')
          .update({ ...limpios, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .select(
            'resumen_semanal, resumen_dia, resumen_hora, aviso_lluvia, buenos_dias, buenos_dias_hora, no_molestar, no_molestar_desde, no_molestar_hasta, aviso_evento_minutos, latitud'
          )
          .single();
        if (error) return { ok: false, error: error.message };
        const { latitud, ...ajustesNuevos } = data;
        return {
          ok: true,
          ajustes: ajustesNuevos,
          ...((data.aviso_lluvia || data.buenos_dias) && latitud == null
            ? { falta: 'Para que el clima aparezca tiene que tocar "Usar mi ubicación" en el panel.' }
            : {}),
        };
      },
    }),

    conectar_calendario: tool({
      description:
        'Conecta el calendario del usuario (solo lectura) con la "dirección secreta en formato iCal" que te pegue. Comprueba que funcione antes de guardarla.',
      inputSchema: z.object({
        enlace: z.string().describe('El enlace iCal (.ics) tal cual lo pegó el usuario'),
      }),
      execute: async ({ enlace }) => {
        const url = validarEnlace(enlace);
        if (!url) {
          return { ok: false, error: 'Ese enlace no es válido: tiene que empezar con https:// (o webcal://).' };
        }
        try {
          const eventos = await probarCalendario(url.toString(), zonaHoraria);
          const supabase = await createClient();
          const { error } = await supabase
            .from('ajustes')
            .update({ calendario_ics: url.toString(), updated_at: new Date().toISOString() })
            .eq('user_id', userId);
          if (error) return { ok: false, error: error.message };
          return { ok: true, conectado: true, eventos_proximos_30_dias: eventos };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'No se pudo leer el calendario.' };
        }
      },
    }),

    ver_calendario: tool({
      description:
        'Lista los eventos del calendario conectado del usuario en un rango de días. Usar antes de programar algo en un día concreto, o cuando pregunte qué tiene.',
      inputSchema: z.object({
        desde: z.string().optional().describe('Primer día YYYY-MM-DD (por defecto, hoy)'),
        dias: z.number().int().min(1).max(31).optional().default(7).describe('Cuántos días mirar'),
      }),
      execute: async ({ desde, dias }) => {
        // Con Google conectado se lee directo de la API: está al día al instante.
        if (await googleConectado(userId)) {
          const inicioG = horaLocalAUtc(`${desde ?? partesLocales(new Date(), zonaHoraria).fecha}T00:00`, zonaHoraria);
          if (!inicioG) return { ok: false, error: 'La fecha "desde" debe ser YYYY-MM-DD.' };
          try {
            const eventos = await listarEventosGoogle(userId, inicioG, new Date(inicioG.getTime() + dias * 86_400_000));
            return { ok: true, eventos: eventos.map((e) => eventoLegible(e, zonaHoraria)) };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        const supabase = await createClient();
        const { data } = await supabase
          .from('ajustes')
          .select('calendario_ics')
          .eq('user_id', userId)
          .maybeSingle();
        if (!data?.calendario_ics) {
          return {
            ok: false,
            error:
              'No hay calendario conectado. Explicale cómo conseguir la dirección secreta en formato iCal.',
          };
        }
        const inicio = horaLocalAUtc(`${desde ?? partesLocales(new Date(), zonaHoraria).fecha}T00:00`, zonaHoraria);
        if (!inicio) return { ok: false, error: 'La fecha "desde" debe ser YYYY-MM-DD.' };
        try {
          const eventos = await eventosEntre(
            data.calendario_ics,
            inicio,
            new Date(inicio.getTime() + dias * 86_400_000),
            zonaHoraria
          );
          return { ok: true, eventos };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'No se pudo leer el calendario.' };
        }
      },
    }),

    enlace_calendario_tareas: tool({
      description:
        'Da el enlace secreto para ver las tareas y avisos de QIR dentro de Google Calendar, Apple o Outlook (suscripción de solo lectura). Con regenerar: true crea uno nuevo y el anterior deja de funcionar.',
      inputSchema: z.object({
        regenerar: z
          .boolean()
          .optional()
          .default(false)
          .describe('true solo si pide un enlace nuevo porque compartió el anterior o quiere cortarlo'),
      }),
      execute: async ({ regenerar }) => {
        const supabase = await createClient();
        const { data } = await supabase
          .from('ajustes')
          .select('calendario_token')
          .eq('user_id', userId)
          .maybeSingle();
        let token = data?.calendario_token as string | null | undefined;
        if (!token || regenerar) {
          token = randomBytes(24).toString('base64url');
          const { error } = await supabase
            .from('ajustes')
            .update({ calendario_token: token, updated_at: new Date().toISOString() })
            .eq('user_id', userId);
          if (error) return { ok: false, error: error.message };
        }
        return {
          ok: true,
          enlace: `${URL_APP}/api/calendario/${token}`,
          nuevo: regenerar || !data?.calendario_token,
        };
      },
    }),

    desconectar_calendario: tool({
      description: 'Desconecta el calendario: QIR deja de leerlo y borra el enlace guardado.',
      inputSchema: z.object({}),
      execute: async () => {
        const supabase = await createClient();
        const { error } = await supabase
          .from('ajustes')
          .update({ calendario_ics: null, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
        if (error) return { ok: false, error: error.message };
        return { ok: true, desconectado: true };
      },
    }),

    // ---- Equipo: tareas asignadas a otras personas ----

    companeros_de_equipo: tool({
      description:
        'Lista los emails de las personas del equipo que ya tienen cuenta en QIR, para asignarles tareas. Combinalo con los contactos para saber quién es quién.',
      inputSchema: z.object({}),
      execute: async () => {
        const miembros = await miembrosDelEquipo();
        return {
          ok: true,
          equipo: [...miembros.keys()].filter((e) => e !== userEmail?.toLowerCase()),
        };
      },
    }),

    asignar_tarea: tool({
      description:
        'Le asigna una tarea a otra persona del equipo: le aparece en su panel y le llega un aviso. Cuando la complete, al usuario le llega otro aviso. Solo para personas del equipo con cuenta (ver companeros_de_equipo).',
      inputSchema: z.object({
        email: z.email().describe('Email de la persona del equipo que recibe la tarea'),
        titulo: z.string().min(1).max(200).describe('Título breve de la tarea'),
        descripcion: z.string().max(1000).optional().describe('Detalles, opcional'),
        fecha_limite: z.string().optional().describe('Fecha límite YYYY-MM-DD, si aplica'),
      }),
      execute: async ({ email, titulo, descripcion, fecha_limite }) => {
        const destino = email.trim().toLowerCase();
        if (destino === userEmail?.toLowerCase()) {
          return { ok: false, error: 'Es para el propio usuario: usá crear_tarea.' };
        }
        const miembros = await miembrosDelEquipo();
        const destinoId = miembros.get(destino);
        if (!destinoId) {
          return {
            ok: false,
            error: `${destino} no es del equipo o todavía no creó su cuenta. Un administrador puede invitarlo.`,
          };
        }

        const admin = createAdminClient();
        const { count } = await admin
          .from('tareas')
          .select('id', { count: 'exact', head: true })
          .eq('asignada_por', userId)
          .gte('created_at', new Date(Date.now() - 86_400_000).toISOString());
        if ((count ?? 0) >= LIMITE_ASIGNACIONES_DIARIO) {
          return { ok: false, error: `Límite alcanzado: hasta ${LIMITE_ASIGNACIONES_DIARIO} tareas asignadas por día.` };
        }

        // La crea el servidor: la fila es de quien la recibe (RLS no deja crearla a nombre de otro).
        const { data: tarea, error } = await admin
          .from('tareas')
          .insert({
            user_id: destinoId,
            titulo,
            descripcion,
            fecha_limite,
            asignada_por: userId,
            asignada_por_email: userEmail ?? null,
          })
          .select('id, titulo, fecha_limite')
          .single();
        if (error) return { ok: false, error: error.message };

        // El aviso viaja como recordatorio inmediato: notificación o, si no tiene, correo.
        const { data: suZona } = await admin
          .from('ajustes')
          .select('zona_horaria')
          .eq('user_id', destinoId)
          .maybeSingle();
        await admin.from('recordatorios').insert({
          user_id: destinoId,
          tarea_id: tarea.id,
          mensaje: `📋 ${userEmail ?? 'Alguien del equipo'} te asignó: ${titulo}${
            fecha_limite ? ` (vence el ${fechaLegible(fecha_limite)})` : ''
          }`.slice(0, 300),
          enviar_en: new Date().toISOString(),
          zona_horaria: suZona?.zona_horaria ?? 'UTC',
        });

        return { ok: true, asignada: { ...tarea, para: destino } };
      },
    }),

    tareas_que_asigne: tool({
      description: 'Lista las tareas que el usuario les asignó a otras personas del equipo y si ya las completaron.',
      inputSchema: z.object({
        incluir_completadas: z.boolean().optional().default(false),
      }),
      execute: async ({ incluir_completadas }) => {
        const admin = createAdminClient();
        let consulta = admin
          .from('tareas')
          .select('titulo, fecha_limite, completada, updated_at, user_id')
          .eq('asignada_por', userId);
        if (!incluir_completadas) consulta = consulta.eq('completada', false);
        const { data, error } = await consulta.order('fecha_limite', { ascending: true, nullsFirst: false });
        if (error) return { ok: false, error: error.message };
        const emails = new Map([...(await miembrosDelEquipo())].map(([email, id]) => [id, email]));
        return {
          ok: true,
          tareas: (data ?? []).map(({ user_id, ...t }) => ({ ...t, para: emails.get(user_id) ?? 'alguien del equipo' })),
        };
      },
    }),

    // ---- Gastos ----

    registrar_gasto: tool({
      description:
        'Anota un gasto del usuario ("gasté 20 mil en el almuerzo"). Pasá el monto como número (20 mil = 20000).',
      inputSchema: z.object({
        monto: z.number().positive().max(1e12).describe('Monto como número, ej. 20000 o 15.5'),
        moneda: z
          .string()
          .length(3)
          .describe('Código ISO de la moneda: COP, ARS, MXN, USD, EUR... La del país del usuario si no dice otra'),
        categoria: z.enum(CATEGORIAS_GASTO).describe('La categoría que mejor encaja'),
        descripcion: z.string().max(200).optional().describe('En qué fue, en pocas palabras'),
        fecha: z.string().optional().describe('YYYY-MM-DD si no fue hoy'),
      }),
      execute: async ({ monto, moneda, categoria, descripcion, fecha }) => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('gastos')
          .insert({
            user_id: userId,
            monto,
            moneda: moneda.toUpperCase(),
            categoria,
            descripcion,
            fecha: fecha ?? partesLocales(new Date(), zonaHoraria).fecha,
          })
          .select('id, monto, moneda, categoria, descripcion, fecha')
          .single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, gasto: { ...data, texto: formatearMonto(Number(data.monto), data.moneda) } };
      },
    }),

    resumen_gastos: tool({
      description:
        'Totales de gastos del usuario en un período, por categoría y por moneda, y el gasto más grande. Por defecto, el mes en curso.',
      inputSchema: z.object({
        desde: z.string().optional().describe('Primer día YYYY-MM-DD (por defecto, el 1 del mes actual)'),
        hasta: z.string().optional().describe('Último día YYYY-MM-DD, incluido (por defecto, hoy)'),
      }),
      execute: async ({ desde, hasta }) => {
        const hoy = partesLocales(new Date(), zonaHoraria).fecha;
        const inicio = desde ?? `${hoy.slice(0, 8)}01`;
        const fin = hasta ?? hoy;
        const supabase = await createClient();
        return { ok: true, desde: inicio, hasta: fin, ...(await resumirGastos(supabase, userId, inicio, fin)) };
      },
    }),

    listar_gastos: tool({
      description: 'Lista los últimos gastos del usuario con su id (para corregir o borrar alguno).',
      inputSchema: z.object({
        dias: z.number().int().min(1).max(365).optional().default(30).describe('Cuántos días hacia atrás'),
      }),
      execute: async ({ dias }) => {
        const hoy = partesLocales(new Date(), zonaHoraria).fecha;
        const desde = new Date(Date.parse(hoy + 'T00:00:00Z') - dias * 86_400_000).toISOString().slice(0, 10);
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('gastos')
          .select('id, monto, moneda, categoria, descripcion, fecha')
          .eq('user_id', userId)
          .gte('fecha', desde)
          .order('fecha', { ascending: false })
          .limit(50);
        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          gastos: (data ?? []).map((g) => ({ ...g, texto: formatearMonto(Number(g.monto), g.moneda) })),
        };
      },
    }),

    borrar_gasto: tool({
      description: 'Borra un gasto anotado por error, dado su id (ver listar_gastos).',
      inputSchema: z.object({ id: z.string().describe('El id del gasto') }),
      execute: async ({ id }) => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('gastos')
          .delete()
          .eq('id', id)
          .eq('user_id', userId)
          .select('id');
        if (error) return { ok: false, error: error.message };
        if (!data?.length) return { ok: false, error: 'No existe ese gasto.' };
        return { ok: true, borrado: true };
      },
    }),

    // ---- Google Calendar (escritura) ----

    conectar_google_calendar: tool({
      description:
        'Da el enlace para conectar Google Calendar con permiso para crear, mover y borrar eventos. Usar cuando quiera que QIR agende en su calendario y todavía no lo conectó.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!googleConfigurado()) {
          return { ok: false, error: 'Google Calendar todavía no está configurado en el servidor (falta la parte de Google Cloud).' };
        }
        const conectado = await googleConectado(userId);
        return {
          ok: true,
          ya_conectado: conectado ? (conectado.email ?? true) : false,
          enlace: `${URL_APP}/api/google/conectar`,
        };
      },
    }),

    crear_evento: tool({
      description:
        'Crea un evento en el Google Calendar del usuario (necesita conectar_google_calendar antes). Horas en la hora local del usuario. Si lleva invitados, Google les manda la invitación por correo y el usuario lo aprueba con un botón.',
      inputSchema: z.object({
        titulo: z.string().min(1).max(200),
        inicio: z
          .string()
          .describe('YYYY-MM-DDTHH:mm para un evento con hora, o YYYY-MM-DD para uno de todo el día'),
        fin: z.string().optional().describe('Mismo formato que inicio. Sin fin: dura duracion_minutos (o todo el día)'),
        duracion_minutos: z.number().int().min(5).max(1440).optional().default(60),
        lugar: z.string().max(200).optional(),
        descripcion: z.string().max(2000).optional(),
        invitados: z
          .array(z.email())
          .max(20)
          .optional()
          .describe('Emails de invitados que el usuario escribió o que están en sus contactos'),
      }),
      execute: async ({ titulo, inicio, fin, duracion_minutos, lugar, descripcion, invitados }) => {
        const todoElDia = /^\d{4}-\d{2}-\d{2}$/.test(inicio);
        let finReal = fin;
        if (!finReal) {
          finReal = todoElDia
            ? new Date(Date.parse(inicio + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)
            : (sumarMinutosLocal(inicio, duracion_minutos, zonaHoraria) ?? undefined);
        }
        if (!finReal || (!todoElDia && !horaLocalAUtc(inicio, zonaHoraria))) {
          return { ok: false, error: 'La fecha debe ser YYYY-MM-DDTHH:mm o YYYY-MM-DD.' };
        }
        try {
          const e = await crearEventoGoogle(userId, {
            titulo,
            inicio: momento(inicio, zonaHoraria),
            fin: momento(finReal, zonaHoraria),
            lugar,
            descripcion,
            invitados,
          });
          return { ok: true, evento: { ...eventoLegible(e, zonaHoraria), enlace: e.enlace } };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),

    buscar_eventos: tool({
      description:
        'Lista o busca eventos del Google Calendar conectado (con su id, para moverlos o borrarlos). Si no está conectado con permiso de escritura, usá ver_calendario.',
      inputSchema: z.object({
        desde: z.string().optional().describe('Primer día YYYY-MM-DD (por defecto, hoy)'),
        dias: z.number().int().min(1).max(90).optional().default(7),
        texto: z.string().max(100).optional().describe('Palabras del título, ej. "dentista"'),
      }),
      execute: async ({ desde, dias, texto }) => {
        const inicio = horaLocalAUtc(`${desde ?? partesLocales(new Date(), zonaHoraria).fecha}T00:00`, zonaHoraria);
        if (!inicio) return { ok: false, error: 'La fecha "desde" debe ser YYYY-MM-DD.' };
        try {
          const eventos = await listarEventosGoogle(userId, inicio, new Date(inicio.getTime() + dias * 86_400_000), texto);
          return { ok: true, eventos: eventos.map((e) => eventoLegible(e, zonaHoraria)) };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),

    mover_evento: tool({
      description:
        'Cambia un evento del Google Calendar: otra hora, otro día, otro título u otro lugar (primero buscar_eventos para el id). Si tiene invitados, Google les avisa del cambio.',
      inputSchema: z.object({
        id: z.string().describe('El id del evento'),
        inicio: z.string().optional().describe('Nuevo inicio YYYY-MM-DDTHH:mm o YYYY-MM-DD'),
        fin: z.string().optional().describe('Nuevo fin. Sin fin y con inicio nuevo, se mantiene la duración que tenía'),
        titulo: z.string().max(200).optional(),
        lugar: z.string().max(200).optional(),
      }),
      execute: async ({ id, inicio, fin, titulo, lugar }) => {
        try {
          let finReal = fin;
          if (inicio && !fin && !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) {
            // Se mantiene la duración original: hace falta leer el evento.
            const actual = await leerEventoGoogle(userId, id);
            const duracion = actual.todo_el_dia ? 60 : (Date.parse(actual.fin) - Date.parse(actual.inicio)) / 60_000;
            finReal = sumarMinutosLocal(inicio, duracion, zonaHoraria) ?? undefined;
          }
          const e = await modificarEventoGoogle(userId, id, {
            titulo,
            lugar,
            inicio: inicio ? momento(inicio, zonaHoraria) : undefined,
            fin: finReal ? momento(finReal, zonaHoraria) : undefined,
          });
          return { ok: true, evento: eventoLegible(e, zonaHoraria), movido: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),

    borrar_evento: tool({
      description:
        'Borra un evento del Google Calendar (primero buscar_eventos para el id). El usuario lo confirma con un botón. Si tenía invitados, Google les avisa que se canceló.',
      inputSchema: z.object({
        id: z.string(),
        titulo: z.string().describe('Título y fecha, para mostrarlos en la confirmación'),
      }),
      execute: async ({ id }) => {
        try {
          await borrarEventoGoogle(userId, id);
          return { ok: true, evento_borrado: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),

    desconectar_google_calendar: tool({
      description: 'Quita el permiso de QIR sobre el Google Calendar del usuario.',
      inputSchema: z.object({}),
      execute: async () => {
        await desconectarGoogle(userId);
        return { ok: true, desconectado: true };
      },
    }),

    // ---- Memoria: conversaciones anteriores y documentos ----

    buscar_en_conversaciones: tool({
      description:
        'Busca en TODO lo hablado con el usuario, también en conversaciones anteriores que ya no se ven ("¿qué te dije del presupuesto?", "¿de qué hablamos el martes?"). Pasá palabras clave, un rango de fechas, o las dos cosas.',
      inputSchema: z.object({
        consulta: z
          .string()
          .max(200)
          .optional()
          .describe('Palabras clave, ej. "presupuesto Ana". Omitir para traer todo lo de un rango de fechas'),
        desde: z.string().optional().describe('Primer día YYYY-MM-DD, incluido'),
        hasta: z.string().optional().describe('Último día YYYY-MM-DD, incluido'),
      }),
      execute: async ({ consulta, desde, hasta }) => {
        if (!consulta && !desde && !hasta) {
          return { ok: false, error: 'Indicá palabras clave o un rango de fechas.' };
        }
        const inicio = desde ? horaLocalAUtc(`${desde}T00:00`, zonaHoraria) : null;
        const finDia = hasta ? horaLocalAUtc(`${hasta}T00:00`, zonaHoraria) : null;
        const supabase = await createClient();
        const { data, error } = await supabase.rpc('buscar_mensajes', {
          consulta: consulta ? consultaFlexible(consulta) : null,
          desde: inicio?.toISOString() ?? null,
          hasta: finDia ? new Date(finDia.getTime() + 86_400_000).toISOString() : null,
          limite: 12,
        });
        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          resultados: (data ?? []).map((m: { rol: string; texto: string; created_at: string }) => ({
            quien: m.rol === 'user' ? 'el usuario' : 'QIR',
            cuando: formatearEnZona(new Date(m.created_at), zonaHoraria),
            texto: m.texto.length > 600 ? m.texto.slice(0, 600) + '…' : m.texto,
          })),
        };
      },
    }),

    olvidar_conversaciones: tool({
      description:
        'Borra para siempre el archivo de todo lo hablado (lo que usa buscar_en_conversaciones). El usuario lo confirma con un botón. Usar solo si lo pide explícitamente.',
      inputSchema: z.object({}),
      execute: async () => {
        const supabase = await createClient();
        const { error } = await supabase.from('mensajes_archivo').delete().eq('user_id', userId);
        if (error) return { ok: false, error: error.message };
        return { ok: true, olvidado: true };
      },
    }),

    guardar_documento: tool({
      description:
        'Guarda un documento que el usuario adjuntó (PDF, Word .docx o texto) para poder preguntarle cosas después, en cualquier conversación. Usá el nombre y la ruta exactos de "[Adjuntos del usuario]".',
      inputSchema: z.object({
        nombre: z.string().describe('Nombre del archivo, tal cual aparece en los adjuntos'),
        ruta: z.string().describe('Ruta del adjunto, tal cual aparece en los adjuntos'),
      }),
      execute: async ({ nombre, ruta }) => {
        if (!ruta.startsWith(`${userId}/`)) return { ok: false, error: 'Ese archivo no es de esta cuenta.' };
        const supabase = await createClient();
        const { count } = await supabase
          .from('documentos')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId);
        if ((count ?? 0) >= MAX_DOCUMENTOS) {
          return { ok: false, error: `Ya hay ${MAX_DOCUMENTOS} documentos guardados: hay que borrar alguno.` };
        }
        const { data: archivo, error: errorArchivo } = await supabase.storage.from(BUCKET_ADJUNTOS).download(ruta);
        if (errorArchivo || !archivo) {
          return { ok: false, error: 'No encontré el archivo. Pedile que lo vuelva a adjuntar.' };
        }
        const clase = tipoSoportado(archivo.type, nombre);
        if (!clase) return { ok: false, error: 'Solo se pueden guardar PDF, Word (.docx) o archivos de texto.' };

        let extraido: { texto: string; paginas?: number };
        try {
          extraido = await extraerTexto(Buffer.from(await archivo.arrayBuffer()), clase);
        } catch (e) {
          console.error('[documentos] No se pudo leer:', e);
          return { ok: false, error: 'No pude leer el archivo. Puede estar dañado o protegido con contraseña.' };
        }
        // Un PDF escaneado (fotos de páginas) no trae texto.
        const soloTexto = extraido.texto.replace(/\[Página \d+\]/g, '').trim();
        if (soloTexto.length < 20) {
          return {
            ok: false,
            error:
              'El documento no tiene texto que se pueda leer (parece escaneado). Las imágenes las puedo ver en el chat, pero no guardarlas como documento.',
          };
        }
        if (extraido.texto.length > MAX_CARACTERES) {
          return { ok: false, error: 'El documento es demasiado largo (más de ~400 páginas).' };
        }

        const fragmentos = fragmentar(extraido.texto);
        const { data: doc, error } = await supabase
          .from('documentos')
          .insert({
            user_id: userId,
            nombre,
            tipo: clase,
            paginas: extraido.paginas ?? null,
            caracteres: extraido.texto.length,
          })
          .select('id, nombre')
          .single();
        if (error) return { ok: false, error: error.message };
        for (let i = 0; i < fragmentos.length; i += 200) {
          const { error: e } = await supabase.from('documento_fragmentos').insert(
            fragmentos.slice(i, i + 200).map((texto, j) => ({
              documento_id: doc.id,
              user_id: userId,
              numero: i + j + 1,
              texto,
            }))
          );
          if (e) {
            await supabase.from('documentos').delete().eq('id', doc.id);
            return { ok: false, error: e.message };
          }
        }
        return {
          ok: true,
          documento: { ...doc, paginas: extraido.paginas ?? null, fragmentos: fragmentos.length },
        };
      },
    }),

    listar_documentos: tool({
      description: 'Lista los documentos que el usuario guardó, con su id.',
      inputSchema: z.object({}),
      execute: async () => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('documentos')
          .select('id, nombre, tipo, paginas, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });
        if (error) return { ok: false, error: error.message };
        return { ok: true, documentos: data };
      },
    }),

    buscar_en_documentos: tool({
      description:
        'Busca en los documentos guardados del usuario los fragmentos que responden una pregunta. Respondé solo con lo que dicen los fragmentos, citando el documento (y la página si aparece).',
      inputSchema: z.object({
        pregunta: z.string().min(2).max(300).describe('Lo que hay que encontrar, con las palabras importantes'),
        documento_id: z.string().optional().describe('Para buscar en un solo documento (ver listar_documentos)'),
      }),
      execute: async ({ pregunta, documento_id }) => {
        const supabase = await createClient();
        const { data, error } = await supabase.rpc('buscar_en_documentos', {
          consulta: consultaFlexible(pregunta),
          documento: documento_id ?? null,
          limite: 6,
        });
        if (error) return { ok: false, error: error.message };
        if (!data?.length) {
          return {
            ok: true,
            fragmentos: [],
            nota: 'No encontré nada con esas palabras. Probá con sinónimos, o leé el documento con leer_documento.',
          };
        }
        return {
          ok: true,
          fragmentos: data.map((f: { nombre: string; numero: number; texto: string; documento_id: string }) => ({
            documento: f.nombre,
            documento_id: f.documento_id,
            fragmento: f.numero,
            texto: f.texto,
          })),
        };
      },
    }),

    leer_documento: tool({
      description:
        'Lee un documento guardado en orden, de a partes (para resumirlo o cuando la búsqueda no alcanza). Devuelve hasta ~12.000 caracteres por vez; para seguir, pasá desde_fragmento con el valor de "siguiente".',
      inputSchema: z.object({
        documento_id: z.string().describe('El id del documento (ver listar_documentos)'),
        desde_fragmento: z.number().int().min(1).optional().default(1),
      }),
      execute: async ({ documento_id, desde_fragmento }) => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('documento_fragmentos')
          .select('numero, texto')
          .eq('documento_id', documento_id)
          .eq('user_id', userId)
          .gte('numero', desde_fragmento)
          .order('numero')
          .limit(8);
        if (error) return { ok: false, error: error.message };
        if (!data?.length) return { ok: false, error: 'No hay más texto o el documento no existe.' };
        const { count } = await supabase
          .from('documento_fragmentos')
          .select('id', { count: 'exact', head: true })
          .eq('documento_id', documento_id);
        const ultimo = data[data.length - 1].numero;
        return {
          ok: true,
          texto: data.map((f) => f.texto).join('\n\n'),
          fragmentos: `${desde_fragmento} a ${ultimo} de ${count ?? '?'}`,
          siguiente: count && ultimo < count ? ultimo + 1 : null,
        };
      },
    }),

    borrar_documento: tool({
      description: 'Borra un documento guardado, dado su id y su nombre. El usuario lo confirma con un botón.',
      inputSchema: z.object({
        id: z.string().describe('El id del documento'),
        nombre: z.string().describe('El nombre, para mostrarlo en la confirmación'),
      }),
      execute: async ({ id }) => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('documentos')
          .delete()
          .eq('id', id)
          .eq('user_id', userId)
          .select('id');
        if (error) return { ok: false, error: error.message };
        if (!data?.length) return { ok: false, error: 'No existe ese documento.' };
        return { ok: true, borrado: true };
      },
    }),

    // ---- Solo administradores (ver HERRAMIENTAS_ADMIN y activeTools en la ruta del chat) ----

    invitar_persona: tool({
      description:
        'Invita a una persona del equipo a usar QIR: agrega su email a la lista de invitados para que pueda registrarse. Solo administradores.',
      inputSchema: z.object({
        email: z.email().describe('Email de la persona a invitar'),
        es_admin: z
          .boolean()
          .optional()
          .default(false)
          .describe('true solo si el usuario pidió explícitamente que también sea administrador'),
      }),
      execute: async ({ email, es_admin }) => {
        if (!esAdmin) return soloAdmin;
        const limpio = email.trim().toLowerCase();
        const { error } = await createAdminClient()
          .from('invitaciones')
          .upsert({ email: limpio, es_admin, invitado_por: userEmail }, { onConflict: 'email' });
        if (error) return { ok: false, error: error.message };
        return { ok: true, invitado: limpio, es_admin };
      },
    }),

    listar_equipo: tool({
      description:
        'Lista las personas invitadas a QIR, si ya crearon su cuenta y quién es administrador. Solo administradores.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!esAdmin) return soloAdmin;
        const admin = createAdminClient();
        const [{ data: invitados, error }, { data: usuarios }] = await Promise.all([
          admin.from('invitaciones').select('email, es_admin, created_at').order('created_at'),
          admin.auth.admin.listUsers({ perPage: 1000 }),
        ]);
        if (error) return { ok: false, error: error.message };
        const registrados = new Set(usuarios?.users.map((u) => u.email?.toLowerCase()));
        return {
          ok: true,
          equipo: (invitados ?? []).map((i) => ({
            email: i.email,
            es_admin: i.es_admin,
            ya_se_registro: registrados.has(i.email),
          })),
        };
      },
    }),

    quitar_invitacion: tool({
      description:
        'Quita a alguien de la lista de invitados para que no pueda registrarse. Si ya tenía cuenta, la cuenta sigue existiendo. Solo administradores.',
      inputSchema: z.object({ email: z.email().describe('Email a quitar') }),
      execute: async ({ email }) => {
        if (!esAdmin) return soloAdmin;
        const limpio = email.trim().toLowerCase();
        if (limpio === userEmail?.toLowerCase()) {
          return { ok: false, error: 'No podés quitarte a vos mismo.' };
        }
        const { data, error } = await createAdminClient()
          .from('invitaciones')
          .delete()
          .eq('email', limpio)
          .select('email');
        if (error) return { ok: false, error: error.message };
        if (!data?.length) return { ok: false, error: `${limpio} no estaba invitado.` };
        return { ok: true, quitado: limpio };
      },
    }),
  };
}

/** Herramientas que solo ve el modelo cuando quien chatea es administrador. */
export const HERRAMIENTAS_ADMIN = ['invitar_persona', 'listar_equipo', 'quitar_invitacion'] as const;

/** true si el email está invitado como administrador. */
export async function esAdministrador(email: string | undefined): Promise<boolean> {
  if (!email) return false;
  const { data } = await createAdminClient()
    .from('invitaciones')
    .select('es_admin')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  return data?.es_admin === true;
}
