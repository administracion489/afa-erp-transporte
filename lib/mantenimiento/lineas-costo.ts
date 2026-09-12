// lib/mantenimiento/lineas-costo.ts — Una orden de trabajo la pagan VARIOS bolsillos, y uno de
// ellos no es un bolsillo. Módulo PURO: no lee la base, no escribe nada.
//
// ══════════════════════════════════════════════════════════════════════════════
// LO QUE FALTABA, DICHO POR EL DUEÑO: «¿QUÉ PASA SI LOS MATERIALES LOS COMPRAMOS
// APARTE Y LA MANO DE OBRA EN UN TALLER TERCERO? ¿Y CUANDO TENGA MI MECÁNICO?»
//
// La OT tenía UN costo y UNA factura. Eso solo describe el caso «todo al mismo taller», que es
// el menos frecuente: lo normal es comprar el repuesto en un sitio, pagar la mano de obra en
// otro, y —el día que AFA tenga mecánico propio— no pagar mano de obra a nadie porque ya está
// en la planilla. Con un solo importe y un solo comprobante, esas tres realidades entraban
// como un número plano que nadie podía desglosar ni conciliar contra dos facturas distintas.
//
// Por eso un renglón de costo es ahora una LÍNEA con cuatro datos que no se deducen:
//   · QUÉ es          → `tipo`: material | mano_obra | servicio
//   · DE DÓNDE SALE   → `origen`: comprado | propio
//   · A QUIÉN         → `proveedor_id`
//   · CON QUÉ PAPEL   → `documento_compra_id`
// y las que hagan falta por orden: dos proveedores de repuestos, un taller y el mecánico de casa
// caben en la misma orden sin inventar una segunda OT.
//
// ══════════════════════════════════════════════════════════════════════════════
// `origen` NO ES UNA ETIQUETA: ES LO QUE DECIDE SI EL SOL ENTRA A `v_egresos`.
//
// La pregunta exacta que contesta es **¿salió plata de la caja POR ESTA ORDEN?**
//
//   · `comprado` → sí. Va a `mantenimiento.costo`, que es lo que publica `v_egresos`.
//   · `propio`   → no. La hora del mecánico de casa YA se pagó en la planilla, y el repuesto
//                  sacado del almacén YA se pagó cuando se compró. Meterlo en el egreso contaría
//                  el mismo sol dos veces — exactamente lo que evita `promoverGastos` de caja
//                  chica filtrando `gasto_id is null`.
//
// PERO NO ES GRATIS, Y AHÍ ESTÁ LA OTRA MITAD. Ese costo sí es real y sí es de ese vehículo: es
// `costo_imputado`, el mismo patrón que `v_utilidad_servicio` usa con los neumáticos y la
// depreciación. Se publica aparte de `costo_directo_real` y **entra al S/km medido de la
// categoría**. Si no entrara, el día que AFA contrate un mecánico el S/km medido BAJARÍA sin que
// el costo real haya bajado —solo se mudó a la planilla—, la columna «Medido» propondría ese
// número más barato y el precio ofertado de toda cotización de esa categoría bajaría con él.
// Un costo corto no se discute antes de vender: se descubre cuando el servicio ya se prestó.
//
// ══════════════════════════════════════════════════════════════════════════════
// EL COSTO DE LA HORA PROPIA SE RESUELVE POR CASCADA, Y CADA ESCALÓN DECLARA SU FUENTE
//
// Son los dos métodos que pidió el dueño, y son escalones del mismo camino, no una alternativa:
//   1 · el COSTO EMPRESA real del mecánico (sueldo + gratificaciones + CTS + EsSalud + SCTR,
//       `lib/costeo-conductor.ts`) repartido entre sus horas del mes — aritmética exacta sobre la
//       planilla, sin ruido de medición, así que manda;
//   2 · una TARIFA S/hora tecleada en la configuración del taller, para cuando el mecánico
//       todavía no está en planilla o no se quiere publicar su sueldo.
// Sin ninguna de las dos NO SE INVENTA UN NÚMERO: la línea sale sin valorizar y la pantalla dice
// cuál de los dos campos llenar. Un S/hora adivinado se multiplica por las horas de cada orden
// y termina moviendo el precio de venta de una categoría entera.
//
// LO QUE ESE NÚMERO ES, Y NO ES: es un PISO. Solo imputa las horas que alguien cargó a una
// orden; el resto del mes del mecánico (esperas, traslados, el taller barrido) no lo absorbe
// nadie. La misma advertencia que ya hace `mantenimiento-tipo.ts` sobre las órdenes que nunca se
// registraron. Afirmar lo contrario sería decir que el costo del taller cabe entero en las OT.
// ══════════════════════════════════════════════════════════════════════════════

