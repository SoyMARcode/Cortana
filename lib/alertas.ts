'use client';

import type { SweetAlertIcon, SweetAlertOptions } from 'sweetalert2';

/**
 * Alertas de QIR sobre SweetAlert2, vestidas con los tokens de la libreta
 * (ver .alerta-* en globals.css). SweetAlert2 se carga recién la primera vez
 * que se muestra una alerta, así no pesa en la carga inicial ni rompe el SSR.
 */
async function swal() {
  const { default: Swal } = await import('sweetalert2');
  return Swal.mixin({
    buttonsStyling: false,
    reverseButtons: true,
    customClass: {
      popup: 'alerta',
      title: 'alerta-titulo fuente-editorial',
      htmlContainer: 'alerta-texto',
      actions: 'alerta-acciones',
      confirmButton: 'alerta-boton alerta-boton-principal',
      denyButton: 'alerta-boton',
      cancelButton: 'alerta-boton',
      input: 'alerta-input',
      validationMessage: 'alerta-validacion',
    },
  });
}

/** Aviso con un solo botón. */
export async function avisar(titulo: string, texto?: string, icono: SweetAlertIcon = 'info') {
  const Swal = await swal();
  await Swal.fire({ title: titulo, text: texto, icon: icono, confirmButtonText: 'Entendido' });
}

export const avisarError = (titulo: string, texto?: string) => avisar(titulo, texto, 'error');
export const avisarExito = (titulo: string, texto?: string) => avisar(titulo, texto, 'success');

/** Pregunta sí/no. Devuelve true solo si la persona confirmó. */
export async function confirmar(
  titulo: string,
  texto: string,
  { si = 'Sí', no = 'Cancelar', peligro = false }: { si?: string; no?: string; peligro?: boolean } = {}
): Promise<boolean> {
  const Swal = await swal();
  const { isConfirmed } = await Swal.fire({
    title: titulo,
    text: texto,
    icon: peligro ? 'warning' : 'question',
    showCancelButton: true,
    confirmButtonText: si,
    cancelButtonText: no,
    focusCancel: peligro,
  });
  return isConfirmed;
}

/** Mensaje corto que aparece arriba y se va solo. */
export async function notificar(texto: string, icono: SweetAlertIcon = 'success') {
  const Swal = await swal();
  await Swal.fire({
    toast: true,
    position: 'top',
    icon: icono,
    title: texto,
    showConfirmButton: false,
    timer: 3200,
    timerProgressBar: true,
    customClass: { popup: 'alerta alerta-toast', title: 'alerta-toast-texto' },
  });
}

/** Acceso directo a SweetAlert2 ya vestido, para casos especiales. */
export async function alerta(opciones: SweetAlertOptions) {
  const Swal = await swal();
  return Swal.fire(opciones);
}
