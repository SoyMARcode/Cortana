'use client';

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
  const utterance = new SpeechSynthesisUtterance(texto);
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

/**
 * Reconocimiento de voz para dictar en vez de escribir.
 * Devuelve null si el navegador no lo soporta (ej. Firefox).
 */
export function crearReconocimientoDeVoz(onResultado: (texto: string) => void): any | null {
  if (typeof window === 'undefined') return null;

  const SpeechRecognitionCtor =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) return null;

  const recognition: any = new SpeechRecognitionCtor();
  recognition.lang = 'es-ES';
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (event: any) => {
    const texto = event.results[0][0].transcript;
    onResultado(texto);
  };

  return recognition;
}
