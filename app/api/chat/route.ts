import {
  streamText,
  convertToModelMessages,
  createIdGenerator,
  isStepCount,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { createClient } from '@/lib/supabase/server';
import {
  crearHerramientas,
  esAdministrador,
  HERRAMIENTAS_ADMIN,
  soloAlPropioEmail,
} from '@/lib/tools';
import { personalidad } from '@/lib/personality';
import { guardarConversacion, ventanaParaModelo } from '@/lib/conversacion';

/** Mensajes de chat por persona por día. Se puede cambiar con la variable CHAT_LIMITE_DIARIO. */
const LIMITE_DIARIO = Number(process.env.CHAT_LIMITE_DIARIO) || 150;

/** Punto de caché de Anthropic: todo lo anterior se reutiliza en la próxima llamada. */
const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/** Acepta solo zonas horarias IANA válidas (ej. "America/Bogota"); si no, UTC. */
function zonaHorariaValida(zona: unknown): string {
  if (typeof zona !== 'string') return 'UTC';
  try {
    new Intl.DateTimeFormat('es', { timeZone: zona });
    return zona;
  } catch {
    return 'UTC';
  }
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response('No autorizado', { status: 401 });
  }

  const { messages, zonaHoraria }: { messages: UIMessage[]; zonaHoraria?: string } =
    await req.json();

  // Solo cuenta los mensajes que escribe la persona; la continuación
  // automática después de aprobar un correo o un borrado no suma.
  if (messages[messages.length - 1]?.role === 'user') {
    const { data: usados, error } = await supabase.rpc('registrar_mensaje_chat', {
      limite: LIMITE_DIARIO,
    });
    if (error) {
      console.error('[chat] No se pudo registrar el uso:', error.message);
      return new Response('No se pudo verificar tu límite diario. Probá de nuevo en un momento.', {
        status: 503,
      });
    }
    if (usados === -1) {
      return new Response(
        `Llegaste al límite de ${LIMITE_DIARIO} mensajes por día. Se renueva mañana.`,
        { status: 429 }
      );
    }
  }

  const esAdmin = await esAdministrador(user.email);
  const tools = crearHerramientas(user.id, user.email, zonaHorariaValida(zonaHoraria), esAdmin);

  const historial = await convertToModelMessages(ventanaParaModelo(messages));
  // Caché en dos puntos: después de las instrucciones (herramientas + personalidad,
  // iguales en cada llamada) y al final del historial (el próximo turno lo reutiliza).
  const ultimo = historial[historial.length - 1];
  if (ultimo) ultimo.providerOptions = { ...ultimo.providerOptions, ...CACHE };
  const modelMessages: ModelMessage[] = [
    { role: 'system', content: personalidad, providerOptions: CACHE },
    ...historial,
  ];

  const result = streamText({
    model: anthropic('claude-sonnet-5'),
    messages: modelMessages,
    tools,
    activeTools: esAdmin
      ? undefined
      : (Object.keys(tools) as (keyof typeof tools)[]).filter(
          (nombre) => !(HERRAMIENTAS_ADMIN as readonly string[]).includes(nombre)
        ),
    // Acciones que requieren que el usuario apruebe con un botón:
    // enviar a otras personas (enviarse algo a sí mismo no) y borrar tareas.
    toolApproval: {
      enviar_correo: (input) =>
        soloAlPropioEmail(input.destinatarios, user.email)
          ? 'not-applicable'
          : {
              type: 'user-approval',
              reason: 'El correo va a otras personas: confirmá antes de enviarlo.',
            },
      borrar_tarea: 'user-approval',
    },
    stopWhen: isStepCount(5),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    // IDs generados en el servidor: estables para el historial guardado.
    generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
    onEnd: ({ messages: completos }) => guardarConversacion(supabase, user.id, completos),
  });
}
