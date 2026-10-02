import ICAL from 'ical.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NOMBRE } from '@/lib/marca';

/**
 * Las tareas y avisos de una persona como calendario iCal, para suscribirse
 * desde Google Calendar, Apple o Outlook ("Agregar calendario desde URL").
 * Es de solo lectura: el calendario lo consulta solo cada tanto (Google,
 * cada varias horas). Lo sirve app/api/calendario/[token]/route.ts.
 */

const DIAS_ICAL = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Duración que se le da a un aviso en el calendario (es un instante, no un evento). */
const MINUTOS_AVISO = 15;

/** Regla de repetición iCal (RRULE) equivalente a nuestras repeticiones. */
function regla(repeticion: string | null, dias: number[] | null): string | null {
  if (repeticion === 'diaria') return 'FREQ=DAILY';
  if (repeticion === 'laborables') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (repeticion === 'mensual') return 'FREQ=MONTHLY';
  if (repeticion === 'semanal') {
    return dias?.length ? `FREQ=WEEKLY;BYDAY=${dias.map((d) => DIAS_ICAL[d]).join(',')}` : 'FREQ=WEEKLY';
  }
  return null;
}

function nuevoEvento(uid: string, titulo: string, descripcion?: string) {
  const comp = new ICAL.Component('vevent');
  comp.updatePropertyWithValue('uid', uid);
  comp.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  comp.updatePropertyWithValue('summary', titulo);
  if (descripcion) comp.updatePropertyWithValue('description', descripcion);
  return comp;
}

export async function calendarioDeTareas(supabase: SupabaseClient, userId: string): Promise<string> {
  const [tareas, avisos] = await Promise.all([
    supabase
      .from('tareas')
      .select('id, titulo, descripcion, fecha_limite, repeticion, dias_semana')
      .eq('user_id', userId)
      .eq('completada', false)
      .not('fecha_limite', 'is', null),
    supabase
      .from('recordatorios')
      .select('id, mensaje, enviar_en, repeticion, dias_semana')
      .eq('user_id', userId)
      .is('enviado_en', null),
  ]);

  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.updatePropertyWithValue('prodid', `-//${NOMBRE}//Tareas//ES`);
  cal.updatePropertyWithValue('version', '2.0');
  cal.updatePropertyWithValue('calscale', 'GREGORIAN');
  cal.updatePropertyWithValue('x-wr-calname', `${NOMBRE} · tareas y avisos`);
  // Pide a los calendarios que lo vuelvan a consultar cada hora (Google lo ignora).
  cal.updatePropertyWithValue('x-published-ttl', 'PT1H');

  for (const t of tareas.data ?? []) {
    const ev = nuevoEvento(`tarea-${t.id}@${NOMBRE.toLowerCase()}`, `✅ ${t.titulo}`, t.descripcion ?? undefined);
    // Tarea = evento de día completo en su fecha límite.
    const dia = ICAL.Time.fromDateString(t.fecha_limite);
    const siguiente = dia.clone();
    siguiente.addDuration(ICAL.Duration.fromData({ days: 1 }));
    ev.updatePropertyWithValue('dtstart', dia);
    ev.updatePropertyWithValue('dtend', siguiente);
    const rrule = regla(t.repeticion, t.dias_semana);
    if (rrule) ev.updatePropertyWithValue('rrule', ICAL.Recur.fromString(rrule));
    cal.addSubcomponent(ev);
  }

  for (const r of avisos.data ?? []) {
    const ev = nuevoEvento(`aviso-${r.id}@${NOMBRE.toLowerCase()}`, `⏰ ${r.mensaje}`);
    const inicio = new Date(r.enviar_en);
    ev.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(inicio, true));
    ev.updatePropertyWithValue(
      'dtend',
      ICAL.Time.fromJSDate(new Date(inicio.getTime() + MINUTOS_AVISO * 60_000), true)
    );
    const rrule = regla(r.repeticion, r.dias_semana);
    if (rrule) ev.updatePropertyWithValue('rrule', ICAL.Recur.fromString(rrule));
    cal.addSubcomponent(ev);
  }

  return cal.toString();
}
