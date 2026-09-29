'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { hablar, detenerVoz, crearReconocimientoDeVoz } from '@/lib/voice';
import { cargarLibreta, type Libreta } from '@/lib/libreta';
import PanelTareas from './panel-tareas';
import AvisosDispositivo, { registrarServiceWorker } from './avisos-dispositivo';
import { IconoMarcador, IconoMicrofono, IconoPersona, IconoReloj, IconoSobre, Sello } from './iconos';

const NOMBRES_HERRAMIENTA: Record<string, string> = {
  crear_tarea: 'anotado',
  listar_tareas: 'revisando tus pendientes',
  completar_tarea: 'listo',
  editar_tarea: 'corrigiendo la tarea',
  borrar_tarea: 'borrando la tarea',
  guardar_contacto: 'guardando el contacto',
  listar_contactos: 'buscando en tus contactos',
  borrar_contacto: 'borrando el contacto',
  programar_recordatorio: 'programando el aviso',
  listar_recordatorios: 'revisando tus avisos',
  cancelar_recordatorio: 'aviso cancelado',
  fecha_hora_actual: 'mirando el calendario',
  enviar_correo: 'enviando el correo',
};

function fechaDeHoy() {
  return new Intl.DateTimeFormat('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
}

type RespuestaAprobacion = (r: { id: string; approved: boolean }) => void;

function tieneAprobacionPendiente(mensajes: UIMessage[]): boolean {
  const ultimo = mensajes[mensajes.length - 1];
  return (
    ultimo?.role === 'assistant' &&
    ultimo.parts.some(
      (p: any) => p.state === 'approval-requested' && !p.approval?.isAutomatic
    )
  );
}

function Aprobacion({
  pregunta,
  confirmar,
  children,
  toolPart,
  responder,
}: {
  pregunta: string;
  confirmar: string;
  children: React.ReactNode;
  toolPart: any;
  responder: RespuestaAprobacion;
}) {
  return (
    <div className="my-3 border border-[var(--amber)] bg-[var(--amber-soft)] px-4 py-3 text-sm">
      <p className="mb-2 font-semibold">{pregunta}</p>
      {children}
      <div className="mt-3 flex items-center gap-4">
        <button
          onClick={() => responder({ id: toolPart.approval.id, approved: true })}
          className="border border-[var(--ink)] bg-[var(--ink)] px-3.5 py-1.5 font-medium text-[var(--paper)] transition hover:opacity-85"
        >
          {confirmar}
        </button>
        <button
          onClick={() => responder({ id: toolPart.approval.id, approved: false })}
          className="underline decoration-[var(--rule)] underline-offset-4 hover:text-[var(--ink)]"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

const CHIP = 'my-2 inline-flex -rotate-1 items-center gap-2 border border-[var(--rule)] px-3 py-1.5 text-sm text-[var(--ink)]';

function EtiquetaTarea({ toolPart, responder }: { toolPart: any; responder: RespuestaAprobacion }) {
  const nombre = NOMBRES_HERRAMIENTA[toolPart.type?.replace('tool-', '')] ?? 'usando una herramienta';
  const salida = toolPart.output as any;
  const tarea = salida?.tarea;
  const pideAprobacion = toolPart.state === 'approval-requested' && !toolPart.approval?.isAutomatic;

  if (toolPart.type === 'tool-enviar_correo') {
    if (pideAprobacion) {
      const { destinatarios = [], asunto, contenido } = toolPart.input ?? {};
      return (
        <Aprobacion pregunta="¿Envío este correo?" confirmar="Enviar" toolPart={toolPart} responder={responder}>
          <p>
            <span className="text-[var(--ink-soft)]">Para:</span> {destinatarios.join(', ')}
          </p>
          <p className="mb-2">
            <span className="text-[var(--ink-soft)]">Asunto:</span> {asunto}
          </p>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap border-l-2 border-[var(--rule)] pl-3 text-[var(--ink-soft)]">
            {contenido}
          </p>
        </Aprobacion>
      );
    }
    if (toolPart.state === 'output-denied') {
      return <div className="my-1 text-sm italic text-[var(--ink-soft)]">correo cancelado</div>;
    }
  }

  if (toolPart.type === 'tool-borrar_tarea') {
    if (pideAprobacion) {
      return (
        <Aprobacion pregunta="¿Borro esta tarea?" confirmar="Borrar" toolPart={toolPart} responder={responder}>
          <p className="font-medium">{toolPart.input?.titulo}</p>
          <p className="text-[var(--ink-soft)]">No se puede deshacer.</p>
        </Aprobacion>
      );
    }
    if (toolPart.state === 'output-denied') {
      return <div className="my-1 text-sm italic text-[var(--ink-soft)]">la tarea sigue ahí</div>;
    }
    if (salida?.borrada) {
      return (
        <div className="my-1 text-sm italic text-[var(--ink-soft)]">
          borrada: <span className="line-through">{toolPart.input?.titulo}</span>
        </div>
      );
    }
  }

  if (salida?.enviado_a) {
    return (
      <div className="flex flex-col items-start gap-1">
        <div className={`${CHIP} bg-[var(--teal-soft)]`}>
          <IconoSobre />
          <span>Correo enviado a {[].concat(salida.enviado_a).join(', ')}</span>
        </div>
        {salida.fallidos?.length > 0 && (
          <div className="border border-[var(--amber)] bg-[var(--amber-soft)] px-3 py-1.5 text-sm">
            No llegó a:{' '}
            {salida.fallidos.map((f: any) => `${f.destinatario} (${f.error})`).join('; ')}
          </div>
        )}
      </div>
    );
  }
  if (salida && salida.ok === false && toolPart.type === 'tool-enviar_correo') {
    return (
      <div className="my-2 border border-[var(--amber)] bg-[var(--amber-soft)] px-3 py-1.5 text-sm">
        No se pudo enviar el correo: {salida.error}
      </div>
    );
  }

  if (salida?.recordatorio) {
    return (
      <div className={`${CHIP} border-dashed bg-[var(--paper-note)]`}>
        <IconoReloj />
        <span className="font-medium">{salida.recordatorio.mensaje}</span>
        <span className="fuente-editorial italic text-[var(--ink-soft)]">
          {salida.recordatorio.cuando_local}
        </span>
      </div>
    );
  }

  if (salida?.contacto) {
    return (
      <div className={`${CHIP} bg-[var(--paper-note)]`}>
        <IconoPersona />
        <span className="font-medium">{salida.contacto.nombre}</span>
        <span className="text-[var(--ink-soft)]">{salida.contacto.email}</span>
      </div>
    );
  }

  if (tarea) {
    return (
      <div className={`${CHIP} bg-[var(--amber-soft)]`}>
        <IconoMarcador />
        <span className="font-medium">{tarea.titulo}</span>
        {tarea.fecha_limite && (
          <span className="fuente-editorial italic text-[var(--ink-soft)]">
            vence {tarea.fecha_limite}
          </span>
        )}
      </div>
    );
  }

  return <div className="my-1 text-sm italic text-[var(--ink-soft)]">{nombre}...</div>;
}

const ENLACE =
  'underline decoration-[var(--rule)] decoration-1 underline-offset-4 hover:text-[var(--ink)] disabled:opacity-40';

export default function Chat({
  mensajesIniciales,
  libretaInicial,
}: {
  mensajesIniciales: UIMessage[];
  libretaInicial: Libreta;
}) {
  const [supabase] = useState(() => createClient());
  const [libreta, setLibreta] = useState(libretaInicial);
  const [hojaAbierta, setHojaAbierta] = useState(false);

  const refrescarLibreta = useCallback(async () => {
    setLibreta(await cargarLibreta(supabase));
  }, [supabase]);

  const { messages, setMessages, sendMessage, status, addToolApprovalResponse } = useChat({
    messages: mensajesIniciales,
    transport: new DefaultChatTransport({
      body: () => ({ zonaHoraria: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    }),
    // Tras aprobar o cancelar una acción, la conversación sigue sola.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    // Cortana pudo haber creado, editado o borrado tareas: el panel se pone al día.
    onFinish: () => {
      refrescarLibreta();
    },
  });
  const [input, setInput] = useState('');
  const [vozActivada, setVozActivada] = useState(true);
  const [escuchando, setEscuchando] = useState(false);
  // El historial cargado ya fue leído: no se vuelve a decir en voz alta al abrir.
  const ultimoLeidoRef = useRef<string | null>(
    mensajesIniciales[mensajesIniciales.length - 1]?.id ?? null
  );
  const reconocimientoRef = useRef<any>(null);
  const finRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const esperandoAprobacion = tieneAprobacionPendiente(messages);
  const pendientes = libreta.tareas.filter((t) => !t.completada).length;

  useEffect(() => {
    registrarServiceWorker();
  }, []);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  useEffect(() => {
    if (!vozActivada) return;
    const ultimo = messages[messages.length - 1];
    if (!ultimo || ultimo.role !== 'assistant') return;
    if (ultimoLeidoRef.current === ultimo.id) return;
    if (status !== 'ready') return;

    const texto = ultimo.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as any).text)
      .join(' ');

    if (texto) {
      hablar(texto);
      ultimoLeidoRef.current = ultimo.id;
    }
  }, [messages, status, vozActivada]);

  useEffect(() => {
    if (!hojaAbierta) return;
    const cerrarConEscape = (e: KeyboardEvent) => e.key === 'Escape' && setHojaAbierta(false);
    window.addEventListener('keydown', cerrarConEscape);
    return () => window.removeEventListener('keydown', cerrarConEscape);
  }, [hojaAbierta]);

  async function cancelarAviso(id: string) {
    setLibreta((l) => ({ ...l, recordatorios: l.recordatorios.filter((r) => r.id !== id) }));
    const { error } = await supabase.from('recordatorios').delete().eq('id', id);
    if (error) refrescarLibreta();
  }

  async function alternarTarea(id: string, completada: boolean) {
    // Se tacha al instante; si la base falla, se vuelve atrás al refrescar.
    setLibreta((l) => ({
      ...l,
      tareas: l.tareas.map((t) =>
        t.id === id ? { ...t, completada, updated_at: new Date().toISOString() } : t
      ),
    }));
    const { error } = await supabase.from('tareas').update({ completada }).eq('id', id);
    if (error) refrescarLibreta();
  }

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || esperandoAprobacion) return;
    sendMessage({ text: input });
    setInput('');
  }

  function alternarMicrofono() {
    if (escuchando) {
      reconocimientoRef.current?.stop();
      setEscuchando(false);
      return;
    }
    const recognition = crearReconocimientoDeVoz((texto) => {
      setInput(texto);
      setEscuchando(false);
    });
    if (!recognition) {
      alert('Tu navegador no soporta reconocimiento de voz. Probá con Chrome o Edge.');
      return;
    }
    recognition.onend = () => setEscuchando(false);
    reconocimientoRef.current = recognition;
    recognition.start();
    setEscuchando(true);
  }

  async function nuevaConversacion() {
    detenerVoz();
    const { data } = await supabase.auth.getUser();
    if (data.user) await supabase.from('conversaciones').delete().eq('user_id', data.user.id);
    setMessages([]);
    ultimoLeidoRef.current = null;
    setHojaAbierta(false);
  }

  async function cerrarSesion() {
    detenerVoz();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const acciones = (
    <>
      {messages.length > 0 && (
        <button onClick={nuevaConversacion} disabled={status !== 'ready'} className={ENLACE}>
          nueva conversación
        </button>
      )}
      <button onClick={() => setVozActivada((v) => !v)} className={ENLACE}>
        {vozActivada ? 'silenciar voz' : 'activar voz'}
      </button>
      <button onClick={cerrarSesion} className={ENLACE}>
        cerrar sesión
      </button>
    </>
  );

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] bg-[var(--paper)] text-[var(--ink)] md:grid-cols-[300px_1fr]">
      <header className="col-span-full flex items-center justify-between gap-4 border-b border-[var(--paper-line)] px-4 py-3 md:px-6 md:py-3.5">
        <div className="flex items-center gap-2.5">
          <Sello />
          <h1 className="fuente-editorial text-[22px] italic md:text-2xl">Cortana</h1>
        </div>
        <div className="hidden items-baseline gap-5 text-sm text-[var(--ink-soft)] md:flex">
          <span className="fuente-editorial italic">{fechaDeHoy()}</span>
          {acciones}
        </div>
        <button
          onClick={() => setHojaAbierta(true)}
          aria-haspopup="dialog"
          aria-expanded={hojaAbierta}
          className="inline-flex items-center gap-1.5 border border-[var(--rule)] bg-[var(--paper-note)] px-2.5 py-1 text-sm font-medium md:hidden"
        >
          Tareas
          <span
            className={`grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] tabular-nums ${
              pendientes > 0 ? 'bg-[var(--amber)] text-[var(--paper)]' : 'bg-[var(--rule)] text-[var(--ink)]'
            }`}
          >
            {pendientes}
          </span>
        </button>
      </header>

      {/* Panel lateral: solo en computadora */}
      <aside
        aria-label="Tus tareas"
        className="hidden overflow-y-auto border-r border-[var(--paper-line)] bg-[var(--panel)] px-[18px] py-5 md:block"
      >
        <div className="flex flex-col gap-5">
          <PanelTareas libreta={libreta} onAlternar={alternarTarea} onCancelarAviso={cancelarAviso} />
          <AvisosDispositivo />
        </div>
      </aside>

      <div className="grid min-h-0 grid-rows-[1fr_auto]">
        <main className="overflow-y-auto px-4 py-6 md:px-10 md:py-8">
          <div className="mx-auto flex max-w-[700px] flex-col gap-5">
            {messages.length === 0 && (
              <p className="fuente-editorial text-center italic text-[var(--ink-soft)]">
                Escribile algo a Cortana — por ejemplo, &quot;recordame entregar el informe el
                viernes&quot;.
              </p>
            )}

            {messages.map((message) => (
              <div key={message.id} className="nota-nueva">
                {message.role === 'user' ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rotate-1 bg-[var(--paper-note)] px-4 py-2 text-[15px] shadow-[1px_2px_0_var(--rule)] md:max-w-[75%]">
                      {message.parts.map((part, i) =>
                        part.type === 'text' ? <span key={i}>{part.text}</span> : null
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="border-l-2 border-[var(--rule)] pl-4 text-[15px] leading-relaxed">
                    {message.parts.map((part, i) => {
                      if (part.type === 'text') {
                        return <span key={i}>{(part as any).text}</span>;
                      }
                      if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
                        return <EtiquetaTarea key={i} toolPart={part} responder={addToolApprovalResponse} />;
                      }
                      return null;
                    })}
                  </div>
                )}
              </div>
            ))}

            {status === 'submitted' && (
              <div className="border-l-2 border-[var(--rule)] pl-4 text-[15px] italic text-[var(--ink-soft)]">
                escribiendo...
              </div>
            )}
            <div ref={finRef} />
          </div>
        </main>

        <form
          onSubmit={enviar}
          className="border-t border-[var(--paper-line)] px-3 pt-2.5 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-10 md:py-3.5"
        >
          <div className="mx-auto flex max-w-[700px] items-center gap-3">
            <button
              type="button"
              onClick={alternarMicrofono}
              aria-pressed={escuchando}
              aria-label={escuchando ? 'Dejar de escuchar' : 'Dictar mensaje'}
              className={`grid h-11 w-11 shrink-0 place-items-center border transition md:h-10 md:w-10 ${
                escuchando
                  ? 'animate-pulse border-[var(--amber)] bg-[var(--amber-soft)] text-[var(--amber)]'
                  : 'border-[var(--paper-line)] hover:border-[var(--rule)]'
              }`}
            >
              <IconoMicrofono />
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                esperandoAprobacion
                  ? 'Primero confirmá o cancelá lo de arriba'
                  : 'Escribí o usá el micrófono...'
              }
              className="min-w-0 flex-1 border-b border-[var(--paper-line)] bg-transparent px-1 py-2 text-base outline-none placeholder:text-[var(--ink-soft)] focus:border-[var(--ink)] md:text-[15px]"
            />
            <button
              type="submit"
              disabled={status !== 'ready' || esperandoAprobacion}
              className="border border-[var(--ink)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-40"
            >
              Enviar
            </button>
          </div>
        </form>
      </div>

      {/* Hoja de tareas: solo en celular */}
      {hojaAbierta && (
        <div className="fixed inset-0 z-20 md:hidden" role="dialog" aria-modal="true" aria-label="Tus tareas">
          <button
            aria-label="Cerrar tareas"
            onClick={() => setHojaAbierta(false)}
            className="absolute inset-0 bg-black/35"
          />
          <div className="hoja-sube absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col gap-4 overflow-y-auto rounded-t-[18px] border-t border-[var(--rule)] bg-[var(--panel)] px-4 pt-2.5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <button
              onClick={() => setHojaAbierta(false)}
              aria-label="Cerrar tareas"
              className="h-1 w-10 self-center rounded-full bg-[var(--rule)]"
            />
            <PanelTareas libreta={libreta} onAlternar={alternarTarea} onCancelarAviso={cancelarAviso} grande />
            <AvisosDispositivo />
            <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-[var(--paper-line)] pt-3.5 text-sm text-[var(--ink-soft)]">
              {acciones}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
