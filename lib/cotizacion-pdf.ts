// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizacion-pdf.ts — El HTML del PDF de la cotización, las cuatro plantillas. Motor PURO.
//
// Estaba dentro de app/cotizaciones/page.tsx como cuatro funciones que abrían una ventana y
// escribían en ella, así que no se podía generar ni comparar fuera del navegador. Aquí devuelven
// el HTML y la pantalla lo escribe (`win.document.write(html)`). En español y en soles el
// resultado es BYTE A BYTE el de antes (scripts/prueba-cotizacion-pdf.mts compara contra los
// generadores viejos copiados literal), salvo tres divergencias DECLARADAS:
//
//  1. La plantilla ejecutiva ya no imprime la columna «USD ~» con `importe / 3.7`. Era un tipo de
//     cambio escrito en el código —falso casi todos los días— en un papel que el cliente firma.
//     Si se cotiza en dólares, la cotización lleva SU tipo de cambio y todo el documento va en US$.
//  2. Todo texto escrito por una persona (cliente, ruta, descripción, consideraciones, plantilla,
//     perfil de la empresa) pasa por `esc`: el documento se abre con document.write en el origen
//     del ERP, y un nombre con markup no puede entrar crudo. Sin < > & " ' no cambia nada.
//  3. El itinerario reconoce también `Day N` como encabezado de día (para el anexo en inglés).
//  4. Un color de la plantilla solo entra al CSS si es `#RRGGBB` (`colorCss`); si no, el del diseño.
//     `esc` no basta dentro de un `style`: «red;background:url(…)» no lleva < > & " ' y cambiaba el
//     documento. Con colores válidos (los que guarda el editor) no cambia nada.
//
// MONEDA: los ítems llegan SIEMPRE en soles (la fila autoritativa). En USD se convierten aquí con
// el tipo de cambio congelado de la cotización (`totalesEnMoneda`), se imprime una sola vez
// «Tipo de cambio referencial» y no se imprime ningún total en soles. Sin un TC válido NO hay PDF
// en dólares (`html: null` + aviso `sin_tc`): imprimir soles rotulados como dólares es el error caro.
//
// CONSIDERACIONES: con `consid.version = 2` la fila manda (las condiciones se copiaron de la
// plantilla al guardar, `considSnapshot` en lib/cotizacion-plantillas.ts); sin `version`, la regla
// de siempre (`considParaPdf`, lib/cotizacion-idioma.ts). Qué campos de la plantilla lee cada uno
// de los cuatro diseños lo declara `CAMPOS_POR_DISENO` (lib/cotizacion-plantillas.ts), y
// scripts/prueba-cotizacion-plantillas.mts lo comprueba contra este archivo con valores centinela:
// si un diseño empieza o deja de leer un campo, esa tabla se actualiza o la matriz falla.
// ──────────────────────────────────────────────────────────────────────────────

import { LOGO_DEFAULT, buildHeaderPDFHtml, buildFooterPDFHtml, pintarPieHtml, pintarVehiculosHtml, sharedCSS, buildVehsHtml, esc, type VehiculoPDF } from "./pdf-chrome";
import { empresaConDefectos, type PerfilEmpresa, type CuentaBancaria } from "./empresa-perfil";
import type { Moneda, TotalesMoneda } from "./cotizacion-moneda";
import { t, fmtFechaDoc, fmtImporte, fmtTipoCambio, esConsidFijada, type Idioma, type ClaveTexto, type ConsidCot, type ConsidFila } from "./cotizacion-idioma";
import {
  anexoDoc, baseCotizacionPdf, cronogramaDoc, cuentasCorporativo, cuentasDoc, docCorporativoDeBase, lineasItinerario, listaVisible, numeroCotizacion, reservaVisible,
  type AnexoDoc, type CajaDoc, type CronogramaDoc, type CuentasDoc, type DocCorporativo, type FilaDoc, type LineaItinerario, type Segmento,
} from "./cotizacion-corporativo";
import { SILENCIO_QR, TAMANO_QR_PX, type MatrizQr } from "./qr-matriz";

// El número que se imprime vive con el modelo corporativo (lib/cotizacion-corporativo.ts); aquí se
// re-exporta porque es donde lo buscan los demás módulos.
export { numeroCotizacion };

const EMP = empresaConDefectos;

/** Un color `#RRGGBB` (lo único que el editor de plantillas guarda como color). */
export function colorValido(x: unknown): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(String(x ?? "").trim());
}

/**
 * El color de la plantilla que se interpola en el CSS del documento: el escrito si es `#RRGGBB`; si
 * no (vacío, otro formato o texto con más CSS dentro), el del diseño. Ver la divergencia 4.
 */
export function colorCss(x: unknown, defecto: string): string {
  const t = String(x ?? "").trim();
  return colorValido(t) ? t : defecto;
}

export type FechaMultidiaPdf = {
  dia: number; fecha: string; hora_ida: string; destino_nombre: string;
  hora_fin?: string; hora_retorno?: string; tipo_noche?: string;
};
export type ParadaPdf = { nombre: string; tipo: string; hora?: string | null };
export type ItemPdf = { descripcion: string; dias: number; cantidad: number; precio_unit: number; descuento_pct: number };

/** Lo que el PDF lee de la cotización. La fila de `cotizaciones` es asignable tal cual. */
export type CotizacionPdf = {
  id: number;
  numero_cotizacion: string | null;
  origen: string; destino: string; km: number | null;
  atencion: string | null; asunto: string | null; punto_retorno: string | null;
  fecha_servicio: string | null; fecha_retorno: string | null;
  hora_ida: string | null; hora_retorno: string | null;
  tipo_servicio: string | null;
  incluye_igv: boolean | null;
  itinerario_texto: string | null;
  created_at: string;
  paradas_json?: ParadaPdf[] | null;
  fechas_multidia_json?: FechaMultidiaPdf[] | null;
  modo_servicio?: string | null;
  tipo_vehiculo?: string | null;
  /** De `cotizaciones-04`: sin la migración llegan ausentes y valen PEN / sin TC / español. */
  moneda?: string | null;
  tipo_cambio?: number | string | null;
  idioma_pdf?: string | null;
};

export type ClientePdf = {
  nombre: string; empresa?: string; tipo?: string; ruc?: string; dni?: string;
  direccion?: string; telefono?: string; operativo_nombre?: string;
};

