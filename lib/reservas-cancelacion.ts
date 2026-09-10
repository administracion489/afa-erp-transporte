// lib/reservas-cancelacion.ts — QUÉ PASA CON EL DINERO CUANDO UN SERVICIO SE CANCELA.
// Motor PURO: sin React, sin DOM, sin fetch, sin BD (misma doctrina que lib/costeo-propio.ts
// y lib/radar/coherencia-voucher.ts). Recibe lo que va a quedar guardado y devuelve el plan.
//
// PROBLEMA. `supabase/reservas-05-falso-flete.sql` puso a salvo el dinero en el CIERRE: una
// cancelación vale S/ 0.00 y solo se paga con `falso_flete = true`. Pero el dinero no se
// escribe en el cierre, se escribe en /programacion — y ahí no había nada. Se cancelaba un
// servicio con S/ 664.41 de costo cargado y el importe se quedaba escrito, sin preguntar y
// sin forma de marcar el acuerdo desde esa pantalla (la casilla solo existía en
// /liquidaciones → ModalServicios, pestaña de pagar). El propio aviso de `avisosDe` decía
// "márcalo como falso flete" sobre una pantalla que no podía marcarlo.
//
// Y el importe huérfano no espera al cierre para hacer daño: `v_costo_servicio` y `v_egresos`
// leen `reservas.costo_proveedor` SIN preguntar si el servicio se prestó, así que infla el
// costo de esa unidad y desinfla el margen de sus servicios desde el minuto uno. La limpieza
// existía una pantalla más allá ("Poner en S/ 0.00" en /liquidaciones), o sea: el dato sucio
// nacía en el origen y se saneaba en la desembocadura, una vez al mes y si alguien lo notaba.
//
// ── LAS DOS REGLAS QUE NO SE TOCAN ───────────────────────────────────────────────────
//
// 1. EL IMPORTE, POR SÍ SOLO, NO AUTORIZA NADA. No se deduce el falso flete de
//    "cancelado + importe > 0". La razón es de negocio y está en CLAUDE.md: pagar de menos
//    lo reclama el proveedor y se corrige; pagar de más hay que pedir que lo devuelvan, y no
//    vuelve. Como el importe huérfano es JUSTO el que deja el descuido de cancelar sin
//    borrar el costo, deducirlo convertiría cada descuido en un pago.
//
// 2. MARCAR EL ACUERDO Y ESCRIBIR EL MONTO SON UN SOLO ACTO. El monto del avance se teclea
//    de nuevo (`montoAcordado`), NUNCA se hereda el que ya estaba: ese número es el del
//    servicio completo que no se prestó — se pagarían los S/ 664.41 enteros donde el acuerdo
//    eran S/ 120.
//
// ── EL CASO QUE PROHÍBE LIMPIAR A CIEGAS ─────────────────────────────────────────────
//
// Poner en S/ 0.00 todo tramo cancelado con importe sería una FUGA DE DINERO, y de las
// caras. AFA cobra UNA tarifa por el día (ida + retorno) y el importe vive en un solo tramo;
// además "qué tramo lleva el importe no es siempre la ida: es el que se prestó". Con la IDA
// CANCELADA por el cliente y el RETORNO PRESTADO, el día SÍ se factura y su tarifa está
// escrita en la ida caída. Borrarla ahí es borrar el cobro de un día que se trabajó, en
// silencio y sin que ninguna pantalla lo vuelva a mencionar.
//
// Por eso el plan solo limpia cuando el DÍA ENTERO se cayó —el mismo `diaCaido` de
// `avisosDe`—, y cuando el hermano sí corrió devuelve `importe_del_dia_vivo`: ahí no falta
// limpiar, falta MOVER el importe al tramo que se prestó, que es lo que ya dice `avisosDe`.

/** El otro tramo del día. Misma forma que `TramoHermano` de lib/reservas-pacto.ts. */
export type TramoCancelacion = {
  id?: number | null;
  codigo?: string | null;
  estado?: string | null;
  costo_proveedor?: number | null;
  precio_cliente?: number | null;
  falso_flete?: boolean | null;
} | null;

/** Qué se hace con el importe de un día que se cayó entero. */
export type DecisionCancelacion =
  /** El bus no salió: el importe se retira. Es el default y el lado reversible del error. */
  | "cero"
  /** El proveedor ya había salido y hay acuerdo por el avance: se paga lo pactado. */
  | "falso_flete";

