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
//   · De cada par se cobra UN tramo y el otro queda en S/ 0.00. AFA cobra un solo
//     importe por los dos tramos del día (ver lib/liquidacion-agrupacion.ts): cargar el
//     precio en los dos facturaría el doble. Cuál lo lleva no es siempre la ida — si el
//     cliente canceló la ida y el retorno sí se prestó, va en el retorno.
//
// Y el caso que obligó a lo de "va incluido": hay retornos SIN `reserva_vinculada_id`.
// Sin ese enlace el ERP no puede saber qué ida los cubre, así que los pedía como
// servicios sueltos — y ponerles precio habría cobrado el día dos veces. Este modal les
// busca su ida (mismo cliente, misma fecha, ruta contraria, la que lleva la tarifa) y
// ofrece REPARAR el vínculo en vez de un flag nuevo de "incluido": ese flag sería un
// segundo sitio donde vive "estos dos tramos son el mismo día", y el problema es
// justamente que al primero le faltan filas.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { nombreRuta, sentidoDeReserva, origenContractual, type ReservaLiq } from "@/lib/liquidacion-agrupacion";
import { indiceHermanos, repararEnlaces } from "@/lib/liquidacion-hermanos";

export type ReservaSinPrecio = ReservaLiq & { clienteNombre?: string };

/**
 * La ida que cubre a un retorno huérfano.
 *
 * Un retorno sin `reserva_vinculada_id` es invisible como "tramo incluido": el ERP no
 * tiene con qué saber qué ida lleva su tarifa, así que lo pide como si fuera un servicio
 * suelto. Y cargarle un precio sería cobrarle al cliente dos veces el mismo día.
 *
 * La solución no es un campo nuevo de "va incluido" —sería un segundo sitio donde vive
 * "estos dos tramos son el mismo día", y ya hay uno— sino REPARAR el vínculo que falta.
 * Con eso el retorno deja de pedir precio en este cierre y en todos los siguientes, y
 * de paso se arreglan el aviso de Programación y el conteo del par.
 */
type IdaCandidata = {
  id: number;
  codigo: string | null;
  hora: string | null;
  precio: number;
};

type GrupoRuta = {
  clave: string;
  cliente: string;
  ruta: string;
  /** El tipo de unidad de TODAS las filas del grupo: por eso admite un precio único. */
  unidad: string;
  /** contrato | adicional | contingencia. Un adicional NO se cobra a la tarifa del contrato. */
  origen: string;
  /** Solo los tramos a los que se les va a escribir el importe. */
  filas: ReservaSinPrecio[];
  /** Tramos huérfanos a los que se les encontró su ida: van incluidos, no llevan importe. */
  conIda: ReservaSinPrecio[];
  /** Los retornos que quedan cubiertos por esa misma tarifa, para poder decirlo. */
  cubiertos: number;
  desde: string;
  hasta: string;
};

const LOTE = 200;

