"use client";
// ──────────────────────────────────────────────────────────────────────────────
// ModalServicios — QUÉ servicios son esos, y arreglarlos sin salir de aquí.
//
// En /liquidaciones había tres contadores que solo se podían mirar: el "3 serv." del
// bloque rojo, el "5/5 serv." de cada línea y el "142 servicio(s)" de la cabecera del
// grupo. Cuando uno de esos números estaba mal —y en un cierre siempre hay alguno— la
// única salida era abrir Programación o Seguimiento, buscar el servicio por código y
// corregirlo ahí, de a uno. Este modal es el detalle detrás del número, con el mismo
// nivel de dato que Programación (fecha, hora, ruta, placa, conductor, estado, importe)
// y editable en el sitio.
//
// TRES REGLAS QUE ESTE MODAL NO PUEDE ROMPER, y por las que no escribe él mismo:
//
//   1. SE ESCRIBE POR `guardarReservas` (lib/reservas-pacto.ts), la única puerta por la
//      que Programación escribe dinero en `reservas`. Un `update` propio aquí sería un
//      cuarto camino con las mismas reglas escritas de nuevo, y bastaría olvidar una
//      para que editar desde Liquidaciones y editar desde Programación dieran resultados
//      distintos sobre la misma fila.
//
//   2. EL DÍA SE COBRA UNA VEZ. La ida y el retorno son UN servicio a UNA tarifa: el
//      importe va en un tramo y el otro queda en S/ 0.00 a propósito. Por eso cada fila
//      conoce a su hermano y `avisosDe` avisa antes de guardar — cargar el importe en
//      los dos factura el día dos veces, y es el error más caro que se puede cometer
//      desde esta pantalla.
//
//   3. EL MONTO AUTORITATIVO ES LA RESERVA. No se "propaga" el precio a la línea, a la
//      factura y al Anexo: se escribe la fila que manda y lo demás se DERIVA. Para el
//      documento que ya existe eso es `resincronizarImportes`, y solo sobre borradores.
//
// CUÁNDO SE PUEDE EDITAR (la pregunta que el operador hace de verdad):
//
//   sin liquidar ......... todo editable
//   borrador ............. editable · al guardar se vuelve a derivar la línea
//   emitida/facturada .... el importe en solo lectura, con el camino escrito: Reabrir
//   ANULADA .............. editable de nuevo (el documento ya no existe para el negocio)
//
// El caso anulada es el que no se puede olvidar: anular devuelve los servicios al pool,
// así que un servicio cuyo FK apunta a una liquidación anulada NO está bloqueado por
// nada — bloquearlo sería dejar sin arreglo justo el mes que hubo que rehacer.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  nombreRuta, sentidoDeReserva, origenContractual,
  type ReservaLiq, type LadoLiquidacion,
} from "@/lib/liquidacion-agrupacion";
import { indiceHermanos } from "@/lib/liquidacion-hermanos";
import { guardarReservas, avisosDe, describirResultado, type AvisoPacto } from "@/lib/reservas-pacto";
import { resincronizarImportes } from "@/lib/liquidaciones";
import { ESTADOS_EDITABLES_MANUAL, etiquetaEstado, configEstado } from "@/lib/estados";

/** Origen contractual: los mismos tres valores del CHECK de `reservas`. */
const ORIGENES = ["contrato", "adicional", "contingencia"] as const;

/**
 * Columnas que solo existen con supabase/reservas-04 corrido. Se escriben aparte para
 * poder reintentar sin ellas: que falte una migración accesoria no puede impedir
 * corregir un precio en pleno cierre.
 */
const COLUMNAS_OPCIONALES = ["origen_contractual", "falso_flete", "falso_flete_motivo"] as const;

/** Lo que el operador puede cambiar de una fila. */
type Campos = {
  fecha_servicio: string;
  hora_servicio: string;
  ruta_nombre: string;
  estado: string;
  monto: string;
  origen_contractual: string;
  /**
   * El acuerdo para pagarle al proveedor un servicio CANCELADO. Sin él, el importe de una
   * cancelación no se paga por más que esté escrito: es justo el número que deja el error
   * humano de cancelar sin borrar el costo, y pagarlo por descuido no se puede deshacer.
   */
  falso_flete: boolean;
  falso_flete_motivo: string;
};