import { costoEmpresaMes, type DatosConductor, type RegimenLaboral } from "@/lib/costeo-conductor";
import { totalDeOT, aCentimos, type ItemCosto, type TotalOT } from "./costo-ot";

/** Qué se pagó. No es decoración: separa el repuesto del trabajo en el desglose del taller. */
export type TipoLinea = "material" | "mano_obra" | "servicio";

/** ¿Salió plata de la caja POR ESTA ORDEN? Es lo único que decide si entra a `v_egresos`. */
export type OrigenLinea = "comprado" | "propio";

export const TIPOS_LINEA: { valor: TipoLinea; label: string; icono: string }[] = [
  { valor: "material",  label: "Repuesto o material", icono: "🔩" },
  { valor: "mano_obra", label: "Mano de obra",        icono: "🔧" },
  { valor: "servicio",  label: "Servicio del taller", icono: "🏭" },
];

export const ORIGENES_LINEA: { valor: OrigenLinea; label: string; ayuda: string }[] = [
  { valor: "comprado", label: "Comprado",      ayuda: "Salió plata por esta orden. Entra al egreso del vehículo y admite su factura." },
  { valor: "propio",   label: "Propio / casa", ayuda: "Ya estaba pagado (planilla o almacén). Cuenta para el costo por kilómetro, NO como egreso nuevo." },
];

export type LineaCosto = {
  id: number | string;
  concepto: string;
  tipo: TipoLinea;
  origen: OrigenLinea;
  /** El importe de la línea, SIN IGV — el mismo criterio que el costo de la orden. */
  monto: number;
  /** Solo en mano de obra propia: de dónde salió el monto. Se guardan para poder rehacerlo. */
  horas?: number | null;
  tarifa_hora?: number | null;
  proveedor_id?: number | null;
  documento_compra_id?: number | null;
  /** Cuando la línea nació del costo tecleado en un ítem del checklist. */
  checklist_ot_id?: number | null;
};

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

// ── El reparto de la orden ───────────────────────────────────────────────────

export type OrigenReparto =
  | "lineas"     // hay líneas de costo: mandan ellas
  | "items"      // no hay líneas, pero algún ítem del checklist lleva costo
  | "tecleado"   // ni líneas ni ítems: manda el total escrito a mano
  | "sin_dato";

export type RepartoOT = {
  /** Lo que salió de la caja por esta orden. Va a `mantenimiento.costo` → `v_egresos`. */
  desembolsado: number;
  /** Lo ya pagado por otra vía (planilla, almacén). NO es egreso; sí es costo del vehículo. */
  imputado: number;
  /** desembolsado + imputado. Lo que de verdad costó mantener esa unidad esta vez. */
  total: number;
  origen: OrigenReparto;
  lineasComprado: number;
  lineasPropio: number;
  /** Ítems del checklist con costo que ninguna línea representa: cuentan por su cuenta. */
  itemsSueltos: number;
  detalle: string;
};

/**
 * CUÁNTO COSTÓ LA ORDEN Y POR QUÉ DOS PUERTAS, CON UNA REGLA QUE IMPIDE PERDER DINERO.
 *
 * La itemización de una orden es el conjunto `líneas ∪ {ítems del checklist que ninguna línea
 * representa}`. Esa unión no es un adorno: es lo que evita el fallo caro.
 *
 * Sin ella, la cascada natural («si hay líneas, mandan las líneas») BORRARÍA en silencio los
 * costos ya tecleados en el checklist: alguien pone S/ 200 de repuesto en un ítem, agrega
 * después una línea de mano de obra de S/ 150, y el total de la orden pasa de S/ 200 a S/ 150.
 * Doscientos soles que desaparecen del egreso y del S/km sin un solo aviso — equivocarse hacia
 * abajo, el error que no vuelve. Una línea anclada a un ítem (`checklist_ot_id`) SUSTITUYE a ese
 * ítem y no se suma dos veces: un solo importe autoritativo por concepto, que es la regla de oro.
 *
 * El total tecleado solo manda cuando NO hay itemización de ninguna clase — la misma regla que
 * ya aplicaba `totalDeOT`, extendida. Y cuando no hay líneas, el resultado es **byte a byte** el
 * de antes: `totalDeOT` decide y todo cae del lado `comprado`, que es lo que significaba el
 * único número que existía.
 */
