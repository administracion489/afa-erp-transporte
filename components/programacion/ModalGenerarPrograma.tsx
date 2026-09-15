"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { X, Calendar, RefreshCw, ArrowRight, ArrowLeftRight, Layers, Signpost, Plus, Sparkles } from "lucide-react";
import { sugerirNombreRuta } from "@/lib/nombre-ruta";

type ItemCot = {
  descripcion: string;
  dias: number;
  cantidad: number;
  precio_unit: number;
  descuento_pct: number;
  vehiculo_flota_id?:   number | null;  // flota propia  → reservas.vehiculo_id
  vehiculo_tercero_id?: number | null;  // vehículo ter. → reservas.vehiculo_tercero_id + empresa_tercerizada_id
  /** Asientos CONTRATADOS del ítem → reservas.capacidad_contratada. Ver el Slot. */
  pax_contratado?:      number | null;
};

type CotizacionFija = {
  id: number;
  cliente_id: number | null;
  asunto: string | null;
  tipo_servicio: string | null;
  precio_dia: number | null;
  precio_cliente: number | null;
  paradas_json: any[] | null;
  hora_ida: string | null;
  hora_retorno: string | null;
  paradas_retorno_json: any[] | null;
  items_json: ItemCot[] | null;
};

type VehiculoTercero = {
  id: number;
  empresa_id: number;
  placa: string;
  categoria?: string | null;
};

type EmpresaTercerizada = {
  id: number;
  razon_social: string;
};

// Slot = un vehículo / ítem de la cotización
type Slot = {
  precio:                 number;
  tipo:                   "propia" | "tercerizada";
  vehiculo_id:            number | null;   // flota propia
  vehiculo_tercero_id:    number | null;   // vehículo tercero
  empresa_tercerizada_id: number | null;   // empresa del tercero
  placa:                  string;          // para mostrar en UI
  descripcion:            string;
  /**
   * Asientos que el cliente contrató para este móvil. Viaja hasta
   * `reservas.capacidad_contratada` y de ahí lo lee la liquidación.
   *
   * NO es la capacidad del vehículo asignado: AFA asigna por disponibilidad, así que
   * una ruta contratada para 15 puede cubrirse con un bus de 17 o de 20. Copiar la
   * capacidad del bus es lo que hacía que el formato le declarara al cliente un número
   * que nadie pactó (ver supabase/liquidaciones-03-ruta-contratada.sql).
   */
  pax_contratado:         number | null;
};

type Cliente = { id: number; nombre: string; empresa?: string; };

/** Modo de trabajo del modal. Ver el bloque de comentarios de `Props`. */
export type ModoPrograma = "fijo" | "adicional";

/**
 * Columnas que pueden NO existir todavía en `reservas` porque su migración es
 * opcional. PostgREST rechaza el lote ENTERO por una columna desconocida, así que
 * antes que dejar sin programar el mes se reintenta sin ella.
 *
 * El orden importa poco, pero el efecto de perder cada una no es el mismo:
 *   · capacidad_contratada → la liquidación resuelve el pax por otros escalones.
 *   · origen_contractual   → el adicional queda indistinguible del contrato. Eso SÍ
 *     hay que decirlo en pantalla, no tragárselo: por eso se devuelve `omitidas`.
 */
const COLUMNAS_OPCIONALES = [
  "capacidad_contratada",
  "origen_contractual",
  "precio_cotizado",
  "adicional_motivo",
  "adicional_nota",
] as const;

type ResultadoInsert = { data: any[] | null; error: any; omitidas: string[] };

async function insertarReservas(filas: any[], devolverIds = false): Promise<ResultadoInsert> {
  const meter = (f: any[]) => {
    const q = supabase.from("reservas").insert(f);
    return devolverIds ? q.select("id") : q;
  };
  let actuales = filas;
  const omitidas: string[] = [];

  // Un intento por columna opcional como mucho: cada reintento quita exactamente la
  // que el error nombró, así que el bucle no puede girar más veces que columnas hay.
  for (let i = 0; i <= COLUMNAS_OPCIONALES.length; i++) {
    const r = await meter(actuales);
    if (!r.error) return { data: (r as any).data ?? null, error: null, omitidas };
    const falta = COLUMNAS_OPCIONALES.find(
      (c) => !omitidas.includes(c) && new RegExp(`\\b${c}\\b`, "i").test(String(r.error.message))
    );
    if (!falta) return { data: null, error: r.error, omitidas };
    omitidas.push(falta);
    actuales = actuales.map((f) => {
      const copia = { ...f };
      delete copia[falta];
      return copia;
    });
  }
  return { data: null, error: { message: "No se pudo insertar" }, omitidas };
}


const DIAS_SEMANA  = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const UI_TO_JS_DAY = [1, 2, 3, 4, 5, 6, 0];

/**
 * Motivos por los que un adicional se cobra distinto a la tarifa del contrato.
 * Son las mismas claves de `pacto_motivo` que ya usa Programación al cambiar un
 * precio: si aquí se inventara otra lista, el mismo hecho quedaría archivado con
 * dos nombres y ningún reporte podría cruzarlos.
 */
const MOTIVOS_ADICIONAL = [
  { clave: "cliente_unidad_mayor", nombre: "El cliente pidió una unidad de mayor capacidad" },
  { clave: "cliente_unidad_menor", nombre: "El cliente pidió una unidad menor" },
  { clave: "cliente_cambio_ruta",  nombre: "Cambio de ruta, horario o paradero" },
  { clave: "precio_renegociado",   nombre: "Importe acordado aparte con el cliente" },
  { clave: "correccion_carga",     nombre: "Corrección de un dato" },
];

