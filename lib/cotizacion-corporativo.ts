// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizacion-corporativo.ts — QUÉ imprime la plantilla corporativa de la cotización. Motor PURO.
//
// LA PLANTILLA CORPORATIVA SE DIBUJA EN DOS SITIOS, Y LOS DOS LEEN ESTE MODELO:
//  · el HTML de /cotizaciones (`htmlCorporativo` en lib/cotizacion-pdf.ts), que el navegador
//    imprime — 569 de 572 cotizaciones de los últimos 120 días usan esta plantilla;
//  · el PDF que arma el SERVIDOR para el traslado que cotiza la IA del CRM
//    (`dibujarPdfCorporativo` en lib/pdf-corporativo.ts, pdf-lib), que sale por WhatsApp.
// Antes eran dos dibujos con dos contenidos: el de la IA tenía su propio layout, y el dueño lo
// reportó como «no tiene el mismo formato de mi página de cotización». Dos motores que contestan
// «¿qué se imprime?» terminan contestando distinto; por eso aquí se decide TODO lo que se imprime
// —textos fijos con `t()`, filas, totales, cuentas, unidades y pie— y los dos solo deciden CÓMO.
//
// EL TEXTO SE GUARDA CRUDO (sin escapar). El HTML escapa donde ya escapaba; el PDF lo pasa por
// `aWinAnsi`. Los textos fijos del diccionario no llevan & < > " ' (la matriz lo comprueba), así
// que escapar una frase que mezcla un texto fijo y un dato da lo mismo que escapar solo el dato:
// por eso el HTML sale BYTE A BYTE igual que antes (scripts/prueba-cotizacion-pdf.mts).
//
// LO QUE SOLO LEE LA CORPORATIVA (y con su ausencia todo es lo de siempre):
//  · `fechaEmision` — la fecha de emisión YA en hora de Lima (el servidor corre en UTC);
//  · `validezHasta` — distinta de 30 días → «Válida hasta el …» (`corp_sub_hasta`): un traslado
//    vence en la fecha del servicio si llega antes, y «Válida 30 días» sería falso;
//  · `notaTotales` — una línea bajo la tabla (la de disponibilidad del traslado);
//  · `omitirListasVacias` — una lista de consideraciones vacía no se imprime, ni su título.
//
// LA POLÍTICA DE RESERVA, CAMBIOS Y CANCELACIÓN (`consid.reserva`, supabase/cotizaciones-06) es la
// cuarta lista y SOLO la imprime esta plantilla: en la hoja 2, después de las Consideraciones
// generales. Vacía, ausente o solo con líneas en blanco no se imprime NADA, ni su título (con o sin
// `omitirListasVacias`), así que una cotización o una plantilla sin ella sale como siempre.
//
// SU RESUMEN (`consid.reserva_resumen`, supabase/cotizaciones-08) la reemplaza SOLO con el enlace a
// las condiciones completas de la cotización (`enlaceCondiciones` de la entrada): se imprimen los
// puntos del resumen, el enlace y su QR (`matrizQr`, lib/qr-matriz.ts, los mismos módulos para el
// HTML y el PDF). Sin resumen o sin enlace, la política entera byte a byte (`politicaParaImprimir`,
// lib/condiciones-publicas.ts): nunca se esconde lo que mueve dinero.
// ──────────────────────────────────────────────────────────────────────────────

