"use client";

// PanelMensajesPasajeros.tsx
// Bandeja de conversaciones 1-a-1 con los pasajeros (chat bidireccional).
// El operador ve los hilos (agrupados por pasajero+servicio), abre uno y RESPONDE.
// La respuesta llega al pasajero por push (POST /api/mensajes/responder).
// Colocar en: components/seguimiento/PanelMensajesPasajeros.tsx

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type Remitente = "pasajero" | "operador" | "conductor";

type MensajePasajero = {
  id: number;
  pasajero_id: number | null;
  reserva_id: number | null;
  parada_id: number | null;
  tipo: string;
  mensaje: string;
  remitente: Remitente;
  autor_nombre: string | null;
  leido: boolean;
  leido_por: string | null;
  leido_at: string | null;
  leido_pasajero: boolean;
  created_at: string;
  // joins
  pasajero?: { nombre: string; empresa: string | null } | null;
  parada?: { nombre: string } | null;
  reserva?: ReservaInfo | null;
};

type ReservaInfo = {
  origen: string | null;
  destino: string | null;
  ruta_nombre: string | null;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  codigo: string | null;
};

type Convo = {
  key: string;
  pasajeroId: number | null;
  reservaId: number | null;
  nombre: string;
  empresa: string | null;
  ruta: ReservaInfo | null;
  parada: string | null;
  mensajes: MensajePasajero[]; // asc
  ultimo: MensajePasajero;
  noLeidos: number; // mensajes del pasajero sin atender
};

const TIPO_CFG: Record<string, { ico: string; color: string; bg: string; label: string }> = {
  tardanza:    { ico: "⏰", color: "#92400E", bg: "#FEF3C7", label: "Tardanza" },
  cancelacion: { ico: "❌", color: "#991B1B", bg: "#FEF2F2", label: "Cancelación" },
  incidencia:  { ico: "🚨", color: "#991B1B", bg: "#FEF2F2", label: "Incidencia" },
  novedad:     { ico: "💬", color: "#1E40AF", bg: "#EFF6FF", label: "Novedad" },
  otro:        { ico: "✏️", color: "#374151", bg: "#F3F4F6", label: "Otro" },
};

// Respuestas de un toque (operador). Se envían al instante al tocarlas.
const RESP_RAPIDAS = [
  "Ya vamos en camino 🚌",
  "Tu bus llega en ~5 minutos, por favor espera en tu paradero.",
  "Estamos atendiendo tu solicitud ahora mismo.",
  "Gracias por avisar, lo estamos revisando.",
  "Confirmado ✅",
];

function fmtTime(s: string) {
  const d = new Date(s);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)  return "Ahora";
  if (diff < 3600) return `Hace ${Math.floor(diff / 60)} min`;
  return d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
}

// Etiqueta corta de ruta: prioriza ruta_nombre, si no arma "origen → destino".
function rutaLabel(r: ReservaInfo | null): string | null {
  if (!r) return null;
  if (r.ruta_nombre) return r.ruta_nombre;
  if (r.origen && r.destino) return `${r.origen} → ${r.destino}`;
  return r.origen || r.destino || null;
}

// Fecha (+hora) del servicio para dar soporte: "23 jul · 05:00".
function fmtServicio(r: ReservaInfo | null): string | null {
  if (!r?.fecha_servicio) return r?.hora_servicio ? r.hora_servicio.slice(0, 5) : null;
  const d = new Date(`${r.fecha_servicio}T00:00:00`);
  const fecha = isNaN(d.getTime())
    ? r.fecha_servicio
    : d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
  const hora = r.hora_servicio ? r.hora_servicio.slice(0, 5) : null;
  return hora ? `${fecha} · ${hora}` : fecha;
}

// Fecha "hoy" en Perú (UTC-5), formato YYYY-MM-DD.
function fechaHoyPeru(): string {
  const lima = new Date(Date.now() - 5 * 3600 * 1000);
  return lima.toISOString().slice(0, 10);
}

type Props = {
  // Abre el detalle del servicio (drawer) en Seguimiento desde un hilo.
  onIrAServicio?: (reservaId: number, fechaServicio?: string | null) => void;
};

