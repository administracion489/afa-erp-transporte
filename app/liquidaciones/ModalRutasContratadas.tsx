"use client";
// Las fichas de las rutas contratadas del periodo: cuántos asientos pidió el cliente.
//
// Es lo único que faltaba para que el formato deje de inventar el "N PAX". Hasta ahora
// ese número salía de la capacidad del bus que tocó ese día, así que una ruta contratada
// para 15 personas se le declaraba al cliente como 20 cuando AFA, por disponibilidad,
// mandaba una unidad más grande.
//
// Se llena desde aquí porque aquí es donde se nota: el periodo ya está cargado, cada
// ruta trae sus servicios del mes y se ve cuáles saldrían sin el dato. Lo que se guarda
// queda en `cliente_ruta` contra el par de nombres (ida + retorno), que es la misma
// identidad con la que la liquidación agrupa sus líneas — o sea que se corrige una vez
// y todos los meses siguientes salen bien solos.
//
// LA COLUMNA «SERV.» SE ABRE. Era el cuarto contador de esta pantalla que solo se podía
// mirar, y el peor de los cuatro: acá se está por DECLARAR cuántos asientos contrató el
// cliente en una ruta, y para responder eso hay que ver qué servicios se están metiendo
// en la misma bolsa. La fila que lo vuelve obligatorio es la que sale «(sin nombre de
// ruta)» — sin poder abrirla no hay forma de saber a qué ruta pertenece ese renglón, ni
// de arreglarla: el nombre se escribe en el servicio, no acá. El detalle es el MISMO
// `ModalServicios` que abren los otros tres contadores (lo monta la página, que es quien
// tiene el catálogo y el universo de reservas), así que se corrige por la misma puerta.
//
// Este modal NO se cierra al abrir el detalle: los PAX ya tecleados se perderían. Se
// queda debajo y se vuelve a él — por eso `ModalServicios` vive una capa por encima
// (z-[60]) y por eso la página le pasa la lista VIVA: corregido el nombre del servicio,
// la ficha de esta tabla se rearma sola.

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { guardarPaxContratado, guardarPaxDeServicios } from "@/lib/liquidacion-rutas";
import { fmtMoneda } from "@/lib/finanzas/dinero";

export type RutaDelPeriodo = {
  clave: string;
  clienteId: number | null;
  clienteNombre: string;
  sedeId: number | null;
  sedeNombre: string;
  nombreIda: string | null;
  nombreRetorno: string | null;
  /** Lo que hoy resuelve la cascada. null = la ruta sale sin el "N PAX". */
  paxContratado: number | null;
  /** La unidad más chica que se asignó en el periodo. Solo referencia, nunca se copia sola. */
  capacidadMinimaAsignada: number | null;
  servicios: number;
  /**
   * ids de TODOS los tramos del periodo que sustentan la ficha (ida y retorno, ejecutados
   * o no): lo que se abre al pulsar el contador.
   *
   * No son los mismos que cuenta `servicios`, y la diferencia es a propósito. `servicios`
   * cuenta DÍAS cobrados —el par ida+retorno es un servicio a una tarifa—, mientras que
   * acá va cada tramo, incluidos los que no se prestaron. Se abre lo ancho por lo mismo
   * que en el contador de cada línea: si un día no está saliendo, es justo el que hay que
   * poder ver. El modal rotula las dos cifras para que nadie lea un número por el otro.
   */
  reservasPeriodo: number[];
  /**
   * Las tarifas DISTINTAS que cobra la ruta en el periodo, tal como entran a la
   * valorización (una sola en el caso normal).
   *
   * Van todas y no un promedio: la ficha no se parte por móvil ni por origen, así que
   * una ruta con un adicional más caro trae dos, y aplastarlas en un número mostraría un
   * precio que nadie cobró. Con más de una, la fila lo dice y el detrás del contador
   * enseña cuál es cuál.
   */
  precios: number[];
  /** Lo que suma la ruta en el periodo. Es el renglón del cierre, no una estimación. */
  total: number;
  /**
   * Cuántos de esos servicios se pidieron POR ENCIMA del contrato.
   *
   * La ficha NO se parte por eso —la capacidad contratada es de la RUTA, y `cliente_ruta`
   * la identifica por el par de nombres, sin el origen—, pero sí se dice: si de 24
   * servicios 5 fueron adicionales, el operador tiene que saberlo antes de declarar
   * cuántos asientos "contrató" el cliente en esa ruta.
   */
  adicionales: number;
};

