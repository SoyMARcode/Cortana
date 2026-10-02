import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { nombrarLugar } from '@/lib/clima';

const ubicacionSchema = z.object({
  latitud: z.number().min(-90).max(90),
  longitud: z.number().min(-180).max(180),
});

/** Dos decimales: unos 1,1 km. Alcanza para el clima y las búsquedas, sin guardar dónde vive exactamente. */
function redondear(n: number) {
  return Math.round(n * 100) / 100;
}

/** Guarda la ubicación aproximada de este dispositivo (la pide el panel). */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const datos = ubicacionSchema.safeParse(await req.json().catch(() => null));
  if (!datos.success) return NextResponse.json({ error: 'Ubicación inválida' }, { status: 400 });

  const latitud = redondear(datos.data.latitud);
  const longitud = redondear(datos.data.longitud);
  const nombre = await nombrarLugar(latitud, longitud).catch(() => null);

  const { error } = await supabase.from('ajustes').upsert(
    {
      user_id: user.id,
      latitud,
      longitud,
      lugar: nombre?.lugar ?? `${latitud}, ${longitud}`,
      ciudad: nombre?.ciudad ?? null,
      region: nombre?.region ?? null,
      pais: nombre?.pais ?? null,
      ubicacion_actualizada: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, lugar: nombre?.lugar ?? null });
}

/** Borra la ubicación guardada. */
export async function DELETE() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const { error } = await supabase
    .from('ajustes')
    .update({
      latitud: null,
      longitud: null,
      lugar: null,
      ciudad: null,
      region: null,
      pais: null,
      ubicacion_actualizada: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
