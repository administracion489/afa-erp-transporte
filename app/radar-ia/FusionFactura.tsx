// app/radar-ia/FusionFactura.tsx — ¿Esta recarga ya está en Combustible? Si es así, en vez de descartar
// el voucher se FUSIONA con esa carga (lib/radar/fusion-factura.ts, puro), en uno de dos modos:
//   • la carga entró desde la FACTURA del correo y todavía no tiene su voucher → toma del voucher la
//     fecha del despacho, el odómetro, el conductor y la nota (modo «factura»);
//   • la registró el Radar de otro reporte, una persona, o es de factura ya fusionada → esta fila queda
//     ENLAZADA a la carga (sus fotos pasan a ser evidencia de ella) y la carga toma lo que le falta, sin
//     mover su fecha (modo «sumar»).
//
// El Radar marcaba «posible duplicado» y mandaba a descartar la fila, y con ella se iba lo que la otra
// carga no tiene: la fecha del DESPACHO (la factura lleva la de emisión), el odómetro, el conductor, y
// las fotos del tablero y del surtidor. Aquí se busca la carga con la MISMA regla con que el Radar la
// encontró (buscarCargaRegistrada) y se enseña, ANTES del clic, lo que ya tiene la carga al lado de lo
// que trae esta fila. Si no se encontró por la nota de despacho —misma unidad, día e importe— quien
// revisa marca que comparó las fotos antes de poder fusionar. Escribe la página (onFusionar).
//
// SE PREGUNTA EN CADA FILA POR REVISAR, no solo en las que el Radar marcó al procesarlas: la factura
// puede registrar la carga DESPUÉS, mientras la recarga sigue esperando revisión, y entonces la fila
// no lo sabía. `comprobarEnCombustible` es también lo que consulta el botón «Registrar» justo antes
// de insertar.
"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { patronComprobante, type CargaRegistrada } from "@/lib/radar/album-recargas";
import {
  planDeFusion, yaEstaEnCombustible,
  type CargaDeFactura, type VoucherAFusionar, type YaEstaEnCombustible,
} from "@/lib/radar/fusion-factura";
import { fotosPorCarga, type FilaConFotos, type FotoLeida, type MediaDeMensaje } from "@/lib/radar/fotos-lectura";
import { notasEnTexto } from "@/lib/combustible/factura-lineas";
import { ImgPrivada, EnlacePrivado } from "@/components/ArchivoPrivado";
import type { RadarCombustible } from "@/lib/radar/tipos";