export default function ModalRutasContratadas({
  rutas, catalogoDisponible, onCerrar, onGuardado, onVerServicios,
}: {
  /**
   * La lista VIVA de rutas del periodo, no una copia congelada al abrir: mientras este
   * modal está abierto se puede corregir un servicio desde el detalle, y al recargarse la
   * página la ficha tiene que rearmarse sola (una ruta que estaba «(sin nombre)» pasa a
   * tener el suyo, y con él la clave que la identifica).
   */
  rutas: RutaDelPeriodo[];
  catalogoDisponible: boolean;
  onCerrar: () => void;
  onGuardado: (guardadas: number) => void;
  /** Abre el detalle de los servicios de una ruta. Lo monta la página, encima de este modal. */
  onVerServicios: (ruta: RutaDelPeriodo) => void;
}) {
  /**
   * SOLO lo tecleado, superpuesto a lo que ya resuelve la cascada. Copiar los valores a
   * un estado inicial dejaba la tabla congelada: si desde el detalle se corregía el
   * nombre de una ruta, su fila cambiaba de clave y volvía a la pantalla en blanco,
   * borrando de la vista una capacidad que sí estaba fichada.
   */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");

  const valorDe = (r: RutaDelPeriodo) =>
    edits[r.clave] ?? (r.paxContratado != null ? String(r.paxContratado) : "");

  const sinPax = rutas.filter((r) => !valorDe(r).trim()).length;

  async function guardar() {
    setGuardando(true); setMsg("");
    let ok = 0;
    const fallos: string[] = [];
    for (const r of rutas) {
      const texto = valorDe(r).trim();
      const pax = texto ? Number(texto) : null;
      // Nada que hacer si no cambió respecto de lo que ya resolvía la cascada.
      if ((pax ?? null) === (r.paxContratado ?? null)) continue;
      if (pax != null && (!Number.isFinite(pax) || pax <= 0)) {
        fallos.push(`${r.nombreIda ?? "(sin nombre)"}: "${texto}" no es una cantidad de asientos`);
        continue;
      }
      // DÓNDE SE GUARDA depende de si esta fila es la ruta entera o solo una parte.
      //
      // `cliente_ruta` tiene un índice único por par de nombres: una ruta, un número. Pero
      // la misma ruta puede salir en el periodo con dos contratos —la RUTA C de retorno
      // tenía un adicional por 4 asientos y dos por 10, todos con el mismo nombre—, y ahí
      // la ficha no da para los dos. Guardar las dos filas contra la ficha haría que la
      // segunda pisara a la primera EN SILENCIO.
      //
      //   · ruta con UNA sola fila  → la ficha, como siempre: se corrige una vez y los
      //                               meses siguientes salen bien solos.
      //   · ruta con VARIAS filas   → el snapshot de cada servicio, que es el escalón que
      //                               manda sobre la ficha y sí distingue fila por fila.
      const filasDeLaRuta = rutas.filter(
        (x) =>
          (x.clienteId ?? 0) === (r.clienteId ?? 0) &&
          (x.sedeId ?? 0) === (r.sedeId ?? 0) &&
          (x.nombreIda ?? "") === (r.nombreIda ?? "") &&
          (x.nombreRetorno ?? "") === (r.nombreRetorno ?? "")
      ).length;

      const res = filasDeLaRuta > 1
        ? await guardarPaxDeServicios(supabase, r.reservasPeriodo, pax)
        : await guardarPaxContratado(supabase, {
            clienteId: r.clienteId,
            sedeId: r.sedeId,
            nombreIda: r.nombreIda,
            nombreRetorno: r.nombreRetorno,
            pax,
          });
      if (res.ok) ok += 1;
      else fallos.push(`${r.nombreIda ?? "(sin nombre)"}: ${res.error}`);
    }
    setGuardando(false);
    if (fallos.length) { setMsg(`⚠️ ${fallos.length} no se guardó(aron): ${fallos[0]}`); return; }
    onGuardado(ok);
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b sticky top-0 bg-white rounded-t-2xl z-10">
          <h3 className="font-black text-[#0b315f]">Rutas contratadas del periodo</h3>
          <p className="text-xs text-gray-500">
            Cuántos asientos contrató el cliente en cada ruta. Es lo que imprime el formato — no la
            capacidad del bus que salió ese día, que cambia según la disponibilidad.
          </p>
        </div>

        {!catalogoDisponible && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
            <b>Falta un paso en la base de datos.</b> Corre <code>supabase/liquidaciones-03-ruta-contratada.sql</code>:
            sin esa tabla no hay dónde guardar la capacidad contratada y el formato seguirá saliendo sin el «N PAX».
          </div>
        )}
        {msg && <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">{msg}</div>}

        <div className="p-5">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
              <tr>
                <th className="text-left px-2 py-2">Ruta</th>
                <th className="px-2 py-2 w-20">Serv.</th>
                <th className="text-right px-2 py-2 w-36">Precio cliente</th>
                <th className="px-2 py-2 w-28">Unidad menor</th>
                <th className="px-2 py-2 w-32">PAX contratados</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rutas.map((r) => {
                const valor = valorDe(r);
                const falta = !valor.trim();
                return (
                  <tr key={r.clave} className={falta ? "bg-amber-50/50" : ""}>
                    <td className="px-2 py-2">
                      <span className="block font-medium text-gray-800">{r.nombreIda ?? "(sin nombre de ruta)"}</span>
                      {r.nombreRetorno && <span className="block text-[11px] text-gray-500">↩ {r.nombreRetorno}</span>}
                      <span className="block text-[10px] text-gray-400">{r.clienteNombre} · {r.sedeNombre}</span>
                      {r.adicionales > 0 && (
                        <span className="mt-0.5 inline-block text-[10px] font-black px-1.5 py-0.5 rounded-full uppercase"
                              title="Parte de estos servicios se pidieron por encima del contrato. La capacidad que declares aquí es la de la ruta contratada."
                              style={{ background: "#fef3c7", color: "#b45309" }}>
                          {r.adicionales} adicional{r.adicionales !== 1 ? "es" : ""}
                        </span>
                      )}
                    </td>
                    {/* El contador abre el detalle. Es la única forma de contestar "¿qué
                        servicios son estos?" antes de declarar cuántos asientos se
                        contrataron — y la única de arreglar la fila «(sin nombre de
                        ruta)», porque el nombre se escribe en el servicio, no acá. */}
                    <td className="px-2 py-2 text-center">
                      <button
                        onClick={() => onVerServicios(r)}
                        disabled={!r.reservasPeriodo.length}
                        className="text-xs font-bold text-[#0b315f] underline decoration-dotted hover:text-black disabled:text-gray-400 disabled:no-underline disabled:cursor-default"
                        title={r.reservasPeriodo.length
                          ? `Ver los ${r.reservasPeriodo.length} tramo(s) del periodo de esta ruta`
                          : "Sin tramos que mostrar"}>
                        {r.servicios}
                      </button>
                    </td>
                    {/* La tarifa por servicio y lo que suma la ruta en el mes. Es el otro
                        número contra el que se verifica la ficha: una ruta contratada
                        cobra UNA tarifa, así que ver dos aquí es la señal de que hay un
                        móvil o un adicional a otro precio — o de que alguien tecleó de
                        más. Sin esta columna había que cerrar el modal y buscar la línea
                        en el árbol del cierre para saberlo. */}
                    <td className="px-2 py-2 text-right">
                      {r.precios.length === 0 ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : (
                        <>
                          <span className="block text-xs font-semibold text-gray-800"
                                title={r.precios.length > 1
                                  ? `Tarifas del periodo: ${r.precios.map((p) => fmtMoneda(p)).join(" · ")}`
                                  : "Tarifa por servicio"}>
                            {r.precios.length === 1
                              ? fmtMoneda(r.precios[0])
                              : `${fmtMoneda(r.precios[0])} – ${fmtMoneda(r.precios[r.precios.length - 1])}`}
                          </span>
                          {r.precios.length > 1 && (
                            <span className="block text-[10px] text-amber-700">{r.precios.length} tarifas</span>
                          )}
                          <span className="block text-[10px] text-gray-400">{fmtMoneda(r.total)} en el periodo</span>
                        </>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center text-xs text-gray-400">
                      {r.capacidadMinimaAsignada ?? "—"}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="number" min="1" step="1"
                        className="w-full px-2 py-1 rounded border text-sm text-center"
                        placeholder="—"
                        value={valor}
                        onChange={(e) => setEdits((v) => ({ ...v, [r.clave]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="mt-3 text-[11px] text-gray-500">
            La columna <b>Serv.</b> son los <b>días cobrados</b> de la ruta en el periodo (la ida y su
            retorno son un solo servicio a una sola tarifa). Púlsala para ver de cuáles se trata,
            con su fecha, hora, unidad y estado: ahí se corrige el nombre de las rutas que salen{" "}
            <b>«(sin nombre de ruta)»</b>, que es el dato que las junta en una misma ficha.
          </p>
          <p className="mt-2 text-[11px] text-gray-500">
            El <b>precio cliente</b> es la tarifa por servicio tal como entra a la valorización —
            la misma que muestra la línea del cierre, ya sin IGV si marcaste que los precios del ERP
            lo incluyen— y debajo, lo que la ruta suma en el periodo. La ida y el retorno van a
            <b> una sola</b> tarifa: el retorno queda en S/ 0.00 a propósito.
          </p>
          <p className="mt-2 text-[11px] text-gray-500">
            La columna <b>Unidad menor</b> es la capacidad del bus más chico que cubrió la ruta en el
            periodo. Está solo como referencia y <b>no se copia sola</b>: es un dato de la flota, no del
            contrato, y confundirlos es exactamente lo que hacía que el formato declarara un número que
            nadie pactó. Una ruta sin capacidad se liquida igual, pero su ítem sale sin el «N PAX».
          </p>
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end sticky bottom-0 bg-white rounded-b-2xl">
          <span className="mr-auto text-xs text-gray-500 self-center">
            {sinPax ? `${sinPax} de ${rutas.length} sin capacidad contratada` : "Todas las rutas del periodo tienen su capacidad"}
          </span>
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={guardar} disabled={guardando || !catalogoDisponible}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-[#0b315f] disabled:opacity-50">
            {guardando ? "Guardando…" : "Guardar fichas"}
          </button>
        </div>
      </div>
    </div>
  );
}
