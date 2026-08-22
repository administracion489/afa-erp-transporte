"use client";

// ──────────────────────────────────────────────────────────────────────────────
// Pestaña "Planilla y gastos administrativos" — CRUD de `gastos_generales`.
//
// Es el gasto que NO tiene factura de proveedor detrás: sueldos, honorarios de
// gerencia, alquileres, luz, tributos. Comparte con las CxP los dos ejes ortogonales
// (aprobación de gerencia y estado de pago) para que un lote de pago pueda mezclar
// ambos orígenes sin traducir estados.
//
// La recurrencia se materializa a mano ("Generar mes siguiente") y no por trigger: un
// alquiler que sube de precio o un sueldo que cambia debe pasar por el ojo de alguien
// antes de convertirse en una obligación del mes que viene.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda, redondear } from "@/lib/finanzas/dinero";
import { exportarXlsx, type Columna } from "@/lib/finanzas/exportar";
import { PERFILES_GASTOS_GENERALES } from "@/lib/importador/perfiles-finanzas";
import ImportadorFinanzas from "@/app/_components/ImportadorFinanzas";
import type { GastoGeneral } from "@/lib/finanzas/tipos";

type ConfigChip = { label: string; bg: string; color: string };

const CATEGORIAS: Record<string, ConfigChip> = {
  planilla: { label: "Planilla", bg: "#ede9fe", color: "#6d28d9" },
  gasto_gerencia: { label: "Gerencia", bg: "#dbeafe", color: "#1d4ed8" },
  tercerizado: { label: "Tercerizado", bg: "#f0fdfa", color: "#0f766e" },
  servicios_fijos: { label: "Servicios fijos", bg: "#fff7ed", color: "#ea580c" },
  tributos: { label: "Tributos", bg: "#fee2e2", color: "#991b1b" },
  mantenimiento: { label: "Mantenimiento", bg: "#fef9c3", color: "#854d0e" },
  financiero: { label: "Financiero", bg: "#eef3f8", color: "#0b315f" },
  otro: { label: "Otro", bg: "#f3f4f6", color: "#4b5563" },
};

const ESTADOS_APROBACION: Record<string, ConfigChip> = {
  pendiente: { label: "Pendiente", bg: "#f3f4f6", color: "#4b5563" },
  aprobado: { label: "Aprobado", bg: "#dbeafe", color: "#1d4ed8" },
  rechazado: { label: "Rechazado", bg: "#fee2e2", color: "#991b1b" },
};

const ESTADOS_PAGO: Record<string, ConfigChip> = {
  impaga: { label: "Impaga", bg: "#fee2e2", color: "#991b1b" },
  parcial: { label: "Parcial", bg: "#fef9c3", color: "#854d0e" },
  pagada: { label: "Pagada", bg: "#dcfce7", color: "#166534" },
};

const PERIODICIDADES = [
  { v: "mensual", label: "Mensual" },
  { v: "quincenal", label: "Quincenal" },
  { v: "semanal", label: "Semanal" },
  { v: "anual", label: "Anual" },
];

const CABECERAS = [
  "",
  "Código",
  "Categoría",
  "Beneficiario",
  "Concepto",
  "Periodo",
  "Vencimiento",
  "Monto",
  "Cuenta destino",
  "Aprobación",
  "Pago",
  "Acciones",
];

