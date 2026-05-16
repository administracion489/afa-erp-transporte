"use client";

import React, { useEffect, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { supabase } from "@/lib/supabase";

type Reserva = {
  id: number; cliente_id: number | null; vehiculo_id: number | null;
  conductor_id: number | null; origen: string; destino: string;
  fecha_servicio: string | null; hora_servicio: string | null;
  estado: string; tipo: string;
  precio_cliente: number; costo_proveedor: number; margen: number;
  observaciones: string | null;
  tipo_servicio_detalle: string | null;
};

type Cotizacion = {
  id: number; cliente_id: number | null;
  origen: string; destino: string;
  fecha_servicio: string | null; hora_ida: string | null;
  estado: string; precio_cliente: number;
  numero_cotizacion: string | null; asunto: string | null;
};

type Cliente   = { id: number; nombre: string; empresa?: string; tipo?: string; };
type Vehiculo  = { id: number; placa: string; categoria?: string; };
type Conductor = { id: number; nombre: string; };

const RESERVA_COLOR: Record<string, { bg: string; border: string; text: string; badge: string; badgeText: string }> = {
  pendiente:  { bg: "#fef9c3", border: "#eab308", text: "#854d0e", badge: "#fef9c3", badgeText: "#854d0e" },
  programada: { bg: "#e0f2fe", border: "#0284c7", text: "#0369a1", badge: "#e0f2fe", badgeText: "#0369a1" },
  confirmada: { bg: "#dcfce7", border: "#16a34a", text: "#166534", badge: "#dcfce7", badgeText: "#166534" },
  en_curso:   { bg: "#dbeafe", border: "#2563eb", text: "#1d4ed8", badge: "#dbeafe", badgeText: "#1d4ed8" },
  finalizada: { bg: "#ede9fe", border: "#7c3aed", text: "#6d28d9", badge: "#ede9fe", badgeText: "#6d28d9" },
  cancelada:  { bg: "#fee2e2", border: "#dc2626", text: "#991b1b", badge: "#fee2e2", badgeText: "#991b1b" },
};

const RESERVA_FC: Record<string, string> = {
  pendiente: "#eab308", programada: "#0284c7", confirmada: "#16a34a",
  en_curso: "#2563eb", finalizada: "#7c3aed", cancelada: "#dc2626",
};

function fmtSoles(n: number) {
  return "S/ " + Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2 });
}

function fmtFecha(f: string | null) {
  if (!f) return "-";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long" });
}

function esEventual(r: Reserva): boolean {
  return r.tipo_servicio_detalle !== "transporte_personal";
}

