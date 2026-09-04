// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-doc.ts — "Formato de Liquidación y Conformidad del Servicio".
//
// Arma el HTML imprimible de los dos documentos:
//   AFA-FL-07  Liquidación al CLIENTE   (lo firma el cliente)
//   AFA-FL-08  Liquidación al PROVEEDOR (lo firma AFA y el tercero)
//
// Respeta el formato que los clientes de AFA ya reciben y firman (mismo orden de
// secciones, misma redacción, mismas tres firmas) y le agrega lo que el Excel no
// podía dar: correlativo, QR de verificación, contraste programado/ejecutado,
// Anexo 1 con los servicios uno por uno y Anexo 2 con la evidencia operativa.
//
// Vive fuera de la página (igual que lib/ficha-ruta-html.ts) para poder generar el
// documento sin navegador ni sesión — ver scripts/muestra-liquidacion.mts, que sirve
// para revisar el diseño sin tocar datos reales.
// ──────────────────────────────────────────────────────────────────────────────

import { buildFooterPDFHtml, sharedCSS, LOGO_DEFAULT } from "./pdf-chrome";
import { fmtMoneda } from "./finanzas/dinero";

/**
 * Escapa lo que entra al HTML del documento. El PDF se abre con document.write en una
 * ventana que hereda el origen de la app, así que un dato de la BD con markup (nombre
 * de cliente, comentario del operador, observación del cliente) no puede entrar crudo.
 *
 * Se define aquí y no se importa de pdf-chrome a propósito: este módulo tiene que poder
 * desplegarse por su cuenta. Cuando `esc` esté publicado en pdf-chrome, unificar.
 */
const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const CP_CLIENTE = "#0b315f";
export const CP_PROVEEDOR = "#6d28d9";

// ── Forma de los datos que pinta el documento ───────────────────────────────

export type ControlDoc = {
  codigo: string;          // 'AFA-FL-07'
  titulo: string;
  macro_proceso?: string | null;
  proceso?: string | null;
  subproceso?: string | null;
  version?: string | null;
  vigencia_desde?: string | null;
};

export type LineaDoc = {
  item: number;
  tipo: "servicio" | "adicional" | "penalidad" | "descuento";
  descripcion: string;
  unidad_medida: string;
  cantidad_programada?: number | null;
  cantidad_ejecutada?: number | null;
  cantidad: number;
  precio_unitario: number;
  total_linea: number;
  orden_compra?: string | null;
  /** Segunda línea en gris: placas, N° de servicios, referencia al Anexo 1. */
  detalle?: string | null;
};

export type FilaAnexo = {
  ref: string;             // 'A-01' — el ítem de la valorización que sustenta esta fila
  fecha: string;           // '15/06'
  codigo: string;          // 'AFA-2026-004612'
  ruta: string;
  turno: string;
  placa: string;
  conductor: string;
  /**
   * Asientos CONTRATADOS para ese servicio. Es lo que el cliente pactó, no lo que cupo en
   * el bus. null = ninguna fuente lo sabe, y entonces se imprime "—" en vez de inventarlo.
   */
  paxContratado?: number | null;
  /**
   * Pasajeros que EMBARCARON de verdad, contados del manifiesto digital. null = ese
   * servicio no tiene manifiesto, que no es lo mismo que cero.
   */
  pax: number | null;
  estado: string;          // 'Conforme' | 'Tardío' | 'Adicional' | 'No ejecutado'
  importe: number;
  alerta?: boolean;
};

export type Anexo2 = {
  serviciosEjecutados: number;
  serviciosProgramados: number;
  puntualidadPct: number | null;
  pasajeros: number | null;
  km: number | null;
  incidencias: { fecha: string; codigo: string; tipo: string; descripcion: string; accion: string; efecto: number | null }[];
  unidades: { placa: string; descripcion: string; soat: string; revision: string; mtc: string; gps: string; conductores: string }[];
};

export type TotalesDoc = {
  servicios: number;
  adicionales: number;
  descuentos: number;
  subtotal: number;
  igvPct: number;
  igv: number;
  total: number;
  // Solo proveedor:
  totalComprobante?: number | null;
  detraccionPct?: number | null;
  detraccionMonto?: number | null;
  anticipos?: number | null;
};

export type ConformidadDoc = {
  estado: "pendiente" | "conforme" | "observada";
  grado?: string | null;         // CONFORME | CONFORME CON OBSERVACIONES | NO CONFORME
  por?: string | null;
  cargo?: string | null;
  fecha?: string | null;         // ya formateada
  ip?: string | null;
  canal?: string | null;
  sello?: string | null;
  comentario?: string | null;
};

