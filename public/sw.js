// Service worker de Cortana: recibe las notificaciones push y abre la app
// al tocarlas. Se sirve desde /sw.js para que su alcance sea todo el sitio.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let datos;
  try {
    datos = event.data.json();
  } catch {
    datos = { titulo: 'Cortana', cuerpo: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(datos.titulo || 'Cortana', {
      body: datos.cuerpo || '',
      icon: '/icono-192.png',
      badge: '/insignia-96.png',
      // Mismo tag = reemplaza en vez de apilar avisos repetidos del mismo recordatorio.
      tag: datos.tag,
      vibrate: [120, 60, 120],
      data: { url: datos.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      // Si Cortana ya está abierta, la trae al frente en vez de abrir otra.
      const abierta = ventanas.find((v) => v.url.startsWith(self.location.origin));
      if (abierta) return abierta.focus();
      return self.clients.openWindow(url);
    })
  );
});
