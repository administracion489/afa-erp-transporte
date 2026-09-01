"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { X, Calendar, RefreshCw, ArrowRight, ArrowLeftRight, Layers, Signpost } from "lucide-react";
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

/**
 * Inserta reservas tolerando que falte `capacidad_contratada` (la agrega
 * supabase/liquidaciones-03-ruta-contratada.sql). Sin la migración, PostgREST rechaza
 * el lote entero por una columna desconocida: antes que dejar sin programar el mes, se
 * reintenta sin ese campo y la liquidación resuelve el pax por los otros escalones de
 * su cascada.
 */
async function insertarReservas(filas: any[], devolverIds = false): Promise<{ data: any[] | null; error: any }> {
  const meter = (f: any[]) => {
    const q = supabase.from("reservas").insert(f);
    return devolverIds ? q.select("id") : q;
  };
  const r = await meter(filas);
  if (r.error && /capacidad_contratada/i.test(String(r.error.message)))
    return await meter(filas.map(({ capacidad_contratada, ...resto }) => resto));
  return r as { data: any[] | null; error: any };
}


const DIAS_SEMANA  = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const UI_TO_JS_DAY = [1, 2, 3, 4, 5, 6, 0];

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

function inputCls() {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all";
}

interface Props {
  clientes: Cliente[];
  onClose: () => void;
  onGenerado: (info: { lote: string; cantidad: number }) => void;
}

