"use client";

// Fondos: la bolsa permanente asignada a cada responsable. El listado se arma sobre
// v_caja_chica_saldos (trae saldo_en_calle y rendiciones_vivas ya agregados) y se
// completa con las columnas de configuración que solo viven en la tabla.
//
// La caja chica NO es solo del conductor: también la reciben el gerente, el contador y
// el personal administrativo. Por eso lo PRIMERO que se elige es el TIPO de
// responsable, y recién entonces se carga la lista que corresponde (conductores ·
// personal administrativo · usuarios del ERP). Antes solo había selector de conductor
// y a la oficina había que teclearle el nombre a mano, sin quedar ligada a nadie.
//
// Un fondo NO se borra: se desactiva. Sus rendiciones históricas siguen contando en el
// costo de los servicios y borrarlo dejaría huecos en v_egresos.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { TIPOS_RESPONSABLE_CC, type FondoCajaChica } from "@/lib/finanzas/caja-chica";

type Props = { onCambio: () => void };

type TipoResponsable = FondoCajaChica["responsable_tipo"];

type FilaSaldo = {
  fondo_id: number;
  nombre: string;
  responsable_tipo: string;
  responsable_nombre: string;
  conductor_id: number | null;
  personal_administrativo_id: number | null;
  usuario_id: string | null;
  cargo: string | null;
  area: string | null;
  moneda: string;
  tope: number | null;
  activo: boolean;
  rendiciones_vivas: number | null;
  rendiciones_atrasadas: number | null;
  saldo_en_calle: number | null;
  ultima_entrega: string | null;
};

/** Una persona elegible, ya normalizada: de dónde salga es problema de `cargar`. */
type Persona = { id: string; nombre: string; documento: string | null; cargo: string | null; area: string | null };

// Las tres tablas de origen. Se declaran sueltas porque cada una llama distinto a lo
// mismo: el "área" es `departamento` en personal y no existe en conductores ni usuarios.
type FilaConductor = { id: number; nombre: string | null; dni: string | null };
type FilaAdministrativo = {
  id: number; nombre: string | null; dni: string | null;
  cargo: string | null; departamento: string | null; estado: string | null;
};
type FilaUsuario = { id: string; nombre: string | null; rol: string | null; activo: boolean | null };

type CuentaRef = { id: number; nombre: string; tipo: string; moneda: string };

const CABECERAS = [
  "Responsable",
  "Tipo",
  "Área",
  "DNI",
  "Tope",
  "Días para rendir",
  "Saldo en calle",
  "Rendiciones vivas",
  "Estado",
  "Acciones",
];

const TIPOS: TipoResponsable[] = ["conductor", "personal_administrativo", "usuario", "otro"];

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
  responsable_tipo: TipoResponsable;
  responsable_nombre: string;
  documento_identidad: string;
  /** id de la persona elegida en la lista del tipo actual (vacío para "otro"). */
  persona_id: string;
  cargo: string;
  centro_costo: string;
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
  persona_id: "",
  cargo: "",
  centro_costo: "",
  cuenta_tesoreria_id: "",
  moneda: "PEN",
  tope: "0",
  dias_para_rendir: "7",
  observaciones: "",
};

/** El plazo típico de rendición no es el mismo en la calle que en la oficina. */
const DIAS_SUGERIDOS: Record<TipoResponsable, string> = {
  conductor: "7",
  personal_administrativo: "15",
  usuario: "15",
  otro: "7",
};

