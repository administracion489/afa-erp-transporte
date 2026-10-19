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
//
// MONEDA: los ítems llegan SIEMPRE en soles (la fila autoritativa). En USD se convierten aquí con
// el tipo de cambio congelado de la cotización (`totalesEnMoneda`), se imprime una sola vez
// «Tipo de cambio referencial» y no se imprime ningún total en soles. Sin un TC válido NO hay PDF
// en dólares (`html: null` + aviso `sin_tc`): imprimir soles rotulados como dólares es el error caro.
// ──────────────────────────────────────────────────────────────────────────────

import { LOGO_DEFAULT, buildHeaderPDFHtml, buildFooterPDFHtml, sharedCSS, buildVehsHtml, esc, type VehiculoPDF } from "./pdf-chrome";
import { empresaConDefectos, cuentasUtiles, cuentasParaMoneda, monedaDeCuenta, type PerfilEmpresa, type CuentaBancaria } from "./empresa-perfil";
import { normalizarMoneda, revisarTipoCambio, totalesEnMoneda, simboloMoneda, type Moneda, type TotalesMoneda } from "./cotizacion-moneda";
import {
  normalizarIdioma, t, fmtFechaDoc, fmtImporte, fmtTipoCambio, considParaPdf, descripcionParaPdf,
  DEFAULT_CONSID_ES, type Idioma, type ClaveTexto, type ConsidCot, type CtxDescripcion,
} from "./cotizacion-idioma";

const EMP = empresaConDefectos;

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
  /** Las consideraciones de la cotización (las de la pantalla si se está editando). */
  consid?: ConsidCot;
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
};

export type CodigoAvisoPdf = "sin_tc" | "sin_cuenta_en_moneda" | "plantilla_en_espanol" | "textos_escritos_tal_cual";

export type AvisoPdf = { codigo: CodigoAvisoPdf; detalle: string; /** `sin_tc` impide el PDF. */ bloquea: boolean };

export type ResultadoPdf = { html: string | null; avisos: AvisoPdf[] };

/**
 * El número que se IMPRIME: el escrito a mano en `numero_cotizacion` o, si no hay, el id con ceros
 * a la izquierda. No hay correlativo propio: el buscador de /cotizaciones encuentra los dos.
 * Lo usan este PDF y el de traslados cotizados por la IA (lib/traslados/cotizacion-traslado.ts).
 */
export function numeroCotizacion(c: { id: number; numero_cotizacion?: string | null }): string {
  return c.numero_cotizacion || String(c.id).padStart(5, "0");
}

// ── Helpers de anexo e itinerario ──────────────────────────────────────────────

const ES_DIA = /^d[iíI][aA]\s*\d+/i;
const EN_DIA = /^day\s*\d+/i;

export function formatItinerarioHtml(texto: string, cp: string, acento: string): string {
  return texto.split("\n").map(l => {
    if (!l.trim()) return '<div style="height:5px;"></div>';
    if (ES_DIA.test(l.trim()) || EN_DIA.test(l.trim()))
      return `<div style="margin:16px 0 8px;padding:8px 14px;background:${cp}18;border-left:4px solid ${cp};border-radius:0 8px 8px 0;font-size:13px;font-weight:900;color:${cp};">${esc(l)}</div>`;
    const m = l.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.*)/);
    if (m) return `<div style="display:flex;gap:12px;padding:5px 0;border-bottom:1px solid #f3f4f6;"><span style="font-size:10px;font-weight:900;color:${acento};min-width:42px;flex-shrink:0;padding-top:1px;">${m[1]}</span><span style="font-size:11px;">${esc(m[2])}</span></div>`;
    return `<p style="margin:4px 0;font-size:11px;">${esc(l)}</p>`;
  }).join("");
}

