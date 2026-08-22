"use client";

// ──────────────────────────────────────────────────────────────────────────────
// Pestaña "Conciliación" — el extracto del banco contra lo que el ERP sabe.
//
// La pregunta que responde es una sola: ¿hay algún cargo en la cuenta que nadie pueda
// justificar? Eso es una FUGA, y es lo que la "Regla Cero Fugas" pone en rojo arriba
// del todo.
//
// La política de casado vive en lib/finanzas/conciliacion.ts y aquí no se repite: solo
// el nivel de confianza 1 (mismo n.º de operación) se auto-concilia; el resto se
// PROPONE y lo confirma una persona, porque dos servicios del mismo importe el mismo
// día es la norma en transporte, no la excepción.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { exportarXlsx, type Columna } from "@/lib/finanzas/exportar";
import {
  ESTADOS_BANCO,
  cargarUniverso,
  conciliarAutomatico,
  conciliarManual,
  proponerCandidatos,
  resumirConciliacion,
  type Candidato,
  type MovimientoExtracto,
  type UniversoConciliacion,
} from "@/lib/finanzas/conciliacion";
import { PERFILES_EXTRACTO } from "@/lib/importador/perfiles-finanzas";
import ImportadorFinanzas from "@/app/_components/ImportadorFinanzas";
import type { CuentaTesoreria } from "@/lib/finanzas/tipos";

const CABECERAS = ["Fecha", "N° operación", "Descripción del banco", "Cargo", "Abono", "Saldo", "Estado", "Casa con", "Acciones"];

const ETIQUETA_DOC: Record<string, string> = {
  documento_compra: "Factura de compra",
  gasto_general: "Gasto administrativo",
  caja_chica_rendicion: "Rendición de caja chica",
  factura: "Factura de venta",
  lote_pago: "Lote de pago",
  otro: "Pago registrado",
};

const UNIVERSO_VACIO: UniversoConciliacion = { pagos: [], compras: [], generales: [], lotes: [] };

const COLUMNAS_FUGAS: Columna<MovimientoExtracto>[] = [
  { titulo: "FECHA", valor: (m) => m.fecha_movimiento, tipo: "fecha" },
  { titulo: "NRO OPERACION", valor: (m) => m.nro_operacion ?? "" },
  { titulo: "DESCRIPCION", valor: (m) => m.descripcion_banco ?? "" },
  { titulo: "CARGO", valor: (m) => Number(m.monto_cargo ?? 0), tipo: "monto" },
  { titulo: "MONEDA", valor: (m) => m.moneda ?? "PEN" },
  { titulo: "ESTADO", valor: (m) => ESTADOS_BANCO[m.estado_conciliacion]?.label ?? m.estado_conciliacion },
  { titulo: "OBSERVACIONES", valor: (m) => m.observaciones ?? "" },
];