export default function FondosTab({ onCambio }: Props) {
  const [saldos, setSaldos] = useState<FilaSaldo[]>([]);
  const [fondos, setFondos] = useState<FondoCajaChica[]>([]);
  const [personas, setPersonas] = useState<Record<TipoResponsable, Persona[]>>({
    conductor: [],
    personal_administrativo: [],
    usuario: [],
    otro: [],
  });
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
    // `personal_administrativo` puede no existir en una base sin ese módulo: la consulta
    // se aísla para que su fallo no vacíe también conductores y usuarios.
    const [s, f, c, pa, us, ct] = await Promise.all([
      supabase.from("v_caja_chica_saldos").select("*").order("responsable_nombre"),
      supabase.from("caja_chica_fondos").select("*"),
      supabase.from("conductores").select("id, nombre, dni").order("nombre"),
      supabase.from("personal_administrativo").select("id, nombre, dni, cargo, departamento, estado").order("nombre"),
      supabase.from("usuarios").select("id, nombre, rol, activo").order("nombre"),
      supabase.from("cuentas_tesoreria").select("id, nombre, tipo, moneda").eq("activo", true).order("nombre"),
    ]);

    setSaldos((s.data ?? []) as FilaSaldo[]);
    setFondos((f.data ?? []) as FondoCajaChica[]);
    setCuentas((ct.data ?? []) as CuentaRef[]);
    setPersonas({
      conductor: ((c.data ?? []) as FilaConductor[]).map((x) => ({
        id: String(x.id),
        nombre: String(x.nombre ?? ""),
        documento: x.dni ?? null,
        cargo: "Conductor",
        area: "Operaciones",
      })),
      personal_administrativo: ((pa.data ?? []) as FilaAdministrativo[])
        .filter((x) => (x.estado ?? "activo") === "activo")
        .map((x) => ({
          id: String(x.id),
          nombre: String(x.nombre ?? ""),
          documento: x.dni ?? null,
          cargo: x.cargo ?? null,
          area: x.departamento ?? null,
        })),
      usuario: ((us.data ?? []) as FilaUsuario[])
        .filter((x) => x.activo !== false)
        .map((x) => ({
          id: String(x.id),
          nombre: String(x.nombre ?? ""),
          documento: null,
          cargo: x.rol ?? null,
          area: null,
        })),
      otro: [],
    });
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

  const lista = personas[form.responsable_tipo] ?? [];
  const necesitaLista = form.responsable_tipo !== "otro";

  function abrirNuevo() {
    setEditandoId(null);
    setForm(FORM_VACIO);
    setError("");
    setMostrarForm(true);
  }

  function abrirEdicion(id: number) {
    const f = detalle[id];
    if (!f) return;
    const tipo = (f.responsable_tipo ?? "conductor") as TipoResponsable;
    setEditandoId(id);
    setForm({
      nombre: f.nombre ?? "",
      responsable_tipo: tipo,
      responsable_nombre: f.responsable_nombre ?? "",
      documento_identidad: f.documento_identidad ?? "",
      persona_id: idDePersona(f, tipo),
      cargo: f.cargo ?? "",
      centro_costo: f.centro_costo ?? "",
      cuenta_tesoreria_id: f.cuenta_tesoreria_id ? String(f.cuenta_tesoreria_id) : "",
      moneda: f.moneda ?? "PEN",
      tope: String(Number(f.tope ?? 0)),
      dias_para_rendir: String(Number(f.dias_para_rendir ?? 7)),
      observaciones: f.observaciones ?? "",
    });
    setError("");
    setMostrarForm(true);
  }

  /** Cambiar de tipo limpia a la persona elegida: un id de conductor no vale para un administrativo. */
  function elegirTipo(tipo: TipoResponsable) {
    setForm((f) => ({
      ...f,
      responsable_tipo: tipo,
      persona_id: "",
      // Solo se borran los datos que venían AUTOCOMPLETADOS de la persona anterior.
      // Si el usuario los tecleó a mano (tipo "otro"), se respetan.
      responsable_nombre: f.persona_id ? "" : f.responsable_nombre,
      documento_identidad: f.persona_id ? "" : f.documento_identidad,
      cargo: f.persona_id ? "" : f.cargo,
      centro_costo: f.persona_id ? "" : f.centro_costo,
      dias_para_rendir: DIAS_SUGERIDOS[tipo],
    }));
    setError("");
  }

  /** Elegir a la persona copia su nombre, DNI, cargo y área al formulario. */
  function elegirPersona(id: string) {
    const p = (personas[form.responsable_tipo] ?? []).find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      persona_id: id,
      responsable_nombre: p ? p.nombre : f.responsable_nombre,
      documento_identidad: p?.documento ?? f.documento_identidad,
      cargo: p?.cargo ?? f.cargo,
      centro_costo: p?.area ?? f.centro_costo,
      nombre: p && !f.nombre.trim() ? `Caja chica · ${p.nombre}` : f.nombre,
    }));
  }

  async function guardar() {
    setError("");
    if (!form.responsable_nombre.trim()) {
      setError("Indica el nombre del responsable.");
      return;
    }
    if (necesitaLista && !form.persona_id) {
      setError(`Elige a la persona de la lista de ${TIPOS_RESPONSABLE_CC[form.responsable_tipo].label.toLowerCase()}.`);
      return;
    }
    const dias = Number(form.dias_para_rendir);
    if (!(dias > 0)) {
      setError("Los días para rendir deben ser mayores a 0.");
      return;
    }

    const tipo = form.responsable_tipo;
    const fila: Record<string, unknown> = {
      nombre: form.nombre.trim() || `Caja chica · ${form.responsable_nombre.trim()}`,
      responsable_tipo: tipo,
      responsable_nombre: form.responsable_nombre.trim(),
      documento_identidad: form.documento_identidad.trim() || null,
      // El CHECK cc_fondos_responsable_coherente exige que solo venga el id que calza
      // con el tipo: mandarlos todos guardaría un fondo que la bandeja no sabría leer.
      conductor_id: tipo === "conductor" && form.persona_id ? Number(form.persona_id) : null,
      personal_administrativo_id:
        tipo === "personal_administrativo" && form.persona_id ? Number(form.persona_id) : null,
      usuario_id: tipo === "usuario" && form.persona_id ? form.persona_id : null,
      cargo: form.cargo.trim() || null,
      centro_costo: form.centro_costo.trim() || null,
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
      setError(mensajeDeError(res.error.message));
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
      showToast(mensajeDeError(String(err.message ?? "")), false);
      return;
    }
    showToast(fila.activo ? "Fondo desactivado" : "Fondo activado");
    await cargar();
    onCambio();
  }

  const totalEnCalle = useMemo(() => saldos.reduce((s, f) => s + Number(f.saldo_en_calle ?? 0), 0), [saldos]);

  // Cuánto hay en la calle por área: el corte que la oficina no tenía y que ahora
  // v_caja_chica_saldos publica ya derivado.
  const porArea = useMemo(() => {
    const mapa: Record<string, number> = {};
    for (const f of saldos) {
      const k = f.area || "Sin asignar";
      mapa[k] = (mapa[k] ?? 0) + Number(f.saldo_en_calle ?? 0);
    }
    return Object.entries(mapa)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
  }, [saldos]);

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Fondos</h1>
          <p className="text-gray-400 text-sm mt-1">
            Conductores, gerencia y administración · Tope de dinero en la calle · Plazo para rendir
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

      {porArea.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {porArea.map(([area, monto]) => (
            <span key={area} className="text-xs font-bold px-3 py-1.5 rounded-xl border" style={{ background: "#f8fafc", borderColor: "#e2e8f0", color: "#0b315f" }}>
              {area}: {fmtMoneda(monto)}
            </span>
          ))}
        </div>
      )}

      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>
              💰
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar fondo" : "Nuevo fondo de caja chica"}</h2>
              <p className="text-xs text-gray-400">
                Elige primero de qué tipo es el responsable; la lista y el plazo se ajustan solos
              </p>
            </div>
          </div>

          {/* Paso 1 — el tipo manda: define qué lista se ofrece y a qué tabla se liga. */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">
              ¿Quién recibe la caja chica?
            </label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {TIPOS.map((t) => {
                const cfg = TIPOS_RESPONSABLE_CC[t];
                const activo = form.responsable_tipo === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => elegirTipo(t)}
                    className="text-left px-3 py-2.5 rounded-xl border transition-all"
                    style={
                      activo
                        ? { borderColor: "#0b315f", background: "#eef3f8", boxShadow: "0 0 0 1px #0b315f inset" }
                        : { borderColor: "#e2e8f0", background: "#fff" }
                    }
                  >
                    <span className="text-sm font-bold text-gray-900">
                      {cfg.emoji} {cfg.label}
                    </span>
                    <span className="block text-[11px] text-gray-400 mt-0.5 leading-snug">{cfg.ayuda}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Paso 2 — la persona. Para "otro" no hay lista: el nombre se teclea. */}
            {necesitaLista ? (
              <Campo label={TIPOS_RESPONSABLE_CC[form.responsable_tipo].label}>
                <select className={inputCls()} value={form.persona_id} onChange={(e) => elegirPersona(e.target.value)}>
                  <option value="">— Elige a la persona —</option>
                  {lista.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                      {p.cargo ? ` · ${p.cargo}` : ""}
                    </option>
                  ))}
                </select>
                {lista.length === 0 && (
                  <p className="text-[11px] text-amber-700 mt-1">
                    No hay nadie activo en esa lista todavía.
                  </p>
                )}
              </Campo>
            ) : (
              <Campo label="Nombre del responsable">
                <input
                  className={inputCls()}
                  value={form.responsable_nombre}
                  onChange={(e) => setForm({ ...form, responsable_nombre: e.target.value })}
                  placeholder="Practicante, personal temporal…"
                />
              </Campo>
            )}

            {necesitaLista && (
              <Campo label="Nombre del responsable">
                <input
                  className={inputCls()}
                  value={form.responsable_nombre}
                  onChange={(e) => setForm({ ...form, responsable_nombre: e.target.value })}
                  placeholder="Se completa al elegir a la persona"
                />
              </Campo>
            )}

            <Campo label="DNI">
              <input
                className={inputCls()}
                value={form.documento_identidad}
                onChange={(e) => setForm({ ...form, documento_identidad: e.target.value })}
                placeholder="12345678"
              />
            </Campo>

            <Campo label="Cargo">
              <input
                className={inputCls()}
                value={form.cargo}
                onChange={(e) => setForm({ ...form, cargo: e.target.value })}
                placeholder="Gerente General"
              />
            </Campo>
            <Campo label="Centro de costo / área">
              <input
                className={inputCls()}
                value={form.centro_costo}
                onChange={(e) => setForm({ ...form, centro_costo: e.target.value })}
                placeholder="Gerencia, Contabilidad, Operaciones…"
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

            <Campo label="Observaciones" span={2}>
              <textarea
                rows={2}
                className={inputCls()}
                value={form.observaciones}
                onChange={(e) => setForm({ ...form, observaciones: e.target.value })}
                placeholder="Notas internas sobre el fondo"
              />
            </Campo>
          </div>

          {form.responsable_tipo === "personal_administrativo" && form.persona_id && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 flex items-start gap-3 text-sm text-blue-900">
              <span className="text-lg leading-none">ℹ️</span>
              <span>
                El área de esta persona la manda su ficha en <span className="font-bold">Personal administrativo</span>.
                Si cambia de departamento allí, los reportes de caja chica la siguen sin tocar nada aquí.
              </span>
            </div>
          )}

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
                  const cfgTipo = TIPOS_RESPONSABLE_CC[f.responsable_tipo as TipoResponsable];
                  return (
                    <tr key={f.fondo_id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 text-xs text-gray-600 font-medium">
                        {f.responsable_nombre}
                        <span className="block text-[10px] text-gray-400">{f.cargo || f.nombre}</span>
                      </td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">
                        {cfgTipo ? `${cfgTipo.emoji} ${cfgTipo.label}` : f.responsable_tipo}
                      </td>
                      <td className="p-3 text-xs text-gray-600 font-medium">{f.area || "—"}</td>
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

/** Recupera, al editar, cuál de los tres ids es el que corresponde al tipo del fondo. */
function idDePersona(f: FondoCajaChica, tipo: TipoResponsable): string {
  if (tipo === "conductor") return f.conductor_id ? String(f.conductor_id) : "";
  if (tipo === "personal_administrativo") return f.personal_administrativo_id ? String(f.personal_administrativo_id) : "";
  if (tipo === "usuario") return f.usuario_id ? String(f.usuario_id) : "";
  return "";
}

/**
 * Traduce a castellano los errores de las guardas de finanzas-08. Un mensaje crudo de
 * Postgres con el nombre del índice no le dice nada a quien está creando el fondo.
 */
function mensajeDeError(msg: string): string {
  if (/uq_cc_fondo_administrativo|uq_cc_fondo_conductor/.test(msg)) {
    return "Esa persona ya tiene un fondo de caja chica activo. Usa el que ya existe o desactívalo primero.";
  }
  if (/cc_fondos_responsable_coherente/.test(msg)) {
    return "El tipo de responsable no calza con la persona elegida. Vuelve a elegirla tras cambiar el tipo.";
  }
  if (/responsable_tipo_check/.test(msg)) {
    return "Tipo de responsable no válido. ¿Falta correr la migración finanzas-08 en Supabase?";
  }
  if (/column .*(personal_administrativo_id|centro_costo|cargo)/.test(msg)) {
    return "Falta correr finanzas-08-caja-chica-todo-el-personal.sql en Supabase para habilitar los fondos de oficina.";
  }
  return msg || "No se pudo guardar el fondo.";
}
