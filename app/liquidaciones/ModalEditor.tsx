"use client";
// Editor de UNA liquidación antes de emitirla: la revisión que hoy se hace tecleando
// sobre el Excel. Las líneas de servicio vienen calculadas desde los viajes; aquí solo
// se ajustan cantidades (con motivo), se agregan adicionales y penalidades, y se
// completan los datos que el formato imprime en la sección 1.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { totalesValorizacion } from "@/lib/liquidacion-agrupacion";
import {
  actualizarCantidad, agregarLineaManual, eliminarLinea, recalcularTotales,
  emitirLiquidacion, recalcularDescripciones, totalesProveedorExt, detraccionDe, type Lado,
} from "@/lib/liquidaciones";

type Linea = {
  id: number; item: number; tipo: "servicio" | "adicional" | "penalidad" | "descuento";
  descripcion: string; unidad_medida: string;
  cantidad_programada: number | null; cantidad_ejecutada: number | null;
  cantidad: number; cantidad_motivo: string | null;
  precio_unitario: number; total_linea: number; referencia: string | null;
  /** Asientos contratados. null = el ítem se imprime sin el "N PAX". */
  pax_contratado: number | null;
  /** La escribe la agrupación. Presente ⇒ la línea tiene reservas detrás. */
  agrupacion_clave: string | null;
};

/**
 * ¿La línea salió de servicios reales o la escribió alguien a mano en este editor?
 *
 * No basta con `tipo === "servicio"`: desde que los adicionales se registran en
 * Programación, una línea de tipo `adicional` también puede venir de reservas —con su
 * pax contratado, su programado/ejecutado y su descripción de varios renglones— y
 * tratarla como una línea manual la mostraba vacía ("—") y con botón de borrar.
 */
const deReservas = (l: Linea) => l.tipo === "servicio" || !!l.agrupacion_clave;

const campo = "w-full px-2.5 py-1.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-[#2a5298]/30";
const label = "text-[10px] font-bold text-gray-500 uppercase tracking-wide";

