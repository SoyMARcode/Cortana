import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Destino de los enlaces que manda Supabase por correo (confirmar cuenta,
 * recuperar contraseña). Canjea el enlace por una sesión y lleva a la persona
 * a la app ya adentro.
 *
 * Acepta los dos formatos de enlace:
 * - ?code=...                     el que usa Supabase por defecto (PKCE).
 * - ?token_hash=...&type=...      el de las plantillas de correo recomendadas;
 *                                 funciona aunque el enlace se abra en otro
 *                                 navegador (ej. el de la app de Gmail).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const destino = rutaSegura(searchParams.get('next'));

  const supabase = await createClient();
  let error: { message: string } | null = null;

  if (tokenHash && type) {
    ({ error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type }));
  } else if (code) {
    ({ error } = await supabase.auth.exchangeCodeForSession(code));
  } else {
    error = { message: 'Enlace incompleto' };
  }

  if (!error) return NextResponse.redirect(new URL(destino, request.url));

  console.error('[auth/confirm] No se pudo canjear el enlace:', error.message);
  // Con el enlace por defecto (?code=), Supabase ya confirmó el correo antes de
  // llegar acá: lo que falla es solo abrir la sesión en este navegador. Por eso
  // al registrarse alcanza con iniciar sesión; al recuperar hay que pedir otro enlace.
  const login = new URL('/login', request.url);
  login.searchParams.set('aviso', destino === '/nueva-contrasena' ? 'recuperacion-fallida' : 'enlace-fallido');
  return NextResponse.redirect(login);
}

/** Solo rutas internas, para que nadie use el enlace para redirigir a otro sitio. */
function rutaSegura(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