import type { AvisoPdf, ClientePdf, CotizacionPdf, EntradaPdfCot, ItemPdf, PlantillaPdfCfg } from "./cotizacion-pdf";
import {
  descripcionVehiculoPdf, etiquetaVehiculoPdf, partesPie, vehiculosDoc,
  type PartePie, type TipoPartePie, type VehiculoDoc, type VehiculoPDF,
} from "./pdf-chrome";
import { empresaConDefectos, cuentasUtiles, cuentasParaMoneda, monedaDeCuenta, type CuentaBancaria, type PerfilEmpresa } from "./empresa-perfil";
import { normalizarMoneda, revisarTipoCambio, totalesEnMoneda, simboloMoneda, type Moneda, type TotalesMoneda } from "./cotizacion-moneda";
import {
  normalizarIdioma, t, fmtFechaDoc, fmtImporte, fmtTipoCambio, considParaPdf, descripcionParaPdf,
  DEFAULT_CONSID_ES, type Idioma, type ConsidPdf, type CtxDescripcion,
} from "./cotizacion-idioma";
import { enlaceCondiciones, esEnlaceCondiciones, politicaParaImprimir, RUTA_CONDICIONES, SQL_RESUMEN_CONDICIONES, type ModoPolitica } from "./condiciones-publicas";
import { matrizQr, type MatrizQr } from "./qr-matriz";

export { descripcionVehiculoPdf, etiquetaVehiculoPdf, partesPie, vehiculosDoc };
export type { PartePie, TipoPartePie, VehiculoDoc, VehiculoPDF };
// El enlace a las condiciones vive en lib/condiciones-publicas.ts (sin dependencias: lo importa la
// página pública); se re-exporta aquí, que es donde lo buscan los demás módulos del PDF.
export { enlaceCondiciones, esEnlaceCondiciones, politicaParaImprimir, RUTA_CONDICIONES, SQL_RESUMEN_CONDICIONES, matrizQr };
export type { ModoPolitica, MatrizQr };

/**
 * El color de la plantilla corporativa. Fijo: la corporativa nunca leyó `color_primario` de la
 * plantilla (pendiente conocido) y el PDF del servidor imprime el mismo.
 */
export const COLOR_CORPORATIVO = "#0b315f";

const EMP = empresaConDefectos;

/** Lo mismo que `esc` hace con un valor antes de escaparlo: así «crudo + esc» = «esc» de antes. */
const s = (x: unknown): string => String(x ?? "");

/**
 * El número que se IMPRIME: el escrito a mano en `numero_cotizacion` o, si no hay, el id con ceros
 * a la izquierda. No hay correlativo propio: el buscador de /cotizaciones encuentra los dos.
 * Lo usan los PDF de /cotizaciones y el de traslados cotizados por la IA.
 */
export function numeroCotizacion(c: { id: number; numero_cotizacion?: string | null }): string {
  return c.numero_cotizacion || String(c.id).padStart(5, "0");
}

// ── 1. La base común de las cuatro plantillas ────────────────────────────────

