'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { avisar, avisarError, avisarExito } from '@/lib/alertas';
import { NOMBRE } from '@/lib/marca';
import { Logo } from '../iconos';

/** Destino del enlace de "¿Olvidaste tu contraseña?": /auth/confirm ya abrió la sesión. */
export default function NuevaContrasenaPage() {
  const [password, setPassword] = useState('');
  const [repetida, setRepetida] = useState('');
  const [cargando, setCargando] = useState(false);
  const router = useRouter();
  const [supabase] = useState(() => createClient());

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (data.user) return;
      await avisar(
        'El enlace no funcionó',
        'Venció, ya se usó o se abrió en otro navegador. Pedí uno nuevo desde "¿Olvidaste tu contraseña?".'
      );
      router.replace('/login');
    });
  }, [supabase, router]);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (password !== repetida) return avisarError('Las contraseñas no coinciden', 'Escribí la misma en los dos campos.');

    setCargando(true);
    const { error } = await supabase.auth.updateUser({ password });
    setCargando(false);
    if (error) {
      const texto = /different from the old/i.test(error.message)
        ? 'Tiene que ser distinta a la anterior.'
        : /at least/i.test(error.message)
          ? 'La contraseña tiene que tener al menos 6 caracteres.'
          : error.message;
      return avisarError('No se pudo cambiar la contraseña', texto);
    }
    await avisarExito('Contraseña actualizada', `Ya podés usar ${NOMBRE}.`);
    router.push('/');
    router.refresh();
  }

  const campo =
    'border-b border-[var(--paper-line)] bg-transparent py-2 text-[var(--ink)] outline-none focus:border-[var(--ink)]';

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--paper)] px-4 text-[var(--ink)]">
      <div className="w-full max-w-sm">
        <h1 className="mb-4">
          <Logo className="h-8 w-auto" />
        </h1>
        <p className="mb-8 text-sm text-[var(--ink-soft)]">Elegí tu contraseña nueva.</p>

        <form onSubmit={guardar} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-[var(--ink-soft)]">
            Contraseña nueva
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              className={campo}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--ink-soft)]">
            Repetila
            <input
              type="password"
              value={repetida}
              onChange={(e) => setRepetida(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              className={campo}
            />
          </label>

          <button
            type="submit"
            disabled={cargando}
            className="mt-3 border border-[var(--ink)] py-2.5 font-medium transition hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-40"
          >
            {cargando ? 'Guardando...' : 'Guardar contraseña'}
          </button>
        </form>
      </div>
    </div>
  );
}