export function buildAnexoHtml(cot: CotizacionPdf, nomCl: string, nCot: string, cp: string, acento: string, idioma: Idioma = "es"): string {
  const texto = (cot.itinerario_texto || "").trim(); if (!texto) return "";
  const itHtml = formatItinerarioHtml(texto, cp, acento);
  const fechaStr = cot.fecha_servicio ? fmtFechaDoc(cot.fecha_servicio, idioma, "larga_mayus") : "";
  return `<div style="page-break-before:always;padding:82px 40px 20px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid ${cp};padding-bottom:12px;margin-bottom:24px;">
      <div>
        <p style="font-size:9px;font-weight:900;text-transform:uppercase;color:${acento};letter-spacing:1.5px;margin:0 0 4px;">${t(idioma, "anexo_1")}</p>
        <h2 style="font-size:20px;font-weight:900;color:${cp};margin:0;">${t(idioma, "anexo_programa")}</h2>
      </div>
      <div style="text-align:right;">
        <p style="font-size:10px;color:#6b7280;margin:0 0 2px;">N° ${esc(nCot)}</p>
        <p style="font-size:12px;font-weight:800;color:${cp};margin:0;">${esc(nomCl)}</p>
        ${fechaStr ? `<p style="font-size:10px;color:#6b7280;margin:2px 0 0;">${fechaStr}</p>` : ""}
      </div>
    </div>
    <div>${itHtml}</div>
  </div>`;
}