function hoyLima(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function haceDias(n: number): string {
  return new Date(Date.now() - 5 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
}

function fmtFecha(f: string | null | undefined): string {
  if (!f) return "—";
  return new Date(f.slice(0, 10) + "T00:00:00").toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function ConciliacionTab() {
  const [cuentas, setCuentas] = useState<CuentaTesoreria[]>([]);
  const [cuentaId, setCuentaId] = useState("");
  const [desde, setDesde] = useState(haceDias(90));
  const [hasta, setHasta] = useState(hoyLima());

  const [movimientos, setMovimientos] = useState<MovimientoExtracto[]>([]);
  const [universo, setUniverso] = useState<UniversoConciliacion>(UNIVERSO_VACIO);
  const [loading, setLoading] = useState(false);
  const [fEstado, setFEstado] = useState("");
  const [q, setQ] = useState("");

  const [importando, setImportando] = useState(false);
  const [conciliando, setConciliando] = useState(false);
  const [resultado, setResultado] = useState<{ conciliados: number; observados: number; noIdentificados: number; ignorados: number } | null>(null);
  const [detalle, setDetalle] = useState<MovimientoExtracto | null>(null);
  const [usuarioNombre, setUsuarioNombre] = useState("");
  const [procesando, setProcesando] = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    (async () => {
      const [cs, sesion] = await Promise.all([
        supabase.from("cuentas_tesoreria").select("*").eq("activo", true).order("nombre"),
        supabase.auth.getSession(),
      ]);
      const lista = (cs.data ?? []) as CuentaTesoreria[];
      setCuentas(lista);
      // Con una sola cuenta activa no tiene sentido obligar a elegirla a mano.
      if (lista.length === 1) setCuentaId(String(lista[0].id));

      const uid = sesion.data?.session?.user?.id;
      if (uid) {
        const { data } = await supabase.from("usuarios").select("nombre").eq("id", uid).maybeSingle();
        setUsuarioNombre(String(data?.nombre ?? ""));
      }
    })();
  }, []);

  const cuentaActiva = useMemo(() => cuentas.find((c) => String(c.id) === cuentaId) ?? null, [cuentas, cuentaId]);

  const cargar = useCallback(async () => {
    if (!cuentaId) {
      setMovimientos([]);
      setUniverso(UNIVERSO_VACIO);
      return;
    }
    setLoading(true);
    const [movs, u] = await Promise.all([
      supabase
        .from("extractos_bancarios_movimientos")
        .select("*")
        .eq("cuenta_tesoreria_id", Number(cuentaId))
        .gte("fecha_movimiento", desde)
        .lte("fecha_movimiento", hasta)
        .order("fecha_movimiento", { ascending: false })
        .order("id", { ascending: false }),
      cargarUniverso(supabase, desde, hasta),
    ]);
    setMovimientos((movs.data ?? []) as MovimientoExtracto[]);
    setUniverso(u);
    setLoading(false);
  }, [cuentaId, desde, hasta]);

  // Recarga al cambiar de cuenta o de rango. La regla del linter apunta a otro caso
  // —setState síncrono en el cuerpo del efecto—; aquí se escribe tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  const resumen = useMemo(() => resumirConciliacion(movimientos), [movimientos]);

  const fugas = useMemo(
    () => movimientos.filter((m) => m.estado_conciliacion === "no_identificado" && Number(m.monto_cargo) > 0),
    [movimientos]
  );

  const filtrados = useMemo(() => {
    const texto = q.trim().toLowerCase();
    return movimientos.filter((m) => {
      if (fEstado && m.estado_conciliacion !== fEstado) return false;
      if (!texto) return true;
      return (
        (m.descripcion_banco ?? "").toLowerCase().includes(texto) ||
        (m.nro_operacion ?? "").toLowerCase().includes(texto) ||
        String(m.monto_cargo ?? "").includes(texto) ||
        String(m.monto_abono ?? "").includes(texto)
      );
    });
  }, [movimientos, q, fEstado]);

  const conciliarTodo = useCallback(async () => {
    if (!cuentaId) return showToast("Elige primero la cuenta de tesorería.", false);
    const pendientes = movimientos.filter((m) => m.estado_conciliacion !== "conciliado" && m.estado_conciliacion !== "ignorado");
    if (!pendientes.length) return showToast("No hay movimientos pendientes de conciliar en el rango.", false);

    setConciliando(true);
    const r = await conciliarAutomatico(supabase, pendientes, universo, usuarioNombre || null);
    setConciliando(false);
    setResultado(r);
    showToast(`${r.conciliados} conciliados · ${r.observados} por revisar · ${r.noIdentificados} sin identificar`, r.noIdentificados === 0);
    cargar();
  }, [cuentaId, movimientos, universo, usuarioNombre, cargar, showToast]);

  const candidatos: Candidato[] = useMemo(() => (detalle ? proponerCandidatos(detalle, universo) : []), [detalle, universo]);

  const casarCon = useCallback(
    async (c: Candidato) => {
      if (!detalle) return;
      setProcesando(true);
      const r = await conciliarManual(
        supabase,
        detalle.id,
        { documento_tipo: c.documento_tipo, documento_id: c.documento_id, pago_id: c.pago_id },
        usuarioNombre || null
      );
      setProcesando(false);
      if (!r.ok) return showToast(r.error ?? "No se pudo conciliar.", false);
      setDetalle(null);
      showToast("Movimiento conciliado.");
      cargar();
    },
    [detalle, usuarioNombre, cargar, showToast]
  );

  const marcarEstado = useCallback(
    async (mov: MovimientoExtracto, estado: "ignorado" | "observado", nota: string) => {
      setProcesando(true);
      const { error } = await supabase
        .from("extractos_bancarios_movimientos")
        .update({ estado_conciliacion: estado, observaciones: nota, conciliado_por: usuarioNombre || null })
        .eq("id", mov.id);
      setProcesando(false);
      if (error) return showToast(error.message, false);
      setDetalle(null);
      showToast(estado === "ignorado" ? "Movimiento marcado como ignorado." : "Movimiento marcado como observado.");
      cargar();
    },
    [usuarioNombre, cargar, showToast]
  );

  const exportarFugas = useCallback(() => {
    if (!fugas.length) return showToast("No hay fugas que exportar: todo el rango está justificado.", false);
    exportarXlsx(fugas, COLUMNAS_FUGAS, {
      nombre: "fugas_bancarias",
      hoja: "Fugas",
      titulo: "Cargos sin respaldo en el ERP · Regla Cero Fugas",
      subtitulo: `${cuentaActiva?.nombre ?? "cuenta"} · del ${fmtFecha(desde)} al ${fmtFecha(hasta)} · ${fmtMoneda(resumen.montoFugas)}`,
      totales: true,
    }).catch((e) => showToast(`No se pudo generar el Excel: ${String((e as Error)?.message ?? e)}`, false));
  }, [fugas, cuentaActiva, desde, hasta, resumen.montoFugas, showToast]);

  const kpis = [
    { label: "Movimientos", valor: String(resumen.movimientos), color: "#0b315f", bg: "#eef3f8" },
    { label: "Total cargos", valor: fmtMoneda(resumen.totalCargos), color: "#991b1b", bg: "#fee2e2" },
    { label: "Conciliados", valor: String(resumen.conciliados), color: "#166534", bg: "#dcfce7" },
    { label: "Observados", valor: String(resumen.observados), color: "#854d0e", bg: "#fef9c3" },
  ];

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
          <h1 className="text-3xl font-bold text-gray-900">Conciliación bancaria</h1>
          <p className="text-gray-400 text-sm mt-1">Extracto del banco · Casado automático · Cargos sin justificar</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}
            onClick={exportarFugas}
          >
            ⬇️ Exportar fugas
          </button>
          <button
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50 disabled:opacity-60"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}
            onClick={() => setImportando(true)}
            disabled={!cuentaId}
          >
            ⬆️ Importar extracto
          </button>
          <button
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
            style={{ background: "#0b315f" }}
            onClick={conciliarTodo}
            disabled={conciliando || !cuentaId}
          >
            {conciliando ? "Conciliando…" : "🔗 Conciliar automáticamente"}
          </button>
        </div>
      </div>

      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={cuentaId} onChange={(e) => setCuentaId(e.target.value)}>
          <option value="">Elige la cuenta de tesorería…</option>
          {cuentas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre} · {c.banco ?? "—"} · {c.moneda}
            </option>
          ))}
        </select>
        <input type="date" className="border rounded-xl px-4 py-2.5 text-sm" value={desde} onChange={(e) => setDesde(e.target.value)} title="Desde" />
        <input type="date" className="border rounded-xl px-4 py-2.5 text-sm" value={hasta} onChange={(e) => setHasta(e.target.value)} title="Hasta" />
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input
            className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Descripción, n.º de operación o importe…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={fEstado} onChange={(e) => setFEstado(e.target.value)}>
          <option value="">Todos los estados</option>
          {Object.entries(ESTADOS_BANCO).map(([k, c]) => (
            <option key={k} value={k}>
              {c.label}
            </option>
          ))}
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">{filtrados.length} resultados</div>
      </section>

      {resultado && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">
          Última corrida: {resultado.conciliados} conciliados · {resultado.observados} por revisar · {resultado.noIdentificados} sin
          identificar · {resultado.ignorados} ignorados (comisiones e ITF).
        </div>
      )}

      {!cuentaId && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          <span>🏦</span>
          Elige una cuenta de tesorería para ver sus movimientos e importar el extracto.
        </div>
      )}

      {/* Regla Cero Fugas: el bloque rojo manda sobre todo lo demás de la pantalla. */}
      <section className="rounded-2xl border-2 p-4" style={{ background: "#fee2e2", borderColor: "#991b1b22" }}>
        <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: "#991b1b99" }}>
          Regla Cero Fugas
        </p>
        <p className="text-4xl font-black" style={{ color: "#991b1b" }}>
          {fmtMoneda(resumen.montoFugas)}
        </p>
        <p className="text-xs mt-1" style={{ color: "#991b1b" }}>
          {resumen.fugas} cargo{resumen.fugas === 1 ? "" : "s"} del banco que el ERP no sabe justificar en el rango consultado.
          {resumen.fugas === 0 && " Todo el dinero que salió tiene respaldo."}
        </p>
      </section>

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

      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {CABECERAS.map((h) => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
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
              {!loading && !filtrados.length && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">🏦</p>
                    <p>{cuentaId ? "No hay movimientos en el rango" : "Elige una cuenta para empezar"}</p>
                  </td>
                </tr>
              )}
              {!loading &&
                filtrados.map((m) => {
                  const cfg = ESTADOS_BANCO[m.estado_conciliacion] ?? ESTADOS_BANCO.no_identificado;
                  const esFuga = m.estado_conciliacion === "no_identificado" && Number(m.monto_cargo) > 0;
                  return (
                    <tr key={m.id} className={`border-t hover:bg-gray-50 ${esFuga ? "bg-red-50" : ""}`} style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(m.fecha_movimiento)}</td>
                      <td className="p-3 font-mono font-black text-xs text-[#0b315f] whitespace-nowrap">{m.nro_operacion ?? "—"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium max-w-[280px] truncate" title={m.descripcion_banco ?? ""}>
                        {m.descripcion_banco ?? "—"}
                      </td>
                      <td className="p-3 font-black text-xs text-red-700 whitespace-nowrap">
                        {Number(m.monto_cargo) > 0 ? fmtMoneda(Number(m.monto_cargo), m.moneda) : "—"}
                      </td>
                      <td className="p-3 font-black text-xs whitespace-nowrap" style={{ color: "#166534" }}>
                        {Number(m.monto_abono) > 0 ? fmtMoneda(Number(m.monto_abono), m.moneda) : "—"}
                      </td>
                      <td className="p-3 text-xs text-gray-500 whitespace-nowrap">{m.saldo != null ? fmtMoneda(Number(m.saldo), m.moneda) : "—"}</td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg whitespace-nowrap" style={{ background: cfg.bg, color: cfg.color }}>
                          {cfg.label}
                        </span>
                      </td>
                      <td className="p-3 text-[10px] text-gray-500 max-w-[220px]">
                        {m.documento_tipo ? (
                          <span className="font-medium text-gray-700">
                            {ETIQUETA_DOC[m.documento_tipo] ?? m.documento_tipo}
                            {m.documento_id ? ` #${m.documento_id}` : ""}
                          </span>
                        ) : (
                          m.observaciones ?? "—"
                        )}
                      </td>
                      <td className="p-3">
                        <button className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700 whitespace-nowrap" onClick={() => setDetalle(m)}>
                          Conciliar…
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>
            {filtrados.length} de {movimientos.length} movimientos
          </span>
          <span>Abonos: {fmtMoneda(resumen.totalAbonos)} · Cargos: {fmtMoneda(resumen.totalCargos)}</span>
        </div>
      </section>

      {detalle && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setDetalle(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b">
              <h3 className="font-bold text-gray-900">Conciliar movimiento</h3>
              <p className="text-xs text-gray-400 mt-1">
                {fmtFecha(detalle.fecha_movimiento)} · {detalle.descripcion_banco ?? "sin descripción"} ·{" "}
                {Number(detalle.monto_cargo) > 0
                  ? `cargo de ${fmtMoneda(Number(detalle.monto_cargo), detalle.moneda)}`
                  : `abono de ${fmtMoneda(Number(detalle.monto_abono), detalle.moneda)}`}
              </p>
            </div>

            <div className="p-6 space-y-4">
              {!candidatos.length && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
                  <span>🔎</span>
                  No hay ningún registro del ERP con este importe en el rango. Si es una comisión o un ITF márcalo como ignorado; si no,
                  es una fuga que hay que investigar.
                </div>
              )}

              {candidatos.map((c, i) => (
                <div key={`${c.documento_tipo}-${c.documento_id}-${i}`} className="rounded-xl border p-3 flex items-start justify-between gap-3" style={{ borderColor: "#e2e8f0" }}>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-800 truncate">{c.etiqueta}</p>
                    <p className="text-[10px] text-gray-400">
                      {ETIQUETA_DOC[c.documento_tipo] ?? c.documento_tipo} · {fmtFecha(c.fecha)} · {fmtMoneda(c.monto)} ·{" "}
                      {c.nro_operacion ? `op. ${c.nro_operacion}` : "sin n.º de operación"}
                    </p>
                    <p className="text-[10px] font-bold" style={{ color: c.confianza >= 1 ? "#166534" : c.confianza >= 0.85 ? "#854d0e" : "#ea580c" }}>
                      {Math.round(c.confianza * 100)}% · {c.motivo}
                    </p>
                  </div>
                  <button
                    className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 whitespace-nowrap"
                    onClick={() => casarCon(c)}
                    disabled={procesando}
                  >
                    Es este
                  </button>
                </div>
              ))}

              <div className="pt-2 border-t space-y-2" style={{ borderColor: "#f1f5f9" }}>
                <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Si no corresponde a ningún documento</p>
                <div className="flex gap-2 flex-wrap">
                  <button
                    className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                    onClick={() => marcarEstado(detalle, "ignorado", "Comisión/ITF: sin contrapartida en el ERP")}
                    disabled={procesando}
                  >
                    Marcar como ignorado (comisión / ITF)
                  </button>
                  <button
                    className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                    onClick={() => marcarEstado(detalle, "observado", "Marcado para revisión manual")}
                    disabled={procesando}
                  >
                    Marcar observado
                  </button>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t flex justify-end gap-3">
              <button className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50" onClick={() => setDetalle(null)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      <ImportadorFinanzas
        abierto={importando}
        onCerrar={() => setImportando(false)}
        perfiles={PERFILES_EXTRACTO}
        titulo="Importar extracto bancario"
        descripcion={`Los movimientos se cargan en ${cuentaActiva?.nombre ?? "la cuenta elegida"}. Volver a subir el mismo rango no duplica filas.`}
        extras={{ cuenta_tesoreria_id: cuentaId ? Number(cuentaId) : null, banco: cuentaActiva?.banco ?? "BCP" }}
        plantilla={{
          cabeceras: ["FECHA", "FECHA VALUTA", "NRO OPERACION", "DESCRIPCION", "CARGO", "ABONO", "SALDO", "MONEDA"],
          instrucciones: [
            "EXTRACTO BANCARIO",
            "Descarga el movimiento de la cuenta desde Telecrédito en Excel y pégalo aquí.",
            "Se aceptan CARGO y ABONO en columnas separadas, o una sola columna IMPORTE con signo.",
            "FECHA y DESCRIPCION son obligatorias. Las filas repetidas se detectan solas y no se duplican.",
          ],
        }}
        onImportado={(r) => {
          showToast(`${r.creadas} movimientos nuevos · ${r.omitidas} ya estaban · ${r.errores.length} con error`, !r.errores.length);
          cargar();
        }}
      />
    </main>
  );
}
