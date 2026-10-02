-- QIR — relojes de avisos (recordatorios, resumen semanal y lluvia).
-- Ejecutar DESPUÉS de publicar la app en Vercel, en:
-- Supabase Dashboard → SQL Editor → New query → Run
--
-- Primera vez: reemplazá los DOS valores marcados con <<< >>>:
--   1. La URL de tu app en Vercel (sin barra final).
--   2. El mismo CRON_SECRET que cargaste en Vercel.
-- Los dos quedan guardados en el Vault de Supabase (cifrados), no en el job.
-- Si ya lo corriste antes, podés dejar los <<< >>> como están: se usan los
-- valores guardados. Es seguro correrlo de nuevo.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Guarda (o actualiza) la URL y el secreto en el Vault.
do $$
declare
  url_app text := '<<<https://tu-app.vercel.app>>>';
  secreto text := '<<<tu_CRON_SECRET>>>';
begin
  if url_app not like '<<<%' then
    if exists (select 1 from vault.secrets where name = 'cortana_url') then
      perform vault.update_secret(
        (select id from vault.secrets where name = 'cortana_url'), url_app);
    else
      perform vault.create_secret(url_app, 'cortana_url');
    end if;
  end if;

  if secreto not like '<<<%' then
    if exists (select 1 from vault.secrets where name = 'cortana_cron_secret') then
      perform vault.update_secret(
        (select id from vault.secrets where name = 'cortana_cron_secret'), secreto);
    else
      perform vault.create_secret(secreto, 'cortana_cron_secret');
    end if;
  end if;

  if not exists (select 1 from vault.secrets where name = 'cortana_url')
     or not exists (select 1 from vault.secrets where name = 'cortana_cron_secret') then
    raise exception 'Falta la URL o el CRON_SECRET: reemplazá los valores <<< >>> y volvé a correrlo.';
  end if;
end $$;

-- Cada 10 segundos revisa si hay recordatorios vencidos. Solo llama a la
-- app cuando hay alguno: así la precisión es de segundos sin gastar
-- invocaciones de Vercel cuando no hay nada que enviar.
select cron.unschedule('cortana-recordatorios')
where exists (select 1 from cron.job where jobname = 'cortana-recordatorios');

select cron.schedule(
  'cortana-recordatorios',
  '10 seconds',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cortana_url')
           || '/api/cron/recordatorios',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cortana_cron_secret')
    ),
    timeout_milliseconds := 30000
  )
  where exists (
    select 1 from public.recordatorios
     where enviado_en is null
       and enviar_en <= now()
       and intentos < 5
       and (reclamado_en is null or reclamado_en < now() - interval '10 minutes')
  );
  $$
);

-- Cada hora en punto: resumen semanal y aviso de lluvia. La app decide a
-- quién le toca según su zona horaria y sus ajustes.
select cron.unschedule('qir-proactivo')
where exists (select 1 from cron.job where jobname = 'qir-proactivo');

select cron.schedule(
  'qir-proactivo',
  '0 * * * *',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cortana_url')
           || '/api/cron/proactivo',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cortana_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);

-- Cada 5 minutos: aviso antes de cada evento del calendario. Solo llama a
-- la app si alguien tiene un calendario conectado con el aviso encendido.
select cron.unschedule('qir-eventos')
where exists (select 1 from cron.job where jobname = 'qir-eventos');

select cron.schedule(
  'qir-eventos',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cortana_url')
           || '/api/cron/eventos',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cortana_cron_secret')
    ),
    timeout_milliseconds := 60000
  )
  where exists (
    select 1 from public.ajustes
     where calendario_ics is not null and aviso_evento_minutos > 0
  );
  $$
);

-- Para revisar que esté corriendo:
--   select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;
--   select status_code, content from net._http_response order by created desc limit 5;
