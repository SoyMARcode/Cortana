'use client';

import { NOMBRE, NOMBRE_HABLADO } from '@/lib/marca';

/**
 * Utilidades de voz (fase 1, gratis) usando la Web Speech API nativa
 * del navegador. No requiere ninguna API key ni servicio externo.
 *
 * Limitación conocida: la calidad y disponibilidad de voces en
 * español depende 100% del navegador/sistema operativo del usuario.
 * Funciona mejor en Chrome/Edge. Si en algún momento se siente muy
 * robótica, la fase 2 sería conectar un proveedor real (ej. ElevenLabs)
 * — eso quedó pausado a propósito, no es prioridad por ahora.
 */

let vocesCache: SpeechSynthesisVoice[] = [];

/** Si el navegador no avisa que cargó las voces, se habla igual con la de por defecto. */
const ESPERA_VOCES_MS = 1500;

/** Chrome corta las lecturas largas a los ~15 s: se lee de a frases cortas. */
const MAX_CARACTERES_TROZO = 180;

/**
 * Las frases que se están leyendo. Chrome a veces descarta (garbage
 * collection) una lectura en curso si nadie la referencia, y se corta.
 */
let enCurso: SpeechSynthesisUtterance[] = [];

let desbloqueada = false;

function cargarVoces(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const voces = window.speechSynthesis.getVoices();
    if (voces.length > 0) {
      vocesCache = voces;
      resolve(voces);
      return;
    }
    // Safari a veces nunca dispara voiceschanged: sin este tope, QIR se
    // quedaba esperando para siempre y no decía nada.
    const tope = setTimeout(() => resolve(window.speechSynthesis.getVoices()), ESPERA_VOCES_MS);
    window.speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        clearTimeout(tope);
        vocesCache = window.speechSynthesis.getVoices();
        resolve(vocesCache);
      },
      { once: true }
    );
  });
}

/**
 * iPhone (y algunos Chrome) solo dejan hablar si la primera lectura empieza
 * con un toque del usuario. La respuesta de QIR llega segundos después del
 * toque, así que se "abre" la voz en el momento del toque con una frase
 * muda. Llamarla en los botones que mandan mensajes o activan la voz.
 */
export function desbloquearVoz() {
  if (desbloqueada || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const muda = new SpeechSynthesisUtterance(' ');
  muda.volume = 0;
  window.speechSynthesis.speak(muda);
  desbloqueada = true;
  // De paso empieza a cargar las voces, así la primera respuesta no espera.
  cargarVoces();
}

/**
 * Emojis (incluidas banderas, tonos de piel y combinaciones) y flechas como
 * ↻: la voz los leía por su nombre ("marca de verificación", "paraguas").
 */
const EMOJIS =
  /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}←-⇿⬀-⯿️‍⃣]/gu;

