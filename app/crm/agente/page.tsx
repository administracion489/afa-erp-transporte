"use client";
import ContactosSinIA from "@/components/crm/ContactosSinIA";
import AjustesComportamiento from "@/components/crm/AjustesComportamiento";
import CoherenciaAgente, {
  AvisoCampo, AvisosAjuste, ProveedorCoherencia, enfocarFrase, idCampo, resaltarAjuste, type AccionesCoherencia,
} from "@/components/crm/CoherenciaAgente";
import { normalizarAjustes, mensajeDerivacionDefecto, TEMAS_AJUSTE, type AjustesIA } from "@/lib/crm-ia-ajustes";
import {
  auditarAgente, nuevasAlarmas,
  type CampoTexto, type ConfigAuditable, type Hallazgo,
} from "@/lib/crm-ia-coherencia";
import React, { useDeferredValue, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";

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
  pausa_humano_horas?: number | null;
  escalar_si: string;
  mensaje_derivacion?: string | null;
  comportamiento?: unknown;
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

const TABS = ["Personalidad", "Objetivos", "Conocimiento", "Canales & Modo", "Ajustes"] as const;
type Tab = (typeof TABS)[number];

// ── Coherencia de la configuración (lib/crm-ia-coherencia.ts decide; aquí solo se navega) ─────────

/** Dónde vive cada texto del dueño. */
const TAB_DE_CAMPO: Record<CampoTexto, Tab> = {
  persona: "Personalidad",
  empresa_contexto: "Personalidad",
  goals: "Objetivos",
  conocimiento: "Conocimiento",
  reglas_extra: "Ajustes",
  mensaje_derivacion: "Ajustes",
};
/** Los campos de `porCampo` (el conteo de alarmas del motor) que pinta el badge de cada pestaña.
 *  "ajustes" = los choques entre ajustes, que se arreglan en Ajustes. */
const CAMPOS_DE_TAB: Partial<Record<Tab, string[]>> = {
  Personalidad: ["persona", "empresa_contexto"],
  Objetivos: ["goals"],
  Conocimiento: ["conocimiento"],
  Ajustes: ["reglas_extra", "mensaje_derivacion", "ajustes"],
};

/** Lo que el auditor lee del formulario (lo que se está editando, sin guardar). */
const cfgAuditable = (a: Agente): ConfigAuditable => ({
  persona: a.persona,
  empresa_contexto: a.empresa_contexto,
  conocimiento: a.conocimiento,
  goals: a.goals,
  mensaje_derivacion: a.mensaje_derivacion,
  escalar_si: a.escalar_si,
  nombre: a.nombre,
  pausa_humano_horas: a.pausa_humano_horas,
  comportamiento: a.comportamiento,
});

const corto = (s: string, max = 90) => {
  const c = Array.from(s.replace(/\s+/g, " ").trim());
  return c.length <= max ? c.join("") : `${c.slice(0, max - 1).join("").trimEnd()}…`;
};

/** El confirm() de guardar: nombra los choques NUEVOS (hasta 3) y dice quién manda. */
function textoChoquesNuevos(nuevas: Hallazgo[]): string {
  const n = nuevas.length;
  const lineas = nuevas.slice(0, 3).map((h) => {
    const manda = h.ajuste ? ` Manda: ${h.ajuste.etiqueta} = ${h.ajuste.valorLegible}.` : "";
    return `• ${h.titulo}: «${corto(h.cita)}» (${h.etiquetaCampo}).${manda}`;
  });
  if (n > 3) lineas.push(`(…y ${n - 3} más)`);
  const imposible = nuevas.some((h) => !h.ajuste);
  return [
    `Con estos cambios hay ${n} choque${n === 1 ? "" : "s"} nuevo${n === 1 ? "" : "s"}:`,
    ...lineas,
    "",
    `La IA seguirá el ajuste${imposible ? ", y lo que el sistema no puede hacer no lo hará aunque esté escrito" : ""}. ¿Guardar igual?`,
  ].join("\n");
}

const input =
  "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-xs font-semibold text-gray-500 mb-1.5";

export default function AgenteIAPage() {
  const [agente, setAgente] = useState<Agente | null>(null);
  /** Lo último cargado o guardado: contra esto se cuentan los choques NUEVOS al guardar. */
  const [cargado, setCargado] = useState<Agente | null>(null);
  /** Nombre del perfil de la empresa ({empresa} en «Cómo se presenta»); "" = sin perfil. */
  const [empresa, setEmpresa] = useState("");
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

  // Lo que solo sabe el servidor: ¿hay clave de transcripción?, el prompt real, si la IA cotiza
  // traslados y si los RESERVA, con la política de reserva que envía (null = no se sabe: el auditor
  // no afirma nada de eso, lib/crm-ia-coherencia.ts).
  const [estadoIA, setEstadoIA] = useState<{
    transcripcion: boolean | null; instrucciones: string | null; traslados: boolean | null;
    reserva: boolean | null; politicaReserva: string[] | null;
  }>({
    transcripcion: null, instrucciones: null, traslados: null, reserva: null, politicaReserva: null,
  });
  const cargarEstadoIA = React.useCallback(async () => {
    try {
      const r = await fetch("/api/crm/ia/estado", { headers: await cabecerasErp() });
      const j = await r.json();
      if (j?.ok) {
        const politica = Array.isArray(j.politica_reserva) ? (j.politica_reserva as unknown[]).filter((x): x is string => typeof x === "string") : null;
        setEstadoIA((prev) => ({
          transcripcion: !!j.transcripcion,
          instrucciones: j.instrucciones ?? null,
          traslados: typeof j.traslados === "boolean" ? j.traslados : null,
          reserva: typeof j.reserva === "boolean" ? j.reserva : null,
          // La MISMA lista no cambia de identidad: así el auditor (useMemo) no se rehace en cada lectura.
          politicaReserva: politica && prev.politicaReserva && JSON.stringify(politica) === JSON.stringify(prev.politicaReserva) ? prev.politicaReserva : politica,
        }));
      }
    } catch { /* se queda en «no se sabe» */ }
  }, []);
  useEffect(() => { cargarEstadoIA(); }, [cargarEstadoIA]);

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
        const leido: Agente = {
          ...a,
          goals: Array.isArray(a.goals) ? a.goals : [],
          canales: Array.isArray(a.canales) ? a.canales : [],
          canales_autonomos: Array.isArray(a.canales_autonomos) ? a.canales_autonomos : [],
        };
        setAgente(leido);
        setCargado(leido);
      }
      setCargando(false);
    })();
    // El nombre de la empresa, como lo lee el motor (nombre o razón social). Best-effort.
    (async () => {
      try {
        const { data } = await supabase.from("empresa_perfil").select("nombre, razon_social").eq("id", 1).maybeSingle();
        const p = data as { nombre?: string | null; razon_social?: string | null } | null;
        setEmpresa(String(p?.nombre || p?.razon_social || "").trim());
      } catch { /* sin perfil: «la empresa» */ }
    })();
  }, []);

  const set = <K extends keyof Agente>(k: K, v: Agente[K]) => setAgente((a) => (a ? { ...a, [k]: v } : a));

  // ── Coherencia: el auditor PURO sobre lo que se está editando (se recalcula al teclear, diferido
  // para no frenar la escritura) y sobre lo guardado (para saber qué choques AGREGA una edición). ──
  const ctxAuditoria = useMemo(
    () => ({ trasladosActivos: estadoIA.traslados, reservaTraslados: estadoIA.reserva, politicaTraslados: estadoIA.politicaReserva, empresa }),
    [estadoIA.traslados, estadoIA.reserva, estadoIA.politicaReserva, empresa],
  );
  const agenteDiferido = useDeferredValue(agente);
  const auditoria = useMemo(
    () => (agenteDiferido ? auditarAgente(cfgAuditable(agenteDiferido), ctxAuditoria) : null),
    [agenteDiferido, ctxAuditoria],
  );
  const auditoriaCargada = useMemo(
    () => (cargado ? auditarAgente(cfgAuditable(cargado), ctxAuditoria) : null),
    [cargado, ctxAuditoria],
  );

  // «Ver la frase» / «Ir al ajuste»: se cambia de pestaña y, ya pintada, se enfoca o se resalta.
  type Destino = { tipo: "frase"; campo: CampoTexto; cita: string; indice?: number } | { tipo: "ajuste"; ancla: string };
  const [irA, setIrA] = useState<Destino | null>(null);
  useEffect(() => {
    if (!irA) return;
    const raf = requestAnimationFrame(() => {
      if (irA.tipo === "frase") enfocarFrase(irA.campo, irA.cita, irA.indice);
      else resaltarAjuste(irA.ancla);
      setIrA(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [irA]);

  const acciones: AccionesCoherencia = {
    verFrase: (campo, cita, indice) => {
      setTab(TAB_DE_CAMPO[campo]);
      setIrA({ tipo: "frase", campo, cita, ...(indice != null ? { indice } : {}) });
    },
    irAjuste: (ancla) => {
      setTab("Ajustes");
      setIrA({ tipo: "ajuste", ancla });
    },
    // Solo cambia el FORMULARIO: el aviso pasa a gris en vivo y guardar sigue siendo del dueño.
    aplicarPropuesta: (h) => {
      const p = h.propuesta;
      if (!p) return;
      if (p.clave === "pausa_humano_horas") set("pausa_humano_horas", Number(p.valor));
      else if (p.clave === "escalar_si") set("escalar_si", String(p.valor ?? ""));
      else if (p.clave === "mensaje_derivacion") set("mensaje_derivacion", String(p.valor ?? ""));
      else
        setAgente((a) => {
          if (!a) return a;
          const c = a.comportamiento;
          const base = { ...normalizarAjustes(c), ...(c && typeof c === "object" ? (c as object) : {}) } as AjustesIA;
          return { ...a, comportamiento: { ...base, [p.clave]: p.valor } };
        });
      showToast(`«${h.ajuste?.etiqueta ?? "Ajuste"}» puesto en «${p.etiqueta}». Falta pulsar Guardar.`);
    },
  };

  const guardar = async () => {
    if (!agente) return;
    // No se bloquea: si la edición AGREGA choques, se nombran y decide el dueño. Los que ya estaban
    // no se vuelven a preguntar (los muestra el panel).
    const despues = auditarAgente(cfgAuditable(agente), ctxAuditoria);
    const nuevas = nuevasAlarmas(auditoriaCargada?.hallazgos ?? [], despues.hallazgos);
    if (nuevas.length > 0 && !window.confirm(textoChoquesNuevos(nuevas))) return;
    setGuardando(true);
    const { id, ...resto } = agente;
    // Se guarda acotado con la misma regla que usa el motor.
    const patch: Omit<Agente, "id"> = { ...resto };
    if (resto.comportamiento !== undefined) patch.comportamiento = normalizarAjustes(resto.comportamiento);
    const { error } = await supabase
      .from("crm_agentes_ia")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
    setGuardando(false);
    showToast(
      error
        ? /pausa_humano_horas/.test(error.message)
          ? "Falta correr supabase/crm-ia-pausa-humano.sql en Supabase"
          : /mensaje_derivacion|comportamiento/.test(error.message)
          ? "Falta correr supabase/crm-ia-comportamiento.sql en Supabase"
          : `Error al guardar: ${error.message}`
        : despues.alarmas > 0
        ? `Configuración guardada · ${despues.alarmas} choque${despues.alarmas === 1 ? "" : "s"} pendiente${despues.alarmas === 1 ? "" : "s"}`
        : "Configuración guardada",
      !error,
    );
    if (!error) {
      if (patch.comportamiento) set("comportamiento", patch.comportamiento);
      setCargado({ ...agente, ...(patch.comportamiento !== undefined ? { comportamiento: patch.comportamiento } : {}) });
      cargarEstadoIA();
    }
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
        headers: await cabecerasErp(),
        body: JSON.stringify({ mensaje: texto, historial }),
      });
      const data = await res.json();
      setChatMsgs((prev) => [...prev, { role: "afita", texto: data.texto ?? "", herramientas: data.herramientas, error: data.error }]);
    } catch (e) {
      setChatMsgs((prev) => [...prev, { role: "afita", texto: "", error: e instanceof Error ? e.message : "Error de red" }]);
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

  const trato = normalizarAjustes(agente.comportamiento).tratamiento;

  return (
    <ProveedorCoherencia resultado={auditoria} acciones={acciones}>
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
          {/* Choques de la configuración: los decide lib/crm-ia-coherencia.ts; sin hallazgos no pinta nada. */}
          <CoherenciaAgente resultado={auditoria} />

          {/* Tabs */}
          <div className="flex gap-1 border-b border-gray-100 mb-5 overflow-x-auto">
            {TABS.map((t) => {
              const choques = (CAMPOS_DE_TAB[t] ?? []).reduce((s, c) => s + (auditoria?.porCampo[c] ?? 0), 0);
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                    tab === t ? "border-[#0b315f] text-[#0b315f]" : "border-transparent text-gray-400 hover:text-gray-600"
                  }`}
                >
                  {t}
                  {choques > 0 && (
                    <span
                      className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold align-middle"
                      title={`${choques} choque${choques === 1 ? "" : "s"} con los ajustes`}
                    >
                      {choques}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ── Personalidad ── */}
          {tab === "Personalidad" && (
            <div className="space-y-4 bg-white border border-gray-100 rounded-2xl p-5">
              <div>
                <label className={label}>Nombre del agente</label>
                <input className={input} value={agente.nombre} onChange={(e) => set("nombre", e.target.value)} />
                <p className="text-[11px] text-gray-400 mt-1">
                  La IA lo usa si «{TEMAS_AJUSTE.presentacion.etiqueta}» (en Ajustes) lleva {"{agente}"}.
                </p>
              </div>
              <div>
                <label className={label} htmlFor={idCampo("persona")}>Personalidad y tono (rol del bot)</label>
                <textarea
                  id={idCampo("persona")}
                  className={input}
                  rows={4}
                  value={agente.persona}
                  onChange={(e) => set("persona", e.target.value)}
                  placeholder="Eres el asistente comercial de la empresa. Hablas español peruano, cordial y profesional…"
                />
                <AvisoCampo campo="persona" />
              </div>
              <div>
                <label className={label} htmlFor={idCampo("empresa_contexto")}>Sobre la empresa</label>
                <textarea
                  id={idCampo("empresa_contexto")}
                  className={input}
                  rows={3}
                  value={agente.empresa_contexto}
                  onChange={(e) => set("empresa_contexto", e.target.value)}
                  placeholder="Qué hace la empresa, qué servicios ofrece, zonas de cobertura…"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Lo que no tiene un ajuste (qué hace la empresa, servicios, precios, el tono). El trato, cómo pide los
                  datos, el resumen, el saludo y el horario de atención se deciden en Ajustes: ahí manda el ajuste.
                </p>
                <AvisoCampo campo="empresa_contexto" />
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
          {tab === "Objetivos" && (
            <div className="space-y-3">
              <p className="text-xs text-gray-400 px-1">
                Los objetivos guían qué debe lograr el agente en cada conversación (igual que los “Goals” de Zolutium).
              </p>
              {agente.goals.map((g, i) => (
                <div key={i} className="bg-white border border-gray-100 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[#0b315f] font-bold text-sm">#{i + 1}</span>
                    <input
                      id={idCampo("goals", i + 1, "titulo")}
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
                    id={idCampo("goals", i + 1, "instrucciones")}
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
                  <AvisoCampo campo="goals" indice={i + 1} />
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
              <label className={label} htmlFor={idCampo("conocimiento")}>Base de conocimiento (FAQ, políticas, info de rutas)</label>
              <textarea
                id={idCampo("conocimiento")}
                className={input}
                rows={14}
                value={agente.conocimiento}
                onChange={(e) => set("conocimiento", e.target.value)}
                placeholder={
                  "Pega aquí todo lo que el agente debe saber: políticas, rutas frecuentes, formas de pago, preguntas frecuentes y sus respuestas… (el horario de atención del equipo se declara en Ajustes)"
                }
              />
              <AvisoCampo campo="conocimiento" />
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
                  En estos canales trabaja el agente. Copiloto: la IA no escribe sola; la sugerencia se pide con ✨ IA en el inbox.
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
                        Copiloto: la IA no escribe sola; la sugerencia se pide con <b>✨ IA</b> en el inbox. Tu equipo la
                        revisa, la edita si hace falta y la envía.
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
                  <p className="text-xs text-gray-400">
                    Fuera de este horario la IA no contesta ni deja borrador: el chat espera a una persona, que puede pedir
                    una sugerencia con ✨ IA. No es el horario de atención del equipo.
                  </p>
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
                <div id="ajuste-pausa-humano" className="scroll-mt-24 rounded-xl">
                  <label className={label}>{TEMAS_AJUSTE.pausa_humano.etiqueta}</label>
                  <input
                    type="number"
                    min={0}
                    max={168}
                    className={input}
                    value={agente.pausa_humano_horas ?? 12}
                    onChange={(e) => set("pausa_humano_horas", Number(e.target.value))}
                  />
                  <p className="text-[11px] text-gray-400 mt-1">Si alguien del equipo respondió (CRM o celular), la IA no contesta en ese chat durante estas horas (0 = no pausar).</p>
                  <AvisosAjuste ancla={TEMAS_AJUSTE.pausa_humano.ancla} />
                </div>
              </div>

              <div id="ajuste-escalar" className="scroll-mt-24 rounded-xl">
                <label className={label}>{TEMAS_AJUSTE.derivacion.etiqueta}</label>
                <input
                  className={input}
                  value={agente.escalar_si}
                  onChange={(e) => set("escalar_si", e.target.value)}
                  placeholder="reclamo, queja, hablar con una persona, factura, gerente"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Frases separadas por coma. Además, el sistema ya pasa el chat a una persona si el cliente lo pide, está
                  molesto o hay un reclamo, entre otros casos.
                </p>
                <AvisosAjuste ancla={TEMAS_AJUSTE.derivacion.ancla} />
              </div>

              <div>
                <label className={label} htmlFor={idCampo("mensaje_derivacion")}>Mensaje al derivar a un ejecutivo</label>
                <textarea
                  id={idCampo("mensaje_derivacion")}
                  rows={3}
                  className={input}
                  value={agente.mensaje_derivacion ?? ""}
                  onChange={(e) => set("mensaje_derivacion", e.target.value)}
                  placeholder={mensajeDerivacionDefecto(trato)}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Lo usa la IA cuando no encuentra lo que piden en el sistema, no puede escuchar un audio o el tema es para una persona. {"{nombre}"} = primer nombre del cliente; {"{atencion}"} = la frase del horario de atención del equipo (solo fuera de ese horario). Vacío = este texto de ejemplo, en el trato de «{TEMAS_AJUSTE.tratamiento.etiqueta}» y con el horario de atención si lo declaras. La etiqueta y la nota interna se configuran abajo, en «Al derivar a un ejecutivo».
                </p>
                <AvisoCampo campo="mensaje_derivacion" />
              </div>

              <AjustesComportamiento
                valor={agente.comportamiento}
                onChange={(v) => set("comportamiento", v)}
                transcripcionLista={estadoIA.transcripcion}
                instrucciones={estadoIA.instrucciones}
                empresa={empresa}
                nombreAgente={agente.nombre ?? ""}
                mensajeDerivacionPropio={agente.mensaje_derivacion ?? ""}
              />

              <div>
                <label className={label}>Firma (se añade al final del mensaje)</label>
                <input className={input} value={agente.firma} onChange={(e) => set("firma", e.target.value)} placeholder="— Nombre de tu empresa" />
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
      <ContactosSinIA />
    </div>
    </ProveedorCoherencia>
  );
}
