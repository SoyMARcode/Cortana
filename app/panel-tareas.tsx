'use client';

import { agruparTareas, textoAviso, textoPlazo, type Libreta } from '@/lib/libreta';
import { IconoReloj } from './iconos';

/**
 * Pendientes agrupados por cuándo vencen + contactos. Se usa en la columna
 * lateral (computadora) y en la hoja deslizable (celular).
 */
export default function PanelTareas({
  libreta,
  onAlternar,
  onCancelarAviso,
  grande = false,
}: {
  libreta: Libreta;
  onAlternar: (id: string, completada: boolean) => void;
  onCancelarAviso: (id: string) => void;
  grande?: boolean;
}) {
  const grupos = agruparTareas(libreta.tareas);
  const pendientes = libreta.tareas.filter((t) => !t.completada).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between">
        <h2 className="fuente-editorial text-[19px] font-semibold not-italic">Pendientes</h2>
        <span className="text-xs tabular-nums text-[var(--ink-soft)]">
          {pendientes === 1 ? '1 tarea' : `${pendientes} tareas`}
        </span>
      </div>

      {grupos.length === 0 && (
        <p className="fuente-editorial text-sm italic text-[var(--ink-soft)]">
          No tenés nada pendiente. Pedile a Cortana que te anote algo.
        </p>
      )}

      {grupos.map((grupo) => (
        <section key={grupo.clave} className="flex flex-col gap-1.5">
          <h3
            className={`flex justify-between text-[11px] font-semibold uppercase tracking-[0.08em] ${
              grupo.urgente ? 'text-[var(--amber)]' : 'text-[var(--ink-soft)]'
            }`}
          >
            <span>{grupo.titulo}</span>
            <span className="tabular-nums">{grupo.tareas.length}</span>
          </h3>
          {grupo.tareas.map((t) => (
            <label
              key={t.id}
              className={`grid cursor-pointer items-start gap-2.5 border border-[var(--paper-line)] bg-[var(--paper-note)] leading-snug ${
                grande ? 'grid-cols-[22px_1fr_auto] px-3 py-2.5 text-[15px]' : 'grid-cols-[18px_1fr_auto] px-2.5 py-2 text-sm'
              } ${grupo.urgente ? 'border-l-[3px] border-l-[var(--amber)]' : ''}`}
            >
              <input
                type="checkbox"
                checked={t.completada}
                onChange={(e) => onAlternar(t.id, e.target.checked)}
                aria-label={`Marcar "${t.titulo}" como ${t.completada ? 'pendiente' : 'hecha'}`}
                className={`casillero mt-px ${grande ? 'h-5 w-5' : 'h-4 w-4'}`}
              />
              <span className={t.completada ? 'text-[var(--ink-soft)] line-through' : ''}>{t.titulo}</span>
              <span
                className={`whitespace-nowrap tabular-nums ${
                  grupo.urgente
                    ? 'text-xs font-semibold text-[var(--amber)]'
                    : 'fuente-editorial text-[13px] italic text-[var(--ink-soft)]'
                }`}
              >
                {t.completada ? '' : textoPlazo(t.fecha_limite)}
              </span>
            </label>
          ))}
        </section>
      ))}

      {libreta.recordatorios.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="flex justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-soft)]">
            <span>Avisos programados</span>
            <span className="tabular-nums">{libreta.recordatorios.length}</span>
          </h3>
          {libreta.recordatorios.map((r) => (
            <div
              key={r.id}
              className={`grid items-start gap-2.5 border border-dashed border-[var(--rule)] leading-snug ${
                grande ? 'grid-cols-[18px_1fr_auto] px-3 py-2.5 text-[15px]' : 'grid-cols-[16px_1fr_auto] px-2.5 py-2 text-sm'
              }`}
            >
              <IconoReloj className="mt-0.5 h-4 w-4 text-[var(--ink-soft)]" />
              <span>
                {r.mensaje}
                <span className="fuente-editorial block text-[13px] italic tabular-nums text-[var(--ink-soft)]">
                  {textoAviso(r.enviar_en)}
                </span>
              </span>
              <button
                onClick={() => onCancelarAviso(r.id)}
                aria-label={`Cancelar el aviso "${r.mensaje}"`}
                title="Cancelar aviso"
                className="px-1 text-base leading-none text-[var(--ink-soft)] hover:text-[var(--ink)]"
              >
                ×
              </button>
            </div>
          ))}
        </section>
      )}

      {libreta.contactos.length > 0 && (
        <section className="flex flex-col gap-1.5 border-t border-[var(--paper-line)] pt-3.5 text-[13px]">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-soft)]">
            Contactos
          </h3>
          {libreta.contactos.map((c) => (
            <div key={c.nombre} className="flex justify-between gap-2">
              <span>{c.nombre}</span>
              <span className="truncate text-[var(--ink-soft)]">{c.email}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
