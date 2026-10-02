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

notify pgrst, 'reload schema';
