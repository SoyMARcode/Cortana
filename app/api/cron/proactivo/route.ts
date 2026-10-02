import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { enviarResumenSemanal } from '@/lib/email';
import { enviarPush } from '@/lib/push';
import { pronostico } from '@/lib/clima';
import { armarResumen } from '@/lib/resumen';
import { armarBuenosDias } from '@/lib/buenos-dias';
import { partesLocales } from '@/lib/zona-horaria';
import { NOMBRE } from '@/lib/marca';
import { enNoMolestar, type HorarioNoMolestar } from '@/lib/no-molestar';
import {
  avisarLimpieza,
  DIA_LIMPIEZA,
  HORA_LIMPIEZA,
  HORA_RESCATE,
  rescatarTareas,
} from '@/lib/rescate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Hora local del aviso de lluvia. */
const HORA_AVISO_LLUVIA = 7;

type Fila = HorarioNoMolestar & {
  user_id: string;
  latitud: number | null;
  longitud: number | null;
  lugar: string | null;
  resumen_semanal: boolean;
  resumen_dia: number;
  resumen_hora: number;
  ultimo_resumen: string | null;
  aviso_lluvia: boolean;
  ultimo_aviso_lluvia: string | null;
  buenos_dias: boolean;
  buenos_dias_hora: number;
  ultimo_buenos_dias: string | null;
  ultima_limpieza: string | null;
  calendario_ics: string | null;
};

/**
 * Avisos que QIR manda sin que se los pidan. Lo llama pg_cron cada hora en
 * punto (ver supabase-cron.sql); a cada persona le toca según su hora local:
 * - Resumen semanal: el día y la hora de sus ajustes (por defecto lunes 8:00).
 * - Buenos días: cada mañana a la hora de sus ajustes (por defecto 7:00), con
 *   clima, eventos, tareas y avisos de hoy. Ya trae el aviso de lluvia.
 * - Lluvia sola: a las 7:00, solo para quien apagó el buenos días.
 * - Rescate de tareas atrasadas: todos los días a las 9:00 (lib/rescate.ts).
 * - Limpieza de tareas viejas sin fecha: los domingos a las 18:00.
 * El rescate y la limpieza respetan el horario de no molestar.
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
      'user_id, zona_horaria, latitud, longitud, lugar, resumen_semanal, resumen_dia, resumen_hora, ultimo_resumen, aviso_lluvia, ultimo_aviso_lluvia, buenos_dias, buenos_dias_hora, ultimo_buenos_dias, ultima_limpieza, calendario_ics, no_molestar, no_molestar_desde, no_molestar_hasta'
    );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const ahora = new Date();
  let resumenes = 0;
  let lluvias = 0;
  let buenosDias = 0;
  let rescates = 0;
  let limpiezas = 0;
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
      f.buenos_dias &&
      local.horaDelDia === f.buenos_dias_hora &&
      f.ultimo_buenos_dias !== local.fecha
    ) {
      try {
        const aviso = await armarBuenosDias(supabase, f);
        // Solo push: es un vistazo rápido, un correo diario sería demasiado.
        if (aviso && (await enviarPush(f.user_id, { ...aviso, tag: 'buenos-dias' })) > 0) buenosDias++;
        await supabase.from('ajustes').update({ ultimo_buenos_dias: local.fecha }).eq('user_id', f.user_id);
      } catch (e) {
        errores.push({ user_id: f.user_id, motivo: e instanceof Error ? e.message : String(e) });
      }
    }

    if (
      f.aviso_lluvia &&
      !f.buenos_dias &&
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

    // Desde acá, avisos automáticos que respetan el horario de no molestar.
    if (enNoMolestar(f, ahora)) continue;

    if (local.horaDelDia === HORA_RESCATE) {
      try {
        rescates += await rescatarTareas(supabase, f.user_id, local.fecha);
      } catch (e) {
        errores.push({ user_id: f.user_id, motivo: e instanceof Error ? e.message : String(e) });
      }
    }

    if (
      local.diaSemana === DIA_LIMPIEZA &&
      local.horaDelDia === HORA_LIMPIEZA &&
      f.ultima_limpieza !== local.fecha
    ) {
      try {
        if (await avisarLimpieza(supabase, f.user_id)) limpiezas++;
        await supabase.from('ajustes').update({ ultima_limpieza: local.fecha }).eq('user_id', f.user_id);
      } catch (e) {
        errores.push({ user_id: f.user_id, motivo: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    revisados: filas?.length ?? 0,
    resumenes,
    buenosDias,
    lluvias,
    rescates,
    limpiezas,
    errores,
  });
}
