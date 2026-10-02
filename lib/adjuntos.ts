/**
 * Archivos que el usuario adjunta en el chat. Se suben a Supabase Storage
 * (bucket "adjuntos", carpeta = id del usuario) y viajan en la metadata del
 * mensaje; QIR puede verlos (imágenes y PDF) y mandarlos por correo.
 */

export const BUCKET_ADJUNTOS = 'adjuntos';

/** 10 MB por archivo (igual que el límite del bucket en supabase-schema.sql). */
export const MAX_BYTES_ADJUNTO = 10 * 1024 * 1024;

/** Hasta 5 archivos por mensaje. */
export const MAX_ADJUNTOS = 5;

/** Total adjunto a un correo. Resend acepta hasta 40 MB; se deja margen. */
export const MAX_BYTES_CORREO = 25 * 1024 * 1024;

/** Lo que el modelo puede ver directamente (además lo puede reenviar). */
export const TIPOS_VISIBLES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];

export type Adjunto = { nombre: string; ruta: string; tipo: string; tamano: number };

export type MetadataMensaje = { adjuntos?: Adjunto[] };

/** "Informe final (v2).pdf" -> "Informe-final-v2.pdf", seguro para una ruta de Storage. */
export function nombreSeguro(nombre: string): string {
  const limpio = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return limpio.slice(-80) || 'archivo';
}

export function tamanoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
