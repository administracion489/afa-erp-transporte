// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/fichador.ts — MOTOR PURO: ¿este empleado FICHA (marca asistencia con cámara en
// la sede) o no?
//
// Tres clases de empleado resuelven su asistencia distinto, y QUIÉN ficha tiene que decidirse
// en UN solo sitio: si el gate de la cámara lo contestara por su cuenta y el panel de RRHH por
// la suya, dos pantallas terminarían diciendo cosas contrarias de la misma persona (el bug del
// semáforo de puntualidad).
//   · El CONDUCTOR no ficha: su asistencia se DERIVA de los servicios del día
//     (lib/rrhh/asistencia-conductor.ts). Maneja en la calle, no hay cámara en sede para él.
//   · El personal de CAMPO con una ventana de autorización vigente marca LEJOS de la sede
//     (lib/rrhh/campo.ts → ventanaCampoVigente); tampoco ficha en sede.
//   · El resto ficha en sede SOLO si lo declara el opt-in autoritativo `marca_asistencia` del
//     perfil (empleado_perfil), que NACE en false.
//
// EL ADMIN NO ES UN CASO APARTE. La decisión del dueño es que el admin que ficha vive el mismo
// flujo que cualquiera, así que esta función NO lo exenta — ni siquiera recibe el rol. Exentar
// al admin aquí sería escribir "quién ficha" en dos sitios.
//
// PURO: sin base, sin red, sin reloj. Recibe la clase YA derivada (perfil-datos.ts), el opt-in,
// y si la ventana de campo está vigente AHORA (eso lo resuelve el llamador con
// ventanaCampoVigente, que sí mira el instante). Devuelve la decisión con un `codigo` DECLARADO.
// ──────────────────────────────────────────────────────────────────────────────

import type { ClaseFicha } from "./perfil-datos";

/** El porqué DECLARADO del veredicto. Cada código nombra la razón (y dónde cambiarla):
 *  `conductor_por_servicios` — su asistencia sale de los servicios del día, no de la cámara;
 *  `campo` — tiene una ventana de campo vigente: marca fuera de la sede;
 *  `ficha_en_sede` — el opt-in `marca_asistencia` está activo → SÍ ficha;
 *  `no_marca` — nada lo obliga a fichar (el opt-in nace en false). */
export type CodigoFichador =
  | "conductor_por_servicios" | "campo" | "ficha_en_sede" | "no_marca";

export type VeredictoFichador = { ficha: boolean; codigo: CodigoFichador };

/**
 * ¿Este empleado FICHA en sede? EN ESTE ORDEN (gana el primero que aplica):
 *   1. clase === "conductor"     → NO ficha (`conductor_por_servicios`): asistencia por servicios.
 *   2. campo_vigente === true     → NO ficha (`campo`): marca lejos de la sede.
 *   3. marca_asistencia === true  → SÍ ficha (`ficha_en_sede`): el opt-in lo declara.
 *   4. en cualquier otro caso     → NO ficha (`no_marca`): nada lo obliga.
 *
 * El ORDEN es parte de la regla: un conductor con el opt-in activo por error NO ficha (1 gana a
 * 3), y el personal de campo con ventana vigente tampoco (2 gana a 3). El admin no se exenta
 * aquí (el rol ni entra).
 */
export function debeFichar(e: {
  clase: ClaseFicha;
  marca_asistencia: boolean;
  campo_vigente: boolean;
}): VeredictoFichador {
  if (e.clase === "conductor") return { ficha: false, codigo: "conductor_por_servicios" };
  if (e.campo_vigente === true) return { ficha: false, codigo: "campo" };
  if (e.marca_asistencia === true) return { ficha: true, codigo: "ficha_en_sede" };
  return { ficha: false, codigo: "no_marca" };
}

/** Nombre del evento `window` que el frontend dispara al marcar ENTRADA, para desbloquear el
 *  gate de la cámara sin recargar la pantalla. */
export const EVENTO_ENTRADA_MARCADA = "afa:rrhh-entrada";
