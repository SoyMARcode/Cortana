/** Diferencia (ms) entre la hora local de `zona` y UTC en el instante `t`. */
function desfase(t: number, zona: string): number {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zona,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value])
  );
  const comoUtc = Date.UTC(
    +partes.year,
    +partes.month - 1,
    +partes.day,
    +partes.hour,
    +partes.minute,
    +partes.second
  );
  return comoUtc - (t - (t % 1000));
}

/**
 * "2026-09-29T06:45" (o con segundos, "2026-09-29T06:45:30") en la zona
 * "America/Bogota" -> instante UTC real. Devuelve null si el formato no es
 * YYYY-MM-DDTHH:mm[:ss].
 */
export function horaLocalAUtc(fechaHora: string, zona: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(fechaHora);
  if (!m) return null;
  const [anio, mes, dia, hora, minuto, segundo] = m.slice(1).map((v) => Number(v ?? 0));
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hora > 23 || minuto > 59 || segundo > 59) {
    return null;
  }

  const comoUtc = Date.UTC(anio, mes - 1, dia, hora, minuto, segundo);
  // Dos pasadas: la segunda corrige los días de cambio de horario de verano.
  let t = comoUtc - desfase(comoUtc, zona);
  t = comoUtc - desfase(t, zona);
  return new Date(t);
}

/** Fecha "YYYY-MM-DD", hora "HH:mm:ss", día de la semana (0 = domingo) y hora (0-23) locales. */
export function partesLocales(instante: Date, zona: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zona,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
      .formatToParts(instante)
      .map((x) => [x.type, x.value])
  );
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    hora: `${p.hour}:${p.minute}:${p.second}`,
    horaDelDia: Number(p.hour),
    diaSemana: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

/**
 * "lunes 29 de septiembre, 6:45" en la hora local de `zona`. Si el instante
 * tiene segundos (un aviso "en 30 segundos"), también los muestra.
 */
export function formatearEnZona(instante: Date, zona: string): string {
  const dia = new Intl.DateTimeFormat('es', {
    timeZone: zona,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(instante);
  const hora = new Intl.DateTimeFormat('es', {
    timeZone: zona,
    hour: 'numeric',
    minute: '2-digit',
    second: instante.getUTCSeconds() ? '2-digit' : undefined,
  }).format(instante);
  return `${dia}, ${hora}`;
}
