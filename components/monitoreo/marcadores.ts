// components/monitoreo/marcadores.ts — SOLO NAVEGADOR (arma HTML para los marcadores de Mapbox).
//
// Los marcadores de /monitoreo son DOM, no capas del estilo: así se ven aunque el mapa base no
// cargue, y cada uno lleva la silueta de su tipo de unidad. Este módulo NO decide nada del estado:
// el color, la etiqueta, el detalle y si va atenuado vienen del veredicto de lib/monitoreo-estado.ts.
// Lo único que hace es convertir esos datos en HTML, y TODO texto que viene de la base o del
// conductor (placa, nombre, proveedor, motivo del SOS, teléfono) pasa por `esc()`: va a innerHTML.
//
// Las funciones devuelven la cadena HTML, que sirve también de FIRMA: la página solo reescribe el
// innerHTML de un marcador cuando su cadena cambió (con 95 unidades y el realtime moviendo una cada
// pocos segundos, reescribirlas todas cada vez es lo que hacía parpadear el mapa).

/** Escape HTML para todo lo que se inyecta vía innerHTML. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Solo dígitos y «+», para un enlace tel: (el texto visible va aparte, escapado). */
export function telHref(tel: string | null | undefined): string | null {
  const t = String(tel ?? "").replace(/[^\d+]/g, "");
  return t.length >= 6 ? `tel:${t}` : null;
}