export default function ModalEditor({
  lado, liquidacionId, usuario, onCerrar, onCambio, onVerPdf,
}: {
  lado: Lado;
  liquidacionId: number;
  usuario: string;
  onCerrar: () => void;
  onCambio: () => void;
  onVerPdf: (id: number) => void;
}) {
  const tCab = lado === "cliente" ? "liquidacion_cliente" : "liquidacion_proveedor";
  const tLin = lado === "cliente" ? "liquidacion_cliente_linea" : "liquidacion_proveedor_linea";

  const [cab, setCab] = useState<any>(null);
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [nueva, setNueva] = useState({ tipo: "adicional" as "adicional" | "penalidad" | "descuento", descripcion: "", cantidad: "1", precio: "" });
  const [detraccionPct, setDetraccionPct] = useState<number | null>(null);

  async function cargar() {
    setCargando(true);
    const [{ data: c }, { data: l }] = await Promise.all([
      supabase.from(tCab).select("*").eq("id", liquidacionId).maybeSingle(),
      supabase.from(tLin).select("*").eq("liquidacion_id", liquidacionId).order("item"),
    ]);
    setCab(c);
    setLineas(((l as any[]) ?? []).map((x) => ({ ...x, cantidad: Number(x.cantidad), precio_unitario: Number(x.precio_unitario) })));
    if (lado === "proveedor" && c?.detraccion_codigo) {
      const d = await detraccionDe(supabase, c.detraccion_codigo);
      setDetraccionPct(d?.porcentaje ?? null);
    }
    setCargando(false);
  }
  useEffect(() => { cargar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [liquidacionId]);

  const editable = cab?.estado === "borrador";
  const moneda = cab?.moneda ?? "PEN";
  const igvPct = Number(cab?.igv_pct ?? 18);

  // Totales en vivo: se recalculan mientras se edita, sin esperar al guardado.
  const totales = useMemo(() => {
    const filas = lineas.map((l) => ({ tipo: l.tipo, cantidad: Number(l.cantidad || 0), precio_unitario: Number(l.precio_unitario || 0) }));
    if (lado === "cliente") return { ...totalesValorizacion(filas, igvPct), totalComprobante: null as number | null, detraccionMonto: 0, anticipos: 0 };
    const t = totalesProveedorExt(filas, {
      igvPct,
      detraccion: detraccionPct ? { porcentaje: detraccionPct, umbral_min: 700 } : null,
      anticipos: Number(cab?.anticipos ?? 0),
    });
    const base = totalesValorizacion(filas, igvPct);
    return { ...base, ...t, detraccionMonto: t.detraccionMonto, anticipos: t.anticipos, total: t.total, totalComprobante: t.totalComprobante };
  }, [lineas, igvPct, lado, detraccionPct, cab?.anticipos]);

  function setLinea(id: number, campo: Partial<Linea>) {
    setLineas((ls) => ls.map((l) => (l.id === id ? { ...l, ...campo } : l)));
  }

  /** Guarda una línea; si la cantidad se apartó de lo ejecutado, exige el motivo. */
  async function guardarLinea(l: Linea) {
    setTrabajando(true); setMsg("");
    try {
      const r = await actualizarCantidad(supabase, lado, l.id, Number(l.cantidad || 0), {
        motivo: l.cantidad_motivo, usuario,
      });
      if (!r.ok) throw new Error(r.error);
      // El precio y la descripción no pasan por el dominio: son texto del documento.
      await supabase.from(tLin).update({
        descripcion: l.descripcion,
        precio_unitario: Number(l.precio_unitario || 0),
        total_linea: (l.tipo === "penalidad" || l.tipo === "descuento" ? -1 : 1) * Number(l.cantidad || 0) * Number(l.precio_unitario || 0),
      }).eq("id", l.id);
      await recalcularTotales(supabase, lado, liquidacionId);
      setMsg("✅ Línea actualizada.");
      await cargar(); onCambio();
    } catch (e: any) {
      setMsg("⚠️ " + String(e?.message ?? e));
    } finally { setTrabajando(false); }
  }

  async function agregar() {
    if (!nueva.descripcion.trim() || !Number(nueva.precio)) { setMsg("⚠️ Completa la descripción y el importe."); return; }
    setTrabajando(true); setMsg("");
    const r = await agregarLineaManual(supabase, lado, liquidacionId, {
      tipo: nueva.tipo,
      descripcion: nueva.descripcion.trim(),
      cantidad: Number(nueva.cantidad || 1),
      precio_unitario: Number(nueva.precio),
    });
    setMsg(r.ok ? "✅ Línea agregada." : "⚠️ " + r.error);
    setNueva({ tipo: "adicional", descripcion: "", cantidad: "1", precio: "" });
    await cargar(); onCambio(); setTrabajando(false);
  }

  async function borrar(id: number) {
    setTrabajando(true);
    const r = await eliminarLinea(supabase, lado, id);
    setMsg(r.ok ? "✅ Línea eliminada." : "⚠️ " + r.error);
    await cargar(); onCambio(); setTrabajando(false);
  }

  async function guardarCabecera() {
    setTrabajando(true); setMsg("");
    const campos: any = {
      servicio_contratado: cab.servicio_contratado, ubicacion_servicio: cab.ubicacion_servicio,
      orden_compra: cab.orden_compra, comentarios: cab.comentarios, moneda: cab.moneda,
      precios_incluyen_igv: cab.precios_incluyen_igv,
    };
    if (lado === "cliente") Object.assign(campos, {
      area_solicitante: cab.area_solicitante, usuario_solicita: cab.usuario_solicita, cargo_solicita: cab.cargo_solicita,
    });
    else Object.assign(campos, {
      responsable_afa: cab.responsable_afa, cargo_responsable: cab.cargo_responsable,
      cuenta_detraccion: cab.cuenta_detraccion, detraccion_codigo: cab.detraccion_codigo,
      anticipos: Number(cab.anticipos ?? 0),
    });
    const { error } = await supabase.from(tCab).update(campos).eq("id", liquidacionId);
    if (!error) await recalcularTotales(supabase, lado, liquidacionId);
    setMsg(error ? "⚠️ " + error.message : "✅ Datos guardados.");
    await cargar(); onCambio(); setTrabajando(false);
  }

  async function emitir() {
    setTrabajando(true); setMsg("");
    const r = await emitirLiquidacion(supabase, lado, liquidacionId, usuario);
    setMsg(r.ok ? "✅ Emitida. Ya puedes enviarla para conformidad." : "⚠️ " + r.error);
    await cargar(); onCambio(); setTrabajando(false);
  }

  /**
   * Reescribe las descripciones con los datos de hoy. Hace falta porque la descripción
   * es un snapshot: un documento creado antes del cambio de formato conserva el
   * "RUTA B / TURNO DÍA / MÓVIL 1" con el que nació, y sin esto la única forma de verlo
   * con el nombre real de la ruta sería anularlo y volver a cerrar el periodo.
   * No toca cantidades, precios ni totales.
   */
  async function recalcular() {
    setTrabajando(true); setMsg("");
    const r = await recalcularDescripciones(supabase, lado, liquidacionId, { usuario });
    setMsg(
      r.ok
        ? `✅ ${r.actualizadas} descripción(es) actualizada(s).` +
          (r.sinPax ? ` ${r.sinPax} ruta(s) salen sin el "N PAX": fíchalas en Liquidaciones → Rutas contratadas.` : "")
        : "⚠️ " + r.error
    );
    await cargar(); onCambio(); setTrabajando(false);
  }

  if (cargando || !cab)
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
        <div className="bg-white rounded-2xl px-8 py-6 text-gray-400 text-sm">Cargando liquidación…</div>
      </div>
    );

  const cp = lado === "cliente" ? "#0b315f" : "#6d28d9";

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[94vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Cabecera */}
        <div className="px-5 py-3 border-b sticky top-0 bg-white rounded-t-2xl flex items-center gap-3 z-10">
          <div>
            <h3 className="font-black" style={{ color: cp }}>{cab.codigo ?? `#${liquidacionId}`}</h3>
            <p className="text-xs text-gray-500">{cab.periodo} · {cab.estado.toUpperCase()}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => onVerPdf(liquidacionId)} className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50">📄 Ver PDF</button>
            {editable && (
              <button onClick={recalcular} disabled={trabajando}
                title="Reescribe las descripciones con el nombre real de cada ruta y la capacidad contratada. No toca cantidades ni precios."
                className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 disabled:opacity-50">
                ↻ Recalcular descripciones
              </button>
            )}
            {editable && (
              <button onClick={emitir} disabled={trabajando} className="px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50" style={{ background: cp }}>
                Emitir documento
              </button>
            )}
            <button onClick={onCerrar} className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50">Cerrar</button>
          </div>
        </div>

        {msg && <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">{msg}</div>}
        {!editable && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
            Esta liquidación ya fue emitida: para cambiar montos hay que reabrirla desde la lista. El cliente ya vio este documento.
          </div>
        )}

        {/* Datos del formato */}
        <div className="p-5 grid gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-wide mb-2" style={{ color: cp }}>1 · Datos generales</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={label}>Servicio contratado</label>
                <input disabled={!editable} className={campo} value={cab.servicio_contratado ?? ""} onChange={(e) => setCab({ ...cab, servicio_contratado: e.target.value })} />
              </div>
              <div>
                <label className={label}>Orden de compra</label>
                <input disabled={!editable} className={campo} value={cab.orden_compra ?? ""} onChange={(e) => setCab({ ...cab, orden_compra: e.target.value })} />
              </div>
              {lado === "cliente" ? (
                <>
                  <div>
                    <label className={label}>Área solicitante</label>
                    <input disabled={!editable} className={campo} value={cab.area_solicitante ?? ""} onChange={(e) => setCab({ ...cab, area_solicitante: e.target.value })} />
                  </div>
                  <div>
                    <label className={label}>Usuario que solicita</label>
                    <input disabled={!editable} className={campo} value={cab.usuario_solicita ?? ""} onChange={(e) => setCab({ ...cab, usuario_solicita: e.target.value })} />
                  </div>
                  <div>
                    <label className={label}>Cargo</label>
                    <input disabled={!editable} className={campo} value={cab.cargo_solicita ?? ""} onChange={(e) => setCab({ ...cab, cargo_solicita: e.target.value })} />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className={label}>Responsable AFA</label>
                    <input disabled={!editable} className={campo} value={cab.responsable_afa ?? ""} onChange={(e) => setCab({ ...cab, responsable_afa: e.target.value })} />
                  </div>
                  <div>
                    <label className={label}>Cuenta de detracción</label>
                    <input disabled={!editable} className={campo} value={cab.cuenta_detraccion ?? ""} onChange={(e) => setCab({ ...cab, cuenta_detraccion: e.target.value })} />
                  </div>
                  <div>
                    <label className={label}>Anticipos entregados</label>
                    <input disabled={!editable} type="number" className={campo} value={cab.anticipos ?? 0} onChange={(e) => setCab({ ...cab, anticipos: e.target.value })} />
                  </div>
                </>
              )}
              <div className="col-span-3 flex items-center gap-2 text-xs text-gray-600 bg-gray-50 rounded-xl px-3 py-2">
                <input id="conigv" type="checkbox" disabled={!editable} checked={!!cab.precios_incluyen_igv}
                  onChange={(e) => setCab({ ...cab, precios_incluyen_igv: e.target.checked })} />
                <label htmlFor="conigv">
                  Los precios cargados en el ERP <b>ya incluyen IGV</b> — al marcarlo, el formato imprime el precio sin IGV y lo suma abajo.
                  Cámbialo solo si el total no coincide con lo que facturas.
                </label>
              </div>
            </div>
          </div>

          {/* Líneas */}
          <div>
            <p className="text-xs font-black uppercase tracking-wide mb-2" style={{ color: cp }}>2 · Valorización</p>
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
                  <tr>
                    <th className="px-2 py-2 text-left w-8">#</th>
                    <th className="px-2 py-2 text-left">Descripción</th>
                    <th className="px-2 py-2 w-20">PAX</th>
                    <th className="px-2 py-2 w-24">Prog./Ejec.</th>
                    <th className="px-2 py-2 w-20">Cant.</th>
                    <th className="px-2 py-2 w-24">P. unit.</th>
                    <th className="px-2 py-2 w-24 text-right">Total</th>
                    <th className="px-2 py-2 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {lineas.map((l) => {
                    const difiere = l.cantidad_ejecutada != null && Number(l.cantidad_ejecutada) !== Number(l.cantidad);
                    const negativo = l.tipo === "penalidad" || l.tipo === "descuento";
                    return (
                      <tr key={l.id} className={l.tipo === "adicional" ? "bg-amber-50/60" : negativo ? "bg-red-50/60" : ""}>
                        <td className="px-2 py-2 text-gray-400">{l.item}</td>
                        <td className="px-2 py-2">
                          {/* La descripción trae varios renglones (concepto, ida, retorno, móvil):
                              un <input> de una línea solo dejaba ver el primero. */}
                          <textarea disabled={!editable} rows={deReservas(l) ? 3 : 1}
                            className="w-full bg-transparent text-[13px] font-medium focus:outline-none resize-y leading-snug"
                            value={l.descripcion} onChange={(e) => setLinea(l.id, { descripcion: e.target.value })} />
                          {difiere && (
                            <input disabled={!editable} className="w-full mt-1 px-2 py-1 rounded border border-amber-300 bg-amber-50 text-[11px]"
                              placeholder="Motivo del ajuste (obligatorio)"
                              value={l.cantidad_motivo ?? ""} onChange={(e) => setLinea(l.id, { cantidad_motivo: e.target.value })} />
                          )}
                          {l.referencia && <p className="text-[10px] text-gray-400 mt-0.5">Anexo 1 · ítems {l.referencia}</p>}
                        </td>
                        <td className="px-2 py-2 text-center text-xs">
                          {deReservas(l)
                            ? (l.pax_contratado != null
                                ? <span className="text-gray-500">{l.pax_contratado}</span>
                                : <span className="text-amber-600" title="Ninguna fuente sabe cuántos asientos se contrataron: el ítem se imprime sin el «N PAX». Fíchalo en Liquidaciones → Rutas contratadas.">sin dato</span>)
                            : "—"}
                        </td>
                        <td className="px-2 py-2 text-center text-xs text-gray-500">
                          {deReservas(l) ? `${l.cantidad_programada ?? "—"} / ${l.cantidad_ejecutada ?? "—"}` : "—"}
                        </td>
                        <td className="px-2 py-2">
                          <input disabled={!editable} type="number" step="0.01" className="w-full px-1.5 py-1 rounded border text-sm text-center"
                            value={l.cantidad} onChange={(e) => setLinea(l.id, { cantidad: Number(e.target.value) })} />
                        </td>
                        <td className="px-2 py-2">
                          <input disabled={!editable} type="number" step="0.01" className="w-full px-1.5 py-1 rounded border text-sm text-right"
                            value={l.precio_unitario} onChange={(e) => setLinea(l.id, { precio_unitario: Number(e.target.value) })} />
                        </td>
                        <td className={`px-2 py-2 text-right font-bold ${negativo ? "text-red-600" : "text-gray-700"}`}>
                          {negativo ? "−" : ""}{fmtMoneda(Math.abs(Number(l.cantidad || 0) * Number(l.precio_unitario || 0)), moneda)}
                        </td>
                        <td className="px-2 py-2 text-right">
                          {editable && (
                            <div className="flex gap-1 justify-end">
                              <button onClick={() => guardarLinea(l)} disabled={trabajando} title="Guardar"
                                className="px-2 py-1 rounded text-[11px] font-bold bg-emerald-600 text-white disabled:opacity-50">✓</button>
                              {!deReservas(l) && (
                                <button onClick={() => borrar(l.id)} disabled={trabajando} title="Eliminar"
                                  className="px-2 py-1 rounded text-[11px] font-bold border text-red-600 border-red-200">✕</button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {editable && (
              <div className="mt-3 grid grid-cols-12 gap-2 items-end bg-gray-50 rounded-xl p-3">
                <div className="col-span-2">
                  <label className={label}>Tipo</label>
                  <select className={campo} value={nueva.tipo} onChange={(e) => setNueva({ ...nueva, tipo: e.target.value as any })}>
                    <option value="adicional">Adicional (+)</option>
                    <option value="penalidad">Penalidad (−)</option>
                    <option value="descuento">Descuento (−)</option>
                  </select>
                </div>
                <div className="col-span-5">
                  <label className={label}>Descripción</label>
                  <input className={campo} value={nueva.descripcion} onChange={(e) => setNueva({ ...nueva, descripcion: e.target.value })}
                    placeholder="Servicio extra 28/06 autorizado por…" />
                </div>
                <div className="col-span-2">
                  <label className={label}>Cantidad</label>
                  <input className={campo} type="number" step="0.01" value={nueva.cantidad} onChange={(e) => setNueva({ ...nueva, cantidad: e.target.value })} />
                </div>
                <div className="col-span-2">
                  <label className={label}>Importe unitario</label>
                  <input className={campo} type="number" step="0.01" value={nueva.precio} onChange={(e) => setNueva({ ...nueva, precio: e.target.value })} />
                </div>
                <div className="col-span-1">
                  <button onClick={agregar} disabled={trabajando} className="w-full px-3 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: cp }}>+</button>
                </div>
              </div>
            )}
          </div>

          {/* Totales */}
          <div className="flex justify-end">
            <table className="text-sm w-80">
              <tbody>
                <tr><td className="py-1 text-right pr-3 text-gray-500">Servicios</td><td className="py-1 text-right font-bold">{fmtMoneda(totales.servicios, moneda)}</td></tr>
                {!!totales.adicionales && <tr><td className="py-1 text-right pr-3 text-gray-500">Adicionales</td><td className="py-1 text-right font-bold">{fmtMoneda(totales.adicionales, moneda)}</td></tr>}
                {!!totales.descuentos && <tr><td className="py-1 text-right pr-3 text-gray-500">Descuentos y penalidades</td><td className="py-1 text-right font-bold text-red-600">− {fmtMoneda(totales.descuentos, moneda)}</td></tr>}
                <tr><td className="py-1 text-right pr-3 text-gray-500">Subtotal</td><td className="py-1 text-right font-bold">{fmtMoneda(totales.subtotal, moneda)}</td></tr>
                <tr><td className="py-1 text-right pr-3 text-gray-500">IGV {igvPct}%</td><td className="py-1 text-right font-bold">{fmtMoneda(totales.igv, moneda)}</td></tr>
                {lado === "proveedor" && (
                  <>
                    <tr><td className="py-1 text-right pr-3 text-gray-500">Total del comprobante</td><td className="py-1 text-right font-bold">{fmtMoneda(totales.totalComprobante ?? 0, moneda)}</td></tr>
                    {!!totales.detraccionMonto && <tr><td className="py-1 text-right pr-3 text-gray-500">Detracción {detraccionPct}%</td><td className="py-1 text-right font-bold text-red-600">− {fmtMoneda(totales.detraccionMonto, moneda)}</td></tr>}
                    {!!totales.anticipos && <tr><td className="py-1 text-right pr-3 text-gray-500">Anticipos</td><td className="py-1 text-right font-bold text-red-600">− {fmtMoneda(totales.anticipos, moneda)}</td></tr>}
                  </>
                )}
                <tr style={{ background: cp }}>
                  <td className="py-2 px-3 text-right text-white font-black text-xs">{lado === "cliente" ? "TOTAL A FACTURAR" : "NETO A PAGAR"}</td>
                  <td className="py-2 px-3 text-right text-white font-black">{fmtMoneda(totales.total, moneda)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Comentarios */}
          <div>
            <label className={label}>Comentarios acerca del servicio ejecutado (se imprimen en el formato)</label>
            <textarea disabled={!editable} className={campo + " min-h-[70px]"} value={cab.comentarios ?? ""}
              onChange={(e) => setCab({ ...cab, comentarios: e.target.value })} />
          </div>
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end sticky bottom-0 bg-white rounded-b-2xl">
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          {editable && (
            <button onClick={guardarCabecera} disabled={trabajando}
              className="px-4 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: cp }}>
              {trabajando ? "Guardando…" : "Guardar datos"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
