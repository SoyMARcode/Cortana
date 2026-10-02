'use client';

import { useCallback, useEffect, useState } from 'react';
import { avisarError, confirmar, notificar } from '@/lib/alertas';
import type { Ubicacion } from '@/lib/libreta';
import { NOMBRE } from '@/lib/marca';

/** Con el permiso ya dado, la ubicación se actualiza sola si tiene más de esto. */
const REFRESCAR_CADA_MS = 3 * 60 * 60 * 1000;

const ENLACE =
  'underline decoration-[var(--rule)] underline-offset-4 hover:text-[var(--ink)] disabled:opacity-40';

function posicionActual(): Promise<GeolocationPosition> {
  return new Promise((resolver, rechazar) =>
    navigator.geolocation.getCurrentPosition(resolver, rechazar, {
      // Precisión baja: alcanza para el clima y gasta menos batería.
      enableHighAccuracy: false,
      timeout: 15_000,
      maximumAge: 10 * 60 * 1000,
    })
  );
}

async function guardar(pos: GeolocationPosition): Promise<string | null> {
  const res = await fetch('/api/ubicacion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitud: pos.coords.latitude, longitud: pos.coords.longitude }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Error ${res.status}`);
  return (await res.json()).lugar;
}

/**
 * Comparte la ubicación aproximada (~1 km) para el clima, el aviso de lluvia
 * y las búsquedas cercanas. Una vez dado el permiso se mantiene al día sola.
 */
export default function UbicacionDispositivo({ inicial }: { inicial: Ubicacion }) {
  const [lugar, setLugar] = useState(inicial.lugar);
  const [ocupado, setOcupado] = useState(false);
  // En el servidor no hay navigator: se asume que sí y el efecto no hace nada.
  const [soportado] = useState(() => typeof navigator === 'undefined' || 'geolocation' in navigator);

  const actualizar = useCallback(async (silencioso: boolean) => {
    setOcupado(true);
    try {
      const nuevo = await guardar(await posicionActual());
      setLugar(nuevo ?? 'tu ubicación');
      if (!silencioso) notificar(nuevo ? `Ubicación: ${nuevo}` : 'Ubicación guardada');
    } catch (e) {
      if (silencioso) return;
      const err = e as GeolocationPositionError | Error;
      const motivo =
        'code' in err && err.code === 1
          ? 'No diste permiso. Habilitalo desde el candado de la barra de direcciones y probá de nuevo.'
          : 'code' in err && err.code === 3
            ? 'Tardó demasiado en encontrarte. Probá de nuevo.'
            : err.message;
      avisarError('No se pudo obtener la ubicación', motivo);
    } finally {
      setOcupado(false);
    }
  }, []);

  useEffect(() => {
    if (!soportado) return;
    // Si ya dio permiso antes y la ubicación es vieja, se actualiza sin preguntar.
    const vieja =
      !inicial.actualizada || Date.now() - Date.parse(inicial.actualizada) > REFRESCAR_CADA_MS;
    if (!inicial.lugar || !vieja) return;
    navigator.permissions
      ?.query({ name: 'geolocation' })
      .then((p) => {
        if (p.state === 'granted') actualizar(true);
      })
      .catch(() => {});
  }, [inicial, actualizar, soportado]);

  async function quitar() {
    const seguro = await confirmar(
      '¿Dejo de usar tu ubicación?',
      'Se borra la que está guardada. El aviso de lluvia deja de funcionar hasta que la vuelvas a compartir.',
      { si: 'Borrarla', no: 'Dejarla' }
    );
    if (!seguro) return;
    setOcupado(true);
    const res = await fetch('/api/ubicacion', { method: 'DELETE' });
    setOcupado(false);
    if (res.ok) setLugar(null);
    else avisarError('No se pudo borrar', `Error del servidor (código ${res.status}).`);
  }

  if (!soportado) return null;

  return (
    <section className="flex flex-col gap-1.5 border-t border-[var(--paper-line)] pt-3.5 text-[13px]">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-soft)]">
        Ubicación
      </h3>
      {lugar ? (
        <>
          <p>{lugar}</p>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[var(--ink-soft)]">
            <button onClick={() => actualizar(false)} disabled={ocupado} className={ENLACE}>
              {ocupado ? 'actualizando...' : 'actualizar'}
            </button>
            <button onClick={quitar} disabled={ocupado} className={ENLACE}>
              dejar de usar
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[var(--ink-soft)]">
            Para el clima, el aviso de lluvia y recomendaciones cerca tuyo. {NOMBRE} guarda solo la
            zona (~1 km), no tu dirección.
          </p>
          <button
            onClick={() => actualizar(false)}
            disabled={ocupado}
            className="self-start border border-[var(--ink)] px-3 py-1.5 text-sm font-medium transition hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-40"
          >
            {ocupado ? 'Buscando...' : 'Usar mi ubicación'}
          </button>
        </>
      )}
    </section>
  );
}
