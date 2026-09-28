import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { cargarConversacion } from '@/lib/conversacion';
import { cargarLibreta } from '@/lib/libreta';
import Chat from './chat';

export default async function Page() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [mensajes, libreta] = await Promise.all([
    cargarConversacion(supabase, user.id),
    cargarLibreta(supabase),
  ]);
  return <Chat mensajesIniciales={mensajes} libretaInicial={libreta} />;
}
