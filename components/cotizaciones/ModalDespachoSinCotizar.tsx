"use client";
// Regularizar los servicios del Despachador sin cotización. El predicado de "pendiente" es
// `pendientesDeCotizar` (lib/despacho-sin-cotizar.ts): el MISMO que cuenta el chip.
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  motivoDespacho, puedeVincular, MIN_MOTIVO_NO_REQUIERE, type ReservaDespacho,
} from "@/lib/despacho-sin-cotizar";
import {
  leerDespachosSinCotizar, vincularCotizacion, marcarNoRequiere, quitarNoRequiere, SQL_MIGRACION,
} from "@/lib/despacho-sin-cotizar-datos";
import { identidadRuta, ETIQUETA_RUTA, ETIQUETA_RECORRIDO, SIN_NOMBRE_RUTA, SIN_RECORRIDO } from "@/lib/ruta-identidad";

type CotMin = {
  id: number; numero_cotizacion: string | null; cliente_id: number | null; modo_servicio: string | null;
  estado: string | null; fecha_servicio: string | null; origen: string | null; destino: string | null; precio_cliente: number | null;
};

type Props = {
  /** Rótulo del cliente por id (la página usa rotuloCliente). */
  nombreCliente: (id: number | null | undefined) => string;
  onCerrar: () => void;
  /** Se llama tras cualquier cambio, para que el chip se recuente. */
  onCambio: () => void;
  /** Abre el formulario de nueva cotización prellenado con este servicio. */
  onCotizar: (r: ReservaDespacho) => void;
};

