// Service worker de QIR (nombre fijo acá: este archivo no puede importar lib/marca.ts): recibe las notificaciones push y abre la app
// al tocarlas. Se sirve desde /sw.js para que su alcance sea todo el sitio.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let datos;
  try {
    datos = event.data.json();
  } catch {
    datos = { titulo: 'QIR', cuerpo: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(datos.titulo || 'QIR', {
      body: datos.cuerpo || '',
      icon: '/icono-192.png',
      badge: '/insignia-96.png',
      // Mismo tag = reemplaza en vez de apilar avisos repetidos del mismo recordatorio.
      tag: datos.tag,
      vibrate: [120, 60, 120],
      // Botones como "Posponer 10 min" o "Marcar hecha" (iPhone no los muestra).
      actions: (datos.acciones || []).map((a) => ({ action: a.accion, title: a.titulo })),
      data: { url: datos.url || '/', aviso: datos.aviso },
    })
  );
});

/** Lo que pasa al tocar un botón de la notificación, sin abrir la app. */
async function ejecutarAccion(accion, aviso, tag) {
  const confirmar = (titulo, cuerpo) =>
    self.registration.showNotification(titulo, {
      body: cuerpo,
      icon: '/icono-192.png',
      badge: '/insignia-96.png',
      tag,
      silent: true,
    });
  try {
    const res = await fetch('/api/avisos/accion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...aviso, accion }),
    });
    if (!res.ok) throw new Error(String(res.status));
    if (accion === 'posponer') await confirmar('Pospuesto', 'Te lo vuelvo a avisar en 10 minutos.');
    if (accion === 'hecha') await confirmar('¡Hecho!', 'La marqué como completada.');
  } catch {
    await confirmar('No se pudo', 'Abrí QIR y hacelo desde ahí.');
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const aviso = event.notification.data?.aviso;
  if (event.action && aviso) {
    event.waitUntil(ejecutarAccion(event.action, aviso, event.notification.tag));
    return;
  }
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      // Si QIR ya está abierta, la trae al frente en vez de abrir otra.
      const abierta = ventanas.find((v) => v.url.startsWith(self.location.origin));
      if (abierta) return abierta.focus();
      return self.clients.openWindow(url);
    })
  );
});