export type PlantillaPdfCfg = {
  color_primario?: string | null; color_secundario?: string | null; color_acento?: string | null;
  titulo_documento?: string | null; subtitulo?: string | null; mensaje_cierre?: string | null;
  mostrar_cuentas_bancarias?: boolean | null; usar_bancos_propios?: boolean | null;
  condiciones_incluye?: string[] | null; condiciones_no_incluye?: string[] | null; condiciones_generales?: string[] | null;
  /** La política de reserva, cambios y cancelación (supabase/cotizaciones-06). Solo la lee la corporativa. */
  condiciones_reserva?: string[] | null;
  /**
   * Su resumen (supabase/cotizaciones-08): se COPIA a la fila al crear la cotización
   * (`considSnapshot`); al imprimir nunca se lee de la plantilla (el enlace abre la política de la fila).
   */
  condiciones_reserva_resumen?: string[] | null;
  banco_1_nombre?: string | null; banco_1_cuenta?: string | null; banco_1_cci?: string | null;
  banco_2_nombre?: string | null; banco_2_cuenta?: string | null; banco_2_cci?: string | null;
  banco_3_nombre?: string | null; banco_3_cuenta?: string | null; banco_3_cci?: string | null;
};

export type PlantillaPdf = "corporativo" | "moderno_fotos" | "turistico" | "ejecutivo";

export type EntradaPdfCot = {
  cot: CotizacionPdf;
  cliente?: ClientePdf;
  /** Los ítems EN SOLES, como están guardados. */
  items: ItemPdf[];
  vehiculos: VehiculoPDF[];
  /** Quién firma como representante. */
  repr?: string;
  /**
   * Las consideraciones de la cotización (las de la pantalla si se está editando). Con `version: 2`
   * (`CONSID_VERSION`, lib/cotizacion-idioma.ts) están FIJADAS: en español se imprimen ellas y no
   * las de la plantilla. Sin `version`, la regla de siempre.
   */
  consid?: ConsidFila;
  /**
   * El DISEÑO que dibuja el documento (`corporativo` | `moderno_fotos` | `turistico` | `ejecutivo`).
   * Desde las plantillas con uso, el id de la plantilla ya no es su diseño: quien llama pasa
   * `disenoDe(fila)` (lib/cotizacion-plantillas.ts). Un valor desconocido dibuja la corporativa.
   */
  plantilla?: PlantillaPdf | string;
  cfg?: PlantillaPdfCfg | null;
  empresa?: PerfilEmpresa | null;
  /** Por defecto, las de la cotización (`cot.moneda`, `cot.tipo_cambio`, `cot.idioma_pdf`). */
  moneda?: Moneda;
  tipoCambio?: number | string | null;
  idioma?: Idioma;
  /** El nombre de la ficha de costeo (`parametros_costos.nombre`), para reconocer la descripción automática. */
  tipoVehiculoNombre?: string | null;
  /** El instante de emisión (por defecto, ahora): la fecha del encabezado sale de aquí. */
  ahora?: Date;
  /**
   * SOLO LA CORPORATIVA (lib/cotizacion-corporativo.ts). Sin ellos, el documento de siempre.
   * `fechaEmision`: la fecha de emisión YA en hora de Lima (ISO) — en el servidor (UTC) la fecha de
   * `created_at` podría ser el día siguiente. `validezHasta`: distinta de emisión + 30 días →
   * «Válida hasta el …». `notaTotales`: una línea bajo la tabla. `omitirListasVacias`: una lista de
   * consideraciones vacía no se imprime (ni su título).
   */
  fechaEmision?: string | null;
  validezHasta?: string | null;
  notaTotales?: string | null;
  omitirListasVacias?: boolean;
  /**
   * SOLO LA CORPORATIVA. El enlace a las condiciones completas de ESTA cotización
   * (`enlaceCondiciones(base, cot.condiciones_token)`, lib/condiciones-publicas.ts). Con él y con un
   * resumen en `consid.reserva_resumen`, se imprimen el resumen, el enlace y su QR en lugar de la
   * política entera. Sin él (o sin resumen), la política entera, como siempre.
   */
  enlaceCondiciones?: string | null;
  /**
   * Las descripciones de los ítems YA están en el idioma del documento (las arma el código, como en
   * el traslado de la IA en inglés: lib/traslados/cotizacion-traslado.ts): no se cuentan como «escritas
   * tal cual» en el aviso `textos_escritos_tal_cual`. Sin él, el aviso de siempre.
   */
  itemsEnIdioma?: boolean;
};

/**
 * `cliente_no_verificado` solo lo agrega /cotizaciones al PDF de un traslado de la IA (components/cotizaciones/pdf-traslado.ts).
 * `condiciones_de_otra_plantilla` lo arma `avisoCondicionesDeOtraPlantilla` (lib/cotizacion-plantillas.ts):
 * la cotización tiene sus condiciones fijadas desde una plantilla y se imprime con OTRA.
 */
export type CodigoAvisoPdf = "sin_tc" | "sin_cuenta_en_moneda" | "plantilla_en_espanol" | "textos_escritos_tal_cual" | "cliente_no_verificado" | "condiciones_de_otra_plantilla";

export type AvisoPdf = { codigo: CodigoAvisoPdf; detalle: string; /** `sin_tc` impide el PDF. */ bloquea: boolean };

export type ResultadoPdf = { html: string | null; avisos: AvisoPdf[] };

// ── Helpers de anexo e itinerario ──────────────────────────────────────────────

export function formatItinerarioHtml(texto: string, cp: string, acento: string): string {
  return pintarItinerarioHtml(lineasItinerario(texto), cp, acento);
}

function pintarItinerarioHtml(lineas: LineaItinerario[], cp: string, acento: string): string {
  return lineas.map(l => {
    if (l.tipo === "vacia") return '<div style="height:5px;"></div>';
    if (l.tipo === "dia")
      return `<div style="margin:16px 0 8px;padding:8px 14px;background:${cp}18;border-left:4px solid ${cp};border-radius:0 8px 8px 0;font-size:13px;font-weight:900;color:${cp};">${esc(l.texto)}</div>`;
    if (l.tipo === "hora") return `<div style="display:flex;gap:12px;padding:5px 0;border-bottom:1px solid #f3f4f6;"><span style="font-size:10px;font-weight:900;color:${acento};min-width:42px;flex-shrink:0;padding-top:1px;">${l.hora}</span><span style="font-size:11px;">${esc(l.texto)}</span></div>`;
    return `<p style="margin:4px 0;font-size:11px;">${esc(l.texto)}</p>`;
  }).join("");
}

export function buildAnexoHtml(cot: CotizacionPdf, nomCl: string, nCot: string, cp: string, acento: string, idioma: Idioma = "es"): string {
  const a = anexoDoc(cot, nomCl, nCot, idioma);
  return a ? pintarAnexoHtml(a, cp, acento) : "";
}

function pintarAnexoHtml(a: AnexoDoc, cp: string, acento: string): string {
  const itHtml = pintarItinerarioHtml(a.lineas, cp, acento);
  return `<div style="page-break-before:always;padding:82px 40px 20px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid ${cp};padding-bottom:12px;margin-bottom:24px;">
      <div>
        <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1.5px;margin:0 0 4px;">${esc(a.rotulo)}</p>
        <h2 style="font-size:20px;font-weight:900;color:${cp};margin:0;">${esc(a.titulo)}</h2>
      </div>
      <div style="text-align:right;">
        <p style="font-size:10px;color:#6b7280;margin:0 0 2px;">N° ${esc(a.numero)}</p>
        <p style="font-size:12px;font-weight:800;color:${cp};margin:0;">${esc(a.cliente)}</p>
        ${a.fecha ? `<p style="font-size:10px;color:#6b7280;margin:2px 0 0;">${esc(a.fecha)}</p>` : ""}
      </div>
    </div>
    <div>${itHtml}</div>
  </div>`;
}