export type DocLiquidacion = {
  lado: "cliente" | "proveedor";
  control: ControlDoc;
  codigo: string;                // LQC-2026-000318
  estadoLabel: string;
  emitido: string;
  contraparte: {
    nombre: string;
    ruc?: string | null;
    area?: string | null;        // área solicitante (cliente) / responsable AFA (proveedor)
    usuario?: string | null;
    cargo?: string | null;
    cuentaDetraccion?: string | null;
  };
  servicio: {
    contratado?: string | null;
    ubicacion?: string | null;
    periodo?: string | null;
    inicio?: string | null;
    fin?: string | null;
    fechaValorizacion?: string | null;
    moneda: string;
    ordenCompra?: string | null;
  };
  lineas: LineaDoc[];
  totales: TotalesDoc;
  documentacion: { nombre: string; estado: string; copias: string | number }[];
  conformidad: ConformidadDoc;
  comentarios?: string | null;
  anexo1: FilaAnexo[];
  anexo2?: Anexo2 | null;
  firmas: {
    rol: string;
    entidad: string;
    /**
     * Firma escaneada, ya rubricada. Solo la lleva la de AFA: las del cliente van en blanco
     * a propósito, porque son las que él tiene que firmar al dar la conformidad.
     */
    firmaUrl?: string | null;
  }[];
  empresa: { nombre: string; ruc?: string | null; logo?: string | null; direccion?: string | null; telefono?: string | null; email?: string | null; web?: string | null };
  /** QR como data URL; enlaza a la página pública de verificación/conformidad. */
  qr?: string | null;
  urlVerificacion?: string | null;
  /** Aviso al pie de la primera página (p. ej. "documento en borrador"). */
  aviso?: string | null;
};

// ── Utilidades de formato ───────────────────────────────────────────────────

const m2 = (n: number | null | undefined, moneda = "PEN") => fmtMoneda(Number(n ?? 0), moneda);
const num = (n: number | null | undefined, dec = 2) =>
  Number(n ?? 0).toLocaleString("es-PE", { minimumFractionDigits: dec, maximumFractionDigits: dec });

const chip = (txt: string, clase: string) =>
  `<span class="chip ${clase}">${esc(txt)}</span>`;

/** Verde si se ejecutó todo, ámbar si faltó algo, gris si no aplica. */
function chipCumplimiento(prog?: number | null, ejec?: number | null): string {
  if (prog == null || ejec == null || !prog) return "";
  const pct = Math.round((ejec / prog) * 100);
  return chip(`${pct}%`, pct >= 100 ? "ok" : pct >= 90 ? "warn" : "bad");
}

// ── CSS del documento ───────────────────────────────────────────────────────

