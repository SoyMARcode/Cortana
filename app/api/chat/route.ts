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
import { adjuntosParaModelo, guardarConversacion, ventanaParaModelo } from '@/lib/conversacion';
import { cargarContexto } from '@/lib/contexto';

/** Búsquedas y lecturas de páginas web por mensaje (cada búsqueda tiene costo). */
const MAX_BUSQUEDAS = 3;

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
  // Verifica la sesión sin ir al servidor de Supabase: cada mensaje sale ~250 ms antes.
  const { data: sesion } = await supabase.auth.getClaims();
  const user = sesion?.claims.sub
    ? { id: sesion.claims.sub, email: sesion.claims.email as string | undefined }
    : null;

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

  const zona = zonaHorariaValida(zonaHoraria);
  const [esAdmin, contexto, conAdjuntos] = await Promise.all([
    esAdministrador(user.email),
    cargarContexto(supabase, user.id, zona),
    adjuntosParaModelo(supabase, ventanaParaModelo(messages)),
  ]);
  const { ajustes } = contexto;

  const tools = {
    ...crearHerramientas(user.id, user.email, zona, esAdmin, ajustes),
    // Búsqueda y lectura web de Anthropic: noticias y datos en tiempo real.
    // Hay que habilitarlas una vez en console.anthropic.com/settings/privacy.
    web_search: anthropic.tools.webSearch_20260318({
      maxUses: MAX_BUSQUEDAS,
      responseInclusion: 'excluded',
      userLocation: ajustes?.ciudad
        ? {
            type: 'approximate',
            city: ajustes.ciudad,
            region: ajustes.region ?? undefined,
            country: ajustes.pais ?? undefined,
            timezone: zona,
          }
        : { type: 'approximate', timezone: zona },
    }),
    web_fetch: anthropic.tools.webFetch_20260318({
      maxUses: MAX_BUSQUEDAS,
      responseInclusion: 'excluded',
    }),
  };

  const historial: ModelMessage[] = await convertToModelMessages(conAdjuntos);
  // Caché en dos puntos: después de las instrucciones (herramientas + personalidad,
  // iguales en cada llamada) y al final del historial (el próximo turno lo reutiliza).
  // En AI SDK v7 el sistema va en `instructions`: no se admite como mensaje.
  const ultimo = historial[historial.length - 1];
  if (ultimo) ultimo.providerOptions = { ...ultimo.providerOptions, ...CACHE };

  const result = streamText({
    model: anthropic('claude-sonnet-5'),
    // La personalidad queda cacheada; el contexto de la persona va después
    // porque cambia (preferencias, contactos, ubicación).
    instructions: [
      { role: 'system', content: personalidad, providerOptions: CACHE },
      { role: 'system', content: contexto.texto },
    ],
    messages: historial,
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
    stopWhen: isStepCount(8),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    // Las fuentes de las búsquedas web se muestran debajo de la respuesta.
    sendSources: true,
    // IDs generados en el servidor: estables para el historial guardado.
    generateMessageId: createIdGenerator({ prefix: 'msg', size: 16 }),
    onEnd: ({ messages: completos }) => guardarConversacion(supabase, user.id, completos),
  });
}
