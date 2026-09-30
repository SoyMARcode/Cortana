import { tool } from 'ai';
import { z } from 'zod';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { enviarCorreoLibre } from '@/lib/email';
import { formatearEnZona, horaLocalAUtc } from '@/lib/zona-horaria';

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
  esAdmin = false
) {
  const soloAdmin = { ok: false as const, error: 'Solo un administrador del equipo puede hacer esto.' };

  return {
    crear_tarea: tool({
      description:
        'Crea una nueva tarea o recordatorio para el usuario, opcionalmente con fecha límite.',
      inputSchema: z.object({
        titulo: z.string().describe('Título breve de la tarea'),
        descripcion: z.string().optional().describe('Detalles adicionales, opcional'),
        fecha_limite: z
          .string()
          .optional()
          .describe('Fecha límite en formato YYYY-MM-DD, si aplica'),
      }),
      execute: async ({ titulo, descripcion, fecha_limite }) => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('tareas')
          .insert({ user_id: userId, titulo, descripcion, fecha_limite })
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
        'Modifica una tarea existente del usuario (título, descripción o fecha límite), dado su id. Solo se cambian los campos que se pasan.',
      inputSchema: z.object({
        id: z.string().describe('El id de la tarea a editar'),
        titulo: z.string().optional().describe('Nuevo título'),
        descripcion: z.string().optional().describe('Nueva descripción'),
        fecha_limite: z
          .string()
          .nullable()
          .optional()
          .describe('Nueva fecha límite YYYY-MM-DD, o null para quitarla'),
      }),
      execute: async ({ id, titulo, descripcion, fecha_limite }) => {
        const cambios: Record<string, unknown> = {};
        if (titulo !== undefined) cambios.titulo = titulo;
        if (descripcion !== undefined) cambios.descripcion = descripcion;
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

    listar_contactos: tool({
      description:
        'Lista la libreta de contactos del usuario (nombre y email). Usar para averiguar el email de alguien que el usuario nombra.',
      inputSchema: z.object({}),
      execute: async () => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('contactos')
          .select('nombre, email')
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
      }),
      execute: async ({ destinatarios, asunto, contenido }) => {
        if (!userEmail) {
          return { ok: false, error: 'La cuenta no tiene un email vinculado.' };
        }
        const lista = destinatarios?.length ? normalizarEmails(destinatarios) : [userEmail];

        const supabase = await createClient();
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
        return { ok: true, enviado_a: enviados, fallidos };
      },
    }),

    programar_recordatorio: tool({
      description:
        'Programa un aviso por correo para un día y hora exactos (ej. "recordame a las 6:45", "avisame antes de las 7"). La hora es la hora local del usuario.',
      inputSchema: z.object({
        mensaje: z.string().min(1).max(300).describe('Qué hay que recordarle, en pocas palabras'),
        cuando: z
          .string()
          .describe('Fecha y hora local del usuario en formato YYYY-MM-DDTHH:mm, ej. 2026-09-29T06:45'),
        tarea_id: z
          .string()
          .optional()
          .describe('Id de la tarea relacionada, si el recordatorio es sobre una tarea existente'),
      }),
      execute: async ({ mensaje, cuando, tarea_id }) => {
        const instante = horaLocalAUtc(cuando, zonaHoraria);
        if (!instante) {
          return { ok: false, error: 'La fecha y hora deben tener el formato YYYY-MM-DDTHH:mm.' };
        }
        const ahora = Date.now();
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
          })
          .select('id, mensaje, enviar_en')
          .single();

        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          recordatorio: { ...data, cuando_local: formatearEnZona(instante, zonaHoraria) },
        };
      },
    }),

    listar_recordatorios: tool({
      description: 'Lista los recordatorios con hora que todavía no se enviaron.',
      inputSchema: z.object({}),
      execute: async () => {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('recordatorios')
          .select('id, mensaje, enviar_en')
          .eq('user_id', userId)
          .is('enviado_en', null)
          .order('enviar_en');

        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          recordatorios: (data ?? []).map((r) => ({
            ...r,
            cuando_local: formatearEnZona(new Date(r.enviar_en), zonaHoraria),
          })),
        };
      },
    }),

    cancelar_recordatorio: tool({
      description: 'Cancela un recordatorio con hora que todavía no se envió, dado su id.',
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
        return {
          fecha_local: new Intl.DateTimeFormat('es', {
            timeZone: zonaHoraria,
            dateStyle: 'full',
            timeStyle: 'short',
          }).format(ahora),
          // en-CA formatea como YYYY-MM-DD, el mismo formato que fecha_limite.
          hoy: new Intl.DateTimeFormat('en-CA', { timeZone: zonaHoraria }).format(ahora),
          zona_horaria: zonaHoraria,
        };
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
