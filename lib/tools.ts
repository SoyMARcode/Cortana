import { tool } from 'ai';
import { z } from 'zod';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { enviarCorreoLibre, type Adjunto as AdjuntoCorreo } from '@/lib/email';
import { formatearEnZona, horaLocalAUtc, partesLocales } from '@/lib/zona-horaria';
import { esquemaRepeticion, textoRepeticion } from '@/lib/repeticion';
import { buscarLugar, pronostico } from '@/lib/clima';
import { eventosEntre, probarCalendario, validarEnlace } from '@/lib/calendario';
import { BUCKET_ADJUNTOS, MAX_BYTES_CORREO } from '@/lib/adjuntos';
import type { Ajustes } from '@/lib/contexto';

/** Tope de preferencias guardadas por persona. */
const MAX_PREFERENCIAS = 40;

/** Tope de apodos por contacto. */
const MAX_APODOS = 10;

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
        'Cambia los avisos automáticos: el "buenos días" de cada mañana (si llega y a qué hora), el resumen semanal de tareas (si llega, qué día y a qué hora) y el aviso de lluvia. Solo se cambian los campos que se pasan.',
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
      }),
      execute: async (cambios) => {
        const limpios = Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== undefined));
        if (Object.keys(limpios).length === 0) return { ok: false, error: 'No se indicó ningún cambio.' };
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('ajustes')
          .update({ ...limpios, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .select('resumen_semanal, resumen_dia, resumen_hora, aviso_lluvia, buenos_dias, buenos_dias_hora, latitud')
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
