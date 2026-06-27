"use client";
import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// ── Tipos ────────────────────────────────────────────────────────────────────
type Goal = { titulo: string; instrucciones: string };
type Agente = {
  id: string;
  nombre: string;
  activo: boolean;
  modelo: string;
  persona: string;
  empresa_contexto: string;
  idioma: string;
  goals: Goal[];
  conocimiento: string;
  canales: string[];
  canales_autonomos: string[];
  horario_activo: boolean;
  hora_inicio: string;
  hora_fin: string;
  delay_segundos: number;
  max_turnos_auto: number;
  escalar_si: string;
  firma: string;
};

const CANALES = [
  { key: "whatsapp", label: "WhatsApp", icon: "💬" },
  { key: "messenger", label: "Messenger", icon: "💙" },
  { key: "instagram", label: "Instagram", icon: "📸" },
  { key: "gmail", label: "Gmail", icon: "📧" },
];

const MODELOS = [
  { key: "claude-opus-4-8", label: "Claude Opus 4.8", nota: "Máxima calidad y razonamiento" },
  { key: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", nota: "Equilibrio calidad/costo" },
  { key: "claude-haiku-4-5", label: "Claude Haiku 4.5", nota: "Más rápido y económico" },
];

const TABS = ["Personalidad", "Goals", "Conocimiento", "Canales & Modo", "Ajustes"] as const;
type Tab = (typeof TABS)[number];

const input =
  "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-xs font-semibold text-gray-500 mb-1.5";

export default function AgenteIAPage() {
  const [agente, setAgente] = useState<Agente | null>(null);
  const [cargando, setCargando] = useState(true);
  const [faltaTabla, setFaltaTabla] = useState(false);
  const [tab, setTab] = useState<Tab>("Personalidad");
  const [guardando, setGuardando] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Probador chat
  type ChatMsg = { role: "user" | "afita"; texto: string; herramientas?: string[]; error?: string };
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [pruebaMsg, setPruebaMsg] = useState("");
  const [probando, setProbando] = useState(false);
  const chatEndRef = React.useRef<HTMLDivElement>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("crm_agentes_ia").select("*").order("created_at").limit(1);
      if (error) {
        setFaltaTabla(true);
      } else if (data && data[0]) {
        const a = data[0];
        setAgente({
          ...a,
          goals: Array.isArray(a.goals) ? a.goals : [],
          canales: Array.isArray(a.canales) ? a.canales : [],
          canales_autonomos: Array.isArray(a.canales_autonomos) ? a.canales_autonomos : [],
        });
      }
      setCargando(false);
    })();
  }, []);

  const set = <K extends keyof Agente>(k: K, v: Agente[K]) => setAgente((a) => (a ? { ...a, [k]: v } : a));

  const guardar = async () => {
    if (!agente) return;
    setGuardando(true);
    const { id, ...patch } = agente;
    const { error } = await supabase
      .from("crm_agentes_ia")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
    setGuardando(false);
    showToast(error ? "Error al guardar" : "Configuración guardada", !error);
  };

  const toggleActivo = async () => {
    if (!agente) return;
    const nuevo = !agente.activo;
    set("activo", nuevo);
    await supabase.from("crm_agentes_ia").update({ activo: nuevo }).eq("id", agente.id);
    showToast(nuevo ? "Agente activado" : "Agente desactivado");
  };

  const probar = async () => {
    const texto = pruebaMsg.trim();
    if (!texto || probando) return;
    setPruebaMsg("");
    const msgsConUser: ChatMsg[] = [...chatMsgs, { role: "user", texto }];
    setChatMsgs(msgsConUser);
    setProbando(true);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    // Construir historial Anthropic alternando user/assistant
    const historial: { role: "user" | "assistant"; content: string }[] = [];
    for (const m of chatMsgs) {
      if (m.role === "user") historial.push({ role: "user", content: m.texto });
      else if (m.texto) historial.push({ role: "assistant", content: m.texto });
    }
    try {
      const res = await fetch("/api/crm/ia/probar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensaje: texto, historial }),
      });
      const data = await res.json();
      setChatMsgs((prev) => [...prev, { role: "afita", texto: data.texto ?? "", herramientas: data.herramientas, error: data.error }]);
    } catch (e: any) {
      setChatMsgs((prev) => [...prev, { role: "afita", texto: "", error: e?.message ?? "Error de red" }]);
    }
    setProbando(false);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  // ── Estados de carga / falta de migración ──────────────────────────────────
  if (cargando) return <div className="p-10 text-center text-gray-400">Cargando…</div>;

  if (faltaTabla || !agente)
    return (
      <div className="max-w-xl mx-auto mt-16 bg-white border border-amber-200 rounded-2xl p-8 text-center">
        <div className="text-4xl mb-3">⚙️</div>
        <h2 className="text-lg font-bold text-[#0b315f] mb-2">Falta crear las tablas del agente</h2>
        <p className="text-sm text-gray-500">
          Ejecuta el archivo <code className="bg-gray-100 px-1.5 py-0.5 rounded">supabase/crm-agente-ia.sql</code> en el
          SQL Editor de Supabase y recarga esta página.
        </p>
      </div>
    );

  const toggleCanal = (k: string) => {
    const tiene = agente.canales.includes(k);
    set("canales", tiene ? agente.canales.filter((c) => c !== k) : [...agente.canales, k]);
    if (tiene) set("canales_autonomos", agente.canales_autonomos.filter((c) => c !== k));
  };
  const toggleAutonomo = (k: string) => {
    if (!agente.canales.includes(k)) return;
    set(
      "canales_autonomos",
      agente.canales_autonomos.includes(k)
        ? agente.canales_autonomos.filter((c) => c !== k)
        : [...agente.canales_autonomos, k]
    );
  };

  return (
    <div className="max-w-5xl mx-auto p-5 pb-24">
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white ${
            toast.ok ? "bg-[#0b315f]" : "bg-red-600"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="bg-white border border-gray-100 rounded-2xl p-5 mb-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-[#0b315f]/10 text-[#0b315f] flex items-center justify-center text-xl">
            🤖
          </div>
          <div>
            <h1 className="text-lg font-bold text-[#0b315f]">{agente.nombre || "Agente IA"}</h1>
            <p className="text-xs text-gray-400">Asistente conversacional con Claude</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <select value={agente.modelo} onChange={(e) => set("modelo", e.target.value)} className="text-xs border border-gray-200 rounded-lg px-2.5 py-2">
            {MODELOS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>

          {/* Master switch */}
          <button
            onClick={toggleActivo}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${
              agente.activo ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${agente.activo ? "bg-green-500" : "bg-gray-400"}`} />
            {agente.activo ? "Activo" : "Inactivo"}
          </button>

          <button
            onClick={guardar}
            disabled={guardando}
            className="bg-[#0b315f] text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-[#1262bd] disabled:opacity-50"
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </div>

      <div className="flex gap-4">
        {/* Columna principal */}
        <div className="flex-1 min-w-0">
          {/* Tabs */}
          <div className="flex gap-1 border-b border-gray-100 mb-5 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  tab === t ? "border-[#0b315f] text-[#0b315f]" : "border-transparent text-gray-400 hover:text-gray-600"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* ── Personalidad ── */}
          {tab === "Personalidad" && (
            <div className="space-y-4 bg-white border border-gray-100 rounded-2xl p-5">
              <div>
                <label className={label}>Nombre del agente</label>
                <input className={input} value={agente.nombre} onChange={(e) => set("nombre", e.target.value)} />
              </div>
              <div>
                <label className={label}>Personalidad y tono (rol del bot)</label>
                <textarea
                  className={input}
                  rows={4}
                  value={agente.persona}
                  onChange={(e) => set("persona", e.target.value)}
                  placeholder="Eres el asistente comercial de AFA Transportes. Hablas español peruano, cordial y profesional…"
                />
              </div>
              <div>
                <label className={label}>Contexto de la empresa</label>
                <textarea
                  className={input}
                  rows={3}
                  value={agente.empresa_contexto}
                  onChange={(e) => set("empresa_contexto", e.target.value)}
                  placeholder="Qué hace AFA, qué servicios ofrece, zonas de cobertura…"
                />
              </div>
              <div className="w-40">
                <label className={label}>Idioma principal</label>
                <select className={input} value={agente.idioma} onChange={(e) => set("idioma", e.target.value)}>
                  <option value="es">Español</option>
                  <option value="en">Inglés</option>
                </select>
              </div>
            </div>
          )}

          {/* ── Goals ── */}
          {tab === "Goals" && (
            <div className="space-y-3">
              <p className="text-xs text-gray-400 px-1">
                Los objetivos guían qué debe lograr el agente en cada conversación (igual que los “Goals” de Zolutium).
              </p>
              {agente.goals.map((g, i) => (
                <div key={i} className="bg-white border border-gray-100 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[#0b315f] font-bold text-sm">#{i + 1}</span>
                    <input
                      className={`${input} font-semibold`}
                      value={g.titulo}
                      placeholder="Título del objetivo"
                      onChange={(e) => {
                        const goals = [...agente.goals];
                        goals[i] = { ...goals[i], titulo: e.target.value };
                        set("goals", goals);
                      }}
                    />
                    <button
                      onClick={() => set("goals", agente.goals.filter((_, j) => j !== i))}
                      className="text-red-500 text-sm px-2 hover:bg-red-50 rounded-lg py-2"
                      title="Eliminar"
                    >
                      ✕
                    </button>
                  </div>
                  <textarea
                    className={input}
                    rows={2}
                    value={g.instrucciones}
                    placeholder="Instrucciones: qué debe preguntar, qué datos recoger, cómo actuar…"
                    onChange={(e) => {
                      const goals = [...agente.goals];
                      goals[i] = { ...goals[i], instrucciones: e.target.value };
                      set("goals", goals);
                    }}
                  />
                </div>
              ))}
              <button
                onClick={() => set("goals", [...agente.goals, { titulo: "", instrucciones: "" }])}
                className="w-full border-2 border-dashed border-gray-200 rounded-2xl py-3 text-sm text-gray-500 hover:border-[#0b315f] hover:text-[#0b315f]"
              >
                + Añadir objetivo
              </button>
            </div>
          )}

          {/* ── Conocimiento ── */}
          {tab === "Conocimiento" && (
            <div className="bg-white border border-gray-100 rounded-2xl p-5">
              <label className={label}>Base de conocimiento (FAQ, políticas, info de rutas)</label>
              <textarea
                className={input}
                rows={14}
                value={agente.conocimiento}
                onChange={(e) => set("conocimiento", e.target.value)}
                placeholder={
                  "Pega aquí todo lo que el agente debe saber: horarios de atención, políticas, rutas frecuentes, formas de pago, preguntas frecuentes y sus respuestas…"
                }
              />
              <p className="text-xs text-gray-400 mt-2">
                Además de esto, el agente consulta datos reales de tu ERP (rutas, precios históricos, flota, estado de
                servicios) mediante herramientas.
              </p>
            </div>
          )}

          {/* ── Canales & Modo ── */}
          {tab === "Canales & Modo" && (
            <div className="space-y-4">
              <div className="bg-white border border-gray-100 rounded-2xl p-5">
                <label className={label}>Canales que atiende el agente</label>
                <div className="flex flex-wrap gap-2">
                  {CANALES.map((c) => (
                    <button
                      key={c.key}
                      onClick={() => toggleCanal(c.key)}
                      className={`px-3 py-2 rounded-xl text-sm font-medium border transition-colors ${
                        agente.canales.includes(c.key)
                          ? "border-[#0b315f] bg-[#0b315f]/5 text-[#0b315f]"
                          : "border-gray-200 text-gray-400"
                      }`}
                    >
                      {c.icon} {c.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  En estos canales el agente genera una respuesta (borrador por defecto).
                </p>
              </div>

              <div className="bg-white border border-gray-100 rounded-2xl p-5">
                <label className={label}>Modo de respuesta</label>
                <div className="space-y-3 text-sm">
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-blue-50">
                    <span>🧑‍💼</span>
                    <div>
                      <div className="font-semibold text-gray-700">Copiloto (por defecto)</div>
                      <div className="text-gray-500 text-xs">
                        La IA redacta y deja la respuesta como <b>borrador</b> en el inbox. Tu equipo la revisa y envía
                        con un clic.
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="font-semibold text-gray-700 mb-2">⚡ Autonomía por canal</div>
                    <p className="text-xs text-gray-400 mb-2">
                      En los canales que actives aquí, la IA <b>envía sola</b> sin aprobación humana. Actívalos solo
                      cuando confíes en el agente.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {CANALES.filter((c) => agente.canales.includes(c.key)).map((c) => (
                        <button
                          key={c.key}
                          onClick={() => toggleAutonomo(c.key)}
                          className={`px-3 py-2 rounded-xl text-sm font-medium border transition-colors ${
                            agente.canales_autonomos.includes(c.key)
                              ? "border-amber-400 bg-amber-50 text-amber-700"
                              : "border-gray-200 text-gray-400"
                          }`}
                        >
                          {agente.canales_autonomos.includes(c.key) ? "⚡ " : ""}
                          {c.icon} {c.label}
                        </button>
                      ))}
                      {agente.canales.length === 0 && (
                        <span className="text-xs text-gray-400">Primero activa algún canal arriba.</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Ajustes ── */}
          {tab === "Ajustes" && (
            <div className="space-y-4 bg-white border border-gray-100 rounded-2xl p-5">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-semibold text-gray-700">Restringir autonomía a horario</label>
                  <p className="text-xs text-gray-400">Fuera de horario, la IA solo deja borradores.</p>
                </div>
                <button
                  onClick={() => set("horario_activo", !agente.horario_activo)}
                  className={`w-11 h-6 rounded-full relative transition-colors ${agente.horario_activo ? "bg-[#0b315f]" : "bg-gray-300"}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${agente.horario_activo ? "left-5" : "left-0.5"}`} />
                </button>
              </div>
              {agente.horario_activo && (
                <div className="flex gap-3">
                  <div>
                    <label className={label}>Desde</label>
                    <input type="time" className={input} value={agente.hora_inicio} onChange={(e) => set("hora_inicio", e.target.value)} />
                  </div>
                  <div>
                    <label className={label}>Hasta</label>
                    <input type="time" className={input} value={agente.hora_fin} onChange={(e) => set("hora_fin", e.target.value)} />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Espera antes de responder (seg)</label>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    className={input}
                    value={agente.delay_segundos}
                    onChange={(e) => set("delay_segundos", Number(e.target.value))}
                  />
                  <p className="text-[11px] text-gray-400 mt-1">Para parecer más humano (máx. 30).</p>
                </div>
                <div>
                  <label className={label}>Máx. turnos automáticos</label>
                  <input
                    type="number"
                    min={0}
                    className={input}
                    value={agente.max_turnos_auto}
                    onChange={(e) => set("max_turnos_auto", Number(e.target.value))}
                  />
                  <p className="text-[11px] text-gray-400 mt-1">Tras N respuestas IA, escala a humano (0 = sin límite).</p>
                </div>
              </div>

              <div>
                <label className={label}>Escalar a humano si el mensaje menciona</label>
                <input
                  className={input}
                  value={agente.escalar_si}
                  onChange={(e) => set("escalar_si", e.target.value)}
                  placeholder="reclamo, queja, hablar con una persona, factura, gerente"
                />
                <p className="text-[11px] text-gray-400 mt-1">Frases separadas por coma.</p>
              </div>

              <div>
                <label className={label}>Firma (se añade al final del mensaje)</label>
                <input className={input} value={agente.firma} onChange={(e) => set("firma", e.target.value)} placeholder="— AFA Transportes" />
              </div>
            </div>
          )}
        </div>

        {/* Probador chat (columna lateral) */}
        <div className="w-80 flex-shrink-0 hidden lg:block">
          <div className="bg-white border border-gray-100 rounded-2xl flex flex-col sticky top-4" style={{ height: "calc(100vh - 120px)" }}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <span className="text-base">✨</span>
                <h3 className="font-bold text-[#0b315f] text-sm">Probar agente</h3>
              </div>
              {chatMsgs.length > 0 && (
                <button onClick={() => setChatMsgs([])} className="text-[11px] text-gray-400 hover:text-red-400">
                  Limpiar
                </button>
              )}
            </div>

            {/* Burbujas */}
            <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2">
              {chatMsgs.length === 0 && (
                <p className="text-xs text-gray-400 text-center mt-6">
                  Escribe como si fueras un cliente.<br />No se envía nada real.
                </p>
              )}
              {chatMsgs.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                      m.role === "user"
                        ? "bg-[#0b315f] text-white rounded-br-sm"
                        : m.error
                        ? "bg-red-50 text-red-700 rounded-bl-sm"
                        : "bg-gray-100 text-gray-800 rounded-bl-sm"
                    }`}
                  >
                    {m.error ? m.error : m.texto}
                    {m.herramientas && m.herramientas.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {m.herramientas.map((h) => (
                          <span key={h} className="text-[10px] bg-[#0b315f]/15 text-[#0b315f] px-1.5 py-0.5 rounded-full font-medium">
                            🔧 {h}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {probando && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-3 py-2 text-sm text-gray-400">
                    Pensando…
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-gray-100 p-3 flex gap-2">
              <textarea
                className={`${input} flex-1 resize-none`}
                rows={2}
                value={pruebaMsg}
                onChange={(e) => setPruebaMsg(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); probar(); } }}
                placeholder="Escribe un mensaje…"
              />
              <button
                onClick={probar}
                disabled={probando || !pruebaMsg.trim()}
                className="bg-[#0b315f] text-white text-xs font-semibold px-3 rounded-xl hover:bg-[#1262bd] disabled:opacity-40"
              >
                ➤
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
