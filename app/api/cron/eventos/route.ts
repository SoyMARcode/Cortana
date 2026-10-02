import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { eventosEntre } from '@/lib/calendario';
import { pronostico } from '@/lib/clima';
import { enviarPush } from '@/lib/push';
import { enNoMolestar, type HorarioNoMolestar } from '@/lib/no-molestar';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Fila = HorarioNoMolestar & {
  user_id: string;
  calendario_ics: string;
  aviso_evento_minutos: number;
  latitud: number | null;
  longitud: number | null;
  lugar: string | null;
};

function hora12(instante: Date, zona: string): string {
  return new Intl.DateTimeFormat('es', {
    timeZone: zona,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(instante);
}

/**
 * Aviso antes de cada evento del calendario (por defecto 30 minutos antes),
 * con "llevate paraguas" si va a llover. Lo llama pg_cron cada 5 minutos
 * (ver supabase-cron.sql). Cada evento se avisa una sola vez: queda anotado
 * en eventos_avisados.
 */
export async function GET(req: Request) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return new NextResponse('CRON_SECRET no está configurado', { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secreto}`) {
    return new NextResponse('No autorizado', { status: 401 });
  }

  const supabase = createAdminClient();
  const { data: filas, error } = await supabase
    .from('ajustes')
    .select(
      'user_id, zona_horaria, calendario_ics, aviso_evento_minutos, latitud, longitud, lugar, no_molestar, no_molestar_desde, no_molestar_hasta'
    )
    .not('calendario_ics', 'is', null)
    .gt('aviso_evento_minutos', 0);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const ahora = new Date();
  let avisados = 0;
  const errores: { user_id: string; motivo: string }[] = [];

  for (const f of (filas ?? []) as Fila[]) {
    if (enNoMolestar(f, ahora)) continue;
    try {
      const hasta = new Date(ahora.getTime() + f.aviso_evento_minutos * 60_000);
      const proximos = (await eventosEntre(f.calendario_ics, ahora, hasta, f.zona_horaria)).filter(
        (e) => !e.todo_el_dia && Date.parse(e.inicio) > ahora.getTime()
      );
      if (!proximos.length) continue;

      // Solo los que todavía no se avisaron: el insert ignora los repetidos.
      const { data: nuevos } = await supabase
        .from('eventos_avisados')
        .upsert(
          proximos.map((e) => ({ user_id: f.user_id, clave: e.clave })),
          { onConflict: 'user_id,clave', ignoreDuplicates: true }
        )
        .select('clave');
      const claves = new Set((nuevos ?? []).map((n) => n.clave));
      const porAvisar = proximos.filter((e) => claves.has(e.clave));
      if (!porAvisar.length) continue;

      const clima =
        f.latitud != null && f.longitud != null
          ? await pronostico({ nombre: f.lugar ?? '', latitud: f.latitud, longitud: f.longitud }, 1).catch(
              () => null
            )
          : null;
      const lluvia = clima?.dias[0]?.llevar_paraguas
        ? ` Llevate paraguas ☂️ (${clima.dias[0].prob_lluvia}% de lluvia).`
        : '';

      for (const e of porAvisar) {
        const inicio = new Date(e.inicio);
        const minutos = Math.max(1, Math.round((inicio.getTime() - ahora.getTime()) / 60_000));
        const llegados = await enviarPush(f.user_id, {
          titulo: `En ${minutos} min: ${e.titulo}`,
          cuerpo: `${hora12(inicio, f.zona_horaria)}${e.lugar ? ` · ${e.lugar}` : ''}.${lluvia}`,
          tag: `evento-${e.clave}`,
        });
        if (llegados > 0) avisados++;
      }
    } catch (e) {
      errores.push({ user_id: f.user_id, motivo: e instanceof Error ? e.message : String(e) });
    }
  }

  // Lo avisado hace más de 2 días ya no puede repetirse: se limpia.
  await supabase
    .from('eventos_avisados')
    .delete()
    .lt('created_at', new Date(ahora.getTime() - 2 * 86_400_000).toISOString());

  return NextResponse.json({ ok: true, revisados: filas?.length ?? 0, avisados, errores });
}
