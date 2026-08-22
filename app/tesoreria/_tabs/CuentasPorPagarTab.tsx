"use client";

// ──────────────────────────────────────────────────────────────────────────────
// Pestaña "Cuentas por pagar" — la bandeja de deuda con proveedores.
//
// Lee la VISTA v_cuentas_por_pagar y NUNCA la tabla: monto_a_cancelar, pagado, saldo
// y dias_vencido son derivados que calcula Postgres; recalcularlos aquí sería abrir
// la puerta a que la pantalla y el lote de pago digan cosas distintas.
//
// Dos ejes ortogonales conviven en la grilla y no deben mezclarse: APROBACIÓN
// (pendiente → aprobado_gerencia → incluido_lote) y PAGO (impaga → parcial → pagada).
// Una factura puede estar aprobada y sin pagar, o pagada y sin aprobar (histórico).
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cubetaAging, fmtMoneda, redondear } from "@/lib/finanzas/dinero";
import { exportarXlsx, type Columna } from "@/lib/finanzas/exportar";
import { PERFILES_CXP } from "@/lib/importador/perfiles-finanzas";
import ImportadorFinanzas from "@/app/_components/ImportadorFinanzas";
import type { CuentaPorPagar } from "@/lib/finanzas/tipos";
import ModalCxP from "../ModalCxP";

type ConfigChip = { label: string; bg: string; color: string };

const ESTADOS_PAGO: Record<string, ConfigChip> = {
  impaga: { label: "Impaga", bg: "#fee2e2", color: "#991b1b" },
  parcial: { label: "Parcial", bg: "#fef9c3", color: "#854d0e" },
  pagada: { label: "Pagada", bg: "#dcfce7", color: "#166534" },
};

const ESTADOS_APROBACION: Record<string, ConfigChip> = {
  pendiente: { label: "Pendiente", bg: "#f3f4f6", color: "#4b5563" },
  aprobado_gerencia: { label: "Aprobada", bg: "#dbeafe", color: "#1d4ed8" },
  incluido_lote: { label: "En lote", bg: "#ede9fe", color: "#6d28d9" },
  rechazado: { label: "Rechazada", bg: "#fee2e2", color: "#991b1b" },
};

const ESTADOS_DETRACCION: Record<string, ConfigChip> = {
  no_aplica: { label: "No aplica", bg: "#f3f4f6", color: "#4b5563" },
  pendiente: { label: "Por depositar", bg: "#fef9c3", color: "#854d0e" },
  pagada: { label: "Depositada", bg: "#dcfce7", color: "#166534" },
};

const AGING: Record<string, ConfigChip> = {
  vigente: { label: "Vigente", bg: "#dcfce7", color: "#166534" },
  "0-30": { label: "1-30 d", bg: "#fef9c3", color: "#854d0e" },
  "31-60": { label: "31-60 d", bg: "#fff7ed", color: "#ea580c" },
  "61-90": { label: "61-90 d", bg: "#fee2e2", color: "#991b1b" },
  "+90": { label: "+90 d", bg: "#fee2e2", color: "#991b1b" },
};

const CABECERAS = [
  "",
  "Emisión",
  "Proveedor",
  "Factura",
  "Servicio",
  "Placa",
  "Monto neto",
  "Adelantos",
  "Detracción",
  "A cancelar",
  "Saldo",
  "Vencimiento",
  "Aprobación",
  "Estado pago",
  "Acciones",
];

