"use client";
// ──────────────────────────────────────────────────────────────────────────────
// ModalCostos — pactar y CORREGIR el costo del proveedor sin salir de Liquidaciones.
//
// Por qué existe: la pantalla que DETECTA el problema era de solo lectura. Un
// servicio marcado "Sin costo de proveedor" obligaba a volver a Programación, uno
// por uno, sin saber cuánto se pactó — así que el bloque rojo se quedaba rojo y el
// mes no cerraba.
//
// Y por qué tiene DOS modos (`faltantes` | `periodo`): durante mucho tiempo solo se
// abría con `sinCosto.length > 0`, o sea únicamente para RELLENAR. Un costo ya
// cargado y equivocado —S/ 664.41 donde se pactó S/ 480— no tenía ningún camino en
// lote, y en cuanto no faltaba ninguno el botón DESAPARECÍA: la única pantalla que ve
// lo que se le paga a cada proveedor en el mes no ofrecía cambiarlo. Renegociar una
// tarifa era abrir los servicios de a uno desde Programación.
//
// Tres cosas que le ahorran el trabajo a quien cierra el periodo:
//   · Agrupa por proveedor + ruta: se cargan 22 servicios con un solo importe.
//   · Propone el importe donde YA existe en el ERP (la factura de compra o el gasto
//     de pago a tercero de ese mismo servicio) — v_costo_tercero_huerfano.
//   · Sugiere el último costo realmente pactado con ese proveedor en esa ruta
//     (fn_costo_sugerido). El tarifario de compra no hay que crearlo: es el historial.
//
// Y muestra el COSTO REAL según la afectación, porque un taxi exonerado de S/ 500
// cuesta más que un bus gravado de S/ 550. Ver lib/finanzas/afectacion.ts.
//
// ─── LAS TRES REGLAS QUE NO SE PUEDEN AFLOJAR ───────────────────────────────────
//
// 1. A QUÉ TRAMO SE LE ESCRIBE LO DECIDE `lib/liquidacion-dinero.ts`, no este modal.
//    La regla («el que ya lleva el importe; si ninguno, el que se prestó; a igualdad,
//    la ida») vivía duplicada aquí y en ModalPrecios, y era suficiente MIENTRAS el
//    modal solo viera días con los dos tramos en S/ 0.00. Con los importes ya cargados
//    a la vista deja de serlo: un día cuya tarifa vive en el RETORNO recibiría el
//    importe nuevo en la IDA y quedaría pagado DOS VECES.
//
// 2. SE ESCRIBE POR `guardarReservas`, la misma puerta que Programación. Antes este
//    modal hacía su propio `update` crudo, así que el acta que levanta el trigger nacía
//    con `motivo: null` —cada costo pactado desde el cierre sin decir por qué—, un lote
//    que fallaba no nombraba ninguna fila, y la degradación por migración accesoria
//    estaba escrita a mano y solo para `compra_afectacion`.
//
// 3. PISAR UN IMPORTE PIDE MOTIVO Y BLOQUEA EL BOTÓN. Rellenar un S/ 0.00 es completar
//    un dato que falta; cambiar un importe ya pactado es mover plata, y el acta es la
//    única constancia de por qué. Mismo candado que `falso_flete_motivo` y el masivo
//    del contrato. Rellenar sigue sin pedir nada: un peaje que sale siempre se vuelve
//    paisaje.
//
// Y EL IMPORTE NUEVO SE TECLEA, NUNCA SE PRECARGA CON EL ACTUAL: un campo relleno
// invita al Enter ciego, y «aplicar a todo el grupo» sobre una rejilla precargada es la
// forma más rápida de reescribir el mes entero con el número que ya estaba. Mismo
// criterio que el PAX contratado de /programacion: los dos números a la vista, con
// etiquetas distintas, y nunca un botón «usar este».
//
// Requiere supabase/pacto-00-tributario.sql y supabase/pacto-01-costeo.sql.
// Matriz del motor: npx tsx scripts/prueba-liquidacion-dinero.mts
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { AFECTACIONES, afectacionDe, costoReal, type CodigoAfectacion } from "@/lib/finanzas/afectacion";
import { guardarReservas } from "@/lib/reservas-pacto";
import {
  planDeImportes, indiceDelDia, tramoQueLlevaElImporte, importeDe,
  TEXTO_MOTIVO_DINERO, type ServicioDinero,
} from "@/lib/liquidacion-dinero";

