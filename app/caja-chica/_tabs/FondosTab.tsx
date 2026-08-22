"use client";

// Fondos: la bolsa permanente asignada a cada responsable. El listado se arma sobre
// v_caja_chica_saldos (trae saldo_en_calle y rendiciones_vivas ya agregados) y se
// completa con las columnas de configuración que solo viven en la tabla.
//
// Un fondo NO se borra: se desactiva. Sus rendiciones históricas siguen contando en el
// costo de los servicios y borrarlo dejaría huecos en v_egresos.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import type { FondoCajaChica } from "@/lib/finanzas/caja-chica";

type Props = { onCambio: () => void };

type FilaSaldo = {
  fondo_id: number;
  nombre: string;
  responsable_tipo: string;
  responsable_nombre: string;
  conductor_id: number | null;
  moneda: string;
  tope: number | null;
  activo: boolean;
  rendiciones_vivas: number | null;
  rendiciones_atrasadas: number | null;
  saldo_en_calle: number | null;
  ultima_entrega: string | null;
};

type ConductorRef = { id: number; nombre: string };
type CuentaRef = { id: number; nombre: string; tipo: string; moneda: string };

const CABECERAS = [
  "Responsable",
  "Tipo",
  "DNI",
  "Tope",
  "Días para rendir",
  "Saldo en calle",
  "Rendiciones vivas",
  "Estado",
  "Acciones",
];