export default function ModalGenerarPrograma({ clientes, onClose, onGenerado }: Props) {
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

  const fechasGeneradas = useMemo(
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

  useEffect(() => {
    if (nombreTocado) return;
    setNombreIda(cot ? sugerirNombreRuta({ asunto: cot.asunto, paradas: cot.paradas_json, hora, sentido: "ida" }) : "");
    setNombreRetorno(cot && tieneRetorno
      ? sugerirNombreRuta({ asunto: cot.asunto, paradas: paradasRetornoNombre, hora: cot.hora_retorno, sentido: "retorno" })
      : "");
  }, [cot, hora, tieneRetorno, paradasRetornoNombre, nombreTocado]);

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

  const numItems       = slots.length;
  const esMultiVehiculo = numItems > 1;

  const clienteNombre = (id: number | null) => {
    if (!id) return "Sin cliente";
    const c = clientes.find(c => c.id === id);
    return c ? (c.empresa || c.nombre) : "Cliente #" + id;
  };

  const precioDiaTotal   = slots.reduce((acc, s) => acc + s.precio, 0);
  const totalServicios   = fechasGeneradas.length * numItems * (tieneRetorno ? 2 : 1);
  const puedeGenerar     = !!cotizacionId && !!fechaInicio && !!fechaFin && diasUI.some(Boolean) && fechasGeneradas.length > 0;

  // ── Generación ───────────────────────────────────────────────────────────
  const confirmar = async () => {
    if (!puedeGenerar || !cot) return;

    const lineasMsg = esMultiVehiculo
      ? `${numItems} vehículos × ${fechasGeneradas.length} días`
      : `${fechasGeneradas.length} días`;
    const retMsg = tieneRetorno ? " × IDA+RETORNO" : "";
    if (!confirm(`¿Generar ${lineasMsg}${retMsg} = ${totalServicios} servicios en total?`)) return;

    setGenerando(true);

    const lote = crypto.randomUUID();
    let totalInsertados = 0;

    const origenIda      = cot.paradas_json?.find((p: any) => p.tipo === "inicio")?.nombre  || "Sin especificar";
    const destinoIda     = cot.paradas_json?.find((p: any) => p.tipo === "destino")?.nombre || "Sin especificar";
    const paradasRetorno = cot.paradas_retorno_json?.length ? cot.paradas_retorno_json : cot.paradas_json;
    const origenRetorno  = cot.paradas_retorno_json?.find((p: any) => p.tipo === "inicio")?.nombre  || destinoIda;
    const destinoRetorno = cot.paradas_retorno_json?.find((p: any) => p.tipo === "destino")?.nombre || origenIda;

    const BATCH = 50;

    for (const slot of slots) {
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

      const camposBase = {
        cotizacion_id:         cot.id,
        cliente_id:            cot.cliente_id,
        // Snapshot de lo CONTRATADO: es lo que imprimirá la liquidación, y tiene que
        // sobrevivir a que el contrato se renegocie más adelante.
        capacidad_contratada:  slot.pax_contratado,
        hora_servicio:         hora,
        estado:                "pendiente",
        costo_proveedor:       0,
        tipo_servicio_detalle: cot.tipo_servicio || "transporte_personal",
        paradas_json:          cot.paradas_json,
        origen:                origenIda,
        destino:               destinoIda,
        ruta_nombre:           nombreIda.trim() || null,
        lote_generacion:       lote,
        ...camposVehiculo,
      };

      if (!tieneRetorno) {
        // ── Solo IDA ────────────────────────────────────────────────────
        const filas = fechasGeneradas.map(fecha => ({
          ...camposBase,
          fecha_servicio: fecha,
          precio_cliente: slot.precio,
        }));

        for (let i = 0; i < filas.length; i += BATCH) {
          const { error } = await insertarReservas(filas.slice(i, i + BATCH));
          if (error) {
            alert("Error al generar servicios: " + error.message);
            setGenerando(false);
            return;
          }
        }
        totalInsertados += filas.length;

      } else {
        // ── Par IDA + RETORNO vinculados ────────────────────────────────

        // 1. Insertar IDAs y obtener sus IDs
        const filasIda = fechasGeneradas.map(fecha => ({
          ...camposBase,
          fecha_servicio:     fecha,
          precio_cliente:     slot.precio,
          direccion_servicio: "ida",
        }));

        const idasIds: number[] = [];
        for (let i = 0; i < filasIda.length; i += BATCH) {
          const { data, error } = await insertarReservas(filasIda.slice(i, i + BATCH), true);
          if (error) {
            alert("Error al generar servicios de IDA: " + error.message);
            setGenerando(false);
            return;
          }
          idasIds.push(...(data || []).map((r: any) => r.id));
        }

        // 2. Insertar RETORNOs con referencia a cada IDA
        const camposBaseRetorno = {
          cotizacion_id:         cot.id,
          cliente_id:            cot.cliente_id,
          hora_servicio:         cot.hora_retorno,
          estado:                "pendiente",
          precio_cliente:        0,           // El precio del par va en la IDA
          costo_proveedor:       0,
          tipo_servicio_detalle: cot.tipo_servicio || "transporte_personal",
          paradas_json:          paradasRetorno,
          origen:                origenRetorno,
          destino:               destinoRetorno,
          ruta_nombre:           nombreRetorno.trim() || null,
          direccion_servicio:    "retorno",
          lote_generacion:       lote,
          ...camposVehiculo,
        };

        const filasRetorno = fechasGeneradas.map((fecha, idx) => ({
          ...camposBaseRetorno,
          fecha_servicio:       fecha,
          reserva_vinculada_id: idasIds[idx],
        }));

        const retornosIds: number[] = [];
        for (let i = 0; i < filasRetorno.length; i += BATCH) {
          const { data, error } = await insertarReservas(filasRetorno.slice(i, i + BATCH), true);
          if (error) {
            alert("Error al generar servicios de RETORNO: " + error.message);
            setGenerando(false);
            return;
          }
          retornosIds.push(...(data || []).map((r: any) => r.id));
        }

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
    if (fechasGeneradas.length === 0) return null;
    const diasStr = `${fechasGeneradas.length} día${fechasGeneradas.length !== 1 ? "s" : ""}`;

    if (tieneRetorno && esMultiVehiculo) {
      return (
        <><b>{diasStr} × {numItems} vehículos × IDA+RETORNO</b>
          <span className="opacity-70"> = {totalServicios} servicios</span>
          {precioDiaTotal > 0 && <span className="opacity-70"> · S/ {(fechasGeneradas.length * precioDiaTotal).toLocaleString("es-PE", { minimumFractionDigits: 2 })} total est.</span>}
        </>
      );
    }
    if (tieneRetorno) {
      return (
        <><b>{fechasGeneradas.length} pares IDA+RETORNO</b>
          <span className="opacity-70"> ({fechasGeneradas.length * 2} servicios)</span>
          {precioDiaTotal > 0 && <span className="opacity-70"> · S/ {(fechasGeneradas.length * precioDiaTotal).toLocaleString("es-PE", { minimumFractionDigits: 2 })} total est.</span>}
        </>
      );
    }
    if (esMultiVehiculo) {
      return (
        <><b>{diasStr} × {numItems} vehículos</b>
          <span className="opacity-70"> = {totalServicios} servicios</span>
          {precioDiaTotal > 0 && <span className="opacity-70"> · S/ {(fechasGeneradas.length * precioDiaTotal).toLocaleString("es-PE", { minimumFractionDigits: 2 })} total est.</span>}
        </>
      );
    }
    return (
      <><b>{fechasGeneradas.length} servicios</b> a generar
        {precioDiaTotal > 0 && <span className="ml-2 opacity-70">· S/ {(fechasGeneradas.length * precioDiaTotal).toLocaleString("es-PE", { minimumFractionDigits: 2 })} total est.</span>}
      </>
    );
  };

  const botonLabel = () => {
    if (generando)   return "Generando...";
    if (!puedeGenerar) return "Generar programa";
    return `Generar ${totalServicios} servicio${totalServicios !== 1 ? "s" : ""}`;
  };

  const previewColor = tieneRetorno || esMultiVehiculo
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
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: "#0b315f" }}>
              <Calendar size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Generar programa fijo</h2>
              <p className="text-xs text-gray-400">Crea múltiples servicios desde una cotización</p>
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
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Cotización fija *</label>
            {cargando ? (
              <p className="text-sm text-gray-400 py-2">Cargando cotizaciones...</p>
            ) : cotizaciones.length === 0 ? (
              <p className="text-sm text-amber-600 py-2">No hay cotizaciones fijas.</p>
            ) : (
              <select className={inputCls()} value={cotizacionId} onChange={e => {
                setCotizacionId(e.target.value);
                setNombreTocado(false); // otra cotización ⇒ otra ruta: vuelve a sugerir
                // La hora arranca en la del contrato (primer paradero → hora_ida). Tipearla a mano
                // es lo que deja reservas.hora_servicio desfasada de los paraderos reales.
                const c = cotizaciones.find(c => c.id === Number(e.target.value));
                const h = String(c?.paradas_json?.find(p => p.tipo === "inicio")?.hora || c?.hora_ida || "").slice(0, 5);
                if (h) setHora(h);
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
                {tieneRetorno && (
                  <p>
                    <b>Ruta RETORNO:</b>{" "}
                    {cot.paradas_retorno_json?.length
                      ? nombreRuta(cot.paradas_retorno_json)
                      : <span className="italic opacity-60">mismas paradas en sentido inverso</span>}
                  </p>
                )}

                {/* Lista de slots/vehículos */}
                {esMultiVehiculo && (
                  <div className="pt-1.5 mt-0.5 border-t" style={{ borderColor: "#0b315f22" }}>
                    <div className="flex items-center gap-1.5 mb-1 font-bold">
                      <Layers size={11} className="shrink-0" />
                      {numItems} vehículos detectados:
                    </div>
                    {slots.map((s, idx) => (
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
                  {tieneRetorno ? <ArrowLeftRight size={13} className="shrink-0 mt-0.5" /> : <Layers size={13} className="shrink-0 mt-0.5" />}
                  <div>
                    {tieneRetorno && esMultiVehiculo && (
                      <p><b>Por día:</b> {numItems} IDA + {numItems} RETORNO ({cot.hora_retorno}) = <b>{numItems * 2} servicios</b></p>
                    )}
                    {tieneRetorno && !esMultiVehiculo && (
                      <p><b>Por día:</b> 1 IDA + 1 RETORNO ({cot.hora_retorno}) enlazados</p>
                    )}
                    {!tieneRetorno && esMultiVehiculo && (
                      <p><b>Por día:</b> {numItems} servicios (uno por vehículo)</p>
                    )}
                    {!tieneRetorno && !esMultiVehiculo && (
                      <p><b>Por día:</b> 1 servicio — S/ {precioDiaTotal.toFixed(2)}</p>
                    )}
                    {tieneRetorno && (
                      <p className="opacity-60 text-[10px]">Precio en IDA · RETORNO = S/ 0.00 (par = un solo cobro)</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Rango de fechas */}
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

          {/* Horas */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                {tieneRetorno ? "Hora salida IDA" : "Hora de salida"}
              </label>
              <input type="time" className={inputCls()} value={hora} onChange={e => setHora(e.target.value)} />
            </div>
            {tieneRetorno && (
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                  Hora salida RETORNO
                </label>
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50">
                  <ArrowRight size={14} className="text-gray-400 shrink-0" style={{ transform: "scaleX(-1)" }} />
                  <span className="text-sm font-bold text-gray-700">{cot?.hora_retorno}</span>
                  <span className="text-[10px] text-gray-400 ml-auto">desde cotización</span>
                </div>
              </div>
            )}
          </div>

          {/* Nombre de ruta — lo que verá el pasajero al elegir su bus */}
          {cot && (
            <div>
              <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                <Signpost size={12} className="shrink-0" />
                Nombre de ruta {tieneRetorno ? "(IDA)" : ""}
              </label>
              <input
                className={inputCls()}
                value={nombreIda}
                onChange={e => { setNombreTocado(true); setNombreIda(e.target.value); }}
                placeholder="Ej. RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA"
              />
              {tieneRetorno && (
                <input
                  className={inputCls() + " mt-2"}
                  value={nombreRetorno}
                  onChange={e => { setNombreTocado(true); setNombreRetorno(e.target.value); }}
                  placeholder="Nombre de ruta (RETORNO)"
                />
              )}
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                Así lo verá el pasajero al elegir su bus. Sugerido desde la cotización;
                corrígelo aquí y se aplica a los {totalServicios || 0} servicios de una vez.
                {!nombreIda && " Si lo dejas vacío habrá que ponerlo servicio por servicio."}
              </p>
            </div>
          )}

          {/* Preview */}
          {fechasGeneradas.length > 0 && (
            <div
              className="rounded-xl px-4 py-3 flex items-center gap-3 text-sm"
              style={{ background: previewColor.bg, color: previewColor.text }}
            >
              <RefreshCw size={16} className="shrink-0" />
              <div>{previewLabel()}</div>
            </div>
          )}
          {fechaInicio && fechaFin && !diasUI.some(Boolean) && (
            <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#fef9c3", color: "#854d0e" }}>
              Selecciona al menos un día de la semana.
            </div>
          )}
          {fechaInicio && fechaFin && new Date(fechaInicio) > new Date(fechaFin) && (
            <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#fee2e2", color: "#991b1b" }}>
              La fecha de inicio debe ser anterior a la fecha de fin.
            </div>
          )}

        </div>

        {/* Footer — fijo, siempre visible */}
        <div className="flex gap-3 px-6 py-4 border-t shrink-0" style={{ borderColor: "#e2e8f0" }}>
          <button
            onClick={confirmar}
            disabled={!puedeGenerar || generando}
            className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-40 transition-all"
            style={{ background: "#0b315f" }}
          >
            {botonLabel()}
          </button>
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            Cancelar
          </button>
        </div>

      </div>
    </div>
  );
}
