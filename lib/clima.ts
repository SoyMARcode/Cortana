/**
 * Clima con Open-Meteo (https://open-meteo.com): gratis, sin clave y sin
 * registrarse. Se usa desde el chat (consultar_clima) y desde el aviso de
 * lluvia de las mañanas (app/api/cron/proactivo).
 */

/** Desde esta probabilidad de lluvia (%) QIR sugiere llevar paraguas. */
export const UMBRAL_PARAGUAS = 50;

const DESCRIPCIONES: Record<number, string> = {
  0: 'despejado',
  1: 'mayormente despejado',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'niebla',
  48: 'niebla con escarcha',
  51: 'llovizna débil',
  53: 'llovizna',
  55: 'llovizna intensa',
  56: 'llovizna helada',
  57: 'llovizna helada intensa',
  61: 'lluvia débil',
  63: 'lluvia',
  65: 'lluvia fuerte',
  66: 'lluvia helada',
  67: 'lluvia helada fuerte',
  71: 'nevada débil',
  73: 'nevada',
  75: 'nevada fuerte',
  77: 'granizo fino',
  80: 'chaparrones débiles',
  81: 'chaparrones',
  82: 'chaparrones violentos',
  85: 'chaparrones de nieve',
  86: 'chaparrones de nieve fuertes',
  95: 'tormenta',
  96: 'tormenta con granizo',
  99: 'tormenta fuerte con granizo',
};

export type Lugar = { nombre: string; latitud: number; longitud: number };

export type DiaClima = {
  fecha: string;
  descripcion: string;
  minima: number;
  maxima: number;
  prob_lluvia: number;
  lluvia_mm: number;
  llevar_paraguas: boolean;
};

export type Clima = {
  lugar: string;
  ahora: { temperatura: number; sensacion: number; descripcion: string; viento_kmh: number };
  dias: DiaClima[];
};

async function pedirJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!res.ok) throw new Error(`El servicio del clima respondió ${res.status}`);
  return res.json();
}

/** "Medellín" -> coordenadas. null si no existe. */
export async function buscarLugar(nombre: string): Promise<Lugar | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=es&name=${encodeURIComponent(nombre)}`;
  const datos = (await pedirJson(url)) as {
    results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[];
  };
  const r = datos.results?.[0];
  if (!r) return null;
  return {
    nombre: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    latitud: r.latitude,
    longitud: r.longitude,
  };
}

/** Clima actual y pronóstico de `dias` días (1 a 7), en la hora local del lugar. */
export async function pronostico(lugar: Lugar, dias = 1): Promise<Clima> {
  const params = new URLSearchParams({
    latitude: String(lugar.latitud),
    longitude: String(lugar.longitud),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
    timezone: 'auto',
    forecast_days: String(Math.min(Math.max(dias, 1), 7)),
  });
  const d = (await pedirJson(`https://api.open-meteo.com/v1/forecast?${params}`)) as {
    current: {
      temperature_2m: number;
      apparent_temperature: number;
      weather_code: number;
      wind_speed_10m: number;
    };
    daily: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: (number | null)[];
      precipitation_sum: (number | null)[];
    };
  };

  return {
    lugar: lugar.nombre,
    ahora: {
      temperatura: Math.round(d.current.temperature_2m),
      sensacion: Math.round(d.current.apparent_temperature),
      descripcion: DESCRIPCIONES[d.current.weather_code] ?? 'sin datos',
      viento_kmh: Math.round(d.current.wind_speed_10m),
    },
    dias: d.daily.time.map((fecha, i) => {
      const prob = d.daily.precipitation_probability_max[i] ?? 0;
      const mm = d.daily.precipitation_sum[i] ?? 0;
      return {
        fecha,
        descripcion: DESCRIPCIONES[d.daily.weather_code[i]] ?? 'sin datos',
        minima: Math.round(d.daily.temperature_2m_min[i]),
        maxima: Math.round(d.daily.temperature_2m_max[i]),
        prob_lluvia: prob,
        lluvia_mm: Math.round(mm * 10) / 10,
        llevar_paraguas: prob >= UMBRAL_PARAGUAS || mm >= 1,
      };
    }),
  };
}

/**
 * Coordenadas -> "Palermo, Buenos Aires, Argentina", con OpenStreetMap
 * (Nominatim). Se llama solo cuando el usuario actualiza su ubicación.
 */
export async function nombrarLugar(latitud: number, longitud: number) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&accept-language=es&lat=${latitud}&lon=${longitud}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    // Nominatim exige identificar la aplicación.
    headers: { 'User-Agent': 'QIR-asistente/1.0 (https://elqir.com)' },
  });
  if (!res.ok) return null;
  const d = (await res.json()) as {
    address?: Record<string, string | undefined>;
  };
  const a = d.address ?? {};
  const ciudad = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county;
  const barrio = a.suburb ?? a.neighbourhood ?? a.city_district;
  return {
    lugar: [barrio, ciudad, a.country].filter(Boolean).join(', ') || null,
    ciudad: ciudad ?? null,
    region: a.state ?? null,
    pais: a.country_code?.toUpperCase() ?? null,
  };
}
