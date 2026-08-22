"use client";

// ──────────────────────────────────────────────────────────────────────────────
// Pestaña "Lotes de pago" — la aprobación masiva convertida en un archivo de abono.
//
// El ciclo completo vive en lib/finanzas/lotes.ts y esta pantalla NO lo reimplementa:
// solo dibuja el estado y llama a las funciones del módulo. Importa especialmente que
// la confirmación del pago pase por confirmarPagoLote(), porque es la que emite UN
// pago por línea con su aplicación — el saldo de cada CxP se sigue derivando de
// pagos_aplicacion y no de un flag puesto a mano desde el front.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda, redondear } from "@/lib/finanzas/dinero";
import { descargarArchivoTelecredito } from "@/lib/finanzas/exportar";
import {
  ESTADOS_LOTE,
  anularLote,
  aprobarLote,
  candidatosPago,
  confirmarPagoLote,
  crearLote,
  itemsAAbonos,
  marcarEnviadoAlBanco,
  type EstadoLote,
  type ItemLote,
  type Lote,
  type Pagable,
} from "@/lib/finanzas/lotes";
import type { CuentaTesoreria } from "@/lib/finanzas/tipos";

const CABECERAS = ["Código", "Fecha", "Banco", "Programado", "Ítems", "Total", "Estado", "Acciones"];
const CABECERAS_ITEMS = ["Beneficiario", "Documento", "Banco", "Cuenta / CCI", "Referencia", "Monto", "Estado", "Rechazar"];

const ETIQUETA_TIPO: Record<string, string> = {
  documento_compra: "Factura de compra",
  gasto_general: "Gasto administrativo",
  caja_chica_rendicion: "Rendición de caja chica",
  detraccion: "Detracción",
  otro: "Otro",
};

const ESTADOS_ITEM: Record<string, { label: string; bg: string; color: string }> = {
  pendiente: { label: "Pendiente", bg: "#f3f4f6", color: "#4b5563" },
  pagado: { label: "Pagado", bg: "#dcfce7", color: "#166534" },
  rechazado: { label: "Rechazado", bg: "#fee2e2", color: "#991b1b" },
};

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

/** Identidad estable de un pagable dentro de la selección del armado. */
function claveDe(p: Pagable): string {
  return `${p.documento_tipo}-${p.documento_id}`;
}