function generarFechas(inicio: string, fin: string, diasUI: boolean[]): string[] {
  if (!inicio || !fin) return [];
  const fechas: string[] = [];
  const cur = new Date(inicio + "T12:00:00");
  const end = new Date(fin   + "T12:00:00");
  if (cur > end) return [];
  while (cur <= end) {
    const uiIdx = UI_TO_JS_DAY.indexOf(cur.getDay());
    if (uiIdx >= 0 && diasUI[uiIdx]) {
      fechas.push(cur.toISOString().split("T")[0]);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return fechas;
}

function nombreRuta(paradas: any[] | null): string {
  if (!paradas || paradas.length === 0) return "Sin ruta";
  const inicio  = paradas.find((p: any) => p.tipo === "inicio");
  const destino = paradas.find((p: any) => p.tipo === "destino");
  return (inicio?.nombre || "-") + " → " + (destino?.nombre || "-");
}

/** 'AAAA-MM-DD' → 'vie 12/08'. Para los chips de fechas sueltas del adicional. */
function fechaChip(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return iso;
  const dia = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][d.getDay()];
  return `${dia} ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const dosDecimales = (n: number) => Math.round(Number(n || 0) * 100) / 100;

function inputCls() {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all";
}

interface Props {
  clientes: Cliente[];
  onClose: () => void;
  onGenerado: (info: { lote: string; cantidad: number }) => void;
  /**
   * `fijo`      → el programa del mes: rango de fechas × días de la semana, precio
   *               tomado de la cotización, y el retorno lo decide el contrato.
   * `adicional` → lo que el cliente pide POR ENCIMA de lo contratado: fechas sueltas,
   *               sentido a elección y precio editable.
   *
   * Es el MISMO modal a propósito. Los paraderos, el nombre de ruta, el vínculo
   * ida↔retorno y la herencia del vehículo son idénticos en los dos casos; tener
   * dos pantallas que generan servicios desde una cotización sería tener la misma
   * regla en dos sitios, y terminarían diciendo cosas distintas.
   */
  modo?: ModoPrograma;
}

export default function ModalGenerarPrograma({ clientes, onClose, onGenerado, modo = "fijo" }: Props) {
  const esAdicional = modo === "adicional";

  const [cotizaciones,     setCotizaciones]     = useState<CotizacionFija[]>([]);
  const [vehTercero,       setVehTercero]       = useState<VehiculoTercero[]>([]);
  const [empresasTer,      setEmpresasTer]      = useState<EmpresaTercerizada[]>([]);
  const [cotizacionId,     setCotizacionId]     = useState<string>("");
  const [fechaInicio,      setFechaInicio]      = useState<string>("");
  const [fechaFin,         setFechaFin]         = useState<string>("");
  const [diasUI,           setDiasUI]           = useState<boolean[]>([true, true, true, true, true, false, false]);
  const [hora,             setHora]             = useState<string>("07:00");
  const [generando,        setGenerando]        = useState(false);
  const [cargando,         setCargando]         = useState(true);
  // Nombre de ruta visible al pasajero. Se sugiere solo y el operador lo corrige
  // ANTES de generar: ponerlo después obliga a abrir el manifiesto servicio por
  // servicio, que es justo lo que se olvidaba. `tocado` congela la sugerencia
  // para no pisar lo que el operador ya escribió al mover la hora.
  const [nombreIda,        setNombreIda]        = useState("");
  const [nombreRetorno,    setNombreRetorno]    = useState("");
  const [nombreTocado,     setNombreTocado]     = useState(false);

  // ── Estado exclusivo del modo ADICIONAL ────────────────────────────────
  // Fechas SUELTAS: un adicional son tres salidas de días distintos, no un rango
  // con días de la semana. Forzarlo al rango obligaba a generar de más y cancelar.
  const [fechasSueltas,    setFechasSueltas]    = useState<string[]>([]);
  const [fechaNueva,       setFechaNueva]       = useState<string>("");
  const [sentidoAdic,      setSentidoAdic]      = useState<"ida" | "retorno" | "ambos">("ida");
  const [horaRetorno,      setHoraRetorno]      = useState<string>("");
  const [slotIdx,          setSlotIdx]          = useState(0);
  const [precioAdic,       setPrecioAdic]       = useState<string>("");
  const [precioTocado,     setPrecioTocado]     = useState(false);
  const [motivoAdic,       setMotivoAdic]       = useState<string>("");
  const [notaAdic,         setNotaAdic]         = useState<string>("");

  useEffect(() => {
    Promise.all([
      supabase
        .from("cotizaciones")
        .select("id, cliente_id, asunto, tipo_servicio, precio_dia, precio_cliente, paradas_json, hora_ida, hora_retorno, paradas_retorno_json, items_json")
        .eq("modo_servicio", "fijo")
        .order("id", { ascending: false }),
      supabase.from("vehiculos_tercero").select("id, empresa_id, placa, categoria"),
      supabase.from("empresas_tercerizadas").select("id, razon_social"),
    ]).then(([cotRes, vehRes, empRes]) => {
      setCotizaciones((cotRes.data as CotizacionFija[]) || []);
      setVehTercero((vehRes.data as VehiculoTercero[]) || []);
      setEmpresasTer((empRes.data as EmpresaTercerizada[]) || []);
      setCargando(false);
    });
  }, []);

  const fechasRango = useMemo(
    () => generarFechas(fechaInicio, fechaFin, diasUI),
    [fechaInicio, fechaFin, diasUI]
  );

  const cot          = cotizaciones.find(c => c.id === Number(cotizacionId));
  const tieneRetorno = !!cot?.hora_retorno;

  // Paradas con las que se NOMBRA el retorno: las propias si existen; si no, las
  // de la ida con los extremos invertidos — el mismo criterio que usa la
  // generación para `origen`/`destino` del retorno.
  const paradasRetornoNombre = useMemo(() => {
    if (cot?.paradas_retorno_json?.length) return cot.paradas_retorno_json;
    const ini = cot?.paradas_json?.find((p: any) => p.tipo === "inicio")?.nombre  || "";
    const des = cot?.paradas_json?.find((p: any) => p.tipo === "destino")?.nombre || "";
    if (!ini && !des) return null;
    return [{ tipo: "inicio", nombre: des }, { tipo: "destino", nombre: ini }];
  }, [cot]);

  // ── Construir slots: un slot por ítem de la cotización ──────────────────
  const slots = useMemo<Slot[]>(() => {
    const items: ItemCot[] = cot?.items_json?.length ? cot.items_json : [];

    if (items.length === 0) {
      // Sin ítems: un único slot con el precio de la cotización
      return [{
        precio:                 Number(cot?.precio_dia || cot?.precio_cliente || 0),
        tipo:                   "propia",
        vehiculo_id:            null,
        vehiculo_tercero_id:    null,
        empresa_tercerizada_id: null,
        placa:                  "",
        descripcion:            "",
        pax_contratado:         null,
      }];
    }

    return items.map((it): Slot => {
      // Vehículo tercerizado
      if (it.vehiculo_tercero_id) {
        const veh = vehTercero.find(v => v.id === it.vehiculo_tercero_id);
        return {
          precio:                 Number(it.precio_unit) || 0,
          tipo:                   "tercerizada",
          vehiculo_id:            null,
          vehiculo_tercero_id:    it.vehiculo_tercero_id,
          empresa_tercerizada_id: veh?.empresa_id || null,
          placa:                  veh?.placa || `VT-${it.vehiculo_tercero_id}`,
          descripcion:            it.descripcion,
          pax_contratado:         Number(it.pax_contratado) > 0 ? Number(it.pax_contratado) : null,
        };
      }
      // Vehículo propio
      return {
        precio:                 Number(it.precio_unit) || 0,
        tipo:                   "propia",
        vehiculo_id:            it.vehiculo_flota_id || null,
        vehiculo_tercero_id:    null,
        empresa_tercerizada_id: null,
        placa:                  "",    // se mostrará la placa real al mostrar en programacion
        descripcion:            it.descripcion,
        pax_contratado:         Number(it.pax_contratado) > 0 ? Number(it.pax_contratado) : null,
      };
    });
  }, [cot, vehTercero]);

  // ── Qué se va a generar, ya resuelto por modo ───────────────────────────
  //
  // Un adicional es UN móvil, no el programa entero: si la cotización tiene tres
  // ítems, generar los tres crearía tres servicios donde el cliente pidió uno. Se
  // elige el ítem, y de él salen la tarifa de referencia, el vehículo heredado y el
  // pax contratado.
  const slotAdicional = slots[Math.min(slotIdx, Math.max(0, slots.length - 1))] ?? slots[0];
  const precioReferencia = dosDecimales(slotAdicional?.precio ?? 0);

  // El precio del adicional ARRANCA en el cotizado y se puede cambiar. Se DERIVA en vez
  // de sincronizarse con un efecto: mientras nadie lo toque manda la tarifa del ítem, y
  // así elegir otra cotización o otro móvil ya lo actualiza sin un render extra.
  // Dejarlo en blanco haría que el caso normal —cobrar lo mismo que el contrato— exigiera
  // teclear una cifra que el sistema ya conoce, y ahí es donde se teclea mal.
  const precioAdicVal = precioTocado ? precioAdic : (precioReferencia ? precioReferencia.toFixed(2) : "");
  const precioAdicNum = dosDecimales(Number(precioAdicVal.replace(",", ".")) || 0);

  /**
   * La cotización no trae tarifa para este móvil (ni `precio_unit` en el ítem, ni
   * `precio_dia`/`precio_cliente` en la cabecera). Pasa de verdad: hay cotizaciones que
   * solo fijan los paraderos.
   *
   * Sin referencia NO hay diferencia que explicar, y exigir el motivo obligaba a elegir
   * uno para justificar una diferencia inexistente — el operador marca el primero de la
   * lista y el dato queda mintiendo. El motivo se sigue OFRECIENDO (el precio salió de
   * algún acuerdo y conviene anotarlo), pero no se exige.
   */
  const sinReferencia = esAdicional && precioReferencia <= 0;
  const difierePrecio = esAdicional && !sinReferencia && precioAdicNum !== precioReferencia;
  /** Cuándo tiene sentido pedir el porqué. Obligatorio solo si hay contra qué comparar. */
  const pedirMotivo = difierePrecio || sinReferencia;

  const slotsAGenerar = useMemo<Slot[]>(() => {
    if (!esAdicional) return slots;
    if (!slotAdicional) return [];
    return [{ ...slotAdicional, precio: precioAdicNum }];
  }, [esAdicional, slots, slotAdicional, precioAdicNum]);

  const fechas = esAdicional ? fechasSueltas : fechasRango;

  // Sentido de los tramos a crear. En `fijo` lo decide el contrato; en `adicional` lo
  // decide el operador, que es lo que hoy no se podía: pedir SOLO la salida obligaba
  // a que el sistema creara también la entrada para cancelarla después.
  const generaIda     = esAdicional ? sentidoAdic !== "retorno" : true;
  const generaRetorno = esAdicional ? sentidoAdic !== "ida"     : tieneRetorno;
  const horaRetornoEfectiva = esAdicional ? horaRetorno : (cot?.hora_retorno ?? "");
  const tramosPorDia  = (generaIda ? 1 : 0) + (generaRetorno ? 1 : 0);

  // Al puente del precio va UN solo tramo: el que existe, y si existen los dos, la
  // IDA. Escribir el importe en ambos factura el día dos veces (ver la regla del par
  // en lib/liquidacion-agrupacion.ts).
  const tramoQueCobra: "ida" | "retorno" = generaIda ? "ida" : "retorno";

  useEffect(() => {
    if (nombreTocado) return;
    setNombreIda(cot ? sugerirNombreRuta({ asunto: cot.asunto, paradas: cot.paradas_json, hora, sentido: "ida" }) : "");
    setNombreRetorno(cot && generaRetorno
      ? sugerirNombreRuta({ asunto: cot.asunto, paradas: paradasRetornoNombre, hora: horaRetornoEfectiva, sentido: "retorno" })
      : "");
  }, [cot, hora, generaRetorno, horaRetornoEfectiva, paradasRetornoNombre, nombreTocado]);

  const numItems       = slotsAGenerar.length;
  const esMultiVehiculo = numItems > 1;

  const clienteNombre = (id: number | null) => {
    if (!id) return "Sin cliente";
    const c = clientes.find(c => c.id === id);
    return c ? (c.empresa || c.nombre) : "Cliente #" + id;
  };

  const precioDiaTotal = slotsAGenerar.reduce((acc, s) => acc + s.precio, 0);
  const totalServicios = fechas.length * numItems * Math.max(1, tramosPorDia);

  // Qué falta para poder generar. Se devuelve el MOTIVO, no un booleano: el botón
  // deshabilitado sin explicación es la forma más rápida de que alguien crea que el
  // ERP está roto.
  const faltaPara: string | null = (() => {
    if (!cotizacionId) return "Elige la cotización de la que salen los paraderos.";
    if (esAdicional) {
      if (fechasSueltas.length === 0) return "Agrega al menos una fecha.";
      if (generaRetorno && !horaRetornoEfectiva) return "Falta la hora del retorno.";
      if (difierePrecio && !motivoAdic)
        return "El precio no es el de la cotización: elige el motivo.";
      return null;
    }
    if (!fechaInicio || !fechaFin) return "Falta el rango de fechas.";
    if (!diasUI.some(Boolean)) return "Selecciona al menos un día de la semana.";
    if (fechasRango.length === 0) return "El rango no produce ninguna fecha.";
    return null;
  })();
  const puedeGenerar = faltaPara === null;

  const agregarFecha = (f: string) => {
    // El picker dispara onChange con años a medio teclear ("0002-08-12"). Sin este
    // filtro, la lista se llena de fechas imposibles que después hay que quitar.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number(f.slice(0, 4)) < 2000) return;
    setFechasSueltas(prev => prev.includes(f) ? prev : [...prev, f].sort());
    setFechaNueva("");
  };

  // ── Generación ───────────────────────────────────────────────────────────
  const confirmar = async () => {
    if (!puedeGenerar || !cot) return;

    const lineasMsg = esMultiVehiculo
      ? `${numItems} vehículos × ${fechas.length} días`
      : `${fechas.length} ${esAdicional ? "fecha(s)" : "días"}`;
    const retMsg = tramosPorDia === 2 ? " × IDA+RETORNO" : generaRetorno ? " (solo RETORNO)" : "";
    const encabezado = esAdicional ? "¿Generar el ADICIONAL?" : "";
    if (!confirm(`${encabezado}\n${lineasMsg}${retMsg} = ${totalServicios} servicios en total.`)) return;

    setGenerando(true);

    const lote = crypto.randomUUID();
    let totalInsertados = 0;
    const omitidasTotal = new Set<string>();

    const origenIda      = cot.paradas_json?.find((p: any) => p.tipo === "inicio")?.nombre  || "Sin especificar";
    const destinoIda     = cot.paradas_json?.find((p: any) => p.tipo === "destino")?.nombre || "Sin especificar";
    const paradasRetorno = cot.paradas_retorno_json?.length ? cot.paradas_retorno_json : cot.paradas_json;
    const origenRetorno  = cot.paradas_retorno_json?.find((p: any) => p.tipo === "inicio")?.nombre  || destinoIda;
    const destinoRetorno = cot.paradas_retorno_json?.find((p: any) => p.tipo === "destino")?.nombre || origenIda;

    // Marca de origen. En `fijo` no se escribe NADA: la columna tiene default
    // 'contrato' y mandarlo explícito solo agregaría una columna más que puede faltar
    // y hacer reintentar el lote entero de un programa de 600 servicios.
    const camposOrigen = esAdicional
      ? {
          origen_contractual: "adicional",
          // De cuánto se partió, congelado hoy: si el contrato se renegocia, la
          // diferencia tiene que seguir midiéndose contra lo que regía este día.
          precio_cotizado:    precioReferencia || null,
          adicional_motivo:   pedirMotivo ? (motivoAdic || null) : null,
          adicional_nota:     notaAdic.trim() || null,
        }
      : {};

    const BATCH = 50;
    const meter = async (filas: any[], devolverIds: boolean, etiqueta: string): Promise<number[] | null> => {
      const ids: number[] = [];
      for (let i = 0; i < filas.length; i += BATCH) {
        const { data, error, omitidas } = await insertarReservas(filas.slice(i, i + BATCH), devolverIds);
        omitidas.forEach(c => omitidasTotal.add(c));
        if (error) {
          alert(`Error al generar servicios${etiqueta ? " de " + etiqueta : ""}: ` + error.message);
          setGenerando(false);
          return null;
        }
        if (devolverIds) ids.push(...(data || []).map((r: any) => r.id));
      }
      return ids;
    };

    for (const slot of slotsAGenerar) {
      // Campos de vehículo según tipo de asignación
      const camposVehiculo = slot.tipo === "tercerizada"
        ? {
            tipo:                   "tercerizada",
            tipo_asignacion:        "tercerizado",   // valor que espera el form de edición
            ...(slot.vehiculo_tercero_id    ? { vehiculo_tercero_id:    slot.vehiculo_tercero_id    } : {}),
            ...(slot.empresa_tercerizada_id ? { empresa_tercerizada_id: slot.empresa_tercerizada_id } : {}),
          }
        : {
            tipo:            "propia",
            tipo_asignacion: "propio",
            ...(slot.vehiculo_id ? { vehiculo_id: slot.vehiculo_id } : {}),
          };

      const camposComunes = {
        cotizacion_id:         cot.id,
        cliente_id:            cot.cliente_id,
        estado:                "pendiente",
        costo_proveedor:       0,
        tipo_servicio_detalle: cot.tipo_servicio || "transporte_personal",
        lote_generacion:       lote,
        ...camposVehiculo,
        ...camposOrigen,
      };

      const camposIda = {
        ...camposComunes,
        // Snapshot de lo CONTRATADO: es lo que imprimirá la liquidación, y tiene que
        // sobrevivir a que el contrato se renegocie más adelante.
        capacidad_contratada:  slot.pax_contratado,
        hora_servicio:         hora,
        paradas_json:          cot.paradas_json,
        origen:                origenIda,
        destino:               destinoIda,
        ruta_nombre:           nombreIda.trim() || null,
        // En `fijo` sin retorno se omitía el sentido y la liquidación lo deducía del
        // nombre de la ruta. Se mantiene ese comportamiento tal cual; en `adicional`
        // el sentido es una decisión explícita del operador y se guarda como tal.
        ...(generaRetorno || esAdicional ? { direccion_servicio: "ida" } : {}),
        precio_cliente:        tramoQueCobra === "ida" ? slot.precio : 0,
      };

      const camposRet = {
        ...camposComunes,
        // El retorno solo lleva la capacidad contratada cuando ES el servicio (el
        // adicional de solo salida). En un par la lleva la ida, que es la cabeza que
        // lee la liquidación.
        ...(generaIda ? {} : { capacidad_contratada: slot.pax_contratado }),
        hora_servicio:         horaRetornoEfectiva,
        paradas_json:          paradasRetorno,
        origen:                origenRetorno,
        destino:               destinoRetorno,
        ruta_nombre:           nombreRetorno.trim() || null,
        direccion_servicio:    "retorno",
        precio_cliente:        tramoQueCobra === "retorno" ? slot.precio : 0,
        // El precio de referencia acompaña SOLO al tramo que cobra: en el otro, un
        // "cotizado S/ 350 · cobrado S/ 0" se leería como un descuento del 100 %.
        ...(esAdicional && tramoQueCobra !== "retorno" ? { precio_cotizado: null } : {}),
      };

      // ── Un solo tramo ───────────────────────────────────────────────────
      if (tramosPorDia === 1) {
        const base = generaIda ? camposIda : camposRet;
        const filas = fechas.map(fecha => ({ ...base, fecha_servicio: fecha }));
        const ids = await meter(filas, false, "");
        if (ids === null) return;
        totalInsertados += filas.length;

      } else {
        // ── Par IDA + RETORNO vinculados ────────────────────────────────

        // 1. Insertar IDAs y obtener sus IDs
        const idasIds = await meter(
          fechas.map(fecha => ({ ...camposIda, fecha_servicio: fecha })), true, "IDA"
        );
        if (idasIds === null) return;

        // 2. Insertar RETORNOs con referencia a cada IDA
        const retornosIds = await meter(
          fechas.map((fecha, idx) => ({ ...camposRet, fecha_servicio: fecha, reserva_vinculada_id: idasIds[idx] })),
          true, "RETORNO"
        );
        if (retornosIds === null) return;

        // 3. Enlace bidireccional: actualizar IDAs con ID del RETORNO
        await Promise.all(
          idasIds.map((idaId, idx) =>
            supabase
              .from("reservas")
              .update({ reserva_vinculada_id: retornosIds[idx] })
              .eq("id", idaId)
          )
        );

        totalInsertados += idasIds.length + retornosIds.length;
      }
    }

    setGenerando(false);

    // Si la base todavía no tiene la columna de origen, los servicios SÍ se crearon
    // pero nacieron indistinguibles de los del contrato. Callarlo dejaría al operador
    // buscando en la liquidación un subtotal de adicionales que nunca va a aparecer.
    if (esAdicional && omitidasTotal.has("origen_contractual")) {
      alert(
        `Se crearon ${totalInsertados} servicio(s), pero NO quedaron marcados como ADICIONAL: ` +
        `la base todavía no tiene esa columna.\n\n` +
        `Corre supabase/reservas-04-servicios-adicionales.sql en Supabase y vuelve a marcarlos, ` +
        `o la liquidación los cobrará junto a los del contrato.`
      );
    }

    onGenerado({ lote, cantidad: totalInsertados });
    onClose();
  };

  const toggleDia = (i: number) => setDiasUI(prev => prev.map((v, j) => j === i ? !v : v));

  // ── Label del recurso de cada slot para la UI ─────────────────────────
  const slotRecursoLabel = (s: Slot): string => {
    if (s.tipo === "tercerizada") {
      const emp = empresasTer.find(e => e.id === s.empresa_tercerizada_id);
      return `🚌 ${s.placa}${emp ? ` · ${emp.razon_social}` : " (tercerizado)"}`;
    }
    if (s.vehiculo_id) return `🚌 Flota propia (ID ${s.vehiculo_id})`;
    return "Sin asignar (se asignará después)";
  };

  // ── Preview ───────────────────────────────────────────────────────────
  const previewLabel = () => {
    if (fechas.length === 0) return null;
    const diasStr = `${fechas.length} ${esAdicional ? (fechas.length === 1 ? "fecha" : "fechas") : `día${fechas.length !== 1 ? "s" : ""}`}`;
    const importe = precioDiaTotal > 0
      ? <span className="opacity-70"> · S/ {(fechas.length * precioDiaTotal).toLocaleString("es-PE", { minimumFractionDigits: 2 })} total est.</span>
      : null;

    if (tramosPorDia === 2 && esMultiVehiculo) {
      return (
        <><b>{diasStr} × {numItems} vehículos × IDA+RETORNO</b>
          <span className="opacity-70"> = {totalServicios} servicios</span>{importe}
        </>
      );
    }
    if (tramosPorDia === 2) {
      return (
        <><b>{fechas.length} pares IDA+RETORNO</b>
          <span className="opacity-70"> ({fechas.length * 2} servicios)</span>{importe}
        </>
      );
    }
    if (esMultiVehiculo) {
      return (
        <><b>{diasStr} × {numItems} vehículos</b>
          <span className="opacity-70"> = {totalServicios} servicios</span>{importe}
        </>
      );
    }
    return (
      <><b>{totalServicios} servicio{totalServicios !== 1 ? "s" : ""}</b>
        {generaRetorno && !generaIda ? " de RETORNO" : ""} a generar{importe}
      </>
    );
  };

  const botonLabel = () => {
    if (generando)     return "Generando...";
    if (!puedeGenerar) return esAdicional ? "Registrar adicional" : "Generar programa";
    return `${esAdicional ? "Registrar" : "Generar"} ${totalServicios} servicio${totalServicios !== 1 ? "s" : ""}`;
  };

  const acento = esAdicional ? "#b45309" : "#0b315f";
  const previewColor = esAdicional
    ? { bg: "#fef3c7", text: "#854d0e" }
    : tramosPorDia === 2 || esMultiVehiculo
      ? { bg: "#ede9fe", text: "#5b21b6" }
      : { bg: "#dcfce7", text: "#166534" };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      {/* max-h + flex-col: header y footer siempre visibles, cuerpo hace scroll */}
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl flex flex-col" style={{ maxHeight: "calc(100vh - 16px)" }}>

        {/* Header — fijo, nunca se desplaza */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "#e2e8f0" }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: acento }}>
              {esAdicional ? <Sparkles size={18} /> : <Calendar size={18} />}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {esAdicional ? "Servicio adicional" : "Generar programa fijo"}
              </h2>
              <p className="text-xs text-gray-400">
                {esAdicional
                  ? "Lo que el cliente pide por encima de lo contratado, con su propio precio"
                  : "Crea múltiples servicios desde una cotización"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100 transition-colors shrink-0">
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        {/* Cuerpo — scrollable cuando el contenido supera la pantalla */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">

          {/* Selector de cotización */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
              {esAdicional ? "Cotización · de aquí salen los paraderos *" : "Cotización fija *"}
            </label>
            {cargando ? (
              <p className="text-sm text-gray-400 py-2">Cargando cotizaciones...</p>
            ) : cotizaciones.length === 0 ? (
              <p className="text-sm text-amber-600 py-2">No hay cotizaciones fijas.</p>
            ) : (
              <select className={inputCls()} value={cotizacionId} onChange={e => {
                setCotizacionId(e.target.value);
                setNombreTocado(false); // otra cotización ⇒ otra ruta: vuelve a sugerir
                setPrecioTocado(false); // …y otra tarifa de referencia
                setSlotIdx(0);
                // La hora arranca en la del contrato (primer paradero → hora_ida). Tipearla a mano
                // es lo que deja reservas.hora_servicio desfasada de los paraderos reales.
                const c = cotizaciones.find(c => c.id === Number(e.target.value));
                const h = String(c?.paradas_json?.find(p => p.tipo === "inicio")?.hora || c?.hora_ida || "").slice(0, 5);
                if (h) setHora(h);
                setHoraRetorno(String(c?.hora_retorno || "").slice(0, 5));
              }}>
                <option value="">Seleccionar cotización...</option>
                {cotizaciones.map(c => (
                  <option key={c.id} value={c.id}>
                    #{c.id} — {clienteNombre(c.cliente_id)} — {nombreRuta(c.paradas_json)}
                    {(c.items_json?.length ?? 0) > 1 ? ` [${c.items_json!.length} vehículos]` : ""}
                    {c.hora_retorno ? ` ⇄ retorno ${c.hora_retorno}` : ""}
                  </option>
                ))}
              </select>
            )}

            {/* Ficha de la cotización seleccionada */}
            {cot && (
              <div className="mt-2 rounded-xl px-4 py-3 text-xs space-y-1.5" style={{ background: "#eef3f8", color: "#0b315f" }}>
                <p><b>Cliente:</b> {clienteNombre(cot.cliente_id)}</p>
                <p><b>Ruta IDA:</b> {nombreRuta(cot.paradas_json)}</p>
                {(tieneRetorno || generaRetorno) && (
                  <p>
                    <b>Ruta RETORNO:</b>{" "}
                    {cot.paradas_retorno_json?.length
                      ? nombreRuta(cot.paradas_retorno_json)
                      : <span className="italic opacity-60">mismas paradas en sentido inverso</span>}
                  </p>
                )}

                {/* Lista de slots/vehículos (solo en el programa fijo: el adicional elige uno) */}
                {!esAdicional && esMultiVehiculo && (
                  <div className="pt-1.5 mt-0.5 border-t" style={{ borderColor: "#0b315f22" }}>
                    <div className="flex items-center gap-1.5 mb-1 font-bold">
                      <Layers size={11} className="shrink-0" />
                      {numItems} vehículos detectados:
                    </div>
                    {slotsAGenerar.map((s, idx) => (
                      <p key={idx} className="pl-3 opacity-80">
                        {idx + 1}. {s.descripcion || `Vehículo ${idx + 1}`}
                        {s.placa ? <span className="font-semibold ml-1">· {s.placa}</span> : ""}
                        {s.tipo === "tercerizada"
                          ? <span className="ml-1 px-1 py-0.5 rounded text-[9px] font-bold" style={{ background: "#fef9c3", color: "#854d0e" }}>TERCERO</span>
                          : s.vehiculo_id
                            ? <span className="ml-1 px-1 py-0.5 rounded text-[9px] font-bold" style={{ background: "#dcfce7", color: "#166534" }}>PROPIO</span>
                            : <span className="ml-1 opacity-50">sin asignar</span>}
                        {s.precio ? <span className="font-semibold"> — S/ {Number(s.precio).toFixed(2)}/día</span> : ""}
                      </p>
                    ))}
                  </div>
                )}

                {/* Resumen de lo que se generará */}
                <div className="pt-1.5 mt-0.5 border-t flex items-start gap-2" style={{ borderColor: "#0b315f22" }}>
                  {tramosPorDia === 2 ? <ArrowLeftRight size={13} className="shrink-0 mt-0.5" /> : <Layers size={13} className="shrink-0 mt-0.5" />}
                  <div>
                    {tramosPorDia === 2 && esMultiVehiculo && (
                      <p><b>Por día:</b> {numItems} IDA + {numItems} RETORNO ({horaRetornoEfectiva}) = <b>{numItems * 2} servicios</b></p>
                    )}
                    {tramosPorDia === 2 && !esMultiVehiculo && (
                      <p><b>Por día:</b> 1 IDA + 1 RETORNO ({horaRetornoEfectiva}) enlazados</p>
                    )}
                    {tramosPorDia === 1 && esMultiVehiculo && (
                      <p><b>Por día:</b> {numItems} servicios (uno por vehículo)</p>
                    )}
                    {tramosPorDia === 1 && !esMultiVehiculo && (
                      <p><b>Por día:</b> 1 {generaIda ? "IDA" : "RETORNO"} — S/ {precioDiaTotal.toFixed(2)}</p>
                    )}
                    {tramosPorDia === 2 && (
                      <p className="opacity-60 text-[10px]">Precio en IDA · RETORNO = S/ 0.00 (par = un solo cobro)</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── ADICIONAL: qué móvil de la cotización se toma como referencia ── */}
          {esAdicional && cot && slots.length > 1 && (
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                Móvil de la cotización *
              </label>
              <select className={inputCls()} value={slotIdx} onChange={e => { setSlotIdx(Number(e.target.value)); setPrecioTocado(false); }}>
                {slots.map((s, idx) => (
                  <option key={idx} value={idx}>
                    {idx + 1}. {s.descripcion || `Vehículo ${idx + 1}`} — S/ {Number(s.precio).toFixed(2)}
                    {s.pax_contratado ? ` · ${s.pax_contratado} pax` : ""}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                Un adicional es UN móvil: de aquí salen la tarifa de referencia, el vehículo
                heredado y el pax contratado. {slotRecursoLabel(slotAdicional)}
              </p>
            </div>
          )}

          {/* ── Fechas ─────────────────────────────────────────────────── */}
          {esAdicional ? (
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                Fechas del adicional *
              </label>
              <div className="flex gap-2">
                <input
                  type="date"
                  className={inputCls()}
                  value={fechaNueva}
                  onChange={e => setFechaNueva(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); agregarFecha(fechaNueva); } }}
                />
                <button
                  type="button"
                  onClick={() => agregarFecha(fechaNueva)}
                  disabled={!fechaNueva}
                  className="px-4 rounded-xl font-bold text-sm text-white disabled:opacity-40 shrink-0 flex items-center gap-1"
                  style={{ background: acento }}
                >
                  <Plus size={14} /> Agregar
                </button>
              </div>
              {fechasSueltas.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {fechasSueltas.map(f => (
                    <span key={f} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold"
                          style={{ background: "#fef3c7", color: "#854d0e" }}>
                      {fechaChip(f)}
                      <button type="button" onClick={() => setFechasSueltas(prev => prev.filter(x => x !== f))}
                              className="opacity-60 hover:opacity-100">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                Fechas sueltas, no un rango: un adicional son tres salidas de días distintos.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fecha inicio *</label>
                  <input type="date" className={inputCls()} value={fechaInicio} onChange={e => setFechaInicio(e.target.value)} />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fecha fin *</label>
                  <input type="date" className={inputCls()} value={fechaFin} onChange={e => setFechaFin(e.target.value)} />
                </div>
              </div>

              {/* Días de semana */}
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Días de la semana *</label>
                <div className="flex gap-2">
                  {DIAS_SEMANA.map((dia, i) => (
                    <button
                      key={dia}
                      type="button"
                      onClick={() => toggleDia(i)}
                      className="flex-1 py-2 rounded-xl text-xs font-bold transition-all border-2"
                      style={{
                        background:  diasUI[i] ? "#0b315f" : "white",
                        color:       diasUI[i] ? "white"   : "#9ca3af",
                        borderColor: diasUI[i] ? "#0b315f" : "#e5e7eb",
                      }}
                    >
                      {dia}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── ADICIONAL: sentido ─────────────────────────────────────── */}
          {esAdicional && (
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Sentido *</label>
              <div className="flex gap-2">
                {([
                  { v: "ida",     t: "Solo ida" },
                  { v: "retorno", t: "Solo salida" },
                  { v: "ambos",   t: "Ida y salida" },
                ] as const).map(o => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => { setSentidoAdic(o.v); setNombreTocado(false); }}
                    className="flex-1 py-2 rounded-xl text-xs font-bold transition-all border-2"
                    style={{
                      background:  sentidoAdic === o.v ? acento : "white",
                      color:       sentidoAdic === o.v ? "white" : "#9ca3af",
                      borderColor: sentidoAdic === o.v ? acento : "#e5e7eb",
                    }}
                  >
                    {o.t}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                El programa fijo crea siempre los dos tramos. Aquí se elige: pedir solo la
                salida ya no obliga a crear la entrada para cancelarla después.
              </p>
            </div>
          )}

          {/* Horas */}
          <div className="grid grid-cols-2 gap-4">
            {generaIda && (
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                  {tramosPorDia === 2 ? "Hora salida IDA" : "Hora de salida"}
                </label>
                <input type="time" className={inputCls()} value={hora} onChange={e => setHora(e.target.value)} />
              </div>
            )}
            {generaRetorno && (
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                  {generaIda ? "Hora salida RETORNO" : "Hora de la salida"}
                </label>
                {esAdicional ? (
                  // Editable: el adicional puede salir a otra hora que el contrato, y ahí
                  // está justo la razón de que sea adicional.
                  <input type="time" className={inputCls()} value={horaRetorno} onChange={e => setHoraRetorno(e.target.value)} />
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50">
                    <ArrowRight size={14} className="text-gray-400 shrink-0" style={{ transform: "scaleX(-1)" }} />
                    <span className="text-sm font-bold text-gray-700">{cot?.hora_retorno}</span>
                    <span className="text-[10px] text-gray-400 ml-auto">desde cotización</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── ADICIONAL: precio y motivo ─────────────────────────────── */}
          {esAdicional && cot && (
            <div className="rounded-xl border-2 p-4 space-y-3" style={{ borderColor: "#fde68a", background: "#fffbeb" }}>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide mb-1" style={{ color: "#854d0e" }}>
                  Precio por servicio *
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold" style={{ color: "#854d0e" }}>S/</span>
                  <input
                    type="number" step="0.01" min="0"
                    className={inputCls()}
                    value={precioAdicVal}
                    onChange={e => { setPrecioTocado(true); setPrecioAdic(e.target.value); }}
                    placeholder="0.00"
                  />
                </div>
                <p className="text-[11px] mt-1.5" style={{ color: difierePrecio ? "#b45309" : "#78716c" }}>
                  {sinReferencia
                    ? "La cotización no fija tarifa para este móvil, así que no hay contra qué comparar: escribe el precio acordado."
                    : <>Cotizado: <b>S/ {precioReferencia.toFixed(2)}</b>
                        {difierePrecio && (
                          <> · lo estás cobrando <b>S/ {Math.abs(precioAdicNum - precioReferencia).toFixed(2)} {precioAdicNum > precioReferencia ? "más" : "menos"}</b></>
                        )}
                      </>}
                </p>
              </div>

              {/* El motivo solo aparece cuando hace falta. Pedirlo siempre lo convierte en
                  un campo que se rellena con lo primero de la lista. */}
              {pedirMotivo && (
                <>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wide mb-1" style={{ color: "#854d0e" }}>
                      {difierePrecio ? "Motivo del precio distinto *" : "Motivo (opcional)"}
                    </label>
                    <select className={inputCls()} value={motivoAdic} onChange={e => setMotivoAdic(e.target.value)}>
                      <option value="">Seleccionar motivo...</option>
                      {MOTIVOS_ADICIONAL.map(m => <option key={m.clave} value={m.clave}>{m.nombre}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wide mb-1" style={{ color: "#854d0e" }}>
                      Nota (opcional)
                    </label>
                    <input
                      className={inputCls()}
                      value={notaAdic}
                      onChange={e => setNotaAdic(e.target.value)}
                      placeholder="Quién lo pidió, por qué correo, qué se acordó…"
                    />
                    <p className="text-[10px] mt-1 leading-snug" style={{ color: "#92400e" }}>
                      Es el único sitio donde queda escrito el porqué: un adicional nace con su
                      precio, así que no genera un acta de cambio de venta.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Nombre de ruta — lo que verá el pasajero al elegir su bus */}
          {cot && (
            <div>
              <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                <Signpost size={12} className="shrink-0" />
                Nombre de ruta {tramosPorDia === 2 ? "(IDA)" : generaIda ? "" : "(RETORNO)"}
              </label>
              {generaIda && (
                <input
                  className={inputCls()}
                  value={nombreIda}
                  onChange={e => { setNombreTocado(true); setNombreIda(e.target.value); }}
                  placeholder="Ej. RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA"
                />
              )}
              {generaRetorno && (
                <input
                  className={inputCls() + (generaIda ? " mt-2" : "")}
                  value={nombreRetorno}
                  onChange={e => { setNombreTocado(true); setNombreRetorno(e.target.value); }}
                  placeholder="Nombre de ruta (RETORNO)"
                />
              )}
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                Así lo verá el pasajero al elegir su bus. Sugerido desde la cotización;
                corrígelo aquí y se aplica a los {totalServicios || 0} servicios de una vez.
                {generaIda && !nombreIda && " Si lo dejas vacío habrá que ponerlo servicio por servicio."}
              </p>
            </div>
          )}

          {/* Preview */}
          {fechas.length > 0 && (
            <div
              className="rounded-xl px-4 py-3 flex items-center gap-3 text-sm"
              style={{ background: previewColor.bg, color: previewColor.text }}
            >
              <RefreshCw size={16} className="shrink-0" />
              <div>{previewLabel()}</div>
            </div>
          )}
          {!esAdicional && fechaInicio && fechaFin && !diasUI.some(Boolean) && (
            <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#fef9c3", color: "#854d0e" }}>
              Selecciona al menos un día de la semana.
            </div>
          )}
          {!esAdicional && fechaInicio && fechaFin && new Date(fechaInicio) > new Date(fechaFin) && (
            <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#fee2e2", color: "#991b1b" }}>
              La fecha de inicio debe ser anterior a la fecha de fin.
            </div>
          )}

        </div>

        {/* Footer — fijo, siempre visible */}
        <div className="px-6 py-4 border-t shrink-0 space-y-2" style={{ borderColor: "#e2e8f0" }}>
          {/* Por qué no se puede generar todavía. Un botón apagado y mudo se lee como
              "el sistema está roto". */}
          {faltaPara && cotizacionId && (
            <p className="text-xs text-center" style={{ color: "#b45309" }}>{faltaPara}</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={confirmar}
              disabled={!puedeGenerar || generando}
              className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-40 transition-all"
              style={{ background: acento }}
            >
              {botonLabel()}
            </button>
            <button onClick={onClose} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
