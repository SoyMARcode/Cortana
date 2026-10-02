import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { URL_APP } from '@/lib/marca';

/**
 * Google Calendar con permiso de escritura (OAuth). La persona conecta su
 * cuenta una vez desde /api/google/conectar; el permiso queda cifrado en
 * google_cuentas y QIR crea, mueve y borra eventos con la API de Google.
 *
 * Variables de entorno: GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (Google
 * Cloud → APIs y servicios → Credenciales). Ver docs/MEJORAS.md, parte 5.
 */

const ALCANCES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
export const REDIRECCION_GOOGLE = `${URL_APP}/api/google/callback`;
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Vale el permiso de acceso: se renueva un minuto antes de vencer. */
const MARGEN_MS = 60_000;

/**
 * Las credenciales sin espacios ni saltos de línea en los bordes: al
 * pegarlas en Vercel es fácil que se cuele un Enter, y Google rechaza el ID
 * con "invalid_client".
 */
const idCliente = () => (process.env.GOOGLE_CLIENT_ID ?? '').trim();
const secretoCliente = () => (process.env.GOOGLE_CLIENT_SECRET ?? '').trim();

export function googleConfigurado(): boolean {
  return Boolean(idCliente() && secretoCliente());
}

// ---------- Cifrado de los permisos (AES-256-GCM) ----------

function clave(): Buffer {
  const base = process.env.GOOGLE_TOKEN_KEY || process.env.CRON_SECRET;
  if (!base) throw new Error('Falta CRON_SECRET para cifrar los permisos de Google');
  return createHash('sha256').update(`qir-google:${base}`).digest();
}

function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave(), iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), datos].map((b) => b.toString('base64url')).join('.');
}

function descifrar(cifrado: string): string {
  const [iv, etiqueta, datos] = cifrado.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', clave(), iv);
  d.setAuthTag(etiqueta);
  return Buffer.concat([d.update(datos), d.final()]).toString('utf8');
}

// ---------- Estado firmado del OAuth (quién está conectando) ----------

function firmar(texto: string): string {
  return createHmac('sha256', clave()).update(texto).digest('base64url');
}

/** state = userId.vencimiento.firma: dura 10 minutos y no se puede falsificar. */
export function crearEstado(userId: string): string {
  const cuerpo = `${userId}.${Date.now() + 10 * 60_000}`;
  return `${cuerpo}.${firmar(cuerpo)}`;
}

export function leerEstado(estado: string | null): string | null {
  const partes = estado?.split('.') ?? [];
  if (partes.length !== 3) return null;
  const [userId, vence, firma] = partes;
  const esperada = Buffer.from(firmar(`${userId}.${vence}`));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  if (Number(vence) < Date.now()) return null;
  return userId;
}

export function enlaceDeAutorizacion(userId: string): string {
  const p = new URLSearchParams({
    client_id: idCliente(),
    redirect_uri: REDIRECCION_GOOGLE,
    response_type: 'code',
    scope: ALCANCES.join(' '),
    // offline + consent: Google entrega un refresh token, para seguir sin volver a pedir permiso.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: crearEstado(userId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

// ---------- Permisos ----------

type RespuestaToken = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

async function pedirToken(cuerpo: Record<string, string>): Promise<RespuestaToken> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: idCliente(),
      client_secret: secretoCliente(),
      ...cuerpo,
    }),
  });
  const datos = (await res.json()) as RespuestaToken;
  if (!res.ok) throw new Error(datos.error_description || datos.error || `Google respondió ${res.status}`);
  return datos;
}

/** Cambia el código del callback por los permisos y los guarda cifrados. */
export async function guardarConexion(userId: string, codigo: string): Promise<string | null> {
  const t = await pedirToken({ code: codigo, grant_type: 'authorization_code', redirect_uri: REDIRECCION_GOOGLE });
  if (!t.refresh_token) throw new Error('Google no entregó un permiso permanente. Probá conectar de nuevo.');
  // El id_token ya viene verificado por Google en este canal directo: solo se lee el email.
  const email = t.id_token
    ? (JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email as string)
    : null;
  const { error } = await createAdminClient()
    .from('google_cuentas')
    .upsert({
      user_id: userId,
      email,
      refresh_token_cifrado: cifrar(t.refresh_token),
      access_token_cifrado: cifrar(t.access_token),
      expira_en: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(error.message);
  return email;
}

/** Un permiso de acceso vigente, renovado si hace falta. null si la persona no conectó Google. */
async function accesoVigente(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('google_cuentas')
    .select('refresh_token_cifrado, access_token_cifrado, expira_en')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return null;
  if (data.access_token_cifrado && data.expira_en && Date.parse(data.expira_en) - MARGEN_MS > Date.now()) {
    return descifrar(data.access_token_cifrado);
  }
  try {
    const t = await pedirToken({ refresh_token: descifrar(data.refresh_token_cifrado), grant_type: 'refresh_token' });
    await admin
      .from('google_cuentas')
      .update({
        access_token_cifrado: cifrar(t.access_token),
        expira_en: new Date(Date.now() + t.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
    return t.access_token;
  } catch (e) {
    // invalid_grant = la persona quitó el permiso desde su cuenta de Google.
    if (e instanceof Error && /invalid_grant|expired|revoked/i.test(e.message)) {
      await admin.from('google_cuentas').delete().eq('user_id', userId);
      throw new Error('Se perdió el permiso de Google Calendar. Hay que volver a conectarlo.');
    }
    throw e;
  }
}

export async function googleConectado(userId: string): Promise<{ email: string | null } | null> {
  const { data } = await createAdminClient()
    .from('google_cuentas')
    .select('email')
    .eq('user_id', userId)
    .maybeSingle();
  return data ? { email: data.email } : null;
}

export async function desconectarGoogle(userId: string): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from('google_cuentas').select('refresh_token_cifrado').eq('user_id', userId).maybeSingle();
  if (data) {
    // Le avisa a Google que ya no se usa (si falla, igual se borra acá).
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: descifrar(data.refresh_token_cifrado) }),
    }).catch(() => {});
  }
  await admin.from('google_cuentas').delete().eq('user_id', userId);
}

