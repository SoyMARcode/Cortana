import type { MetadataRoute } from 'next';
import { NOMBRE } from '@/lib/marca';

/** Hace que QIR se pueda instalar como app en el celular y la computadora. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: NOMBRE,
    short_name: NOMBRE,
    description: 'Tu asistente personal: tareas, recordatorios y avisos.',
    lang: 'es',
    start_url: '/',
    display: 'standalone',
    background_color: '#EDEFF2',
    theme_color: '#EDEFF2',
    icons: [
      { src: '/icono-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
