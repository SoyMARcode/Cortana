import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { cargarConversacion } from '@/lib/conversacion';
import { cargarLibreta } from '@/lib/libreta';
import Chat from './chat';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [clave: string]: string | string[] | undefined }>;
}) {
  const supabase = await createClient();
  // Verifica la sesión sin ir al servidor de Supabase (ver proxy.ts).
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims.sub;
  if (!userId) redirect('/login');

  const [mensajes, libreta] = await Promise.all([
    cargarConversacion(supabase, userId),
    cargarLibreta(supabase),
  ]);
  // Algunas notificaciones (ej. la limpieza semanal) abren el chat con un
  // pedido ya escrito: /?mensaje=...
  const { mensaje } = await searchParams;
  const sugerido = typeof mensaje === 'string' ? mensaje.slice(0, 300) : '';

  return <Chat mensajesIniciales={mensajes} libretaInicial={libreta} mensajeSugerido={sugerido} />;
}
