import type { Metadata } from 'next';
import Link from 'next/link';
import { CONTACTO, PaginaLegal, Seccion } from '../legal';
import { NOMBRE } from '@/lib/marca';

export const metadata: Metadata = { title: `Condiciones del servicio · ${NOMBRE}` };

const LISTA = 'list-disc space-y-1 pl-5';

export default function Condiciones() {
  return (
    <PaginaLegal titulo="Condiciones del servicio" actualizada="2 de octubre de 2026">
      <p>
        Al usar {NOMBRE} aceptás estas condiciones. Son pocas y simples.
      </p>

      <Seccion titulo="Qué es">
        <p>
          {NOMBRE} es un asistente personal para un equipo de trabajo. Se entra solo con una
          invitación de un administrador del equipo.
        </p>
      </Seccion>

      <Seccion titulo="Uso aceptable">
        <ul className={LISTA}>
          <li>Tu cuenta es personal: no la compartas.</li>
          <li>
            No uses {NOMBRE} para mandar correos o invitaciones que la otra persona no espera (spam), ni
            para nada ilegal o que perjudique a otros.
          </li>
          <li>
            Hay límites para cuidar el servicio, por ejemplo de mensajes y correos por día. Se pueden
            ajustar.
          </li>
        </ul>
      </Seccion>

      <Seccion titulo="Sobre las respuestas de la inteligencia artificial">
        <p>
          {NOMBRE} usa inteligencia artificial y puede equivocarse. Revisá lo importante (fechas,
          montos, lo que dice un documento) antes de tomar decisiones. Las acciones que afectan a
          otras personas o que no se pueden deshacer, como mandar un correo o borrar algo, se
          confirman con un botón.
        </p>
      </Seccion>

      <Seccion titulo="Tus datos">
        <p>
          Tus datos son tuyos. Cómo se guardan y cómo borrarlos está en la{' '}
          <Link href="/privacidad" className="underline underline-offset-4">
            política de privacidad
          </Link>
          .
        </p>
      </Seccion>

      <Seccion titulo="Disponibilidad y cambios">
        <p>
          {NOMBRE} se ofrece tal como está, sin garantía de que funcione siempre sin interrupciones.
          Estas condiciones pueden cambiar; si el cambio es importante, se avisa en la app.
          Un administrador puede quitar el acceso de una cuenta que no respete estas condiciones.
        </p>
      </Seccion>

      <Seccion titulo="Contacto">
        <p>
          <a href={`mailto:${CONTACTO}`} className="underline underline-offset-4">
            {CONTACTO}
          </a>
        </p>
      </Seccion>
    </PaginaLegal>
  );
}
