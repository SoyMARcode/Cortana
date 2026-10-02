import type { UIMessage } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BUCKET_ADJUNTOS,
  TIPOS_VISIBLES,
  tamanoLegible,
  type MetadataMensaje,
} from '@/lib/adjuntos';

/** Mensajes que se guardan en la base (los más viejos se descartan). */
const MAX_GUARDADOS = 200;

/** Mensajes que se le mandan al modelo en cada turno, para acotar costo y contexto. */
const MAX_PARA_MODELO = 40;

export async function cargarConversacion(
  supabase: SupabaseClient,
  userId: string
): Promise<UIMessage[]> {
  const { data } = await supabase
    .from('conversaciones')
    .select('mensajes')
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.mensajes as UIMessage[] | undefined) ?? [];
}

export async function guardarConversacion(
  supabase: SupabaseClient,
  userId: string,
  mensajes: UIMessage[]
) {
  const { error } = await supabase.from('conversaciones').upsert({
    user_id: userId,
    mensajes: mensajes.slice(-MAX_GUARDADOS),
    updated_at: new Date().toISOString(),
  });
  if (error) console.error('[conversacion] No se pudo guardar el historial:', error.message);
}

/** Imágenes más grandes que esto no se le muestran al modelo (Anthropic acepta hasta 5 MB). */
const MAX_BYTES_IMAGEN_VISIBLE = 4.5 * 1024 * 1024;

/**
 * Copia de los mensajes para el modelo con los adjuntos a la vista: a cada
 * mensaje con archivos se le suma una nota con nombre y ruta (para poder
 * reenviarlos con enviar_correo), y los del último mensaje del usuario
 * también van como archivo para que QIR los vea. Los anteriores no se
 * vuelven a mandar: ya los vio cuando llegaron, y así el costo no crece.
 */
export async function adjuntosParaModelo(
  supabase: SupabaseClient,
  mensajes: UIMessage[]
): Promise<UIMessage[]> {
  const ultimoUsuario = mensajes.findLastIndex((m) => m.role === 'user');

  return Promise.all(
    mensajes.map(async (m, i) => {
      const adjuntos = (m.metadata as MetadataMensaje | undefined)?.adjuntos;
      if (m.role !== 'user' || !adjuntos?.length) return m;

      const nota = `[Adjuntos del usuario: ${adjuntos
        .map((a) => `"${a.nombre}" (ruta: ${a.ruta}, ${tamanoLegible(a.tamano)})`)
        .join('; ')}]`;
      const partes: UIMessage['parts'] = [...m.parts, { type: 'text', text: nota }];

      if (i === ultimoUsuario) {
        for (const a of adjuntos) {
          const esImagen = a.tipo.startsWith('image/');
          if (!TIPOS_VISIBLES.includes(a.tipo)) continue;
          if (esImagen && a.tamano > MAX_BYTES_IMAGEN_VISIBLE) continue;
          const { data } = await supabase.storage.from(BUCKET_ADJUNTOS).download(a.ruta);
          if (!data) continue;
          const base64 = Buffer.from(await data.arrayBuffer()).toString('base64');
          partes.push({
            type: 'file',
            mediaType: a.tipo,
            filename: a.nombre,
            url: `data:${a.tipo};base64,${base64}`,
          });
        }
      }
      return { ...m, parts: partes };
    })
  );
}

/**
 * Los últimos mensajes, empezando siempre en uno del usuario para no cortar
 * a la mitad una llamada a herramienta y su resultado.
 */
export function ventanaParaModelo(mensajes: UIMessage[]): UIMessage[] {
  if (mensajes.length <= MAX_PARA_MODELO) return mensajes;
  const recientes = mensajes.slice(-MAX_PARA_MODELO);
  const inicio = recientes.findIndex((m) => m.role === 'user');
  return inicio === -1 ? recientes : recientes.slice(inicio);
}