/** Estado del documento que reclama a esta reserva, y qué permite. */
type Candado = {
  /** Código o #id del documento. null = el servicio está libre. */
  documento: string | null;
  estado: string | null;
  /** false solo para emitida / conformada / observada / facturada. */
  editable: boolean;
  /** Documento en borrador al que hay que volver a derivarle los importes al guardar. */
  borradorId: number | null;
  motivo: string | null;
};

const LIBRE: Candado = { documento: null, estado: null, editable: true, borradorId: null, motivo: null };

const hhmm = (v: string | null | undefined) => String(v ?? "").slice(0, 5);
const num = (v: number | null | undefined) => (Number(v ?? 0) ? String(Number(v)) : "");

function camposDe(r: ReservaLiq, lado: LadoLiquidacion): Campos {
  return {
    fecha_servicio: String(r.fecha_servicio ?? "").slice(0, 10),
    hora_servicio: hhmm(r.hora_servicio),
    ruta_nombre: String(r.ruta_nombre ?? ""),
    estado: String(r.estado ?? ""),
    monto: num(lado === "cliente" ? r.precio_cliente : r.costo_proveedor),
    origen_contractual: origenContractual(r),
    falso_flete: r.falso_flete === true,
    falso_flete_motivo: String(r.falso_flete_motivo ?? ""),
  };
}