export function repartoDeOT(
  lineas: LineaCosto[],
  items: ItemCosto[],
  totalTecleado: number | null | undefined
): RepartoOT {
  const ls = lineas ?? [];
  const its = items ?? [];

  // Sin líneas, el comportamiento anterior intacto: lo decide `totalDeOT`, y todo es desembolso.
  if (!ls.length) {
    const t: TotalOT = totalDeOT(its, totalTecleado);
    return {
      desembolsado: t.total, imputado: 0, total: t.total,
      origen: t.origen === "items" ? "items" : t.origen === "tecleado" ? "tecleado" : "sin_dato",
      lineasComprado: 0, lineasPropio: 0, itemsSueltos: t.itemsConCosto,
      detalle: t.detalle,
    };
  }

  const anclados = new Set(
    ls.map(l => (l.checklist_ot_id == null ? null : String(l.checklist_ot_id))).filter(Boolean) as string[]
  );
  const sueltos = its.filter(
    i => i.costo !== null && i.costo !== undefined && Number.isFinite(Number(i.costo)) && !anclados.has(String(i.id))
  );

  const comprado = ls.filter(l => l.origen !== "propio");
  const propio = ls.filter(l => l.origen === "propio");

  const desembolsado = aCentimos(
    comprado.reduce((s, l) => s + n(l.monto), 0) + sueltos.reduce((s, i) => s + n(i.costo), 0)
  );
  const imputado = aCentimos(propio.reduce((s, l) => s + n(l.monto), 0));

  const partes = [`${comprado.length} línea(s) comprada(s)`];
  if (propio.length) partes.push(`${propio.length} de casa (no es egreso nuevo)`);
  if (sueltos.length) partes.push(`${sueltos.length} ítem(s) del checklist con costo propio`);

  return {
    desembolsado, imputado, total: aCentimos(desembolsado + imputado),
    origen: "lineas",
    lineasComprado: comprado.length, lineasPropio: propio.length, itemsSueltos: sueltos.length,
    detalle: partes.join(" · ") +
      (imputado > 0
        ? `. Al egreso del vehículo van S/ ${desembolsado.toFixed(2)}; los S/ ${imputado.toFixed(2)} de casa ya están pagados por otra vía y solo cuentan para el costo por kilómetro.`
        : "."),
  };
}

// ── La hora del mecánico de casa ─────────────────────────────────────────────

/** Horas de taller al mes con las que se reparte el costo empresa. 26 días × 8 h. */
export const HORAS_MES_DEFECTO = 208;

export type FuenteTarifa =
  | "costo_empresa"       // el sueldo real del mecánico repartido entre sus horas
  | "tarifa_configurada"  // el S/hora tecleado en la configuración del taller
  | "sin_tarifa";         // ninguna de las dos: NO se inventa un número

export type TarifaHora = {
  tarifa: number;
  fuente: FuenteTarifa;
  /** Cómo se llegó al número, para imprimirlo al lado. Nunca se redacta en la pantalla. */
  base: string;
  /** Qué falta llenar, cuando no hay tarifa. */
  falta: string | null;
};

export type InsumosManoObra = {
  /** Método 2: S/hora tecleado. Respaldo, no primera opción. */
  tarifa_hora: number | null;
  /** Método 1: los insumos del costo empresa del mecánico (mismo contrato que el conductor). */
  mecanico: DatosConductor | null;
  regimen: RegimenLaboral | null;
  /** Divisor del costo empresa. Sin valor, `HORAS_MES_DEFECTO`. */
  horas_mes: number | null;
};

/**
 * EL S/HORA DE LA CASA, CON SU FUENTE DECLARADA.
 *
 * Manda el **costo empresa** cuando se puede calcular, y esto es lo contrario de lo que decide
 * `decidirRendimiento` a propósito: allí lo medido puede venir inflado por un hueco de registro,
 * así que ante la duda mandaba el parámetro tecleado. Aquí no hay medición ni ruido — es
 * aritmética sobre la planilla, el costo exacto de esa hora. Una tarifa tecleada, en cambio, es
 * una opinión que envejece: se pone una vez y se queda mientras el sueldo sube.
 *
 * Sin ninguna de las dos devuelve `sin_tarifa` con la tarifa en 0 y NOMBRA qué llenar. No se
 * elige un S/hora «de mercado»: ese número multiplica las horas de cada orden y termina moviendo
 * el precio de venta de toda una categoría de flota.
 */
