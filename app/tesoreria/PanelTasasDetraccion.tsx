"use client";

// ──────────────────────────────────────────────────────────────────────────────
// Panel "Tasas y códigos de detracción" — el catálogo SUNAT, editable.
//
// Por qué existe: los porcentajes del SPOT cambian por Resolución de Superintendencia
// y no todos los servicios llevan la misma tasa (4 %, 10 %, 12 %, 15 %, 1.5 %). Dejarlos
// escritos en el código obligaría a un despliegue cada vez que SUNAT los mueve, así que
// viven en `cat_detraccion` y se editan desde aquí.
//
// Lo que se guarda aquí gobierna el cálculo de TODO el ERP: el modal de cuentas por
// pagar propone el % y el umbral leyendo esta tabla (ver lib/finanzas/dinero.ts →
// calcularDetraccion, que recibe la configuración y nunca fija una tasa por su cuenta).
//
// Editar tasas es decisión de gerencia, no de operaciones: solo admin/gerente pueden
// guardar. El resto lo ve en modo lectura, que igual sirve para consultar el código.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

export type CodigoDetraccion = {
  codigo: string;
  descripcion: string;
  porcentaje: number;
  umbral_min: number;
  activo: boolean;
  anexo: string | null;
  base_legal: string | null;
  notas: string | null;
  updated_at: string | null;
};

type ConfigTributaria = {
  igv_pct: number;
  detraccion_activa: boolean;
  detraccion_codigo_defecto: string | null;
};

/** Orden de presentación: primero lo que AFA usa a diario, después el resto. */
const ORDEN_ANEXO = ["Anexo 3", "Régimen propio", "Anexo 2", "Anexo 1"];

const COLOR_ANEXO: Record<string, { color: string; bg: string }> = {
  "Anexo 3": { color: "#0b315f", bg: "#eef3f8" },
  "Régimen propio": { color: "#6d28d9", bg: "#ede9fe" },
  "Anexo 2": { color: "#0f766e", bg: "#f0fdfa" },
  "Anexo 1": { color: "#4b5563", bg: "#f3f4f6" },
};

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

