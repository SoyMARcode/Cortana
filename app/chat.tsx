'use client';

import { useState, useRef, useEffect, useCallback, useEffectEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import {
  hablar,
  desbloquearVoz,
  detenerVoz,
  iniciarDictado,
  soportaDictado,
  type Dictado,
} from '@/lib/voice';
import { cargarLibreta, type Libreta } from '@/lib/libreta';
import { avisar, confirmar, notificar } from '@/lib/alertas';
import PanelTareas from './panel-tareas';
import AvisosDispositivo, { registrarServiceWorker } from './avisos-dispositivo';
import UbicacionDispositivo from './ubicacion-dispositivo';
import {
  IconoClip,
  IconoMarcador,
  IconoMicrofono,
  IconoNube,
  IconoPersona,
  IconoReloj,
  IconoSobre,
  Logo,
} from './iconos';
import { NOMBRE } from '@/lib/marca';
import { separarSugerencias, sinSugerencias } from '@/lib/sugerencias';
import {
  BUCKET_ADJUNTOS,
  MAX_ADJUNTOS,
  MAX_BYTES_ADJUNTO,
  nombreSeguro,
  tamanoLegible,
  type Adjunto,
  type MetadataMensaje,
} from '@/lib/adjuntos';

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
  invitar_persona: 'invitación agregada',
  listar_equipo: 'revisando el equipo',
  quitar_invitacion: 'invitación quitada',
  enviar_correo: 'enviando el correo',
  agregar_apodo: 'anotando el apodo',
  consultar_clima: 'mirando el cielo',
  recordar_preferencia: 'lo tengo en cuenta',
  olvidar_preferencia: 'olvidado',
  configurar_avisos: 'ajustando tus avisos',
  conectar_calendario: 'conectando tu calendario',
  ver_calendario: 'revisando tu calendario',
  desconectar_calendario: 'calendario desconectado',
  web_search: 'buscando en internet',
  web_fetch: 'leyendo la página',
  enlace_calendario_tareas: 'preparando tu calendario',
  companeros_de_equipo: 'mirando el equipo',
  asignar_tarea: 'asignando la tarea',
  tareas_que_asigne: 'revisando lo que asignaste',
  registrar_gasto: 'anotando el gasto',
  resumen_gastos: 'sumando tus gastos',
  listar_gastos: 'revisando tus gastos',
  borrar_gasto: 'gasto borrado',
};

function adjuntosDe(mensaje: UIMessage): Adjunto[] {
  return (mensaje.metadata as MetadataMensaje | undefined)?.adjuntos ?? [];
}

