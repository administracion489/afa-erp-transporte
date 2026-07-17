// app/radar-ia/page.tsx — Dashboard del Radar IA: WhatsApp → ELIA → ERP.
// Feed de mensajes clasificados, oportunidades comerciales, combustible, alertas,
// grupos monitoreados y configuración del pipeline. Lee/edita las tablas radar_*
// (supabase/radar-ia.sql). Módulo independiente del CRM/Meta oficial.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { normalizarConfigRadar } from "@/lib/radar/config";
import {
  CATEGORIAS_RADAR,
  LISTA_CATEGORIAS,
  type CategoriaRadar,
  type EstadoMensajeRadar,
  type RadarAlerta,
  type RadarCombustible,
  type RadarConfig,
  type RadarEstado,
  type RadarGrupo,
  type RadarMensaje,
  type RadarOportunidad,
  type SeveridadAlerta,
} from "@/lib/radar/tipos";

// ── Helpers puros ────────────────────────────────────────────────────────────

function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fechaLocalDe(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtSoles(n: number): string {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function haceRelativo(iso: string | null): string {
  if (!iso) return "—";
  const seg = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seg < 60) return `hace ${seg}s`;
  const min = Math.floor(seg / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return new Date(iso).toLocaleDateString("es-PE", { day: "numeric", month: "short" });
}

function fechaHoraCorta(iso: string): string {
  const d = new Date(iso);
  const hora = d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  if (fechaLocalDe(iso) === hoyISO()) return hora;
  return `${d.toLocaleDateString("es-PE", { day: "numeric", month: "short" })} ${hora}`;
}

function fmtFecha(f: string | null): string {
  if (!f) return "Fecha por confirmar";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// ── Catálogos visuales ───────────────────────────────────────────────────────

const ESTADO_MSG_CFG: Record<EstadoMensajeRadar, { label: string; color: string; bg: string }> = {
  pendiente:  { label: "Pendiente",  color: "#B07A0F", bg: "#FBF1D8" },
  procesando: { label: "Procesando", color: "#1d4ed8", bg: "#dbeafe" },
  procesado:  { label: "Procesado",  color: "#27AE60", bg: "#E8F5EC" },
  descartado: { label: "Descartado", color: "#5B6B82", bg: "#eef2f7" },
  error:      { label: "Error",      color: "#EB5757", bg: "#FDECEC" },
  fusionado:  { label: "🔗 Fusionado", color: "#5B6B82", bg: "#eef2f7" },
};

const ESTADO_OPP_CFG: Record<RadarOportunidad["estado"], { label: string; color: string; bg: string }> = {
  nueva:      { label: "Nueva",      color: "#1d4ed8", bg: "#dbeafe" },
  revisada:   { label: "Revisada",   color: "#0f766e", bg: "#ccfbf1" },
  cotizada:   { label: "Cotizada",   color: "#27AE60", bg: "#E8F5EC" },
  descartada: { label: "Descartada", color: "#5B6B82", bg: "#eef2f7" },
};

const ESTADO_COMB_CFG: Record<RadarCombustible["estado"], { label: string; color: string; bg: string }> = {
  registrado:         { label: "Registrado",  color: "#27AE60", bg: "#E8F5EC" },
  pendiente_revision: { label: "Por revisar", color: "#B07A0F", bg: "#FBF1D8" },
  descartado:         { label: "Descartado",  color: "#5B6B82", bg: "#eef2f7" },
};

const SEVERIDAD_CFG: Record<SeveridadAlerta, { label: string; color: string; bg: string }> = {
  critico:  { label: "Crítico",  color: "#EB5757", bg: "#FDECEC" },
  atencion: { label: "Atención", color: "#B07A0F", bg: "#FBF1D8" },
  info:     { label: "Info",     color: "#1262bd", bg: "#E8F1FB" },
};

const ANOMALIA_LABEL: Record<string, string> = {
  galones_exceden_tanque: "Galones exceden tanque",
  posible_duplicado:      "Posible duplicado",
  precio_fuera_de_rango:  "Precio fuera de rango",
  km_menor_al_actual:     "KM menor al actual",
  consumo_excesivo:       "Consumo excesivo",
  recarga_madrugada:      "Recarga de madrugada",
  monto_inconsistente:    "Monto inconsistente",
  galones_coinciden_km:   "Cantidad = kilometraje",
};

const TABS = [
  { id: "feed",          label: "Feed" },
  { id: "oportunidades", label: "Oportunidades" },
  { id: "combustible",   label: "Combustible" },
  { id: "alertas",       label: "Alertas" },
  { id: "grupos",        label: "Grupos" },
  { id: "configuracion", label: "Configuración" },
] as const;
type TabId = (typeof TABS)[number]["id"];

type VehiculoLite = { id: number; placa: string; categoria: string | null; estado: string | null };

type VehiculoGuiaOdometro = { tipo: "propio" | "tercero"; id: number; placa: string; categoria: string | null; guia_odometro: string | null };

// ── Iconos SVG inline ────────────────────────────────────────────────────────

type IcProps = { size?: number; className?: string };
const Ic = {
  Lupa: ({ size = 16, className = "" }: IcProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  ),
  Refresh: ({ size = 16, className = "" }: IcProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
    </svg>
  ),
  Chevron: ({ size = 16, className = "" }: IcProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  Externo: ({ size = 16, className = "" }: IcProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  ),
  QrCode: ({ size = 16, className = "" }: IcProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3" /><path d="M14 21h.01" /><path d="M21 17.5V21" />
    </svg>
  ),
};

// ── Átomos compartidos ───────────────────────────────────────────────────────

function Switch({ on, onClick, grande = false, disabled = false }: { on: boolean; onClick: () => void; grande?: boolean; disabled?: boolean }) {
  const w = grande ? "w-12 h-7" : "w-9 h-5";
  const knob = grande ? "w-5 h-5" : "w-3.5 h-3.5";
  const shift = grande ? "translate-x-5" : "translate-x-4";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${w} rounded-full p-1 transition-colors flex-shrink-0 ${on ? "bg-[#27AE60]" : "bg-gray-300"} ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span className={`block ${knob} bg-white rounded-full shadow-sm transition-transform ${on ? shift : "translate-x-0"}`} />
    </button>
  );
}

function ChipEstado({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span className="text-[11px] font-black px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color, background: bg }}>
      {label}
    </span>
  );
}

function CardVacia({ emoji, titulo, detalle }: { emoji: string; titulo: string; detalle?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
      <p className="text-4xl mb-3">{emoji}</p>
      <p className="font-bold text-gray-600">{titulo}</p>
      {detalle && <p className="text-sm text-gray-400 mt-1">{detalle}</p>}
    </div>
  );
}

// ── Tab: Feed de mensajes ────────────────────────────────────────────────────

function TabFeed({ mensajes, reprocesando, onFeedback, onReprocesar }: {
  mensajes: RadarMensaje[];
  reprocesando: string | null;
  onFeedback: (id: string, fb: "correcto" | "incorrecto") => void;
  onReprocesar: (id: string) => void;
}) {
  const [filtroCat, setFiltroCat] = useState<CategoriaRadar | "todas">("todas");
  const [busqueda, setBusqueda] = useState("");
  const [expandido, setExpandido] = useState<string | null>(null);

  const filtrados = mensajes.filter((m) => {
    if (filtroCat !== "todas" && m.categoria !== filtroCat) return false;
    if (busqueda.trim()) {
      const b = norm(busqueda);
      const blob = norm(`${m.texto ?? ""} ${m.resumen_ia ?? ""} ${m.grupo_nombre ?? ""} ${m.remitente_nombre ?? ""}`);
      if (!blob.includes(b)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-gray-50 rounded-xl p-1 flex-wrap">
          <button
            onClick={() => setFiltroCat("todas")}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filtroCat === "todas" ? "bg-white shadow-sm text-[#0b315f]" : "text-gray-400 hover:text-gray-600"}`}
          >
            Todas
          </button>
          {LISTA_CATEGORIAS.map((c) => (
            <button
              key={c}
              onClick={() => setFiltroCat(c)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filtroCat === c ? "bg-white shadow-sm text-[#0b315f]" : "text-gray-400 hover:text-gray-600"}`}
            >
              {CATEGORIAS_RADAR[c].emoji} {CATEGORIAS_RADAR[c].label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[220px]">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300"><Ic.Lupa size={15} /></span>
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por texto, grupo o remitente…"
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#0b315f] transition-colors bg-white"
          />
        </div>
      </div>

      {/* Lista */}
      {filtrados.length === 0 ? (
        <CardVacia emoji="📭" titulo="Sin mensajes con ese filtro" detalle="Los mensajes de los grupos activos aparecen aquí en tiempo real." />
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden divide-y divide-gray-100">
          {filtrados.map((m) => {
            const cat = m.categoria ? CATEGORIAS_RADAR[m.categoria] : null;
            const est = ESTADO_MSG_CFG[m.estado] ?? ESTADO_MSG_CFG.pendiente;
            const abierto = expandido === m.id;
            const extraccion = m.resultado && typeof m.resultado === "object"
              ? ((m.resultado as Record<string, unknown>)["extraccion"] as Record<string, unknown> | undefined)
              : undefined;
            const detalleAccion = m.resultado && typeof (m.resultado as Record<string, unknown>)["detalle"] === "string"
              ? String((m.resultado as Record<string, unknown>)["detalle"])
              : null;
            const esImagen = m.tipo === "imagen" || (m.media_mime ?? "").startsWith("image/");
            return (
              <div key={m.id}>
                {/* Fila resumida */}
                <button
                  onClick={() => setExpandido(abierto ? null : m.id)}
                  className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors ${abierto ? "bg-blue-50/50" : "hover:bg-gray-50"}`}
                >
                  {cat ? (
                    <span className="text-[11px] font-black px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0" style={{ color: cat.color, background: cat.bg }}>
                      {cat.emoji} {cat.label}
                    </span>
                  ) : (
                    <span className="text-[11px] font-black px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0 text-[#5B6B82] bg-[#eef2f7]">💬 Sin clasificar</span>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-[#0b315f] truncate">
                      {m.grupo_nombre ?? "Grupo desconocido"}
                      <span className="text-gray-400 font-semibold"> · {m.remitente_nombre ?? "Desconocido"}</span>
                    </p>
                    <p className="text-sm text-gray-600 truncate">
                      {m.resumen_ia ?? (m.texto ? (m.texto.length > 120 ? m.texto.slice(0, 120) + "…" : m.texto) : `(${m.tipo})`)}
                    </p>
                  </div>
                  <span className="text-[11px] text-gray-400 font-semibold whitespace-nowrap">{fechaHoraCorta(m.ts_mensaje)}</span>
                  {m.confianza != null && (
                    <span className="text-[11px] font-black text-gray-400 whitespace-nowrap">{Math.round(m.confianza * 100)}%</span>
                  )}
                  <ChipEstado {...est} />
                  <Ic.Chevron size={14} className={`text-gray-300 transition-transform ${abierto ? "rotate-180" : ""}`} />
                </button>

                {/* Detalle expandido */}
                {abierto && (
                  <div className="px-4 pb-4 pt-1 space-y-3 bg-blue-50/30">
                    {m.texto && (
                      <p className="text-sm text-gray-700 whitespace-pre-wrap bg-white rounded-xl border border-gray-100 p-3">{m.texto}</p>
                    )}
                    {m.transcripcion && (
                      <div className="bg-white rounded-xl border border-gray-100 p-3">
                        <p className="text-[11px] font-black text-gray-400 uppercase tracking-wide mb-1">Transcripción</p>
                        <p className="text-sm text-gray-600 italic whitespace-pre-wrap">{m.transcripcion}</p>
                      </div>
                    )}
                    {m.media_url && (
                      esImagen ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.media_url} alt={m.media_nombre ?? "Imagen del mensaje"} className="rounded-xl max-h-64 border border-gray-100" />
                      ) : (
                        <a
                          href={m.media_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm font-bold text-[#1262bd] hover:underline"
                        >
                          <Ic.Externo size={14} /> Ver archivo{m.media_nombre ? ` · ${m.media_nombre}` : ""}
                        </a>
                      )
                    )}
                    {extraccion && Object.entries(extraccion).some(([, v]) => v !== null && v !== undefined && v !== "") && (
                      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                        <p className="text-[11px] font-black text-gray-400 uppercase tracking-wide px-3 pt-3">Datos extraídos</p>
                        <table className="w-full text-sm">
                          <tbody>
                            {Object.entries(extraccion)
                              .filter(([, v]) => v !== null && v !== undefined && v !== "")
                              .map(([k, v]) => (
                                <tr key={k} className="border-t border-gray-50">
                                  <td className="px-3 py-1.5 text-xs font-bold text-gray-400 capitalize whitespace-nowrap">{k.replace(/_/g, " ")}</td>
                                  <td className="px-3 py-1.5 text-gray-700">{typeof v === "object" ? JSON.stringify(v) : String(v)}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {m.accion && (
                      <p className="text-sm text-gray-600">
                        <span className="font-black text-[#0b315f]">Acción:</span>{" "}
                        <span className="font-mono text-xs bg-white border border-gray-100 rounded-lg px-2 py-0.5">{m.accion}</span>
                        {detalleAccion && <span className="ml-2">{detalleAccion}</span>}
                      </p>
                    )}
                    {m.error && (
                      <p className="text-sm text-[#EB5757] bg-[#FDECEC] rounded-xl px-3 py-2 font-semibold">{m.error}</p>
                    )}
                    <div className="flex items-center gap-2 flex-wrap pt-1">
                      <button
                        onClick={() => onFeedback(m.id, "correcto")}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${m.feedback === "correcto" ? "bg-[#E8F5EC] border-[#27AE60] text-[#27AE60]" : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"}`}
                      >
                        👍 Correcto
                      </button>
                      <button
                        onClick={() => onFeedback(m.id, "incorrecto")}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${m.feedback === "incorrecto" ? "bg-[#FDECEC] border-[#EB5757] text-[#EB5757]" : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"}`}
                      >
                        👎 Incorrecto
                      </button>
                      <button
                        onClick={() => onReprocesar(m.id)}
                        disabled={reprocesando === m.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#0b315f] text-white hover:bg-[#1262bd] transition-colors disabled:opacity-50"
                      >
                        <Ic.Refresh size={13} className={reprocesando === m.id ? "animate-spin" : ""} />
                        {reprocesando === m.id ? "Reprocesando…" : "Reprocesar"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Tab: Oportunidades comerciales ───────────────────────────────────────────

function TabOportunidades({ oportunidades, creando, onCrearCotizacion, onCambiarEstado }: {
  oportunidades: RadarOportunidad[];
  creando: string | null;
  onCrearCotizacion: (o: RadarOportunidad) => void;
  onCambiarEstado: (id: string, estado: RadarOportunidad["estado"]) => void;
}) {
  const ordenEstado: Record<RadarOportunidad["estado"], number> = { nueva: 0, revisada: 1, cotizada: 2, descartada: 3 };
  const ordenadas = [...oportunidades].sort(
    (a, b) => ordenEstado[a.estado] - ordenEstado[b.estado] || (a.created_at < b.created_at ? 1 : -1)
  );

  if (ordenadas.length === 0) {
    return <CardVacia emoji="💼" titulo="Sin oportunidades detectadas" detalle="Cuando ELIA detecte una solicitud de servicio en los grupos, aparece aquí." />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {ordenadas.map((o) => {
        const est = ESTADO_OPP_CFG[o.estado];
        const cerrada = o.estado === "cotizada" || o.estado === "descartada";
        const disp = o.disponibilidad;
        const hayDisp = disp != null && disp.vehiculos_libres > 0 && disp.conductores_libres > 0;
        const prob = o.probabilidad;
        const colorProb = prob == null ? "#5B6B82" : prob >= 60 ? "#27AE60" : prob >= 35 ? "#B07A0F" : "#EB5757";
        return (
          <div
            key={o.id}
            className={`bg-white rounded-2xl shadow-sm border p-5 space-y-3 ${o.estado === "nueva" ? "border-[#2f8ee9]" : "border-gray-100"} ${cerrada ? "opacity-60" : ""}`}
          >
            {/* Cabecera */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-gray-400 font-semibold">
                  {fmtFecha(o.fecha_servicio)}{o.hora_servicio ? ` · ${o.hora_servicio}` : ""}
                </p>
                <p className="font-black text-[#0b315f] text-base mt-0.5 leading-snug">
                  {o.origen ?? "Origen por definir"} → {o.destino ?? "Destino por definir"}
                </p>
                {(o.distrito || o.ciudad) && (
                  <p className="text-xs text-gray-500 font-semibold mt-0.5">{[o.distrito, o.ciudad].filter(Boolean).join(", ")}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <ChipEstado {...est} />
                {o.veces_detectada > 1 && (
                  <span
                    className="text-[10px] font-black px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={{ color: "#B07A0F", background: "#FBF1D8" }}
                    title="El mismo remitente pidió esta ruta y fecha en más de un grupo/mensaje — se fusionó en una sola tarjeta"
                  >
                    🔁 Visto en {o.veces_detectada} grupos
                  </span>
                )}
              </div>
            </div>

            {/* Datos del pedido */}
            <div className="flex flex-wrap gap-2 text-xs font-bold text-gray-600">
              {o.pasajeros != null && <span className="bg-gray-50 rounded-lg px-2 py-1">👥 {o.pasajeros} pax</span>}
              {o.tipo_vehiculo && <span className="bg-gray-50 rounded-lg px-2 py-1">🚐 {o.tipo_vehiculo}</span>}
              {o.unidades != null && o.unidades > 1 && <span className="bg-gray-50 rounded-lg px-2 py-1">× {o.unidades} unidades</span>}
            </div>
            {(o.cliente_nombre || o.empresa || o.telefono) && (
              <p className="text-sm text-gray-600">
                <span className="font-bold text-[#0b315f]">{o.cliente_nombre ?? o.empresa ?? "Cliente sin nombre"}</span>
                {o.empresa && o.cliente_nombre && <span className="text-gray-400"> · {o.empresa}</span>}
                {o.telefono && <span className="text-gray-400 font-mono text-xs"> · {o.telefono}</span>}
              </p>
            )}
            {o.observaciones && <p className="text-xs text-gray-500 whitespace-pre-wrap">{o.observaciones}</p>}

            {/* Disponibilidad */}
            {disp && (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="text-[11px] font-black px-2 py-0.5 rounded-full"
                  style={hayDisp ? { color: "#27AE60", background: "#E8F5EC" } : { color: "#EB5757", background: "#FDECEC" }}
                >
                  {hayDisp ? "HAY DISPONIBILIDAD" : "SIN DISPONIBILIDAD"}
                </span>
                <span className="text-xs text-gray-500 font-semibold">
                  🚐 {disp.vehiculos_libres} libres{disp.vehiculos_tipo != null ? ` (${disp.vehiculos_tipo} del tipo)` : ""} · 👤 {disp.conductores_libres} conductores · {disp.servicios_ese_dia} servicios ese día
                </span>
              </div>
            )}

            {/* Dinero + probabilidad */}
            {(o.precio_referencial != null || o.utilidad_estimada != null) && (
              <div className="flex flex-wrap gap-4 text-sm">
                {o.precio_referencial != null && (
                  <p><span className="text-xs text-gray-400 font-bold">Precio ref.</span>{" "}<span className="font-black text-[#0b315f]">{fmtSoles(o.precio_referencial)}</span></p>
                )}
                {o.utilidad_estimada != null && (
                  <p><span className="text-xs text-gray-400 font-bold">Utilidad est.</span>{" "}<span className="font-black text-[#27AE60]">{fmtSoles(o.utilidad_estimada)}</span></p>
                )}
              </div>
            )}
            {prob != null && (
              <div>
                <div className="flex justify-between text-[11px] font-bold">
                  <span className="text-gray-400">Probabilidad de cierre</span>
                  <span style={{ color: colorProb }}>{prob}%</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden mt-1">
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, prob))}%`, background: colorProb }} />
                </div>
              </div>
            )}

            {/* Acciones */}
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {(o.estado === "nueva" || o.estado === "revisada") && (
                <>
                  <button
                    onClick={() => onCrearCotizacion(o)}
                    disabled={creando === o.id}
                    className="px-3 py-2 rounded-xl text-xs font-bold bg-[#0b315f] text-white hover:bg-[#1262bd] transition-colors disabled:opacity-50"
                  >
                    {creando === o.id ? "Creando…" : "Crear cotización"}
                  </button>
                  {o.estado === "nueva" && (
                    <button
                      onClick={() => onCambiarEstado(o.id, "revisada")}
                      className="px-3 py-2 rounded-xl text-xs font-bold border border-gray-200 text-gray-600 hover:border-gray-300 transition-colors"
                    >
                      Marcar revisada
                    </button>
                  )}
                  <button
                    onClick={() => onCambiarEstado(o.id, "descartada")}
                    className="px-3 py-2 rounded-xl text-xs font-bold text-[#EB5757] hover:bg-[#FDECEC] transition-colors"
                  >
                    Descartar
                  </button>
                </>
              )}
              {o.estado === "cotizada" && o.cotizacion_id != null && (
                <Link
                  href={`/cotizaciones?buscar=${String(o.cotizacion_id).padStart(5, "0")}`}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-[#E8F5EC] text-[#27AE60] hover:bg-[#d5eedd] transition-colors"
                >
                  <Ic.Externo size={13} /> Abrir en Cotizaciones
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab: Combustible ─────────────────────────────────────────────────────────

function TabCombustible({ registros, vehiculos, registrando, onRegistrar, onDescartar }: {
  registros: RadarCombustible[];
  vehiculos: VehiculoLite[];
  registrando: string | null;
  onRegistrar: (c: RadarCombustible, vehiculoId: number) => void;
  onDescartar: (id: string) => void;
}) {
  const [expandido, setExpandido] = useState<string | null>(null);
  const [selVehiculo, setSelVehiculo] = useState<Record<string, string>>({});

  if (registros.length === 0) {
    return <CardVacia emoji="⛽" titulo="Sin recargas detectadas" detalle="Los vouchers de combustible que lleguen a los grupos aparecen aquí." />;
  }

  const placaDe = (id: number | null) => vehiculos.find((v) => v.id === id)?.placa ?? null;

  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Fecha", "Unidad", "Grifo", "Cantidad", "Precio", "Monto", "Anomalías", "Estado"].map((h) => (
                <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {registros.map((c) => {
              const est = ESTADO_COMB_CFG[c.estado];
              const abierto = expandido === c.id;
              const esPendiente = c.estado === "pendiente_revision";
              const placaMatch = placaDe(c.vehiculo_id);
              const cantidad = c.galones != null ? `${c.galones} gal` : c.litros != null ? `${c.litros} lt` : "—";
              const precio = c.precio_galon != null ? `${fmtSoles(c.precio_galon)}/gal` : c.precio_litro != null ? `${fmtSoles(c.precio_litro)}/lt` : "—";
              const galonesEfectivos = c.galones ?? c.litros;
              const precioEfectivo = c.precio_galon ?? c.precio_litro ?? (c.monto_total != null && galonesEfectivos ? c.monto_total / galonesEfectivos : null);
              const vehSel = selVehiculo[c.id] ?? (c.vehiculo_id != null ? String(c.vehiculo_id) : "");
              const puedeRegistrar = vehSel !== "" && galonesEfectivos != null && galonesEfectivos > 0 && precioEfectivo != null && precioEfectivo > 0;
              return (
                <FragmentoFilaCombustible key={c.id}>
                  <tr
                    className={`border-t transition-colors ${esPendiente ? "cursor-pointer " + (abierto ? "bg-blue-50" : "hover:bg-gray-50") : ""}`}
                    style={{ borderColor: "#f1f5f9" }}
                    onClick={() => { if (esPendiente) setExpandido(abierto ? null : c.id); }}
                  >
                    <td className="p-3 whitespace-nowrap text-gray-600">{c.fecha ? fmtFecha(c.fecha) : "—"}{c.hora ? ` · ${c.hora}` : ""}</td>
                    <td className="p-3 whitespace-nowrap">
                      <span className="font-mono font-black text-[#0b315f]">{placaMatch ?? c.placa ?? "—"}</span>
                      {!placaMatch && c.placa && <span className="ml-1.5 text-[10px] font-bold text-[#B07A0F]">sin match</span>}
                    </td>
                    <td className="p-3 text-gray-600 max-w-[180px] truncate">{c.grifo ?? "—"}</td>
                    <td className="p-3 whitespace-nowrap font-bold text-gray-700">{cantidad}</td>
                    <td className="p-3 whitespace-nowrap text-gray-600">{precio}</td>
                    <td className="p-3 whitespace-nowrap font-black text-[#0b315f]">{c.monto_total != null ? fmtSoles(c.monto_total) : "—"}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
                        {(c.anomalias ?? []).map((a, i) => (
                          <span key={i} className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-[#FDECEC] text-[#EB5757]" title={a.detalle}>
                            {ANOMALIA_LABEL[a.codigo] ?? a.codigo}
                          </span>
                        ))}
                        {(c.anomalias ?? []).length === 0 && <span className="text-xs text-gray-300">—</span>}
                      </div>
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <ChipEstado {...est} />
                        {c.estado === "registrado" && (
                          <Link href="/combustible" onClick={(e) => e.stopPropagation()} className="text-[#1262bd] hover:underline text-xs font-bold inline-flex items-center gap-1">
                            <Ic.Externo size={12} /> Ver
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                  {esPendiente && abierto && (
                    <tr className="border-t" style={{ borderColor: "#f1f5f9" }}>
                      <td colSpan={8} className="p-4 bg-blue-50/40">
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="block text-[11px] font-black text-gray-400 uppercase tracking-wide mb-1">Vehículo</label>
                            <select
                              value={vehSel}
                              onChange={(e) => setSelVehiculo((prev) => ({ ...prev, [c.id]: e.target.value }))}
                              onClick={(e) => e.stopPropagation()}
                              className="border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] bg-white"
                            >
                              <option value="">— Elegir unidad —</option>
                              {vehiculos.map((v) => (
                                <option key={v.id} value={String(v.id)}>{v.placa}{v.categoria ? ` · ${v.categoria}` : ""}</option>
                              ))}
                            </select>
                          </div>
                          {c.conductor && <p className="text-xs text-gray-500 font-semibold pb-2.5">Conductor: <span className="font-bold text-gray-700">{c.conductor}</span></p>}
                          {c.comprobante && <p className="text-xs text-gray-500 font-semibold pb-2.5">Comprobante: <span className="font-mono">{c.comprobante}</span></p>}
                          <div className="flex items-center gap-2 ml-auto">
                            <button
                              onClick={(e) => { e.stopPropagation(); onRegistrar(c, Number(vehSel)); }}
                              disabled={!puedeRegistrar || registrando === c.id}
                              className="px-3 py-2 rounded-xl text-xs font-bold bg-[#0b315f] text-white hover:bg-[#1262bd] transition-colors disabled:opacity-40"
                            >
                              {registrando === c.id ? "Registrando…" : "Registrar en Combustible"}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); onDescartar(c.id); }}
                              className="px-3 py-2 rounded-xl text-xs font-bold text-[#EB5757] hover:bg-[#FDECEC] transition-colors"
                            >
                              Descartar
                            </button>
                          </div>
                        </div>
                        {!puedeRegistrar && (
                          <p className="text-[11px] text-[#B07A0F] font-bold mt-2">
                            Para registrar se necesita unidad, galones o litros, y precio o monto total.
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </FragmentoFilaCombustible>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Wrapper mínimo para agrupar fila + fila expandida sin romper el <tbody>
function FragmentoFilaCombustible({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ── Tab: Alertas ─────────────────────────────────────────────────────────────

function TabAlertas({ alertas, onMarcarLeida, onMarcarTodas }: {
  alertas: RadarAlerta[];
  onMarcarLeida: (id: string) => void;
  onMarcarTodas: () => void;
}) {
  const [filtroSev, setFiltroSev] = useState<SeveridadAlerta | "todas">("todas");
  const [verLeidas, setVerLeidas] = useState(false);

  const filtradas = alertas.filter((a) => {
    if (!verLeidas && a.leida) return false;
    if (filtroSev !== "todas" && a.severidad !== filtroSev) return false;
    return true;
  });
  const sinLeer = alertas.filter((a) => !a.leida).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
          {(["todas", "critico", "atencion", "info"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFiltroSev(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filtroSev === s ? "bg-white shadow-sm text-[#0b315f]" : "text-gray-400 hover:text-gray-600"}`}
            >
              {s === "todas" ? "Todas" : SEVERIDAD_CFG[s].label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setVerLeidas((v) => !v)}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${verLeidas ? "bg-white border-[#0b315f] text-[#0b315f]" : "border-gray-200 text-gray-400 hover:text-gray-600"}`}
        >
          {verLeidas ? "Ocultar leídas" : "Ver leídas"}
        </button>
        {sinLeer > 0 && (
          <button
            onClick={onMarcarTodas}
            className="ml-auto px-3 py-1.5 rounded-lg text-xs font-bold bg-[#0b315f] text-white hover:bg-[#1262bd] transition-colors"
          >
            Marcar todas leídas
          </button>
        )}
      </div>

      {filtradas.length === 0 ? (
        <CardVacia emoji="🔕" titulo="Sin alertas por leer" detalle={verLeidas ? "No hay alertas con ese filtro." : "Activa “Ver leídas” para revisar el historial."} />
      ) : (
        <div className="space-y-2">
          {filtradas.map((a) => {
            const sev = SEVERIDAD_CFG[a.severidad] ?? SEVERIDAD_CFG.info;
            return (
              <div
                key={a.id}
                className={`bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex items-start gap-3 ${a.leida ? "opacity-60" : ""}`}
                style={{ borderLeft: `4px solid ${sev.color}`, background: a.leida ? "#fff" : sev.bg }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <ChipEstado label={sev.label} color={sev.color} bg="#ffffff" />
                    <p className="font-black text-sm text-[#0b315f]">{a.titulo}</p>
                  </div>
                  {a.detalle && <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{a.detalle}</p>}
                  <div className="flex items-center gap-3 mt-1.5">
                    <p className="text-[11px] text-gray-400 font-semibold">{haceRelativo(a.created_at)}</p>
                    {a.href && (
                      <Link href={a.href} className="text-xs font-bold text-[#1262bd] hover:underline inline-flex items-center gap-1">
                        <Ic.Externo size={12} /> Ver en el ERP
                      </Link>
                    )}
                  </div>
                </div>
                {!a.leida && (
                  <button
                    onClick={() => onMarcarLeida(a.id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold border border-gray-200 bg-white text-gray-500 hover:border-gray-300 transition-colors whitespace-nowrap"
                  >
                    Marcar leída
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Tab: Grupos ──────────────────────────────────────────────────────────────

type PatchGrupo = { contexto: string | null; categorias_permitidas: CategoriaRadar[] | null };

function TabGrupos({ grupos, onToggle, onGuardarContexto }: {
  grupos: RadarGrupo[];
  onToggle: (g: RadarGrupo) => void;
  onGuardarContexto: (g: RadarGrupo, patch: PatchGrupo) => Promise<void>;
}) {
  const [busqueda, setBusqueda] = useState("");
  const filtrados = grupos.filter((g) => !busqueda.trim() || norm(g.nombre).includes(norm(busqueda)));

  return (
    <div className="space-y-4">
      <div className="bg-[#E8F1FB] border border-[#2f8ee9]/30 rounded-2xl p-4 flex items-start gap-3">
        <span className="text-xl">ℹ️</span>
        <p className="text-sm text-[#0b315f] font-semibold">
          El número dedicado del Radar debe ser miembro del grupo. Los grupos se sincronizan solos al conectar el worker.
          Si un grupo NO es de la operación de AFA (p.ej. una red de apoyo entre transportistas), abre la fila y cuéntale
          el contexto a ELIA para que no clasifique mal sus mensajes.
        </p>
      </div>

      <div className="relative max-w-sm">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300"><Ic.Lupa size={15} /></span>
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar grupo…"
          className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#0b315f] transition-colors bg-white"
        />
      </div>

      {filtrados.length === 0 ? (
        <CardVacia emoji="👥" titulo="Aún no hay grupos" detalle="Conecta el worker y espera unos segundos." />
      ) : (
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Grupo", "Participantes", "ID de WhatsApp", "Monitorear"].map((h) => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtrados.map((g) => (
                  <FilaGrupo key={g.id} g={g} onToggle={onToggle} onGuardar={onGuardarContexto} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function FilaGrupo({ g, onToggle, onGuardar }: {
  g: RadarGrupo;
  onToggle: (g: RadarGrupo) => void;
  onGuardar: (g: RadarGrupo, patch: PatchGrupo) => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [contexto, setContexto] = useState(g.contexto ?? "");
  const [cats, setCats] = useState<CategoriaRadar[]>(g.categorias_permitidas ?? []);
  const [guardando, setGuardando] = useState(false);

  // Si la fila llega actualizada desde afuera (recarga/realtime) y no se está editando, resincroniza el borrador.
  useEffect(() => {
    if (!abierto) {
      setContexto(g.contexto ?? "");
      setCats(g.categorias_permitidas ?? []);
    }
  }, [g.contexto, g.categorias_permitidas, abierto]);

  const toggleCat = (c: CategoriaRadar) =>
    setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const guardar = async () => {
    setGuardando(true);
    await onGuardar(g, { contexto: contexto.trim() || null, categorias_permitidas: cats.length ? cats : null });
    setGuardando(false);
  };

  const personalizado = !!g.contexto || !!(g.categorias_permitidas && g.categorias_permitidas.length);

  return (
    <>
      <tr className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
        <td className="p-3">
          <button onClick={() => setAbierto((v) => !v)} className="flex items-center gap-2 font-bold text-[#0b315f] text-left">
            <Ic.Chevron size={13} className={`text-gray-300 transition-transform flex-shrink-0 ${abierto ? "rotate-180" : ""}`} />
            <span>{g.nombre || "(sin nombre)"}</span>
            {personalizado && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#2f8ee9] flex-shrink-0" title="Tiene contexto o categorías personalizadas" />
            )}
          </button>
        </td>
        <td className="p-3 text-gray-600">{g.participantes}</td>
        <td className="p-3 font-mono text-xs text-gray-400">{g.wa_group_id}</td>
        <td className="p-3"><Switch on={g.activo} onClick={() => onToggle(g)} /></td>
      </tr>
      {abierto && (
        <tr className="bg-blue-50/30 border-t" style={{ borderColor: "#f1f5f9" }}>
          <td colSpan={4} className="p-4 space-y-3">
            <div>
              <label className="text-xs font-black text-gray-400 uppercase tracking-wide">Contexto para ELIA (opcional)</label>
              <textarea
                value={contexto}
                onChange={(e) => setContexto(e.target.value)}
                rows={2}
                placeholder='Ej: "Red de apoyo entre transportistas independientes, NO es la flota de AFA. Marcar oportunidad_comercial solo si alguien pide un servicio que AFA podría cubrir."'
                className="w-full mt-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-[#0b315f] transition-colors bg-white"
              />
            </div>
            <div>
              <label className="text-xs font-black text-gray-400 uppercase tracking-wide">Categorías permitidas en este grupo</label>
              <p className="text-[11px] text-gray-400 mb-1.5 mt-0.5">Sin selección = usa las categorías activas globales de Configuración.</p>
              <div className="flex flex-wrap gap-1.5">
                {LISTA_CATEGORIAS.filter((c) => c !== "otros").map((c) => {
                  const activa = cats.includes(c);
                  const cat = CATEGORIAS_RADAR[c];
                  return (
                    <button
                      key={c}
                      onClick={() => toggleCat(c)}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition-colors ${activa ? "" : "border-gray-200 text-gray-400 bg-white hover:border-gray-300"}`}
                      style={activa ? { color: cat.color, background: cat.bg, borderColor: cat.color } : undefined}
                    >
                      {cat.emoji} {cat.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              onClick={guardar}
              disabled={guardando}
              className="bg-[#0b315f] text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-[#1262bd] transition-colors disabled:opacity-50"
            >
              {guardando ? "Guardando…" : "Guardar"}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Tab: Configuración ───────────────────────────────────────────────────────

function TabConfiguracion({ config, guardando, onGuardar, vehiculosGuia, onGuardarGuiaOdometro }: {
  config: RadarConfig;
  guardando: boolean;
  onGuardar: (cfg: RadarConfig) => void;
  vehiculosGuia: VehiculoGuiaOdometro[];
  onGuardarGuiaOdometro: (v: VehiculoGuiaOdometro, guia: string | null) => Promise<void>;
}) {
  const [cfg, setCfg] = useState<RadarConfig>(() => ({
    ...config,
    categorias_activas: [...(config.categorias_activas ?? [])],
    palabras_clave: [...(config.palabras_clave ?? [])],
    acciones_automaticas: { ...(config.acciones_automaticas ?? {}) },
  }));
  const [palabra, setPalabra] = useState("");

  const set = <K extends keyof RadarConfig>(k: K, v: RadarConfig[K]) => setCfg((prev) => ({ ...prev, [k]: v }));

  const toggleCategoria = (c: CategoriaRadar) => {
    set(
      "categorias_activas",
      cfg.categorias_activas.includes(c)
        ? cfg.categorias_activas.filter((x) => x !== c)
        : [...cfg.categorias_activas, c]
    );
  };

  const agregarPalabra = () => {
    const p = palabra.trim().toLowerCase();
    if (!p) return;
    if (!cfg.palabras_clave.includes(p)) set("palabras_clave", [...cfg.palabras_clave, p]);
    setPalabra("");
  };

  const ACCIONES: { clave: "combustible" | "odometro" | "mantenimiento" | "operaciones"; titulo: string; riesgo: string }[] = [
    { clave: "combustible",   titulo: "Combustible automático",   riesgo: "Registra recargas sin anomalías directamente en /combustible" },
    { clave: "odometro",      titulo: "Odómetro automático",      riesgo: "Registra lecturas de kilometraje en /mantenimiento (protegido: una lectura rara nunca corrompe el km vigente, solo queda «por revisar»)" },
    { clave: "mantenimiento", titulo: "Mantenimiento automático", riesgo: "Crea la orden y puede poner la unidad en mantenimiento (bloquea asignaciones)" },
    { clave: "operaciones",   titulo: "Operaciones automáticas",  riesgo: "Cambia el estado del servicio (en curso/finalizada) — recomendado dejarlo apagado" },
  ];

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Estado general */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-black text-[#0b315f] text-sm">Estado general</h3>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-gray-700">Radar activo</p>
              <p className="text-xs text-gray-400">Si está apagado, los mensajes se capturan pero no se analizan.</p>
            </div>
            <Switch on={cfg.activo} onClick={() => set("activo", !cfg.activo)} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-gray-700">Solo en horario</p>
              <p className="text-xs text-gray-400">Analiza únicamente dentro de la ventana horaria (hora de Lima).</p>
            </div>
            <Switch on={cfg.horario_activo} onClick={() => set("horario_activo", !cfg.horario_activo)} />
          </div>
          {cfg.horario_activo && (
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-xs font-bold text-gray-400">Desde</label>
              <input
                type="time"
                value={cfg.hora_inicio}
                onChange={(e) => set("hora_inicio", e.target.value)}
                className="border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f]"
              />
              <label className="text-xs font-bold text-gray-400">Hasta</label>
              <input
                type="time"
                value={cfg.hora_fin}
                onChange={(e) => set("hora_fin", e.target.value)}
                className="border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f]"
              />
              <span className="text-xs text-gray-400 font-semibold">hora de Lima</span>
            </div>
          )}
        </div>
      </div>

      {/* Categorías */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-black text-[#0b315f] text-sm">Categorías activas</h3>
          <p className="text-xs text-gray-400 mt-0.5">Solo estas categorías generan extracción y acciones. Lo demás cae en «Otros».</p>
        </div>
        <div className="p-5 flex flex-wrap gap-2">
          {LISTA_CATEGORIAS.filter((c) => c !== "otros").map((c) => {
            const activa = cfg.categorias_activas.includes(c);
            const cat = CATEGORIAS_RADAR[c];
            return (
              <button
                key={c}
                onClick={() => toggleCategoria(c)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${activa ? "" : "border-gray-200 text-gray-400 bg-white hover:border-gray-300"}`}
                style={activa ? { color: cat.color, background: cat.bg, borderColor: cat.color } : undefined}
              >
                {cat.emoji} {cat.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Acciones automáticas */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-black text-[#0b315f] text-sm">Acciones automáticas</h3>
          <p className="text-xs text-gray-400 mt-0.5">Con el switch apagado, todo queda en revisión manual (siempre se genera alerta y registro).</p>
        </div>
        <div className="p-5 space-y-4">
          {ACCIONES.map((a) => (
            <div key={a.clave} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-gray-700">{a.titulo}</p>
                <p className="text-xs text-gray-400">{a.riesgo}</p>
              </div>
              <Switch
                on={Boolean(cfg.acciones_automaticas[a.clave])}
                onClick={() => set("acciones_automaticas", { ...cfg.acciones_automaticas, [a.clave]: !cfg.acciones_automaticas[a.clave] })}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Afinado del análisis */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-black text-[#0b315f] text-sm">Afinado del análisis</h3>
        </div>
        <div className="p-5 space-y-5">
          <div>
            <p className="text-sm font-bold text-gray-700 mb-1">Palabras clave</p>
            <p className="text-xs text-gray-400 mb-2">Pistas extra para el triage (placas, apodos de unidades, nombres de clientes). Enter para agregar.</p>
            <input
              value={palabra}
              onChange={(e) => setPalabra(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); agregarPalabra(); } }}
              placeholder="Escribe y presiona Enter…"
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#0b315f] transition-colors"
            />
            {cfg.palabras_clave.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {cfg.palabras_clave.map((p) => (
                  <span key={p} className="inline-flex items-center gap-1 text-xs font-bold bg-gray-50 border border-gray-200 rounded-full px-2.5 py-1 text-gray-600">
                    {p}
                    <button
                      onClick={() => set("palabras_clave", cfg.palabras_clave.filter((x) => x !== p))}
                      className="text-gray-400 hover:text-[#EB5757] font-black leading-none"
                      aria-label={`Quitar ${p}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-gray-700">Umbral de confianza</p>
              <span className="text-sm font-black text-[#0b315f]">{Math.round(cfg.umbral_confianza * 100)}%</span>
            </div>
            <input
              type="range"
              min={0.3}
              max={0.95}
              step={0.05}
              value={cfg.umbral_confianza}
              onChange={(e) => set("umbral_confianza", Number(e.target.value))}
              className="w-full mt-2 accent-[#0b315f]"
            />
            <p className="text-xs text-gray-400 mt-1">Bajo este nivel de confianza, la acción queda en revisión manual.</p>
          </div>

          <div>
            <p className="text-sm font-bold text-gray-700 mb-1">Modelo de extracción</p>
            <select
              value={cfg.modelo_extraccion}
              onChange={(e) => set("modelo_extraccion", e.target.value)}
              className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] bg-white"
            >
              <option value="claude-sonnet-5">claude-sonnet-5 · Recomendado</option>
              <option value="claude-haiku-4-5">claude-haiku-4-5 · Económico</option>
              <option value="claude-opus-4-8">claude-opus-4-8 · Máxima calidad</option>
            </select>
            <p className="text-xs text-gray-400 mt-1.5">El triage siempre usa <span className="font-mono">claude-haiku-4-5</span> (rápido y económico); este modelo solo aplica a la extracción de datos.</p>
          </div>

          <div>
            <p className="text-sm font-bold text-gray-700 mb-1">Guía de lectura de vouchers de combustible</p>
            <p className="text-xs text-gray-400 mb-2">
              Explícale a ELIA particularidades de los vouchers que recibes (p.ej. "el monto real dice TOTAL, no
              SUBTOTAL" o "a veces la placa aparece como UNIDAD"). Se usa en cada foto/PDF de combustible.
            </p>
            <textarea
              value={cfg.guia_voucher ?? ""}
              onChange={(e) => set("guia_voucher", e.target.value || null)}
              placeholder='Ej: "El monto a usar es el que dice TOTAL (no SUBTOTAL). El código de la placa a veces aparece como UNIDAD o UND."'
              rows={3}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#0b315f] transition-colors resize-none"
            />
          </div>
        </div>
      </div>

      {/* Guías de odómetro por vehículo */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-black text-[#0b315f] text-sm">Guías de odómetro por vehículo</h3>
          <p className="text-xs text-gray-400 mt-0.5">Cada tablero es distinto — explícale a ELIA dónde está la lectura y qué ignorar (p.ej. el trip parcial) en cada unidad.</p>
        </div>
        {vehiculosGuia.length === 0 ? (
          <p className="p-5 text-sm text-gray-400">Sin vehículos registrados todavía.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Placa", "Categoría", "Flota"].map((h) => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vehiculosGuia.map((v) => (
                  <FilaGuiaOdometro key={`${v.tipo}-${v.id}`} v={v} onGuardar={onGuardarGuiaOdometro} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Notificaciones y presupuesto */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-black text-[#0b315f] text-sm">Notificaciones y presupuesto</h3>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-gray-700">Notificar por email</p>
              <p className="text-xs text-gray-400">Envía las alertas críticas y de atención a los correos configurados.</p>
            </div>
            <Switch on={cfg.notificar_email} onClick={() => set("notificar_email", !cfg.notificar_email)} />
          </div>
          {cfg.notificar_email && (
            <textarea
              value={cfg.correos_alerta ?? ""}
              onChange={(e) => set("correos_alerta", e.target.value || null)}
              placeholder="operaciones@afatoursperu.com, administracion@afatoursperu.com"
              rows={2}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#0b315f] transition-colors resize-none"
            />
          )}
          <div>
            <p className="text-sm font-bold text-gray-700 mb-1">Límite diario de gasto IA (USD)</p>
            <input
              type="number"
              min={0}
              step={0.5}
              value={cfg.limite_diario_usd}
              onChange={(e) => set("limite_diario_usd", Number(e.target.value))}
              className="w-32 border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f]"
            />
            <p className="text-xs text-gray-400 mt-1">Al llegar al límite, los mensajes quedan pendientes hasta el día siguiente.</p>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => onGuardar(cfg)}
          disabled={guardando}
          className="px-5 py-2.5 rounded-xl text-sm font-bold bg-[#0b315f] text-white hover:bg-[#1262bd] transition-colors shadow-sm disabled:opacity-50"
        >
          {guardando ? "Guardando…" : "Guardar configuración"}
        </button>
      </div>
    </div>
  );
}

function FilaGuiaOdometro({ v, onGuardar }: {
  v: VehiculoGuiaOdometro;
  onGuardar: (v: VehiculoGuiaOdometro, guia: string | null) => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [guia, setGuia] = useState(v.guia_odometro ?? "");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!abierto) setGuia(v.guia_odometro ?? "");
  }, [v.guia_odometro, abierto]);

  const guardar = async () => {
    setGuardando(true);
    await onGuardar(v, guia.trim() || null);
    setGuardando(false);
  };

  return (
    <>
      <tr className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
        <td className="p-3">
          <button onClick={() => setAbierto((x) => !x)} className="flex items-center gap-2 font-bold text-[#0b315f] text-left">
            <Ic.Chevron size={13} className={`text-gray-300 transition-transform flex-shrink-0 ${abierto ? "rotate-180" : ""}`} />
            <span className="font-mono">{v.placa}</span>
            {v.guia_odometro && <span className="w-1.5 h-1.5 rounded-full bg-[#2f8ee9] flex-shrink-0" title="Tiene guía configurada" />}
          </button>
        </td>
        <td className="p-3 text-gray-500">{v.categoria ?? "—"}</td>
        <td className="p-3">
          <span
            className="text-[10px] font-black px-2 py-0.5 rounded-full"
            style={v.tipo === "tercero" ? { color: "#B07A0F", background: "#FBF1D8" } : { color: "#27AE60", background: "#E8F5EC" }}
          >
            {v.tipo === "tercero" ? "Tercerizada" : "Propia"}
          </span>
        </td>
      </tr>
      {abierto && (
        <tr className="bg-blue-50/30 border-t" style={{ borderColor: "#f1f5f9" }}>
          <td colSpan={3} className="p-4 space-y-3">
            <textarea
              value={guia}
              onChange={(e) => setGuia(e.target.value)}
              rows={2}
              placeholder='Ej: "Pantalla digital superior derecha, formato con puntos (25.434 km). El TRIP de abajo se ignora."'
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-[#0b315f] transition-colors bg-white"
            />
            <button
              onClick={guardar}
              disabled={guardando}
              className="bg-[#0b315f] text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-[#1262bd] transition-colors disabled:opacity-50"
            >
              {guardando ? "Guardando…" : "Guardar"}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Página principal ─────────────────────────────────────────────────────────

export default function RadarIAPage() {
  const [loading, setLoading] = useState(true);
  const [estado, setEstado] = useState<RadarEstado | null>(null);
  const [config, setConfig] = useState<RadarConfig | null>(null);
  const [grupos, setGrupos] = useState<RadarGrupo[]>([]);
  const [mensajes, setMensajes] = useState<RadarMensaje[]>([]);
  const [oportunidades, setOportunidades] = useState<RadarOportunidad[]>([]);
  const [combustibles, setCombustibles] = useState<RadarCombustible[]>([]);
  const [alertas, setAlertas] = useState<RadarAlerta[]>([]);
  const [vehiculos, setVehiculos] = useState<VehiculoLite[]>([]);
  const [vehiculosGuia, setVehiculosGuia] = useState<VehiculoGuiaOdometro[]>([]);

  const [tab, setTab] = useState<TabId>("feed");
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [reprocesando, setReprocesando] = useState<string | null>(null);
  const [creandoCot, setCreandoCot] = useState<string | null>(null);
  const [registrandoComb, setRegistrandoComb] = useState<string | null>(null);
  const [guardandoConfig, setGuardandoConfig] = useState(false);
  const [solicitandoQr, setSolicitandoQr] = useState(false);

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Carga de datos ──
  const cargar = useCallback(async () => {
    try {
      const [rEstado, rConfig, rGrupos, rMensajes, rOpps, rComb, rAlertas, rVehiculos, rVehTercero] = await Promise.all([
        supabase.from("radar_estado").select("*").eq("id", 1).maybeSingle(),
        supabase.from("radar_config").select("*").eq("id", 1).maybeSingle(),
        supabase.from("radar_grupos").select("*").order("nombre"),
        supabase.from("radar_mensajes").select("*").order("recibido_en", { ascending: false }).limit(150),
        supabase.from("radar_oportunidades").select("*").order("created_at", { ascending: false }).limit(60),
        supabase.from("radar_combustible").select("*").order("created_at", { ascending: false }).limit(60),
        supabase.from("radar_alertas").select("*").order("created_at", { ascending: false }).limit(100),
        supabase.from("vehiculos").select("id, placa, categoria, estado, guia_odometro"),
        supabase.from("vehiculos_tercero").select("id, placa, categoria, guia_odometro"),
      ]);
      if (rEstado.error) console.warn("radar-ia: error leyendo radar_estado", rEstado.error);
      if (rConfig.error) console.warn("radar-ia: error leyendo radar_config", rConfig.error);
      setEstado((rEstado.data as RadarEstado | null) ?? null);
      // Normaliza con los MISMOS defaults que el motor (lib/radar/config): así el toggle
      // "Odómetro automático" muestra el estado real que ejecuta el pipeline, en vez de
      // leerse apagado por una clave ausente en una config vieja mientras el backend la
      // trataba como encendida.
      setConfig(rConfig.data ? normalizarConfigRadar(rConfig.data) : null);
      setGrupos(((rGrupos.data ?? []) as RadarGrupo[]));
      setMensajes(((rMensajes.data ?? []) as RadarMensaje[]));
      setOportunidades(((rOpps.data ?? []) as RadarOportunidad[]));
      setCombustibles(((rComb.data ?? []) as RadarCombustible[]));
      setAlertas(((rAlertas.data ?? []) as RadarAlerta[]));
      setVehiculos(((rVehiculos.data ?? []) as VehiculoLite[]));
      const guiaPropios: VehiculoGuiaOdometro[] = ((rVehiculos.data ?? []) as any[]).map((v) => ({
        tipo: "propio", id: v.id, placa: v.placa, categoria: v.categoria ?? null, guia_odometro: v.guia_odometro ?? null,
      }));
      const guiaTerceros: VehiculoGuiaOdometro[] = ((rVehTercero.data ?? []) as any[]).map((v) => ({
        tipo: "tercero", id: v.id, placa: v.placa, categoria: v.categoria ?? null, guia_odometro: v.guia_odometro ?? null,
      }));
      setVehiculosGuia(
        [...guiaPropios, ...guiaTerceros].sort((a, b) => (a.placa ?? "").localeCompare(b.placa ?? ""))
      );
    } catch (e) {
      console.warn("radar-ia: error cargando datos", e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Tab inicial desde ?tab= (window.location para no requerir Suspense de useSearchParams)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && TABS.some((x) => x.id === t)) setTab(t as TabId);
  }, []);

  // ── Realtime con throttle de 2 s ──
  const throttleRef = useRef<{ ultima: number; timer: ReturnType<typeof setTimeout> | null }>({ ultima: 0, timer: null });
  const recargarThrottled = useCallback(() => {
    const t = throttleRef.current;
    const ahora = Date.now();
    if (ahora - t.ultima >= 2000) {
      t.ultima = ahora;
      cargar();
    } else if (!t.timer) {
      t.timer = setTimeout(() => {
        t.timer = null;
        throttleRef.current.ultima = Date.now();
        cargar();
      }, 2000 - (ahora - t.ultima));
    }
  }, [cargar]);

  useEffect(() => {
    const ch = supabase
      .channel("radar_realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "radar_mensajes" }, () => recargarThrottled())
      .on("postgres_changes", { event: "*", schema: "public", table: "radar_alertas" }, () => recargarThrottled())
      .on("postgres_changes", { event: "*", schema: "public", table: "radar_estado" }, () => recargarThrottled())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [recargarThrottled]);

  // Fallback: refrescar solo el estado de conexión cada 20 s (por si realtime se cae)
  useEffect(() => {
    const timer = setInterval(async () => {
      const { data } = await supabase.from("radar_estado").select("*").eq("id", 1).maybeSingle();
      if (data) setEstado(data as RadarEstado);
    }, 20000);
    return () => clearInterval(timer);
  }, []);

  // Tick liviano para que "hace Xs" del latido se mantenga fresco
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // ── Derivados / KPIs ──
  const hoy = hoyISO();
  const mensajesHoy = mensajes.filter(
    (m) => (m.estado === "procesado" || m.estado === "descartado") && fechaLocalDe(m.recibido_en) === hoy
  ).length;
  const oppAbiertas = oportunidades.filter((o) => o.estado === "nueva" || o.estado === "revisada");
  const utilidadPotencial = oppAbiertas.reduce((s, o) => s + Number(o.utilidad_estimada ?? 0), 0);
  const combustibleHoy = combustibles
    .filter((c) => c.estado === "registrado" && (c.fecha ? c.fecha === hoy : fechaLocalDe(c.created_at) === hoy))
    .reduce((s, c) => s + Number(c.monto_total ?? 0), 0);
  const alertasSinLeer = alertas.filter((a) => !a.leida).length;
  const fbCorrectos = mensajes.filter((m) => m.feedback === "correcto").length;
  const fbIncorrectos = mensajes.filter((m) => m.feedback === "incorrecto").length;
  const precision = fbCorrectos + fbIncorrectos > 0
    ? `${Math.round((fbCorrectos / (fbCorrectos + fbIncorrectos)) * 100)}%`
    : "—";
  const gastoHoy = mensajes
    .filter((m) => m.procesado_en && fechaLocalDe(m.procesado_en) === hoy)
    .reduce((s, m) => s + Number(m.costo_usd ?? 0), 0);

  const oppNuevas = oportunidades.filter((o) => o.estado === "nueva").length;
  const combPendientes = combustibles.filter((c) => c.estado === "pendiente_revision").length;

  const grupoPorMensaje = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of mensajes) if (m.grupo_nombre) map[m.id] = m.grupo_nombre;
    return map;
  }, [mensajes]);

  // ── Chip de conexión ──
  const conexion = (() => {
    if (!estado) return { dot: "#EB5757", color: "#EB5757", texto: "Sin estado", sub: "Corre supabase/radar-ia.sql" as string | null };
    const latidoMs = estado.ultimo_latido ? Date.now() - new Date(estado.ultimo_latido).getTime() : null;
    if (estado.estado === "conectado") {
      if (latidoMs === null || latidoMs > 3 * 60 * 1000) {
        return {
          dot: "#B07A0F", color: "#B07A0F", texto: "Worker sin señal",
          sub: estado.ultimo_latido ? `último latido ${haceRelativo(estado.ultimo_latido)}` : "sin latido registrado",
        };
      }
      return {
        dot: "#27AE60", color: "#27AE60",
        texto: `Conectado${estado.numero ? ` · ${estado.numero}` : ""}`,
        sub: `latido ${haceRelativo(estado.ultimo_latido)}`,
      };
    }
    if (estado.estado === "esperando_qr") {
      return { dot: "#B07A0F", color: "#B07A0F", texto: "Esperando QR", sub: "escanea el código para vincular" };
    }
    return { dot: "#EB5757", color: "#EB5757", texto: "Desconectado", sub: estado.detalle };
  })();

  // ── Mutaciones ──

  async function toggleRadarActivo() {
    if (!config) return;
    const nuevo = !config.activo;
    const previo = config;
    setConfig({ ...config, activo: nuevo });
    const { error } = await supabase.from("radar_config").update({ activo: nuevo }).eq("id", 1);
    if (error) {
      console.warn("radar-ia: error actualizando activo", error);
      setConfig(previo);
      showToast("No se pudo actualizar el estado del Radar", false);
    } else {
      showToast(nuevo ? "Radar activado" : "Radar en pausa");
    }
  }

  async function solicitarNuevoQr() {
    if (
      !window.confirm(
        "Esto va a cerrar la sesión de WhatsApp que el Radar tiene activa ahora mismo y va a pedir escanear un QR nuevo. ¿Continuar?"
      )
    ) {
      return;
    }
    setSolicitandoQr(true);
    try {
      const { error } = await supabase.from("radar_estado").update({ solicitar_relink: true }).eq("id", 1);
      if (error) {
        console.warn("radar-ia: error solicitando QR nuevo", error);
        showToast("No se pudo solicitar el QR nuevo", false);
        return;
      }
      showToast("Solicitado — si el worker está corriendo, el QR nuevo aparece aquí en unos segundos");
    } finally {
      setSolicitandoQr(false);
    }
  }

  async function marcarFeedback(id: string, fb: "correcto" | "incorrecto") {
    setMensajes((prev) => prev.map((m) => (m.id === id ? { ...m, feedback: fb } : m)));
    const { error } = await supabase.from("radar_mensajes").update({ feedback: fb }).eq("id", id);
    if (error) {
      console.warn("radar-ia: error guardando feedback", error);
      showToast("No se pudo guardar el feedback", false);
    }
  }

  async function reprocesarMensaje(id: string) {
    setReprocesando(id);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;
      if (!token) {
        showToast("Sesión expirada: vuelve a iniciar sesión", false);
        return;
      }
      const res = await fetch("/api/radar/reprocesar", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mensaje_id: id }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.ok) {
        const detalle = typeof data.detalle === "string" ? data.detalle : typeof data.mensaje === "string" ? data.mensaje : "Mensaje reprocesado";
        showToast(detalle);
        cargar();
      } else {
        showToast(typeof data.error === "string" ? data.error : "Error al reprocesar el mensaje", false);
      }
    } catch (e) {
      console.warn("radar-ia: error reprocesando", e);
      showToast("Error al reprocesar el mensaje", false);
    } finally {
      setReprocesando(null);
    }
  }

  async function crearCotizacion(o: RadarOportunidad) {
    setCreandoCot(o.id);
    try {
      // 1) Cliente: usar el match o crear uno nuevo desde los datos del mensaje
      let clienteId = o.cliente_id;
      if (clienteId == null) {
        const { data: cli, error: eCli } = await supabase
          .from("clientes")
          .insert({
            nombre: o.cliente_nombre ?? o.empresa ?? "Cliente WhatsApp",
            tipo: "b2b",
            estado: "activo",
            telefono: o.telefono,
            empresa: o.empresa,
          })
          .select("id")
          .single();
        if (eCli || !cli) throw eCli ?? new Error("no se pudo crear el cliente");
        clienteId = (cli as any).id as number;
      }
      // 2) Cotización en borrador (espejo del payload del agente CRM)
      const { data: cot, error: eCot } = await supabase
        .from("cotizaciones")
        .insert({
          cliente_id: clienteId,
          estado: "borrador",
          origen: o.origen,
          destino: o.destino,
          fecha_servicio: o.fecha_servicio,
          hora_ida: o.hora_servicio,
          tipo_vehiculo: o.tipo_vehiculo,
          precio_cliente: o.precio_referencial,
          atencion: o.cliente_nombre,
          asunto: "Solicitud vía WhatsApp (Radar IA)",
          medio_envio: "radar_ia",
          incluye_igv: false,
        })
        .select("id")
        .single();
      if (eCot || !cot) throw eCot ?? new Error("no se pudo crear la cotización");
      const cotId = (cot as any).id as number;
      // 3) Cerrar la oportunidad
      await supabase.from("radar_oportunidades").update({ estado: "cotizada", cotizacion_id: cotId }).eq("id", o.id);
      showToast(`Cotización #${String(cotId).padStart(5, "0")} creada como borrador`);
      cargar();
    } catch (e) {
      console.warn("radar-ia: error creando cotización", e);
      showToast("No se pudo crear la cotización", false);
    } finally {
      setCreandoCot(null);
    }
  }

  async function cambiarEstadoOportunidad(id: string, nuevoEstado: RadarOportunidad["estado"]) {
    setOportunidades((prev) => prev.map((o) => (o.id === id ? { ...o, estado: nuevoEstado } : o)));
    const { error } = await supabase.from("radar_oportunidades").update({ estado: nuevoEstado }).eq("id", id);
    if (error) {
      console.warn("radar-ia: error actualizando oportunidad", error);
      showToast("No se pudo actualizar la oportunidad", false);
      cargar();
    } else {
      showToast(nuevoEstado === "descartada" ? "Oportunidad descartada" : "Oportunidad marcada como revisada");
    }
  }

  async function registrarCombustible(c: RadarCombustible, vehiculoId: number) {
    const galones = c.galones ?? c.litros;
    const precio = c.precio_galon ?? c.precio_litro ?? (c.monto_total != null && galones ? c.monto_total / galones : null);
    if (!vehiculoId || !galones || !precio) {
      showToast("Faltan datos para registrar la recarga", false);
      return;
    }
    setRegistrandoComb(c.id);
    try {
      const grupo = (c.mensaje_id && grupoPorMensaje[c.mensaje_id]) || "WhatsApp";
      // OJO: nunca escribir `total` — es columna generada (galones × precio_galon)
      const { data, error } = await supabase
        .from("combustible")
        .insert({
          vehiculo_id: vehiculoId,
          fecha: c.fecha ?? hoyISO(),
          kilometraje: c.kilometraje ?? 0,
          galones,
          precio_galon: precio,
          grifo: c.grifo,
          conductor: c.conductor,
          observaciones: `Radar IA (manual) · grupo ${grupo}`,
          tipo_combustible: c.tipo_combustible ?? "diesel",
          unidad: c.galones != null ? "galones" : "litros",
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("no se pudo insertar en combustible");
      await supabase
        .from("radar_combustible")
        .update({ estado: "registrado", combustible_id: (data as any).id, vehiculo_id: vehiculoId })
        .eq("id", c.id);
      showToast("Recarga registrada en Combustible");
      cargar();
    } catch (e) {
      console.warn("radar-ia: error registrando combustible", e);
      showToast("No se pudo registrar la recarga", false);
    } finally {
      setRegistrandoComb(null);
    }
  }

  async function descartarCombustible(id: string) {
    setCombustibles((prev) => prev.map((c) => (c.id === id ? { ...c, estado: "descartado" } : c)));
    const { error } = await supabase.from("radar_combustible").update({ estado: "descartado" }).eq("id", id);
    if (error) {
      console.warn("radar-ia: error descartando combustible", error);
      showToast("No se pudo descartar el registro", false);
      cargar();
    } else {
      showToast("Registro de combustible descartado");
    }
  }

  async function marcarAlertaLeida(id: string) {
    setAlertas((prev) => prev.map((a) => (a.id === id ? { ...a, leida: true } : a)));
    const { error } = await supabase.from("radar_alertas").update({ leida: true }).eq("id", id);
    if (error) {
      console.warn("radar-ia: error marcando alerta", error);
      showToast("No se pudo marcar la alerta", false);
    }
  }

  async function marcarTodasLeidas() {
    setAlertas((prev) => prev.map((a) => ({ ...a, leida: true })));
    const { error } = await supabase.from("radar_alertas").update({ leida: true }).eq("leida", false);
    if (error) {
      console.warn("radar-ia: error marcando alertas", error);
      showToast("No se pudieron marcar las alertas", false);
      cargar();
    } else {
      showToast("Todas las alertas quedaron leídas");
    }
  }

  async function toggleGrupo(g: RadarGrupo) {
    const nuevo = !g.activo;
    setGrupos((prev) => prev.map((x) => (x.id === g.id ? { ...x, activo: nuevo } : x)));
    const { error } = await supabase.from("radar_grupos").update({ activo: nuevo }).eq("id", g.id);
    if (error) {
      console.warn("radar-ia: error actualizando grupo", error);
      setGrupos((prev) => prev.map((x) => (x.id === g.id ? { ...x, activo: g.activo } : x)));
      showToast("No se pudo actualizar el grupo", false);
    } else {
      showToast(nuevo ? `Monitoreando «${g.nombre}»` : `«${g.nombre}» fuera del monitoreo`);
    }
  }

  async function guardarContextoGrupo(
    g: RadarGrupo,
    patch: { contexto: string | null; categorias_permitidas: CategoriaRadar[] | null }
  ) {
    const { error } = await supabase.from("radar_grupos").update(patch).eq("id", g.id);
    if (error) {
      console.warn("radar-ia: error guardando contexto de grupo", error);
      showToast("No se pudo guardar el contexto del grupo", false);
      return;
    }
    setGrupos((prev) => prev.map((x) => (x.id === g.id ? { ...x, ...patch } : x)));
    showToast(`Contexto de «${g.nombre}» guardado`);
  }

  async function guardarGuiaOdometro(v: VehiculoGuiaOdometro, guia: string | null) {
    const tabla = v.tipo === "tercero" ? "vehiculos_tercero" : "vehiculos";
    const { error } = await supabase.from(tabla).update({ guia_odometro: guia }).eq("id", v.id);
    if (error) {
      console.warn("radar-ia: error guardando guía de odómetro", error);
      showToast("No se pudo guardar la guía de odómetro", false);
      return;
    }
    setVehiculosGuia((prev) => prev.map((x) => (x.tipo === v.tipo && x.id === v.id ? { ...x, guia_odometro: guia } : x)));
    showToast(`Guía de ${v.placa} guardada`);
  }

  async function guardarConfig(cfg: RadarConfig) {
    setGuardandoConfig(true);
    const { error } = await supabase
      .from("radar_config")
      .update({
        activo: cfg.activo,
        horario_activo: cfg.horario_activo,
        hora_inicio: cfg.hora_inicio,
        hora_fin: cfg.hora_fin,
        categorias_activas: cfg.categorias_activas,
        acciones_automaticas: cfg.acciones_automaticas,
        palabras_clave: cfg.palabras_clave,
        umbral_confianza: cfg.umbral_confianza,
        modelo_extraccion: cfg.modelo_extraccion,
        notificar_email: cfg.notificar_email,
        correos_alerta: cfg.correos_alerta,
        limite_diario_usd: cfg.limite_diario_usd,
        guia_voucher: cfg.guia_voucher,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    setGuardandoConfig(false);
    if (error) {
      console.warn("radar-ia: error guardando config", error);
      showToast("No se pudo guardar la configuración", false);
    } else {
      setConfig(cfg);
      showToast("Configuración guardada");
    }
  }

  // ── KPIs para el grid ──
  const kpis: { label: string; value: string; icon: string; color: string; bg: string }[] = [
    { label: "Mensajes hoy",           value: String(mensajesHoy),           icon: "📨", color: "#0b315f", bg: "#E8F1FB" },
    { label: "Oportunidades abiertas", value: String(oppAbiertas.length),    icon: "💼", color: "#1d4ed8", bg: "#dbeafe" },
    { label: "Utilidad potencial",     value: fmtSoles(utilidadPotencial),   icon: "📈", color: "#27AE60", bg: "#E8F5EC" },
    { label: "Combustible hoy",        value: fmtSoles(combustibleHoy),      icon: "⛽", color: "#B07A0F", bg: "#FBF1D8" },
    { label: "Alertas sin leer",       value: String(alertasSinLeer),        icon: "🔔", color: alertasSinLeer > 0 ? "#EB5757" : "#5B6B82", bg: "#FDECEC" },
    { label: "Precisión ELIA",         value: precision,                     icon: "🎯", color: "#7c3aed", bg: "#ede9fe" },
    { label: "Gasto IA hoy",           value: `$ ${gastoHoy.toFixed(2)}`,    icon: "🪙", color: "#0f766e", bg: "#ccfbf1" },
  ];

  const contadorTab: Partial<Record<TabId, { n: number; color: string }>> = {
    oportunidades: { n: oppNuevas, color: "#1d4ed8" },
    combustible: { n: combPendientes, color: "#B07A0F" },
    alertas: { n: alertasSinLeer, color: "#EB5757" },
  };

  // ── Render ──
  return (
    <div className="min-h-screen bg-[#eef3f8]">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* Toast */}
        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white transition-all ${toast.ok ? "bg-[#0b315f]" : "bg-red-600"}`}>
            {toast.msg}
          </div>
        )}

        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-[#0b315f] leading-none">Radar IA</h1>
            <p className="text-sm text-gray-400 mt-1 font-medium">WhatsApp → ELIA → ERP</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 bg-white border border-gray-100 shadow-sm rounded-xl px-3 py-2">
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: conexion.dot }} />
              <div>
                <p className="text-xs font-black leading-tight" style={{ color: conexion.color }}>{conexion.texto}</p>
                {conexion.sub && <p className="text-[10px] text-gray-400 font-semibold leading-tight">{conexion.sub}</p>}
              </div>
            </div>
            {estado && estado.estado !== "esperando_qr" && (
              <button
                onClick={solicitarNuevoQr}
                disabled={solicitandoQr}
                title="Cierra la sesión de WhatsApp actual y pide vincular un número (el mismo u otro) escaneando un QR nuevo"
                className="flex items-center gap-1.5 bg-white border border-gray-100 shadow-sm rounded-xl px-3 py-2 text-xs font-bold text-gray-600 hover:border-gray-300 transition-colors disabled:opacity-50"
              >
                <Ic.QrCode size={14} /> {solicitandoQr ? "Solicitando…" : "Generar QR nuevo"}
              </button>
            )}
            <div className="flex items-center gap-2.5 bg-white border border-gray-100 shadow-sm rounded-xl px-3.5 py-2">
              <span className="text-xs font-black text-[#0b315f]">Radar activo</span>
              <Switch grande on={Boolean(config?.activo)} onClick={toggleRadarActivo} disabled={!config} />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-3" />
            <p className="font-bold text-gray-500 text-sm">Cargando el Radar…</p>
          </div>
        ) : (
          <>
            {/* Vinculación / worker apagado */}
            {estado?.estado === "esperando_qr" && estado.qr_data_url && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 flex flex-col items-center text-center">
                <h2 className="font-black text-[#0b315f] text-lg mb-1">Vincula el WhatsApp del Radar</h2>
                <p className="text-sm text-gray-500 max-w-md mb-4">
                  En el teléfono del número DEDICADO: WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo → escanea este código. Solo se hace una vez.
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={estado.qr_data_url} alt="Código QR para vincular el WhatsApp del Radar" className="w-64 h-64 rounded-xl border border-gray-100" />
              </div>
            )}
            {estado?.estado === "desconectado" && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex items-start gap-3">
                <span className="text-2xl">🔌</span>
                <div>
                  <p className="font-black text-[#0b315f] text-sm">Worker desconectado</p>
                  <p className="text-sm text-gray-500 mt-1">
                    El worker de WhatsApp está apagado o sin conexión{estado.detalle ? ` (${estado.detalle})` : ""}. Enciéndelo en el servidor — instrucciones en <span className="font-mono text-xs">radar-worker/README.md</span>.
                  </p>
                </div>
              </div>
            )}

            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
              {kpis.map((kpi) => (
                <div key={kpi.label} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm mb-2" style={{ background: kpi.bg }}>{kpi.icon}</div>
                  <div className="font-black text-xl leading-none" style={{ color: kpi.color }}>{kpi.value}</div>
                  <div className="text-[11px] text-gray-400 font-semibold mt-1 leading-tight">{kpi.label}</div>
                </div>
              ))}
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-gray-50 rounded-xl p-1 flex-wrap w-fit max-w-full">
              {TABS.map((t) => {
                const cont = contadorTab[t.id];
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center ${tab === t.id ? "bg-white shadow-sm text-[#0b315f]" : "text-gray-400 hover:text-gray-600"}`}
                  >
                    {t.label}
                    {cont && cont.n > 0 && (
                      <span
                        className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black text-white"
                        style={{ background: cont.color }}
                      >
                        {cont.n}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Contenido del tab activo */}
            {tab === "feed" && (
              <TabFeed
                mensajes={mensajes}
                reprocesando={reprocesando}
                onFeedback={marcarFeedback}
                onReprocesar={reprocesarMensaje}
              />
            )}
            {tab === "oportunidades" && (
              <TabOportunidades
                oportunidades={oportunidades}
                creando={creandoCot}
                onCrearCotizacion={crearCotizacion}
                onCambiarEstado={cambiarEstadoOportunidad}
              />
            )}
            {tab === "combustible" && (
              <TabCombustible
                registros={combustibles}
                vehiculos={vehiculos}
                registrando={registrandoComb}
                onRegistrar={registrarCombustible}
                onDescartar={descartarCombustible}
              />
            )}
            {tab === "alertas" && (
              <TabAlertas alertas={alertas} onMarcarLeida={marcarAlertaLeida} onMarcarTodas={marcarTodasLeidas} />
            )}
            {tab === "grupos" && <TabGrupos grupos={grupos} onToggle={toggleGrupo} onGuardarContexto={guardarContextoGrupo} />}
            {tab === "configuracion" && (
              config ? (
                <TabConfiguracion
                  config={config}
                  guardando={guardandoConfig}
                  onGuardar={guardarConfig}
                  vehiculosGuia={vehiculosGuia}
                  onGuardarGuiaOdometro={guardarGuiaOdometro}
                />
              ) : (
                <CardVacia emoji="⚙️" titulo="Sin configuración" detalle="Corre supabase/radar-ia.sql en el editor SQL de Supabase para crear la fila de configuración." />
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}