/** Cabeceras del export = las que reconoce el importador (ciclo Sheets ↔ ERP). */
const COLUMNAS_EXPORT: Columna<CuentaPorPagar>[] = [
  { titulo: "PROVEEDOR", valor: (d) => d.proveedor_razon_social ?? "" },
  { titulo: "RUC", valor: (d) => d.proveedor_ruc ?? "" },
  { titulo: "TITULAR DE LA CUENTA", valor: (d) => d.titular_cuenta ?? "" },
  { titulo: "BANCO", valor: (d) => d.banco ?? "" },
  { titulo: "NUMERO DE CUENTA", valor: (d) => d.numero_cuenta ?? "" },
  { titulo: "CCI", valor: (d) => d.cci ?? "" },
  { titulo: "CODIGO DE SERVICIO", valor: (d) => d.codigo_servicio ?? "" },
  { titulo: "DETALLE DEL SERVICIO", valor: (d) => d.detalle_servicio ?? "" },
  { titulo: "PLACA DE VEHICULO", valor: (d) => d.vehiculo_placa ?? "" },
  { titulo: "FECHA DE SERVICIO", valor: (d) => d.fecha_servicio ?? "", tipo: "fecha" },
  { titulo: "N FACTURA", valor: (d) => d.numero_factura ?? "" },
  { titulo: "FECHA DE EMISION", valor: (d) => d.fecha_emision, tipo: "fecha" },
  { titulo: "MONTO NETO", valor: (d) => Number(d.monto_neto ?? 0), tipo: "monto" },
  { titulo: "ADELANTO 1", valor: (d) => Number(d.adelanto_1 ?? 0), tipo: "monto" },
  { titulo: "ADELANTO 2", valor: (d) => Number(d.adelanto_2 ?? 0), tipo: "monto" },
  { titulo: "DETRACCION", valor: (d) => Number(d.detraccion_monto ?? 0), tipo: "monto" },
  { titulo: "ESTADO DETRACCION", valor: (d) => ESTADOS_DETRACCION[d.estado_detraccion]?.label ?? d.estado_detraccion },
  { titulo: "ESTADO", valor: (d) => ESTADOS_PAGO[d.estado_pago]?.label ?? d.estado_pago },
  { titulo: "NRO OPERACION", valor: (d) => d.nro_operacion_bancaria ?? "" },
  { titulo: "FECHA DE PAGO", valor: (d) => d.fecha_pago ?? "", tipo: "fecha" },
  { titulo: "OBSERVACIONES", valor: (d) => d.observaciones ?? "" },
];

