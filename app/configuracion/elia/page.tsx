"use client";
// ============================================================
// Configuración de ELIA — modelo, encendido y límite de gasto.
// Solo administradores (el API devuelve 403 al resto; el layout
// ya oculta la ruta a quien no tiene el módulo "configuracion").
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { OrbeElia } from "@/app/_components/elia";

type ModeloInfo = { id: string; etiqueta: string; precio_entrada: number; precio_salida: number };
type UsoUsuario = { usuario: string; mensajes: number; costo: number };

// Costo aproximado de una pregunta típica (~11k tokens entrada, ~500 salida)
const costoPreguntaTipica = (m: ModeloInfo) =>
  (11000 * m.precio_entrada + 500 * m.precio_salida) / 1_000_000;

const DESCRIPCION_MODELO: Record<string, { tono: string; detalle: string }> = {
  "claude-opus-4-8": { tono: "Máxima calidad", detalle: "El más inteligente. Ideal si el costo no es la prioridad." },
  "claude-sonnet-5": { tono: "Equilibrado · recomendado", detalle: "Casi la misma calidad en el uso diario, ~40% más barato." },
  "claude-haiku-4-5": { tono: "Económico", detalle: "Rápido y barato. Suficiente para consultas simples; menos fino en análisis." },
};

const fmtUsd = (n: number, dec = 2) => `US$ ${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

async function tokenSesion(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export function EliaConfigInner() {
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [faltaSql, setFaltaSql] = useState(false);

  const [activa, setActiva] = useState(true);
  const [modelo, setModelo] = useState("claude-opus-4-8");
  const [limite, setLimite] = useState<string>("100");
  const [avisoPct, setAvisoPct] = useState<string>("80");

  const [modelos, setModelos] = useState<ModeloInfo[]>([]);
  const [uso, setUso] = useState<{ mes: string; gasto: number; mensajes: number; por_usuario: UsoUsuario[] }>({
    mes: "",
    gasto: 0,
    mensajes: 0,
    por_usuario: [],
  });

  const [guardando, setGuardando] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; texto: string } | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga(null);
    try {
      const token = await tokenSesion();
      const res = await fetch("/api/elia/config", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorCarga(json.error || "No se pudo cargar la configuración.");
        return;
      }
      setFaltaSql(!!json.faltaSql);
      setActiva(json.config.activa !== false);
      setModelo(json.config.modelo);
      setLimite(String(json.config.limite_mensual_usd ?? 0));
      setAvisoPct(String(json.config.aviso_pct ?? 80));
      setModelos(json.modelos ?? []);
      setUso(json.uso ?? { mes: "", gasto: 0, mensajes: 0, por_usuario: [] });
    } catch {
      setErrorCarga("Error de conexión al cargar la configuración.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const guardar = async () => {
    setGuardando(true);
    setToast(null);
    try {
      const token = await tokenSesion();
      const res = await fetch("/api/elia/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          activa,
          modelo,
          limite_mensual_usd: Number(limite) || 0,
          aviso_pct: Number(avisoPct) || 80,
        }),
      });
      const json = await res.json();
      setToast(res.ok ? { ok: true, texto: "✓ Configuración guardada" } : { ok: false, texto: json.error || "No se pudo guardar" });
      if (res.ok) cargar();
    } catch {
      setToast({ ok: false, texto: "Error de conexión al guardar" });
    } finally {
      setGuardando(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  if (cargando)
    return (
      <div className="flex items-center gap-3 text-[#5B6B82] text-sm p-8">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-[#0b315f]" />
        Cargando configuración de ELIA…
      </div>
    );

  if (errorCarga)
    return (
      <div className="max-w-2xl bg-white border border-[#E4E7ED] rounded-2xl p-6">
        <p className="font-bold text-[#0b315f]">No se pudo abrir la configuración</p>
        <p className="text-sm text-[#5B6B82] mt-1">{errorCarga}</p>
      </div>
    );

  const limiteNum = Number(limite) || 0;
  const pctUsado = limiteNum > 0 ? Math.min(100, Math.round((uso.gasto / limiteNum) * 100)) : 0;
  const avisoNum = Number(avisoPct) || 80;
  const colorBarra = pctUsado >= 100 ? "#EB5757" : pctUsado >= avisoNum ? "#f59e0b" : "#27AE60";
  const costoPromedio = uso.mensajes > 0 ? uso.gasto / uso.mensajes : null;
  const preguntasRestantes =
    limiteNum > 0 && costoPromedio && costoPromedio > 0 ? Math.max(0, Math.floor((limiteNum - uso.gasto) / costoPromedio)) : null;

  return (
    <div className="max-w-3xl space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <OrbeElia size={44} activa={activa} />
        <div className="flex-1">
          <h1 className="text-xl font-extrabold text-[#0b315f] tracking-tight">ELIA · Configuración</h1>
          <p className="text-[12px] text-[#5B6B82]">Modelo, encendido y límite de gasto mensual de la asistente.</p>
        </div>
        <button
          onClick={guardar}
          disabled={guardando}
          className="bg-[#0b315f] hover:bg-[#1262bd] disabled:opacity-50 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-colors"
        >
          {guardando ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>

      {toast && (
        <div
          className={`text-sm font-semibold px-4 py-2.5 rounded-xl ${
            toast.ok ? "bg-[#E8F5EC] text-[#166534]" : "bg-[#FDECEC] text-[#991b1b]"
          }`}
        >
          {toast.texto}
        </div>
      )}

      {faltaSql && (
        <div className="bg-[#FBF1D8] border border-[#B07A0F]/30 rounded-2xl p-4">
          <p className="text-sm font-bold text-[#854d0e]">Falta un paso: crear las tablas de control</p>
          <p className="text-[12.5px] text-[#854d0e]/90 mt-1">
            Ejecuta el archivo <code className="font-mono bg-white/60 px-1.5 py-0.5 rounded">supabase/elia-config.sql</code> en el SQL
            Editor de Supabase (una sola vez). Mientras tanto ELIA funciona con los valores por defecto, pero{" "}
            <strong>no registra el gasto ni aplica el límite</strong>.
          </p>
        </div>
      )}

      {/* Estado */}
      <div className="bg-white border border-[#E4E7ED] rounded-2xl p-5 flex items-center justify-between">
        <div>
          <p className="font-bold text-[#0c2d52] text-sm">Asistente {activa ? "encendida" : "apagada"}</p>
          <p className="text-[12px] text-[#5B6B82] mt-0.5">
            {activa
              ? "ELIA responde a todos los usuarios del ERP según sus permisos."
              : "Nadie puede conversar con ELIA hasta volver a encenderla."}
          </p>
        </div>
        <button
          onClick={() => setActiva((v) => !v)}
          className={`relative w-14 h-8 rounded-full transition-colors flex-shrink-0 ${activa ? "bg-[#27AE60]" : "bg-gray-300"}`}
          title={activa ? "Apagar ELIA" : "Encender ELIA"}
        >
          <span
            className="absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-all"
            style={{ left: activa ? 30 : 4 }}
          />
        </button>
      </div>

      {/* Modelo */}
      <div className="bg-white border border-[#E4E7ED] rounded-2xl p-5">
        <p className="font-bold text-[#0c2d52] text-sm">Modelo de inteligencia</p>
        <p className="text-[12px] text-[#5B6B82] mt-0.5 mb-3">Define la calidad de las respuestas y el costo por pregunta.</p>
        <div className="grid sm:grid-cols-3 gap-2.5">
          {modelos.map((m) => {
            const sel = modelo === m.id;
            const desc = DESCRIPCION_MODELO[m.id];
            return (
              <button
                key={m.id}
                onClick={() => setModelo(m.id)}
                className={`text-left rounded-xl border-2 p-3.5 transition-all ${
                  sel ? "border-[#2f8ee9] bg-[#E8F1FB]" : "border-[#E4E7ED] hover:border-[#2f8ee9]/40"
                }`}
              >
                <div className="flex items-center justify-between">
                  <p className="font-bold text-[13px] text-[#0c2d52]">{m.etiqueta}</p>
                  {sel && <span className="w-2.5 h-2.5 rounded-full bg-[#2f8ee9]" />}
                </div>
                <p className="text-[10.5px] font-bold text-[#1262bd] mt-0.5">{desc?.tono}</p>
                <p className="text-[11px] text-[#5B6B82] mt-1 leading-snug">{desc?.detalle}</p>
                <p className="text-[11px] font-bold text-[#0b315f] mt-2" style={{ fontFamily: "var(--font-mono)" }}>
                  ≈ {fmtUsd(costoPreguntaTipica(m), 3)}/pregunta
                </p>
                <p className="text-[9.5px] text-[#8693A6]">
                  ${m.precio_entrada}/M entrada · ${m.precio_salida}/M salida
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Presupuesto */}
      <div className="bg-white border border-[#E4E7ED] rounded-2xl p-5">
        <p className="font-bold text-[#0c2d52] text-sm">Presupuesto mensual</p>
        <p className="text-[12px] text-[#5B6B82] mt-0.5 mb-3">
          Al llegar al límite, ELIA deja de responder hasta el mes siguiente (lo explica con amabilidad a quien le escriba).
        </p>
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="block text-[10px] font-black uppercase tracking-wide text-[#8693A6] mb-1">Límite (US$)</label>
            <input
              type="number"
              min={0}
              step={10}
              value={limite}
              onChange={(e) => setLimite(e.target.value)}
              className="w-32 border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-bold text-[#0b315f] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <p className="text-[10px] text-[#8693A6] mt-1">0 = sin límite</p>
          </div>
          <div>
            <label className="block text-[10px] font-black uppercase tracking-wide text-[#8693A6] mb-1">Aviso al llegar al (%)</label>
            <input
              type="number"
              min={10}
              max={100}
              step={5}
              value={avisoPct}
              onChange={(e) => setAvisoPct(e.target.value)}
              className="w-24 border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-bold text-[#0b315f] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>
        </div>

        {/* Uso del mes */}
        <div className="mt-5 pt-4 border-t border-[#EEF1F4]">
          <div className="flex items-baseline justify-between">
            <p className="text-[11px] font-black uppercase tracking-wide text-[#8693A6]">
              Consumo de {uso.mes || "este mes"}
            </p>
            <p className="text-[13px] font-bold" style={{ fontFamily: "var(--font-mono)", color: colorBarra }}>
              {fmtUsd(uso.gasto)}
              {limiteNum > 0 && <span className="text-[#8693A6] font-medium"> / {fmtUsd(limiteNum, 0)}</span>}
            </p>
          </div>
          {limiteNum > 0 && (
            <div className="mt-2 h-3 bg-[#EEF1F4] rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(2, pctUsado)}%`, background: colorBarra }} />
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 mt-3">
            <div>
              <p className="text-[9px] font-black uppercase tracking-wide text-[#8693A6]">Respuestas</p>
              <p className="text-[15px] font-bold text-[#0c2d52]" style={{ fontFamily: "var(--font-mono)" }}>{uso.mensajes}</p>
            </div>
            <div>
              <p className="text-[9px] font-black uppercase tracking-wide text-[#8693A6]">Costo promedio</p>
              <p className="text-[15px] font-bold text-[#0c2d52]" style={{ fontFamily: "var(--font-mono)" }}>
                {costoPromedio !== null ? fmtUsd(costoPromedio, 3) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-black uppercase tracking-wide text-[#8693A6]">Preguntas restantes ≈</p>
              <p className="text-[15px] font-bold text-[#0c2d52]" style={{ fontFamily: "var(--font-mono)" }}>
                {preguntasRestantes !== null ? preguntasRestantes.toLocaleString("es-PE") : "—"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Consumo por usuario */}
      {uso.por_usuario.length > 0 && (
        <div className="bg-white border border-[#E4E7ED] rounded-2xl p-5">
          <p className="font-bold text-[#0c2d52] text-sm mb-3">Consumo por usuario ({uso.mes})</p>
          <div className="space-y-1.5">
            {uso.por_usuario.slice(0, 8).map((u) => {
              const max = uso.por_usuario[0]?.costo || 1;
              return (
                <div key={u.usuario} className="flex items-center gap-2">
                  <span className="w-36 text-[11.5px] font-semibold text-[#1f3a5f] truncate">{u.usuario}</span>
                  <div className="flex-1 h-3 bg-[#EEF1F4] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(3, Math.round((u.costo / max) * 100))}%`, background: "linear-gradient(90deg, #2f8ee9, #1262bd)" }}
                    />
                  </div>
                  <span className="w-24 text-right text-[11px] font-bold text-[#0b315f]" style={{ fontFamily: "var(--font-mono)" }}>
                    {fmtUsd(u.costo)}
                  </span>
                  <span className="w-14 text-right text-[10px] text-[#8693A6]">{u.mensajes} msg</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PaginaConfigElia() {
  return <EliaConfigInner />;
}
