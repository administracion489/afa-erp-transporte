"use client";
// app/combustible/CargasPorCompletar.tsx — «Cargas por completar»: lo que registró la FACTURA del correo
// sin que el Radar leyera su voucher (lib/combustible/completar-carga.ts, puro). Una persona pone el
// odómetro del voucher —o dice que no lo hay— y confirma o corrige la fecha del despacho.
//
// Es la otra mitad del respaldo de la factura: cuando el Radar no lee (servidor caído, WhatsApp
// desvinculado, API sin saldo), la factura registra la carga al día siguiente, pero sin odómetro y con
// la fecha deducida. Sin esta cola esos dos datos se quedaban así para siempre y nada los pedía.
//
// LO QUE ESCRIBE: la carga (`combustible`), con la fila RECIÉN leída —el plan se rehace al pulsar— y un
// UPDATE que exige que siga con la fecha leída; y el odómetro por `registrarLectura`, la misma puerta del
// resto del ERP (anti-retroceso, km vigente, mantenimiento), con una clave por carga para que un
// reintento no lo duplique. La plata de la factura no se toca.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { registrarLectura } from "@/lib/odometro";
import { capturaDeFechaHora } from "@/lib/odometro-tiempo";
import { MARCA_CARGA_DE_FACTURA, DIAS_REGISTRO_AUTOMATICO } from "@/lib/combustible/factura-lineas";
import { sumarDias } from "@/lib/combustible/desfase-factura";
import {
  colaPorCompletar, origenesDeCargas, planDeCompletar, rangoKmDelDia, kmFueraDelRango,
  type CargaDeFacturaBD, type CargaPorCompletar, type FacturaConCargas, type LecturaOdometroBD, type RangoKmDelDia,
} from "@/lib/combustible/completar-carga";
import { configCombustible } from "@/lib/combustible-tipos";
import { pendientesCerca, type RecargaPorRevisar } from "@/lib/combustible/orden-revision";

