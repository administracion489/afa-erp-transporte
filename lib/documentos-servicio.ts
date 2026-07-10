// ══════════════════════════════════════════════════════════════════════════════
// lib/documentos-servicio.ts
// Fuente ÚNICA de los documentos imprimibles de un servicio (data-in → HTML-string-out).
//
// PURO: no importa Supabase, no lee estado de React, no toca `window` DENTRO de los
// templates. Cada portal (portal cliente, ERP /seguimiento) hace su propia carga de
// datos con su auth/scoping y solo mapea a `DatosServicioDoc`, pasando URLs de logo/
// firma ya resueltas. Así el Manifiesto MTC (documento legal R.D. 1946-2009-MTC-15)
// es idéntico donde se imprima: cambiar una columna o el N° de resolución se hace acá.
//
// El único helper impuro (`abrirImprimible`) usa window.open y va aparte a propósito.
// ══════════════════════════════════════════════════════════════════════════════

// Fuente de verdad del abordaje en TODO el ERP: pasajeros_parada (estado + estado_abordaje,
// sincronizadas por trigger en BD). boarding_log se agregó después y está sin backfill, así
// que NO sirve para contar embarcados de servicios históricos. Misma lógica que conductor/lector.
export const esAbordado = (
  pp?: { estado?: string | null; estado_abordaje?: string | null } | null,
): boolean =>
  pp?.estado_abordaje === "Abordado" || pp?.estado === "abordado" || pp?.estado === "embarcado";

// Escape de HTML para TODO dato dinámico interpolado. El nombre/DNI del pasajero es editable
// por el propio pasajero (perfil "Mis datos") y por carga CSV: sin escapar, un nombre con
// <script>/<img onerror> se ejecutaría en la sesión del operador al imprimir (el HTML se
// inyecta con document.write en una ventana que hereda el origin del ERP). Para datos
// legítimos (sin < > & " ') es un no-op → la salida sigue byte-idéntica.
const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// ─── Formateo en hora Perú (no usar toISOString para "hoy") ──────────────────
const fmtFecha = (f: string | null | undefined) =>
  f ? new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "–";
const fmtTs = (ts: string) => new Date(ts).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
const fmtDur = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);
const fmtSoles = (n: number) => `S/ ${Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2 })}`;

// ─── Estructura normalizada que reciben los templates ────────────────────────
export type DocParada = {
  id: number;
  orden: number;
  nombre: string;
  hora_estimada?: string | null;
};

export type DocPasajero = {
  parada_id: number | null;
  pasajero_id: number;
  estado?: string | null;
  estado_abordaje?: string | null;
  hora_abordaje?: string | null;
  pasajero?: { nombre?: string | null; dni?: string | null; edad?: number | null } | null;
};

export type DocBoarding = { pasajero_id: number; timestamp: string };

export type DatosServicioDoc = {
  empresa: {
    nombre?: string | null;
    ruc?: string | null;
    telefono?: string | null;
    email?: string | null;
    // Manifiesto MTC: logo desde empresa_perfil.logo_url (el template aplica el fallback
    // "/logoafacotizacion.jpg" si viene null). El caller pasa el valor crudo.
    logoUrl?: string | null;
    // Reporte de servicio: logo de cabecera y firma, ya resueltos por el caller
    // (window.location.origin + ruta), porque la lib no depende de window.
    logoReporteUrl?: string | null;
    firmaUrl?: string | null;
  };
  cliente: { nombre?: string | null; ruc?: string | null };
  servicio: {
    fecha: string | null;
    hora?: string | null;
    origen?: string | null;
    destino?: string | null;
  };
  conductor?: { nombre?: string | null; licencia?: string | null } | null;
  vehiculo?: { placa?: string | null; modelo?: string | null } | null;
  paradas?: DocParada[];
  pasajeros: DocPasajero[];
  boarding?: DocBoarding[];
  // Bloque opcional SOLO para el Reporte de Servicio del operador (no lo usa el portal
  // cliente → su salida queda byte-idéntica). Datos internos: liquidación / auditoría.
  // horaRealInicio / horaRealFin son strings de hora del día ("HH:MM") ya recortados por
  // el caller — NO timestamps (se imprimen tal cual). duracionMin ya viene calculada.
  operativo?: {
    horaRealInicio?: string | null;
    horaRealFin?: string | null;
    duracionMin?: number | null;
    gastosTotal?: number | null;
    gpsUrl?: string | null;
  } | null;
  generadoEn?: Date;
};

