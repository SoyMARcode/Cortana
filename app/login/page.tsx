'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { alerta, avisar, avisarError, avisarExito } from '@/lib/alertas';
import { NOMBRE } from '@/lib/marca';
import { Logo } from '../iconos';

type Modo = 'login' | 'registro' | 'recuperar';

/** Mensajes de Supabase Auth en palabras que el equipo entienda. */
function traducirError(mensaje: string): string {
  // El trigger verificar_invitacion bloquea el registro; Supabase lo reporta así.
  if (/database error saving new user/i.test(mensaje)) {
    return `Tu email no está invitado a ${NOMBRE}. Pedile acceso a quien administra el equipo.`;
  }
  if (/invalid login credentials/i.test(mensaje)) {
    return 'Email o contraseña incorrectos. Si no te acordás la contraseña, usá "¿Olvidaste tu contraseña?".';
  }
  if (/user already registered/i.test(mensaje)) return 'Ese email ya tiene cuenta. Iniciá sesión.';
  if (/password should be at least/i.test(mensaje)) {
    return 'La contraseña tiene que tener al menos 6 caracteres.';
  }
  if (/rate limit|only request this after/i.test(mensaje)) {
    return 'Demasiados intentos. Esperá unos minutos y probá de nuevo.';
  }
  if (/failed to fetch|network/i.test(mensaje)) {
    return 'Sin conexión con el servidor. Revisá tu internet y probá de nuevo.';
  }
  return mensaje;
}

/** Avisos que llegan en la URL desde /auth/confirm. */
const AVISOS_URL: Record<string, [titulo: string, texto: string]> = {
  'enlace-fallido': [
    'Tu correo ya está confirmado',
    'No pudimos abrir la sesión desde ese enlace (pasa si se abre en otro navegador). Iniciá sesión con tu email y contraseña.',
  ],
  'recuperacion-fallida': [
    'El enlace no funcionó',
    'Venció, ya se usó o se abrió en otro navegador. Pedí uno nuevo desde "¿Olvidaste tu contraseña?" y abrilo en este mismo navegador.',
  ],
};

const TEXTOS: Record<Modo, { bajada: string; boton: string }> = {
  login: { bajada: 'Tu libreta te está esperando.', boton: 'Entrar' },
  registro: { bajada: 'Empecemos tu libreta. Usá el email con el que te invitaron.', boton: 'Crear cuenta' },
  recuperar: { bajada: 'Te mandamos un enlace para elegir una contraseña nueva.', boton: 'Enviar enlace' },
};

