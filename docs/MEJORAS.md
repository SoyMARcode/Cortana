# Mejoras de QIR — guía por partes

Cada parte explica **qué hace**, **cómo se usa** y **cómo funciona por
dentro**, y qué hay que correr en Supabase para activarla. La arquitectura
general está en [ARCHITECTURE.md](ARCHITECTURE.md).

| Parte | Funciones | Estado |
|---|---|---|
| 1. Avisos inteligentes | No molestar · Aviso antes de cada evento · Rescate de tareas atrasadas · Limpieza semanal | Publicada |
| 2. Comodidad | Botones de respuesta rápida · Tus tareas en Google Calendar | Publicada |
| 3. Equipo y plata | Tareas en equipo · Gastos | Publicada |
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

---

## Parte 2 · Comodidad

### Botones de respuesta rápida (M4)

**Qué hace.** Cuando la respuesta obvia es corta (confirmar, elegir una
opción, el siguiente paso), debajo del último mensaje de QIR aparecen
hasta 3 botones, por ejemplo **Sí, a las 9** · **Sí, a las 8** ·
**No hace falta**. Tocar uno es igual que escribirlo y enviarlo.

**Cuándo no aparecen.** En respuestas abiertas, cuando ya no hay un
siguiente paso, mientras QIR está escribiendo y cuando hay que aprobar algo
con los botones de siempre (correo a otra persona, borrar una tarea).

**Por dentro.** QIR termina el texto con una línea
`[[opción 1 | opción 2 | opción 3]]` (lo indica `lib/personality.ts`).
`lib/sugerencias.ts` la separa: `separarSugerencias()` saca las opciones
(máximo 3, de hasta 40 caracteres) y `sinSugerencias()` la borra del texto
que se muestra y del que se lee en voz alta, también mientras se está
escribiendo. `RespuestasRapidas` en `app/chat.tsx` dibuja los botones solo
en el último mensaje. Se eligió una marca en el texto y no una herramienta
porque no agrega otro viaje al modelo.

### Tus tareas en Google Calendar (M1)

**Qué hace.** Tus tareas con fecha (como eventos de día completo, con ✅)
y tus avisos programados (con ⏰, a su hora) aparecen dentro de Google
Calendar, Apple o Outlook. Las repeticiones también: "todos los lunes"
se ve todos los lunes. Es de solo lectura: se cambian desde QIR.

**Cómo se usa.**
1. Pedile a QIR: "quiero ver mis tareas en Google Calendar". Te da un
   enlace privado.
2. En la computadora, en calendar.google.com, a la izquierda, junto a
   **Otros calendarios**, tocá **+** → **Desde URL**, pegá el enlace y tocá
   **Agregar calendario**. En el celular aparece solo.
3. Si compartiste el enlace por error: "haceme un enlace nuevo del
   calendario". El anterior deja de funcionar.

**Límite.** Google vuelve a leer el calendario cada varias horas (hasta
24): una tarea nueva no aparece al instante. Apple y Outlook suelen ser
más rápidos.

**Por dentro.** Herramienta `enlace_calendario_tareas` (`lib/tools.ts`):
crea un token al azar de 24 bytes en `ajustes.calendario_token` y devuelve
`https://elqir.com/api/calendario/<token>`. Esa ruta
(`app/api/calendario/[token]/route.ts`) no usa sesión: el token
identifica a la persona. El archivo lo arma `lib/calendario-tareas.ts` con
ical.js, y traduce las repeticiones a reglas iCal (`RRULE`): laborables =
`FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`.

### Activación (Supabase)

`supabase-schema.sql`, bloque **Mejoras v8 (parte 2)**: la columna
`ajustes.calendario_token`.

---

## Parte 3 · Equipo y plata

### Tareas en equipo (P4)

**Qué hace.** Le podés pasar una tarea a otra persona del equipo:
*"asignale a Chris revisar el informe para el viernes"*.
- A esa persona le llega un aviso (*"📋 vos@… te asignó: Revisar el
  informe (vence el viernes 9 de octubre)"*) y la tarea le aparece en su
  panel con la marca **de tu-nombre**.
- Desde ahí es una tarea más suya: le llegan los avisos de vencimiento, el
  rescate y demás, y puede tacharla desde el panel o desde el chat.
- Cuando la completa, te llega a vos: *"✅ chris@… completó: Revisar el
  informe"*.
- *"¿Cómo van las tareas que asigné?"* muestra cuáles siguen pendientes.

**Límites.** Solo entre personas del equipo que ya crearon su cuenta.
Hasta 30 tareas asignadas por persona cada 24 horas.

**Por dentro.**
- Herramientas `companeros_de_equipo`, `asignar_tarea` y
  `tareas_que_asigne` (`lib/tools.ts`).
- La tarea la crea el servidor (service role) a nombre de quien la recibe
  (`user_id`), con `asignada_por` y `asignada_por_email`. Así RLS y todos
  los avisos funcionan igual que con una tarea propia.
- Los dos avisos viajan como recordatorios inmediatos (`enviar_en = now()`):
  el reloj de cada 10 segundos los entrega por notificación o correo. El de
  "completó" lo crea el trigger `tareas_avisar_asignada` en la base, así
  funciona aunque se tache desde el panel.

### Gastos (P7)

**Qué hace.** Contale a QIR lo que gastás y lo anota:
*"gasté 20 mil en el almuerzo"*, *"pagué 120 mil de luz"*,
*"ayer 8.500 de taxi"*. Después podés preguntar *"¿cuánto gasté este
mes?"*, *"¿en qué gasto más?"*, *"¿cuánto gasté en comida en septiembre?"*.
- Categorías: comida, transporte, hogar, servicios, salud, ocio, compras,
  educación, trabajo, otros.
- Moneda: la de tu país; se puede usar otra ("15 dólares de Netflix") y
  los totales se separan por moneda.
- El **resumen semanal** ahora suma los gastos de la semana.
- Para corregir: *"borrá el gasto del taxi de ayer"*.

**Privacidad.** Los gastos son privados de cada persona; nadie del equipo
los ve.

**Por dentro.** Tabla `gastos` con RLS. `lib/gastos.ts`:
`resumirGastos()` (totales por moneda y por categoría, y el gasto mayor) y
`formatearMonto()` (formato del país de cada moneda: `$ 8.500` en pesos
colombianos). Herramientas `registrar_gasto`, `resumen_gastos`,
`listar_gastos` y `borrar_gasto`.

### Activación (Supabase)

`supabase-schema.sql`, bloque **Mejoras v8 (parte 3)**: columnas
`tareas.asignada_por` y `asignada_por_email`, el trigger
`tareas_avisar_asignada` y la tabla `gastos`.
