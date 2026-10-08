// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/saldo-cuenta.ts — Motor PURO del saldo de una cuenta de combustible
// PREPAGO (Primax Solutions, una tarjeta de flota de otro grifo…). No lee la base.
//
// EL PROBLEMA: AFA le deposita a Primax y Primax descuenta cada despacho. El portal de
// Primax sabe el saldo y no avisa cuando se acaba; el ERP no tiene API de Primax. Lo que
// el ERP SÍ tiene son las cargas, así que el saldo se DERIVA:
//
//     saldo = saldo leído del portal (ancla)  +  abonos posteriores  −  cargas posteriores
//
// Tres decisiones que sostienen el módulo:
//
// 1) EL ANCLA ES UNA LECTURA DEL PORTAL, NO UN SALDO INICIAL INVENTADO. Una persona abre
//    Primax, ve «Disponible S/ 5,392.76» y lo teclea. Desde ahí cuenta el ERP. Volver a
//    teclearlo cuando quiera corrige cualquier deriva (una carga que el ERP no registró,
//    un ajuste de Primax): la última lectura MANDA y lo anterior deja de contar.
//
// 2) LO QUE EL RADAR VIO Y NADIE CONFIRMÓ TAMBIÉN SE GASTÓ. Una carga en revisión en
//    /radar-ia ya salió de la cuenta aunque no esté en `combustible`. Se resta aparte
//    (`porConfirmar`) para que el saldo no salga inflado justo mientras alguien revisa —
//    y se publica separado, porque no es un dato confirmado.
//
// 3) ANTE LA DUDA, EL SALDO SALE MÁS BAJO, NUNCA MÁS ALTO. El error caro es el aviso
//    TARDE: el bus llega al grifo y la tarjeta rebota. Un aviso temprano cuesta un
//    depósito un día antes. Por eso una carga del MISMO día de la lectura cuenta si se
//    registró después de leer (puede que ya estuviera dentro del saldo del portal: si es
//    así, el saldo sale más bajo de lo real, que es el lado seguro).
//
// 4) SOLO DESCUENTA LO PROPIO (decisión del dueño, 08/10/2026). La cuenta prepago la usan las
//    unidades de AFA. El combustible de una unidad TERCERIZADA lo paga su dueño aunque cargue en
//    una estación Primax, y el ERP lo registra igual (rendimiento, odómetro): que salga del mismo
//    grifo no lo vuelve de la cuenta. El grifo dice DÓNDE se cargó; QUIÉN pagó lo dice la unidad,
//    y la unidad la dice el FK escrito (vehiculo_id XOR vehiculo_tercero_id), no un nombre.
//    Hasta esa fecha una casilla de la cuenta («las cargas de unidades tercerizadas también salen
//    de esta cuenta») permitía lo contrario; se retiró y `incluye_terceros` ya no se lee: no hay
//    configuración con la que una carga de tercero descuente.
//    Lo que no se puede afirmar propio TAMPOCO descuenta —una recarga del Radar sin unidad
//    identificada, una placa que figura en las DOS flotas—, y no es aflojar la regla 3: aquella
//    es la duda sobre CUÁNDO, ésta sobre DE QUIÉN, y el dueño contestó esa. Todo lo que no
//    descuenta se publica aparte, con su motivo (`cargasExcluidas`): un número sin su lista no
//    se puede cotejar, y una lista es lo único que deja ver si una unidad está mal fichada.
// ──────────────────────────────────────────────────────────────────────────────

export type CuentaCombustible = {
  id: number;
  nombre: string;
  /** Texto que identifica a los grifos de esta cuenta en `combustible.grifo`
   *  (p. ej. PRIMAX, COESTI — COESTI S.A. es la operadora de las estaciones Primax). */
  patrones_grifo: string[];
  /** RUC del vendedor (combustible.ruc_proveedor). Si coincide, pertenece aunque el
   *  nombre del grifo venga escrito de otra forma. */
  rucs: string[];
  /** Umbrales de aviso en soles, p. ej. [500, 300]. */
  umbrales: number[];
};

/** De qué flota es la unidad de una carga. Solo `propia` descuenta del saldo (regla 4). */
export type FlotaCarga = "propia" | "tercero" | "dos_flotas" | "sin_unidad";

