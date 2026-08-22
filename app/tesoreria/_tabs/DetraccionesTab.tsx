"use client";

// ──────────────────────────────────────────────────────────────────────────────
// Pestaña "Detracciones" — la bandeja de control SUNAT / Banco de la Nación.
//
// Lee v_detracciones_pendientes, que une los DOS lados del mismo impuesto y que hasta
// ahora nadie miraba junto:
//   · COMPRA → lo que AFA debe depositar en la cuenta de detracciones del proveedor.
//   · VENTA  → lo que el cliente nos retuvo y todavía no aparece como constancia.
//
// El estado de la detracción es INDEPENDIENTE del estado de pago de la factura: se
// puede haber pagado al proveedor y seguir debiendo el depósito al BN. Por eso vive
// en su propia pestaña y no como una columna más de cuentas por pagar.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda, redondear } from "@/lib/finanzas/dinero";
import { exportarXlsx, type Columna } from "@/lib/finanzas/exportar";
import PanelTasasDetraccion from "../PanelTasasDetraccion";

type FilaDetraccion = {
  lado: "compra" | "venta";
  origen_id: number;
  contraparte: string | null;
  ruc: string | null;
  comprobante: string | null;
  fecha_emision: string;
  total: number | null;
  detraccion_codigo: string | null;
  detraccion_pct: number | null;
  detraccion_monto: number | null;
  estado_detraccion: string;
  detraccion_constancia: string | null;
  detraccion_fecha_pago: string | null;
  dias_desde_emision: number | null;
};

const CABECERAS_COMPRA = ["", "Emisión", "Proveedor", "RUC", "Comprobante", "Total", "Código", "%", "Monto", "Días", "Acciones"];
const CABECERAS_VENTA = ["Emisión", "Cliente", "RUC", "Comprobante", "Total", "Monto retenido", "Días"];

const COLUMNAS_EXPORT: Columna<FilaDetraccion>[] = [
  { titulo: "FECHA DE EMISION", valor: (d) => d.fecha_emision, tipo: "fecha" },
  { titulo: "PROVEEDOR", valor: (d) => d.contraparte ?? "" },
  { titulo: "RUC", valor: (d) => d.ruc ?? "" },
  { titulo: "COMPROBANTE", valor: (d) => d.comprobante ?? "" },
  { titulo: "TOTAL", valor: (d) => Number(d.total ?? 0), tipo: "monto" },
  { titulo: "CODIGO DETRACCION", valor: (d) => d.detraccion_codigo ?? "" },
  { titulo: "PORCENTAJE", valor: (d) => Number(d.detraccion_pct ?? 0), tipo: "numero" },
  { titulo: "MONTO DETRACCION", valor: (d) => Number(d.detraccion_monto ?? 0), tipo: "monto" },
  { titulo: "DIAS DESDE EMISION", valor: (d) => Number(d.dias_desde_emision ?? 0), tipo: "entero" },
];

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

