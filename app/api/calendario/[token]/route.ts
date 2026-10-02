import { createAdminClient } from '@/lib/supabase/server';
import { calendarioDeTareas } from '@/lib/calendario-tareas';

export const dynamic = 'force-dynamic';

/**
 * Calendario iCal de las tareas y avisos de una persona. No usa sesión: el
 * token secreto de la dirección (ajustes.calendario_token) identifica a la
 * persona. Se genera y se cambia con la herramienta enlace_calendario_tareas.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Google a veces agrega ".ics" al final; se acepta con o sin.
  const limpio = token.replace(/\.ics$/, '');
  if (!/^[\w-]{20,64}$/.test(limpio)) return new Response('No encontrado', { status: 404 });

  const supabase = createAdminClient();
  const { data } = await supabase
    .from('ajustes')
    .select('user_id')
    .eq('calendario_token', limpio)
    .maybeSingle();
  if (!data) return new Response('No encontrado', { status: 404 });

  return new Response(await calendarioDeTareas(supabase, data.user_id), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
