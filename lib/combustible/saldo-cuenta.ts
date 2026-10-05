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
  /** Si las cargas de unidades TERCERIZADAS también salen de esta cuenta. */
  incluye_terceros: boolean;
  /** Umbrales de aviso en soles, p. ej. [500, 300]. */
  umbrales: number[];
};

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
  es_tercero?: boolean;
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

export function perteneceACuenta(c: CargaCuenta, cuenta: CuentaCombustible): boolean {
  if (c.es_tercero && !cuenta.incluye_terceros) return false;
  const ruc = soloDigitos(c.ruc_proveedor);
  if (ruc && cuenta.rucs.some((r) => soloDigitos(r) === ruc)) return true;
  return cuenta.patrones_grifo.some((p) => grifoCasa(c.grifo, p));
}

// ── El saldo ─────────────────────────────────────────────────────────────────

export type SaldoCuenta = {
  /** null = no hay ninguna lectura del portal: no se puede afirmar un saldo. */
  saldo: number | null;
  ancla: Movimiento | null;
  abonos: number;            // suma de abonos posteriores al ancla
  consumido: number;         // cargas registradas posteriores
  porConfirmar: number;      // cargas del Radar en revisión posteriores
  nCargas: number;
  nPorConfirmar: number;
  /** Consumo promedio por día (últimos `diasRitmo` días con al menos una carga). */
  consumoDiario: number | null;
  /** Días que alcanza el saldo al ritmo actual. */
  diasRestantes: number | null;
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

  const propias = (args.cargas ?? []).filter((c) => perteneceACuenta(c, cuenta));
  const pend = (args.porConfirmar ?? []).filter((c) => perteneceACuenta(c, cuenta));

  // Ritmo: no depende del ancla. Se mide sobre las cargas registradas de los últimos N días.
  const desde = sumarDiasISO(hoy, -diasRitmo + 1);
  const ventana = propias.filter((c) => c.fecha >= desde && c.fecha <= hoy);
  const totalVentana = ventana.reduce((s, c) => s + (Number(c.total) || 0), 0);
  const consumoDiario = ventana.length ? r2(totalVentana / diasRitmo) : null;

  if (!ancla) {
    return {
      saldo: null, ancla: null, abonos: 0, consumido: 0, porConfirmar: 0,
      nCargas: 0, nPorConfirmar: 0, consumoDiario, diasRestantes: null,
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
  };
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
    partes.push(`Incluye ${fmt(s.porConfirmar)} de ${s.nPorConfirmar} carga(s) del Radar aún sin confirmar.`);
  }
  partes.push(escalon === 0 ? "Recarga YA: las unidades no podrán abastecer." : "Programa la recarga del saldo.");
  return { titulo, detalle: partes.join(" ") };
}
