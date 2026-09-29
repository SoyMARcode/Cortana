'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Sello } from '../iconos';

/** Mensajes de Supabase Auth en palabras que el equipo entienda. */
function traducirError(mensaje: string): string {
  // El trigger verificar_invitacion bloquea el registro; Supabase lo reporta así.
  if (/database error saving new user/i.test(mensaje)) {
    return 'Tu email no está invitado a Cortana. Pedile acceso a quien administra el equipo.';
  }
  if (/invalid login credentials/i.test(mensaje)) return 'Email o contraseña incorrectos.';
  if (/email not confirmed/i.test(mensaje)) {
    return 'Todavía no confirmaste tu email. Revisá tu bandeja de entrada (y spam).';
  }
  if (/user already registered/i.test(mensaje)) return 'Ese email ya tiene cuenta. Iniciá sesión.';
  if (/password should be at least/i.test(mensaje)) {
    return 'La contraseña tiene que tener al menos 6 caracteres.';
  }
  if (/rate limit/i.test(mensaje)) return 'Demasiados intentos. Esperá unos minutos y probá de nuevo.';
  return mensaje;
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [modo, setModo] = useState<'login' | 'registro'>('login');
  const [mensaje, setMensaje] = useState('');
  const [cargando, setCargando] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function manejarEnvio(e: React.FormEvent) {
    e.preventDefault();
    setMensaje('');
    setCargando(true);

    if (modo === 'registro') {
      const { error } = await supabase.auth.signUp({ email, password });
      setCargando(false);
      if (error) return setMensaje(traducirError(error.message));
      setMensaje(
        'Cuenta creada. Si tu proyecto pide confirmar el correo, revisá tu bandeja. Si no, ya podés iniciar sesión.'
      );
      setModo('login');
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setCargando(false);
    if (error) return setMensaje(traducirError(error.message));
    router.push('/');
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--paper)] px-4 text-[var(--ink)]">
      <div className="w-full max-w-sm">
        <div className="mb-1 flex items-center gap-3">
          <Sello className="h-7 w-7" />
          <h1 className="fuente-editorial text-4xl italic">Cortana</h1>
        </div>
        <p className="mb-8 text-sm text-[var(--ink-soft)]">
          {modo === 'login' ? 'Tu libreta te está esperando.' : 'Empecemos tu libreta. Usá el email con el que te invitaron.'}
        </p>

        <form onSubmit={manejarEnvio} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-[var(--ink-soft)]">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="border-b border-[var(--paper-line)] bg-transparent py-2 text-[var(--ink)] outline-none focus:border-[var(--ink)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--ink-soft)]">
            Contraseña
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="border-b border-[var(--paper-line)] bg-transparent py-2 text-[var(--ink)] outline-none focus:border-[var(--ink)]"
            />
          </label>

          <button
            type="submit"
            disabled={cargando}
            className="mt-3 border border-[var(--ink)] py-2.5 font-medium transition hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-40"
          >
            {cargando ? 'Un momento...' : modo === 'login' ? 'Entrar' : 'Crear cuenta'}
          </button>
        </form>

        {mensaje && <p className="mt-4 text-sm text-[var(--ink-soft)]">{mensaje}</p>}

        <button
          onClick={() => setModo(modo === 'login' ? 'registro' : 'login')}
          className="mt-6 text-sm text-[var(--ink-soft)] underline decoration-[var(--rule)] underline-offset-4 hover:text-[var(--ink)]"
        >
          {modo === 'login' ? '¿Te invitaron? Creá tu cuenta' : '¿Ya tenés cuenta? Iniciá sesión'}
        </button>
      </div>
    </div>
  );
}
