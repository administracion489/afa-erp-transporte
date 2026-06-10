"use client";
import React, { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────────

type Canal = "todos" | "whatsapp" | "messenger" | "instagram" | "gmail" | "llamada";
type Estado = "abierta" | "en_progreso" | "resuelta" | "spam";

type Contacto = {
  id: string; nombre: string; empresa?: string; telefono?: string; email?: string;
  canal_origen: string; wa_id?: string; fb_psid?: string; ig_id?: string; gmail_email?: string;
};

type Conversacion = {
  id: string; canal: Canal; estado: Estado; asunto?: string;
  ultimo_mensaje_at?: string; no_leidos: number; pipeline_id?: string;
  contacto_id: string; crm_contactos: Contacto;
  _ultimo_texto?: string;
};

type Mensaje = {
  id: string; conversacion_id: string; direccion: "entrante" | "saliente";
  tipo: string; contenido?: string; media_url?: string;
  enviado_por?: string; error?: string; created_at: string;
};

// ── Canal config ──────────────────────────────────────────────────────────

const CANAL_CFG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  whatsapp:  { label: "WhatsApp",  color: "#16a34a", bg: "#dcfce7", icon: "💬" },
  messenger: { label: "Messenger", color: "#1d4ed8", bg: "#dbeafe", icon: "💙" },
  instagram: { label: "Instagram", color: "#9333ea", bg: "#f3e8ff", icon: "📸" },
  gmail:     { label: "Gmail",     color: "#dc2626", bg: "#fee2e2", icon: "📧" },
  llamada:   { label: "Llamada",   color: "#d97706", bg: "#fef3c7", icon: "📞" },
  manual:    { label: "Manual",    color: "#6b7280", bg: "#f3f4f6", icon: "✉️" },
};

const ESTADO_CFG: Record<string, { label: string; color: string; bg: string }> = {
  abierta:     { label: "Abierta",     color: "#0369a1", bg: "#e0f2fe" },
  en_progreso: { label: "En progreso", color: "#92400e", bg: "#fef3c7" },
  resuelta:    { label: "Resuelta",    color: "#166534", bg: "#dcfce7" },
  spam:        { label: "Spam",        color: "#991b1b", bg: "#fee2e2" },
};

// ── Helpers ───────────────────────────────────────────────────────────────

const fmtHora = (s?: string) => {
  if (!s) return "";
  const d = new Date(s);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Ahora";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffMin < 1440) return d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
};

const fmtFechaMsg = (s: string) =>
  new Date(s).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });

const iniciales = (n: string) =>
  n.split(" ").slice(0, 2).map((p) => p[0] ?? "").join("").toUpperCase();

const avatarColor = (n: string) => {
  const cols = ["#0b315f", "#1262bd", "#16a34a", "#9333ea", "#dc2626", "#d97706", "#0891b2"];
  return cols[(n.charCodeAt(0) ?? 0) % cols.length];
};

// ── Main component ────────────────────────────────────────────────────────

