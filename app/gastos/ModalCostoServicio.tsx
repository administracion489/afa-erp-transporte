"use client";

// ──────────────────────────────────────────────────────────────────────────────
// app/gastos/ModalCostoServicio.tsx — Vista "Rentabilidad por servicio" de /gastos.
//
// Vive en un archivo aparte para no engordar page.tsx, que ya carga la vista
// unificada de seis fuentes de egreso.
//
// Lee v_costo_servicio TAL CUAL: no recalcula ni el costo real ni el margen en el
// cliente. La única definición válida de "cuánto costó de verdad este servicio" es
// la de la vista (supabase/finanzas-06-gastos-caja-chica.sql), que suma los egresos
// con reserva_id y las líneas de compra del tercero. Duplicar esa fórmula aquí es
// justo la divergencia que este módulo viene a cerrar.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from "react";
import { ESTADOS_ADMIN, ESTADOS_PROVEEDOR, etiquetaAdmin, etiquetaProveedor } from "@/lib/estados";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import type { CostoServicio } from "@/lib/finanzas/tipos";

// ─── PASTILLAS DE ESTADO ──────────────────────────────────────────────────────
// Se exportan porque la tabla de movimientos (page.tsx) muestra los mismos chips en
// su columna "Servicio". El color sale SIEMPRE de los diccionarios de @/lib/estados
// —ninguna pantalla redefine estados de reserva— y el fondo se deriva del mismo hex
// con sufijo alfa, el truco repetido en todo el ERP.

function colorDe(dicc: Record<string, { color: string }>, estado: string): string {
  return dicc[estado]?.color ?? "#4b5563";
}

/** Estado administrativo (dimensión cliente · familia violeta). */
export function ChipAdmin({ estado }: { estado: string | null | undefined }) {
  if (!estado) return null;
  const color = colorDe(ESTADOS_ADMIN as Record<string, { color: string }>, estado);
  return (
    <span
      className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide whitespace-nowrap"
      style={{ background: color + "1a", color }}
    >
      {etiquetaAdmin(estado)}
    </span>
  );
}

