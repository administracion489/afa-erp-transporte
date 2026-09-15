"use client";
// Costear un servicio con unidad propia: a la izquierda lo que se planea gastar, a
// la derecha lo que de verdad se gastó. La diferencia es el único número nuevo de
// todo esto, y es el que enseña.
//
// NO ESCRIBE EN reservas.costo_proveedor. Ese campo es lo que se le debe a un
// tercero; en flota propia no hay tercero. Escribir ahí un estimado haría que
// v_costo_servicio contara los mismos soles dos veces y levantaría actas de compra
// contra un proveedor que no existe. El presupuesto vive en su propia tabla.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { X, Calculator, AlertTriangle } from "lucide-react";
import {
  cargarContextoCosteo, calcularPresupuesto, guardarPresupuesto,
  cargarRealPorConcepto, cargarPresupuesto,
  type ContextoCosteo, type EntradaCosteo, type ReservaCosteable, type LineaCosto,
} from "@/lib/costeo-servicio";

const soles = (n: number) => `S/ ${Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";

const ENTRADA_VACIA: EntradaCosteo = {
  km: 0, kmFuente: "", dias: 1, peajes: 0, viaticos: 0, estacionamiento: 0, pernocte: 0, otros: 0,
};

export default function ModalCostear({
  reserva, onCerrar, onGuardado,
}: {
  reserva: ReservaCosteable;
  onCerrar: () => void;
  onGuardado?: () => void;
}) {
  const [ctx, setCtx]         = useState<ContextoCosteo | null>(null);
  const [entrada, setEntrada] = useState<EntradaCosteo>(ENTRADA_VACIA);
  const [real, setReal]       = useState<Record<string, number>>({});
  const [guardado, setGuardado] = useState<{ total: number; version: number } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");
  const [usuario, setUsuario] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const [c, reales, prev, ses] = await Promise.all([
        cargarContextoCosteo(supabase, reserva),
        cargarRealPorConcepto(supabase, reserva.id),
        cargarPresupuesto(supabase, reserva.id),
        // Quién costeó queda escrito en el presupuesto. Se resuelve aquí y no en la
        // página porque el modal ya está haciendo trabajo asíncrono.
        supabase.auth.getUser(),
      ]);
      if (!vivo) return;
      setUsuario(String((ses as any)?.data?.user?.email ?? "") || null);
      const mapa: Record<string, number> = {};
      for (const r of reales) mapa[r.concepto] = r.monto;
      setReal(mapa);
      setCtx(c);
      // Si ya hay presupuesto, se abre con sus valores: re-costear es corregir lo
      // anterior, no empezar de cero.
      if (prev) {
        const por = (k: string) => Number(prev.lineas.find((l) => l.concepto === k)?.monto ?? 0);
        setEntrada({
          km: Number(prev.cabecera.km ?? 0),
          kmFuente: (prev.cabecera.km_fuente ?? "manual") as EntradaCosteo["kmFuente"],
          dias: Number(prev.cabecera.dias ?? 1),
          peajes: por("peajes"), viaticos: por("viaticos"),
          estacionamiento: por("estacionamiento"), pernocte: por("pernocte"), otros: por("otro"),
        });
        setGuardado({ total: Number(prev.cabecera.total_estimado ?? 0), version: Number(prev.cabecera.version ?? 1) });
      } else if (c.kmSugerido) {
        setEntrada({ ...ENTRADA_VACIA, km: c.kmSugerido.km, kmFuente: c.kmSugerido.fuente });
      }
      setCargando(false);
    })();
    return () => { vivo = false; };
  }, [reserva]);

  const presupuesto = useMemo(
    () => (ctx ? calcularPresupuesto(ctx, entrada) : null),
    [ctx, entrada]
  );

  // Filas de la tabla: la unión de lo presupuestado y lo real, para que un gasto
  // que nadie previó también se vea. Un real sin plan es tan informativo como un
  // plan sin real.
  const filas = useMemo(() => {
    const porConcepto = new Map<string, { linea?: LineaCosto; real: number }>();
    for (const l of presupuesto?.lineas ?? []) porConcepto.set(l.concepto, { linea: l, real: real[l.concepto] ?? 0 });
    for (const [k, v] of Object.entries(real)) {
      if (!porConcepto.has(k)) porConcepto.set(k, { real: v });
    }
    return [...porConcepto.entries()]
      .map(([concepto, v]) => ({ concepto, ...v }))
      .sort((a, b) => (a.linea?.orden ?? 98) - (b.linea?.orden ?? 98));
  }, [presupuesto, real]);

  const totalReal = useMemo(() => Object.values(real).reduce((s, n) => s + n, 0), [real]);
  const ingreso = Number(reserva.precio_cliente ?? 0);
  // Utilidad contra el presupuesto: el imputado (conductor y desgaste) nunca va a
  // tener comprobante, así que sale del plan aunque el real ya esté cargado.
  const costoEstimadoTotal = presupuesto?.total ?? 0;
  const utilidad = ingreso - costoEstimadoTotal;

  const set = (k: keyof EntradaCosteo) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEntrada((p) => ({ ...p, [k]: Number(e.target.value || 0), ...(k === "km" ? { kmFuente: "manual" as const } : {}) }));

  async function guardar() {
    if (!presupuesto || !ctx) return;
    setGuardando(true); setMsg("");
    const r = await guardarPresupuesto(supabase, reserva.id, presupuesto, {
      usuario,
      parametros: {
        placa: ctx.placa,
        rendimiento: ctx.rendimientoMedido,
        precio_galon: ctx.precioUltimaCarga,
        deprec_km: ctx.deprecKm,
        regimen: ctx.conductor?.regimen?.regimen ?? null,
        dias_con_servicio: ctx.diasConServicio,
      },
    });
    setGuardando(false);
    if (!r.ok) {
      setMsg(/servicio_costo_estimado|cat_concepto_costo|config_laboral/i.test(String(r.error))
        ? "Falta correr supabase/costeo-01-planilla-y-presupuesto.sql en Supabase."
        : "⚠️ " + r.error);
      return;
    }
    setGuardado({ total: presupuesto.total, version: r.version ?? 1 });
    setMsg(`✅ Presupuesto guardado (versión ${r.version}).`);
    onGuardado?.();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col" style={{ maxHeight: "calc(100vh - 16px)" }}>

        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "#e2e8f0" }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: "#0f5257" }}>
              <Calculator size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Costear el servicio</h2>
              <p className="text-xs text-gray-400">
                {reserva.codigo ?? `#${reserva.id}`}
                {ctx?.placa ? ` · ${ctx.placa}` : ""}
                {reserva.ruta_nombre ? ` · ${reserva.ruta_nombre}` : ""}
              </p>
            </div>
          </div>
          <button onClick={onCerrar} className="p-2 rounded-xl hover:bg-gray-100"><X size={18} className="text-gray-500" /></button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {cargando ? (
            <p className="text-sm text-gray-400">Resolviendo rendimiento, depreciación y planilla…</p>
          ) : (
            <>
              {/* Lo que el operador teclea */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Kilómetros *</label>
                  <input type="number" min="0" step="0.1" className={inputCls} value={entrada.km || ""} onChange={set("km")} />
                  <p className="text-[10px] text-gray-400 mt-1">
                    {entrada.kmFuente === "ruta" ? "de un costeo anterior de esta ruta"
                     : entrada.kmFuente === "manual" ? "tecleado"
                     : "sin km no se puede costear"}
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Días</label>
                  <input type="number" min="1" step="1" className={inputCls} value={entrada.dias} onChange={set("dias")} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Peajes S/</label>
                  <input type="number" min="0" step="0.5" className={inputCls} value={entrada.peajes || ""} onChange={set("peajes")} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Viáticos S/</label>
                  <input type="number" min="0" step="0.5" className={inputCls} value={entrada.viaticos || ""} onChange={set("viaticos")} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Estacionamiento S/</label>
                  <input type="number" min="0" step="0.5" className={inputCls} value={entrada.estacionamiento || ""} onChange={set("estacionamiento")} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Pernocte S/</label>
                  <input type="number" min="0" step="0.5" className={inputCls} value={entrada.pernocte || ""} onChange={set("pernocte")} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Otros S/</label>
                  <input type="number" min="0" step="0.5" className={inputCls} value={entrada.otros || ""} onChange={set("otros")} />
                </div>
                <div className="flex items-end">
                  <p className="text-[10px] text-gray-400 leading-snug">
                    Lo que escribas aquí es el <b>plan</b>. El real entra por Seguimiento con su comprobante.
                  </p>
                </div>
              </div>

              {/* Lo que falta para costear del todo */}
              {!!presupuesto?.faltantes.length && (
                <div className="rounded-xl border px-4 py-3 text-[12px] space-y-1" style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#854d0e" }}>
                  <p className="font-bold flex items-center gap-1.5"><AlertTriangle size={13} /> El presupuesto sale incompleto</p>
                  {presupuesto.faltantes.map((f, i) => <p key={i}>· {f}</p>)}
                </div>
              )}

              {/* Presupuestado vs real */}
              <div className="border rounded-xl overflow-x-auto" style={{ borderColor: "#e2e8f0" }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      <th className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-gray-500">Concepto</th>
                      <th className="text-right px-3 py-2 text-[10px] font-bold uppercase tracking-wide" style={{ color: "#a1622a" }}>Presupuestado</th>
                      <th className="text-right px-3 py-2 text-[10px] font-bold uppercase tracking-wide" style={{ color: "#0f5257" }}>Real</th>
                      <th className="text-right px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-gray-500">Δ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y" style={{ borderColor: "#eef2f2" }}>
                    {filas.map((f) => {
                      const plan = f.linea?.monto ?? 0;
                      const rl = f.real ?? 0;
                      const delta = f.linea?.imputado || !plan || !rl ? null : rl - plan;
                      return (
                        <tr key={f.concepto}>
                          <td className="px-3 py-2">
                            <span className="block text-gray-800">{f.linea?.nombre ?? f.concepto}</span>
                            {f.linea?.base && <span className="block text-[10.5px] text-gray-400 leading-snug">{f.linea.base}</span>}
                            {!f.linea && <span className="block text-[10.5px] text-gray-400">gasto real sin previsión</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums" style={{ color: "#a1622a" }}>
                            {plan ? soles(plan) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums" style={{ color: "#0f5257" }}>
                            {/* Los que se amortizan no tienen real por servicio, y decirlo
                                es mejor que un guion que se lee como "falta cargarlo". */}
                            {f.linea?.imputado ? <span className="text-gray-300">se amortiza</span> : rl ? soles(rl) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums" style={{ color: delta == null ? "#9ca3af" : delta > 0 ? "#9f1239" : "#166534" }}>
                            {delta == null ? "—" : (delta > 0 ? "+" : "") + delta.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                    <tr style={{ background: "#f8fafc" }}>
                      <td className="px-3 py-2 font-bold text-gray-800">
                        Costo del servicio
                        <span className="block text-[10.5px] font-normal text-gray-400">
                          de los cuales {soles(presupuesto?.totalImputado ?? 0)} son imputados
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums" style={{ color: "#a1622a" }}>{soles(presupuesto?.total ?? 0)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums" style={{ color: "#0f5257" }}>{soles(totalReal)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums" style={{ color: totalReal > (presupuesto?.totalComparable ?? 0) ? "#9f1239" : "#166534" }}>
                        {totalReal && presupuesto?.totalComparable
                          ? (totalReal - presupuesto.totalComparable > 0 ? "+" : "") + (totalReal - presupuesto.totalComparable).toFixed(2)
                          : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* La utilidad, que es el objetivo */}
              <div className="rounded-xl border px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-2" style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
                <div>
                  <span className="block text-[10px] uppercase tracking-wide text-gray-400">Precio al cliente</span>
                  <span className="font-black tabular-nums text-gray-700">{soles(ingreso)}</span>
                </div>
                <span className="text-gray-300">−</span>
                <div>
                  <span className="block text-[10px] uppercase tracking-wide text-gray-400">Costo presupuestado</span>
                  <span className="font-black tabular-nums" style={{ color: "#a1622a" }}>{soles(costoEstimadoTotal)}</span>
                </div>
                <span className="text-gray-300">=</span>
                <div>
                  <span className="block text-[10px] uppercase tracking-wide text-gray-400">Utilidad estimada</span>
                  <span className="font-black tabular-nums" style={{ color: utilidad >= 0 ? "#166534" : "#9f1239" }}>
                    {soles(utilidad)}
                    {ingreso > 0 && <span className="text-xs font-bold ml-1.5">({((utilidad / ingreso) * 100).toFixed(1)} %)</span>}
                  </span>
                </div>
                <p className="text-[10px] text-gray-400 flex-1 min-w-[180px] leading-snug">
                  Sobre el precio con IGV. La utilidad neta antes de impuestos, con los
                  importes sin IGV, sale en <b>v_utilidad_servicio</b>.
                </p>
              </div>

              {!!msg && <p className="text-xs" style={{ color: msg.startsWith("✅") ? "#166534" : "#9f1239" }}>{msg}</p>}
            </>
          )}
        </div>

        <div className="flex items-center gap-3 px-6 py-4 border-t shrink-0" style={{ borderColor: "#e2e8f0" }}>
          {guardado && (
            <span className="text-[11px] text-gray-400">
              Guardado v{guardado.version} · {soles(guardado.total)}
            </span>
          )}
          <button
            onClick={guardar}
            disabled={cargando || guardando || !(entrada.km > 0)}
            className="ml-auto px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-40"
            style={{ background: "#0f5257" }}
          >
            {guardando ? "Guardando…" : guardado ? "Guardar nueva versión" : "Guardar presupuesto"}
          </button>
          <button onClick={onCerrar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
