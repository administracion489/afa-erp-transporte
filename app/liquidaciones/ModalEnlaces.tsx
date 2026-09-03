"use client";
// ──────────────────────────────────────────────────────────────────────────────
// ModalEnlaces — reparar el enlace IDA↔RETORNO que la base perdió.
//
// AFA cobra UNA tarifa por los dos tramos del día, y quien dice que dos tramos son el
// mismo día es `reservas.reserva_vinculada_id`. Cuando ese enlace falta, el ERP deja de
// ver un servicio y ve dos: el que lleva la tarifa se cobra bien, y el que va en S/ 0.00
// —el retorno, normalmente— sale del cierre pidiendo un precio que NO se le debe cargar.
// Cargárselo factura el día dos veces; no cargárselo deja el bloque rojo encendido para
// siempre. Ninguna de las dos salidas es la correcta: la correcta es escribir el enlace.
//
// El enlace se rompe de dos formas, y las dos se arreglan igual:
//
//   A MEDIAS  — escrito en un solo lado. Se genera en dos pasos (ModalGenerarPrograma
//               inserta las idas, luego los retornos apuntando a su ida y recién al final
//               actualiza las idas), y basta que el último no llegue. También lo deja así
//               borrar un tramo: al superviviente se le pone el enlace en NULL.
//   SIN NADA  — ninguno de los dos apunta al otro. Se deduce el par (mismo cliente, mismo
//               día, misma ruta, sentido contrario) y se propone; nunca se adivina: con
//               dos móviles de la misma ruta el mismo día no se propone ninguno.
//
// Se escriben LOS DOS lados (lib/liquidacion-hermanos.ts · repararEnlaces): media docena
// de sitios del ERP leen esa columna hacia adelante, así que arreglar solo el lado que
// mira el cierre dejaría Programación igual de rota.
// ──────────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { nombreRuta, sentidoDeReserva, type ReservaLiq, type LadoLiquidacion } from "@/lib/liquidacion-agrupacion";
import { montoDeTramo, repararEnlaces, type EnlaceReparable } from "@/lib/liquidacion-hermanos";

const fecha = (r: ReservaLiq) => String(r.fecha_servicio ?? "").slice(0, 10);
const hora = (r: ReservaLiq) => String(r.hora_servicio ?? "").slice(0, 5);
const ref = (r: ReservaLiq) => r.codigo ?? `#${r.id}`;

