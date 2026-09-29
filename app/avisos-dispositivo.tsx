'use client';

import { useEffect, useState } from 'react';

type Estado = 'cargando' | 'no-soportado' | 'instalar-ios' | 'bloqueado' | 'inactivo' | 'activo';

const CLAVE_PUBLICA = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function base64UrlABytes(base64: string): Uint8Array<ArrayBuffer> {
  const relleno = '='.repeat((4 - (base64.length % 4)) % 4);
  const crudo = atob((base64 + relleno).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(crudo.length));
  for (let i = 0; i < crudo.length; i++) bytes[i] = crudo.charCodeAt(i);
  return bytes;
}

function esIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function instalada() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Registra el service worker. Se llama una vez al abrir la app. */
export function registrarServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch((e) => console.error('[push] No se pudo registrar el service worker:', e));
  }
}

/** Traduce la respuesta de error de /api/push a algo que el usuario pueda resolver. */
async function motivoDeError(res: Response): Promise<string> {
  if (res.status === 401) return 'Tu sesión expiró. Cerrá sesión, volvé a entrar y probá de nuevo.';
  const texto = await res.text().catch(() => '');
  let detalle = texto;
  try {
    detalle = JSON.parse(texto).error ?? texto;
  } catch {
    // La respuesta era texto plano.
  }
  return detalle ? `${detalle} (código ${res.status})` : `Error del servidor (código ${res.status}).`;
}

const ENLACE =
  'underline decoration-[var(--rule)] underline-offset-4 hover:text-[var(--ink)] disabled:opacity-40';

/**
 * Activa o desactiva las notificaciones en ESTE dispositivo. Cada celular o
 * computadora se activa por separado.
 */
export default function AvisosDispositivo() {
  const [estado, setEstado] = useState<Estado>('cargando');
  const [ocupado, setOcupado] = useState(false);
  const [nota, setNota] = useState('');

  useEffect(() => {
    (async () => {
      const soportado =
        CLAVE_PUBLICA && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!soportado) {
        // En iPhone, las notificaciones solo existen con la app instalada en el inicio.
        setEstado(esIOS() && !instalada() ? 'instalar-ios' : 'no-soportado');
        return;
      }
      if (Notification.permission === 'denied') return setEstado('bloqueado');
      const registro = await navigator.serviceWorker.ready;
      const sub = await registro.pushManager.getSubscription();
      setEstado(sub ? 'activo' : 'inactivo');
    })();
  }, []);

  async function activar() {
    setOcupado(true);
    setNota('');
    try {
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        setEstado(permiso === 'denied' ? 'bloqueado' : 'inactivo');
        return;
      }
      const registro = await navigator.serviceWorker.ready;
      const sub = await registro.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlABytes(CLAVE_PUBLICA!),
      });
      const res = await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sub.toJSON(), dispositivo: navigator.userAgent.slice(0, 200) }),
      });
      if (!res.ok) {
        await sub.unsubscribe();
        setNota(`No se pudo guardar este dispositivo: ${await motivoDeError(res)}`);
        return;
      }
      setEstado('activo');
      setNota('Listo. Te mandé una de prueba.');
      await fetch('/api/push', { method: 'PUT' });
    } catch (e) {
      console.error('[push] Error activando:', e);
      const detalle = e instanceof Error ? e.message : String(e);
      setNota(`No se pudieron activar los avisos en este navegador: ${detalle}`);
    } finally {
      setOcupado(false);
    }
  }

  async function probar() {
    setOcupado(true);
    try {
      const res = await fetch('/api/push', { method: 'PUT' });
      if (!res.ok) {
        setNota(`No se pudo enviar la prueba: ${await motivoDeError(res)}`);
        return;
      }
      const datos = await res.json();
      setNota(datos.ok ? 'Enviada. Debería aparecer en unos segundos.' : `No se envió: ${datos.motivo}`);
    } catch {
      setNota('Sin conexión con el servidor. Revisá tu internet y probá de nuevo.');
    } finally {
      setOcupado(false);
    }
  }

  async function desactivar() {
    setOcupado(true);
    const registro = await navigator.serviceWorker.ready;
    const sub = await registro.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    setEstado('inactivo');
    setNota('');
    setOcupado(false);
  }

  if (estado === 'cargando' || estado === 'no-soportado') return null;

  return (
    <section className="flex flex-col gap-1.5 border-t border-[var(--paper-line)] pt-3.5 text-[13px]">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-soft)]">
        Avisos en este dispositivo
      </h3>

      {estado === 'instalar-ios' && (
        <p className="text-[var(--ink-soft)]">
          En iPhone, primero instalá Cortana: tocá <b className="text-[var(--ink)]">Compartir</b> y
          después <b className="text-[var(--ink)]">Agregar a inicio</b>. Abrila desde ese ícono para
          activar los avisos.
        </p>
      )}

      {estado === 'bloqueado' && (
        <p className="text-[var(--ink-soft)]">
          Los avisos están bloqueados para este sitio. Habilitalos desde el candado de la barra de
          direcciones y recargá la página.
        </p>
      )}

      {estado === 'inactivo' && (
        <>
          <p className="text-[var(--ink-soft)]">
            Recibí tus recordatorios como notificación, aunque Cortana esté cerrada.
          </p>
          <button
            onClick={activar}
            disabled={ocupado}
            className="self-start border border-[var(--ink)] px-3 py-1.5 text-sm font-medium transition hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-40"
          >
            {ocupado ? 'Activando...' : 'Activar avisos'}
          </button>
        </>
      )}

      {estado === 'activo' && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="font-medium text-[var(--teal)]">Activados</span>
          <button onClick={probar} disabled={ocupado} className={ENLACE}>
            probar
          </button>
          <button onClick={desactivar} disabled={ocupado} className={ENLACE}>
            desactivar
          </button>
        </div>
      )}

      {nota && <p className="text-[var(--ink-soft)]">{nota}</p>}
    </section>
  );
}
