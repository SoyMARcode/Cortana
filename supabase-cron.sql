-- Cortana Agent — reloj de recordatorios con hora.
-- Ejecutar DESPUÉS de publicar la app en Vercel, en:
-- Supabase Dashboard → SQL Editor → New query → Run
--
-- Antes de correrlo, reemplazá los DOS valores marcados con <<< >>>:
--   1. La URL de tu app en Vercel (sin barra final).
--   2. El mismo CRON_SECRET que cargaste en Vercel.
-- Los dos quedan guardados en el Vault de Supabase (cifrados), no en el job.
-- Es seguro correrlo de nuevo: actualiza los valores y el job.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Guarda (o actualiza) la URL y el secreto en el Vault.
do $$
declare
  url_app text := '<<<https://tu-app.vercel.app>>>';
  secreto text := '<<<tu_CRON_SECRET>>>';
begin
  if exists (select 1 from vault.secrets where name = 'cortana_url') then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'cortana_url'), url_app);
  else
    perform vault.create_secret(url_app, 'cortana_url');
  end if;

  if exists (select 1 from vault.secrets where name = 'cortana_cron_secret') then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'cortana_cron_secret'), secreto);
  else
    perform vault.create_secret(secreto, 'cortana_cron_secret');
  end if;
end $$;

-- Cada minuto, le pide a la app que envíe los recordatorios vencidos.
select cron.unschedule('cortana-recordatorios')
where exists (select 1 from cron.job where jobname = 'cortana-recordatorios');

select cron.schedule(
  'cortana-recordatorios',
  '* * * * *',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cortana_url')
           || '/api/cron/recordatorios',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cortana_cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $$
);

-- Para revisar que esté corriendo:
--   select * from cron.job_run_details order by start_time desc limit 5;
--   select status_code, content from net._http_response order by created desc limit 5;