// ─── ICONOS DE VEHÍCULO (siluetas laterales, viewBox 44×28) ──────────────────
// Cuerpo blanco, ventanas/ruedas #12213a. La forma diferencia el tipo de un vistazo:
// AUTO bajo, SUV alto, VAN/Sprinter caja alta, MINIBÚS/CÚSTER bus corto, BUS largo.
export const VEH_SVG = {
  AUTO: `<path d="M3.5 20.5 L3.5 17.8 C3.5 17 4.1 16.4 4.9 16.4 L7.5 16.4 L11.5 10.8 C12 10 12.9 9.6 13.8 9.6 L25 9.6 C26 9.6 26.9 10 27.5 10.8 L31 15.3 L38 16.3 C39.7 16.6 41 18 41 19.7 C41 20.1 40.7 20.5 40.2 20.5 Z"/><path d="M13.8 11.5 L23.6 11.5 C24.2 11.5 24.8 11.8 25.2 12.3 L27.4 15 L13.8 15 Z" fill="#12213a"/><circle cx="13.5" cy="21.2" r="3.5" fill="#12213a"/><circle cx="13.5" cy="21.2" r="1.3" fill="#fff"/><circle cx="31" cy="21.2" r="3.5" fill="#12213a"/><circle cx="31" cy="21.2" r="1.3" fill="#fff"/>`,
  SUV: `<path d="M3.5 20.5 L3.5 16.4 C3.5 15.6 4.1 15 4.9 15 L8.6 15 L11.4 9.4 C11.9 8.6 12.8 8.2 13.7 8.2 L27.6 8.2 C28.5 8.2 29.3 8.6 29.8 9.4 L32.6 15 L38.2 15.8 C39.8 16 41 17.4 41 19 L41 19.8 C41 20.2 40.7 20.5 40.2 20.5 Z"/><path d="M13.7 9.9 L20 9.9 L20 14.5 L13.7 14.5 Z" fill="#12213a"/><path d="M21.5 9.9 L27 9.9 C27.6 9.9 28.1 10.2 28.4 10.7 L30.4 14.5 L21.5 14.5 Z" fill="#12213a"/><circle cx="13.5" cy="21.2" r="3.5" fill="#12213a"/><circle cx="13.5" cy="21.2" r="1.3" fill="#fff"/><circle cx="31.5" cy="21.2" r="3.5" fill="#12213a"/><circle cx="31.5" cy="21.2" r="1.3" fill="#fff"/>`,
  VAN: `<path d="M3.5 20.5 L3.5 10 C3.5 8.9 4.4 8 5.5 8 L28.5 8 C29.5 8 30.4 8.4 31 9.2 L36.4 15.6 C37.4 16.2 38 17.2 38 18.4 L38 19.7 C38 20.1 37.7 20.5 37.2 20.5 Z"/><rect x="6" y="10.3" width="9" height="4.6" rx="1" fill="#12213a"/><rect x="16.8" y="10.3" width="9" height="4.6" rx="1" fill="#12213a"/><path d="M29.4 10.6 L33.2 15 L29.4 15 Z" fill="#12213a"/><circle cx="11" cy="21.2" r="3.5" fill="#12213a"/><circle cx="11" cy="21.2" r="1.3" fill="#fff"/><circle cx="32" cy="21.2" r="3.5" fill="#12213a"/><circle cx="32" cy="21.2" r="1.3" fill="#fff"/>`,
  MINIBUS: `<path d="M4 20.5 L4 9.5 C4 8.4 4.9 7.5 6 7.5 L34 7.5 C35.1 7.5 36 8.4 36 9.5 L36 19.5 C36 20.1 35.6 20.5 35 20.5 Z"/><rect x="6.4" y="9.7" width="6" height="4.4" rx="1" fill="#12213a"/><rect x="13.4" y="9.7" width="6" height="4.4" rx="1" fill="#12213a"/><rect x="20.4" y="9.7" width="6" height="4.4" rx="1" fill="#12213a"/><rect x="27.4" y="9.7" width="6.2" height="4.4" rx="1" fill="#12213a"/><circle cx="11" cy="21.2" r="3.5" fill="#12213a"/><circle cx="11" cy="21.2" r="1.3" fill="#fff"/><circle cx="29" cy="21.2" r="3.5" fill="#12213a"/><circle cx="29" cy="21.2" r="1.3" fill="#fff"/>`,
  BUS: `<path d="M2 20.5 L2 9 C2 7.9 2.9 7 4 7 L38 7 C39.1 7 40 7.9 40 9 L40 19.5 C40 20.1 39.6 20.5 39 20.5 Z"/><rect x="4.4" y="9.2" width="6" height="4.7" rx="1" fill="#12213a"/><rect x="11.4" y="9.2" width="6" height="4.7" rx="1" fill="#12213a"/><rect x="18.4" y="9.2" width="6" height="4.7" rx="1" fill="#12213a"/><rect x="25.4" y="9.2" width="6" height="4.7" rx="1" fill="#12213a"/><rect x="32.4" y="9.2" width="5.2" height="4.7" rx="1" fill="#12213a"/><circle cx="9" cy="21.2" r="3.5" fill="#12213a"/><circle cx="9" cy="21.2" r="1.3" fill="#fff"/><circle cx="33" cy="21.2" r="3.5" fill="#12213a"/><circle cx="33" cy="21.2" r="1.3" fill="#fff"/>`,
  CUSTER: `<path d="M6 20.5 L6 10 C6 8.9 6.9 8 8 8 L31 8 C32.1 8 33 8.9 33 10 L33 19.5 C33 20.1 32.6 20.5 32 20.5 Z"/><rect x="8.4" y="10.2" width="5.4" height="4.1" rx="1" fill="#12213a"/><rect x="14.8" y="10.2" width="5.4" height="4.1" rx="1" fill="#12213a"/><rect x="21.2" y="10.2" width="5.4" height="4.1" rx="1" fill="#12213a"/><rect x="27.6" y="10.2" width="3.6" height="4.1" rx="1" fill="#12213a"/><circle cx="12" cy="21.2" r="3.5" fill="#12213a"/><circle cx="12" cy="21.2" r="1.3" fill="#fff"/><circle cx="27" cy="21.2" r="3.5" fill="#12213a"/><circle cx="27" cy="21.2" r="1.3" fill="#fff"/>`,
} as const;
export type TipoSilueta = keyof typeof VEH_SVG;

/** Persona (conductor conectado sin vehículo asignado). viewBox 24×24. */
export const PERSONA_SVG = `<circle cx="12" cy="8" r="4" fill="#fff"/><path d="M4 21 C4 15.5 7.6 13 12 13 C16.4 13 20 15.5 20 21 Z" fill="#fff"/>`;

