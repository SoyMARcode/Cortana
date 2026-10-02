import { partesLocales } from '@/lib/zona-horaria';

export type HorarioNoMolestar = {
  zona_horaria: string;
  no_molestar: boolean;
  no_molestar_desde: number;
  no_molestar_hasta: number;
};

/**
 * true si ahora es horario de no molestar para esta persona (por defecto de
 * 22:00 a 7:00, en su hora local). Lo respetan los avisos automáticos: aviso
 * antes de eventos, vencimientos, rescate y limpieza. Los recordatorios que
 * la persona programó a una hora exacta y el buenos días (cuya hora eligió)
 * llegan igual.
 */
export function enNoMolestar(a: HorarioNoMolestar | null | undefined, ahora = new Date()): boolean {
  if (!a?.no_molestar || a.no_molestar_desde === a.no_molestar_hasta) return false;
  const hora = partesLocales(ahora, a.zona_horaria).horaDelDia;
  const { no_molestar_desde: desde, no_molestar_hasta: hasta } = a;
  // 22 a 7 cruza la medianoche; 13 a 15 (una siesta) no.
  return desde < hasta ? hora >= desde && hora < hasta : hora >= desde || hora < hasta;
}