export type CodigoCancelacion =
  /** El servicio no queda cancelado: no hay nada que decidir. */
  | "no_cancelada"
  /** Cancelado y sin importe cargado: ya está como tiene que estar. */
  | "sin_importe"
  /** Día caído con importe: hay que elegir qué pasa con esa plata. */
  | "decidir"
  /** Este tramo cae pero su hermano SÍ se prestó: el día se cobra y el importe se MUEVE. */
  | "importe_del_dia_vivo";

export type EntradaCancelacion = {
  /** El estado que va a QUEDAR guardado (el del formulario), no el que hay en la base. */
  estado?: string | null;
  /** El que va a quedar: la flota propia no tiene proveedor a quien pagarle un avance. */
  tipoAsignacion?: string | null;
  /** Importes que la fila tiene HOY. */
  costo?: number | string | null;
  precio?: number | string | null;
  /** ¿La fila ya trae la marca escrita? Se retira sola si el servicio deja de estar cancelado. */
  falsoFleteActual?: boolean | null;
  hermano?: TramoCancelacion;
  /** Lo que eligió el operador. Sin elegir → el default seguro. */
  decision?: DecisionCancelacion | null;
  /** Solo con `decision === "falso_flete"`. Se teclea de nuevo: jamás hereda el importe viejo. */
  montoAcordado?: number | string | null;
  /** Constancia obligatoria de por qué sale dinero por un viaje que no se prestó. */
  motivoAcuerdo?: string | null;
};

export type PlanCancelacion = {
  codigo: CodigoCancelacion;
  /** ¿La pantalla tiene que pedir una decisión? */
  pide: boolean;
  /** ¿Se puede ofrecer el acuerdo? Solo tercerizado. */
  ofreceFalsoFlete: boolean;
  decision: DecisionCancelacion;
  /** Lo que quedaría cargado y no se paga ni se cobra. */
  costoSuelto: number;
  precioSuelto: number;
  /** Columnas que hay que sumar al patch del guardado. `{}` = no toca nada. */
  patch: Record<string, unknown>;
  /** Motivo/nota del acta que corresponde a este patch. `null` = no lo impone. */
  motivo: string | null;
  nota: string | null;
  /** Texto que IMPIDE guardar. `null` = adelante. */
  bloqueo: string | null;
  /** Lo que va a pasar al guardar, para decirlo antes. "" = nada que anunciar. */
  resumen: string;
};

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * ¿Este estado es una cancelación? Mismo criterio que `seCayo` en lib/reservas-pacto.ts.
 * Se EXPORTA para que quien mezcle el plan en su patch decida con la misma definición: dos
 * ideas de "cancelada" a los dos lados del guardado es cómo se escribe un importe sobre un
 * servicio que la pantalla creía caído.
 */
export const esCancelacion = (estado?: string | null) =>
  ["cancelada", "anulada"].includes(String(estado ?? "").toLowerCase());

const seCayo = esCancelacion;

const soles = (n: number) => `S/ ${n.toFixed(2)}`;

const PLAN_VACIO: Omit<PlanCancelacion, "codigo" | "costoSuelto" | "precioSuelto"> = {
  pide: false, ofreceFalsoFlete: false, decision: "cero",
  patch: {}, motivo: null, nota: null, bloqueo: null, resumen: "",
};

/**
 * Qué hacer con el dinero de un servicio que se está cancelando (o que ya lo está).
 *
 * Determinista y sin efectos: la pantalla pinta `resumen`, respeta `bloqueo` y mezcla
 * `patch` en el guardado. Escribir sigue siendo cosa de `guardarReservas`.
 */