/** Saca lo que no tiene sentido leer en voz alta: emojis, enlaces, asteriscos, numerales. */
function textoParaLeer(texto: string): string {
  return texto
    .replace(EMOJIS, '')
    .replace(/(\d)\s?°C?/g, '$1 grados')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parte el texto en frases de hasta MAX_CARACTERES_TROZO, sin cortar palabras. */
function enTrozos(texto: string): string[] {
  const frases = texto.match(/[^.!?;\n]+[.!?;]*\s*/g) ?? [texto];
  const trozos: string[] = [];
  let actual = '';
  for (const frase of frases) {
    if ((actual + frase).length > MAX_CARACTERES_TROZO && actual) {
      trozos.push(actual.trim());
      actual = '';
    }
    // Una sola frase muy larga se parte por palabras.
    if (frase.length > MAX_CARACTERES_TROZO) {
      for (const palabra of frase.split(' ')) {
        if ((actual + ' ' + palabra).length > MAX_CARACTERES_TROZO && actual) {
          trozos.push(actual.trim());
          actual = '';
        }
        actual += (actual ? ' ' : '') + palabra;
      }
    } else {
      actual += frase;
    }
  }
  if (actual.trim()) trozos.push(actual.trim());
  return trozos;
}

function elegirVozEnEspanol(voces: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const enEspanol = voces.filter((v) => v.lang.toLowerCase().startsWith('es'));
  // Intenta encontrar una que suene femenina por el nombre (heurística simple,
  // depende de cómo el sistema operativo nombre sus voces).
  const femenina = enEspanol.find((v) => /female|mujer|femenina|monica|paulina|lucia/i.test(v.name));
  return femenina || enEspanol[0] || voces[0];
}

/** Sube con cada lectura nueva o corte: una lectura vieja sabe que la reemplazaron. */
let generacion = 0;

/**
 * Lee el texto en voz alta. La promesa se resuelve al terminar: true si
 * terminó de leer, false si se cortó (otra lectura, detenerVoz) o no se
 * pudo. Manos libres la usa para abrir el micrófono recién cuando QIR
 * deja de hablar, así no se escucha a sí misma.
 */
export async function hablar(texto: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;

  const synth = window.speechSynthesis;
  const mia = ++generacion;
  // Corta cualquier lectura anterior antes de empezar una nueva
  synth.cancel();

  const voces = vocesCache.length > 0 ? vocesCache : await cargarVoces();
  const voz = elegirVozEnEspanol(voces);
  // En pantalla dice "QIR"; en voz alta, "Kir" (si no, lo deletrea).
  const hablado = textoParaLeer(texto).replace(new RegExp(`\\b${NOMBRE}\\b`, 'g'), NOMBRE_HABLADO);
  if (!hablado || mia !== generacion) return false;

  return new Promise<boolean>((resolver) => {
    let resuelta = false;
    let sondeo: ReturnType<typeof setInterval> | undefined;
    const fin = (ok: boolean) => {
      if (resuelta) return;
      resuelta = true;
      clearInterval(sondeo);
      resolver(ok && mia === generacion);
    };

    enCurso = enTrozos(hablado).map((trozo) => {
      const u = new SpeechSynthesisUtterance(trozo);
      if (voz) u.voice = voz;
      u.lang = voz?.lang || 'es-ES';
      u.rate = 1;
      u.onerror = (e) => {
        // "interrupted"/"canceled" son normales: se cortó para leer otra cosa.
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          console.warn('[voz] No se pudo leer en voz alta:', e.error);
        }
        fin(false);
      };
      return u;
    });
    enCurso[enCurso.length - 1].onend = () => fin(true);

    // Chrome pierde lo que se encola justo después de cancel(): se espera un instante.
    setTimeout(() => {
      if (mia !== generacion) return fin(false);
      // Si quedó en pausa (pasa en Chrome al volver de otra pestaña), se reanuda.
      synth.resume();
      for (const u of enCurso) synth.speak(u);
      // Respaldo: algunos navegadores no avisan el final (onend). Se mira
      // cada medio segundo si ya terminó de hablar.
      sondeo = setInterval(() => {
        if (mia !== generacion) fin(false);
        else if (!synth.speaking && !synth.pending) fin(true);
      }, 500);
    }, 60);
  });
}

