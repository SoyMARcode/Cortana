# Cortana Agent — proyecto completo, listo para correr

Este zip trae el proyecto ENTERO (sesiones 1, 2 y 3 ya integradas):
chat con Claude, voz (leer/dictar), personalidad separada, base de
datos multi-usuario con login, y notificaciones por email escalonadas.

## 1. Descomprimir

Descomprimí `cortana-agent-completo.zip` donde quieras (ej. en tu
Desktop, reemplazando la carpeta vieja del proyecto si tenías una a
medio armar).

## 2. Instalar dependencias

Abrí una terminal DENTRO de la carpeta `cortana-agent` (la que tiene
`package.json` adentro) y corré:

```bash
npm install
```

## 3. Crear el proyecto en Supabase (si no lo hiciste ya)

Si ya creaste el proyecto "SoyMARcode's Project" en Supabase, andá
directo al paso 4. Si no:

1. https://supabase.com → **New project** (gratis)
2. **Project Settings → API**: copiá `Project URL`, `anon public key`
   y `service_role key` (los vas a necesitar en el paso 5).

## 4. Cargar el esquema de base de datos

1. Supabase → **SQL Editor → New query**
2. Pegá TODO el contenido de `supabase-schema.sql` (está en la raíz
   de esta carpeta) y hacé **Run**.
3. Debería decir "Success" — eso crea la tabla `tareas` con seguridad
   por usuario.

## 5. Crear `.env.local`

En la raíz del proyecto, copiá `.env.example` a un archivo nuevo
llamado `.env.local` y completá:

```
ANTHROPIC_API_KEY=tu_api_key_de_console.anthropic.com

NEXT_PUBLIC_SUPABASE_URL=https://tu-proyecto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=tu_anon_key
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key

RESEND_API_KEY=tu_key_de_resend.com/api-keys
RESEND_FROM_EMAIL=Cortana <onboarding@resend.dev>

CRON_SECRET=un_valor_random_que_inventes
```

Para `CRON_SECRET`, generá uno con:
```bash
openssl rand -hex 16
```

⚠️ La URL de Supabase tiene que ser la corta (`https://xxxxx.supabase.co`),
NO la URL del dashboard con `/project/.../settings/api-keys` en el medio.

## 6. Probar local

```bash
npm run dev
```

Abrí `http://localhost:3000` → te va a redirigir a `/login` (eso ya
lo probamos y compila sin errores). Registrate con tu email y una
contraseña, entrá, y probá:

- Escribir: "recordame entregar el informe el viernes"
- Probar el micrófono 🎤
- Ver que Cortana te responde en voz (podés silenciarla con el botón
  🔊 arriba a la derecha)

## 7. Probar el cron sin esperar 24hs

Con `npm run dev` corriendo, en otra terminal:

```bash
curl -H "Authorization: Bearer TU_CRON_SECRET" http://localhost:3000/api/cron/notificaciones
```

Para forzar que mande un email de verdad, entrá a Supabase → **Table
Editor → tareas**, y editale a una tarea la `fecha_limite` a la fecha
de mañana. Volvé a correr el curl y revisá tu bandeja de entrada
(el mismo email con el que te registraste en Resend).

## 8. Desplegar a Vercel

1. Subí este proyecto a un repo de GitHub (o conectá la carpeta
   directo si usás la CLI de Vercel).
2. En Vercel: **Import Project** → seleccioná el repo.
3. **Settings → Environment Variables**: cargá las mismas variables
   del `.env.local`.
4. Deploy. El cron ya está configurado en `vercel.json` para correr
   todos los días a las 12:00 UTC — no hay que hacer nada más.

## Nota sobre Resend

Sin verificar un dominio propio, Resend solo te deja mandar emails a
la cuenta con la que te registraste en Resend. Perfecto para probar
solo/a; si mañana se suma un segundo usuario real a Cortana, ese
usuario no va a recibir emails hasta que verifiques un dominio propio
(gratis, Resend → Domains → Add Domain).

## Qué queda pendiente (según lo acordado)

- Mejorar la interfaz visual — hoy es funcional pero simple. Prioridad
  #2, después de confirmar que todo esto funciona de punta a punta.
- SMS (Twilio) y voz más natural (ElevenLabs) — pausados, no son
  prioridad ahora.

---

## Probar y diagnosticar los correos (actualización)

**Prueba rápida desde el chat** (la más fácil): con la sesión iniciada, escribile
a Cortana *"mandame por correo un mensaje de prueba"*. Tiene que aparecer una
etiqueta verde "Correo enviado a ..." y, en unos segundos, el correo en tu
Gmail y en resend.com → **Emails**. Si falla, la etiqueta naranja te muestra el
motivo exacto que devolvió Resend.

**Causa más común de que no llegue nada (y no aparezca en el panel):**
Resend, sin dominio propio verificado, solo envía al email con el que creaste
tu cuenta de Resend. Si te registraste en Cortana con OTRO correo, Resend
rechaza el envío. Solución: registrate en Cortana con el mismo email de tu
cuenta de Resend, o verificá un dominio en resend.com → Domains.

**Otras causas a revisar:**
- `RESEND_API_KEY` mal copiada en `.env.local` (hay que reiniciar `npm run dev`
  después de cambiar el archivo).
- Los recordatorios por fecha NO se disparan solos en local: el cron solo corre
  automáticamente en Vercel. En local hay que llamarlo a mano:
  `curl -H "Authorization: Bearer TU_CRON_SECRET" http://localhost:3000/api/cron/notificaciones`
  La respuesta ahora incluye una lista `errores` con el motivo de cada fallo.
- Revisá la carpeta de spam de Gmail: los envíos desde `onboarding@resend.dev`
  a veces caen ahí.

## Qué cambió en esta versión
- **Bug corregido:** el cron marcaba los avisos como enviados aunque Resend los
  rechazara. Ahora solo los marca si salieron de verdad, y reintenta al día
  siguiente si fallaron.
- **Nueva herramienta `enviar_correo`:** podés pedirle a Cortana que te mande
  por correo un resumen, tu lista de tareas o cualquier información. Solo
  envía al email vinculado a tu cuenta, nunca a terceros.
- Los textos de los correos ahora se escapan (una tarea con `<` o `&` en el
  título ya no rompe el HTML del mensaje).
