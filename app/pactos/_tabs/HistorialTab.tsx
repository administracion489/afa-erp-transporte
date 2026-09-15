"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Pactos · Historial — EL ACTA, LEÍDA.
//
// Dos vistas del mismo hecho:
//
//   · Por CONTRATO (v_adenda_contrato) — "esta cotización acumuló +S/ 4 500 de venta y
//     +S/ 1 800 de costo en 18 servicios". Es literalmente la segunda cotización que
//     hoy se le exige al operador, armada sola. Sirve para sustentarle el cambio al
//     cliente y a gerencia.
//   · Por MOVIMIENTO — la línea de tiempo cruda, para responder "¿quién cambió esto y
//     por qué?" sobre un servicio concreto.
//
// Las actas de `origen='apertura'` son la línea de corte: el estado del parque el día
// que se instaló el Pacto, sin autor, porque antes el ERP no guardaba nada y firmar por
// eso sería inventar. Se muestran aparte y no se cuentan como cambios.
// ──────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";

type Adenda = {
  cotizacion_id: number;
  desde: string | null;
  hasta: string | null;
  cambios_de_precio: number;
  cambios_de_costo: number;
  servicios_afectados: number;
  delta_venta: number | null;
  delta_costo: number | null;
  delta_margen: number | null;
};

type Movimiento = {
  id: number;
  codigo: string | null;
  os: string | null;
  fecha_servicio: string | null;
  ruta_nombre: string | null;
  lado: string;
  version: number;
  origen: string;
  monto_antes: number | null;
  monto_despues: number | null;
  delta: number | null;
  severidad: string | null;
  veredicto: string | null;
  motivo: string | null;
  motivo_nota: string | null;
  estado_visado: string;
  proveedor_antes: string | null;
  proveedor_despues: string | null;
  creado_at: string;
};

const SEV: Record<string, { bg: string; color: string; label: string }> = {
  inicial:   { bg: "#f1f5f9", color: "#475569", label: "Inicial" },
  neutro:    { bg: "#f1f5f9", color: "#475569", label: "Sin impacto" },
  mejora:    { bg: "#dcfce7", color: "#166534", label: "Mejora" },
  deterioro: { bg: "#ffedd5", color: "#c2410c", label: "Deterioro" },
  critico:   { bg: "#fee2e2", color: "#b91c1c", label: "Crítico" },
};

const VISADO: Record<string, { color: string; label: string }> = {
  no_requiere: { color: "#94a3b8", label: "No requería visado" },
  pendiente:   { color: "#c2410c", label: "Por visar" },
  aprobado:    { color: "#166534", label: "Aprobado" },
  rechazado:   { color: "#b91c1c", label: "Rechazado" },
};

