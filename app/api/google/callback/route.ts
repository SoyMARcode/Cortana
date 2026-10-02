import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { guardarConexion, leerEstado } from '@/lib/google';

export const dynamic = 'force-dynamic';

/** Vuelve al chat con un mensaje ya escrito que cuenta cómo salió. */
function volver(req: Request, mensaje: string) {
  return NextResponse.redirect(new URL(`/?mensaje=${encodeURIComponent(mensaje)}`, req.url));
}

/**
 * Google vuelve acá después de que la persona da (o niega) el permiso. El
 * state firmado prueba quién empezó la conexión; además tiene que coincidir
 * con la sesión abierta, para que nadie conecte su Google en la cuenta de otro.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('error')) {
    return volver(req, 'No conecté Google Calendar: cancelé el permiso.');
  }
  const userId = leerEstado(url.searchParams.get('state'));
  const codigo = url.searchParams.get('code');
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!userId || !codigo || data?.claims.sub !== userId) {
    return volver(req, 'La conexión con Google Calendar venció o no es válida. ¿Me pasás el enlace de nuevo?');
  }
  try {
    const email = await guardarConexion(userId, codigo);
    return volver(req, `Listo, conecté Google Calendar${email ? ` (${email})` : ''}. ¿Qué tengo esta semana?`);
  } catch (e) {
    console.error('[google] No se pudo conectar:', e);
    return volver(req, 'No se pudo conectar Google Calendar. ¿Lo intentamos de nuevo?');
  }
}
