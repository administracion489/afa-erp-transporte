"use client";
// ──────────────────────────────────────────────────────────────────────────────
// ModalPrecios — cargar el PRECIO DE VENTA sin salir de Liquidaciones.
//
// Es el espejo, del lado cliente, de components/pactos/ModalCostos. Faltaba, y esa
// asimetría costó un cierre: una ruta con sesenta servicios de agosto no salió en la
// valorización porque nadie le había cargado la tarifa, el bloque rojo decía "Sin
// precio de venta" en ocho filas recortadas de sesenta, y arreglarlo obligaba a ir a
// Programación servicio por servicio.
//
// Dos decisiones del dominio que este modal respeta:
//
//   · Se cobra POR RUTA, no por servicio. Un mes son 20 o 30 viajes de la misma ruta
//     a la misma tarifa, así que se teclea un importe y se aplica a todos.
//   · La tarifa va en la IDA y el RETORNO queda en S/ 0.00. AFA cobra un solo importe
//     por los dos tramos del día (ver lib/liquidacion-agrupacion.ts): cargar el precio
//     en los dos facturaría el doble. Por eso aquí solo se listan las idas — y los
//     tramos sueltos que no tienen par en el periodo.
// ──────────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { nombreRuta, sentidoDeReserva, type ReservaLiq } from "@/lib/liquidacion-agrupacion";

export type ReservaSinPrecio = ReservaLiq & { clienteNombre?: string };

type GrupoRuta = {
  clave: string;
  cliente: string;
  ruta: string;
  /** Solo los tramos a los que se les va a escribir el importe. */
  filas: ReservaSinPrecio[];
  /** Los retornos que quedan cubiertos por esa misma tarifa, para poder decirlo. */
  cubiertos: number;
  desde: string;
  hasta: string;
};

const LOTE = 200;