export function catKey(cat: string | null | undefined): TipoSilueta {
  const c = (cat || "").toUpperCase().trim();
  if (c in VEH_SVG) return c as TipoSilueta;
  if (c.includes("SPRINTER")) return "VAN";
  if (c.includes("COASTER") || c.includes("COSTER") || c.includes("CUSTER") || c.includes("CÚSTER")) return "CUSTER";
  if (c.includes("MINI")) return "MINIBUS";
  if (c.includes("VAN")) return "VAN";
  if (c.includes("SUV") || c.includes("CAMIONETA") || c.includes("PICKUP")) return "SUV";
  if (c.includes("AUTO") || c.includes("SEDAN") || c.includes("SEDÁN") || c.includes("TAXI") || c.includes("CAR")) return "AUTO";
  return "BUS";
}

export const CAT_LABEL: Record<TipoSilueta, string> = {
  AUTO: "Auto", SUV: "Camioneta", VAN: "Van / Sprinter", MINIBUS: "Minibús", BUS: "Bus", CUSTER: "Cúster",
};

/** `fill` es un color que pone la pantalla (nunca un dato de la base). */
export function svgVehiculo(cat: string | null | undefined, size = 30, fill = "#fff"): string {
  return `<svg viewBox="0 0 44 28" width="${size}" height="${Math.round((size * 28) / 44)}" fill="${fill}" style="display:block">${VEH_SVG[catKey(cat)]}</svg>`;
}

// ─── CAPAS (z-index) ─────────────────────────────────────────────────────────
// Cada marcador lleva de z-index la `prioridad` del veredicto (atender encima de en línea, y los
// grises debajo de todo). Llega a ~43 millones, así que los controles y los popups del mapa —que
// Mapbox deja en z-index 2 y auto— se suben por encima con CSS. El contenedor del mapa va con
// `isolation: isolate`: nada de esto se sale del mapa ni tapa los paneles de la pantalla.
export const Z_SELECCIONADO = 50_000_000;
export const Z_ALERTA_SOS = 48_000_000;

