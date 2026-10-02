import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Los botones de las notificaciones ("Posponer", "Marcar hecha") llaman a
 * /api/avisos/accion desde el service worker, que puede no tener una sesión
 * válida. Por eso cada aviso viaja con una firma de su tipo + id: solo el
 * servidor la puede generar, así que nadie puede tocar avisos ajenos
 * adivinando ids. Se firma con CRON_SECRET, que ya es secreto del servidor.
 */

export type TipoAviso = 'recordatorio' | 'tarea';

function calcular(tipo: TipoAviso, id: string): string {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) throw new Error('CRON_SECRET no está configurado');
  return createHmac('sha256', secreto).update(`${tipo}:${id}`).digest('base64url');
}

export function firmarAviso(tipo: TipoAviso, id: string): string {
  return calcular(tipo, id);
}

export function firmaValida(tipo: TipoAviso, id: string, firma: string): boolean {
  const esperada = Buffer.from(calcular(tipo, id));
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}
