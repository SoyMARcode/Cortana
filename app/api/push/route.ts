import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { enviarPush, pushDisponible } from '@/lib/push';

/**
 * Solo servicios push reales (Chrome/Edge/Android, Firefox, Safari/iOS,
 * Windows). El servidor hace peticiones a este endpoint: aceptar cualquier
 * URL permitiría usarlo para llegar a sitios arbitrarios.
 */
const SERVICIOS_PUSH = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

function esServicioPush(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && SERVICIOS_PUSH.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

const suscripcionSchema = z.object({
  endpoint: z.url().refine(esServicioPush, 'Servicio push no reconocido'),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  dispositivo: z.string().max(200).optional(),
});

async function usuarioActual() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Activa los avisos en este dispositivo. */
export async function POST(req: Request) {
  const user = await usuarioActual();
  if (!user) return new NextResponse('No autorizado', { status: 401 });

  const datos = suscripcionSchema.safeParse(await req.json());
  if (!datos.success) return new NextResponse('Suscripción inválida', { status: 400 });
  const { endpoint, keys, dispositivo } = datos.data;

  // Con el cliente admin: si el dispositivo estaba registrado con otra cuenta
  // (cerró sesión y entró otra persona), pasa a la cuenta actual.
  const { error } = await createAdminClient()
    .from('push_suscripciones')
    .upsert(
      { user_id: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, dispositivo },
      { onConflict: 'endpoint' }
    );

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** Desactiva los avisos en este dispositivo. */
export async function DELETE(req: Request) {
  const user = await usuarioActual();
  if (!user) return new NextResponse('No autorizado', { status: 401 });

  const { endpoint } = (await req.json()) as { endpoint?: string };
  if (!endpoint) return new NextResponse('Falta el endpoint', { status: 400 });

  await createAdminClient()
    .from('push_suscripciones')
    .delete()
    .eq('endpoint', endpoint)
    .eq('user_id', user.id);
  return NextResponse.json({ ok: true });
}

/** Manda una notificación de prueba a todos los dispositivos del usuario. */
export async function PUT() {
  const user = await usuarioActual();
  if (!user) return new NextResponse('No autorizado', { status: 401 });

  if (!pushDisponible()) {
    return NextResponse.json({
      ok: false,
      motivo: 'faltan las claves VAPID en el servidor (variables de entorno de Vercel).',
    });
  }

  const { data: dispositivos, error } = await createAdminClient()
    .from('push_suscripciones')
    .select('id')
    .eq('user_id', user.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!dispositivos.length) {
    return NextResponse.json({
      ok: false,
      motivo: 'no hay ningún dispositivo activado en tu cuenta. Tocá "Activar avisos".',
    });
  }

  const entregados = await enviarPush(user.id, {
    titulo: 'Cortana',
    cuerpo: 'Así te van a llegar los avisos. Todo listo.',
    tag: 'prueba',
  });
  return NextResponse.json({
    ok: entregados > 0,
    entregados,
    motivo:
      entregados > 0
        ? undefined
        : 'el servicio de notificaciones rechazó el envío. Desactivá y volvé a activar los avisos en este dispositivo.',
  });
}