function fmtFecha(f: string | null | undefined): string {
  if (!f) return "—";
  // Sin el sufijo T00:00:00 la fecha civil se corre un día por UTC-5.
  return new Date(f.slice(0, 10) + "T00:00:00").toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function Chip({ cfg }: { cfg: ConfigChip }) {
  return (
    <span className="text-xs font-bold px-2.5 py-1 rounded-lg whitespace-nowrap" style={{ background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}

export default function CuentasPorPagarTab() {
  const [filas, setFilas] = useState<CuentaPorPagar[]>([]);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [fEstadoPago, setFEstadoPago] = useState("");
  const [fAprobacion, setFAprobacion] = useState("");
  const [fProveedor, setFProveedor] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");

  const [seleccion, setSeleccion] = useState<Set<number>>(new Set());
  const [puedeAprobar, setPuedeAprobar] = useState(false);
  const [usuarioNombre, setUsuarioNombre] = useState("");

  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<CuentaPorPagar | null>(null);
  // Cambia en cada apertura: es la `key` que remonta ModalCxP con el formulario limpio
  // (o cargado con la fila que se va a editar) sin que el modal tenga que resetearse solo.
  const [apertura, setApertura] = useState(0);
  const [importando, setImportando] = useState(false);
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [procesando, setProcesando] = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("v_cuentas_por_pagar")
      .select("*")
      .order("fecha_emision", { ascending: false })
      .order("id", { ascending: false });
    setFilas((data ?? []) as CuentaPorPagar[]);
    setSeleccion(new Set());
    setLoading(false);
  }, []);

  // Carga inicial (patrón de todo el ERP). La regla del linter apunta a otro caso
  // —setState síncrono en el cuerpo del efecto—; aquí se escribe tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  // El rol decide si se puede aprobar. No se usa usePermiso: no contempla admin y
  // expulsaría a un admin sin fila en permisos_usuario.
  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user?.id) return;
      const { data } = await supabase.from("usuarios").select("nombre, rol").eq("id", session.user.id).maybeSingle();
      setUsuarioNombre(String(data?.nombre ?? ""));
      setPuedeAprobar(data?.rol === "admin" || data?.rol === "gerente");
    })();
  }, []);

  const proveedoresUnicos = useMemo(() => {
    const set = new Set<string>();
    for (const d of filas) if (d.proveedor_razon_social) set.add(d.proveedor_razon_social);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
  }, [filas]);

  const filtradas = useMemo(() => {
    const texto = q.trim().toLowerCase();
    return filas.filter((d) => {
      if (fEstadoPago && d.estado_pago !== fEstadoPago) return false;
      if (fAprobacion && d.estado_aprobacion !== fAprobacion) return false;
      if (fProveedor && d.proveedor_razon_social !== fProveedor) return false;
      if (desde && d.fecha_emision < desde) return false;
      if (hasta && d.fecha_emision > hasta) return false;
      if (!texto) return true;
      return (
        (d.proveedor_razon_social ?? "").toLowerCase().includes(texto) ||
        (d.proveedor_ruc ?? "").includes(texto) ||
        (d.numero_factura ?? "").toLowerCase().includes(texto) ||
        (d.vehiculo_placa ?? "").toLowerCase().includes(texto) ||
        (d.codigo_servicio ?? "").toLowerCase().includes(texto)
      );
    });
  }, [filas, q, fEstadoPago, fAprobacion, fProveedor, desde, hasta]);

  // Los KPI del Plan Maestro miran SIEMPRE el universo completo, no lo filtrado: son
  // el semáforo del módulo y no deben cambiar porque alguien escriba en el buscador.
  const kpis = useMemo(() => {
    const deuda = filas.filter((d) => d.estado_pago !== "pagada").reduce((s, d) => s + Number(d.saldo ?? 0), 0);
    const detracciones = filas
      .filter((d) => d.estado_detraccion === "pendiente")
      .reduce((s, d) => s + Number(d.detraccion_monto ?? 0), 0);
    const enLote = filas
      .filter((d) => d.estado_aprobacion === "incluido_lote")
      .reduce((s, d) => s + Number(d.monto_a_cancelar ?? 0), 0);
    const vencidas = filas
      .filter((d) => d.estado_pago !== "pagada" && Number(d.dias_vencido ?? 0) > 30)
      .reduce((s, d) => s + Number(d.saldo ?? 0), 0);
    return [
      { label: "Total deuda pendiente", valor: fmtMoneda(redondear(deuda)), color: "#0b315f", bg: "#eef3f8" },
      { label: "Detracciones por pagar", valor: fmtMoneda(redondear(detracciones)), color: "#854d0e", bg: "#fef9c3" },
      { label: "Lote aprobado Telecrédito", valor: fmtMoneda(redondear(enLote)), color: "#166534", bg: "#dcfce7" },
      { label: "Vencidas +30 días", valor: fmtMoneda(redondear(vencidas)), color: "#991b1b", bg: "#fee2e2" },
    ];
  }, [filas]);

  const seleccionadas = useMemo(() => filtradas.filter((d) => seleccion.has(d.id)), [filtradas, seleccion]);
  const totalSeleccion = useMemo(
    () => redondear(seleccionadas.reduce((s, d) => s + Number(d.monto_a_cancelar ?? 0), 0)),
    [seleccionadas]
  );

  const alternar = useCallback((id: number) => {
    setSeleccion((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }, []);

  const todasMarcadas = filtradas.length > 0 && filtradas.every((d) => seleccion.has(d.id));
  const alternarTodas = useCallback(() => {
    setSeleccion((prev) => {
      if (filtradas.length && filtradas.every((d) => prev.has(d.id))) return new Set();
      return new Set(filtradas.map((d) => d.id));
    });
  }, [filtradas]);

  const aprobar = useCallback(async () => {
    const ids = seleccionadas.map((d) => d.id);
    if (!ids.length) return;
    setProcesando(true);
    const { error } = await supabase
      .from("documentos_compra")
      .update({
        estado_aprobacion: "aprobado_gerencia",
        aprobado_por: usuarioNombre || null,
        fecha_aprobacion: new Date().toISOString(),
        motivo_rechazo: null,
      })
      .in("id", ids);
    setProcesando(false);
    if (error) return showToast(error.message, false);
    showToast(`${ids.length} factura${ids.length === 1 ? "" : "s"} aprobada${ids.length === 1 ? "" : "s"}.`);
    cargar();
  }, [seleccionadas, usuarioNombre, cargar, showToast]);

  const rechazar = useCallback(async () => {
    const ids = seleccionadas.map((d) => d.id);
    if (!ids.length) return;
    if (!motivo.trim()) return showToast("Escribe el motivo del rechazo.", false);
    setProcesando(true);
    const { error } = await supabase
      .from("documentos_compra")
      .update({
        estado_aprobacion: "rechazado",
        aprobado_por: usuarioNombre || null,
        fecha_aprobacion: new Date().toISOString(),
        motivo_rechazo: motivo.trim(),
      })
      .in("id", ids);
    setProcesando(false);
    if (error) return showToast(error.message, false);
    setRechazando(false);
    setMotivo("");
    showToast(`${ids.length} factura${ids.length === 1 ? "" : "s"} rechazada${ids.length === 1 ? "" : "s"}.`);
    cargar();
  }, [seleccionadas, motivo, usuarioNombre, cargar, showToast]);

  const exportar = useCallback(() => {
    if (!filtradas.length) return showToast("No hay filas que exportar con los filtros actuales.", false);
    exportarXlsx(filtradas, COLUMNAS_EXPORT, {
      nombre: "cuentas_por_pagar",
      hoja: "CxP",
      titulo: "Cuentas por pagar · AFA Transportes",
      subtitulo: `${filtradas.length} comprobantes · exportado con las cabeceras que reconoce el importador`,
      totales: true,
    }).catch((e) => showToast(`No se pudo generar el Excel: ${String((e as Error)?.message ?? e)}`, false));
  }, [filtradas, showToast]);

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
          <h1 className="text-3xl font-bold text-gray-900">Cuentas por pagar</h1>
          <p className="text-gray-400 text-sm mt-1">
            Facturas de proveedores · Adelantos y detracción · Aprobación de gerencia
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}
            onClick={() => setImportando(true)}
          >
            ⬆️ Importar
          </button>
          <button
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}
            onClick={exportar}
          >
            ⬇️ Exportar
          </button>
          <button
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: "#0b315f" }}
            onClick={() => {
              setEditando(null);
              setApertura((n) => n + 1);
              setModalAbierto(true);
            }}
          >
            + Registrar factura
          </button>
        </div>
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

      {!puedeAprobar && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          <span>🔒</span>
          Solo gerencia puede aprobar pagos. Puedes registrar y consultar facturas, pero no visarlas.
        </div>
      )}

      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input
            className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Proveedor, RUC, factura, placa o código de servicio…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={fEstadoPago} onChange={(e) => setFEstadoPago(e.target.value)}>
          <option value="">Todo estado de pago</option>
          {Object.entries(ESTADOS_PAGO).map(([k, c]) => (
            <option key={k} value={k}>
              {c.label}
            </option>
          ))}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={fAprobacion} onChange={(e) => setFAprobacion(e.target.value)}>
          <option value="">Toda aprobación</option>
          {Object.entries(ESTADOS_APROBACION).map(([k, c]) => (
            <option key={k} value={k}>
              {c.label}
            </option>
          ))}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={fProveedor} onChange={(e) => setFProveedor(e.target.value)}>
          <option value="">Todos los proveedores</option>
          {proveedoresUnicos.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input type="date" className="border rounded-xl px-4 py-2.5 text-sm" value={desde} onChange={(e) => setDesde(e.target.value)} title="Emisión desde" />
        <input type="date" className="border rounded-xl px-4 py-2.5 text-sm" value={hasta} onChange={(e) => setHasta(e.target.value)} title="Emisión hasta" />
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">{filtradas.length} resultados</div>
      </section>

      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {CABECERAS.map((h, i) => (
                  <th key={h + i} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {i === 0 ? (
                      <input type="checkbox" checked={todasMarcadas} onChange={alternarTodas} aria-label="Seleccionar todo" />
                    ) : (
                      h
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                      Cargando…
                    </div>
                  </td>
                </tr>
              )}
              {!loading && !filtradas.length && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">🧾</p>
                    <p>No hay facturas con estos filtros</p>
                  </td>
                </tr>
              )}
              {!loading &&
                filtradas.map((d) => {
                  const aging = AGING[cubetaAging(d.dias_vencido)];
                  const adelantos = redondear(Number(d.adelanto_1 ?? 0) + Number(d.adelanto_2 ?? 0));
                  return (
                    <tr key={d.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3">
                        <input type="checkbox" checked={seleccion.has(d.id)} onChange={() => alternar(d.id)} aria-label={`Seleccionar ${d.numero_factura ?? d.id}`} />
                      </td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(d.fecha_emision)}</td>
                      <td className="p-3">
                        <p className="text-xs font-bold text-gray-800">{d.proveedor_razon_social ?? "—"}</p>
                        <p className="text-[10px] text-gray-400 font-mono">{d.proveedor_ruc ?? "sin RUC"}</p>
                      </td>
                      <td className="p-3 font-mono font-black text-xs text-[#0b315f] whitespace-nowrap">{d.numero_factura ?? "—"}</td>
                      <td className="p-3">
                        <p className="font-mono font-black text-xs text-[#0b315f]">{d.codigo_servicio ?? "—"}</p>
                        {d.turno && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg" style={{ background: "#f0fdfa", color: "#0f766e" }}>
                            {d.turno}
                          </span>
                        )}
                      </td>
                      <td className="p-3 font-mono font-black text-xs text-[#0b315f]">{d.vehiculo_placa ?? "—"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtMoneda(Number(d.monto_neto ?? 0), d.moneda)}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{adelantos > 0 ? fmtMoneda(adelantos, d.moneda) : "—"}</td>
                      <td className="p-3 whitespace-nowrap">
                        <p className="text-xs text-gray-600 font-medium">{fmtMoneda(Number(d.detraccion_monto ?? 0), d.moneda)}</p>
                        <Chip cfg={ESTADOS_DETRACCION[d.estado_detraccion] ?? ESTADOS_DETRACCION.no_aplica} />
                      </td>
                      <td className="p-3 font-black text-xs text-red-700 whitespace-nowrap">{fmtMoneda(Number(d.monto_a_cancelar ?? 0), d.moneda)}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtMoneda(Number(d.saldo ?? 0), d.moneda)}</td>
                      <td className="p-3 whitespace-nowrap">
                        <p className="text-xs text-gray-600 font-medium">{fmtFecha(d.fecha_vencimiento)}</p>
                        <Chip cfg={aging} />
                      </td>
                      <td className="p-3">
                        <Chip cfg={ESTADOS_APROBACION[d.estado_aprobacion] ?? ESTADOS_APROBACION.pendiente} />
                      </td>
                      <td className="p-3">
                        <Chip cfg={ESTADOS_PAGO[d.estado_pago] ?? ESTADOS_PAGO.impaga} />
                      </td>
                      <td className="p-3">
                        <button
                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                          onClick={() => {
                            setEditando(d);
                            setApertura((n) => n + 1);
                            setModalAbierto(true);
                          }}
                        >
                          Editar
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>{filtradas.length} de {filas.length} comprobantes</span>
          <span>
            A cancelar: {fmtMoneda(redondear(filtradas.reduce((s, d) => s + Number(d.monto_a_cancelar ?? 0), 0)))}
          </span>
        </div>
      </section>

      {/* Barra de aprobación masiva: aparece pegada abajo al marcar checkboxes. */}
      {seleccionadas.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-white rounded-2xl border shadow-xl px-5 py-3 flex items-center gap-4 flex-wrap max-w-[95vw]">
          <p className="text-sm font-bold text-[#0b315f]">
            {seleccionadas.length} seleccionada{seleccionadas.length === 1 ? "" : "s"} · {fmtMoneda(totalSeleccion)}
          </p>
          {puedeAprobar ? (
            <>
              <button
                className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                onClick={aprobar}
                disabled={procesando}
              >
                Aprobar seleccionadas
              </button>
              <button
                className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50"
                onClick={() => setRechazando(true)}
                disabled={procesando}
              >
                Rechazar
              </button>
            </>
          ) : (
            <span className="text-xs text-amber-700">Solo gerencia puede aprobar pagos</span>
          )}
          <button className="text-xs text-gray-400 hover:text-gray-600" onClick={() => setSeleccion(new Set())}>
            Limpiar
          </button>
        </div>
      )}

      {rechazando && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setRechazando(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b">
              <h3 className="font-bold text-gray-900">Rechazar {seleccionadas.length} factura(s)</h3>
              <p className="text-xs text-gray-400 mt-1">El motivo queda registrado en el comprobante y lo ve quien la registró.</p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Motivo del rechazo</label>
                <textarea
                  rows={3}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ej.: el detalle del servicio no coincide con la programación del 12/08."
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t flex justify-end gap-3">
              <button className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50" onClick={() => setRechazando(false)}>
                Cancelar
              </button>
              <button
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
                style={{ background: "#991b1b" }}
                onClick={rechazar}
                disabled={procesando}
              >
                Rechazar
              </button>
            </div>
          </div>
        </div>
      )}

      <ModalCxP
        key={apertura}
        abierto={modalAbierto}
        documento={editando}
        usuarioNombre={usuarioNombre}
        onCerrar={() => setModalAbierto(false)}
        onGuardado={(msg) => {
          showToast(msg);
          cargar();
        }}
      />

      <ImportadorFinanzas
        abierto={importando}
        onCerrar={() => setImportando(false)}
        perfiles={PERFILES_CXP}
        titulo="Importar cuentas por pagar"
        descripcion="Sube el Google Sheet o el Excel de facturas de proveedores. Se reconocen el formato OSLO (con código de servicio y turno) y el tradicional."
        plantilla={{
          cabeceras: COLUMNAS_EXPORT.map((c) => c.titulo),
          instrucciones: [
            "CUENTAS POR PAGAR",
            "Una fila por factura de proveedor. El monto neto es el TOTAL del comprobante.",
            "PROVEEDOR y MONTO NETO son obligatorios; sin FECHA DE EMISION se usa la FECHA DE SERVICIO.",
            "ESTADO acepta texto libre (pagado, pendiente, en Telecrédito…) y se traduce solo.",
            "No borres la fila de cabecera: es la que permite reconocer las columnas.",
          ],
        }}
        onImportado={(r) => {
          showToast(`${r.creadas} creadas · ${r.actualizadas} actualizadas · ${r.errores.length} con error`, !r.errores.length);
          cargar();
        }}
      />
    </main>
  );
}
