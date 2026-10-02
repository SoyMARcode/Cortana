import type { SupabaseClient } from '@supabase/supabase-js';
import { enviarPush } from '@/lib/push';
import { firmarAviso } from '@/lib/firma-aviso';
import { fechaLegible } from '@/lib/email';

/** Días de atraso a partir de los cuales se ofrece rescatar una tarea (y cada cuánto se repite). */
export const DIAS_RESCATE = 3;

/** Tareas rescatadas por día, para no llenar el celular de notificaciones. */
const MAX_RESCATES_POR_DIA = 3;

/** Una tarea sin fecha con más de estos días entra en la limpieza semanal. */
const DIAS_TAREA_VIEJA = 30;

/** Hora local del rescate (todos los días) y de la limpieza (los domingos). */
export const HORA_RESCATE = 9;
export const HORA_LIMPIEZA = 18;
export const DIA_LIMPIEZA = 0;

function restarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/**
 * A2 · Rescate: por cada tarea con 3 días o más de atraso (hasta 3 por día),
 * una notificación con "Pasar a mañana" y "Marcar hecha". Cada tarea se
 * vuelve a ofrecer recién a los 3 días, para no insistir todos los días.
 * Devuelve cuántas se ofrecieron.
 */
export async function rescatarTareas(supabase: SupabaseClient, userId: string, hoy: string): Promise<number> {
  const limite = restarDias(hoy, DIAS_RESCATE);
  const { data: tareas } = await supabase
    .from('tareas')
    .select('id, titulo, fecha_limite')
    .eq('user_id', userId)
    .eq('completada', false)
    .lte('fecha_limite', limite)
    .or(`ultimo_rescate.is.null,ultimo_rescate.lte.${limite}`)
    .order('fecha_limite')
    .limit(MAX_RESCATES_POR_DIA);
  if (!tareas?.length) return 0;

  let ofrecidas = 0;
  for (const t of tareas) {
    const dias = Math.round((Date.parse(hoy) - Date.parse(t.fecha_limite)) / 86_400_000);
    const llegados = await enviarPush(userId, {
      titulo: `¿Rescatamos "${t.titulo}"?`,
      cuerpo: `Venció el ${fechaLegible(t.fecha_limite)} (hace ${dias} días).`,
      tag: `rescate-${t.id}`,
      acciones: [
        { accion: 'manana', titulo: 'Pasar a mañana' },
        { accion: 'hecha', titulo: 'Marcar hecha' },
      ],
      aviso: { tipo: 'tarea', id: t.id, firma: firmarAviso('tarea', t.id) },
    });
    // Se anota aunque no haya llegado: sin dispositivos, no se reintenta a diario.
    await supabase.from('tareas').update({ ultimo_rescate: hoy }).eq('id', t.id);
    if (llegados > 0) ofrecidas++;
  }
  return ofrecidas;
}

/**
 * A8 · Limpieza semanal: si hay tareas sin fecha con más de un mes, una
 * notificación que al tocarla abre el chat con el pedido ya escrito.
 * Devuelve true si se mandó.
 */
export async function avisarLimpieza(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { count } = await supabase
    .from('tareas')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('completada', false)
    .is('fecha_limite', null)
    .lt('created_at', new Date(Date.now() - DIAS_TAREA_VIEJA * 86_400_000).toISOString());
  if (!count) return false;

  const pedido = 'Ayudame a ordenar mis tareas sin fecha que tienen más de un mes';
  const llegados = await enviarPush(userId, {
    titulo: 'Limpieza de tareas 🧹',
    cuerpo: `Tenés ${count === 1 ? '1 tarea' : `${count} tareas`} sin fecha de hace más de un mes. Tocá para decidir cuáles borrar o cuándo hacerlas.`,
    tag: 'limpieza',
    url: `/?mensaje=${encodeURIComponent(pedido)}`,
  });
  return llegados > 0;
}