export function detenerVoz() {
  generacion++;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

// Lo mínimo de la Web Speech API que usamos (TypeScript no la trae tipada).
interface ResultadoVoz {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface EventoResultadoVoz {
  readonly results: { readonly length: number; readonly [i: number]: ResultadoVoz };
}
interface ReconocimientoNativo {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: EventoResultadoVoz) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type ConstructorReconocimiento = new () => ReconocimientoNativo;

export interface Dictado {
  /** Termina de escuchar; lo ya dictado se entrega igual. */
  detener(): void;
  /** Corta sin esperar el último resultado. */
  cancelar(): void;
}

interface OpcionesDictado {
  /** Texto dictado hasta ahora; `final` es true cuando ya no va a cambiar. */
  alTexto: (texto: string, final: boolean) => void;
  /**
   * Explicación lista para mostrar (o null si no hace falta avisar nada) y
   * el código del navegador, ej. "no-speech" cuando no se dijo nada.
   */
  alError: (mensaje: string | null, codigo: string) => void;
  /** Siempre se llama al final, haya salido bien o mal. */
  alTerminar: () => void;
  /**
   * true: escucha hasta que se toque el botón. false: una frase y se apaga
   * solo (manos libres). Por defecto, continuo salvo en Android.
   */
  continuo?: boolean;
}

export function soportaDictado(): boolean {
  return typeof window !== 'undefined' && constructorNativo() !== null;
}

function constructorNativo(): ConstructorReconocimiento | null {
  const w = window as unknown as {
    SpeechRecognition?: ConstructorReconocimiento;
    webkitSpeechRecognition?: ConstructorReconocimiento;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** El español del teléfono (es-CO, es-MX, es-AR...) reconoce mejor los acentos locales. */
function idiomaDictado(): string {
  const idioma = navigator.language || '';
  return idioma.toLowerCase().startsWith('es') ? idioma : 'es-ES';
}

function esAndroid() {
  return /android/i.test(navigator.userAgent);
}

function esIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function mensajeDeError(codigo: string): string | null {
  switch (codigo) {
    case 'aborted':
      return null;
    case 'no-speech':
      return 'No escuché nada. Tocá el micrófono y hablá cerca del teléfono.';
    case 'audio-capture':
      return 'No encontré un micrófono. Revisá que esté conectado y que otra app no lo esté usando.';
    case 'network':
      return 'El dictado necesita internet y no hay conexión. Probá de nuevo o escribí el mensaje.';
    case 'not-allowed':
    case 'service-not-allowed':
      return esIOS()
        ? `El iPhone no dejó usar el micrófono. Revisá Ajustes → Safari → Micrófono, y que el Dictado de Siri esté activado (Ajustes → General → Teclado). Si abriste ${NOMBRE} desde el ícono de inicio y sigue fallando, usá el micrófono del teclado.`
        : 'No hay permiso para usar el micrófono. Habilitalo desde el candado de la barra de direcciones y recargá la página.';
    case 'language-not-supported':
      return 'Tu navegador no reconoce voz en español. Probá con Chrome.';
    default:
      return `El dictado falló (${codigo}). Probá de nuevo o escribí el mensaje.`;
  }
}

/**
 * Dictado por voz: va escribiendo lo que se dice mientras se habla.
 * Devuelve null si el navegador no lo soporta (ej. Firefox) o no pudo arrancar.
 */
export function iniciarDictado({
  alTexto,
  alError,
  alTerminar,
  continuo,
}: OpcionesDictado): Dictado | null {
  if (typeof window === 'undefined') return null;
  const Reconocimiento = constructorNativo();
  if (!Reconocimiento) return null;

  // Si QIR está leyendo en voz alta, el micrófono se escucharía a sí mismo.
  detenerVoz();

  const rec = new Reconocimiento();
  rec.lang = idiomaDictado();
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  // En computadora sigue escuchando entre pausas hasta que se toque el botón.
  // Chrome de Android repite frases en modo continuo, así que ahí escucha una
  // frase por vez y se apaga solo al terminar de hablar.
  rec.continuous = continuo ?? !esAndroid();

  let texto = '';
  let terminado = false;

  rec.onresult = (e) => {
    let finales = '';
    let parcial = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finales += r[0].transcript;
      else parcial += r[0].transcript;
    }
    texto = (finales + parcial).replace(/\s+/g, ' ').trim();
    alTexto(texto, parcial === '');
  };

  rec.onerror = (e) => alError(mensajeDeError(e.error), e.error);

  rec.onend = () => {
    if (terminado) return;
    terminado = true;
    if (texto) alTexto(texto, true);
    alTerminar();
  };

  try {
    rec.start();
  } catch (e) {
    console.error('[voz] No se pudo iniciar el dictado:', e);
    alError('No se pudo encender el micrófono. Probá de nuevo en unos segundos.', 'start');
    return null;
  }

  return {
    detener: () => rec.stop(),
    cancelar: () => {
      rec.onresult = null;
      texto = '';
      rec.abort();
    },
  };
}
