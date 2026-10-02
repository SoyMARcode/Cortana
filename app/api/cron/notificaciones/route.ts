import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { enviarRecordatorio } from '@/lib/email';
import { enviarPush } from '@/lib/push';
import { firmarAviso } from '@/lib/firma-aviso';
import { enNoMolestar, type HorarioNoMolestar } from '@/lib/no-molestar';

export const dynamic = 'force-dynamic';

function diasHasta(fechaISO: string): number {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const limite = new Date(fechaISO + 'T00:00:00');
  const ms = limite.getTime() - hoy.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

export async function GET(req: Request) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) {
    return new NextResponse('CRON_SECRET no está configurado', { status: 500 });
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secreto}`) {
    return new NextResponse('No autorizado', { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: tareas, error } = await supabase
    .from('tareas')
    .select('id, titulo, fecha_limite, user_id, ultimo_aviso_dia, completada')
    .eq('completada', false)
    .not('fecha_limite', 'is', null);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Horario de no molestar de cada persona: de noche el aviso queda para mañana.
  const { data: horarios } = await supabase
    .from('ajustes')
    .select('user_id, zona_horaria, no_molestar, no_molestar_desde, no_molestar_hasta');
  const noMolestar = new Map(
    (horarios ?? []).map((h) => [h.user_id as string, h as HorarioNoMolestar])
  );

  let enviados = 0;
  const errores: { tarea: string; motivo: string }[] = [];

  for (const tarea of tareas ?? []) {
    const dias = diasHasta(tarea.fecha_limite as string);

    if (dias < 0 || dias > 8) continue;
    if (tarea.ultimo_aviso_dia === dias) continue;
    if (enNoMolestar(noMolestar.get(tarea.user_id))) continue;

    // Primero push; el correo solo si no llegó a ningún dispositivo.
    const entregadosPush = await enviarPush(tarea.user_id, {
      titulo: tarea.titulo,
      cuerpo:
        dias === 0 ? 'Vence hoy.' : dias === 1 ? 'Vence mañana.' : `Faltan ${dias} días.`,
      tag: `tarea-${tarea.id}`,
      acciones: [
        { accion: 'hecha', titulo: 'Marcar hecha' },
        { accion: 'manana', titulo: 'Pasar a mañana' },
      ],
      aviso: { tipo: 'tarea', id: tarea.id, firma: firmarAviso('tarea', tarea.id) },
    });

    let resultado: { ok: true } | { ok: false; error: string } = { ok: true };
    if (entregadosPush === 0) {
      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
        tarea.user_id
      );
      if (userError || !userData?.user?.email) {
        errores.push({ tarea: tarea.titulo, motivo: 'No se encontró el email del usuario' });
        continue;
      }
      resultado = await enviarRecordatorio({
        destinatario: userData.user.email,
        titulo: tarea.titulo,
        fechaLimite: tarea.fecha_limite as string,
        diasRestantes: dias,
      });
    }

    if (!resultado.ok) {
      // No se marca como avisado: mañana se vuelve a intentar.
      errores.push({ tarea: tarea.titulo, motivo: resultado.error });
      continue;
    }

    await supabase.from('tareas').update({ ultimo_aviso_dia: dias }).eq('id', tarea.id);
    enviados++;
  }

  return NextResponse.json({ ok: true, revisadas: tareas?.length ?? 0, enviados, errores });
}