/** CSS de marcadores y popups, una sola vez por documento. */
export function inyectarEstilosMonitoreo(): void {
  if (typeof document === "undefined" || document.getElementById("afa-monitoreo-css")) return;
  const st = document.createElement("style");
  st.id = "afa-monitoreo-css";
  st.textContent = `
    .afa-mon .mapboxgl-popup{z-index:60000000}
    .afa-mon .mapboxgl-ctrl-top-left,.afa-mon .mapboxgl-ctrl-top-right,.afa-mon .mapboxgl-ctrl-bottom-left,.afa-mon .mapboxgl-ctrl-bottom-right{z-index:70000000}
    .afa-mon .mapboxgl-popup-content{border-radius:14px;padding:12px 14px 12px;box-shadow:0 10px 30px rgba(2,6,23,.35)}
    .afa-mon .mapboxgl-popup-close-button{width:34px;height:34px;font-size:22px;line-height:30px;color:#64748b;border-radius:0 14px 0 10px}
    .afa-mk{display:flex;flex-direction:column;align-items:center;cursor:pointer;will-change:transform}
    .afa-badge{width:40px;height:40px;border-radius:12px;border:2.5px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;transition:transform .15s}
    .afa-badge.sos{width:48px;height:48px;border-color:#fecaca;position:relative}
    .afa-badge.sos::after{content:"";position:absolute;inset:-6px;border-radius:16px;border:3px solid #dc2626;animation:afa-pulse 1.4s ease-out infinite;pointer-events:none}
    @keyframes afa-pulse{0%{transform:scale(.85);opacity:.9}100%{transform:scale(1.4);opacity:0}}
    .afa-plate{margin-top:3px;background:rgba(255,255,255,.98);color:#0b315f;font:800 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;padding:1.5px 6px;border-radius:6px;box-shadow:0 1px 5px rgba(0,0,0,.35);white-space:nowrap;letter-spacing:.3px;border:1px solid rgba(0,0,0,.08)}
    .afa-terc{margin-left:4px;background:#f59e0b;color:#3a2606;border-radius:4px;padding:0 3px;font-size:8px;font-weight:900;letter-spacing:0}
    .afa-edad{margin-top:2px;background:rgba(15,23,42,.82);color:#e2e8f0;font:700 9px/1.25 system-ui,-apple-system,sans-serif;padding:1px 5px;border-radius:5px;white-space:nowrap}
    .afa-mk.gris .afa-badge{width:34px;height:34px;opacity:.6;border-width:2px;border-color:#e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,.22)}
    .afa-mk.gris .afa-plate{color:#475569;box-shadow:0 1px 2px rgba(0,0,0,.18);opacity:.92}
    .afa-mon.afa-lejos .afa-mk.gris .afa-plate,.afa-mon.afa-lejos .afa-mk.gris .afa-edad{display:none}
    .afa-mk.sel .afa-badge{outline:3px solid #38bdf8;outline-offset:2px;transform:scale(1.12);opacity:1}
    .afa-mk.sel .afa-plate,.afa-mk.sel .afa-edad{display:block!important}
    .afa-sos-pin{width:38px;height:38px;border-radius:12px;background:#dc2626;border:3px solid #fca5a5;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 0 22px rgba(220,38,38,.85);cursor:pointer;color:#fff;font-weight:900}
    .afa-pop{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;min-width:190px;max-width:100%;color:#0f172a}
    .afa-pop .t{font-weight:900;font-size:15px;color:#0b315f;margin:0 26px 2px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3px}
    .afa-pop .s{font-size:11.5px;color:#64748b;margin-bottom:6px}
    .afa-pop .prov{display:inline-block;font-size:10.5px;font-weight:800;color:#92400e;background:#fef3c7;border-radius:6px;padding:1px 6px;margin-bottom:6px}
    .afa-pop .k{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-top:6px}
    .afa-pop .v{font-size:12.5px;color:#1e293b}
    .afa-pop .e{font-size:12.5px;font-weight:900}
    .afa-pop .d{font-size:12px;color:#334155;margin-top:1px}
    .afa-pop .tel{display:block;margin-top:10px;min-height:44px;line-height:44px;background:#0b315f;color:#fff;text-align:center;border-radius:10px;font-size:13px;font-weight:800;text-decoration:none;padding:0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  `;
  document.head.appendChild(st);
}

// ─── UNIDAD ──────────────────────────────────────────────────────────────────

export type DatosMarcadorUnidad = {
  placa: string;
  categoria: string | null;
  /** Del veredicto (`veredicto.color`). */
  color: string;
  /** Del veredicto (`veredicto.atenuado`): gris, más chico, placa oculta con zoom lejano. */
  atenuado: boolean;
  sos: boolean;
  tercero: boolean;
  /** Solo en los atenuados: «hace 3 h», «ayer 18:40»… (rotuloEdad). */
  edad: string | null;
};

/** Clase del contenedor del marcador (va aparte del innerHTML: cambia con la selección). */
export function claseMarcador(atenuado: boolean, seleccionado: boolean): string {
  return "afa-mk" + (atenuado ? " gris" : "") + (seleccionado ? " sel" : "");
}

export function htmlMarcadorUnidad(d: DatosMarcadorUnidad): string {
  const tam = d.atenuado ? 24 : 30;
  return (
    `<div class="afa-badge${d.sos ? " sos" : ""}" style="background:${d.color}">${svgVehiculo(d.categoria, tam)}</div>` +
    `<div class="afa-plate">${esc(d.placa)}${d.tercero ? '<span class="afa-terc">3P</span>' : ""}</div>` +
    (d.atenuado && d.edad ? `<div class="afa-edad">${esc(d.edad)}</div>` : "")
  );
}