const COLUMNAS_EXPORT: Columna<GastoGeneral>[] = [
  { titulo: "BENEFICIARIO", valor: (g) => g.beneficiario_nombre },
  { titulo: "DNI", valor: (g) => g.documento_identidad ?? "" },
  { titulo: "CATEGORIA", valor: (g) => CATEGORIAS[g.categoria]?.label ?? g.categoria },
  { titulo: "CONCEPTO", valor: (g) => g.concepto },
  { titulo: "PERIODO", valor: (g) => g.periodo ?? "" },
  { titulo: "FECHA", valor: (g) => g.fecha, tipo: "fecha" },
  { titulo: "FECHA DE VENCIMIENTO", valor: (g) => g.fecha_vencimiento ?? "", tipo: "fecha" },
  { titulo: "MONTO", valor: (g) => Number(g.monto ?? 0), tipo: "monto" },
  { titulo: "MONEDA", valor: (g) => g.moneda ?? "PEN" },
  { titulo: "BANCO", valor: (g) => g.banco_destino ?? "" },
  { titulo: "NUMERO DE CUENTA", valor: (g) => g.cuenta_destino ?? "" },
  { titulo: "CCI", valor: (g) => g.cci_destino ?? "" },
  { titulo: "ESTADO", valor: (g) => ESTADOS_PAGO[g.estado_pago]?.label ?? g.estado_pago },
  { titulo: "NRO OPERACION", valor: (g) => g.nro_operacion_bancaria ?? "" },
  { titulo: "FECHA DE PAGO", valor: (g) => g.fecha_pago ?? "", tipo: "fecha" },
  { titulo: "COMPROBANTE", valor: (g) => g.comprobante_ref ?? "" },
  { titulo: "OBSERVACIONES", valor: (g) => g.observaciones ?? "" },
];

