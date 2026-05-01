"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Seguro = {
  id: number;
  tipo: string;
  aseguradora: string;
  numero_poliza: string | null;
  titular: string | null;
  vehiculo_id: number | null;
  proveedor_id: number | null;
  fecha_inicio: string | null;
  fecha_vencimiento: string;
  prima_total: number;
  cuota_mensual: number;
  estado: string;
  archivo_url: string | null;
  observaciones: string | null;
};

type Vehiculo = {
  id: number;
  placa: string;
  categoria?: string;
};

type Proveedor = {
  id: number;
  nombre: string;
};

export default function SegurosPage() {
  const [seguros, setSeguros] = useState<Seguro[]>([]);
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [loading, setLoading] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");

  const [form, setForm] = useState({
    tipo: "vehicular",
    aseguradora: "",
    numero_poliza: "",
    titular: "",
    vehiculo_id: "",
    proveedor_id: "",
    fecha_inicio: "",
    fecha_vencimiento: "",
    prima_total: "",
    cuota_mensual: "",
    archivo_url: "",
    observaciones: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [segurosRes, vehiculosRes, proveedoresRes] = await Promise.all([
      supabase.from("seguros").select("*").order("fecha_vencimiento", {
        ascending: true,
      }),
      supabase.from("vehiculos").select("id, placa, categoria").order("placa"),
      supabase.from("proveedores").select("id, nombre").order("nombre"),
    ]);

    if (segurosRes.error) alert(segurosRes.error.message);
    else setSeguros(segurosRes.data || []);

    setVehiculos(vehiculosRes.data || []);
    setProveedores(proveedoresRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const limpiar = () => {
    setEditandoId(null);
    setForm({
      tipo: "vehicular",
      aseguradora: "",
      numero_poliza: "",
      titular: "",
      vehiculo_id: "",
      proveedor_id: "",
      fecha_inicio: "",
      fecha_vencimiento: "",
      prima_total: "",
      cuota_mensual: "",
      archivo_url: "",
      observaciones: "",
    });
  };

  const calcularEstado = (fecha: string | null) => {
    if (!fecha) return "vigente";

    const hoy = new Date();
    const vencimiento = new Date(fecha);
    const dias = Math.ceil(
      (vencimiento.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (dias < 0) return "vencido";
    if (dias <= 30) return "por_vencer";
    return "vigente";
  };

  const guardar = async () => {
    if (!form.tipo || !form.aseguradora || !form.fecha_vencimiento) {
      alert("Completa tipo, aseguradora y fecha de vencimiento");
      return;
    }

    const estado = calcularEstado(form.fecha_vencimiento);

    const payload = {
      tipo: form.tipo,
      aseguradora: form.aseguradora,
      numero_poliza: form.numero_poliza || null,
      titular: form.titular || null,
      vehiculo_id: form.vehiculo_id ? Number(form.vehiculo_id) : null,
      proveedor_id: form.proveedor_id ? Number(form.proveedor_id) : null,
      fecha_inicio: form.fecha_inicio || null,
      fecha_vencimiento: form.fecha_vencimiento,
      prima_total: Number(form.prima_total || 0),
      cuota_mensual: Number(form.cuota_mensual || 0),
      estado,
      archivo_url: form.archivo_url || null,
      observaciones: form.observaciones || null,
    };

    if (editandoId) {
      const { error } = await supabase
        .from("seguros")
        .update(payload)
        .eq("id", editandoId);

      if (error) return alert(error.message);
    } else {
      const { error } = await supabase.from("seguros").insert(payload);

      if (error) return alert(error.message);
    }

    limpiar();
    cargarDatos();
  };

  const editar = (s: Seguro) => {
    setEditandoId(s.id);

    setForm({
      tipo: s.tipo || "vehicular",
      aseguradora: s.aseguradora || "",
      numero_poliza: s.numero_poliza || "",
      titular: s.titular || "",
      vehiculo_id: s.vehiculo_id ? String(s.vehiculo_id) : "",
      proveedor_id: s.proveedor_id ? String(s.proveedor_id) : "",
      fecha_inicio: s.fecha_inicio || "",
      fecha_vencimiento: s.fecha_vencimiento || "",
      prima_total: String(s.prima_total || ""),
      cuota_mensual: String(s.cuota_mensual || ""),
      archivo_url: s.archivo_url || "",
      observaciones: s.observaciones || "",
    });
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar seguro?")) return;

    const { error } = await supabase.from("seguros").delete().eq("id", id);

    if (error) return alert(error.message);

    cargarDatos();
  };

  const nombreVehiculo = (id: number | null) =>
    vehiculos.find((v) => v.id === id)?.placa || "-";

  const nombreProveedor = (id: number | null) =>
    proveedores.find((p) => p.id === id)?.nombre || "-";

  const segurosActualizados = useMemo(() => {
    return seguros.map((s) => ({
      ...s,
      estado: calcularEstado(s.fecha_vencimiento),
    }));
  }, [seguros]);

  const filtrados = segurosActualizados
    .filter((s) => {
      const texto = `${s.aseguradora} ${s.numero_poliza || ""} ${
        s.titular || ""
      } ${s.tipo}`.toLowerCase();

      return texto.includes(busqueda.toLowerCase());
    })
    .filter((s) =>
      filtroEstado === "todos" ? true : s.estado === filtroEstado
    );

  const vigentes = segurosActualizados.filter(
    (s) => s.estado === "vigente"
  ).length;

  const porVencer = segurosActualizados.filter(
    (s) => s.estado === "por_vencer"
  ).length;

  const vencidos = segurosActualizados.filter(
    (s) => s.estado === "vencido"
  ).length;

  const costoTotal = segurosActualizados.reduce(
    (sum, s) => sum + Number(s.prima_total || 0),
    0
  );

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Seguros</h1>
        <p className="text-gray-600">
          Gestión de pólizas, vencimientos, cuotas y seguros de la empresa.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Total seguros</p>
          <p className="text-2xl font-bold">{seguros.length}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Por vencer</p>
          <p className="text-2xl font-bold text-yellow-600">{porVencer}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Vencidos</p>
          <p className="text-2xl font-bold text-red-600">{vencidos}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Prima total</p>
          <p className="text-2xl font-bold text-green-600">
            S/ {costoTotal.toFixed(2)}
          </p>
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {editandoId ? "Editar seguro" : "Nuevo seguro"}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <select
            className="border rounded-lg p-3"
            value={form.tipo}
            onChange={(e) => setForm({ ...form, tipo: e.target.value })}
          >
            <option value="vehicular">Vehicular</option>
            <option value="sctr">SCTR</option>
            <option value="responsabilidad_civil">Responsabilidad civil</option>
            <option value="todo_riesgo">Todo riesgo</option>
            <option value="vida">Vida</option>
            <option value="negocio">Negocio</option>
            <option value="otro">Otro</option>
          </select>

          <input
            className="border rounded-lg p-3"
            placeholder="Aseguradora"
            value={form.aseguradora}
            onChange={(e) =>
              setForm({ ...form, aseguradora: e.target.value })
            }
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Número de póliza"
            value={form.numero_poliza}
            onChange={(e) =>
              setForm({ ...form, numero_poliza: e.target.value })
            }
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Titular"
            value={form.titular}
            onChange={(e) => setForm({ ...form, titular: e.target.value })}
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
                {v.placa} {v.categoria ? `- ${v.categoria}` : ""}
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
            <option value="">Proveedor / broker</option>
            {proveedores.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>

          <input
            type="date"
            className="border rounded-lg p-3"
            value={form.fecha_inicio}
            onChange={(e) =>
              setForm({ ...form, fecha_inicio: e.target.value })
            }
          />

          <input
            type="date"
            className="border rounded-lg p-3"
            value={form.fecha_vencimiento}
            onChange={(e) =>
              setForm({ ...form, fecha_vencimiento: e.target.value })
            }
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Prima total S/"
            value={form.prima_total}
            onChange={(e) =>
              setForm({ ...form, prima_total: e.target.value })
            }
          />

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Cuota mensual S/"
            value={form.cuota_mensual}
            onChange={(e) =>
              setForm({ ...form, cuota_mensual: e.target.value })
            }
          />

          <input
            className="border rounded-lg p-3 md:col-span-2"
            placeholder="URL archivo / póliza PDF"
            value={form.archivo_url}
            onChange={(e) =>
              setForm({ ...form, archivo_url: e.target.value })
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
            {editandoId ? "Actualizar seguro" : "Guardar seguro"}
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

      <section className="bg-white rounded-xl border shadow p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input
            className="border rounded-lg p-3"
            placeholder="Buscar por aseguradora, póliza, titular..."
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />

          <select
            className="border rounded-lg p-3"
            value={filtroEstado}
            onChange={(e) => setFiltroEstado(e.target.value)}
          >
            <option value="todos">Todos los estados</option>
            <option value="vigente">Vigente</option>
            <option value="por_vencer">Por vencer</option>
            <option value="vencido">Vencido</option>
          </select>
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Lista de seguros</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-left">Tipo</th>
              <th className="p-3 text-left">Aseguradora</th>
              <th className="p-3 text-left">Póliza</th>
              <th className="p-3 text-left">Titular</th>
              <th className="p-3 text-left">Vehículo</th>
              <th className="p-3 text-left">Vencimiento</th>
              <th className="p-3 text-left">Prima</th>
              <th className="p-3 text-left">Archivo</th>
              <th className="p-3 text-right">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="p-5 text-center">
                  Cargando...
                </td>
              </tr>
            ) : filtrados.length === 0 ? (
              <tr>
                <td colSpan={10} className="p-5 text-center">
                  No hay seguros registrados.
                </td>
              </tr>
            ) : (
              filtrados.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="p-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${
                        s.estado === "vigente"
                          ? "bg-green-100 text-green-700"
                          : s.estado === "por_vencer"
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {s.estado.replace("_", " ").toUpperCase()}
                    </span>
                  </td>

                  <td className="p-3">{s.tipo}</td>
                  <td className="p-3 font-bold">{s.aseguradora}</td>
                  <td className="p-3">{s.numero_poliza || "-"}</td>
                  <td className="p-3">{s.titular || "-"}</td>
                  <td className="p-3">{nombreVehiculo(s.vehiculo_id)}</td>
                  <td className="p-3">{s.fecha_vencimiento}</td>
                  <td className="p-3 font-bold">
                    S/ {Number(s.prima_total || 0).toFixed(2)}
                  </td>

                  <td className="p-3">
                    {s.archivo_url ? (
                      <a
                        href={s.archivo_url}
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
                      onClick={() => editar(s)}
                      className="bg-blue-600 text-white px-3 py-1 rounded"
                    >
                      Editar
                    </button>

                    <button
                      onClick={() => eliminar(s.id)}
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