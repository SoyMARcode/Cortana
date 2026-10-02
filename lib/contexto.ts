import type { SupabaseClient } from '@supabase/supabase-js';
import { horaEnPunto } from '@/lib/zona-horaria';

export type Ajustes = {
  zona_horaria: string;
  latitud: number | null;
  longitud: number | null;
  lugar: string | null;
  ciudad: string | null;
  region: string | null;
  pais: string | null;
  ubicacion_actualizada: string | null;
  resumen_semanal: boolean;
  resumen_dia: number;
  resumen_hora: number;
  aviso_lluvia: boolean;
  calendario_ics: string | null;
};

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Tope de contactos que se le pasan al modelo en cada turno. */
const MAX_CONTACTOS = 60;

/**
 * Lo que QIR sabe de la persona antes de que hable: preferencias guardadas,
 * contactos con apodos, ubicación y ajustes. Va como segundo bloque de
 * instrucciones, después de la personalidad (que queda cacheada aparte).
 * También guarda la zona horaria actual para los avisos automáticos.
 */
export async function cargarContexto(
  supabase: SupabaseClient,
  userId: string,
  zonaHoraria: string
): Promise<{ texto: string; ajustes: Ajustes | null }> {
  const [ajustes, preferencias, contactos] = await Promise.all([
    supabase
      .from('ajustes')
      .upsert({ user_id: userId, zona_horaria: zonaHoraria }, { onConflict: 'user_id' })
      .select('*')
      .single(),
    supabase.from('preferencias').select('id, texto').eq('user_id', userId).order('created_at'),
    supabase
      .from('contactos')
      .select('nombre, email, apodos')
      .eq('user_id', userId)
      .order('nombre')
      .limit(MAX_CONTACTOS),
  ]);

  const a = (ajustes.data as Ajustes | null) ?? null;
  const lineas: string[] = ['## Lo que ya sabés de esta persona'];

  const prefs = preferencias.data ?? [];
  lineas.push(
    prefs.length
      ? `Preferencias guardadas (respetalas sin que te las repitan):\n${prefs
          .map((p) => `- [${p.id}] ${p.texto}`)
          .join('\n')}`
      : 'Preferencias guardadas: ninguna todavía.'
  );

  const lista = contactos.data ?? [];
  lineas.push(
    lista.length
      ? `Contactos:\n${lista
          .map(
            (c) =>
              `- ${c.nombre} <${c.email}>${c.apodos?.length ? ` (también: ${c.apodos.join(', ')})` : ''}`
          )
          .join('\n')}`
      : 'Contactos: ninguno todavía.'
  );

  if (a?.lugar && a.ubicacion_actualizada) {
    const horas = Math.round((Date.now() - Date.parse(a.ubicacion_actualizada)) / 3_600_000);
    const hace = horas < 1 ? 'hace menos de una hora' : horas < 48 ? `hace ${horas} h` : `hace ${Math.round(horas / 24)} días`;
    lineas.push(`Ubicación aproximada: ${a.lugar} (actualizada ${hace}).`);
  } else {
    lineas.push(
      'Ubicación: no la compartió. Si hace falta, pedile la ciudad o que toque "Usar mi ubicación" en el panel.'
    );
  }

  if (a) {
    lineas.push(
      `Resumen semanal automático: ${
        a.resumen_semanal
          ? `activado, los ${DIAS[a.resumen_dia]} a las ${horaEnPunto(a.resumen_hora)}`
          : 'desactivado'
      }. Aviso de lluvia por la mañana: ${a.aviso_lluvia ? 'activado' : 'desactivado'}. Calendario: ${
        a.calendario_ics ? 'conectado' : 'no conectado'
      }.`
    );
  }

  return { texto: lineas.join('\n\n'), ajustes: a };
}
