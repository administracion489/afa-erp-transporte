// Ficha Técnica de Ruta — armado del documento imprimible.
//
// Está fuera de la página para poder generar el HTML sin navegador ni sesión (ver
// scripts/muestra-ficha-ruta.mjs): así el diseño se revisa sin tocar datos reales.
// La página solo resuelve los datos, abre la ventana y escribe lo que devuelve esto.

import { buildHeaderPDFHtml, buildFooterPDFHtml, sharedCSS, LOGO_DEFAULT, buildVehsHtml, type VehiculoPDF } from "./pdf-chrome";
import { filasConAcumulados, rolLabel, fmtKm, fmtDuracion, fmtCoord, esc, type PuntoFicha, type FilaFicha, type FichaRutaCache, type MetricaSentido } from "./ficha-ruta";

export const CP_FICHA = "#0b315f";
export const C_IDA = "#0b315f";
export const C_RET = "#6d28d9";

export const CONDICIONES_FICHA = [
  "El embarque y desembarque se realiza únicamente en los puntos autorizados de esta ficha.",
  "Tolerancia máxima de espera en cada punto: 5 minutos sobre la hora programada.",
  "Cualquier cambio de paradero, horario o recorrido debe solicitarse con 24 horas de anticipación y genera una nueva versión de esta ficha.",
  "La unidad cuenta con GPS: el cliente puede seguir el servicio en tiempo real desde el portal.",
  "Las horas marcadas en gris son estimadas — se calculan con tiempos de recorrido promedio y pueden variar por tráfico o clima.",
  "Ante cualquier incidencia en ruta, comunicarse de inmediato con la central de operaciones.",
];

export type FichaRutaDatos = {
  nCot: string;
  anio: number;
  emitida: string;
  cliente: { nombre: string; docLabel: string; doc: string; contacto: string; telefono: string };
  servicio: { ruta: string; modalidad: string; inicio: string; retornoLabel: string; retorno: string };
  horaIda: string;
  horaRetorno: string;
  puntosIda: PuntoFicha[];
  puntosRet: PuntoFicha[];
  metrica: FichaRutaCache | null;
  mapaIda: string;
  mapaRet: string;
  /** QR por sentido: el recorrido de retorno no es el inverso del de ida, son otras coordenadas. */
  qrIda: string;
  qrRet: string;
  /** Unidades asignadas: se muestran con foto y descripción, igual que en la cotización. */
  vehiculos: VehiculoPDF[];
  /** Placas y modelos en una línea; vacío si todavía no hay unidad asignada. */
  unidadDetalle: string;
  empresa: { nombre: string; email: string; telefono: string; web: string; direccion: string; logo: string };
  aviso: string;
};

const celda = (v: string, extra = "") => `<td style="padding:5px 6px;border:1px solid #d7dde5;${extra}">${v}</td>`;

