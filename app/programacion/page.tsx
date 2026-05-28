"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Calendar, FileText, Pencil, Trash2 } from "lucide-react";
import ModalManifiesto from "@/components/programacion/ModalManifiesto";
import ModalGenerarPrograma from "@/components/programacion/ModalGenerarPrograma";
import TimelineParadasEditable from "@/components/programacion/TimelineParadasEditable";

type ParadaTP = {
  id: string; tipo: "inicio" | "intermedia" | "destino";
  nombre: string; direccion: string; lat: string; lng: string; hora: string;
};

type EstadoReserva = "pendiente" | "programada" | "confirmada" | "en_curso" | "finalizada" | "cancelada";

type Cliente            = { id: number; nombre: string; empresa?: string; tipo?: string; };
type Vehiculo           = { id: number; placa: string; categoria?: string; estado?: string; estado_operativo?: string; capacidad_pasajeros?: number; };
type Conductor          = { id: number; nombre: string; licencia?: string; vencimiento_licencia?: string; estado?: string; telefono?: string; };
type EmpresaTercerizada = { id: number; razon_social: string; ruc?: string | null; telefono?: string | null; estado: string; };
type VehiculoTercero    = { id: number; empresa_id: number; placa: string; categoria?: string | null; capacidad?: number | null; estado: string; marca?: string | null; };
type ConductorTercero   = { id: number; empresa_id: number; nombre: string; licencia?: string | null; vencimiento_licencia?: string | null; telefono?: string | null; estado: string; };
type DocumentoTercero   = { id: number; empresa_id: number; tipo: string; fecha_vencimiento?: string | null; };

type Reserva = {
  id: number; cliente_id: number | null; cotizacion_id: number | null;
  vehiculo_id: number | null; conductor_id: number | null;
  tipo: string; estado: EstadoReserva;
  fecha_servicio: string | null; hora_servicio: string | null;
  precio_cliente: number; costo_proveedor: number; margen: number;
  observaciones: string | null; created_at: string;
  tipo_asignacion: string | null;
  empresa_tercerizada_id: number | null;
  vehiculo_tercero_id: number | null;
  paradas_json: any[] | null;
  tipo_servicio_detalle: string | null;
  sincronizado_app?: boolean;
  fecha_sincronizacion?: string | null;
};

type Ocupacion = {
  reserva_id: number;
  capacidad: number | null;
  total_pasajeros: number;
  abordados: number;
  pendientes: number;
  sobrecupo: boolean;
  ocupacion_pct: number | null;
};

const ESTADO_CFG: Record<EstadoReserva, { label: string; bg: string; color: string; dot: string }> = {
  pendiente:  { label: "Pendiente",  bg: "#fef9c3", color: "#854d0e", dot: "#eab308" },
  programada: { label: "Programada", bg: "#e0f2fe", color: "#0369a1", dot: "#0284c7" },
  confirmada: { label: "Confirmada", bg: "#dcfce7", color: "#166534", dot: "#16a34a" },
  en_curso:   { label: "En curso",   bg: "#dbeafe", color: "#1d4ed8", dot: "#2563eb" },
  finalizada: { label: "Finalizada", bg: "#ede9fe", color: "#6d28d9", dot: "#7c3aed" },
  cancelada:  { label: "Cancelada",  bg: "#fee2e2", color: "#991b1b", dot: "#dc2626" },
};

const FLUJO_ESTADO: Record<EstadoReserva, string> = {
  pendiente:  "Sin asignacion",
  programada: "Asignado",
  confirmada: "Cliente confirmo",
  en_curso:   "En ejecucion",
  finalizada: "Completado",
  cancelada:  "Cancelado",
};

