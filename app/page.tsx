import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { cargarConversacion } from '@/lib/conversacion';
import { cargarLibreta } from '@/lib/libreta';
import Chat from './chat';

export default async function Page() {
  const supabase = await createClient();
  // Verifica la sesión sin ir al servidor de Supabase (ver proxy.ts).
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims.sub;
  if (!userId) redirect('/login');

  const [mensajes, libreta] = await Promise.all([
    cargarConversacion(supabase, userId),
    cargarLibreta(supabase),
  ]);
  return <Chat mensajesIniciales={mensajes} libretaInicial={libreta} />;
}
