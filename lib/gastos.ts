import type { SupabaseClient } from '@supabase/supabase-js';

/** Las mismas categorías que el check de la tabla gastos (supabase-schema.sql). */
export const CATEGORIAS_GASTO = [
  'comida',
  'transporte',
  'hogar',
  'servicios',
  'salud',
  'ocio',
  'compras',
  'educacion',
  'trabajo',
  'otros',
] as const;

export type CategoriaGasto = (typeof CATEGORIAS_GASTO)[number];

/** Formato del país de cada moneda: así el peso de cada país se ve como "$". */
const REGION_DE_MONEDA: Record<string, string> = {
  COP: 'es-CO',
  ARS: 'es-AR',
  MXN: 'es-MX',
  CLP: 'es-CL',
  PEN: 'es-PE',
  UYU: 'es-UY',
  EUR: 'es-ES',
};

/** "$ 1.234.567" en la moneda indicada, sin decimales si no hacen falta. */
export function formatearMonto(monto: number, moneda: string): string {
  const decimales = Number.isInteger(monto) ? 0 : 2;
  try {
    return new Intl.NumberFormat(REGION_DE_MONEDA[moneda] ?? 'es-CO', {
      style: 'currency',
      currency: moneda,
      minimumFractionDigits: decimales,
      maximumFractionDigits: decimales,
    }).format(monto);
  } catch {
    return `${monto} ${moneda}`;
  }
}

export type ResumenGastos = {
  total_por_moneda: { moneda: string; total: number; texto: string }[];
  por_categoria: { categoria: string; moneda: string; total: number; texto: string; cantidad: number }[];
  cantidad: number;
  mayor?: { descripcion: string | null; categoria: string; texto: string; fecha: string };
};

/**
 * Totales de un período (fechas YYYY-MM-DD, ambas incluidas), por moneda y
 * por categoría, ordenados de mayor a menor. Filtra por usuario a mano para
 * servir tanto con la sesión como con el cliente de servicio (el cron).
 */
export async function resumirGastos(
  supabase: SupabaseClient,
  userId: string,
  desde: string,
  hasta: string
): Promise<ResumenGastos> {
  const { data } = await supabase
    .from('gastos')
    .select('monto, moneda, categoria, descripcion, fecha')
    .eq('user_id', userId)
    .gte('fecha', desde)
    .lte('fecha', hasta);
  const filas = (data ?? []).map((g) => ({ ...g, monto: Number(g.monto) }));

  const porMoneda = new Map<string, number>();
  const porCategoria = new Map<string, { moneda: string; categoria: string; total: number; cantidad: number }>();
  for (const g of filas) {
    porMoneda.set(g.moneda, (porMoneda.get(g.moneda) ?? 0) + g.monto);
    const clave = `${g.moneda}|${g.categoria}`;
    const c = porCategoria.get(clave) ?? { moneda: g.moneda, categoria: g.categoria, total: 0, cantidad: 0 };
    c.total += g.monto;
    c.cantidad++;
    porCategoria.set(clave, c);
  }
  const mayor = filas.sort((a, b) => b.monto - a.monto)[0];

  return {
    total_por_moneda: [...porMoneda]
      .map(([moneda, total]) => ({ moneda, total, texto: formatearMonto(total, moneda) }))
      .sort((a, b) => b.total - a.total),
    por_categoria: [...porCategoria.values()]
      .map((c) => ({ ...c, texto: formatearMonto(c.total, c.moneda) }))
      .sort((a, b) => b.total - a.total),
    cantidad: filas.length,
    mayor: mayor && {
      descripcion: mayor.descripcion,
      categoria: mayor.categoria,
      texto: formatearMonto(mayor.monto, mayor.moneda),
      fecha: mayor.fecha,
    },
  };
}
