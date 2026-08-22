"use client";

// ──────────────────────────────────────────────────────────────────────────────
// app/tesoreria/ModalCxP.tsx — Alta y edición MANUAL de una factura de compra.
//
// Hasta ahora el ERP solo sabía crear `documentos_compra` por IA (correo/XML), por el
// Radar o por importación masiva: una factura que llega en papel no tenía puerta de
// entrada. Este modal es esa puerta, y el mismo formulario sirve para corregir una
// fila ya existente.
//
// Ni el IGV ni la detracción se fijan aquí: el % de IGV sale de `config_tributaria`
// (fila única id=1) y las tasas de detracción de `cat_detraccion`. La aritmética la
// hace lib/finanzas/dinero — esta pantalla solo recoge datos y muestra el desglose.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { calcularDetraccion, desdeNeto, desdeTotal, fmtMoneda, redondear } from "@/lib/finanzas/dinero";
import type { CuentaPorPagar } from "@/lib/finanzas/tipos";

type Props = {
  abierto: boolean;
  onCerrar: () => void;
  /** Se llama tras guardar con el mensaje ya redactado para el toast del padre. */
  onGuardado: (mensaje: string) => void;
  /** Fila a editar; null/undefined = alta nueva. */
  documento?: CuentaPorPagar | null;
  usuarioNombre?: string;
};

type ProveedorRef = {
  id: number;
  nombre: string | null;
  razon_social: string | null;
  ruc: string | null;
  banco: string | null;
  cuenta_bancaria: string | null;
  cci: string | null;
  titular_cuenta: string | null;
};

type FilaDetraccion = {
  codigo: string;
  descripcion: string;
  porcentaje: number;
  umbral_min: number;
  activo: boolean;
};

type Formulario = {
  proveedor_id: number | null;
  proveedor_texto: string;
  ruc: string;
  titular_cuenta: string;
  banco_destino: string;
  cuenta_destino: string;
  cci_destino: string;
  tipo_comprobante: string;
  serie: string;
  numero: string;
  fecha_emision: string;
  fecha_vencimiento: string;
  moneda: string;
  /** Cómo hay que leer el importe tecleado: con IGV incluido o sin él. */
  base: "total" | "neto";
  importe: string;
  afecto_igv: boolean;
  detraccion_codigo: string;
  detraccion_pct: string;
  detraccion_monto: string;
  adelanto_1: string;
  adelanto_2: string;
  vehiculo_placa: string;
  codigo_servicio: string;
  detalle_servicio: string;
  turno: string;
  fecha_servicio: string;
  categoria: string;
  observaciones: string;
};

const TIPOS_COMPROBANTE = [
  { v: "factura", label: "Factura" },
  { v: "boleta", label: "Boleta" },
  { v: "recibo_honorarios", label: "Recibo por honorarios" },
  { v: "nota_credito", label: "Nota de crédito" },
  { v: "nota_debito", label: "Nota de débito" },
  { v: "ticket", label: "Ticket" },
];

const CATEGORIAS = [
  { v: "tercero", label: "Servicio tercerizado" },
  { v: "combustible", label: "Combustible" },
  { v: "repuestos", label: "Repuestos" },
  { v: "servicio", label: "Servicio / taller" },
  { v: "otro", label: "Otro" },
];

