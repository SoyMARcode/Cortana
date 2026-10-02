# Arquitectura — Cortana Agent

## Stack
- **Next.js 16** (App Router) + TypeScript + Tailwind CSS
- **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/react`) para el
  loop de conversación con tools (ReAct)
- **Supabase** (Postgres + Auth) para usuarios y tareas persistentes
- **Resend** para el envío de emails de recordatorio
- **Vercel Cron** para disparar la revisión diaria de fechas límite

## Flujo del chat
1. El usuario escribe (o dicta por voz) en `app/page.tsx`.
2. `useChat` manda los mensajes a `app/api/chat/route.ts`.
3. Esa ruta verifica que haya sesión (Supabase Auth), arma el prompt con
   la personalidad (`lib/personality.ts`) y las tools atadas a ese
   usuario (`lib/tools.ts`), y llama a Claude vía `streamText`.
4. Claude puede llamar a las tools (`crear_tarea`, `listar_tareas`,
   `completar_tarea`, `enviar_correo`, `fecha_hora_actual`), que leen/escriben en la
   tabla `tareas` de Supabase.
5. La respuesta se streamea de vuelta al navegador y, si la voz está
   activada, se lee en voz alta con la Web Speech API (`lib/voice.ts`).

## Multi-usuario
Cada usuario tiene su cuenta (email + contraseña, vía Supabase Auth).
La tabla `tareas` tiene Row Level Security: cada usuario solo puede
leer y escribir sus propias filas. El proxy (`proxy.ts`, antes `middleware.ts`)
redirige a `/login` si no hay sesión activa.

## Notificaciones
`app/api/cron/notificaciones/route.ts` corre una vez al día (Vercel
Cron, ver `vercel.json`). Revisa todas las tareas pendientes con
`fecha_limite`, calcula cuántos días faltan, y si están entre 8 y 0 (el mismo día)
día, manda un email vía Resend — guardando `ultimo_aviso_dia` en la
tarea para no repetir el mismo aviso el mismo día.

## Lo que falta / decisiones futuras
- SMS (Twilio) — pausado, se evalúa después de probar email.
- Voz más natural (ElevenLabs) — pausado, no es prioridad.
- Verificar dominio propio en Resend antes de sumar usuarios reales
  aparte del dueño del proyecto.

## Correos a otras personas
`enviar_correo` acepta hasta 10 destinatarios. Si el correo va solo al
email del usuario, sale directo. Si va a cualquier otra dirección,
`app/api/chat/route.ts` exige aprobación (`toolApproval` del AI SDK):
la interfaz muestra destinatarios, asunto y cuerpo con botones
Enviar / Cancelar, y nada sale hasta que el usuario aprueba. Se envía
un correo por destinatario (nadie ve las direcciones de los demás) con
`Reply-To` al email del usuario. Requiere un dominio verificado en
Resend: sin eso, Resend rechaza cualquier destinatario que no sea el
dueño de la cuenta de Resend.

## Zona horaria
El navegador manda su zona horaria (IANA) en cada petición al chat;
`fecha_hora_actual` devuelve la fecha local del usuario para que
"el viernes" se calcule bien cerca de la medianoche.

## Diseño de los correos
Todos los correos usan la plantilla "membrete" de `lib/email.ts`: el sello
de Cortana (`lib/email-sello.ts`, PNG incrustado como adjunto `cid:`) junto
al nombre en serif itálica, el cuerpo, y un pie. Tablas y estilos en línea,
que es lo que respetan Gmail y Outlook. Copia del sello: `public/sello-cortana.png`.

## Contactos, límite y borrado
- `contactos`: libreta nombre → email por usuario (`guardar_contacto`,
  `listar_contactos`, `borrar_contacto`).
- `correos_enviados`: registro de cada envío; `enviar_correo` corta en
  50 correos cada 24 h por usuario. El usuario no puede borrar su registro (RLS).
- `editar_tarea` reinicia los avisos si cambia la fecha; `borrar_tarea`
  pide confirmación con botón, igual que los correos a terceros.

## Historial del chat
`conversaciones` guarda los mensajes (formato UIMessage, últimos 200) de
cada usuario al terminar cada respuesta. `app/page.tsx` (servidor) los
carga y se los pasa a `app/chat.tsx` (cliente). Al modelo solo se le
mandan los últimos 40 mensajes. "nueva conversación" borra el historial.

## Interfaz
- `app/page.tsx` (servidor) carga historial + libreta (`lib/libreta.ts`:
  tareas pendientes, hechas hoy y contactos) y renderiza `app/chat.tsx`.
- Computadora: panel lateral `app/panel-tareas.tsx` con las tareas
  agrupadas por vencimiento (atrasadas y de hoy en ámbar). Celular: el
  panel se abre como hoja desde abajo con el botón "Tareas N".
- El casillero completa la tarea directo en Supabase (RLS). Al terminar
  cada respuesta de Cortana, el panel se recarga para reflejar lo que
  hizo el chat.
- Íconos de trazo en `app/iconos.tsx` (incluye el sello). Modo oscuro por
  `prefers-color-scheme` en `app/globals.css`.

## Recordatorios con hora
- Tabla `recordatorios` (mensaje, `enviar_en` en UTC, zona horaria del
  usuario, estado de envío). Herramientas `programar_recordatorio`,
  `listar_recordatorios`, `cancelar_recordatorio`. La hora que dice el
  usuario se convierte a UTC con `lib/zona-horaria.ts` (maneja horario de verano).
- `app/api/cron/recordatorios/route.ts` envía los vencidos. Lo llama
  **pg_cron de Supabase cada minuto** (`supabase-cron.sql`), porque el
  cron de Vercel en el plan gratis solo corre una vez por día.
- `reclamar_recordatorios()` toma lotes con `FOR UPDATE SKIP LOCKED`: si
  dos ejecuciones se superponen, ningún aviso sale dos veces. Si el envío
  falla se reintenta en la siguiente pasada, hasta 5 veces.
- El panel muestra los "Avisos programados" y permite cancelarlos.

## Notificaciones push (PWA)
- Cortana es instalable: `app/manifest.ts`, íconos en `public/icono-*.png`
  y `app/apple-icon.png`. El service worker es `public/sw.js`.
- Cada dispositivo se activa por separado desde el panel
  (`app/avisos-dispositivo.tsx`). La suscripción se guarda en
  `push_suscripciones` vía `app/api/push/route.ts` (POST activar, DELETE
  desactivar, PUT notificación de prueba). Solo se aceptan endpoints de
  servicios push reales, para que el servidor no pueda usarse contra URLs arbitrarias.
- `lib/push.ts` envía con `web-push` (claves VAPID en las variables
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) y
  borra las suscripciones que el navegador dio de baja.
- Recordatorios con hora y avisos de vencimiento: primero push; si no
  llegó a ningún dispositivo, por correo.
- iPhone: los avisos solo funcionan con Cortana agregada a la pantalla de
  inicio (iOS 16.4 o posterior).

## Uso en equipo
- **Registro solo por invitación:** tabla `invitaciones` (email, es_admin).
  El trigger `verificar_invitacion` en `auth.users` rechaza en la base de
  datos cualquier alta cuyo email no esté invitado, venga de donde venga.
  El login traduce ese rechazo a "Tu email no está invitado".
- **Administradores** (`es_admin = true`) gestionan el equipo desde el chat:
  `invitar_persona`, `listar_equipo`, `quitar_invitacion`. Para los demás,
  esas herramientas se ocultan al modelo con `activeTools` y además cada
  una vuelve a verificar el rol al ejecutarse.
- **Límite de chat:** `registrar_mensaje_chat(limite)` suma de forma
  atómica en `uso_chat` (por persona y día) y devuelve -1 al pasarse; la
  ruta responde 429 y el chat lo muestra. Límite por defecto 150/día,
  configurable con la variable `CHAT_LIMITE_DIARIO`. Solo cuentan los
  mensajes que escribe la persona, no las continuaciones tras aprobar.
- **Prompt caching de Anthropic:** puntos de caché después de la
  personalidad (herramientas + instrucciones) y al final del historial.

## Mejoras v6 (octubre 2026)
Requieren correr de nuevo `supabase-schema.sql` y `supabase-cron.sql`
ANTES de publicar: sin las columnas nuevas, el panel no carga las tareas.

- **Contexto por persona** (`lib/contexto.ts`): en cada mensaje se arma un
  segundo bloque de instrucciones con preferencias, contactos (con apodos),
  ubicación y ajustes. La personalidad sigue cacheada aparte. También
  guarda la zona horaria en `ajustes`, que usan los avisos automáticos.
- **Preferencias** (`preferencias`): `recordar_preferencia` /
  `olvidar_preferencia`, hasta 40 por persona.
- **Apodos** (`contactos.apodos`): `agregar_apodo` los guarda solos cuando
  queda claro a quién se refería ("Anita" = Ana).
- **Repeticiones** (`lib/repeticion.ts`): tareas y recordatorios con
  `repeticion` (diaria, laborables, semanal + `dias_semana`, mensual).
  Las tareas: un trigger crea la siguiente al completarlas. Los
  recordatorios: el cron los reprograma a la misma hora local.
- **Segundos**: `programar_recordatorio` acepta `HH:mm:ss` o
  `dentro_de_segundos`. pg_cron revisa cada 10 s, pero solo llama a la app
  si hay algo vencido (no gasta invocaciones de Vercel en vano).
- **Clima** (`lib/clima.ts`): Open-Meteo, sin clave. `consultar_clima`.
- **Ubicación** (`app/ubicacion-dispositivo.tsx`, `/api/ubicacion`):
  geolocalización del navegador, redondeada a ~1 km, con nombre del lugar
  vía OpenStreetMap (Nominatim). Se actualiza sola cada 3 h si hay permiso.
- **Avisos automáticos** (`/api/cron/proactivo`, cada hora): resumen
  semanal por correo + push (por defecto lunes 8:00, se cambia con
  `configurar_avisos`) y aviso de lluvia a las 7:00 (solo push).
- **Calendario** (`lib/calendario.ts`): solo lectura, con la dirección
  secreta iCal (Google, Outlook, Apple). `conectar_calendario`,
  `ver_calendario`, `desconectar_calendario`. Se valida el enlace (solo
  https a dominios públicos, también en redirecciones).
- **Adjuntos** (`lib/adjuntos.ts`): el clip sube a Storage (bucket
  `adjuntos/<user_id>/`, 10 MB por archivo, 5 por mensaje). Viajan en la
  metadata del mensaje; QIR ve imágenes y PDF del último mensaje y los
  puede mandar con `enviar_correo`. "Nueva conversación" los borra.
- **Internet**: `web_search` y `web_fetch` de Anthropic (hasta 3 usos por
  mensaje, ~US$10 cada 1000 búsquedas). Las fuentes se ven debajo de la
  respuesta.

## Mejoras v7
- **Buenos días** (`lib/buenos-dias.ts`): push diario a la hora de
  `ajustes.buenos_dias_hora` (por defecto 7) con clima, eventos, tareas de
  hoy/atrasadas y avisos del día. Reemplaza al aviso de lluvia suelto, que
  solo se manda a quien apagó el buenos días. Lo dispara `/api/cron/proactivo`.
- **Botones en las notificaciones** (`public/sw.js`, `/api/avisos/accion`):
  "Posponer 10 min", "Listo" y "Marcar hecha". Funcionan sin sesión: cada
  aviso lleva una firma HMAC (`lib/firma-aviso.ts`, con CRON_SECRET). iPhone
  no muestra botones en las notificaciones web.
- **Manos libres** (`app/chat.tsx`): `hablar()` avisa cuando termina de leer
  y el micrófono escucha una frase y la envía sola. Si no se dice nada,
  queda en pausa.

## Mejoras v8 en adelante
La guía por partes (qué hace, cómo se usa, cómo funciona) está en
[MEJORAS.md](MEJORAS.md).
