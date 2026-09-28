import {
  streamText,
  convertToModelMessages,
  createIdGenerator,
  isStepCount,
  type UIMessage,
} from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { createClient } from '@/lib/supabase/server';
import { crearHerramientas, soloAlPropioEmail } from '@/lib/tools';
import { personalidad } from '@/lib/personality';
import { guardarConversacion, ventanaParaModelo } from '@/lib/conversacion';

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
  const modelMessages = await convertToModelMessages(ventanaParaModelo(messages));

  const result = streamText({
    model: anthropic('claude-sonnet-5'),
    system: personalidad,
    messages: modelMessages,
    tools: crearHerramientas(user.id, user.email, zonaHorariaValida(zonaHoraria)),
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