// Los campos numéricos de items_json vienen de un jsonb que acepta texto: un string que no es
// número se imprimiría crudo en el HTML (y el PDF se escribe en el origen del ERP). Un número
// sigue tal cual (la salida no cambia); null/undefined también; lo demás pasa a 0.
function numPdf(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Lo que las cuatro plantillas derivan de la entrada, una sola vez. */
export type BaseCotizacionPdf = {
  /** La entrada con los ítems normalizados (`numPdf`) y `repr` resuelto. */
  e: EntradaPdfCot & { repr: string };
  cot: CotizacionPdf;
  idioma: Idioma;
  moneda: Moneda;
  tc: number | null;
  conIGV: boolean;
  tot: TotalesMoneda;
  consid: ConsidPdf;
  /** La descripción de cada ítem como se imprime (recompuesta en inglés si era la automática). */
  descs: string[];
  /** Cuántas descripciones escritas por una persona van sin traducir (solo en inglés). */
  descsTalCual: number;
  nomCl: string;
  nCot: string;
  ahora: Date;
};

export type ResultadoBase = { ok: true; base: BaseCotizacionPdf } | { ok: false; aviso: AvisoPdf };

/**
 * La base común. `ok: false` solo con dólares sin un tipo de cambio válido (`sin_tc`, que impide
 * el PDF): imprimir soles rotulados como dólares es el error caro.
 */
export function baseCotizacionPdf(entrada: EntradaPdfCot): ResultadoBase {
  const e0 = { ...entrada, items: entrada.items.map(it => ({ ...it, dias: numPdf(it.dias), cantidad: numPdf(it.cantidad), precio_unit: numPdf(it.precio_unit), descuento_pct: numPdf(it.descuento_pct) }) as ItemPdf) };
  const cot = e0.cot;
  const idioma = normalizarIdioma(e0.idioma ?? cot.idioma_pdf);
  const moneda = normalizarMoneda(e0.moneda ?? cot.moneda);
  const tcEntrada = e0.tipoCambio !== undefined ? e0.tipoCambio : cot.tipo_cambio;
  let tc: number | null = null;
  if (moneda === "USD") {
    const r = revisarTipoCambio(tcEntrada);
    if (r.codigo !== "ok") return { ok: false, aviso: { codigo: "sin_tc", bloquea: true, detalle: `No se puede generar el PDF en dólares: ${r.detalle}` } };
    tc = r.tc;
  }
  const conIGV = cot.incluye_igv !== false;
  const tot = totalesEnMoneda(e0.items, moneda, tc, conIGV)!;
  const consid = considParaPdf(e0.cfg ?? null, e0.consid ?? DEFAULT_CONSID_ES, idioma);
  const ctxDesc: CtxDescripcion | null = e0.tipoVehiculoNombre !== undefined || cot.tipo_vehiculo !== undefined
    ? { modo_servicio: cot.modo_servicio, tipo_vehiculo: cot.tipo_vehiculo, tipoNombre: e0.tipoVehiculoNombre ?? "" }
    : null;
  let descsTalCual = 0;
  const descs = e0.items.map(it => {
    const d = descripcionParaPdf(it.descripcion, ctxDesc, idioma);
    if (idioma === "en" && !d.recompuesta && String(it.descripcion ?? "").trim()) descsTalCual++;
    return d.texto;
  });
  const cliente = e0.cliente;
  return {
    ok: true,
    base: {
      e: { ...e0, repr: e0.repr ?? "" }, cot, idioma, moneda, tc, conIGV, tot, consid, descs, descsTalCual,
      nomCl: cliente?.tipo === "b2b" ? (cliente.empresa || cliente.nombre) : cliente?.nombre || "—",
      nCot: numeroCotizacion(cot),
      ahora: e0.ahora ?? new Date(),
    },
  };
}

// ── 2. Cuentas bancarias ─────────────────────────────────────────────────────

export type ResultadoCuentasCorp = { cuentas: CuentaBancaria[]; aviso: AvisoPdf | null };

/**
 * LAS CUENTAS QUE SE IMPRIMEN, desde la configuración (nunca un literal: mandaría el dinero a la
 * cuenta de otra empresa). Sin cuentas no se imprime el bloque.
 *
 * Por MONEDA: las declaradas en la moneda de la cotización y las sin declarar; NUNCA una declarada
 * en la otra (`cuentasParaMoneda`). Si con eso no queda ninguna, el bloque se omite y se avisa
 * `sin_cuenta_en_moneda`. Extraída de `buildCuentasHtml` (lib/cotizacion-pdf.ts), que la usa.
 */
export function cuentasCorporativo(cfg: PlantillaPdfCfg | null | undefined, empresa: PerfilEmpresa | null | undefined, moneda: Moneda = "PEN"): ResultadoCuentasCorp {
  if (cfg && cfg.mostrar_cuentas_bancarias === false) return { cuentas: [], aviso: null };
  let todas: CuentaBancaria[] = [];
  // `usar_bancos_propios` apagado —el caso normal— manda la ficha de la empresa.
  if (!cfg?.usar_bancos_propios) todas = EMP(empresa).cuentas;
  // Sin cuentas en la empresa se mira igual la plantilla (una base sin `empresa-02`).
  if (!todas.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = cfg as any;
    todas = cuentasUtiles([1, 2, 3].map(n => ({ banco: c?.[`banco_${n}_nombre`], cuenta: c?.[`banco_${n}_cuenta`], cci: c?.[`banco_${n}_cci`] })));
  }
  const utiles = cuentasParaMoneda(todas, moneda);
  if (!utiles.length) {
    const otra = todas.length > 0;
    return {
      cuentas: [],
      aviso: {
        codigo: "sin_cuenta_en_moneda", bloquea: false,
        detalle: otra
          ? `Las cuentas bancarias configuradas son de otra moneda: el PDF en ${moneda === "USD" ? "dólares" : "soles"} sale sin el bloque de cuentas. Agrega una cuenta en ${moneda === "USD" ? "dólares" : "soles"} (o sin moneda declarada) en Configuración → Perfil de la empresa.`
          : "No hay cuentas bancarias configuradas: el PDF sale sin el bloque de cuentas. Se agregan en Configuración → Perfil de la empresa.",
      },
    };
  }
  return { cuentas: utiles, aviso: null };
}

export type CuentaDoc = { banco: string; lineas: string[] };
export type CuentasDoc = { titulo: string; items: CuentaDoc[] };

/** El bloque de cuentas en texto crudo, o null sin cuentas. */
export function cuentasDoc(cuentas: CuentaBancaria[], idioma: Idioma = "es"): CuentasDoc | null {
  if (!cuentas.length) return null;
  return {
    titulo: t(idioma, "cuentas_titulo"),
    items: cuentas.map(c => {
      const m = monedaDeCuenta(c.moneda);
      const lineas: string[] = [];
      if (c.cuenta) lineas.push(`${t(idioma, "cuentas_cta")} ${s(c.cuenta)}`);
      if (c.cci) lineas.push(`${t(idioma, "cuentas_cci")} ${s(c.cci)}`);
      return { banco: `${s(c.banco)}${m ? " · " + simboloMoneda(m) : ""}`, lineas };
    }),
  };
}

// ── 3. Cronograma multidía e itinerario (anexo) ──────────────────────────────

export type FinCronograma = { tipo: "final" | "por_confirmar" | "cochera" | "pernocte"; hora: string; etiqueta: string };
export type FilaCronograma = { dia: string; fecha: string; ruta: { origen: string; destino: string } | null; salida: string; fin: FinCronograma };
export type CronogramaDoc = {
  titulo: string;
  encabezados: { dia: string; fecha: string; ruta: string | null; salida: string; fin: string };
  filas: FilaCronograma[];
};

/** El cronograma de un servicio de varios días, o null si no lo tiene. */
export function cronogramaDoc(cot: CotizacionPdf, idioma: Idioma = "es"): CronogramaDoc | null {
  const dias = cot.fechas_multidia_json; if (!dias?.length) return null;
  const T = (k: Parameters<typeof t>[1], v?: Record<string, string | number>) => t(idioma, k, v);
  const hasDestino = dias.some(d => d.destino_nombre?.trim());
  const filas = dias.map((d, i): FilaCronograma => {
    const esUltimo = i === dias.length - 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dd = d as any;
    const horaFin = s(dd.hora_fin ?? dd.hora_retorno ?? "");
    const tipoNoche = dd.tipo_noche ?? (horaFin ? "" : "pernocte");
    const fin: FinCronograma = esUltimo
      ? (horaFin ? { tipo: "final", hora: horaFin, etiqueta: T("cron_retorno_final") } : { tipo: "por_confirmar", hora: "", etiqueta: T("cron_por_confirmar") })
      : tipoNoche === "cochera"
        ? { tipo: "cochera", hora: horaFin, etiqueta: T("cron_cochera") }
        : { tipo: "pernocte", hora: horaFin, etiqueta: T("cron_pernocte") };
    return {
      dia: T("cron_dia_mayus", { n: s(d.dia) }),
      fecha: d.fecha ? fmtFechaDoc(d.fecha, idioma, "cronograma") : "—",
      ruta: hasDestino ? { origen: s(i === 0 ? cot.origen : (dias[i - 1].destino_nombre || "—")), destino: s(d.destino_nombre || "—") } : null,
      salida: s(d.hora_ida || "—"),
      fin,
    };
  });
  return {
    titulo: T("cron_titulo", { n: dias.length }),
    encabezados: { dia: T("cron_dia"), fecha: T("cron_fecha"), ruta: hasDestino ? T("cron_ruta") : null, salida: T("cron_salida"), fin: T("cron_fin") },
    filas,
  };
}

const ES_DIA = /^d[iíI][aA]\s*\d+/i;
const EN_DIA = /^day\s*\d+/i;

export type LineaItinerario =
  | { tipo: "vacia" }
  | { tipo: "dia"; texto: string }
  | { tipo: "hora"; hora: string; texto: string }
  | { tipo: "texto"; texto: string };

/** Las líneas del itinerario escrito: encabezado de día («Día N» o «Day N»), «HH:MM – texto», texto o vacía. */
export function lineasItinerario(texto: string): LineaItinerario[] {
  return texto.split("\n").map((l): LineaItinerario => {
    if (!l.trim()) return { tipo: "vacia" };
    if (ES_DIA.test(l.trim()) || EN_DIA.test(l.trim())) return { tipo: "dia", texto: l };
    const m = l.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.*)/);
    if (m) return { tipo: "hora", hora: m[1], texto: m[2] };
    return { tipo: "texto", texto: l };
  });
}

