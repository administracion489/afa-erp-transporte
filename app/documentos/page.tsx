"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Documento = {
  id: number;
  titulo: string;
  categoria: string;
  archivo_url: string | null;
  archivo_nombre: string | null;
  alcance: "empresa" | "cliente" | "reserva" | "proveedor" | "conductor";
  cliente_id: number | null;
  reserva_id: number | null;
  proveedor_id: number | null;
  conductor_id: number | null;
  privado: boolean;
  fecha_emision: string | null;
  fecha_vencimiento: string | null;
  estado: string;
  created_at: string;
};

type Simple = {
  id: number;
  nombre: string;
};

type Reserva = {
  id: number;
  origen: string;
  destino: string;
};

export default function DocumentosPage() {
  const [documentos, setDocumentos] = useState<Documento[]>([]);
  const [clientes, setClientes] = useState<Simple[]>([]);
  const [proveedores, setProveedores] = useState<Simple[]>([]);
  const [conductores, setConductores] = useState<Simple[]>([]);
  const [reservas, setReservas] = useState<Reserva[]>([]);

  const [archivo, setArchivo] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [subiendo, setSubiendo] = useState(false);

  const [busqueda, setBusqueda] = useState("");
  const [filtroCategoria, setFiltroCategoria] = useState("todos");
  const [filtroEstado, setFiltroEstado] = useState("todos");

  const [form, setForm] = useState({
    titulo: "",
    categoria: "contrato",
    alcance: "empresa",
    cliente_id: "",
    reserva_id: "",
    proveedor_id: "",
    conductor_id: "",
    privado: true,
    fecha_emision: "",
    fecha_vencimiento: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [docsRes, clientesRes, proveedoresRes, conductoresRes, reservasRes] =
      await Promise.all([
        supabase
          .from("documentos_empresa")
          .select("*")
          .order("id", { ascending: false }),
        supabase.from("clientes").select("id, nombre").order("nombre"),
        supabase.from("proveedores").select("id, nombre").order("nombre"),
        supabase.from("conductores").select("id, nombre").order("nombre"),
        supabase.from("reservas").select("id, origen, destino").order("id", {
          ascending: false,
        }),
      ]);

    if (docsRes.error) alert(docsRes.error.message);
    else setDocumentos(docsRes.data || []);

    setClientes(clientesRes.data || []);
    setProveedores(proveedoresRes.data || []);
    setConductores(conductoresRes.data || []);
    setReservas(reservasRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const limpiarNombreArchivo = (nombre: string) => {
    return nombre
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .toLowerCase();
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

  const subirArchivo = async () => {
    if (!archivo) return { url: null, nombre: null };

    const nombreLimpio = limpiarNombreArchivo(archivo.name);
    const nombreFinal = `${Date.now()}_${nombreLimpio}`;

    const { error } = await supabase.storage
      .from("documentos")
      .upload(nombreFinal, archivo);

    if (error) {
      alert(error.message);
      return { url: null, nombre: null };
    }

    const { data } = supabase.storage
      .from("documentos")
      .getPublicUrl(nombreFinal);

    return {
      url: data.publicUrl,
      nombre: archivo.name,
    };
  };

  const guardar = async () => {
    if (!form.titulo.trim()) {
      alert("Ingresa el título del documento");
      return;
    }

    if (!archivo) {
      alert("Selecciona un archivo");
      return;
    }

    setSubiendo(true);

    const archivoSubido = await subirArchivo();

    if (!archivoSubido.url) {
      setSubiendo(false);
      return;
    }

    const estado = calcularEstado(form.fecha_vencimiento || null);

    const payload = {
      titulo: form.titulo,
      categoria: form.categoria,
      archivo_url: archivoSubido.url,
      archivo_nombre: archivoSubido.nombre,
      alcance: form.alcance,
      cliente_id:
        form.alcance === "cliente" && form.cliente_id
          ? Number(form.cliente_id)
          : null,
      reserva_id:
        form.alcance === "reserva" && form.reserva_id
          ? Number(form.reserva_id)
          : null,
      proveedor_id:
        form.alcance === "proveedor" && form.proveedor_id
          ? Number(form.proveedor_id)
          : null,
      conductor_id:
        form.alcance === "conductor" && form.conductor_id
          ? Number(form.conductor_id)
          : null,
      privado: form.privado,
      fecha_emision: form.fecha_emision || null,
      fecha_vencimiento: form.fecha_vencimiento || null,
      estado,
    };

    const { error } = await supabase.from("documentos_empresa").insert(payload);

    setSubiendo(false);

    if (error) {
      alert(error.message);
      return;
    }

    setForm({
      titulo: "",
      categoria: "contrato",
      alcance: "empresa",
      cliente_id: "",
      reserva_id: "",
      proveedor_id: "",
      conductor_id: "",
      privado: true,
      fecha_emision: "",
      fecha_vencimiento: "",
    });

    setArchivo(null);

    const inputFile = document.getElementById("archivo") as HTMLInputElement;
    if (inputFile) inputFile.value = "";

    cargarDatos();
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar documento?")) return;

    const { error } = await supabase
      .from("documentos_empresa")
      .delete()
      .eq("id", id);

    if (error) {
      alert(error.message);
      return;
    }

    cargarDatos();
  };

  const descargarArchivo = async (url: string, nombre: string | null) => {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = nombre || "documento";
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.URL.revokeObjectURL(blobUrl);
  };

  const nombreRelacionado = (doc: Documento) => {
    if (doc.alcance === "cliente") {
      return clientes.find((c) => c.id === doc.cliente_id)?.nombre || "-";
    }

    if (doc.alcance === "proveedor") {
      return proveedores.find((p) => p.id === doc.proveedor_id)?.nombre || "-";
    }

    if (doc.alcance === "conductor") {
      return conductores.find((c) => c.id === doc.conductor_id)?.nombre || "-";
    }

    if (doc.alcance === "reserva") {
      const reserva = reservas.find((r) => r.id === doc.reserva_id);
      return reserva
        ? `Reserva #${reserva.id} - ${reserva.origen} → ${reserva.destino}`
        : "-";
    }

    return "Empresa";
  };

  const documentosActualizados = useMemo(() => {
    return documentos.map((d) => ({
      ...d,
      estado: calcularEstado(d.fecha_vencimiento),
    }));
  }, [documentos]);

  const documentosFiltrados = documentosActualizados
    .filter((d) =>
      d.titulo.toLowerCase().includes(busqueda.toLowerCase())
    )
    .filter((d) =>
      filtroCategoria === "todos" ? true : d.categoria === filtroCategoria
    )
    .filter((d) => (filtroEstado === "todos" ? true : d.estado === filtroEstado));

  const vencidos = documentosActualizados.filter(
    (d) => d.estado === "vencido"
  ).length;

  const porVencer = documentosActualizados.filter(
    (d) => d.estado === "por_vencer"
  ).length;

  const privados = documentosActualizados.filter((d) => d.privado).length;

  const categorias = [
    "contrato",
    "guia_remision",
    "sst",
    "capacitacion",
    "permiso",
    "legal",
    "factura",
    "interno",
    "otro",
  ];

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Documentos Empresa</h1>
        <p className="text-gray-600">
          Gestión documental administrativa, legal, SST, contratos, guías,
          capacitaciones y permisos.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white border rounded-xl p-4 shadow">
          <p className="text-sm text-gray-500">Total documentos</p>
          <p className="text-2xl font-bold">{documentos.length}</p>
        </div>

        <div className="bg-white border rounded-xl p-4 shadow">
          <p className="text-sm text-gray-500">Por vencer</p>
          <p className="text-2xl font-bold text-yellow-600">{porVencer}</p>
        </div>

        <div className="bg-white border rounded-xl p-4 shadow">
          <p className="text-sm text-gray-500">Vencidos</p>
          <p className="text-2xl font-bold text-red-600">{vencidos}</p>
        </div>

        <div className="bg-white border rounded-xl p-4 shadow">
          <p className="text-sm text-gray-500">Privados</p>
          <p className="text-2xl font-bold">{privados}</p>
        </div>
      </section>

      <section className="bg-white border rounded-xl p-6 shadow space-y-4">
        <h2 className="text-xl font-bold">Subir nuevo documento</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            className="border rounded-lg p-3"
            placeholder="Título del documento"
            value={form.titulo}
            onChange={(e) => setForm({ ...form, titulo: e.target.value })}
          />

          <select
            className="border rounded-lg p-3"
            value={form.categoria}
            onChange={(e) => setForm({ ...form, categoria: e.target.value })}
          >
            {categorias.map((cat) => (
              <option key={cat} value={cat}>
                {cat.replace("_", " ").toUpperCase()}
              </option>
            ))}
          </select>

          <select
            className="border rounded-lg p-3"
            value={form.alcance}
            onChange={(e) =>
              setForm({
                ...form,
                alcance: e.target.value,
                cliente_id: "",
                reserva_id: "",
                proveedor_id: "",
                conductor_id: "",
              })
            }
          >
            <option value="empresa">Privado empresa / interno</option>
            <option value="cliente">Relacionado a cliente</option>
            <option value="reserva">Relacionado a reserva</option>
            <option value="proveedor">Relacionado a proveedor</option>
            <option value="conductor">Relacionado a conductor</option>
          </select>

          {form.alcance === "cliente" && (
            <select
              className="border rounded-lg p-3"
              value={form.cliente_id}
              onChange={(e) =>
                setForm({ ...form, cliente_id: e.target.value })
              }
            >
              <option value="">Seleccionar cliente</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          )}

          {form.alcance === "reserva" && (
            <select
              className="border rounded-lg p-3"
              value={form.reserva_id}
              onChange={(e) =>
                setForm({ ...form, reserva_id: e.target.value })
              }
            >
              <option value="">Seleccionar reserva</option>
              {reservas.map((r) => (
                <option key={r.id} value={r.id}>
                  Reserva #{r.id} - {r.origen} → {r.destino}
                </option>
              ))}
            </select>
          )}

          {form.alcance === "proveedor" && (
            <select
              className="border rounded-lg p-3"
              value={form.proveedor_id}
              onChange={(e) =>
                setForm({ ...form, proveedor_id: e.target.value })
              }
            >
              <option value="">Seleccionar proveedor</option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
          )}

          {form.alcance === "conductor" && (
            <select
              className="border rounded-lg p-3"
              value={form.conductor_id}
              onChange={(e) =>
                setForm({ ...form, conductor_id: e.target.value })
              }
            >
              <option value="">Seleccionar conductor</option>
              {conductores.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          )}

          <input
            type="date"
            className="border rounded-lg p-3"
            value={form.fecha_emision}
            onChange={(e) =>
              setForm({ ...form, fecha_emision: e.target.value })
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

          <label className="border rounded-lg p-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.privado}
              onChange={(e) =>
                setForm({ ...form, privado: e.target.checked })
              }
            />
            Documento privado
          </label>

          <input
            id="archivo"
            type="file"
            className="border rounded-lg p-3 md:col-span-3"
            onChange={(e) => setArchivo(e.target.files?.[0] || null)}
          />
        </div>

        <button
          onClick={guardar}
          disabled={subiendo}
          className="bg-blue-600 text-white px-6 py-3 rounded-lg font-bold disabled:bg-gray-400"
        >
          {subiendo ? "Subiendo..." : "Guardar documento"}
        </button>
      </section>

      <section className="bg-white border rounded-xl p-4 shadow space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            className="border rounded-lg p-3"
            placeholder="Buscar documento..."
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />

          <select
            className="border rounded-lg p-3"
            value={filtroCategoria}
            onChange={(e) => setFiltroCategoria(e.target.value)}
          >
            <option value="todos">Todas las categorías</option>
            {categorias.map((cat) => (
              <option key={cat} value={cat}>
                {cat.replace("_", " ").toUpperCase()}
              </option>
            ))}
          </select>

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

      {loading ? (
        <div className="bg-white border rounded-xl p-6 text-center">
          Cargando documentos...
        </div>
      ) : documentosFiltrados.length === 0 ? (
        <div className="bg-white border rounded-xl p-6 text-center text-gray-500">
          No hay documentos registrados.
        </div>
      ) : (
        <section className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
          {documentosFiltrados.map((doc) => (
            <div
              key={doc.id}
              className="bg-white border rounded-xl shadow p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-4xl">📄</div>
                  <h3 className="font-bold mt-2">{doc.titulo}</h3>
                  <p className="text-xs text-gray-500">
                    {doc.archivo_nombre || "Sin nombre de archivo"}
                  </p>
                </div>

                <span
                  className={`px-2 py-1 rounded text-xs font-bold ${
                    doc.estado === "vigente"
                      ? "bg-green-100 text-green-700"
                      : doc.estado === "por_vencer"
                      ? "bg-yellow-100 text-yellow-700"
                      : "bg-red-100 text-red-700"
                  }`}
                >
                  {doc.estado.replace("_", " ").toUpperCase()}
                </span>
              </div>

              <div className="text-sm space-y-1">
                <p>
                  <b>Categoría:</b> {doc.categoria.replace("_", " ")}
                </p>
                <p>
                  <b>Alcance:</b> {doc.alcance}
                </p>
                <p>
                  <b>Relacionado:</b> {nombreRelacionado(doc)}
                </p>
                <p>
                  <b>Privado:</b> {doc.privado ? "Sí" : "No"}
                </p>
                <p>
                  <b>Vence:</b> {doc.fecha_vencimiento || "Sin vencimiento"}
                </p>
              </div>

              <div className="flex gap-2 pt-2">
                {doc.archivo_url && (
                  <>
                    <a
                      href={doc.archivo_url}
                      target="_blank"
                      className="bg-slate-900 text-white px-3 py-2 rounded text-sm"
                    >
                      Ver
                    </a>

                    <button
                      onClick={() =>
                        descargarArchivo(doc.archivo_url!, doc.archivo_nombre)
                      }
                      className="bg-green-600 text-white px-3 py-2 rounded text-sm"
                    >
                      Descargar
                    </button>
                  </>
                )}

                <button
                  onClick={() => eliminar(doc.id)}
                  className="bg-red-600 text-white px-3 py-2 rounded text-sm"
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}