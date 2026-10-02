import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { enlaceDeAutorizacion, googleConfigurado } from '@/lib/google';

export const dynamic = 'force-dynamic';

/** Lleva a la pantalla de permisos de Google. El enlace lo da QIR (herramienta conectar_google_calendar). */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims.sub;
  if (!userId) return NextResponse.redirect(new URL('/login', req.url));
  if (!googleConfigurado()) {
    return new NextResponse('Google Calendar todavía no está configurado en el servidor.', { status: 503 });
  }
  return NextResponse.redirect(enlaceDeAutorizacion(userId));
}