const sumar = (f: string, n: number) => new Date(Date.parse(`${f}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const F = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const S = (n: number | null | undefined) => (n == null ? "—" : `S/ ${Number(n).toFixed(2)}`);
const K = (n: number | null | undefined) => (n != null && n > 0 ? `${Math.round(n).toLocaleString("es-PE")} km` : "sin odómetro");

/** La carga de `combustible` tal como la necesita el planificador. */
export const aCargaDeFactura = (r: Record<string, unknown>): CargaDeFactura => ({
  id: Number(r.id),
  fecha: String(r.fecha ?? "").slice(0, 10),
  total: r.total == null ? null : Number(r.total),
  galones: r.galones == null ? null : Number(r.galones),
  kilometraje: r.kilometraje == null ? null : Number(r.kilometraje),
  conductor: (r.conductor as string) ?? null,
  grifo: (r.grifo as string) ?? null,
  observaciones: (r.observaciones as string) ?? null,
  tanque_lleno: r.tanque_lleno == null ? null : Boolean(r.tanque_lleno),
});

export type Comprobacion = { veredicto: YaEstaEnCombustible; fila: Record<string, unknown> | null };

/**
 * ¿La recarga ya está en Combustible? Misma consulta y misma regla que la acción del Radar
 * (lib/radar/acciones.ts): de esa unidad ±1 día, y por comprobante de cualquier unidad. Si la base no
 * contesta, el veredicto es `sin_comprobar` — nunca «libre» por una lista vacía.
 */
export async function comprobarEnCombustible(
  unidad: { tipo: "propio" | "tercero"; id: number } | null,
  v: { fecha: string | null; comprobante: string | null; monto: number | null },
): Promise<Comprobacion> {
  const filas = new Map<string, Record<string, unknown>>();
  const col = unidad?.tipo === "tercero" ? "vehiculo_tercero_id" : "vehiculo_id";
  try {
    if (unidad && v.fecha && v.monto != null) {
      const { data, error } = await supabase.from("combustible").select("*")
        .eq(col, unidad.id).gte("fecha", sumar(v.fecha, -1)).lte("fecha", sumar(v.fecha, 1));
      if (error) throw error;
      for (const r of (data as Record<string, unknown>[]) ?? []) filas.set(String(r.id), r);
    }
    const patron = patronComprobante(v.comprobante);
    if (patron) {
      const { data, error } = await supabase.from("combustible").select("*").ilike("observaciones", patron).limit(50);
      if (error) throw error;
      for (const r of (data as Record<string, unknown>[]) ?? []) filas.set(String(r.id), r);
    }
  } catch (e) {
    const motivo = (e as { message?: string } | null)?.message ?? null;
    return { veredicto: yaEstaEnCombustible(v, null, motivo), fila: null };
  }
  const candidatas: CargaRegistrada[] = [...filas.values()].map((r) => ({
    id: Number(r.id), fecha: r.fecha == null ? null : String(r.fecha).slice(0, 10),
    total: r.total == null ? null : Number(r.total), observaciones: (r.observaciones as string) ?? null,
    misma_unidad: !!unidad && Number(r[col]) === unidad.id,
  }));
  const veredicto = yaEstaEnCombustible(v, candidatas);
  return { veredicto, fila: veredicto.id != null ? filas.get(String(veredicto.id)) ?? null : null };
}

/** Lo que la carga YA tiene del Radar: las fotos de sus filas enlazadas y sus notas de despacho. */
type Evidencia = { cargaId: number; fotos: FotoLeida[]; notas: string[] };

async function evidenciaDeCarga(cargaId: number): Promise<Evidencia> {
  const vacia: Evidencia = { cargaId, fotos: [], notas: [] };
  try {
    const { data, error } = await supabase.from("radar_combustible").select("*").eq("combustible_id", cargaId);
    if (error) return vacia;
    const filas = ((data as (FilaConFotos & { comprobante?: string | null })[]) ?? []);
    // Las filas viejas (sin `fotos`) solo tienen la media de su mensaje: se piden esas, y nada más.
    const sinFotos = filas.filter((f) => !(f.fotos ?? []).some((x) => x?.url) && f.mensaje_id).map((f) => f.mensaje_id as string);
    const media: Record<string, MediaDeMensaje> = {};
    if (sinFotos.length) {
      const { data: ms } = await supabase.from("radar_mensajes").select("id, media_url, media_mime, media_nombre").in("id", sinFotos);
      for (const m of ((ms as (MediaDeMensaje & { id: string })[]) ?? [])) media[m.id] = m;
    }
    return { cargaId, fotos: fotosPorCarga(filas, media)[cargaId] ?? [], notas: filas.map((f) => f.comprobante ?? "").filter(Boolean) };
  } catch {
    return vacia;
  }
}

export default function FusionFactura({ c, unidad, voucher, ocupado, onFusionar, silencioso }: {
  c: RadarCombustible;
  unidad: { tipo: "propio" | "tercero"; id: number } | null;
  voucher: VoucherAFusionar;
  ocupado: boolean;
  onFusionar: (cargaId: number) => void;
  /** Sin «Buscando…» mientras consulta: la fila no traía `posible_duplicado` y lo normal es que no haya nada. */
  silencioso?: boolean;
}) {
  // El resultado lleva la clave con que se buscó: si la persona cambia la unidad, la fecha o el
  // importe, lo de antes ya no describe esta búsqueda y se dice «buscando» hasta que llegue lo nuevo.
  const [res, setRes] = useState<{ clave: string; r: Comprobacion } | null>(null);
  const clave = `${c.id}|${unidad?.tipo}:${unidad?.id}|${voucher.fecha}|${voucher.comprobante}|${voucher.monto}`;
  useEffect(() => {
    let vivo = true;
    comprobarEnCombustible(unidad, voucher).then((r) => { if (vivo) setRes({ clave, r }); });
    return () => { vivo = false; };
    // La búsqueda depende solo de unidad, fecha, comprobante e importe (la clave).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);
  const r = res && res.clave === clave ? res.r : undefined;

  // Lo que la carga encontrada ya tiene del Radar (sus fotos, sus notas): para comparar ANTES de fusionar.
  const cargaId = r?.fila ? Number(r.fila.id) : null;
  const [evidencia, setEvidencia] = useState<Evidencia | null>(null);
  useEffect(() => {
    if (cargaId == null) return;
    let vivo = true;
    evidenciaDeCarga(cargaId).then((e) => { if (vivo) setEvidencia(e); });
    return () => { vivo = false; };
  }, [cargaId]);
  const ev = evidencia && evidencia.cargaId === cargaId ? evidencia : null;

  // Quien revisa confirma que comparó, cuando la carga no se encontró por la nota de despacho. Se
  // reinicia al cambiar de carga: lo que se verificó era otra.
  const [verificada, setVerificada] = useState<number | null>(null);

  if (r === undefined) return silencioso ? null : <p className="text-[11px] text-gray-500 mt-2">Buscando si ya está en Combustible…</p>;
  const v = r.veredicto;
  if (v.codigo === "libre") return null;
  if (v.codigo === "sin_comprobar" || !r.fila) {
    // No se pudo comprobar: se dice, y el botón «Registrar» vuelve a preguntar antes de insertar.
    return (
      <div className="mt-3 rounded-xl border border-[#F2C94C] bg-[#FFF8E1] p-3 text-xs">
        <p className="font-black text-[#7a5a00]">⚠ {v.codigo === "sin_comprobar" ? "No se pudo comprobar" : "Ya está en Combustible"}</p>
        <p className="text-[#6b5310] mt-1">{v.detalle}</p>
      </div>
    );
  }
  const carga: CargaDeFactura = { ...aCargaDeFactura(r.fila), notas: ev?.notas ?? null };
  const plan = planDeFusion(carga, voucher);
  const sumar_ = plan.modo === "sumar";
  const porNota = v.por === "comprobante";
  const listo = plan.puede && (porNota || verificada === carga.id);
  const notasCarga = [...new Set([...notasEnTexto(String(carga.observaciones ?? "")), ...(ev?.notas ?? [])])];
  const fotosFila = (c.fotos ?? []).filter((f) => f?.url).length;
  const filaComp: [string, string, string][] = [
    ["Fecha", F(carga.fecha), F(voucher.fecha)],
    ["Odómetro", K(carga.kilometraje), K(voucher.kilometraje)],
    ["Cantidad", carga.galones != null ? String(carga.galones) : "—", voucher.cantidad != null ? String(voucher.cantidad) : "—"],
    ["Importe", S(carga.total), S(voucher.monto)],
    ["Nota de despacho", notasCarga.join(", ") || "—", voucher.comprobante ?? "—"],
    ["Conductor", carga.conductor ?? "—", voucher.conductor ?? "—"],
  ];
  return (
    <div className={`mt-3 rounded-xl border p-3 text-xs space-y-2 ${plan.puede ? "border-[#93c5fd] bg-[#eff6ff]" : "border-[#F2C94C] bg-[#FFF8E1]"}`}>
      <p className={`font-black ${plan.puede ? "text-[#1e3a8a]" : "text-[#7a5a00]"}`}>
        🔗 Es la carga #{carga.id} {sumar_ ? "que ya está en Combustible" : "que entró desde la factura del correo"} ({F(carga.fecha)}{carga.total != null ? `, S/ ${carga.total.toFixed(2)}` : ""}).
      </p>
      <p className="text-gray-700">{plan.detalle}</p>

      {/* LO QUE YA TIENE LA CARGA, al lado de lo que trae esta fila: para verificar sin salir de aquí. */}
      {sumar_ && (
        <div className="rounded-lg border border-[#bfdbfe] bg-white overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-[#f8fafc] text-gray-500">
              <tr><th className="p-1.5 text-left"></th><th className="p-1.5 text-left">Carga #{carga.id} (ya en Combustible)</th><th className="p-1.5 text-left">Esta fila (por revisar)</th></tr>
            </thead>
            <tbody>
              {filaComp.map(([campo, a, b]) => (
                <tr key={campo} className="border-t border-gray-100">
                  <td className="p-1.5 font-bold text-gray-500">{campo}</td>
                  <td className="p-1.5">{a}</td>
                  <td className={`p-1.5 ${a !== b && b !== "—" ? "font-bold text-[#1e3a8a]" : ""}`}>{b}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-100 align-top">
                <td className="p-1.5 font-bold text-gray-500">Fotos</td>
                <td className="p-1.5">
                  {ev == null ? "buscando…" : ev.fotos.length === 0 ? "ninguna del Radar" : (
                    <div className="flex flex-wrap gap-1.5">
                      {ev.fotos.map((f, i) => (
                        <EnlacePrivado key={f.url} href={f.url} target="_blank" rel="noreferrer" title={f.nombre ?? `Foto ${i + 1}`}>
                          <ImgPrivada src={f.url} alt={f.nombre ?? `Foto ${i + 1} de la carga`} className="h-14 w-14 object-cover rounded-lg border border-gray-200" />
                        </EnlacePrivado>
                      ))}
                    </div>
                  )}
                </td>
                <td className="p-1.5">{fotosFila ? `${fotosFila} (las de arriba): pasan a la carga` : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {plan.puede && plan.cambios.length > 0 && (
        <ul className="text-gray-700 space-y-0.5">
          {plan.cambios.map((x) => (
            <li key={x.campo}>• <b>{x.campo}:</b> {x.de} → <b>{x.a}</b></li>
          ))}
        </ul>
      )}
      {plan.avisos.map((a) => <p key={a} className="text-[#B07A0F] font-semibold">⚠ {a}</p>)}
      {/* Sin la nota de despacho que lo pruebe, la persona dice que comparó: misma unidad, día e importe
          también son dos recargas de S/ 100 el mismo día. */}
      {plan.puede && !porNota && (
        <label className="flex items-start gap-2 text-gray-800 font-semibold">
          <input type="checkbox" className="mt-0.5" checked={verificada === carga.id} onChange={(e) => setVerificada(e.target.checked ? carga.id : null)} />
          Comparé las fotos y los datos: es la misma recarga (la encontré por {v.por === "factura" ? "unidad e importe, con un día de diferencia" : "unidad, día e importe"}, sin una nota de despacho que lo pruebe).
        </label>
      )}
      {plan.puede && (
        <button
          onClick={() => onFusionar(carga.id)}
          disabled={ocupado || !listo}
          title={!listo ? "Primero compara las fotos y marca la casilla." : undefined}
          className="mt-1 px-3 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-50"
          style={{ background: "#1d4ed8" }}
        >
          {ocupado ? "Fusionando…" : sumar_ ? `📎 Fusionar con la carga #${carga.id} (sumar sus fotos)` : `🔗 Fusionar con la carga #${carga.id}`}
        </button>
      )}
      {sumar_ && <p className="text-[11px] text-gray-500">Si esta fila no aporta nada que la carga no tenga, también puedes descartarla. Si es OTRA recarga, regístrala: el botón te pedirá confirmarlo.</p>}
    </div>
  );
}
