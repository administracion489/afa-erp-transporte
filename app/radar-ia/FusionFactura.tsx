// app/radar-ia/FusionFactura.tsx — «Es la misma recarga que entró desde la FACTURA»: en vez de
// descartar el voucher, se FUSIONA con esa carga (lib/radar/fusion-factura.ts, puro).
//
// El Radar marcaba «posible duplicado» y mandaba a descartar la fila, y con ella se iba lo único que
// la factura no tiene: la fecha del DESPACHO (la factura lleva la de emisión, al día siguiente en el
// lote nocturno de COESTI), el odómetro, el conductor y la nota de despacho. Aquí se busca la carga
// con la MISMA regla con que el Radar la encontró (buscarCargaRegistrada) y se enseña, ANTES del
// clic, qué toma esa carga del voucher y qué se queda como está. Escribe la página (onFusionar).
"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { buscarCargaRegistrada, patronComprobante, type CargaRegistrada } from "@/lib/radar/album-recargas";
import { esCargaDeFactura } from "@/lib/combustible/factura-lineas";
import { planDeFusion, type CargaDeFactura, type VoucherAFusionar } from "@/lib/radar/fusion-factura";
import type { RadarCombustible } from "@/lib/radar/tipos";

const sumar = (f: string, n: number) => new Date(Date.parse(`${f}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const F = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

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

/**
 * La carga de la factura que es esta recarga, o null. Misma consulta y misma regla que la acción del
 * Radar (lib/radar/acciones.ts): de esa unidad ±1 día, y por comprobante de cualquier unidad.
 */
export async function buscarCargaDeFactura(
  unidad: { tipo: "propio" | "tercero"; id: number } | null,
  v: { fecha: string | null; comprobante: string | null; monto: number | null },
): Promise<CargaDeFactura | null> {
  const filas = new Map<string, Record<string, unknown>>();
  const col = unidad?.tipo === "tercero" ? "vehiculo_tercero_id" : "vehiculo_id";
  if (unidad && v.fecha && v.monto != null) {
    const { data } = await supabase.from("combustible").select("*")
      .eq(col, unidad.id).gte("fecha", sumar(v.fecha, -1)).lte("fecha", sumar(v.fecha, 1));
    for (const r of (data as Record<string, unknown>[]) ?? []) filas.set(String(r.id), r);
  }
  const patron = patronComprobante(v.comprobante);
  if (patron) {
    const { data } = await supabase.from("combustible").select("*").ilike("observaciones", patron).limit(50);
    for (const r of (data as Record<string, unknown>[]) ?? []) filas.set(String(r.id), r);
  }
  const candidatas: CargaRegistrada[] = [...filas.values()].map((r) => ({
    id: Number(r.id), fecha: r.fecha == null ? null : String(r.fecha).slice(0, 10),
    total: r.total == null ? null : Number(r.total), observaciones: (r.observaciones as string) ?? null,
    misma_unidad: !!unidad && Number(r[col]) === unidad.id,
  }));
  const hallada = buscarCargaRegistrada({ fecha: v.fecha, comprobante: v.comprobante, monto: v.monto }, candidatas);
  const fila = hallada ? filas.get(String(hallada.id)) : undefined;
  return fila && esCargaDeFactura(fila.observaciones as string) ? aCargaDeFactura(fila) : null;
}

export default function FusionFactura({ c, unidad, voucher, ocupado, onFusionar }: {
  c: RadarCombustible;
  unidad: { tipo: "propio" | "tercero"; id: number } | null;
  voucher: VoucherAFusionar;
  ocupado: boolean;
  onFusionar: (cargaId: number) => void;
}) {
  // El resultado lleva la clave con que se buscó: si la persona cambia la unidad, la fecha o el
  // importe, lo de antes ya no describe esta búsqueda y se dice «buscando» hasta que llegue lo nuevo.
  const [res, setRes] = useState<{ clave: string; carga: CargaDeFactura | null } | null>(null);
  const clave = `${c.id}|${unidad?.tipo}:${unidad?.id}|${voucher.fecha}|${voucher.comprobante}|${voucher.monto}`;
  useEffect(() => {
    let vivo = true;
    buscarCargaDeFactura(unidad, voucher)
      .then((x) => { if (vivo) setRes({ clave, carga: x }); })
      .catch(() => { if (vivo) setRes({ clave, carga: null }); });
    return () => { vivo = false; };
    // La búsqueda depende solo de unidad, fecha, comprobante e importe (la clave).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);
  const carga = res && res.clave === clave ? res.carga : undefined;

  if (carga === undefined) return <p className="text-[11px] text-gray-500 mt-2">Buscando la carga de la factura…</p>;
  if (!carga) return null;
  const plan = planDeFusion(carga, voucher);
  return (
    <div className={`mt-3 rounded-xl border p-3 text-xs space-y-1.5 ${plan.puede ? "border-[#93c5fd] bg-[#eff6ff]" : "border-[#F2C94C] bg-[#FFF8E1]"}`}>
      <p className={`font-black ${plan.puede ? "text-[#1e3a8a]" : "text-[#7a5a00]"}`}>
        🔗 Es la carga #{carga.id} que entró desde la factura del correo ({F(carga.fecha)}{carga.total != null ? `, S/ ${carga.total.toFixed(2)}` : ""}).
      </p>
      <p className="text-gray-700">{plan.detalle}</p>
      {plan.puede && plan.cambios.length > 0 && (
        <ul className="text-gray-700 space-y-0.5">
          {plan.cambios.map((x) => (
            <li key={x.campo}>• <b>{x.campo}:</b> {x.de} → <b>{x.a}</b></li>
          ))}
        </ul>
      )}
      {plan.avisos.map((a) => <p key={a} className="text-[#B07A0F] font-semibold">⚠ {a}</p>)}
      {plan.puede && (
        <button
          onClick={() => onFusionar(carga.id)}
          disabled={ocupado}
          className="mt-1 px-3 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-50"
          style={{ background: "#1d4ed8" }}
        >
          {ocupado ? "Fusionando…" : `🔗 Fusionar con la carga #${carga.id}`}
        </button>
      )}
    </div>
  );
}
