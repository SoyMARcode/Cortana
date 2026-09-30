/**
 * Genera todos los íconos de la app a partir del logo de lib/marca.ts.
 * Correr después de cambiar el logo:  node --no-warnings scripts/generar-iconos.ts
 */
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { svgLogo } from '../lib/marca.ts';

const PAPEL = '#EDEFF2';
const TINTA = '#21242B';

/** Monograma Q centrado sobre un cuadrado de papel. `escala` = ancho de la Q sobre el lado. */
async function iconoCuadrado(lado: number, { fondo, color, escala }: { fondo: string | null; color: string; escala: number }) {
  const q = await sharp(Buffer.from(svgLogo({ color, soloQ: true })), { density: 1200 })
    .resize({ width: Math.round(lado * escala) })
    .png()
    .toBuffer();
  return sharp({
    create: { width: lado, height: lado, channels: 4, background: fondo ?? { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: q, gravity: 'center' }])
    .png()
    .toBuffer();
}

/** .ico con imágenes PNG adentro (lo aceptan todos los navegadores actuales). */
function armarIco(pngs: { lado: number; datos: Buffer }[]): Buffer {
  const cabecera = Buffer.alloc(6);
  cabecera.writeUInt16LE(0, 0);
  cabecera.writeUInt16LE(1, 2);
  cabecera.writeUInt16LE(pngs.length, 4);
  let desplazamiento = 6 + 16 * pngs.length;
  const entradas = pngs.map(({ lado, datos }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(lado >= 256 ? 0 : lado, 0);
    e.writeUInt8(lado >= 256 ? 0 : lado, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(datos.length, 8);
    e.writeUInt32LE(desplazamiento, 12);
    desplazamiento += datos.length;
    return e;
  });
  return Buffer.concat([cabecera, ...entradas, ...pngs.map((p) => p.datos)]);
}

// App instalada (Android/PC). La Q ocupa el 46%: entra en la zona segura de los íconos "maskable".
const appIcono = { fondo: PAPEL, color: TINTA, escala: 0.46 };
await writeFile('public/icono-192.png', await iconoCuadrado(192, appIcono));
await writeFile('public/icono-512.png', await iconoCuadrado(512, appIcono));
await writeFile('app/apple-icon.png', await iconoCuadrado(180, { ...appIcono, escala: 0.5 }));

// Insignia de Android en la barra de notificaciones: solo cuenta la silueta (blanco sobre transparente).
await writeFile('public/insignia-96.png', await iconoCuadrado(96, { fondo: null, color: '#FFFFFF', escala: 0.72 }));

// Pestaña del navegador.
const favicon = { fondo: PAPEL, color: TINTA, escala: 0.78 };
await writeFile(
  'app/favicon.ico',
  armarIco(await Promise.all([16, 32, 48].map(async (lado) => ({ lado, datos: await iconoCuadrado(lado, favicon) }))))
);

// Logo para los correos, al doble de tamaño para pantallas nítidas.
const logoCorreo = await sharp(Buffer.from(svgLogo({ color: TINTA })), { density: 1200 })
  .resize({ height: 48 })
  .png()
  .toBuffer();
const { width } = await sharp(logoCorreo).metadata();
await writeFile(
  'lib/email-logo.ts',
  `/**
 * Logo de QIR para los correos (PNG ${width}x48, se muestra a la mitad). Va
 * incrustado como adjunto inline (cid:), así se ve sin depender de que la app
 * esté publicada en una URL. Generado por scripts/generar-iconos.ts: no editar a mano.
 */
export const LOGO_PNG_BASE64 = '${logoCorreo.toString('base64')}';
export const LOGO_ANCHO = ${Math.round((width ?? 0) / 2)};
export const LOGO_ALTO = 24;
`
);

console.log('Íconos generados.');
