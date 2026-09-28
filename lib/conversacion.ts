import type { UIMessage } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';

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
