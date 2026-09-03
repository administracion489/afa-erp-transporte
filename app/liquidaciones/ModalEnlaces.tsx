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
// EL ERP NO ELIGE POR TI, y esa es la lección cara de esta pantalla. La primera versión
// proponía el par cuando quedaban un solo ida y un solo retorno SUELTOS — y el 22-08 la
// RUTA B salió con dos móviles: como dos de sus cuatro tramos ya tenían enlace, los otros
// dos parecían "los únicos" y se proponían como pareja. Se veían perfectos (mismo cliente,
// mismo día, misma ruta, sentidos contrarios, extremos invertidos) y eran de móviles
// distintos. Ahora se cuenta el DÍA entero: solo se propone marcado cuando esa ruta salió
// UNA vez ese día. Si salió más veces, el hermano se ELIGE en la lista, con los otros
// tramos del día a la vista para poder verificarlo.
//
// Se escriben LOS DOS lados (lib/liquidacion-hermanos.ts · repararEnlaces), y al reasignar
// se suelta al tercero que apuntaba a cualquiera de los dos: media docena de sitios del
// ERP leen esa columna hacia adelante, y un enlace de tres puntas se lee distinto según
// por dónde se entre.
// ──────────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { nombreRuta, sentidoDeReserva, type ReservaLiq, type LadoLiquidacion } from "@/lib/liquidacion-agrupacion";
import { montoDeTramo, repararEnlaces, type EnlacePendiente } from "@/lib/liquidacion-hermanos";

const fecha = (r: ReservaLiq) => String(r.fecha_servicio ?? "").slice(0, 10);
const hora = (r: ReservaLiq) => String(r.hora_servicio ?? "").slice(0, 5);
const ref = (r: ReservaLiq) => r.codigo ?? `#${r.id}`;
const esRetorno = (r: ReservaLiq) => sentidoDeReserva(r) === "RETORNO";