export type AnexoDoc = { rotulo: string; titulo: string; numero: string; cliente: string; fecha: string; lineas: LineaItinerario[] };

/** El anexo «Programa detallado» con el itinerario escrito, o null si no hay itinerario. */
export function anexoDoc(cot: CotizacionPdf, nomCl: string, nCot: string, idioma: Idioma = "es"): AnexoDoc | null {
  const texto = (cot.itinerario_texto || "").trim(); if (!texto) return null;
  return {
    rotulo: t(idioma, "anexo_1"), titulo: t(idioma, "anexo_programa"), numero: s(nCot), cliente: s(nomCl),
    fecha: cot.fecha_servicio ? fmtFechaDoc(cot.fecha_servicio, idioma, "larga_mayus") : "",
    lineas: lineasItinerario(texto),
  };
}

// ── 4. El documento corporativo ──────────────────────────────────────────────

/** Un trozo de texto de una fila: normal o en negrita. */
export type Segmento = { texto: string; negrita?: boolean };
/** Una fila de caja: «<b>ROTULO</b> valor». */
export type FilaDoc = { rotulo: string; segmentos: Segmento[] };
export type CajaDoc = { titulo: string; filas: FilaDoc[] };
export type FilaTablaDoc = { item: string; descripcion: string; dias: string; cantidad: string; punit: string; dscto: string; total: string };
export type ListaDoc = { titulo: string; items: string[] };
/** El enlace a las condiciones completas, en el modo `resumen`: rótulo, la URL y su QR (null si no se pudo armar). */
export type EnlaceCondicionesDoc = { rotulo: string; url: string; qr: MatrizQr | null };
/** La política de reserva: la lista que se imprime (la política o su resumen), el modo y el enlace. */
export type ReservaDoc = ListaDoc & { modo: ModoPolitica; enlace: EnlaceCondicionesDoc | null };