// ─── Reporte de Servicio (detalle de embarques + % cumplimiento + firma) ─────
export function reporteServicioHTML(d: DatosServicioDoc): string {
  const ps = d.paradas || [];
  const bl = d.boarding || [];   // boarding_log: solo para método/hora si existe
  const pp = d.pasajeros || [];
  // El abordaje se determina por pasajeros_parada.estado_abordaje (boarding_log está vacía).
  const totalEsp = pp.length, totalEmb = pp.filter(esAbordado).length;
  const pct = totalEsp > 0 ? Math.min(100, Math.round((totalEmb / totalEsp) * 100)) : 0;
  const noEmb = pp.filter(p => !esAbordado(p));
  const empNombre = d.empresa?.nombre || "AFA Tours Peru S.A.C.";
  const empTel    = d.empresa?.telefono || "966 707 225";
  const empEmail  = d.empresa?.email || "transporte@afatoursperu.com";
  const pdfLogo   = d.empresa?.logoReporteUrl || "";
  const firmaUrl  = d.empresa?.firmaUrl || "";
  const clienteNom = d.cliente?.nombre || "";
  const now       = d.generadoEn || new Date();

  const filasParadas = ps.map(p => {
    const ppP = pp.filter(x => x.parada_id === p.id);
    const embP = ppP.filter(esAbordado).length;
    return `
      <tr style="background:#eff6ff"><td colspan="4" style="padding:8px 14px;font-weight:800;color:#1e40af;font-size:10.5px;border-bottom:1px solid #dbeafe;letter-spacing:.2px">
        ${p.orden}. ${esc(p.nombre)}${p.hora_estimada ? ` &nbsp;·&nbsp; ${esc(p.hora_estimada)}` : ""} &nbsp;<span style="font-weight:500;color:#64748b;font-size:10px">(${embP}/${ppP.length} embarcaron)</span>
      </td></tr>
      ${ppP.map((x, xi) => { const emb = esAbordado(x); const blRow = bl.find(b => b.pasajero_id === x.pasajero_id); const hora = x.hora_abordaje || blRow?.timestamp; return `<tr style="background:${xi%2===0?"#fff":"#f8fafc"}">
        <td style="padding:7px 14px;border-bottom:1px solid #f1f5f9">${esc(x.pasajero?.nombre || `#${x.pasajero_id}`)}</td>
        <td style="padding:7px 14px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:10px;color:#475569">${esc(x.pasajero?.dni || "–")}</td>
        <td style="padding:7px 14px;border-bottom:1px solid #f1f5f9;text-align:center"><span style="font-size:10px;font-weight:700;padding:2px 10px;border-radius:12px;background:${emb?"#dbeafe":"#f1f5f9"};color:${emb?"#1e40af":"#475569"}">${emb ? "✓ Embarcó" : "✗ No asistió"}</span></td>
        <td style="padding:7px 14px;border-bottom:1px solid #f1f5f9;color:#64748b;font-family:monospace;font-size:10px">${hora ? fmtTs(hora) : "–"}</td>
      </tr>`; }).join("")}`;
  }).join("");

  // Pasajeros del manifiesto sin paradero asignado (parada_id null)
  const ppSinParada = pp.filter(x => !x.parada_id);
  const filasSinParada = ppSinParada.length === 0 ? "" : `
      <tr style="background:#fef3c7"><td colspan="4" style="padding:8px 14px;font-weight:800;color:#92400e;font-size:10.5px;border-bottom:1px solid #fde68a;letter-spacing:.2px">
        Sin paradero asignado &nbsp;<span style="font-weight:500;color:#64748b;font-size:10px">(${ppSinParada.length} pasajero${ppSinParada.length !== 1 ? "s" : ""})</span>
      </td></tr>
      ${ppSinParada.map((x, xi) => { const emb = esAbordado(x); const blRow = bl.find(b => b.pasajero_id === x.pasajero_id); const hora = x.hora_abordaje || blRow?.timestamp; return `<tr style="background:${xi%2===0?"#fff":"#f8fafc"}">
        <td style="padding:7px 14px;border-bottom:1px solid #f1f5f9">${esc(x.pasajero?.nombre || `#${x.pasajero_id}`)}</td>
        <td style="padding:7px 14px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:10px;color:#475569">${esc(x.pasajero?.dni || "–")}</td>
        <td style="padding:7px 14px;border-bottom:1px solid #f1f5f9;text-align:center"><span style="font-size:10px;font-weight:700;padding:2px 10px;border-radius:12px;background:${emb?"#dbeafe":"#f1f5f9"};color:${emb?"#1e40af":"#475569"}">${emb ? "✓ Embarcó" : "✗ No asistió"}</span></td>
        <td style="padding:7px 14px;border-bottom:1px solid #f1f5f9;color:#64748b;font-family:monospace;font-size:10px">${hora ? fmtTs(hora) : "–"}</td>
      </tr>`; }).join("")}`;

  const filas = filasParadas + filasSinParada;

  // Bloque operativo (uso interno AFA) — SOLO si el caller lo provee (portal cliente no →
  // salida byte-idéntica). Ojo: termina en "\n" y se pega directo al <div class="box">
  // siguiente para no dejar un salto de línea extra cuando está vacío.
  const op = d.operativo;
  const bloqueOperativo = !op ? "" : `<div class="box" style="margin-bottom:14px">
  <div class="bt">Operación interna &nbsp;·&nbsp; uso AFA</div>
  <div class="g2" style="margin-bottom:0">
    <div>
      ${op.horaRealInicio ? `<div class="kv"><span class="lbl">Inicio real</span><span class="val" style="font-family:monospace">${esc(op.horaRealInicio)}</span></div>` : ""}
      ${op.horaRealFin ? `<div class="kv"><span class="lbl">Fin real</span><span class="val" style="font-family:monospace">${esc(op.horaRealFin)}</span></div>` : ""}
      ${op.duracionMin != null && !Number.isNaN(op.duracionMin) ? `<div class="kv"><span class="lbl">Duración</span><span class="val">${fmtDur(op.duracionMin)}</span></div>` : ""}
    </div>
    <div>
      ${op.gastosTotal != null ? `<div class="kv"><span class="lbl">Gastos del servicio</span><span class="val">${fmtSoles(op.gastosTotal)}</span></div>` : ""}
      ${op.gpsUrl ? `<div class="kv"><span class="lbl">Recorrido GPS</span><span class="val"><a href="${op.gpsUrl}" style="color:#0b315f;text-decoration:none">Ver en el sistema</a></span></div>` : ""}
    </div>
  </div>
</div>
`;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Reporte · ${fmtFecha(d.servicio.fecha)}</title>
<style>
@page{size:A4;margin:16mm 14mm}
*{box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#1e293b;margin:0;background:#fff}
.hd{display:flex;justify-content:space-between;align-items:center;border:1.5px solid #cbd5e1;border-left:5px solid #0b315f;padding:10px 16px;gap:12px;background:#f8faff;margin-bottom:0;border-radius:4px 4px 0 0}
.hd-center{text-align:center;flex:1}
.hd-right{text-align:right;min-width:120px}
.hd-title{background:linear-gradient(135deg,#0b315f 0%,#1e4d8c 100%);padding:9px 18px;margin-bottom:18px;border-radius:0 0 4px 4px}
.hd-title h1{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:2px;margin:0;color:#fff}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.box{border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;background:#fff}
.box-accent{border-left:4px solid #0b315f}
.box-green{border-left:4px solid #1e4d8c}
.box-red{border-left:4px solid #334155}
.bt{font-weight:800;font-size:9px;color:#0b315f;text-transform:uppercase;letter-spacing:1px;padding-bottom:8px;margin-bottom:10px;border-bottom:1.5px solid #e2e8f0}
table{width:100%;border-collapse:collapse;font-size:10.5px;margin-bottom:0}
thead tr{background:#f1f5f9}
thead th{padding:8px 14px;text-align:left;font-size:9px;color:#475569;font-weight:700;letter-spacing:.5px;border-bottom:2px solid #cbd5e1;text-transform:uppercase}
tbody tr:nth-child(even){background:#f8fafc}
tbody td{vertical-align:middle}
.kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:10.5px}
.kv:last-child{border-bottom:none}
.kv .lbl{color:#64748b}
.kv .val{font-weight:700;color:#1e293b}
.ft{border-top:1.5px solid #e2e8f0;padding-top:10px;text-align:center;font-size:8.5px;color:#94a3b8;margin-top:20px}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="hd">
  <div><img src="${pdfLogo}" alt="AFA" style="height:52px;object-fit:contain;max-width:150px"/></div>
  <div class="hd-center">
    <p style="font-size:10px;font-weight:900;margin:0;text-transform:uppercase;letter-spacing:.6px;color:#0b315f">AFA TOURS PERU SAC</p>
    <p style="font-size:8px;color:#475569;margin:3px 0 1px">Calle la bajada Mz F Lote 2, Lurigancho</p>
    <p style="font-size:8px;color:#475569;margin:1px 0">Tel: 966707225 / 01-3453707</p>
    <p style="font-size:8px;color:#475569;margin:1px 0">transporte@afatoursperu.com</p>
  </div>
  <div class="hd-right">
    <p style="font-size:8px;color:#64748b;margin:0;font-weight:700;text-transform:uppercase;letter-spacing:.5px">Reporte de Servicio</p>
    <p style="font-size:7.5px;color:#94a3b8;margin:4px 0 2px">Generado: ${now.toLocaleDateString("es-PE")} ${now.toLocaleTimeString("es-PE",{hour:"2-digit",minute:"2-digit"})}</p>
    <p style="font-size:7.5px;color:#94a3b8;margin:0">Total esperados: <b style="color:#0b315f;font-size:9px">${totalEsp}</b></p>
  </div>
</div>
<div class="hd-title"><h1>Detalle de embarques &nbsp;·&nbsp; ${fmtFecha(d.servicio.fecha)}</h1></div>
<div class="g2">
  <div class="box box-accent">
    <div class="bt">Datos del servicio</div>
    <div class="kv"><span class="lbl">Cliente</span><span class="val">${esc(clienteNom)}</span></div>
    <div class="kv"><span class="lbl">RUC</span><span class="val" style="font-family:monospace">${esc(d.cliente?.ruc || "–")}</span></div>
    <div class="kv"><span class="lbl">Fecha</span><span class="val">${fmtFecha(d.servicio.fecha)}</span></div>
    <div class="kv"><span class="lbl">Hora</span><span class="val" style="font-family:monospace">${esc(d.servicio.hora?.slice(0,5) || "–")}</span></div>
    <div class="kv"><span class="lbl">Ruta</span><span class="val">${esc(d.servicio.origen)} → ${esc(d.servicio.destino)}</span></div>
  </div>
  <div class="box box-green">
    <div class="bt">Cumplimiento</div>
    <div class="kv"><span class="lbl">Pasajeros esperados</span><span class="val">${totalEsp}</span></div>
    <div class="kv"><span class="lbl">Embarcaron</span><span class="val" style="color:#0b315f">${totalEmb}</span></div>
    <div class="kv"><span class="lbl">No asistieron</span><span class="val" style="color:#475569">${noEmb.length}</span></div>
    <div style="margin-top:12px;height:8px;background:#f1f5f9;border-radius:4px;overflow:hidden"><div style="height:100%;background:#0b315f;width:${pct}%;border-radius:4px"></div></div>
    <p style="font-weight:900;font-size:22px;color:#0b315f;margin:8px 0 0;letter-spacing:-0.5px">${pct}% <span style="font-size:11px;font-weight:600;color:#64748b">de cumplimiento</span></p>
  </div>
</div>
${bloqueOperativo}<div class="box" style="margin-bottom:14px">
  <div class="bt">Detalle de embarques por parada</div>
  <table><thead><tr><th>Pasajero</th><th>DNI</th><th>Estado</th><th>Hora embarque</th></tr></thead><tbody>${filas || `<tr><td colspan="4" style="text-align:center;padding:16px;color:#94a3b8;font-style:italic">Sin datos de embarque registrados</td></tr>`}</tbody></table>
</div>
${noEmb.length > 0 ? `<div class="box box-red" style="margin-bottom:14px"><div class="bt">No se presentaron · ${noEmb.length} pasajero${noEmb.length!==1?"s":""}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${noEmb.map(x => `<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;font-size:10px"><b style="color:#1e293b">${esc(x.pasajero?.nombre||`#${x.pasajero_id}`)}</b><br/><span style="color:#94a3b8;font-family:monospace">${esc(x.pasajero?.dni||"Sin DNI")}</span></div>`).join("")}</div></div>` : ""}
<div class="box">
  <div class="bt">Firma de conformidad</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:48px;margin-top:16px;align-items:end">
    <div style="text-align:center">
      <img src="${firmaUrl}" alt="Firma" style="width:80%;max-height:75px;height:auto;object-fit:contain;object-position:bottom;display:block;margin:0 auto 6px"/>
      <div style="border-top:1.5px solid #334155;padding-top:6px;font-size:10px;color:#334155"><b>${esc(empNombre)}</b><br/><span style="color:#64748b;font-size:9px">Gerente General / Representante legal</span></div>
    </div>
    <div style="text-align:center">
      <div style="border-top:1.5px solid #334155;padding-top:6px;font-size:10px;color:#334155"><b>${esc(clienteNom)}</b><br/><span style="color:#64748b;font-size:9px">Responsable del servicio</span></div>
    </div>
  </div>
</div>
<div class="ft">${esc(empNombre)} &nbsp;·&nbsp; ${esc(empTel)} &nbsp;·&nbsp; ${esc(empEmail)}</div>
<script>window.onload=()=>window.print()</script></body></html>`;
}

// ─── Manifiesto oficial R.D. 1946-2009-MTC-15 ─────────────────────────────
export function manifiestoMtcHTML(d: DatosServicioDoc): string {
  const bl  = d.boarding || [];
  const pp  = d.pasajeros || [];
  const cond = d.conductor;
  const vehi = d.vehiculo;
  const now  = d.generadoEn || new Date();
  const logoUrl = d.empresa?.logoUrl || "/logoafacotizacion.jpg";
  const clienteNom = d.cliente?.nombre || "";

  const fmtQR = (ts: string) => {
    const dd = new Date(ts);
    return `${String(dd.getHours()).padStart(2,"0")}:${String(dd.getMinutes()).padStart(2,"0")} - ${String(dd.getDate()).padStart(2,"0")}/${String(dd.getMonth()+1).padStart(2,"0")}`;
  };

  let filas = "";
  pp.forEach((x, idx) => {
    // Abordaje por estado_abordaje (boarding_log está vacía); hora desde hora_abordaje.
    const embarco    = esAbordado(x);
    const blRow      = bl.find(b => b.pasajero_id === x.pasajero_id);
    const horaAb     = x.hora_abordaje || blRow?.timestamp || null;
    const tsTxt      = horaAb ? fmtQR(horaAb) : "";
    const edadStr    = (x.pasajero as any)?.edad ? String((x.pasajero as any).edad) : "–";
    filas += `
      <tr>
        <td style="padding:5px 8px;border:1px solid #374151;text-align:center;font-weight:700;width:48px">${idx + 1}</td>
        <td style="padding:5px 8px;border:1px solid #374151;font-weight:600">${esc(x.pasajero?.nombre || "–")}</td>
        <td style="padding:5px 8px;border:1px solid #374151;text-align:center;font-family:monospace;width:105px">${esc(x.pasajero?.dni || "–")}</td>
        <td style="padding:5px 8px;border:1px solid #374151;text-align:center;width:46px">${esc(edadStr)}</td>
        <td style="padding:0;border:1px solid #374151;width:150px;vertical-align:top">
          <div style="${embarco ? 'background:#f0fdf4;' : ''}padding:4px 6px;min-height:24px;border-bottom:1px dotted #d1d5db">
            ${embarco
              ? `<div style="font-size:7.5px;color:#166534;font-weight:700;font-family:monospace">&#10003; ABORDADO${tsTxt ? " " + tsTxt : ""}</div>`
              : `<div style="font-size:7.5px;color:#9ca3af;font-style:italic">Pendiente</div>`
            }
          </div>
          <div style="min-height:34px;padding:4px 6px;display:flex;flex-direction:column;justify-content:flex-end">
            <div style="border-top:1px dotted #9ca3af;padding-top:2px;font-size:6px;color:#9ca3af;text-align:center">Firma / Huella digital</div>
          </div>
        </td>
      </tr>`;
  });

  if (!filas) {
    filas = `<tr><td colspan="5" style="padding:16px;text-align:center;border:1px solid #374151;color:#6b7280;font-style:italic">Sin pasajeros registrados en este servicio</td></tr>`;
  }

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Manifiesto MTC · ${fmtFecha(d.servicio.fecha)}</title>
<style>
@page{size:A4;margin:14mm 12mm}*{box-sizing:border-box}
body{font-family:Arial,sans-serif;font-size:9.5px;color:#111827;margin:0}
.hd-top{display:flex;justify-content:space-between;align-items:center;border:2px solid #111827;padding:10px 14px;gap:12px}
.hd-empresa{text-align:center;flex:1}
.hd-right{text-align:right;min-width:110px}
.hd-title{text-align:center;border:2px solid #111827;border-top:none;padding:7px;background:#f9fafb}
.hd-title h1{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:2px;margin:0;color:#111827}
.hd-title p{font-size:8px;color:#6b7280;margin:3px 0 0}
.data-grid{display:grid;grid-template-columns:1fr 1fr;border:2px solid #111827;border-top:none}
.dc{padding:5px 10px;border-right:1px solid #9ca3af;border-bottom:1px solid #9ca3af}
.dc:nth-child(even){border-right:none}
.dc:nth-last-child(1):nth-child(odd){grid-column:1/-1;border-right:none}
.dc .lbl{font-size:7px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.5px}
.dc .val{font-size:10px;font-weight:700;color:#111827;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:9px;margin-top:0}
thead tr{background:#111827;color:white}
thead th{padding:6px 8px;text-align:left;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;border:1px solid #374151}
tbody tr:nth-child(even){background:#f9fafb}
.ft{margin-top:14px;border-top:2px solid #111827;padding-top:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.ft-box{text-align:center}
.ft-line{border-top:1px solid #374151;margin-top:28px;padding-top:4px;font-size:7.5px;color:#6b7280}
.rd-ref{font-size:7px;color:#9ca3af;text-align:center;margin-top:8px}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>

<div class="hd-top">
  <div>
    <img src="${logoUrl}" alt="AFA Tours Peru" style="height:52px;object-fit:contain;max-width:160px" />
  </div>
  <div class="hd-empresa">
    <p style="font-size:10px;font-weight:900;margin:0;text-transform:uppercase;letter-spacing:.5px">AFA TOURS PERU SAC</p>
    <p style="font-size:8px;color:#374151;margin:3px 0 1px">Calle la bajada Mz F Lote 2, Lurigancho</p>
    <p style="font-size:8px;color:#374151;margin:1px 0">Tel: 966707225 / 01-3453707</p>
    <p style="font-size:8px;color:#374151;margin:1px 0">transporte@afatoursperu.com</p>
  </div>
  <div class="hd-right">
    <p style="font-size:7.5px;color:#6b7280;margin:0">Generado: ${now.toLocaleDateString("es-PE")} ${now.toLocaleTimeString("es-PE",{hour:"2-digit",minute:"2-digit"})}</p>
    <p style="font-size:7.5px;color:#6b7280;margin:3px 0">Total pasajeros: <b style="color:#111827;font-size:9px">${pp.length}</b></p>
  </div>
</div>

<div class="hd-title">
  <h1>Manifiesto de Pasajeros</h1>
  <p>Res. Directoral N° 1946-2009-MTC-15 &nbsp;·&nbsp; Exigido por SUTRAN</p>
</div>

<div class="data-grid">
  <div class="dc"><div class="lbl">Fecha de viaje</div><div class="val">${fmtFecha(d.servicio.fecha)}</div></div>
  <div class="dc"><div class="lbl">Hora de salida</div><div class="val">${esc(d.servicio.hora?.slice(0,5) || "–")}</div></div>
  <div class="dc"><div class="lbl">N° Placa Vehicular</div><div class="val" style="font-family:monospace;letter-spacing:2px">${esc(vehi?.placa || "–")}</div></div>
  <div class="dc"><div class="lbl">Ruta</div><div class="val">${esc(d.servicio.origen)} → ${esc(d.servicio.destino)}</div></div>
  <div class="dc"><div class="lbl">Nombre del Conductor</div><div class="val">${esc(cond?.nombre || "–")}</div></div>
  <div class="dc"><div class="lbl">Nro. de Licencia</div><div class="val" style="font-family:monospace">${esc(cond?.licencia || "–")}</div></div>
  <div class="dc" style="grid-column:1/-1;border-right:none"><div class="lbl">Modalidad del Servicio</div><div class="val">Transporte de Personal · Cliente: ${esc(clienteNom || "–")}</div></div>
</div>

<table>
  <thead>
    <tr>
      <th style="width:48px;text-align:center">N° Asiento</th>
      <th>Apellidos y Nombres</th>
      <th style="width:105px;text-align:center">N° Documento</th>
      <th style="width:46px;text-align:center">Edad</th>
      <th style="width:150px">Firma / Validación Digital</th>
    </tr>
  </thead>
  <tbody>${filas}</tbody>
</table>

<div class="ft">
  <div class="ft-box"><div class="ft-line"><b>AFA TOURS PERU SAC</b><br/>Empresa Autorizada MTC<br/>Representante Legal</div></div>
  <div class="ft-box"><div class="ft-line"><b>${esc(cond?.nombre || "CONDUCTOR")}</b><br/>Lic: ${esc(cond?.licencia || "–")}<br/>Firma del Conductor</div></div>
  <div class="ft-box"><div class="ft-line"><b>${esc(clienteNom || "EMPRESA")}</b><br/>Responsable de Servicio<br/>Firma y Sello</div></div>
</div>
<p class="rd-ref">R.D. N° 1946-2009-MTC-15 &nbsp;·&nbsp; AFA Tours Peru SAC &nbsp;·&nbsp; Tel: 966707225 / 01-3453707 &nbsp;·&nbsp; transporte@afatoursperu.com</p>
<script>window.onload=()=>window.print()</script></body></html>`;
}

// ─── Único helper impuro: abre el HTML en una pestaña y dispara la impresión ──
// El HTML ya incluye <script>window.onload=()=>window.print()</script>. Debe llamarse
// SIN await intermedio dentro del onClick (gesto del usuario) o el popup se bloquea.
export function abrirImprimible(html: string): void {
  const win = window.open("", "_blank");
  if (win) { win.document.write(html); win.document.close(); }
  else { alert("Permite las ventanas emergentes para poder abrir e imprimir el documento."); }
}