export default function HistorialTab({ onCambio }: { onCambio: () => void }) {
  const [vista, setVista] = useState<"contrato" | "movimientos">("contrato");
  const [adendas, setAdendas] = useState<Adenda[]>([]);
  const [movs, setMovs] = useState<Movimiento[]>([]);
  const [busca, setBusca] = useState("");
  const [cargando, setCargando] = useState(true);
  const [errorSql, setErrorSql] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true); setErrorSql("");
    const [ad, mv] = await Promise.all([
      supabase.from("v_adenda_contrato").select("*").order("delta_margen", { ascending: true }).limit(300),
      supabase.from("v_pactos_servicio").select("*").order("creado_at", { ascending: false }).limit(400),
    ]);
    if (mv.error) {
      setErrorSql("Falta correr supabase/pacto-02-acta.sql y supabase/pacto-03-triggers.sql: sin eso no hay acta que mostrar.");
      setCargando(false); return;
    }
    setAdendas((ad.data as Adenda[]) ?? []);
    setMovs((mv.data as Movimiento[]) ?? []);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const movsFiltrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    // Las actas de apertura no son cambios: son la foto del día del corte.
    const reales = movs.filter((m) => m.origen !== "apertura");
    if (!q) return reales;
    return reales.filter((m) =>
      [m.os, m.codigo, m.ruta_nombre, m.motivo, m.proveedor_despues, m.proveedor_antes]
        .some((x) => (x ?? "").toLowerCase().includes(q)));
  }, [movs, busca]);

  const aperturas = useMemo(() => movs.filter((m) => m.origen === "apertura").length, [movs]);

  if (cargando) return <div className="py-16 text-center text-gray-400 text-sm">Cargando el acta…</div>;
  if (errorSql)
    return <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-sm text-amber-800">{errorSql}</div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(["contrato", "movimientos"] as const).map((v) => (
          <button key={v} onClick={() => setVista(v)}
            className={`px-3 py-1.5 rounded-xl text-sm font-bold border ${
              vista === v ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
            {v === "contrato" ? "Por contrato" : "Movimientos"}
          </button>
        ))}
        {vista === "movimientos" && (
          <input className="px-3 py-1.5 border rounded-xl text-sm flex-1 min-w-[200px]"
            placeholder="Buscar por OS, folio, ruta, proveedor o motivo…"
            value={busca} onChange={(e) => setBusca(e.target.value)} />
        )}
        {aperturas > 0 && (
          <span className="text-[11px] text-gray-400 ml-auto">
            {aperturas} acta(s) de apertura ocultas (el estado al día del corte)
          </span>
        )}
      </div>

      {vista === "contrato" ? (
        adendas.length === 0 ? (
          <div className="bg-white rounded-2xl border p-10 text-center text-gray-400 text-sm">
            Todavía no hay contratos con cambios posteriores a lo pactado.
          </div>
        ) : (
          <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-gray-50 text-gray-400 text-[11px] uppercase">
                  <tr>
                    <th className="text-left px-4 py-2">Cotización</th>
                    <th className="text-left px-4 py-2">Periodo</th>
                    <th className="text-right px-4 py-2">Servicios</th>
                    <th className="text-right px-4 py-2">Δ Venta</th>
                    <th className="text-right px-4 py-2">Δ Costo</th>
                    <th className="text-right px-4 py-2">Δ Margen</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {adendas.map((a) => {
                    const dm = Number(a.delta_margen ?? 0);
                    return (
                      <tr key={a.cotizacion_id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs font-bold text-gray-800">#{a.cotizacion_id}</td>
                        <td className="px-4 py-2 text-xs text-gray-500">{a.desde} → {a.hasta}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-600">
                          {a.servicios_afectados}
                          <span className="text-gray-400 text-[11px]"> ({a.cambios_de_precio}p · {a.cambios_de_costo}c)</span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-700">{fmtMoneda(Number(a.delta_venta ?? 0))}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-gray-700">{fmtMoneda(Number(a.delta_costo ?? 0))}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-black"
                          style={{ color: dm < 0 ? "#b91c1c" : "#166534" }}>
                          {dm > 0 ? "+" : ""}{fmtMoneda(dm)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-[11px] text-gray-400 border-t">
              Cada fila es el sustento del cambio de ese contrato: la adenda que hoy se le pide
              al operador, sin que la escriba.
            </p>
          </div>
        )
      ) : (
        movsFiltrados.length === 0 ? (
          <div className="bg-white rounded-2xl border p-10 text-center text-gray-400 text-sm">
            {busca ? "Nada calza con esa búsqueda." : "Todavía no se registró ningún cambio."}
          </div>
        ) : (
          <div className="space-y-2">
            {movsFiltrados.map((m) => {
              const sev = SEV[m.severidad ?? "neutro"] ?? SEV.neutro;
              const vis = VISADO[m.estado_visado] ?? VISADO.no_requiere;
              return (
                <div key={m.id} className="bg-white rounded-xl border px-4 py-3 flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-[240px]">
                    <div className="flex flex-wrap items-center gap-2">
                      {m.codigo && <span className="font-mono text-[11px] text-gray-400">{m.codigo}</span>}
                      <span className="font-mono text-xs font-bold text-gray-800">{m.os}</span>
                      <span className="text-[11px] text-gray-400">{m.fecha_servicio}</span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase"
                        style={{ background: sev.bg, color: sev.color }}>{sev.label}</span>
                      <span className="text-[10px] font-bold uppercase" style={{ color: vis.color }}>{vis.label}</span>
                      <span className="text-[10px] text-gray-400 uppercase">{m.lado} v{m.version}</span>
                    </div>
                    {(m.proveedor_antes || m.proveedor_despues) && m.lado === "compra" && (
                      <p className="text-xs text-gray-600 mt-1">
                        {m.proveedor_antes ?? "—"} <span className="text-gray-300">→</span>{" "}
                        <b className="text-gray-800">{m.proveedor_despues ?? "—"}</b>
                      </p>
                    )}
                    <p className="text-xs text-gray-600 mt-1">{m.veredicto}</p>
                    {m.motivo && (
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        {m.motivo}{m.motivo_nota ? ` · ${m.motivo_nota}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0 tabular-nums">
                    <p className="text-xs text-gray-400">{fmtMoneda(Number(m.monto_antes ?? 0))}</p>
                    <p className="text-sm font-black text-gray-800">{fmtMoneda(Number(m.monto_despues ?? 0))}</p>
                    {Number(m.delta ?? 0) !== 0 && (
                      <p className="text-[11px] font-bold"
                        style={{ color: Number(m.delta) > 0 ? "#b91c1c" : "#166534" }}>
                        {Number(m.delta) > 0 ? "+" : ""}{fmtMoneda(Number(m.delta))}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
