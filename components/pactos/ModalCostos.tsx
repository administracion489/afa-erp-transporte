"use client";
// ──────────────────────────────────────────────────────────────────────────────
// ModalCostos — cargar el costo del proveedor SIN salir de Liquidaciones.
//
// Por qué existe: la pantalla que DETECTA el problema era de solo lectura. Un
// servicio marcado "Sin costo de proveedor" obligaba a volver a Programación, uno
// por uno, sin saber cuánto se pactó — así que el bloque rojo se quedaba rojo y el
// mes no cerraba.
//
// Tres cosas que le ahorran el trabajo a quien cierra el periodo:
//   · Agrupa por proveedor + ruta: se cargan 22 servicios con un solo importe.
//   · Propone el importe donde YA existe en el ERP (la factura de compra o el gasto
//     de pago a tercero de ese mismo servicio) — v_costo_tercero_huerfano.
//   · Sugiere el último costo realmente pactado con ese proveedor en esa ruta
//     (fn_costo_sugerido). El tarifario de compra no hay que crearlo: es el historial.
//
// Y muestra el COSTO REAL según la afectación, porque un taxi exonerado de S/ 500
// cuesta más que un bus gravado de S/ 550. Ver lib/finanzas/afectacion.ts.
//
// Requiere supabase/pacto-00-tributario.sql y supabase/pacto-01-costeo.sql.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { AFECTACIONES, afectacionDe, costoReal, type CodigoAfectacion } from "@/lib/finanzas/afectacion";

export type ReservaSinCosto = {
  id: number;
  codigo?: string | null;
  fecha_servicio?: string | null;
  hora_servicio?: string | null;
  direccion_servicio?: string | null;
  ruta_nombre?: string | null;
  empresa_tercerizada_id?: number | null;
  vehiculo_tercero_id?: number | null;
  compra_afectacion?: string | null;
};

type Props = {
  reservas: ReservaSinCosto[];
  terceros: Record<number, any>;
  onCerrar: () => void;
  onGuardado: () => void;
};

type Grupo = {
  clave: string;
  empresaId: number | null;
  proveedor: string;
  ruta: string;
  afectacion: CodigoAfectacion;
  emiteFactura: boolean;
  filas: ReservaSinCosto[];
  sugerido?: { costo: number; base: string; dias: number; os: string } | null;
};

