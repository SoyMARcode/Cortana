import { z } from 'zod';

export const REPETICIONES = ['diaria', 'laborables', 'semanal', 'mensual'] as const;
export type Repeticion = (typeof REPETICIONES)[number];

/** Campos de repetición que comparten tareas y recordatorios en las herramientas. */
export const esquemaRepeticion = {
  repeticion: z
    .enum(REPETICIONES)
    .nullable()
    .optional()
    .describe(
      'Si se repite: "diaria", "laborables" (lunes a viernes), "semanal" o "mensual". null para que deje de repetirse.'
    ),
  dias_semana: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .optional()
    .describe(
      'Solo con "semanal": días en que se repite, 0 = domingo ... 6 = sábado. Ej. "todos los lunes y jueves" = [1, 4]. Sin días, cada 7 días desde la fecha.'
    ),
};

const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function diaDeSemana(fecha: string): number {
  return new Date(fecha + 'T00:00:00Z').getUTCDay();
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Próxima fecha (YYYY-MM-DD) de una repetición. Es la misma lógica que la
 * función siguiente_fecha de supabase-schema.sql, que usan las tareas.
 */
export function siguienteFecha(
  fecha: string,
  repeticion: Repeticion,
  dias?: number[] | null
): string {
  if (repeticion === 'diaria') return sumarDias(fecha, 1);
  if (repeticion === 'mensual') {
    const [a, m, d] = fecha.split('-').map(Number);
    // Como Postgres: el 31 de enero pasa al último día de febrero.
    const ultimoDia = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(a, m, Math.min(d, ultimoDia))).toISOString().slice(0, 10);
  }
  let d = sumarDias(fecha, 1);
  if (repeticion === 'laborables') {
    while ([0, 6].includes(diaDeSemana(d))) d = sumarDias(d, 1);
    return d;
  }
  if (!dias?.length) return sumarDias(fecha, 7);
  while (!dias.includes(diaDeSemana(d))) d = sumarDias(d, 1);
  return d;
}

/** "todos los días", "de lunes a viernes", "todos los lunes y jueves", "todos los meses". */
export function textoRepeticion(repeticion: string | null, dias?: number[] | null): string {
  if (repeticion === 'diaria') return 'todos los días';
  if (repeticion === 'laborables') return 'de lunes a viernes';
  if (repeticion === 'mensual') return 'todos los meses';
  if (repeticion === 'semanal') {
    if (!dias?.length) return 'todas las semanas';
    const nombres = [...new Set(dias)].sort().map((d) => NOMBRES_DIA[d]);
    const lista =
      nombres.length === 1 ? nombres[0] : `${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)}`;
    return `todos los ${lista.replace(/(sábado|domingo)(?=,| y|$)/g, '$1s')}`;
  }
  return '';
}
