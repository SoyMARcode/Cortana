-- Cortana Agent — esquema de base de datos (Supabase / Postgres)
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
