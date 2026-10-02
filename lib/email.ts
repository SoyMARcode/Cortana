import { Resend } from 'resend';
import { LOGO_ALTO, LOGO_ANCHO, LOGO_PNG_BASE64 } from '@/lib/email-logo';
import { NOMBRE } from '@/lib/marca';

const resend = new Resend(process.env.RESEND_API_KEY);

const REMITENTE = process.env.RESEND_FROM_EMAIL || `${NOMBRE} <onboarding@resend.dev>`;

const LOGO_CID = 'logo-qir';

// Misma paleta que la app (app/globals.css). Los correos van con estilos
// en línea y tablas porque Gmail/Outlook ignoran casi todo el CSS moderno.
const TINTA = '#21242B';
const TINTA_SUAVE = '#5B6070';
const LINEA = '#DCDFE5';
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

/** Archivo que viaja adjunto en un correo. */
export type Adjunto = { nombre: string; contenido: Buffer; tipo?: string };

export type ResultadoEnvio =
  | { ok: true; id: string }
  | { ok: false; error: string };

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convierte texto plano en HTML seguro, respetando saltos de línea. */
function textoAHtml(texto: string): string {
  return texto
    .split(/\n{2,}/)
    .map(
      (parrafo) =>
        `<p style="margin: 0 0 14px;">${escaparHtml(parrafo).replace(/\n/g, '<br>')}</p>`
    )
    .join('');
}

/** "2026-09-30" -> "miércoles 30 de septiembre" (sin corrimiento por zona horaria). */
export function fechaLegible(fechaISO: string): string {
  return new Intl.DateTimeFormat('es', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(fechaISO + 'T00:00:00Z'));
}

/**
 * Plantilla "membrete": el logo arriba como el encabezado de una
 * carta, el cuerpo, y una línea de pie. `cuerpoHtml` ya debe venir escapado.
 */