export default function CRMPage() {
  const [convs, setConvs] = useState<Conversacion[]>([]);
  const [selected, setSelected] = useState<Conversacion | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [reply, setReply] = useState("");
  const [canalFiltro, setCanalFiltro] = useState<Canal>("todos");
  const [estadoFiltro, setEstadoFiltro] = useState<"abierta" | "en_progreso" | "resuelta">("abierta");
  const [busqueda, setBusqueda] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [nuevoContactoModal, setNuevoContactoModal] = useState(false);
  const [nuevoForm, setNuevoForm] = useState({ nombre: "", empresa: "", telefono: "", email: "", canal: "whatsapp", notas: "" });
  const chatEndRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const sincronizarGmail = async () => {
    setSincronizando(true);
    try {
      const res = await fetch("/api/crm/gmail/sync", { method: "POST" });
      if (res.ok) { showToast("Gmail sincronizado correctamente"); cargarConvs(); }
      else showToast("Error al sincronizar Gmail", false);
    } catch { showToast("Error al sincronizar Gmail", false); }
    setSincronizando(false);
  };

  // ── Cargar conversaciones ──────────────────────────────────────────────

  const cargarConvs = useCallback(async () => {
    let q = supabase
      .from("crm_conversaciones")
      .select("*, crm_contactos(id,nombre,empresa,telefono,email,canal_origen,wa_id,fb_psid,ig_id,gmail_email)")
      .order("ultimo_mensaje_at", { ascending: false, nullsFirst: false });

    if (estadoFiltro !== "resuelta") {
      q = q.in("estado", estadoFiltro === "abierta" ? ["abierta"] : ["en_progreso"]);
    } else {
      q = q.eq("estado", "resuelta");
    }

    if (canalFiltro !== "todos") q = q.eq("canal", canalFiltro);

    const { data } = await q.limit(80);

    // Para cada conv, obtener el último mensaje
    const enriched = await Promise.all(
      (data ?? []).map(async (c) => {
        const { data: ult } = await supabase
          .from("crm_mensajes")
          .select("contenido")
          .eq("conversacion_id", c.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return { ...c, _ultimo_texto: ult?.contenido };
      })
    );
    setConvs(enriched as Conversacion[]);
    setCargando(false);
  }, [canalFiltro, estadoFiltro]);

  useEffect(() => { cargarConvs(); }, [cargarConvs]);

  // ── Cargar mensajes de conversación ───────────────────────────────────

  const cargarMensajes = useCallback(async (convId: string) => {
    const { data } = await supabase
      .from("crm_mensajes")
      .select("*")
      .eq("conversacion_id", convId)
      .order("created_at", { ascending: true });
    setMensajes(data ?? []);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, []);

  useEffect(() => {
    if (selected) {
      cargarMensajes(selected.id);
      // Marcar como leído
      supabase.from("crm_conversaciones").update({ no_leidos: 0 }).eq("id", selected.id);
    }
  }, [selected, cargarMensajes]);

  // ── Realtime ───────────────────────────────────────────────────────────

  useEffect(() => {
    const ch = supabase
      .channel("crm_realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "crm_mensajes" }, (payload) => {
        const nuevo = payload.new as Mensaje;
        if (selected && nuevo.conversacion_id === selected.id) {
          setMensajes((prev) => [...prev, nuevo]);
          setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
        }
        cargarConvs();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "crm_conversaciones" }, () => {
        cargarConvs();
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [selected, cargarConvs]);

  // ── Enviar mensaje ─────────────────────────────────────────────────────

  const enviar = async () => {
    if (!reply.trim() || !selected || enviando) return;
    setEnviando(true);
    const texto = reply.trim();
    setReply("");

    const res = await fetch("/api/crm/mensajes/enviar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversacion_id: selected.id, texto }),
    });
    const data = await res.json();
    setEnviando(false);

    if (!data.ok) showToast(data.error ?? "Error al enviar", false);
    else {
      cargarMensajes(selected.id);
      cargarConvs();
    }
  };

  // ── Cambiar estado ─────────────────────────────────────────────────────

  const cambiarEstado = async (conv: Conversacion, nuevoEstado: Estado) => {
    await supabase.from("crm_conversaciones").update({ estado: nuevoEstado }).eq("id", conv.id);
    if (selected?.id === conv.id) setSelected({ ...conv, estado: nuevoEstado });
    cargarConvs();
    showToast(`Conversación marcada como ${ESTADO_CFG[nuevoEstado].label}`);
  };

  // ── Crear contacto manual ──────────────────────────────────────────────

  const crearContacto = async () => {
    if (!nuevoForm.nombre.trim()) return;
    const { data: contacto } = await supabase
      .from("crm_contactos")
      .insert({
        nombre: nuevoForm.nombre, empresa: nuevoForm.empresa || null,
        telefono: nuevoForm.telefono || null, email: nuevoForm.email || null,
        canal_origen: nuevoForm.canal, notas: nuevoForm.notas || null,
        wa_id: nuevoForm.canal === "whatsapp" ? nuevoForm.telefono || null : null,
        gmail_email: nuevoForm.canal === "gmail" ? nuevoForm.email || null : null,
      })
      .select("id").single();

    if (contacto) {
      const { data: conv } = await supabase
        .from("crm_conversaciones")
        .insert({ contacto_id: contacto.id, canal: nuevoForm.canal, estado: "abierta" })
        .select("*, crm_contactos(*)").single();
      if (conv) {
        setNuevoContactoModal(false);
        setNuevoForm({ nombre: "", empresa: "", telefono: "", email: "", canal: "whatsapp", notas: "" });
        cargarConvs();
        setSelected(conv as Conversacion);
        showToast("Conversación creada");
      }
    }
  };

  // ── Filtros ────────────────────────────────────────────────────────────

  const convsFiltradas = convs.filter((c) => {
    if (!busqueda) return true;
    const q = busqueda.toLowerCase();
    return (
      c.crm_contactos?.nombre?.toLowerCase().includes(q) ||
      c.crm_contactos?.empresa?.toLowerCase().includes(q) ||
      c._ultimo_texto?.toLowerCase().includes(q)
    );
  });

  const totalNoLeidos = convs.reduce((t, c) => t + (c.no_leidos ?? 0), 0);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-gray-50 overflow-hidden">

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white transition-all
          ${toast.ok ? "bg-[#0b315f]" : "bg-red-600"}`}>
          {toast.msg}
        </div>
      )}

      {/* ── Panel izquierdo — lista de conversaciones ── */}
      <div className="w-80 flex-shrink-0 bg-white border-r border-gray-100 flex flex-col">

        {/* Header */}
        <div className="p-4 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-[#0b315f]">CRM</span>
              {totalNoLeidos > 0 && (
                <span className="bg-[#0b315f] text-white text-xs font-bold px-1.5 py-0.5 rounded-full">
                  {totalNoLeidos}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={sincronizarGmail}
                disabled={sincronizando}
                title="Sincronizar Gmail"
                className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {sincronizando ? "⏳" : "📧↻"}
              </button>
              <button
                onClick={() => setNuevoContactoModal(true)}
                className="bg-[#0b315f] text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-[#1262bd] transition-colors"
              >
                + Nueva
              </button>
            </div>
          </div>

          {/* Búsqueda */}
          <input
            value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar conversación..."
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
          />
        </div>

        {/* Filtros canal */}
        <div className="px-3 pt-3 pb-1 flex gap-1.5 flex-wrap border-b border-gray-100">
          {(["todos", "whatsapp", "messenger", "instagram", "gmail", "llamada"] as Canal[]).map((c) => (
            <button
              key={c}
              onClick={() => setCanalFiltro(c)}
              className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors
                ${canalFiltro === c ? "bg-[#0b315f] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {c === "todos" ? "Todos" : (CANAL_CFG[c]?.icon + " " + CANAL_CFG[c]?.label)}
            </button>
          ))}
        </div>

        {/* Filtros estado */}
        <div className="px-3 py-2 flex gap-1.5 border-b border-gray-100">
          {(["abierta", "en_progreso", "resuelta"] as const).map((e) => (
            <button
              key={e}
              onClick={() => setEstadoFiltro(e)}
              className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors
                ${estadoFiltro === e
                  ? "bg-[#0b315f]/10 text-[#0b315f] font-semibold"
                  : "text-gray-500 hover:text-gray-700"}`}
            >
              {e === "abierta" ? "Abiertas" : e === "en_progreso" ? "En progreso" : "Resueltas"}
            </button>
          ))}
        </div>

        {/* Lista */}
        <div className="flex-1 overflow-y-auto">
          {cargando ? (
            <div className="p-8 text-center text-gray-400 text-sm">Cargando...</div>
          ) : convsFiltradas.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">Sin conversaciones</div>
          ) : (
            convsFiltradas.map((c) => {
              const cfg = CANAL_CFG[c.canal] ?? CANAL_CFG.manual;
              const isSelected = selected?.id === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors
                    ${isSelected ? "bg-[#0b315f]/5 border-l-2 border-l-[#0b315f]" : ""}`}
                >
                  <div className="flex items-start gap-3">
                    {/* Avatar */}
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                      style={{ background: avatarColor(c.crm_contactos?.nombre ?? "") }}
                    >
                      {iniciales(c.crm_contactos?.nombre ?? "?")}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className={`text-sm truncate ${c.no_leidos ? "font-semibold text-gray-900" : "font-medium text-gray-700"}`}>
                          {c.crm_contactos?.nombre ?? "Sin nombre"}
                        </span>
                        <span className="text-[10px] text-gray-400 flex-shrink-0">{fmtHora(c.ultimo_mensaje_at)}</span>
                      </div>
                      {c.crm_contactos?.empresa && (
                        <div className="text-[11px] text-gray-400 truncate">{c.crm_contactos.empresa}</div>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: cfg.bg, color: cfg.color }}>
                          {cfg.icon} {cfg.label}
                        </span>
                        {c.no_leidos > 0 && (
                          <span className="bg-[#0b315f] text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                            {c.no_leidos > 9 ? "9+" : c.no_leidos}
                          </span>
                        )}
                      </div>
                      {c._ultimo_texto && (
                        <div className={`text-xs mt-0.5 truncate ${c.no_leidos ? "text-gray-700" : "text-gray-400"}`}>
                          {c._ultimo_texto}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Panel derecho — chat ── */}
      {selected ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat header */}
          <div className="bg-white border-b border-gray-100 px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold"
                style={{ background: avatarColor(selected.crm_contactos?.nombre ?? "") }}
              >
                {iniciales(selected.crm_contactos?.nombre ?? "?")}
              </div>
              <div>
                <div className="font-semibold text-gray-900">{selected.crm_contactos?.nombre}</div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  {selected.crm_contactos?.empresa && <span>{selected.crm_contactos.empresa}</span>}
                  {selected.crm_contactos?.telefono && <span>· {selected.crm_contactos.telefono}</span>}
                  {selected.crm_contactos?.email && <span>· {selected.crm_contactos.email}</span>}
                </div>
              </div>
            </div>

            {/* Acciones */}
            <div className="flex items-center gap-2">
              <span
                className="text-xs px-2.5 py-1 rounded-full font-medium"
                style={{
                  background: CANAL_CFG[selected.canal]?.bg,
                  color: CANAL_CFG[selected.canal]?.color,
                }}
              >
                {CANAL_CFG[selected.canal]?.icon} {CANAL_CFG[selected.canal]?.label}
              </span>

              {/* Estado */}
              <select
                value={selected.estado}
                onChange={(e) => cambiarEstado(selected, e.target.value as Estado)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#0b315f]/30"
                style={{ color: ESTADO_CFG[selected.estado]?.color }}
              >
                {Object.entries(ESTADO_CFG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>

              <a
                href="/crm/pipeline"
                className="text-xs bg-[#0b315f]/10 text-[#0b315f] font-semibold px-3 py-1.5 rounded-lg hover:bg-[#0b315f]/20 transition-colors"
              >
                Ver Pipeline
              </a>
            </div>
          </div>

          {/* Mensajes */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
            {mensajes.length === 0 && (
              <div className="text-center text-gray-400 text-sm py-12">Sin mensajes aún</div>
            )}
            {mensajes.map((m, i) => {
              const esMio = m.direccion === "saliente";
              const showDate =
                i === 0 ||
                new Date(mensajes[i - 1].created_at).toDateString() !== new Date(m.created_at).toDateString();
              return (
                <React.Fragment key={m.id}>
                  {showDate && (
                    <div className="text-center text-xs text-gray-400 py-2">
                      {new Date(m.created_at).toLocaleDateString("es-PE", { weekday: "long", day: "2-digit", month: "long" })}
                    </div>
                  )}
                  <div className={`flex ${esMio ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-sm px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed
                        ${esMio
                          ? "bg-[#0b315f] text-white rounded-br-sm"
                          : "bg-white border border-gray-100 text-gray-800 rounded-bl-sm shadow-sm"
                        }`}
                    >
                      {m.media_url && (
                        <img src={m.media_url} alt="media" className="rounded-lg mb-1.5 max-w-full" />
                      )}
                      <p className="whitespace-pre-wrap">{m.contenido}</p>
                      <div className={`text-[10px] mt-1 text-right ${esMio ? "text-white/60" : "text-gray-400"}`}>
                        {fmtFechaMsg(m.created_at)}
                        {m.error && <span className="ml-1 text-red-300">⚠ {m.error}</span>}
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Reply box */}
          <div className="bg-white border-t border-gray-100 p-4">
            {selected.estado === "resuelta" ? (
              <div className="text-center text-sm text-gray-400 py-2">
                Conversación resuelta.{" "}
                <button
                  onClick={() => cambiarEstado(selected, "abierta")}
                  className="text-[#0b315f] underline"
                >
                  Reabrir
                </button>
              </div>
            ) : (
              <div className="flex gap-3 items-end">
                <textarea
                  ref={replyRef}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
                  }}
                  placeholder={`Responder por ${CANAL_CFG[selected.canal]?.label ?? selected.canal}…`}
                  rows={2}
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                />
                <button
                  onClick={enviar}
                  disabled={!reply.trim() || enviando}
                  className="bg-[#0b315f] text-white px-4 py-2.5 rounded-xl text-sm font-semibold
                    hover:bg-[#1262bd] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {enviando ? "…" : "Enviar"}
                </button>
              </div>
            )}
            <div className="text-xs text-gray-400 mt-1.5 text-right">
              Enter para enviar · Shift+Enter para nueva línea
            </div>
          </div>
        </div>
      ) : (
        /* Empty state */
        <div className="flex-1 flex flex-col items-center justify-center text-center p-12">
          <div className="text-6xl mb-4">💬</div>
          <h2 className="text-xl font-bold text-gray-700 mb-2">Bandeja unificada</h2>
          <p className="text-gray-400 text-sm max-w-xs">
            Selecciona una conversación para ver los mensajes, o crea una nueva desde el panel izquierdo.
          </p>
          <div className="mt-8 flex flex-wrap gap-2 justify-center">
            {Object.entries(CANAL_CFG).filter(([k]) => k !== "manual").map(([k, v]) => (
              <span key={k} className="text-xs px-3 py-1.5 rounded-full font-medium" style={{ background: v.bg, color: v.color }}>
                {v.icon} {v.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Modal nuevo contacto ── */}
      {nuevoContactoModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-[#0b315f] mb-4">Nueva conversación</h3>
            <div className="space-y-3">
              <input
                placeholder="Nombre del contacto *"
                value={nuevoForm.nombre}
                onChange={(e) => setNuevoForm({ ...nuevoForm, nombre: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              />
              <input
                placeholder="Empresa"
                value={nuevoForm.empresa}
                onChange={(e) => setNuevoForm({ ...nuevoForm, empresa: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              />
              <input
                placeholder="Teléfono (con código país, ej: 51987654321)"
                value={nuevoForm.telefono}
                onChange={(e) => setNuevoForm({ ...nuevoForm, telefono: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              />
              <input
                placeholder="Email"
                value={nuevoForm.email}
                onChange={(e) => setNuevoForm({ ...nuevoForm, email: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              />
              <select
                value={nuevoForm.canal}
                onChange={(e) => setNuevoForm({ ...nuevoForm, canal: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              >
                {Object.entries(CANAL_CFG).filter(([k]) => k !== "manual").map(([k, v]) => (
                  <option key={k} value={k}>{v.icon} {v.label}</option>
                ))}
              </select>
              <textarea
                placeholder="Notas iniciales"
                value={nuevoForm.notas}
                onChange={(e) => setNuevoForm({ ...nuevoForm, notas: e.target.value })}
                rows={2}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              />
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setNuevoContactoModal(false)}
                className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={crearContacto}
                disabled={!nuevoForm.nombre.trim()}
                className="flex-1 bg-[#0b315f] text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-[#1262bd] disabled:opacity-40"
              >
                Crear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