function Campo({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

function hoyLima(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function fmtFecha(f: string | null | undefined): string {
  if (!f) return "—";
  return new Date(f.slice(0, 10) + "T00:00:00").toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Chip de antigüedad: la detracción se deposita el mes siguiente, +30 días ya duele. */
function chipDias(dias: number | null) {
  const d = Number(dias ?? 0);
  if (d > 30) return { label: `${d} d`, bg: "#fee2e2", color: "#991b1b" };
  if (d > 15) return { label: `${d} d`, bg: "#fff7ed", color: "#ea580c" };
  return { label: `${d} d`, bg: "#f3f4f6", color: "#4b5563" };
}

export default function DetraccionesTab() {
  const [filas, setFilas] = useState<FilaDetraccion[]>([]);
  const [loading, setLoading] = useState(true);
  const [seleccion, setSeleccion] = useState<Set<number>>(new Set());

  const [depositando, setDepositando] = useState<FilaDetraccion[] | null>(null);
  const [constancia, setConstancia] = useState("");
  const [fechaDeposito, setFechaDeposito] = useState(hoyLima());
  const [procesando, setProcesando] = useState(false);

  // Editar tasas es decisión de gerencia; el resto ve el catálogo en lectura.
  const [puedeEditarTasas, setPuedeEditarTasas] = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("v_detracciones_pendientes")
      .select("*")
      .order("fecha_emision", { ascending: true });
    setFilas((data ?? []) as FilaDetraccion[]);
    setSeleccion(new Set());
    setLoading(false);
  }, []);

  // Carga inicial (patrón de todo el ERP). La regla del linter apunta a otro caso
  // —setState síncrono en el cuerpo del efecto—; aquí se escribe tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;
      const { data } = await supabase.from("usuarios").select("rol").eq("id", session.user.id).maybeSingle();
      if (vivo) setPuedeEditarTasas(data?.rol === "admin" || data?.rol === "gerente");
    })();
    return () => { vivo = false; };
  }, []);

  const compras = useMemo(() => filas.filter((d) => d.lado === "compra"), [filas]);
  const ventas = useMemo(() => filas.filter((d) => d.lado === "venta"), [filas]);

  const totalDepositar = useMemo(
    () => redondear(compras.reduce((s, d) => s + Number(d.detraccion_monto ?? 0), 0)),
    [compras]
  );
  const masAntiguo = useMemo(
    () => compras.reduce((max, d) => Math.max(max, Number(d.dias_desde_emision ?? 0)), 0),
    [compras]
  );
  const totalRetenido = useMemo(
    () => redondear(ventas.reduce((s, d) => s + Number(d.detraccion_monto ?? 0), 0)),
    [ventas]
  );

  const kpis = [
    { label: "Total a depositar", valor: fmtMoneda(totalDepositar), color: "#0b315f", bg: "#eef3f8" },
    { label: "Comprobantes", valor: String(compras.length), color: "#854d0e", bg: "#fef9c3" },
    { label: "El más antiguo", valor: `${masAntiguo} días`, color: masAntiguo > 30 ? "#991b1b" : "#166534", bg: masAntiguo > 30 ? "#fee2e2" : "#dcfce7" },
    { label: "Nos retuvieron (ventas)", valor: fmtMoneda(totalRetenido), color: "#6d28d9", bg: "#ede9fe" },
  ];

  const seleccionadas = useMemo(() => compras.filter((d) => seleccion.has(d.origen_id)), [compras, seleccion]);

  const alternar = useCallback((id: number) => {
    setSeleccion((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }, []);

  const todasMarcadas = compras.length > 0 && compras.every((d) => seleccion.has(d.origen_id));
  const alternarTodas = useCallback(() => {
    setSeleccion((prev) => {
      if (compras.length && compras.every((d) => prev.has(d.origen_id))) return new Set();
      return new Set(compras.map((d) => d.origen_id));
    });
  }, [compras]);

  const abrirDeposito = useCallback((lista: FilaDetraccion[]) => {
    setConstancia("");
    setFechaDeposito(hoyLima());
    setDepositando(lista);
  }, []);

  const confirmarDeposito = useCallback(async () => {
    if (!depositando?.length) return;
    if (!fechaDeposito) return showToast("Indica la fecha del depósito.", false);
    const ids = depositando.map((d) => d.origen_id);
    setProcesando(true);
    const { error } = await supabase
      .from("documentos_compra")
      .update({
        estado_detraccion: "pagada",
        detraccion_constancia: constancia.trim() || null,
        detraccion_fecha_pago: fechaDeposito,
      })
      .in("id", ids);
    setProcesando(false);
    if (error) return showToast(error.message, false);
    setDepositando(null);
    showToast(`${ids.length} detracción${ids.length === 1 ? "" : "es"} marcada${ids.length === 1 ? "" : "s"} como depositada${ids.length === 1 ? "" : "s"}.`);
    cargar();
  }, [depositando, constancia, fechaDeposito, cargar, showToast]);

  const exportar = useCallback(() => {
    if (!compras.length) return showToast("No hay detracciones pendientes que exportar.", false);
    exportarXlsx(compras, COLUMNAS_EXPORT, {
      nombre: "detracciones_por_depositar",
      hoja: "Detracciones",
      titulo: "Detracciones por depositar · Banco de la Nación",
      subtitulo: `${compras.length} comprobantes · ${fmtMoneda(totalDepositar)} · generado el ${fmtFecha(hoyLima())}`,
      totales: true,
    }).catch((e) => showToast(`No se pudo generar el Excel: ${String((e as Error)?.message ?? e)}`, false));
  }, [compras, totalDepositar, showToast]);

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white ${
            toast.ok ? "bg-[#0b315f]" : "bg-red-600"
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Detracciones</h1>
          <p className="text-gray-400 text-sm mt-1">Depósitos al Banco de la Nación · Constancias · Lado compra y lado venta</p>
        </div>
        <button
          className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
          style={{ borderColor: "#0b315f", color: "#0b315f" }}
          onClick={exportar}
        >
          ⬇️ Exportar para SUNAT
        </button>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>
              {k.label}
            </p>
            <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>
              {k.valor}
            </p>
          </div>
        ))}
      </section>

      {/* La tasa y el código son decisión del contador, no del ERP: aquí se editan.
          El aviso que había antes citaba los códigos AL REVÉS (027 como transporte de
          personas); ahora el dato vive en el catálogo y no en un texto suelto. */}
      <PanelTasasDetraccion puedeEditar={puedeEditarTasas} onCambio={cargar} />

      {/* ── Lado compra ── */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between flex-wrap gap-2" style={{ borderColor: "#e2e8f0" }}>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Compras · por depositar en el Banco de la Nación</h2>
            <p className="text-xs text-gray-400">Lo que AFA detrajo al proveedor y todavía no depositó.</p>
          </div>
          <p className="text-sm font-black text-red-700">{fmtMoneda(totalDepositar)}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {CABECERAS_COMPRA.map((h, i) => (
                  <th key={h + i} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {i === 0 ? <input type="checkbox" checked={todasMarcadas} onChange={alternarTodas} aria-label="Seleccionar todo" /> : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={CABECERAS_COMPRA.length} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                      Cargando…
                    </div>
                  </td>
                </tr>
              )}
              {!loading && !compras.length && (
                <tr>
                  <td colSpan={CABECERAS_COMPRA.length} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">🏦</p>
                    <p>No hay detracciones pendientes de depósito</p>
                  </td>
                </tr>
              )}
              {!loading &&
                compras.map((d) => {
                  const dias = chipDias(d.dias_desde_emision);
                  return (
                    <tr key={`compra-${d.origen_id}`} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={seleccion.has(d.origen_id)}
                          onChange={() => alternar(d.origen_id)}
                          aria-label={`Seleccionar ${d.comprobante ?? d.origen_id}`}
                        />
                      </td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(d.fecha_emision)}</td>
                      <td className="p-3 text-xs font-bold text-gray-800">{d.contraparte ?? "—"}</td>
                      <td className="p-3 font-mono text-xs text-gray-500">{d.ruc ?? "—"}</td>
                      <td className="p-3 font-mono font-black text-xs text-[#0b315f] whitespace-nowrap">{d.comprobante ?? "—"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtMoneda(Number(d.total ?? 0))}</td>
                      <td className="p-3 font-mono font-black text-xs text-[#0b315f]">{d.detraccion_codigo ?? "—"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium">{d.detraccion_pct != null ? `${Number(d.detraccion_pct)}%` : "—"}</td>
                      <td className="p-3 font-black text-xs text-red-700 whitespace-nowrap">{fmtMoneda(Number(d.detraccion_monto ?? 0))}</td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg whitespace-nowrap" style={{ background: dias.bg, color: dias.color }}>
                          {dias.label}
                        </span>
                      </td>
                      <td className="p-3">
                        <button
                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700 whitespace-nowrap"
                          onClick={() => abrirDeposito([d])}
                        >
                          Marcar depositada
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>{compras.length} comprobantes con detracción pendiente</span>
          <span>Total: {fmtMoneda(totalDepositar)}</span>
        </div>
      </section>

      {/* ── Lado venta ── */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between flex-wrap gap-2" style={{ borderColor: "#e2e8f0" }}>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Ventas · detracciones que nos retuvieron</h2>
            <p className="text-xs text-gray-400">Facturas emitidas sin constancia de depósito registrada: hay que reclamarla al cliente.</p>
          </div>
          <p className="text-sm font-black" style={{ color: "#6d28d9" }}>
            {fmtMoneda(totalRetenido)}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {CABECERAS_VENTA.map((h) => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={CABECERAS_VENTA.length} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                      Cargando…
                    </div>
                  </td>
                </tr>
              )}
              {!loading && !ventas.length && (
                <tr>
                  <td colSpan={CABECERAS_VENTA.length} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">📄</p>
                    <p>No hay detracciones de venta sin constancia</p>
                  </td>
                </tr>
              )}
              {!loading &&
                ventas.map((d) => {
                  const dias = chipDias(d.dias_desde_emision);
                  return (
                    <tr key={`venta-${d.origen_id}`} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(d.fecha_emision)}</td>
                      <td className="p-3 text-xs font-bold text-gray-800">{d.contraparte ?? "—"}</td>
                      <td className="p-3 font-mono text-xs text-gray-500">{d.ruc ?? "—"}</td>
                      <td className="p-3 font-mono font-black text-xs text-[#0b315f] whitespace-nowrap">{d.comprobante ?? "—"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtMoneda(Number(d.total ?? 0))}</td>
                      <td className="p-3 font-black text-xs whitespace-nowrap" style={{ color: "#6d28d9" }}>
                        {fmtMoneda(Number(d.detraccion_monto ?? 0))}
                      </td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg whitespace-nowrap" style={{ background: dias.bg, color: dias.color }}>
                          {dias.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>

      {seleccionadas.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-white rounded-2xl border shadow-xl px-5 py-3 flex items-center gap-4 flex-wrap max-w-[95vw]">
          <p className="text-sm font-bold text-[#0b315f]">
            {seleccionadas.length} seleccionada{seleccionadas.length === 1 ? "" : "s"} ·{" "}
            {fmtMoneda(redondear(seleccionadas.reduce((s, d) => s + Number(d.detraccion_monto ?? 0), 0)))}
          </p>
          <button
            className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => abrirDeposito(seleccionadas)}
          >
            Marcar depositadas
          </button>
          <button className="text-xs text-gray-400 hover:text-gray-600" onClick={() => setSeleccion(new Set())}>
            Limpiar
          </button>
        </div>
      )}

      {depositando && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setDepositando(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b">
              <h3 className="font-bold text-gray-900">
                Marcar {depositando.length === 1 ? "detracción depositada" : `${depositando.length} detracciones depositadas`}
              </h3>
              <p className="text-xs text-gray-400 mt-1">
                Registra el número de constancia que devuelve el Banco de la Nación y la fecha del depósito.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="rounded-xl border p-3" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
                <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Importe a depositar</p>
                <p className="text-xl font-black text-[#0b315f]">
                  {fmtMoneda(redondear(depositando.reduce((s, d) => s + Number(d.detraccion_monto ?? 0), 0)))}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="N° de constancia">
                  <input className={inputCls("font-mono")} value={constancia} onChange={(e) => setConstancia(e.target.value)} placeholder="Constancia BN" />
                </Campo>
                <Campo label="Fecha del depósito">
                  <input type="date" className={inputCls()} value={fechaDeposito} onChange={(e) => setFechaDeposito(e.target.value)} />
                </Campo>
              </div>
              {depositando.length > 1 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
                  <span>ℹ️</span>
                  La misma constancia y fecha se aplicarán a los {depositando.length} comprobantes seleccionados.
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t flex justify-end gap-3">
              <button className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50" onClick={() => setDepositando(null)}>
                Cancelar
              </button>
              <button
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
                style={{ background: "#0b315f" }}
                onClick={confirmarDeposito}
                disabled={procesando}
              >
                {procesando ? "Guardando…" : "Confirmar depósito"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