function ChipAdjunto({
  adjunto,
  onQuitar,
}: {
  adjunto: Pick<Adjunto, 'nombre' | 'tamano'>;
  onQuitar?: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 border border-[var(--rule)] bg-[var(--paper)] px-2 py-0.5 text-[13px]">
      <IconoClip className="h-3.5 w-3.5 shrink-0 text-[var(--ink-soft)]" />
      <span className="truncate">{adjunto.nombre}</span>
      <span className="shrink-0 text-[var(--ink-soft)]">{tamanoLegible(adjunto.tamano)}</span>
      {onQuitar && (
        <button
          type="button"
          onClick={onQuitar}
          aria-label={`Quitar ${adjunto.nombre}`}
          className="px-0.5 leading-none text-[var(--ink-soft)] hover:text-[var(--ink)]"
        >
          ×
        </button>
      )}
    </span>
  );
}

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
      const { destinatarios = [], asunto, contenido, adjuntos = [] } = toolPart.input ?? {};
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
          {adjuntos.length > 0 && (
            <p className="mt-2">
              <span className="text-[var(--ink-soft)]">Adjuntos:</span>{' '}
              {adjuntos.map((a: { nombre: string }) => a.nombre).join(', ')}
            </p>
          )}
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
          <span>
            Correo enviado a {[].concat(salida.enviado_a).join(', ')}
            {salida.adjuntos?.length > 0 &&
              ` · ${salida.adjuntos.length} adjunto${salida.adjuntos.length > 1 ? 's' : ''}`}
          </span>
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
          {salida.recordatorio.se_repite && ` · ↻ ${salida.recordatorio.se_repite}`}
        </span>
      </div>
    );
  }

  if (salida?.gasto) {
    return (
      <div className={`${CHIP} bg-[var(--paper-note)]`}>
        <span className="font-medium tabular-nums">{salida.gasto.texto}</span>
        <span className="fuente-editorial italic text-[var(--ink-soft)]">
          {salida.gasto.categoria}
          {salida.gasto.descripcion && ` · ${salida.gasto.descripcion}`}
        </span>
      </div>
    );
  }

  if (salida?.asignada) {
    return (
      <div className={`${CHIP} bg-[var(--teal-soft)]`}>
        <IconoPersona />
        <span className="font-medium">{salida.asignada.titulo}</span>
        <span className="fuente-editorial italic text-[var(--ink-soft)]">
          para {salida.asignada.para}
          {salida.asignada.fecha_limite && ` · vence ${salida.asignada.fecha_limite}`}
        </span>
      </div>
    );
  }

  if (salida?.clima) {
    const { lugar, ahora, dias } = salida.clima;
    const hoy = dias?.[0];
    return (
      <div className={`${CHIP} bg-[var(--paper-note)]`}>
        <IconoNube />
        <span className="font-medium">
          {ahora.temperatura}° {ahora.descripcion}
        </span>
        <span className="fuente-editorial italic text-[var(--ink-soft)]">
          {lugar}
          {hoy?.llevar_paraguas && ` · lluvia ${hoy.prob_lluvia}%`}
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

/** Botones con las respuestas que QIR sugirió al final de su último mensaje. */
function RespuestasRapidas({ mensaje, onElegir }: { mensaje: UIMessage; onElegir: (texto: string) => void }) {
  const ultimoTexto = [...mensaje.parts].reverse().find((p) => p.type === 'text') as
    | { text: string }
    | undefined;
  const { sugerencias } = separarSugerencias(ultimoTexto?.text ?? '');
  if (!sugerencias.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {sugerencias.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onElegir(s)}
          className="border border-[var(--rule)] bg-[var(--paper-note)] px-3 py-1.5 text-sm transition hover:border-[var(--ink)]"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

/** Las páginas que QIR consultó en internet para esta respuesta. */
function Fuentes({ mensaje }: { mensaje: UIMessage }) {
  const vistas = new Set<string>();
  const fuentes: { url: string; title?: string }[] = [];
  for (const p of mensaje.parts) {
    if (p.type === 'source-url' && !vistas.has(p.url)) {
      vistas.add(p.url);
      fuentes.push(p);
    }
  }
  if (!fuentes.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-[var(--ink-soft)]">
      <span>Fuentes:</span>
      {fuentes.slice(0, 6).map((f) => {
        let sitio = f.url;
        try {
          sitio = new URL(f.url).hostname.replace(/^www\./, '');
        } catch {
          // URL rara: se muestra entera.
        }
        return (
          <a
            key={f.url}
            href={f.url}
            target="_blank"
            rel="noopener noreferrer"
            title={f.title ?? f.url}
            className="underline decoration-[var(--rule)] underline-offset-4 hover:text-[var(--ink)]"
          >
            {sitio}
          </a>
        );
      })}
    </div>
  );
}

const ENLACE =
  'underline decoration-[var(--rule)] decoration-1 underline-offset-4 hover:text-[var(--ink)] disabled:opacity-40';

export default function Chat({
  mensajesIniciales,
  libretaInicial,
  mensajeSugerido = '',
}: {
  mensajesIniciales: UIMessage[];
  libretaInicial: Libreta;
  /** Texto para dejar escrito en el campo al abrir (lo trae una notificación). */
  mensajeSugerido?: string;
}) {
  const [supabase] = useState(() => createClient());
  const [libreta, setLibreta] = useState(libretaInicial);
  const [hojaAbierta, setHojaAbierta] = useState(false);

  const refrescarLibreta = useCallback(async () => {
    setLibreta(await cargarLibreta(supabase));
  }, [supabase]);

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    addToolApprovalResponse,
    error,
    clearError,
  } = useChat({
    messages: mensajesIniciales,
    transport: new DefaultChatTransport({
      body: () => ({ zonaHoraria: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    }),
    // Tras aprobar o cancelar una acción, la conversación sigue sola.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    // QIR pudo haber creado, editado o borrado tareas: el panel se pone al día.
    onFinish: () => {
      refrescarLibreta();
    },
  });
  const [input, setInput] = useState(mensajeSugerido);
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const archivoRef = useRef<HTMLInputElement>(null);
  const [vozActivada, setVozActivada] = useState(true);
  const [escuchando, setEscuchando] = useState(false);
  // Manos libres: cuando QIR termina de hablar, el micrófono se abre solo y
  // lo que se dice se envía al terminar la frase. El ref lo leen los
  // callbacks del dictado, que viven más que un render.
  const [manosLibres, setManosLibres] = useState(false);
  const manosLibresRef = useRef(false);
  // El historial cargado ya fue leído: no se vuelve a decir en voz alta al abrir.
  const ultimoLeidoRef = useRef<string | null>(
    mensajesIniciales[mensajesIniciales.length - 1]?.id ?? null
  );
  const dictadoRef = useRef<Dictado | null>(null);
  const campoRef = useRef<HTMLInputElement>(null);
  const finRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const esperandoAprobacion = tieneAprobacionPendiente(messages);
  const pendientes = libreta.tareas.filter((t) => !t.completada).length;

  useEffect(() => {
    if (mensajeSugerido) router.replace('/');
  }, [mensajeSugerido, router]);

  useEffect(() => {
    registrarServiceWorker();
    // Al salir de la pantalla se apaga el micrófono.
    return () => dictadoRef.current?.cancelar();
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

    const texto = sinSugerencias(
      ultimo.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as any).text)
        .join(' ')
    );

    if (texto) {
      ultimoLeidoRef.current = ultimo.id;
      hablar(texto).then((completo) => {
        if (completo) despuesDeHablar();
      });
    }
  }, [messages, status, vozActivada]);

  // Con manos libres, al terminar de leer la respuesta se vuelve a escuchar.
  // Si QIR espera que se apruebe algo con un botón, no: hay que tocarlo.
  const despuesDeHablar = useEffectEvent(() => {
    if (manosLibresRef.current && !tieneAprobacionPendiente(messages)) escucharManosLibres();
  });

  useEffect(() => {
    if (!hojaAbierta) return;
    const cerrarConEscape = (e: KeyboardEvent) => e.key === 'Escape' && setHojaAbierta(false);
    window.addEventListener('keydown', cerrarConEscape);
    return () => window.removeEventListener('keydown', cerrarConEscape);
  }, [hojaAbierta]);

  async function cancelarAviso(id: string) {
    const aviso = libreta.recordatorios.find((r) => r.id === id);
    const seguro = await confirmar(
      '¿Cancelo este aviso?',
      aviso ? `"${aviso.mensaje}" no te va a llegar.` : 'Este aviso no te va a llegar.',
      { si: 'Cancelar aviso', no: 'Dejarlo', peligro: true }
    );
    if (!seguro) return;
    setLibreta((l) => ({ ...l, recordatorios: l.recordatorios.filter((r) => r.id !== id) }));
    const { error } = await supabase.from('recordatorios').delete().eq('id', id);
    if (error) {
      refrescarLibreta();
      notificar('No se pudo cancelar el aviso. Probá de nuevo.', 'error');
    } else {
      notificar('Aviso cancelado');
    }
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
    if (error) {
      refrescarLibreta();
      notificar('No se pudo guardar el cambio de la tarea.', 'error');
    }
  }

  async function adjuntar(e: React.ChangeEvent<HTMLInputElement>) {
    const elegidos = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!elegidos.length) return;
    if (adjuntos.length + elegidos.length > MAX_ADJUNTOS) {
      avisar('Demasiados archivos', `Podés adjuntar hasta ${MAX_ADJUNTOS} por mensaje.`);
      return;
    }
    const grandes = elegidos.filter((f) => f.size > MAX_BYTES_ADJUNTO);
    if (grandes.length) {
      avisar(
        'Archivo demasiado grande',
        `${grandes.map((f) => f.name).join(', ')} pasa de ${tamanoLegible(MAX_BYTES_ADJUNTO)}.`
      );
      return;
    }

    setSubiendo(true);
    try {
      const { data } = await supabase.auth.getUser();
      const userId = data.user?.id;
      if (!userId) throw new Error('Tu sesión expiró. Volvé a entrar.');
      const subidos = await Promise.all(
        elegidos.map(async (f) => {
          // Carpeta = id del usuario: es lo que exige la política de Storage.
          const ruta = `${userId}/${crypto.randomUUID().slice(0, 8)}-${nombreSeguro(f.name)}`;
          const tipo = f.type || 'application/octet-stream';
          const { error } = await supabase.storage
            .from(BUCKET_ADJUNTOS)
            .upload(ruta, f, { contentType: tipo });
          if (error) throw new Error(`${f.name}: ${error.message}`);
          return { nombre: f.name, ruta, tipo, tamano: f.size };
        })
      );
      setAdjuntos((a) => [...a, ...subidos]);
    } catch (err) {
      avisar('No se pudo adjuntar', err instanceof Error ? err.message : String(err));
    } finally {
      setSubiendo(false);
    }
  }

  function quitarAdjunto(ruta: string) {
    setAdjuntos((a) => a.filter((x) => x.ruta !== ruta));
    supabase.storage.from(BUCKET_ADJUNTOS).remove([ruta]);
  }

  function mandar(texto: string) {
    clearError();
    // Este toque es lo que habilita que la respuesta se escuche (iPhone/Chrome).
    if (vozActivada) desbloquearVoz();
    sendMessage({
      text: texto || 'Te adjunto esto.',
      metadata: adjuntos.length ? { adjuntos } : undefined,
    });
    setInput('');
    setAdjuntos([]);
  }

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    if ((!input.trim() && !adjuntos.length) || esperandoAprobacion || subiendo) return;
    // Si se envía mientras dicta, lo que falte reconocer ya no debe pisar el campo vacío.
    dictadoRef.current?.cancelar();
    mandar(input.trim());
  }

  function apagarManosLibres() {
    manosLibresRef.current = false;
    setManosLibres(false);
    dictadoRef.current?.cancelar();
  }

  /** Escucha una frase y la envía sola. Si no se dice nada, manos libres queda en pausa. */
  function escucharManosLibres() {
    if (!manosLibresRef.current || dictadoRef.current) return;
    let dicho = '';
    const dictado = iniciarDictado({
      continuo: false,
      alTexto: (texto) => {
        dicho = texto;
        setInput(texto);
      },
      alError: (mensaje, codigo) => {
        // Silencio o corte: se resuelve en alTerminar. Otro error apaga manos libres.
        if (codigo === 'no-speech' || codigo === 'aborted') return;
        apagarManosLibres();
        if (mensaje) avisar('Manos libres se apagó', mensaje);
      },
      alTerminar: () => {
        setEscuchando(false);
        dictadoRef.current = null;
        if (!manosLibresRef.current) return;
        if (dicho.trim()) {
          mandar(dicho.trim());
        } else {
          apagarManosLibres();
          notificar('Manos libres en pausa: no escuché nada.', 'info');
        }
      },
    });
    if (!dictado) {
      apagarManosLibres();
      return;
    }
    dictadoRef.current = dictado;
    setEscuchando(true);
  }

  function alternarManosLibres() {
    if (manosLibresRef.current) {
      apagarManosLibres();
      return;
    }
    if (!soportaDictado()) {
      avisar(
        'Sin manos libres en este navegador',
        'Tu navegador no reconoce voz. Probá con Chrome o Edge.'
      );
      return;
    }
    // Sin voz no hay manos libres: QIR tiene que responder en voz alta.
    setVozActivada(true);
    desbloquearVoz();
    detenerVoz();
    dictadoRef.current?.cancelar();
    manosLibresRef.current = true;
    setManosLibres(true);
    escucharManosLibres();
  }

  function alternarMicrofono() {
    if (escuchando) {
      dictadoRef.current?.detener();
      return;
    }
    if (!soportaDictado()) {
      avisar(
        'Sin dictado en este navegador',
        'Tu navegador no reconoce voz. Probá con Chrome o Edge, o usá el micrófono del teclado del celular.'
      );
      return;
    }

    // Lo dictado se suma a lo que ya estaba escrito, no lo reemplaza.
    const escrito = input.trim();
    const dictado = iniciarDictado({
      alTexto: (texto) => setInput(escrito ? `${escrito} ${texto}` : texto),
      alError: (mensaje) => {
        if (mensaje) avisar('No se pudo dictar', mensaje);
      },
      alTerminar: () => {
        setEscuchando(false);
        dictadoRef.current = null;
        campoRef.current?.focus();
      },
    });
    if (!dictado) return;
    dictadoRef.current = dictado;
    setEscuchando(true);
  }

  async function nuevaConversacion() {
    const seguro = await confirmar(
      '¿Empezamos de cero?',
      'Se borra el historial de esta conversación. Tus tareas y recordatorios quedan como están.',
      { si: 'Borrar historial', no: 'Seguir', peligro: true }
    );
    if (!seguro) return;
    detenerVoz();
    const { data } = await supabase.auth.getUser();
    const userId = data.user?.id;
    if (userId) {
      await supabase.from('conversaciones').delete().eq('user_id', userId);
      // Los archivos adjuntos se van con la conversación.
      const { data: archivos } = await supabase.storage
        .from(BUCKET_ADJUNTOS)
        .list(userId, { limit: 1000 });
      if (archivos?.length) {
        await supabase.storage
          .from(BUCKET_ADJUNTOS)
          .remove(archivos.map((a) => `${userId}/${a.name}`));
      }
    }
    setAdjuntos([]);
    setMessages([]);
    ultimoLeidoRef.current = null;
    setHojaAbierta(false);
  }

  async function cerrarSesion() {
    const seguro = await confirmar('¿Cerrar sesión?', 'Para volver vas a necesitar tu email y contraseña.', {
      si: 'Cerrar sesión',
    });
    if (!seguro) return;
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
      <button
        onClick={() => {
          if (vozActivada) {
            detenerVoz();
            apagarManosLibres();
          } else {
            desbloquearVoz();
          }
          setVozActivada((v) => !v);
        }}
        className={ENLACE}
      >
        {vozActivada ? 'silenciar voz' : 'activar voz'}
      </button>
      <button
        onClick={alternarManosLibres}
        aria-pressed={manosLibres}
        title="QIR te escucha sola después de cada respuesta"
        className={`${ENLACE} ${manosLibres ? 'font-medium text-[var(--teal)]' : ''}`}
      >
        {manosLibres ? 'apagar manos libres' : 'manos libres'}
      </button>
      <button onClick={cerrarSesion} className={ENLACE}>
        cerrar sesión
      </button>
    </>
  );

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] bg-[var(--paper)] text-[var(--ink)] md:grid-cols-[300px_1fr]">
      <header className="col-span-full flex items-center justify-between gap-4 border-b border-[var(--paper-line)] px-4 py-3 md:px-6 md:py-3.5">
        <h1 className="flex items-center">
          <Logo className="h-[18px] w-auto md:h-5" />
        </h1>
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
          <UbicacionDispositivo inicial={libretaInicial.ubicacion} />
        </div>
      </aside>

      <div className="grid min-h-0 grid-rows-[1fr_auto]">
        <main className="overflow-y-auto px-4 py-6 md:px-10 md:py-8">
          <div className="mx-auto flex max-w-[700px] flex-col gap-5">
            {messages.length === 0 && (
              <p className="fuente-editorial text-center italic text-[var(--ink-soft)]">
                Escribile algo a {NOMBRE} — por ejemplo, &quot;recordame entregar el informe el
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
                      {adjuntosDe(message).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {adjuntosDe(message).map((a) => (
                            <ChipAdjunto key={a.ruta} adjunto={a} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="border-l-2 border-[var(--rule)] pl-4 text-[15px] leading-relaxed">
                    {message.parts.map((part, i) => {
                      if (part.type === 'text') {
                        return <span key={i}>{sinSugerencias((part as any).text)}</span>;
                      }
                      if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
                        return <EtiquetaTarea key={i} toolPart={part} responder={addToolApprovalResponse} />;
                      }
                      return null;
                    })}
                    <Fuentes mensaje={message} />
                    {message.id === messages[messages.length - 1]?.id &&
                      status === 'ready' &&
                      !esperandoAprobacion && (
                        <RespuestasRapidas
                          mensaje={message}
                          onElegir={(texto) => {
                            dictadoRef.current?.cancelar();
                            mandar(texto);
                          }}
                        />
                      )}
                  </div>
                )}
              </div>
            ))}

            {error && (
              <div
                role="alert"
                className="border border-[var(--amber)] bg-[var(--amber-soft)] px-4 py-3 text-sm"
              >
                {/* Los errores del servidor ya vienen en texto claro (límite diario, sesión, etc.). */}
                {error.message.length < 300 && !error.message.startsWith('{')
                  ? error.message
                  : 'Algo falló al responder. Probá de nuevo en un momento.'}
              </div>
            )}

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
          {(adjuntos.length > 0 || subiendo) && (
            <div className="mx-auto mb-2 flex max-w-[700px] flex-wrap gap-1.5">
              {adjuntos.map((a) => (
                <ChipAdjunto key={a.ruta} adjunto={a} onQuitar={() => quitarAdjunto(a.ruta)} />
              ))}
              {subiendo && <span className="text-[13px] italic text-[var(--ink-soft)]">subiendo...</span>}
            </div>
          )}
          <div className="mx-auto flex max-w-[700px] items-center gap-3">
            <input ref={archivoRef} type="file" multiple hidden onChange={adjuntar} />
            <button
              type="button"
              onClick={() => archivoRef.current?.click()}
              disabled={subiendo || esperandoAprobacion}
              aria-label="Adjuntar archivos"
              title="Adjuntar archivos o imágenes"
              className="grid h-11 w-11 shrink-0 place-items-center border border-[var(--paper-line)] transition hover:border-[var(--rule)] disabled:opacity-40 md:h-10 md:w-10"
            >
              <IconoClip />
            </button>
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
              ref={campoRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                esperandoAprobacion
                  ? 'Primero confirmá o cancelá lo de arriba'
                  : escuchando
                    ? manosLibres
                      ? 'Te escucho (manos libres)...'
                      : 'Te escucho, hablá...'
                    : 'Escribí o usá el micrófono...'
              }
              className="min-w-0 flex-1 border-b border-[var(--paper-line)] bg-transparent px-1 py-2 text-base outline-none placeholder:text-[var(--ink-soft)] focus:border-[var(--ink)] md:text-[15px]"
            />
            <button
              type="submit"
              disabled={status !== 'ready' || esperandoAprobacion || subiendo}
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
            <UbicacionDispositivo inicial={libretaInicial.ubicacion} />
            <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-[var(--paper-line)] pt-3.5 text-sm text-[var(--ink-soft)]">
              {acciones}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
