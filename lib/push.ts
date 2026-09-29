import webpush from 'web-push';
import { createAdminClient } from '@/lib/supabase/server';

export type AvisoPush = {
  titulo: string;
  cuerpo: string;
  /** A dónde lleva al tocar la notificación. */
  url?: string;
  /** Avisos con el mismo tag se reemplazan en vez de apilarse. */
  tag?: string;
};

let configurado = false;

/** false si faltan las claves VAPID: en ese caso los avisos van solo por correo. */
export function pushDisponible(): boolean {
  const publica = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privada = process.env.VAPID_PRIVATE_KEY;
  if (!publica || !privada) return false;
  if (!configurado) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:cortana@example.com',
      publica,
      privada
    );
    configurado = true;
  }
  return true;
}

/**
 * Manda el aviso a todos los dispositivos activados del usuario y devuelve
 * a cuántos llegó. Borra las suscripciones que el navegador ya dio de baja
 * (404/410), así la tabla no acumula dispositivos muertos.
 */
export async function enviarPush(userId: string, aviso: AvisoPush): Promise<number> {
  if (!pushDisponible()) return 0;

  const supabase = createAdminClient();
  const { data: suscripciones } = await supabase
    .from('push_suscripciones')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (!suscripciones?.length) return 0;

  const resultados = await Promise.all(
    suscripciones.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(aviso),
          { TTL: 60 * 60 * 12, urgency: 'high' }
        );
        return true;
      } catch (e) {
        const codigo = (e as { statusCode?: number }).statusCode;
        if (codigo === 404 || codigo === 410) {
          await supabase.from('push_suscripciones').delete().eq('id', s.id);
        } else {
          console.error('[push] Falló el envío a un dispositivo:', codigo, e);
        }
        return false;
      }
    })
  );

  return resultados.filter(Boolean).length;
}
