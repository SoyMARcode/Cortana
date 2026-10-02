# Mejoras de QIR — guía por partes

Cada parte explica **qué hace**, **cómo se usa** y **cómo funciona por
dentro**, y qué hay que correr en Supabase para activarla. La arquitectura
general está en [ARCHITECTURE.md](ARCHITECTURE.md).

| Parte | Funciones | Estado |
|---|---|---|
| 1. Avisos inteligentes | No molestar · Aviso antes de cada evento · Rescate de tareas atrasadas · Limpieza semanal | Publicada |
| 2. Comodidad | Botones de respuesta rápida · Tus tareas en Google Calendar | Pendiente |
| 3. Equipo y plata | Tareas en equipo · Gastos | Pendiente |
| 4. Memoria | Buscar en conversaciones anteriores · Preguntarle a tus documentos | Pendiente |
| 5. Google Calendar | Crear y mover eventos | Pendiente |

---

## Parte 1 · Avisos inteligentes

### No molestar (A3)

**Qué hace.** De noche no llegan avisos automáticos. Por defecto, de
10:00 p. m. a 7:00 a. m., en la hora local de cada persona.

**Qué respeta el silencio y qué no.**

| Llega igual de noche | Espera a que termine el silencio o no se manda |
|---|---|
| Recordatorios programados a una hora exacta ("recordame a las 11 p. m.") | Aviso antes de un evento |
| El buenos días (su hora la elige la persona) | Vencimiento de tareas |
| El resumen semanal | Rescate de tareas atrasadas |
| | Limpieza semanal |

**Cómo se usa.** Pedíselo a QIR: "no me mandes avisos después de las 11 de
la noche", "apagá el no molestar", "silencio de 1 a 3 de la tarde".

**Por dentro.** `lib/no-molestar.ts` → `enNoMolestar()`. Columnas
`ajustes.no_molestar`, `no_molestar_desde` y `no_molestar_hasta`. El
horario puede cruzar la medianoche (22 a 7) o no (13 a 15).

### Aviso antes de cada evento (A1)

**Qué hace.** 30 minutos antes de cada evento del calendario conectado
llega una notificación: *"En 30 min: Reunión · 3:00 p. m. · Oficina"*. Si
ese día va a llover y hay ubicación guardada, agrega *"Llevate paraguas"*.
No avisa los eventos de día completo.

**Cómo se usa.** Necesita el calendario conectado. Para cambiar el tiempo:
"avisame 15 minutos antes de mis reuniones"; para apagarlo: "no me avises
antes de los eventos".

**Por dentro.** `app/api/cron/eventos/route.ts`, llamado por pg_cron cada
5 minutos (`qir-eventos` en `supabase-cron.sql`). Solo llama a la app si
alguien tiene calendario conectado. Cada ocurrencia de un evento tiene una
`clave` (UID + inicio) y se anota en `eventos_avisados`, así nunca se
avisa dos veces; lo de más de 2 días se borra solo. Columna
`ajustes.aviso_evento_minutos` (0 = apagado, máximo 240).

### Rescate de tareas atrasadas (A2)

**Qué hace.** Todos los días a las 9:00 a. m., por cada tarea con 3 días o
más de atraso (hasta 3 por día), llega una notificación: *"¿Rescatamos
'Pagar la luz'? Venció el lunes 28 de septiembre (hace 4 días)"*, con los
botones **Pasar a mañana** y **Marcar hecha**. Cada tarea se vuelve a
ofrecer recién a los 3 días.

Los avisos de vencimiento de siempre ahora también traen **Pasar a mañana**.

**Cómo se usa.** Se toca el botón en la notificación, sin abrir la app. En
iPhone no aparecen botones: se toca la notificación y se resuelve en el chat.

**Por dentro.** `lib/rescate.ts` → `rescatarTareas()`, llamado desde
`app/api/cron/proactivo` a la hora `HORA_RESCATE`. Columna
`tareas.ultimo_rescate`. El botón llama a `/api/avisos/accion` con
`accion: 'manana'`, que pone la fecha en el día siguiente según la zona
horaria de la persona y reinicia los avisos de esa tarea.

### Limpieza semanal (A8)

**Qué hace.** Los domingos a las 6:00 p. m., si hay tareas **sin fecha**
con más de un mes, llega: *"Tenés 5 tareas sin fecha de hace más de un
mes"*. Al tocarla, el chat se abre con el pedido ya escrito ("Ayudame a
ordenar mis tareas sin fecha…") y QIR propone, una por una, borrarla o
ponerle fecha.

**Por dentro.** `lib/rescate.ts` → `avisarLimpieza()`. La notificación
abre `/?mensaje=…`: `app/page.tsx` lo lee y se lo pasa a `app/chat.tsx`
como texto inicial, y después limpia la dirección. Si QIR ya estaba
abierta, `public/sw.js` la lleva a esa dirección. Columna
`ajustes.ultima_limpieza`.

### Activación (Supabase)

1. `supabase-schema.sql`, bloque **Mejoras v8 (parte 1)**: columnas de
   no molestar, `aviso_evento_minutos`, `ultima_limpieza`,
   `tareas.ultimo_rescate` y la tabla `eventos_avisados`.
2. `supabase-cron.sql`: el reloj `qir-eventos` cada 5 minutos.

### Horarios fijos de la parte 1

| Aviso | Cuándo (hora local) | Dónde se cambia |
|---|---|---|
| Rescate | Todos los días, 9:00 a. m. | `HORA_RESCATE` en `lib/rescate.ts` |
| Limpieza | Domingos, 6:00 p. m. | `DIA_LIMPIEZA` / `HORA_LIMPIEZA` en `lib/rescate.ts` |
| Antes de eventos | 30 min antes (se cambia desde el chat) | `ajustes.aviso_evento_minutos` |
| No molestar | 10:00 p. m. a 7:00 a. m. (se cambia desde el chat) | `ajustes.no_molestar_*` |