export type DatosPopupUnidad = {
  placa: string;
  tipo: string;
  marcaModelo: string | null;
  proveedor: string | null;
  tercero: boolean;
  conductor: string | null;
  telefono: string | null;
  etiqueta: string;
  color: string;
  detalle: string;
  /** «Última posición: 18:40 · hace 3 h». */
  ultimaPosicion: string | null;
  /** Solo si está en línea. */
  velocidadKmh: number | null;
  sos: boolean;
};

export function htmlPopupUnidad(d: DatosPopupUnidad): string {
  const tel = telHref(d.telefono);
  const colorEtiqueta = d.color === "#64748b" || d.color === "#94a3b8" ? "#475569" : d.color;
  return (
    `<div class="afa-pop">` +
    `<div class="t">${esc(d.placa)}${d.sos ? ' <span style="color:#dc2626">⚠ SOS</span>' : ""}</div>` +
    `<div class="s">${esc(d.tipo)}${d.marcaModelo ? " · " + esc(d.marcaModelo) : ""}</div>` +
    (d.tercero ? `<div class="prov">Proveedor: ${esc(d.proveedor || "Tercerizado")}</div>` : "") +
    `<div class="e" style="color:${colorEtiqueta}">${esc(d.etiqueta)}</div>` +
    `<div class="d">${esc(d.detalle)}</div>` +
    (d.ultimaPosicion ? `<div class="k">Última posición</div><div class="v">${esc(d.ultimaPosicion)}</div>` : "") +
    (d.velocidadKmh != null ? `<div class="k">Velocidad</div><div class="v">${Math.round(d.velocidadKmh)} km/h</div>` : "") +
    `<div class="k">Conductor</div><div class="v">${esc(d.conductor || "Sin dato en su última posición")}</div>` +
    (tel ? `<a class="tel" href="${esc(tel)}">Llamar · ${esc(d.telefono)}</a>` : "") +
    `</div>`
  );
}

// ─── CONDUCTOR CONECTADO SIN UNIDAD ──────────────────────────────────────────

export function htmlMarcadorPersona(nombre: string, color: string, atenuado: boolean, edad: string | null): string {
  return (
    `<div class="afa-badge" style="background:${color}"><svg viewBox="0 0 24 24" width="${atenuado ? 18 : 22}" height="${atenuado ? 18 : 22}" style="display:block">${PERSONA_SVG}</svg></div>` +
    `<div class="afa-plate">${esc(nombre)}</div>` +
    (atenuado && edad ? `<div class="afa-edad">${esc(edad)}</div>` : "")
  );
}

export function htmlPopupPersona(d: { nombre: string; estado: string; color: string; ultimaPosicion: string; telefono: string | null }): string {
  const tel = telHref(d.telefono);
  return (
    `<div class="afa-pop">` +
    `<div class="t" style="font-family:inherit">${esc(d.nombre)}</div>` +
    `<div class="s">Conductor conectado sin unidad asignada</div>` +
    `<div class="e" style="color:${d.color === "#64748b" ? "#475569" : d.color}">${esc(d.estado)}</div>` +
    `<div class="k">Última posición</div><div class="v">${esc(d.ultimaPosicion)}</div>` +
    (tel ? `<a class="tel" href="${esc(tel)}">Llamar · ${esc(d.telefono)}</a>` : "") +
    `</div>`
  );
}

// ─── ALERTA SOS CON POSICIÓN ─────────────────────────────────────────────────

export function htmlPopupSos(d: { motivo: string | null; reservaId: number | null; hora: string; placa: string | null }): string {
  return (
    `<div class="afa-pop">` +
    `<div class="t" style="color:#dc2626;font-family:inherit">⚠ Alerta SOS</div>` +
    `<div class="s">Posición al momento de la alerta</div>` +
    `<div class="k">Motivo</div><div class="v">${esc(d.motivo || "Sin motivo escrito")}</div>` +
    (d.placa ? `<div class="k">Unidad</div><div class="v">${esc(d.placa)}</div>` : "") +
    (d.reservaId != null ? `<div class="k">Servicio</div><div class="v">Reserva #${esc(d.reservaId)}</div>` : "") +
    `<div class="k">Hora</div><div class="v">${esc(d.hora)}</div>` +
    `</div>`
  );
}