export type Movimiento = {
  id: number;
  tipo: "abono" | "lectura";
  monto: number;          // abono: lo depositado · lectura: el saldo que dice el portal
  fecha: string;          // YYYY-MM-DD (Lima)
  creado_en: string;      // ISO — desempata el mismo día
};

export type CargaCuenta = {
  id: number | string;
  fecha: string;               // YYYY-MM-DD
  creado_en?: string | null;   // ISO (created_at)
  total: number;
  grifo?: string | null;
  ruc_proveedor?: string | null;
  /** De qué flota es la unidad (`unidadDeCarga`). Sin el dato no se sabe de quién es, y lo que
   *  no se puede afirmar propio no descuenta. */
  flota?: FlotaCarga;
  /** Lo que sigue solo sirve para ENSEÑAR la carga; no decide nada. */
  placa?: string | null;
  /** Serie-número de la factura a la que está enlazada, si alguna. */
  comprobante?: string | null;
};

// ── ¿Esta carga sale de esta cuenta? ─────────────────────────────────────────

export const normTexto = (s?: string | null) =>
  String(s ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

const soloDigitos = (s?: string | null) => String(s ?? "").replace(/\D/g, "");

/** El nombre del grifo CONTIENE el patrón como palabra(s) completa(s): «PRIMAX» casa con
 *  «GRIFO PRIMAX SAN LUIS», no con «PRIMAXIMO». Mismo criterio que el match del grifo del
 *  Radar: nunca un `includes` a secas. */
export function grifoCasa(grifo: string | null | undefined, patron: string): boolean {
  const g = ` ${normTexto(grifo)} `;
  const p = normTexto(patron);
  if (!p) return false;
  return g.includes(` ${p} `);
}

/** ¿La carga se hizo en un grifo de esta cuenta? Solo mira el GRIFO (RUC o nombre): dice
 *  dónde se cargó, no quién pagó. Si descuenta lo decide `juzgarCarga`. */
export function perteneceACuenta(c: CargaCuenta, cuenta: CuentaCombustible): boolean {
  const ruc = soloDigitos(c.ruc_proveedor);
  if (ruc && cuenta.rucs.some((r) => soloDigitos(r) === ruc)) return true;
  return cuenta.patrones_grifo.some((p) => grifoCasa(c.grifo, p));
}

/** Qué hace el saldo con una carga. Solo `descuenta` resta; los demás se enseñan aparte. */
export type MotivoCarga = "descuenta" | "otro_grifo" | "tercero" | "dos_flotas" | "sin_unidad";

export function juzgarCarga(c: CargaCuenta, cuenta: CuentaCombustible): MotivoCarga {
  if (!perteneceACuenta(c, cuenta)) return "otro_grifo";
  // Un `switch` sobre la flota, sin rama por defecto que descuente: un valor que no se conoce
  // (o ninguno) no es propio.
  switch (c.flota) {
    case "propia": return "descuenta";
    case "tercero": return "tercero";
    case "dos_flotas": return "dos_flotas";
    default: return "sin_unidad";
  }
}

/** Por qué una carga de un grifo de la cuenta NO descuenta. La pantalla y el correo dicen lo mismo. */
export const MOTIVO_NO_DESCUENTA: Record<Exclude<MotivoCarga, "descuenta" | "otro_grifo">, { corto: string; detalle: string }> = {
  tercero: {
    corto: "unidad tercerizada",
    detalle: "Es de una unidad tercerizada: su combustible lo paga su dueño, no la cuenta.",
  },
  dos_flotas: {
    corto: "placa en las dos flotas",
    detalle: "La placa figura vigente en Vehículos y en Tercerizadas, así que no se sabe de quién es. Marca como inactiva la ficha de la flota a la que ya no pertenece; mientras tanto no se descuenta.",
  },
  sin_unidad: {
    corto: "sin unidad identificada",
    detalle: "El Radar no supo de qué unidad es. Cuando se confirme con una unidad propia, se descuenta.",
  },
};

// ── ¿De qué flota es la unidad? ──────────────────────────────────────────────

const normPlaca = (p?: string | null) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const idNum = (v: unknown): number | null =>
  v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

/** La flota conocida, en la forma que necesita `unidadDeCarga`. Los ids de `vehiculos` y de
 *  `vehiculos_tercero` SE SOLAPAN (el 7 existe en las dos), así que van en mapas separados. */
export type FlotaConocida = {
  propias: Map<number, string>;
  terceros: Map<number, string>;
  /** Placas normalizadas de las fichas VIGENTES (estado ≠ inactivo). */
  vigentesPropias: Set<string>;
  vigentesTerceros: Set<string>;
  /** Todas las placas normalizadas, vigentes o no. */
  todasPropias: Set<string>;
  todasTerceros: Set<string>;
};

type FichaUnidad = { id: unknown; placa?: string | null; estado?: string | null };
const esVigente = (v: FichaUnidad) => String(v.estado ?? "").trim().toLowerCase() !== "inactivo";

export function flotaConocida(propias: FichaUnidad[], terceros: FichaUnidad[]): FlotaConocida {
  const f: FlotaConocida = {
    propias: new Map(), terceros: new Map(),
    vigentesPropias: new Set(), vigentesTerceros: new Set(), todasPropias: new Set(), todasTerceros: new Set(),
  };
  const cargar = (lista: FichaUnidad[], ids: Map<number, string>, vigentes: Set<string>, todas: Set<string>) => {
    for (const v of lista ?? []) {
      const id = idNum(v.id), p = normPlaca(v.placa);
      if (id != null && v.placa) ids.set(id, v.placa);
      if (!p) continue;
      todas.add(p);
      if (esVigente(v)) vigentes.add(p);
    }
  };
  cargar(propias, f.propias, f.vigentesPropias, f.todasPropias);
  cargar(terceros, f.terceros, f.vigentesTerceros, f.todasTerceros);
  return f;
}

/**
 * De qué flota es la unidad de una carga (de `combustible` o de `radar_combustible`).
 *
 * MANDA EL FK ESCRITO: una carga es de `vehiculo_id` XOR `vehiculo_tercero_id` (el CHECK
 * `combustible_una_flota`), y el FK de tercero gana si alguna fila trajera los dos. La placa solo
 * decide sola cuando no hay FK —una recarga del Radar que no encontró la unidad—, y tiene que casar
 * EXACTA con una ficha.
 *
 * SALVO QUE LA PLACA SEA DE UNA FICHA VIGENTE DE LA OTRA FLOTA. Pasa cuando una unidad cambió de
 * manos y la ficha vieja sigue donde estaba: el Radar y la factura buscan primero en la flota
 * propia, así que la carga del tercero que hoy opera un bus que fue de AFA entra con el FK propio.
 *   · la ficha del FK está inactiva y la de la otra flota vigente → es de la otra flota (la unidad
 *     ya cambió de manos; marcar inactiva la ficha que sobra es justo lo que hay que hacer);
 *   · las dos vigentes → `dos_flotas`: no se sabe de quién es, y no se descuenta hasta corregirlo.
 * Una ficha INACTIVA de la otra flota no disputa nada: es la de antes del cambio de manos.
 */
export function unidadDeCarga(
  c: { vehiculo_id?: unknown; vehiculo_tercero_id?: unknown; placa?: string | null },
  f: FlotaConocida,
): { flota: FlotaCarga; placa: string | null } {
  const idT = idNum(c.vehiculo_tercero_id), idP = idNum(c.vehiculo_id);
  const porFk: "propia" | "tercero" | null = idT != null ? "tercero" : idP != null ? "propia" : null;
  const placa = (idT != null ? f.terceros.get(idT) : idP != null ? f.propias.get(idP) : undefined) ?? c.placa ?? null;
  const p = normPlaca(placa);
  const vP = !!p && f.vigentesPropias.has(p), vT = !!p && f.vigentesTerceros.has(p);
  if (porFk) {
    const otraVigente = porFk === "propia" ? vT : vP;
    if (!otraVigente) return { flota: porFk, placa };
    const mismaVigente = porFk === "propia" ? vP : vT;
    return { flota: mismaVigente ? "dos_flotas" : porFk === "propia" ? "tercero" : "propia", placa };
  }
  if (!p) return { flota: "sin_unidad", placa: null };
  if (vP || vT) return { flota: vP && vT ? "dos_flotas" : vP ? "propia" : "tercero", placa };
  const aP = f.todasPropias.has(p), aT = f.todasTerceros.has(p);
  return { flota: aP && aT ? "dos_flotas" : aP ? "propia" : aT ? "tercero" : "sin_unidad", placa };
}

// ── El saldo ─────────────────────────────────────────────────────────────────

/** Una carga de un grifo de la cuenta, posterior a la lectura, que NO descuenta. */
export type CargaExcluida = CargaCuenta & {
  motivo: Exclude<MotivoCarga, "descuenta" | "otro_grifo">;
  /** true = recarga del Radar en revisión; false = registrada en `combustible`. */
  delRadar: boolean;
};

export type SaldoCuenta = {
  /** null = no hay ninguna lectura del portal: no se puede afirmar un saldo. */
  saldo: number | null;
  ancla: Movimiento | null;
  abonos: number;            // suma de abonos posteriores al ancla
  consumido: number;         // cargas PROPIAS registradas posteriores
  porConfirmar: number;      // cargas PROPIAS del Radar en revisión posteriores
  nCargas: number;
  nPorConfirmar: number;
  /** Consumo promedio por día (últimos `diasRitmo` días con al menos una carga propia). */
  consumoDiario: number | null;
  /** Días que alcanza el saldo al ritmo actual. */
  diasRestantes: number | null;
  /** Las cargas detrás de `consumido` y de `porConfirmar`, para enseñarlas. */
  cargasDescontadas: CargaCuenta[];
  cargasPorConfirmar: CargaCuenta[];
  /** Las de los grifos de la cuenta, posteriores a la lectura, que no descuentan (regla 4). */
  cargasExcluidas: CargaExcluida[];
};

/** ¿La carga ocurrió DESPUÉS de la lectura? Día posterior → sí. Mismo día → si se
 *  registró después de leer, o si no se sabe cuándo se registró (lado seguro). */
export function posteriorAlAncla(c: CargaCuenta, ancla: Movimiento): boolean {
  if (c.fecha > ancla.fecha) return true;
  if (c.fecha < ancla.fecha) return false;
  if (!c.creado_en) return true;
  return c.creado_en > ancla.creado_en;
}

const ordenMov = (a: Movimiento, b: Movimiento) =>
  a.fecha === b.fecha ? (a.creado_en < b.creado_en ? -1 : a.creado_en > b.creado_en ? 1 : a.id - b.id) : a.fecha < b.fecha ? -1 : 1;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function calcularSaldo(args: {
  cuenta: CuentaCombustible;
  movimientos: Movimiento[];
  cargas: CargaCuenta[];          // registradas en `combustible`
  porConfirmar?: CargaCuenta[];   // del Radar, sin registrar
  hoy: string;                    // YYYY-MM-DD Lima — no se calcula aquí (el servidor va en UTC)
  diasRitmo?: number;
}): SaldoCuenta {
  const { cuenta, hoy } = args;
  const diasRitmo = args.diasRitmo ?? 14;
  const movs = [...(args.movimientos ?? [])].sort(ordenMov);
  const lecturas = movs.filter((m) => m.tipo === "lectura");
  const ancla = lecturas.length ? lecturas[lecturas.length - 1] : null;

  const cargas = args.cargas ?? [];
  const radar = args.porConfirmar ?? [];
  const propias = cargas.filter((c) => juzgarCarga(c, cuenta) === "descuenta");
  const pend = radar.filter((c) => juzgarCarga(c, cuenta) === "descuenta");

  // Ritmo: no depende del ancla. Se mide sobre las cargas PROPIAS registradas de los últimos N
  // días: el de un tercero no gasta la cuenta, y contarlo acortaría los días que «alcanza».
  const desde = sumarDiasISO(hoy, -diasRitmo + 1);
  const ventana = propias.filter((c) => c.fecha >= desde && c.fecha <= hoy);
  const totalVentana = ventana.reduce((s, c) => s + (Number(c.total) || 0), 0);
  const consumoDiario = ventana.length ? r2(totalVentana / diasRitmo) : null;

  if (!ancla) {
    return {
      saldo: null, ancla: null, abonos: 0, consumido: 0, porConfirmar: 0,
      nCargas: 0, nPorConfirmar: 0, consumoDiario, diasRestantes: null,
      cargasDescontadas: [], cargasPorConfirmar: [], cargasExcluidas: [],
    };
  }

  const abonos = movs
    .filter((m) => m.tipo === "abono" && ordenMov(m, ancla) > 0)
    .reduce((s, m) => s + (Number(m.monto) || 0), 0);
  const posteriores = propias.filter((c) => posteriorAlAncla(c, ancla));
  const pendPost = pend.filter((c) => posteriorAlAncla(c, ancla));
  const consumido = posteriores.reduce((s, c) => s + (Number(c.total) || 0), 0);
  const porConfirmar = pendPost.reduce((s, c) => s + (Number(c.total) || 0), 0);
  const saldo = r2(Number(ancla.monto) + abonos - consumido - porConfirmar);

  // Lo que se cargó en un grifo de la cuenta después de la lectura y NO resta: se enseña con su
  // motivo, para que nadie tenga que adivinar si una carga de tercero se está descontando.
  const excluidas: CargaExcluida[] = [];
  for (const [lista, delRadar] of [[cargas, false], [radar, true]] as const) {
    for (const c of lista) {
      const m = juzgarCarga(c, cuenta);
      if (m === "descuenta" || m === "otro_grifo" || !posteriorAlAncla(c, ancla)) continue;
      excluidas.push({ ...c, motivo: m, delRadar });
    }
  }

  return {
    saldo,
    ancla,
    abonos: r2(abonos),
    consumido: r2(consumido),
    porConfirmar: r2(porConfirmar),
    nCargas: posteriores.length,
    nPorConfirmar: pendPost.length,
    consumoDiario,
    diasRestantes: consumoDiario && consumoDiario > 0 ? Math.max(0, Math.floor(saldo / consumoDiario)) : null,
    cargasDescontadas: posteriores,
    cargasPorConfirmar: pendPost,
    cargasExcluidas: excluidas,
  };
}

/** «No se descuentan: 2 carga(s) de unidades tercerizadas (S/ 412.10) · 1 sin unidad
 *  identificada (S/ 50.00).» — o null si no hay ninguna. La pantalla y el correo la comparten. */
export function fraseExcluidas(s: Pick<SaldoCuenta, "cargasExcluidas">): string | null {
  const ex = s.cargasExcluidas ?? [];
  if (!ex.length) return null;
  const orden: CargaExcluida["motivo"][] = ["tercero", "dos_flotas", "sin_unidad"];
  const partes = orden.flatMap((m) => {
    const de = ex.filter((c) => c.motivo === m);
    if (!de.length) return [];
    const total = de.reduce((t, c) => t + (Number(c.total) || 0), 0);
    const quien = m === "tercero" ? "de unidades tercerizadas" : m === "dos_flotas" ? "con la placa en las dos flotas" : "sin unidad identificada";
    return [`${de.length} carga(s) ${quien} (${fmt(r2(total))})`];
  });
  return `No se descuentan: ${partes.join(" · ")}.`;
}

/**
 * Lo único de las excluidas que merece un aviso: una carga que NO descuenta pero viene en una
 * FACTURA de la cuenta (la que el correo de facturas concilió). La regla del dueño es que de la
 * cuenta solo cargan las unidades propias; si una carga de tercero aparece facturada a la empresa,
 * o el portal ya la cobró —y el saldo del ERP sale más alto que el real, el lado caro— o la unidad
 * está mal fichada. No se descuenta igual: se DICE, y la lectura del portal lo corrige.
 */
export function avisoExcluidasEnFactura(s: Pick<SaldoCuenta, "cargasExcluidas">): string | null {
  const ex = (s.cargasExcluidas ?? []).filter((c) => !c.delRadar && !!c.comprobante);
  if (!ex.length) return null;
  const total = ex.reduce((t, c) => t + (Number(c.total) || 0), 0);
  const quien = ex.length === 1 ? "Una de las que no se descuentan viene" : `${ex.length} de las que no se descuentan vienen`;
  return `${quien} en una factura de la cuenta (${fmt(r2(total))}): si se pagó con el saldo, el portal ya la cobró — ` +
    `vuelve a leer el saldo del portal y revisa de quién es esa unidad.`;
}

export function sumarDiasISO(fecha: string, dias: number): string {
  const d = new Date(fecha + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ── ¿Hay que avisar? ─────────────────────────────────────────────────────────
//
// Un aviso por ESCALÓN y por ciclo, no uno por hora. `ultimo` es el umbral más bajo ya
// avisado en el ciclo actual (null = nada avisado). El ciclo se rearma cuando el saldo
// vuelve a subir por encima del umbral más alto (o sea: alguien depositó).
//
//   saldo 480 con [500, 300] → avisa 500. Una hora después 470 → nada (ya avisado).
//   baja a 290 → avisa 300.   baja a −10 → avisa «agotado» (escalón 0).
//   depositan y sube a 2 000  → se rearma: el próximo 500 vuelve a avisar.

export type DecisionAviso = {
  /** Escalón a avisar ahora (0 = agotado), o null si no toca. */
  avisar: number | null;
  /** Valor a guardar como `ultimo` del ciclo. */
  nuevoUltimo: number | null;
  codigo: "sin_saldo" | "sin_umbrales" | "holgado" | "rearmado" | "ya_avisado" | "aviso" | "agotado";
};

export function umbralesValidos(u: unknown): number[] {
  const arr = Array.isArray(u) ? u : [];
  const nums = arr.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => b - a);
}

export function decidirAviso(saldo: number | null, umbralesRaw: unknown, ultimo: number | null): DecisionAviso {
  if (saldo == null) return { avisar: null, nuevoUltimo: ultimo, codigo: "sin_saldo" };
  const umbrales = umbralesValidos(umbralesRaw);
  // El agotamiento se avisa SIEMPRE, haya o no umbrales configurados: con la tarjeta en
  // cero el bus no carga, y eso no es una preferencia.
  const escalones = [...umbrales, 0];
  if (saldo > (umbrales[0] ?? 0)) {
    return ultimo == null
      ? { avisar: null, nuevoUltimo: null, codigo: umbrales.length ? "holgado" : "sin_umbrales" }
      : { avisar: null, nuevoUltimo: null, codigo: "rearmado" };
  }
  // El escalón más bajo que el saldo ya cruzó (saldo ≤ escalón).
  const cruzado = escalones.filter((e) => saldo <= e).pop()!;
  if (ultimo != null && cruzado >= ultimo) return { avisar: null, nuevoUltimo: ultimo, codigo: "ya_avisado" };
  return { avisar: cruzado, nuevoUltimo: cruzado, codigo: cruzado === 0 ? "agotado" : "aviso" };
}

const fmt = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** La frase del aviso. Vive aquí para que el correo, el WhatsApp y la pantalla digan lo mismo. */
export function textoAviso(cuenta: { nombre: string }, s: SaldoCuenta, escalon: number): { titulo: string; detalle: string } {
  const saldo = s.saldo ?? 0;
  const titulo = escalon === 0
    ? `⛔ ${cuenta.nombre}: saldo de combustible AGOTADO`
    : `⚠️ ${cuenta.nombre}: saldo de combustible bajo (${fmt(saldo)})`;
  const partes = [
    `Saldo estimado: ${fmt(saldo)}${escalon > 0 ? ` (aviso al bajar de ${fmt(escalon)})` : ""}.`,
  ];
  if (s.diasRestantes != null && s.consumoDiario) {
    partes.push(`Al ritmo de ${fmt(s.consumoDiario)}/día alcanza para ~${s.diasRestantes} día(s).`);
  }
  if (s.nPorConfirmar > 0) {
    partes.push(`Incluye ${fmt(s.porConfirmar)} de ${s.nPorConfirmar} carga(s) de unidades propias que el Radar vio y aún nadie confirmó.`);
  }
  partes.push(escalon === 0 ? "Recarga YA: las unidades no podrán abastecer." : "Programa la recarga del saldo.");
  return { titulo, detalle: partes.join(" ") };
}
