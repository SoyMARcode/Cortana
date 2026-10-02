import ICAL from 'ical.js';
import { formatearEnZona } from '@/lib/zona-horaria';

/**
 * Calendario de solo lectura a partir de la "dirección secreta en formato
 * iCal" que ofrecen Google Calendar, Outlook y Apple. No necesita OAuth: el
 * usuario pega el enlace una vez y QIR lo guarda en `ajustes.calendario_ics`.
 */

const TAMANO_MAXIMO = 5 * 1024 * 1024;

/** Tope de repeticiones que se recorren por evento, por si una regla es enorme. */
const MAX_ITERACIONES = 5000;

export type EventoCalendario = {
  /** Identificador único de esta ocurrencia: UID del evento + inicio. */
  clave: string;
  titulo: string;
  /** "lunes 6 de octubre, 9:00", o solo el día si es de día completo. */
  cuando: string;
  hasta?: string;
  todo_el_dia: boolean;
  lugar?: string;
  inicio: string;
};

/**
 * Acepta solo https (o webcal, que es https) hacia un dominio público. Evita
 * que alguien use el servidor para pedir direcciones internas.
 */
export function validarEnlace(enlace: string): URL | null {
  let url: URL;
  try {
    url = new URL(enlace.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const esIp = /^[\d.]+$/.test(host) || host.includes(':');
  if (url.protocol !== 'https:' || esIp || host === 'localhost' || !host.includes('.')) {
    return null;
  }
  return url;
}

async function descargar(inicial: URL): Promise<string> {
  // Las redirecciones se siguen a mano para validar cada destino.
  let url = inicial;
  let res: Response | undefined;
  for (let saltos = 0; saltos < 4; saltos++) {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual', cache: 'no-store' });
    const destino = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!destino) break;
    const siguiente = validarEnlace(new URL(destino, url).toString());
    if (!siguiente) throw new Error('El calendario redirige a una dirección no permitida.');
    url = siguiente;
  }
  if (!res) throw new Error('No se pudo leer el calendario.');
  if (!res.ok) throw new Error(`El calendario respondió ${res.status}. Revisá que el enlace sea el secreto en formato iCal.`);
  const texto = await res.text();
  if (texto.length > TAMANO_MAXIMO) throw new Error('El calendario es demasiado grande.');
  if (!texto.includes('BEGIN:VCALENDAR')) {
    throw new Error('Ese enlace no es un calendario iCal (.ics).');
  }
  return texto;
}

function fechaDeDia(t: ICAL.Time): string {
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

function textoDia(fecha: string): string {
  return new Intl.DateTimeFormat('es', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(fecha + 'T00:00:00Z'));
}

/** Eventos entre `desde` y `hasta`, ordenados, con las horas en la zona del usuario. */
export async function eventosEntre(
  enlace: string,
  desde: Date,
  hasta: Date,
  zona: string
): Promise<EventoCalendario[]> {
  const url = validarEnlace(enlace);
  if (!url) throw new Error('El enlace del calendario no es válido.');

  const raiz = new ICAL.Component(ICAL.parse(await descargar(url)));
  for (const tz of raiz.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);

  // Las ediciones de una sola repetición vienen como eventos aparte con el
  // mismo UID: se asocian a su evento principal.
  const eventos = raiz.getAllSubcomponents('vevent').map((c) => new ICAL.Event(c));
  const principales = new Map<string, ICAL.Event>();
  for (const e of eventos) if (!e.isRecurrenceException()) principales.set(e.uid, e);
  for (const e of eventos) if (e.isRecurrenceException()) principales.get(e.uid)?.relateException(e);

  const resultado: EventoCalendario[] = [];
  const agregar = (uid: string, titulo: string, inicio: ICAL.Time, fin: ICAL.Time, lugar: string) => {
    const empieza = inicio.isDate ? new Date(fechaDeDia(inicio) + 'T00:00:00Z') : inicio.toJSDate();
    const termina = fin.isDate ? new Date(fechaDeDia(fin) + 'T00:00:00Z') : fin.toJSDate();
    if (termina <= desde || empieza >= hasta) return;
    resultado.push({
      clave: `${uid}|${empieza.toISOString()}`,
      titulo: titulo || '(sin título)',
      cuando: inicio.isDate ? textoDia(fechaDeDia(inicio)) : formatearEnZona(empieza, zona),
      hasta: inicio.isDate ? undefined : formatearEnZona(termina, zona),
      todo_el_dia: inicio.isDate,
      lugar: lugar || undefined,
      inicio: empieza.toISOString(),
    });
  };

  for (const evento of principales.values()) {
    if (!evento.isRecurring()) {
      agregar(evento.uid, evento.summary, evento.startDate, evento.endDate, evento.location);
      continue;
    }
    const iterador = evento.iterator();
    for (let i = 0, t = iterador.next(); t && i < MAX_ITERACIONES; i++, t = iterador.next()) {
      if (t.toJSDate() >= hasta) break;
      const det = evento.getOccurrenceDetails(t);
      agregar(evento.uid, det.item.summary, det.startDate, det.endDate, det.item.location);
    }
  }

  return resultado
    .sort((a, b) => a.inicio.localeCompare(b.inicio))
    .slice(0, 100);
}

/** Comprueba que el enlace funcione antes de guardarlo. Devuelve cuántos eventos hay en 30 días. */
export async function probarCalendario(enlace: string, zona: string): Promise<number> {
  const ahora = new Date();
  const eventos = await eventosEntre(enlace, ahora, new Date(ahora.getTime() + 30 * 86_400_000), zona);
  return eventos.length;
}