const ENLACE =
  'text-sm text-[var(--ink-soft)] underline decoration-[var(--rule)] underline-offset-4 hover:text-[var(--ink)]';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [modo, setModo] = useState<Modo>('login');
  const [cargando, setCargando] = useState(false);
  const router = useRouter();
  const [supabase] = useState(() => createClient());

  useEffect(() => {
    const url = new URL(window.location.href);
    const aviso = AVISOS_URL[url.searchParams.get('aviso') ?? ''];
    if (!aviso) return;
    url.searchParams.delete('aviso');
    window.history.replaceState(null, '', url);
    avisar(...aviso);
  }, []);

  /** A dónde vuelve la persona al tocar el enlace del correo. */
  function enlaceDeRegreso(next = '/') {
    return `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}`;
  }

  async function reenviarConfirmacion(correo: string) {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: correo,
      options: { emailRedirectTo: enlaceDeRegreso() },
    });
    if (error) return avisarError('No se pudo reenviar', traducirError(error.message));
    await avisarExito('Correo reenviado', `Revisá ${correo}, también en spam o promociones.`);
  }

  /** Explica que falta confirmar el correo y ofrece reenviarlo. */
  async function pedirConfirmacion(correo: string, titulo: string) {
    const { isDenied } = await alerta({
      icon: 'info',
      title: titulo,
      html: `Te mandamos un correo a <b>${escaparHtml(correo)}</b>. Tocá el enlace que trae y vas a entrar directo.<br><br>¿No llegó? Buscalo en spam o promociones.`,
      showDenyButton: true,
      confirmButtonText: 'Entendido',
      denyButtonText: 'Reenviar correo',
    });
    if (isDenied) await reenviarConfirmacion(correo);
  }

  async function registrar(correo: string) {
    const { data, error } = await supabase.auth.signUp({
      email: correo,
      password,
      options: { emailRedirectTo: enlaceDeRegreso() },
    });
    if (error) return avisarError('No se pudo crear la cuenta', traducirError(error.message));

    // Proyecto sin confirmación por correo: ya hay sesión.
    if (data.session) {
      router.push('/');
      router.refresh();
      return;
    }
    // Supabase no avisa con un error si el email ya tenía cuenta: devuelve un
    // usuario sin identidades.
    if (data.user && data.user.identities?.length === 0) {
      setModo('login');
      return avisar(
        'Ese email ya tiene cuenta',
        'Iniciá sesión con tu contraseña. Si no la recordás, usá "¿Olvidaste tu contraseña?".'
      );
    }
    setModo('login');
    await pedirConfirmacion(correo, '¡Cuenta creada! Falta un paso');
  }

  async function entrar(correo: string) {
    const { error } = await supabase.auth.signInWithPassword({ email: correo, password });
    if (!error) {
      router.push('/');
      router.refresh();
      return;
    }
    if (/email not confirmed/i.test(error.message)) {
      return pedirConfirmacion(correo, 'Todavía no confirmaste tu correo');
    }
    await avisarError('No pudimos entrar', traducirError(error.message));
  }

  async function recuperar(correo: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(correo, {
      redirectTo: enlaceDeRegreso('/nueva-contrasena'),
    });
    if (error) return avisarError('No se pudo enviar el enlace', traducirError(error.message));
    setModo('login');
    // Mismo mensaje exista o no la cuenta, para no revelar quién está registrado.
    await avisarExito(
      'Revisá tu correo',
      `Si ${correo} tiene cuenta, te llega un enlace para elegir una contraseña nueva. Abrilo en este mismo celular o computadora.`
    );
  }

  async function manejarEnvio(e: React.FormEvent) {
    e.preventDefault();
    const correo = email.trim().toLowerCase();
    setCargando(true);
    try {
      if (modo === 'registro') await registrar(correo);
      else if (modo === 'recuperar') await recuperar(correo);
      else await entrar(correo);
    } catch (err) {
      await avisarError('Algo salió mal', traducirError(err instanceof Error ? err.message : String(err)));
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--paper)] px-4 text-[var(--ink)]">
      <div className="w-full max-w-sm">
        <h1 className="mb-4">
          <Logo className="h-8 w-auto" />
        </h1>
        <p className="mb-8 text-sm text-[var(--ink-soft)]">{TEXTOS[modo].bajada}</p>

        <form onSubmit={manejarEnvio} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-[var(--ink-soft)]">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="email"
              className="border-b border-[var(--paper-line)] bg-transparent py-2 text-[var(--ink)] outline-none focus:border-[var(--ink)]"
            />
          </label>
          {modo !== 'recuperar' && (
            <label className="flex flex-col gap-1 text-sm text-[var(--ink-soft)]">
              Contraseña
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete={modo === 'registro' ? 'new-password' : 'current-password'}
                className="border-b border-[var(--paper-line)] bg-transparent py-2 text-[var(--ink)] outline-none focus:border-[var(--ink)]"
              />
            </label>
          )}

          <button
            type="submit"
            disabled={cargando}
            className="mt-3 border border-[var(--ink)] py-2.5 font-medium transition hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-40"
          >
            {cargando ? 'Un momento...' : TEXTOS[modo].boton}
          </button>
        </form>

        <div className="mt-6 flex flex-col items-start gap-3">
          {modo === 'login' ? (
            <>
              <button onClick={() => setModo('registro')} className={ENLACE}>
                ¿Te invitaron? Creá tu cuenta
              </button>
              <button onClick={() => setModo('recuperar')} className={ENLACE}>
                ¿Olvidaste tu contraseña?
              </button>
            </>
          ) : (
            <button onClick={() => setModo('login')} className={ENLACE}>
              ¿Ya tenés cuenta? Iniciá sesión
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function escaparHtml(texto: string) {
  return texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