function buildTablaPuntos(filas: FilaFicha[], color: string): string {
  // En muchas cotizaciones el nombre del paradero YA es la dirección completa y el campo
  // dirección viene vacío: mostrar una columna entera de guiones solo roba ancho.
  const hayDirs = filas.some(f => f.direccion.trim() !== "");
  const cuerpo = filas.map(f => {
    const bg = f.rol === "embarque" ? "#dcfce7" : f.rol === "llegada" ? "#fee2e2" : "#f1f5f9";
    const fg = f.rol === "embarque" ? "#166534" : f.rol === "llegada" ? "#991b1b" : "#475569";
    const badge = `<span style="display:inline-block;font-size:8px;font-weight:900;text-transform:uppercase;padding:1px 5px;border-radius:8px;background:${bg};color:${fg};">${rolLabel(f.rol)}</span>`;
    const hora = f.hora_mostrada
      ? (f.hora_estimada ? `<span style="color:#94a3b8;font-style:italic;">${esc(f.hora_mostrada)}</span>` : `<b>${esc(f.hora_mostrada)}</b>`)
      : "—";
    return `<tr>`
      + celda(`<b style="color:${color};">${esc(f.codigo)}</b>`, "text-align:center;white-space:nowrap;")
      + celda(`<b>${esc(f.nombre)}</b><br/>${badge}`)
      + (hayDirs ? celda(esc(f.direccion || "—"), "font-size:9px;color:#475569;") : "")
      + celda(fmtCoord(f), "font-size:8.5px;color:#64748b;text-align:center;white-space:nowrap;")
      + celda(hora, "text-align:center;white-space:nowrap;")
      + celda(f.km_tramo === null ? "—" : fmtKm(f.km_tramo), "text-align:right;white-space:nowrap;")
      + celda(f.km_acum === null ? "—" : fmtKm(f.km_acum), "text-align:right;white-space:nowrap;")
      + celda(f.min_acum === null ? "—" : fmtDuracion(f.min_acum), "text-align:right;white-space:nowrap;")
      + `</tr>`;
  }).join("");
  const th = ["CÓD.", "PUNTO", ...(hayDirs ? ["REFERENCIA / DIRECCIÓN"] : []), "COORDENADAS", "HORA", "TRAMO", "ACUM.", "T. ACUM."]
    .map((h, i) => `<th style="border:1px solid ${color};padding:5px 6px;font-size:8.5px;color:#fff;text-align:${i === 1 || (hayDirs && i === 2) ? "left" : "center"};">${h}</th>`).join("");
  return `<table class="tbl-puntos"><thead style="background:${color};"><tr>${th}</tr></thead><tbody>${cuerpo}</tbody></table>`;
}

function buildSeccion(titulo: string, sentido: string, color: string, filas: FilaFicha[], mapa: string, metrica: MetricaSentido | null, qr: string): string {
  if (!filas.length) {
    return `<div class="ficha-sec"><div class="ficha-sec-h" style="border-color:${color};"><span style="color:${color};">${titulo}</span></div>`
      + `<p style="font-size:10px;color:#94a3b8;margin:8px 0 0;">No se ha definido un tramo de ${sentido} para este servicio.</p></div>`;
  }
  const resumen = metrica
    ? `<span style="font-size:9px;color:#64748b;">${fmtKm(metrica.total_km)} · ${fmtDuracion(metrica.total_min)} · ${filas.length} puntos</span>`
    : `<span style="font-size:9px;color:#64748b;">${filas.length} puntos</span>`;
  // El QR va sobre el mapa, en la esquina superior izquierda: cada sentido tiene el suyo
  // porque el recorrido de retorno no es el inverso del de ida.
  const qrSobreMapa = qr
    ? `<div class="ficha-qr"><img src="${qr}"/><p>Abrir<br/>${esc(sentido)}<br/>en Maps</p></div>`
    : "";
  const img = mapa
    ? `<div class="ficha-mapa"><img class="mapa" src="${mapa}" onerror="this.closest('.ficha-mapa').style.display='none'"/>${qrSobreMapa}<p class="pie">Recorrido referencial por vía — ${esc(sentido)}</p></div>`
    : (qr ? `<div class="ficha-qr-suelto">${qrSobreMapa}</div>` : "");
  return `<div class="ficha-sec">
    <div class="ficha-sec-h" style="border-color:${color};"><span style="color:${color};">${titulo}</span>${resumen}</div>
    ${buildTablaPuntos(filas, color)}
    ${img}
  </div>`;
}