const fmtFecha = (f?: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
};
const fmtSoles = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? `S/ ${v.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "S/ —";
};
const ETIQ_MOTIVO: Record<string, string> = {
  cancelado: "Cancelado: ya no pide cotización",
  no_requiere: "No requiere cotización",
};

export default function ModalDespachoSinCotizar({ nombreCliente, onCerrar, onCambio, onCotizar }: Props) {
  const [filas, setFilas] = useState<ReservaDespacho[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sinColumnas, setSinColumnas] = useState<string[]>([]);
  const [verRegularizados, setVerRegularizados] = useState(false);
  const [abierta, setAbierta] = useState<{ id: number; modo: "vincular" | "no_requiere" } | null>(null);
  const [motivo, setMotivo] = useState("");
  const [cots, setCots] = useState<CotMin[] | null>(null);
  const [cotsError, setCotsError] = useState<string | null>(null);
  const [cotSel, setCotSel] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const [aviso, setAviso] = useState<{ tono: "rojo" | "ambar" | "verde"; texto: string } | null>(null);

  const cargar = useCallback(async () => {
    setFilas(null); setError(null);
    try {
      const r = await leerDespachosSinCotizar(supabase);
      setFilas(r.filas); setSinColumnas(r.sinColumnas);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !trabajando) onCerrar(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [onCerrar, trabajando]);

  const rotulo = (r: ReservaDespacho) => `#${r.codigo || r.id} del ${fmtFecha(r.fecha_servicio)}`;

  const tras = async (texto: string, tono: "verde" | "rojo" | "ambar" = "verde") => {
    setAviso({ tono, texto }); setAbierta(null); setMotivo(""); setCotSel("");
    onCambio(); await cargar();
  };

  const abrirVincular = async (r: ReservaDespacho) => {
    setAbierta({ id: r.id, modo: "vincular" }); setCots(null); setCotsError(null); setCotSel("");
    if (r.cliente_id == null) { setCots([]); return; }
    const { data, error: e } = await supabase.from("cotizaciones")
      .select("id,numero_cotizacion,cliente_id,modo_servicio,estado,fecha_servicio,origen,destino,precio_cliente")
      .eq("cliente_id", r.cliente_id).order("id", { ascending: false }).limit(50);
    if (e) { setCotsError(e.message); setCots([]); return; }
    setCots((data ?? []) as CotMin[]);
  };

  const vincular = async (r: ReservaDespacho) => {
    const c = cots?.find((x) => String(x.id) === cotSel);
    if (!c) return;
    if (!confirm(`¿Vincular el servicio del Despachador ${rotulo(r)} (${nombreCliente(r.cliente_id)}) a la cotización ${c.numero_cotizacion || `#${c.id}`} (${c.origen ?? "—"} → ${c.destino ?? "—"})?\n\nSolo se escribe el vínculo: no cambia ningún importe.`)) return;
    setTrabajando(true);
    const res = await vincularCotizacion(supabase, r.id, c.id);
    setTrabajando(false);
    if (!res.ok) { setAviso({ tono: "rojo", texto: res.error ?? "No se pudo vincular." }); return; }
    await tras(`Servicio ${rotulo(r)} vinculado a ${c.numero_cotizacion || `#${c.id}`}.`);
  };

  const noRequiere = async (r: ReservaDespacho) => {
    if (!confirm(`¿Marcar el servicio ${rotulo(r)} (${nombreCliente(r.cliente_id)}) como que no requiere cotización?\n\nMotivo: ${motivo.trim()}`)) return;
    setTrabajando(true);
    const res = await marcarNoRequiere(supabase, r.id, motivo);
    setTrabajando(false);
    if (!res.ok) { setAviso({ tono: res.sinMigracion ? "ambar" : "rojo", texto: res.error ?? "No se pudo guardar." }); return; }
    await tras(`Servicio ${rotulo(r)} marcado como que no requiere cotización.`);
  };

  const deshacer = async (r: ReservaDespacho) => {
    if (!confirm(`¿Deshacer el «no requiere cotización» del servicio ${rotulo(r)}? Volverá a contar como pendiente.`)) return;
    setTrabajando(true);
    const res = await quitarNoRequiere(supabase, r.id);
    setTrabajando(false);
    if (!res.ok) { setAviso({ tono: res.sinMigracion ? "ambar" : "rojo", texto: res.error ?? "No se pudo deshacer." }); return; }
    await tras(`El servicio ${rotulo(r)} vuelve a estar pendiente de cotizar.`);
  };

  const visibles = (filas ?? []).filter((r) => {
    const m = motivoDespacho(r);
    return m === "requiere_cotizacion" || (verRegularizados && (m === "cancelado" || m === "no_requiere"));
  });
  const nPend = (filas ?? []).filter((r) => motivoDespacho(r) === "requiere_cotizacion").length;
  const tonos = { rojo: "bg-red-50 border-red-200 text-red-700", ambar: "bg-amber-50 border-amber-200 text-amber-800", verde: "bg-green-50 border-green-200 text-green-700" };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-2 sm:p-4" onClick={() => !trabajando && onCerrar()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-4 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-900">⚡ Servicios del Despachador sin cotizar</h2>
            <p className="text-xs text-gray-500 mt-0.5">Si se prestó, cotízalo o vincúlalo a una cotización. Si no se ejecutó, cancélalo en Programación. Si no necesita cotización, decláralo con su motivo.</p>
          </div>
          <button onClick={onCerrar} disabled={trabajando} className="text-gray-400 hover:text-gray-700 text-xl leading-none px-2 min-h-[44px]" aria-label="Cerrar">✕</button>
        </div>
        <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-3 border-b text-sm">
          <span className="font-bold text-purple-700">{filas ? `${nPend} pendiente${nPend === 1 ? "" : "s"}` : error ? "No se pudo contar" : "Cargando…"}</span>
          <label className="flex items-center gap-2 text-gray-600 cursor-pointer">
            <input type="checkbox" checked={verRegularizados} onChange={(e) => setVerRegularizados(e.target.checked)} />
            Ver también los regularizados
          </label>
          <span className="text-xs text-gray-400">(los ya vinculados a una cotización no se listan)</span>
        </div>
        {sinColumnas.length > 0 && (
          <div className="mx-4 sm:mx-5 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Falta correr <b>{SQL_MIGRACION}</b>: sin ella no se puede marcar un servicio como «no requiere cotización».
          </div>
        )}
        {aviso && <div className={`mx-4 sm:mx-5 mt-3 rounded-xl border px-3 py-2 text-xs ${tonos[aviso.tono]}`}>{aviso.texto}</div>}
        <div className="overflow-y-auto px-4 sm:px-5 py-3 space-y-3">
          {!filas && !error && <p className="text-sm text-gray-500">Cargando…</p>}
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex flex-wrap items-center gap-3">
              <span>{error}</span>
              <button onClick={cargar} className="font-bold underline">Reintentar</button>
            </div>
          )}
          {filas && visibles.length === 0 && (
            <p className="text-sm text-gray-500">No hay servicios del Despachador pendientes de cotizar.</p>
          )}
          {visibles.map((r) => {
            const m = motivoDespacho(r);
            const pend = m === "requiere_cotizacion";
            const id = identidadRuta(r);
            const ab = abierta?.id === r.id ? abierta.modo : null;
            const vMotivo = motivo.trim().length >= MIN_MOTIVO_NO_REQUIERE;
            return (
              <div key={r.id} className={`rounded-xl border p-3 ${pend ? "border-purple-200" : "border-gray-200 bg-gray-50 text-gray-500"}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="font-bold text-sm text-gray-900">#{r.codigo || r.id} · {fmtFecha(r.fecha_servicio)} {r.hora_servicio ? String(r.hora_servicio).slice(0, 5) : ""} · {nombreCliente(r.cliente_id)}</div>
                  <div className="text-xs"><span className="text-gray-500">{r.estado || "—"}</span> · <b>{fmtSoles(r.precio_cliente)}</b> <span className="text-gray-400">c/IGV</span></div>
                </div>
                <div className="text-xs mt-1 grid sm:grid-cols-2 gap-x-4">
                  <div><span className="text-gray-400">{ETIQUETA_RUTA}: </span>{id.nombre ?? <i className="text-gray-400">{SIN_NOMBRE_RUTA}</i>}</div>
                  <div><span className="text-gray-400">{ETIQUETA_RECORRIDO}: </span>{id.recorrido ?? <i className="text-gray-400">{SIN_RECORRIDO}</i>}</div>
                </div>
                {!pend && (
                  <div className="text-xs mt-2 text-gray-500 flex flex-wrap items-center gap-3">
                    <span>{ETIQ_MOTIVO[m] ?? m}{m === "no_requiere" && r.cotizacion_no_requerida_motivo ? `: ${r.cotizacion_no_requerida_motivo}` : ""}</span>
                    {m === "no_requiere" && <button disabled={trabajando} onClick={() => deshacer(r)} className="font-bold underline text-gray-600">Deshacer</button>}
                  </div>
                )}
                {pend && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    <button disabled={trabajando} onClick={() => onCotizar(r)} className="px-3 py-2 min-h-[40px] rounded-lg text-xs font-bold text-white bg-[#0b315f]">Crear cotización</button>
                    <button disabled={trabajando} onClick={() => ab === "vincular" ? setAbierta(null) : abrirVincular(r)} className="px-3 py-2 min-h-[40px] rounded-lg text-xs font-bold border border-[#0b315f] text-[#0b315f]">Vincular a cotización existente</button>
                    <a href={`/programacion?editar=${r.id}`} target="_blank" rel="noopener noreferrer" className="px-3 py-2 min-h-[40px] rounded-lg text-xs font-bold border border-gray-300 text-gray-700 inline-flex items-center">Cancelar en Programación ↗</a>
                    <button disabled={trabajando} onClick={() => { setMotivo(""); setAbierta(ab === "no_requiere" ? null : { id: r.id, modo: "no_requiere" }); }} className="px-3 py-2 min-h-[40px] rounded-lg text-xs font-bold border border-gray-300 text-gray-700">No requiere cotización</button>
                  </div>
                )}
                {pend && <p className="text-[11px] text-gray-400 mt-1">Al cancelarlo, Programación te pregunta qué hacer con el importe (S/ 0.00 o falso flete). Después vuelve aquí y pulsa Reintentar o cierra y abre la lista.</p>}
                {ab === "vincular" && (
                  <div className="mt-2 rounded-lg bg-gray-50 border p-2 text-xs space-y-2">
                    {cots === null && <p className="text-gray-500">Cargando cotizaciones del cliente…</p>}
                    {cotsError && <p className="text-red-700">No se pudieron leer las cotizaciones: {cotsError}</p>}
                    {cots && r.cliente_id == null && <p className="text-gray-600">El servicio no tiene cliente: no se puede vincular a ninguna cotización.</p>}
                    {cots && r.cliente_id != null && !cotsError && cots.length === 0 && <p className="text-gray-600">Este cliente no tiene cotizaciones.</p>}
                    {cots && cots.length > 0 && (
                      <>
                        <select value={cotSel} onChange={(e) => setCotSel(e.target.value)} className="w-full border rounded-lg px-2 py-2 bg-white">
                          <option value="">— Elige una cotización —</option>
                          {cots.map((c) => {
                            const v = puedeVincular(r, c);
                            return (
                              <option key={c.id} value={c.id} disabled={!v.ok}>
                                {c.numero_cotizacion || `#${c.id}`} · {fmtFecha(c.fecha_servicio)} · {c.origen ?? "—"} → {c.destino ?? "—"} · {fmtSoles(c.precio_cliente)} · {c.estado ?? ""}{v.ok ? "" : ` — no: ${v.motivo}`}
                              </option>
                            );
                          })}
                        </select>
                        <button disabled={!cotSel || trabajando} onClick={() => vincular(r)} className="px-3 py-2 rounded-lg font-bold text-white bg-[#0b315f] disabled:opacity-40">Vincular</button>
                        {!cotSel && <p className="text-gray-500">Elige una cotización eventual del mismo cliente para poder vincular.</p>}
                      </>
                    )}
                  </div>
                )}
                {ab === "no_requiere" && (
                  <div className="mt-2 rounded-lg bg-gray-50 border p-2 text-xs space-y-2">
                    <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="¿Por qué no requiere cotización? (cortesía, servicio interno…)" className="w-full border rounded-lg px-2 py-2 bg-white" />
                    <button disabled={!vMotivo || trabajando} onClick={() => noRequiere(r)} className="px-3 py-2 rounded-lg font-bold text-white bg-gray-700 disabled:opacity-40">Confirmar</button>
                    {!vMotivo && <p className="text-gray-500">Escribe el motivo (mínimo {MIN_MOTIVO_NO_REQUIERE} caracteres).</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
