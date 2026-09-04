// app/radar-ia/page.tsx — Dashboard del Radar IA: WhatsApp → ELIA → ERP.
// Feed de mensajes clasificados, oportunidades comerciales, combustible, alertas,
// grupos monitoreados y configuración del pipeline. Lee/edita las tablas radar_*
// (supabase/radar-ia.sql). Módulo independiente del CRM/Meta oficial.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { aceptarLectura } from "@/lib/odometro";
import AnularLecturaOdometro from "@/components/AnularLecturaOdometro";
import { normalizarConfigRadar } from "@/lib/radar/config";
import { COMBUSTIBLES, TIPOS_COMBUSTIBLE, normalizarTipoCombustible } from "@/lib/combustibles";
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
  tipo_combustible_sin_leer: "Combustible sin leer",
  tipo_combustible_inferido: "Combustible deducido",
  tipo_combustible_dudoso:   "Combustible no cuadra con el precio",
};

const TABS = [
  { id: "feed",          label: "Feed" },
  { id: "oportunidades", label: "Oportunidades" },
  { id: "combustible",   label: "Combustible" },
  { id: "odometro",      label: "Odómetro" },
  { id: "alertas",       label: "Alertas" },
  { id: "grupos",        label: "Grupos" },
  { id: "configuracion", label: "Configuración" },
] as const;
type TabId = (typeof TABS)[number]["id"];

type VehiculoLite = { id: number; placa: string; categoria: string | null; estado: string | null };

type VehiculoGuiaOdometro = { tipo: "propio" | "tercero"; id: number; placa: string; categoria: string | null; guia_odometro: string | null };

// Lectura de odómetro que el Radar registró en lecturas_odometro (ref_origen='radar_ia').
type RadarLecturaOdometro = {
  id: string;
  vehiculo_id: number | null;
  vehiculo_tercero_id: number | null;
  km: number;
  fuente: string;
  fecha: string | null;
  foto_url: string | null;
  estado: "aceptada" | "sospechosa" | "rechazada" | "reinicio" | "anulada";
  momento: string | null;
  motivo: string | null;
  created_at: string;
};