export default function ModalEnlaces({
  pendientes, lado, clienteDe, onCerrar, onGuardado,
}: {
  pendientes: EnlacePendiente[];
  lado: LadoLiquidacion;
  clienteDe: (r: ReservaLiq) => string;
  onCerrar: () => void;
  onGuardado: (reparados: number) => void;
}) {
  /** tramo → id del hermano elegido. Arranca con lo propuesto, que solo existe si era seguro. */
  const [elegido, setElegido] = useState<Record<number, number>>(() =>
    Object.fromEntries(pendientes.filter((p) => p.propuesto).map((p) => [p.tramo.id, p.propuesto!.id]))
  );
  /**
   * Qué filas se van a escribir. Solo arrancan marcadas las que el ERP pudo resolver sin
   * adivinar: una propuesta ambigua marcada por defecto es exactamente cómo se escribe un
   * enlace equivocado sin que nadie lo lea.
   */
  const [marcados, setMarcados] = useState<Set<number>>(
    () => new Set(pendientes.filter((p) => p.propuesto).map((p) => p.tramo.id))
  );
  const [abierto, setAbierto] = useState<Set<number>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");

  const filas = useMemo(
    () =>
      [...pendientes].sort(
        (a, b) =>
          // Primero lo que hay que decidir a mano: es el trabajo de verdad.
          Number(a.procedencia !== "ambiguo") - Number(b.procedencia !== "ambiguo") ||
          fecha(a.tramo).localeCompare(fecha(b.tramo)) ||
          nombreRuta(a.tramo).localeCompare(nombreRuta(b.tramo)) ||
          a.tramo.id - b.tramo.id
      ),
    [pendientes]
  );

  const ambiguas = filas.filter((f) => f.procedencia === "ambiguo").length;
  const aMedias = filas.filter((f) => f.procedencia === "enlace_a_medias").length;
  const deducidas = filas.filter((f) => f.procedencia === "deducido").length;

  /** El hermano elegido de una fila, buscado entre sus candidatos. */
  const hermanoDe = (f: EnlacePendiente): ReservaLiq | null =>
    f.candidatos.find((c) => c.id === elegido[f.tramo.id]) ??
    (f.propuesto && f.propuesto.id === elegido[f.tramo.id] ? f.propuesto : null);

  /** Un hermano ya reclamado por otra fila de esta misma tanda: escribiría dos veces. */
  const chocaCon = (f: EnlacePendiente): EnlacePendiente | null => {
    const mio = elegido[f.tramo.id];
    if (!mio || !marcados.has(f.tramo.id)) return null;
    return (
      filas.find(
        (o) => o.tramo.id !== f.tramo.id && marcados.has(o.tramo.id) &&
          (elegido[o.tramo.id] === mio || o.tramo.id === mio)
      ) ?? null
    );
  };

  const listas = filas.filter((f) => marcados.has(f.tramo.id) && hermanoDe(f) && !chocaCon(f));
  const conflictos = filas.filter((f) => marcados.has(f.tramo.id) && chocaCon(f)).length;

  async function guardar() {
    if (!listas.length) { setMsg("⚠️ Marca al menos un par y elige su hermano."); return; }
    setGuardando(true); setMsg("");
    try {
      const { reparados, errores } = await repararEnlaces(
        supabase,
        listas.map((f) => ({ tramo: f.tramo, hermano: hermanoDe(f)! }))
      );
      if (errores.length) {
        // Se dice cuántos SÍ entraron: creer que se enlazaron veinte cuando entraron tres
        // es peor que el propio fallo, porque el cierre se emite igual.
        setMsg(`⚠️ Se enlazaron ${reparados} de ${listas.length}. ${errores.join(" · ")}`);
        return;
      }
      onGuardado(reparados);
    } catch (e) {
      setMsg("⚠️ " + String((e as { message?: string })?.message ?? e));
    } finally {
      setGuardando(false);
    }
  }

  /** Una celda de tramo: código, hora, ruta e importe. Lo que hace falta para reconocerlo. */
  const Tramo = ({ t, tenue }: { t: ReservaLiq; tenue?: boolean }) => (
    <span className={tenue ? "opacity-70" : ""}>
      <span className="block font-mono text-[11px] text-gray-700">{ref(t)}</span>
      <span className="block text-[10px] text-gray-500">{hora(t)} · {nombreRuta(t)}</span>
      <span className="block text-[10px] text-gray-400">
        {montoDeTramo(t, lado) > 0 ? `lleva ${fmtMoneda(montoDeTramo(t, lado))}` : "S/ 0.00 · incluido"}
        {" · "}{t.estado ?? "sin estado"}
      </span>
    </span>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b rounded-t-2xl">
          <h3 className="font-black text-[#0b315f]">Enlazar ida ↔ retorno</h3>
          <p className="text-xs text-gray-500">
            Estos días están partidos en dos servicios sueltos porque les falta el enlace que dice
            que son el mismo día. AFA cobra <b>una tarifa por los dos tramos</b>: mientras falte,
            el tramo en S/ 0.00 sale del cierre pidiendo un precio que <b>no</b> hay que cargarle.
            {aMedias > 0 && <> · <b>{aMedias}</b> con el enlace escrito en un solo lado.</>}
            {deducidas > 0 && <> · <b>{deducidas}</b> sin enlace, y esa ruta salió una sola vez ese día.</>}
            {ambiguas > 0 && (
              <> · <b className="text-amber-700">{ambiguas} salieron con más de un móvil ese día: el hermano
                lo eliges tú</b>, el ERP no adivina.</>
            )}
          </p>
        </div>

        {msg && <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">{msg}</div>}

        <div className="flex-1 overflow-auto p-5">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase text-gray-500 sticky top-0">
              <tr>
                <th className="px-2 py-2 w-8"></th>
                <th className="text-left px-2 py-2 w-28">Fecha</th>
                <th className="text-left px-2 py-2">Este tramo</th>
                <th className="text-left px-2 py-2 w-80">Su hermano</th>
                <th className="text-left px-2 py-2 w-56">Cómo se supo</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filas.map((f) => {
                const hermano = hermanoDe(f);
                const choca = chocaCon(f);
                const marcado = marcados.has(f.tramo.id);
                // El contexto del día: los OTROS tramos de esa ruta, con su enlace actual.
                // Es lo único con lo que se puede verificar una propuesta — y lo que
                // faltaba cuando el ERP emparejó dos tramos de móviles distintos.
                const otros = f.delDia.filter((x) => x.id !== f.tramo.id && x.id !== hermano?.id);
                return (
                  <tr key={f.tramo.id} className={marcado && hermano && !choca ? "bg-emerald-50/40" : ""}>
                    <td className="px-2 py-2 align-top">
                      <input type="checkbox" checked={marcado} disabled={!hermano}
                        onChange={(e) => setMarcados((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(f.tramo.id); else n.delete(f.tramo.id);
                          return n;
                        })} />
                    </td>
                    <td className="px-2 py-2 align-top text-xs text-gray-600">
                      <span className="block">{fecha(f.tramo)}</span>
                      <span className="block text-[10px] text-gray-400">{clienteDe(f.tramo)}</span>
                      <span className="block text-[10px] font-bold text-gray-500 mt-0.5">
                        {esRetorno(f.tramo) ? "↩ retorno" : "→ ida"}
                      </span>
                    </td>
                    <td className="px-2 py-2 align-top"><Tramo t={f.tramo} /></td>
                    <td className="px-2 py-2 align-top">
                      {/* Siempre un selector, incluso con un único candidato: que el par se
                          pueda cambiar es justo lo que faltaba cuando la propuesta era la
                          equivocada y no había forma de corregirla desde acá. */}
                      <select
                        className="w-full px-1.5 py-1 rounded border text-xs mb-1"
                        value={elegido[f.tramo.id] ?? ""}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setElegido((m) => ({ ...m, [f.tramo.id]: v }));
                          setMarcados((s) => {
                            const n = new Set(s);
                            if (v) n.add(f.tramo.id); else n.delete(f.tramo.id);
                            return n;
                          });
                        }}>
                        <option value="">— elige {esRetorno(f.tramo) ? "la ida" : "el retorno"} —</option>
                        {f.candidatos.map((c) => (
                          <option key={c.id} value={c.id}>
                            {ref(c)} · {hora(c)} · {montoDeTramo(c, lado) > 0 ? fmtMoneda(montoDeTramo(c, lado)) : "S/ 0.00"}
                            {Number(c.reserva_vinculada_id ?? 0) ? " · YA enlazado con otro" : ""}
                          </option>
                        ))}
                      </select>
                      {hermano && <Tramo t={hermano} tenue />}
                      {hermano && Number(hermano.reserva_vinculada_id ?? 0) > 0 &&
                        Number(hermano.reserva_vinculada_id) !== f.tramo.id && (
                        <span className="block text-[10px] text-red-700 mt-1">
                          ⚠ {ref(hermano)} ya está enlazado con el servicio #{hermano.reserva_vinculada_id}.
                          Al guardar se suelta ese enlace y queda con este tramo.
                        </span>
                      )}
                      {choca && (
                        <span className="block text-[10px] text-red-700 mt-1">
                          ⚠ {ref(choca.tramo)} está usando el mismo hermano en esta misma tanda. Elige otro.
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 align-top text-[10px]">
                      {f.procedencia === "enlace_a_medias" ? (
                        <span className="text-amber-700">
                          Escrito en un solo lado. El par es seguro: falta escribir la vuelta.
                        </span>
                      ) : f.procedencia === "deducido" ? (
                        <span className="text-sky-700">
                          Sin enlace. Esa ruta salió <b>una sola vez</b> ese día, así que no hay otra
                          pareja posible. Verifícalo igual.
                        </span>
                      ) : (
                        <span className="text-amber-800">
                          <b>Elígelo tú.</b> Esa ruta salió con <b>{f.delDia.length} tramos</b> ese día
                          (más de un móvil): el ERP no puede saber cuál va con cuál sin adivinar.
                        </span>
                      )}
                      {otros.length > 0 && (
                        <>
                          <button type="button"
                            onClick={() => setAbierto((s) => {
                              const n = new Set(s);
                              if (n.has(f.tramo.id)) n.delete(f.tramo.id); else n.add(f.tramo.id);
                              return n;
                            })}
                            className="mt-1 underline decoration-dotted text-gray-500 hover:text-gray-800">
                            {abierto.has(f.tramo.id) ? "▲ ocultar" : `▼ ver los otros ${otros.length} tramo(s) de esa ruta ese día`}
                          </button>
                          {abierto.has(f.tramo.id) && (
                            <span className="block mt-1 space-y-0.5">
                              {otros.map((x) => (
                                <span key={x.id} className="block text-gray-500">
                                  <b className="font-mono">{ref(x)}</b> {hora(x)} {esRetorno(x) ? "↩" : "→"}{" "}
                                  {montoDeTramo(x, lado) > 0 ? fmtMoneda(montoDeTramo(x, lado)) : "S/ 0.00"} ·{" "}
                                  {Number(x.reserva_vinculada_id ?? 0)
                                    ? `enlazado con #${x.reserva_vinculada_id}`
                                    : "sin enlace"}
                                </span>
                              ))}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="mt-3 text-[11px] text-gray-500">
            Enlazar <b>no cambia ningún importe</b>: solo dice que esos dos tramos son el mismo día.
            El tramo que ya lleva la tarifa la sigue llevando, el otro se queda en S/ 0.00 —que es
            lo correcto— y deja de reclamar precio en este cierre y en todos los siguientes. Se
            escribe en los dos servicios, porque Programación y las notificaciones leen esa misma
            columna; y si el hermano que eliges venía enlazado a un tercero, ese enlace viejo se
            suelta para no dejar un vínculo de tres puntas.
          </p>
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end rounded-b-2xl">
          <span className="mr-auto text-xs text-gray-500 self-center">
            <b>{listas.length}</b> de {filas.length} par(es) listos
            {conflictos > 0 && <span className="text-red-600 font-semibold"> · {conflictos} con el mismo hermano repetido</span>}
          </span>
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={guardar} disabled={guardando || !listas.length}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
            {guardando ? "Enlazando…" : `Enlazar ${listas.length || ""} par(es)`}
          </button>
        </div>
      </div>
    </div>
  );
}
