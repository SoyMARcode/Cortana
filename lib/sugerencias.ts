/**
 * Botones de respuesta rápida. QIR termina algunas respuestas con una línea
 * como:  [[Sí, programalo | Cambiá la hora | No, gracias]]
 * La app la saca del texto (no se muestra ni se lee en voz alta) y dibuja
 * cada opción como un botón que, al tocarlo, se envía como mensaje.
 */

const MARCA = /\[\[([^\]]{1,300})\]\]\s*$/;

/** Hasta 3 opciones de hasta 40 caracteres cada una. */
const MAX_OPCIONES = 3;
const MAX_LARGO = 40;

export function separarSugerencias(texto: string): { texto: string; sugerencias: string[] } {
  const m = MARCA.exec(texto);
  if (!m) return { texto, sugerencias: [] };
  const sugerencias = m[1]
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s && s.length <= MAX_LARGO)
    .slice(0, MAX_OPCIONES);
  return { texto: texto.slice(0, m.index).trimEnd(), sugerencias };
}

/**
 * Saca cualquier marca de sugerencias, esté donde esté (para la voz y los
 * mensajes viejos). También una marca a medio escribir mientras llega la
 * respuesta, así no parpadea "[[Sí, progr" en pantalla.
 */
export function sinSugerencias(texto: string): string {
  return texto
    .replace(/\[\[[^\]]{0,300}\]\]/g, '')
    .replace(/\[\[[^\]]*$/, '')
    .trimEnd();
}
