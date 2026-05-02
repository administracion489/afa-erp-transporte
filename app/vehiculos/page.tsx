"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Vehiculo = {
  id: number;
  placa: string;
  categoria: string | null;
  marca: string | null;
  modelo: string | null;
  anio: number | null;
  color: string | null;
  capacidad_pasajeros: number | null;
  carga_maxima: string | null;
  estado: string | null;
  kilometraje_actual: number | null;
  proximo_mantenimiento_km: number | null;
  estado_operativo: string | null;
  observaciones: string | null;
};

type DocumentoVehiculo = {
  id: number;
  vehiculo_id: number;
  tipo_documento: string;
  numero_documento: string | null;
  fecha_emision: string | null;
  fecha_vencimiento: string | null;
  obligatorio: boolean | null;
  archivo_url: string | null;
  estado: string | null;
};

export default function VehiculosPage() {
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [documentos, setDocumentos] = useState<DocumentoVehiculo[]>([]);

  const [editandoId, setEditandoId] = useState<number | null>(null);

  const [placa, setPlaca] = useState("");
  const [categoria, setCategoria] = useState("AUTO");
  const [marca, setMarca] = useState("");
  const [modelo, setModelo] = useState("");
  const [anio, setAnio] = useState("");
  const [color, setColor] = useState("");
  const [capacidad, setCapacidad] = useState("");
  const [cargaMaxima, setCargaMaxima] = useState("");
  const [estado, setEstado] = useState("disponible");
  const [km, setKm] = useState("");
  const [proximoKm, setProximoKm] = useState("");
  const [observaciones, setObservaciones] = useState("");

  const [vehiculoDocumentoId, setVehiculoDocumentoId] = useState("");
  const [tipoDocumento, setTipoDocumento] = useState("SOAT");
  const [numeroDocumento, setNumeroDocumento] = useState("");
  const [fechaEmision, setFechaEmision] = useState("");
  const [fechaVencimiento, setFechaVencimiento] = useState("");
  const [archivoUrl, setArchivoUrl] = useState("");

  function calcularEstadoDocumento(fecha: string | null) {
    if (!fecha) return "sin_fecha";

    const hoy = new Date();
    const vencimiento = new Date(fecha);
    const diferencia = vencimiento.getTime() - hoy.getTime();
    const dias = Math.ceil(diferencia / (1000 * 60 * 60 * 24));

    if (dias < 0) return "vencido";
    if (dias <= 30) return "por_vencer";
    return "vigente";
  }

  function documentoEsObligatorio(tipo: string, categoriaVehiculo?: string | null) {
    if (tipo === "Tarjeta de propiedad") return true;
    if (tipo === "SOAT") return true;
    if (tipo === "Revisión técnica") return true;

    if (tipo === "Tarjeta de circulación") {
      return categoriaVehiculo !== "AUTO";
    }

    return false;
  }

  async function actualizarEstadosDocumentos() {
    const { data: docs } = await supabase
      .from("documentos_vehiculo")
      .select("*");

    for (const doc of docs || []) {
      const nuevoEstado = calcularEstadoDocumento(doc.fecha_vencimiento);

      await supabase
        .from("documentos_vehiculo")
        .update({ estado: nuevoEstado })
        .eq("id", doc.id);
    }
  }

  async function actualizarEstadoVehiculos() {
    const { data: listaVehiculos } = await supabase
      .from("vehiculos")
      .select("*");

    const { data: listaDocumentos } = await supabase
      .from("documentos_vehiculo")
      .select("*");

    for (const vehiculo of listaVehiculos || []) {
      const docsVehiculo = (listaDocumentos || []).filter(
        (d) => d.vehiculo_id === vehiculo.id
      );

      const documentosObligatorios = [
        "Tarjeta de propiedad",
        "SOAT",
        "Revisión técnica",
      ];

      if (vehiculo.categoria !== "AUTO") {
        documentosObligatorios.push("Tarjeta de circulación");
      }

      const tieneProblema = documentosObligatorios.some((tipo) => {
        const doc = docsVehiculo.find((d) => d.tipo_documento === tipo);
        if (!doc) return true;

        const estadoDoc = calcularEstadoDocumento(doc.fecha_vencimiento);
        return estadoDoc === "vencido" || estadoDoc === "sin_fecha";
      });

      await supabase
        .from("vehiculos")
        .update({ estado_operativo: tieneProblema ? "no_apto" : "apto" })
        .eq("id", vehiculo.id);
    }
  }

  async function cargarTodo() {
    await actualizarEstadosDocumentos();
    await actualizarEstadoVehiculos();

    const { data: vehiculosData } = await supabase
      .from("vehiculos")
      .select("*")
      .order("id", { ascending: false });

    const { data: documentosData } = await supabase
      .from("documentos_vehiculo")
      .select("*")
      .order("id", { ascending: false });

    setVehiculos(vehiculosData || []);
    setDocumentos(documentosData || []);
  }

  useEffect(() => {
    cargarTodo();
  }, []);

  async function guardarVehiculo() {
    if (!placa.trim()) {
      alert("Ingrese la placa");
      return;
    }

    const datos = {
      placa,
      categoria,
      marca,
      modelo,
      anio: Number(anio || 0),
      color,
      capacidad_pasajeros: Number(capacidad || 0),
      carga_maxima: cargaMaxima,
      estado,
      kilometraje_actual: Number(km || 0),
      proximo_mantenimiento_km: Number(proximoKm || 0),
      observaciones,
    };

    if (editandoId) {
      await supabase.from("vehiculos").update(datos).eq("id", editandoId);
    } else {
      await supabase.from("vehiculos").insert([datos]);
    }

    limpiarVehiculo();
    cargarTodo();
  }

  function editarVehiculo(v: Vehiculo) {
    setEditandoId(v.id);
    setPlaca(v.placa || "");
    setCategoria(v.categoria || "AUTO");
    setMarca(v.marca || "");
    setModelo(v.modelo || "");
    setAnio(String(v.anio || ""));
    setColor(v.color || "");
    setCapacidad(String(v.capacidad_pasajeros || ""));
    setCargaMaxima(v.carga_maxima || "");
    setEstado(v.estado || "disponible");
    setKm(String(v.kilometraje_actual || ""));
    setProximoKm(String(v.proximo_mantenimiento_km || ""));
    setObservaciones(v.observaciones || "");
  }

  async function eliminarVehiculo(id: number) {
    if (!confirm("¿Seguro que desea eliminar este vehículo?")) return;

    await supabase.from("vehiculos").delete().eq("id", id);
    cargarTodo();
  }

  function limpiarVehiculo() {
    setEditandoId(null);
    setPlaca("");
    setCategoria("AUTO");
    setMarca("");
    setModelo("");
    setAnio("");
    setColor("");
    setCapacidad("");
    setCargaMaxima("");
    setEstado("disponible");
    setKm("");
    setProximoKm("");
    setObservaciones("");
  }

  async function guardarDocumento() {
    if (!vehiculoDocumentoId || !tipoDocumento) {
      alert("Seleccione vehículo y tipo de documento");
      return;
    }

    const vehiculo = vehiculos.find((v) => v.id === Number(vehiculoDocumentoId));
    const estadoDocumento = calcularEstadoDocumento(fechaVencimiento);

    await supabase.from("documentos_vehiculo").insert([
      {
        vehiculo_id: Number(vehiculoDocumentoId),
        tipo_documento: tipoDocumento,
        numero_documento: numeroDocumento,
        fecha_emision: fechaEmision || null,
        fecha_vencimiento: fechaVencimiento || null,
        obligatorio: documentoEsObligatorio(tipoDocumento, vehiculo?.categoria),
        archivo_url: archivoUrl,
        estado: estadoDocumento,
      },
    ]);

    limpiarDocumento();
    cargarTodo();
  }

  async function eliminarDocumento(id: number) {
    if (!confirm("¿Eliminar documento?")) return;

    await supabase.from("documentos_vehiculo").delete().eq("id", id);
    cargarTodo();
  }

  function limpiarDocumento() {
    setVehiculoDocumentoId("");
    setTipoDocumento("SOAT");
    setNumeroDocumento("");
    setFechaEmision("");
    setFechaVencimiento("");
    setArchivoUrl("");
  }

  function estadoBadge(estadoDoc: string | null) {
    if (estadoDoc === "vencido") return "bg-red-100 text-red-700";
    if (estadoDoc === "por_vencer") return "bg-yellow-100 text-yellow-700";
    if (estadoDoc === "vigente") return "bg-green-100 text-green-700";
    return "bg-gray-100 text-gray-700";
  }

  return (
    <main className="p-8 text-slate-800">
      <h1 className="text-3xl font-bold text-slate-900">Vehículos</h1>
      <p className="mb-6 text-slate-600">
        Gestión de flota, documentos obligatorios y vencimientos.
      </p>

      <div className="mb-8 rounded-xl bg-white p-6 shadow">
        <h2 className="mb-4 text-xl font-bold text-slate-900">
          {editandoId ? "Editar vehículo" : "Nuevo vehículo"}
        </h2>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <input className="rounded-lg border p-3" placeholder="Placa" value={placa} onChange={(e) => setPlaca(e.target.value.toUpperCase())} />
          <select className="rounded-lg border p-3" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
            <option value="AUTO">Auto</option>
            <option value="SUV">SUV</option>
            <option value="VAN">Van</option>
            <option value="MINIBUS">Minibus</option>
            <option value="BUS">Bus</option>
          </select>
          <input className="rounded-lg border p-3" placeholder="Marca" value={marca} onChange={(e) => setMarca(e.target.value)} />
          <input className="rounded-lg border p-3" placeholder="Modelo" value={modelo} onChange={(e) => setModelo(e.target.value)} />
          <input className="rounded-lg border p-3" placeholder="Año" value={anio} onChange={(e) => setAnio(e.target.value)} />
          <input className="rounded-lg border p-3" placeholder="Color" value={color} onChange={(e) => setColor(e.target.value)} />
          <input className="rounded-lg border p-3" placeholder="Capacidad pasajeros" value={capacidad} onChange={(e) => setCapacidad(e.target.value)} />
          <input className="rounded-lg border p-3" placeholder="Carga máxima" value={cargaMaxima} onChange={(e) => setCargaMaxima(e.target.value)} />
          <input className="rounded-lg border p-3" placeholder="Kilometraje actual" value={km} onChange={(e) => setKm(e.target.value)} />
          <input className="rounded-lg border p-3" placeholder="Próximo mantenimiento KM" value={proximoKm} onChange={(e) => setProximoKm(e.target.value)} />

          <select className="rounded-lg border p-3" value={estado} onChange={(e) => setEstado(e.target.value)}>
            <option value="disponible">Disponible</option>
            <option value="ocupado">Ocupado</option>
            <option value="mantenimiento">Mantenimiento</option>
            <option value="inactivo">Inactivo</option>
          </select>

          <input className="rounded-lg border p-3" placeholder="Observaciones" value={observaciones} onChange={(e) => setObservaciones(e.target.value)} />
        </div>

        <div className="mt-5 flex gap-3">
          <button onClick={guardarVehiculo} className="rounded-lg bg-slate-900 px-6 py-3 font-semibold text-white hover:bg-slate-700">
            {editandoId ? "Actualizar vehículo" : "Guardar vehículo"}
          </button>

          {editandoId && (
            <button onClick={limpiarVehiculo} className="rounded-lg bg-gray-200 px-6 py-3 font-semibold text-slate-800 hover:bg-gray-300">
              Cancelar
            </button>
          )}
        </div>
      </div>

      <div className="mb-8 rounded-xl bg-white p-6 shadow">
        <h2 className="mb-4 text-xl font-bold text-slate-900">
          Documentos del vehículo
        </h2>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <select className="rounded-lg border p-3" value={vehiculoDocumentoId} onChange={(e) => setVehiculoDocumentoId(e.target.value)}>
            <option value="">Seleccionar vehículo</option>
            {vehiculos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.placa} - {v.categoria}
              </option>
            ))}
          </select>

          <select className="rounded-lg border p-3" value={tipoDocumento} onChange={(e) => setTipoDocumento(e.target.value)}>
            <option value="Tarjeta de propiedad">Tarjeta de propiedad</option>
            <option value="SOAT">SOAT</option>
            <option value="Revisión técnica">Revisión técnica</option>
            <option value="Tarjeta de circulación">Tarjeta de circulación</option>
            <option value="Seguro todo riesgo">Seguro todo riesgo</option>
            <option value="Otro">Otro</option>
          </select>

          <input className="rounded-lg border p-3" placeholder="Número de documento" value={numeroDocumento} onChange={(e) => setNumeroDocumento(e.target.value)} />
          <input className="rounded-lg border p-3" type="date" value={fechaEmision} onChange={(e) => setFechaEmision(e.target.value)} />
          <input className="rounded-lg border p-3" type="date" value={fechaVencimiento} onChange={(e) => setFechaVencimiento(e.target.value)} />
          <input className="rounded-lg border p-3" placeholder="URL archivo / PDF" value={archivoUrl} onChange={(e) => setArchivoUrl(e.target.value)} />
        </div>

        <button onClick={guardarDocumento} className="mt-5 rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700">
          Guardar documento
        </button>
      </div>

      <div className="mb-8 rounded-xl bg-white p-6 shadow">
        <h2 className="mb-4 text-xl font-bold text-slate-900">
          Flota registrada
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-100 text-slate-700">
                <th className="p-3">Placa</th>
                <th className="p-3">Categoría</th>
                <th className="p-3">Marca / Modelo</th>
                <th className="p-3">KM</th>
                <th className="p-3">Estado</th>
                <th className="p-3">Operativo</th>
                <th className="p-3">Acciones</th>
              </tr>
            </thead>

            <tbody>
              {vehiculos.map((v) => (
                <tr key={v.id} className="border-b">
                  <td className="p-3 font-bold">{v.placa}</td>
                  <td className="p-3">{v.categoria}</td>
                  <td className="p-3">{v.marca} {v.modelo}</td>
                  <td className="p-3">{v.kilometraje_actual}</td>

                  <td className="p-3">
                    <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-700">
                      {v.estado?.toUpperCase()}
                    </span>
                  </td>

                  <td className="p-3">
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${v.estado_operativo === "no_apto" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                      {v.estado_operativo === "no_apto" ? "NO APTO" : "APTO"}
                    </span>
                  </td>

                  <td className="flex gap-2 p-3">
                    <button onClick={() => editarVehiculo(v)} className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700">
                      Editar
                    </button>

                    <button onClick={() => eliminarVehiculo(v.id)} className="rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700">
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}

              {vehiculos.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">
                    No hay vehículos registrados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl bg-white p-6 shadow">
        <h2 className="mb-4 text-xl font-bold text-slate-900">
          Lista de documentos registrados
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-100 text-slate-700">
                <th className="p-3">Vehículo</th>
                <th className="p-3">Documento</th>
                <th className="p-3">Número</th>
                <th className="p-3">Vencimiento</th>
                <th className="p-3">Obligatorio</th>
                <th className="p-3">Estado</th>
                <th className="p-3">Archivo</th>
                <th className="p-3">Acciones</th>
              </tr>
            </thead>

            <tbody>
              {documentos.map((d) => {
                const vehiculo = vehiculos.find((v) => v.id === d.vehiculo_id);

                return (
                  <tr key={d.id} className="border-b">
                    <td className="p-3 font-semibold">{vehiculo?.placa || "-"}</td>
                    <td className="p-3">{d.tipo_documento}</td>
                    <td className="p-3">{d.numero_documento}</td>
                    <td className="p-3">{d.fecha_vencimiento || "-"}</td>
                    <td className="p-3">{d.obligatorio ? "Sí" : "No"}</td>

                    <td className="p-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-bold ${estadoBadge(d.estado)}`}>
                        {d.estado?.toUpperCase() || "SIN FECHA"}
                      </span>
                    </td>

                    <td className="p-3">
                      {d.archivo_url ? (
                        <a href={d.archivo_url} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                          Ver archivo
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>

                    <td className="p-3">
                      <button onClick={() => eliminarDocumento(d.id)} className="rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700">
                        Eliminar
                      </button>
                    </td>
                  </tr>
                );
              })}

              {documentos.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-500">
                    No hay documentos registrados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}