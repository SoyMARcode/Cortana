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