export function planDeCancelacion(e: EntradaCancelacion): PlanCancelacion {
  const costo = num(e.costo);
  const precio = num(e.precio);
  const base = { costoSuelto: costo, precioSuelto: precio };

  // ── El servicio NO queda cancelado ────────────────────────────────────────────────
  // Una marca de falso flete colgada sobre un servicio que volvió a prestarse no describe
  // nada y confundiría al siguiente que lo mire, así que se retira sola. Es la misma regla
  // que ya aplica ModalServicios (`ff = estado === "cancelada" && falso_flete`).
  if (!seCayo(e.estado)) {
    if (e.falsoFleteActual === true) {
      return {
        ...PLAN_VACIO, ...base, codigo: "no_cancelada",
        patch: { falso_flete: false, falso_flete_motivo: null },
        motivo: "correccion_carga",
        nota: "El servicio dejó de estar cancelado: se retira el acuerdo de falso flete.",
        resumen: "Se retirará la marca de falso flete: el servicio ya no está cancelado.",
      };
    }
    return { ...PLAN_VACIO, ...base, codigo: "no_cancelada" };
  }

  // ── El día NO se cayó entero: el importe es del día que SÍ se prestó ──────────────
  // No se ofrece limpiar nada. Ver la cabecera: borrar aquí es borrar el cobro de un día
  // trabajado. `avisosDe` ya dice lo que toca — mover el importe al tramo que corrió.
  const hermanoCayo = !e.hermano || seCayo(e.hermano.estado);
  if (!hermanoCayo) {
    return { ...PLAN_VACIO, ...base, codigo: "importe_del_dia_vivo" };
  }

  const ofreceFalsoFlete = String(e.tipoAsignacion ?? "") === "tercerizado";
  const yaMarcado = e.falsoFleteActual === true;

  // ── Día caído y sin nada cargado: ya está como tiene que estar ────────────────────
  if (costo <= 0 && precio <= 0 && !yaMarcado) {
    return { ...PLAN_VACIO, ...base, codigo: "sin_importe", ofreceFalsoFlete };
  }

  // ── Día caído CON importe: hay que decidir ────────────────────────────────────────
  // El default cae del lado del error reversible, igual que el `default false` de la
  // migración: sin decisión explícita, la cancelación vale S/ 0.00.
  const decision: DecisionCancelacion =
    e.decision === "falso_flete" && ofreceFalsoFlete ? "falso_flete" : "cero";

  if (decision === "falso_flete") {
    const monto = num(e.montoAcordado);
    const motivoAcuerdo = String(e.motivoAcuerdo ?? "").trim();
    const patch: Record<string, unknown> = {
      falso_flete: true,
      falso_flete_motivo: motivoAcuerdo || null,
      costo_proveedor: monto,
    };
    // Al cliente NO se le cobra la cancelación, pase lo que pase (decisión comercial de
    // AFA): el acuerdo del avance es entre AFA y el proveedor. Por eso el precio se retira
    // igual en esta rama, y no hay casilla que lo cambie.
    if (precio > 0) patch.precio_cliente = 0;

    const partes = [`Se pagará ${soles(monto)} al proveedor como falso flete`];
    if (precio > 0) partes.push(`y el precio al cliente pasará a ${soles(0)}`);
    return {
      ...PLAN_VACIO, ...base, codigo: "decidir", pide: true, ofreceFalsoFlete,
      decision, patch,
      // El porqué del pago vive en `falso_flete_motivo`, que es su constancia propia; el
      // motivo del acta describe el movimiento de plata de esta fila.
      motivo: "correccion_carga",
      nota: motivoAcuerdo ? `Falso flete acordado: ${motivoAcuerdo}` : null,
      bloqueo: motivoAcuerdo
        ? null
        : "Escribe por qué se le paga al proveedor un servicio que no se prestó: es la única "
          + "constancia que va a quedar de esa salida de dinero.",
      resumen: partes.join(" ") + ".",
    };
  }

  // ── Poner en S/ 0.00 ──────────────────────────────────────────────────────────────
  const patch: Record<string, unknown> = {};
  const partes: string[] = [];
  if (costo > 0) { patch.costo_proveedor = 0; partes.push(`el costo (${soles(costo)})`); }
  if (precio > 0) { patch.precio_cliente = 0; partes.push(`el precio (${soles(precio)})`); }
  if (yaMarcado) { patch.falso_flete = false; patch.falso_flete_motivo = null; }

  return {
    ...PLAN_VACIO, ...base, codigo: "decidir", pide: true, ofreceFalsoFlete, decision, patch,
    motivo: "correccion_carga",
    nota: "Servicio cancelado sin acuerdo de falso flete: se retira el importe que había quedado cargado.",
    resumen: partes.length
      ? `Se pondrá en S/ 0.00 ${partes.join(" y ")}: el servicio no se prestó.`
      : yaMarcado ? "Se retirará el acuerdo de falso flete." : "",
  };
}
