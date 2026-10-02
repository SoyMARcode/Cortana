/**
 * Documentos que la persona guarda para preguntarles después ("¿qué dice
 * el contrato sobre la renovación?"). Se guarda solo el texto, partido en
 * fragmentos con búsqueda en español (tablas documentos y
 * documento_fragmentos, función buscar_en_documentos).
 */

/** Tope de documentos guardados por persona. */
export const MAX_DOCUMENTOS = 30;

/** Tope de texto por documento (~400 páginas). */
export const MAX_CARACTERES = 1_000_000;

/** Tamaño de cada fragmento: cabe una idea completa y la búsqueda sigue siendo precisa. */
const LARGO_FRAGMENTO = 1500;

/** Cada fragmento repite el final del anterior, para no cortar una idea por la mitad. */
const SOLAPE = 200;

const TIPO_WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Tipos que se pueden guardar. */
export function tipoSoportado(tipo: string, nombre: string): 'pdf' | 'word' | 'texto' | null {
  const ext = nombre.toLowerCase().split('.').pop() ?? '';
  if (tipo === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (tipo === TIPO_WORD || ext === 'docx') return 'word';
  if (tipo.startsWith('text/') || ['txt', 'md', 'csv'].includes(ext)) return 'texto';
  return null;
}

/** Texto plano del archivo. Para PDF también devuelve la cantidad de páginas. */
export async function extraerTexto(
  datos: Buffer,
  clase: 'pdf' | 'word' | 'texto'
): Promise<{ texto: string; paginas?: number }> {
  if (clase === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(datos));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    // Cada página empieza con una marca, para poder citar "página 3".
    const texto = (text as string[]).map((t, i) => `[Página ${i + 1}]\n${t.trim()}`).join('\n\n');
    return { texto, paginas: totalPages };
  }
  if (clase === 'word') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: datos });
    return { texto: value };
  }
  return { texto: datos.toString('utf8') };
}

/** Parte el texto en fragmentos solapados, cortando en saltos de párrafo o de línea cuando se puede. */
export function fragmentar(texto: string): string[] {
  const limpio = texto.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const fragmentos: string[] = [];
  let inicio = 0;
  while (inicio < limpio.length) {
    let fin = Math.min(inicio + LARGO_FRAGMENTO, limpio.length);
    if (fin < limpio.length) {
      // Preferir cortar en un párrafo, si no en una línea, si no en un espacio.
      const ventana = limpio.slice(inicio + LARGO_FRAGMENTO / 2, fin);
      const corte = Math.max(ventana.lastIndexOf('\n\n'), ventana.lastIndexOf('\n'), ventana.lastIndexOf('. '));
      if (corte > 0) fin = inicio + LARGO_FRAGMENTO / 2 + corte + 1;
    }
    const pedazo = limpio.slice(inicio, fin).trim();
    if (pedazo) fragmentos.push(pedazo);
    if (fin >= limpio.length) break;
    inicio = Math.max(fin - SOLAPE, inicio + 1);
  }
  return fragmentos;
}

/**
 * Convierte "qué dice sobre la renovación del contrato" en una búsqueda que
 * encuentra fragmentos con CUALQUIERA de las palabras importantes (y los
 * ordena por cuántas tienen). Así una palabra que no aparece no deja la
 * búsqueda vacía.
 */
export function consultaFlexible(texto: string): string {
  const palabras = texto
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s"-]/gu, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 2 && p !== 'or' && p !== 'and');
  return [...new Set(palabras)].slice(0, 12).join(' or ');
}
