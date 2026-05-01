"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Gasto = {
  id: number;
  fecha: string;
  categoria: string;
  descripcion: string;
  monto: number;
  vehiculo_id: number | null;
  proveedor_id: number | null;
  reserva_id: number | null;
  metodo_pago: string;
  comprobante_url: string | null;
  estado: string;
  observaciones: string | null;
};

type Simple = {
  id: number;
  nombre?: string;
  placa?: string;
  origen?: string;
  destino?: string;
};

export default function GastosPage() {
  const [gastos, setGastos] = useState<Gasto[]>([]);
  const [vehiculos, setVehiculos] = useState<Simple[]>([]);
  const [proveedores, setProveedores] = useState<Simple[]>([]);
  const [reservas, setReservas] = useState<Simple[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [form, setForm] = useState({
    fecha: "",
    categoria: "administrativo",
    descripcion: "",
    monto: "",
    vehiculo_id: "",
    proveedor_id: "",
    reserva_id: "",
    metodo_pago: "efectivo",
    comprobante_url: "",
    estado: "pagado",
    observaciones: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [gastosRes, vehiculosRes, proveedoresRes, reservasRes] =
      await Promise.all([
        supabase.from("gastos").select("*").order("fecha", { ascending: false }),
        supabase.from("vehiculos").select("id, placa").order("placa"),
        supabase.from("proveedores").select("id, nombre").order("nombre"),
        supabase.from("reservas").select("id, origen, destino").order("id", {
          ascending: false,
        }),
      ]);

    if (gastosRes.error) alert(gastosRes.error.message);
    else setGastos(gastosRes.data || []);

    setVehiculos(vehiculosRes.data || []);
    setProveedores(proveedoresRes.data || []);
    setReservas(reservasRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const limpiar = () => {
    setEditandoId(null);
    setForm({
      fecha: "",
      categoria: "administrativo",
      descripcion: "",
      monto: "",
      vehiculo_id: "",
      proveedor_id: "",
      reserva_id: "",
      metodo_pago: "efectivo",
      comprobante_url: "",
      estado: "pagado",
      observaciones: "",
    });
  };

  const guardar = async () => {
    if (!form.fecha || !form.descripcion || !form.monto) {
      alert("Completa fecha, descripción y monto");
      return;
    }

    const payload = {
      fecha: form.fecha,
      categoria: form.categoria,
      descripcion: form.descripcion,
      monto: Number(form.monto),
      vehiculo_id: form.vehiculo_id ? Number(form.vehiculo_id) : null,
      proveedor_id: form.proveedor_id ? Number(form.proveedor_id) : null,
      reserva_id: form.reserva_id ? Number(form.reserva_id) : null,
      metodo_pago: form.metodo_pago,
      comprobante_url: form.comprobante_url || null,
      estado: form.estado,
      observaciones: form.observaciones || null,
    };

    if (editandoId) {
      const { error } = await supabase
        .from("gastos")
        .update(payload)
        .eq("id", editandoId);

      if (error) return alert(error.message);
    } else {
      const { error } = await supabase.from("gastos").insert(payload);

      if (error) return alert(error.message);
    }

    limpiar();
    cargarDatos();
  };

  const editar = (g: Gasto) => {
    setEditandoId(g.id);

    setForm({
      fecha: g.fecha || "",
      categoria: g.categoria || "administrativo",
      descripcion: g.descripcion || "",
      monto: String(g.monto || ""),
      vehiculo_id: g.vehiculo_id ? String(g.vehiculo_id) : "",
      proveedor_id: g.proveedor_id ? String(g.proveedor_id) : "",
      reserva_id: g.reserva_id ? String(g.reserva_id) : "",
      metodo_pago: g.metodo_pago || "efectivo",
      comprobante_url: g.comprobante_url || "",
      estado: g.estado || "pagado",
      observaciones: g.observaciones || "",
    });
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar gasto?")) return;

    const { error } = await supabase.from("gastos").delete().eq("id", id);

    if (error) return alert(error.message);

    cargarDatos();
  };

  const nombreVehiculo = (id: number | null) =>
    vehiculos.find((v) => v.id === id)?.placa || "-";

  const nombreProveedor = (id: number | null) =>
    proveedores.find((p) => p.id === id)?.nombre || "-";

  const nombreReserva = (id: number | null) => {
    const r = reservas.find((x) => x.id === id);
    return r ? `#${r.id} ${r.origen} → ${r.destino}` : "-";
  };

  const totalGastos = gastos.reduce((sum, g) => sum + Number(g.monto || 0), 0);
  const pendientes = gastos.filter((g) => g.estado === "pendiente").length;
  const pagados = gastos.filter((g) => g.estado === "pagado").length;

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Gastos</h1>
        <p className="text-gray-600">
          Control de egresos operativos, administrativos y costos asociados.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Registros</p>
          <p className="text-2xl font-bold">{gastos.length}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Total gastos</p>
          <p className="text-2xl font-bold text-red-600">
            S/ {totalGastos.toFixed(2)}
          </p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Pendientes</p>
          <p className="text-2xl font-bold text-yellow-600">{pendientes}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Pagados</p>
          <p className="text-2xl font-bold text-green-600">{pagados}</p>
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar gasto" : "Nuevo gasto"}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            type="date"
            className="border rounded-lg p-3"
            value={form.fecha}
            onChange={(e) => setForm({ ...form, fecha: e.target.value })}
          />

          <select
            className="border rounded-lg p-3"
            value={form.categoria}
            onChange={(e) => setForm({ ...form, categoria: e.target.value })}
          >
            <option value="combustible">Combustible</option>
            <option value="mantenimiento">Mantenimiento</option>
            <option value="neumaticos">Neumáticos</option>
            <option value="peajes">Peajes</option>
            <option value="viaticos">Viáticos</option>
            <option value="proveedor">Proveedor</option>
            <option value="planilla">Planilla</option>
            <option value="administrativo">Administrativo</option>
            <option value="seguro">Seguro</option>
            <option value="multa">Multa</option>
            <option value="otro">Otro</option>
          </select>

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Monto S/"
            value={form.monto}
            onChange={(e) => setForm({ ...form, monto: e.target.value })}
          />

          <input
            className="border rounded-lg p-3 md:col-span-3"
            placeholder="Descripción"
            value={form.descripcion}
            onChange={(e) =>
              setForm({ ...form, descripcion: e.target.value })
            }
          />

          <select
            className="border rounded-lg p-3"
            value={form.vehiculo_id}
            onChange={(e) =>
              setForm({ ...form, vehiculo_id: e.target.value })
            }
          >
            <option value="">Vehículo relacionado</option>
            {vehiculos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.placa}
              </option>
            ))}
          </select>

          <select
            className="border rounded-lg p-3"
            value={form.proveedor_id}
            onChange={(e) =>
              setForm({ ...form, proveedor_id: e.target.value })
            }
          >
            <option value="">Proveedor relacionado</option>
            {proveedores.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>

          <select
            className="border rounded-lg p-3"
            value={form.reserva_id}
            onChange={(e) =>
              setForm({ ...form, reserva_id: e.target.value })
            }
          >
            <option value="">Reserva relacionada</option>
            {reservas.map((r) => (
              <option key={r.id} value={r.id}>
                #{r.id} {r.origen} → {r.destino}
              </option>
            ))}
          </select>

          <select
            className="border rounded-lg p-3"
            value={form.metodo_pago}
            onChange={(e) =>
              setForm({ ...form, metodo_pago: e.target.value })
            }
          >
            <option value="efectivo">Efectivo</option>
            <option value="transferencia">Transferencia</option>
            <option value="yape">Yape</option>
            <option value="plin">Plin</option>
            <option value="tarjeta">Tarjeta</option>
            <option value="credito">Crédito</option>
            <option value="otro">Otro</option>
          </select>

          <select
            className="border rounded-lg p-3"
            value={form.estado}
            onChange={(e) => setForm({ ...form, estado: e.target.value })}
          >
            <option value="pagado">Pagado</option>
            <option value="pendiente">Pendiente</option>
            <option value="anulado">Anulado</option>
          </select>

          <input
            className="border rounded-lg p-3"
            placeholder="URL comprobante"
            value={form.comprobante_url}
            onChange={(e) =>
              setForm({ ...form, comprobante_url: e.target.value })
            }
          />

          <input
            className="border rounded-lg p-3 md:col-span-3"
            placeholder="Observaciones"
            value={form.observaciones}
            onChange={(e) =>
              setForm({ ...form, observaciones: e.target.value })
            }
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={guardar}
            className="bg-slate-900 text-white px-6 py-3 rounded-lg font-bold"
          >
            {editandoId ? "Actualizar gasto" : "Guardar gasto"}
          </button>

          {editandoId && (
            <button
              onClick={limpiar}
              className="bg-gray-200 px-6 py-3 rounded-lg font-bold"
            >
              Cancelar
            </button>
          )}
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Lista de gastos</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Fecha</th>
              <th className="p-3 text-left">Categoría</th>
              <th className="p-3 text-left">Descripción</th>
              <th className="p-3 text-left">Monto</th>
              <th className="p-3 text-left">Vehículo</th>
              <th className="p-3 text-left">Proveedor</th>
              <th className="p-3 text-left">Reserva</th>
              <th className="p-3 text-left">Pago</th>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-left">Comprobante</th>
              <th className="p-3 text-right">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={11} className="p-5 text-center">
                  Cargando...
                </td>
              </tr>
            ) : gastos.length === 0 ? (
              <tr>
                <td colSpan={11} className="p-5 text-center">
                  No hay gastos registrados.
                </td>
              </tr>
            ) : (
              gastos.map((g) => (
                <tr key={g.id} className="border-t">
                  <td className="p-3">{g.fecha}</td>
                  <td className="p-3">{g.categoria}</td>
                  <td className="p-3">{g.descripcion}</td>
                  <td className="p-3 font-bold text-red-600">
                    S/ {Number(g.monto || 0).toFixed(2)}
                  </td>
                  <td className="p-3">{nombreVehiculo(g.vehiculo_id)}</td>
                  <td className="p-3">{nombreProveedor(g.proveedor_id)}</td>
                  <td className="p-3">{nombreReserva(g.reserva_id)}</td>
                  <td className="p-3">{g.metodo_pago}</td>
                  <td className="p-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${
                        g.estado === "pagado"
                          ? "bg-green-100 text-green-700"
                          : g.estado === "pendiente"
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {g.estado.toUpperCase()}
                    </span>
                  </td>
                  <td className="p-3">
                    {g.comprobante_url ? (
                      <a
                        href={g.comprobante_url}
                        target="_blank"
                        className="text-blue-600 underline"
                      >
                        Ver
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="p-3 text-right space-x-2">
                    <button
                      onClick={() => editar(g)}
                      className="bg-blue-600 text-white px-3 py-1 rounded"
                    >
                      Editar
                    </button>

                    <button
                      onClick={() => eliminar(g.id)}
                      className="bg-red-600 text-white px-3 py-1 rounded"
                    >
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