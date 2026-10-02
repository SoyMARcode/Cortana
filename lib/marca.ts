/**
 * Marca de la app: nombre y logo en un solo lugar. Para renombrar la app se
 * cambia acá (y el fallback de public/sw.js, que no puede importar esto), y se
 * regeneran los íconos con: node scripts/generar-iconos.ts
 */

export const NOMBRE = 'QIR';
/** Cómo lo dice la voz: "QIR" se leería letra por letra. */
export const NOMBRE_HABLADO = 'Kir';

/** Dirección pública de la app, para enlaces que salen de ella (ej. el calendario de tareas). */
export const URL_APP = process.env.NEXT_PUBLIC_APP_URL || 'https://elqir.com';

/**
 * Geometría del logo, redibujada a partir del original. Unidades: la altura
 * de las letras mide 55. La Q es un anillo cortado en diagonal por su cola;
 * la R no tiene palo: es la panza más la pierna.
 */
export const LOGO = {
  ancho: 137,
  alto: 55,
  /** Ancho de la Q sola (con la cola), para el monograma de los íconos. */
  anchoQ: 58,
  anillo: { cx: 28, cy: 27.5, r: 22.6, grosor: 10.3 },
  /** Cola de la Q. */
  cola: '25,32 37,32 57.5,55 46,55',
  /** Franja que se le quita al anillo para separarlo de la cola. */
  corte: '19,32 43,32 66,58 42,58',
  /** La I. */
  i: { x: 67, y: 0, ancho: 10, alto: 55 },
  /** La R: barra de arriba, panza y pierna en un solo trazo. */
  r: 'M88 0H120A16 16 0 0 1 136 16V17A15 15 0 0 1 121 32H114.6L137 55H122L94 25H118.5A7.5 7.5 0 0 0 118.5 10H88Z',
} as const;

/** El logo como SVG en texto, para generar PNG y usar en correos. */
export function svgLogo({ color, soloQ = false }: { color: string; soloQ?: boolean }): string {
  const { anillo: a } = LOGO;
  const ancho = soloQ ? LOGO.anchoQ : LOGO.ancho;
  const resto = soloQ
    ? ''
    : `<rect x="${LOGO.i.x}" y="${LOGO.i.y}" width="${LOGO.i.ancho}" height="${LOGO.i.alto}"/><path d="${LOGO.r}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ancho} ${LOGO.alto}" fill="${color}">
<defs><mask id="qir-corte" maskUnits="userSpaceOnUse" x="0" y="0" width="${ancho}" height="${LOGO.alto}"><rect width="${ancho}" height="${LOGO.alto}" fill="#fff"/><polygon points="${LOGO.corte}" fill="#000"/></mask></defs>
<circle cx="${a.cx}" cy="${a.cy}" r="${a.r}" fill="none" stroke="${color}" stroke-width="${a.grosor}" mask="url(#qir-corte)"/>
<polygon points="${LOGO.cola}"/>${resto}
</svg>`;
}