export default function ModalEnlaces({
  enlaces, lado, clienteDe, onCerrar, onGuardado,
}: {
  enlaces: EnlaceReparable[];
  lado: LadoLiquidacion;
  clienteDe: (r: ReservaLiq) => string;
  onCerrar: () => void;
  onGuardado: (reparados: number) => void;
}) {
  // Arrancan TODOS marcados: en la práctica siempre hay que enlazarlos, y el que no
  // corresponda se desmarca. Lo contrario obliga a veinte clics para el caso normal.
  const [marcados, setMarcados] = useState<Set<number>>(new Set(enlaces.map((e) => e.tramo.id)));
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");

  /** Los dos tramos ordenados por sentido, no por quién cobra: así la tabla se lee igual siempre. */
  const filas = useMemo(
    () =>
      enlaces
        .map((e) => {
          const esRetorno = sentidoDeReserva(e.tramo) === "RETORNO";
          const ida = esRetorno ? e.hermano : e.tramo;
          const retorno = esRetorno ? e.tramo : e.hermano;
          return { ...e, ida, retorno, importe: montoDeTramo(e.tramo, lado) + montoDeTramo(e.hermano, lado) };
        })
        .sort(
          (a, b) =>
            fecha(a.ida).localeCompare(fecha(b.ida)) ||
            nombreRuta(a.ida).localeCompare(nombreRuta(b.ida)) ||
            a.ida.id - b.ida.id
        ),
    [enlaces, lado]
  );

  const aMedias = filas.filter((f) => f.procedencia === "enlace_a_medias").length;
  const deducidos = filas.length - aMedias;

  async function guardar() {
    const objetivo = filas.filter((f) => marcados.has(f.tramo.id));
    if (!objetivo.length) { setMsg("⚠️ Marca al menos un par."); return; }
    setGuardando(true); setMsg("");
    try {
      const { reparados, errores } = await repararEnlaces(supabase, objetivo);
      if (errores.length) {
        // Se dice cuántos SÍ entraron: creer que se enlazaron veinte cuando entraron tres
        // es peor que el propio fallo, porque el cierre se emite igual.
        setMsg(`⚠️ Se enlazaron ${reparados} de ${objetivo.length}. ${errores.join(" · ")}`);
        return;
      }
      onGuardado(reparados);
    } catch (e) {
      setMsg("⚠️ " + String((e as { message?: string })?.message ?? e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b rounded-t-2xl">
          <h3 className="font-black text-[#0b315f]">Enlazar ida ↔ retorno</h3>
          <p className="text-xs text-gray-500">
            Estos días están partidos en dos servicios sueltos porque les falta el enlace que dice
            que son el mismo día. AFA cobra <b>una tarifa por los dos tramos</b>: mientras falte,
            el tramo en S/ 0.00 sale del cierre pidiendo un precio que <b>no</b> hay que cargarle
            — hacerlo cobraría el día dos veces.
            {aMedias > 0 && <> · <b>{aMedias}</b> con el enlace escrito en un solo lado.</>}
            {deducidos > 0 && <> · <b>{deducidos}</b> sin enlace, emparejados por cliente, día y ruta.</>}
          </p>
        </div>

        {msg && <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">{msg}</div>}

        <div className="flex-1 overflow-auto p-5">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase text-gray-500 sticky top-0">
              <tr>
                <th className="px-2 py-2 w-8">
                  <input type="checkbox"
                    checked={filas.length > 0 && marcados.size === filas.length}
                    onChange={(e) => setMarcados(e.target.checked ? new Set(filas.map((f) => f.tramo.id)) : new Set())} />
                </th>
                <th className="text-left px-2 py-2 w-28">Fecha</th>
                <th className="text-left px-2 py-2">Ida</th>
                <th className="text-left px-2 py-2">Retorno</th>
                <th className="text-right px-2 py-2 w-28">{lado === "cliente" ? "Precio del día" : "Costo del día"}</th>
                <th className="text-left px-2 py-2 w-40">Enlace</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filas.map((f) => (
                <tr key={f.tramo.id} className={marcados.has(f.tramo.id) ? "bg-emerald-50/40" : ""}>
                  <td className="px-2 py-2 align-top">
                    <input type="checkbox" checked={marcados.has(f.tramo.id)}
                      onChange={(e) => setMarcados((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(f.tramo.id); else n.delete(f.tramo.id);
                        return n;
                      })} />
                  </td>
                  <td className="px-2 py-2 align-top text-xs text-gray-600">
                    <span className="block">{fecha(f.ida)}</span>
                    <span className="block text-[10px] text-gray-400">{clienteDe(f.ida)}</span>
                  </td>
                  {[f.ida, f.retorno].map((t, i) => (
                    <td key={i} className="px-2 py-2 align-top">
                      <span className="block font-mono text-[11px] text-gray-700">{ref(t)}</span>
                      <span className="block text-[10px] text-gray-500">{hora(t)} · {nombreRuta(t)}</span>
                      <span className="block text-[10px] text-gray-400">
                        {montoDeTramo(t, lado) > 0 ? `lleva ${fmtMoneda(montoDeTramo(t, lado))}` : "S/ 0.00 · incluido"}
                        {" · "}{t.estado ?? "sin estado"}
                      </span>
                    </td>
                  ))}
                  <td className="px-2 py-2 align-top text-right font-bold text-gray-700">{fmtMoneda(f.importe)}</td>
                  <td className="px-2 py-2 align-top text-[10px]">
                    {f.procedencia === "enlace_a_medias" ? (
                      <span className="text-amber-700">
                        Escrito en un solo lado. El par es seguro: falta escribir la vuelta.
                      </span>
                    ) : (
                      <span className="text-sky-700">
                        Sin enlace. Mismo cliente, mismo día y misma ruta, y son los únicos dos
                        tramos sueltos de esa ruta ese día. <b>Verifícalo</b> antes de enlazar.
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-3 text-[11px] text-gray-500">
            Enlazar <b>no cambia ningún importe</b>: solo dice que esos dos tramos son el mismo día.
            El tramo que ya lleva la tarifa la sigue llevando, el otro se queda en S/ 0.00 —que es
            lo correcto— y deja de reclamar precio en este cierre y en todos los siguientes. Se
            escribe en los dos servicios, porque Programación y las notificaciones leen esa misma
            columna.
          </p>
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end rounded-b-2xl">
          <span className="mr-auto text-xs text-gray-500 self-center">
            <b>{marcados.size}</b> de {filas.length} par(es) a enlazar
          </span>
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={guardar} disabled={guardando || !marcados.size}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
            {guardando ? "Enlazando…" : `Enlazar ${marcados.size || ""} par(es)`}
          </button>
        </div>
      </div>
    </div>
  );
}
