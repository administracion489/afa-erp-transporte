"use client";
import React, { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import {
  telefonoLegible, telefonoDeContacto, nombreEsElNumero, coincideBusquedaTelefono,
} from "@/lib/crm-telefono";
import { avisosAutomaticosDeTelefono, etiquetaAviso, type AvisoAutomatico } from "@/lib/crm-avisos-automaticos";

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
  contacto_id: string; crm_contactos: Contacto; created_at?: string;
  ia_pausada?: boolean; borrador_ia?: string | null; borrador_ia_at?: string | null;
  _ultimo_texto?: string;
  // Número de la empresa por el que entró (los 2 números del WABA caen en este
  // mismo Inbox). NULL en conversaciones anteriores a ago-2026.
  display_phone_number?: string | null; phone_number_id?: string | null;
};

// Alias legibles para los números que ya conocemos. NO es la lista de números: esa se
// descubre de los datos (ver cargarNumeros), así que un número recién conectado aparece
// solo en el filtro sin tocar código. Lo que no esté aquí se muestra como "+51…".
const ALIAS_NUMERO: Record<string, string> = {
  "966707225": "Ventas",
  "905438216": "Avisos",
};

// Meta manda display_phone_number como "51966707225" (sin +). Se filtra por ahí y no por
// phone_number_id, que es un id interno y vive en variables de entorno del servidor.
//
// SÓLO para los números DE LA EMPRESA. Para el número del CLIENTE usa
// formatearTelefono/telefonoLegible de @/lib/crm-telefono: si un cliente cayera aquí y su
// número terminase igual que uno nuestro, se pintaría con el alias "Ventas"/"Avisos".
const formatearNumero = (d: string) => {
  const alias = Object.entries(ALIAS_NUMERO).find(([suf]) => d.endsWith(suf))?.[1];
  const legible = d.startsWith("51") ? `+51 ${d.slice(2)}` : `+${d}`;
  return alias ? `${alias} · ${legible}` : legible;
};

type Mensaje = {
  id: string; conversacion_id: string; direccion: "entrante" | "saliente";
  tipo: string; contenido?: string; media_url?: string;
  enviado_por?: string; error?: string; created_at: string;
  generado_por_ia?: boolean;
};

