import Link from 'next/link';
import { Logo } from './iconos';

/** Contacto que figura en la política de privacidad y las condiciones. */
export const CONTACTO = 'acevedomichael653@gmail.com';

/** Marco común de las páginas legales (privacidad y condiciones). */
export function PaginaLegal({
  titulo,
  actualizada,
  children,
}: {
  titulo: string;
  actualizada: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-[var(--paper)] text-[var(--ink)]">
      <header className="border-b border-[var(--paper-line)] px-4 py-3 md:px-6">
        <Link href="/" aria-label="Ir a QIR">
          <Logo className="h-[18px] w-auto" />
        </Link>
      </header>
      <main className="mx-auto max-w-[700px] px-4 py-8 text-[15px] leading-relaxed md:py-12">
        <h1 className="fuente-editorial text-3xl font-semibold">{titulo}</h1>
        <p className="mt-1 text-sm italic text-[var(--ink-soft)]">Última actualización: {actualizada}</p>
        <div className="legal mt-8 flex flex-col gap-4">{children}</div>
      </main>
    </div>
  );
}

export function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="mt-4 text-lg font-semibold">{titulo}</h2>
      {children}
    </section>
  );
}
