import type { SupabaseClient } from '@supabase/supabase-js';
import { pronostico } from '@/lib/clima';
import { eventosEntre } from '@/lib/calendario';
import { horaLocalAUtc, partesLocales } from '@/lib/zona-horaria';

/** Cuántos eventos y avisos se nombran; el resto se cuenta. */
const MAX_NOMBRADOS = 2;

export type FilaBuenosDias = {
  user_id: string;
  zona_horaria: string;
  latitud: number | null;
  longitud: number | null;
  lugar: string | null;
  calendario_ics: string | null;
};

function hora12(instante: Date, zona: string): string {
  return new Intl.DateTimeFormat('es', {
    timeZone: zona,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(instante);
}

function lista(items: string[]): string {
  const nombrados = items.slice(0, MAX_NOMBRADOS).join(', ');
  const resto = items.length - MAX_NOMBRADOS;
  return resto > 0 ? `${nombrados} y ${resto} más` : nombrados;
}

/**
 * El aviso de cada mañana: clima (con paraguas si va a llover), eventos del
 * calendario, tareas que vencen hoy o están atrasadas y avisos programados
 * para hoy. Una línea por tema, para que se lea de un vistazo en la
 * notificación. Devuelve null si no hay nada que contar.
 */
export async function armarBuenosDias(
  supabase: SupabaseClient,
  f: FilaBuenosDias
): Promise<{ titulo: string; cuerpo: string } | null> {
  const zona = f.zona_horaria;
  const ahora = new Date();
  const hoy = partesLocales(ahora, zona).fecha;
  const finDelDia = horaLocalAUtc(`${hoy}T23:59:59`, zona) ?? new Date(ahora.getTime() + 86_400_000);
  const inicioDelDia = horaLocalAUtc(`${hoy}T00:00`, zona) ?? ahora;

  const [clima, tareas, avisos, eventos] = await Promise.all([
    f.latitud != null && f.longitud != null
      ? pronostico({ nombre: f.lugar ?? 'tu zona', latitud: f.latitud, longitud: f.longitud }, 1).catch(
          () => null
        )
      : null,
    supabase
      .from('tareas')
      .select('titulo, fecha_limite')
      .eq('user_id', f.user_id)
      .eq('completada', false)
      .lte('fecha_limite', hoy)
      .order('fecha_limite'),
    supabase
      .from('recordatorios')
      .select('mensaje, enviar_en')
      .eq('user_id', f.user_id)
      .is('enviado_en', null)
      .gte('enviar_en', ahora.toISOString())
      .lte('enviar_en', finDelDia.toISOString())
      .order('enviar_en'),
    f.calendario_ics
      ? eventosEntre(f.calendario_ics, inicioDelDia, finDelDia, zona).catch((e) => {
          console.error('[buenos-dias] No se pudo leer el calendario:', e);
          return [];
        })
      : [],
  ]);

  const lineas: string[] = [];

  const dia = clima?.dias[0];
  if (clima && dia) {
    lineas.push(
      `${clima.ahora.temperatura}°, ${dia.descripcion}. Máx ${dia.maxima}°.` +
        (dia.llevar_paraguas ? ` Llevate paraguas ☂️ (${dia.prob_lluvia}% de lluvia).` : '')
    );
  }

  if (eventos.length) {
    lineas.push(
      `📅 ${lista(
        eventos.map((e) => (e.todo_el_dia ? e.titulo : `${hora12(new Date(e.inicio), zona)} ${e.titulo}`))
      )}`
    );
  }

  const pendientes = tareas.data ?? [];
  const deHoy = pendientes.filter((t) => t.fecha_limite === hoy);
  const atrasadas = pendientes.length - deHoy.length;
  if (pendientes.length) {
    const partes = [
      deHoy.length && `Vence hoy: ${lista(deHoy.map((t) => t.titulo))}`,
      atrasadas && `${atrasadas} atrasada${atrasadas > 1 ? 's' : ''}`,
    ].filter(Boolean);
    lineas.push(`✅ ${partes.join(' · ')}`);
  }

  if (avisos.data?.length) {
    lineas.push(
      `⏰ ${lista(avisos.data.map((r) => `${hora12(new Date(r.enviar_en), zona)} ${r.mensaje}`))}`
    );
  }

  if (!lineas.length) return null;
  // Solo vino el clima: se aclara que el día está libre.
  if (lineas.length === 1 && clima) lineas.push('Hoy no tenés nada agendado.');

  return { titulo: dia?.llevar_paraguas ? 'Buenos días ☔' : 'Buenos días ☀️', cuerpo: lineas.join('\n') };
}