export default function ModalPrecios({
  reservas, unidadDe, onCerrar, onGuardado,
}: {
  reservas: ReservaSinPrecio[];
  /** "BUS 50 PAX" · el tipo de unidad que cubrió el servicio. La tarifa depende de esto. */
  unidadDe: (r: ReservaSinPrecio) => string;
  onCerrar: () => void;
  onGuardado: (servicios: number) => void;
}) {
  const [montos, setMontos] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");
  /** reserva huérfana → la ida que la cubre, cuando se encontró UNA sola. */
  const [candidatas, setCandidatas] = useState<Map<number, IdaCandidata>>(new Map());
  /** Cuáles se van a enlazar al guardar. Arrancan marcadas: es lo que casi siempre toca. */
  const [enlazar, setEnlazar] = useState<Set<number>>(new Set());
  const [resuelto, setResuelto] = useState(false);
  /** clave del grupo → último precio cobrado en esa ruta con esa misma unidad. */
  const [ultimos, setUltimos] = useState<Map<string, { precio: number; dias: number; os: string }>>(new Map());

  /** Tramos sin par y el rango donde buscarlo. null = no hay nada que reparar. */
  const objetivo = useMemo(() => {
    const huerfanos = reservas.filter((r) => !r.reserva_vinculada_id);
    const clientes = [...new Set(huerfanos.map((r) => r.cliente_id).filter(Boolean))] as number[];
    const fechas = [...new Set(huerfanos.map((r) => String(r.fecha_servicio ?? "")).filter(Boolean))];
    return huerfanos.length && clientes.length && fechas.length ? { huerfanos, clientes, fechas } : null;
  }, [reservas]);

  const buscando = !!objetivo && !resuelto;

  // ── Buscar la ida de cada tramo huérfano ──────────────────────────────────
  useEffect(() => {
    if (!objetivo) return;
    const { huerfanos, clientes, fechas } = objetivo;
    let vivo = true;
    (async () => {
      const { data } = await supabase
        .from("reservas")
        .select("id,codigo,cliente_id,fecha_servicio,hora_servicio,ruta_nombre,direccion_servicio,precio_cliente,reserva_vinculada_id")
        .in("cliente_id", clientes)
        .in("fecha_servicio", fechas);
      if (!vivo) return;

      // Quién va con quién lo contesta lib/liquidacion-hermanos.ts, que es el ÚNICO sitio
      // donde vive la regla "estos dos tramos son el mismo día" — la misma que usa el
      // cierre para no pedir dos veces la tarifa. Antes esa regla estaba escrita acá
      // dentro, y la del cierre por su cuenta: dos definiciones del mismo dato es
      // exactamente lo que este módulo no puede permitirse.
      const indice = indiceHermanos(((data as any[]) ?? []) as ReservaLiq[]);
      const hallado = new Map<number, IdaCandidata>();

      for (const h of huerfanos) {
        const otro = indice.hermanoDe(h) ?? indice.hermanoProbableDe(h);
        // Solo cuenta como "va incluido" si el otro tramo LLEVA la tarifa del día: si
        // ninguno de los dos la lleva, el precio sí falta y hay que pedirlo.
        if (!otro || Number(otro.precio_cliente ?? 0) <= 0) continue;
        hallado.set(h.id, {
          id: otro.id, codigo: otro.codigo ?? null,
          hora: String(otro.hora_servicio ?? "").slice(0, 5),
          precio: Number(otro.precio_cliente ?? 0),
        });
      }
      setCandidatas(hallado);
      setEnlazar(new Set(hallado.keys()));
      setResuelto(true);
    })();
    return () => { vivo = false; };
  }, [objetivo]);

  const grupos = useMemo<GrupoRuta[]>(() => {
    // De cada par se cobra UN tramo; el otro queda en S/ 0.00 cubierto por la tarifa.
    // Cuál lo lleva NO es siempre la ida: si el cliente canceló la ida y el retorno sí
    // se prestó, el importe tiene que ir donde hubo servicio, o el día no se factura.
    const porId = new Map(reservas.map((r) => [r.id, r]));
    // El par se resuelve por los DOS sentidos del enlace: si estuviera escrito solo en el
    // otro tramo, los dos aparecerían como filas sueltas y escribir un importe se lo
    // pondría a los dos, que es cobrar el día dos veces.
    const enLaLista = indiceHermanos(reservas as ReservaLiq[]);
    const hecho = (r?: ReservaSinPrecio | null) => String(r?.estado ?? "").toLowerCase() === "finalizada";
    const tramoQueCobra = (a: ReservaSinPrecio, b?: ReservaSinPrecio | null): ReservaSinPrecio => {
      if (!b) return a;
      if (hecho(a) !== hecho(b)) return hecho(a) ? a : b;      // manda el que se prestó
      return sentidoDeReserva(a) === "IDA" ? a : b;            // a igualdad, la ida
    };

    const vistos = new Set<number>();
    const cobran: ReservaSinPrecio[] = [];
    for (const r of reservas) {
      if (vistos.has(r.id)) continue;
      const hermano = enLaLista.hermanoDe(r);
      const par = hermano ? porId.get(hermano.id) : undefined;
      vistos.add(r.id);
      if (par) vistos.add(par.id);
      cobran.push(tramoQueCobra(r, par));
    }
    const cubiertos = reservas.length - cobran.length;

    const mapa = new Map<string, GrupoRuta>();
    for (const r of cobran) {
      const ruta = nombreRuta(r);
      const cliente = r.clienteNombre ?? "—";
      // El TIPO DE UNIDAD entra en la clave. Si en el mes rotaron un bus de 50 y una van
      // de 11, un solo casillero de precio para las dos sería incorrecto para una de las
      // dos: se separan y cada renglón admite el precio que de verdad le toca.
      const unidad = unidadDe(r) || "SIN UNIDAD ASIGNADA";
      // El ORIGEN también parte el grupo, y no es cosmética: un adicional de la misma
      // ruta y la misma unidad compartía casillero con los servicios del contrato, así
      // que escribir un precio le aplicaba la tarifa contractual a lo que se acordó
      // aparte — exactamente lo que este módulo existe para impedir.
      const origen = origenContractual(r);
      const clave = `${cliente}|${ruta}|${unidad}|${origen}`;
      const f = String(r.fecha_servicio ?? "");
      const g = mapa.get(clave) ?? { clave, cliente, ruta, unidad, origen, filas: [], conIda: [], cubiertos: 0, desde: f, hasta: f };
      // Un tramo al que se le encontró su ida NO necesita tarifa: la lleva ella. Se
      // aparta para ofrecer el enlace en vez de un importe que cobraría el día dos veces.
      (candidatas.has(r.id) ? g.conIda : g.filas).push(r);
      if (f && (!g.desde || f < g.desde)) g.desde = f;
      if (f && (!g.hasta || f > g.hasta)) g.hasta = f;
      mapa.set(clave, g);
    }
    const salida = [...mapa.values()].sort((a, b) => a.ruta.localeCompare(b.ruta));
    // El total de tramos cubiertos se reparte de forma informativa en el primer grupo:
    // el número que importa al operador es "cuántos servicios voy a desbloquear".
    if (salida.length) salida[0].cubiertos = cubiertos;
    return salida;
  }, [reservas, candidatas, unidadDe]);

  /**
   * El último precio que se le cobró a ese cliente por esa MISMA ruta con esa MISMA
   * unidad. Es lo que de verdad evita el error: nadie tiene que acordarse de cuánto se
   * cobró en julio. El lado proveedor ya tenía su equivalente (fn_costo_sugerido en
   * ModalCostos); del lado cliente faltaba.
   *
   * Se propone, NO se rellena solo: un importe prellenado que nadie mira es el mismo
   * error de siempre, nada más que más rápido.
   */
  useEffect(() => {
    const clientes = [...new Set(reservas.map((r) => r.cliente_id).filter(Boolean))] as number[];
    if (!clientes.length || !grupos.length) return;
    let vivo = true;
    (async () => {
      const COLS = "id,codigo,cliente_id,fecha_servicio,ruta_nombre,origen,destino,precio_cliente,vehiculo_id,vehiculo_tercero_id";
      const pedir = (cols: string) => supabase
        .from("reservas")
        .select(cols)
        .in("cliente_id", clientes)
        .gt("precio_cliente", 0)
        .order("fecha_servicio", { ascending: false })
        .limit(600);
      // `origen_contractual` es de supabase/reservas-04 y aquí NO es decorativo: un
      // adicional que se cobró S/ 480 por una unidad mayor no puede proponerse como
      // referencia del precio contractual. Si la migración no está, se sugiere igual
      // (es lo que se hacía hasta ahora) en vez de quedarse sin sugerencia.
      let res = await pedir(`${COLS},origen_contractual`);
      if (res.error) res = await pedir(COLS);
      const data = res.data;
      if (!vivo) return;

      const hoy = Date.now();
      const out = new Map<string, { precio: number; dias: number; os: string }>();
      for (const g of grupos) {
        // A un ADICIONAL no se le propone la tarifa del contrato: se acordó aparte, y
        // un importe prellenado que nadie mira es el error de siempre, más rápido.
        if (g.origen !== "contrato") continue;
        // Mismo cliente, misma ruta y misma unidad: si cambia cualquiera de los tres, el
        // precio anterior no es comparable y es mejor no sugerir nada.
        const previo = ((data as any[]) ?? []).find(
          (x) =>
            String(x.origen_contractual || "contrato") === "contrato" &&
            nombreRuta(x) === g.ruta &&
            (unidadDe(x as ReservaSinPrecio) || "SIN UNIDAD ASIGNADA") === g.unidad &&
            !g.filas.some((f) => f.id === Number(x.id))
        );
        if (!previo) continue;
        const t = Date.parse(String(previo.fecha_servicio ?? ""));
        out.set(g.clave, {
          precio: Number(previo.precio_cliente ?? 0),
          dias: Number.isFinite(t) ? Math.max(0, Math.round((hoy - t) / 86400000)) : 0,
          os: String(previo.codigo ?? ""),
        });
      }
      setUltimos(out);
    })();
    return () => { vivo = false; };
  }, [grupos, reservas, unidadDe]);

  const totalAAplicar = grupos.reduce(
    (a, g) => a + (Number(montos[g.clave]) > 0 ? g.filas.length : 0), 0
  );
  const importeTotal = grupos.reduce(
    (a, g) => a + (Number(montos[g.clave]) > 0 ? Number(montos[g.clave]) * g.filas.length : 0), 0
  );

  async function guardar() {
    const conImporte = grupos.filter((g) => Number(montos[g.clave]) > 0 && g.filas.length);
    const aEnlazar = [...enlazar].filter((id) => candidatas.has(id));
    if (!conImporte.length && !aEnlazar.length) {
      setMsg("⚠️ Escribe el importe de al menos una ruta, o marca las que van incluidas en su ida.");
      return;
    }
    setGuardando(true); setMsg("");
    let hechos = 0;
    try {
      // 1) Reparar los vínculos, por el mismo camino que el botón "Enlazar ida↔retorno"
      //    del cierre: se escribe en LOS DOS lados, porque media docena de sitios del ERP
      //    leen `reserva_vinculada_id` hacia adelante y dejarlo a medias da un par que
      //    unos ven y otros no.
      if (aEnlazar.length) {
        const { reparados, errores } = await repararEnlaces(
          supabase,
          aEnlazar.map((id) => ({ tramo: { id }, hermano: candidatas.get(id)! }))
        );
        hechos += reparados;
        if (errores.length) throw new Error(`${errores.join(" · ")} (se enlazaron ${reparados})`);
      }

      // 2) Y recién ahora los importes, sobre los tramos que de verdad cobran.
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
                const marcados = g.conIda.filter((f) => enlazar.has(f.id)).length;
                const todosIncluidos = g.conIda.length > 0 && g.filas.length === 0;
                const ejemplo = g.conIda.length ? candidatas.get(g.conIda[0].id) : null;
                const ultimo = ultimos.get(g.clave);
                return (
                  <tr key={g.clave} className={precio > 0 || marcados ? "bg-emerald-50/40" : ""}>
                    <td className="px-2 py-2">
                      <span className="block font-medium text-gray-800">{g.ruta}</span>
                      <span className="block text-[10px] text-gray-400">
                        {g.cliente} · del {g.desde} al {g.hasta}
                      </span>
                      {/* El TIPO DE UNIDAD que cubrió el servicio. La tarifa depende de
                          esto —una van de 11 no se cobra como un bus de 50—, así que sin
                          verlo poner un precio es adivinar. */}
                      <span className="mt-0.5 inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700">
                        {g.unidad}
                      </span>
                      {g.origen !== "contrato" && (
                        <span className="ml-1 inline-block text-[10px] font-black px-1.5 py-0.5 rounded-full uppercase"
                              title="Pedido por encima del contrato: el precio se acordó aparte, no es la tarifa contractual."
                              style={{ background: "#fef3c7", color: "#b45309" }}>
                          {g.origen}
                        </span>
                      )}
                      {ultimo && (
                        <button type="button"
                          onClick={() => setMontos((m) => ({ ...m, [g.clave]: String(ultimo.precio) }))}
                          className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100">
                          última vez: {fmtMoneda(ultimo.precio)}
                          {ultimo.dias ? ` · hace ${ultimo.dias} d` : ""} — usar
                        </button>
                      )}
                      {/* El "va incluido" que faltaba: en vez de exigir una tarifa que
                          cobraría el día dos veces, se repara el vínculo con su ida. */}
                      {g.conIda.length > 0 && (
                        <label className="mt-1 flex items-start gap-2 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1.5 cursor-pointer">
                          <input type="checkbox" className="mt-0.5"
                            checked={marcados === g.conIda.length}
                            onChange={(e) => setEnlazar((s) => {
                              const n = new Set(s);
                              for (const f of g.conIda) e.target.checked ? n.add(f.id) : n.delete(f.id);
                              return n;
                            })} />
                          <span>
                            <b>{g.conIda.length} van incluidos en su ida</b>
                            {ejemplo && <> — p. ej. {ejemplo.codigo ?? `#${ejemplo.id}`} ({ejemplo.hora}, {fmtMoneda(ejemplo.precio)})</>}
                            . Les falta el enlace ida↔retorno y por eso se pedían aparte;
                            al marcarlo se enlazan y dejan de pedir tarifa.
                          </span>
                        </label>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center text-xs text-gray-500">
                      {g.filas.length || "—"}
                    </td>
                    <td className="px-2 py-2">
                      {todosIncluidos ? (
                        <span className="block text-center text-[11px] text-emerald-700">incluido</span>
                      ) : (
                        <input type="number" min="0" step="0.01"
                          className="w-full px-2 py-1 rounded border text-sm text-right"
                          placeholder="0.00"
                          value={montos[g.clave] ?? ""}
                          onChange={(e) => setMontos((m) => ({ ...m, [g.clave]: e.target.value }))} />
                      )}
                    </td>
                    <td className="px-2 py-2 text-right font-bold text-gray-700">
                      {todosIncluidos ? "S/ 0.00" : precio > 0 ? fmtMoneda(precio * g.filas.length) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="mt-3 text-[11px] text-gray-500">
            El importe se escribe en <b>un solo tramo</b> de cada día — normalmente la ida, y el
            retorno se queda en S/ 0.00 a propósito: AFA cobra <b>una sola tarifa por los dos
            tramos</b>, y cargarla en ambos facturaría el doble. Si un día la ida se canceló y el
            retorno sí se prestó, el importe va al <b>retorno</b>, que es donde hubo servicio.
            {grupos[0]?.cubiertos ? ` En este lote hay ${grupos[0].cubiertos} retorno(s) que quedan cubiertos así.` : ""}
            {" "}Comprueba el precio con la cotización antes de guardar: es el que va a la factura.
          </p>
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end sticky bottom-0 bg-white rounded-b-2xl">
          <span className="mr-auto text-xs text-gray-500 self-center">
            {buscando ? "Buscando la ida de cada tramo…" : (
              <>
                {enlazar.size > 0 && <><b>{enlazar.size}</b> se enlazan con su ida{totalAAplicar ? " · " : ""}</>}
                {totalAAplicar > 0 && <>importe a <b>{totalAAplicar}</b> servicio(s) · {fmtMoneda(importeTotal)} sin IGV</>}
                {!enlazar.size && !totalAAplicar && "Escribe el importe de al menos una ruta"}
              </>
            )}
          </span>
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={guardar} disabled={guardando || buscando || (!totalAAplicar && !enlazar.size)}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
            {guardando ? "Guardando…" : "Aplicar precios"}
          </button>
        </div>
      </div>
    </div>
  );
}