export default function ModalCostos({ reservas, terceros, onCerrar, onGuardado }: Props) {
  // Importe por servicio. La clave es el id; el valor, lo tecleado (string para no
  // pelear con el input vacío).
  const [montos, setMontos] = useState<Record<number, string>>({});
  const [afectPorGrupo, setAfectPorGrupo] = useState<Record<string, CodigoAfectacion>>({});
  const [propuestas, setPropuestas] = useState<Record<number, { monto: number; fuente: string }>>({});
  const [sugeridos, setSugeridos] = useState<Record<string, Grupo["sugerido"]>>({});
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");
  const [aviso, setAviso] = useState("");

  const grupos = useMemo<Grupo[]>(() => {
    const m = new Map<string, Grupo>();
    for (const r of reservas) {
      const empresaId = r.empresa_tercerizada_id ?? null;
      const t = empresaId != null ? terceros[empresaId] : null;
      const proveedor = t?.razon_social ?? "Sin empresa tercerizada";
      const ruta = r.ruta_nombre ?? "Sin ruta";
      const clave = `${empresaId ?? "x"}|${ruta}`;
      const g: Grupo = m.get(clave) ?? {
        clave, empresaId, proveedor, ruta,
        afectacion: (t?.afectacion_defecto ?? "10") as CodigoAfectacion,
        emiteFactura: t?.emite_factura !== false,
        filas: [] as ReservaSinCosto[],
      };
      g.filas.push(r);
      m.set(clave, g);
    }
    return [...m.values()].sort((a, b) => b.filas.length - a.filas.length);
  }, [reservas, terceros]);

  // ── Propuestas e historial ────────────────────────────────────────────────
  useEffect(() => {
    let vivo = true;
    (async () => {
      const ids = reservas.map((r) => r.id);
      if (ids.length) {
        // Se lee de v_costo_tercero_propuesta, NO de v_costo_tercero_huerfano: la vista
        // de propuesta ya descartó los cruces ambiguos. Una factura que calza con seis
        // servicios no dice el costo de ninguno, dice el total de todos — aceptarla en
        // cada uno multiplicaría el costo por seis.
        const { data, error } = await supabase
          .from("v_costo_tercero_propuesta")
          .select("reserva_id,importe_propuesto,fuente")
          .in("reserva_id", ids.slice(0, 500));
        if (error) {
          setAviso("Falta correr supabase/pacto-01-costeo.sql: sin eso no hay importes propuestos ni costo sugerido.");
        } else if (vivo) {
          const p: Record<number, { monto: number; fuente: string }> = {};
          for (const f of ((data as any[]) ?? []))
            p[f.reserva_id] = { monto: Number(f.importe_propuesto ?? 0), fuente: f.fuente };
          setPropuestas(p);
        }
      }

      for (const g of grupos) {
        if (g.empresaId == null) continue;
        const { data } = await supabase.rpc("fn_costo_sugerido", {
          p_empresa: g.empresaId,
          p_ruta: g.ruta === "Sin ruta" ? null : g.ruta,
          p_vehiculo_tercero: g.filas.find((f) => f.vehiculo_tercero_id)?.vehiculo_tercero_id ?? null,
        });
        const fila = Array.isArray(data) ? data[0] : data;
        if (vivo && fila?.costo != null)
          setSugeridos((prev) => ({
            ...prev,
            [g.clave]: { costo: Number(fila.costo), base: fila.base, dias: Number(fila.dias ?? 0), os: fila.os },
          }));
      }
    })();
    return () => { vivo = false; };
  }, [reservas, grupos]);

  // ── Acciones ──────────────────────────────────────────────────────────────
  const aplicarAGrupo = (g: Grupo, valor: string) =>
    setMontos((p) => ({ ...p, ...Object.fromEntries(g.filas.map((f) => [f.id, valor])) }));

  const aceptarPropuestas = (g: Grupo) =>
    setMontos((p) => ({
      ...p,
      ...Object.fromEntries(
        g.filas.filter((f) => propuestas[f.id]).map((f) => [f.id, String(propuestas[f.id].monto)])
      ),
    }));

  const afectacionDeGrupo = (g: Grupo): CodigoAfectacion => afectPorGrupo[g.clave] ?? g.afectacion;

  const conMonto = useMemo(
    () => Object.entries(montos).filter(([, v]) => Number(v) > 0).map(([k]) => Number(k)),
    [montos]
  );

  const totales = useMemo(() => {
    let nominal = 0, real = 0;
    for (const g of grupos) {
      const af = afectacionDeGrupo(g);
      for (const f of g.filas) {
        const v = Number(montos[f.id] ?? 0);
        if (v <= 0) continue;
        nominal += v;
        real += costoReal(v, af, { emiteFactura: g.emiteFactura });
      }
    }
    return { nominal, real };
  }, [montos, grupos, afectPorGrupo]);

  async function guardar() {
    if (!conMonto.length) return;
    setGuardando(true); setMsg("");
    try {
      // Un update por grupo+importe: los servicios de una ruta suelen compartir tarifa,
      // así que esto son 2 o 3 llamadas, no 22.
      const lotes = new Map<string, { patch: any; ids: number[] }>();
      for (const g of grupos) {
        const af = afectacionDeGrupo(g);
        for (const f of g.filas) {
          const v = Number(montos[f.id] ?? 0);
          if (v <= 0) continue;
          const patch = { costo_proveedor: v, compra_afectacion: af };
          const k = JSON.stringify(patch);
          const lote = lotes.get(k) ?? { patch, ids: [] };
          lote.ids.push(f.id);
          lotes.set(k, lote);
        }
      }

      const errores: string[] = [];
      for (const l of lotes.values()) {
        for (let i = 0; i < l.ids.length; i += 200) {
          const { error } = await supabase.from("reservas").update(l.patch).in("id", l.ids.slice(i, i + 200));
          if (error) errores.push(error.message);
        }
      }
      if (errores.length) {
        // compra_afectacion solo existe después de pacto-00: se reintenta sin ella para
        // que cargar el costo funcione igual y el mes pueda cerrarse.
        if (errores.some((e) => /compra_afectacion/i.test(e))) {
          for (const l of lotes.values())
            for (let i = 0; i < l.ids.length; i += 200)
              await supabase.from("reservas")
                .update({ costo_proveedor: l.patch.costo_proveedor })
                .in("id", l.ids.slice(i, i + 200));
          setAviso("Se guardó el costo, pero no la afectación: falta correr supabase/pacto-00-tributario.sql.");
        } else {
          setMsg(`No se pudieron guardar ${errores.length} lote(s): ${errores[0]}`);
          setGuardando(false);
          return;
        }
      }
      onGuardado();
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setGuardando(false);
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  const inputCls = "w-32 px-2 py-1 border rounded-lg text-sm text-right tabular-nums";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl my-8">
        <div className="px-6 py-4 border-b flex items-center justify-between sticky top-0 bg-white rounded-t-2xl z-10">
          <div>
            <h2 className="text-lg font-black text-gray-800">Cargar costos del proveedor</h2>
            <p className="text-xs text-gray-500">
              {reservas.length} servicio(s) sin costo pactado · {grupos.length} grupo(s)
            </p>
          </div>
          <button onClick={onCerrar} className="text-gray-400 hover:text-gray-600 text-2xl leading-none px-2">×</button>
        </div>

        {aviso && (
          <div className="mx-6 mt-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-[12px] text-amber-800">
            {aviso}
          </div>
        )}

        <div className="p-6 space-y-5">
          {grupos.map((g) => {
            const sug = sugeridos[g.clave];
            const af = afectacionDeGrupo(g);
            const nProp = g.filas.filter((f) => propuestas[f.id]).length;
            return (
              <div key={g.clave} className="border rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 border-b">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-black text-gray-800 text-sm">{g.proveedor}</span>
                    <span className="text-gray-400">·</span>
                    <span className="text-sm text-gray-600">{g.ruta}</span>
                    <span className="text-[11px] text-gray-500 bg-white border rounded-full px-2 py-0.5">
                      {g.filas.length} servicio(s)
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 mt-3">
                    <label className="text-[11px] text-gray-500 uppercase tracking-wide font-bold">
                      Aplicar a todo el grupo
                    </label>
                    <input
                      type="number" min="0" step="0.01" placeholder="0.00" className={inputCls}
                      onChange={(e) => aplicarAGrupo(g, e.target.value)}
                    />
                    {sug && (
                      <button
                        onClick={() => aplicarAGrupo(g, String(sug.costo))}
                        className="text-[11px] px-2 py-1 rounded-lg bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100"
                      >
                        Usar {fmtMoneda(sug.costo)} · último con este proveedor en {sug.base}, hace {sug.dias} día(s)
                      </button>
                    )}
                    {nProp > 0 && (
                      <button
                        onClick={() => aceptarPropuestas(g)}
                        className="text-[11px] px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                      >
                        Aceptar {nProp} importe(s) ya facturado(s)
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <label className="text-[11px] text-gray-500 uppercase tracking-wide font-bold">IGV</label>
                    <select
                      className="px-2 py-1 border rounded-lg text-xs"
                      value={af}
                      onChange={(e) => setAfectPorGrupo((p) => ({ ...p, [g.clave]: e.target.value as CodigoAfectacion }))}
                    >
                      {Object.values(AFECTACIONES).map((a) => (
                        <option key={a.codigo} value={a.codigo}>{a.codigo} · {a.nombre}</option>
                      ))}
                    </select>
                    <span className="text-[11px] text-gray-500">
                      {afectacionDe(af).grava
                        ? (g.emiteFactura
                            ? "El IGV vuelve como crédito fiscal: el costo real es el neto."
                            : "Gravado pero sin factura: no hay crédito, cuesta el importe completo.")
                        : "Sin IGV: no hay crédito fiscal ni detracción, cuesta el importe completo."}
                    </span>
                  </div>
                </div>

                <div className="divide-y max-h-64 overflow-y-auto">
                  {g.filas.map((f) => {
                    const prop = propuestas[f.id];
                    const v = Number(montos[f.id] ?? 0);
                    return (
                      <div key={f.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                        <span className="font-mono text-xs text-gray-700 w-40 shrink-0">{f.codigo ?? "#" + f.id}</span>
                        <span className="text-xs text-gray-400 w-24 shrink-0">{f.fecha_servicio}</span>
                        <span className="text-xs text-gray-400 w-16 shrink-0">
                          {f.direccion_servicio === "retorno" ? "retorno" : "ida"}
                        </span>
                        <span className="flex-1 text-[11px] text-emerald-700 truncate">
                          {prop ? `Ya facturado ${fmtMoneda(prop.monto)} · ${prop.fuente}` : ""}
                        </span>
                        <input
                          type="number" min="0" step="0.01" placeholder="0.00" className={inputCls}
                          value={montos[f.id] ?? ""}
                          onChange={(e) => setMontos((p) => ({ ...p, [f.id]: e.target.value }))}
                        />
                        <span className="w-28 text-right text-[11px] text-gray-500 tabular-nums shrink-0">
                          {v > 0 ? `real ${fmtMoneda(costoReal(v, af, { emiteFactura: g.emiteFactura }))}` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-6 py-4 border-t bg-gray-50 rounded-b-2xl sticky bottom-0">
          {msg && <p className="text-xs text-red-600 mb-2">{msg}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-gray-600">
              <span className="font-black text-gray-800">{conMonto.length}</span> de {reservas.length} con importe ·
              nominal <span className="font-bold tabular-nums">{fmtMoneda(totales.nominal)}</span> ·
              costo real <span className="font-bold tabular-nums">{fmtMoneda(totales.real)}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm text-gray-600 hover:bg-white">
                Cancelar
              </button>
              <button
                onClick={guardar}
                disabled={guardando || !conMonto.length}
                className="px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-bold disabled:opacity-40 hover:bg-violet-700"
              >
                {guardando ? "Guardando…" : `Pactar ${conMonto.length} servicio(s)`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
