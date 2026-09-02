// ──────────────────────────────────────────────────────────────────────────────
// lib/costeo-propio.ts — Qué cuesta mover una unidad PROPIA.
//
// De dónde sale: esta función vivía dentro de app/cotizador/page.tsx (1259 líneas de
// pantalla). Ahí calculaba bien, pero no la podía usar nadie más — y el costeo de un
// servicio de flota propia necesita exactamente la misma cuenta. Copiarla habría dado
// dos motores con la misma fórmula, que es peor que no tener ninguno: el día que
// divergen, nadie sabe cuál de los dos números creer.
//
// LO QUE ESTE MÓDULO NO HACE, A PROPÓSITO:
//
//   · No lee la base. Recibe los parámetros ya resueltos y devuelve números. Así se
//     puede probar sin Supabase y sin DOM (ver scripts/prueba-costeo.mts).
//   · No decide de dónde salen esos parámetros. El rendimiento medido de una placa, la
//     depreciación contable o el costo-empresa del conductor son cascadas que resuelve
//     quien tiene acceso a los datos, igual que `paxContratadoDe` en la liquidación.
//   · No redondea a soles. Redondear en cada renglón y volver a sumar da un total que
//     no coincide con la suma; se redondea al presentar.
//
// UNIDADES. `rendimiento` es km por galón (o por m³ en GNV) y los precios son por esa
// misma unidad. `mantenimiento_km` es soles POR KILÓMETRO; el resto de los fijos son
// anuales y se prorratean por `km_anio`. Mezclarlos es el error clásico de un costeo
// de flota y por eso los nombres lo dicen.
// ──────────────────────────────────────────────────────────────────────────────

/** El modelo de costos de un TIPO de unidad. Espejo de `parametros_costos`. */
export type ParametrosUnidad = {
  tipo_vehiculo: string;
  nombre: string;
  capacidad: number;
  usa_urea: boolean;
  consumo_urea_pct: number | null;
  /** Combustible principal y su rendimiento en km por galón (o m³). */
  tipo_combustible_1: string;
  rendimiento_1: number;
  /** Qué proporción del recorrido usa ese combustible. Un bimodal GLP/gasolina reparte. */
  pct_uso_1: number;
  tipo_combustible_2: string | null;
  rendimiento_2: number | null;
  pct_uso_2: number | null;
  n_neumaticos: number;
  costo_neumatico: number;
  vida_neumatico_km: number;
  /** Soles por kilómetro. */
  mantenimiento_km: number;
  valor_compra: number;
  /** Fracción del valor de compra que queda al final de la vida útil (0.20 = 20 %). */
  residual_pct: number;
  vida_util_anios: number;
  km_anio: number;
  seguro_anual: number;
  soat_anual: number;
  revision_semestral: number;
  permisos_anual: number;
  otros_fijos_mensual: number;
  /** Costo de un día de conductor. Ver `costoConductorDia` en la nota de abajo. */
  conductor_dia: number;
};

/** Precio por unidad de cada combustible: `{ "Diésel": 16.4, "UREA": 12.0 }`. */
export type PreciosCombustible = Record<string, number>;

/** Lo que cambia de un servicio a otro con la misma unidad. */
export type ViajeCosteado = {
  /** Kilómetros del recorrido. Sin esto no hay nada que calcular. */
  km: number;
  /** Días que la unidad y el conductor quedan ocupados. */
  dias: number;
  peajes: number;
  /** Cualquier otro costo directo del viaje que no tenga renglón propio. */
  otros: number;
  /** Pernocte de la unidad (playa, garaje). */
  pernocte: number;
  /** Viáticos del conductor. */
  viaticos: number;
  /**
   * Costo de UN día de conductor. Cuando se pasa, manda sobre `conductor_dia` del
   * parámetro: es el costo empresa real (planilla con gratificaciones, CTS, EsSalud y
   * SCTR, según el régimen laboral) o el importe del recibo por honorarios.
   * El parámetro sigue sirviendo mientras esa cascada no esté disponible.
   */
  costoConductorDia?: number | null;
  /**
   * Soles por kilómetro de depreciación. Cuando se pasa, manda sobre el cálculo con
   * `valor_compra`: es la depreciación CONTABLE de esa placa (activos_fijos), y usarla
   * hace que el costeo cuadre con el libro en vez de aproximarlo.
   */
  deprecKm?: number | null;
};