const CSS_DOC = (cp: string) => `
.ctrl{display:flex;border:1.4px solid ${cp};margin:0 0 8px}
.ctrl>div{padding:5px 7px}
.ctrl-logo{width:104px;border-right:1.4px solid ${cp};display:flex;align-items:center;justify-content:center;background:#f8fafc}
.ctrl-logo img{max-width:88px;max-height:42px;object-fit:contain}
.ctrl-mid{flex:1;border-right:1.4px solid ${cp}}
.ctrl-mid .l{display:flex;gap:6px;padding:1.2px 0;font-size:8.4px}
.ctrl-mid .k{width:74px;font-weight:800;color:${cp};flex-shrink:0}
.ctrl-mid .v{color:#334155}
.ctrl-right{width:126px;border-right:1.4px solid ${cp}}
.ctrl-right .l{display:flex;gap:5px;padding:1.2px 0;font-size:8.4px}
.ctrl-right .k{font-weight:800;color:${cp}}
.ctrl-qr{width:92px;text-align:center;background:#f8fafc}
.ctrl-qr img{width:60px;height:60px;display:block;margin:0 auto 2px}
.ctrl-qr p{margin:0;font-size:6px;color:#64748b;line-height:1.2}
.folio{display:flex;justify-content:space-between;align-items:center;background:${cp};color:#fff;padding:5px 10px;border-radius:4px;margin-bottom:9px}
.folio h1{margin:0;font-size:11.5px;font-weight:900;letter-spacing:.4px}
.folio .n{font-size:12.5px;font-weight:900;font-family:"Courier New",monospace}
.folio .est{background:rgba(255,255,255,.22);font-size:7.6px;font-weight:900;padding:2px 8px;border-radius:20px;letter-spacing:.6px}
.sec{display:flex;align-items:center;gap:7px;background:#eef2f7;border-left:4px solid ${cp};padding:4px 8px;margin:11px 0 6px}
.sec .num{background:${cp};color:#fff;width:15px;height:15px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900}
.sec h2{margin:0;font-size:10px;font-weight:900;color:${cp};text-transform:uppercase;letter-spacing:.4px}
table{width:100%;border-collapse:collapse}
.datos td{border:1px solid #cbd5e1;padding:3.6px 6px;font-size:8.8px;vertical-align:middle}
.datos td.k{background:#f1f5f9;font-weight:800;color:#334155;width:104px}
.datos td.v{color:#0f172a;font-weight:600}
.val thead th{background:${cp};color:#fff;font-size:7.4px;font-weight:800;padding:5px 4px;border:1px solid ${cp};text-transform:uppercase}
.val td{border:1px solid #cbd5e1;padding:4.5px 5px;font-size:8.5px;vertical-align:top}
/* pre-line: la descripción trae un renglón por tramo (ida, retorno, móvil) y sin esto
   el HTML colapsa los saltos y el nombre de la ruta queda pegado al del retorno. */
.val .desc{font-weight:600;color:#0f172a;line-height:1.35;white-space:pre-line}
.val .meta{color:#64748b;font-size:7.2px;margin-top:2px}
.val tr.adicional td{background:#fffbeb}
.val tr.negativo td{background:#fef2f2}
.c{text-align:center}.r{text-align:right}
.chip{display:inline-block;font-size:7px;font-weight:900;padding:1px 5px;border-radius:9px;letter-spacing:.3px}
.ok{background:#dcfce7;color:#166534}.warn{background:#fef3c7;color:#92400e}
.bad{background:#fee2e2;color:#991b1b}.info{background:#dbeafe;color:#1e40af}
.tot{width:56%;margin-left:auto;margin-top:7px}
.tot td{padding:4px 8px;font-size:9px;border:1px solid #cbd5e1}
.tot td.k{background:#f1f5f9;font-weight:800;color:#334155;text-align:right}
.tot td.v{text-align:right;font-weight:800;width:110px}
.tot tr.grand td{background:${cp};color:#fff;font-size:11px;font-weight:900;border-color:${cp}}
.tot tr.neg td.v{color:#b91c1c}
.nota{margin-top:6px;background:#f8fafc;border:1px dashed #94a3b8;border-radius:5px;padding:6px 9px;font-size:8px;color:#475569}
.nota b{color:${cp}}
.docs thead th{background:#f1f5f9;color:#334155;font-size:7.4px;font-weight:800;padding:4px;border:1px solid #cbd5e1;text-transform:uppercase}
.docs td{border:1px solid #cbd5e1;padding:4px 6px;font-size:8.6px}
.conf{display:flex;gap:8px}
.conf .col{flex:1}
.sello{border:1.4px solid #16a34a;background:#f0fdf4;border-radius:6px;padding:7px 9px}
.sello .t{font-size:8.6px;font-weight:900;color:#166534}
.sello .s{font-size:7.4px;color:#3f6212;margin-top:2px;line-height:1.4}
.sello.pend{border-color:#f59e0b;background:#fffbeb}
.sello.pend .t{color:#92400e}.sello.pend .s{color:#78350f}
.coment{border:1px solid #cbd5e1;border-radius:5px;min-height:48px;padding:7px 9px;font-size:8.6px;color:#334155;line-height:1.5}
.firmas{display:flex;gap:14px;margin-top:18px}
.firma{flex:1;text-align:center}
.firma .linea{border-top:1.2px solid #334155;margin:34px 8px 4px}
/* Con firma escaneada, el hueco lo ocupa la imagen y la línea deja de reservarlo. */
.firma .linea.con-rubrica{margin-top:0}
.firma .rubrica{display:block;margin:0 auto;height:38px;width:auto;max-width:86%;object-fit:contain;object-position:bottom}
.firma .rol{font-size:8.4px;font-weight:900;color:${cp}}
.firma .ent{font-size:7.4px;color:#64748b;margin-top:1px}
.anx thead th{background:${cp};color:#fff;font-size:6.8px;font-weight:800;padding:4px 3px;border:1px solid ${cp};text-transform:uppercase}
.anx td{border:1px solid #d7dde5;padding:2.8px 4px;font-size:7.4px}
.anx td.nw{white-space:nowrap;font-family:"Courier New",monospace;font-size:6.8px}
.anx tbody tr:nth-child(even) td{background:#f8fafc}
.anx tfoot td{background:#eef2f7;font-weight:900;font-size:7.8px;border:1px solid #cbd5e1}
.anx tr.alerta td{background:#fef2f2}
.titulo-anexo{font-size:12px;font-weight:900;color:${cp};margin:0 0 2px}
.sub-anexo{font-size:8px;color:#64748b;margin:0 0 8px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
.kpi{border:1px solid #cbd5e1;border-radius:7px;padding:8px 10px;background:#f8fafc}
.kpi .n{font-size:18px;font-weight:900;color:${cp};line-height:1}
.kpi .l{font-size:7.2px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-top:3px}
.kpi .s{font-size:6.8px;color:#94a3b8;margin-top:2px}
.aviso{margin-top:10px;border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;border-radius:6px;padding:6px 9px;font-size:8px;font-weight:700}
`;