const S = (n: number | null | undefined) =>
  n == null ? "—" : `S/ ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const F = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const fmtKm = (n: number) => `${Math.round(n).toLocaleString("es-PE")} km`;
const hoyLima = () => new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);

type Fila = Record<string, unknown>;
type Entrada = { km: string; sinOdometro: boolean; fecha: string; hora: string; conductor: string };

/** La fila de `combustible` como la necesita el motor. */
function aCarga(r: Fila, placaDe: Map<string, string>): CargaDeFacturaBD {
  const vp = r.vehiculo_id != null ? Number(r.vehiculo_id) : null;
  const vt = r.vehiculo_tercero_id != null ? Number(r.vehiculo_tercero_id) : null;
  return {
    id: Number(r.id),
    fecha: String(r.fecha ?? "").slice(0, 10),
    kilometraje: r.kilometraje == null ? null : Number(r.kilometraje),
    total: r.total == null ? null : Number(r.total),
    galones: r.galones == null ? null : Number(r.galones),
    unidad: (r.unidad as string) ?? null,
    tipo_combustible: (r.tipo_combustible as string) ?? null,
    conductor: (r.conductor as string) ?? null,
    observaciones: (r.observaciones as string) ?? null,
    placa: vp != null ? placaDe.get(`p${vp}`) ?? null : vt != null ? placaDe.get(`t${vt}`) ?? null : null,
    vehiculo: vp != null ? { flota: "propia", id: vp } : vt != null ? { flota: "tercero", id: vt } : null,
  };
}

/**
 * TODAS las cargas que registró una factura, paginadas, con su placa: el motor decide cuáles faltan
 * completar (y cuáles son del historial). Un tope aquí dejaría fuera justo las más nuevas.
 */
async function leerCargasDeFactura(): Promise<{ cargas: CargaDeFacturaBD[] } | { error: string }> {
  try {
    const [{ data: vp }, { data: vt }] = await Promise.all([
      supabase.from("vehiculos").select("id, placa"),
      supabase.from("vehiculos_tercero").select("id, placa"),
    ]);
    const placaDe = new Map<string, string>();
    for (const v of ((vp as Fila[]) ?? [])) placaDe.set(`p${v.id}`, String(v.placa ?? ""));
    for (const v of ((vt as Fila[]) ?? [])) placaDe.set(`t${v.id}`, String(v.placa ?? ""));
    const out: CargaDeFacturaBD[] = [];
    for (let desde = 0; desde < 20_000; desde += 1000) {
      const { data, error: e } = await supabase.from("combustible").select("*")
        .ilike("observaciones", `%${MARCA_CARGA_DE_FACTURA}%`).order("id").range(desde, desde + 999);
      if (e) throw e;
      out.push(...((data as Fila[]) ?? []).map((r) => aCarga(r, placaDe)));
      if (!data || data.length < 1000) break;
    }
    return { cargas: out };
  } catch (e) {
    return { error: (e as { message?: string } | null)?.message ?? "error" };
  }
}

/** Las facturas que guarda la pestaña (radar_facturas) → lo que el motor necesita de cada una. */
function aFacturas(filas: Fila[] | null): FacturaConCargas[] {
  return (filas ?? []).filter((f) => Array.isArray(f.conciliacion)).map((f) => ({
    factura_id: Number(f.id), serie: (f.serie as string) ?? null, numero: (f.numero as string) ?? null,
    fecha_emision: f.fecha_emision ? String(f.fecha_emision).slice(0, 10) : null,
    recibido_en: (f.recibido_en as string) ?? null,
    lineas: Array.isArray(f.lineas) ? (f.lineas as FacturaConCargas["lineas"]) : [],
    conciliacion: f.conciliacion as FacturaConCargas["conciliacion"],
  }));
}

export default function CargasPorCompletar({ facturas, pendRadar, onConteo }: {
  /** Las facturas que ya leyó la pestaña: de ahí sale qué factura registró cada carga y cómo se fechó. */
  facturas: Fila[] | null;
  /**
   * Las recargas del Radar que siguen por revisar. Si una de esa placa cae a ±1 día de la carga —la
   * ventana con que el Radar reconoce la carga de una factura—, lo correcto es FUSIONARLA allá: trae el
   * km del tablero y la fecha del papel. Se dice; no se bloquea (puede ser otra carga).
   */
  pendRadar: RecargaPorRevisar[] | null;
  /** Cuántas quedan por completar (para el resumen de la pestaña). null = no se pudo saber. */
  onConteo?: (n: number | null) => void;
}) {
  const [cargas, setCargas] = useState<CargaDeFacturaBD[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verAntiguas, setVerAntiguas] = useState(false);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [entradas, setEntradas] = useState<Record<number, Entrada>>({});
  const [guardando, setGuardando] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ id: number; texto: string; ok: boolean } | null>(null);
  // Las lecturas de odómetro alrededor de la fecha de la carga abierta: el rango que la acota.
  const [lecturas, setLecturas] = useState<{ clave: string; filas: LecturaOdometroBD[] } | null>(null);
  const hoy = hoyLima();

  // Se vuelve a leer al cambiar las facturas (una lectura del correo pudo registrar cargas nuevas) y
  // después de completar una (`version`).
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let vivo = true;
    leerCargasDeFactura().then((r) => {
      if (!vivo) return;
      if ("error" in r) { setCargas(null); setError(r.error); } else { setCargas(r.cargas); setError(null); }
    });
    return () => { vivo = false; };
  }, [facturas, version]);
  const cargar = useCallback(() => setVersion((v) => v + 1), []);

  const origenes = useMemo(() => origenesDeCargas(aFacturas(facturas)), [facturas]);
  const cola = useMemo(() => (cargas ? colaPorCompletar(cargas, origenes, hoy) : null), [cargas, origenes, hoy]);
  useEffect(() => { onConteo?.(cola ? cola.cola.length : null); }, [cola, onConteo]);

  const entradaDe = (x: CargaPorCompletar): Entrada => entradas[x.carga.id] ?? {
    // La fecha se precarga con la que tiene la carga: es la que se está confirmando. El km NUNCA:
    // se escribe mirando el voucher, no se copia de ninguna parte.
    km: "", sinOdometro: false, fecha: x.carga.fecha, hora: "", conductor: "",
  };
  const poner = (x: CargaPorCompletar, cambio: Partial<Entrada>) =>
    setEntradas((prev) => ({ ...prev, [x.carga.id]: { ...entradaDe(x), ...cambio } }));

  // El rango de km: las lecturas de esa unidad ±5 días alrededor de la fecha elegida.
  const abiertaX = cola ? [...cola.cola, ...cola.antiguas].find((x) => x.carga.id === abierta) ?? null : null;
  const fechaAbierta = abiertaX ? entradaDe(abiertaX).fecha : null;
  const claveLect = abiertaX?.carga.vehiculo && fechaAbierta ? `${abiertaX.carga.vehiculo.flota}:${abiertaX.carga.vehiculo.id}:${fechaAbierta}` : null;
  useEffect(() => {
    if (!claveLect || !abiertaX?.carga.vehiculo || !fechaAbierta || !/^\d{4}-\d{2}-\d{2}$/.test(fechaAbierta)) return;
    let vivo = true;
    const fk = abiertaX.carga.vehiculo.flota === "tercero" ? "vehiculo_tercero_id" : "vehiculo_id";
    supabase.from("lecturas_odometro").select("*").eq(fk, abiertaX.carga.vehiculo.id)
      .gte("fecha", sumarDias(fechaAbierta, -5)).lte("fecha", sumarDias(fechaAbierta, 5)).order("fecha").limit(200)
      .then(({ data, error: e }: { data: unknown; error: unknown }) => {
        // Sin lecturas (o sin poder leerlas) no hay rango: la pantalla lo dice y nada se bloquea.
        if (vivo) setLecturas({ clave: claveLect, filas: e ? [] : ((data as LecturaOdometroBD[]) ?? []) });
      });
    return () => { vivo = false; };
    // La búsqueda depende solo de la unidad y la fecha (la clave).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveLect]);
  const rango: RangoKmDelDia | null = abiertaX && fechaAbierta && lecturas?.clave === claveLect
    ? rangoKmDelDia(lecturas.filas, fechaAbierta, entradaDe(abiertaX).hora || null) : null;

  async function completar(x: CargaPorCompletar) {
    const e = entradaDe(x);
    setGuardando(x.carga.id); setMsg(null);
    try {
      // La carga RECIÉN leída: si alguien la tocó (o el Radar la fusionó) mientras tanto, el plan lo ve.
      const { data: fila, error: eF } = await supabase.from("combustible").select("*").eq("id", x.carga.id).maybeSingle();
      if (eF) throw eF;
      if (!fila) throw new Error(`la carga #${x.carga.id} ya no existe`);
      const placaDe = new Map<string, string>();
      if (x.carga.vehiculo && x.carga.placa) placaDe.set(`${x.carga.vehiculo.flota === "tercero" ? "t" : "p"}${x.carga.vehiculo.id}`, x.carga.placa);
      const carga = aCarga(fila as Fila, placaDe);
      const plan = planDeCompletar(carga, x.origen, {
        km: e.km.trim() === "" ? null : Number(e.km), sinOdometro: e.sinOdometro, fecha: e.fecha || null,
        hora: e.hora || null, conductor: e.conductor || null,
      }, hoy, rango);
      if (!plan.puede) { setMsg({ id: x.carga.id, texto: plan.detalle, ok: false }); return; }
      const ok = window.confirm(
        `Completar la carga #${carga.id} (${carga.placa ?? "—"}, ${S(carga.total)}), que registró la factura ${x.comprobante ?? ""} sin su voucher:\n\n` +
        (plan.cambios.length ? plan.cambios.map((c) => `• ${c.campo}: ${c.de} → ${c.a}`).join("\n") : "• Se confirma tal como está.") +
        "\n\nLos galones, el precio y el importe quedan los de la factura." +
        (plan.avisos.length ? `\n\n⚠ ${plan.avisos.join("\n⚠ ")}` : "") + "\n\n¿Seguir?",
      );
      if (!ok) return;
      const { data: upd, error: eU } = await supabase.from("combustible")
        .update(plan.patch).eq("id", carga.id).eq("fecha", carga.fecha).select("id");
      if (eU) throw eU;
      if (!((upd as unknown[]) ?? []).length) throw new Error(`la carga #${carga.id} cambió mientras tanto: vuelve a abrirla`);
      // El odómetro, por la misma puerta que el resto del ERP. La carga —el gasto— ya quedó escrita: un
      // fallo aquí se DICE, no deshace nada.
      let nota = "";
      if (plan.lectura && carga.vehiculo) {
        try {
          const r = await registrarLectura(supabase, {
            vehiculo_id: carga.vehiculo.id, flota: carga.vehiculo.flota, km: plan.lectura.km, fuente: "combustible",
            fecha: plan.lectura.fecha,
            // Con la hora del voucher la lectura es exacta; sin ella, solo la fecha (se ubica en su día).
            capturado_en: plan.lectura.hora ? capturaDeFechaHora(plan.lectura.fecha, plan.lectura.hora) : null,
            horaEsTope: false,
            ref_origen: "factura_completada",
            // Por CARGA: un reintento (o un doble clic) no deja dos lecturas del mismo despacho.
            idemKey: `factura_completada_odo:${carga.id}`,
          });
          nota = !r.ok ? ` · el odómetro no se pudo registrar (${r.error ?? r.motivo ?? "error"})`
            : r.duplicada ? " · el odómetro ya estaba en el historial (no se registró otra vez)"
            : r.estado !== "aceptada" ? ` · el odómetro quedó por revisar en Mantenimiento → Odómetro: ${r.motivo ?? r.estado}` : "";
        } catch {
          nota = " · el odómetro no se pudo registrar";
        }
      } else if (plan.lectura && !carga.vehiculo) {
        nota = " · la carga no tiene unidad: el odómetro quedó en la carga, pero no en el historial de la unidad";
      }
      setMsg({ id: carga.id, texto: `Carga #${carga.id} completada${plan.cambios.length ? `: ${plan.cambios.map((c) => c.campo.toLowerCase()).join(", ")}` : ""}${nota}.`, ok: !nota });
      setAbierta(null);
      cargar();
    } catch (err) {
      setMsg({ id: x.carga.id, texto: `No se pudo completar: ${(err as { message?: string } | null)?.message ?? "error"}`, ok: false });
    } finally {
      setGuardando(null);
    }
  }

  if (error) {
    return <div className="rounded-xl border bg-white p-4 text-xs text-gray-500">No se pudieron leer las cargas por completar ({error}).</div>;
  }
  if (!cola) return null;
  const lista = verAntiguas ? [...cola.antiguas, ...cola.cola] : cola.cola;
  if (!cola.cola.length && !cola.antiguas.length) return null;

  return (
    <div className="rounded-xl border p-4 space-y-3" style={cola.cola.length ? { background: "#fffbeb", borderColor: "#fcd34d" } : { background: "#fff", borderColor: "#e5e7eb" }}>
      <div className="text-sm text-amber-900">
        <b>✍ {cola.cola.length ? `${cola.cola.length} carga(s) registradas desde la factura esperan su odómetro y su fecha` : "Ninguna carga reciente por completar"}</b>
        {cola.cola.length > 0 && <> — las de los últimos {DIAS_REGISTRO_AUTOMATICO} días que entraron por la factura sin que el Radar leyera su voucher.</>}
      </div>
      {cola.cola.length > 0 && (
        <div className="text-xs text-gray-700">
          La factura no trae el odómetro ni la fecha del despacho. Pon el <b>km del voucher</b> (lo tiene el conductor; si lo mandó al grupo de WhatsApp,
          búscalo por su nota) y <b>confirma la fecha</b>: se precarga la deducida de la emisión. Si el voucher se perdió, marca <b>«No hay odómetro»</b>:
          sale de la lista sin inventar un número. Si después el Radar lee ese voucher, propone <b>fusionarlo</b> con la carga y no la duplica.
        </div>
      )}
      {cola.antiguas.length > 0 && (
        <button onClick={() => setVerAntiguas(!verAntiguas)} className="text-xs text-[#1d4ed8] font-bold hover:underline">
          {verAntiguas ? "Ocultar" : "Ver"} también {cola.antiguas.length} más antiguas (de hace más de {DIAS_REGISTRO_AUTOMATICO} días: no se piden)
        </button>
      )}
      <div className="space-y-1.5">
        {lista.map((x) => {
          const c = x.carga;
          const cfg = configCombustible(c.tipo_combustible);
          const e = entradaDe(x);
          const abiertaEsta = abierta === c.id;
          const kmTec = e.km.trim() === "" ? null : Number(e.km);
          const fuera = abiertaEsta && kmTec && kmTec > 0 ? kmFueraDelRango(Math.round(kmTec), rango) : null;
          const vieja = c.fecha < sumarDias(hoy, -DIAS_REGISTRO_AUTOMATICO);
          const enRadar = pendRadar ? pendientesCerca({ placa: c.placa, fecha: c.fecha }, pendRadar, 1) : [];
          return (
            <div key={c.id} className="rounded-lg border bg-white text-xs">
              <button onClick={() => { setAbierta(abiertaEsta ? null : c.id); setMsg(null); }}
                className="w-full text-left p-2 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-gray-50">
                <span className="font-bold">{F(c.fecha)}</span>
                <span className="font-mono font-black text-[#0b315f]">{c.placa ?? "sin unidad"}</span>
                <span>{cfg.icon} {cfg.labelCorto} {c.galones ?? "—"} {cfg.unidadLabel}</span>
                <span className="font-bold">{S(c.total)}</span>
                {x.comprobante && <span className="font-mono text-gray-500">{x.comprobante}</span>}
                {x.nota_despacho && <span className="font-mono text-gray-500">Nota {x.nota_despacho}</span>}
                {x.falta_km && <span className="px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800">falta el km</span>}
                {x.falta_fecha && <span className="px-2 py-0.5 rounded-full font-bold bg-blue-100 text-blue-800">fecha por confirmar</span>}
                {vieja && <span className="px-2 py-0.5 rounded-full font-bold bg-gray-100 text-gray-600">historial</span>}
                {enRadar.length > 0 && <span className="px-2 py-0.5 rounded-full font-bold bg-indigo-100 text-indigo-800">🔗 voucher por revisar en el Radar</span>}
                <span className="ml-auto text-gray-400">{abiertaEsta ? "▲" : "▼"}</span>
              </button>
              {abiertaEsta && (
                <div className="border-t p-2 space-y-2">
                  {enRadar.length > 0 && (
                    <div className="text-[#1e3a8a] bg-[#eff6ff] border border-[#93c5fd] rounded px-2 py-1.5">
                      🔗 En el Radar hay {enRadar.length} recarga(s) de {c.placa} por revisar del {enRadar.slice(0, 3).map((r) => F(r.fecha)).join(", ")}.
                      Si una es esta carga, <b>fusiónala allá</b> en vez de completarla aquí: trae el km del tablero y la fecha del voucher.{" "}
                      <Link href="/radar-ia?tab=combustible" className="font-bold hover:underline">Ir a Radar IA →</Link>
                    </div>
                  )}
                  <div className="text-gray-600">{x.por_que_fecha}</div>
                  <div className="flex flex-wrap items-end gap-2">
                    {x.falta_km ? (
                      <label className="flex flex-col gap-0.5">
                        <span className="text-gray-500">Odómetro del voucher</span>
                        <input type="number" inputMode="numeric" min={1} value={e.km} disabled={e.sinOdometro}
                          onChange={(ev) => poner(x, { km: ev.target.value })} placeholder="km"
                          className="border rounded px-2 py-1 w-32 disabled:bg-gray-100" />
                      </label>
                    ) : (
                      <span className="text-gray-600 self-center">Odómetro: <b>{fmtKm(Number(c.kilometraje))}</b> (ya lo tiene)</span>
                    )}
                    {x.falta_km && (
                      <label className="flex items-center gap-1 self-center">
                        <input type="checkbox" checked={e.sinOdometro} onChange={(ev) => poner(x, { sinOdometro: ev.target.checked, km: ev.target.checked ? "" : e.km })} />
                        No hay odómetro
                      </label>
                    )}
                    <label className="flex flex-col gap-0.5">
                      <span className="text-gray-500">Fecha del despacho</span>
                      <input type="date" value={e.fecha} max={x.origen?.fecha_emision ?? hoy} onChange={(ev) => poner(x, { fecha: ev.target.value })} className="border rounded px-2 py-1" />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-gray-500">Hora (opcional)</span>
                      <input type="time" value={e.hora} onChange={(ev) => poner(x, { hora: ev.target.value })} className="border rounded px-2 py-1" />
                    </label>
                    {!String(c.conductor ?? "").trim() && (
                      <label className="flex flex-col gap-0.5">
                        <span className="text-gray-500">Conductor (opcional)</span>
                        <input type="text" value={e.conductor} onChange={(ev) => poner(x, { conductor: ev.target.value })} className="border rounded px-2 py-1 w-44" />
                      </label>
                    )}
                    <button onClick={() => completar(x)} disabled={guardando != null || (x.falta_km && !e.sinOdometro && e.km.trim() === "") || !e.fecha}
                      className="px-3 py-1.5 rounded font-bold text-white disabled:opacity-50" style={{ background: "#b45309" }}>
                      {guardando === c.id ? "Guardando…" : "Completar"}
                    </button>
                  </div>
                  {/* El rango de ese día: REFERENCIA. Nunca un «usar este»: copiar el km del check-out sería
                      fabricar una lectura que nadie tomó. */}
                  {c.vehiculo && (
                    <div className="text-gray-600">
                      {!rango ? "Buscando las lecturas de odómetro de esa unidad…" : !rango.antes && !rango.despues && !rango.delDia.length
                        ? "No hay lecturas de odómetro de esa unidad cerca de esa fecha."
                        : <>
                            Lecturas de esa unidad:
                            {rango.antes && <> antes, <b>{fmtKm(rango.antes.km)}</b> ({rango.antes.etiqueta}, {F(rango.antes.fecha)}{rango.antes.hora ? ` ${rango.antes.hora}` : ""});</>}
                            {rango.delDia.length > 0 && <> ese día, {rango.delDia.map((l) => `${fmtKm(l.km)} (${l.etiqueta}${l.hora ? ` ${l.hora}` : ""})`).join(", ")};</>}
                            {rango.despues && <> después, <b>{fmtKm(rango.despues.km)}</b> ({rango.despues.etiqueta}, {F(rango.despues.fecha)}{rango.despues.hora ? ` ${rango.despues.hora}` : ""}).</>}
                            {" "}El km del voucher tiene que caer entre la anterior y la posterior.
                          </>}
                    </div>
                  )}
                  {fuera && <div className="text-amber-800 font-semibold">⚠ {fuera} Se guarda igual, y la lectura queda por revisar en Mantenimiento → Odómetro.</div>}
                  {!c.vehiculo && <div className="text-amber-800">Esta carga no tiene unidad: corrígela primero en el Historial de Combustible.</div>}
                  {msg?.id === c.id && <div className={msg.ok ? "text-green-700 font-semibold" : "text-red-700 font-semibold"}>{msg.texto}</div>}
                </div>
              )}
              {!abiertaEsta && msg?.id === c.id && <div className={`px-2 pb-2 ${msg.ok ? "text-green-700" : "text-red-700"} font-semibold`}>{msg.texto}</div>}
            </div>
          );
        })}
      </div>
      {msg && !lista.some((x) => x.carga.id === msg.id) && (
        <div className={`text-xs font-semibold ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.texto}{" "}
          {msg.ok && <Link href="/mantenimiento" className="text-[#1d4ed8] hover:underline">Ver el odómetro en Mantenimiento →</Link>}
        </div>
      )}
    </div>
  );
}