function ModalReserva({ reserva, cliente, vehiculo, conductor, onCerrar, onCambiarEstado }: {
  reserva: Reserva; cliente?: Cliente; vehiculo?: Vehiculo; conductor?: Conductor;
  onCerrar: () => void; onCambiarEstado: (id: number, estado: string) => void;
}) {
  const estCfg = RESERVA_COLOR[reserva.estado] || RESERVA_COLOR.pendiente;
  const esFijo = !esEventual(reserva);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onCerrar}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4" style={{ background: estCfg.border }}>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-white text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.25)" }}>Reserva #{reserva.id}</span>
                <span className="text-white text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.25)" }}>{reserva.tipo === "tercerizada" ? "Tercerizada" : "Propia"}</span>
                <span className="text-white text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.25)" }}>{esFijo ? "Fijo" : "Eventual"}</span>
              </div>
              <h3 className="text-white font-black text-lg leading-tight">{reserva.origen} - {reserva.destino}</h3>
              <p className="text-white/80 text-sm mt-0.5">{cliente?.empresa || cliente?.nombre || "Sin cliente"}</p>
            </div>
            <button onClick={onCerrar} className="text-white/70 hover:text-white text-xl font-bold">X</button>
          </div>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <span className="font-bold">{fmtFecha(reserva.fecha_servicio)}</span>
            </div>
            {reserva.hora_servicio && (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span>{reserva.hora_servicio.slice(0, 5)} hrs</span>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Vehiculo</p>
              <p className="font-black text-gray-800 font-mono">{vehiculo?.placa || "-"}</p>
              <p className="text-xs text-gray-400">{vehiculo?.categoria || ""}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Conductor</p>
              <p className="font-bold text-gray-800 text-sm">{conductor?.nombre || "-"}</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-green-50 rounded-xl p-2">
              <p className="text-[10px] font-bold text-green-600 uppercase">Precio</p>
              <p className="text-sm font-black text-green-700">{fmtSoles(Number(reserva.precio_cliente || 0))}</p>
            </div>
            <div className="bg-red-50 rounded-xl p-2">
              <p className="text-[10px] font-bold text-red-500 uppercase">Costo</p>
              <p className="text-sm font-black text-red-700">{fmtSoles(Number(reserva.costo_proveedor || 0))}</p>
            </div>
            <div className="rounded-xl p-2" style={{ background: Number(reserva.margen || 0) >= 0 ? "#dcfce7" : "#fee2e2" }}>
              <p className="text-[10px] font-bold uppercase" style={{ color: Number(reserva.margen || 0) >= 0 ? "#166534" : "#991b1b" }}>Margen</p>
              <p className="text-sm font-black" style={{ color: Number(reserva.margen || 0) >= 0 ? "#166534" : "#991b1b" }}>{fmtSoles(Number(reserva.margen || 0))}</p>
            </div>
          </div>
          {reserva.observaciones ? <div className="bg-blue-50 rounded-xl px-3 py-2 text-xs text-blue-700 italic">"{reserva.observaciones}"</div> : null}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-2">Cambiar estado</p>
            <div className="flex gap-2 flex-wrap">
              {["pendiente", "programada", "confirmada", "en_curso", "finalizada", "cancelada"].map(est => {
                const cfg = RESERVA_COLOR[est];
                const activo = reserva.estado === est;
                return (
                  <button key={est} onClick={() => onCambiarEstado(reserva.id, est)}
                    className="text-xs font-bold px-3 py-1.5 rounded-lg border-2 transition-all"
                    style={{ background: activo ? cfg.border : cfg.badge, color: activo ? "white" : cfg.badgeText, borderColor: cfg.border, opacity: activo ? 1 : 0.7 }}>
                    {est.replace("_", " ")}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalCotizacion({ cotizacion, cliente, onCerrar }: {
  cotizacion: Cotizacion; cliente?: Cliente; onCerrar: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onCerrar}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4" style={{ background: "#f59e0b" }}>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-white text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.25)" }}>Cotizacion aprobada sin reserva</span>
              </div>
              <h3 className="text-white font-black text-lg">{cotizacion.origen} - {cotizacion.destino}</h3>
              <p className="text-white/80 text-sm">{cliente?.empresa || cliente?.nombre || "Sin cliente"}</p>
            </div>
            <button onClick={onCerrar} className="text-white/70 hover:text-white text-xl font-bold">X</button>
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="bg-amber-50 rounded-xl p-3 text-sm text-amber-800">
            <p className="font-bold mb-1">Esta cotizacion esta aprobada pero aun no se convirtio en reserva.</p>
            <p className="text-xs">Ve a Cotizaciones y usa el boton Reserva para programar este servicio.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-gray-400 font-bold uppercase text-[10px] mb-1">Fecha</p>
              <p className="font-bold text-gray-800">{fmtFecha(cotizacion.fecha_servicio)}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-gray-400 font-bold uppercase text-[10px] mb-1">Monto</p>
              <p className="font-black text-green-700">{fmtSoles(Number(cotizacion.precio_cliente || 0))}</p>
            </div>
          </div>
          {cotizacion.asunto ? <p className="text-xs text-gray-500 italic">"{cotizacion.asunto}"</p> : null}
          <button onClick={onCerrar} className="w-full py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cerrar</button>
        </div>
      </div>
    </div>
  );
}

export default function CalendarioPage() {
  const calRef = useRef<any>(null);

  const [reservas,     setReservas]     = useState<Reserva[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [conductores,  setConductores]  = useState<Conductor[]>([]);
  const [loading,      setLoading]      = useState(true);

  const [modalReserva,          setModalReserva]          = useState<Reserva | null>(null);
  const [modalCotizacion,       setModalCotizacion]       = useState<Cotizacion | null>(null);
  const [filtroEstado,          setFiltroEstado]          = useState("todos");
  const [filtroTipo,            setFiltroTipo]            = useState("todos");
  const [filtroServicio,        setFiltroServicio]        = useState<"todos" | "fijo" | "eventual">("todos");
  const [mostrarCotAprobadas,   setMostrarCotAprobadas]   = useState(true);
  const [vistaActual,           setVistaActual]           = useState("timeGridWeek");

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [rRes, cotRes, clRes, vRes, cRes] = await Promise.all([
        supabase.from("reservas").select("id,cliente_id,vehiculo_id,conductor_id,origen,destino,fecha_servicio,hora_servicio,estado,tipo,precio_cliente,costo_proveedor,margen,observaciones,tipo_servicio_detalle").order("fecha_servicio").order("hora_servicio"),
        supabase.from("cotizaciones").select("id,cliente_id,origen,destino,fecha_servicio,hora_ida,estado,precio_cliente,numero_cotizacion,asunto").eq("estado", "aprobado").not("fecha_servicio", "is", null),
        supabase.from("clientes").select("id,nombre,empresa,tipo"),
        supabase.from("vehiculos").select("id,placa,categoria"),
        supabase.from("conductores").select("id,nombre"),
      ]);
      setReservas(rRes.data || []);
      const cotData = cotRes.data || [];
      const rData = rRes.data || [];
      setCotizaciones(cotData.filter((c: Cotizacion) => !rData.some((r: any) => r.cotizacion_id === c.id)));
      setClientes(clRes.data || []);
      setVehiculos(vRes.data || []);
      setConductores(cRes.data || []);
      setLoading(false);
    })();
  }, []);

  const cambiarEstado = async (id: number, estado: string) => {
    await supabase.from("reservas").update({ estado }).eq("id", id);
    setReservas(prev => prev.map(r => r.id === id ? { ...r, estado } : r));
    if (modalReserva?.id === id) setModalReserva(prev => prev ? { ...prev, estado } : prev);
  };

  const reservasFiltradas = reservas.filter(r =>
    (filtroEstado === "todos" || r.estado === filtroEstado) &&
    (filtroTipo === "todos" || r.tipo === filtroTipo) &&
    (filtroServicio === "todos" || (filtroServicio === "fijo" ? !esEventual(r) : esEventual(r))) &&
    r.fecha_servicio
  );

  const eventosReservas = reservasFiltradas.map(r => {
    const cliente = clientes.find(c => c.id === r.cliente_id);
    const vehiculo = vehiculos.find(v => v.id === r.vehiculo_id);
    const nombreCl = cliente ? (cliente.empresa || cliente.nombre) : "Sin cliente";
    const color = RESERVA_FC[r.estado] || "#eab308";
    const esFijo = !esEventual(r);
    return {
      id: "r-" + r.id,
      title: (esFijo ? "[F] " : "[E] ") + nombreCl + " - " + r.origen.split(",")[0] + " - " + r.destino.split(",")[0],
      start: r.hora_servicio ? (r.fecha_servicio + "T" + r.hora_servicio) : r.fecha_servicio!,
      allDay: !r.hora_servicio,
      backgroundColor: color, borderColor: color, textColor: "#fff",
      extendedProps: { tipo: "reserva", reserva: r, vehiculo },
    };
  });

  const eventosCotizaciones = mostrarCotAprobadas ? cotizaciones.map(c => {
    const cliente = clientes.find(cl => cl.id === c.cliente_id);
    const nombreCl = cliente ? (cliente.empresa || cliente.nombre) : "Sin cliente";
    return {
      id: "c-" + c.id,
      title: "[!] " + nombreCl + " - " + c.origen.split(",")[0] + " - " + c.destino.split(",")[0],
      start: c.hora_ida ? (c.fecha_servicio + "T" + c.hora_ida) : c.fecha_servicio!,
      allDay: !c.hora_ida,
      backgroundColor: "#f59e0b", borderColor: "#d97706", textColor: "#fff",
      extendedProps: { tipo: "cotizacion", cotizacion: c },
    };
  }) : [];

  const eventos = [...eventosReservas, ...eventosCotizaciones];

  const hoy  = new Date().toISOString().split("T")[0];
  const mes  = new Date().getMonth();
  const anio = new Date().getFullYear();

  const resMes  = reservas.filter(r => { if (!r.fecha_servicio) return false; const d = new Date(r.fecha_servicio + "T00:00:00"); return d.getMonth() === mes && d.getFullYear() === anio; });
  const resHoy  = reservas.filter(r => r.fecha_servicio === hoy);
  const pendMes = resMes.filter(r => r.estado === "pendiente").length;
  const confMes = resMes.filter(r => r.estado === "confirmada").length;
  const progMes = resMes.filter(r => r.estado === "programada").length;
  const fijosMes     = resMes.filter(r => !esEventual(r)).length;
  const eventualesMes = resMes.filter(r => esEventual(r)).length;

  const cambiarVista = (vista: string) => { setVistaActual(vista); calRef.current?.getApi().changeView(vista); };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-4 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto" />
        <p className="text-sm font-bold text-gray-500">Cargando calendario...</p>
      </div>
    </div>
  );

  return (
    <>
      {modalReserva ? (
        <ModalReserva
          reserva={modalReserva}
          cliente={clientes.find(c => c.id === modalReserva.cliente_id)}
          vehiculo={vehiculos.find(v => v.id === modalReserva.vehiculo_id)}
          conductor={conductores.find(c => c.id === modalReserva.conductor_id)}
          onCerrar={() => setModalReserva(null)}
          onCambiarEstado={cambiarEstado}
        />
      ) : null}
      {modalCotizacion ? (
        <ModalCotizacion
          cotizacion={modalCotizacion}
          cliente={clientes.find(c => c.id === modalCotizacion.cliente_id)}
          onCerrar={() => setModalCotizacion(null)}
        />
      ) : null}

      <main className="p-6 space-y-4 max-w-7xl mx-auto">

        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Calendario de servicios</h1>
            <p className="text-gray-400 text-sm mt-1">
              Programacion visual · {resMes.length} servicios este mes
              {resHoy.length > 0 ? <span className="ml-2 font-bold text-[#0b315f]">· {resHoy.length} hoy</span> : null}
              {cotizaciones.length > 0 ? <span className="ml-2 font-bold text-amber-600">· {cotizaciones.length} cotiz. aprobadas sin reserva</span> : null}
            </p>
          </div>
        </div>

        {cotizaciones.length > 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
            <span className="text-xl mt-0.5">!</span>
            <div className="text-sm text-amber-800">
              <span className="font-bold">{cotizaciones.length} cotizacion(es) aprobada(s) sin reserva — </span>
              servicios comprometidos que no estan en la agenda. Ve a Cotizaciones y usa la opcion de Reserva para programarlos.
            </div>
          </div>
        ) : null}

        {/* KPIs */}
        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          {[
            { label: "Este mes",    valor: resMes.length,       color: "#0b315f", bg: "#eef3f8" },
            { label: "Hoy",         valor: resHoy.length,       color: "#0f766e", bg: "#f0fdfa" },
            { label: "Fijos",       valor: fijosMes,            color: "#0b315f", bg: "#eef3f8" },
            { label: "Eventuales",  valor: eventualesMes,       color: "#6d28d9", bg: "#ede9fe" },
            { label: "Pendientes",  valor: pendMes,             color: "#854d0e", bg: "#fef9c3" },
            { label: "Programadas", valor: progMes,             color: "#0369a1", bg: "#e0f2fe" },
            { label: "Confirmadas", valor: confMes,             color: "#166534", bg: "#dcfce7" },
            { label: "Sin reserva", valor: cotizaciones.length, color: "#b45309", bg: "#fef3c7" },
          ].map(k => (
            <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
              <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
              <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
            </div>
          ))}
        </section>

        {/* Controles */}
        <div className="bg-white rounded-2xl border shadow-sm p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <button onClick={() => calRef.current?.getApi().today()} className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">Hoy</button>
              <div className="flex">
                <button onClick={() => calRef.current?.getApi().prev()} className="w-8 h-8 rounded-l-lg border flex items-center justify-center hover:bg-gray-50 text-gray-600">-</button>
                <button onClick={() => calRef.current?.getApi().next()} className="w-8 h-8 rounded-r-lg border-t border-b border-r flex items-center justify-center hover:bg-gray-50 text-gray-600">+</button>
              </div>
            </div>

            <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
              {[{ key: "dayGridMonth", label: "Mes" }, { key: "timeGridWeek", label: "Semana" }, { key: "timeGridDay", label: "Dia" }].map(v => (
                <button key={v.key} onClick={() => cambiarVista(v.key)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                  style={{ background: vistaActual === v.key ? "#0b315f" : "transparent", color: vistaActual === v.key ? "white" : "#6b7280" }}>
                  {v.label}
                </button>
              ))}
            </div>

            <div className="flex gap-2 flex-wrap items-center">
              <select className="border rounded-xl px-3 py-1.5 text-xs font-bold focus:outline-none" value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
                <option value="todos">Todos los estados</option>
                <option value="pendiente">Pendientes</option>
                <option value="programada">Programadas</option>
                <option value="confirmada">Confirmadas</option>
                <option value="en_curso">En curso</option>
                <option value="finalizada">Finalizadas</option>
                <option value="cancelada">Canceladas</option>
              </select>
              <select className="border rounded-xl px-3 py-1.5 text-xs font-bold focus:outline-none" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
                <option value="todos">Todos los tipos</option>
                <option value="propia">Propia</option>
                <option value="tercerizada">Tercerizada</option>
              </select>

              {/* NUEVO FILTRO: Fijos / Eventuales */}
              <div className="flex gap-1 rounded-xl p-1" style={{ background: "#f1f5f9" }}>
                {(["todos", "fijo", "eventual"] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setFiltroServicio(t)}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                    style={{
                      background: filtroServicio === t ? "#0b315f" : "transparent",
                      color: filtroServicio === t ? "white" : "#9ca3af",
                      boxShadow: filtroServicio === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                    }}
                  >
                    {t === "todos" ? "Todos" : t === "fijo" ? "Fijos" : "Eventuales"}
                  </button>
                ))}
              </div>

              <button
                onClick={() => setMostrarCotAprobadas(v => !v)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold border transition-all"
                style={{ background: mostrarCotAprobadas ? "#fef3c7" : "white", color: mostrarCotAprobadas ? "#b45309" : "#6b7280", borderColor: mostrarCotAprobadas ? "#f59e0b" : "#e5e7eb" }}
              >
                Cotiz. sin reserva {mostrarCotAprobadas ? "ON" : "OFF"}
              </button>
            </div>

            <div className="flex gap-3 flex-wrap">
              {Object.entries(RESERVA_FC).map(([est, color]) => (
                <div key={est} className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-full" style={{ background: color }} />
                  <span className="text-[11px] font-medium text-gray-500 capitalize">{est.replace("_", " ")}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full" style={{ background: "#f59e0b" }} />
                <span className="text-[11px] font-medium text-amber-600">Cot. aprobada</span>
              </div>
            </div>
          </div>

          {filtroServicio !== "todos" && (
            <div className="mt-3 px-3 py-2 rounded-xl text-xs font-bold" style={{ background: "#eef3f8", color: "#0b315f" }}>
              Mostrando solo servicios {filtroServicio === "fijo" ? "FIJOS (transporte de personal recurrente)" : "EVENTUALES (servicios puntuales)"} · {reservasFiltradas.length} resultado(s)
            </div>
          )}
        </div>

        {/* CALENDARIO */}
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <style>{`
            .fc{font-family:inherit}
            .fc-toolbar{display:none!important}
            .fc-event{border-radius:6px!important;border-width:0!important;padding:3px 6px!important;font-size:12px!important;font-weight:700!important;cursor:pointer!important;min-height:22px!important}
            .fc-event:hover{opacity:.85!important}
            .fc-event-main{color:#fff!important;font-weight:700!important}
            .fc-event-title{color:#fff!important;font-weight:700!important;white-space:normal!important}
            .fc-event-time{color:rgba(255,255,255,0.9)!important;font-size:10px!important}
            .fc-daygrid-event{margin:2px 3px!important;padding:3px 6px!important;min-height:20px!important;border-radius:6px!important}
            .fc-daygrid-event-dot{display:none!important}
            .fc-timegrid-event{border-radius:6px!important;box-shadow:0 2px 4px rgba(0,0,0,0.2)!important}
            .fc-timegrid-event .fc-event-main{padding:4px 6px!important}
            .fc-col-header-cell{background:#f8fafc!important}
            .fc-col-header-cell-cushion{font-size:12px!important;font-weight:700!important;color:#374151!important;text-decoration:none!important;padding:8px 4px!important}
            .fc-daygrid-day-number{font-size:13px!important;font-weight:600!important;color:#374151!important;text-decoration:none!important}
            .fc-day-today{background:#eff6ff!important}
            .fc-day-today .fc-daygrid-day-number{background:#0b315f!important;color:white!important;border-radius:50%!important;width:28px!important;height:28px!important;display:flex!important;align-items:center!important;justify-content:center!important}
            .fc-timegrid-slot-label{font-size:11px!important;color:#9ca3af!important}
            .fc-more-link{font-size:11px!important;font-weight:700!important;color:#0b315f!important}
            .fc-popover{border-radius:12px!important;box-shadow:0 8px 24px rgba(0,0,0,0.15)!important}
            .fc-popover-header{background:#0b315f!important;color:white!important;border-radius:12px 12px 0 0!important;padding:8px 12px!important}
          `}</style>
          <FullCalendar
            ref={calRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="timeGridWeek"
            headerToolbar={false}
            locale="es"
            height={680}
            events={eventos}
            eventClick={(info) => {
              const tipo = info.event.extendedProps.tipo;
              if (tipo === "reserva") setModalReserva(info.event.extendedProps.reserva);
              else setModalCotizacion(info.event.extendedProps.cotizacion);
            }}
            eventDisplay="block"
            dayMaxEvents={3}
            slotMinTime="00:00:00"
            slotMaxTime="24:00:00"
            slotDuration="00:30:00"
            slotLabelInterval="01:00:00"
            scrollTime="06:00:00"
            expandRows={false}
            nowIndicator={true}
            allDaySlot={true}
            allDayText="Todo el dia"
            eventContent={(arg) => {
              const r = arg.event.extendedProps.reserva as Reserva | undefined;
              const v = arg.event.extendedProps.vehiculo as Vehiculo | undefined;
              const esCot = arg.event.extendedProps.tipo === "cotizacion";
              return (
                <div className="px-1 py-0.5 overflow-hidden" title={arg.event.title}>
                  <div className="font-bold text-white truncate" style={{ fontSize: "11px" }}>{arg.event.title}</div>
                  {arg.view.type !== "dayGridMonth" && !esCot && r ? (
                    <div className="text-white/80 truncate" style={{ fontSize: "10px" }}>
                      {v?.placa || "Sin vehiculo"} · {r.hora_servicio?.slice(0, 5)}
                    </div>
                  ) : null}
                  {esCot && arg.view.type !== "dayGridMonth" ? (
                    <div className="text-white/80 truncate" style={{ fontSize: "10px" }}>Pendiente de programar</div>
                  ) : null}
                </div>
              );
            }}
          />
        </div>

        {resHoy.length > 0 ? (
          <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b flex items-center gap-2" style={{ borderColor: "#f1f5f9" }}>
              <h2 className="text-sm font-bold text-gray-700">Servicios de hoy ({resHoy.length})</h2>
            </div>
            <div className="divide-y" style={{ borderColor: "#f1f5f9" }}>
              {resHoy.map(r => {
                const cliente  = clientes.find(c => c.id === r.cliente_id);
                const vehiculo = vehiculos.find(v => v.id === r.vehiculo_id);
                const cond     = conductores.find(c => c.id === r.conductor_id);
                const estCfg   = RESERVA_COLOR[r.estado] || RESERVA_COLOR.pendiente;
                const esFijo   = !esEventual(r);
                return (
                  <div key={r.id} className="px-5 py-3 flex items-center justify-between hover:bg-gray-50 cursor-pointer transition-colors" onClick={() => setModalReserva(r)}>
                    <div className="flex items-center gap-4">
                      <div className="text-center min-w-[50px]">
                        <div className="text-sm font-black text-gray-800">{r.hora_servicio?.slice(0, 5) || "-"}</div>
                        <div className="text-[10px] text-gray-400">hrs</div>
                      </div>
                      <div className="w-px h-8 bg-gray-200" />
                      <div>
                        <div className="font-bold text-gray-900 text-sm">{cliente?.empresa || cliente?.nombre || "Sin cliente"}</div>
                        <div className="text-xs text-gray-500">{r.origen} - {r.destino}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      {vehiculo ? <span className="text-xs font-mono font-bold text-gray-600 bg-gray-100 px-2 py-0.5 rounded">{vehiculo.placa}</span> : null}
                      {cond ? <span className="text-xs text-gray-500">{cond.nombre}</span> : null}
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: esFijo ? "#eef3f8" : "#ede9fe", color: esFijo ? "#0b315f" : "#6d28d9" }}>
                        {esFijo ? "Fijo" : "Eventual"}
                      </span>
                      <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: estCfg.badge, color: estCfg.badgeText }}>{r.estado.replace("_", " ")}</span>
                      <span className="text-xs font-bold text-green-700">{fmtSoles(Number(r.precio_cliente || 0))}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </main>
    </>
  );
}