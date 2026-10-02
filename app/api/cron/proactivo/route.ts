import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { enviarResumenSemanal } from '@/lib/email';
import { enviarPush } from '@/lib/push';
import { pronostico } from '@/lib/clima';
import { armarResumen } from '@/lib/resumen';
import { partesLocales } from '@/lib/zona-horaria';
import { NOMBRE } from '@/lib/marca';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Hora local del aviso de lluvia. */
const HORA_AVISO_LLUVIA = 7;

type Fila = {
  user_id: string;
  zona_horaria: string;
  latitud: number | null;
  longitud: number | null;
  lugar: string | null;
  resumen_semanal: boolean;
  resumen_dia: number;
  resumen_hora: number;
  ultimo_resumen: string | null;
  aviso_lluvia: boolean;
  ultimo_aviso_lluvia: string | null;
  calendario_ics: string | null;
};

/**
 * Avisos que QIR manda sin que se los pidan. Lo llama pg_cron cada hora en
 * punto (ver supabase-cron.sql); a cada persona le toca según su hora local:
 * - Resumen semanal: el día y la hora de sus ajustes (por defecto lunes 8:00).
 * - Lluvia: a las 7:00, si hay ubicación guardada y va a llover.
 */
export async function GET(req: Request) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) {
    return new NextResponse('CRON_SECRET no está configurado', { status: 500 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secreto}`) {
    return new NextResponse('No autorizado', { status: 401 });
  }

  const supabase = createAdminClient();
  const { data: filas, error } = await supabase
    .from('ajustes')
    .select(
      'user_id, zona_horaria, latitud, longitud, lugar, resumen_semanal, resumen_dia, resumen_hora, ultimo_resumen, aviso_lluvia, ultimo_aviso_lluvia, calendario_ics'
    )
    .or('resumen_semanal.eq.true,aviso_lluvia.eq.true');

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const ahora = new Date();
  let resumenes = 0;
  let lluvias = 0;
  const errores: { user_id: string; motivo: string }[] = [];

  for (const f of (filas ?? []) as Fila[]) {
    const local = partesLocales(ahora, f.zona_horaria);

    if (
      f.resumen_semanal &&
      local.diaSemana === f.resumen_dia &&
      local.horaDelDia === f.resumen_hora &&
      f.ultimo_resumen !== local.fecha
    ) {
      try {
        const resumen = await armarResumen(supabase, f.user_id, f.zona_horaria, f.calendario_ics);
        if (resumen) {
          const { data } = await supabase.auth.admin.getUserById(f.user_id);
          const email = data?.user?.email;
          const correo = email
            ? await enviarResumenSemanal({ destinatario: email, contenido: resumen.texto })
            : ({ ok: false, error: 'Sin email' } as const);
          await enviarPush(f.user_id, {
            titulo: `Tu semana con ${NOMBRE}`,
            cuerpo: correo.ok ? `${resumen.corto} · Detalle en tu correo.` : resumen.corto,
            tag: 'resumen-semanal',
          });
          if (!correo.ok) errores.push({ user_id: f.user_id, motivo: correo.error });
          else resumenes++;
        }
        await supabase.from('ajustes').update({ ultimo_resumen: local.fecha }).eq('user_id', f.user_id);
      } catch (e) {
        errores.push({ user_id: f.user_id, motivo: e instanceof Error ? e.message : String(e) });
      }
    }

    if (
      f.aviso_lluvia &&
      f.latitud != null &&
      f.longitud != null &&
      local.horaDelDia === HORA_AVISO_LLUVIA &&
      f.ultimo_aviso_lluvia !== local.fecha
    ) {
      try {
        const clima = await pronostico(
          { nombre: f.lugar ?? 'tu zona', latitud: f.latitud, longitud: f.longitud },
          1
        );
        const hoy = clima.dias[0];
        // Solo push: un correo diario por la lluvia sería demasiado.
        if (hoy?.llevar_paraguas) {
          const llegados = await enviarPush(f.user_id, {
            titulo: 'Llevate paraguas ☂️',
            cuerpo: `Hoy: ${hoy.descripcion}, ${hoy.prob_lluvia}% de probabilidad de lluvia. ${hoy.minima}° a ${hoy.maxima}°.`,
            tag: 'lluvia',
          });
          if (llegados > 0) lluvias++;
        }
        await supabase.from('ajustes').update({ ultimo_aviso_lluvia: local.fecha }).eq('user_id', f.user_id);
      } catch (e) {
        errores.push({ user_id: f.user_id, motivo: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return NextResponse.json({ ok: true, revisados: filas?.length ?? 0, resumenes, lluvias, errores });
}
