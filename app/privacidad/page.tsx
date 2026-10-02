import type { Metadata } from 'next';
import { CONTACTO, PaginaLegal, Seccion } from '../legal';
import { NOMBRE } from '@/lib/marca';

export const metadata: Metadata = { title: `Política de privacidad · ${NOMBRE}` };

const LISTA = 'list-disc space-y-1 pl-5';

export default function Privacidad() {
  return (
    <PaginaLegal titulo="Política de privacidad" actualizada="2 de octubre de 2026">
      <p>
        {NOMBRE} es un asistente personal para un equipo de trabajo, al que se entra solo por
        invitación. Esta página explica qué datos guarda, para qué los usa y cómo podés borrarlos.
      </p>

      <Seccion titulo="Qué datos guarda">
        <ul className={LISTA}>
          <li>Tu email y tu contraseña (la contraseña se guarda cifrada; nadie la puede leer).</li>
          <li>
            Lo que cargás o le contás: tareas, recordatorios, contactos, preferencias, gastos y las
            conversaciones con {NOMBRE}, incluido un archivo para buscar en lo que hablaron antes.
          </li>
          <li>
            Los archivos que adjuntás en el chat y el texto de los documentos que pedís guardar.
          </li>
          <li>
            Tu ubicación aproximada (redondeada a ~1 km, nunca la exacta), solo si tocás &quot;Usar
            mi ubicación&quot;. Sirve para el clima y para búsquedas cercanas.
          </li>
          <li>
            Los datos técnicos para mandarte notificaciones en los dispositivos donde las activaste.
          </li>
          <li>
            Si conectás un calendario: el enlace iCal que pegues o, con Google Calendar, el permiso
            de acceso (guardado cifrado).
          </li>
        </ul>
      </Seccion>

      <Seccion titulo="Para qué se usan">
        <p>
          Únicamente para que {NOMBRE} funcione para vos: responder en el chat, mandarte avisos y
          correos que pediste, y los avisos automáticos que podés apagar (buenos días, resumen
          semanal, lluvia, eventos). Tus datos no se venden, no se usan para publicidad y no se
          comparten con otras personas del equipo, salvo lo que vos decidas: un correo que mandás o
          una tarea que le asignás a alguien.
        </p>
      </Seccion>

      <Seccion titulo="Datos de Google">
        <p>
          Si conectás Google Calendar, {NOMBRE} pide solo el permiso para ver y editar los eventos de
          tu calendario (<code>calendar.events</code>) y tu email, para mostrarte qué cuenta
          conectaste. No accede a tu Gmail, tu Drive ni al resto de tu cuenta.
        </p>
        <ul className={LISTA}>
          <li>
            Los eventos se leen, crean, mueven o borran solo cuando vos se lo pedís a {NOMBRE}, o para
            avisarte antes de un evento si tenés ese aviso encendido.
          </li>
          <li>
            No se guardan copias de tus eventos: se consultan a Google en el momento. Lo único que se
            guarda es el permiso de acceso, cifrado.
          </li>
          <li>
            Los datos de Google no se transfieren a terceros, salvo lo necesario para responderte en el
            chat (ver &quot;Servicios que usa&quot;), no se usan para publicidad ni para entrenar
            modelos de inteligencia artificial, y nadie los lee a mano.
          </li>
          <li>
            El uso de la información recibida de las APIs de Google respeta la{' '}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              className="underline underline-offset-4"
            >
              Política de Datos del Usuario de los Servicios de API de Google
            </a>
            , incluidos sus requisitos de Uso Limitado.
          </li>
          <li>
            Podés quitar el permiso cuando quieras, diciéndole a {NOMBRE} &quot;desconectá Google
            Calendar&quot; o desde{' '}
            <a href="https://myaccount.google.com/permissions" className="underline underline-offset-4">
              myaccount.google.com/permissions
            </a>
            .
          </li>
        </ul>
      </Seccion>

      <Seccion titulo="Servicios que usa">
        <ul className={LISTA}>
          <li>Supabase: base de datos y cuentas.</li>
          <li>Vercel: donde funciona la app.</li>
          <li>
            Anthropic (Claude): la inteligencia artificial que responde en el chat. Recibe lo que
            escribís y la información necesaria para responderte, y no la usa para entrenar sus
            modelos.
          </li>
          <li>Resend: el envío de correos.</li>
          <li>
            Open-Meteo y OpenStreetMap: el clima y el nombre de tu zona. Solo reciben coordenadas
            aproximadas, nunca tu nombre ni tu email.
          </li>
          <li>Google: solo si conectás Google Calendar.</li>
        </ul>
      </Seccion>

      <Seccion titulo="Cómo borrar tus datos">
        <ul className={LISTA}>
          <li>Tareas, avisos, contactos, gastos, preferencias y documentos: pedíselo a {NOMBRE}.</li>
          <li>
            Conversaciones: &quot;nueva conversación&quot; borra el chat; &quot;olvidá todo lo que
            hablamos&quot; borra el archivo de búsqueda.
          </li>
          <li>
            Para borrar tu cuenta y todos tus datos, escribí a{' '}
            <a href={`mailto:${CONTACTO}`} className="underline underline-offset-4">
              {CONTACTO}
            </a>
            .
          </li>
        </ul>
      </Seccion>

      <Seccion titulo="Contacto">
        <p>
          Dudas sobre esta política:{' '}
          <a href={`mailto:${CONTACTO}`} className="underline underline-offset-4">
            {CONTACTO}
          </a>
          .
        </p>
      </Seccion>
    </PaginaLegal>
  );
}