export default function PanelMensajesPasajeros({ onIrAServicio }: Props = {}) {
  const [mensajes, setMensajes] = useState<MensajePasajero[]>([]);
  const [abierto, setAbierto] = useState(false);
  const [convoKey, setConvoKey] = useState<string | null>(null); // hilo abierto
  const [borrador, setBorrador] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [busqueda, setBusqueda] = useState("");     // filtro de la lista
  const [soloHoy, setSoloHoy] = useState(false);     // filtro: solo servicios de hoy
  const finRef = useRef<HTMLDivElement | null>(null);
  const hoyPeru = useMemo(() => fechaHoyPeru(), []);

  const cargar = useCallback(async () => {
    const { data } = await supabase
      .from("mensajes_pasajero")
      .select(`
        *,
        pasajero:pasajeros(nombre, empresa),
        parada:paradas(nombre),
        reserva:reservas(origen, destino, ruta_nombre, fecha_servicio, hora_servicio, codigo)
      `)
      .order("created_at", { ascending: false })
      .limit(200);
    setMensajes((data as MensajePasajero[]) || []);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Deep-link desde el toast/notificación global: /seguimiento?mensajes=1 abre el panel.
  // Se lee de window.location (cliente) para no requerir <Suspense> de useSearchParams.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("mensajes") === "1") {
      setAbierto(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // Realtime — nuevo mensaje o cambio de estado
  useEffect(() => {
    const ch = supabase
      .channel("mensajes-pasajero-erp")
      .on("postgres_changes", { event: "*", schema: "public", table: "mensajes_pasajero" }, () => cargar())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [cargar]);

  // Agrupar en conversaciones por (pasajero + servicio)
  const convos = useMemo<Convo[]>(() => {
    const mapa = new Map<string, Convo>();
    // mensajes viene desc; recorrer al revés para construir asc
    for (const m of [...mensajes].reverse()) {
      const key = `${m.pasajero_id ?? "?"}__${m.reserva_id ?? "?"}`;
      const prev = mapa.get(key);
      if (!prev) {
        mapa.set(key, {
          key,
          pasajeroId: m.pasajero_id,
          reservaId: m.reserva_id,
          nombre: m.pasajero?.nombre || "Pasajero",
          empresa: m.pasajero?.empresa || null,
          ruta: m.reserva || null,
          parada: m.parada?.nombre || null,
          mensajes: [m],
          ultimo: m,
          noLeidos: m.remitente === "pasajero" && !m.leido ? 1 : 0,
        });
      } else {
        prev.mensajes.push(m);
        prev.ultimo = m;
        if (m.remitente === "pasajero" && !m.leido) prev.noLeidos++;
        if (!prev.ruta && m.reserva) prev.ruta = m.reserva;
        if (!prev.parada && m.parada?.nombre) prev.parada = m.parada.nombre;
      }
    }
    const esHoy = (c: Convo) => c.ruta?.fecha_servicio === hoyPeru;
    return [...mapa.values()].sort((a, b) => {
      // 1º los servicios de hoy; 2º sin leer; 3º el mensaje más reciente.
      if (esHoy(a) !== esHoy(b)) return esHoy(a) ? -1 : 1;
      if ((a.noLeidos > 0) !== (b.noLeidos > 0)) return a.noLeidos > 0 ? -1 : 1;
      return new Date(b.ultimo.created_at).getTime() - new Date(a.ultimo.created_at).getTime();
    });
  }, [mensajes, hoyPeru]);

  // Lista visible según buscador y filtro "solo hoy".
  const convosVisibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return convos.filter(c => {
      if (soloHoy && c.ruta?.fecha_servicio !== hoyPeru) return false;
      if (!q) return true;
      const heno = [
        c.nombre, c.empresa, rutaLabel(c.ruta), c.parada, c.ruta?.codigo,
      ].filter(Boolean).join(" ").toLowerCase();
      return heno.includes(q);
    });
  }, [convos, busqueda, soloHoy, hoyPeru]);

  const convoAbierta = useMemo(
    () => convos.find(c => c.key === convoKey) || null,
    [convos, convoKey]
  );

  const totalNoLeidos = useMemo(
    () => mensajes.filter(m => m.remitente === "pasajero" && !m.leido).length,
    [mensajes]
  );
  const hayNuevos = totalNoLeidos > 0;

  // Auto-scroll al fondo al abrir un hilo o al llegar mensajes
  useEffect(() => {
    if (convoAbierta) finRef.current?.scrollIntoView({ behavior: "auto" });
  }, [convoAbierta?.mensajes.length, convoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function responder(texto: string) {
    const t = texto.trim();
    if (!t || !convoAbierta?.pasajeroId || enviando) return;
    setEnviando(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setEnviando(false); return; }
      const res = await fetch("/api/mensajes/responder", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          pasajero_id: convoAbierta.pasajeroId,
          reserva_id: convoAbierta.reservaId,
          texto: t,
        }),
      });
      if (res.ok) { setBorrador(""); await cargar(); }
    } finally {
      setEnviando(false);
    }
  }

  async function marcarConvoAtendida(c: Convo) {
    const ids = c.mensajes.filter(m => m.remitente === "pasajero" && !m.leido).map(m => m.id);
    if (!ids.length) return;
    await supabase.from("mensajes_pasajero")
      .update({ leido: true, leido_at: new Date().toISOString() }).in("id", ids);
    setMensajes(prev => prev.map(m => ids.includes(m.id) ? { ...m, leido: true } : m));
  }

  async function marcarTodosLeidos() {
    const ids = mensajes.filter(m => m.remitente === "pasajero" && !m.leido).map(m => m.id);
    if (!ids.length) return;
    await supabase.from("mensajes_pasajero")
      .update({ leido: true, leido_at: new Date().toISOString() }).in("id", ids);
    setMensajes(prev => prev.map(m => ({ ...m, leido: m.remitente === "pasajero" ? true : m.leido })));
  }

  return (
    <>
      {/* ── BOTÓN FLOTANTE ── */}
      <button
        onClick={() => setAbierto(v => !v)}
        className="relative flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm transition-all"
        style={{
          background: hayNuevos ? "#0b315f" : "#f1f5f9",
          color: hayNuevos ? "white" : "#475569",
          border: hayNuevos ? "none" : "1px solid #e2e8f0",
        }}>
        <span style={{ fontSize: 16 }}>💬</span>
        Mensajes pasajeros
        {hayNuevos && (
          <span style={{
            background: "#ef4444", color: "white",
            borderRadius: "50%", width: 20, height: 20,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 900,
          }}>
            {totalNoLeidos > 9 ? "9+" : totalNoLeidos}
          </span>
        )}
      </button>

      {/* ── PANEL LATERAL ── */}
      {abierto && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          style={{ background: "rgba(15,23,42,0.5)" }}
          onClick={() => setAbierto(false)}>
          <div
            className="h-full bg-white flex flex-col shadow-2xl"
            style={{ width: "100%", maxWidth: 440 }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex-shrink-0 px-5 py-4 border-b flex items-center justify-between"
              style={{ background: "#0b315f" }}>
              <div className="flex items-center gap-3 min-w-0">
                {convoAbierta && (
                  <button onClick={() => setConvoKey(null)}
                    className="w-8 h-8 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white flex-shrink-0">
                    ←
                  </button>
                )}
                <div className="min-w-0">
                  <p className="text-white font-black text-base truncate">
                    {convoAbierta ? convoAbierta.nombre : "Mensajes de pasajeros"}
                  </p>
                  <p className="text-blue-200 text-xs mt-0.5 truncate">
                    {convoAbierta
                      ? (convoAbierta.empresa || "En tiempo real")
                      : (hayNuevos ? `${totalNoLeidos} sin leer · En tiempo real` : "Todos atendidos · En tiempo real")}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {!convoAbierta && hayNuevos && (
                  <button onClick={marcarTodosLeidos}
                    className="text-xs font-bold text-blue-200 hover:text-white px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors">
                    Marcar todos leídos
                  </button>
                )}
                <button onClick={() => { setAbierto(false); setConvoKey(null); }}
                  className="w-8 h-8 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors">
                  ✕
                </button>
              </div>
            </div>

            {/* ── BUSCADOR / FILTROS DE LA LISTA ── */}
            {!convoAbierta && convos.length > 0 && (
              <div className="flex-shrink-0 px-4 py-3 border-b bg-white space-y-2">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300 text-sm">🔍</span>
                  <input
                    value={busqueda}
                    onChange={e => setBusqueda(e.target.value)}
                    placeholder="Buscar por pasajero, ruta, empresa o código…"
                    className="w-full pl-8 pr-3 py-2 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-[#0b315f]/30"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setSoloHoy(v => !v)}
                    className="text-xs font-bold px-3 py-1.5 rounded-full border transition-colors"
                    style={soloHoy
                      ? { background: "#0b315f", color: "white", borderColor: "#0b315f" }
                      : { background: "white", color: "#475569", borderColor: "#e2e8f0" }}>
                    📅 Solo hoy
                  </button>
                  <span className="text-[11px] text-slate-400">
                    {convosVisibles.length} de {convos.length} conversación{convos.length !== 1 ? "es" : ""}
                  </span>
                </div>
              </div>
            )}

            {/* ── LISTA DE CONVERSACIONES ── */}
            {!convoAbierta && (
              <div className="flex-1 overflow-y-auto">
                {convos.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center px-6">
                    <p style={{ fontSize: 48, marginBottom: 12 }}>💬</p>
                    <p className="font-bold text-gray-700">Sin mensajes aún</p>
                    <p className="text-sm text-gray-400 mt-2">Las conversaciones con pasajeros aparecerán aquí en tiempo real</p>
                  </div>
                ) : convosVisibles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center px-6">
                    <p style={{ fontSize: 40, marginBottom: 12 }}>🔍</p>
                    <p className="font-bold text-gray-700">Sin resultados</p>
                    <p className="text-sm text-gray-400 mt-2">Ajusta la búsqueda o quita el filtro de hoy</p>
                  </div>
                ) : (
                  <div className="divide-y" style={{ borderColor: "#f1f5f9" }}>
                    {convosVisibles.map(c => {
                      const cfg = TIPO_CFG[c.ultimo.tipo] || TIPO_CFG.novedad;
                      const suyo = c.ultimo.remitente !== "pasajero";
                      return (
                        <button key={c.key} onClick={() => { setConvoKey(c.key); setBorrador(""); }}
                          className="w-full text-left px-5 py-4 flex items-start gap-3 hover:bg-slate-50 transition-colors"
                          style={{ background: c.noLeidos > 0 ? "#f8fafc" : "white" }}>
                          <div className="w-10 h-10 rounded-xl bg-[#0b315f] flex items-center justify-center text-white text-sm font-black flex-shrink-0">
                            {c.nombre.charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-bold text-gray-900 truncate">{c.nombre}</p>
                              <span className="text-xs text-gray-400 flex-shrink-0">{fmtTime(c.ultimo.created_at)}</span>
                            </div>
                            {c.empresa && <p className="text-xs text-gray-400 truncate">{c.empresa}</p>}
                            {/* Contexto del servicio: ruta + fecha/hora — clave para dar soporte */}
                            {(rutaLabel(c.ruta) || fmtServicio(c.ruta) || c.parada) && (
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
                                {rutaLabel(c.ruta) && (
                                  onIrAServicio && c.reservaId != null ? (
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      title="Ver el detalle del servicio"
                                      onClick={e => {
                                        e.stopPropagation();
                                        onIrAServicio(c.reservaId!, c.ruta?.fecha_servicio ?? null);
                                        setAbierto(false);
                                        setConvoKey(null);
                                      }}
                                      onKeyDown={e => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault(); e.stopPropagation();
                                          onIrAServicio(c.reservaId!, c.ruta?.fecha_servicio ?? null);
                                          setAbierto(false); setConvoKey(null);
                                        }
                                      }}
                                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0b315f] bg-slate-100 hover:bg-blue-100 rounded-md px-1.5 py-0.5 max-w-full truncate cursor-pointer transition-colors">
                                      🚌 {rutaLabel(c.ruta)} →
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600 bg-slate-100 rounded-md px-1.5 py-0.5 max-w-full truncate">
                                      🚌 {rutaLabel(c.ruta)}
                                    </span>
                                  )
                                )}
                                {fmtServicio(c.ruta) && (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0b315f] bg-blue-50 rounded-md px-1.5 py-0.5">
                                    📅 {fmtServicio(c.ruta)}
                                  </span>
                                )}
                                {c.parada && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 truncate">
                                    📍 {c.parada}
                                  </span>
                                )}
                              </div>
                            )}
                            <p className="text-sm text-gray-600 truncate mt-1">
                              {suyo && <span className="text-[#0b315f] font-semibold">Tú: </span>}
                              {!suyo && <span>{cfg.ico} </span>}
                              {c.ultimo.mensaje}
                            </p>
                          </div>
                          {c.noLeidos > 0 && (
                            <span className="flex-shrink-0 mt-1" style={{
                              background: "#ef4444", color: "white", borderRadius: "50%",
                              minWidth: 20, height: 20, padding: "0 6px", fontSize: 11, fontWeight: 900,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>
                              {c.noLeidos > 9 ? "9+" : c.noLeidos}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── HILO ── */}
            {convoAbierta && (
              <>
                {/* Contexto ruta/parada */}
                {(convoAbierta.ruta || convoAbierta.parada) && (
                  <div className="flex-shrink-0 px-5 py-2.5 border-b bg-slate-50 flex items-center gap-x-3 gap-y-1 text-xs text-gray-500 flex-wrap">
                    {rutaLabel(convoAbierta.ruta) && (
                      <span className="font-semibold text-slate-700">🚌 {rutaLabel(convoAbierta.ruta)}</span>
                    )}
                    {fmtServicio(convoAbierta.ruta) && (
                      <span className="font-semibold text-[#0b315f]">📅 {fmtServicio(convoAbierta.ruta)}</span>
                    )}
                    {convoAbierta.ruta?.codigo && <span className="text-slate-400">#{convoAbierta.ruta.codigo}</span>}
                    {convoAbierta.parada && <span>📍 {convoAbierta.parada}</span>}
                    <div className="ml-auto flex items-center gap-3">
                      {convoAbierta.noLeidos > 0 && (
                        <button onClick={() => marcarConvoAtendida(convoAbierta)}
                          className="text-xs font-bold text-[#0b315f] hover:underline">
                          ✓ Marcar atendido
                        </button>
                      )}
                      {onIrAServicio && convoAbierta.reservaId != null && (
                        <button
                          onClick={() => {
                            onIrAServicio(convoAbierta.reservaId!, convoAbierta.ruta?.fecha_servicio ?? null);
                            setAbierto(false);
                            setConvoKey(null);
                          }}
                          className="text-xs font-bold text-white bg-[#0b315f] hover:bg-[#1262bd] rounded-lg px-2.5 py-1 transition-colors">
                          Ver servicio →
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Burbujas */}
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2" style={{ background: "#f8fafc" }}>
                  {convoAbierta.mensajes.map(m => {
                    const suyo = m.remitente !== "pasajero";
                    const cfg = TIPO_CFG[m.tipo] || TIPO_CFG.novedad;
                    return (
                      <div key={m.id} className={`flex ${suyo ? "justify-end" : "justify-start"}`}>
                        <div className="max-w-[80%]">
                          {suyo && (
                            <p className="text-[10px] text-gray-400 text-right mb-0.5 pr-1 font-semibold">
                              {m.remitente === "conductor" ? (m.autor_nombre || "Conductor") : (m.autor_nombre || "Central AFA")}
                            </p>
                          )}
                          {!suyo && m.tipo && TIPO_CFG[m.tipo] && m.tipo !== "novedad" && (
                            <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full mb-1"
                              style={{ background: cfg.bg, color: cfg.color }}>
                              {cfg.ico} {cfg.label}
                            </span>
                          )}
                          <div className="rounded-2xl px-3.5 py-2 text-sm"
                            style={suyo
                              ? { background: "#0b315f", color: "white", borderTopRightRadius: 4 }
                              : { background: "white", color: "#1f2937", border: "1px solid #e5e7eb", borderTopLeftRadius: 4 }}>
                            {m.mensaje}
                          </div>
                          <p className={`text-[10px] text-gray-400 mt-0.5 ${suyo ? "text-right pr-1" : "pl-1"}`}>
                            {fmtTime(m.created_at)}
                            {suyo && m.leido_pasajero && " · Visto"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={finRef} />
                </div>

                {/* Respuestas rápidas */}
                <div className="flex-shrink-0 px-3 pt-2 flex gap-2 overflow-x-auto border-t bg-white">
                  {RESP_RAPIDAS.map((r, i) => (
                    <button key={i} disabled={enviando} onClick={() => responder(r)}
                      className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap">
                      {r.length > 26 ? r.slice(0, 24) + "…" : r}
                    </button>
                  ))}
                </div>

                {/* Caja de texto */}
                <div className="flex-shrink-0 px-3 py-3 bg-white flex items-end gap-2">
                  <textarea
                    value={borrador}
                    onChange={e => setBorrador(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); responder(borrador); } }}
                    placeholder="Escribe una respuesta…"
                    rows={1}
                    className="flex-1 resize-none rounded-2xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/30"
                    style={{ maxHeight: 120 }}
                  />
                  <button
                    onClick={() => responder(borrador)}
                    disabled={enviando || !borrador.trim()}
                    className="flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center text-white disabled:opacity-40 transition-opacity"
                    style={{ background: "#0b315f" }}>
                    {enviando ? "…" : "➤"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