export default function ModalPrecios({
  reservas, onCerrar, onGuardado,
}: {
  reservas: ReservaSinPrecio[];
  onCerrar: () => void;
  onGuardado: (servicios: number) => void;
}) {
  const [montos, setMontos] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");

  const grupos = useMemo<GrupoRuta[]>(() => {
    // Los retornos que viajan con una ida presente en la lista NO reciben importe:
    // los cubre la tarifa del par.
    const ids = new Set(reservas.map((r) => r.id));
    const conPar = (r: ReservaSinPrecio) =>
      !!r.reserva_vinculada_id && ids.has(Number(r.reserva_vinculada_id));

    const cobran = reservas.filter((r) => sentidoDeReserva(r) === "IDA" || !conPar(r));
    const cubiertos = reservas.length - cobran.length;

    const mapa = new Map<string, GrupoRuta>();
    for (const r of cobran) {
      const ruta = nombreRuta(r);
      const cliente = r.clienteNombre ?? "—";
      const clave = `${cliente}|${ruta}`;
      const f = String(r.fecha_servicio ?? "");
      const g = mapa.get(clave) ?? { clave, cliente, ruta, filas: [], cubiertos: 0, desde: f, hasta: f };
      g.filas.push(r);
      if (f && (!g.desde || f < g.desde)) g.desde = f;
      if (f && (!g.hasta || f > g.hasta)) g.hasta = f;
      mapa.set(clave, g);
    }
    const salida = [...mapa.values()].sort((a, b) => a.ruta.localeCompare(b.ruta));
    // El total de tramos cubiertos se reparte de forma informativa en el primer grupo:
    // el número que importa al operador es "cuántos servicios voy a desbloquear".
    if (salida.length) salida[0].cubiertos = cubiertos;
    return salida;
  }, [reservas]);

  const totalAAplicar = grupos.reduce(
    (a, g) => a + (Number(montos[g.clave]) > 0 ? g.filas.length : 0), 0
  );
  const importeTotal = grupos.reduce(
    (a, g) => a + (Number(montos[g.clave]) > 0 ? Number(montos[g.clave]) * g.filas.length : 0), 0
  );

  async function guardar() {
    const conImporte = grupos.filter((g) => Number(montos[g.clave]) > 0);
    if (!conImporte.length) { setMsg("⚠️ Escribe el importe de al menos una ruta."); return; }
    setGuardando(true); setMsg("");
    let hechos = 0;
    try {
      for (const g of conImporte) {
        const precio = Number(montos[g.clave]);
        const ids = g.filas.map((r) => r.id);
        for (let i = 0; i < ids.length; i += LOTE) {
          const { error } = await supabase
            .from("reservas")
            .update({ precio_cliente: precio })
            .in("id", ids.slice(i, i + LOTE));
          // Se corta al primer fallo y se informa cuántos SÍ entraron: dejar creer que
          // se aplicaron 60 cuando entraron 20 es peor que el propio fallo.
          if (error) throw new Error(`${g.ruta}: ${error.message} (se aplicaron ${hechos})`);
          hechos += Math.min(LOTE, ids.length - i);
        }
      }
      onGuardado(hechos);
    } catch (e: any) {
      setMsg("⚠️ " + String(e?.message ?? e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b sticky top-0 bg-white rounded-t-2xl z-10">
          <h3 className="font-black text-[#0b315f]">Cargar el precio de venta que falta</h3>
          <p className="text-xs text-gray-500">
            Estas rutas no entran a la liquidación porque ninguno de sus servicios tiene tarifa.
            Escribe el precio de una y se aplica a todos sus servicios del periodo.
          </p>
        </div>

        {msg && <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">{msg}</div>}

        <div className="p-5">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
              <tr>
                <th className="text-left px-2 py-2">Ruta</th>
                <th className="px-2 py-2 w-20">Serv.</th>
                <th className="px-2 py-2 w-32">Precio unitario</th>
                <th className="px-2 py-2 w-28 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {grupos.map((g) => {
                const precio = Number(montos[g.clave]) || 0;
                return (
                  <tr key={g.clave} className={precio > 0 ? "bg-emerald-50/40" : ""}>
                    <td className="px-2 py-2">
                      <span className="block font-medium text-gray-800">{g.ruta}</span>
                      <span className="block text-[10px] text-gray-400">
                        {g.cliente} · del {g.desde} al {g.hasta}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center text-xs text-gray-500">{g.filas.length}</td>
                    <td className="px-2 py-2">
                      <input type="number" min="0" step="0.01"
                        className="w-full px-2 py-1 rounded border text-sm text-right"
                        placeholder="0.00"
                        value={montos[g.clave] ?? ""}
                        onChange={(e) => setMontos((m) => ({ ...m, [g.clave]: e.target.value }))} />
                    </td>
                    <td className="px-2 py-2 text-right font-bold text-gray-700">
                      {precio > 0 ? fmtMoneda(precio * g.filas.length) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="mt-3 text-[11px] text-gray-500">
            El importe se escribe en la <b>ida</b> de cada día. El retorno se queda en S/ 0.00 a
            propósito: AFA cobra <b>una sola tarifa por los dos tramos</b>, y cargarla en ambos
            facturaría el doble.
            {grupos[0]?.cubiertos ? ` En este lote hay ${grupos[0].cubiertos} retorno(s) que quedan cubiertos así.` : ""}
            {" "}Comprueba el precio con la cotización antes de guardar: es el que va a la factura.
          </p>
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end sticky bottom-0 bg-white rounded-b-2xl">
          <span className="mr-auto text-xs text-gray-500 self-center">
            {totalAAplicar
              ? <>Se aplicará a <b>{totalAAplicar}</b> servicio(s) · {fmtMoneda(importeTotal)} sin IGV</>
              : "Escribe el importe de al menos una ruta"}
          </span>
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={guardar} disabled={guardando || !totalAAplicar}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
            {guardando ? "Guardando…" : "Aplicar precios"}
          </button>
        </div>
      </div>
    </div>
  );
}