export function buildCronogramaMultidiaPDF(cot: CotizacionPdf, cp: string, idioma: Idioma = "es"): string {
  const c = cronogramaDoc(cot, idioma);
  return c ? pintarCronogramaHtml(c, cp) : "";
}

function pintarCronogramaHtml(c: CronogramaDoc, cp: string): string {
  const hasDestino = c.encabezados.ruta != null;
  const rows = c.filas.map(d => {
    const horaFin = esc(d.fin.hora);
    const et = esc(d.fin.etiqueta);
    let finLabel = "";
    if (d.fin.tipo === "final") finLabel = `<b>⏰ ${horaFin}</b> <span style="color:#166534;font-size:9px;">${et}</span>`;
    else if (d.fin.tipo === "por_confirmar") finLabel = `<span style="color:#6b7280;font-size:9px;font-style:italic;">${et}</span>`;
    else if (d.fin.tipo === "cochera") { finLabel = horaFin ? `<b>⏰ ${horaFin}</b> <span style="color:#1d4ed8;font-size:9px;">${et}</span>` : `<span style="color:#1d4ed8;font-size:9px;">${et}</span>`; }
    else { finLabel = horaFin ? `<b>⏰ ${horaFin}</b> <span style="color:#b45309;font-size:9px;">${et}</span>` : `<span style="color:#b45309;font-size:9px;font-style:italic;">${et}</span>`; }
    const rutaLabel = hasDestino && d.ruta ? `<span style="color:#374151;">${esc(d.ruta.origen)}</span><span style="color:${cp};font-weight:900;"> → </span><span style="font-weight:700;">${esc(d.ruta.destino)}</span>` : "";
    return `<tr style="border-bottom:1px solid #f3f4f6;">
      <td style="text-align:center;font-weight:900;font-size:11px;color:${cp};padding:5px 8px;white-space:nowrap;">${esc(d.dia)}</td>
      <td style="padding:5px 8px;font-size:10px;font-weight:600;">${esc(d.fecha)}</td>
      ${hasDestino ? `<td style="padding:5px 8px;font-size:10px;">${rutaLabel}</td>` : ""}
      <td style="text-align:center;padding:5px 8px;font-size:10px;">⏰ ${esc(d.salida)}</td>
      <td style="padding:5px 8px;font-size:10px;">${finLabel}</td>
    </tr>`;
  }).join("");
  const colRuta = hasDestino ? `<th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${esc(c.encabezados.ruta)}</th>` : "";
  return `<div style="margin:12px 0 16px;background:#fafafa;border:1px solid ${cp}22;border-radius:10px;overflow:hidden;">
    <div style="background:${cp}12;padding:8px 14px;border-bottom:1px solid ${cp}22;">
      <p style="font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.8px;margin:0;">${esc(c.titulo)}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:${cp}08;">
        <th style="padding:4px 8px;text-align:center;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${esc(c.encabezados.dia)}</th>
        <th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${esc(c.encabezados.fecha)}</th>
        ${colRuta}
        <th style="padding:4px 8px;text-align:center;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${esc(c.encabezados.salida)}</th>
        <th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${esc(c.encabezados.fin)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── Cuentas bancarias ──────────────────────────────────────────────────────────

export type ResultadoCuentas = { html: string; aviso: AvisoPdf | null };

/**
 * EL BLOQUE DE CUENTAS BANCARIAS, armado desde la configuración (nunca un literal: mandaría el
 * dinero a la cuenta de otra empresa). Sin cuentas no se imprime el bloque.
 *
 * Por MONEDA: se imprimen las cuentas declaradas en la moneda de la cotización y las sin
 * declarar; NUNCA una declarada en la otra (`cuentasParaMoneda`). Si con eso no queda ninguna,
 * el bloque se omite y la pantalla recibe el aviso `sin_cuenta_en_moneda`.
 */
export function buildCuentasHtml(cfg: PlantillaPdfCfg | null | undefined, empresa: PerfilEmpresa | null | undefined, moneda: Moneda = "PEN", idioma: Idioma = "es"): ResultadoCuentas {
  const r = cuentasCorporativo(cfg, empresa, moneda);
  return { html: r.cuentas.length ? pintarCuentas(r.cuentas, idioma) : "", aviso: r.aviso };
}

export function pintarCuentas(cuentas: CuentaBancaria[], idioma: Idioma = "es"): string {
  const d = cuentasDoc(cuentas, idioma);
  return d ? pintarCuentasHtml(d) : "";
}

function pintarCuentasHtml(d: CuentasDoc): string {
  return `<div class="cuentas"><h3>${esc(d.titulo)}</h3><div class="cuentas-grid">${
    d.items.map(c => `<div class="cuenta-box"><div class="banco">${esc(c.banco)}</div>${c.lineas.map(l => `<p>${esc(l)}</p>`).join("")}</div>`).join("")
  }</div></div>`;
}

// ── Contexto común de las cuatro plantillas ────────────────────────────────────

type Ctx = {
  e: EntradaPdfCot;
  cot: CotizacionPdf;
  idioma: Idioma;
  moneda: Moneda;
  tc: number | null;
  T: (k: ClaveTexto, v?: Record<string, string | number>) => string;
  money: (n: number) => string;
  tot: TotalesMoneda;
  conIGV: boolean;
  descs: string[];
  consid: { incluye: string[]; no_incluye: string[]; generales: string[] };
  nomCl: string;
  nCot: string;
  ahora: Date;
  /** Texto escrito por la plantilla que sí se imprime (solo en español). */
  titulo: (porDefecto: string) => string;
  cierre: string | null;
  lineaTc: (estilo: string) => string;
};

function lineaTcHtml(c: { moneda: Moneda; tc: number | null; idioma: Idioma }, estilo: string): string {
  if (c.moneda !== "USD" || c.tc == null) return "";
  return `<p style="${estilo}">${t(c.idioma, "tc_referencial", { tc: fmtTipoCambio(c.tc, c.idioma) })}</p>`;
}

// ── Plantilla MODERNO ──────────────────────────────────────────────────────────

function htmlModerno(c: Ctx): string {
  const { e, cot, T, money, tot, conIGV } = c;
  const { cliente, vehiculos, cfg, empresa } = e;
  const { subtotal, igv, total } = tot;
  const nomCl = esc(c.nomCl), nCot = esc(c.nCot);
  const cp = colorCss(cfg?.color_primario, "#1a1a2e"); const cs = colorCss(cfg?.color_secundario, "#2f8ee9");
  const logoUrl = esc(empresa?.logo_url || LOGO_DEFAULT);
  const empTel = esc(EMP(empresa).telefono); const empEmail = esc(EMP(empresa).email);
  const empWeb = esc(EMP(empresa).web);
  const filasItems = e.items.map((it, i) => { const tf = tot.lineas[i]; return `<tr><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;">${i + 1}. ${esc(c.descs[i])}</td><td style="padding:10px 12px;text-align:center;border-bottom:1px solid #f0f0f0;">${T("dias_x_cant", { d: it.dias, c: it.cantidad })}</td><td style="padding:10px 12px;text-align:right;border-bottom:1px solid #f0f0f0;font-weight:700;color:${cp};">${money(tf)}</td></tr>`; }).join("");
  const inc = c.consid.incluye.map(i => `<li style="margin:4px 0;font-size:10px;color:#333;">${esc(i)}</li>`).join("");
  const noInc = c.consid.no_incluye.map(i => `<li style="margin:4px 0;font-size:10px;color:#333;">${esc(i)}</li>`).join("");
  const rotDoc = cliente?.ruc ? T("rotulo_ruc") + ": " + esc(cliente.ruc) : cliente?.dni ? T("rotulo_dni") + ": " + esc(cliente.dni) : "";
  return `<!DOCTYPE html><html lang="${c.idioma}"><head><meta charset="UTF-8"/><title>${T("cot_titulo_html", { n: nCot })}</title>
  <style>${sharedCSS()}</style>
  </head><body>
  ${buildHeaderPDFHtml(logoUrl, cp, c.titulo(T("mod_titulo")), `N° ${nCot} · ${fmtFechaDoc(c.ahora, c.idioma, "simple")} · ${T("valida_30")}`)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div style="background:#f8fafc;border-radius:12px;padding:16px;"><p style="font-weight:900;font-size:10px;color:${cp};text-transform:uppercase;margin:0 0 8px;letter-spacing:.8px;">${T("mod_cliente")}</p>
        <p style="font-weight:800;font-size:14px;margin:0;">${nomCl}</p><p style="color:#64748b;font-size:10px;margin:3px 0 0;">${rotDoc}${cot.atencion ? " · " + esc(cot.atencion) : ""}</p></div>
      <div style="background:#f8fafc;border-radius:12px;padding:16px;"><p style="font-weight:900;font-size:10px;color:${cp};text-transform:uppercase;margin:0 0 8px;letter-spacing:.8px;">${T("mod_servicio")}</p>
        <p style="font-weight:800;font-size:14px;margin:0;">${esc(cot.origen)} → ${esc(cot.destino)}</p><p style="color:#64748b;font-size:10px;margin:3px 0 0;">${cot.fecha_servicio ? fmtFechaDoc(cot.fecha_servicio, c.idioma, "larga_mayus") : T("fecha_a_coordinar")}${cot.hora_ida ? " · " + esc(cot.hora_ida) : ""}</p></div>
    </div>
    ${buildCronogramaMultidiaPDF(cot, cp, c.idioma)}
    ${vehiculos.length ? `<div style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:20px;"><p style="font-weight:900;font-size:10px;color:${cp};text-transform:uppercase;margin:0 0 12px;letter-spacing:.8px;">${T("mod_unidad")}${vehiculos.length > 1 ? T("vehiculos_n", { n: vehiculos.length }) : ""}</p>${buildVehsHtml(vehiculos, cp, c.idioma === "en" ? { idioma: "en" } : undefined)}</div>` : ""}
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <thead><tr style="background:${cp};"><th style="padding:10px 12px;text-align:left;color:white;font-size:10px;font-weight:700;border-radius:8px 0 0 0;">${T("mod_th_desc")}</th><th style="padding:10px 12px;text-align:center;color:white;font-size:10px;font-weight:700;">${T("mod_th_cant")}</th><th style="padding:10px 12px;text-align:right;color:white;font-size:10px;font-weight:700;border-radius:0 8px 0 0;">${T("mod_th_total")}</th></tr></thead>
      <tbody>${filasItems}</tbody>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:24px;">
      <div style="background:#f8fafc;border-radius:12px;padding:16px;min-width:220px;">
        ${conIGV ? `<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:11px;"><span style="color:#64748b;">${T("mod_subtotal")}</span><span style="font-weight:700;">${money(subtotal)}</span></div><div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:11px;"><span style="color:#64748b;">${T("igv_18")}</span><span style="font-weight:700;">${money(igv)}</span></div>` : ""}
        <div style="display:flex;justify-content:space-between;border-top:2px solid ${cp};padding-top:10px;"><span style="font-weight:900;font-size:14px;color:${cp};">${T("total")}</span><span style="font-weight:900;font-size:14px;color:${cp};">${money(total)}</span></div>
        ${!conIGV ? `<p style="font-size:10px;color:#6b7280;margin:6px 0 0;text-align:right;">${T("no_incluye_igv")}</p>` : ""}${c.lineaTc("font-size:10px;color:#6b7280;margin:6px 0 0;text-align:right;")}
      </div>
    </div>
    ${e.items.length >= 3 || vehiculos.length >= 3 ? `<div style="page-break-before:always;height:70px;margin:0;"></div>` : ""}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
      <div><p style="font-weight:900;font-size:10px;color:#166534;text-transform:uppercase;margin:0 0 8px;">${T("mod_incluye")}</p><ul style="margin:0;padding-left:16px;">${inc}</ul></div>
      <div><p style="font-weight:900;font-size:10px;color:#991b1b;text-transform:uppercase;margin:0 0 8px;">${T("mod_no_incluye")}</p><ul style="margin:0;padding-left:16px;">${noInc}</ul></div>
    </div>
    ${c.cierre ? `<p style="text-align:center;color:#64748b;font-style:italic;font-size:11px;margin-bottom:24px;">${esc(c.cierre)}</p>` : ""}
  ${buildAnexoHtml(cot, c.nomCl, c.nCot, cp, cs, c.idioma)}
  ${buildFooterPDFHtml(cp, esc(empresa?.direccion || ""), empTel, empEmail, empWeb, c.idioma)}
  <script>window.onload=()=>window.print();</script></body></html>`;
}

// ── Plantilla TURÍSTICO ────────────────────────────────────────────────────────

function htmlTuristico(c: Ctx): string {
  const { e, cot, T, money, tot, conIGV } = c;
  const { vehiculos, cfg, empresa } = e;
  const { subtotal, igv, total } = tot;
  const nCot = esc(c.nCot);
  const cp = colorCss(cfg?.color_primario, "#b45309"); const cs = colorCss(cfg?.color_secundario, "#d97706");
  const logoUrl = esc(empresa?.logo_url || LOGO_DEFAULT);
  const empTel = esc(EMP(empresa).telefono); const empEmail = esc(EMP(empresa).email);
  const filasItems = e.items.map((it, i) => { const tf = tot.lineas[i]; return `<tr><td style="padding:8px 12px;border-bottom:1px solid #fde68a;">${esc(c.descs[i])}<br/><span style="font-size:9px;color:#92400e;">${T("tur_dias_unid", { d: it.dias, c: it.cantidad })}</span></td><td style="padding:8px 12px;text-align:right;border-bottom:1px solid #fde68a;font-weight:800;color:${cp};">${money(tf)}</td></tr>`; }).join("");
  const paradas = cot.paradas_json || []; const paradasHtml = paradas.length > 0 ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:14px;margin-bottom:16px;"><p style="font-weight:900;font-size:10px;color:${cp};text-transform:uppercase;margin:0 0 10px;">${T("tur_paradas")}</p>${paradas.map((p, i) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;"><div style="width:24px;height:24px;border-radius:50%;background:${cp};color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;flex-shrink:0;">${i + 1}</div><div><p style="font-weight:700;font-size:11px;margin:0;">${esc(p.nombre || p.tipo)}</p>${p.hora ? `<p style="font-size:10px;color:#92400e;margin:1px 0 0;">🕐 ${esc(p.hora)}</p>` : ""}</div></div>`).join("")}</div>` : "";
  return `<!DOCTYPE html><html lang="${c.idioma}"><head><meta charset="UTF-8"/><title>${T("tur_titulo_html", { n: nCot })}</title>
  <style>${sharedCSS()}</style>
  </head><body>
  ${buildHeaderPDFHtml(logoUrl, cp, c.titulo(T("tur_titulo")), `N° ${nCot} · ${T("valida_30")}`)}
    <div style="background:#fff7ed;border-left:4px solid ${cp};border-radius:0 10px 10px 0;padding:14px 18px;margin-bottom:18px;">
      <p style="font-weight:900;color:${cp};font-size:13px;margin:0 0 4px;">📍 ${esc(cot.origen)} → ${esc(cot.destino)}</p>
      <p style="color:#92400e;font-size:11px;margin:0;">${cot.hora_ida ? T("tur_salida") + esc(cot.hora_ida) : ""}${cot.km ? " · " + cot.km + " km" : ""}</p>
    </div>
    ${buildCronogramaMultidiaPDF(cot, cp, c.idioma)}
    ${vehiculos.length ? `<div style="margin-bottom:16px;">${buildVehsHtml(vehiculos, cp, { imgH: "180px", radius: "10px", gap: "10px", ...(c.idioma === "en" ? { idioma: "en" as const } : {}) })}</div>` : ""}
    ${paradasHtml}
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
      <thead><tr style="background:${cp};"><th style="padding:9px 12px;text-align:left;color:white;font-size:10px;font-weight:700;">${T("tur_th_desc")}</th><th style="padding:9px 12px;text-align:right;color:white;font-size:10px;font-weight:700;">${T("tur_th_importe")}</th></tr></thead>
      <tbody style="background:#fffbeb;">${filasItems}</tbody>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:20px;">
      <div style="background:#fff7ed;border:2px solid ${cs};border-radius:12px;padding:14px 20px;min-width:200px;">
        ${conIGV ? `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px;"><span style="color:#92400e;">${T("tur_subtotal")}</span><span style="font-weight:700;">${money(subtotal)}</span></div><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:10px;"><span style="color:#92400e;">${T("igv_18")}</span><span style="font-weight:700;">${money(igv)}</span></div>` : ""}
        <div style="display:flex;justify-content:space-between;border-top:2px solid ${cp};padding-top:8px;"><span style="font-weight:900;font-size:15px;color:${cp};">${T("total")}</span><span style="font-weight:900;font-size:15px;color:${cp};">${money(total)}</span></div>
        ${!conIGV ? `<p style="font-size:10px;color:#92400e;margin:6px 0 0;text-align:right;">${T("no_incluye_igv")}</p>` : ""}${c.lineaTc("font-size:10px;color:#92400e;margin:6px 0 0;text-align:right;")}
      </div>
    </div>
    ${e.items.length >= 3 || vehiculos.length >= 3 ? `<div style="page-break-before:always;height:70px;margin:0;"></div>` : ""}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px;">
      <div style="background:#f0fdf4;border-radius:10px;padding:12px;"><p style="font-weight:900;font-size:10px;color:#166534;margin:0 0 6px;">${T("tur_incluye")}</p>${c.consid.incluye.map(i => `<p style="font-size:10px;color:#166534;margin:2px 0;">• ${esc(i)}</p>`).join("")}</div>
      <div style="background:#fff5f5;border-radius:10px;padding:12px;"><p style="font-weight:900;font-size:10px;color:#991b1b;margin:0 0 6px;">${T("tur_no_incluye")}</p>${c.consid.no_incluye.map(i => `<p style="font-size:10px;color:#991b1b;margin:2px 0;">• ${esc(i)}</p>`).join("")}</div>
    </div>
    ${c.cierre ? `<p style="text-align:center;color:${cp};font-weight:700;font-size:12px;margin:16px 0;padding:12px;background:#fff7ed;border-radius:10px;">${esc(c.cierre)}</p>` : ""}
  ${buildAnexoHtml(cot, c.nomCl, c.nCot, cp, cs, c.idioma)}
  ${buildFooterPDFHtml(cp, esc(empresa?.direccion || ""), empTel, empEmail, esc(EMP(empresa).web), c.idioma)}
  <script>window.onload=()=>window.print();</script></body></html>`;
}

// ── Plantilla EJECUTIVO ────────────────────────────────────────────────────────

function htmlEjecutivo(c: Ctx): string {
  const { e, cot, T, money, tot, conIGV } = c;
  const { cliente, vehiculos, cfg, empresa } = e;
  const { subtotal, igv, total } = tot;
  const nomCl = esc(c.nomCl), nCot = esc(c.nCot);
  const cp = colorCss(cfg?.color_primario, "#1a1a1a"); const acento = colorCss(cfg?.color_acento, "#C8A24B");
  const logoUrl = esc(empresa?.logo_url || LOGO_DEFAULT);
  const empNombre = esc(EMP(empresa).nombre); const empRuc = esc(EMP(empresa).ruc); const empTel = esc(EMP(empresa).telefono); const empEmail = esc(EMP(empresa).email);
  const repr = esc(e.repr ?? "");
  // Sin la columna «USD ~»: ver la cabecera del módulo (divergencia declarada 1).
  const filasItems = e.items.map((it, i) => { const tf = tot.lineas[i]; return `<tr><td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:10.5px;">${esc(c.descs[i])}</td><td style="padding:10px 14px;text-align:center;border-bottom:1px solid #f0f0f0;font-size:10px;color:#6b7280;">${T("dias_x_cant", { d: it.dias, c: it.cantidad })}</td><td style="padding:10px 14px;text-align:right;border-bottom:1px solid #f0f0f0;font-weight:800;color:${cp};">${money(tf)}</td></tr>`; }).join("");
  return `<!DOCTYPE html><html lang="${c.idioma}"><head><meta charset="UTF-8"/><title>${T("eje_titulo_html", { n: nCot })}</title>
  <style>${sharedCSS()}</style>
  </head><body>
  ${buildHeaderPDFHtml(logoUrl, cp, c.titulo(T("eje_titulo")), `N° ${nCot} · ${fmtFechaDoc(c.ahora, c.idioma, "simple")} · ${T("eje_valida")}`)}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;">
      <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1px;margin:0 0 8px;">${T("eje_cliente")}</p>
      <p style="font-weight:800;font-size:14px;margin:0;">${nomCl}</p>
      ${cliente?.ruc ? `<p style="color:#6b7280;font-size:10px;margin:3px 0 0;">${T("rotulo_ruc")}: ${esc(cliente.ruc)}</p>` : ""}
      ${cot.atencion ? `<p style="color:#6b7280;font-size:10px;margin:2px 0 0;">${T("eje_attn")}${esc(cot.atencion)}</p>` : ""}
    </div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;">
      <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1px;margin:0 0 8px;">${empNombre}</p>
      <p style="color:#6b7280;font-size:10px;margin:2px 0;">${T("rotulo_ruc")}: ${empRuc}</p>
      <p style="color:#6b7280;font-size:10px;margin:2px 0;">${T("eje_repr")}${repr}</p>
      <p style="color:#6b7280;font-size:10px;margin:2px 0;">📞 ${empTel} · ✉️ ${empEmail}</p>
    </div>
  </div>
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:20px;">
    <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1px;margin:0 0 8px;">${T("eje_detalle")}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
      <div><p style="font-size:9px;color:#6b7280;margin:0;">${T("eje_origen")}</p><p style="font-weight:700;font-size:11px;margin:2px 0 0;">${esc(cot.origen)}</p></div>
      <div><p style="font-size:9px;color:#6b7280;margin:0;">${T("eje_destino")}</p><p style="font-weight:700;font-size:11px;margin:2px 0 0;">${esc(cot.destino)}</p></div>
      <div><p style="font-size:9px;color:#6b7280;margin:0;">${T("eje_fecha")}</p><p style="font-weight:700;font-size:11px;margin:2px 0 0;">${cot.fecha_servicio ? fmtFechaDoc(cot.fecha_servicio, c.idioma, "corta") : "—"}</p></div>
    </div>
  </div>
  ${buildCronogramaMultidiaPDF(cot, cp, c.idioma)}
  ${vehiculos.length ? `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:20px;"><p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1px;margin:0 0 8px;">${T("eje_unidad")}${vehiculos.length > 1 ? T("vehiculos_n", { n: vehiculos.length }) : ""}</p>${buildVehsHtml(vehiculos, cp, { imgH: "190px", radius: "8px", ...(c.idioma === "en" ? { idioma: "en" as const } : {}) })}</div>` : ""}
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <thead><tr style="border-bottom:2px solid ${acento};"><th style="padding:9px 14px;text-align:left;font-size:9px;font-weight:900;text-transform:uppercase;color:${cp};letter-spacing:.5px;">${T("eje_th_desc")}</th><th style="padding:9px 14px;text-align:center;font-size:9px;font-weight:900;text-transform:uppercase;color:${cp};letter-spacing:.5px;">${T("eje_th_cant")}</th><th style="padding:9px 14px;text-align:right;font-size:9px;font-weight:900;text-transform:uppercase;color:${cp};letter-spacing:.5px;">${T("eje_th_monto", { cod: c.moneda })}</th></tr></thead>
    <tbody>${filasItems}</tbody>
  </table>
  <div style="display:flex;justify-content:flex-end;margin-bottom:24px;">
    <div style="min-width:240px;">
      ${conIGV ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11px;"><span style="color:#6b7280;">${T("eje_subtotal")}</span><span style="font-weight:700;">${money(subtotal)}</span></div><div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11px;"><span style="color:#6b7280;">${T("eje_igv")}</span><span style="font-weight:700;">${money(igv)}</span></div>` : ""}
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-top:2px solid ${acento};margin-top:4px;"><span style="font-weight:900;font-size:15px;">${T("total")}</span><span style="font-weight:900;font-size:15px;color:${cp};">${money(total)}</span></div>
      ${!conIGV ? `<p style="font-size:10px;color:#6b7280;margin:4px 0 0;text-align:right;">${T("no_incluye_igv")}</p>` : ""}${c.lineaTc("font-size:10px;color:#6b7280;margin:4px 0 0;text-align:right;")}
    </div>
  </div>
  ${e.items.length >= 3 || vehiculos.length >= 3 ? `<div style="page-break-before:always;height:70px;margin:0;"></div>` : ""}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px;">
    <div><p style="font-size:9px;font-weight:900;color:#166534;text-transform:uppercase;letter-spacing:.5px;margin:0 0 6px;">${T("eje_incluye")}</p>${c.consid.incluye.map(i => `<p style="font-size:10px;color:#166534;margin:3px 0;">✓ ${esc(i)}</p>`).join("")}</div>
    <div><p style="font-size:9px;font-weight:900;color:#991b1b;text-transform:uppercase;letter-spacing:.5px;margin:0 0 6px;">${T("eje_no_incluye")}</p>${c.consid.no_incluye.map(i => `<p style="font-size:10px;color:#991b1b;margin:3px 0;">✗ ${esc(i)}</p>`).join("")}</div>
  </div>
  ${c.cierre ? `<p style="text-align:center;color:#6b7280;font-style:italic;font-size:11px;margin-bottom:20px;border-top:1px solid #e5e7eb;padding-top:14px;">${esc(c.cierre)}</p>` : ""}
  ${buildAnexoHtml(cot, c.nomCl, c.nCot, cp, acento, c.idioma)}
  ${buildFooterPDFHtml(cp, esc(empresa?.direccion || ""), empTel, empEmail, esc(EMP(empresa).web), c.idioma)}
  <script>window.onload=()=>window.print();</script></body></html>`;
}

// ── Plantilla CORPORATIVO ──────────────────────────────────────────────────────

const CSS_CORPORATIVO = `.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}.box{border:1px solid #ccc;border-radius:4px;padding:8px 10px}.box-title{font-weight:900;font-size:10px;color:#0b315f;text-transform:uppercase;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-bottom:6px}.box-row{margin:3px 0;font-size:10.5px}table{width:100%;border-collapse:collapse;margin:10px 0;font-size:10.5px}thead{background:#0b315f;color:white}thead th{padding:6px;text-align:center;font-weight:700;font-size:10px;border:1px solid #0b315f}tbody tr:nth-child(even){background:#f8fafc}.totales td{padding:4px 10px}.totales .label{text-align:right;color:#555;font-weight:600}.totales .valor{text-align:right;font-weight:700}.totales .total-neto{font-size:13px;font-weight:900;color:#0b315f}.totales .sep{border-top:2px solid #0b315f}.cuentas{margin-top:12px;border-top:2px solid #0b315f;padding-top:10px}.cuentas h3{font-size:11px;font-weight:900;color:#0b315f;margin:0 0 6px}.cuentas-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.cuenta-box{border:1px solid #ddd;border-radius:4px;padding:6px 8px}.cuenta-box .banco{font-weight:900;font-size:10px;color:#0b315f;margin-bottom:3px}.cuenta-box p{margin:1px 0;font-size:9.5px}.anexo h3{font-size:10.5px;font-weight:900;margin:8px 0 4px;text-transform:uppercase}.anexo li{font-size:10.5px;color:#333;line-height:1.6}`;

export { TAMANO_QR_PX };

/**
 * El QR como SVG en línea: los MISMOS tramos que dibuja el PDF del servidor (`matrizQr`,
 * lib/qr-matriz.ts), sobre blanco y con su zona de silencio. Sin texto, sin pedir nada a la red.
 */
export function svgQr(m: MatrizQr, px: number): string {
  const lado = m.tamano + 2 * SILENCIO_QR;
  const d = m.tramos.map(([f, c, l]) => `M${c + SILENCIO_QR} ${f + SILENCIO_QR}h${l}v1h-${l}z`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${lado}" height="${lado}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const segHtml = (ss: Segmento[]): string => ss.map(x => (x.negrita ? `<b>${esc(x.texto)}</b>` : esc(x.texto))).join("");
const filaHtml = (f: FilaDoc, attrs = ""): string => `<div class="box-row"${attrs}><b>${esc(f.rotulo)}</b> ${segHtml(f.segmentos)}</div>`;
const cajaHtml = (c: CajaDoc): string => `<div class="box"><div class="box-title">${esc(c.titulo)}</div>${c.filas.map(f => filaHtml(f)).join("")}</div>`;

/**
 * La plantilla corporativa en HTML, pintada desde el modelo (`docCorporativo`, el mismo que dibuja
 * el PDF del servidor). Sin los campos que solo lee la corporativa, el MISMO HTML byte a byte que
 * antes de la extracción (scripts/prueba-cotizacion-pdf.mts).
 */
function htmlCorporativo(d: DocCorporativo): string {
  const cp = d.color;
  const css = sharedCSS(CSS_CORPORATIVO);
  const det = d.detalle;
  const filasItems = d.tabla.filas.map(f => `<tr><td style="text-align:center;padding:6px;border:1px solid #ccc;">${esc(f.item)}</td><td style="padding:6px;border:1px solid #ccc;">${esc(f.descripcion)}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${esc(f.dias)}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${esc(f.cantidad)}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;">${esc(f.punit)}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${esc(f.dscto)}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;font-weight:bold;">${esc(f.total)}</td></tr>`).join("");
  const totalesCorpHtml = (() => {
    let h = "<table class=\"totales\">";
    for (const f of d.totales.filas) h += f.descuento ? `<tr><td class="label">${esc(f.rotulo)}</td><td class="valor" style="color:#dc2626;">${esc(f.valor)}</td></tr>` : `<tr><td class="label">${esc(f.rotulo)}</td><td class="valor">${esc(f.valor)}</td></tr>`;
    h += `<tr class="sep"><td class="label total-neto">${esc(d.totales.total.rotulo)}</td><td class="valor total-neto">${esc(d.totales.total.valor)}</td></tr>`;
    for (const n of d.totales.notas) h += `<tr><td colspan="2" style="text-align:right;font-size:9px;color:#6b7280;padding:2px 10px 0;">${esc(n)}</td></tr>`;
    h += "</table>";
    return h;
  })();
  const E = d.tabla.encabezados.map(x => esc(x));
  const nota = d.notaTotales ? `<div style="margin:-4px 0 10px;padding:6px 10px;border-left:3px solid ${cp};background:#f1f5f9;font-size:10px;font-weight:700;color:${cp};">${esc(d.notaTotales)}</div>` : "";
  const p2 = d.pagina2;
  const caract = p2.caracteristicas
    ? `<div class="box" style="margin-bottom:10px;"><div class="box-title">${esc(p2.caracteristicas.titulo)}</div><div class="box-row">${pintarVehiculosHtml(p2.caracteristicas.vehiculos, cp, { imgH: "180px", radius: "8px", contain: true })}</div></div>`
    : "";
  const saltoIncl = p2.saltoAntesDeCondiciones ? '<div style="page-break-before:always;height:70px;margin:0;"></div>' : "";
  const li = (xs: string[]) => xs.map(i => `<li>${esc(i)}</li>`).join("");
  const vInc = listaVisible(p2.incluye, p2.omitirVacias), vNo = listaVisible(p2.noIncluye, p2.omitirVacias), vGen = listaVisible(p2.generales, p2.omitirVacias);
  // La política de reserva va al final y solo con líneas: sin ella, el HTML de siempre byte a byte.
  // Con el resumen (cotizaciones-08): el resumen con el QR a la derecha y, debajo, el enlace a la
  // política completa. Sin resumen o sin enlace, la política entera, como siempre.
  const vRes = reservaVisible(p2);
  const tituloRes = vRes ? `<h3 style="color:${cp};border-bottom:2px solid ${cp};padding-bottom:3px;">${esc(p2.reserva.titulo)}</h3>` : "";
  const en = p2.reserva.enlace;
  const reserva = !vRes ? ""
    : p2.reserva.modo === "resumen" && en
      ? `${tituloRes}<div style="display:flex;gap:12px;align-items:flex-start;"><ul style="flex:1;min-width:0;margin-top:0;">${li(p2.reserva.items)}</ul>${en.qr ? `<div style="flex:0 0 auto;">${svgQr(en.qr, TAMANO_QR_PX)}</div>` : ""}</div><p style="margin:4px 0 0;font-size:10.5px;color:#333;line-height:1.6;">${esc(en.rotulo)} <a href="${esc(en.url)}" style="color:${cp};font-weight:700;overflow-wrap:anywhere;">${esc(en.url)}</a></p>`
      : `${tituloRes}<ul>${li(p2.reserva.items)}</ul>`;
  const listas = vInc || vNo || vGen || vRes
    ? `<div class="anexo">${vInc || vNo ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;">${vInc ? `<div><h3 style="color:#166534;border-bottom:2px solid #16a34a;padding-bottom:3px;">${esc(p2.incluye.titulo)}</h3><ul>${li(p2.incluye.items)}</ul></div>` : ""}${vNo ? `<div><h3 style="color:#991b1b;border-bottom:2px solid #dc2626;padding-bottom:3px;">${esc(p2.noIncluye.titulo)}</h3><ul>${li(p2.noIncluye.items)}</ul></div>` : ""}</div>` : ""}${vGen ? `<h3 style="color:${cp};border-bottom:2px solid ${cp};padding-bottom:3px;">${esc(p2.generales.titulo)}</h3><ul>${li(p2.generales.items)}</ul>` : ""}${reserva}</div>`
    : "";
  return `<!DOCTYPE html><html lang="${d.idioma}"><head><meta charset="UTF-8"/><title>${esc(d.tituloVentana)}</title><style>${css}</style></head><body>${buildHeaderPDFHtml(esc(d.logoUrl || LOGO_DEFAULT), cp, esc(d.titulo), esc(d.subtitulo))}<div class="grid2">${cajaHtml(d.cliente)}${cajaHtml(d.empresa)}</div><div class="box" style="margin-bottom:10px;"><div class="box-title">${esc(det.titulo)}</div><div style="display:grid;grid-template-columns:${det.lugares.length === 2 ? "1fr 1fr" : "1fr 1fr 1fr"};gap:6px;">${det.lugares.map(f => filaHtml(f)).join("")}</div>${det.asunto ? filaHtml(det.asunto, ' style="margin-top:4px;"') : ""}<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;">${det.fechas.map(f => filaHtml(f)).join("")}</div></div>${d.cronograma ? pintarCronogramaHtml(d.cronograma, cp) : ""}<table><thead><tr><th style="width:40px;">${E[0]}</th><th style="text-align:left;">${E[1]}</th><th style="width:45px;">${E[2]}</th><th style="width:55px;">${E[3]}</th><th style="width:110px;">${E[4]}</th><th style="width:55px;">${E[5]}</th><th style="width:110px;">${E[6]}</th></tr></thead><tbody>${filasItems}<tr><td colspan="7" style="border:1px solid #ccc;padding:0;vertical-align:top;">${totalesCorpHtml}</td></tr></tbody></table>${nota}${d.cuentas ? pintarCuentasHtml(d.cuentas) : ""}${d.anexo ? pintarAnexoHtml(d.anexo, cp, "#1d4ed8") : ""}<div class="page-break"></div><h2 style="font-size:14px;font-weight:900;color:${cp};border-bottom:2px solid ${cp};padding-bottom:6px;margin-bottom:16px;padding-top:82px;">${esc(p2.titulo)}</h2>${caract}` + saltoIncl + listas + `${pintarPieHtml(cp, d.pie.map(p => ({ ...p, texto: esc(p.texto) })))}<script>window.onload=()=>window.print();</script></body></html>`;
}

// ── La entrada única ───────────────────────────────────────────────────────────

/** Cómo nombra el aviso «tal cual» cada lista (las tres de siempre, como las escribía antes). */
const NOMBRE_LISTA_AVISO: Record<keyof ConsidCot, string> = {
  incluye: "incluye", no_incluye: "no incluye", generales: "generales", reserva: "reserva, cambios y cancelación",
  reserva_resumen: "resumen de la reserva",
};

/**
 * Los textos que la PLANTILLA escribió a mano (en español) y que en inglés no se imprimen. Con las
 * consideraciones FIJADAS en la fila (versión 2) las condiciones de la plantilla no se imprimen en
 * ningún idioma, así que nombrarlas aquí sería avisar de algo que no pasa.
 */
function textosDePlantilla(cfg: PlantillaPdfCfg | null | undefined, considFijada: boolean): string[] {
  if (!cfg) return [];
  const out: string[] = [];
  if (String(cfg.titulo_documento ?? "").trim()) out.push("el título del documento");
  if (String(cfg.mensaje_cierre ?? "").trim()) out.push("el mensaje de cierre");
  if (!considFijada && (cfg.condiciones_incluye?.length || cfg.condiciones_no_incluye?.length || cfg.condiciones_generales?.length || cfg.condiciones_reserva?.length || cfg.condiciones_reserva_resumen?.length)) out.push("las condiciones de la plantilla");
  return out;
}

/**
 * El HTML del PDF de la cotización y lo que la pantalla tiene que AVISAR antes de enviarlo.
 * `html: null` solo con el aviso `sin_tc` (dólares sin un tipo de cambio válido).
 */
export function htmlCotizacion(e: EntradaPdfCot): ResultadoPdf {
  const avisos: AvisoPdf[] = [];
  // La base común (ítems normalizados, moneda, TC, totales, consideraciones, descripciones) vive
  // en lib/cotizacion-corporativo.ts: la corporativa la usa también en el servidor.
  const rb = baseCotizacionPdf(e);
  if (!rb.ok) return { html: null, avisos: [rb.aviso] };
  const b = rb.base;
  const { cot, idioma, moneda, tc, consid } = b;
  const cfg = b.e.cfg ?? null;

  if (idioma === "en") {
    const dePlantilla = textosDePlantilla(cfg, esConsidFijada(b.e.consid));
    if (dePlantilla.length) {
      avisos.push({
        codigo: "plantilla_en_espanol", bloquea: false,
        detalle: `La plantilla tiene textos escritos en español (${dePlantilla.join(", ")}) que no se imprimen en el PDF en inglés: se usan el título en inglés y las consideraciones de la cotización.`,
      });
    }
    const partes: string[] = [];
    if (b.descsTalCual) partes.push(`${b.descsTalCual} descripción(es) de ítem`);
    if (consid.escritasTalCual.length) partes.push(`las consideraciones (${consid.escritasTalCual.map(k => NOMBRE_LISTA_AVISO[k]).join(", ")})`);
    if (String(cot.itinerario_texto ?? "").trim()) partes.push("el itinerario");
    if (partes.length) {
      avisos.push({
        codigo: "textos_escritos_tal_cual", bloquea: false,
        detalle: `Se imprimen tal cual se escribieron, sin traducir: ${partes.join(", ")}. Si están en español, escríbelos en inglés en la cotización.`,
      });
    }
  }

  const ctx: Ctx = {
    e: b.e, cot, idioma, moneda, tc,
    T: (k, v) => t(idioma, k, v),
    money: n => fmtImporte(n, moneda, idioma),
    tot: b.tot, conIGV: b.conIGV, descs: b.descs,
    consid,
    nomCl: b.nomCl,
    nCot: b.nCot,
    ahora: b.ahora,
    // En inglés los textos libres de la plantilla no se imprimen: el título sale del diccionario.
    titulo: porDefecto => esc(idioma === "es" ? (cfg?.titulo_documento || porDefecto) : porDefecto),
    cierre: idioma === "es" ? (cfg?.mensaje_cierre || null) : null,
    lineaTc: estilo => lineaTcHtml({ moneda, tc, idioma }, estilo),
  };

  const plantilla = e.plantilla ?? "corporativo";
  let html: string;
  if (plantilla === "moderno_fotos") html = htmlModerno(ctx);
  else if (plantilla === "turistico") html = htmlTuristico(ctx);
  else if (plantilla === "ejecutivo") html = htmlEjecutivo(ctx);
  else {
    const doc = docCorporativoDeBase(b);
    // El bloque de cuentas se omite igual que siempre; lo nuevo es que la pantalla lo DIGA antes de enviar.
    avisos.push(...doc.avisos);
    html = htmlCorporativo(doc);
  }
  return { html, avisos };
}