function plantilla(cuerpoHtml: string, pie: string): string {
  return `<!doctype html>
<html lang="es">
<body style="margin: 0; padding: 0; background: #FFFFFF;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #FFFFFF;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; font-family: ${SANS}; font-size: 15px; line-height: 1.6; color: ${TINTA};">
          <tr>
            <td style="padding-bottom: 16px; border-bottom: 1px solid ${LINEA};">
              <img src="cid:${LOGO_CID}" width="${LOGO_ANCHO}" height="${LOGO_ALTO}" alt="${NOMBRE}" style="display: block; border: 0; font-family: ${SANS}; font-size: 20px; font-weight: bold; color: ${TINTA};">
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 0 8px;">${cuerpoHtml}</td>
          </tr>
          <tr>
            <td style="padding-top: 14px; border-top: 1px solid ${LINEA}; font-size: 12px; color: ${TINTA_SUAVE};">
              ${pie}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * IMPORTANTE: el SDK de Resend NO lanza excepciones cuando falla; devuelve
 * { data, error }. Por eso acá se revisa `error` explícitamente. Si no, un
 * correo rechazado pasaría por "enviado" sin que nadie se entere.
 */
async function enviar(params: {
  destinatario: string;
  asunto: string;
  html: string;
  responderA?: string;
  adjuntos?: Adjunto[];
}): Promise<ResultadoEnvio> {
  try {
    const { data, error } = await resend.emails.send({
      from: REMITENTE,
      to: params.destinatario,
      subject: params.asunto,
      html: params.html,
      replyTo: params.responderA,
      attachments: [
        {
          content: Buffer.from(LOGO_PNG_BASE64, 'base64'),
          filename: 'qir.png',
          contentType: 'image/png',
          contentId: LOGO_CID,
        },
        ...(params.adjuntos ?? []).map((a) => ({
          content: a.contenido,
          filename: a.nombre,
          contentType: a.tipo,
        })),
      ],
    });

    if (error) {
      console.error('[email] Resend rechazó el envío:', error);
      return { ok: false, error: `${error.name}: ${error.message}` };
    }
    return { ok: true, id: data?.id ?? '' };
  } catch (e) {
    console.error('[email] Error inesperado enviando:', e);
    return { ok: false, error: e instanceof Error ? e.message : 'Error desconocido' };
  }
}

export function enviarRecordatorio(params: {
  destinatario: string;
  titulo: string;
  fechaLimite: string;
  diasRestantes: number;
}): Promise<ResultadoEnvio> {
  const { destinatario, titulo, fechaLimite, diasRestantes } = params;
  const tituloSeguro = escaparHtml(titulo);

  const asunto =
    diasRestantes === 0
      ? `⏰ "${titulo}" vence HOY`
      : diasRestantes === 1
        ? `⏰ "${titulo}" vence MAÑANA`
        : `⏰ Faltan ${diasRestantes} días para "${titulo}"`;

  const cierre =
    diasRestantes === 0
      ? 'Es hoy. Todavía estás a tiempo.'
      : diasRestantes === 1
        ? 'Es mañana. No te olvides.'
        : `Faltan ${diasRestantes} días.`;

  return enviar({
    destinatario,
    asunto,
    html: plantilla(
      `<p style="margin: 0 0 14px;">Tu tarea <strong>${tituloSeguro}</strong> vence el <strong>${escaparHtml(fechaLegible(fechaLimite))}</strong>.</p>
       <p style="margin: 0 0 14px;">${cierre}</p>`,
      `Recordatorio automático de ${NOMBRE}.`
    ),
  });
}

/** Aviso de un recordatorio con hora ("recordame a las 6:45"). */
export function enviarAvisoConHora(params: {
  destinatario: string;
  mensaje: string;
  cuandoLocal: string;
}): Promise<ResultadoEnvio> {
  return enviar({
    destinatario: params.destinatario,
    asunto: `⏰ ${params.mensaje}`,
    html: plantilla(
      `<p style="margin: 0 0 14px;">Me pediste que te lo recordara:</p>
       <p style="margin: 0 0 14px; font-family: ${SERIF}; font-size: 20px; line-height: 1.4;">${escaparHtml(params.mensaje)}</p>
       <p style="margin: 0 0 14px; color: ${TINTA_SUAVE};">Programado para el ${escaparHtml(params.cuandoLocal)}.</p>`,
      `Recordatorio programado en ${NOMBRE}.`
    ),
  });
}

/**
 * Correo libre: información que el usuario pidió por chat. Puede ir a su
 * propio email o a otras personas; las respuestas le llegan al usuario.
 */
export function enviarCorreoLibre(params: {
  destinatario: string;
  asunto: string;
  contenido: string;
  remitenteHumano: string;
  adjuntos?: Adjunto[];
}): Promise<ResultadoEnvio> {
  const esParaSiMismo =
    params.destinatario.toLowerCase() === params.remitenteHumano.toLowerCase();
  const pie = esParaSiMismo
    ? `Enviado por ${NOMBRE} a pedido tuyo.`
    : `Enviado por ${NOMBRE} en nombre de ${escaparHtml(params.remitenteHumano)}. Si respondés, tu respuesta le llega a esa persona.`;

  return enviar({
    destinatario: params.destinatario,
    asunto: params.asunto,
    responderA: esParaSiMismo ? undefined : params.remitenteHumano,
    html: plantilla(textoAHtml(params.contenido), pie),
    adjuntos: params.adjuntos,
  });
}

/** Resumen semanal automático (ver lib/resumen.ts). */
export function enviarResumenSemanal(params: {
  destinatario: string;
  contenido: string;
}): Promise<ResultadoEnvio> {
  return enviar({
    destinatario: params.destinatario,
    asunto: `Tu semana con ${NOMBRE}`,
    html: plantilla(
      textoAHtml(params.contenido),
      `Resumen automático de ${NOMBRE}. Para cambiar el día o dejar de recibirlo, pedíselo en el chat.`
    ),
  });
}