const TURNOS = [
  { v: "", label: "—" },
  { v: "dia", label: "Día" },
  { v: "noche", label: "Noche" },
  { v: "mixto", label: "Mixto" },
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

/** Lee un input numérico tolerando coma decimal; nunca devuelve NaN. */
function num(v: string): number {
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function hoyLima(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function formularioVacio(): Formulario {
  return {
    proveedor_id: null,
    proveedor_texto: "",
    ruc: "",
    titular_cuenta: "",
    banco_destino: "",
    cuenta_destino: "",
    cci_destino: "",
    tipo_comprobante: "factura",
    serie: "",
    numero: "",
    fecha_emision: hoyLima(),
    fecha_vencimiento: "",
    moneda: "PEN",
    base: "total",
    importe: "",
    afecto_igv: true,
    detraccion_codigo: "",
    detraccion_pct: "",
    detraccion_monto: "",
    adelanto_1: "",
    adelanto_2: "",
    vehiculo_placa: "",
    codigo_servicio: "",
    detalle_servicio: "",
    turno: "",
    fecha_servicio: "",
    categoria: "tercero",
    observaciones: "",
  };
}

function formularioDesde(d: CuentaPorPagar): Formulario {
  return {
    proveedor_id: d.proveedor_id ?? null,
    proveedor_texto: d.proveedor_razon_social ?? "",
    ruc: d.proveedor_ruc ?? "",
    titular_cuenta: d.titular_cuenta ?? "",
    banco_destino: d.banco ?? "",
    cuenta_destino: d.numero_cuenta ?? "",
    cci_destino: d.cci ?? "",
    tipo_comprobante: d.tipo_comprobante ?? "factura",
    serie: d.serie ?? "",
    numero: d.numero ?? "",
    fecha_emision: (d.fecha_emision ?? "").slice(0, 10) || hoyLima(),
    fecha_vencimiento: (d.fecha_vencimiento ?? "").slice(0, 10),
    moneda: d.moneda ?? "PEN",
    // Al editar siempre se parte del TOTAL: es el dato fiscal que figura impreso.
    base: "total",
    importe: String(Number(d.monto_neto ?? 0)),
    afecto_igv: Number(d.igv ?? 0) > 0,
    detraccion_codigo: d.detraccion_codigo ?? "",
    detraccion_pct: d.detraccion_pct != null ? String(Number(d.detraccion_pct)) : "",
    detraccion_monto: Number(d.detraccion_monto ?? 0) > 0 ? String(Number(d.detraccion_monto)) : "",
    adelanto_1: Number(d.adelanto_1 ?? 0) > 0 ? String(Number(d.adelanto_1)) : "",
    adelanto_2: Number(d.adelanto_2 ?? 0) > 0 ? String(Number(d.adelanto_2)) : "",
    vehiculo_placa: d.vehiculo_placa ?? "",
    codigo_servicio: d.codigo_servicio ?? "",
    detalle_servicio: d.detalle_servicio ?? "",
    turno: d.turno ?? "",
    fecha_servicio: (d.fecha_servicio ?? "").slice(0, 10),
    categoria: d.categoria ?? "tercero",
    observaciones: d.observaciones ?? "",
  };
}

export default function ModalCxP({ abierto, onCerrar, onGuardado, documento, usuarioNombre }: Props) {
  // El formulario se inicializa UNA vez por montaje: el padre remonta el modal en cada
  // apertura (prop `key`), que es la forma recomendada de resetear estado derivado de
  // props sin un efecto que reescriba el estado en cada render.
  const [form, setForm] = useState<Formulario>(() => (documento ? formularioDesde(documento) : formularioVacio()));
  const [proveedores, setProveedores] = useState<ProveedorRef[]>([]);
  const [catalogo, setCatalogo] = useState<FilaDetraccion[]>([]);
  const [igvPct, setIgvPct] = useState(18);
  const [igvPorDefecto, setIgvPorDefecto] = useState(false);
  const [listaProv, setListaProv] = useState(false);
  // Al editar se respeta lo que ya está guardado; en un alta manda el catálogo.
  const [detraccionManual, setDetraccionManual] = useState(!!documento);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editando = !!documento?.id;

  const set = useCallback(<K extends keyof Formulario>(clave: K, valor: Formulario[K]) => {
    setForm((f) => ({ ...f, [clave]: valor }));
  }, []);

  // Catálogos: se piden una sola vez por apertura. El estado se escribe siempre tras
  // el await, nunca de forma síncrona en el cuerpo del efecto.
  useEffect(() => {
    if (!abierto || catalogo.length || proveedores.length) return;
    (async () => {
      const [ps, cs, cfg] = await Promise.all([
        supabase
          .from("proveedores")
          .select("id, nombre, razon_social, ruc, banco, cuenta_bancaria, cci, titular_cuenta")
          .order("nombre"),
        supabase.from("cat_detraccion").select("codigo, descripcion, porcentaje, umbral_min, activo").order("codigo"),
        supabase.from("config_tributaria").select("igv_pct, detraccion_codigo_defecto").eq("id", 1).maybeSingle(),
      ]);
      setProveedores((ps.data ?? []) as ProveedorRef[]);
      setCatalogo((cs.data ?? []) as FilaDetraccion[]);
      const pct = Number(cfg.data?.igv_pct);
      if (Number.isFinite(pct) && pct > 0) {
        setIgvPct(pct);
        setIgvPorDefecto(false);
      } else {
        setIgvPct(18);
        setIgvPorDefecto(true);
      }

      // Código de detracción por defecto de la empresa (Detracciones → Tasas y códigos).
      // Solo se propone en un comprobante NUEVO y si nadie eligió todavía: en uno que se
      // está editando manda lo que ya tiene guardado.
      const porDefecto = cfg.data?.detraccion_codigo_defecto;
      if (porDefecto && !documento) {
        setForm((f) => (f.detraccion_codigo ? f : { ...f, detraccion_codigo: String(porDefecto) }));
      }
    })();
  }, [abierto, catalogo.length, proveedores.length, documento]);

  const desglose = useMemo(() => {
    const importe = num(form.importe);
    if (!form.afecto_igv) return { base: redondear(importe), igv: 0, total: redondear(importe), igvPct: 0 };
    return form.base === "total" ? desdeTotal(importe, igvPct) : desdeNeto(importe, igvPct);
  }, [form.importe, form.afecto_igv, form.base, igvPct]);

  // La detracción es DERIVADA del catálogo mientras el usuario no la toque: se calcula
  // en el render en vez de sincronizarse con un efecto, para que cambiar el importe no
  // deje nunca un monto viejo pegado en pantalla.
  const detraccionAuto = useMemo(() => {
    const cfg = catalogo.find((c) => c.codigo === form.detraccion_codigo);
    if (!cfg) return null;
    const d = calcularDetraccion(desglose.total, {
      porcentaje: Number(cfg.porcentaje),
      umbral_min: Number(cfg.umbral_min),
      codigo: cfg.codigo,
      activa: cfg.activo,
    });
    return { pct: Number(cfg.porcentaje), monto: d.monto };
  }, [catalogo, form.detraccion_codigo, desglose.total]);

  const detraccionPct = detraccionManual ? num(form.detraccion_pct) : detraccionAuto?.pct ?? 0;
  const detraccionMonto = detraccionManual ? num(form.detraccion_monto) : detraccionAuto?.monto ?? 0;
  const textoPct = detraccionManual ? form.detraccion_pct : detraccionAuto ? String(detraccionAuto.pct) : "";
  const textoMonto = detraccionManual ? form.detraccion_monto : detraccionAuto && detraccionAuto.monto > 0 ? String(detraccionAuto.monto) : "";

  /** Tocar cualquiera de los dos campos congela AMBOS con su valor visible. */
  const editarDetraccion = useCallback(
    (campo: "pct" | "monto", valor: string) => {
      setForm((f) => ({
        ...f,
        detraccion_pct: campo === "pct" ? valor : textoPct,
        detraccion_monto: campo === "monto" ? valor : textoMonto,
      }));
      setDetraccionManual(true);
    },
    [textoPct, textoMonto]
  );

  const adelantos = redondear(num(form.adelanto_1) + num(form.adelanto_2));
  const aCancelar = redondear(desglose.total - adelantos - detraccionMonto);

  const proveedoresFiltrados = useMemo(() => {
    const t = form.proveedor_texto.trim().toLowerCase();
    if (!t) return proveedores.slice(0, 8);
    return proveedores
      .filter((p) => {
        const nombre = `${p.razon_social ?? ""} ${p.nombre ?? ""}`.toLowerCase();
        return nombre.includes(t) || String(p.ruc ?? "").includes(t);
      })
      .slice(0, 8);
  }, [proveedores, form.proveedor_texto]);

  const elegirProveedor = useCallback((p: ProveedorRef) => {
    const razon = p.razon_social || p.nombre || "";
    setForm((f) => ({
      ...f,
      proveedor_id: p.id,
      proveedor_texto: razon,
      // Solo se rellena lo que el usuario aún no escribió: editar no debe pisar datos.
      ruc: f.ruc || (p.ruc ?? ""),
      titular_cuenta: f.titular_cuenta || p.titular_cuenta || razon,
      banco_destino: f.banco_destino || (p.banco ?? ""),
      cuenta_destino: f.cuenta_destino || (p.cuenta_bancaria ?? ""),
      cci_destino: f.cci_destino || (p.cci ?? ""),
    }));
    setListaProv(false);
  }, []);

  const guardar = useCallback(async () => {
    setError(null);
    const razon = form.proveedor_texto.trim();
    if (!razon) return setError("Falta el proveedor o razón social.");
    if (!form.fecha_emision) return setError("Falta la fecha de emisión.");
    if (desglose.total <= 0) return setError("El importe del comprobante debe ser mayor que cero.");
    if (detraccionMonto > desglose.total) return setError("La detracción no puede superar el total del comprobante.");
    if (adelantos > desglose.total) return setError("Los adelantos no pueden superar el total del comprobante.");

    // `estado_detraccion` no se toca si ya estaba depositada: el depósito en el BN es
    // un hecho consumado, no una consecuencia de reeditar el importe.
    const detraccionYaPagada = documento?.estado_detraccion === "pagada";
    const estadoDetraccion = detraccionYaPagada ? "pagada" : detraccionMonto > 0 ? "pendiente" : "no_aplica";

    const payload: Record<string, unknown> = {
      proveedor_id: form.proveedor_id,
      ruc_emisor: form.ruc.trim() || null,
      razon_social: razon,
      titular_cuenta: form.titular_cuenta.trim() || razon,
      banco_destino: form.banco_destino.trim() || null,
      cuenta_destino: form.cuenta_destino.trim() || null,
      cci_destino: form.cci_destino.trim() || null,
      tipo_comprobante: form.tipo_comprobante,
      serie: form.serie.trim().toUpperCase() || null,
      numero: form.numero.trim() || null,
      fecha_emision: form.fecha_emision,
      fecha_vencimiento: form.fecha_vencimiento || null,
      moneda: form.moneda,
      subtotal: desglose.base,
      igv: desglose.igv,
      total: desglose.total,
      detraccion_pct: detraccionPct > 0 ? detraccionPct : null,
      detraccion_monto: detraccionMonto,
      detraccion_codigo: form.detraccion_codigo || null,
      estado_detraccion: estadoDetraccion,
      adelanto_1: num(form.adelanto_1),
      adelanto_2: num(form.adelanto_2),
      vehiculo_placa: form.vehiculo_placa.trim().toUpperCase() || null,
      codigo_servicio: form.codigo_servicio.trim() || null,
      detalle_servicio: form.detalle_servicio.trim() || null,
      turno: form.turno || null,
      fecha_servicio: form.fecha_servicio || null,
      categoria: form.categoria || null,
      observaciones: form.observaciones.trim() || null,
    };

    setGuardando(true);
    if (editando && documento) {
      const { error: e } = await supabase.from("documentos_compra").update(payload).eq("id", documento.id);
      setGuardando(false);
      if (e) return setError(e.message);
      onGuardado(`Factura ${form.serie ? `${form.serie}-${form.numero}` : razon} actualizada.`);
    } else {
      const { error: e } = await supabase
        .from("documentos_compra")
        .insert({ ...payload, origen: "manual", creado_por: usuarioNombre || null });
      setGuardando(false);
      if (e) {
        // El índice único fiscal (ruc + tipo + serie + número) es la defensa contra el
        // doble registro de la misma factura; se traduce a lenguaje humano.
        return setError(
          /uq_docs_compra_fiscal|duplicate key/i.test(e.message)
            ? "Ese comprobante ya está registrado para el mismo RUC (serie y número repetidos)."
            : e.message
        );
      }
      onGuardado(`Factura registrada por ${fmtMoneda(desglose.total, form.moneda)}.`);
    }
    onCerrar();
  }, [form, desglose, detraccionPct, detraccionMonto, adelantos, documento, editando, onCerrar, onGuardado, usuarioNombre]);

  if (!abierto) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCerrar}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b">
          <h3 className="font-bold text-gray-900">{editando ? "Editar factura de compra" : "Registrar factura de compra"}</h3>
          <p className="text-xs text-gray-400 mt-1">
            Alta manual del comprobante del proveedor. El IGV y la detracción se calculan con las tasas
            configuradas; puedes ajustarlas si el comprobante trae otra cosa impresa.
          </p>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3 text-sm text-red-800">
              <span>⚠️</span>
              {error}
            </div>
          )}

          {/* ── Proveedor ── */}
          <div className="space-y-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#0b315f]">Proveedor</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Proveedor / razón social" span={2}>
                <div className="relative">
                  <input
                    className={inputCls()}
                    value={form.proveedor_texto}
                    placeholder="Busca por nombre o RUC…"
                    onChange={(e) => {
                      setForm((f) => ({ ...f, proveedor_texto: e.target.value, proveedor_id: null }));
                      setListaProv(true);
                    }}
                    onFocus={() => setListaProv(true)}
                  />
                  {listaProv && proveedoresFiltrados.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full bg-white border rounded-xl shadow-lg max-h-56 overflow-y-auto">
                      {proveedoresFiltrados.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => elegirProveedor(p)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b last:border-b-0"
                          style={{ borderColor: "#f1f5f9" }}
                        >
                          <p className="text-sm font-medium text-gray-800">{p.razon_social || p.nombre}</p>
                          <p className="text-[10px] text-gray-400 font-mono">{p.ruc || "sin RUC"}</p>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 mt-1">
                    {form.proveedor_id
                      ? "Proveedor del padrón: los datos bancarios se rellenaron solos."
                      : "Si no está en el padrón, escribe la razón social tal cual figura en la factura."}
                  </p>
                </div>
              </Campo>
              <Campo label="RUC">
                <input className={inputCls("font-mono")} value={form.ruc} maxLength={11} onChange={(e) => set("ruc", e.target.value.replace(/\D/g, ""))} />
              </Campo>
              <Campo label="Titular de la cuenta">
                <input className={inputCls()} value={form.titular_cuenta} onChange={(e) => set("titular_cuenta", e.target.value)} />
              </Campo>
              <Campo label="Banco">
                <input className={inputCls()} value={form.banco_destino} onChange={(e) => set("banco_destino", e.target.value)} />
              </Campo>
              <Campo label="Número de cuenta">
                <input className={inputCls("font-mono")} value={form.cuenta_destino} onChange={(e) => set("cuenta_destino", e.target.value)} />
              </Campo>
              <Campo label="CCI">
                <input className={inputCls("font-mono")} value={form.cci_destino} maxLength={20} onChange={(e) => set("cci_destino", e.target.value.replace(/\D/g, ""))} />
              </Campo>
            </div>
          </div>

          {/* ── Comprobante ── */}
          <div className="space-y-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#0b315f]">Comprobante</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Tipo">
                <select className={inputCls()} value={form.tipo_comprobante} onChange={(e) => set("tipo_comprobante", e.target.value)}>
                  {TIPOS_COMPROBANTE.map((t) => (
                    <option key={t.v} value={t.v}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo label="Serie">
                <input className={inputCls("font-mono uppercase")} value={form.serie} placeholder="F001" onChange={(e) => set("serie", e.target.value)} />
              </Campo>
              <Campo label="Número">
                <input className={inputCls("font-mono")} value={form.numero} placeholder="0001234" onChange={(e) => set("numero", e.target.value)} />
              </Campo>
              <Campo label="Fecha de emisión">
                <input type="date" className={inputCls()} value={form.fecha_emision} onChange={(e) => set("fecha_emision", e.target.value)} />
              </Campo>
              <Campo label="Fecha de vencimiento">
                <input type="date" className={inputCls()} value={form.fecha_vencimiento} onChange={(e) => set("fecha_vencimiento", e.target.value)} />
              </Campo>
              <Campo label="Moneda">
                <select className={inputCls()} value={form.moneda} onChange={(e) => set("moneda", e.target.value)}>
                  <option value="PEN">Soles (PEN)</option>
                  <option value="USD">Dólares (USD)</option>
                </select>
              </Campo>
            </div>
          </div>

          {/* ── Importes ── */}
          <div className="space-y-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#0b315f]">Importes</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Importe del comprobante">
                <input
                  className={inputCls("font-bold")}
                  inputMode="decimal"
                  value={form.importe}
                  placeholder="0.00"
                  onChange={(e) => set("importe", e.target.value)}
                />
              </Campo>
              <Campo label="Cómo se ingresa">
                <select className={inputCls()} value={form.base} onChange={(e) => set("base", e.target.value === "neto" ? "neto" : "total")}>
                  <option value="total">Total (IGV incluido)</option>
                  <option value="neto">Neto (sin IGV)</option>
                </select>
              </Campo>
              <Campo label="Afecto a IGV">
                <label className="flex items-center gap-2 h-[42px] px-3 border border-gray-200 rounded-xl text-sm text-gray-600">
                  <input type="checkbox" checked={form.afecto_igv} onChange={(e) => set("afecto_igv", e.target.checked)} />
                  Aplicar IGV {igvPct}%
                </label>
                {igvPorDefecto && (
                  <p className="text-[10px] text-gray-400 mt-1">
                    No hay fila en config_tributaria: se está usando 18% por defecto.
                  </p>
                )}
              </Campo>
            </div>

            <div className="rounded-xl border p-3 grid grid-cols-2 md:grid-cols-4 gap-3" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
              {[
                { label: "Subtotal", valor: fmtMoneda(desglose.base, form.moneda) },
                { label: `IGV ${form.afecto_igv ? `${igvPct}%` : "—"}`, valor: fmtMoneda(desglose.igv, form.moneda) },
                { label: "Total", valor: fmtMoneda(desglose.total, form.moneda) },
                { label: "A cancelar", valor: fmtMoneda(aCancelar, form.moneda) },
              ].map((c) => (
                <div key={c.label}>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{c.label}</p>
                  <p className="text-sm font-black text-[#0b315f]">{c.valor}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Código de detracción">
                <select
                  className={inputCls()}
                  value={form.detraccion_codigo}
                  onChange={(e) => {
                    // Cambiar de código devuelve el control al cálculo automático.
                    setDetraccionManual(false);
                    set("detraccion_codigo", e.target.value);
                  }}
                >
                  <option value="">No aplica</option>
                  {catalogo.map((c) => (
                    <option key={c.codigo} value={c.codigo}>
                      {c.codigo} · {c.descripcion} ({Number(c.porcentaje)}%)
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-gray-400 mt-1">
                  Confirma con tu contador el código de servicio y la tasa vigente.
                </p>
              </Campo>
              <Campo label="Detracción %">
                <input className={inputCls()} inputMode="decimal" value={textoPct} onChange={(e) => editarDetraccion("pct", e.target.value)} />
              </Campo>
              <Campo label="Detracción monto">
                <input className={inputCls()} inputMode="decimal" value={textoMonto} onChange={(e) => editarDetraccion("monto", e.target.value)} />
              </Campo>
              <Campo label="Adelanto 1">
                <input className={inputCls()} inputMode="decimal" value={form.adelanto_1} onChange={(e) => set("adelanto_1", e.target.value)} />
              </Campo>
              <Campo label="Adelanto 2">
                <input className={inputCls()} inputMode="decimal" value={form.adelanto_2} onChange={(e) => set("adelanto_2", e.target.value)} />
              </Campo>
              <Campo label="Categoría">
                <select className={inputCls()} value={form.categoria} onChange={(e) => set("categoria", e.target.value)}>
                  {CATEGORIAS.map((c) => (
                    <option key={c.v} value={c.v}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Campo>
            </div>
          </div>

          {/* ── Eje operativo ── */}
          <div className="space-y-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#0b315f]">Servicio asociado</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Código de servicio">
                <input className={inputCls("font-mono uppercase")} value={form.codigo_servicio} placeholder="COD-OSLO-01" onChange={(e) => set("codigo_servicio", e.target.value)} />
              </Campo>
              <Campo label="Placa del vehículo">
                <input className={inputCls("font-mono uppercase")} value={form.vehiculo_placa} placeholder="ABC-123" onChange={(e) => set("vehiculo_placa", e.target.value)} />
              </Campo>
              <Campo label="Fecha de servicio">
                <input type="date" className={inputCls()} value={form.fecha_servicio} onChange={(e) => set("fecha_servicio", e.target.value)} />
              </Campo>
              <Campo label="Detalle del servicio" span={2}>
                <input className={inputCls()} value={form.detalle_servicio} placeholder="Ruta / turno tal como figura en el Sheet" onChange={(e) => set("detalle_servicio", e.target.value)} />
              </Campo>
              <Campo label="Turno">
                <select className={inputCls()} value={form.turno} onChange={(e) => set("turno", e.target.value)}>
                  {TURNOS.map((t) => (
                    <option key={t.v} value={t.v}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo label="Observaciones" span={3}>
                <textarea className={inputCls()} rows={2} value={form.observaciones} onChange={(e) => set("observaciones", e.target.value)} />
              </Campo>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <button className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50" onClick={onCerrar} disabled={guardando}>
            Cancelar
          </button>
          <button
            className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
            style={{ background: "#0b315f" }}
            onClick={guardar}
            disabled={guardando}
          >
            {guardando ? "Guardando…" : editando ? "Guardar cambios" : "Registrar factura"}
          </button>
        </div>
      </div>
    </div>
  );
}