/** Porcentajes de la política comercial. Se pasan para poder cambiarlos sin tocar el motor. */
export type PoliticaCosteo = {
  /** Colchón sobre el costo del vehículo, por imprevistos. 0.05 = 5 %. */
  reservaPct: number;
  /** Gastos de estructura repartidos sobre el costo directo. 0.10 = 10 %. */
  overheadPct: number;
  igvPct: number;
};

export const POLITICA_DEFECTO: PoliticaCosteo = {
  reservaPct: 0.05,
  overheadPct: 0.10,
  igvPct: 0.18,
};

export type CostoUnidad = {
  // ── Costo del vehículo, todo por kilómetro ──
  costoCombustible: number;
  /** Va incluido dentro de `costoCombustible`; se publica aparte para poder mostrarlo. */
  costoUrea: number;
  costoNeumaticos: number;
  costoMantenimiento: number;
  costoDeprec: number;
  costoFijosKm: number;
  reserva: number;
  costoVehiculo: number;
  // ── Costo del servicio ──
  costoConductor: number;
  costoDirectos: number;
  costoDirectoTotal: number;
  overhead: number;
  /** Costo total del servicio, sin IGV y sin margen. Es la base para fijar el precio. */
  baseCosto: number;
  /** Soles por kilómetro del costo directo. El número comparable entre unidades. */
  costoKm: number;
  /** De dónde salió cada dato discutible, para poder mostrarlo. */
  fuentes: { conductor: "real" | "parametro"; depreciacion: "contable" | "parametro" };
};

/** Consumo de combustible en soles por kilómetro, con sus dos tipos y la urea. */
function combustiblePorKm(p: ParametrosUnidad, precios: PreciosCombustible): { comb: number; urea: number } {
  const precio1 = precios[p.tipo_combustible_1] || 0;
  // Un rendimiento en cero dividiría por cero: se trata como "no consume", no como infinito.
  const tramo1 = p.rendimiento_1 > 0 ? (precio1 / p.rendimiento_1) * p.pct_uso_1 : 0;
  const tramo2 =
    p.tipo_combustible_2 && p.rendimiento_2 && p.pct_uso_2
      ? ((precios[p.tipo_combustible_2] || 0) / p.rendimiento_2) * p.pct_uso_2
      : 0;
  // La urea solo aplica a los diésel Euro V/VI: se consume como fracción del combustible.
  // 3.785 = litros por galón, porque el rendimiento viene en km/galón y la urea se
  // compra por litro.
  const urea =
    p.usa_urea && p.tipo_combustible_1 === "Diésel" && p.rendimiento_1 > 0
      ? (1 / p.rendimiento_1) * 3.785 * (p.consumo_urea_pct || 0.04) * (precios["UREA"] || 0)
      : 0;
  return { comb: tramo1 + tramo2, urea };
}

/**
 * El costo de un servicio con unidad propia. Devuelve `null` cuando no hay km: sin
 * recorrido no hay nada que costear, y un cero se leería como "gratis".
 */
