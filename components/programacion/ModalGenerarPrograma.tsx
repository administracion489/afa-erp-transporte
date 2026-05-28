"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { X, Calendar, RefreshCw } from "lucide-react";

type CotizacionFija = {
  id: number;
  cliente_id: number | null;
  tipo_servicio: string | null;
  precio_dia: number | null;
  precio_cliente: number | null;
  paradas_json: any[] | null;
};

type Cliente = { id: number; nombre: string; empresa?: string; };

const DIAS_SEMANA = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
// Mapping UI index (0=Lun … 6=Dom) → JS getDay() (1=Mon … 0=Sun)
const UI_TO_JS_DAY = [1, 2, 3, 4, 5, 6, 0];

function generarFechas(inicio: string, fin: string, diasUI: boolean[]): string[] {
  if (!inicio || !fin) return [];
  const fechas: string[] = [];
  const cur = new Date(inicio + "T12:00:00");
  const end = new Date(fin + "T12:00:00");
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
  onGenerado: () => void;
}

export default function ModalGenerarPrograma({ clientes, onClose, onGenerado }: Props) {
  const [cotizaciones,  setCotizaciones]  = useState<CotizacionFija[]>([]);
  const [cotizacionId,  setCotizacionId]  = useState<string>("");
  const [fechaInicio,   setFechaInicio]   = useState<string>("");
  const [fechaFin,      setFechaFin]      = useState<string>("");
  const [diasUI,        setDiasUI]        = useState<boolean[]>([true, true, true, true, true, false, false]);
  const [hora,          setHora]          = useState<string>("07:00");
  const [generando,     setGenerando]     = useState(false);
  const [cargando,      setCargando]      = useState(true);

  useEffect(() => {
    supabase
      .from("cotizaciones")
      .select("id, cliente_id, tipo_servicio, precio_dia, precio_cliente, paradas_json")
      .eq("modo_servicio", "fijo")
      .order("id", { ascending: false })
      .then(({ data }: { data: CotizacionFija[] | null }) => { setCotizaciones(data || []); setCargando(false); });
  }, []);

  const fechasGeneradas = useMemo(
    () => generarFechas(fechaInicio, fechaFin, diasUI),
    [fechaInicio, fechaFin, diasUI]
  );

  const cot = cotizaciones.find(c => c.id === Number(cotizacionId));

  const clienteNombre = (id: number | null) => {
    if (!id) return "Sin cliente";
    const c = clientes.find(c => c.id === id);
    return c ? (c.empresa || c.nombre) : "Cliente #" + id;
  };

  const precioDia = Number(cot?.precio_dia || cot?.precio_cliente || 0);
  const puedeGenerar = !!cotizacionId && !!fechaInicio && !!fechaFin && diasUI.some(Boolean) && fechasGeneradas.length > 0;

  const confirmar = async () => {
    if (!puedeGenerar || !cot) return;
    if (!confirm(`¿Generar ${fechasGeneradas.length} reservas para este contrato? Podrás eliminar días individuales si hay feriados.`)) return;

    setGenerando(true);

    const origen  = cot.paradas_json?.find((p: any) => p.tipo === "inicio")?.nombre  || "Sin especificar";
    const destino = cot.paradas_json?.find((p: any) => p.tipo === "destino")?.nombre || "Sin especificar";

    const filas = fechasGeneradas.map(fecha => ({
      cotizacion_id:         cot.id,
      cliente_id:            cot.cliente_id,
      fecha_servicio:        fecha,
      hora_servicio:         hora,
      tipo:                  "propia",
      tipo_asignacion:       "propio",
      estado:                "pendiente",
      precio_cliente:        precioDia,
      costo_proveedor:       0,
      tipo_servicio_detalle: "transporte_personal",
      paradas_json:          cot.paradas_json,
      origen,
      destino,
    }));

    const BATCH = 100;
    for (let i = 0; i < filas.length; i += BATCH) {
      const { error } = await supabase.from("reservas").insert(filas.slice(i, i + BATCH));
      if (error) {
        alert("Error al generar reservas: " + error.message);
        setGenerando(false);
        return;
      }
    }

    setGenerando(false);
    onGenerado();
    onClose();
  };

  const toggleDia = (i: number) => setDiasUI(prev => prev.map((v, j) => j === i ? !v : v));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "#e2e8f0" }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white" style={{ background: "#0b315f" }}>
              <Calendar size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Generar programa fijo</h2>
              <p className="text-xs text-gray-400">Crea múltiples servicios desde una cotización</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100 transition-colors">
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        <div className="p-6 space-y-5">

          {/* Cotización */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Cotización fija *</label>
            {cargando ? (
              <p className="text-sm text-gray-400 py-2">Cargando cotizaciones...</p>
            ) : cotizaciones.length === 0 ? (
              <p className="text-sm text-amber-600 py-2">No hay cotizaciones fijas registradas. Crea una desde el módulo de Cotizaciones.</p>
            ) : (
              <select className={inputCls()} value={cotizacionId} onChange={e => setCotizacionId(e.target.value)}>
                <option value="">Seleccionar cotización...</option>
                {cotizaciones.map(c => (
                  <option key={c.id} value={c.id}>
                    #{c.id} — {clienteNombre(c.cliente_id)} — {nombreRuta(c.paradas_json)} — S/ {Number(c.precio_dia || c.precio_cliente || 0).toFixed(2)}/día
                  </option>
                ))}
              </select>
            )}
            {cot && (
              <div className="mt-2 rounded-xl px-4 py-3 text-xs space-y-1" style={{ background: "#eef3f8", color: "#0b315f" }}>
                <p><b>Cliente:</b> {clienteNombre(cot.cliente_id)}</p>
                <p><b>Ruta:</b> {nombreRuta(cot.paradas_json)}</p>
                <p><b>Precio por día:</b> S/ {precioDia.toFixed(2)} · cada servicio generado registra este monto como ingreso</p>
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
                    background:   diasUI[i] ? "#0b315f" : "white",
                    color:        diasUI[i] ? "white"   : "#9ca3af",
                    borderColor:  diasUI[i] ? "#0b315f" : "#e5e7eb",
                  }}
                >
                  {dia}
                </button>
              ))}
            </div>
          </div>

          {/* Hora */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Hora de salida</label>
              <input type="time" className={inputCls()} value={hora} onChange={e => setHora(e.target.value)} />
            </div>
          </div>

          {/* Preview */}
          {fechasGeneradas.length > 0 && (
            <div className="rounded-xl px-4 py-3 flex items-center gap-3 text-sm" style={{ background: "#dcfce7", color: "#166534" }}>
              <RefreshCw size={16} className="shrink-0" />
              <div>
                <b>{fechasGeneradas.length} servicios</b> a generar
                {precioDia > 0 && (
                  <span className="ml-2 opacity-70">
                    · Ingreso total estimado: S/ {(fechasGeneradas.length * precioDia).toLocaleString("es-PE", { minimumFractionDigits: 2 })}
                  </span>
                )}
              </div>
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

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t" style={{ borderColor: "#e2e8f0" }}>
          <button
            onClick={confirmar}
            disabled={!puedeGenerar || generando}
            className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-40 transition-all"
            style={{ background: "#0b315f" }}
          >
            {generando
              ? "Generando..."
              : puedeGenerar
                ? `Generar ${fechasGeneradas.length} servicios`
                : "Generar programa"}
          </button>
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