const FORM_VACIO = {
  fecha_servicio: "", hora_servicio: "", tipo_asignacion: "propio",
  estado: "pendiente" as EstadoReserva,
  vehiculo_id: "", conductor_id: "",
  empresa_tercerizada_id: "", vehiculo_tercero_id: "", conductor_tercero_id: "",
  costo_proveedor: "", observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function esEventual(r: Reserva): boolean {
  return r.tipo_servicio_detalle !== "transporte_personal";
}

function fmtSoles(n: number) {
  return "S/ " + n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtFecha(f: string | null) {
  if (!f) return "-";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

function Campo({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

function riesgoEmpresa(docs: DocumentoTercero[], empresaId: number): "alto" | "ok" {
  const OBLIGATORIOS = ["SOAT", "Revision Tecnica (CITV)", "Habilitacion SUTRAN", "Permiso Operacion MTC"];
  const docsEmp = docs.filter(d => d.empresa_id === empresaId);
  const vencidos = docsEmp.filter(d => OBLIGATORIOS.includes(d.tipo) && diasPara(d.fecha_vencimiento || null) !== null && diasPara(d.fecha_vencimiento || null)! < 0);
  return vencidos.length > 0 ? "alto" : "ok";
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ReservasPage() {
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [conductores,  setConductores]  = useState<Conductor[]>([]);
  const [empresasTer,  setEmpresasTer]  = useState<EmpresaTercerizada[]>([]);
  const [vehTercero,   setVehTercero]   = useState<VehiculoTercero[]>([]);
  const [condTercero,  setCondTercero]  = useState<ConductorTercero[]>([]);
  const [docsTercero,  setDocsTercero]  = useState<DocumentoTercero[]>([]);
  const [reservas,     setReservas]     = useState<Reserva[]>([]);
  const [ocupacionMap, setOcupacionMap] = useState<Record<number, Ocupacion>>({});
  const [loading,      setLoading]      = useState(false);
  const [guardando,    setGuardando]    = useState(false);
  const [paradasMap,   setParadasMap]   = useState<Record<number, any[]>>({});
  const [cargandoPar,  setCargandoPar]  = useState<Record<number, boolean>>({});
  const [pasajerosCliente, setPasajerosCliente] = useState<Record<number, any[]>>({});
  const [pasajerosAsig,    setPasajerosAsig]    = useState<Record<number, number[]>>({});
  const [cargandoPas,      setCargandoPas]      = useState<Record<number, boolean>>({});
  const [paradaSelPas,     setParadaSelPas]     = useState<Record<number, number | null>>({});
  const [guardandoPas,     setGuardandoPas]     = useState<Record<number, boolean>>({});
  const [editandoId,   setEditandoId]   = useState<number | null>(null);
  const [expandidoId,  setExpandidoId]  = useState<number | null>(null);
  const [mostrarForm,  setMostrarForm]  = useState(false);
  const [busqueda,     setBusqueda]     = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [filtroTipo,   setFiltroTipo]   = useState("todos");
  const [filtroServicio, setFiltroServicio] = useState<"todos" | "fijo" | "eventual">("todos");
  const [form, setForm] = useState(FORM_VACIO);
  const [modalReservaId,       setModalReservaId]       = useState<number | null>(null);
  const [mostrarModalPrograma, setMostrarModalPrograma] = useState(false);
  const [expandidoContrato,    setExpandidoContrato]    = useState<string | null>(null);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cargarOcupaciones = async () => {
    const { data } = await supabase.from("reservas_ocupacion").select("*");
    const map: Record<number, Ocupacion> = {};
    (data || []).forEach((o: any) => { map[o.reserva_id] = o; });
    setOcupacionMap(map);
  };

  const cargarPasajerosAsignados = async (reservaId: number, paradaId?: number) => {
    const paradas = paradasMap[reservaId] || [];
    if (paradaId) {
      const { data } = await supabase.from("pasajeros_parada").select("pasajero_id").eq("parada_id", paradaId);
      setPasajerosAsig(prev => ({ ...prev, [reservaId]: (data || []).map((p: any) => p.pasajero_id) }));
    } else if (paradas.length > 0) {
      const { data } = await supabase.from("pasajeros_parada").select("pasajero_id").in("parada_id", paradas.map((p: any) => p.id));
      const unique = [...new Set((data || []).map((p: any) => p.pasajero_id))];
      setPasajerosAsig(prev => ({ ...prev, [reservaId]: unique as number[] }));
    }
  };

  const guardarPasajerosEnParada = async (reservaId: number, paradaId: number, seleccionados: number[]) => {
    setGuardandoPas(prev => ({ ...prev, [reservaId]: true }));
    await supabase.from("pasajeros_parada").delete().eq("parada_id", paradaId);
    if (seleccionados.length > 0) {
      await supabase.from("pasajeros_parada").insert(
        seleccionados.map(pid => ({ parada_id: paradaId, pasajero_id: pid, estado_abordaje: "Pendiente" }))
      );
    }
    setGuardandoPas(prev => ({ ...prev, [reservaId]: false }));
    await cargarPasajerosAsignados(reservaId, paradaId);
    await cargarOcupaciones();
    alert(seleccionados.length + " pasajeros asignados");
  };

  const crearParadasDesdeJSON = async (reservaId: number, paradasJSON: any[]) => {
    if (!paradasJSON || paradasJSON.length === 0) return;
    const { data: ex } = await supabase.from("paradas").select("id").eq("reserva_id", reservaId);
    if (ex && ex.length > 0) {
      if (!confirm("Ya tiene paradas. Reemplazarlas?")) return;
      await supabase.from("paradas").delete().eq("reserva_id", reservaId);
    }
    const todas = [...paradasJSON.filter((p: any) => p.tipo === "inicio"), ...paradasJSON.filter((p: any) => p.tipo === "intermedia"), ...paradasJSON.filter((p: any) => p.tipo === "destino")];
    await supabase.from("paradas").insert(todas.map((p: any, i: number) => ({
      reserva_id: reservaId, orden: i + 1, nombre: p.nombre, direccion: p.direccion || null,
      lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
      hora_estimada: p.hora || null, estado: "pendiente",
    })));
    const { data: nuevas } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");
    setParadasMap(prev => ({ ...prev, [reservaId]: nuevas || [] }));
    alert(todas.length + " paradas creadas correctamente");
  };

  const cargarParadasReserva = async (reservaId: number) => {
    setCargandoPar(prev => ({ ...prev, [reservaId]: true }));
    const { data } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");
    setParadasMap(prev => ({ ...prev, [reservaId]: data || [] }));
    setCargandoPar(prev => ({ ...prev, [reservaId]: false }));
  };

  const cargarPasajerosCliente = async (reservaId: number, clienteId: number | null) => {
    if (!clienteId) { setPasajerosCliente(prev => ({ ...prev, [reservaId]: [] })); return; }
    setCargandoPas(prev => ({ ...prev, [reservaId]: true }));
    const { data } = await supabase.from("pasajeros").select("*").eq("cliente_id", clienteId).order("nombre");
    setPasajerosCliente(prev => ({ ...prev, [reservaId]: data || [] }));
    setCargandoPas(prev => ({ ...prev, [reservaId]: false }));
    await cargarPasajerosAsignados(reservaId);
  };

  const cargarDatos = async () => {
    setLoading(true);
    const [clRes, vRes, cRes, etRes, vtRes, ctRes, dtRes, rRes] = await Promise.all([
      supabase.from("clientes").select("id,nombre,empresa,tipo").order("nombre"),
      supabase.from("vehiculos").select("id,placa,categoria,estado,estado_operativo,capacidad_pasajeros").order("placa"),
      supabase.from("conductores").select("id,nombre,licencia,vencimiento_licencia,estado,telefono").order("nombre"),
      supabase.from("empresas_tercerizadas").select("id,razon_social,ruc,telefono,estado").order("razon_social"),
      supabase.from("vehiculos_tercero").select("id,empresa_id,placa,categoria,capacidad,estado,marca").order("placa"),
      supabase.from("conductores_tercero").select("id,empresa_id,nombre,licencia,vencimiento_licencia,telefono,estado").order("nombre"),
      supabase.from("documentos_tercero").select("id,empresa_id,tipo,fecha_vencimiento"),
      supabase.from("reservas").select("*").order("fecha_servicio", { ascending: false }),
    ]);
    setClientes(clRes.data     || []);
    setVehiculos(vRes.data     || []);
    setConductores(cRes.data   || []);
    setEmpresasTer(etRes.data  || []);
    setVehTercero(vtRes.data   || []);
    setCondTercero(ctRes.data  || []);
    setDocsTercero(dtRes.data  || []);
    setReservas(rRes.data      || []);
    await cargarOcupaciones();
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const nombreCliente    = (id: number | null) => { const c = clientes.find(c => c.id === id); return c ? (c.empresa || c.nombre) : "Sin cliente"; };
  const nombreVehiculo   = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "-";
  const nombreConductor  = (id: number | null) => conductores.find(c => c.id === id)?.nombre || "-";
  const nombreEmpTer     = (id: number | null) => empresasTer.find(e => e.id === id)?.razon_social || "-";
  const nombreVehTercero = (id: number | null) => vehTercero.find(v => v.id === id)?.placa || "-";

  const vehiculosAptos         = vehiculos.filter(v => v.estado === "disponible" && (v.estado_operativo === "apto" || !v.estado_operativo));
  const conductoresDisponibles = conductores.filter(c => c.estado !== "no_disponible" && (!c.vencimiento_licencia || new Date(c.vencimiento_licencia) >= new Date()));

  const empSelId     = form.empresa_tercerizada_id ? Number(form.empresa_tercerizada_id) : null;
  const vehEmpSel    = empSelId ? vehTercero.filter(v => v.empresa_id === empSelId && v.estado === "disponible") : [];
  const condEmpSel   = empSelId ? condTercero.filter(c => c.empresa_id === empSelId) : [];
  const riesgoEmpSel = empSelId ? riesgoEmpresa(docsTercero, empSelId) : "ok";

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const editarReserva = (r: Reserva) => {
    setForm({
      fecha_servicio:         r.fecha_servicio            || "",
      hora_servicio:          r.hora_servicio?.slice(0,5) || "",
      tipo_asignacion:        r.tipo_asignacion            || "propio",
      estado:                 r.estado                    || "pendiente",
      vehiculo_id:            r.vehiculo_id               ? String(r.vehiculo_id)               : "",
      conductor_id:           r.conductor_id              ? String(r.conductor_id)              : "",
      empresa_tercerizada_id: r.empresa_tercerizada_id    ? String(r.empresa_tercerizada_id)    : "",
      vehiculo_tercero_id:    r.vehiculo_tercero_id       ? String(r.vehiculo_tercero_id)       : "",
      conductor_tercero_id:   "",
      costo_proveedor:        r.costo_proveedor           ? String(r.costo_proveedor)           : "",
      observaciones:          r.observaciones             || "",
    });
    setEditandoId(r.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const guardarReserva = async () => {
    if (!editandoId) return;
    if (!form.fecha_servicio || !form.hora_servicio) { alert("Ingresa fecha y hora"); return; }
    if (form.tipo_asignacion === "propio" && (!form.vehiculo_id || !form.conductor_id)) {
      alert("Selecciona vehiculo y conductor propios"); return;
    }
    if (form.tipo_asignacion === "tercerizado" && !form.empresa_tercerizada_id) {
      alert("Selecciona la empresa tercerizada"); return;
    }
    if (form.tipo_asignacion === "tercerizado" && riesgoEmpSel === "alto") {
      const ok = confirm("ALERTA: Esta empresa tiene documentos OBLIGATORIOS vencidos. Continuar de todas formas?");
      if (!ok) return;
    }

    setGuardando(true);
    const costo = form.tipo_asignacion === "tercerizado" ? Number(form.costo_proveedor || 0) : 0;

    let nuevoEstado = form.estado;
    const reservaActual = reservas.find(r => r.id === editandoId);
    if (reservaActual?.estado === "pendiente") {
      if (form.tipo_asignacion === "propio" && form.vehiculo_id && form.conductor_id) nuevoEstado = "programada";
      if (form.tipo_asignacion === "tercerizado" && form.empresa_tercerizada_id) nuevoEstado = "programada";
    }
    if (form.estado !== "pendiente") nuevoEstado = form.estado;

    const { error } = await supabase.from("reservas").update({
      fecha_servicio:         form.fecha_servicio,
      hora_servicio:          form.hora_servicio,
      tipo:                   form.tipo_asignacion === "propio" ? "propia" : "tercerizada",
      tipo_asignacion:        form.tipo_asignacion,
      estado:                 nuevoEstado,
      vehiculo_id:            form.tipo_asignacion === "propio" ? Number(form.vehiculo_id) : null,
      conductor_id:           form.tipo_asignacion === "propio" ? Number(form.conductor_id) : null,
      empresa_tercerizada_id: form.tipo_asignacion === "tercerizado" ? Number(form.empresa_tercerizada_id) : null,
      vehiculo_tercero_id:    form.tipo_asignacion === "tercerizado" && form.vehiculo_tercero_id ? Number(form.vehiculo_tercero_id) : null,
      costo_proveedor:        costo,
      observaciones:          form.observaciones.trim() || null,
    }).eq("id", editandoId);

    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const eliminarReserva = async (id: number) => {
    if (!confirm("Eliminar esta reserva?")) return;
    await supabase.from("reservas").delete().eq("id", id);
    cargarDatos();
  };

  const cambiarEstadoRapido = async (id: number, estado: EstadoReserva) => {
    await supabase.from("reservas").update({ estado }).eq("id", id);
    setReservas(prev => prev.map(r => r.id === id ? { ...r, estado } : r));
  };

  const capacidadDe = (r: Reserva): number | null => {
    if (r.tipo === "tercerizada") return vehTercero.find(v => v.id === r.vehiculo_tercero_id)?.capacidad ?? null;
    return vehiculos.find(v => v.id === r.vehiculo_id)?.capacidad_pasajeros ?? null;
  };

  const hoy          = new Date().toISOString().split("T")[0];
  const totalRes     = reservas.length;
  const pendientes   = reservas.filter(r => r.estado === "pendiente").length;
  const programadas  = reservas.filter(r => r.estado === "programada").length;
  const confirmadas  = reservas.filter(r => r.estado === "confirmada").length;
  const enCurso      = reservas.filter(r => r.estado === "en_curso").length;
  const hoyCount     = reservas.filter(r => r.fecha_servicio === hoy).length;
  const ventas       = reservas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const costos       = reservas.reduce((s, r) => s + Number(r.costo_proveedor || 0), 0);
  const margenTotal  = reservas.reduce((s, r) => s + Number(r.margen || 0), 0);
  const conSobrecupo = Object.values(ocupacionMap).filter(o => o.sobrecupo).length;
  const sincronizadas = reservas.filter(r => r.sincronizado_app).length;

  const filtradas = useMemo(() => reservas.filter(r => {
    const q   = busqueda.toLowerCase();
    const txt = (r.id + " " + nombreCliente(r.cliente_id) + " " + ((r as any).origen || "") + " " + ((r as any).destino || "")).toLowerCase();
    return txt.includes(q) &&
      (filtroEstado === "todos" || r.estado === filtroEstado) &&
      (filtroTipo === "todos" || r.tipo === filtroTipo) &&
      (filtroServicio === "todos" || (filtroServicio === "fijo" ? !esEventual(r) : esEventual(r)));
  }), [reservas, busqueda, filtroEstado, filtroTipo, filtroServicio, clientes]);

  // Agrupación de servicios fijos por contrato (cotizacion_id)
  const gruposContratos = useMemo(() => {
    if (filtroServicio !== "fijo") return null;
    const grupos = new Map<string, Reserva[]>();
    filtradas.forEach(r => {
      const key = r.cotizacion_id != null ? String(r.cotizacion_id) : "sin_cotizacion";
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(r);
    });
    return Array.from(grupos.entries()).map(([clave, filas]) => {
      const sorted = [...filas].sort((a, b) => (a.fecha_servicio || "").localeCompare(b.fecha_servicio || ""));
      const proxima = sorted.find(r => r.fecha_servicio && r.fecha_servicio >= hoy) || sorted[0];
      return { clave, cotId: filas[0].cotizacion_id, filas: sorted, proxima };
    });
  }, [filtradas, filtroServicio, hoy]);

  const reservaModal = modalReservaId ? reservas.find(r => r.id === modalReservaId) : null;

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {mostrarModalPrograma && (
        <ModalGenerarPrograma
          clientes={clientes}
          onClose={() => setMostrarModalPrograma(false)}
          onGenerado={() => { cargarDatos(); setFiltroServicio("fijo"); }}
        />
      )}

      {reservaModal && (
        <ModalManifiesto
          reservaId={reservaModal.id}
          clienteId={reservaModal.cliente_id}
          capacidad={capacidadDe(reservaModal)}
          sincronizadoApp={!!reservaModal.sincronizado_app}
          fechaSincronizacion={reservaModal.fecha_sincronizacion || null}
          origen={(reservaModal as any).origen || null}
          destino={(reservaModal as any).destino || null}
          puntoRetorno={(reservaModal as any).punto_retorno || null}
          paradasJson={reservaModal.paradas_json || null}
          onClose={() => setModalReservaId(null)}
          onChange={async () => {
            await cargarOcupaciones();
            const { data } = await supabase.from("reservas").select("sincronizado_app, fecha_sincronizacion").eq("id", reservaModal.id).single();
            if (data) setReservas(prev => prev.map(r => r.id === reservaModal.id ? { ...r, ...data } : r));
          }}
        />
      )}

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Reservas</h1>
          <p className="text-gray-400 text-sm mt-1">
            Programacion de servicios · flota propia o empresa tercerizada
            {hoyCount > 0 && <span className="ml-2 font-bold text-[#0b315f]">· {hoyCount} servicio(s) hoy</span>}
            {conSobrecupo > 0 && <span className="ml-2 font-bold text-red-600">· {conSobrecupo} con sobrecupo</span>}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setMostrarModalPrograma(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm text-white transition-colors hover:opacity-90"
            style={{ background: "#0b315f" }}
          >
            <Calendar size={15} /> Programa fijo
          </button>
          {editandoId && (
            <button onClick={limpiar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cancelar edicion
            </button>
          )}
        </div>
      </div>

      {/* FLUJO DE ESTADOS */}
      <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">Flujo de estados</p>
        <div className="flex items-center gap-1 flex-wrap">
          {(Object.entries(FLUJO_ESTADO) as [EstadoReserva, string][]).map(([est, desc], i, arr) => {
            const cfg   = ESTADO_CFG[est];
            const count = reservas.filter(r => r.estado === est).length;
            return (
              <React.Fragment key={est}>
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: cfg.bg, color: cfg.color }}>
                    <div className="w-2 h-2 rounded-full" style={{ background: cfg.dot }} />
                    {cfg.label}
                    {count > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-black text-white" style={{ background: cfg.dot }}>{count}</span>}
                  </div>
                  <p className="text-[9px] text-gray-400 mt-1 text-center max-w-[80px]">{desc}</p>
                </div>
                {i < arr.length - 1 && <span className="text-gray-300 text-lg mb-4">-</span>}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total",         valor: totalRes,     color: "#0b315f", bg: "#eef3f8" },
          { label: "Pendientes",    valor: pendientes,   color: "#854d0e", bg: "#fef9c3" },
          { label: "Programadas",   valor: programadas,  color: "#0369a1", bg: "#e0f2fe" },
          { label: "Confirmadas",   valor: confirmadas,  color: "#166534", bg: "#dcfce7" },
          { label: "En curso",      valor: enCurso,      color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Sincronizadas", valor: sincronizadas,color: "#0f766e", bg: "#f0fdfa" },
          { label: "Sobrecupo",     valor: conSobrecupo, color: "#991b1b", bg: "#fee2e2" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* KPIs financieros */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { label: "Ventas reservas",  valor: fmtSoles(ventas),      color: "#166534", bg: "#dcfce7" },
          { label: "Costos proveedor", valor: fmtSoles(costos),      color: "#991b1b", bg: "#fee2e2" },
          { label: "Margen total",     valor: fmtSoles(margenTotal), color: "#1d4ed8", bg: "#dbeafe" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORMULARIO PROGRAMACION */}
      {mostrarForm && editandoId && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>P</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Programar reserva #{editandoId}</h2>
              <p className="text-xs text-gray-400">
                {(() => { const r = reservas.find(r => r.id === editandoId); return r ? ((r as any).origen || "") + " -> " + ((r as any).destino || "") + " · " + fmtSoles(Number(r.precio_cliente || 0)) : ""; })()}
              </p>
            </div>
          </div>

          <div className="rounded-xl px-4 py-3 text-xs" style={{ background: "#e0f2fe", color: "#0369a1" }}>
            Al asignar recursos el estado pasara automaticamente a Programada. Para tercerizado el sistema verificara que la empresa no tenga documentos vencidos.
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del servicio</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Fecha *">
                <input type="date" className={inputCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")} />
              </Campo>
              <Campo label="Hora *">
                <input type="time" className={inputCls()} value={form.hora_servicio} onChange={f("hora_servicio")} />
              </Campo>
              <Campo label="Tipo de asignacion">
                <select className={inputCls()} value={form.tipo_asignacion} onChange={e => setForm(p => ({ ...p, tipo_asignacion: e.target.value, vehiculo_id: "", conductor_id: "", empresa_tercerizada_id: "", vehiculo_tercero_id: "", conductor_tercero_id: "", costo_proveedor: "" }))}>
                  <option value="propio">Flota propia</option>
                  <option value="tercerizado">Empresa tercerizada</option>
                </select>
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="pendiente">Pendiente</option>
                  <option value="programada">Programada</option>
                  <option value="confirmada">Confirmada</option>
                  <option value="en_curso">En curso</option>
                  <option value="finalizada">Finalizada</option>
                  <option value="cancelada">Cancelada</option>
                </select>
              </Campo>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              {form.tipo_asignacion === "propio" ? "Asignacion de flota propia" : "Empresa tercerizada"}
            </p>

            {form.tipo_asignacion === "propio" ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label={"Vehiculo (" + vehiculosAptos.length + " aptos) *"}>
                  <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                    <option value="">Seleccionar vehiculo</option>
                    {vehiculosAptos.map(v => (
                      <option key={v.id} value={v.id}>{v.placa} · {v.categoria}{v.capacidad_pasajeros ? " · " + v.capacidad_pasajeros + " pax" : ""}</option>
                    ))}
                  </select>
                </Campo>
                <Campo label={"Conductor (" + conductoresDisponibles.length + " disponibles) *"}>
                  <select className={inputCls()} value={form.conductor_id} onChange={f("conductor_id")}>
                    <option value="">Seleccionar conductor</option>
                    {conductoresDisponibles.map(c => (
                      <option key={c.id} value={c.id}>{c.nombre}{c.licencia ? " · " + c.licencia : ""}</option>
                    ))}
                  </select>
                </Campo>
                <Campo label="Observaciones">
                  <input className={inputCls()} placeholder="Notas del servicio..." value={form.observaciones} onChange={f("observaciones")} />
                </Campo>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Campo label="Empresa tercerizada *" span={2}>
                    <select className={inputCls()} value={form.empresa_tercerizada_id} onChange={f("empresa_tercerizada_id")}>
                      <option value="">Seleccionar empresa</option>
                      {empresasTer.filter(e => e.estado === "activo").map(e => (
                        <option key={e.id} value={e.id}>
                          {riesgoEmpresa(docsTercero, e.id) === "alto" ? "ALERTA " : ""}
                          {e.razon_social}{e.ruc ? " · RUC " + e.ruc : ""}
                        </option>
                      ))}
                    </select>
                  </Campo>
                  <Campo label="Costo S/ *">
                    <input type="number" min="0" className={inputCls()} placeholder="0.00" value={form.costo_proveedor} onChange={f("costo_proveedor")} />
                    {form.costo_proveedor && (() => {
                      const r = reservas.find(r => r.id === editandoId);
                      const margen = Number(r?.precio_cliente || 0) - Number(form.costo_proveedor);
                      return <p className="text-[10px] mt-1 font-bold" style={{ color: margen >= 0 ? "#166534" : "#dc2626" }}>Margen: {fmtSoles(margen)}</p>;
                    })()}
                  </Campo>
                </div>

                {empSelId && riesgoEmpSel === "alto" && (
                  <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800">
                    ATENCION: Esta empresa tiene documentos obligatorios vencidos. Revisar modulo de Tercerizadas antes de confirmar.
                  </div>
                )}

                {empSelId && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Campo label={"Vehiculo del tercero (" + vehEmpSel.length + " disponibles)"}>
                      <select className={inputCls()} value={form.vehiculo_tercero_id} onChange={f("vehiculo_tercero_id")}>
                        <option value="">Sin especificar</option>
                        {vehEmpSel.map(v => (
                          <option key={v.id} value={v.id}>{v.placa} · {v.categoria}{v.capacidad ? " · " + v.capacidad + " pax" : ""}</option>
                        ))}
                      </select>
                    </Campo>
                    <Campo label={"Conductor del tercero (" + condEmpSel.length + ")"}>
                      <select className={inputCls()} value={form.conductor_tercero_id} onChange={f("conductor_tercero_id")}>
                        <option value="">Sin especificar</option>
                        {condEmpSel.map(c => {
                          const licOk = !c.vencimiento_licencia || diasPara(c.vencimiento_licencia)! >= 0;
                          return <option key={c.id} value={c.id}>{!licOk ? "VENC. " : ""}{c.nombre}{c.licencia ? " · " + c.licencia : ""}</option>;
                        })}
                      </select>
                    </Campo>
                    <Campo label="Observaciones">
                      <input className={inputCls()} placeholder="Notas del servicio..." value={form.observaciones} onChange={f("observaciones")} />
                    </Campo>
                  </div>
                )}

                {empSelId && (() => {
                  const emp = empresasTer.find(e => e.id === empSelId);
                  if (!emp) return null;
                  return (
                    <div className="rounded-xl px-4 py-3 text-xs bg-gray-50 flex gap-6 flex-wrap">
                      <div><span className="text-gray-400">Empresa:</span> <b>{emp.razon_social}</b></div>
                      {emp.telefono && <div><span className="text-gray-400">Tel:</span> {emp.telefono}</div>}
                      <div><span className="text-gray-400">Flota disponible:</span> <b>{vehEmpSel.length} vehiculos</b></div>
                      <div><span className="text-gray-400">Conductores:</span> <b>{condEmpSel.length}</b></div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button onClick={guardarReserva} disabled={guardando} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : "Guardar programacion"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none" placeholder="Buscar por cliente, ruta o ID..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
          <option value="todos">Todos los estados</option>
          {Object.entries(ESTADO_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
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
                background: filtroServicio === t ? "white" : "transparent",
                color: filtroServicio === t ? "#0b315f" : "#9ca3af",
                boxShadow: filtroServicio === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
              }}
            >
              {t === "todos" ? "Todos" : t === "fijo" ? "Fijos" : "Eventuales"}
            </button>
          ))}
        </div>

        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
          {filtradas.length} resultado{filtradas.length !== 1 ? "s" : ""}
        </div>
      </section>

      {/* VISTA AGRUPADA POR CONTRATO (solo cuando filtro = Fijos) */}
      {filtroServicio === "fijo" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          {/* Sub-encabezado */}
          <div className="px-5 py-3 border-b flex items-center justify-between" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Contratos activos · {gruposContratos?.length ?? 0} contrato(s) · {filtradas.length} servicio(s)
            </p>
            <p className="text-[10px] text-gray-400">Haz clic en un contrato para ver sus fechas</p>
          </div>

          {loading ? (
            <div className="p-10 text-center text-gray-400 flex items-center justify-center gap-2">
              <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
              Cargando...
            </div>
          ) : !gruposContratos || gruposContratos.length === 0 ? (
            <div className="p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">📋</p>
              <p className="font-medium">No hay servicios fijos</p>
              <p className="text-sm mt-1">Usa el botón <b>Programa fijo</b> para generar servicios desde una cotización.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {gruposContratos.map(({ clave, cotId, filas, proxima }) => {
                const r0           = filas[0];
                const expandido    = expandidoContrato === clave;
                const pendientesG  = filas.filter(r => r.estado === "pendiente").length;
                const programadasG = filas.filter(r => r.estado === "programada").length;
                const finalizadasG = filas.filter(r => r.estado === "finalizada").length;
                const totalIngreso = filas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);

                return (
                  <div key={clave} className="border-t" style={{ borderColor: "#f1f5f9" }}>
                    {/* Fila resumen del contrato */}
                    <div
                      className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
                      onClick={() => setExpandidoContrato(expandido ? null : clave)}
                    >
                      <span className="text-gray-300 text-xs w-3 shrink-0">{expandido ? "▼" : "▶"}</span>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {cotId && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md" style={{ background: "#eef3f8", color: "#0b315f" }}>
                              Cot.#{cotId}
                            </span>
                          )}
                          <span className="font-bold text-gray-800">{nombreCliente(r0.cliente_id)}</span>
                          <span className="text-xs text-gray-400 truncate max-w-[200px]">
                            {(r0 as any).origen || "-"} → {(r0 as any).destino || "-"}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                          <span className="text-[11px] text-gray-500">{filas.length} servicios en total</span>
                          {proxima && (
                            <span className="text-[11px] text-gray-500">
                              Próximo: <b>{fmtFecha(proxima.fecha_servicio)}</b>
                            </span>
                          )}
                          {pendientesG > 0  && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: "#fef9c3", color: "#854d0e" }}>{pendientesG} pendientes</span>}
                          {programadasG > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: "#e0f2fe", color: "#0369a1" }}>{programadasG} programadas</span>}
                          {finalizadasG > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: "#ede9fe", color: "#6d28d9" }}>{finalizadasG} finalizadas</span>}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="font-bold text-gray-800 text-sm">{fmtSoles(Number(r0.precio_cliente || 0))}/día</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">
                          {fmtSoles(totalIngreso)} ingreso total
                        </div>
                      </div>
                    </div>

                    {/* Sub-tabla de fechas */}
                    {expandido && (
                      <div style={{ background: "#f8fafc", borderTop: "1px solid #e2e8f0" }}>
                        <table className="w-full text-xs">
                          <thead>
                            <tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                              {["Fecha", "Día", "Hora", "Estado", "Recurso", "Ingreso", "Acciones"].map(h => (
                                <th key={h} className="px-4 py-2 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {filas.map(r => {
                              const estCfg   = ESTADO_CFG[r.estado] || ESTADO_CFG.pendiente;
                              const esTer    = r.tipo === "tercerizada";
                              const esHoyR   = r.fecha_servicio === hoy;
                              const diaSem   = r.fecha_servicio
                                ? new Date(r.fecha_servicio + "T12:00:00").toLocaleDateString("es-PE", { weekday: "short" })
                                : "-";
                              return (
                                <tr key={r.id} className="border-t hover:bg-white transition-colors" style={{ borderColor: "#e2e8f0" }}>
                                  <td className="px-4 py-2.5">
                                    <span className="font-medium text-gray-700">{fmtFecha(r.fecha_servicio)}</span>
                                    {esHoyR && <span className="ml-1.5 text-[9px] font-bold text-orange-500">HOY</span>}
                                  </td>
                                  <td className="px-4 py-2.5 capitalize text-gray-500">{diaSem}</td>
                                  <td className="px-4 py-2.5 text-gray-500">{r.hora_servicio?.slice(0,5) || "-"}</td>
                                  <td className="px-4 py-2.5">
                                    <select
                                      value={r.estado}
                                      onChange={e => cambiarEstadoRapido(r.id, e.target.value as EstadoReserva)}
                                      className="text-[11px] font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                                      style={{ background: estCfg.bg, color: estCfg.color }}
                                    >
                                      {Object.entries(ESTADO_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                                    </select>
                                  </td>
                                  <td className="px-4 py-2.5 text-gray-600 max-w-[160px]">
                                    <div className="truncate">
                                      {esTer
                                        ? nombreEmpTer(r.empresa_tercerizada_id)
                                        : (nombreVehiculo(r.vehiculo_id) !== "-" ? nombreVehiculo(r.vehiculo_id) + " · " + nombreConductor(r.conductor_id) : "Sin asignar")}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 font-bold text-gray-700">{fmtSoles(Number(r.precio_cliente || 0))}</td>
                                  <td className="px-4 py-2.5">
                                    <div className="flex gap-1.5">
                                      <button
                                        onClick={() => setModalReservaId(r.id)}
                                        className="flex items-center gap-1 bg-purple-50 hover:bg-purple-100 text-purple-700 text-[10px] font-bold px-2 py-1 rounded-lg transition-colors"
                                      >
                                        <FileText size={11} /> Pax
                                      </button>
                                      <button
                                        onClick={() => editarReserva(r)}
                                        className="flex items-center gap-1 bg-gray-50 hover:bg-gray-100 text-gray-600 text-[10px] font-bold px-2 py-1 rounded-lg transition-colors border border-gray-200"
                                      >
                                        <Pencil size={11} /> Editar
                                      </button>
                                      <button
                                        onClick={() => eliminarReserva(r.id)}
                                        className="flex items-center gap-1 bg-red-50 hover:bg-red-100 text-red-600 text-[10px] font-bold px-2 py-1 rounded-lg transition-colors"
                                      >
                                        <Trash2 size={11} />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {filtradas.length > 0 && (
            <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
              <span>{filtradas.length} servicios en {gruposContratos?.length ?? 0} contrato(s)</span>
              <span>AFA ERP · Operaciones</span>
            </div>
          )}
        </section>
      )}

      {/* TABLA PLANA (Todos / Eventuales) */}
      {filtroServicio !== "fijo" && (
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["ID", "Cliente", "Ruta", "Fecha", "Asignacion", "Recurso", "Ocupacion", "Sync", "Precio", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={12} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                    Cargando...
                  </div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={12} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🎫</p>
                  <p className="font-medium">No hay reservas</p>
                </td></tr>
              ) : filtradas.map(r => {
                const estCfg    = ESTADO_CFG[r.estado] || ESTADO_CFG.pendiente;
                const expandido = expandidoId === r.id;
                const margen    = Number(r.margen || 0);
                const dias      = diasPara(r.fecha_servicio);
                const esHoy     = r.fecha_servicio === hoy;
                const esTer     = r.tipo === "tercerizada";
                const riesgo    = esTer && r.empresa_tercerizada_id ? riesgoEmpresa(docsTercero, r.empresa_tercerizada_id) : "ok";
                const ocup      = ocupacionMap[r.id];
                const cap       = capacidadDe(r);
                const totalPax  = ocup?.total_pasajeros || 0;
                const sobrecupo = ocup?.sobrecupo || false;
                const pctOcup   = ocup?.ocupacion_pct;
                const esFijo    = !esEventual(r);

                let ocupBg = "#f8fafc", ocupColor = "#475569";
                if (sobrecupo) { ocupBg = "#fee2e2"; ocupColor = "#991b1b"; }
                else if (cap !== null && totalPax > 0 && totalPax >= cap * 0.9) { ocupBg = "#fef3c7"; ocupColor = "#92400e"; }
                else if (cap !== null && totalPax > 0) { ocupBg = "#dcfce7"; ocupColor = "#166534"; }

                return (
                  <React.Fragment key={r.id}>
                    <tr
                      className={"border-t transition-colors cursor-pointer " + (editandoId === r.id ? "bg-blue-50" : sobrecupo ? "bg-red-50/40" : "hover:bg-gray-50")}
                      style={{ borderColor: "#f1f5f9", boxShadow: sobrecupo ? "inset 3px 0 0 #dc2626" : undefined }}
                      onClick={() => {
                        const nId = expandido ? null : r.id;
                        setExpandidoId(nId);
                        if (nId) { cargarParadasReserva(nId); cargarPasajerosCliente(nId, r.cliente_id); }
                      }}
                    >
                      <td className="p-3 text-gray-300 text-xs">{expandido ? "v" : ">"}</td>

                      <td className="p-3">
                        <span className="font-black font-mono text-[#0b315f]">#{r.id}</span>
                        {esHoy && <div className="text-[9px] font-bold text-orange-500">HOY</div>}
                        {riesgo === "alto" && <div className="text-[9px] font-bold text-red-600">DOC VENC.</div>}
                        {sobrecupo && <div className="text-[9px] font-bold text-red-600">SOBRECUPO</div>}
                        <div className="mt-0.5">
                          <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{ background: esFijo ? "#eef3f8" : "#ede9fe", color: esFijo ? "#0b315f" : "#6d28d9" }}>
                            {esFijo ? "Fijo" : "Eventual"}
                          </span>
                        </div>
                      </td>

                      <td className="p-3 font-bold text-gray-800 max-w-[120px]">
                        <div className="truncate">{nombreCliente(r.cliente_id)}</div>
                      </td>

                      <td className="p-3 text-gray-600 max-w-[160px]">
                        <div className="truncate text-xs">{(r as any).origen || "-"} - {(r as any).destino || "-"}</div>
                      </td>

                      <td className="p-3 text-xs">
                        <div className="text-gray-700 font-medium">{fmtFecha(r.fecha_servicio)}</div>
                        <div className="text-gray-400">{r.hora_servicio?.slice(0,5) || "-"}</div>
                        {dias !== null && dias >= 0 && dias <= 3 && !esHoy && (
                          <div className="text-[9px] font-bold text-amber-600">En {dias}d</div>
                        )}
                      </td>

                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={esTer ? { background: "#ede9fe", color: "#6d28d9" } : { background: "#dbeafe", color: "#1d4ed8" }}>
                          {esTer ? "Tercerizado" : "Propio"}
                        </span>
                      </td>

                      <td className="p-3 text-xs">
                        {esTer ? (
                          <div>
                            <div className="font-bold text-gray-800 truncate max-w-[120px]">{nombreEmpTer(r.empresa_tercerizada_id)}</div>
                            {r.vehiculo_tercero_id && <div className="text-gray-400 font-mono">{nombreVehTercero(r.vehiculo_tercero_id)}</div>}
                          </div>
                        ) : (
                          <div>
                            <div className="font-bold text-gray-800">{nombreVehiculo(r.vehiculo_id)}</div>
                            <div className="text-gray-400">{nombreConductor(r.conductor_id)}</div>
                          </div>
                        )}
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => setModalReservaId(r.id)}
                          className="group flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition-transform hover:scale-105"
                          style={{ background: ocupBg }}
                        >
                          <span className="font-black text-xs leading-tight" style={{ color: ocupColor }}>
                            {totalPax}{cap !== null ? "/" + cap : ""}
                            {sobrecupo ? " (!)" : ""}
                          </span>
                          <span className="text-[9px] font-bold uppercase tracking-wide opacity-70" style={{ color: ocupColor }}>
                            {pctOcup !== null && pctOcup !== undefined ? pctOcup + "%" : "Ver pax"}
                          </span>
                        </button>
                      </td>

                      <td className="p-3 text-center">
                        {r.sincronizado_app ? (
                          <div className="inline-flex flex-col items-center" title={r.fecha_sincronizacion ? "Sincronizado: " + new Date(r.fecha_sincronizacion).toLocaleString("es-PE") : ""}>
                            <span className="text-base">S</span>
                            <span className="text-[8px] font-bold text-green-700 uppercase tracking-wide">Sync</span>
                          </div>
                        ) : (
                          <div className="inline-flex flex-col items-center opacity-60">
                            <span className="text-base">II</span>
                            <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wide">Pend.</span>
                          </div>
                        )}
                      </td>

                      <td className="p-3 font-bold text-gray-800 text-xs">{fmtSoles(Number(r.precio_cliente || 0))}</td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <select
                          value={r.estado}
                          onChange={e => cambiarEstadoRapido(r.id, e.target.value as EstadoReserva)}
                          className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                          style={{ background: estCfg.bg, color: estCfg.color }}
                        >
                          {Object.entries(ESTADO_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1.5 flex-wrap">
                          <button onClick={() => setModalReservaId(r.id)} className="flex items-center gap-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
                            <FileText size={13} /> Manifiesto
                          </button>
                          <button onClick={() => editarReserva(r)} className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold px-3 py-2 rounded-xl transition-colors border border-gray-200">
                            <Pencil size={13} /> Editar
                          </button>
                          <button onClick={() => eliminarReserva(r.id)} className="flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
                            <Trash2 size={13} /> Eliminar
                          </button>
                        </div>
                      </td>
                    </tr>

                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={12} className="px-6 py-5">
                          {(() => {
                            const paradasR = paradasMap[r.id] || [];
                            const tieneJSON = r.paradas_json && r.paradas_json.length > 0;
                            return (
                              <div className="mb-5">
                                <div className="flex items-center justify-between mb-3">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                    Paradas del recorrido ({cargandoPar[r.id] ? "..." : paradasR.length})
                                  </p>
                                  <div className="flex gap-2">
                                    {tieneJSON && paradasR.length === 0 && (
                                      <button onClick={() => crearParadasDesdeJSON(r.id, r.paradas_json!)} className="text-xs font-bold px-3 py-1.5 rounded-lg text-white" style={{ background: "#be185d" }}>
                                        Crear desde cotizacion ({r.paradas_json!.length} paradas)
                                      </button>
                                    )}
                                    <button onClick={() => setModalReservaId(r.id)} className="text-xs font-bold px-3 py-1.5 rounded-lg border hover:bg-blue-50" style={{ borderColor: "#0b315f", color: "#0b315f" }}>
                                      Manifiesto completo
                                    </button>
                                  </div>
                                </div>

                                {paradasR.length === 0 ? (
                                  <div className="rounded-xl border-2 border-dashed p-4 text-center text-xs text-gray-400">
                                    {tieneJSON
                                      ? <span>Tiene {r.paradas_json!.length} paradas en la cotizacion. Haz clic en Crear desde cotizacion.</span>
                                      : "Sin paradas configuradas. Agregalas desde Pasajeros o el modal de manifiesto."}
                                  </div>
                                ) : (
                                  <TimelineParadasEditable
                                    reservaId={r.id}
                                    paradas={paradasMap[r.id] || []}
                                    onChange={() => cargarParadasReserva(r.id)}
                                    compacto={true}
                                  />
                                )}
                              </div>
                            );
                          })()}

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs border-t pt-4" style={{ borderColor: "#e2e8f0" }}>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Servicio</p>
                              <p><span className="text-gray-400">Origen:</span> {(r as any).origen || "-"}</p>
                              <p><span className="text-gray-400">Destino:</span> {(r as any).destino || "-"}</p>
                              <p><span className="text-gray-400">Fecha:</span> {fmtFecha(r.fecha_servicio)}</p>
                              <p><span className="text-gray-400">Hora:</span> {r.hora_servicio?.slice(0,5) || "-"}</p>
                              <p>
                                <span className="text-gray-400">Tipo servicio: </span>
                                <span className="font-bold" style={{ color: !esEventual(r) ? "#0b315f" : "#6d28d9" }}>
                                  {!esEventual(r) ? "Fijo" : "Eventual"}
                                </span>
                              </p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                {esTer ? "Empresa tercerizada" : "Flota propia"}
                              </p>
                              {esTer ? (
                                <>
                                  <p>{nombreEmpTer(r.empresa_tercerizada_id)}</p>
                                  {r.vehiculo_tercero_id && <p>{nombreVehTercero(r.vehiculo_tercero_id)}</p>}
                                  {riesgo === "alto" && <p className="text-red-600 font-bold">Documentos vencidos</p>}
                                </>
                              ) : (
                                <>
                                  <p>{nombreVehiculo(r.vehiculo_id)}</p>
                                  <p>{nombreConductor(r.conductor_id)}</p>
                                </>
                              )}
                              {cap !== null && <p><span className="text-gray-400">Capacidad:</span> <b>{cap} pax</b></p>}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Manifiesto</p>
                              <p><span className="text-gray-400">Total:</span> <b>{totalPax}</b> pasajero(s)</p>
                              <p><span className="text-gray-400">Abordados:</span> <b className="text-green-700">{ocup?.abordados || 0}</b></p>
                              <p><span className="text-gray-400">Pendientes:</span> <b className="text-yellow-700">{ocup?.pendientes || 0}</b></p>
                              {sobrecupo && <p className="text-red-600 font-bold">Excede capacidad</p>}
                              <button onClick={() => setModalReservaId(r.id)} className="mt-1 text-[10px] font-bold px-2 py-1 rounded-lg text-white" style={{ background: "#0b315f" }}>
                                Abrir manifiesto
                              </button>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Financiero / Sync</p>
                              <div className="flex justify-between"><span className="text-gray-400">Precio</span><b>{fmtSoles(Number(r.precio_cliente || 0))}</b></div>
                              <div className="flex justify-between"><span className="text-gray-400">Margen</span>
                                <span className="font-black" style={{ color: margen >= 0 ? "#166534" : "#991b1b" }}>{fmtSoles(margen)}</span>
                              </div>
                              <div className="flex justify-between border-t pt-1" style={{ borderColor: "#e5e7eb" }}>
                                <span className="text-gray-400">App Pasajero</span>
                                <b className={r.sincronizado_app ? "text-green-700" : "text-gray-400"}>
                                  {r.sincronizado_app ? "Sincronizado" : "Sin enviar"}
                                </b>
                              </div>
                              {r.fecha_sincronizacion && (
                                <p className="text-[10px] text-gray-400">
                                  {new Date(r.fecha_sincronizacion).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtradas.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtradas.length} de {totalRes} reservas</span>
            <span>AFA ERP · Operaciones</span>
          </div>
        )}
      </section>
      )}
    </main>
  );
}