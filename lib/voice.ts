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

function cargarVoces(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const voces = window.speechSynthesis.getVoices();
    if (voces.length > 0) {
      vocesCache = voces;
      resolve(voces);
      return;
    }
    window.speechSynthesis.onvoiceschanged = () => {
      vocesCache = window.speechSynthesis.getVoices();
      resolve(vocesCache);
    };
  });
}

function elegirVozEnEspanol(voces: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const enEspanol = voces.filter((v) => v.lang.toLowerCase().startsWith('es'));
  // Intenta encontrar una que suene femenina por el nombre (heurística simple,
  // depende de cómo el sistema operativo nombre sus voces).
  const femenina = enEspanol.find((v) => /female|mujer|femenina|monica|paulina|lucia/i.test(v.name));
  return femenina || enEspanol[0] || voces[0];
}

export async function hablar(texto: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

  // Corta cualquier lectura anterior antes de empezar una nueva
  window.speechSynthesis.cancel();

  const voces = vocesCache.length > 0 ? vocesCache : await cargarVoces();
  // En pantalla dice "QIR"; en voz alta, "Kir" (si no, lo deletrea).
  const hablado = texto.replace(new RegExp(`\\b${NOMBRE}\\b`, 'g'), NOMBRE_HABLADO);
  const utterance = new SpeechSynthesisUtterance(hablado);
  const voz = elegirVozEnEspanol(voces);
  if (voz) utterance.voice = voz;
  utterance.lang = voz?.lang || 'es-ES';
  utterance.rate = 1;

  window.speechSynthesis.speak(utterance);
}

export function detenerVoz() {
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
  /** Explicación lista para mostrar, o null si no hace falta avisar nada. */
  alError: (mensaje: string | null) => void;
  /** Siempre se llama al final, haya salido bien o mal. */
  alTerminar: () => void;
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
export function iniciarDictado({ alTexto, alError, alTerminar }: OpcionesDictado): Dictado | null {
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
  rec.continuous = !esAndroid();

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

  rec.onerror = (e) => alError(mensajeDeError(e.error));

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
    alError('No se pudo encender el micrófono. Probá de nuevo en unos segundos.');
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
