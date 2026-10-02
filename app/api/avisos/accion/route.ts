import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server';
import { firmaValida } from '@/lib/firma-aviso';

/** Cuánto se pospone un aviso desde el botón de la notificación. */
const MINUTOS_POSPONER = 10;

const pedidoSchema = z.object({
  tipo: z.enum(['recordatorio', 'tarea']),
  id: z.uuid(),
  firma: z.string().min(10).max(100),
  accion: z.enum(['posponer', 'hecha', 'listo']),
});

/**
 * Botones de las notificaciones (ver public/sw.js). No usa la sesión: la
 * firma de lib/firma-aviso.ts prueba que el aviso es auténtico.
 * - posponer: el mismo aviso vuelve en 10 minutos.
 * - hecha: completa la tarea (la del aviso o la vinculada al recordatorio).
 * - listo: solo cierra la notificación.
 */
export async function POST(req: Request) {
  const pedido = pedidoSchema.safeParse(await req.json().catch(() => null));
  if (!pedido.success) return NextResponse.json({ error: 'Pedido inválido' }, { status: 400 });
  const { tipo, id, firma, accion } = pedido.data;
  if (!firmaValida(tipo, id, firma)) {
    return NextResponse.json({ error: 'Firma inválida' }, { status: 403 });
  }
  if (accion === 'listo') return NextResponse.json({ ok: true });

  const supabase = createAdminClient();

  if (tipo === 'recordatorio') {
    const { data: r, error } = await supabase
      .from('recordatorios')
      .select('user_id, tarea_id, mensaje, zona_horaria')
      .eq('id', id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!r) return NextResponse.json({ error: 'El aviso ya no existe' }, { status: 404 });

    if (accion === 'posponer') {
      // Un aviso nuevo y suelto: si el original se repite, sigue su curso.
      const { error: e } = await supabase.from('recordatorios').insert({
        user_id: r.user_id,
        tarea_id: r.tarea_id,
        mensaje: r.mensaje,
        zona_horaria: r.zona_horaria,
        enviar_en: new Date(Date.now() + MINUTOS_POSPONER * 60_000).toISOString(),
      });
      if (e) return NextResponse.json({ error: e.message }, { status: 500 });
      return NextResponse.json({ ok: true, minutos: MINUTOS_POSPONER });
    }

    if (!r.tarea_id) return NextResponse.json({ ok: true });
    const { error: e } = await supabase
      .from('tareas')
      .update({ completada: true })
      .eq('id', r.tarea_id)
      .eq('user_id', r.user_id);
    if (e) return NextResponse.json({ error: e.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // tipo === 'tarea': el aviso de vencimiento solo ofrece "Marcar hecha".
  if (accion !== 'hecha') return NextResponse.json({ error: 'Acción no disponible' }, { status: 400 });
  const { error } = await supabase.from('tareas').update({ completada: true }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