const ESTADO_ODO_CFG: Record<RadarLecturaOdometro["estado"], { label: string; color: string; bg: string }> = {
  aceptada:   { label: "Registrada",  color: "#27AE60", bg: "#E8F5EC" },
  sospechosa: { label: "Por revisar", color: "#B07A0F", bg: "#FBF1D8" },
  rechazada:  { label: "Rechazada",   color: "#EB5757", bg: "#FDECEC" },
  reinicio:   { label: "Reinicio",    color: "#1d4ed8", bg: "#dbeafe" },
  anulada:    { label: "Anulada",     color: "#64748b", bg: "#f1f5f9" },
};

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
  Servidor: ({ size = 16, className = "" }: IcProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" />
      <path d="M6 7h.01" /><path d="M6 17h.01" />
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
  const [msgsCategoria, setMsgsCategoria] = useState<RadarMensaje[] | null>(null);
  const [cargandoCat, setCargandoCat] = useState(false);

  // El feed general solo trae los 150 mensajes más recientes; con el volumen de los grupos,
  // los mensajes de categorías poco frecuentes (odómetro, combustible…) quedan fuera de esa
  // ventana en horas. Cuando se filtra por una categoría específica, se traen ESOS mensajes
  // del servidor para que siempre aparezcan, sin importar cuánto tráfico nuevo haya después.
  // Se refresca al cambiar de filtro y cuando llega un mensaje nuevo (id más reciente del feed).
  const idMasReciente = mensajes[0]?.id;
  useEffect(() => {
    if (filtroCat === "todas") { setMsgsCategoria(null); return; }
    let cancelado = false;
    setCargandoCat(true);
    supabase
      .from("radar_mensajes")
      .select("*")
      .eq("categoria", filtroCat)
      .order("recibido_en", { ascending: false })
      .limit(150)
      .then(({ data }: { data: RadarMensaje[] | null }) => {
        if (cancelado) return;
        setMsgsCategoria((data ?? []) as RadarMensaje[]);
        setCargandoCat(false);
      });
    return () => { cancelado = true; };
  }, [filtroCat, idMasReciente]);

  const base = filtroCat === "todas" ? mensajes : (msgsCategoria ?? []);
  const filtrados = base.filter((m) => {
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
      {cargandoCat && filtroCat !== "todas" && !msgsCategoria ? (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 text-center">
          <div className="w-6 h-6 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-3" />
          <p className="font-bold text-gray-500 text-sm">Buscando mensajes de {CATEGORIAS_RADAR[filtroCat].label}…</p>
        </div>
      ) : filtrados.length === 0 ? (
        <CardVacia
          emoji="📭"
          titulo="Sin mensajes con ese filtro"
          detalle={filtroCat === "todas"
            ? "Los mensajes de los grupos activos aparecen aquí en tiempo real."
            : `No hay mensajes de ${CATEGORIAS_RADAR[filtroCat].label}${busqueda.trim() ? " que coincidan con la búsqueda" : " todavía"}.`}
        />
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

// Valores editables por el revisor antes de registrar una recarga. Se inicializan con lo
// que extrajo la IA; cada campo que cambie se guarda como lección en radar_combustible_correcciones.
type EdicionComb = {
  vehiculo: string;   // fleet-encoded: "propio:12" | "tercero:5" | ""
  fecha: string;      // YYYY-MM-DD
  grifo: string;
  combustible: string; // tipo canónico (diesel|glp|gnv|…), "" si la IA no lo leyó
  cantidad: string;   // galones o litros (según esLitros)
  precio: string;     // precio unitario (por galón/litro)
  monto: string;      // monto total
};

export type OverrideComb = {
  tipo: "propio" | "tercero";
  vehiculoId: number;
  fecha: string | null;
  grifo: string | null;
  /** Tipo de combustible con el que se registra. Obligatorio: nunca se asume diésel. */
  tipoCombustible: string;
  cantidad: number | null;
  esLitros: boolean;
  precio: number | null;
  monto: number | null;
};

// Chip del tipo de combustible de una recarga del Radar. Sin dato NO dice "Diésel": dice
// que no se leyó, en ámbar. Un chip azul de diésel puesto por defecto es exactamente el
// error que hacía invisible el problema — el ERP registraba diésel y la pantalla lo
// confirmaba, aunque el voucher fuera de GLP.
function ChipCombustible({ tipo, registrado }: { tipo: string | null; registrado: boolean }) {
  const canon = normalizarTipoCombustible(tipo);
  const cfg = canon ? COMBUSTIBLES[canon] : null;
  if (!cfg) {
    // Sin nada, y "algo que no se reconoce" son dos cosas distintas: en el segundo caso se
    // muestra el texto crudo tal cual, porque esconderlo detrás de "sin leer" impediría
    // ver que el voucher decía algo (y qué decía) que el catálogo no sabe traducir.
    const crudo = (tipo ?? "").trim();
    return (
      <span
        className="text-[10px] font-black px-2 py-0.5 rounded-full bg-[#FBF1D8] text-[#B07A0F] whitespace-nowrap"
        title={
          crudo
            ? `El voucher decía "${crudo}", que no corresponde a ningún combustible del catálogo.${registrado ? " Verifica esta carga en /combustible." : " Elige el tipo al revisar, antes de registrar."}`
            : registrado
              ? "La IA no leyó el tipo de combustible. Las recargas registradas antes de esta corrección entraron a /combustible como Diésel por defecto — verifica esta en /combustible."
              : "La IA no leyó el tipo de combustible: elígelo al revisar, antes de registrar."
        }
      >
        ⚠ {crudo ? `${crudo.slice(0, 14)} · sin reconocer` : "Sin leer"}
      </span>
    );
  }
  return (
    <span
      className="text-[10px] font-black px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: cfg.bg, color: cfg.color }}
      title={`Se registra como ${cfg.label}`}
    >
      {cfg.icon} {cfg.label}
    </span>
  );
}

function TabCombustible({ registros, vehiculosGuia, mensajesPorId, registrando, onRegistrar, onDescartar }: {
  registros: RadarCombustible[];
  vehiculosGuia: VehiculoGuiaOdometro[];
  mensajesPorId: Record<string, RadarMensaje>;
  registrando: string | null;
  onRegistrar: (c: RadarCombustible, ov: OverrideComb) => void;
  onDescartar: (id: string) => void;
}) {
  const [expandido, setExpandido] = useState<string | null>(null);
  const [edic, setEdic] = useState<Record<string, EdicionComb>>({});

  if (registros.length === 0) {
    return <CardVacia emoji="⛽" titulo="Sin recargas detectadas" detalle="Los vouchers de combustible que lleguen a los grupos aparecen aquí." />;
  }

  // Unidad de una recarga: por la FK que dejó el motor o, si no la trae, por la PLACA que leyó
  // la IA cruzada contra la flota (comparando solo alfanumérico, como matchVehiculo del motor).
  // El respaldo por placa es lo que rescata las filas capturadas antes de que el motor guardara
  // `vehiculo_tercero_id`: la IA ya había leído la placa, así que no hay nada que re-teclear.
  const placaNorm = (s?: string | null) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const unidadDe = (c: RadarCombustible): VehiculoGuiaOdometro | null => {
    if (c.vehiculo_id != null)
      return vehiculosGuia.find((v) => v.tipo === "propio" && v.id === c.vehiculo_id) ?? null;
    if (c.vehiculo_tercero_id != null)
      return vehiculosGuia.find((v) => v.tipo === "tercero" && v.id === c.vehiculo_tercero_id) ?? null;
    const p = placaNorm(c.placa);
    return p ? vehiculosGuia.find((v) => placaNorm(v.placa) === p) ?? null : null;
  };

  // Fotos que la IA procesó: las guardadas en la fila, o (filas viejas) la del mensaje origen.
  const fotosDe = (c: RadarCombustible): { url: string; nombre: string | null }[] => {
    const propias = (c.fotos ?? []).filter((f) => f?.url).map((f) => ({ url: f.url, nombre: f.nombre ?? null }));
    if (propias.length) return propias;
    const m = c.mensaje_id ? mensajesPorId[c.mensaje_id] : null;
    return m?.media_url ? [{ url: m.media_url, nombre: m.media_nombre ?? null }] : [];
  };

  // Estado de edición de una fila (perezoso: se crea al expandir con lo que dejó la IA).
  const edicionDe = (c: RadarCombustible): EdicionComb => {
    if (edic[c.id]) return edic[c.id];
    const esLitros = c.litros != null && c.galones == null;
    const u = unidadDe(c);
    return {
      vehiculo: u ? `${u.tipo}:${u.id}` : "",
      fecha: c.fecha ?? "",
      grifo: c.grifo ?? "",
      // Vacío a propósito cuando la IA no lo leyó: obliga a elegirlo en vez de colar diésel.
      combustible: normalizarTipoCombustible(c.tipo_combustible) ?? "",
      cantidad: esLitros ? (c.litros != null ? String(c.litros) : "") : (c.galones != null ? String(c.galones) : ""),
      precio: (esLitros ? c.precio_litro : c.precio_galon) != null ? String(esLitros ? c.precio_litro : c.precio_galon) : "",
      monto: c.monto_total != null ? String(c.monto_total) : "",
    };
  };
  const setCampo = (c: RadarCombustible, campo: keyof EdicionComb, valor: string) =>
    setEdic((prev) => ({ ...prev, [c.id]: { ...edicionDe(c), [campo]: valor } }));

  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Fecha", "Unidad", "Grifo", "Combustible", "Cantidad", "Precio", "Monto", "Anomalías", "Estado"].map((h) => (
                <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {registros.map((c) => {
              const est = ESTADO_COMB_CFG[c.estado];
              const abierto = expandido === c.id;
              const esPendiente = c.estado === "pendiente_revision";
              const unidad = unidadDe(c);
              const placaMatch = unidad?.placa ?? null;
              const esTercero = unidad?.tipo === "tercero";
              const cantidad = c.galones != null ? `${c.galones} gal` : c.litros != null ? `${c.litros} lt` : "—";
              const precio = c.precio_galon != null ? `${fmtSoles(c.precio_galon)}/gal` : c.precio_litro != null ? `${fmtSoles(c.precio_litro)}/lt` : "—";
              // Edición del revisor (perezosa) — solo se usa en el bloque expandido.
              const ed = edicionDe(c);
              const esLitros = c.litros != null && c.galones == null;
              const numEd = (s: string) => { const n = Number((s ?? "").replace(",", ".")); return isFinite(n) && n > 0 ? n : null; };
              const cantEd = numEd(ed.cantidad);
              const precioEd = numEd(ed.precio);
              const montoEd = numEd(ed.monto);
              const fotos = fotosDe(c);
              const puedeRegistrar = ed.vehiculo !== "" && ed.combustible !== "" && cantEd != null && (precioEd != null || montoEd != null);
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
                      {esTercero && <span className="ml-1.5 text-[10px] font-black text-[#7c3aed] bg-[#f3e8ff] px-1.5 py-0.5 rounded-full">tercero</span>}
                    </td>
                    <td className="p-3 text-gray-600 max-w-[180px] truncate">{c.grifo ?? "—"}</td>
                    <td className="p-3 whitespace-nowrap"><ChipCombustible tipo={c.tipo_combustible} registrado={c.estado === "registrado"} /></td>
                    <td className="p-3 whitespace-nowrap font-bold text-gray-700">{cantidad}</td>
                    <td className="p-3 whitespace-nowrap text-gray-600">{precio}</td>
                    <td className="p-3 whitespace-nowrap font-black text-[#0b315f]">{c.monto_total != null ? fmtSoles(c.monto_total) : "—"}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
                        {/* Las observaciones informativas (bloquea:false) van en ámbar, no en
                            rojo: no impiden registrar, y un rojo que no se puede atender
                            enseña a ignorar los rojos de verdad. */}
                        {(c.anomalias ?? []).map((a, i) => (
                          <span
                            key={i}
                            className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${a.bloquea === false ? "bg-[#FBF1D8] text-[#B07A0F]" : "bg-[#FDECEC] text-[#EB5757]"}`}
                            title={a.detalle}
                          >
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
                      <td colSpan={9} className="p-4 bg-blue-50/40" onClick={(e) => e.stopPropagation()}>
                        {/* Fotos que la IA procesó (voucher / surtidor / tablero) */}
                        {fotos.length > 0 ? (
                          <div className="mb-4">
                            <p className="text-[11px] font-black text-gray-400 uppercase tracking-wide mb-2">
                              {fotos.length === 1 ? "Foto procesada por la IA" : `${fotos.length} fotos procesadas por la IA`}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {fotos.map((f, i) => (
                                <a key={i} href={f.url} target="_blank" rel="noreferrer" title={f.nombre ?? "Abrir foto"} className="block">
                                  <img src={f.url} alt={f.nombre ?? `Foto ${i + 1}`} className="h-28 w-28 object-cover rounded-xl border border-gray-200 hover:ring-2 hover:ring-[#1262bd] transition" />
                                </a>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-[11px] text-gray-400 font-semibold mb-4">Sin foto disponible para esta recarga.</p>
                        )}

                        {/* Edición de los campos extraídos — corrige lo que la IA leyó mal */}
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
                          <CampoEdit label="Fecha">
                            <input type="date" value={ed.fecha} onChange={(e) => setCampo(c, "fecha", e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-[#0b315f] outline-none focus:border-[#0b315f] bg-white" />
                          </CampoEdit>
                          <CampoEdit label="Unidad">
                            <select value={ed.vehiculo} onChange={(e) => setCampo(c, "vehiculo", e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] bg-white">
                              <option value="">— Elegir —</option>
                              <optgroup label="Flota propia">
                                {vehiculosGuia.filter((v) => v.tipo === "propio").map((v) => (
                                  <option key={`p${v.id}`} value={`propio:${v.id}`}>{v.placa}{v.categoria ? ` · ${v.categoria}` : ""}</option>
                                ))}
                              </optgroup>
                              <optgroup label="Tercerizadas">
                                {vehiculosGuia.filter((v) => v.tipo === "tercero").map((v) => (
                                  <option key={`t${v.id}`} value={`tercero:${v.id}`}>{v.placa}{v.categoria ? ` · ${v.categoria}` : ""}</option>
                                ))}
                              </optgroup>
                            </select>
                          </CampoEdit>
                          <CampoEdit label="Grifo">
                            <input type="text" value={ed.grifo} onChange={(e) => setCampo(c, "grifo", e.target.value)} placeholder="—" className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-[#0b315f] outline-none focus:border-[#0b315f] bg-white" />
                          </CampoEdit>
                          <CampoEdit label="Combustible">
                            {/* Sin opción "por defecto": si la IA no lo leyó hay que elegirlo.
                                Registrar GLP como diésel arruina el km/gal de la unidad y su
                                costo por km, y no se nota hasta meses después. */}
                            <select
                              value={ed.combustible}
                              onChange={(e) => setCampo(c, "combustible", e.target.value)}
                              className={`w-full border rounded-lg px-2 py-1.5 text-sm font-bold outline-none focus:border-[#0b315f] bg-white ${ed.combustible ? "border-gray-200 text-[#0b315f]" : "border-[#B07A0F] text-[#B07A0F]"}`}
                            >
                              <option value="">— Elegir —</option>
                              {TIPOS_COMBUSTIBLE.map((t) => (
                                <option key={t} value={t}>{COMBUSTIBLES[t].icon} {COMBUSTIBLES[t].label}</option>
                              ))}
                            </select>
                          </CampoEdit>
                          <CampoEdit label={esLitros ? "Cantidad (lt)" : "Cantidad (gal)"}>
                            <input type="number" inputMode="decimal" step="0.001" value={ed.cantidad} onChange={(e) => setCampo(c, "cantidad", e.target.value)} placeholder="—" className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] bg-white" />
                          </CampoEdit>
                          <CampoEdit label={esLitros ? "Precio/lt" : "Precio/gal"}>
                            <input type="number" inputMode="decimal" step="0.01" value={ed.precio} onChange={(e) => setCampo(c, "precio", e.target.value)} placeholder="—" className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-[#0b315f] outline-none focus:border-[#0b315f] bg-white" />
                          </CampoEdit>
                          <CampoEdit label="Monto total">
                            <input type="number" inputMode="decimal" step="0.01" value={ed.monto} onChange={(e) => setCampo(c, "monto", e.target.value)} placeholder="—" className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-[#0b315f] outline-none focus:border-[#0b315f] bg-white" />
                          </CampoEdit>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 mt-3">
                          {c.conductor && <p className="text-xs text-gray-500 font-semibold">Conductor: <span className="font-bold text-gray-700">{c.conductor}</span></p>}
                          {c.comprobante && <p className="text-xs text-gray-500 font-semibold">Comprobante: <span className="font-mono">{c.comprobante}</span></p>}
                          <div className="flex items-center gap-2 ml-auto">
                            <button
                              onClick={() => onRegistrar(c, {
                                tipo: (ed.vehiculo.split(":")[0] as "propio" | "tercero"),
                                vehiculoId: Number(ed.vehiculo.split(":")[1]),
                                fecha: ed.fecha || null,
                                grifo: ed.grifo.trim() || null,
                                tipoCombustible: ed.combustible,
                                cantidad: cantEd,
                                esLitros,
                                precio: precioEd,
                                monto: montoEd,
                              })}
                              disabled={!puedeRegistrar || registrando === c.id}
                              className="px-3 py-2 rounded-xl text-xs font-bold bg-[#0b315f] text-white hover:bg-[#1262bd] transition-colors disabled:opacity-40"
                            >
                              {registrando === c.id ? "Registrando…" : "Registrar en Combustible"}
                            </button>
                            <button
                              onClick={() => onDescartar(c.id)}
                              className="px-3 py-2 rounded-xl text-xs font-bold text-[#EB5757] hover:bg-[#FDECEC] transition-colors"
                            >
                              Descartar
                            </button>
                          </div>
                        </div>
                        {!puedeRegistrar && (
                          <p className="text-[11px] text-[#B07A0F] font-bold mt-2">
                            Para registrar se necesita unidad, tipo de combustible, galones o litros, y precio o monto total.
                          </p>
                        )}
                        <p className="text-[11px] text-gray-400 mt-1">Si corriges lo que la IA leyó, se guarda como lección para que no repita el error.</p>
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

// Campo etiquetado del formulario de edición de una recarga.
function CampoEdit({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-black text-gray-400 uppercase tracking-wide mb-1">{label}</label>
      {children}
    </div>
  );
}

// ── Tab: Odómetro ────────────────────────────────────────────────────────────
// Muestra las lecturas de odómetro que el Radar registró (lecturas_odometro con
// ref_origen='radar_ia'), de ambas flotas. La fuente de verdad y el flujo de
// aceptar/rechazar viven en /mantenimiento > Odómetro; aquí es solo la vista del Radar.

function TabOdometro({ registros, vehiculosGuia, onRefresh, showToast }: {
  registros: RadarLecturaOdometro[];
  vehiculosGuia: VehiculoGuiaOdometro[];
  onRefresh: () => void | Promise<void>;
  showToast: (msg: string, ok?: boolean) => void;
}) {
  const [foto, setFoto] = useState<string | null>(null);
  const [aceptando, setAceptando] = useState<string | null>(null);
  const [corrigiendo, setCorrigiendo] = useState<RadarLecturaOdometro | null>(null);

  if (registros.length === 0) {
    return <CardVacia emoji="🛞" titulo="Sin lecturas de odómetro" detalle="Las fotos de tablero que lleguen a los grupos y el Radar logre registrar aparecen aquí." />;
  }

  const unidadDe = (r: RadarLecturaOdometro): { placa: string | null; flota: "propio" | "tercero" | null } => {
    if (r.vehiculo_id != null) {
      const v = vehiculosGuia.find((x) => x.tipo === "propio" && x.id === r.vehiculo_id);
      return { placa: v?.placa ?? null, flota: "propio" };
    }
    if (r.vehiculo_tercero_id != null) {
      const v = vehiculosGuia.find((x) => x.tipo === "tercero" && x.id === r.vehiculo_tercero_id);
      return { placa: v?.placa ?? null, flota: "tercero" };
    }
    return { placa: null, flota: null };
  };

  // Aceptar el proceso: valida la lectura "por revisar" y actualiza el km vigente.
  const aceptar = async (r: RadarLecturaOdometro) => {
    setAceptando(r.id);
    try {
      const res = await aceptarLectura(supabase, r.id);
      if (!res.ok) throw new Error(res.error || "No se pudo aceptar");
      showToast("Lectura aceptada ✓");
      await onRefresh();
    } catch (e: any) {
      showToast("Error: " + e.message, false);
    } finally {
      setAceptando(null);
    }
  };

  return (
    <>
      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Fecha", "Unidad", "Kilometraje", "Foto", "Estado", ""].map((h, i) => (
                  <th key={i} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {registros.map((r) => {
                const est = ESTADO_ODO_CFG[r.estado] ?? ESTADO_ODO_CFG.sospechosa;
                const { placa, flota } = unidadDe(r);
                return (
                  <tr key={r.id} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
                    <td className="p-3 whitespace-nowrap text-gray-600">{r.fecha ? fmtFecha(r.fecha) : "—"}</td>
                    <td className="p-3 whitespace-nowrap">
                      <span className="font-mono font-black text-[#0b315f]">{placa ?? "—"}</span>
                      {flota === "tercero" && <span className="ml-1.5 text-[10px] font-black px-1.5 py-0.5 rounded-full" style={{ color: "#B07A0F", background: "#FBF1D8" }}>Tercero</span>}
                    </td>
                    <td className="p-3 whitespace-nowrap font-black text-[#0b315f]">{r.km.toLocaleString("es-PE")} km</td>
                    <td className="p-3">
                      {r.foto_url ? (
                        <button onClick={() => setFoto(r.foto_url)} className="text-[#1262bd] hover:underline text-xs font-bold inline-flex items-center gap-1">
                          <Ic.Externo size={12} /> Ver foto
                        </button>
                      ) : <span className="text-xs text-gray-300">—</span>}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <ChipEstado {...est} />
                        {r.motivo && <span className="text-[11px] text-gray-400" title={r.motivo}>ⓘ</span>}
                      </div>
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        {r.estado === "sospechosa" && (
                          <button onClick={() => aceptar(r)} disabled={aceptando === r.id}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-green-700 border border-green-200 hover:bg-green-50 disabled:opacity-50">
                            {aceptando === r.id ? "…" : "✓ Aceptar"}
                          </button>
                        )}
                        {r.estado !== "anulada" && (
                          <button onClick={() => setCorrigiendo(r)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-[#1262bd] border border-[#1262bd]/20 hover:bg-[#1262bd]/5"
                            title="Corregir el número y enseñarle a la IA su error">
                            ✏ Corregir a la IA
                          </button>
                        )}
                        <Link href="/mantenimiento?tab=odometro" className="text-[#1262bd] hover:underline text-xs font-bold inline-flex items-center gap-1">
                          <Ic.Externo size={12} /> Odómetro
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Visor de foto */}
      {foto && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setFoto(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={foto} alt="Foto del odómetro" className="max-h-[90vh] max-w-[90vw] rounded-xl" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {/* Corregir + enseñar a la IA (anula la mala, registra el km correcto) */}
      {corrigiendo && (
        <AnularLecturaOdometro
          lectura={{
            id: corrigiendo.id,
            km: corrigiendo.km,
            fecha: corrigiendo.fecha ?? "",
            fuente: corrigiendo.fuente,
            foto_url: corrigiendo.foto_url,
            estado: corrigiendo.estado,
          }}
          placa={unidadDe(corrigiendo).placa ?? "—"}
          onClose={() => setCorrigiendo(null)}
          onAnulada={async () => { showToast("Lectura corregida ✓"); await onRefresh(); }}
        />
      )}
    </>
  );
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

// ── Modal: el servidor que mantiene WhatsApp abierto ─────────────────────────
// Referencia siempre a mano para no tener que buscar en el repo qué es lo que
// sostiene la sesión de WhatsApp del Radar ni cómo levantarlo cuando se cae.
// El detalle largo vive en radar-worker/README.md; esto es el resumen operativo.

/**
 * Traduce el código de cierre que dejó el worker en `detalle` cuando significa
 * "WhatsApp ya no acepta estas credenciales". Son los casos en que reintentar no
 * sirve de nada: la única salida es borrar la sesión y escanear un QR nuevo.
 * El worker 1.1.0+ lo hace solo; en versiones anteriores el 403 (número bloqueado)
 * caía en el reintento genérico y el Radar se quedaba para siempre sin mostrar QR.
 */
function credencialesRechazadas(detalle: string | null | undefined): string | null {
  const codigo = detalle ? /código\s+(\d{3})/i.exec(detalle)?.[1] : null;
  switch (codigo) {
    case "403":
      return "WhatsApp bloqueó el número del Radar (403). Ese número no va a volver a conectar por más que se reintente: hay que vincular OTRO número dedicado con “Generar QR nuevo”.";
    case "401":
      return "La sesión se cerró desde el teléfono (401). Hay que volver a vincular con “Generar QR nuevo”.";
    case "405":
      return "WhatsApp rechazó las credenciales guardadas (405). Hay que volver a vincular con “Generar QR nuevo”.";
    case "411":
      return "El teléfono no tiene multi-dispositivo activo (411). Actualiza WhatsApp en el celular y vuelve a vincular.";
    default:
      return null;
  }
}

function Cmd({ children }: { children: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(children);
        setCopiado(true);
        setTimeout(() => setCopiado(false), 1500);
      }}
      title="Clic para copiar"
      className="w-full text-left font-mono text-[11px] bg-[#0b315f] text-white/90 rounded-lg px-3 py-2 hover:bg-[#123f77] transition-colors relative group"
    >
      <span className="whitespace-pre-wrap break-all">{children}</span>
      <span className="absolute right-2 top-1.5 text-[9px] font-sans font-bold text-white/50 group-hover:text-white/90">
        {copiado ? "copiado ✓" : "copiar"}
      </span>
    </button>
  );
}

function ModalServidor({ estado, onClose }: { estado: RadarEstado | null; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-black text-[#0b315f] leading-tight">El servidor del Radar</h2>
            <p className="text-sm text-gray-400 font-medium">Qué mantiene el WhatsApp abierto y cómo revivirlo</p>
          </div>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-600 text-2xl leading-none font-light">×</button>
        </div>

        <div className="bg-[#eef4fb] rounded-xl p-4 text-sm text-[#0b315f]">
          <p className="font-black">Es <span className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">radar-worker</span> corriendo 24/7 bajo <span className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">pm2</span>.</p>
          <p className="mt-1 text-[#0b315f]/70 font-medium">
            No es ningún servicio de terceros: es un proceso Node (Baileys) que corre en un servidor propio (ver &quot;Dónde vive&quot;).
            Es lo único que sostiene la sesión de WhatsApp — si se cae, el Radar deja de recibir mensajes de los grupos.
          </p>
        </div>

        <div>
          <p className="text-xs font-black text-gray-500 uppercase tracking-wide mb-2">Estado ahora</p>
          <div className="text-sm text-gray-600 space-y-1">
            <p><span className="font-bold text-[#0b315f]">Conexión:</span> {estado?.estado ?? "sin datos"}{estado?.detalle ? ` — ${estado.detalle}` : ""}</p>
            <p><span className="font-bold text-[#0b315f]">Último latido:</span> {estado?.ultimo_latido ? `${haceRelativo(estado.ultimo_latido)} (${new Date(estado.ultimo_latido).toLocaleString("es-PE")})` : "nunca"}</p>
            <p><span className="font-bold text-[#0b315f]">Versión del worker:</span> {estado?.version_worker ?? "sin datos"}{" "}
              <span className="text-xs text-gray-400">(el botón “Generar QR nuevo” necesita 1.1.0 o superior)</span>
            </p>
            <p className="text-xs text-gray-400">El latido lo escribe el worker en la tabla <span className="font-mono">radar_estado</span>. Si está viejo, el proceso no está corriendo o no llega a Supabase.</p>
          </div>
        </div>

        <div className="bg-[#FFF6E5] border border-[#B07A0F]/25 rounded-xl p-4">
          <p className="text-xs font-black text-[#8a5a00] uppercase tracking-wide mb-2">Cambiar de número (o si el QR no aparece)</p>
          <p className="text-sm text-[#8a5a00]/90 font-medium mb-2">
            Normalmente basta el botón <span className="font-black">“Generar QR nuevo”</span> de esta pantalla. Si el worker no lo
            atiende (versión vieja, o el proceso no está corriendo), se fuerza a mano: la sesión de WhatsApp es la carpeta{" "}
            <span className="font-mono text-xs">auth/</span>, y borrarla obliga a escanear un QR nuevo.
          </p>
          <Cmd>{`cd /root/radar-worker
pm2 stop radar-worker
rm -rf auth
pm2 restart radar-worker
pm2 logs radar-worker`}</Cmd>
          <ul className="text-xs text-[#8a5a00]/80 mt-2 space-y-1 list-disc pl-4">
            <li>El QR sale en <span className="font-mono">pm2 logs</span> y acá en pantalla. Escanearlo con el número NUEVO lo deja vinculado.</li>
            <li>Si WhatsApp bloqueó el número (código 403), ese número no vuelve: hay que usar OTRO chip dedicado.</li>
            <li>Para actualizar el código del worker: si la carpeta es un clon del repo, <span className="font-mono">git pull &amp;&amp; npm install</span> y reiniciar; si se copió a mano, volver a copiar <span className="font-mono">radar-worker/</span>.</li>
          </ul>
        </div>

        <div className="bg-[#f4f9f0] border border-[#27AE60]/20 rounded-xl p-4">
          <p className="text-xs font-black text-gray-500 uppercase tracking-wide mb-2">Dónde vive</p>
          <p className="text-sm text-gray-700">
            El servidor está en <span className="font-black">DigitalOcean</span> — droplet{" "}
            <span className="font-mono text-xs bg-white px-1.5 py-0.5 rounded border border-gray-200">ubuntu-s-1vcpu-512mb-10gb-tor1</span>{" "}
            (IP <span className="font-mono text-xs bg-white px-1.5 py-0.5 rounded border border-gray-200">167.99.182.128</span>), proyecto &quot;first-project&quot;.
          </p>
          <a
            href="https://cloud.digitalocean.com/login"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-[#1262bd] hover:underline"
          >
            <Ic.Externo size={13} /> Iniciar sesión en DigitalOcean
          </a>
          <p className="text-[11px] text-gray-400 mt-1">Para entrar a la consola/terminal del droplet: dentro de DigitalOcean → Droplets → el droplet de arriba → botón &quot;Console&quot; (no necesita SSH desde tu PC).</p>
        </div>

        <div>
          <p className="text-xs font-black text-gray-500 uppercase tracking-wide mb-2">Operarlo (en la máquina donde corre)</p>
          <div className="space-y-1.5">
            <Cmd>pm2 list</Cmd>
            <Cmd>pm2 logs radar-worker</Cmd>
            <Cmd>pm2 restart radar-worker</Cmd>
          </div>
        </div>

        <div>
          <p className="text-xs font-black text-gray-500 uppercase tracking-wide mb-2">Si nunca se instaló (o se cambió de máquina)</p>
          <Cmd>{`npm install -g pm2
cd radar-worker
npm install
pm2 start node_modules/tsx/dist/cli.mjs --name radar-worker -- src/index.ts
pm2 save`}</Cmd>
          <ul className="text-xs text-gray-500 mt-2 space-y-1 list-disc pl-4">
            <li>En Windows <span className="font-mono">pm2 start npm -- start</span> falla; por eso se apunta directo al CLI de <span className="font-mono">tsx</span>.</li>
            <li>Arranque automático: Windows → <span className="font-mono">npm i -g pm2-windows-startup &amp;&amp; pm2-startup install</span>. Linux/VPS → <span className="font-mono">pm2 startup</span>.</li>
            <li>La sesión de WhatsApp vive en <span className="font-mono">radar-worker/auth/</span>. Respaldar esa carpeta = mover el worker de máquina sin volver a escanear el QR. Nunca subirla a git.</li>
          </ul>
        </div>

        <div>
          <p className="text-xs font-black text-gray-500 uppercase tracking-wide mb-2">Si se cae</p>
          <ol className="text-sm text-gray-600 space-y-1 list-decimal pl-4">
            <li>Entrar a la máquina y correr <span className="font-mono text-xs">pm2 restart radar-worker</span>; revisar <span className="font-mono text-xs">pm2 logs</span>.</li>
            <li>Si pide vincular de nuevo, el QR aparece aquí mismo en esta pantalla (y en ASCII en la consola del worker).</li>
            <li>Si el QR no llega, revisar el <span className="font-mono text-xs">.env</span> del worker (Supabase, <span className="font-mono text-xs">ERP_URL</span>, <span className="font-mono text-xs">RADAR_WORKER_SECRET</span>).</li>
          </ol>
        </div>

        <p className="text-xs text-gray-400 border-t border-gray-100 pt-3">
          Detalle completo y solución de problemas: <span className="font-mono">radar-worker/README.md</span> (sección “Correr 24/7”) y <span className="font-mono">CLAUDE.md</span> § Radar IA.
        </p>
      </div>
    </div>
  );
}

// ── Tab: Grupos ──────────────────────────────────────────────────────────────

type PatchGrupo = { contexto: string | null; categorias_permitidas: CategoriaRadar[] | null };

/**
 * `visible` no existe en las filas anteriores a supabase/radar-ia-grupos-vigencia.sql.
 * `undefined` significa "no se sabe todavía", y hay que tratarlo como visible: dar por
 * perdido todo lo antiguo llenaría la lista de advertencias falsas el día del despliegue.
 */
const grupoVisible = (g: RadarGrupo) => g.visible !== false;

function TabGrupos({ grupos, estado, workerVivo, sincronizando, onToggle, onGuardarContexto, onSincronizar, onEliminar }: {
  grupos: RadarGrupo[];
  estado: RadarEstado | null;
  workerVivo: boolean;
  sincronizando: boolean;
  onToggle: (g: RadarGrupo) => void;
  onGuardarContexto: (g: RadarGrupo, patch: PatchGrupo) => Promise<void>;
  onSincronizar: () => void;
  onEliminar: (g: RadarGrupo) => void;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [ocultarPerdidos, setOcultarPerdidos] = useState(false);

  const perdidos = grupos.filter((g) => !grupoVisible(g));
  // Los peligrosos: siguen en "Monitorear" pero el número actual no es miembro, así que
  // aparentan vigilancia sin que pueda llegar un solo mensaje.
  const perdidosActivos = perdidos.filter((g) => g.activo);

  const filtrados = grupos.filter(
    (g) =>
      (!busqueda.trim() || norm(g.nombre).includes(norm(busqueda))) &&
      (!ocultarPerdidos || grupoVisible(g))
  );

  return (
    <div className="space-y-4">
      <div className="bg-[#E8F1FB] border border-[#2f8ee9]/30 rounded-2xl p-4 flex items-start gap-3">
        <span className="text-xl">ℹ️</span>
        <p className="text-sm text-[#0b315f] font-semibold">
          El Radar solo ve los grupos donde el número conectado{estado?.numero ? ` (${estado.numero})` : ""} es miembro.
          Si un grupo NO es de la operación de AFA (p.ej. una red de apoyo entre transportistas), abre la fila y cuéntale
          el contexto a ELIA para que no clasifique mal sus mensajes.
        </p>
      </div>

      {/* Cuándo se leyó esta lista de WhatsApp — y cómo forzar una lectura nueva. */}
      <div className="bg-white border border-gray-100 rounded-2xl p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm">
          <p className="font-black text-[#0b315f]">Lista leída de WhatsApp</p>
          <p className="text-gray-500 font-medium">
            {estado?.grupos_sincronizados_en
              ? `Última lectura correcta ${haceRelativo(estado.grupos_sincronizados_en)}.`
              : "Todavía no hay ninguna lectura registrada con este worker."}
            {!workerVivo && " El worker no responde: no se puede actualizar."}
          </p>
        </div>
        <button
          onClick={onSincronizar}
          disabled={sincronizando}
          title="Vuelve a preguntarle a WhatsApp en qué grupos está el número conectado"
          className="flex items-center gap-1.5 bg-white border border-gray-200 shadow-sm rounded-xl px-3 py-2 text-xs font-bold text-gray-600 hover:border-gray-300 transition-colors disabled:opacity-50"
        >
          <Ic.Refresh size={14} /> {sincronizando ? "Solicitando…" : "Actualizar lista"}
        </button>
      </div>

      {perdidos.length > 0 && (
        <div className={`rounded-2xl p-4 flex items-start gap-3 border ${perdidosActivos.length > 0 ? "bg-[#FDECEC] border-[#EB5757]/30" : "bg-[#FFF6E5] border-[#B07A0F]/25"}`}>
          <span className="text-xl">{perdidosActivos.length > 0 ? "⚠️" : "👻"}</span>
          <div className="text-sm">
            <p className={`font-black ${perdidosActivos.length > 0 ? "text-[#8f1f1f]" : "text-[#8a5a00]"}`}>
              {perdidos.length} grupo{perdidos.length === 1 ? "" : "s"} que el número conectado ya no ve
            </p>
            <p className={`font-medium mt-0.5 ${perdidosActivos.length > 0 ? "text-[#8f1f1f]/90" : "text-[#8a5a00]/90"}`}>
              Quedaron de un número anterior. No se borran solos: conservan el contexto que le escribiste a ELIA y los
              mensajes ya capturados.{" "}
              {perdidosActivos.length > 0 && (
                <strong>
                  {perdidosActivos.length} de ellos sigue{perdidosActivos.length === 1 ? "" : "n"} en “Monitorear”, así que
                  parece{perdidosActivos.length === 1 ? "" : "n"} vigilado{perdidosActivos.length === 1 ? "" : "s"} sin
                  serlo. Para recuperarlos, agrega el número nuevo a esos grupos de WhatsApp.
                </strong>
              )}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[220px]">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300"><Ic.Lupa size={15} /></span>
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar grupo…"
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#0b315f] transition-colors bg-white"
          />
        </div>
        {perdidos.length > 0 && (
          <label className="flex items-center gap-2 text-xs font-bold text-gray-500 cursor-pointer select-none">
            <input type="checkbox" checked={ocultarPerdidos} onChange={(e) => setOcultarPerdidos(e.target.checked)} />
            Ocultar los que ya no se ven
          </label>
        )}
      </div>

      {filtrados.length === 0 ? (
        <CardVacia emoji="👥" titulo="Aún no hay grupos" detalle="Conecta el worker y espera unos segundos." />
      ) : (
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Grupo", "Participantes", "ID de WhatsApp", "Monitorear", ""].map((h, i) => (
                    <th key={h || `col-${i}`} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtrados.map((g) => (
                  <FilaGrupo key={g.id} g={g} onToggle={onToggle} onGuardar={onGuardarContexto} onEliminar={onEliminar} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function FilaGrupo({ g, onToggle, onGuardar, onEliminar }: {
  g: RadarGrupo;
  onToggle: (g: RadarGrupo) => void;
  onGuardar: (g: RadarGrupo, patch: PatchGrupo) => Promise<void>;
  onEliminar: (g: RadarGrupo) => void;
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
  const visible = grupoVisible(g);

  return (
    <>
      <tr className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
        <td className="p-3">
          <button onClick={() => setAbierto((v) => !v)} className="flex items-center gap-2 font-bold text-left">
            <Ic.Chevron size={13} className={`text-gray-300 transition-transform flex-shrink-0 ${abierto ? "rotate-180" : ""}`} />
            <span className={visible ? "text-[#0b315f]" : "text-gray-400 line-through decoration-gray-300"}>
              {g.nombre || "(sin nombre)"}
            </span>
            {personalizado && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#2f8ee9] flex-shrink-0" title="Tiene contexto o categorías personalizadas" />
            )}
            {!visible && (
              <span
                title={
                  g.visto_en
                    ? `El número conectado no es miembro de este grupo. Visto por última vez ${haceRelativo(g.visto_en)}.`
                    : "El número conectado no es miembro de este grupo."
                }
                className={`px-2 py-0.5 rounded-full text-[10px] font-black whitespace-nowrap ${
                  g.activo ? "bg-[#FDECEC] text-[#8f1f1f]" : "bg-gray-100 text-gray-500"
                }`}
              >
                {g.activo ? "Activo pero sin acceso" : "Ya no se ve"}
              </span>
            )}
          </button>
        </td>
        <td className="p-3 text-gray-600">{g.participantes}</td>
        <td className="p-3 font-mono text-xs text-gray-400">{g.wa_group_id}</td>
        <td className="p-3"><Switch on={g.activo} onClick={() => onToggle(g)} /></td>
        <td className="p-3">
          {/* Solo para los heredados: un grupo vigente se deja de monitorear con el switch, no se borra. */}
          {!visible && (
            <button
              onClick={() => onEliminar(g)}
              title="Quitar este grupo de la lista (no borra los mensajes ya capturados)"
              className="text-[11px] font-bold text-gray-400 hover:text-[#EB5757] transition-colors whitespace-nowrap"
            >
              Quitar
            </button>
          )}
        </td>
      </tr>
      {abierto && (
        <tr className="bg-blue-50/30 border-t" style={{ borderColor: "#f1f5f9" }}>
          <td colSpan={5} className="p-4 space-y-3">
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
  const [odometros, setOdometros] = useState<RadarLecturaOdometro[]>([]);
  const [alertas, setAlertas] = useState<RadarAlerta[]>([]);
  const [vehiculos, setVehiculos] = useState<VehiculoLite[]>([]);
  const [vehiculosGuia, setVehiculosGuia] = useState<VehiculoGuiaOdometro[]>([]);

  const [tab, setTab] = useState<TabId>("feed");
  const [verServidor, setVerServidor] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [reprocesando, setReprocesando] = useState<string | null>(null);
  const [creandoCot, setCreandoCot] = useState<string | null>(null);
  const [registrandoComb, setRegistrandoComb] = useState<string | null>(null);
  const [guardandoConfig, setGuardandoConfig] = useState(false);
  const [solicitandoQr, setSolicitandoQr] = useState(false);
  const [sincronizandoGrupos, setSincronizandoGrupos] = useState(false);

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Carga de datos ──
  const cargar = useCallback(async () => {
    try {
      const [rEstado, rConfig, rGrupos, rMensajes, rOpps, rComb, rOdo, rAlertas, rVehiculos, rVehTercero] = await Promise.all([
        supabase.from("radar_estado").select("*").eq("id", 1).maybeSingle(),
        supabase.from("radar_config").select("*").eq("id", 1).maybeSingle(),
        supabase.from("radar_grupos").select("*").order("nombre"),
        supabase.from("radar_mensajes").select("*").order("recibido_en", { ascending: false }).limit(150),
        supabase.from("radar_oportunidades").select("*").order("created_at", { ascending: false }).limit(60),
        supabase.from("radar_combustible").select("*").order("created_at", { ascending: false }).limit(60),
        supabase.from("lecturas_odometro").select("*").eq("ref_origen", "radar_ia").order("created_at", { ascending: false }).limit(60),
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
      setOdometros(((rOdo.data ?? []) as RadarLecturaOdometro[]));
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
  const odoPorRevisar = odometros.filter((o) => o.estado === "sospechosa" || o.estado === "rechazada").length;

  const grupoPorMensaje = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of mensajes) if (m.grupo_nombre) map[m.id] = m.grupo_nombre;
    return map;
  }, [mensajes]);

  // Para el fallback de fotos en el panel de revisión de combustible (filas viejas sin `fotos`).
  const mensajesPorId = useMemo(() => {
    const map: Record<string, RadarMensaje> = {};
    for (const m of mensajes) map[m.id] = m;
    return map;
  }, [mensajes]);

  // ── Estado del worker ──
  // El latido lo escribe el proceso del servidor cada 60 s. Si está viejo, el worker NO
  // está corriendo: ni el QR que se vea en pantalla sirve (los códigos de WhatsApp caducan
  // en segundos) ni el botón "Generar QR nuevo" va a ser atendido por nadie.
  const latidoMs = estado?.ultimo_latido ? Date.now() - new Date(estado.ultimo_latido).getTime() : null;
  const workerVivo = latidoMs !== null && latidoMs < 3 * 60 * 1000;
  /** Desconexión que ningún reintento va a arreglar (la deja un worker anterior a 1.1.0). */
  const motivoRechazo = credencialesRechazadas(estado?.detalle);

  // ── Chip de conexión ──
  const conexion = (() => {
    if (!estado) return { dot: "#EB5757", color: "#EB5757", texto: "Sin estado", sub: "Corre supabase/radar-ia.sql" as string | null };
    if (estado.estado === "conectado") {
      if (!workerVivo) {
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
      return {
        dot: "#B07A0F", color: "#B07A0F", texto: "Esperando QR",
        sub: workerVivo ? "escanea el código para vincular" : "el worker no responde: el QR no sirve",
      };
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
    const aviso = estado?.estado === "conectado"
      ? `Esto va a desvincular el número que el Radar usa ahora mismo (${estado.numero ?? "sin número"}) y va a pedir escanear un QR nuevo. ¿Continuar?`
      : "Esto va a borrar las credenciales de WhatsApp guardadas en el servidor y va a pedir un QR nuevo, para vincular el mismo número u otro. ¿Continuar?";
    if (!window.confirm(aviso)) return;
    setSolicitandoQr(true);
    try {
      const { error } = await supabase.from("radar_estado").update({ solicitar_relink: true }).eq("id", 1);
      if (error) {
        console.warn("radar-ia: error solicitando QR nuevo", error);
        showToast("No se pudo solicitar el QR nuevo", false);
        return;
      }
      setEstado((prev) => (prev ? { ...prev, solicitar_relink: true } : prev));
      // La solicitud es solo una bandera en la BD: la atiende el worker. Si no está
      // corriendo, no la va a ver nadie — decirlo acá evita esperar un QR que no viene.
      showToast(
        workerVivo
          ? "Solicitado — el QR nuevo aparece acá en unos segundos"
          : "Solicitado, pero el worker no está respondiendo: enciéndelo y lo atiende al arrancar",
        workerVivo
      );
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

  // Registra la corrección del revisor (valor IA vs valor final) como lección de la IA. Best-effort.
  async function guardarCorreccionesCombustible(c: RadarCombustible, ov: OverrideComb, fotoUrl: string | null) {
    const iaCantidad = ov.esLitros ? c.litros : c.galones;
    const iaPrecio = ov.esLitros ? c.precio_litro : c.precio_galon;
    const distinto = (a: unknown, b: unknown) => {
      const na = a == null || a === "" ? null : a, nb = b == null || b === "" ? null : b;
      if (typeof na === "number" || typeof nb === "number") return Number(na) !== Number(nb);
      return String(na ?? "").trim().toLowerCase() !== String(nb ?? "").trim().toLowerCase();
    };
    const campos: { campo: string; ia: unknown; correcto: unknown }[] = [
      { campo: "fecha",  ia: c.fecha,   correcto: ov.fecha },
      { campo: "grifo",  ia: c.grifo,   correcto: ov.grifo },
      // También cuando la IA no leyó nada: "no leíste el tipo y era GLP" es justo la
      // lección que evita que el siguiente voucher del mismo grifo vuelva a salir en blanco.
      { campo: "tipo_combustible", ia: c.tipo_combustible, correcto: ov.tipoCombustible },
      { campo: ov.esLitros ? "litros" : "galones", ia: iaCantidad, correcto: ov.cantidad },
      { campo: "precio", ia: iaPrecio,  correcto: ov.precio },
      { campo: "monto",  ia: c.monto_total, correcto: ov.monto },
    ];
    const filas = campos
      .filter((x) => x.correcto != null && distinto(x.ia, x.correcto))
      .map((x) => ({
        radar_combustible_id: c.id,
        campo: x.campo,
        valor_ia: x.ia == null ? null : String(x.ia),
        valor_correcto: String(x.correcto),
        foto_url: fotoUrl,
      }));
    if (!filas.length) return;
    const { error } = await supabase.from("radar_combustible_correcciones").insert(filas);
    if (error) console.warn("radar-ia: no se pudieron guardar las correcciones de combustible", error);
  }

  async function registrarCombustible(c: RadarCombustible, ov: OverrideComb) {
    if (!ov.vehiculoId || !ov.cantidad) {
      showToast("Faltan datos para registrar la recarga", false);
      return;
    }
    // El tipo se exige aquí también, no solo en el botón: es el dato que antes se rellenaba
    // solo con "diesel" y contamina el km/gal, el control de precio y el costo por km.
    if (!ov.tipoCombustible) {
      showToast("Elige el tipo de combustible antes de registrar", false);
      return;
    }
    // Precio unitario: el editado, o derivado del monto entre la cantidad.
    const precio = ov.precio ?? (ov.monto != null && ov.cantidad ? Math.round((ov.monto / ov.cantidad) * 100) / 100 : null);
    if (!precio) {
      showToast("Ingresa el precio o el monto total", false);
      return;
    }
    setRegistrandoComb(c.id);
    try {
      const grupo = (c.mensaje_id && grupoPorMensaje[c.mensaje_id]) || "WhatsApp";
      const fotoUrl = (c.fotos?.[0]?.url) ?? (c.mensaje_id ? mensajesPorId[c.mensaje_id]?.media_url ?? null : null);
      // Guarda primero las correcciones (dataset de aprendizaje), sin frenar el registro.
      await guardarCorreccionesCombustible(c, ov, fotoUrl);

      const destino = ov.tipo === "tercero" ? { vehiculo_tercero_id: ov.vehiculoId } : { vehiculo_id: ov.vehiculoId };
      // OJO: nunca escribir `total` — es columna generada (galones × precio_galon)
      const { data, error } = await supabase
        .from("combustible")
        .insert({
          ...destino,
          fecha: ov.fecha ?? c.fecha ?? hoyISO(),
          kilometraje: c.kilometraje ?? 0,
          galones: ov.cantidad,
          precio_galon: precio,
          grifo: ov.grifo ?? c.grifo,
          conductor: c.conductor,
          observaciones: `Radar IA (manual${ov.tipo === "tercero" ? " · tercero" : ""}) · grupo ${grupo}`,
          tipo_combustible: ov.tipoCombustible,
          unidad: ov.esLitros ? "litros" : "galones",
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("no se pudo insertar en combustible");
      await supabase
        .from("radar_combustible")
        .update({
          estado: "registrado",
          combustible_id: (data as any).id,
          vehiculo_id: ov.tipo === "propio" ? ov.vehiculoId : null,
          vehiculo_tercero_id: ov.tipo === "tercero" ? ov.vehiculoId : null,
          // La fila del Radar guarda lo que REALMENTE se registró: si el revisor corrigió el
          // tipo, la columna "Combustible" tiene que mostrar el corregido, no lo que leyó la IA.
          tipo_combustible: ov.tipoCombustible,
        })
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

  /**
   * Pide al worker que vuelva a preguntarle a WhatsApp en qué grupos está el número.
   * Es una bandera en la BD, igual que el relink: si el worker no corre, no la atiende nadie.
   */
  async function solicitarSyncGrupos() {
    setSincronizandoGrupos(true);
    try {
      const { error } = await supabase.from("radar_estado").update({ solicitar_sync_grupos: true }).eq("id", 1);
      if (error) {
        console.warn("radar-ia: error solicitando sincronización de grupos", error);
        // El caso típico: falta correr supabase/radar-ia-grupos-vigencia.sql.
        showToast(
          error.message?.includes("solicitar_sync_grupos")
            ? "Falta correr supabase/radar-ia-grupos-vigencia.sql en Supabase"
            : "No se pudo pedir la actualización de la lista",
          false
        );
        return;
      }
      showToast(
        workerVivo
          ? "Solicitado — la lista se actualiza en unos segundos"
          : "Solicitado, pero el worker no responde: lo hará cuando arranque",
        workerVivo
      );
    } finally {
      setSincronizandoGrupos(false);
    }
  }

  /** Quita de la lista un grupo que el número actual ya no ve. Los mensajes ya capturados quedan. */
  async function eliminarGrupo(g: RadarGrupo) {
    if (!window.confirm(`¿Quitar «${g.nombre || g.wa_group_id}» de la lista?\n\nSolo desaparece de esta pantalla. Los mensajes que ya se capturaron de ese grupo NO se borran. Si el número vuelve a entrar al grupo, reaparece solo.`)) {
      return;
    }
    const { error } = await supabase.from("radar_grupos").delete().eq("id", g.id);
    if (error) {
      console.warn("radar-ia: error eliminando grupo", error);
      showToast("No se pudo quitar el grupo", false);
      return;
    }
    setGrupos((prev) => prev.filter((x) => x.id !== g.id));
    showToast(`«${g.nombre || g.wa_group_id}» quitado de la lista`);
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
    odometro: { n: odoPorRevisar, color: "#B07A0F" },
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

        {verServidor && <ModalServidor estado={estado} onClose={() => setVerServidor(false)} />}

        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-[#0b315f] leading-none">Radar IA</h1>
            <p className="text-sm text-gray-400 mt-1 font-medium">WhatsApp → ELIA → ERP</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setVerServidor(true)}
              title="Qué servidor mantiene el WhatsApp abierto y cómo revivirlo"
              className="flex items-center gap-2 bg-white border border-gray-100 shadow-sm rounded-xl px-3 py-2 hover:border-gray-300 transition-colors text-left"
            >
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: conexion.dot }} />
              <span>
                <span className="block text-xs font-black leading-tight" style={{ color: conexion.color }}>{conexion.texto}</span>
                {conexion.sub && <span className="block text-[10px] text-gray-400 font-semibold leading-tight">{conexion.sub}</span>}
              </span>
              <Ic.Servidor size={14} className="text-gray-300 ml-0.5" />
            </button>
            {/* Siempre disponible: en `esperando_qr` también hace falta (un QR viejo de un
                worker caído no sirve, y si el número quedó bloqueado hay que vincular otro). */}
            {estado && (
              <button
                onClick={solicitarNuevoQr}
                disabled={solicitandoQr}
                title="Borra la sesión de WhatsApp guardada en el servidor y pide vincular un número (el mismo u otro) escaneando un QR nuevo"
                className="flex items-center gap-1.5 bg-white border border-gray-100 shadow-sm rounded-xl px-3 py-2 text-xs font-bold text-gray-600 hover:border-gray-300 transition-colors disabled:opacity-50"
              >
                <Ic.QrCode size={14} />
                {solicitandoQr
                  ? "Solicitando…"
                  : estado.estado === "conectado" ? "Vincular otro número" : "Generar QR nuevo"}
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
            {estado?.estado === "esperando_qr" && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 flex flex-col items-center text-center">
                <h2 className="font-black text-[#0b315f] text-lg mb-1">Vincula el WhatsApp del Radar</h2>
                <p className="text-sm text-gray-500 max-w-md mb-4">
                  En el teléfono del número DEDICADO: WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo → escanea este código. Solo se hace una vez.
                </p>
                {estado.detalle && (
                  <div className="mb-4 max-w-md text-sm font-semibold text-[#8a5a00] bg-[#FFF6E5] border border-[#B07A0F]/25 rounded-xl px-4 py-3">
                    {estado.detalle}
                  </div>
                )}
                {!workerVivo ? (
                  // Los QR de WhatsApp caducan en segundos y solo los renueva el worker
                  // corriendo: mostrar uno viejo sería mandar a escanear algo que no sirve.
                  <div className="max-w-md text-sm text-[#8f1f1f] bg-[#FDECEC] border border-[#EB5757]/30 rounded-xl px-4 py-3">
                    <p className="font-black">Este código ya no sirve: el worker no está respondiendo</p>
                    <p className="mt-1 font-medium">
                      Último latido {estado.ultimo_latido ? haceRelativo(estado.ultimo_latido) : "nunca"}. Los QR de WhatsApp
                      caducan en segundos y solo el worker corriendo genera uno nuevo — enciéndelo primero y el código aparece acá solo.
                    </p>
                    <button onClick={() => setVerServidor(true)} className="mt-2 inline-flex items-center gap-1.5 text-xs font-black text-[#1262bd] hover:underline">
                      <Ic.Servidor size={13} /> ¿Cuál es el servidor y cómo lo enciendo?
                    </button>
                  </div>
                ) : estado.qr_data_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={estado.qr_data_url} alt="Código QR para vincular el WhatsApp del Radar" className="w-64 h-64 rounded-xl border border-gray-100" />
                ) : (
                  <div className="w-64 h-64 rounded-xl border border-dashed border-gray-200 flex flex-col items-center justify-center gap-3 text-gray-400">
                    <div className="w-7 h-7 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                    <p className="text-xs font-bold">Generando el código…</p>
                  </div>
                )}
              </div>
            )}
            {estado?.estado === "desconectado" && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex items-start gap-3">
                <span className="text-2xl">🔌</span>
                <div>
                  <p className="font-black text-[#0b315f] text-sm">Worker desconectado</p>
                  <p className="text-sm text-gray-500 mt-1">
                    El worker de WhatsApp está apagado o sin conexión{estado.detalle ? ` (${estado.detalle})` : ""}. Enciéndelo en el servidor.
                  </p>
                  {/* Reintentar no arregla unas credenciales que WhatsApp ya rechazó: decir cuál es la salida. */}
                  {motivoRechazo && (
                    <div className="mt-2 text-sm text-[#8f1f1f] bg-[#FDECEC] border border-[#EB5757]/30 rounded-xl px-4 py-3">
                      <p className="font-semibold">{motivoRechazo}</p>
                      <button
                        onClick={solicitarNuevoQr}
                        disabled={solicitandoQr}
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-black text-[#1262bd] hover:underline disabled:opacity-50"
                      >
                        <Ic.QrCode size={13} /> {solicitandoQr ? "Solicitando…" : "Generar QR nuevo"}
                      </button>
                    </div>
                  )}
                  <button onClick={() => setVerServidor(true)} className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-[#1262bd] hover:underline">
                    <Ic.Servidor size={13} /> ¿Cuál es el servidor y cómo lo enciendo?
                  </button>
                </div>
              </div>
            )}
            {/* La solicitud es una bandera en la BD: la atiende el worker cuando la ve. */}
            {estado?.solicitar_relink && (
              <div className="bg-[#FFF6E5] border border-[#B07A0F]/25 rounded-2xl p-4 flex items-start gap-3">
                <span className="text-xl">⏳</span>
                <p className="text-sm font-semibold text-[#8a5a00]">
                  QR nuevo solicitado.{" "}
                  {workerVivo
                    ? "El worker lo va a atender en unos segundos: el código aparece acá solo."
                    : "Pero el worker no está respondiendo, así que nadie va a atenderlo — enciéndelo y lo hace apenas arranque."}
                </p>
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
                vehiculosGuia={vehiculosGuia}
                mensajesPorId={mensajesPorId}
                registrando={registrandoComb}
                onRegistrar={registrarCombustible}
                onDescartar={descartarCombustible}
              />
            )}
            {tab === "odometro" && (
              <TabOdometro registros={odometros} vehiculosGuia={vehiculosGuia} onRefresh={cargar} showToast={showToast} />
            )}
            {tab === "alertas" && (
              <TabAlertas alertas={alertas} onMarcarLeida={marcarAlertaLeida} onMarcarTodas={marcarTodasLeidas} />
            )}
            {tab === "grupos" && (
              <TabGrupos
                grupos={grupos}
                estado={estado}
                workerVivo={workerVivo}
                sincronizando={sincronizandoGrupos}
                onToggle={toggleGrupo}
                onGuardarContexto={guardarContextoGrupo}
                onSincronizar={solicitarSyncGrupos}
                onEliminar={eliminarGrupo}
              />
            )}
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