export function buildCronogramaMultidiaPDF(cot: CotizacionPdf, cp: string, idioma: Idioma = "es"): string {
  const dias = cot.fechas_multidia_json; if (!dias?.length) return "";
  const T = (k: ClaveTexto, v?: Record<string, string | number>) => t(idioma, k, v);
  const hasDestino = dias.some(d => d.destino_nombre?.trim());
  const rows = dias.map((d, i) => {
    const esUltimo = i === dias.length - 1;
    const fechaFmt = d.fecha ? fmtFechaDoc(d.fecha, idioma, "cronograma") : "—";
    const horaFin = esc((d as any).hora_fin ?? (d as any).hora_retorno ?? "");
    const tipoNoche = (d as any).tipo_noche ?? (horaFin ? "" : "pernocte");
    let finLabel = "";
    if (esUltimo) { finLabel = horaFin ? `<b>⏰ ${horaFin}</b> <span style="color:#166534;font-size:9px;">${T("cron_retorno_final")}</span>` : `<span style="color:#6b7280;font-size:9px;font-style:italic;">${T("cron_por_confirmar")}</span>`; }
    else if (tipoNoche === "cochera") { finLabel = horaFin ? `<b>⏰ ${horaFin}</b> <span style="color:#1d4ed8;font-size:9px;">${T("cron_cochera")}</span>` : `<span style="color:#1d4ed8;font-size:9px;">${T("cron_cochera")}</span>`; }
    else { finLabel = horaFin ? `<b>⏰ ${horaFin}</b> <span style="color:#b45309;font-size:9px;">${T("cron_pernocte")}</span>` : `<span style="color:#b45309;font-size:9px;font-style:italic;">${T("cron_pernocte")}</span>`; }
    const origenNombre = esc(i === 0 ? cot.origen : (dias[i - 1].destino_nombre || "—"));
    const destinoNombre = esc(d.destino_nombre || "—");
    const rutaLabel = hasDestino ? `<span style="color:#374151;">${origenNombre}</span><span style="color:${cp};font-weight:900;"> → </span><span style="font-weight:700;">${destinoNombre}</span>` : "";
    return `<tr style="border-bottom:1px solid #f3f4f6;">
      <td style="text-align:center;font-weight:900;font-size:11px;color:${cp};padding:5px 8px;white-space:nowrap;">${T("cron_dia_mayus", { n: esc(d.dia) })}</td>
      <td style="padding:5px 8px;font-size:10px;font-weight:600;">${fechaFmt}</td>
      ${hasDestino ? `<td style="padding:5px 8px;font-size:10px;">${rutaLabel}</td>` : ""}
      <td style="text-align:center;padding:5px 8px;font-size:10px;">⏰ ${esc(d.hora_ida || "—")}</td>
      <td style="padding:5px 8px;font-size:10px;">${finLabel}</td>
    </tr>`;
  }).join("");
  const colRuta = hasDestino ? `<th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${T("cron_ruta")}</th>` : "";
  return `<div style="margin:12px 0 16px;background:#fafafa;border:1px solid ${cp}22;border-radius:10px;overflow:hidden;">
    <div style="background:${cp}12;padding:8px 14px;border-bottom:1px solid ${cp}22;">
      <p style="font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.8px;margin:0;">${T("cron_titulo", { n: dias.length })}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:${cp}08;">
        <th style="padding:4px 8px;text-align:center;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${T("cron_dia")}</th>
        <th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${T("cron_fecha")}</th>
        ${colRuta}
        <th style="padding:4px 8px;text-align:center;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${T("cron_salida")}</th>
        <th style="padding:4px 8px;text-align:left;font-size:9px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.5px;">${T("cron_fin")}</th>
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
  if (cfg && cfg.mostrar_cuentas_bancarias === false) return { html: "", aviso: null };
  let todas: CuentaBancaria[] = [];
  // `usar_bancos_propios` apagado —el caso normal— manda la ficha de la empresa.
  if (!cfg?.usar_bancos_propios) todas = EMP(empresa).cuentas;
  // Sin cuentas en la empresa se mira igual la plantilla (una base sin `empresa-02`).
  if (!todas.length) {
    todas = cuentasUtiles([1, 2, 3].map(n => ({
      banco: (cfg as any)?.[`banco_${n}_nombre`], cuenta: (cfg as any)?.[`banco_${n}_cuenta`], cci: (cfg as any)?.[`banco_${n}_cci`],
    })));
  }
  const utiles = cuentasParaMoneda(todas, moneda);
  if (!utiles.length) {
    const otra = todas.length > 0;
    return {
      html: "",
      aviso: {
        codigo: "sin_cuenta_en_moneda", bloquea: false,
        detalle: otra
          ? `Las cuentas bancarias configuradas son de otra moneda: el PDF en ${moneda === "USD" ? "dólares" : "soles"} sale sin el bloque de cuentas. Agrega una cuenta en ${moneda === "USD" ? "dólares" : "soles"} (o sin moneda declarada) en Configuración → Perfil de la empresa.`
          : "No hay cuentas bancarias configuradas: el PDF sale sin el bloque de cuentas. Se agregan en Configuración → Perfil de la empresa.",
      },
    };
  }
  return { html: pintarCuentas(utiles, idioma), aviso: null };
}

export function pintarCuentas(cuentas: CuentaBancaria[], idioma: Idioma = "es"): string {
  if (!cuentas.length) return "";
  return `<div class="cuentas"><h3>${t(idioma, "cuentas_titulo")}</h3><div class="cuentas-grid">${
    cuentas.map(c => {
      const m = monedaDeCuenta(c.moneda);
      return `<div class="cuenta-box"><div class="banco">${esc(c.banco)}${m ? " · " + simboloMoneda(m) : ""}</div>${
        c.cuenta ? `<p>${t(idioma, "cuentas_cta")} ${esc(c.cuenta)}</p>` : ""}${c.cci ? `<p>${t(idioma, "cuentas_cci")} ${esc(c.cci)}</p>` : ""}</div>`;
    }).join("")
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
  const cp = esc(cfg?.color_primario || "#1a1a2e"); const cs = esc(cfg?.color_secundario || "#2f8ee9");
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
  const cp = esc(cfg?.color_primario || "#b45309"); const cs = esc(cfg?.color_secundario || "#d97706");
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
  const cp = esc(cfg?.color_primario || "#1a1a1a"); const acento = esc(cfg?.color_acento || "#C8A24B");
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

function htmlCorporativo(c: Ctx, cuentasHtml: string): string {
  const { e, cot, T, money, tot, conIGV, idioma } = c;
  const { cliente, vehiculos, empresa } = e;
  const empNombre = esc(EMP(empresa).nombre); const empRuc = esc(EMP(empresa).ruc); const empEmail = esc(EMP(empresa).email); const empTel = esc(EMP(empresa).telefono); const empDir = esc(EMP(empresa).direccion);
  const repr = esc(e.repr ?? "");
  // Un servicio de solo ida no tiene punto ni hora de retorno: imprimirlos le promete al cliente
  // un tramo que no se cotizó. Sin tipo_servicio (cotizaciones antiguas) se conserva lo de antes.
  const soloIda = ["solo_ida", "fijo_solo_ida"].includes(cot.tipo_servicio || "");
  const { subtotal, igv, total } = tot; const desc = tot.descuento;
  const nomCl = esc(c.nomCl); const nCot = esc(c.nCot); const anio = c.ahora.getFullYear();
  const fechaDoc = cot.created_at ? fmtFechaDoc(cot.created_at, idioma, "corta") : fmtFechaDoc(c.ahora, idioma, "simple");
  const vehsSec = buildVehsHtml(vehiculos, "#0b315f", { imgH: "180px", radius: "8px", contain: true, ...(idioma === "en" ? { idioma: "en" as const } : {}) });
  const sim = simboloMoneda(c.moneda);
  const filasItems = e.items.map((it, i) => { const tf = tot.lineas[i]; return `<tr><td style="text-align:center;padding:6px;border:1px solid #ccc;">${i + 1}</td><td style="padding:6px;border:1px solid #ccc;">${esc(c.descs[i])}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.dias}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.cantidad}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;">${money(tot.unitarios[i])}</td><td style="text-align:center;padding:6px;border:1px solid #ccc;">${it.descuento_pct > 0 ? it.descuento_pct + "%" : ""}</td><td style="text-align:right;padding:6px;border:1px solid #ccc;font-weight:bold;">${money(tf)}</td></tr>`; }).join("");
  // El precio del PDF es el ya definido en los items: la nota de "Servicio Fijo" con precio/día y
  // mes estimado es cálculo interno y no debe verse en el documento.
  const notaFijo = "";
  const css = sharedCSS(CSS_CORPORATIVO);
  const totalesCorpHtml = (() => { let h = "<table class=\"totales\">"; if (conIGV) { h += `<tr><td class="label">${T("corp_subtotal")}</td><td class="valor">${money(subtotal)}</td></tr>`; if (desc > 0) h += `<tr><td class="label">${T("corp_descuento")}</td><td class="valor" style="color:#dc2626;">- ${money(desc)}</td></tr>`; h += `<tr><td class="label">${T("corp_igv")}</td><td class="valor">${money(igv)}</td></tr>`; } h += `<tr class="sep"><td class="label total-neto">${T("corp_total_neto")}</td><td class="valor total-neto">${money(total)}</td></tr>`; if (!conIGV) h += `<tr><td colspan="2" style="text-align:right;font-size:9px;color:#6b7280;padding:2px 10px 0;">${T("no_incluye_igv")}</td></tr>`; if (c.moneda === "USD" && c.tc != null) h += `<tr><td colspan="2" style="text-align:right;font-size:9px;color:#6b7280;padding:2px 10px 0;">${t(idioma, "tc_referencial", { tc: fmtTipoCambio(c.tc, idioma) })}</td></tr>`; h += "</table>"; return h; })();
  const saltoIncl = e.items.length >= 3 || vehiculos.length >= 3 ? '<div style="page-break-before:always;height:70px;margin:0;"></div>' : "";
  const fLarga = (iso: string) => fmtFechaDoc(iso, idioma, "larga_mayus");
  const rotDoc = cliente?.ruc ? T("rotulo_ruc") : T("rotulo_dni");
  return `<!DOCTYPE html><html lang="${idioma}"><head><meta charset="UTF-8"/><title>${T("cot_titulo_html", { n: nCot })}</title><style>${css}</style></head><body>${buildHeaderPDFHtml(esc(empresa?.logo_url || LOGO_DEFAULT), "#0b315f", T("corp_titulo", { n: nCot, anio }), T("corp_sub", { fecha: fechaDoc }))}<div class="grid2"><div class="box"><div class="box-title">${T("corp_datos_cliente")}</div><div class="box-row"><b>${T("corp_cliente")}</b> ${nomCl}</div><div class="box-row"><b>${rotDoc}:</b> ${esc(cliente?.ruc || cliente?.dni || "—")}</div><div class="box-row"><b>${T("corp_direccion")}</b> ${esc(cliente?.direccion || "—")}</div><div class="box-row"><b>${T("corp_celular")}</b> ${esc(cliente?.telefono || "—")}</div><div class="box-row"><b>${T("corp_atencion")}</b> ${esc(cot.atencion || cliente?.operativo_nombre || "—")}</div></div><div class="box"><div class="box-title">${empNombre}</div><div class="box-row"><b>${T("rotulo_ruc")}:</b> ${empRuc}</div>${repr ? `<div class="box-row"><b>${T("corp_representante")}</b> ${repr}</div>` : ""}<div class="box-row"><b>${T("corp_email")}</b> ${empEmail}</div><div class="box-row"><b>${T("corp_telf")}</b> ${empTel}</div></div></div><div class="box" style="margin-bottom:10px;"><div class="box-title">${T("corp_detalle")}</div><div style="display:grid;grid-template-columns:${soloIda ? "1fr 1fr" : "1fr 1fr 1fr"};gap:6px;"><div class="box-row"><b>${T("corp_origen")}</b> ${esc(cot.origen || "—")}</div><div class="box-row"><b>${T("corp_destino")}</b> ${esc(cot.destino || "—")}</div>${soloIda ? "" : `<div class="box-row"><b>${T("corp_retorno")}</b> ${esc(cot.punto_retorno || cot.origen || "—")}</div>`}</div>${cot.asunto ? `<div class="box-row" style="margin-top:4px;"><b>${T("corp_asunto")}</b> ${esc(cot.asunto)}</div>` : ""}${cot.fecha_retorno ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;"><div class="box-row"><b>${T("corp_fecha_ida")}</b> ${cot.fecha_servicio ? fLarga(cot.fecha_servicio) : "_____________"}</div><div class="box-row"><b>${T("corp_hora_ida")}</b> <b>${esc(cot.hora_ida || "_____")}</b></div><div class="box-row"><b>${T("corp_fecha_retorno")}</b> ${fLarga(cot.fecha_retorno)}</div><div class="box-row"><b>${T("corp_hora_retorno")}</b> <b>${esc(cot.hora_retorno || "_____")}</b></div></div>` : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;"><div class="box-row"><b>${T("corp_fecha")}</b> ${cot.fecha_servicio ? fLarga(cot.fecha_servicio) : "_____________"}</div><div class="box-row"><b>${T("corp_horario")}</b> ${T("corp_salida")} <b>${esc(cot.hora_ida || "_____")}</b>${soloIda ? "" : ` | ${T("corp_retorno_h")} <b>${esc(cot.hora_retorno || "_____")}</b>`}</div></div>`}${notaFijo}</div>${buildCronogramaMultidiaPDF(cot, "#0b315f", idioma)}<table><thead><tr><th style="width:40px;">${T("corp_th_item")}</th><th style="text-align:left;">${T("corp_th_desc")}</th><th style="width:45px;">${T("corp_th_dias")}</th><th style="width:55px;">${T("corp_th_cant")}</th><th style="width:110px;">${T("corp_th_punit", { m: sim })}</th><th style="width:55px;">${T("corp_th_dscto")}</th><th style="width:110px;">${T("corp_th_total", { m: sim })}</th></tr></thead><tbody>${filasItems}<tr><td colspan="7" style="border:1px solid #ccc;padding:0;vertical-align:top;">${totalesCorpHtml}</td></tr></tbody></table>${cuentasHtml}${buildAnexoHtml(cot, c.nomCl, c.nCot, "#0b315f", "#1d4ed8", idioma)}<div class="page-break"></div><h2 style="font-size:14px;font-weight:900;color:#0b315f;border-bottom:2px solid #0b315f;padding-bottom:6px;margin-bottom:16px;padding-top:82px;">${T("corp_unidad_cond")}</h2>${vehiculos.length ? `<div class="box" style="margin-bottom:10px;"><div class="box-title">${T("corp_caract")}${vehiculos.length > 1 ? T("vehiculos_n", { n: vehiculos.length }) : ""}</div><div class="box-row">${vehsSec}</div></div>` : ""}` + saltoIncl + `<div class="anexo"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;"><div><h3 style="color:#166534;border-bottom:2px solid #16a34a;padding-bottom:3px;">${T("corp_incluye")}</h3><ul>${c.consid.incluye.map(i => `<li>${esc(i)}</li>`).join("")}</ul></div><div><h3 style="color:#991b1b;border-bottom:2px solid #dc2626;padding-bottom:3px;">${T("corp_no_incluye")}</h3><ul>${c.consid.no_incluye.map(i => `<li>${esc(i)}</li>`).join("")}</ul></div></div><h3 style="color:#0b315f;border-bottom:2px solid #0b315f;padding-bottom:3px;">${T("corp_generales")}</h3><ul>${c.consid.generales.map(i => `<li>${esc(i)}</li>`).join("")}</ul></div>${buildFooterPDFHtml("#0b315f", empDir, empTel, empEmail, esc(EMP(empresa).web), idioma)}<script>window.onload=()=>window.print();</script></body></html>`;
}

// ── La entrada única ───────────────────────────────────────────────────────────

/** Los textos que la PLANTILLA escribió a mano (en español) y que en inglés no se imprimen. */
function textosDePlantilla(cfg: PlantillaPdfCfg | null | undefined): string[] {
  if (!cfg) return [];
  const out: string[] = [];
  if (String(cfg.titulo_documento ?? "").trim()) out.push("el título del documento");
  if (String(cfg.mensaje_cierre ?? "").trim()) out.push("el mensaje de cierre");
  if (cfg.condiciones_incluye?.length || cfg.condiciones_no_incluye?.length || cfg.condiciones_generales?.length) out.push("las condiciones de la plantilla");
  return out;
}

/**
 * El HTML del PDF de la cotización y lo que la pantalla tiene que AVISAR antes de enviarlo.
 * `html: null` solo con el aviso `sin_tc` (dólares sin un tipo de cambio válido).
 */
// Los campos numéricos de items_json vienen de un jsonb que acepta texto: un string que no es
// número se imprimiría crudo en el HTML (y el PDF se escribe en el origen del ERP). Un número
// sigue tal cual (la salida no cambia); null/undefined también; lo demás pasa a 0.
function numPdf(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function htmlCotizacion(e: EntradaPdfCot): ResultadoPdf {
  e = { ...e, items: e.items.map(it => ({ ...it, dias: numPdf(it.dias), cantidad: numPdf(it.cantidad), precio_unit: numPdf(it.precio_unit), descuento_pct: numPdf(it.descuento_pct) }) as typeof it) };
  const avisos: AvisoPdf[] = [];
  const cot = e.cot;
  const idioma = normalizarIdioma(e.idioma ?? cot.idioma_pdf);
  const moneda = normalizarMoneda(e.moneda ?? cot.moneda);
  const tcEntrada = e.tipoCambio !== undefined ? e.tipoCambio : cot.tipo_cambio;
  let tc: number | null = null;
  if (moneda === "USD") {
    const r = revisarTipoCambio(tcEntrada);
    if (r.codigo !== "ok") {
      return { html: null, avisos: [{ codigo: "sin_tc", bloquea: true, detalle: `No se puede generar el PDF en dólares: ${r.detalle}` }] };
    }
    tc = r.tc;
  }
  const conIGV = cot.incluye_igv !== false;
  const tot = totalesEnMoneda(e.items, moneda, tc, conIGV)!;
  const cfg = e.cfg ?? null;
  const consid = considParaPdf(cfg, e.consid ?? DEFAULT_CONSID_ES, idioma);

  const ctxDesc: CtxDescripcion | null = e.tipoVehiculoNombre !== undefined || cot.tipo_vehiculo !== undefined
    ? { modo_servicio: cot.modo_servicio, tipo_vehiculo: cot.tipo_vehiculo, tipoNombre: e.tipoVehiculoNombre ?? "" }
    : null;
  let descsTalCual = 0;
  const descs = e.items.map(it => {
    const d = descripcionParaPdf(it.descripcion, ctxDesc, idioma);
    if (idioma === "en" && !d.recompuesta && String(it.descripcion ?? "").trim()) descsTalCual++;
    return d.texto;
  });

  if (idioma === "en") {
    const dePlantilla = textosDePlantilla(cfg);
    if (dePlantilla.length) {
      avisos.push({
        codigo: "plantilla_en_espanol", bloquea: false,
        detalle: `La plantilla tiene textos escritos en español (${dePlantilla.join(", ")}) que no se imprimen en el PDF en inglés: se usan el título en inglés y las consideraciones de la cotización.`,
      });
    }
    const partes: string[] = [];
    if (descsTalCual) partes.push(`${descsTalCual} descripción(es) de ítem`);
    if (consid.escritasTalCual.length) partes.push(`las consideraciones (${consid.escritasTalCual.join(", ").replace("no_incluye", "no incluye")})`);
    if (String(cot.itinerario_texto ?? "").trim()) partes.push("el itinerario");
    if (partes.length) {
      avisos.push({
        codigo: "textos_escritos_tal_cual", bloquea: false,
        detalle: `Se imprimen tal cual se escribieron, sin traducir: ${partes.join(", ")}. Si están en español, escríbelos en inglés en la cotización.`,
      });
    }
  }

  const cliente = e.cliente;
  const ctx: Ctx = {
    e: { ...e, repr: e.repr ?? "" }, cot, idioma, moneda, tc,
    T: (k, v) => t(idioma, k, v),
    money: n => fmtImporte(n, moneda, idioma),
    tot, conIGV, descs,
    consid,
    nomCl: cliente?.tipo === "b2b" ? (cliente.empresa || cliente.nombre) : cliente?.nombre || "—",
    nCot: numeroCotizacion(cot),
    ahora: e.ahora ?? new Date(),
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
    const cuentas = buildCuentasHtml(cfg, e.empresa, moneda, idioma);
    // El bloque se omite igual que siempre; lo nuevo es que la pantalla lo DIGA antes de enviar.
    if (cuentas.aviso) avisos.push(cuentas.aviso);
    html = htmlCorporativo(ctx, cuentas.html);
  }
  return { html, avisos };
}