export function calcularCostoUnidad(
  p: ParametrosUnidad,
  precios: PreciosCombustible,
  viaje: ViajeCosteado,
  politica: PoliticaCosteo = POLITICA_DEFECTO
): CostoUnidad | null {
  const km = Number(viaje.km || 0);
  if (!p || km <= 0) return null;

  const { comb, urea } = combustiblePorKm(p, precios);
  const costoCombustible = (comb + urea) * km;
  const costoUrea = urea * km;

  const costoNeumaticos =
    p.vida_neumatico_km > 0 ? ((p.n_neumaticos * p.costo_neumatico) / p.vida_neumatico_km) * km : 0;
  const costoMantenimiento = p.mantenimiento_km * km;

  // La depreciación contable de ESA placa manda sobre la del parámetro: es la que ya
  // está asentada contra la cuenta 6811 y la que hace que el costeo cuadre con el libro.
  const deprecContable = viaje.deprecKm != null && viaje.deprecKm >= 0;
  const costoDeprec = deprecContable
    ? (viaje.deprecKm as number) * km
    : p.vida_util_anios > 0 && p.km_anio > 0
      ? ((p.valor_compra * (1 - p.residual_pct)) / (p.vida_util_anios * p.km_anio)) * km
      : 0;

  const fijosAnuales =
    p.seguro_anual + p.soat_anual + p.revision_semestral * 2 + p.permisos_anual + p.otros_fijos_mensual * 12;
  const costoFijosKm = p.km_anio > 0 ? (fijosAnuales / p.km_anio) * km : 0;

  const subVehiculo = costoCombustible + costoNeumaticos + costoMantenimiento + costoDeprec + costoFijosKm;
  const reserva = subVehiculo * politica.reservaPct;
  const costoVehiculo = subVehiculo + reserva;

  // El costo-empresa real del conductor manda sobre el parámetro. Ver ViajeCosteado.
  const conductorReal = viaje.costoConductorDia != null && viaje.costoConductorDia >= 0;
  const porDia = conductorReal ? (viaje.costoConductorDia as number) : p.conductor_dia;
  const costoConductor = porDia * Number(viaje.dias || 0);

  const costoDirectos = Number(viaje.peajes || 0) + Number(viaje.otros || 0);
  const costoDirectoTotal = costoVehiculo + costoConductor + costoDirectos;
  const overhead = costoDirectoTotal * politica.overheadPct;
  // Pernocte y viáticos entran DESPUÉS del overhead: son reembolsos de bolsillo, no
  // actividad que consuma estructura. Cargarles el 10 % los encarecería sin razón.
  const baseCosto = costoDirectoTotal + overhead + Number(viaje.pernocte || 0) + Number(viaje.viaticos || 0);

  return {
    costoCombustible,
    costoUrea,
    costoNeumaticos,
    costoMantenimiento,
    costoDeprec,
    costoFijosKm,
    reserva,
    costoVehiculo,
    costoConductor,
    costoDirectos,
    costoDirectoTotal,
    overhead,
    baseCosto,
    costoKm: costoDirectoTotal / Math.max(km, 1),
    fuentes: {
      conductor: conductorReal ? "real" : "parametro",
      depreciacion: deprecContable ? "contable" : "parametro",
    },
  };
}

// ── Del costo al precio ───────────────────────────────────────────────────────

/**
 * Precio de venta que deja el margen pedido. `margen` es sobre el PRECIO, no sobre el
 * costo: con 20 % el precio es costo/0.8, no costo × 1.2. Es la diferencia entre
 * ganar 20 % y ganar 16.7 %, y es un error que se comete todo el tiempo.
 */
export function precioConMargen(baseCosto: number, margen: number): number {
  if (margen >= 1) return 0;
  return baseCosto / (1 - margen);
}

export function conIgv(monto: number, igvPct = POLITICA_DEFECTO.igvPct): number {
  return monto * (1 + igvPct);
}

/** Los tres escenarios que el cotizador ofrece: mínimo, estimado y alto. */
export type EscenariosPrecio = {
  sinIgv: { min: number; est: number; alto: number };
  conIgv: { min: number; est: number; alto: number };
  /** Precio por asiento en el escenario estimado. Sirve para comparar contra la competencia. */
  precioPax: number;
};

export function escenariosPrecio(
  baseCosto: number,
  capacidad: number,
  margenes: { min: number; est: number; alto: number } = { min: 0.15, est: 0.20, alto: 0.25 },
  igvPct = POLITICA_DEFECTO.igvPct
): EscenariosPrecio {
  const sin = {
    min: precioConMargen(baseCosto, margenes.min),
    est: precioConMargen(baseCosto, margenes.est),
    alto: precioConMargen(baseCosto, margenes.alto),
  };
  const con = {
    min: conIgv(sin.min, igvPct),
    est: conIgv(sin.est, igvPct),
    alto: conIgv(sin.alto, igvPct),
  };
  return { sinIgv: sin, conIgv: con, precioPax: con.est / Math.max(capacidad || 1, 1) };
}