const TIPOS_RESPONSABLE: { valor: FondoCajaChica["responsable_tipo"]; label: string }[] = [
  { valor: "conductor", label: "Conductor" },
  { valor: "usuario", label: "Usuario del ERP" },
  { valor: "otro", label: "Otro" },
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

type FormFondo = {
  nombre: string;
  responsable_tipo: FondoCajaChica["responsable_tipo"];
  responsable_nombre: string;
  documento_identidad: string;
  conductor_id: string;
  cuenta_tesoreria_id: string;
  moneda: string;
  tope: string;
  dias_para_rendir: string;
  observaciones: string;
};

const FORM_VACIO: FormFondo = {
  nombre: "",
  responsable_tipo: "conductor",
  responsable_nombre: "",
  documento_identidad: "",
  conductor_id: "",
  cuenta_tesoreria_id: "",
  moneda: "PEN",
  tope: "0",
  dias_para_rendir: "7",
  observaciones: "",
};

export default function FondosTab({ onCambio }: Props) {
  const [saldos, setSaldos] = useState<FilaSaldo[]>([]);
  const [fondos, setFondos] = useState<FondoCajaChica[]>([]);
  const [conductores, setConductores] = useState<ConductorRef[]>([]);
  const [cuentas, setCuentas] = useState<CuentaRef[]>([]);
  const [loading, setLoading] = useState(true);

  const [mostrarForm, setMostrarForm] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [form, setForm] = useState<FormFondo>(FORM_VACIO);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    const [s, f, c, ct] = await Promise.all([
      supabase.from("v_caja_chica_saldos").select("*").order("responsable_nombre"),
      supabase.from("caja_chica_fondos").select("*"),
      supabase.from("conductores").select("id, nombre").order("nombre"),
      supabase.from("cuentas_tesoreria").select("id, nombre, tipo, moneda").eq("activo", true).order("nombre"),
    ]);
    setSaldos((s.data ?? []) as FilaSaldo[]);
    setFondos((f.data ?? []) as FondoCajaChica[]);
    setConductores((c.data ?? []) as ConductorRef[]);
    setCuentas((ct.data ?? []) as CuentaRef[]);
    setLoading(false);
  }, []);

  // Carga inicial (patrón de todo el ERP). La regla del linter apunta a otro caso
  // —setState síncrono en el cuerpo del efecto—; aquí se escribe tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  // La vista de saldos no trae la configuración del fondo (DNI, días, cuenta): se
  // completa desde la tabla en vez de duplicar columnas en la vista.
  const detalle = useMemo(() => {
    const mapa: Record<number, FondoCajaChica> = {};
    for (const f of fondos) mapa[f.id] = f;
    return mapa;
  }, [fondos]);

  function abrirNuevo() {
    setEditandoId(null);
    setForm(FORM_VACIO);
    setError("");
    setMostrarForm(true);
  }

  function abrirEdicion(id: number) {
    const f = detalle[id];
    if (!f) return;
    setEditandoId(id);
    setForm({
      nombre: f.nombre ?? "",
      responsable_tipo: f.responsable_tipo ?? "conductor",
      responsable_nombre: f.responsable_nombre ?? "",
      documento_identidad: f.documento_identidad ?? "",
      conductor_id: f.conductor_id ? String(f.conductor_id) : "",
      cuenta_tesoreria_id: f.cuenta_tesoreria_id ? String(f.cuenta_tesoreria_id) : "",
      moneda: f.moneda ?? "PEN",
      tope: String(Number(f.tope ?? 0)),
      dias_para_rendir: String(Number(f.dias_para_rendir ?? 7)),
      observaciones: f.observaciones ?? "",
    });
    setError("");
    setMostrarForm(true);
  }

  function elegirConductor(id: string) {
    const c = conductores.find((x) => String(x.id) === id);
    setForm((f) => ({
      ...f,
      conductor_id: id,
      // Elegir un conductor fija el tipo y copia el nombre: la vista muestra esa copia
      // legible, así que dejarla desincronizada rompería el listado.
      responsable_tipo: id ? "conductor" : f.responsable_tipo,
      responsable_nombre: c ? c.nombre : f.responsable_nombre,
      nombre: c && !f.nombre.trim() ? `Caja chica · ${c.nombre}` : f.nombre,
    }));
  }

  async function guardar() {
    setError("");
    if (!form.responsable_nombre.trim()) {
      setError("Indica el nombre del responsable.");
      return;
    }
    const dias = Number(form.dias_para_rendir);
    if (!(dias > 0)) {
      setError("Los días para rendir deben ser mayores a 0.");
      return;
    }

    const fila = {
      nombre: form.nombre.trim() || `Caja chica · ${form.responsable_nombre.trim()}`,
      responsable_tipo: form.responsable_tipo,
      responsable_nombre: form.responsable_nombre.trim(),
      documento_identidad: form.documento_identidad.trim() || null,
      conductor_id: form.responsable_tipo === "conductor" && form.conductor_id ? Number(form.conductor_id) : null,
      cuenta_tesoreria_id: form.cuenta_tesoreria_id ? Number(form.cuenta_tesoreria_id) : null,
      moneda: form.moneda,
      tope: Number(form.tope) || 0,
      dias_para_rendir: dias,
      observaciones: form.observaciones.trim() || null,
    };

    setGuardando(true);
    const res = editandoId
      ? await supabase.from("caja_chica_fondos").update(fila).eq("id", editandoId)
      : await supabase.from("caja_chica_fondos").insert(fila);
    setGuardando(false);

    if (res.error) {
      setError(String(res.error.message ?? "No se pudo guardar el fondo."));
      return;
    }
    setMostrarForm(false);
    setEditandoId(null);
    setForm(FORM_VACIO);
    showToast(editandoId ? "Fondo actualizado" : "Fondo creado");
    await cargar();
    onCambio();
  }

  async function alternarActivo(fila: FilaSaldo) {
    // Desactivar con dinero en la calle deja el saldo huérfano: se avisa antes.
    if (fila.activo && Number(fila.rendiciones_vivas ?? 0) > 0) {
      showToast("No se puede desactivar: tiene rendiciones vivas sin liquidar.", false);
      return;
    }
    const { error: err } = await supabase.from("caja_chica_fondos").update({ activo: !fila.activo }).eq("id", fila.fondo_id);
    if (err) {
      showToast(String(err.message ?? "No se pudo cambiar el estado."), false);
      return;
    }
    showToast(fila.activo ? "Fondo desactivado" : "Fondo activado");
    await cargar();
    onCambio();
  }

  const totalEnCalle = useMemo(() => saldos.reduce((s, f) => s + Number(f.saldo_en_calle ?? 0), 0), [saldos]);

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Fondos</h1>
          <p className="text-gray-400 text-sm mt-1">
            Un fondo por responsable · Tope de dinero en la calle · Plazo para rendir
          </p>
        </div>
        <button
          onClick={() => (mostrarForm ? setMostrarForm(false) : abrirNuevo())}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: "#0b315f" }}
        >
          {mostrarForm ? "Cerrar" : "+ Nuevo fondo"}
        </button>
      </div>

      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>
              💰
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar fondo" : "Nuevo fondo de caja chica"}</h2>
              <p className="text-xs text-gray-400">
                Al elegir un conductor se completan solos el nombre del responsable y el tipo
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Campo label="Conductor">
              <select className={inputCls()} value={form.conductor_id} onChange={(e) => elegirConductor(e.target.value)}>
                <option value="">— Sin conductor —</option>
                {conductores.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Tipo de responsable">
              <select
                className={inputCls()}
                value={form.responsable_tipo}
                onChange={(e) =>
                  setForm({ ...form, responsable_tipo: e.target.value as FondoCajaChica["responsable_tipo"] })
                }
              >
                {TIPOS_RESPONSABLE.map((t) => (
                  <option key={t.valor} value={t.valor}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Nombre del responsable">
              <input
                className={inputCls()}
                value={form.responsable_nombre}
                onChange={(e) => setForm({ ...form, responsable_nombre: e.target.value })}
                placeholder="Juan Pérez"
              />
            </Campo>

            <Campo label="Nombre del fondo">
              <input
                className={inputCls()}
                value={form.nombre}
                onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                placeholder="Caja chica · Juan Pérez"
              />
            </Campo>
            <Campo label="DNI">
              <input
                className={inputCls()}
                value={form.documento_identidad}
                onChange={(e) => setForm({ ...form, documento_identidad: e.target.value })}
                placeholder="12345678"
              />
            </Campo>
            <Campo label="Cuenta de tesorería">
              <select
                className={inputCls()}
                value={form.cuenta_tesoreria_id}
                onChange={(e) => setForm({ ...form, cuenta_tesoreria_id: e.target.value })}
              >
                <option value="">— Sin cuenta —</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre} · {c.tipo} · {c.moneda}
                  </option>
                ))}
              </select>
            </Campo>

            <Campo label="Moneda">
              <select className={inputCls()} value={form.moneda} onChange={(e) => setForm({ ...form, moneda: e.target.value })}>
                <option value="PEN">Soles (PEN)</option>
                <option value="USD">Dólares (USD)</option>
              </select>
            </Campo>
            <Campo label="Tope en la calle (0 = sin tope)">
              <input
                type="number"
                min="0"
                step="0.01"
                className={inputCls()}
                value={form.tope}
                onChange={(e) => setForm({ ...form, tope: e.target.value })}
              />
            </Campo>
            <Campo label="Días para rendir">
              <input
                type="number"
                min="1"
                step="1"
                className={inputCls()}
                value={form.dias_para_rendir}
                onChange={(e) => setForm({ ...form, dias_para_rendir: e.target.value })}
              />
            </Campo>

            <Campo label="Observaciones" span={3}>
              <textarea
                rows={2}
                className={inputCls()}
                value={form.observaciones}
                onChange={(e) => setForm({ ...form, observaciones: e.target.value })}
                placeholder="Notas internas sobre el fondo"
              />
            </Campo>
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3 text-sm text-red-800">
              <span className="text-lg leading-none">⚠️</span>
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              onClick={() => {
                setMostrarForm(false);
                setEditandoId(null);
              }}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50"
            >
              Cancelar
            </button>
            <button
              onClick={guardar}
              disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}
            >
              {guardando ? "Guardando…" : editandoId ? "Guardar cambios" : "Crear fondo"}
            </button>
          </div>
        </section>
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

              {!loading && saldos.length === 0 && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">💰</p>
                    <p>No hay fondos de caja chica</p>
                  </td>
                </tr>
              )}

              {!loading &&
                saldos.map((f) => {
                  const cfgFondo = detalle[f.fondo_id];
                  const vivas = Number(f.rendiciones_vivas ?? 0);
                  const atrasadas = Number(f.rendiciones_atrasadas ?? 0);
                  const tipo = TIPOS_RESPONSABLE.find((t) => t.valor === f.responsable_tipo)?.label ?? f.responsable_tipo;
                  return (
                    <tr key={f.fondo_id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 text-xs text-gray-600 font-medium">
                        {f.responsable_nombre}
                        <span className="block text-[10px] text-gray-400">{f.nombre}</span>
                      </td>
                      <td className="p-3 text-xs text-gray-600 font-medium">{tipo}</td>
                      <td className="p-3 font-mono font-black text-xs text-[#0b315f]">{cfgFondo?.documento_identidad || "—"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium">
                        {Number(f.tope ?? 0) > 0 ? fmtMoneda(Number(f.tope), f.moneda) : "Sin tope"}
                      </td>
                      <td className="p-3 text-xs text-gray-600 font-medium">{Number(cfgFondo?.dias_para_rendir ?? 7)} días</td>
                      <td className="p-3 font-black text-xs text-red-700">{fmtMoneda(Number(f.saldo_en_calle ?? 0), f.moneda)}</td>
                      <td className="p-3">
                        <span className="text-xs text-gray-600 font-medium">{vivas}</span>
                        {atrasadas > 0 && (
                          <span
                            className="ml-2 text-xs font-bold px-2.5 py-1 rounded-lg"
                            style={{ background: "#fee2e2", color: "#991b1b" }}
                          >
                            {atrasadas} atrasada{atrasadas === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        <span
                          className="text-xs font-bold px-2.5 py-1 rounded-lg"
                          style={f.activo ? { background: "#dcfce7", color: "#166534" } : { background: "#f3f4f6", color: "#4b5563" }}
                        >
                          {f.activo ? "Activo" : "Inactivo"}
                        </span>
                      </td>
                      <td className="p-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => abrirEdicion(f.fondo_id)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                          >
                            Editar
                          </button>
                          {f.activo ? (
                            <button
                              onClick={() => alternarActivo(f)}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50"
                            >
                              Desactivar
                            </button>
                          ) : (
                            <button
                              onClick={() => alternarActivo(f)}
                              className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700"
                            >
                              Activar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>{saldos.length} fondo{saldos.length === 1 ? "" : "s"}</span>
          <span>Total en la calle: {fmtMoneda(totalEnCalle)}</span>
        </div>
      </section>

      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white ${
            toast.ok ? "bg-[#0b315f]" : "bg-red-600"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </main>
  );
}