export default function LotesTab() {
  const [lotes, setLotes] = useState<Lote[]>([]);
  const [cuentas, setCuentas] = useState<CuentaTesoreria[]>([]);
  const [loading, setLoading] = useState(true);

  const [abierto, setAbierto] = useState<number | null>(null);
  const [items, setItems] = useState<ItemLote[]>([]);
  const [cargandoItems, setCargandoItems] = useState(false);

  const [puedeAprobar, setPuedeAprobar] = useState(false);
  const [usuarioNombre, setUsuarioNombre] = useState("");
  const [procesando, setProcesando] = useState(false);

  // Armado del lote nuevo.
  const [armando, setArmando] = useState(false);
  const [candidatos, setCandidatos] = useState<Pagable[]>([]);
  const [cargandoCandidatos, setCargandoCandidatos] = useState(false);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [hasta, setHasta] = useState("");
  const [incluirDetracciones, setIncluirDetracciones] = useState(true);
  const [fecha, setFecha] = useState(hoyLima());
  const [fechaProgramada, setFechaProgramada] = useState("");
  const [cuentaId, setCuentaId] = useState("");
  const [banco, setBanco] = useState("BCP");
  const [observaciones, setObservaciones] = useState("");

  // Confirmación de pago.
  const [confirmando, setConfirmando] = useState<Lote | null>(null);
  const [fechaPago, setFechaPago] = useState(hoyLima());
  const [nroOperacion, setNroOperacion] = useState("");
  const [rechazados, setRechazados] = useState<Record<number, string>>({});

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    const [ls, cs] = await Promise.all([
      supabase.from("lotes_pago").select("*").order("fecha", { ascending: false }).order("id", { ascending: false }),
      supabase.from("cuentas_tesoreria").select("*").eq("activo", true).order("nombre"),
    ]);
    setLotes((ls.data ?? []) as Lote[]);
    setCuentas((cs.data ?? []) as CuentaTesoreria[]);
    setLoading(false);
  }, []);

  // Carga inicial (patrón de todo el ERP). La regla del linter apunta a otro caso
  // —setState síncrono en el cuerpo del efecto—; aquí se escribe tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

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

  const cargarItems = useCallback(async (loteId: number) => {
    setCargandoItems(true);
    const { data } = await supabase.from("lotes_pago_items").select("*").eq("lote_id", loteId).order("beneficiario").order("id");
    setItems((data ?? []) as ItemLote[]);
    setCargandoItems(false);
  }, []);

  const alternarLote = useCallback(
    async (loteId: number) => {
      if (abierto === loteId) {
        setAbierto(null);
        setItems([]);
        return;
      }
      setAbierto(loteId);
      setItems([]);
      await cargarItems(loteId);
    },
    [abierto, cargarItems]
  );

  // ── Armado ──────────────────────────────────────────────────────────────────

  const cargarCandidatos = useCallback(async () => {
    setCargandoCandidatos(true);
    const lista = await candidatosPago(supabase, { hasta: hasta || undefined, incluirDetracciones });
    setCandidatos(lista);
    // Una obligación que ya no está en la lista no puede seguir seleccionada.
    setSeleccion((prev) => {
      const vivos = new Set(lista.map(claveDe));
      return new Set(Array.from(prev).filter((k) => vivos.has(k)));
    });
    setCargandoCandidatos(false);
  }, [hasta, incluirDetracciones]);

  // Los candidatos se recalculan al entrar al armado y cada vez que cambian sus filtros.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (armando) cargarCandidatos();
  }, [armando, cargarCandidatos]);

  const pagableBloqueado = useCallback((p: Pagable) => !p.cuenta_destino && !p.cci_destino, []);

  const agrupados = useMemo(() => {
    const mapa = new Map<string, Pagable[]>();
    for (const p of candidatos) {
      const lista = mapa.get(p.beneficiario) ?? [];
      lista.push(p);
      mapa.set(p.beneficiario, lista);
    }
    return Array.from(mapa.entries()).sort((a, b) => a[0].localeCompare(b[0], "es"));
  }, [candidatos]);

  // Las líneas que todavía pueden rechazarse al confirmar (las ya pagadas no se tocan).
  const itemsPendientes = useMemo(() => items.filter((i) => i.estado === "pendiente"), [items]);

  const seleccionados = useMemo(() => candidatos.filter((p) => seleccion.has(claveDe(p))), [candidatos, seleccion]);
  const totalSeleccion = useMemo(() => redondear(seleccionados.reduce((s, p) => s + p.monto, 0)), [seleccionados]);

  const alternarPagable = useCallback(
    (p: Pagable) => {
      if (pagableBloqueado(p)) return;
      setSeleccion((prev) => {
        const s = new Set(prev);
        const k = claveDe(p);
        if (s.has(k)) s.delete(k);
        else s.add(k);
        return s;
      });
    },
    [pagableBloqueado]
  );

  const alternarBeneficiario = useCallback(
    (lista: Pagable[]) => {
      const elegibles = lista.filter((p) => !pagableBloqueado(p));
      setSeleccion((prev) => {
        const s = new Set(prev);
        const todos = elegibles.every((p) => s.has(claveDe(p)));
        for (const p of elegibles) {
          if (todos) s.delete(claveDe(p));
          else s.add(claveDe(p));
        }
        return s;
      });
    },
    [pagableBloqueado]
  );

  const guardarLote = useCallback(async () => {
    if (!seleccionados.length) return showToast("Selecciona al menos una obligación.", false);
    setProcesando(true);
    const r = await crearLote(supabase, {
      seleccion: seleccionados,
      fecha,
      fecha_programada: fechaProgramada || null,
      cuenta_tesoreria_id: cuentaId ? Number(cuentaId) : null,
      banco,
      observaciones: observaciones.trim() || null,
      creado_por: usuarioNombre || null,
    });
    setProcesando(false);
    if (!r.ok) return showToast(r.error, false);
    showToast(`Lote ${r.data.codigo ?? r.data.id} creado por ${fmtMoneda(r.data.total)}.`);
    setArmando(false);
    setSeleccion(new Set());
    setObservaciones("");
    cargar();
  }, [seleccionados, fecha, fechaProgramada, cuentaId, banco, observaciones, usuarioNombre, cargar, showToast]);

  // ── Acciones por estado ─────────────────────────────────────────────────────

  const aprobar = useCallback(
    async (lote: Lote) => {
      setProcesando(true);
      const r = await aprobarLote(supabase, lote.id, usuarioNombre || "gerencia");
      setProcesando(false);
      if (!r.ok) return showToast(r.error, false);
      showToast(`Lote ${lote.codigo ?? lote.id} aprobado.`);
      cargar();
    },
    [usuarioNombre, cargar, showToast]
  );

  const descargarArchivo = useCallback(
    (lote: Lote) => {
      if (!items.length) return showToast("Abre el lote para cargar sus líneas antes de descargar.", false);
      descargarArchivoTelecredito(itemsAAbonos(items), lote.codigo ?? `LP-${lote.id}`);
      showToast("Archivo generado. Cotéjalo con el formato de tu convenio antes de subirlo.");
    },
    [items, showToast]
  );

  const marcarEnviado = useCallback(
    async (lote: Lote) => {
      setProcesando(true);
      const r = await marcarEnviadoAlBanco(supabase, lote.id, null);
      setProcesando(false);
      if (!r.ok) return showToast(r.error, false);
      showToast(`Lote ${lote.codigo ?? lote.id} marcado como enviado al banco.`);
      cargar();
    },
    [cargar, showToast]
  );

  // OJO: no se limpia `rechazados`. Los motivos que el usuario ya escribió en las filas
  // del panel expandido son justamente los que hay que enviar; borrarlos aquí haría que
  // ningún rechazo llegara nunca a confirmarPagoLote.
  const abrirConfirmacion = useCallback(
    async (lote: Lote) => {
      setFechaPago(hoyLima());
      setNroOperacion("");
      if (abierto !== lote.id) {
        setAbierto(lote.id);
        await cargarItems(lote.id);
      }
      setConfirmando(lote);
    },
    [abierto, cargarItems]
  );

  const confirmarPago = useCallback(async () => {
    if (!confirmando) return;
    const lista = Object.entries(rechazados)
      .filter(([, motivo]) => motivo.trim())
      .map(([id, motivo]) => ({ item_id: Number(id), motivo: motivo.trim() }));

    setProcesando(true);
    const r = await confirmarPagoLote(supabase, {
      lote_id: confirmando.id,
      fecha_pago: fechaPago,
      nro_operacion: nroOperacion.trim() || null,
      cuenta_tesoreria_id: confirmando.cuenta_tesoreria_id,
      creado_por: usuarioNombre || null,
      rechazados: lista,
    });
    setProcesando(false);
    if (!r.ok) return showToast(r.error, false);
    setConfirmando(null);
    setRechazados({});
    const { pagados, rechazados: nRechazados, errores } = r.data;
    showToast(
      `${pagados} pagado${pagados === 1 ? "" : "s"} · ${nRechazados} rechazado${nRechazados === 1 ? "" : "s"}${
        errores.length ? ` · ${errores.length} con error` : ""
      }`,
      !errores.length
    );
    cargar();
    cargarItems(confirmando.id);
  }, [confirmando, rechazados, fechaPago, nroOperacion, usuarioNombre, cargar, cargarItems, showToast]);

  const anular = useCallback(
    async (lote: Lote) => {
      setProcesando(true);
      const r = await anularLote(supabase, lote.id);
      setProcesando(false);
      if (!r.ok) return showToast(r.error, false);
      showToast(`Lote ${lote.codigo ?? lote.id} anulado. Las facturas vuelven a estar aprobadas.`);
      cargar();
    },
    [cargar, showToast]
  );

  const kpis = useMemo(() => {
    const porEstado = (e: EstadoLote) => lotes.filter((l) => l.estado === e);
    const suma = (ls: Lote[]) => redondear(ls.reduce((s, l) => s + Number(l.total ?? 0), 0));
    return [
      { label: "En borrador", valor: fmtMoneda(suma(porEstado("borrador"))), color: "#4b5563", bg: "#f3f4f6" },
      { label: "Aprobados", valor: fmtMoneda(suma(porEstado("aprobado"))), color: "#1d4ed8", bg: "#dbeafe" },
      { label: "En Telecrédito", valor: fmtMoneda(suma(porEstado("enviado_banco"))), color: "#854d0e", bg: "#fef9c3" },
      { label: "Pagados", valor: fmtMoneda(suma(porEstado("pagado"))), color: "#166534", bg: "#dcfce7" },
    ];
  }, [lotes]);

  // ── Pantalla de armado ──────────────────────────────────────────────────────

  if (armando) {
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
            <h1 className="text-3xl font-bold text-gray-900">Nuevo lote de pago</h1>
            <p className="text-gray-400 text-sm mt-1">
              Solo entra lo aprobado por gerencia · Agrupado por beneficiario · Una sola moneda por lote
            </p>
          </div>
          <button className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50" onClick={() => setArmando(false)}>
            Volver a los lotes
          </button>
        </div>

        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Campo label="Vencimientos hasta">
              <input type="date" className={inputCls()} value={hasta} onChange={(e) => setHasta(e.target.value)} />
            </Campo>
            <Campo label="Incluir detracciones">
              <label className="flex items-center gap-2 h-[42px] px-3 border border-gray-200 rounded-xl text-sm text-gray-600">
                <input type="checkbox" checked={incluirDetracciones} onChange={(e) => setIncluirDetracciones(e.target.checked)} />
                Depósitos al Banco de la Nación
              </label>
            </Campo>
            <Campo label="Cuenta de cargo">
              <select className={inputCls()} value={cuentaId} onChange={(e) => setCuentaId(e.target.value)}>
                <option value="">Sin especificar</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre} · {c.moneda}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Fecha del lote">
              <input type="date" className={inputCls()} value={fecha} onChange={(e) => setFecha(e.target.value)} />
            </Campo>
            <Campo label="Fecha programada de abono">
              <input type="date" className={inputCls()} value={fechaProgramada} onChange={(e) => setFechaProgramada(e.target.value)} />
            </Campo>
            <Campo label="Banco">
              <input className={inputCls()} value={banco} onChange={(e) => setBanco(e.target.value)} />
            </Campo>
            <Campo label="Observaciones" span={3}>
              <input className={inputCls()} value={observaciones} onChange={(e) => setObservaciones(e.target.value)} />
            </Campo>
          </div>
        </section>

        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between flex-wrap gap-2" style={{ borderColor: "#e2e8f0" }}>
            <h2 className="font-bold text-gray-900 text-sm">Obligaciones listas para pagar</h2>
            <button className="text-xs font-bold text-[#0b315f] hover:underline" onClick={cargarCandidatos}>
              Actualizar lista
            </button>
          </div>

          {cargandoCandidatos && (
            <div className="p-10 text-center text-gray-400">
              <div className="flex items-center justify-center gap-2">
                <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                Cargando…
              </div>
            </div>
          )}

          {!cargandoCandidatos && !agrupados.length && (
            <div className="p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">✅</p>
              <p>No hay obligaciones aprobadas pendientes de pago</p>
            </div>
          )}

          {!cargandoCandidatos &&
            agrupados.map(([beneficiario, lista]) => {
              const totalGrupo = redondear(lista.reduce((s, p) => s + p.monto, 0));
              return (
                <div key={beneficiario} className="border-t" style={{ borderColor: "#f1f5f9" }}>
                  <div className="px-4 py-2 flex items-center justify-between gap-3" style={{ background: "#f8fafc" }}>
                    <label className="flex items-center gap-2 text-sm font-bold text-gray-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={lista.filter((p) => !pagableBloqueado(p)).every((p) => seleccion.has(claveDe(p))) && lista.some((p) => !pagableBloqueado(p))}
                        onChange={() => alternarBeneficiario(lista)}
                      />
                      {beneficiario}
                    </label>
                    <span className="text-xs font-black text-[#0b315f]">{fmtMoneda(totalGrupo)}</span>
                  </div>
                  {lista.map((p) => {
                    const bloqueado = pagableBloqueado(p);
                    const conAviso = p.advertencias.length > 0;
                    return (
                      <div
                        key={claveDe(p)}
                        className="px-4 py-2 flex items-start gap-3 border-t"
                        style={{ borderColor: "#f1f5f9", background: conAviso ? "#fef9c3" : undefined }}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={bloqueado}
                          checked={seleccion.has(claveDe(p))}
                          onChange={() => alternarPagable(p)}
                          aria-label={`Seleccionar ${p.referencia ?? claveDe(p)}`}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-700">
                            {ETIQUETA_TIPO[p.documento_tipo] ?? p.documento_tipo} · <span className="font-mono">{p.referencia ?? "—"}</span>
                          </p>
                          <p className="text-[10px] text-gray-400 font-mono">
                            {p.banco ?? "sin banco"} · {p.cuenta_destino ?? p.cci_destino ?? "sin cuenta ni CCI"} · vence {fmtFecha(p.fecha_vencimiento)}
                          </p>
                          {conAviso && (
                            <p className="text-[10px] font-bold" style={{ color: "#854d0e" }}>
                              ⚠️ {p.advertencias.join(" · ")}
                              {bloqueado ? " — no se puede abonar sin cuenta ni CCI" : ""}
                            </p>
                          )}
                        </div>
                        <span className="text-xs font-black text-red-700 whitespace-nowrap">{fmtMoneda(p.monto, p.moneda)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
        </section>

        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-white rounded-2xl border shadow-xl px-5 py-3 flex items-center gap-4 flex-wrap max-w-[95vw]">
          <p className="text-sm font-bold text-[#0b315f]">
            {seleccionados.length} línea{seleccionados.length === 1 ? "" : "s"} · {fmtMoneda(totalSeleccion)}
          </p>
          <button
            className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
            style={{ background: "#0b315f" }}
            onClick={guardarLote}
            disabled={procesando || !seleccionados.length}
          >
            Crear lote
          </button>
        </div>
      </main>
    );
  }

  // ── Listado ─────────────────────────────────────────────────────────────────

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
          <h1 className="text-3xl font-bold text-gray-900">Lotes de pago</h1>
          <p className="text-gray-400 text-sm mt-1">Borrador → Aprobado → Telecrédito → Pagado · Un archivo de abono por lote</p>
        </div>
        <button className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90" style={{ background: "#0b315f" }} onClick={() => setArmando(true)}>
          + Nuevo lote
        </button>
      </div>

      <div className="mb-4 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">
        El archivo de abono se genera como CSV con las columnas del pago masivo. El formato exacto lo define el convenio de cada
        empresa con el banco: cotéjalo una vez contra la estructura que pide tu Telecrédito y ajusta el orden si lo exige distinto.
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
          Solo gerencia puede aprobar pagos. Puedes armar y consultar lotes, pero no visarlos.
        </div>
      )}

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
              {!loading && !lotes.length && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">📦</p>
                    <p>Todavía no hay lotes de pago</p>
                  </td>
                </tr>
              )}
              {!loading &&
                lotes.map((l) => {
                  const cfg = ESTADOS_LOTE[l.estado] ?? ESTADOS_LOTE.borrador;
                  const expandido = abierto === l.id;
                  return (
                    <React.Fragment key={l.id}>
                      <tr className="border-t hover:bg-gray-50 cursor-pointer" style={{ borderColor: "#f1f5f9" }} onClick={() => alternarLote(l.id)}>
                        <td className="p-3 font-mono font-black text-xs text-[#0b315f] whitespace-nowrap">{l.codigo ?? `#${l.id}`}</td>
                        <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(l.fecha)}</td>
                        <td className="p-3 text-xs text-gray-600 font-medium">{l.banco}</td>
                        <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(l.fecha_programada)}</td>
                        <td className="p-3 text-xs text-gray-600 font-medium">{l.items}</td>
                        <td className="p-3 font-black text-xs text-red-700 whitespace-nowrap">{fmtMoneda(Number(l.total ?? 0), l.moneda)}</td>
                        <td className="p-3">
                          <span className="text-xs font-bold px-2.5 py-1 rounded-lg whitespace-nowrap" style={{ background: cfg.bg, color: cfg.color }}>
                            {cfg.label}
                          </span>
                        </td>
                        <td className="p-3 text-xs text-gray-400">{expandido ? "▲ Cerrar" : "▼ Ver líneas"}</td>
                      </tr>

                      {expandido && (
                        <tr style={{ borderColor: "#f1f5f9" }}>
                          <td colSpan={CABECERAS.length} className="p-4" style={{ background: "#f8fafc" }}>
                            <div className="flex gap-2 flex-wrap mb-3">
                              {l.estado === "borrador" &&
                                (puedeAprobar ? (
                                  <button
                                    className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                                    onClick={() => aprobar(l)}
                                    disabled={procesando}
                                  >
                                    Aprobar lote
                                  </button>
                                ) : (
                                  <span className="text-xs text-amber-700">Solo gerencia puede aprobar este lote</span>
                                ))}
                              {l.estado === "aprobado" && (
                                <>
                                  <button
                                    className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                                    onClick={() => descargarArchivo(l)}
                                  >
                                    ⬇️ Descargar archivo Telecrédito
                                  </button>
                                  <button
                                    className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                                    onClick={() => marcarEnviado(l)}
                                    disabled={procesando}
                                  >
                                    Marcar enviado al banco
                                  </button>
                                </>
                              )}
                              {l.estado === "enviado_banco" && (
                                <>
                                  <button
                                    className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                                    onClick={() => abrirConfirmacion(l)}
                                    disabled={procesando}
                                  >
                                    Confirmar pago
                                  </button>
                                  <button
                                    className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                                    onClick={() => descargarArchivo(l)}
                                  >
                                    ⬇️ Volver a descargar archivo
                                  </button>
                                </>
                              )}
                              {l.estado !== "pagado" && l.estado !== "anulado" && (
                                <button
                                  className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50"
                                  onClick={() => anular(l)}
                                  disabled={procesando}
                                >
                                  Anular
                                </button>
                              )}
                            </div>

                            <div className="bg-white rounded-xl border overflow-hidden">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                                    {CABECERAS_ITEMS.map((h) => (
                                      <th key={h} className="p-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                                        {h === "Rechazar" && l.estado !== "enviado_banco" ? "" : h}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {cargandoItems && (
                                    <tr>
                                      <td colSpan={CABECERAS_ITEMS.length} className="p-6 text-center text-gray-400 text-xs">
                                        Cargando líneas…
                                      </td>
                                    </tr>
                                  )}
                                  {!cargandoItems && !items.length && (
                                    <tr>
                                      <td colSpan={CABECERAS_ITEMS.length} className="p-6 text-center text-gray-400 text-xs">
                                        El lote no tiene líneas.
                                      </td>
                                    </tr>
                                  )}
                                  {!cargandoItems &&
                                    items.map((it) => {
                                      const cfgItem = ESTADOS_ITEM[it.estado] ?? ESTADOS_ITEM.pendiente;
                                      return (
                                        <tr key={it.id} className="border-t" style={{ borderColor: "#f1f5f9" }}>
                                          <td className="p-2 text-xs font-bold text-gray-800">{it.beneficiario}</td>
                                          <td className="p-2 text-[10px] text-gray-500">
                                            {ETIQUETA_TIPO[it.documento_tipo] ?? it.documento_tipo}
                                            <span className="block font-mono">{it.documento_identidad ?? "—"}</span>
                                          </td>
                                          <td className="p-2 text-xs text-gray-600">{it.banco ?? "—"}</td>
                                          <td className="p-2 font-mono text-[10px] text-gray-500">{it.cuenta_destino ?? it.cci_destino ?? "—"}</td>
                                          <td className="p-2 text-[10px] text-gray-500">{it.referencia ?? "—"}</td>
                                          <td className="p-2 font-black text-xs text-red-700 whitespace-nowrap">{fmtMoneda(Number(it.monto), it.moneda)}</td>
                                          <td className="p-2">
                                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg whitespace-nowrap" style={{ background: cfgItem.bg, color: cfgItem.color }}>
                                              {cfgItem.label}
                                            </span>
                                            {it.motivo_rechazo && <p className="text-[10px] text-red-600 mt-0.5">{it.motivo_rechazo}</p>}
                                          </td>
                                          <td className="p-2">
                                            {l.estado === "enviado_banco" && it.estado === "pendiente" ? (
                                              <input
                                                className="w-full border border-gray-200 rounded-lg px-2 py-1 text-[10px] focus:outline-none"
                                                placeholder="Motivo del rechazo"
                                                value={rechazados[it.id] ?? ""}
                                                onChange={(e) => setRechazados((prev) => ({ ...prev, [it.id]: e.target.value }))}
                                              />
                                            ) : null}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                </tbody>
                              </table>
                            </div>

                            {l.observaciones && <p className="text-xs text-gray-400 mt-2">📝 {l.observaciones}</p>}
                            {l.aprobado_por && (
                              <p className="text-xs text-gray-400 mt-1">
                                Aprobado por {l.aprobado_por} · {fmtFecha(l.fecha_aprobacion?.slice(0, 10))}
                              </p>
                            )}
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
          <span>{lotes.length} lotes</span>
          <span>Total histórico: {fmtMoneda(redondear(lotes.reduce((s, l) => s + Number(l.total ?? 0), 0)))}</span>
        </div>
      </section>

      {confirmando && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setConfirmando(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b">
              <h3 className="font-bold text-gray-900">Confirmar pago del lote {confirmando.codigo ?? `#${confirmando.id}`}</h3>
              <p className="text-xs text-gray-400 mt-1">
                Se emitirá un pago por cada línea no rechazada y se aplicará a su comprobante. Si el banco devolvió alguna línea,
                escribe su motivo aquí abajo: solo las líneas con motivo se marcan como rechazadas.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="Fecha del pago">
                  <input type="date" className={inputCls()} value={fechaPago} onChange={(e) => setFechaPago(e.target.value)} />
                </Campo>
                <Campo label="N° de operación">
                  <input className={inputCls("font-mono")} value={nroOperacion} onChange={(e) => setNroOperacion(e.target.value)} />
                </Campo>
              </div>

              {/* Los motivos viven en el mismo estado que los inputs de la fila del panel
                  expandido: se editen donde se editen, se envían igual. */}
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
                  Líneas del lote ({itemsPendientes.length} por pagar)
                </p>
                {!itemsPendientes.length && (
                  <p className="text-xs text-gray-400">No quedan líneas pendientes en este lote.</p>
                )}
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {itemsPendientes.map((it) => (
                    <div key={it.id} className="rounded-xl border p-3 space-y-2" style={{ borderColor: "#e2e8f0" }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-gray-800 truncate">{it.beneficiario}</p>
                          <p className="text-[10px] text-gray-400 font-mono">
                            {ETIQUETA_TIPO[it.documento_tipo] ?? it.documento_tipo} · {it.referencia ?? "—"}
                          </p>
                        </div>
                        <span className="text-xs font-black text-red-700 whitespace-nowrap">{fmtMoneda(Number(it.monto), it.moneda)}</span>
                      </div>
                      <input
                        className="w-full border border-gray-200 rounded-lg px-2 py-1 text-[11px] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                        placeholder="Motivo del rechazo (déjalo vacío si el banco sí lo pagó)"
                        value={rechazados[it.id] ?? ""}
                        onChange={(e) => setRechazados((prev) => ({ ...prev, [it.id]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {Object.values(rechazados).some((m) => m.trim()) && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
                  <span>⚠️</span>
                  {Object.values(rechazados).filter((m) => m.trim()).length} línea(s) se marcarán como rechazadas por el banco y no
                  generarán pago.
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t flex justify-end gap-3">
              <button className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50" onClick={() => setConfirmando(null)}>
                Cancelar
              </button>
              <button
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
                style={{ background: "#0b315f" }}
                onClick={confirmarPago}
                disabled={procesando}
              >
                {procesando ? "Confirmando…" : "Confirmar pago"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