// ── Cómo se corta el documento entre hoja y hoja ────────────────────────────
//
// El documento se imprime desde el navegador (window.print), así que el corte de
// página lo decide Chrome y hay que decírselo. Cuatro cosas, y las cuatro se ven solo
// a partir de la SEGUNDA hoja — la primera siempre salió bien y por eso el problema
// pasó desapercibido:
//
//   1. El margen tiene que estar en `@page`, no en el padding del body: el padding
//      solo reserva aire arriba de la primera hoja y abajo de la última, así que las
//      intermedias arrancaban y terminaban al filo del papel.
//   2. El pie tiene que RESERVAR su sitio, no solo repetirse. `position:fixed` se
//      repite en cada hoja pero no ocupa flujo: se imprimía encima del contenido.
//   3. Ninguna fila se parte por la mitad: `break-inside` en las filas y en los
//      bloques que se leen como una unidad (firmas, sello, totales, KPIs).
//   4. Una cabecera de sección o de tabla no puede quedar sola al pie de una hoja:
//      `break-after:avoid` en las bandas de sección y `table-header-group` para que
//      la cabecera de la tabla se repita arriba de cada hoja que la continúa.
const CSS_IMPRESION = `
@page{size:A4;margin:12mm 11mm 12mm}
body{padding:0}
@media screen{body{padding:12mm 11mm 0}}
.hoja{width:100%;border-collapse:collapse}
.hoja>tbody>tr>td,.hoja>tfoot>tr>td{padding:0;border:0;vertical-align:top}
/* La fila que envuelve TODO el documento sí se parte: es la que pagina. */
.hoja>tbody>tr,.hoja>tbody>tr>td{break-inside:auto;page-break-inside:auto}
/* El pie deja de ser fijo: va dentro del <tfoot>, que el navegador repite al pie de
   cada hoja RESERVÁNDOLE el sitio. Fijo se pintaba encima del último renglón, y con
   un hueco de alto fijo no bastaba: la banda envuelve a dos líneas según lo largo
   que sea el domicilio de la empresa. */
.pdf-footer{position:static;margin-top:16px;padding:7px 14px !important}
/* La banda ya no ocupa el ancho del papel sino el del área imprimible, y el membrete
   entero no entra en un renglón a 8.5px: sin esto parte "www…" a una segunda línea y
   deja un separador "|" colgando al final de la primera. El !important es porque
   buildFooterPDFHtml trae los tamaños en el atributo style. */
.pdf-footer span{font-size:7.4px !important}
thead{display:table-header-group}
/* La cabecera SÍ se repite arriba de cada hoja; el pie del anexo NO: dice "TOTALES DEL
   PERIODO" y repetirlo al pie de cada hoja se lee como un subtotal de la hoja. */
.anx tfoot{display:table-row-group}
.val tr,.anx tr,.docs tr,.datos tr,.tot tr{break-inside:avoid;page-break-inside:avoid}
.sec,.titulo-anexo,.sub-anexo{break-after:avoid;page-break-after:avoid}
.ctrl,.folio,.conf,.sello,.firmas,.firma,.kpis,.kpi,.tot,.nota,.coment,.aviso{break-inside:avoid;page-break-inside:avoid}
`;

// ── Bloques ─────────────────────────────────────────────────────────────────

