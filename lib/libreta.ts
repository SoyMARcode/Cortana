import type { SupabaseClient } from '@supabase/supabase-js';

export type Tarea = {
  id: string;
  titulo: string;
  fecha_limite: string | null;
  completada: boolean;
  updated_at: string;
};

export type Contacto = { nombre: string; email: string };

export type Recordatorio = { id: string; mensaje: string; enviar_en: string };

export type Libreta = { tareas: Tarea[]; contactos: Contacto[]; recordatorios: Recordatorio[] };

/**
 * Tareas pendientes + las completadas en las últimas 36 h (el panel muestra
 * solo las de hoy según la hora local; el margen cubre cualquier zona horaria).
 * Sirve tanto con el cliente del servidor como con el del navegador: RLS
 * limita todo a las filas del usuario.
 */
export async function cargarLibreta(supabase: SupabaseClient): Promise<Libreta> {
  const hace36h = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const [tareas, contactos, recordatorios] = await Promise.all([
    supabase
      .from('tareas')
      .select('id, titulo, fecha_limite, completada, updated_at')
      .or(`completada.eq.false,updated_at.gte.${hace36h}`)
      .order('fecha_limite', { ascending: true, nullsFirst: false }),
    supabase.from('contactos').select('nombre, email').order('nombre'),
    supabase
      .from('recordatorios')
      .select('id, mensaje, enviar_en')
      .is('enviado_en', null)
      .order('enviar_en')
      .limit(20),
  ]);
  return {
    tareas: (tareas.data as Tarea[] | null) ?? [],
    contactos: (contactos.data as Contacto[] | null) ?? [],
    recordatorios: (recordatorios.data as Recordatorio[] | null) ?? [],
  };
}

/** "hoy 6:45", "mañana 7:00", "jue 1, 9:30" en la hora local del navegador. */
export function textoAviso(enviarEn: string): string {
  const instante = new Date(enviarEn);
  const hora = new Intl.DateTimeFormat('es', { hour: 'numeric', minute: '2-digit' }).format(instante);
  const fecha = new Intl.DateTimeFormat('en-CA').format(instante);
  const plazo = textoPlazo(fecha);
  return `${plazo}${plazo === 'hoy' || plazo === 'mañana' ? '' : ','} ${hora}`;
}

/** "YYYY-MM-DD" de hoy en la hora local del navegador. */
function hoyLocal(): string {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

function diasHasta(fecha: string): number {
  const ms = Date.parse(fecha + 'T00:00:00Z') - Date.parse(hoyLocal() + 'T00:00:00Z');
  return Math.round(ms / 86_400_000);
}

/** Texto corto de plazo: "hoy", "mañana", "jue 1", "15 oct", "hace 2 días". */
export function textoPlazo(fecha: string | null): string {
  if (!fecha) return '';
  const dias = diasHasta(fecha);
  if (dias === -1) return 'ayer';
  if (dias < -1) return `hace ${-dias} días`;
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'mañana';
  const d = new Date(fecha + 'T00:00:00Z');
  if (dias < 7) {
    const dia = new Intl.DateTimeFormat('es', { weekday: 'short', timeZone: 'UTC' })
      .format(d)
      .replace('.', '');
    return `${dia} ${d.getUTCDate()}`;
  }
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '');
}

export type Grupo = { clave: string; titulo: string; urgente: boolean; tareas: Tarea[] };

/** Agrupa las tareas por cuándo vencen, en el orden en que se muestran. */
export function agruparTareas(tareas: Tarea[]): Grupo[] {
  const hoy = hoyLocal();
  const grupos: Grupo[] = [
    { clave: 'atrasadas', titulo: 'Atrasadas', urgente: true, tareas: [] },
    { clave: 'hoy', titulo: 'Vence hoy', urgente: true, tareas: [] },
    { clave: 'semana', titulo: 'Esta semana', urgente: false, tareas: [] },
    { clave: 'despues', titulo: 'Más adelante', urgente: false, tareas: [] },
    { clave: 'sin-fecha', titulo: 'Sin fecha', urgente: false, tareas: [] },
    { clave: 'hechas', titulo: 'Hechas hoy', urgente: false, tareas: [] },
  ];
  const [atrasadas, deHoy, semana, despues, sinFecha, hechas] = grupos;

  for (const t of tareas) {
    if (t.completada) {
      if (new Intl.DateTimeFormat('en-CA').format(new Date(t.updated_at)) === hoy) hechas.tareas.push(t);
      continue;
    }
    if (!t.fecha_limite) sinFecha.tareas.push(t);
    else {
      const dias = diasHasta(t.fecha_limite);
      if (dias < 0) atrasadas.tareas.push(t);
      else if (dias === 0) deHoy.tareas.push(t);
      else if (dias < 7) semana.tareas.push(t);
      else despues.tareas.push(t);
    }
  }
  return grupos.filter((g) => g.tareas.length > 0);
}