type Formulario = {
  id: number | null;
  categoria: string;
  beneficiario_nombre: string;
  documento_identidad: string;
  concepto: string;
  descripcion: string;
  periodo: string;
  fecha: string;
  fecha_vencimiento: string;
  monto: string;
  moneda: string;
  banco_destino: string;
  cuenta_destino: string;
  cci_destino: string;
  recurrente: boolean;
  periodicidad: string;
  comprobante_ref: string;
  observaciones: string;
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

function Chip({ cfg }: { cfg: ConfigChip }) {
  return (
    <span className="text-xs font-bold px-2.5 py-1 rounded-lg whitespace-nowrap" style={{ background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
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

function etiquetaMes(m: string): string {
  if (!/^\d{4}-\d{2}$/.test(m)) return m;
  return new Date(m + "-01T00:00:00").toLocaleDateString("es-PE", { month: "long", year: "numeric" });
}

/** El filtro de periodo admite "" (todos): sin esto el rótulo saldría vacío. */
function etiquetaPeriodo(m: string): string {
  return m ? etiquetaMes(m) : "todos los periodos";
}

/** Corre una fecha civil N meses, recortando el día al último del mes destino. */
function sumarMeses(fechaISO: string, n: number): string {
  const [y, m, d] = fechaISO.slice(0, 10).split("-").map(Number);
  const destino = new Date(Date.UTC(y, m - 1 + n, 1));
  const ultimoDia = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate();
  destino.setUTCDate(Math.min(d, ultimoDia));
  return destino.toISOString().slice(0, 10);
}

function siguientePeriodo(periodo: string): string {
  const [y, m] = periodo.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

function num(v: string): number {
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function formularioVacio(periodo: string): Formulario {
  return {
    id: null,
    categoria: "servicios_fijos",
    beneficiario_nombre: "",
    documento_identidad: "",
    concepto: "",
    descripcion: "",
    periodo,
    fecha: hoyLima(),
    fecha_vencimiento: "",
    monto: "",
    moneda: "PEN",
    banco_destino: "",
    cuenta_destino: "",
    cci_destino: "",
    recurrente: false,
    periodicidad: "mensual",
    comprobante_ref: "",
    observaciones: "",
  };
}

export default function PlanillaTab() {
  const mesActual = hoyLima().slice(0, 7);

  const [filas, setFilas] = useState<GastoGeneral[]>([]);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [fCategoria, setFCategoria] = useState("");
  const [fAprobacion, setFAprobacion] = useState("");
  const [fPago, setFPago] = useState("");
  const [mes, setMes] = useState(mesActual);

  const [form, setForm] = useState<Formulario>(() => formularioVacio(mesActual));
  const [formAbierto, setFormAbierto] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);

  const [seleccion, setSeleccion] = useState<Set<number>>(new Set());
  const [puedeAprobar, setPuedeAprobar] = useState(false);
  const [usuarioNombre, setUsuarioNombre] = useState("");
  const [procesando, setProcesando] = useState(false);
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [importando, setImportando] = useState(false);
  const [confirmarGenerar, setConfirmarGenerar] = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const set = useCallback(<K extends keyof Formulario>(clave: K, valor: Formulario[K]) => {
    setForm((f) => ({ ...f, [clave]: valor }));
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("gastos_generales")
      .select("*")
      .order("fecha", { ascending: false })
      .order("id", { ascending: false });
    setFilas((data ?? []) as GastoGeneral[]);
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

  /** El periodo de una fila: el declarado, o el mes de su fecha de devengue. */
  const periodoDe = useCallback((g: GastoGeneral) => (g.periodo || g.fecha.slice(0, 7)).slice(0, 7), []);

  const meses = useMemo(() => {
    const set2 = new Set<string>([mesActual]);
    for (const g of filas) set2.add(periodoDe(g));
    return Array.from(set2).sort().reverse();
  }, [filas, mesActual, periodoDe]);

  const delMes = useMemo(() => filas.filter((g) => !mes || periodoDe(g) === mes), [filas, mes, periodoDe]);

  const filtradas = useMemo(() => {
    const texto = q.trim().toLowerCase();
    return delMes.filter((g) => {
      if (fCategoria && g.categoria !== fCategoria) return false;
      if (fAprobacion && g.estado_aprobacion !== fAprobacion) return false;
      if (fPago && g.estado_pago !== fPago) return false;
      if (!texto) return true;
      return (
        g.beneficiario_nombre.toLowerCase().includes(texto) ||
        g.concepto.toLowerCase().includes(texto) ||
        (g.codigo ?? "").toLowerCase().includes(texto) ||
        (g.documento_identidad ?? "").includes(texto)
      );
    });
  }, [delMes, q, fCategoria, fAprobacion, fPago]);

  // KPI por categoría del mes elegido: solo se pintan las categorías con movimiento,
  // una tarjeta vacía por cada rubro del catálogo sería ruido.
  const kpis = useMemo(() => {
    const acumulado = new Map<string, number>();
    for (const g of delMes) acumulado.set(g.categoria, (acumulado.get(g.categoria) ?? 0) + Number(g.monto ?? 0));
    return Array.from(acumulado.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([clave, monto]) => {
        const cfg = CATEGORIAS[clave] ?? CATEGORIAS.otro;
        return { label: cfg.label, valor: fmtMoneda(redondear(monto)), color: cfg.color, bg: cfg.bg };
      });
  }, [delMes]);

  const totalMes = useMemo(() => redondear(delMes.reduce((s, g) => s + Number(g.monto ?? 0), 0)), [delMes]);
  const impagoMes = useMemo(
    () => redondear(delMes.filter((g) => g.estado_pago !== "pagada").reduce((s, g) => s + Number(g.monto ?? 0), 0)),
    [delMes]
  );

  const seleccionadas = useMemo(() => filtradas.filter((g) => seleccion.has(g.id)), [filtradas, seleccion]);
  const totalSeleccion = useMemo(
    () => redondear(seleccionadas.reduce((s, g) => s + Number(g.monto ?? 0), 0)),
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

  const todasMarcadas = filtradas.length > 0 && filtradas.every((g) => seleccion.has(g.id));
  const alternarTodas = useCallback(() => {
    setSeleccion((prev) => {
      if (filtradas.length && filtradas.every((g) => prev.has(g.id))) return new Set();
      return new Set(filtradas.map((g) => g.id));
    });
  }, [filtradas]);

  const abrirNuevo = useCallback(() => {
    setForm(formularioVacio(mes || mesActual));
    setErrorForm(null);
    setFormAbierto(true);
  }, [mes, mesActual]);

  const abrirEdicion = useCallback((g: GastoGeneral) => {
    setForm({
      id: g.id,
      categoria: g.categoria,
      beneficiario_nombre: g.beneficiario_nombre,
      documento_identidad: g.documento_identidad ?? "",
      concepto: g.concepto,
      descripcion: g.descripcion ?? "",
      periodo: g.periodo ?? g.fecha.slice(0, 7),
      fecha: g.fecha.slice(0, 10),
      fecha_vencimiento: (g.fecha_vencimiento ?? "").slice(0, 10),
      monto: String(Number(g.monto ?? 0)),
      moneda: g.moneda ?? "PEN",
      banco_destino: g.banco_destino ?? "",
      cuenta_destino: g.cuenta_destino ?? "",
      cci_destino: g.cci_destino ?? "",
      recurrente: !!g.recurrente,
      periodicidad: g.periodicidad ?? "mensual",
      comprobante_ref: g.comprobante_ref ?? "",
      observaciones: g.observaciones ?? "",
    });
    setErrorForm(null);
    setFormAbierto(true);
  }, []);

  const guardar = useCallback(async () => {
    setErrorForm(null);
    if (!form.beneficiario_nombre.trim()) return setErrorForm("Falta el beneficiario.");
    if (!form.concepto.trim()) return setErrorForm("Falta el concepto.");
    if (num(form.monto) <= 0) return setErrorForm("El monto debe ser mayor que cero.");
    if (!form.fecha) return setErrorForm("Falta la fecha.");

    const payload: Record<string, unknown> = {
      categoria: form.categoria,
      beneficiario_nombre: form.beneficiario_nombre.trim(),
      documento_identidad: form.documento_identidad.trim() || null,
      concepto: form.concepto.trim(),
      descripcion: form.descripcion.trim() || null,
      periodo: form.periodo || null,
      fecha: form.fecha,
      fecha_vencimiento: form.fecha_vencimiento || null,
      monto: num(form.monto),
      moneda: form.moneda,
      banco_destino: form.banco_destino.trim() || null,
      cuenta_destino: form.cuenta_destino.trim() || null,
      cci_destino: form.cci_destino.trim() || null,
      recurrente: form.recurrente,
      periodicidad: form.recurrente ? form.periodicidad : null,
      comprobante_ref: form.comprobante_ref.trim() || null,
      observaciones: form.observaciones.trim() || null,
    };

    setGuardando(true);
    const { error } = form.id
      ? await supabase.from("gastos_generales").update(payload).eq("id", form.id)
      : await supabase.from("gastos_generales").insert({ ...payload, creado_por: usuarioNombre || null });
    setGuardando(false);
    if (error) return setErrorForm(error.message);
    setFormAbierto(false);
    showToast(form.id ? "Gasto actualizado." : "Gasto registrado.");
    cargar();
  }, [form, usuarioNombre, cargar, showToast]);

  const eliminar = useCallback(
    async (g: GastoGeneral) => {
      if (g.estado_pago === "pagada") return showToast("No se elimina un gasto ya pagado: anúlalo con una observación.", false);
      if (!confirm(`¿Eliminar "${g.concepto}" de ${g.beneficiario_nombre} por ${fmtMoneda(Number(g.monto ?? 0), g.moneda)}?`)) return;
      const { error } = await supabase.from("gastos_generales").delete().eq("id", g.id);
      if (error) return showToast(error.message, false);
      showToast(`${g.codigo ?? "Gasto"} eliminado.`);
      cargar();
    },
    [cargar, showToast]
  );

  const aprobar = useCallback(async () => {
    const ids = seleccionadas.map((g) => g.id);
    if (!ids.length) return;
    setProcesando(true);
    const { error } = await supabase
      .from("gastos_generales")
      .update({
        estado_aprobacion: "aprobado",
        aprobado_por: usuarioNombre || null,
        fecha_aprobacion: new Date().toISOString(),
        motivo_rechazo: null,
      })
      .in("id", ids);
    setProcesando(false);
    if (error) return showToast(error.message, false);
    showToast(`${ids.length} gasto${ids.length === 1 ? "" : "s"} aprobado${ids.length === 1 ? "" : "s"}.`);
    cargar();
  }, [seleccionadas, usuarioNombre, cargar, showToast]);

  const rechazar = useCallback(async () => {
    const ids = seleccionadas.map((g) => g.id);
    if (!ids.length) return;
    if (!motivo.trim()) return showToast("Escribe el motivo del rechazo.", false);
    setProcesando(true);
    const { error } = await supabase
      .from("gastos_generales")
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
    showToast(`${ids.length} gasto${ids.length === 1 ? "" : "s"} rechazado${ids.length === 1 ? "" : "s"}.`);
    cargar();
  }, [seleccionadas, motivo, usuarioNombre, cargar, showToast]);

  // La generación SIEMPRE parte de un mes concreto. Se ancla a `periodoBase` y no a
  // `delMes`: con el filtro en "todos los periodos" delMes es el histórico entero, y
  // duplicarlo replicaría al mes que viene cada recurrente que existió alguna vez.
  const periodoBase = mes || mesActual;

  const recurrentesDelMes = useMemo(
    () => filas.filter((g) => periodoDe(g) === periodoBase && g.recurrente && g.estado_aprobacion === "aprobado"),
    [filas, periodoBase, periodoDe]
  );

  const generarMesSiguiente = useCallback(async () => {
    const periodoDestino = siguientePeriodo(periodoBase);
    const nuevos = recurrentesDelMes.map((g) => ({
      categoria: g.categoria,
      beneficiario_nombre: g.beneficiario_nombre,
      documento_identidad: g.documento_identidad,
      concepto: g.concepto,
      descripcion: g.descripcion,
      periodo: periodoDestino,
      fecha: sumarMeses(g.fecha, 1),
      fecha_vencimiento: g.fecha_vencimiento ? sumarMeses(g.fecha_vencimiento, 1) : null,
      monto: Number(g.monto ?? 0),
      moneda: g.moneda,
      banco_destino: g.banco_destino,
      cuenta_destino: g.cuenta_destino,
      cci_destino: g.cci_destino,
      recurrente: true,
      periodicidad: g.periodicidad,
      comprobante_ref: null,
      observaciones: g.observaciones,
      // El duplicado NACE pendiente e impago: replicar la aprobación del mes anterior
      // sería aprobar a ciegas un importe que nadie ha vuelto a mirar.
      estado_aprobacion: "pendiente",
      estado_pago: "impaga",
      proveedor_id: g.proveedor_id,
      vehiculo_id: g.vehiculo_id,
      conductor_id: g.conductor_id,
      creado_por: usuarioNombre || null,
    }));

    setProcesando(true);
    const { error } = await supabase.from("gastos_generales").insert(nuevos);
    setProcesando(false);
    setConfirmarGenerar(false);
    if (error) return showToast(error.message, false);
    showToast(`${nuevos.length} gasto${nuevos.length === 1 ? "" : "s"} generado${nuevos.length === 1 ? "" : "s"} para ${etiquetaMes(periodoDestino)}.`);
    cargar();
  }, [recurrentesDelMes, periodoBase, usuarioNombre, cargar, showToast]);

  const exportar = useCallback(() => {
    if (!filtradas.length) return showToast("No hay filas que exportar con los filtros actuales.", false);
    exportarXlsx(filtradas, COLUMNAS_EXPORT, {
      nombre: "planilla_gastos_administrativos",
      hoja: "Gastos",
      titulo: "Planilla y gastos administrativos · AFA Transportes",
      subtitulo: `${etiquetaPeriodo(mes)} · ${filtradas.length} registros`,
      totales: true,
    }).catch((e) => showToast(`No se pudo generar el Excel: ${String((e as Error)?.message ?? e)}`, false));
  }, [filtradas, mes, showToast]);

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
          <h1 className="text-3xl font-bold text-gray-900">Planilla y gastos administrativos</h1>
          <p className="text-gray-400 text-sm mt-1">Sueldos · Gerencia · Servicios fijos · Tributos · Recurrentes</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}
            onClick={() => setConfirmarGenerar(true)}
          >
            🔁 Generar mes siguiente
          </button>
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
          <button className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90" style={{ background: "#0b315f" }} onClick={abrirNuevo}>
            + Nuevo gasto
          </button>
        </div>
      </div>

      <section className="rounded-2xl border-2 p-4" style={{ background: "#0b315f", borderColor: "#0b315f" }}>
        <p className="text-[10px] font-bold uppercase tracking-widest text-blue-200 mb-1">Gasto administrativo de {etiquetaPeriodo(mes)}</p>
        <p className="text-4xl font-black text-white">{fmtMoneda(totalMes)}</p>
        <p className="text-blue-200 text-xs mt-1">
          {delMes.length} registro{delMes.length === 1 ? "" : "s"} · {fmtMoneda(impagoMes)} sin pagar · {recurrentesDelMes.length} recurrente
          {recurrentesDelMes.length === 1 ? "" : "s"} aprobado{recurrentesDelMes.length === 1 ? "" : "s"} en {etiquetaMes(periodoBase)}
        </p>
      </section>

      {kpis.length > 0 && (
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
      )}

      {!puedeAprobar && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          <span>🔒</span>
          Solo gerencia puede aprobar pagos. Puedes registrar y editar gastos, pero no visarlos.
        </div>
      )}

      {formAbierto && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-gray-900">{form.id ? "Editar gasto" : "Nuevo gasto administrativo"}</h2>
            <button className="text-sm text-gray-400 hover:text-gray-600" onClick={() => setFormAbierto(false)}>
              Cerrar
            </button>
          </div>

          {errorForm && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3 text-sm text-red-800">
              <span>⚠️</span>
              {errorForm}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Campo label="Categoría">
              <select className={inputCls()} value={form.categoria} onChange={(e) => set("categoria", e.target.value)}>
                {Object.entries(CATEGORIAS).map(([k, c]) => (
                  <option key={k} value={k}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Beneficiario">
              <input className={inputCls()} value={form.beneficiario_nombre} onChange={(e) => set("beneficiario_nombre", e.target.value)} />
            </Campo>
            <Campo label="DNI / RUC">
              <input className={inputCls("font-mono")} value={form.documento_identidad} onChange={(e) => set("documento_identidad", e.target.value.replace(/\D/g, ""))} maxLength={11} />
            </Campo>
            <Campo label="Concepto" span={2}>
              <input className={inputCls()} value={form.concepto} placeholder="Sueldo agosto · Alquiler cochera · AFP…" onChange={(e) => set("concepto", e.target.value)} />
            </Campo>
            <Campo label="Periodo (AAAA-MM)">
              <input className={inputCls("font-mono")} value={form.periodo} placeholder="2026-08" onChange={(e) => set("periodo", e.target.value)} />
            </Campo>
            <Campo label="Fecha de devengue">
              <input type="date" className={inputCls()} value={form.fecha} onChange={(e) => set("fecha", e.target.value)} />
            </Campo>
            <Campo label="Fecha de vencimiento">
              <input type="date" className={inputCls()} value={form.fecha_vencimiento} onChange={(e) => set("fecha_vencimiento", e.target.value)} />
            </Campo>
            <Campo label="Monto">
              <input className={inputCls("font-bold")} inputMode="decimal" value={form.monto} onChange={(e) => set("monto", e.target.value)} />
            </Campo>
            <Campo label="Moneda">
              <select className={inputCls()} value={form.moneda} onChange={(e) => set("moneda", e.target.value)}>
                <option value="PEN">Soles (PEN)</option>
                <option value="USD">Dólares (USD)</option>
              </select>
            </Campo>
            <Campo label="Banco destino">
              <input className={inputCls()} value={form.banco_destino} onChange={(e) => set("banco_destino", e.target.value)} />
            </Campo>
            <Campo label="Número de cuenta">
              <input className={inputCls("font-mono")} value={form.cuenta_destino} onChange={(e) => set("cuenta_destino", e.target.value)} />
            </Campo>
            <Campo label="CCI">
              <input className={inputCls("font-mono")} value={form.cci_destino} maxLength={20} onChange={(e) => set("cci_destino", e.target.value.replace(/\D/g, ""))} />
            </Campo>
            <Campo label="Comprobante / referencia">
              <input className={inputCls()} value={form.comprobante_ref} placeholder="RH E001-25 · contrato…" onChange={(e) => set("comprobante_ref", e.target.value)} />
            </Campo>
            <Campo label="¿Se repite?">
              <label className="flex items-center gap-2 h-[42px] px-3 border border-gray-200 rounded-xl text-sm text-gray-600">
                <input type="checkbox" checked={form.recurrente} onChange={(e) => set("recurrente", e.target.checked)} />
                Gasto recurrente
              </label>
            </Campo>
            <Campo label="Periodicidad">
              <select className={inputCls()} value={form.periodicidad} disabled={!form.recurrente} onChange={(e) => set("periodicidad", e.target.value)}>
                {PERIODICIDADES.map((p) => (
                  <option key={p.v} value={p.v}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Observaciones" span={3}>
              <textarea className={inputCls()} rows={2} value={form.observaciones} onChange={(e) => set("observaciones", e.target.value)} />
            </Campo>
          </div>

          <div className="flex justify-end gap-3">
            <button className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50" onClick={() => setFormAbierto(false)}>
              Cancelar
            </button>
            <button
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}
              onClick={guardar}
              disabled={guardando}
            >
              {guardando ? "Guardando…" : form.id ? "Guardar cambios" : "Registrar gasto"}
            </button>
          </div>
        </section>
      )}

      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input
            className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Beneficiario, concepto o código…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={mes} onChange={(e) => setMes(e.target.value)}>
          <option value="">Todos los periodos</option>
          {meses.map((m) => (
            <option key={m} value={m}>
              {etiquetaMes(m)}
            </option>
          ))}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={fCategoria} onChange={(e) => setFCategoria(e.target.value)}>
          <option value="">Todas las categorías</option>
          {Object.entries(CATEGORIAS).map(([k, c]) => (
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
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={fPago} onChange={(e) => setFPago(e.target.value)}>
          <option value="">Todo estado de pago</option>
          {Object.entries(ESTADOS_PAGO).map(([k, c]) => (
            <option key={k} value={k}>
              {c.label}
            </option>
          ))}
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">{filtradas.length} resultados</div>
      </section>

      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {CABECERAS.map((h, i) => (
                  <th key={h + i} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {i === 0 ? <input type="checkbox" checked={todasMarcadas} onChange={alternarTodas} aria-label="Seleccionar todo" /> : h}
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
                    <p className="text-3xl mb-2">💼</p>
                    <p>No hay gastos con estos filtros</p>
                  </td>
                </tr>
              )}
              {!loading &&
                filtradas.map((g) => (
                  <tr key={g.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                    <td className="p-3">
                      <input type="checkbox" checked={seleccion.has(g.id)} onChange={() => alternar(g.id)} aria-label={`Seleccionar ${g.codigo ?? g.id}`} />
                    </td>
                    <td className="p-3 font-mono font-black text-xs text-[#0b315f] whitespace-nowrap">{g.codigo ?? "—"}</td>
                    <td className="p-3">
                      <Chip cfg={CATEGORIAS[g.categoria] ?? CATEGORIAS.otro} />
                    </td>
                    <td className="p-3">
                      <p className="text-xs font-bold text-gray-800">{g.beneficiario_nombre}</p>
                      <p className="text-[10px] text-gray-400 font-mono">{g.documento_identidad ?? "sin documento"}</p>
                    </td>
                    <td className="p-3 text-xs text-gray-600 font-medium">
                      {g.concepto}
                      {g.recurrente && <span className="ml-2 text-[10px] font-bold text-[#6d28d9]">🔁 recurrente</span>}
                    </td>
                    <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{g.periodo ?? "—"}</td>
                    <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(g.fecha_vencimiento)}</td>
                    <td className="p-3 font-black text-xs text-red-700 whitespace-nowrap">{fmtMoneda(Number(g.monto ?? 0), g.moneda)}</td>
                    <td className="p-3">
                      <p className="text-xs text-gray-600 font-medium">{g.banco_destino ?? "—"}</p>
                      <p className="font-mono text-[10px] text-gray-400">{g.cuenta_destino ?? g.cci_destino ?? "sin cuenta"}</p>
                    </td>
                    <td className="p-3">
                      <Chip cfg={ESTADOS_APROBACION[g.estado_aprobacion] ?? ESTADOS_APROBACION.pendiente} />
                    </td>
                    <td className="p-3">
                      <Chip cfg={ESTADOS_PAGO[g.estado_pago] ?? ESTADOS_PAGO.impaga} />
                    </td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <button className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700" onClick={() => abrirEdicion(g)}>
                          Editar
                        </button>
                        <button className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50" onClick={() => eliminar(g)}>
                          Eliminar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>
            {filtradas.length} de {filas.length} registros
          </span>
          <span>Total filtrado: {fmtMoneda(redondear(filtradas.reduce((s, g) => s + Number(g.monto ?? 0), 0)))}</span>
        </div>
      </section>

      {seleccionadas.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-white rounded-2xl border shadow-xl px-5 py-3 flex items-center gap-4 flex-wrap max-w-[95vw]">
          <p className="text-sm font-bold text-[#0b315f]">
            {seleccionadas.length} seleccionada{seleccionadas.length === 1 ? "" : "s"} · {fmtMoneda(totalSeleccion)}
          </p>
          {puedeAprobar ? (
            <>
              <button className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60" onClick={aprobar} disabled={procesando}>
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
              <h3 className="font-bold text-gray-900">Rechazar {seleccionadas.length} gasto(s)</h3>
              <p className="text-xs text-gray-400 mt-1">El motivo queda guardado en el registro.</p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Motivo del rechazo</label>
                <textarea className={inputCls()} rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
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

      {confirmarGenerar && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setConfirmarGenerar(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b">
              <h3 className="font-bold text-gray-900">Generar {etiquetaMes(siguientePeriodo(periodoBase))}</h3>
              <p className="text-xs text-gray-400 mt-1">
                Se duplican los gastos recurrentes ya aprobados de {etiquetaMes(periodoBase)}.
              </p>
            </div>
            <div className="p-6 space-y-4">
              {recurrentesDelMes.length === 0 ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
                  <span>ℹ️</span>
                  No hay gastos recurrentes aprobados en {etiquetaMes(periodoBase)}. Marca &quot;recurrente&quot; y aprueba los que
                  deban repetirse.
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-600">
                    Se crearán <strong>{recurrentesDelMes.length}</strong> registro{recurrentesDelMes.length === 1 ? "" : "s"} por{" "}
                    <strong>{fmtMoneda(redondear(recurrentesDelMes.reduce((s, g) => s + Number(g.monto ?? 0), 0)))}</strong>, con fecha y
                    periodo corridos un mes, en estado pendiente e impago.
                  </p>
                  <ul className="text-xs text-gray-500 space-y-1 max-h-48 overflow-y-auto">
                    {recurrentesDelMes.map((g) => (
                      <li key={g.id} className="flex justify-between gap-3 border-b pb-1" style={{ borderColor: "#f1f5f9" }}>
                        <span>
                          {g.beneficiario_nombre} · {g.concepto}
                        </span>
                        <span className="font-bold text-gray-700 whitespace-nowrap">{fmtMoneda(Number(g.monto ?? 0), g.moneda)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div className="px-6 py-4 border-t flex justify-end gap-3">
              <button className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50" onClick={() => setConfirmarGenerar(false)}>
                Cancelar
              </button>
              <button
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
                style={{ background: "#0b315f" }}
                onClick={generarMesSiguiente}
                disabled={procesando || recurrentesDelMes.length === 0}
              >
                Generar {recurrentesDelMes.length} gasto{recurrentesDelMes.length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ImportadorFinanzas
        abierto={importando}
        onCerrar={() => setImportando(false)}
        perfiles={PERFILES_GASTOS_GENERALES}
        titulo="Importar planilla y gastos administrativos"
        descripcion="Sube el Sheet de sueldos, honorarios, servicios fijos o tributos. La categoría se deduce del texto si la columna no viene."
        plantilla={{
          cabeceras: COLUMNAS_EXPORT.map((c) => c.titulo),
          instrucciones: [
            "PLANILLA Y GASTOS ADMINISTRATIVOS",
            "Una fila por obligación. BENEFICIARIO, CONCEPTO y MONTO son obligatorios.",
            "PERIODO en formato AAAA-MM (2026-08). Si falta, se deduce de la FECHA.",
            "Lo que venga marcado como pagado se importa ya aprobado: no se re-aprueba el histórico.",
          ],
        }}
        onImportado={(r) => {
          showToast(`${r.creadas} creados · ${r.actualizadas} actualizados · ${r.errores.length} con error`, !r.errores.length);
          cargar();
        }}
      />
    </main>
  );
}
