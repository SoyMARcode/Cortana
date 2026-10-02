-- QIR — esquema de base de datos (Supabase / Postgres)
-- Ejecutar esto en: Supabase Dashboard → SQL Editor → New query → Run
-- Es seguro correrlo más de una vez: no da error si ya existe todo.

create extension if not exists "uuid-ossp";

create table if not exists tareas (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  titulo text not null,
  descripcion text,
  fecha_limite date,
  completada boolean not null default false,
  ultimo_aviso_dia integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tareas_user_id_idx on tareas(user_id);
create index if not exists tareas_fecha_limite_idx on tareas(fecha_limite) where completada = false;

alter table tareas enable row level security;

drop policy if exists "usuarios ven sus propias tareas" on tareas;
create policy "usuarios ven sus propias tareas"
  on tareas for select
  using (auth.uid() = user_id);

drop policy if exists "usuarios crean sus propias tareas" on tareas;
create policy "usuarios crean sus propias tareas"
  on tareas for insert
  with check (auth.uid() = user_id);

drop policy if exists "usuarios actualizan sus propias tareas" on tareas;
create policy "usuarios actualizan sus propias tareas"
  on tareas for update
  using (auth.uid() = user_id);

drop policy if exists "usuarios borran sus propias tareas" on tareas;
create policy "usuarios borran sus propias tareas"
  on tareas for delete
  using (auth.uid() = user_id);

-- ============================================================
-- Mejoras v2: contactos, límite de correos, historial del chat.
-- También es seguro correr todo el archivo de nuevo.
-- ============================================================

-- updated_at de tareas se actualiza solo en cada cambio.
create or replace function marcar_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tareas_updated_at on tareas;
create trigger tareas_updated_at
  before update on tareas
  for each row execute function marcar_updated_at();

-- Libreta de contactos: "Ana" -> ana@gmail.com
create table if not exists contactos (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text not null,
  email text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists contactos_user_nombre_idx on contactos(user_id, lower(nombre));

alter table contactos enable row level security;

drop policy if exists "usuarios gestionan sus contactos" on contactos;
create policy "usuarios gestionan sus contactos"
  on contactos for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Registro de correos enviados, para el límite diario anti-spam.
-- Sin políticas de update/delete: el usuario no puede borrar su registro.
create table if not exists correos_enviados (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  destinatario text not null,
  created_at timestamptz not null default now()
);

create index if not exists correos_enviados_user_fecha_idx on correos_enviados(user_id, created_at);

alter table correos_enviados enable row level security;

drop policy if exists "usuarios ven sus envíos" on correos_enviados;
create policy "usuarios ven sus envíos"
  on correos_enviados for select
  using (auth.uid() = user_id);

drop policy if exists "usuarios registran sus envíos" on correos_enviados;
create policy "usuarios registran sus envíos"
  on correos_enviados for insert
  with check (auth.uid() = user_id);

-- Historial del chat: una conversación por usuario.
create table if not exists conversaciones (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mensajes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table conversaciones enable row level security;

drop policy if exists "usuarios gestionan su conversación" on conversaciones;
create policy "usuarios gestionan su conversación"
  on conversaciones for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- Mejoras v3: recordatorios con hora ("recordame a las 6:45").
-- ============================================================

create table if not exists recordatorios (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tarea_id uuid references tareas(id) on delete cascade,
  mensaje text not null,
  enviar_en timestamptz not null,
  zona_horaria text not null default 'UTC',
  enviado_en timestamptz,
  reclamado_en timestamptz,
  intentos integer not null default 0,
  ultimo_error text,
  created_at timestamptz not null default now()
);

create index if not exists recordatorios_pendientes_idx
  on recordatorios(enviar_en) where enviado_en is null;
create index if not exists recordatorios_user_idx on recordatorios(user_id);

alter table recordatorios enable row level security;

drop policy if exists "usuarios gestionan sus recordatorios" on recordatorios;
create policy "usuarios gestionan sus recordatorios"
  on recordatorios for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Toma un lote de recordatorios vencidos y los marca como "en proceso".
-- FOR UPDATE SKIP LOCKED: si dos ejecuciones del cron se pisan, cada una
-- se lleva recordatorios distintos y nadie recibe el aviso dos veces.
-- Un reclamo de hace más de 10 minutos se considera colgado y se reintenta.
create or replace function reclamar_recordatorios(limite integer default 100)
returns setof recordatorios
language sql
as $$
  update recordatorios r
     set reclamado_en = now()
   where r.id in (
     select id from recordatorios
      where enviado_en is null
        and enviar_en <= now()
        and intentos < 5
        and (reclamado_en is null or reclamado_en < now() - interval '10 minutes')
      order by enviar_en
      limit limite
      for update skip locked
   )
  returning r.*;
$$;

-- Solo el servidor (service role) puede reclamar recordatorios.
revoke execute on function reclamar_recordatorios(integer) from public, anon, authenticated;
grant execute on function reclamar_recordatorios(integer) to service_role;

-- ============================================================
-- Mejoras v4: notificaciones push (un registro por dispositivo).
-- ============================================================

create table if not exists push_suscripciones (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  dispositivo text,
  created_at timestamptz not null default now()
);

create index if not exists push_suscripciones_user_idx on push_suscripciones(user_id);

-- Las escribe el servidor (service role). El usuario solo puede ver y
-- borrar las suyas.
alter table push_suscripciones enable row level security;

drop policy if exists "usuarios ven sus dispositivos" on push_suscripciones;
create policy "usuarios ven sus dispositivos"
  on push_suscripciones for select
  using (auth.uid() = user_id);

drop policy if exists "usuarios borran sus dispositivos" on push_suscripciones;
create policy "usuarios borran sus dispositivos"
  on push_suscripciones for delete
  using (auth.uid() = user_id);

-- ============================================================
-- Mejoras v5: uso en equipo (invitaciones + límite de chat).
-- ============================================================

-- Solo pueden crear cuenta los emails de esta lista. es_admin = puede
-- invitar a otros desde el chat. Sin políticas RLS: solo el servidor
-- (service role) la lee y la escribe.
create table if not exists invitaciones (
  email text primary key,
  es_admin boolean not null default false,
  invitado_por text,
  created_at timestamptz not null default now()
);

alter table invitaciones enable row level security;

-- El dueño del proyecto es el primer administrador.
insert into invitaciones (email, es_admin, invitado_por)
values ('acevedomichael653@gmail.com', true, 'instalación')
on conflict (email) do update set es_admin = true;

-- Bloquea en la base de datos cualquier registro que no esté invitado,
-- venga de donde venga (la app, la API de Supabase, un magic link...).
create or replace function public.verificar_invitacion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or not exists (
    select 1 from public.invitaciones where email = lower(new.email)
  ) then
    raise exception 'Este email no está invitado a QIR';
  end if;
  return new;
end;
$$;

drop trigger if exists verificar_invitacion on auth.users;
create trigger verificar_invitacion
  before insert on auth.users
  for each row execute function public.verificar_invitacion();

-- Mensajes de chat por persona y por día, para controlar el costo de la IA.
create table if not exists uso_chat (
  user_id uuid not null references auth.users(id) on delete cascade,
  fecha date not null default current_date,
  mensajes integer not null default 0,
  primary key (user_id, fecha)
);

alter table uso_chat enable row level security;

drop policy if exists "usuarios ven su uso" on uso_chat;
create policy "usuarios ven su uso"
  on uso_chat for select
  using (auth.uid() = user_id);

-- Suma un mensaje al día de hoy del usuario actual y devuelve el total.
-- Si ya llegó al límite no suma y devuelve -1. Es atómico: dos pestañas
-- mandando a la vez no pueden pasarse del límite.
create or replace function public.registrar_mensaje_chat(limite integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  total integer;
begin
  if auth.uid() is null then
    raise exception 'Sin sesión';
  end if;

  insert into public.uso_chat (user_id, fecha, mensajes)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, fecha) do update
    set mensajes = public.uso_chat.mensajes + 1
    where public.uso_chat.mensajes < limite
  returning mensajes into total;

  return coalesce(total, -1);
end;
$$;

revoke execute on function public.registrar_mensaje_chat(integer) from public, anon;
grant execute on function public.registrar_mensaje_chat(integer) to authenticated;

-- ============================================================
-- Mejoras v6: repeticiones, ajustes, preferencias, apodos,
-- calendario y adjuntos.
-- ============================================================

-- Repeticiones: 'diaria', 'laborables' (lun a vie), 'semanal', 'mensual'.
-- dias_semana (0 = domingo ... 6 = sábado) solo se usa con 'semanal',
-- para "todos los lunes y jueves". Sin días, se repite cada 7 días.
alter table recordatorios add column if not exists repeticion text
  check (repeticion in ('diaria', 'laborables', 'semanal', 'mensual'));
alter table recordatorios add column if not exists dias_semana smallint[];
alter table tareas add column if not exists repeticion text
  check (repeticion in ('diaria', 'laborables', 'semanal', 'mensual'));
alter table tareas add column if not exists dias_semana smallint[];

-- La próxima fecha de una repetición. La misma lógica está en
-- lib/repeticion.ts (para los recordatorios, que tienen hora y zona).
create or replace function public.siguiente_fecha(fecha date, repeticion text, dias smallint[])
returns date
language plpgsql
immutable
as $$
declare
  d date := fecha + 1;
begin
  if repeticion = 'diaria' then
    return fecha + 1;
  elsif repeticion = 'mensual' then
    return (fecha + interval '1 month')::date;
  elsif repeticion = 'laborables' then
    while extract(dow from d) in (0, 6) loop d := d + 1; end loop;
    return d;
  elsif repeticion = 'semanal' then
    if dias is null or cardinality(dias) = 0 then return fecha + 7; end if;
    while not (extract(dow from d)::smallint = any (dias)) loop d := d + 1; end loop;
    return d;
  end if;
  return null;
end;
$$;

-- Al completar una tarea que se repite, aparece la siguiente. Sirve igual
-- si se tacha desde el panel o desde el chat.
create or replace function public.crear_siguiente_tarea()
returns trigger
language plpgsql
as $$
declare
  proxima date;
begin
  if new.completada and not old.completada
     and new.repeticion is not null and new.fecha_limite is not null then
    proxima := public.siguiente_fecha(new.fecha_limite, new.repeticion, new.dias_semana);
    -- Si la destachan y la vuelven a tachar, no se duplica la siguiente.
    if not exists (
      select 1 from public.tareas
       where user_id = new.user_id and titulo = new.titulo
         and fecha_limite = proxima and not completada
    ) then
      insert into public.tareas (user_id, titulo, descripcion, fecha_limite, repeticion, dias_semana)
      values (new.user_id, new.titulo, new.descripcion, proxima, new.repeticion, new.dias_semana);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tareas_repetir on tareas;
create trigger tareas_repetir
  after update of completada on tareas
  for each row execute function public.crear_siguiente_tarea();

-- Ajustes por persona: zona horaria, ubicación aproximada, resumen semanal,
-- aviso de lluvia y calendario. Una fila por usuario; se crea sola al chatear.
create table if not exists ajustes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  zona_horaria text not null default 'UTC',
  -- Ubicación redondeada a ~1 km. Nunca se guarda la exacta.
  latitud double precision,
  longitud double precision,
  lugar text,
  ciudad text,
  region text,
  pais text,
  ubicacion_actualizada timestamptz,
  resumen_semanal boolean not null default true,
  resumen_dia smallint not null default 1 check (resumen_dia between 0 and 6),
  resumen_hora smallint not null default 8 check (resumen_hora between 0 and 23),
  ultimo_resumen date,
  aviso_lluvia boolean not null default true,
  ultimo_aviso_lluvia date,
  -- Dirección secreta iCal (Google, Outlook, Apple). Solo lectura.
  calendario_ics text,
  updated_at timestamptz not null default now()
);

alter table ajustes enable row level security;

drop policy if exists "usuarios gestionan sus ajustes" on ajustes;
create policy "usuarios gestionan sus ajustes"
  on ajustes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Cosas que QIR recuerda de cada persona ("prefiere que le hable de usted").
create table if not exists preferencias (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  texto text not null check (char_length(texto) <= 300),
  created_at timestamptz not null default now()
);

create index if not exists preferencias_user_idx on preferencias(user_id);

alter table preferencias enable row level security;

drop policy if exists "usuarios gestionan sus preferencias" on preferencias;
create policy "usuarios gestionan sus preferencias"
  on preferencias for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Apodos de cada contacto: "Anita", "mi hermana", "la jefa".
alter table contactos add column if not exists apodos text[] not null default '{}';

-- Archivos que se adjuntan en el chat para mandarlos por correo.
-- Cada persona solo ve su carpeta: adjuntos/<su id>/...
insert into storage.buckets (id, name, public, file_size_limit)
values ('adjuntos', 'adjuntos', false, 10485760)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "usuarios suben sus adjuntos" on storage.objects;
create policy "usuarios suben sus adjuntos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "usuarios ven sus adjuntos" on storage.objects;
create policy "usuarios ven sus adjuntos"
  on storage.objects for select to authenticated
  using (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "usuarios borran sus adjuntos" on storage.objects;
create policy "usuarios borran sus adjuntos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);


-- ============================================================
-- Mejoras v7: "buenos días" diario (clima, eventos, tareas y avisos de hoy).
-- ============================================================

alter table ajustes add column if not exists buenos_dias boolean not null default true;
alter table ajustes add column if not exists buenos_dias_hora smallint not null default 7
  check (buenos_dias_hora between 0 and 23);
alter table ajustes add column if not exists ultimo_buenos_dias date;

-- ============================================================
-- Mejoras v8 (parte 1): no molestar, aviso antes de eventos,
-- rescate de tareas atrasadas y limpieza semanal.
-- ============================================================

-- No molestar: de noche no llegan avisos automáticos. Los recordatorios
-- que la persona programó a una hora exacta llegan igual.
alter table ajustes add column if not exists no_molestar boolean not null default true;
alter table ajustes add column if not exists no_molestar_desde smallint not null default 22
  check (no_molestar_desde between 0 and 23);
alter table ajustes add column if not exists no_molestar_hasta smallint not null default 7
  check (no_molestar_hasta between 0 and 23);

-- Minutos antes de cada evento del calendario en que llega el aviso. 0 = apagado.
alter table ajustes add column if not exists aviso_evento_minutos smallint not null default 30
  check (aviso_evento_minutos between 0 and 240);

-- Último domingo en que se mandó la limpieza de tareas viejas sin fecha.
alter table ajustes add column if not exists ultima_limpieza date;

-- Último día en que se ofreció rescatar esta tarea atrasada.
alter table tareas add column if not exists ultimo_rescate date;

-- Eventos del calendario ya avisados, para no repetir el aviso.
-- Sin políticas RLS: solo la usa el servidor.
create table if not exists eventos_avisados (
  user_id uuid not null references auth.users(id) on delete cascade,
  clave text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, clave)
);

alter table eventos_avisados enable row level security;

-- ============================================================
-- Mejoras v8 (parte 2): tus tareas en Google Calendar.
-- ============================================================

-- Token secreto de la dirección iCal con las tareas y avisos de la persona
-- (app/api/calendario/[token]). Se crea la primera vez que lo pide.
alter table ajustes add column if not exists calendario_token text unique;

-- ============================================================
-- Mejoras v8 (parte 3): tareas en equipo y gastos.
-- ============================================================

-- Tareas asignadas: la fila es de quien la recibe (user_id), así le llegan
-- todos los avisos como a cualquier tarea suya. asignada_por = quién se la
-- pasó. Las crea el servidor (service role) después de validar que las dos
-- personas son del equipo.
alter table tareas add column if not exists asignada_por uuid references auth.users(id) on delete set null;
alter table tareas add column if not exists asignada_por_email text;
create index if not exists tareas_asignada_por_idx on tareas(asignada_por) where asignada_por is not null;

-- Cuando alguien completa una tarea que le asignaron, quien se la asignó
-- recibe un aviso. Se crea como recordatorio inmediato: el reloj de cada
-- 10 segundos lo entrega por notificación (o correo).
create or replace function public.avisar_tarea_asignada_completada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  quien text;
  zona text;
begin
  if new.completada and not old.completada
     and new.asignada_por is not null and new.asignada_por <> new.user_id then
    select email into quien from auth.users where id = new.user_id;
    select zona_horaria into zona from public.ajustes where user_id = new.asignada_por;
    insert into public.recordatorios (user_id, mensaje, enviar_en, zona_horaria)
    values (
      new.asignada_por,
      left('✅ ' || coalesce(quien, 'Alguien del equipo') || ' completó: ' || new.titulo, 300),
      now(),
      coalesce(zona, 'UTC')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists tareas_avisar_asignada on tareas;
create trigger tareas_avisar_asignada
  after update of completada on tareas
  for each row execute function public.avisar_tarea_asignada_completada();

-- Gastos: privados de cada persona.
create table if not exists gastos (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  monto numeric(14, 2) not null check (monto > 0),
  moneda text not null default 'COP' check (char_length(moneda) = 3),
  categoria text not null default 'otros'
    check (categoria in ('comida', 'transporte', 'hogar', 'servicios', 'salud', 'ocio',
                         'compras', 'educacion', 'trabajo', 'otros')),
  descripcion text check (char_length(descripcion) <= 200),
  fecha date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists gastos_user_fecha_idx on gastos(user_id, fecha);

alter table gastos enable row level security;

drop policy if exists "usuarios gestionan sus gastos" on gastos;
create policy "usuarios gestionan sus gastos"
  on gastos for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- Mejoras v8 (parte 4): buscar en conversaciones anteriores y
-- preguntarle a tus documentos. Búsqueda de texto en español de Postgres.
-- ============================================================

-- Archivo de mensajes: el texto de cada mensaje, para buscar en todo lo
-- hablado. "Nueva conversación" no lo borra; se borra con la herramienta
-- olvidar_conversaciones (con aprobación).
create table if not exists mensajes_archivo (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mensaje_id text not null,
  rol text not null check (rol in ('user', 'assistant')),
  texto text not null,
  busqueda tsvector generated always as (to_tsvector('spanish', texto)) stored,
  created_at timestamptz not null default now(),
  unique (user_id, mensaje_id)
);

create index if not exists mensajes_archivo_busqueda_idx on mensajes_archivo using gin (busqueda);
create index if not exists mensajes_archivo_user_fecha_idx on mensajes_archivo(user_id, created_at);

alter table mensajes_archivo enable row level security;

drop policy if exists "usuarios gestionan su archivo" on mensajes_archivo;
create policy "usuarios gestionan su archivo"
  on mensajes_archivo for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Lo que ya estaba en el historial pasa al archivo (con la fecha del
-- último guardado, porque los mensajes viejos no tienen fecha propia).
insert into mensajes_archivo (user_id, mensaje_id, rol, texto, created_at)
select c.user_id, m->>'id', m->>'role', string_agg(p->>'text', ' '), c.updated_at
  from conversaciones c,
       jsonb_array_elements(c.mensajes) m,
       jsonb_array_elements(m->'parts') p
 where p->>'type' = 'text' and m->>'role' in ('user', 'assistant') and m->>'id' is not null
 group by c.user_id, m->>'id', m->>'role', c.updated_at
on conflict (user_id, mensaje_id) do nothing;

-- Documentos guardados: solo el texto, partido en fragmentos para buscar.
create table if not exists documentos (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text not null,
  tipo text not null,
  paginas integer,
  caracteres integer not null,
  created_at timestamptz not null default now()
);

create index if not exists documentos_user_idx on documentos(user_id);

alter table documentos enable row level security;

drop policy if exists "usuarios gestionan sus documentos" on documentos;
create policy "usuarios gestionan sus documentos"
  on documentos for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists documento_fragmentos (
  id uuid primary key default uuid_generate_v4(),
  documento_id uuid not null references documentos(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  numero integer not null,
  texto text not null,
  busqueda tsvector generated always as (to_tsvector('spanish', texto)) stored
);

create index if not exists documento_fragmentos_busqueda_idx on documento_fragmentos using gin (busqueda);
create index if not exists documento_fragmentos_doc_idx on documento_fragmentos(documento_id, numero);

alter table documento_fragmentos enable row level security;

drop policy if exists "usuarios gestionan sus fragmentos" on documento_fragmentos;
create policy "usuarios gestionan sus fragmentos"
  on documento_fragmentos for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Búsquedas ordenadas por relevancia. security invoker: corren con la
-- sesión de quien busca, así RLS limita a sus propias filas.
create or replace function public.buscar_mensajes(consulta text, desde timestamptz, hasta timestamptz, limite integer default 10)
returns table (rol text, texto text, created_at timestamptz, relevancia real)
language sql stable security invoker set search_path = ''
as $$
  select m.rol, m.texto, m.created_at,
         case when consulta is null or consulta = '' then 0
              else ts_rank(m.busqueda, websearch_to_tsquery('spanish', consulta)) end
    from public.mensajes_archivo m
   where (desde is null or m.created_at >= desde)
     and (hasta is null or m.created_at < hasta)
     and (consulta is null or consulta = '' or m.busqueda @@ websearch_to_tsquery('spanish', consulta))
   order by 4 desc, m.created_at desc
   limit limite;
$$;

create or replace function public.buscar_en_documentos(consulta text, documento uuid, limite integer default 6)
returns table (documento_id uuid, nombre text, numero integer, texto text, relevancia real)
language sql stable security invoker set search_path = ''
as $$
  select f.documento_id, d.nombre, f.numero, f.texto,
         ts_rank(f.busqueda, websearch_to_tsquery('spanish', consulta))
    from public.documento_fragmentos f
    join public.documentos d on d.id = f.documento_id
   where f.busqueda @@ websearch_to_tsquery('spanish', consulta)
     and (documento is null or f.documento_id = documento)
   order by 5 desc
   limit limite;
$$;

-- ============================================================
-- Mejoras v8 (parte 5): crear y mover eventos en Google Calendar.
-- ============================================================

-- Conexión de cada persona con su Google Calendar. El refresh token va
-- cifrado (AES-256-GCM, lib/google.ts): ni con acceso a la base se puede
-- usar sin la clave del servidor. Sin políticas RLS: solo el servidor.
create table if not exists google_cuentas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  refresh_token_cifrado text not null,
  access_token_cifrado text,
  expira_en timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table google_cuentas enable row level security;

notify pgrst, 'reload schema';
