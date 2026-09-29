import type { MetadataRoute } from 'next';

/** Hace que Cortana se pueda instalar como app en el celular y la computadora. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cortana',
    short_name: 'Cortana',
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
