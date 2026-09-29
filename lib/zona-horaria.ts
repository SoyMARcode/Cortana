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
 * "2026-09-29T06:45" en la zona "America/Bogota" -> instante UTC real.
 * Devuelve null si el formato no es YYYY-MM-DDTHH:mm.
 */
export function horaLocalAUtc(fechaHora: string, zona: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(fechaHora);
  if (!m) return null;
  const [anio, mes, dia, hora, minuto] = m.slice(1).map(Number);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hora > 23 || minuto > 59) return null;

  const comoUtc = Date.UTC(anio, mes - 1, dia, hora, minuto);
  // Dos pasadas: la segunda corrige los días de cambio de horario de verano.
  let t = comoUtc - desfase(comoUtc, zona);
  t = comoUtc - desfase(t, zona);
  return new Date(t);
}

/** "lunes 29 de septiembre, 6:45" en la hora local de `zona`. */
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
  }).format(instante);
  return `${dia}, ${hora}`;
}