export type DocCorporativo = {
  idioma: Idioma;
  moneda: Moneda;
  /** `COLOR_CORPORATIVO`. */
  color: string;
  /** El título de la ventana del navegador (`<title>`). */
  tituloVentana: string;
  titulo: string;
  subtitulo: string;
  /** El logo del perfil tal cual (null = sin logo). El HTML cae al del bundle; el PDF del servidor no: pone el nombre. */
  logoUrl: string | null;
  /** El nombre que va en la tarjeta del logo cuando no hay logo (solo el PDF del servidor). */
  empresaNombre: string;
  cliente: CajaDoc;
  empresa: CajaDoc;
  detalle: { titulo: string; lugares: FilaDoc[]; asunto: FilaDoc | null; fechas: FilaDoc[] };
  cronograma: CronogramaDoc | null;
  tabla: { encabezados: [string, string, string, string, string, string, string]; filas: FilaTablaDoc[] };
  totales: { filas: { rotulo: string; valor: string; descuento?: boolean }[]; total: { rotulo: string; valor: string }; notas: string[] };
  /** Una línea bajo la tabla de totales (null = ninguna). */
  notaTotales: string | null;
  cuentas: CuentasDoc | null;
  anexo: AnexoDoc | null;
  pagina2: {
    titulo: string;
    caracteristicas: { titulo: string; vehiculos: VehiculoDoc[] } | null;
    /** Con 3+ ítems o 3+ unidades, las condiciones empiezan en otra hoja. */
    saltoAntesDeCondiciones: boolean;
    incluye: ListaDoc;
    noIncluye: ListaDoc;
    generales: ListaDoc;
    /**
     * La política de reserva, cambios y cancelación: sin líneas no se imprime (`reservaVisible`). En
     * `resumen`, `items` es el resumen y `enlace` lleva la URL y el QR de las condiciones completas.
     */
    reserva: ReservaDoc;
    /** Una lista vacía no se imprime, ni su título. */
    omitirVacias: boolean;
  };
  pie: PartePie[];
  /** Lo que no bloquea y conviene decir (hoy: `sin_cuenta_en_moneda`). */
  avisos: AvisoPdf[];
};