export function tarifaHoraMecanico(ins: InsumosManoObra): TarifaHora {
  const horasMes = Math.max(1, Math.round(n(ins.horas_mes) || HORAS_MES_DEFECTO));

  if (ins.mecanico && ins.regimen && n(ins.mecanico.sueldo_basico) > 0) {
    const mes = costoEmpresaMes(ins.mecanico, ins.regimen);
    if (!mes.falta && mes.total > 0) {
      return {
        tarifa: mes.total / horasMes,
        fuente: "costo_empresa",
        base: `${ins.regimen.nombre} · costo empresa S/ ${mes.total.toFixed(2)} al mes ` +
              `(${mes.factor.toFixed(2)}× el básico) ÷ ${horasMes} horas de taller`,
        falta: null,
      };
    }
  }

  const tecleada = n(ins.tarifa_hora);
  if (tecleada > 0) {
    return {
      tarifa: tecleada, fuente: "tarifa_configurada",
      base: `Tarifa de taller configurada: S/ ${tecleada.toFixed(2)} por hora. ` +
            `Con el sueldo del mecánico en la configuración, este número saldría de su costo empresa real.`,
      falta: null,
    };
  }

  return {
    tarifa: 0, fuente: "sin_tarifa", base: "",
    falta: "No hay con qué valorizar una hora propia. En /mantenimiento → Configuración, pon el " +
           "sueldo básico del mecánico (lo exacto) o una tarifa por hora del taller (lo aproximado).",
  };
}

export type ManoObraPropia = TarifaHora & {
  /** horas × tarifa, al céntimo. 0 cuando no hay tarifa. */
  monto: number;
  horas: number;
};

/**
 * Valoriza N horas de la casa. El monto se DERIVA de horas × tarifa y se guarda junto con sus dos
 * factores: sin ellos, un importe suelto no se puede rehacer ni explicar cuando el sueldo cambie.
 */
export function valorizarManoObraPropia(horas: number, ins: InsumosManoObra): ManoObraPropia {
  const h = Math.max(0, n(horas));
  const t = tarifaHoraMecanico(ins);
  return { ...t, horas: h, monto: t.falta ? 0 : aCentimos(h * t.tarifa) };
}

// ── Las facturas de la orden ─────────────────────────────────────────────────

export type FacturasOT = {
  /** Todos los comprobantes que cuelgan de la orden, sin repetir. */
  ids: number[];
  /**
   * El que puede representar a la orden en `mantenimiento.documento_compra_id`, que es ESCALAR.
   * Con dos facturas es `null` a propósito — ver abajo.
   */
  principal: number | null;
  detalle: string;
};

/**
 * QUÉ FACTURA REPRESENTA A LA ORDEN EN EL LIBRO, CUANDO HAY VARIAS.
 *
 * `mantenimiento.documento_compra_id` es una columna escalar de la fase 06 y `v_egresos` la
 * publica tal cual. Con el repuesto en una factura y la mano de obra en otra, **ninguna de las
 * dos representa a la orden**: poner una haría creer que la otra no existe, que es peor que no
 * poner ninguna. Así que con dos o más se deja en `null` y se NOMBRAN todas en pantalla.
 *
 * No se pierde nada por el lado fiscal: cada comprobante es una fila de `documentos_compra` con
 * su proveedor y su placa, se aprueba, entra a un lote y se concilia por su cuenta — y el propio
 * `v_egresos` declara que «documentos_compra se suma aparte».
 */
export function facturasDeOT(
  documentoDeLaOT: number | null | undefined, lineas: LineaCosto[]
): FacturasOT {
  const ids: number[] = [];
  const push = (v: unknown) => {
    const x = Number(v);
    if (Number.isInteger(x) && x > 0 && !ids.includes(x)) ids.push(x);
  };
  push(documentoDeLaOT);
  for (const l of lineas ?? []) push(l.documento_compra_id);

  if (!ids.length) return { ids, principal: null, detalle: "" };
  if (ids.length === 1) return { ids, principal: ids[0], detalle: "" };
  return {
    ids, principal: null,
    detalle: `Esta orden tiene ${ids.length} comprobantes. El libro de mantenimiento guarda uno solo, ` +
             `así que no guarda ninguno: elegir uno haría creer que los demás no existen. Cada factura ` +
             `se aprueba, se paga y se concilia por su cuenta en Cuentas por Pagar.`,
  };
}