export default function ModalServicios({
  titulo, subtitulo, lado, reservas, universo, catalogo, unidadDe, usuario,
  onCerrar, onGuardado,
}: {
  titulo: string;
  subtitulo?: string;
  lado: LadoLiquidacion;
  /** Los servicios que se listan: exactamente los que el contador contó. */
  reservas: ReservaLiq[];
  /**
   * Todas las reservas del periodo, para encontrar el TRAMO HERMANO de cada fila. Sin
   * él los avisos mienten: todo retorno —que va en S/ 0.00 a propósito— dispararía
   * "sin precio de venta", que es el rojo falso que enseña a ignorar los rojos.
   */
  universo: ReservaLiq[];
  catalogo: { placaDe: (r: ReservaLiq) => string; conductorDe: (r: ReservaLiq) => string };
  unidadDe: (r: { vehiculo_id?: number | null; vehiculo_tercero_id?: number | null }) => string;
  usuario?: string;
  onCerrar: () => void;
  /** `resincronizadas` = documentos en borrador a los que se les volvió a derivar la línea. */
  onGuardado: (n: number, resincronizadas: number) => void;
}) {
  const [edit, setEdit] = useState<Record<number, Campos>>({});
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");
  /**
   * id de la liquidación → su estado. Se lee AQUÍ y no se recibe de la página: la página
   * trae los últimos 200 documentos del lado activo, y un servicio puede estar reclamado
   * por uno más viejo que ése. `null` = todavía no se leyó.
   */
  const [docs, setDocs] = useState<Map<number, { codigo: string; estado: string }> | null>(null);
  /** Valores para la edición en bloque de las filas marcadas. */
  const [bloque, setBloque] = useState({ monto: "", estado: "", origen: "" });

  const etiquetaMonto = lado === "cliente" ? "Precio cliente" : "Costo proveedor";
  const campoMonto = lado === "cliente" ? "precio_cliente" : "costo_proveedor";

  /** La liquidación que reclama a esta reserva, del lado que se está mirando. 0 = ninguna. */
  const refDoc = useMemo(
    () => (r: ReservaLiq) =>
      Number((lado === "cliente" ? r.liquidacion_cliente_id : r.liquidacion_proveedor_id) ?? 0),
    [lado]
  );

  const filas = useMemo(
    () =>
      [...reservas].sort(
        (a, b) =>
          String(a.fecha_servicio ?? "").localeCompare(String(b.fecha_servicio ?? "")) ||
          hhmm(a.hora_servicio).localeCompare(hhmm(b.hora_servicio)) ||
          a.id - b.id
      ),
    [reservas]
  );

  /**
   * El otro tramo del día. Se busca en TODO el periodo, no solo entre las filas listadas,
   * y por los DOS sentidos del enlace (lib/liquidacion-hermanos.ts).
   *
   * Seguir `reserva_vinculada_id` solo hacia adelante era lo que hacía que un retorno con
   * el enlace escrito únicamente en su ida apareciera acá como un servicio suelto en
   * S/ 0.00, sin el "incluido en OS-…" — y quien abría este modal justamente a arreglar
   * ese cero terminaba escribiéndole una tarifa que cobra el día dos veces.
   */
  const hermanos = useMemo(() => indiceHermanos(universo), [universo]);
  const hermanoDe = useMemo(() => (r: ReservaLiq) => hermanos.de(r), [hermanos]);

  // ── Qué documento reclama a cada fila ─────────────────────────────────────
  const idsDoc = useMemo(() => [...new Set(filas.map(refDoc).filter(Boolean))], [filas, refDoc]);
  /** Sin documentos que consultar no hay nada que esperar: la lectura ya está hecha. */
  const docsListos = !idsDoc.length || docs !== null;

  useEffect(() => {
    if (!idsDoc.length) return;
    let vivo = true;
    (async () => {
      const tabla = lado === "cliente" ? "liquidacion_cliente" : "liquidacion_proveedor";
      const { data } = await supabase.from(tabla).select("id,codigo,estado").in("id", idsDoc);
      if (!vivo) return;
      const filasDoc: { id: number; codigo: string | null; estado: string | null }[] = data ?? [];
      setDocs(new Map(filasDoc.map((d) => [
        Number(d.id), { codigo: String(d.codigo ?? `#${d.id}`), estado: String(d.estado ?? "") },
      ])));
    })();
    return () => { vivo = false; };
  }, [idsDoc, lado]);

  const candadoDe = useMemo(() => (r: ReservaLiq): Candado => {
    const ref = refDoc(r);
    if (!ref) return LIBRE;
    const d = docs?.get(ref);
    // Mientras no se sepa el estado del documento no se abre la edición: dejar editar
    // por defecto y cerrar después sería peor que esperar medio segundo.
    if (!d) return { documento: `#${ref}`, estado: null, editable: false, borradorId: null,
                     motivo: docsListos ? "Está en una liquidación que no se pudo leer." : "Leyendo su liquidación…" };
    if (d.estado === "anulada")
      return { documento: d.codigo, estado: d.estado, editable: true, borradorId: null,
               motivo: `${d.codigo} está anulada: el servicio vuelve a ser editable.` };
    if (d.estado === "borrador")
      return { documento: d.codigo, estado: d.estado, editable: true, borradorId: ref,
               motivo: `Está en el borrador ${d.codigo}: al guardar se le vuelve a derivar la línea.` };
    return { documento: d.codigo, estado: d.estado, editable: false, borradorId: null,
             motivo: `${d.codigo} ya está ${d.estado}. Para cambiarle el importe, reábrela como borrador desde Documentos.` };
  }, [docs, docsListos, refDoc]);

  /** Las filas que de verdad se pueden tocar. La selección en bloque solo alcanza a éstas. */
  const editables = useMemo(() => filas.filter((r) => candadoDe(r).editable), [filas, candadoDe]);
  const bloqueadas = filas.length - editables.length;

  const campos = (r: ReservaLiq): Campos => edit[r.id] ?? camposDe(r, lado);

  function tocar(id: number, parche: Partial<Campos>) {
    setEdit((e) => {
      const base = e[id] ?? camposDe(filas.find((r) => r.id === id)!, lado);
      return { ...e, [id]: { ...base, ...parche } };
    });
  }

  /** Lo que cambió respecto de la reserva, ya como patch para `guardarReservas`. */
  function patchDe(r: ReservaLiq): Record<string, unknown> | null {
    const c = edit[r.id];
    if (!c) return null;
    const orig = camposDe(r, lado);
    const p: Record<string, unknown> = {};
    if (c.fecha_servicio !== orig.fecha_servicio && c.fecha_servicio) p.fecha_servicio = c.fecha_servicio;
    if (c.hora_servicio !== orig.hora_servicio) p.hora_servicio = c.hora_servicio || null;
    if (c.ruta_nombre !== orig.ruta_nombre) p.ruta_nombre = c.ruta_nombre.trim() || null;
    if (c.estado !== orig.estado && c.estado) p.estado = c.estado;
    if (c.monto !== orig.monto) p[campoMonto] = Number(c.monto || 0);
    if (c.origen_contractual !== orig.origen_contractual) p.origen_contractual = c.origen_contractual;
    // La marca solo tiene sentido sobre una cancelación. Si el operador la puso y después
    // devolvió el servicio a "finalizada", se retira sola: una marca colgada sobre un
    // servicio prestado no describe nada y confundiría al siguiente que lo mire.
    const ff = c.estado === "cancelada" && c.falso_flete;
    if (ff !== orig.falso_flete) p.falso_flete = ff;
    const motivoFF = ff ? c.falso_flete_motivo.trim() : "";
    if (motivoFF !== orig.falso_flete_motivo) p.falso_flete_motivo = motivoFF || null;
    return Object.keys(p).length ? p : null;
  }

  const pendientes = useMemo(
    () => filas.filter((r) => candadoDe(r).editable && patchDe(r) !== null),
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
    [filas, edit, candadoDe, lado]
  );

  /**
   * Los avisos de `lib/reservas-pacto.ts`, con el hermano puesto. Es la misma voz que
   * Programación: si el día se está quedando sin importe, o llevándolo dos veces, lo
   * dice aquí con las mismas palabras.
   *
   * Van los DOS niveles. El `info` no es decoración: es el que explica que este tramo
   * va en S/ 0.00 porque su hermano lleva la tarifa del día — justo lo que alguien
   * "arreglaría" cargando el importe dos veces— y el que pide el motivo cuando cambia
   * un costo ya pactado.
   */
  const avisos = useMemo(() => {
    const out: { r: ReservaLiq; avisos: AvisoPacto[] }[] = [];
    for (const r of pendientes) {
      const c = campos(r);
      const hermano = hermanoDe(r)?.tramo ?? null;
      // El hermano se juzga con lo que va a quedar guardado, no con lo que hay en la
      // base: si en esta misma tanda se le está poniendo importe a los dos tramos, el
      // aviso de "el día se cobra DOS VECES" tiene que salir ANTES de guardar.
      const cH = hermano ? (edit[hermano.id] ?? camposDe(hermano, lado)) : null;
      const parche = {
        ...r,
        estado: c.estado,
        direccion_servicio: r.direccion_servicio,
        tipo_asignacion: r.tipo_asignacion,
        [campoMonto]: Number(c.monto || 0),
        falso_flete: c.estado === "cancelada" && c.falso_flete,
      } as Record<string, unknown>;
      const otroTramo = hermano && cH
        ? { ...hermano, estado: cH.estado, [campoMonto]: Number(cH.monto || 0),
            falso_flete: cH.estado === "cancelada" && cH.falso_flete }
        : hermano;
      // Solo la cara del dinero que este modal edita: en la pestaña del cliente, el
      // precio. Los avisos del costo del proveedor son ciertos pero no se pueden
      // atender aquí, y un rojo que no se puede arreglar enseña a ignorar los rojos.
      const a = avisosDe(parche, r, otroTramo, lado === "cliente" ? "precio" : "costo");
      if (a.length) out.push({ r, avisos: a });
    }
    return out;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [pendientes, edit, hermanoDe, lado]);

  /** Solo las alertas de verdad: el pie no cuenta los `info`, que son explicaciones. */
  const alertasDuras = avisos.filter((a) => a.avisos.some((x) => x.nivel === "alerta")).length;

  /** Cambios que obligan a rehacer la agrupación del cierre: se avisa, no se impide. */
  const reagrupa = useMemo(
    () => pendientes.filter((r) => {
      const p = patchDe(r) ?? {};
      return "ruta_nombre" in p || "fecha_servicio" in p || campoMonto in p
        || "origen_contractual" in p || "falso_flete" in p || "estado" in p;
    }).length,
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
    [pendientes, edit]
  );

  // ── Edición en bloque ─────────────────────────────────────────────────────
  function aplicarBloque() {
    const objetivo = [...sel].filter((id) => editables.some((r) => r.id === id));
    if (!objetivo.length) { setMsg("⚠️ Marca al menos una fila editable."); return; }
    const parche: Partial<Campos> = {};
    if (bloque.monto !== "") parche.monto = bloque.monto;
    if (bloque.estado) parche.estado = bloque.estado;
    if (bloque.origen) parche.origen_contractual = bloque.origen;
    if (!Object.keys(parche).length) { setMsg("⚠️ Escribe el importe o elige el estado / origen que quieres aplicar."); return; }
    for (const id of objetivo) tocar(id, parche);
    setMsg(`${objetivo.length} fila(s) actualizadas en el formulario. Revisa y guarda.`);
  }

  async function guardar() {
    if (!pendientes.length) { setMsg("⚠️ No hay ningún cambio que guardar."); return; }

    // Sin motivo no se guarda, y esto SÍ bloquea. Pagar un servicio que no se prestó es
    // la salida de dinero más fácil de colar en un cierre, y este campo es lo único que
    // queda escrito para defenderla — igual que `adicional_motivo` en un adicional.
    const sinMotivo = pendientes.filter((r) => {
      const c = campos(r);
      return c.estado === "cancelada" && c.falso_flete && !c.falso_flete_motivo.trim();
    });
    if (sinMotivo.length) {
      setMsg(
        `⚠️ ${sinMotivo.length} falso(s) flete(s) sin motivo: ` +
        `${sinMotivo.slice(0, 3).map((r) => r.codigo ?? `#${r.id}`).join(", ")}` +
        `${sinMotivo.length > 3 ? "…" : ""}. Escribe por qué se le paga al proveedor un ` +
        `servicio que no se prestó — es la única constancia que va a quedar.`
      );
      return;
    }
    const dobles = avisos.filter((a) => a.avisos.some((x) => /DOS VECES/.test(x.texto)));
    if (dobles.length && !confirm(
      `${dobles.length} servicio(s) quedarían con importe en la ida Y en el retorno. ` +
      `AFA cobra UNA tarifa por los dos tramos: así el día se cobra dos veces.\n\n¿Guardar de todas formas?`
    )) return;

    setGuardando(true); setMsg("");
    try {
      // Un UPDATE por patch distinto, agrupando las filas que comparten exactamente el
      // mismo cambio: aplicar un precio a 60 servicios es UN update, no sesenta.
      const porPatch = new Map<string, { patch: Record<string, unknown>; ids: number[] }>();
      for (const r of pendientes) {
        const p = patchDe(r)!;
        const k = JSON.stringify(p);
        const ya = porPatch.get(k);
        if (ya) ya.ids.push(r.id);
        else porPatch.set(k, { patch: p, ids: [r.id] });
      }

      const guardados: number[] = [];
      const problemas: string[] = [];
      let sinOrigen = false;
      for (const { patch, ids } of porPatch.values()) {
        let res = await guardarReservas(supabase, ids, patch);
        // supabase/reservas-04 sin correr: se guarda el resto y se DICE, porque el
        // operador venía justamente a reclasificar un adicional.
        if (!res.ok && res.rechazos.some((x) => COLUMNAS_OPCIONALES.some((c) => x.motivo.includes(c)))) {
          const limpio = { ...patch };
          for (const c of COLUMNAS_OPCIONALES) delete limpio[c];
          sinOrigen = true;
          res = Object.keys(limpio).length
            ? await guardarReservas(supabase, ids, limpio)
            : { ok: true, guardados: [], rechazos: [] };
        }
        guardados.push(...res.guardados);
        if (!res.ok) problemas.push(describirResultado(res));
      }

      // Los borradores tocados vuelven a derivar sus líneas: el documento no puede
      // quedarse diciendo el precio viejo mientras su reserva dice otro. Solo los de las
      // filas que SÍ se guardaron — resincronizar por un cambio que se rechazó reescribiría
      // la línea con lo mismo que ya tenía y haría creer que el arreglo entró.
      const listos = new Set(guardados);
      const borradores = [...new Set(
        pendientes.filter((r) => listos.has(r.id)).map((r) => candadoDe(r).borradorId).filter(Boolean)
      )] as number[];
      let resinc = 0;
      for (const id of borradores) {
        const r = await resincronizarImportes(supabase, lado, id, { usuario });
        if (r.ok) resinc += 1;
        else problemas.push(`Liquidación #${id}: ${r.error}`);
      }

      if (problemas.length) {
        // Se sueltan solo los que entraron: los rechazados quedan escritos en el
        // formulario para poder corregirlos y reintentar sin volver a teclearlos.
        setEdit((e) => {
          const n = { ...e };
          for (const id of guardados) delete n[id];
          return n;
        });
        setMsg(`⚠️ Se guardaron ${guardados.length} servicio(s). ${problemas.join(" · ")}`);
        return;
      }
      if (sinOrigen)
        setMsg("⚠️ Se guardó todo menos el origen contractual: falta correr supabase/reservas-04-servicios-adicionales.sql.");
      onGuardado(guardados.length, resinc);
    } catch (e) {
      setMsg("⚠️ " + String((e as { message?: string })?.message ?? e));
    } finally {
      setGuardando(false);
    }
  }

  const cp = lado === "cliente" ? "#0b315f" : "#6d28d9";

  return (
    /* z-[60], una capa por encima del resto: es el único modal de la pantalla que se abre
       DESDE otro (las fichas de «Rutas contratadas», que se quedan debajo con los PAX que
       el operador ya tecleó). Con el z-50 de todos, quedaba tapado por el que lo abrió. */
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-3" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-[80rem] max-h-[94vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b rounded-t-2xl">
          <h3 className="font-black" style={{ color: cp }}>{titulo}</h3>
          <p className="text-xs text-gray-500">
            {subtitulo ? `${subtitulo} · ` : ""}
            <b>{filas.length}</b> tramo(s) · lo que cambies aquí se escribe en el servicio de origen,
            que es de donde lo leen Programación, Seguimiento y la liquidación.
            {bloqueadas > 0 && (
              <span className="text-amber-700"> {bloqueadas} en un documento ya emitido: en solo lectura.</span>
            )}
          </p>
        </div>

        {msg && <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">{msg}</div>}

        {/* Edición en bloque. El caso real no es "este servicio está mal", es "los cinco
            de esta ruta están mal": sin esto habría que teclear el mismo importe cinco veces. */}
        {sel.size > 0 && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-sky-50 border border-sky-200 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-bold text-sky-900">{sel.size} marcada(s):</span>
            <input type="number" min="0" step="0.01" placeholder={etiquetaMonto}
              className="px-2 py-1 rounded border text-sm w-36 text-right"
              value={bloque.monto} onChange={(e) => setBloque({ ...bloque, monto: e.target.value })} />
            <select className="px-2 py-1 rounded border text-sm"
              value={bloque.estado} onChange={(e) => setBloque({ ...bloque, estado: e.target.value })}>
              <option value="">— estado —</option>
              {ESTADOS_EDITABLES_MANUAL.map((e) => <option key={e} value={e}>{etiquetaEstado(e)}</option>)}
            </select>
            <select className="px-2 py-1 rounded border text-sm"
              value={bloque.origen} onChange={(e) => setBloque({ ...bloque, origen: e.target.value })}>
              <option value="">— origen —</option>
              {ORIGENES.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <button onClick={aplicarBloque}
              className="px-3 py-1.5 rounded-xl text-xs font-bold text-white bg-sky-600 hover:bg-sky-700">
              Aplicar a las marcadas
            </button>
            <button onClick={() => setSel(new Set())}
              className="px-2 py-1.5 rounded-xl text-xs font-bold border text-gray-500 hover:bg-white">✕</button>
          </div>
        )}

        <div className="flex-1 overflow-auto p-5">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase text-gray-500 sticky top-0">
              <tr>
                <th className="px-2 py-2 w-8">
                  <input type="checkbox"
                    checked={editables.length > 0 && sel.size === editables.length}
                    onChange={(e) => setSel(e.target.checked ? new Set(editables.map((r) => r.id)) : new Set())} />
                </th>
                <th className="text-left px-2 py-2">Servicio</th>
                <th className="text-left px-2 py-2 w-32">Fecha</th>
                <th className="text-left px-2 py-2 w-24">Hora</th>
                <th className="text-left px-2 py-2">Ruta</th>
                <th className="text-left px-2 py-2 w-44">Unidad / conductor</th>
                <th className="text-left px-2 py-2 w-32">Estado</th>
                <th className="text-right px-2 py-2 w-32">{etiquetaMonto}</th>
                <th className="text-left px-2 py-2 w-28">Origen</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filas.map((r) => {
                const c = campos(r);
                const candado = candadoDe(r);
                const cambiada = candado.editable && patchDe(r) !== null;
                const cfg = configEstado(c.estado);
                // Se mira el estado EN EL FORMULARIO, no el guardado: si el operador acaba
                // de cambiarlo a "cancelada", el importe tiene que tacharse ya, antes de
                // guardar. Ver el efecto antes de confirmarlo es la mitad del arreglo.
                const esCancelado = c.estado === "cancelada";
                const vinculo = hermanoDe(r);
                const hermano = vinculo?.tramo ?? null;
                const alertas = avisos.find((a) => a.r.id === r.id)?.avisos ?? [];
                return (
                  <tr key={r.id} className={cambiada ? "bg-emerald-50/50" : !candado.editable ? "bg-gray-50/60" : ""}>
                    <td className="px-2 py-2 align-top">
                      <input type="checkbox" disabled={!candado.editable}
                        checked={sel.has(r.id)}
                        onChange={(e) => setSel((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(r.id); else n.delete(r.id);
                          return n;
                        })} />
                    </td>
                    <td className="px-2 py-2 align-top">
                      <span className="block font-mono text-[11px] text-gray-700">{r.codigo ?? `#${r.id}`}</span>
                      <span className="block text-[10px] text-gray-400">
                        {sentidoDeReserva(r) === "RETORNO" ? "↩ retorno" : "→ ida"}
                        {hermano && <> · con {hermano.codigo ?? `#${hermano.id}`}</>}
                      </span>
                      {/* De dónde salió ese hermano. Un par unido por un enlace a medias
                          o deducido se cobra bien acá, pero el dato de la base está roto
                          y en Programación ese tramo se sigue viendo suelto: decirlo es
                          la diferencia entre arreglarlo y volver a tropezar el mes que
                          viene. Se repara desde "Enlazar ida↔retorno" en el cierre. */}
                      {vinculo && vinculo.procedencia !== "enlace" && (
                        <span className="block text-[10px] mt-0.5 text-amber-700">
                          {vinculo.procedencia === "enlace_a_medias"
                            ? "El enlace ida↔retorno está escrito en un solo lado."
                            : "Sin enlace en la base: el par está deducido por cliente, día y ruta."}
                        </span>
                      )}
                      {candado.motivo && (
                        <span className={`block text-[10px] mt-0.5 ${candado.editable ? "text-emerald-700" : "text-amber-700"}`}>
                          {candado.motivo}
                        </span>
                      )}
                      {alertas.map((a, i) => (
                        <span key={i} className={`block text-[10px] mt-0.5 ${a.nivel === "alerta" ? "text-red-700" : "text-sky-700"}`}>
                          {a.nivel === "alerta" ? "⚠ " : "· "}{a.texto}
                        </span>
                      ))}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <input type="date" disabled={!candado.editable}
                        className="w-full px-1.5 py-1 rounded border text-xs disabled:bg-gray-100 disabled:text-gray-400"
                        value={c.fecha_servicio} onChange={(e) => tocar(r.id, { fecha_servicio: e.target.value })} />
                    </td>
                    <td className="px-2 py-2 align-top">
                      <input type="time" disabled={!candado.editable}
                        className="w-full px-1.5 py-1 rounded border text-xs disabled:bg-gray-100 disabled:text-gray-400"
                        value={c.hora_servicio} onChange={(e) => tocar(r.id, { hora_servicio: e.target.value })} />
                    </td>
                    <td className="px-2 py-2 align-top">
                      {/* El nombre COMPLETO, que es lo que se imprime en el formato. */}
                      <input type="text" disabled={!candado.editable}
                        className="w-full px-1.5 py-1 rounded border text-xs disabled:bg-gray-100 disabled:text-gray-400"
                        placeholder={nombreRuta(r)}
                        value={c.ruta_nombre} onChange={(e) => tocar(r.id, { ruta_nombre: e.target.value })} />
                    </td>
                    <td className="px-2 py-2 align-top text-[11px] text-gray-600">
                      <span className="block">{catalogo.placaDe(r) || "sin unidad"}</span>
                      <span className="block text-gray-400">{catalogo.conductorDe(r) || "sin conductor"}</span>
                      <span className="block text-[10px] text-gray-400">{unidadDe(r)}</span>
                    </td>
                    <td className="px-2 py-2 align-top">
                      <select disabled={!candado.editable}
                        className="w-full px-1.5 py-1 rounded border text-xs disabled:bg-gray-100 disabled:text-gray-400"
                        style={{ background: candado.editable ? cfg.bg : undefined, color: candado.editable ? cfg.color : undefined }}
                        value={c.estado} onChange={(e) => tocar(r.id, { estado: e.target.value })}>
                        {!(ESTADOS_EDITABLES_MANUAL as string[]).includes(c.estado) && (
                          <option value={c.estado}>{etiquetaEstado(c.estado)}</option>
                        )}
                        {ESTADOS_EDITABLES_MANUAL.map((e) => <option key={e} value={e}>{etiquetaEstado(e)}</option>)}
                      </select>
                      {r.pasajeros_abordados != null && (
                        <span className="block text-[10px] text-gray-400 mt-0.5">{r.pasajeros_abordados} pax</span>
                      )}
                    </td>
                    <td className="px-2 py-2 align-top">
                      {/*
                        Un servicio CANCELADO no se paga ni se cobra. El importe se ve
                        tachado y en gris: que el número siga escrito y no haga nada tiene
                        que ser evidente, porque es justo el que deja el error humano de
                        cancelar sin borrarlo.

                        Del lado proveedor —y solo ahí— existe la salida: el falso flete.
                        Al cliente no se le cobra la cancelación por decisión comercial, así
                        que la casilla ni se ofrece.
                      */}
                      <input type="number" min="0" step="0.01"
                        disabled={!candado.editable || (esCancelado && !c.falso_flete)}
                        className={`w-full px-1.5 py-1 rounded border text-xs text-right disabled:bg-gray-100 disabled:text-gray-400 ${
                          esCancelado && !c.falso_flete ? "line-through" : ""
                        }`}
                        placeholder="0.00"
                        title={esCancelado && !c.falso_flete
                          ? "Cancelado: este importe no se liquida. Marca «falso flete» si hay acuerdo de pago por el avance."
                          : undefined}
                        value={c.monto} onChange={(e) => tocar(r.id, { monto: e.target.value })} />

                      {esCancelado && lado === "proveedor" && (
                        <label className="mt-1 flex items-start gap-1 text-[10px] text-gray-600 cursor-pointer">
                          <input type="checkbox" disabled={!candado.editable} className="mt-0.5"
                            checked={c.falso_flete}
                            onChange={(e) => tocar(r.id, { falso_flete: e.target.checked })} />
                          <span className={c.falso_flete ? "font-bold text-amber-800" : ""}>Falso flete</span>
                        </label>
                      )}
                      {esCancelado && c.falso_flete && (
                        // El motivo es OBLIGATORIO y por eso se pide aquí mismo, no en otra
                        // pantalla: es el único sitio donde queda escrito por qué salió
                        // dinero por un viaje que no se prestó.
                        <input type="text" disabled={!candado.editable}
                          className={`mt-1 w-full px-1.5 py-1 rounded border text-[10px] ${
                            c.falso_flete_motivo.trim() ? "" : "border-amber-400 bg-amber-50"
                          }`}
                          placeholder="Motivo (obligatorio)"
                          title="Por ejemplo: ya había salido de cochera, o ya había llegado al punto de origen"
                          value={c.falso_flete_motivo}
                          onChange={(e) => tocar(r.id, { falso_flete_motivo: e.target.value })} />
                      )}
                      {esCancelado && !c.falso_flete && Number(c.monto || 0) > 0 && (
                        <span className="block text-[10px] text-amber-700 mt-0.5">
                          no se {lado === "cliente" ? "cobra" : "paga"}
                        </span>
                      )}
                      {!esCancelado && !Number(c.monto || 0) && hermano && (
                        <span className="block text-[10px] text-gray-400 mt-0.5">
                          incluido en {hermano.codigo ?? `#${hermano.id}`}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <select disabled={!candado.editable}
                        className="w-full px-1.5 py-1 rounded border text-xs disabled:bg-gray-100 disabled:text-gray-400"
                        style={c.origen_contractual !== "contrato" ? { background: "#fef3c7", color: "#b45309" } : {}}
                        value={c.origen_contractual} onChange={(e) => tocar(r.id, { origen_contractual: e.target.value })}>
                        {ORIGENES.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="mt-3 text-[11px] text-gray-500">
            El día se cobra <b>una sola vez</b>: la tarifa va en un tramo y el otro queda en
            S/ 0.00 a propósito. Cambiar la <b>fecha</b>, la <b>ruta</b>, el <b>importe</b> o el{" "}
            <b>origen</b> cambia también en qué línea del cierre cae el servicio — la valorización
            se recalcula sola al recargar. Los servicios de una liquidación <b>ya emitida</b> se
            editan reabriéndola primero; los de una <b>anulada</b> ya son editables.
          </p>
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end rounded-b-2xl">
          <span className="mr-auto text-xs text-gray-500 self-center">
            {pendientes.length
              ? <><b>{pendientes.length}</b> servicio(s) con cambios
                  {reagrupa ? ` · ${reagrupa} cambian de línea en el cierre` : ""}
                  {alertasDuras ? <span className="text-red-600 font-semibold"> · {alertasDuras} con alerta</span> : ""}</>
              : "Sin cambios pendientes"}
          </span>
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={guardar} disabled={guardando || !pendientes.length}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
            {guardando ? "Guardando…" : `Guardar ${pendientes.length || ""} cambio(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
