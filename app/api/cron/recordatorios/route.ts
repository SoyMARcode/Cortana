import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { enviarAvisoConHora } from '@/lib/email';
import { formatearEnZona } from '@/lib/zona-horaria';
import { enviarPush } from '@/lib/push';
import { NOMBRE } from '@/lib/marca';

export const dynamic = 'force-dynamic';

/**
 * Envía los recordatorios con hora que ya vencieron. Lo llama pg_cron
 * (Supabase) cada minuto; ver supabase-cron.sql.
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
  const { data: pendientes, error } = await supabase.rpc('reclamar_recordatorios', {
    limite: 100,
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Un mismo usuario puede tener varios avisos en el lote: su email se busca una sola vez.
  const emails = new Map<string, string | null>();
  async function emailDe(userId: string) {
    if (!emails.has(userId)) {
      const { data } = await supabase.auth.admin.getUserById(userId);
      emails.set(userId, data?.user?.email ?? null);
    }
    return emails.get(userId);
  }

  let enviados = 0;
  const errores: { id: string; motivo: string }[] = [];

  for (const r of pendientes ?? []) {
    const cuandoLocal = formatearEnZona(new Date(r.enviar_en), r.zona_horaria);

    // Primero al celular/computadora; el correo queda de respaldo si el
    // usuario no activó avisos en ningún dispositivo o no llegó a ninguno.
    const entregadosPush = await enviarPush(r.user_id, {
      titulo: r.mensaje,
      cuerpo: `Recordatorio de ${NOMBRE} · ${cuandoLocal}`,
      tag: `recordatorio-${r.id}`,
    });

    const destinatario = entregadosPush > 0 ? null : await emailDe(r.user_id);
    const resultado =
      entregadosPush > 0
        ? ({ ok: true } as const)
        : destinatario
          ? await enviarAvisoConHora({ destinatario, mensaje: r.mensaje, cuandoLocal })
          : ({ ok: false, error: 'No se encontró el email del usuario' } as const);

    if (resultado.ok) {
      await supabase
        .from('recordatorios')
        .update({ enviado_en: new Date().toISOString(), ultimo_error: null })
        .eq('id', r.id);
      enviados++;
    } else {
      // Se libera para reintentar en la próxima pasada (hasta 5 intentos).
      await supabase
        .from('recordatorios')
        .update({ intentos: r.intentos + 1, ultimo_error: resultado.error, reclamado_en: null })
        .eq('id', r.id);
      errores.push({ id: r.id, motivo: resultado.error });
    }
  }

  return NextResponse.json({ ok: true, procesados: pendientes?.length ?? 0, enviados, errores });
}
