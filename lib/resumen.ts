import type { SupabaseClient } from '@supabase/supabase-js';
import { fechaLegible } from '@/lib/email';
import { formatearEnZona, partesLocales } from '@/lib/zona-horaria';
import { eventosEntre } from '@/lib/calendario';
import { textoRepeticion } from '@/lib/repeticion';
import { resumirGastos } from '@/lib/gastos';

const SEMANA_MS = 7 * 86_400_000;

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Texto del resumen semanal: lo atrasado, lo que vence en los próximos 7
 * días, avisos y eventos de la semana, y lo que se completó. Usa el cliente
 * de servicio (lo llama el cron), así que filtra por usuario a mano.
 * Devuelve null si no hay nada que contar.
 */
export async function armarResumen(
  supabase: SupabaseClient,
  userId: string,
  zona: string,
  calendarioIcs: string | null
): Promise<{ texto: string; corto: string } | null> {
  const ahora = new Date();
  const hoy = partesLocales(ahora, zona).fecha;
  const enUnaSemana = sumarDias(hoy, 7);

  const [pendientes, hechas, avisos] = await Promise.all([
    supabase
      .from('tareas')
      .select('titulo, fecha_limite, repeticion, dias_semana')
      .eq('user_id', userId)
      .eq('completada', false)
      .order('fecha_limite', { ascending: true, nullsFirst: false }),
    supabase
      .from('tareas')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('completada', true)
      .gte('updated_at', new Date(ahora.getTime() - SEMANA_MS).toISOString()),
    supabase
      .from('recordatorios')
      .select('mensaje, enviar_en')
      .eq('user_id', userId)
      .is('enviado_en', null)
      .lte('enviar_en', new Date(ahora.getTime() + SEMANA_MS).toISOString())
      .order('enviar_en'),
  ]);

  const tareas = pendientes.data ?? [];
  const atrasadas = tareas.filter((t) => t.fecha_limite && t.fecha_limite < hoy);
  const semana = tareas.filter((t) => t.fecha_limite && t.fecha_limite >= hoy && t.fecha_limite < enUnaSemana);
  const sinFecha = tareas.filter((t) => !t.fecha_limite);
  const completadas = hechas.count ?? 0;

  let eventos: { titulo: string; cuando: string }[] = [];
  if (calendarioIcs) {
    try {
      eventos = await eventosEntre(calendarioIcs, ahora, new Date(ahora.getTime() + SEMANA_MS), zona);
    } catch (e) {
      console.error('[resumen] No se pudo leer el calendario:', e);
    }
  }

  // Gastos de los últimos 7 días (de hace una semana a ayer).
  const gastos = await resumirGastos(supabase, userId, sumarDias(hoy, -7), sumarDias(hoy, -1));

  if (!tareas.length && !avisos.data?.length && !eventos.length && !completadas && !gastos.cantidad) {
    return null;
  }

  const linea = (t: { titulo: string; fecha_limite: string | null; repeticion: string | null; dias_semana: number[] | null }) => {
    const repite = textoRepeticion(t.repeticion, t.dias_semana);
    return `• ${t.titulo}${t.fecha_limite ? ` — ${fechaLegible(t.fecha_limite)}` : ''}${repite ? ` (${repite})` : ''}`;
  };

  const bloques: string[] = ['Hola, este es tu resumen de la semana.'];
  if (atrasadas.length) bloques.push(`Atrasadas (${atrasadas.length}):\n${atrasadas.map(linea).join('\n')}`);
  if (semana.length) bloques.push(`Vencen esta semana (${semana.length}):\n${semana.map(linea).join('\n')}`);
  if (eventos.length) {
    bloques.push(
      `En tu calendario:\n${eventos
        .slice(0, 20)
        .map((e) => `• ${e.titulo} — ${e.cuando}`)
        .join('\n')}`
    );
  }
  if (avisos.data?.length) {
    bloques.push(
      `Avisos programados:\n${avisos.data
        .map((r) => `• ${r.mensaje} — ${formatearEnZona(new Date(r.enviar_en), zona)}`)
        .join('\n')}`
    );
  }
  if (sinFecha.length) {
    bloques.push(`Sin fecha (${sinFecha.length}): ${sinFecha.slice(0, 8).map((t) => t.titulo).join(', ')}${sinFecha.length > 8 ? '…' : ''}`);
  }
  if (gastos.cantidad) {
    const categorias = gastos.por_categoria
      .slice(0, 4)
      .map((c) => `${c.categoria} ${c.texto}`)
      .join(', ');
    bloques.push(
      `Gastos de la semana: ${gastos.total_por_moneda.map((m) => m.texto).join(' + ')} en ${
        gastos.cantidad === 1 ? '1 gasto' : `${gastos.cantidad} gastos`
      }. Lo que más: ${categorias}.`
    );
  }
  bloques.push(
    completadas
      ? `La semana pasada completaste ${completadas === 1 ? '1 tarea' : `${completadas} tareas`}. ¡Bien ahí!`
      : 'La semana pasada no marcaste ninguna tarea como hecha.'
  );

  const partesCorto = [
    atrasadas.length && `${atrasadas.length} atrasada${atrasadas.length > 1 ? 's' : ''}`,
    semana.length && `${semana.length} vence${semana.length > 1 ? 'n' : ''} esta semana`,
    eventos.length && `${eventos.length} evento${eventos.length > 1 ? 's' : ''}`,
  ].filter(Boolean);

  return {
    texto: bloques.join('\n\n'),
    corto: partesCorto.length ? partesCorto.join(' · ') : 'Mirá cómo viene tu semana.',
  };
}