export type ReservaSinCosto = {
  id: number;
  codigo?: string | null;
  fecha_servicio?: string | null;
  hora_servicio?: string | null;
  direccion_servicio?: string | null;
  /** Enlaza la ida con su retorno: de ese par se paga un solo tramo. */
  reserva_vinculada_id?: number | null;
  estado?: string | null;
  ruta_nombre?: string | null;
  empresa_tercerizada_id?: number | null;
  vehiculo_tercero_id?: number | null;
  compra_afectacion?: string | null;
  /** Lo que la fila ya dice. En modo `periodo` es justo lo que se viene a corregir. */
  costo_proveedor?: number | null;
};

/**
 * Motivos del acta, las mismas claves de `pacto_motivo` que ofrece Programación. Se
 * filtran a los del lado COMPRA: acá solo se mueve lo que se le paga al proveedor.
 */
const MOTIVOS_COSTO = [
  { clave: "precio_renegociado",     nombre: "Importe renegociado con el proveedor" },
  { clave: "proveedor_mejor_precio", nombre: "Proveedor más barato" },
  { clave: "proveedor_sin_unidad",   nombre: "Proveedor sin unidad" },
  { clave: "proveedor_incumplio",    nombre: "Proveedor incumplió" },
  { clave: "cliente_unidad_mayor",   nombre: "Cliente pidió unidad mayor" },
  { clave: "cliente_unidad_menor",   nombre: "Cliente pidió unidad menor" },
  { clave: "averia_unidad",          nombre: "Avería de la unidad" },
  { clave: "correccion_carga",       nombre: "Corrección de un dato" },
];

type Props = {
  /** Las filas que se ENSEÑAN. En modo `faltantes`, las bloqueadas por `sin_costo`. */
  reservas: ReservaSinCosto[];
  /**
   * Todos los tramos del periodo a la vista. El juicio del DÍA se hace sobre esto y no
   * sobre las filas que se enseñan: sin el hermano, un día cuya tarifa vive en el otro
   * tramo se vería como un día sin costo y recibiría el importe por segunda vez. Es el
   * mismo reparto `contexto` / `universo` de lib/reservas-masivo.ts, y por la misma
   * razón. Por defecto, las propias filas.
   */
  contexto?: ReservaSinCosto[];
  /** `faltantes` = solo lo que bloquea el cierre. `periodo` = todo, para corregir. */
  modo?: "faltantes" | "periodo";
  /**
   * Cuántos días del periodo están PARTIDOS en dos por falta de `reserva_vinculada_id`.
   * El motor solo puede emparejar lo que el enlace declara, así que un día partido llega
   * como dos filas y un importe por ruta se le escribiría a las dos: el pago doble. No
   * se bloquea —el enlace se repara en su propio botón, y bloquear dejaría sin arreglo
   * el resto del periodo— pero se DICE, que es lo único que evita el clic a ciegas.
   */
  enlacesRotos?: number;
  terceros: Record<number, any>;
  /**
   * "BUS 50 PAX" · el tipo de unidad que cubrió el servicio. El costo del proveedor
   * depende de esto, no solo de la ruta: sin verlo, teclear un importe es adivinar, y
   * aquí el error se paga en efectivo. Opcional para no romper a quien no la pase.
   */
  unidadDe?: (r: ReservaSinCosto) => string;
  onCerrar: () => void;
  onGuardado: (n: number) => void;
};

type Grupo = {
  clave: string;
  empresaId: number | null;
  proveedor: string;
  ruta: string;
  /** El tipo de unidad de TODAS las filas del grupo: por eso admite un costo único. */
  unidad: string;
  afectacion: CodigoAfectacion;
  emiteFactura: boolean;
  filas: ReservaSinCosto[];
  sugerido?: { costo: number; base: string; dias: number; os: string } | null;
};