/** Acepta coma decimal: en el teclado del celular es lo que sale. */
function num(v: string): number {
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

/** Copia el mapa de borradores sin una clave (descartar los cambios de una fila). */
function quitar<T>(mapa: Record<string, T>, clave: string): Record<string, T> {
  const copia = { ...mapa };
  delete copia[clave];
  return copia;
}

function fmtFecha(f: string | null): string {
  if (!f) return "—";
  const d = new Date(f);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

type Props = {
  /** Solo admin/gerente pueden guardar; el resto ve el catálogo en lectura. */
  puedeEditar: boolean;
  /** Avisa a la pestaña para que recargue lo que dependa de las tasas. */
  onCambio?: () => void;
};

export default function PanelTasasDetraccion({ puedeEditar, onCambio }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ msg: string; ok: boolean } | null>(null);

  const [codigos, setCodigos] = useState<CodigoDetraccion[]>([]);
  const [config, setConfig] = useState<ConfigTributaria | null>(null);
  const [borrador, setBorrador] = useState<Record<string, Partial<CodigoDetraccion>>>({});
  const [borradorConfig, setBorradorConfig] = useState<Partial<ConfigTributaria>>({});
  const [soloActivos, setSoloActivos] = useState(true);
  const [nuevo, setNuevo] = useState<{ codigo: string; descripcion: string; porcentaje: string; umbral_min: string } | null>(null);

  const mostrar = useCallback((msg: string, ok = true) => {
    setAviso({ msg, ok });
    setTimeout(() => setAviso(null), 4000);
  }, []);

  const cargar = useCallback(async () => {
    const [cat, cfg] = await Promise.all([
      supabase
        .from("cat_detraccion")
        .select("codigo, descripcion, porcentaje, umbral_min, activo, anexo, base_legal, notas, updated_at")
        .order("codigo"),
      supabase
        .from("config_tributaria")
        .select("igv_pct, detraccion_activa, detraccion_codigo_defecto")
        .eq("id", 1)
        .maybeSingle(),
    ]);
    setCodigos((cat.data as CodigoDetraccion[]) ?? []);
    setConfig((cfg.data as ConfigTributaria) ?? null);
    setBorrador({});
    setBorradorConfig({});
    setCargando(false);
  }, []);

  // El catálogo se trae al ABRIR el panel, no al montar la pestaña: la mayoría de las
  // veces nadie lo despliega. `cargando` arranca en true y solo se apaga tras el await,
  // así el efecto no escribe estado de forma síncrona.
  useEffect(() => {
    // La regla apunta al setState SÍNCRONO en el cuerpo del efecto. `cargar` es async y
    // su primera instrucción es el await de las consultas, así que todo lo que escribe
    // estado ocurre después. Mismo criterio que DetraccionesTab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (abierto && cargando) void cargar();
  }, [abierto, cargando, cargar]);

  /** Valor a mostrar: lo tecleado si hay borrador, si no lo guardado. */
  function valor<K extends keyof CodigoDetraccion>(c: CodigoDetraccion, campo: K): CodigoDetraccion[K] {
    const b = borrador[c.codigo];
    return (b && campo in b ? (b[campo] as CodigoDetraccion[K]) : c[campo]);
  }

  function editar(codigo: string, campo: keyof CodigoDetraccion, v: unknown) {
    setBorrador((prev) => ({ ...prev, [codigo]: { ...prev[codigo], [campo]: v } }));
  }

  const sucio = (codigo: string) => Object.keys(borrador[codigo] ?? {}).length > 0;

  async function guardarFila(c: CodigoDetraccion) {
    const cambios = borrador[c.codigo];
    if (!cambios) return;

    const pct = cambios.porcentaje ?? c.porcentaje;
    const umbral = cambios.umbral_min ?? c.umbral_min;
    // Una tasa negativa o mayor a 100 es siempre un error de tecleo, y aquí se está
    // configurando cuánto dinero se le retiene a un proveedor.
    if (pct < 0 || pct > 100) return mostrar("El porcentaje debe estar entre 0 y 100.", false);
    if (umbral < 0) return mostrar("El umbral no puede ser negativo.", false);

    setGuardando(c.codigo);
    const { error } = await supabase.from("cat_detraccion").update(cambios).eq("codigo", c.codigo);
    setGuardando(null);
    if (error) return mostrar(error.message, false);

    setCodigos((prev) => prev.map((x) => (x.codigo === c.codigo ? { ...x, ...cambios, updated_at: new Date().toISOString() } : x)));
    setBorrador((prev) => quitar(prev, c.codigo));
    mostrar(`Código ${c.codigo} actualizado.`);
    onCambio?.();
  }

  async function guardarConfig() {
    if (!Object.keys(borradorConfig).length) return;
    const igv = borradorConfig.igv_pct ?? config?.igv_pct ?? 18;
    if (igv < 0 || igv > 100) return mostrar("El IGV debe estar entre 0 y 100.", false);

    setGuardando("__config__");
    const { error } = await supabase.from("config_tributaria").update(borradorConfig).eq("id", 1);
    setGuardando(null);
    if (error) return mostrar(error.message, false);

    setConfig((prev) => (prev ? { ...prev, ...borradorConfig } : prev));
    setBorradorConfig({});
    mostrar("Configuración tributaria actualizada.");
    onCambio?.();
  }

  async function agregarCodigo() {
    if (!nuevo) return;
    const codigo = nuevo.codigo.trim();
    if (!/^\d{3}$/.test(codigo)) return mostrar("El código de SUNAT tiene tres dígitos (por ejemplo 026).", false);
    if (codigos.some((c) => c.codigo === codigo)) return mostrar(`El código ${codigo} ya está en el catálogo.`, false);
    if (!nuevo.descripcion.trim()) return mostrar("Ponle una descripción al código.", false);

    setGuardando("__nuevo__");
    const { error } = await supabase.from("cat_detraccion").insert({
      codigo,
      descripcion: nuevo.descripcion.trim(),
      porcentaje: num(nuevo.porcentaje),
      umbral_min: num(nuevo.umbral_min),
      activo: true,
      anexo: "Anexo 3",
      base_legal: "R.S. 183-2004/SUNAT",
    });
    setGuardando(null);
    if (error) return mostrar(error.message, false);

    setNuevo(null);
    await cargar();
    mostrar(`Código ${codigo} agregado.`);
    onCambio?.();
  }

  const grupos = useMemo(() => {
    const enEdicion = (codigo: string) => Object.keys(borrador[codigo] ?? {}).length > 0;
    const visibles = soloActivos ? codigos.filter((c) => c.activo || enEdicion(c.codigo)) : codigos;
    const m = new Map<string, CodigoDetraccion[]>();
    for (const c of visibles) {
      const k = c.anexo || "Sin clasificar";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(c);
    }
    return [...m.entries()].sort((a, b) => {
      const ia = ORDEN_ANEXO.indexOf(a[0]);
      const ib = ORDEN_ANEXO.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    // `borrador` entra en las deps porque una fila inactiva que se está editando debe
    // seguir visible aunque el filtro "solo activos" esté puesto.
  }, [codigos, soloActivos, borrador]);

  const cfgSucia = Object.keys(borradorConfig).length > 0;
  const igvActual = borradorConfig.igv_pct ?? config?.igv_pct ?? 18;
  const codigoDefecto = borradorConfig.detraccion_codigo_defecto ?? config?.detraccion_codigo_defecto ?? "";
  const detraccionActiva = borradorConfig.detraccion_activa ?? config?.detraccion_activa ?? true;

  return (
    <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
      <button
        onClick={() => setAbierto((v) => !v)}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-gray-50 text-left"
      >
        <div>
          <p className="text-sm font-bold text-gray-800">⚙️ Tasas y códigos de detracción</p>
          <p className="text-xs text-gray-400 mt-0.5">
            Los porcentajes del SPOT no son todos iguales y SUNAT los cambia por resolución. Edítalos aquí.
          </p>
        </div>
        <span className="text-gray-400 text-sm font-bold">{abierto ? "▲ Ocultar" : "▼ Configurar"}</span>
      </button>

      {abierto && (
        <div className="border-t p-4 space-y-4" style={{ borderColor: "#e2e8f0" }}>
          {aviso && (
            <div
              className={`rounded-xl border px-4 py-3 text-sm ${
                aviso.ok ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"
              }`}
            >
              {aviso.msg}
            </div>
          )}

          {!puedeEditar && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
              <span>🔒</span>
              Solo gerencia puede cambiar las tasas. Puedes consultarlas, pero no guardarlas.
            </div>
          )}

          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            <p>
              <strong>Antes de cambiar una tasa, contrástala con SUNAT.</strong> Los porcentajes se modifican por
              Resolución de Superintendencia y sin previo aviso. La tabla oficial está en{" "}
              <a
                href="https://orientacion.sunat.gob.pe/apendices-del-sistema-de-detracciones"
                target="_blank"
                rel="noopener noreferrer"
                className="font-bold underline"
              >
                los apéndices del sistema de detracciones
              </a>
              .
            </p>
            <p className="mt-1 text-xs text-blue-800">
              Para transporte, los dos que suelen confundirse: <strong>026</strong> es transporte de{" "}
              <strong>personas</strong> (10 %) y <strong>027</strong> es transporte de <strong>carga</strong> (4 %,
              y se calcula sobre el importe o el valor referencial, el que sea mayor).
            </p>
          </div>

          {/* ── Configuración general ── */}
          <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Configuración general</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">IGV vigente (%)</label>
                <input
                  type="number"
                  step="0.01"
                  disabled={!puedeEditar}
                  className={inputCls("font-mono")}
                  value={igvActual}
                  onChange={(e) => setBorradorConfig((p) => ({ ...p, igv_pct: num(e.target.value) }))}
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                  Código por defecto
                </label>
                <select
                  disabled={!puedeEditar}
                  className={inputCls()}
                  value={codigoDefecto}
                  onChange={(e) => setBorradorConfig((p) => ({ ...p, detraccion_codigo_defecto: e.target.value || null }))}
                >
                  <option value="">— Sin código por defecto —</option>
                  {codigos
                    .filter((c) => c.activo)
                    .map((c) => (
                      <option key={c.codigo} value={c.codigo}>
                        {c.codigo} · {c.descripcion} ({Number(c.porcentaje)} %)
                      </option>
                    ))}
                </select>
                <p className="text-[10px] text-gray-400 mt-1">Es el que propone el formulario de cuentas por pagar.</p>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm text-gray-700 pb-2.5">
                  <input
                    type="checkbox"
                    disabled={!puedeEditar}
                    checked={detraccionActiva}
                    onChange={(e) => setBorradorConfig((p) => ({ ...p, detraccion_activa: e.target.checked }))}
                  />
                  <span className="font-bold">Aplicar detracción</span>
                </label>
              </div>
            </div>
            {cfgSucia && puedeEditar && (
              <div className="flex justify-end gap-2">
                <button
                  className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-600 hover:bg-gray-50"
                  onClick={() => setBorradorConfig({})}
                >
                  Descartar
                </button>
                <button
                  className="px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-60 hover:opacity-90"
                  style={{ background: "#0b315f" }}
                  onClick={guardarConfig}
                  disabled={guardando === "__config__"}
                >
                  {guardando === "__config__" ? "Guardando…" : "Guardar configuración"}
                </button>
              </div>
            )}
          </div>

          {/* ── Filtros ── */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={soloActivos} onChange={(e) => setSoloActivos(e.target.checked)} />
              Mostrar solo los códigos activos
            </label>
            {puedeEditar && !nuevo && (
              <button
                className="px-4 py-2 rounded-xl font-bold text-xs border transition-all hover:bg-gray-50"
                style={{ borderColor: "#0b315f", color: "#0b315f" }}
                onClick={() => setNuevo({ codigo: "", descripcion: "", porcentaje: "12", umbral_min: "700" })}
              >
                + Agregar código
              </button>
            )}
          </div>

          {/* ── Alta de un código nuevo ── */}
          {nuevo && (
            <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: "#0b315f33", background: "#eef3f8" }}>
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#0b315f99" }}>
                Código nuevo
              </p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input
                  className={inputCls("font-mono")}
                  placeholder="026"
                  maxLength={3}
                  value={nuevo.codigo}
                  onChange={(e) => setNuevo({ ...nuevo, codigo: e.target.value.replace(/\D/g, "") })}
                />
                <input
                  className={inputCls("md:col-span-2")}
                  placeholder="Descripción del servicio"
                  value={nuevo.descripcion}
                  onChange={(e) => setNuevo({ ...nuevo, descripcion: e.target.value })}
                />
                <div className="flex gap-2">
                  <input
                    className={inputCls("font-mono")}
                    placeholder="%"
                    value={nuevo.porcentaje}
                    onChange={(e) => setNuevo({ ...nuevo, porcentaje: e.target.value })}
                  />
                  <input
                    className={inputCls("font-mono")}
                    placeholder="Umbral"
                    value={nuevo.umbral_min}
                    onChange={(e) => setNuevo({ ...nuevo, umbral_min: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-600 hover:bg-gray-50"
                  onClick={() => setNuevo(null)}
                >
                  Cancelar
                </button>
                <button
                  className="px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-60 hover:opacity-90"
                  style={{ background: "#0b315f" }}
                  onClick={agregarCodigo}
                  disabled={guardando === "__nuevo__"}
                >
                  {guardando === "__nuevo__" ? "Guardando…" : "Agregar"}
                </button>
              </div>
            </div>
          )}

          {/* ── Catálogo ── */}
          {cargando ? (
            <div className="p-10 text-center text-gray-400">
              <div className="flex items-center justify-center gap-2">
                <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                Cargando catálogo…
              </div>
            </div>
          ) : !codigos.length ? (
            <div className="p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">🏛️</p>
              <p>El catálogo está vacío.</p>
              <p className="text-sm mt-1">
                Corre <span className="font-mono">supabase/finanzas-07-detracciones-catalogo.sql</span> para cargarlo.
              </p>
            </div>
          ) : (
            grupos.map(([anexo, filas]) => {
              const cfg = COLOR_ANEXO[anexo] ?? { color: "#4b5563", bg: "#f3f4f6" };
              return (
                <div key={anexo} className="rounded-xl border overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
                  <div className="px-4 py-2 flex items-center gap-2" style={{ background: cfg.bg }}>
                    <span className="text-xs font-black uppercase tracking-wide" style={{ color: cfg.color }}>
                      {anexo}
                    </span>
                    <span className="text-[10px]" style={{ color: cfg.color + "99" }}>
                      {filas.length} código{filas.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                          {["Código", "Descripción", "%", "Umbral S/", "Activo", "Base legal", "Actualizado", ""].map((h) => (
                            <th
                              key={h}
                              className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filas.map((c) => (
                          <tr key={c.codigo} className="border-t hover:bg-gray-50 align-top" style={{ borderColor: "#f1f5f9" }}>
                            <td className="p-3 font-mono font-black text-xs text-[#0b315f] whitespace-nowrap">{c.codigo}</td>
                            <td className="p-3 min-w-[240px]">
                              <input
                                disabled={!puedeEditar}
                                className={inputCls("text-xs")}
                                value={String(valor(c, "descripcion") ?? "")}
                                onChange={(e) => editar(c.codigo, "descripcion", e.target.value)}
                              />
                              {c.notas && <p className="text-[10px] text-gray-400 mt-1">{c.notas}</p>}
                            </td>
                            <td className="p-3 w-24">
                              <input
                                type="number"
                                step="0.01"
                                disabled={!puedeEditar}
                                className={inputCls("font-mono text-xs")}
                                value={Number(valor(c, "porcentaje"))}
                                onChange={(e) => editar(c.codigo, "porcentaje", num(e.target.value))}
                              />
                            </td>
                            <td className="p-3 w-28">
                              <input
                                type="number"
                                step="1"
                                disabled={!puedeEditar}
                                className={inputCls("font-mono text-xs")}
                                value={Number(valor(c, "umbral_min"))}
                                onChange={(e) => editar(c.codigo, "umbral_min", num(e.target.value))}
                              />
                            </td>
                            <td className="p-3 text-center">
                              <input
                                type="checkbox"
                                disabled={!puedeEditar}
                                checked={Boolean(valor(c, "activo"))}
                                onChange={(e) => editar(c.codigo, "activo", e.target.checked)}
                              />
                            </td>
                            <td className="p-3 text-[10px] text-gray-400 whitespace-nowrap">{c.base_legal ?? "—"}</td>
                            <td className="p-3 text-[10px] text-gray-400 whitespace-nowrap">{fmtFecha(c.updated_at)}</td>
                            <td className="p-3 whitespace-nowrap">
                              {sucio(c.codigo) && puedeEditar && (
                                <div className="flex gap-1">
                                  <button
                                    className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                                    onClick={() => guardarFila(c)}
                                    disabled={guardando === c.codigo}
                                  >
                                    {guardando === c.codigo ? "…" : "Guardar"}
                                  </button>
                                  <button
                                    className="px-2.5 py-1 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                                    onClick={() => setBorrador((prev) => quitar(prev, c.codigo))}
                                  >
                                    ✕
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
