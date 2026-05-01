"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Cliente = { id: number; nombre: string };
type Vehiculo = { id: number; placa: string; categoria?: string; aptitud?: string; estado?: string };
type Conductor = { id: number; nombre: string; licencia?: string; vencimiento_licencia?: string; estado?: string };
type Proveedor = { id: number; nombre: string; estado?: string };

type Reserva = {
  id: number;
  cliente_id: number | null;
  cotizacion_id: number | null;
  vehiculo_id: number | null;
  conductor_id: number | null;
  proveedor_id: number | null;
  origen: string;
  destino: string;
  tipo: "propia" | "tercerizada";
  estado: "pendiente" | "confirmada" | "en_curso" | "finalizada" | "cancelada";
  fecha_servicio: string;
  hora_servicio: string;
  precio_cliente: number;
  costo_proveedor: number;
  margen: number;
  observaciones: string | null;
};

export default function ReservasPage() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [filtroTipo, setFiltroTipo] = useState("todos");

  const [form, setForm] = useState({
    fecha_servicio: "",
    hora_servicio: "",
    tipo: "propia",
    estado: "pendiente",
    vehiculo_id: "",
    conductor_id: "",
    proveedor_id: "",
    costo_proveedor: "",
    observaciones: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [clientesRes, vehiculosRes, conductoresRes, proveedoresRes, reservasRes] =
      await Promise.all([
        supabase.from("clientes").select("id, nombre").order("nombre"),
        supabase.from("vehiculos").select("*").order("id", { ascending: false }),
        supabase.from("conductores").select("*").order("id", { ascending: false }),
        supabase.from("proveedores").select("*").order("id", { ascending: false }),
        supabase.from("reservas").select("*").order("id", { ascending: false }),
      ]);

    if (clientesRes.error) alert(clientesRes.error.message);
    else setClientes(clientesRes.data || []);

    if (vehiculosRes.error) alert(vehiculosRes.error.message);
    else setVehiculos(vehiculosRes.data || []);

    if (conductoresRes.error) alert(conductoresRes.error.message);
    else setConductores(conductoresRes.data || []);

    if (proveedoresRes.error) alert(proveedoresRes.error.message);
    else setProveedores(proveedoresRes.data || []);

    if (reservasRes.error) alert(reservasRes.error.message);
    else setReservas(reservasRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const nombreCliente = (id: number | null) =>
    clientes.find((c) => c.id === id)?.nombre || "Sin cliente";

  const nombreVehiculo = (id: number | null) =>
    vehiculos.find((v) => v.id === id)?.placa || "-";

  const nombreConductor = (id: number | null) =>
    conductores.find((c) => c.id === id)?.nombre || "-";

  const nombreProveedor = (id: number | null) =>
    proveedores.find((p) => p.id === id)?.nombre || "-";

  const vehiculosAptos = vehiculos.filter((v) => {
    const estado = String(v.aptitud || v.estado || "").toUpperCase();
    return estado === "APTO" || estado === "DISPONIBLE";
  });

  const conductoresDisponibles = conductores.filter((c) => {
    const estado = String(c.estado || "disponible").toLowerCase();
    const licenciaVigente = c.vencimiento_licencia
      ? new Date(c.vencimiento_licencia) >= new Date()
      : true;

    return estado !== "no_disponible" && estado !== "inactivo" && licenciaVigente;
  });

  const proveedoresActivos = proveedores.filter((p) => {
    const estado = String(p.estado || "activo").toLowerCase();
    return estado !== "inactivo";
  });

  const reservasFiltradas = useMemo(() => {
    return reservas
      .filter((r) => {
        const texto = `${r.id} ${nombreCliente(r.cliente_id)} ${r.origen} ${r.destino} ${r.estado} ${r.tipo}`.toLowerCase();
        return texto.includes(busqueda.toLowerCase());
      })
      .filter((r) => (filtroEstado === "todos" ? true : r.estado === filtroEstado))
      .filter((r) => (filtroTipo === "todos" ? true : r.tipo === filtroTipo));
  }, [reservas, busqueda, filtroEstado, filtroTipo, clientes]);

  const editarReserva = (reserva: Reserva) => {
    setEditandoId(reserva.id);

    setForm({
      fecha_servicio: reserva.fecha_servicio || "",
      hora_servicio: reserva.hora_servicio || "",
      tipo: reserva.tipo || "propia",
      estado: reserva.estado || "pendiente",
      vehiculo_id: reserva.vehiculo_id ? String(reserva.vehiculo_id) : "",
      conductor_id: reserva.conductor_id ? String(reserva.conductor_id) : "",
      proveedor_id: reserva.proveedor_id ? String(reserva.proveedor_id) : "",
      costo_proveedor: String(reserva.costo_proveedor || 0),
      observaciones: reserva.observaciones || "",
    });
  };

  const cancelarEdicion = () => {
    setEditandoId(null);
    setForm({
      fecha_servicio: "",
      hora_servicio: "",
      tipo: "propia",
      estado: "pendiente",
      vehiculo_id: "",
      conductor_id: "",
      proveedor_id: "",
      costo_proveedor: "",
      observaciones: "",
    });
  };

  const actualizarReserva = async () => {
    if (!editandoId) return alert("Selecciona una reserva para programar");
    if (!form.fecha_servicio || !form.hora_servicio) return alert("Ingresa fecha y hora");

    if (form.tipo === "propia") {
      if (!form.vehiculo_id) return alert("Selecciona un vehículo");
      if (!form.conductor_id) return alert("Selecciona un conductor");
    }

    if (form.tipo === "tercerizada") {
      if (!form.proveedor_id) return alert("Selecciona un proveedor");
      if (!form.costo_proveedor || Number(form.costo_proveedor) <= 0) {
        return alert("Ingresa el costo del proveedor");
      }
    }

    const { error } = await supabase
      .from("reservas")
      .update({
        fecha_servicio: form.fecha_servicio,
        hora_servicio: form.hora_servicio,
        tipo: form.tipo,
        estado: form.estado,
        vehiculo_id: form.tipo === "propia" ? Number(form.vehiculo_id) : null,
        conductor_id: form.tipo === "propia" ? Number(form.conductor_id) : null,
        proveedor_id: form.tipo === "tercerizada" ? Number(form.proveedor_id) : null,
        costo_proveedor: form.tipo === "tercerizada" ? Number(form.costo_proveedor || 0) : 0,
        observaciones: form.observaciones || null,
      })
      .eq("id", editandoId);

    if (error) return alert(error.message);

    cancelarEdicion();
    cargarDatos();
  };

  const eliminarReserva = async (id: number) => {
    if (!confirm("¿Eliminar reserva?")) return;

    const { error } = await supabase.from("reservas").delete().eq("id", id);
    if (error) return alert(error.message);

    cargarDatos();
  };

  const totalReservas = reservas.length;
  const confirmadas = reservas.filter((r) => r.estado === "confirmada").length;
  const pendientes = reservas.filter((r) => r.estado === "pendiente").length;
  const tercerizadas = reservas.filter((r) => r.tipo === "tercerizada").length;
  const ventas = reservas.reduce((sum, r) => sum + Number(r.precio_cliente || 0), 0);
  const margen = reservas.reduce((sum, r) => sum + Number(r.margen || 0), 0);
  const costos = reservas.reduce((sum, r) => sum + Number(r.costo_proveedor || 0), 0);

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Reservas</h1>
        <p className="text-gray-600">
          Programación de servicios desde cotizaciones aprobadas: vehículo propio, conductor o proveedor tercerizado.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Total reservas</p>
          <p className="text-2xl font-bold">{totalReservas}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Confirmadas</p>
          <p className="text-2xl font-bold text-green-600">{confirmadas}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Pendientes</p>
          <p className="text-2xl font-bold text-yellow-600">{pendientes}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Tercerizadas</p>
          <p className="text-2xl font-bold text-blue-600">{tercerizadas}</p>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Ventas reservas</p>
          <p className="text-2xl font-bold text-green-600">S/ {ventas.toFixed(2)}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Costos proveedor</p>
          <p className="text-2xl font-bold text-red-600">S/ {costos.toFixed(2)}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Margen total</p>
          <p className="text-2xl font-bold text-blue-600">S/ {margen.toFixed(2)}</p>
        </div>
      </section>

      <section className="bg-white rounded-xl shadow border p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? `Programar / editar reserva #${editandoId}` : "Selecciona una reserva para programar"}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input type="date" className="border rounded-lg p-3" value={form.fecha_servicio} onChange={(e) => setForm({ ...form, fecha_servicio: e.target.value })} />
          <input type="time" className="border rounded-lg p-3" value={form.hora_servicio} onChange={(e) => setForm({ ...form, hora_servicio: e.target.value })} />

          <select
            className="border rounded-lg p-3"
            value={form.tipo}
            onChange={(e) =>
              setForm({
                ...form,
                tipo: e.target.value,
                vehiculo_id: "",
                conductor_id: "",
                proveedor_id: "",
                costo_proveedor: "",
              })
            }
          >
            <option value="propia">Propia</option>
            <option value="tercerizada">Tercerizada</option>
          </select>

          <select className="border rounded-lg p-3" value={form.estado} onChange={(e) => setForm({ ...form, estado: e.target.value })}>
            <option value="pendiente">Pendiente</option>
            <option value="confirmada">Confirmada</option>
            <option value="en_curso">En curso</option>
            <option value="finalizada">Finalizada</option>
            <option value="cancelada">Cancelada</option>
          </select>

          {form.tipo === "propia" && (
            <>
              <select className="border rounded-lg p-3" value={form.vehiculo_id} onChange={(e) => setForm({ ...form, vehiculo_id: e.target.value })}>
                <option value="">Seleccionar vehículo APTO</option>
                {vehiculosAptos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.placa} {v.categoria ? `- ${v.categoria}` : ""}
                  </option>
                ))}
              </select>

              <select className="border rounded-lg p-3" value={form.conductor_id} onChange={(e) => setForm({ ...form, conductor_id: e.target.value })}>
                <option value="">Seleccionar conductor disponible</option>
                {conductoresDisponibles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre} {c.licencia ? `- ${c.licencia}` : ""}
                  </option>
                ))}
              </select>
            </>
          )}

          {form.tipo === "tercerizada" && (
            <>
              <select className="border rounded-lg p-3" value={form.proveedor_id} onChange={(e) => setForm({ ...form, proveedor_id: e.target.value })}>
                <option value="">Seleccionar proveedor</option>
                {proveedoresActivos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>

              <input type="number" className="border rounded-lg p-3" placeholder="Costo proveedor S/" value={form.costo_proveedor} onChange={(e) => setForm({ ...form, costo_proveedor: e.target.value })} />
            </>
          )}

          <input className="border rounded-lg p-3 md:col-span-3" placeholder="Observaciones" value={form.observaciones} onChange={(e) => setForm({ ...form, observaciones: e.target.value })} />
        </div>

        <div className="flex gap-3">
          <button onClick={actualizarReserva} disabled={!editandoId} className="bg-blue-600 text-white px-6 py-3 rounded-lg font-bold disabled:bg-gray-400">
            Actualizar reserva
          </button>

          {editandoId && (
            <button onClick={cancelarEdicion} className="bg-gray-200 px-6 py-3 rounded-lg font-bold">
              Cancelar
            </button>
          )}
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input className="border rounded-lg p-3" placeholder="Buscar por cliente, ruta, ID..." value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />

          <select className="border rounded-lg p-3" value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}>
            <option value="todos">Todos los estados</option>
            <option value="pendiente">Pendiente</option>
            <option value="confirmada">Confirmada</option>
            <option value="en_curso">En curso</option>
            <option value="finalizada">Finalizada</option>
            <option value="cancelada">Cancelada</option>
          </select>

          <select className="border rounded-lg p-3" value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}>
            <option value="todos">Todos los tipos</option>
            <option value="propia">Propia</option>
            <option value="tercerizada">Tercerizada</option>
          </select>
        </div>
      </section>

      <section className="bg-white rounded-xl shadow border p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Lista de reservas</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">ID</th>
              <th className="p-3 text-left">Cliente</th>
              <th className="p-3 text-left">Ruta</th>
              <th className="p-3 text-left">Fecha</th>
              <th className="p-3 text-left">Hora</th>
              <th className="p-3 text-left">Tipo</th>
              <th className="p-3 text-left">Asignación</th>
              <th className="p-3 text-left">Precio</th>
              <th className="p-3 text-left">Costo</th>
              <th className="p-3 text-left">Margen</th>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-right">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={12} className="p-5 text-center">Cargando...</td>
              </tr>
            ) : reservasFiltradas.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-5 text-center">
                  No hay reservas registradas.
                </td>
              </tr>
            ) : (
              reservasFiltradas.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-3 font-bold">#{r.id}</td>
                  <td className="p-3 font-bold">{nombreCliente(r.cliente_id)}</td>
                  <td className="p-3">{r.origen} → {r.destino}</td>
                  <td className="p-3">{r.fecha_servicio || "-"}</td>
                  <td className="p-3">{r.hora_servicio || "-"}</td>
                  <td className="p-3">{r.tipo}</td>

                  <td className="p-3">
                    {r.tipo === "propia" ? (
                      <div>
                        <div><b>Veh:</b> {nombreVehiculo(r.vehiculo_id)}</div>
                        <div className="text-xs text-gray-500"><b>Cond:</b> {nombreConductor(r.conductor_id)}</div>
                      </div>
                    ) : (
                      <div>
                        <b>Prov:</b> {nombreProveedor(r.proveedor_id)}
                      </div>
                    )}
                  </td>

                  <td className="p-3 font-bold">S/ {Number(r.precio_cliente || 0).toFixed(2)}</td>
                  <td className="p-3 text-red-600">S/ {Number(r.costo_proveedor || 0).toFixed(2)}</td>
                  <td className="p-3 font-bold text-green-600">S/ {Number(r.margen || 0).toFixed(2)}</td>

                  <td className="p-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${
                        r.estado === "confirmada"
                          ? "bg-green-100 text-green-700"
                          : r.estado === "cancelada"
                          ? "bg-red-100 text-red-700"
                          : r.estado === "finalizada"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {r.estado.replace("_", " ").toUpperCase()}
                    </span>
                  </td>

                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => editarReserva(r)} className="bg-blue-600 text-white px-3 py-1 rounded">
                      Programar
                    </button>

                    <button onClick={() => eliminarReserva(r.id)} className="bg-red-600 text-white px-3 py-1 rounded">
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}