function bloqueControl(d: DocLiquidacion, cp: string): string {
  const c = d.control;
  const linea = (k: string, v: string) =>
    `<div class="l"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  const qr = d.qr
    ? `<div class="ctrl-qr"><img src="${d.qr}"/><p>Verifica este<br/>documento</p></div>`
    : "";
  return `<div class="ctrl">
    <div class="ctrl-logo"><img src="${esc(d.empresa.logo || LOGO_DEFAULT)}"/></div>
    <div class="ctrl-mid">
      ${linea("MACRO PROCESO:", esc(c.macro_proceso || "—"))}
      ${linea("PROCESO:", esc(c.proceso || "—"))}
      ${linea("SUBPROCESO:", esc(c.subproceso || "No aplica"))}
      ${linea("TÍTULO:", `<b>${esc(c.titulo)}</b>`)}
    </div>
    <div class="ctrl-right">
      <div class="l"><span class="k">Código:</span><span>${esc(c.codigo)}</span></div>
      <div class="l"><span class="k">Versión:</span><span>${esc(c.version || "01")}</span></div>
      <div class="l"><span class="k">Vigencia:</span><span>${esc(c.vigencia_desde || "—")}</span></div>
      <div class="l"><span class="k">Emitido:</span><span>${esc(d.emitido)}</span></div>
    </div>
    ${qr}
  </div>
  <div class="folio" style="background:${cp}">
    <h1>${d.lado === "cliente" ? "LIQUIDACIÓN AL CLIENTE" : "LIQUIDACIÓN AL PROVEEDOR"}</h1>
    <span class="n">${esc(d.codigo)}</span>
    <span class="est">${esc(d.estadoLabel)}</span>
  </div>`;
}

function bloqueDatos(d: DocLiquidacion): string {
  const s = d.servicio;
  const p = d.contraparte;
  const fila = (k1: string, v1: string, k2: string, v2: string) =>
    `<tr><td class="k">${esc(k1)}</td><td class="v">${v1}</td><td class="k">${esc(k2)}</td><td class="v">${v2}</td></tr>`;
  const etiquetaContra = d.lado === "cliente" ? "Cliente" : "Proveedor";
  const etiquetaArea = d.lado === "cliente" ? "Área solicitante" : "Conformidad por";
  const etiquetaUsuario = d.lado === "cliente" ? "Usuario que solicita" : "Responsable";
  const cuarta = d.lado === "cliente"
    ? fila("Ubicación del servicio", esc(s.ubicacion || "—"), "Fecha de valorización", esc(s.fechaValorizacion || "—"))
    : fila("Cuenta de detracción", esc(p.cuentaDetraccion || "—"), "Fecha de valorización", esc(s.fechaValorizacion || "—"));
  return `<table class="datos">
    ${fila(etiquetaContra, esc(p.nombre), etiquetaArea, esc(p.area || "—"))}
    ${fila("RUC", esc(p.ruc || "—"), etiquetaUsuario, esc(p.usuario || "—"))}
    ${fila("Servicio contratado", esc(s.contratado || "—"), "Cargo", esc(p.cargo || "—"))}
    ${cuarta}
    ${fila("Periodo valorizado", esc(s.periodo || "—"), "Moneda", esc(s.moneda === "USD" ? "DÓLARES (USD)" : "SOLES (PEN)"))}
    ${fila("Orden de compra", esc(s.ordenCompra || "—"), "Documento", esc(d.control.codigo + " v" + (d.control.version || "01")))}
  </table>`;
}

function bloqueValorizacion(d: DocLiquidacion, cp: string): string {
  const moneda = d.servicio.moneda;
  const filas = d.lineas.map((l) => {
    const clase = l.tipo === "adicional" ? "adicional" : (l.tipo === "penalidad" || l.tipo === "descuento") ? "negativo" : "";
    const negativo = l.total_linea < 0;
    // Un adicional puede venir de dos sitios y no se informan igual: el que se generó
    // en Programación TIENE programado y ejecutado (se pidieron 3 salidas, se
    // prestaron 2) y esconderlo tras un guion perdería justo lo que el cliente
    // pregunta; el que se escribió a mano en el editor no tiene contra qué comparar.
    const conProgramado = Number(l.cantidad_programada ?? 0) > 0;
    const cumplimiento =
      l.tipo === "servicio" || (l.tipo === "adicional" && conProgramado)
        ? `${num(l.cantidad_programada, 0)} / <b>${num(l.cantidad_ejecutada, 0)}</b> ${chipCumplimiento(l.cantidad_programada, l.cantidad_ejecutada)}`
          + (l.tipo === "adicional" ? ` ${chip("ADICIONAL", "warn")}` : "")
        : l.tipo === "adicional"
        ? `— / <b>${num(l.cantidad, 0)}</b> ${chip("ADICIONAL", "warn")}`
        : "—";
    return `<tr class="${clase}">
      <td class="c">${l.item}</td>
      <td><div class="desc">${esc(l.descripcion)}</div>${l.detalle ? `<div class="meta">${esc(l.detalle)}</div>` : ""}</td>
      <td class="c">${esc(l.unidad_medida)}</td>
      <td class="c">${cumplimiento}</td>
      <td class="c">${num(l.cantidad)}</td>
      <td class="r">${negativo ? "−" : ""}${num(Math.abs(l.precio_unitario))}</td>
      <td class="r"><b${negativo ? ' style="color:#b91c1c"' : ""}>${negativo ? "−" : ""}${num(Math.abs(l.total_linea))}</b></td>
    </tr>`;
  }).join("");

  const t = d.totales;
  const filaTot = (k: string, v: string, cls = "") =>
    `<tr class="${cls}"><td class="k">${esc(k)}</td><td class="v">${v}</td></tr>`;

  const totales = d.lado === "cliente"
    ? [
        filaTot("Servicios del periodo", m2(t.servicios, moneda)),
        t.adicionales ? filaTot("Adicionales autorizados", m2(t.adicionales, moneda)) : "",
        t.descuentos ? filaTot("Descuentos y penalidades", "− " + m2(t.descuentos, moneda), "neg") : "",
        filaTot("TOTAL VALORIZADO (sin IGV)", m2(t.subtotal, moneda)),
        filaTot(`IGV ${num(t.igvPct, 0)}%`, m2(t.igv, moneda)),
        `<tr class="grand"><td class="k" style="background:${cp};color:#fff;border-color:${cp}">TOTAL A FACTURAR</td><td class="v" style="background:${cp};color:#fff;border-color:${cp}">${m2(t.total, moneda)}</td></tr>`,
      ]
    : [
        filaTot("Servicios prestados", m2(t.servicios, moneda)),
        t.adicionales ? filaTot("Adicionales", m2(t.adicionales, moneda)) : "",
        t.descuentos ? filaTot("Penalidades y descuentos", "− " + m2(t.descuentos, moneda), "neg") : "",
        filaTot("Subtotal (sin IGV)", m2(t.subtotal, moneda)),
        filaTot(`IGV ${num(t.igvPct, 0)}%`, m2(t.igv, moneda)),
        filaTot("Total del comprobante", m2(t.totalComprobante ?? t.subtotal + t.igv, moneda)),
        t.detraccionMonto
          ? filaTot(`Detracción ${num(t.detraccionPct, 0)}%`, "− " + m2(t.detraccionMonto, moneda), "neg")
          : "",
        t.anticipos ? filaTot("Anticipos ya entregados", "− " + m2(t.anticipos, moneda), "neg") : "",
        `<tr class="grand"><td class="k" style="background:${cp};color:#fff;border-color:${cp}">NETO A PAGAR AL PROVEEDOR</td><td class="v" style="background:${cp};color:#fff;border-color:${cp}">${m2(t.total, moneda)}</td></tr>`,
      ];

  return `<table class="val">
    <thead><tr>
      <th style="width:22px">ITEM</th>
      <th>DESCRIPCIÓN</th>
      <th style="width:34px">U.M.</th>
      <th style="width:54px">PROG. / EJEC.</th>
      <th style="width:38px">CANT.</th>
      <th style="width:62px">${d.lado === "cliente" ? "P. UNITARIO" : "COSTO UNIT."}</th>
      <th style="width:74px">TOTAL ${d.servicio.moneda === "USD" ? "$" : "S/"}</th>
    </tr></thead>
    <tbody>${filas}</tbody>
  </table>
  <table class="tot">${totales.filter(Boolean).join("")}</table>`;
}

function bloqueDocumentacion(d: DocLiquidacion, n: number): string {
  if (!d.documentacion.length) return "";
  const filas = d.documentacion.map((x, i) => {
    const cls = /^s[íi]$|adjunt|\d/i.test(x.estado) ? "ok" : "warn";
    return `<tr><td class="c">${i + 1}</td><td>${esc(x.nombre)}</td><td class="c">${chip(x.estado, cls)}</td><td class="c">${esc(String(x.copias))}</td></tr>`;
  }).join("");
  return `<div class="sec"><span class="num">${n}</span><h2>${d.lado === "cliente" ? "Documentación entregada por el proveedor" : "Condiciones para el pago"}</h2></div>
  <table class="docs">
    <thead><tr><th style="width:26px">Ítem</th><th>${d.lado === "cliente" ? "Nombre del documento" : "Requisito"}</th><th style="width:74px">Estado</th><th style="width:56px">${d.lado === "cliente" ? "N° copias" : "Ref."}</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>`;
}

function bloqueConformidad(d: DocLiquidacion, n: number): string {
  const c = d.conformidad;
  const grado = c.grado || (c.estado === "conforme" ? "CONFORME" : c.estado === "observada" ? "CONFORME CON OBSERVACIONES" : "PENDIENTE");
  const claseGrado = c.estado === "conforme" ? "ok" : c.estado === "observada" ? "warn" : "info";
  const sello = c.estado === "pendiente"
    ? `<div class="sello pend">
         <div class="t">⏳ PENDIENTE DE CONFORMIDAD</div>
         <div class="s">Este documento fue enviado para su aprobación${d.urlVerificacion ? ` y puede aprobarse en línea:<br/><b>${esc(d.urlVerificacion)}</b>` : ""}<br/>
         También puede darse por conforme firmando en el recuadro correspondiente.</div>
       </div>`
    : `<div class="sello">
         <div class="t">✓ CONFORMIDAD REGISTRADA ELECTRÓNICAMENTE</div>
         <div class="s">
           Otorgada por <b>${esc(c.por || "—")}</b>${c.cargo ? ` (${esc(c.cargo)})` : ""}<br/>
           ${c.canal ? `vía ${esc(c.canal)} ` : ""}el <b>${esc(c.fecha || "—")}</b>${c.ip ? ` · IP ${esc(c.ip)}` : ""}<br/>
           ${c.sello ? `Sello de verificación: <b>${esc(c.sello)}</b> — validable en el QR de la cabecera.` : ""}
         </div>
       </div>`;
  const etiquetaGrado = d.lado === "cliente" ? "Grado de satisfacción" : "Evaluación del proveedor";
  return `<div class="sec"><span class="num">${n}</span><h2>Conformidad del servicio</h2></div>
  <div class="conf">
    <div class="col"><table class="datos">
      <tr><td class="k">Inicio del servicio</td><td class="v">${esc(d.servicio.inicio || "—")}</td></tr>
      <tr><td class="k">Término del servicio</td><td class="v">${esc(d.servicio.fin || "—")}</td></tr>
      <tr><td class="k">${esc(etiquetaGrado)}</td><td class="v">${chip(grado, claseGrado)}</td></tr>
    </table></div>
    <div class="col">${sello}</div>
  </div>
  ${c.comentario ? `<div class="nota" style="margin-top:7px"><b>Observación del cliente:</b> ${esc(c.comentario)}</div>` : ""}`;
}

function bloqueAnexo1(d: DocLiquidacion, cp: string): string {
  /**
   * La celda PAX: contratados / embarcados.
   *
   * Antes imprimía solo un número, `reservas.pasajeros_abordados`, que NO LO ESCRIBE NADIE
   * —el abordaje vive en `pasajeros_parada`— así que salía 0 con el manifiesto lleno. Un
   * cero ahí lo lee el cliente como "no viajó nadie" en un servicio que sí se prestó y que
   * se le está cobrando.
   *
   * Los dos números juntos son además lo que hace falta para revisar: el contratado es lo
   * que se pactó y lo que se factura; el embarcado, cuánta gente subió ese día. Que no
   * coincidan es normal —nadie llena el bus a diario— y por eso el uno sin el otro no dice
   * nada. Cada mitad va a "—" por su cuenta: sin dato no se escribe un cero.
   */
  const paxCelda = (f: FilaAnexo) =>
    `${f.paxContratado ?? "—"} / ${f.pax ?? "—"}`;

  if (!d.anexo1.length) return "";
  const moneda = d.servicio.moneda;
  const filas = d.anexo1.map((f) => `<tr${f.alerta ? ' class="alerta"' : ""}>
    <td class="c">${esc(f.ref)}</td><td class="c">${esc(f.fecha)}</td><td class="c nw">${esc(f.codigo)}</td>
    <td>${esc(f.ruta)}</td><td class="c">${esc(f.turno)}</td><td class="c">${esc(f.placa || "—")}</td>
    <td>${esc(f.conductor || "—")}</td><td class="c">${paxCelda(f)}</td>
    <td class="c">${chip(f.estado, f.alerta ? "bad" : /adicional/i.test(f.estado) ? "warn" : /incluido/i.test(f.estado) ? "info" : "ok")}</td>
    <td class="r">${/incluido/i.test(f.estado) ? '<span style="color:#64748b">incl.</span>' : num(f.importe)}</td>
  </tr>`).join("");

  // SOLO se suman los embarcados. Sumar los contratados a lo largo del mes no significa
  // nada —son los mismos asientos cada día, y la ida y su retorno los contarían dos veces—
  // así que un "50 / 38" al pie invitaría a leer el 50 como algo que no existe.
  const totPax = d.anexo1.reduce((a, f) => a + (f.pax ?? 0), 0);
  const totImp = d.anexo1.reduce((a, f) => a + f.importe, 0);

  return `<div class="page-break"></div>
  <div style="padding-top:6px">
    <p class="titulo-anexo">ANEXO 1 — DETALLE DE SERVICIOS EJECUTADOS</p>
    <p class="sub-anexo">Respaldo día por día de la cantidad valorizada, en orden de fecha. Cada fila es un servicio finalizado en el sistema.</p>
    <table class="anx">
      <thead><tr>
        <th style="width:34px">ÍTEM</th><th style="width:42px">FECHA</th><th style="width:74px">N° AFA</th>
        <th>RUTA / SENTIDO</th><th style="width:38px">TURNO</th><th style="width:46px">PLACA</th>
        <th style="width:110px">CONDUCTOR</th><th style="width:54px">PAX<br><span style="font-weight:400">contr./emb.</span></th>
        <th style="width:56px">ESTADO</th><th style="width:60px">IMPORTE</th>
      </tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr>
        <td colspan="7" class="r">TOTALES DEL PERIODO</td>
        <td class="c">${totPax ? totPax + " emb." : "—"}</td>
        <td class="c">${d.anexo1.length} serv.</td>
        <td class="r">${num(totImp)}</td>
      </tr></tfoot>
    </table>
    <div class="nota"><b>Cómo leer este anexo:</b> las filas van en <b>orden de fecha</b>, del primer al último día del periodo; los dos tramos de un mismo día se listan juntos.
    La columna <b>ÍTEM</b> es el número con el que la fila se rastrea en la valorización, y <b>TURNO</b> es la hora programada de salida.
    La columna <b>PAX</b> muestra <b>contratados / embarcados</b>: a la izquierda los asientos pactados para esa ruta —que es lo que se factura, y no cambia porque un día suba menos gente—, y a la derecha las personas que efectivamente embarcaron según el manifiesto digital.
    Un guion significa que ese dato no está registrado, que no es lo mismo que cero. Al pie solo se totalizan los <b>embarques</b> del periodo: los asientos contratados son los mismos cada día y sumarlos no diría nada. Cualquier fila puede rastrearse con su N° AFA.
    ${d.anexo1.some((f) => /incluido/i.test(f.estado))
      ? "Los tramos marcados <b>incl.</b> corresponden al retorno del mismo servicio: una sola tarifa cubre ida y retorno, por eso comparten el número de ítem y el importe se cobra una vez. "
      : ""}
    ${moneda === "USD" ? "Importes en dólares." : "Importes en soles, sin IGV."}</div>
  </div>`;
}

function bloqueAnexo2(d: DocLiquidacion): string {
  const a = d.anexo2;
  if (!a) return "";
  const kpi = (n: string, l: string, s: string) =>
    `<div class="kpi"><div class="n">${n}</div><div class="l">${esc(l)}</div><div class="s">${esc(s)}</div></div>`;
  const incidencias = a.incidencias.length
    ? `<div class="sec"><span class="num">A</span><h2>Incidencias del periodo</h2></div>
       <table class="anx">
         <thead><tr><th style="width:44px">FECHA</th><th style="width:68px">N° AFA</th><th style="width:66px">TIPO</th><th>DESCRIPCIÓN</th><th style="width:86px">ACCIÓN</th><th style="width:56px">EFECTO</th></tr></thead>
         <tbody>${a.incidencias.map((i) => `<tr>
           <td class="c">${esc(i.fecha)}</td><td class="c">${esc(i.codigo)}</td>
           <td class="c">${chip(i.tipo, /adicional/i.test(i.tipo) ? "warn" : "bad")}</td>
           <td>${esc(i.descripcion)}</td><td>${esc(i.accion)}</td>
           <td class="r"${i.efecto != null && i.efecto < 0 ? ' style="color:#b91c1c"' : ""}>${i.efecto != null ? (i.efecto > 0 ? "+" : "−") + num(Math.abs(i.efecto)) : "—"}</td>
         </tr>`).join("")}</tbody>
       </table>`
    : `<div class="nota">Sin incidencias registradas en el periodo.</div>`;
  const unidades = a.unidades.length
    ? `<div class="sec"><span class="num">B</span><h2>Cumplimiento documentario de las unidades</h2></div>
       <table class="anx">
         <thead><tr><th style="width:50px">PLACA</th><th>UNIDAD</th><th style="width:62px">SOAT</th><th style="width:72px">REV. TÉCNICA</th><th style="width:66px">AUT. MTC</th><th style="width:58px">GPS</th><th style="width:72px">CONDUCTORES</th></tr></thead>
         <tbody>${a.unidades.map((u) => `<tr>
           <td class="c">${esc(u.placa)}</td><td>${esc(u.descripcion)}</td>
           <td class="c">${chip(u.soat, /venc/i.test(u.soat) ? "bad" : "ok")}</td>
           <td class="c">${chip(u.revision, /venc/i.test(u.revision) ? "bad" : "ok")}</td>
           <td class="c">${chip(u.mtc, /venc/i.test(u.mtc) ? "bad" : "ok")}</td>
           <td class="c">${esc(u.gps)}</td><td class="c">${esc(u.conductores)}</td>
         </tr>`).join("")}</tbody>
       </table>`
    : "";
  const pct = a.serviciosProgramados
    ? Math.round((a.serviciosEjecutados / a.serviciosProgramados) * 100)
    : 100;
  return `<div class="page-break"></div>
  <div style="padding-top:6px">
    <p class="titulo-anexo">ANEXO 2 — EVIDENCIA OPERATIVA DEL PERIODO</p>
    <p class="sub-anexo">Indicadores medidos por el sistema a partir del GPS y de los manifiestos digitales. Ningún dato se digita a mano.</p>
    <div class="kpis">
      ${kpi(`${a.serviciosEjecutados}/${a.serviciosProgramados}`, "Servicios ejecutados", `${pct}% de cumplimiento`)}
      ${kpi(a.puntualidadPct != null ? `${num(a.puntualidadPct, 1)}%` : "—", "Puntualidad en embarque", "dentro de la tolerancia pactada")}
      ${kpi(a.pasajeros != null ? num(a.pasajeros, 0) : "—", "Pasajeros transportados", a.pasajeros && a.serviciosEjecutados ? `promedio ${num(a.pasajeros / a.serviciosEjecutados, 1)} por servicio` : "según manifiesto")}
      ${kpi(a.km != null ? num(a.km, 0) : "—", "Km recorridos (GPS)", a.km && a.serviciosEjecutados ? `${num(a.km / a.serviciosEjecutados, 1)} km por servicio` : "medido por GPS")}
    </div>
    ${incidencias}
    ${unidades}
  </div>`;
}

// ── Documento completo ──────────────────────────────────────────────────────

export function buildLiquidacionHtml(d: DocLiquidacion): string {
  const cp = d.lado === "cliente" ? CP_CLIENTE : CP_PROVEEDOR;
  const emp = d.empresa;
  // Sin "—" de respaldo: `liquidacion-datos` ya entrega el perfil con los huecos rellenos
  // (lib/empresa-perfil.ts). Dejarlos aquí solo escondería que el dato no llegó.
  const pie = buildFooterPDFHtml(cp, emp.direccion || "", emp.telefono || "", emp.email || "", emp.web || "");

  const firmas = d.firmas.length
    ? `<div class="sec"><span class="num">6</span><h2>Firmas</h2></div>
       <div class="firmas">${d.firmas.map((f) =>
         // La imagen va DENTRO del hueco que la línea ya reservaba (el margen superior de
         // 34px), no encima: si se sumara, la banda de firmas crecería y en un documento de
         // varias páginas empujaría el bloque a la siguiente. Por eso la firma rubricada
         // lleva su propia clase, con el margen recortado.
         `<div class="firma">${f.firmaUrl ? `<img class="rubrica" src="${esc(f.firmaUrl)}" alt=""/>` : ""}` +
         `<div class="linea${f.firmaUrl ? " con-rubrica" : ""}"></div>` +
         `<div class="rol">${esc(f.rol)}</div><div class="ent">${esc(f.entidad)}</div></div>`
       ).join("")}</div>`
    : "";

  const cuerpo = `
    ${bloqueControl(d, cp)}
    <div class="sec"><span class="num">1</span><h2>Datos generales</h2></div>
    ${bloqueDatos(d)}
    <div class="sec"><span class="num">2</span><h2>Valorización del servicio</h2></div>
    ${bloqueValorizacion(d, cp)}
    ${bloqueDocumentacion(d, 3)}
    ${bloqueConformidad(d, 4)}
    <div class="sec"><span class="num">5</span><h2>Comentarios acerca del servicio ejecutado</h2></div>
    <div class="coment">${esc(d.comentarios || "")}</div>
    ${firmas}
    ${d.aviso ? `<div class="aviso">${esc(d.aviso)}</div>` : ""}
    ${bloqueAnexo1(d, cp)}
    ${bloqueAnexo2(d)}
  `;

  // Todo el documento va dentro de una tabla de una sola celda para poder colgar el
  // pie de un <tfoot>: el navegador lo repite al pie de CADA hoja impresa y —esto es
  // lo que no hacía `position:fixed`— le reserva el sitio, así que el contenido nunca
  // más pasa por debajo de la banda. La cabecera controlada, en cambio, va en el flujo
  // y sale una sola vez: cada anexo trae la suya propia y repetirla robaría media hoja.
  const cuerpoImpreso = `<table class="hoja">
    <tfoot><tr><td>${pie}</td></tr></tfoot>
    <tbody><tr><td>${cuerpo}</td></tr></tbody>
  </table>`;
  const css = sharedCSS(CSS_DOC(cp)) + CSS_IMPRESION;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
    <title>${esc(d.control.titulo)} ${esc(d.codigo)}</title>
    <style>${css}</style></head>
    <body>${cuerpoImpreso}</body></html>`;
}