export default function ModalCostos({
  reservas, contexto, modo = "faltantes", enlacesRotos = 0, terceros, unidadDe, onCerrar, onGuardado,
}: Props) {
  // Importe por día. La clave es el id del tramo que LLEVA (o va a llevar) el importe;
  // el valor, lo tecleado (string para no pelear con el input vacío). Arranca SIEMPRE
  // vacío, también sobre las filas que ya tienen costo: ver la cabecera.
  const [montos, setMontos] = useState<Record<number, string>>({});
  const [afectPorGrupo, setAfectPorGrupo] = useState<Record<string, CodigoAfectacion>>({});
  const [propuestas, setPropuestas] = useState<Record<number, { monto: number; fuente: string }>>({});
  const [sugeridos, setSugeridos] = useState<Record<string, Grupo["sugerido"]>>({});
  const [motivo, setMotivo] = useState("precio_renegociado");
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");
  const [aviso, setAviso] = useState("");

  /** El universo del JUICIO: los tramos que se enseñan más los que solo dan contexto. */
  const todos = useMemo<ReservaSinCosto[]>(() => {
    const m = new Map<number, ReservaSinCosto>();
    for (const r of [...(contexto ?? []), ...reservas]) m.set(Number(r.id), r);
    return [...m.values()];
  }, [reservas, contexto]);

  const grupos = useMemo<Grupo[]>(() => {
    // De cada par ida+retorno se paga UN tramo: el proveedor cobra una tarifa por el
    // día completo y el otro tramo queda en S/ 0.00. Listar los dos invitaba a teclear
    // el importe dos veces, y eso es pagarle al proveedor el doble.
    //
    // Quién es ese tramo lo decide `lib/liquidacion-dinero.ts` y NO este modal: con los
    // importes ya cargados a la vista, la regla vieja («el que se prestó; a igualdad,
    // la ida») le habría escrito el importe a la ida de un día cuya tarifa vive en el
    // retorno. El hermano se busca sobre `todos`, no sobre las filas que se enseñan.
    const { delDia } = indiceDelDia(todos as ServicioDinero[]);
    const vistos = new Set<number>();
    const pagables: ReservaSinCosto[] = [];
    for (const x of reservas) {
      if (vistos.has(Number(x.id))) continue;
      const tramos = delDia(x as ServicioDinero);
      for (const t of tramos) vistos.add(Number(t.id));
      const elegido = tramoQueLlevaElImporte(tramos, "costo").tramo;
      // Sin destinatario (día entero cancelado, o ya duplicado) la fila se enseña igual,
      // representada por el tramo por el que entró: el plan la declarará fuera con su
      // motivo y la pantalla lo pinta. Esconderla sería que un servicio del bloque rojo
      // no aparezca en el modal que existe para desbloquearlo.
      pagables.push((elegido as ReservaSinCosto) ?? x);
    }

    const m = new Map<string, Grupo>();
    for (const r of pagables) {
      const empresaId = r.empresa_tercerizada_id ?? null;
      const t = empresaId != null ? terceros[empresaId] : null;
      const proveedor = t?.razon_social ?? "Sin empresa tercerizada";
      const ruta = r.ruta_nombre ?? "Sin ruta";
      // El TIPO DE UNIDAD entra en la clave: si en el mes rotaron un bus de 50 y una
      // van de 11, un solo casillero de costo sería incorrecto para una de las dos.
      const unidad = unidadDe?.(r) || "";
      const clave = `${empresaId ?? "x"}|${ruta}|${unidad}`;
      const g: Grupo = m.get(clave) ?? {
        clave, empresaId, proveedor, ruta, unidad,
        afectacion: (t?.afectacion_defecto ?? "10") as CodigoAfectacion,
        emiteFactura: t?.emite_factura !== false,
        filas: [] as ReservaSinCosto[],
      };
      g.filas.push(r);
      m.set(clave, g);
    }
    for (const g of m.values())
      g.filas.sort((a, b) => String(a.fecha_servicio ?? "").localeCompare(String(b.fecha_servicio ?? "")));
    return [...m.values()].sort((a, b) => b.filas.length - a.filas.length);
  }, [reservas, todos, terceros, unidadDe]);

  // ── Propuestas e historial ────────────────────────────────────────────────
  useEffect(() => {
    let vivo = true;
    (async () => {
      const ids = reservas.map((r) => r.id);
      if (ids.length) {
        // Se lee de v_costo_tercero_propuesta, NO de v_costo_tercero_huerfano: la vista
        // de propuesta ya descartó los cruces ambiguos. Una factura que calza con seis
        // servicios no dice el costo de ninguno, dice el total de todos — aceptarla en
        // cada uno multiplicaría el costo por seis.
        const { data, error } = await supabase
          .from("v_costo_tercero_propuesta")
          .select("reserva_id,importe_propuesto,fuente")
          .in("reserva_id", ids.slice(0, 500));
        if (error) {
          setAviso("Falta correr supabase/pacto-01-costeo.sql: sin eso no hay importes propuestos ni costo sugerido.");
        } else if (vivo) {
          const p: Record<number, { monto: number; fuente: string }> = {};
          for (const f of ((data as any[]) ?? []))
            p[f.reserva_id] = { monto: Number(f.importe_propuesto ?? 0), fuente: f.fuente };
          setPropuestas(p);
        }
      }

      for (const g of grupos) {
        if (g.empresaId == null) continue;
        const { data } = await supabase.rpc("fn_costo_sugerido", {
          p_empresa: g.empresaId,
          p_ruta: g.ruta === "Sin ruta" ? null : g.ruta,
          p_vehiculo_tercero: g.filas.find((f) => f.vehiculo_tercero_id)?.vehiculo_tercero_id ?? null,
        });
        const fila = Array.isArray(data) ? data[0] : data;
        if (vivo && fila?.costo != null)
          setSugeridos((prev) => ({
            ...prev,
            [g.clave]: { costo: Number(fila.costo), base: fila.base, dias: Number(fila.dias ?? 0), os: fila.os },
          }));
      }
    })();
    return () => { vivo = false; };
  }, [reservas, grupos]);

  // ── Acciones ──────────────────────────────────────────────────────────────
  const aplicarAGrupo = (g: Grupo, valor: string) =>
    setMontos((p) => ({ ...p, ...Object.fromEntries(g.filas.map((f) => [f.id, valor])) }));

  const aceptarPropuestas = (g: Grupo) =>
    setMontos((p) => ({
      ...p,
      ...Object.fromEntries(
        g.filas.filter((f) => propuestas[f.id]).map((f) => [f.id, String(propuestas[f.id].monto)])
      ),
    }));

  const afectacionDeGrupo = (g: Grupo): CodigoAfectacion => afectPorGrupo[g.clave] ?? g.afectacion;

  /**
   * El plan, juzgado contra lo que va a quedar guardado y no contra la base. Es el
   * MISMO motor que corre al guardar: una pantalla con su propia idea de «esto se va a
   * escribir» es el bug del semáforo de puntualidad.
   */
  const plan = useMemo(() => planDeImportes({
    lado: "costo",
    contexto: todos as ServicioDinero[],
    tecleado: Object.entries(montos)
      .map(([id, v]) => ({ id: Number(id), importe: Number(v) }))
      .filter((x) => Number.isFinite(x.importe) && x.importe > 0),
  }), [montos, todos]);

  /** Lo que el plan dejó fuera, indexado para pintarlo al lado de su fila. */
  const fueraPorId = useMemo(
    () => new Map(plan.fuera.map((f) => [f.id, f])),
    [plan]
  );

  const totales = useMemo(() => {
    let nominal = 0, real = 0;
    const porId = new Map(plan.escribir.map((x) => [x.id, x]));
    for (const g of grupos) {
      const af = afectacionDeGrupo(g);
      for (const f of g.filas) {
        const w = porId.get(Number(f.id));
        if (!w) continue;
        nominal += w.importe;
        real += costoReal(w.importe, af, { emiteFactura: g.emiteFactura });
      }
    }
    return { nominal, real };
  }, [plan, grupos, afectPorGrupo]);

  const faltaMotivo = plan.requiereMotivo && !motivo;

  async function guardar() {
    if (!plan.escribir.length || faltaMotivo) return;

    // La plata se NOMBRA antes de autorizarla: cuántos servicios y de qué suma a qué
    // suma. Igual que el botón «Poner en S/ 0.00» y el masivo del contrato. Solo cuando
    // se PISA algo: confirmar lo que se está rellenando sería un clic de trámite.
    if (plan.pisados > 0 && !confirm(
      `Se va a cambiar el costo pactado de ${plan.pisados} servicio(s) que YA tenían importe:\n` +
      `${fmtMoneda(plan.totalAntes)} → ${fmtMoneda(plan.totalDespues)}.\n\n` +
      (plan.nuevos > 0 ? `Además se carga el costo de ${plan.nuevos} servicio(s) que no lo tenían.\n\n` : "") +
      `Queda registrado en el acta del servicio con el motivo elegido.\n\n¿Continuar?`
    )) return;

    setGuardando(true); setMsg(""); setAviso("");

    // La afectación viaja con el importe: es del proveedor y del grupo, no del día.
    const afectDe = new Map<number, CodigoAfectacion>();
    for (const g of grupos) for (const f of g.filas) afectDe.set(Number(f.id), afectacionDeGrupo(g));

    // Un UPDATE por (importe, afectación): los servicios de una ruta comparten tarifa,
    // así que un mes son dos o tres llamadas y no 22.
    const lotes = new Map<string, { patch: Record<string, any>; ids: number[] }>();
    for (const x of plan.escribir) {
      const patch = {
        costo_proveedor: x.importe,
        compra_afectacion: afectDe.get(x.idTecleado) ?? afectDe.get(x.id) ?? "10",
      };
      const k = JSON.stringify(patch);
      const lote = lotes.get(k) ?? { patch, ids: [] as number[] };
      lote.ids.push(x.id);
      lotes.set(k, lote);
    }

    // Se escribe por `guardarReservas`: rechazos con nombre, degradación por la columna
    // que el error NOMBRA, y el motivo en el mismo UPDATE para que el trigger lo copie
    // al acta. Un `update` propio sería un cuarto camino con las reglas escritas otra vez.
    const cambio = plan.requiereMotivo ? { motivo, nota: nota.trim() || null } : undefined;
    let guardadosTotal = 0;
    const rechazos: { id: number; motivo: string }[] = [];
    const avisos: string[] = [];
    for (const l of lotes.values()) {
      const r = await guardarReservas(supabase, l.ids, l.patch, cambio);
      guardadosTotal += r.guardados.length;
      rechazos.push(...r.rechazos);
      if (r.aviso && !avisos.includes(r.aviso)) avisos.push(r.aviso);
    }
    setGuardando(false);

    if (avisos.length) setAviso(avisos.join(" "));
    if (rechazos.length) {
      setMsg(`⚠️ ${guardadosTotal} guardado(s), ${rechazos.length} rechazado(s). `
           + `#${rechazos[0].id}: ${rechazos[0].motivo}`);
      if (!guardadosTotal) return;
    }
    // Con rechazos NO se cierra: el operador tiene que poder ver cuál falló. Sin ellos,
    // la pantalla de atrás recarga y el bloque rojo se recalcula.
    if (!rechazos.length) onGuardado(guardadosTotal);
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  const inputCls = "w-32 px-2 py-1 border rounded-lg text-sm text-right tabular-nums";
  const conImporte = plan.escribir.length;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl my-8">
        <div className="px-6 py-4 border-b flex items-center justify-between sticky top-0 bg-white rounded-t-2xl z-10">
          <div>
            <h2 className="text-lg font-black text-gray-800">
              {modo === "periodo" ? "Costos del proveedor en el periodo" : "Cargar costos del proveedor"}
            </h2>
            <p className="text-xs text-gray-500">
              {modo === "periodo"
                ? <>{reservas.length} día(s) · {grupos.length} grupo(s) · escribe solo lo que quieras cambiar</>
                : <>{reservas.length} servicio(s) sin costo pactado · {grupos.length} grupo(s)</>}
            </p>
          </div>
          <button onClick={onCerrar} className="text-gray-400 hover:text-gray-600 text-2xl leading-none px-2">×</button>
        </div>

        {aviso && (
          <div className="mx-6 mt-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-[12px] text-amber-800">
            {aviso}
          </div>
        )}

        {enlacesRotos > 0 && (
          <div className="mx-6 mt-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-[12px] text-amber-800">
            <b>{enlacesRotos} día(s) del periodo están partidos en dos</b> porque les falta el
            enlace ida↔retorno. El ERP solo puede emparejar lo que ese enlace declara, así que
            esos días salen como DOS filas y un importe por ruta se les escribiría a las dos —
            pagando el día dos veces. Ciérralos primero con «Enlazar tramo(s) ida↔retorno».
          </div>
        )}

        <div className="p-6 space-y-5">
          {grupos.map((g) => {
            const sug = sugeridos[g.clave];
            const af = afectacionDeGrupo(g);
            const nProp = g.filas.filter((f) => propuestas[f.id]).length;
            return (
              <div key={g.clave} className="border rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 border-b">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-black text-gray-800 text-sm">{g.proveedor}</span>
                    <span className="text-gray-400">·</span>
                    <span className="text-sm text-gray-600">{g.ruta}</span>
                    {/* El tipo de unidad: de él depende el costo, no solo de la ruta. */}
                    {g.unidad && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700">{g.unidad}</span>
                    )}
                    <span className="text-[11px] text-gray-500 bg-white border rounded-full px-2 py-0.5">
                      {g.filas.length} servicio(s)
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 mt-3">
                    <label className="text-[11px] text-gray-500 uppercase tracking-wide font-bold">
                      Aplicar a todo el grupo
                    </label>
                    <input
                      type="number" min="0" step="0.01" placeholder="0.00" className={inputCls}
                      onChange={(e) => aplicarAGrupo(g, e.target.value)}
                    />
                    {sug && (
                      <button
                        onClick={() => aplicarAGrupo(g, String(sug.costo))}
                        className="text-[11px] px-2 py-1 rounded-lg bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100"
                      >
                        Usar {fmtMoneda(sug.costo)} · último con este proveedor en {sug.base}, hace {sug.dias} día(s)
                      </button>
                    )}
                    {nProp > 0 && (
                      <button
                        onClick={() => aceptarPropuestas(g)}
                        className="text-[11px] px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                      >
                        Aceptar {nProp} importe(s) ya facturado(s)
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <label className="text-[11px] text-gray-500 uppercase tracking-wide font-bold">IGV</label>
                    <select
                      className="px-2 py-1 border rounded-lg text-xs"
                      value={af}
                      onChange={(e) => setAfectPorGrupo((p) => ({ ...p, [g.clave]: e.target.value as CodigoAfectacion }))}
                    >
                      {Object.values(AFECTACIONES).map((a) => (
                        <option key={a.codigo} value={a.codigo}>{a.codigo} · {a.nombre}</option>
                      ))}
                    </select>
                    <span className="text-[11px] text-gray-500">
                      {afectacionDe(af).grava
                        ? (g.emiteFactura
                            ? "El IGV vuelve como crédito fiscal: el costo real es el neto."
                            : "Gravado pero sin factura: no hay crédito, cuesta el importe completo.")
                        : "Sin IGV: no hay crédito fiscal ni detracción, cuesta el importe completo."}
                    </span>
                  </div>
                </div>

                <div className="divide-y max-h-64 overflow-y-auto">
                  {g.filas.map((f) => {
                    const prop = propuestas[f.id];
                    const actual = importeDe(f as ServicioDinero, "costo");
                    const escrito = plan.escribir.find((x) => x.idTecleado === Number(f.id));
                    const bloqueo = fueraPorId.get(Number(f.id));
                    const v = escrito?.importe ?? 0;
                    return (
                      <div key={f.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                        <span className="font-mono text-xs text-gray-700 w-40 shrink-0">{f.codigo ?? "#" + f.id}</span>
                        <span className="text-xs text-gray-400 w-24 shrink-0">{f.fecha_servicio}</span>
                        <span className="text-xs text-gray-400 w-16 shrink-0">
                          {f.direccion_servicio === "retorno" ? "retorno" : "ida"}
                        </span>
                        {/* El importe ACTUAL, con su etiqueta, al lado del campo vacío. Los
                            dos números a la vista es lo único que rompe el reflejo de dar
                            por bueno lo que ya está — y no hay botón «usar este». */}
                        <span className="w-28 text-right text-[11px] tabular-nums shrink-0 text-gray-500">
                          {actual > 0 ? <>hoy <b className="text-gray-700">{fmtMoneda(actual)}</b></> : "sin costo"}
                        </span>
                        <span className="flex-1 text-[11px] truncate">
                          {bloqueo && bloqueo.motivo !== "sin_importe" && bloqueo.motivo !== "sin_cambio"
                            ? <span className="text-amber-700">{TEXTO_MOTIVO_DINERO[bloqueo.motivo]}</span>
                            : prop ? <span className="text-emerald-700">Ya facturado {fmtMoneda(prop.monto)} · {prop.fuente}</span>
                            : ""}
                        </span>
                        <input
                          type="number" min="0" step="0.01"
                          placeholder={actual > 0 ? "nuevo" : "0.00"} className={inputCls}
                          value={montos[f.id] ?? ""}
                          onChange={(e) => setMontos((p) => ({ ...p, [f.id]: e.target.value }))}
                        />
                        <span className="w-28 text-right text-[11px] text-gray-500 tabular-nums shrink-0">
                          {v > 0 ? `real ${fmtMoneda(costoReal(v, af, { emiteFactura: g.emiteFactura }))}` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* El acta. Solo cuando se PISA un importe ya pactado: rellenar lo que falta no
            mueve plata que alguien acordó, y un peaje que sale siempre se vuelve paisaje. */}
        {plan.requiereMotivo && (
          <div className="mx-6 mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
            <p className="text-[12px] font-bold text-amber-900">
              {plan.pisados} servicio(s) ya tenían costo pactado: {fmtMoneda(plan.totalAntes)} → {fmtMoneda(plan.totalDespues)}.
            </p>
            <p className="text-[11px] text-amber-800 mt-0.5">
              Queda un acta por servicio con quién, cuándo y por qué. El motivo es obligatorio.
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <select value={motivo} onChange={(e) => setMotivo(e.target.value)}
                className="px-2 py-1.5 border rounded-lg text-xs bg-white">
                <option value="">— Elige el motivo —</option>
                {MOTIVOS_COSTO.map((m) => <option key={m.clave} value={m.clave}>{m.nombre}</option>)}
              </select>
              <input value={nota} onChange={(e) => setNota(e.target.value)}
                placeholder="Nota (opcional): el detalle que el motivo no dice"
                className="flex-1 min-w-[16rem] px-2 py-1.5 border rounded-lg text-xs" />
            </div>
          </div>
        )}

        <div className="px-6 py-4 border-t bg-gray-50 rounded-b-2xl sticky bottom-0">
          {msg && <p className="text-xs text-red-600 mb-2">{msg}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-gray-600">
              <span className="font-black text-gray-800">{conImporte}</span> servicio(s) van a cambiar
              {plan.pisados > 0 && <> · <b className="text-amber-700">{plan.pisados} pisa(n)</b> un costo ya pactado</>}
              {" "}· nominal <span className="font-bold tabular-nums">{fmtMoneda(totales.nominal)}</span> ·
              costo real <span className="font-bold tabular-nums">{fmtMoneda(totales.real)}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm text-gray-600 hover:bg-white">
                Cancelar
              </button>
              <button
                onClick={guardar}
                disabled={guardando || !conImporte || faltaMotivo}
                title={faltaMotivo ? "Elige el motivo: se está cambiando un costo ya pactado" : ""}
                className="px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-bold disabled:opacity-40 hover:bg-violet-700"
              >
                {guardando ? "Guardando…" : `Pactar ${conImporte} servicio(s)`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