/** Estado del proveedor (dimensión tercero · familia ámbar/teal). */
export function ChipProveedor({ estado }: { estado: string | null | undefined }) {
  if (!estado) return null;
  const color = colorDe(ESTADOS_PROVEEDOR as Record<string, { color: string }>, estado);
  return (
    <span
      className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide whitespace-nowrap"
      style={{ background: color + "1a", color }}
    >
      {etiquetaProveedor(estado)}
    </span>
  );
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtFecha(f: string | null | undefined) {
  if (!f) return "—";
  return new Date(String(f).slice(0, 10) + "T00:00:00").toLocaleDateString("es-PE", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

/** Margen % del servicio. Sin ingreso registrado el porcentaje no significa nada. */
export function margenPct(c: CostoServicio): number | null {
  const ingreso = Number(c.ingreso || 0);
  if (ingreso <= 0) return null;
  return (Number(c.margen_real || 0) / ingreso) * 100;
}

const CABECERAS = [
  "Fecha", "Servicio", "Tipo", "Ingreso", "Costo real",
  "Margen", "Margen %", "Egresos", "Estado admin", "Estado proveedor",
];

// ─── COMPONENTE ───────────────────────────────────────────────────────────────

type Props = {
  /** Filas de v_costo_servicio YA filtradas por la página (para que el Excel exporte lo mismo que se ve). */
  filas: CostoServicio[];
  loading: boolean;
  soloLiquidados: boolean;
  onSoloLiquidados: (v: boolean) => void;
  /** Total de servicios finalizados antes del filtro rápido, para el contador del toggle. */
  totalServicios: number;
};

export default function VistaCostoServicio({
  filas, loading, soloLiquidados, onSoloLiquidados, totalServicios,
}: Props) {
  const [expandido, setExpandido] = useState<number | null>(null);

  const resumen = useMemo(() => {
    const ingreso = filas.reduce((s, c) => s + Number(c.ingreso || 0), 0);
    const costo   = filas.reduce((s, c) => s + Number(c.costo_real || 0), 0);
    const margen  = filas.reduce((s, c) => s + Number(c.margen_real || 0), 0);
    // Porcentaje sobre el ingreso TOTAL, no la media de los porcentajes fila a fila:
    // promediar porcentajes daría el mismo peso a un servicio de S/ 200 que a uno de
    // S/ 20 000 y el número dejaría de cuadrar con las tres cifras de al lado.
    const pct = ingreso > 0 ? (margen / ingreso) * 100 : 0;
    const sinCosto = filas.filter(c => Number(c.egresos_registrados || 0) === 0).length;
    return { ingreso, costo, margen, pct, sinCosto };
  }, [filas]);

  const kpis = [
    { label: "🟢 Ingreso total",     valor: fmtMoneda(resumen.ingreso), color: "#166534", bg: "#dcfce7" },
    { label: "🔴 Costo real total",  valor: fmtMoneda(resumen.costo),   color: "#991b1b", bg: "#fee2e2" },
    { label: "💰 Margen total",      valor: fmtMoneda(resumen.margen),
      color: resumen.margen >= 0 ? "#166534" : "#991b1b",
      bg:    resumen.margen >= 0 ? "#dcfce7" : "#fee2e2" },
    { label: "📊 Margen %",          valor: `${resumen.pct.toFixed(1)}%`,
      color: resumen.pct >= 0 ? "#166534" : "#991b1b",
      bg:    resumen.pct >= 0 ? "#dcfce7" : "#fee2e2" },
    { label: "⚠️ Sin costo registrado", valor: String(resumen.sinCosto), color: "#854d0e", bg: "#fef9c3" },
  ];

  return (
    <section className="space-y-4">

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {kpis.map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* El aviso que importa: un servicio sin ningún egreso imputado aparenta 100% de
          margen. No es rentabilidad, es información que falta. */}
      {resumen.sinCosto > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          ⚠️
          <span>
            <b>{resumen.sinCosto} servicio{resumen.sinCosto > 1 ? "s" : ""} sin ningún costo registrado.</b>{" "}
            Su margen aparece inflado artificialmente: falta imputarles combustible, peajes, caja chica
            o la factura del tercero.
          </span>
        </div>
      )}

      {/* FILTRO RÁPIDO */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <button
          onClick={() => onSoloLiquidados(!soloLiquidados)}
          className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
          style={{
            borderColor: soloLiquidados ? "#0b315f" : "#e2e8f0",
            background:  soloLiquidados ? "#eef3f8" : "white",
            color:       soloLiquidados ? "#0b315f" : "#6b7280",
          }}
        >
          {soloLiquidados ? "☑" : "☐"} Solo servicios liquidados al cliente
        </button>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400 whitespace-nowrap">
          {filas.length} de {totalServicios} servicios finalizados
        </div>
      </section>

      {/* TABLA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {CABECERAS.map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...
                  </div>
                </td></tr>
              ) : filas.length === 0 ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">📈</p>
                  <p>No hay servicios finalizados con estos filtros</p>
                </td></tr>
              ) : filas.map(c => {
                const abierto   = expandido === c.reserva_id;
                const margen    = Number(c.margen_real || 0);
                const colorMar  = margen > 0 ? "#166534" : margen < 0 ? "#991b1b" : "#4b5563";
                const pct       = margenPct(c);
                const sinCosto  = Number(c.egresos_registrados || 0) === 0;
                const terceriz  = c.tipo_asignacion === "tercerizado";
                const desglose  = [
                  { label: "💸 Gastos directos", valor: Number(c.costo_gastos || 0),             color: "#4b5563" },
                  { label: "⛽ Combustible",      valor: Number(c.costo_combustible || 0),        color: "#ea580c" },
                  { label: "🔧 Mantenimiento",   valor: Number(c.costo_mantenimiento || 0),      color: "#854d0e" },
                  { label: "🧾 Caja chica",      valor: Number(c.costo_caja_chica || 0),         color: "#0f766e" },
                  { label: "🏢 Gastos generales", valor: Number(c.costo_gastos_generales || 0),  color: "#6d28d9" },
                  { label: "🤝 Facturado tercero", valor: Number(c.costo_facturado_tercero || 0), color: "#1d4ed8" },
                ];

                return (
                  <React.Fragment key={c.reserva_id}>
                    <tr
                      className="border-t cursor-pointer hover:brightness-95 transition-all"
                      style={{ background: sinCosto ? "#fffbeb" : "white", borderColor: "#f1f5f9" }}
                      onClick={() => setExpandido(abierto ? null : c.reserva_id)}
                    >
                      <td className="p-3 text-gray-300 text-xs">{abierto ? "▼" : "▶"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(c.fecha_servicio)}</td>
                      <td className="p-3 max-w-[220px]">
                        <p className="font-mono font-black text-xs text-[#0b315f]">{c.codigo || `#${c.reserva_id}`}</p>
                        <p className="text-[10px] text-gray-400 truncate">{c.origen || "—"} → {c.destino || "—"}</p>
                      </td>
                      <td className="p-3">
                        <span
                          className="text-xs font-bold px-2.5 py-1 rounded-lg whitespace-nowrap"
                          style={terceriz
                            ? { background: "#ede9fe", color: "#6d28d9" }
                            : { background: "#dbeafe", color: "#1d4ed8" }}
                        >
                          {terceriz ? "🤝 Tercerizado" : "🚌 Propio"}
                        </span>
                      </td>
                      <td className="p-3 font-black text-xs text-green-700 whitespace-nowrap">{fmtMoneda(Number(c.ingreso || 0))}</td>
                      <td className="p-3 font-black text-xs text-red-700 whitespace-nowrap">{fmtMoneda(Number(c.costo_real || 0))}</td>
                      <td className="p-3 font-black text-xs whitespace-nowrap" style={{ color: colorMar }}>{fmtMoneda(margen)}</td>
                      <td className="p-3 font-bold text-xs whitespace-nowrap" style={{ color: colorMar }}>
                        {pct === null ? "—" : `${pct.toFixed(1)}%`}
                      </td>
                      <td className="p-3 text-xs">
                        {sinCosto ? (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: "#fef9c3", color: "#854d0e" }}>
                            ⚠️ 0
                          </span>
                        ) : (
                          <span className="text-gray-600 font-bold">{c.egresos_registrados}</span>
                        )}
                      </td>
                      <td className="p-3"><ChipAdmin estado={c.estado_admin} /></td>
                      <td className="p-3">{terceriz ? <ChipProveedor estado={c.estado_proveedor} /> : <span className="text-gray-300">—</span>}</td>
                    </tr>

                    {abierto && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={11} className="px-6 py-4">
                          <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400 mb-3">
                            Desglose del costo real · {c.codigo || `#${c.reserva_id}`}
                          </p>
                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                            {desglose.map(d => (
                              <div key={d.label} className="rounded-xl p-3 border" style={{ background: "white", borderColor: d.valor > 0 ? d.color + "22" : "#f1f5f9" }}>
                                <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: d.valor > 0 ? d.color + "99" : "#cbd5e1" }}>{d.label}</p>
                                <p className="text-sm font-black mt-0.5" style={{ color: d.valor > 0 ? d.color : "#cbd5e1" }}>{fmtMoneda(d.valor)}</p>
                              </div>
                            ))}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-6 text-xs">
                            <div><p className="text-gray-400">Costo real</p><p className="font-black text-red-700">{fmtMoneda(Number(c.costo_real || 0))}</p></div>
                            <div><p className="text-gray-400">Ingreso</p><p className="font-black text-green-700">{fmtMoneda(Number(c.ingreso || 0))}</p></div>
                            <div><p className="text-gray-400">Margen real</p><p className="font-black" style={{ color: colorMar }}>{fmtMoneda(margen)}</p></div>
                            {terceriz && (
                              // Pactado vs facturado: la diferencia es exactamente lo que se
                              // discute en la conciliación con el tercero.
                              <div>
                                <p className="text-gray-400">Pactado al proveedor</p>
                                <p className="font-black text-gray-700">{fmtMoneda(Number(c.costo_proveedor_pactado || 0))}</p>
                              </div>
                            )}
                            <div>
                              <p className="text-gray-400">Liquidación</p>
                              <p className="font-bold text-gray-700">
                                {c.liquidado_cliente ? "✅ Cliente" : "⏳ Cliente pendiente"}
                                {terceriz ? (c.liquidado_proveedor ? " · ✅ Proveedor" : " · ⏳ Proveedor pendiente") : ""}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>
            {filas.length} servicios · Ingreso <b className="text-green-700">{fmtMoneda(resumen.ingreso)}</b> ·
            Costo <b className="text-red-700">{fmtMoneda(resumen.costo)}</b> ·
            Margen <b style={{ color: resumen.margen >= 0 ? "#166534" : "#991b1b" }}>{fmtMoneda(resumen.margen)}</b>
          </span>
          <span>AFA ERP · Finanzas · v_costo_servicio</span>
        </div>
      </section>
    </section>
  );
}