export function buildFichaRutaHtml(d: FichaRutaDatos): string {
  const filasIda = filasConAcumulados(d.puntosIda, d.metrica?.ida || null);
  const filasRet = filasConAcumulados(d.puntosRet, d.metrica?.retorno || null);
  const kpi = (t: string, v: string, c = CP_FICHA) => `<div class="ficha-kpi"><p class="k">${t}</p><p class="v" style="color:${c};">${esc(v)}</p></div>`;
  const kpis = [
    kpi("Recorrido de entrada", d.metrica?.ida ? fmtKm(d.metrica.ida.total_km) : "—"),
    kpi("Duración estimada", d.metrica?.ida ? fmtDuracion(d.metrica.ida.total_min) : "—"),
    kpi("Puntos de entrada", String(filasIda.length)),
    kpi("Puntos de retorno", String(filasRet.length), C_RET),
    kpi("Hora de salida", d.horaIda || "—"),
    kpi("Hora de retorno", d.horaRetorno || "—", C_RET),
  ].join("");

  const css = sharedCSS(`
    /* Es un documento para imprimir: el modo oscuro del navegador apagaba las tablas. */
    :root{color-scheme:light}
    html,body{background:#fff;color:#1a1a1a}
    /* Encabezado y pie sangran a los bordes del papel, como en el PDF de cotización:
       por eso @page va sin márgenes y los laterales se los pone el cuerpo.
       - El encabezado va en un thead, que se repite por página OCUPANDO espacio: con
         position:fixed Chrome lo ancla al área de contenido y tapaba el texto desde la
         página 2.
       - El pie sí queda fijo al fondo de la hoja (si fuera tfoot, en la última página
         quedaría flotando a media hoja, justo debajo del contenido). El tfoot vacío
         existe solo para reservarle el sitio y que nada pase por debajo. */
    @page{size:A4;margin:0}
    body{padding:0}
    .doc{width:100%;border-collapse:collapse}
    .doc>thead{display:table-header-group}
    .doc>tfoot{display:table-footer-group}
    .doc .pdf-header{position:static}
    .doc td.cuerpo{padding:14px 12mm 10px;vertical-align:top}
    .doc td.hueco-pie{height:42px}
    .ficha-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    .box{border:1px solid #d7dde5;border-radius:5px;padding:8px 10px}
    .box-title{font-weight:900;font-size:9.5px;color:${CP_FICHA};text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-bottom:6px}
    .box-row{margin:3px 0;font-size:10px}
    .ficha-kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:0}
    .ficha-kpi{border:1px solid #e2e8f0;border-radius:5px;padding:6px 7px;background:#f8fafc;text-align:center}
    .ficha-kpi .k{margin:0;font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;color:#94a3b8}
    .ficha-kpi .v{margin:3px 0 0;font-size:11px;font-weight:900}
    .ficha-sec{margin-top:14px}
    /* La foto de la unidad y el bloque de firmas no deben partirse entre páginas. */
    .ficha-sec.entera{page-break-inside:avoid}
    .ficha-sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid;padding-bottom:4px;margin-bottom:8px;page-break-after:avoid;break-after:avoid}
    .tbl-puntos{width:100%;border-collapse:collapse;font-size:9.5px}
    .tbl-puntos thead{display:table-header-group}
    .tbl-puntos tbody tr:nth-child(even){background:#f8fafc}
    .tbl-puntos tbody tr{page-break-inside:avoid}
    .ficha-mapa{position:relative;margin-top:8px;text-align:center;page-break-inside:avoid}
    .ficha-mapa img.mapa{width:100%;max-width:100%;max-height:300px;object-fit:cover;border:1px solid #d7dde5;border-radius:5px;display:block}
    .ficha-mapa p.pie{margin:3px 0 0;font-size:8px;color:#94a3b8}
    .ficha-qr{position:absolute;top:7px;left:7px;background:#fff;border:1px solid #cbd5e1;border-radius:5px;padding:4px 4px 3px;width:72px;box-shadow:0 1px 3px rgba(0,0,0,.18)}
    .ficha-qr img{width:64px;height:64px;display:block;margin:0 auto}
    .ficha-qr p{margin:2px 0 0;font-size:6px;font-weight:700;text-transform:uppercase;letter-spacing:.2px;color:#475569;line-height:1.25;text-align:center}
    .ficha-qr-suelto{margin-top:8px;position:relative;height:96px}
    .ficha-cond li{font-size:9.5px;color:#334155;line-height:1.7}
    .ficha-firmas{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:34px;page-break-inside:avoid}
    .ficha-firma{text-align:center}
    .ficha-firma .linea{border-top:1px solid #64748b;margin-bottom:4px}
    .ficha-firma p{margin:0;font-size:9px;color:#475569}
    .ficha-firma .rol{font-weight:900;color:${CP_FICHA};font-size:9.5px}
  `);

  const header = buildHeaderPDFHtml(d.empresa.logo || LOGO_DEFAULT, CP_FICHA, "FICHA TÉCNICA DE RUTA",
    `Doc. FTR-${esc(d.nCot)}-${d.anio} · Cotización N° ${esc(d.nCot)} · Emitida: ${esc(d.emitida)}`);
  const footer = buildFooterPDFHtml(CP_FICHA, esc(d.empresa.direccion), esc(d.empresa.telefono), esc(d.empresa.email), esc(d.empresa.web));

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Ficha Técnica de Ruta — ${esc(d.nCot)}</title><style>${css}</style></head><body>
${footer}
<table class="doc"><thead><tr><td>${header}</td></tr></thead><tfoot><tr><td class="hueco-pie"></td></tr></tfoot><tbody><tr><td class="cuerpo">
<div class="ficha-grid2">
  <div class="box"><div class="box-title">Cliente</div>
    <div class="box-row"><b>RAZÓN SOCIAL:</b> ${esc(d.cliente.nombre)}</div>
    <div class="box-row"><b>${esc(d.cliente.docLabel)}:</b> ${esc(d.cliente.doc)}</div>
    <div class="box-row"><b>CONTACTO:</b> ${esc(d.cliente.contacto)}</div>
    <div class="box-row"><b>TELÉFONO:</b> ${esc(d.cliente.telefono)}</div>
  </div>
  <div class="box"><div class="box-title">Servicio</div>
    <div class="box-row"><b>RUTA:</b> ${esc(d.servicio.ruta)}</div>
    <div class="box-row"><b>MODALIDAD:</b> ${esc(d.servicio.modalidad)}</div>
    <div class="box-row"><b>INICIO:</b> ${esc(d.servicio.inicio)}</div>
    <div class="box-row"><b>${esc(d.servicio.retornoLabel)}:</b> ${esc(d.servicio.retorno)}</div>
  </div>
</div>
<div class="ficha-kpis">${kpis}</div>
${d.aviso ? `<div style="border:1px solid #fcd34d;background:#fffbeb;border-radius:5px;padding:6px 9px;font-size:9px;color:#92400e;margin-top:6px;">${esc(d.aviso)}</div>` : ""}
${buildSeccion("Puntos de entrada (ida)", "ida", C_IDA, filasIda, d.mapaIda, d.metrica?.ida || null, d.qrIda)}
${buildSeccion("Puntos de retorno (salida)", "retorno", C_RET, filasRet, d.mapaRet, d.metrica?.retorno || null, d.qrRet)}
<div class="ficha-sec entera">
  <div class="ficha-sec-h" style="border-color:${CP_FICHA};"><span style="color:${CP_FICHA};">Unidad asignada</span></div>
  <div class="box">
    ${d.unidadDetalle ? `<div class="box-row" style="font-weight:900;color:${CP_FICHA};">${esc(d.unidadDetalle)}</div>` : ""}
    ${d.vehiculos.length ? buildVehsHtml(d.vehiculos, CP_FICHA, { imgH: "150px", radius: "6px", contain: true }) : `<div class="box-row" style="color:#94a3b8;">Unidad por asignar.</div>`}
  </div>
</div>
<div class="ficha-sec entera">
  <div class="ficha-sec-h" style="border-color:${CP_FICHA};"><span style="color:${CP_FICHA};">Condiciones operativas</span></div>
  <ul class="ficha-cond">${CONDICIONES_FICHA.map(c => `<li>${esc(c)}</li>`).join("")}</ul>
  <p style="font-size:9px;color:#475569;margin:6px 0 0;"><b>Central de operaciones:</b> ${esc(d.empresa.telefono)} · ${esc(d.empresa.email)}</p>
</div>
<div class="ficha-firmas">
  <div class="ficha-firma"><div class="linea"></div><p class="rol">${esc(d.empresa.nombre)}</p><p>Coordinación de operaciones</p><p>Firma y sello</p></div>
  <div class="ficha-firma"><div class="linea"></div><p class="rol">${esc(d.cliente.nombre)}</p><p>Firma y sello de conformidad</p><p>Fecha: ____ / ____ / ________</p></div>
</div>
</td></tr></tbody></table>
</body></html>`;
}