// ---------- Calendario ----------

export type EventoGoogle = {
  id: string;
  titulo: string;
  inicio: string;
  fin: string;
  todo_el_dia: boolean;
  lugar?: string;
  enlace?: string;
  invitados?: string[];
};

type EventoApi = {
  id: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { email: string }[];
};

function aEvento(e: EventoApi): EventoGoogle {
  return {
    id: e.id,
    titulo: e.summary || '(sin título)',
    inicio: e.start.dateTime ?? e.start.date ?? '',
    fin: e.end.dateTime ?? e.end.date ?? '',
    todo_el_dia: !e.start.dateTime,
    lugar: e.location,
    enlace: e.htmlLink,
    invitados: e.attendees?.map((a) => a.email),
  };
}

async function llamar<T>(userId: string, ruta: string, init: RequestInit = {}): Promise<T> {
  const acceso = await accesoVigente(userId);
  if (!acceso) throw new Error('Google Calendar no está conectado.');
  const res = await fetch(`${API}${ruta}`, {
    ...init,
    headers: { Authorization: `Bearer ${acceso}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return undefined as T;
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) {
    const motivo = (datos as { error?: { message?: string } }).error?.message;
    throw new Error(res.status === 404 ? 'Ese evento no existe en tu calendario.' : motivo || `Google respondió ${res.status}`);
  }
  return datos as T;
}

/** Momento de inicio/fin para la API: con hora (en la zona del usuario) o de día completo. */
export function momento(valor: string, zona: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(valor)
    ? { date: valor }
    : { dateTime: valor.length === 16 ? `${valor}:00` : valor, timeZone: zona };
}

export async function listarEventosGoogle(
  userId: string,
  desde: Date,
  hasta: Date,
  texto?: string
): Promise<EventoGoogle[]> {
  const p = new URLSearchParams({
    timeMin: desde.toISOString(),
    timeMax: hasta.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  if (texto) p.set('q', texto);
  const datos = await llamar<{ items?: EventoApi[] }>(userId, `?${p}`);
  return (datos.items ?? []).map(aEvento);
}

export async function leerEventoGoogle(userId: string, id: string): Promise<EventoGoogle> {
  return aEvento(await llamar<EventoApi>(userId, `/${encodeURIComponent(id)}`));
}

export async function crearEventoGoogle(
  userId: string,
  e: { titulo: string; inicio: object; fin: object; lugar?: string; descripcion?: string; invitados?: string[] }
): Promise<EventoGoogle> {
  const cuerpo = {
    summary: e.titulo,
    location: e.lugar,
    description: e.descripcion,
    start: e.inicio,
    end: e.fin,
    attendees: e.invitados?.map((email) => ({ email })),
  };
  // sendUpdates=all: Google les manda la invitación a los invitados.
  const datos = await llamar<EventoApi>(userId, e.invitados?.length ? '?sendUpdates=all' : '', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
  return aEvento(datos);
}

export async function modificarEventoGoogle(
  userId: string,
  id: string,
  cambios: { titulo?: string; inicio?: object; fin?: object; lugar?: string }
): Promise<EventoGoogle> {
  const cuerpo: Record<string, unknown> = {};
  if (cambios.titulo) cuerpo.summary = cambios.titulo;
  if (cambios.lugar !== undefined) cuerpo.location = cambios.lugar;
  if (cambios.inicio) cuerpo.start = cambios.inicio;
  if (cambios.fin) cuerpo.end = cambios.fin;
  // A los invitados que ya tenía les llega el cambio de horario.
  const datos = await llamar<EventoApi>(userId, `/${encodeURIComponent(id)}?sendUpdates=all`, {
    method: 'PATCH',
    body: JSON.stringify(cuerpo),
  });
  return aEvento(datos);
}

export async function borrarEventoGoogle(userId: string, id: string): Promise<void> {
  await llamar<void>(userId, `/${encodeURIComponent(id)}?sendUpdates=all`, { method: 'DELETE' });
}