const RE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoValido = (x: unknown): string | null => {
  const v = s(x).trim();
  if (!RE_ISO.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
};
const sumarDias = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Los días de validez que dice el subtítulo de siempre (`corp_sub`). */
export const DIAS_VALIDEZ_CORP = 30;

/**
 * ¿El subtítulo dice «Válida hasta el …» en vez de «Válida 30 días»? Solo si se declara una
 * validez y NO es exactamente la emisión + 30 días (sin fecha de emisión que lo confirme, también:
 * no se afirma «30 días» de algo que no se pudo comprobar).
 */
export function usaValidezHasta(validezHasta: string | null | undefined, fechaEmision: string | null | undefined): string | null {
  const hasta = isoValido(validezHasta);
  if (!hasta) return null;
  const emision = isoValido(fechaEmision);
  return !emision || hasta !== sumarDias(emision, DIAS_VALIDEZ_CORP) ? hasta : null;
}

const fila = (rotulo: string, valor: unknown): FilaDoc => ({ rotulo, segmentos: [{ texto: s(valor) }] });
const filaNegrita = (rotulo: string, valor: unknown): FilaDoc => ({ rotulo, segmentos: [{ texto: s(valor), negrita: true }] });

/** El documento desde la base ya resuelta (lo usa `htmlCotizacion` sin volver a resolverla). */
export function docCorporativoDeBase(b: BaseCotizacionPdf): DocCorporativo {
  const { e, cot, idioma, tot, conIGV } = b;
  const { cliente, vehiculos, empresa } = e;
  const T = (k: Parameters<typeof t>[1], v?: Record<string, string | number>) => t(idioma, k, v);
  const money = (n: number) => fmtImporte(n, b.moneda, idioma);
  const emp = EMP(empresa);
  // Un servicio de solo ida no tiene punto ni hora de retorno: imprimirlos le promete al cliente
  // un tramo que no se cotizó. Sin tipo_servicio (cotizaciones antiguas) se conserva lo de antes.
  const soloIda = ["solo_ida", "fijo_solo_ida"].includes(cot.tipo_servicio || "");
  const anio = b.ahora.getFullYear();
  const emisionIso = isoValido(e.fechaEmision);
  const fechaDoc = emisionIso
    ? fmtFechaDoc(emisionIso, idioma, "corta")
    : cot.created_at ? fmtFechaDoc(cot.created_at, idioma, "corta") : fmtFechaDoc(b.ahora, idioma, "simple");
  const hasta = e.validezHasta !== undefined
    ? usaValidezHasta(e.validezHasta, emisionIso ?? (cot.created_at ? s(cot.created_at).slice(0, 10) : null))
    : null;
  const subtitulo = hasta ? T("corp_sub_hasta", { fecha: fechaDoc, hasta: fmtFechaDoc(hasta, idioma, "corta") }) : T("corp_sub", { fecha: fechaDoc });
  const fLarga = (iso: string) => fmtFechaDoc(iso, idioma, "larga_mayus");
  const sim = simboloMoneda(b.moneda);
  const rotDoc = cliente?.ruc ? T("rotulo_ruc") : T("rotulo_dni");

  const clienteBox: CajaDoc = {
    titulo: T("corp_datos_cliente"),
    filas: [
      fila(T("corp_cliente"), b.nomCl),
      fila(`${rotDoc}:`, cliente?.ruc || cliente?.dni || "—"),
      fila(T("corp_direccion"), cliente?.direccion || "—"),
      fila(T("corp_celular"), cliente?.telefono || "—"),
      fila(T("corp_atencion"), cot.atencion || cliente?.operativo_nombre || "—"),
    ],
  };
  const empresaBox: CajaDoc = {
    titulo: s(emp.nombre),
    filas: [
      fila(`${T("rotulo_ruc")}:`, emp.ruc),
      ...(e.repr ? [fila(T("corp_representante"), e.repr)] : []),
      fila(T("corp_email"), emp.email),
      fila(T("corp_telf"), emp.telefono),
    ],
  };

  const lugares = [fila(T("corp_origen"), cot.origen || "—"), fila(T("corp_destino"), cot.destino || "—")];
  if (!soloIda) lugares.push(fila(T("corp_retorno"), cot.punto_retorno || cot.origen || "—"));
  const fechas: FilaDoc[] = cot.fecha_retorno
    ? [
      fila(T("corp_fecha_ida"), cot.fecha_servicio ? fLarga(cot.fecha_servicio) : "_____________"),
      filaNegrita(T("corp_hora_ida"), cot.hora_ida || "_____"),
      fila(T("corp_fecha_retorno"), fLarga(cot.fecha_retorno)),
      filaNegrita(T("corp_hora_retorno"), cot.hora_retorno || "_____"),
    ]
    : [
      fila(T("corp_fecha"), cot.fecha_servicio ? fLarga(cot.fecha_servicio) : "_____________"),
      {
        rotulo: T("corp_horario"),
        segmentos: [
          { texto: `${T("corp_salida")} ` }, { texto: s(cot.hora_ida || "_____"), negrita: true },
          ...(soloIda ? [] : [{ texto: ` | ${T("corp_retorno_h")} ` }, { texto: s(cot.hora_retorno || "_____"), negrita: true }]),
        ],
      },
    ];

  const filasTabla = e.items.map((it, i): FilaTablaDoc => ({
    item: String(i + 1),
    descripcion: s(b.descs[i]),
    dias: String(it.dias),
    cantidad: String(it.cantidad),
    punit: money(tot.unitarios[i]),
    dscto: it.descuento_pct > 0 ? it.descuento_pct + "%" : "",
    total: money(tot.lineas[i]),
  }));

  const filasTot: DocCorporativo["totales"]["filas"] = [];
  if (conIGV) {
    filasTot.push({ rotulo: T("corp_subtotal"), valor: money(tot.subtotal) });
    if (tot.descuento > 0) filasTot.push({ rotulo: T("corp_descuento"), valor: `- ${money(tot.descuento)}`, descuento: true });
    filasTot.push({ rotulo: T("corp_igv"), valor: money(tot.igv) });
  }
  const notas: string[] = [];
  if (!conIGV) notas.push(T("no_incluye_igv"));
  if (b.moneda === "USD" && b.tc != null) notas.push(t(idioma, "tc_referencial", { tc: fmtTipoCambio(b.tc, idioma) }));

  const cuentas = cuentasCorporativo(e.cfg ?? null, empresa, b.moneda);
  // Con `omitirListasVacias` tampoco se imprime una línea en blanco dentro de una lista.
  const omitirVacias = e.omitirListasVacias === true;
  const lista = (xs: readonly unknown[]): string[] => (omitirVacias ? xs.map(s).filter(x => x.trim() !== "") : xs.map(s));
  const vehs = vehiculosDoc(vehiculos, idioma);
  // La política o su resumen: el resumen solo con el enlace a las condiciones completas.
  const pol = politicaParaImprimir({ politica: b.consid.reserva, resumen: b.consid.reserva_resumen, enlace: e.enlaceCondiciones });

  return {
    idioma, moneda: b.moneda, color: COLOR_CORPORATIVO,
    tituloVentana: T("cot_titulo_html", { n: b.nCot }),
    titulo: T("corp_titulo", { n: b.nCot, anio }),
    subtitulo,
    logoUrl: empresa?.logo_url || null,
    empresaNombre: s(emp.nombre),
    cliente: clienteBox,
    empresa: empresaBox,
    detalle: {
      titulo: T("corp_detalle"), lugares,
      asunto: cot.asunto ? fila(T("corp_asunto"), cot.asunto) : null,
      fechas,
    },
    cronograma: cronogramaDoc(cot, idioma),
    tabla: {
      encabezados: [T("corp_th_item"), T("corp_th_desc"), T("corp_th_dias"), T("corp_th_cant"), T("corp_th_punit", { m: sim }), T("corp_th_dscto"), T("corp_th_total", { m: sim })],
      filas: filasTabla,
    },
    totales: { filas: filasTot, total: { rotulo: T("corp_total_neto"), valor: money(tot.total) }, notas },
    notaTotales: s(e.notaTotales).trim() ? s(e.notaTotales).trim() : null,
    cuentas: cuentasDoc(cuentas.cuentas, idioma),
    anexo: anexoDoc(cot, b.nomCl, b.nCot, idioma),
    pagina2: {
      titulo: T("corp_unidad_cond"),
      caracteristicas: vehs.length
        ? { titulo: `${T("corp_caract")}${vehs.length > 1 ? T("vehiculos_n", { n: vehs.length }) : ""}`, vehiculos: vehs }
        : null,
      saltoAntesDeCondiciones: e.items.length >= 3 || vehs.length >= 3,
      incluye: { titulo: T("corp_incluye"), items: lista(b.consid.incluye) },
      noIncluye: { titulo: T("corp_no_incluye"), items: lista(b.consid.no_incluye) },
      generales: { titulo: T("corp_generales"), items: lista(b.consid.generales) },
      // Sin líneas en blanco nunca: una política vacía no imprime ni su título.
      reserva: {
        titulo: T("corp_reserva"), items: pol.items, modo: pol.modo,
        enlace: pol.modo === "resumen" && pol.enlace ? { rotulo: T("corp_reserva_enlace"), url: pol.enlace, qr: matrizQr(pol.enlace) } : null,
      },
      omitirVacias,
    },
    pie: partesPie(emp.direccion, emp.telefono, emp.email, emp.web, idioma),
    avisos: cuentas.aviso ? [cuentas.aviso] : [],
  };
}

/**
 * El documento corporativo de una cotización. LANZA con dólares sin un tipo de cambio válido (el
 * único caso sin documento): quien llama lo trata como «PDF no generado».
 */
export function docCorporativo(entrada: EntradaPdfCot): DocCorporativo {
  const r = baseCotizacionPdf(entrada);
  if (!r.ok) throw new Error(r.aviso.detalle);
  return docCorporativoDeBase(r.base);
}

/** ¿Se imprime esta lista? (con `omitirVacias`, una vacía no: ni su título). */
export const listaVisible = (l: ListaDoc, omitirVacias: boolean): boolean => !omitirVacias || l.items.length > 0;

/** ¿Se imprime la política de reserva? Solo con alguna línea (el HTML y el PDF del servidor leen esta). */
export const reservaVisible = (p2: Pick<DocCorporativo["pagina2"], "reserva">): boolean => (p2.reserva?.items.length ?? 0) > 0;

export type { ClientePdf };