type AccionIA = {
  id: string; conversacion_id: string; tipo: "cotizacion" | "reserva";
  resumen?: string; payload: any; estado: string; created_at?: string;
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
  const [numeroFiltro, setNumeroFiltro] = useState<string>("todos");
  const [numeros, setNumeros] = useState<string[]>([]);
  const [conectarWaModal, setConectarWaModal] = useState(false);
  const [estadoFiltro, setEstadoFiltro] = useState<"abierta" | "en_progreso" | "resuelta">("abierta");
  const [busqueda, setBusqueda] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [acciones, setAcciones] = useState<AccionIA[]>([]);
  const [avisos, setAvisos] = useState<AvisoAutomatico[]>([]);
  const [pidiendoIA, setPidiendoIA] = useState(false);
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

    // Sólo aplica a WhatsApp: los demás canales no tienen número de la empresa, así que
    // filtrar por él los dejaría a todos fuera con el selector ya oculto — una lista
    // vacía sin motivo visible.
    const filtraNumero = numeroFiltro !== "todos" && (canalFiltro === "todos" || canalFiltro === "whatsapp");
    if (filtraNumero) q = q.eq("display_phone_number", numeroFiltro);

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
  }, [canalFiltro, estadoFiltro, numeroFiltro]);

  useEffect(() => { cargarConvs(); }, [cargarConvs]);

  // Los números de la empresa se DESCUBREN de las conversaciones, no se declaran en
  // código: al conectar uno nuevo aparece solo en el filtro. Sin filtrar por canal/estado
  // para que la lista no cambie según lo que se esté mirando.
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("crm_conversaciones")
        .select("display_phone_number")
        .not("display_phone_number", "is", null)
        .limit(2000);
      const unicos = new Set<string>((data ?? []).map((r: any) => String(r.display_phone_number)));
      setNumeros([...unicos].sort());
    })();
  }, []);

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

  const cargarAcciones = useCallback(async (convId: string) => {
    const { data } = await supabase
      .from("crm_acciones_ia")
      .select("*")
      .eq("conversacion_id", convId)
      .eq("estado", "pendiente")
      .order("created_at", { ascending: false });
    setAcciones((data ?? []) as AccionIA[]);
  }, []);

  // Qué recordatorio/aviso automático (fuera del CRM) le llegó a este contacto ANTES de
  // que arrancara esta conversación. Sólo aplica a WhatsApp: los avisos automáticos hoy
  // sólo salen por ahí (o SMS de respaldo, que comparte número). Ver
  // lib/crm-avisos-automaticos.ts para el porqué del filtro "antes de".
  const cargarAvisosAutomaticos = useCallback(async (conv: Conversacion) => {
    const tel = telefonoDeContacto(conv.crm_contactos);
    if (conv.canal !== "whatsapp" || !tel) { setAvisos([]); return; }
    setAvisos(await avisosAutomaticosDeTelefono(supabase, tel, conv.created_at, 3));
  }, []);

  useEffect(() => {
    if (selected) {
      cargarMensajes(selected.id);
      cargarAcciones(selected.id);
      // Marcar como leído
      supabase.from("crm_conversaciones").update({ no_leidos: 0 }).eq("id", selected.id);
    } else {
      setAcciones([]);
    }
  }, [selected, cargarMensajes, cargarAcciones]);

  // Efecto aparte: los avisos automáticos no cambian con cada patch de realtime
  // (borrador, ia_pausada) que reasigna `selected`, así que se guarda el id ya
  // consultado en un ref para no reconsultar notificaciones_enviadas en cada uno de esos.
  const avisosCargadosDe = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) { avisosCargadosDe.current = null; setAvisos([]); return; }
    if (avisosCargadosDe.current === selected.id) return;
    avisosCargadosDe.current = selected.id;
    cargarAvisosAutomaticos(selected);
  }, [selected, cargarAvisosAutomaticos]);

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
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "crm_conversaciones" }, (payload) => {
        const upd = payload.new as Conversacion;
        // Refrescar el hilo abierto (borrador IA, pausa, estado) sin perder el contacto embebido
        setSelected((prev) =>
          prev && prev.id === upd.id
            ? { ...prev, ia_pausada: upd.ia_pausada, borrador_ia: upd.borrador_ia, borrador_ia_at: upd.borrador_ia_at, estado: upd.estado }
            : prev
        );
        cargarConvs();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_acciones_ia" }, (payload) => {
        const row = (payload.new ?? payload.old) as AccionIA;
        if (selected && row?.conversacion_id === selected.id) cargarAcciones(selected.id);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [selected, cargarConvs, cargarAcciones]);

  // ── Enviar mensaje ─────────────────────────────────────────────────────

  const enviar = async (override?: string) => {
    const base = override ?? reply;
    if (!base.trim() || !selected || enviando) return;
    setEnviando(true);
    const texto = base.trim();
    if (override === undefined) setReply("");

    // La ruta exige sesión: envía texto libre a clientes reales.
    const { data: s } = await supabase.auth.getSession();
    const res = await fetch("/api/crm/mensajes/enviar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s?.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ conversacion_id: selected.id, texto }),
    });
    const data = await res.json();
    setEnviando(false);

    if (!data.ok) showToast(data.error ?? "Error al enviar", false);
    else {
      // Al enviar (manual o aprobando un borrador), el borrador IA queda obsoleto
      if (selected.borrador_ia) await limpiarBorrador(selected.id);
      cargarMensajes(selected.id);
      cargarConvs();
    }
  };

  // ── Agente IA ────────────────────────────────────────────────────────────

  const limpiarBorrador = async (convId: string) => {
    await supabase.from("crm_conversaciones").update({ borrador_ia: null, borrador_ia_at: null }).eq("id", convId);
    setSelected((prev) => (prev && prev.id === convId ? { ...prev, borrador_ia: null } : prev));
  };

  const pedirRespuestaIA = async () => {
    if (!selected || pidiendoIA) return;
    setPidiendoIA(true);
    try {
      const res = await fetch("/api/crm/ia/responder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversacion_id: selected.id, forzar_borrador: true }),
      });
      const data = await res.json();
      if (data.ok && data.texto) {
        setSelected((prev) => (prev && prev.id === selected.id ? { ...prev, borrador_ia: data.texto } : prev));
        showToast("La IA preparó una sugerencia");
      } else {
        showToast(data.error || data.motivo || "La IA no generó respuesta", false);
      }
    } catch {
      showToast("Error al pedir respuesta a la IA", false);
    }
    setPidiendoIA(false);
  };

  const editarBorrador = async () => {
    if (!selected?.borrador_ia) return;
    setReply(selected.borrador_ia);
    await limpiarBorrador(selected.id);
    replyRef.current?.focus();
  };

  const toggleIaPausada = async () => {
    if (!selected) return;
    const nuevo = !selected.ia_pausada;
    await supabase.from("crm_conversaciones").update({ ia_pausada: nuevo }).eq("id", selected.id);
    setSelected({ ...selected, ia_pausada: nuevo });
    showToast(nuevo ? "IA pausada en este chat" : "IA reactivada en este chat");
  };

  const resolverAccion = async (accionId: string, decision: "aprobar" | "rechazar") => {
    const res = await fetch("/api/crm/ia/accion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accion_id: accionId, decision }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(decision === "aprobar" ? "Propuesta aprobada y creada" : "Propuesta rechazada");
      if (selected) cargarAcciones(selected.id);
    } else {
      showToast(data.error ?? "Error al procesar la propuesta", false);
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
      c._ultimo_texto?.toLowerCase().includes(q) ||
      // Por número: se comparan sólo los dígitos, así que da igual si se teclea
      // "987654321", "+51 987 654 321" o "51-987-654-321".
      coincideBusquedaTelefono(c.crm_contactos, busqueda)
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
                onClick={() => setConectarWaModal(true)}
                title="Vincular el WhatsApp Business existente al CRM (coexistencia)"
                className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-[#25D366]/40 text-[#0b315f] hover:bg-[#25D366]/10 transition-colors"
              >
                📲 Conectar WhatsApp
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
            placeholder="Buscar por nombre, empresa o número..."
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

        {/* Filtro por número de la empresa. Sólo si hay más de uno: con uno solo no
            filtra nada y sería ruido. */}
        {(canalFiltro === "todos" || canalFiltro === "whatsapp") && numeros.length > 1 && (
          <div className="px-3 pt-2 pb-1 border-b border-gray-100">
            <select
              value={numeroFiltro}
              onChange={(e) => setNumeroFiltro(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:outline-none focus:ring-1 focus:ring-[#0b315f]/30"
            >
              <option value="todos">Todos los números ({numeros.length})</option>
              {numeros.map((n) => (
                <option key={n} value={n}>{formatearNumero(n)}</option>
              ))}
            </select>
          </div>
        )}

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
                          {nombreEsElNumero(c.crm_contactos)
                            ? telefonoLegible(c.crm_contactos)
                            : c.crm_contactos?.nombre ?? "Sin nombre"}
                        </span>
                        <span className="text-[10px] text-gray-400 flex-shrink-0">{fmtHora(c.ultimo_mensaje_at)}</span>
                      </div>
                      {c.crm_contactos?.empresa && (
                        <div className="text-[11px] text-gray-400 truncate">{c.crm_contactos.empresa}</div>
                      )}
                      {/* El número también en la lista: se barre la bandeja buscando "quién
                          me escribió" sin tener que abrir cada hilo. Se omite cuando el
                          nombre YA es el número, para no pintarlo dos veces. */}
                      {!nombreEsElNumero(c.crm_contactos) && telefonoLegible(c.crm_contactos) && (
                        <div className="text-[11px] text-gray-400 truncate">
                          📞 {telefonoLegible(c.crm_contactos)}
                        </div>
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
                <div className="font-semibold text-gray-900">
                  {/* Sin nombre de perfil, el webhook guarda el número como nombre: en ese
                      caso se muestra formateado y no se repite abajo. */}
                  {nombreEsElNumero(selected.crm_contactos)
                    ? telefonoLegible(selected.crm_contactos)
                    : selected.crm_contactos?.nombre}
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  {selected.crm_contactos?.empresa && <span>{selected.crm_contactos.empresa}</span>}
                  {/* Número DEL CLIENTE. Va con su propio botón de copiar porque para eso
                      se mira: para llamar o guardarlo. No confundir con el chip gris de la
                      derecha, que es el número DE LA EMPRESA por el que entró el hilo. */}
                  {!nombreEsElNumero(selected.crm_contactos) && telefonoLegible(selected.crm_contactos) && (
                    <span className="flex items-center gap-1">
                      <span>·</span>
                      <button
                        onClick={() => {
                          const t = telefonoDeContacto(selected.crm_contactos);
                          if (t) {
                            navigator.clipboard?.writeText(t);
                            showToast("Número copiado");
                          }
                        }}
                        title="Copiar el número del contacto"
                        className="font-medium text-gray-700 hover:text-[#0b315f] transition-colors"
                      >
                        📞 {telefonoLegible(selected.crm_contactos)}
                      </button>
                    </span>
                  )}
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

              {/* Por qué número de la empresa entró este hilo */}
              {selected.display_phone_number && (
                <span
                  className="text-xs px-2.5 py-1 rounded-full font-medium bg-gray-100 text-gray-600"
                  title="Número de la empresa por el que entró esta conversación"
                >
                  📲 {formatearNumero(selected.display_phone_number)}
                </span>
              )}

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

              {/* Control de IA por conversación */}
              <button
                onClick={toggleIaPausada}
                title={selected.ia_pausada ? "La IA no responderá en este chat" : "La IA puede responder en este chat"}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                  selected.ia_pausada
                    ? "bg-gray-100 text-gray-500 hover:bg-gray-200"
                    : "bg-green-100 text-green-700 hover:bg-green-200"
                }`}
              >
                {selected.ia_pausada ? "🤖 IA pausada" : "🤖 IA activa"}
              </button>

              <a
                href="/crm/pipeline"
                className="text-xs bg-[#0b315f]/10 text-[#0b315f] font-semibold px-3 py-1.5 rounded-lg hover:bg-[#0b315f]/20 transition-colors"
              >
                Ver Pipeline
              </a>
            </div>
          </div>

          {/* ── Por qué escribió: el aviso automático justo antes de esta conversación ──
              Recordatorios/avisos que el sistema le mandó a este número FUERA del CRM
              (lib/notificaciones.ts nunca escribe en crm_mensajes). avisos[0] es SIEMPRE
              el más cercano — y anterior — al inicio del hilo (filtrado en
              cargarAvisosAutomaticos con conv.created_at); si no hay ninguno antes, la
              conversación fue espontánea y no se pinta nada. No se guarda el texto exacto
              que se envió, sólo el qué/cuándo — nunca se finge citarlo. */}
          {avisos.length > 0 && (
            <div className="bg-amber-50/60 border-b border-amber-100 px-5 py-2.5">
              <div className="text-xs text-amber-800">
                <span className="font-semibold">📨 Posible motivo:</span> justo antes de
                escribir, el sistema le había enviado un{" "}
                <span className="font-medium">{etiquetaAviso(avisos[0]).toLowerCase()}</span>
                {avisos[0].reserva_id && <> (reserva #{avisos[0].reserva_id})</>}
                {" "}el{" "}
                {new Date(avisos[0].created_at).toLocaleString("es-PE", {
                  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                })}.
              </div>
              {avisos.length > 1 && (
                <div className="text-[11px] text-amber-600 mt-0.5">
                  + {avisos.length - 1} aviso{avisos.length > 2 ? "s" : ""} más antes de esa fecha
                </div>
              )}
            </div>
          )}

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
                        {m.generado_por_ia && <span className="mr-1" title="Generado por IA">✨</span>}
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

          {/* ── Propuestas de la IA pendientes de confirmación ── */}
          {acciones.length > 0 && (
            <div className="bg-amber-50 border-t border-amber-100 px-5 py-3 space-y-2">
              {acciones.map((a) => (
                <div key={a.id} className="bg-white border border-amber-200 rounded-xl p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide">
                      ✨ Propuesta de {a.tipo === "cotizacion" ? "cotización" : "reserva"} (IA)
                    </div>
                    <div className="text-sm text-gray-700 truncate">{a.resumen}</div>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => resolverAccion(a.id, "rechazar")}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                    >
                      Rechazar
                    </button>
                    <button
                      onClick={() => resolverAccion(a.id, "aprobar")}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-[#0b315f] text-white font-semibold hover:bg-[#1262bd]"
                    >
                      Aprobar y crear
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Sugerencia de la IA (borrador para aprobar) ── */}
          {selected.borrador_ia && selected.estado !== "resuelta" && (
            <div className="bg-[#0b315f]/5 border-t border-[#0b315f]/10 px-5 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-sm">✨</span>
                <span className="text-xs font-semibold text-[#0b315f]">Sugerencia de la IA</span>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap bg-white border border-[#0b315f]/10 rounded-xl p-3">
                {selected.borrador_ia}
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => enviar(selected.borrador_ia!)}
                  disabled={enviando}
                  className="text-xs bg-[#0b315f] text-white font-semibold px-3 py-1.5 rounded-lg hover:bg-[#1262bd] disabled:opacity-50"
                >
                  {enviando ? "Enviando…" : "Enviar"}
                </button>
                <button onClick={editarBorrador} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                  Editar
                </button>
                <button onClick={() => limpiarBorrador(selected.id)} className="text-xs px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-600">
                  Descartar
                </button>
              </div>
            </div>
          )}

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
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={pedirRespuestaIA}
                    disabled={pidiendoIA}
                    title="Pedir una sugerencia de respuesta a la IA"
                    className="border border-[#0b315f]/30 text-[#0b315f] px-4 py-2 rounded-xl text-sm font-semibold
                      hover:bg-[#0b315f]/5 transition-colors disabled:opacity-40"
                  >
                    {pidiendoIA ? "…" : "✨ IA"}
                  </button>
                  <button
                    onClick={() => enviar()}
                    disabled={!reply.trim() || enviando}
                    className="bg-[#0b315f] text-white px-4 py-2.5 rounded-xl text-sm font-semibold
                      hover:bg-[#1262bd] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {enviando ? "…" : "Enviar"}
                  </button>
                </div>
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

      {/* ── Modal conectar WhatsApp Business existente (coexistencia) ── */}
      {conectarWaModal && (
        <ConectarWhatsAppModal onClose={() => setConectarWaModal(false)} />
      )}
    </div>
  );
}

// ── Vincular un WhatsApp Business del celular al CRM ─────────────────────────
// Mismo flujo que public/conectar-whatsapp.html (Embedded Signup de Meta,
// featureType "whatsapp_business_app_onboarding" = coexistencia), pero embebido como
// modal para no salir del CRM. El número lo elige el usuario en la ventana de Meta:
// aquí no hay ninguno fijo. Al terminar, el número se registra en whatsapp_numeros
// para que además de recibir se pueda ENVIAR por él.
declare global {
  interface Window { FB?: any; fbAsyncInit?: () => void; }
}

const WA_APP_ID = "1776032736701552";
const WA_CONFIG_ID = "1912835406054543";

async function registrarNumero(phoneId: string, wabaId?: string): Promise<string> {
  try {
    const { data: s } = await supabase.auth.getSession();
    const r = await fetch("/api/crm/whatsapp/registrar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s?.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ phone_number_id: phoneId, waba_id: wabaId }),
    });
    const d = await r.json();
    if (!r.ok) return `Conectado en Meta, pero no quedó registrado: ${d.error ?? r.status}`;
    return `Registrado como "${d.numero?.alias}". Asígnale un uso en Configuración para enviar por él.`;
  } catch (e: any) {
    return `Conectado en Meta, pero falló el registro: ${e?.message ?? e}`;
  }
}

type NumeroFila = {
  id: string; alias: string; display_phone_number: string | null;
  usa_crm: boolean; usa_avisos: boolean; usa_campanas: boolean; activo: boolean;
};

function ConectarWhatsAppModal({ onClose }: { onClose: () => void }) {
  const [paso, setPaso] = useState<"cargando" | "listo" | "conectando" | "ok" | "error">("cargando");
  const [detalle, setDetalle] = useState<string>("");
  const [codigo, setCodigo] = useState<string>("");
  const [registro, setRegistro] = useState<string>("");
  // null = aún cargando; [] = la tabla existe pero está vacía, o todavía no se creó.
  const [numerosTabla, setNumerosTabla] = useState<NumeroFila[] | null>(null);
  const [detectando, setDetectando] = useState(false);
  const [resultadoDeteccion, setResultadoDeteccion] = useState<string>("");

  const cargarTabla = useCallback(async () => {
    // Si la tabla aún no existe el error se ignora: se muestra la lista vacía con la
    // explicación de que se está usando el respaldo del entorno.
    const { data } = await supabase
      .from("whatsapp_numeros")
      .select("id, alias, display_phone_number, usa_crm, usa_avisos, usa_campanas, activo")
      .order("alias");
    setNumerosTabla((data ?? []) as NumeroFila[]);
  }, []);

  useEffect(() => { cargarTabla(); }, [cargarTabla]);

  const detectar = async () => {
    setDetectando(true);
    setResultadoDeteccion("");
    try {
      const { data: s } = await supabase.auth.getSession();
      const r = await fetch("/api/crm/whatsapp/detectar", {
        method: "POST",
        headers: { Authorization: `Bearer ${s?.session?.access_token ?? ""}` },
      });
      const d = await r.json();
      if (!r.ok) {
        setResultadoDeteccion(`No se pudo detectar: ${d.error ?? r.status}`);
      } else {
        const partes: string[] = [];
        if (d.creados?.length) partes.push(`Nuevos: ${d.creados.join(", ")}`);
        if (d.actualizados?.length) partes.push(`Actualizados: ${d.actualizados.join(", ")}`);
        if (!partes.length) partes.push("Sin cambios: ya estaba todo registrado.");
        if (d.avisos?.length) partes.push(`Avisos: ${d.avisos.join(" · ")}`);
        setResultadoDeteccion(partes.join("\n"));
        await cargarTabla();
      }
    } catch (e: any) {
      setResultadoDeteccion(`Error al detectar: ${e?.message ?? e}`);
    }
    setDetectando(false);
  };

  useEffect(() => {
    function onMensaje(event: MessageEvent) {
      if (event.origin !== "https://www.facebook.com" && event.origin !== "https://web.facebook.com") return;
      try {
        const data = JSON.parse(event.data);
        if (data.type !== "WA_EMBEDDED_SIGNUP") return;
        if (["FINISH", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_ONLY_WABA"].includes(data.event)) {
          setPaso("ok");
          const phoneId = data.data?.phone_number_id;
          const wabaId  = data.data?.waba_id;
          setDetalle(`phone_number_id: ${phoneId ?? "—"} · waba_id: ${wabaId ?? "—"}`);
          // Guardarlo para poder ENVIAR por este número, no sólo recibir.
          if (phoneId) {
            registrarNumero(phoneId, wabaId).then((msg) => {
              setRegistro(msg);
              cargarTabla();   // que el número recién conectado salga en la lista de arriba
            });
          }
        } else if (data.event === "CANCEL") {
          setPaso("error");
          setDetalle(`Se canceló en: ${data.data?.current_step ?? "?"}`);
        }
      } catch { /* mensajes que no son JSON del embedded signup */ }
    }
    window.addEventListener("message", onMensaje);

    if (window.FB) {
      setPaso("listo");
    } else {
      window.fbAsyncInit = () => {
        window.FB!.init({ appId: WA_APP_ID, cookie: true, xfbml: false, version: "v23.0" });
        setPaso("listo");
      };
      if (!document.getElementById("facebook-jssdk")) {
        const js = document.createElement("script");
        js.id = "facebook-jssdk";
        js.src = "https://connect.facebook.net/es_LA/sdk.js";
        document.body.appendChild(js);
      }
    }
    return () => window.removeEventListener("message", onMensaje);
  }, []);

  const lanzar = () => {
    if (!window.FB) return;
    setPaso("conectando");
    window.FB.login(
      (response: any) => {
        if (response.authResponse?.code) {
          setCodigo(response.authResponse.code);
        } else if (paso !== "ok") {
          setPaso("error");
          setDetalle("No se completó la conexión (se cerró la ventana).");
        }
      },
      {
        config_id: WA_CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
      }
    );
  };

  const USOS: { campo: keyof NumeroFila; etiqueta: string }[] = [
    { campo: "usa_crm", etiqueta: "Atención" },
    { campo: "usa_avisos", etiqueta: "Avisos" },
    { campo: "usa_campanas", etiqueta: "Campañas" },
  ];

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 text-center max-h-[92vh] overflow-y-auto">
        <h3 className="text-lg font-bold text-[#0b315f] mb-1">Números de WhatsApp</h3>

        {/* ── Números ya registrados ── */}
        <div className="text-left mt-4 mb-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Registrados
            </span>
            <button
              onClick={detectar}
              disabled={detectando}
              title="Preguntarle a Meta qué números tienes y registrarlos"
              className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-[#0b315f]/30 text-[#0b315f] hover:bg-[#0b315f]/5 disabled:opacity-40"
            >
              {detectando ? "Detectando…" : "↻ Detectar números"}
            </button>
          </div>

          {numerosTabla === null ? (
            <p className="text-xs text-gray-400 py-2">Cargando…</p>
          ) : numerosTabla.length === 0 ? (
            <p className="text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-xl p-3">
              Todavía no hay números registrados. Toca <b>Detectar números</b> para que el ERP
              se los pida a Meta. Mientras tanto se usan los de las variables de entorno, así
              que los envíos siguen funcionando igual.
            </p>
          ) : (
            <div className="rounded-xl border border-gray-100 overflow-hidden">
              {numerosTabla.map((n) => (
                <div key={n.id} className="px-3 py-2 border-b last:border-b-0 border-gray-50">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800">{n.alias}</span>
                    <span className="text-xs text-gray-400 font-mono">
                      {n.display_phone_number ? formatearNumero(n.display_phone_number) : "sin número"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {USOS.filter((u) => n[u.campo]).map((u) => (
                      <span key={u.campo} className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">
                        {u.etiqueta}
                      </span>
                    ))}
                    {!USOS.some((u) => n[u.campo]) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                        sin uso asignado — no envía
                      </span>
                    )}
                    {!n.activo && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">inactivo</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {resultadoDeteccion && (
            <p className="text-xs text-gray-600 mt-2 whitespace-pre-line bg-gray-50 border border-gray-200 rounded-xl p-2.5">
              {resultadoDeteccion}
            </p>
          )}
        </div>

        {/* ── Conectar uno nuevo ── */}
        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm text-gray-500 mb-3 text-left">
            <b className="text-[#0b315f]">Conectar otro número.</b> Vincula un WhatsApp Business
            al CRM sin dejar de usarlo desde el celular. El número lo eliges tú en la ventana de
            Meta: puede ser uno ya existente o uno nuevo. Ten a mano el celular donde está esa cuenta.
          </p>

        <button
          onClick={lanzar}
          disabled={paso === "cargando" || paso === "conectando"}
          className="w-full bg-[#25D366] hover:bg-[#1fb855] disabled:bg-gray-300 text-white font-bold text-sm py-3 rounded-xl transition-colors"
        >
          {paso === "cargando" ? "Cargando conexión con Meta…" : paso === "conectando" ? "Esperando el QR…" : "Conectar mi WhatsApp"}
        </button>

        <div className="text-left mt-4 rounded-xl overflow-hidden border border-gray-100">
          {[
            { txt: "1. Toca el botón verde de arriba", activa: paso === "listo" },
            { txt: "2. Elige el número en la ventana de Meta (existente o nuevo)", activa: paso === "conectando" },
            { txt: "3. Si es un número que ya usas: llega un mensaje al celular → escanea el QR", activa: false },
            { txt: "4. El número queda conectado y sus mensajes entran al Inbox", ok: paso === "ok" },
          ].map((p, i) => (
            <div
              key={i}
              className={`px-3 py-2 text-xs border-b last:border-b-0 border-gray-50 ${
                p.ok ? "bg-emerald-50 text-emerald-800 font-medium" : p.activa ? "bg-[#0b315f]/5 text-[#0b315f] font-medium" : "text-gray-500"
              }`}
            >
              {p.txt}
            </div>
          ))}
        </div>

        {codigo && (
          <div className="mt-4 bg-gray-50 border border-dashed border-gray-300 rounded-xl p-3 text-left text-xs font-mono break-all">
            <b className="text-[#0b315f]">Código de autorización (guárdalo, aún falta activarlo):</b>
            <div className="mt-1">{codigo}</div>
          </div>
        )}
        {paso === "ok" && (
          <div className="mt-4 bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-left text-xs text-emerald-800">
            <b>Número conectado en Meta ✓</b>
            <div className="mt-1 font-mono break-all">{detalle}</div>
            {registro && <div className="mt-2 pt-2 border-t border-emerald-200">{registro}</div>}
          </div>
        )}
        {paso === "error" && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-3 text-left text-xs text-red-700">{detalle}</div>
        )}
        </div>

        <button onClick={onClose} className="mt-5 text-xs text-gray-400 hover:text-gray-600">
          Cerrar
        </button>
      </div>
    </div>
  );
}
