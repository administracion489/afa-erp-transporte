"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Cliente = {
  id: number;
  nombre: string;
};

type Reserva = {
  id: number;
  cliente_id: number | null;
  origen: string;
  destino: string;
  precio_cliente: number;
  estado: string;
};

type Factura = {
  id: number;
  reserva_id: number | null;
  cliente_id: number | null;
  tipo_comprobante: string;
  serie: string;
  numero: string | null;
  fecha_emision: string;
  fecha_vencimiento: string | null;
  subtotal: number;
  igv: number;
  total: number;
  estado: string;
  metodo_pago: string;
  sunat_estado: string;
  pdf_url: string | null;
  observaciones: string | null;
};

export default function FacturacionPage() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    reserva_id: "",
    tipo_comprobante: "factura",
    serie: "F001",
    numero: "",
    fecha_emision: "",
    fecha_vencimiento: "",
    subtotal: "",
    estado: "pendiente",
    metodo_pago: "pendiente",
    observaciones: "",
  });

  const cargarDatos = async () => {
    setLoading(true);

    const [clientesRes, reservasRes, facturasRes] = await Promise.all([
      supabase.from("clientes").select("id, nombre").order("nombre"),
      supabase.from("reservas").select("*").order("id", { ascending: false }),
      supabase.from("facturas").select("*").order("id", { ascending: false }),
    ]);

    if (clientesRes.error) alert(clientesRes.error.message);
    else setClientes(clientesRes.data || []);

    if (reservasRes.error) alert(reservasRes.error.message);
    else setReservas(reservasRes.data || []);

    if (facturasRes.error) alert(facturasRes.error.message);
    else setFacturas(facturasRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const nombreCliente = (id: number | null) =>
    clientes.find((c) => c.id === id)?.nombre || "Sin cliente";

  const reservaTexto = (reserva: Reserva) =>
    `#${reserva.id} - ${reserva.origen} → ${reserva.destino} - S/ ${Number(
      reserva.precio_cliente || 0
    ).toFixed(2)}`;

  const seleccionarReserva = (id: string) => {
    const reserva = reservas.find((r) => r.id === Number(id));

    setForm({
      ...form,
      reserva_id: id,
      subtotal: reserva ? String(Number(reserva.precio_cliente || 0) / 1.18) : "",
    });
  };

  const guardarFactura = async () => {
    if (!form.reserva_id) {
      alert("Selecciona una reserva");
      return;
    }

    if (!form.fecha_emision) {
      alert("Selecciona fecha de emisión");
      return;
    }

    if (!form.subtotal || Number(form.subtotal) <= 0) {
      alert("Ingresa subtotal válido");
      return;
    }

    const reserva = reservas.find((r) => r.id === Number(form.reserva_id));

    if (!reserva) {
      alert("Reserva no encontrada");
      return;
    }

    const subtotal = Number(form.subtotal);
    const igv = subtotal * 0.18;

    const { error } = await supabase.from("facturas").insert({
      reserva_id: reserva.id,
      cliente_id: reserva.cliente_id,
      tipo_comprobante: form.tipo_comprobante,
      serie: form.serie,
      numero: form.numero || null,
      fecha_emision: form.fecha_emision,
      fecha_vencimiento: form.fecha_vencimiento || null,
      subtotal,
      igv,
      estado: form.estado,
      metodo_pago: form.metodo_pago,
      sunat_estado: "pendiente",
      observaciones: form.observaciones || null,
    });

    if (error) {
      alert(error.message);
      return;
    }

    setForm({
      reserva_id: "",
      tipo_comprobante: "factura",
      serie: "F001",
      numero: "",
      fecha_emision: "",
      fecha_vencimiento: "",
      subtotal: "",
      estado: "pendiente",
      metodo_pago: "pendiente",
      observaciones: "",
    });

    cargarDatos();
  };

  const cambiarEstado = async (id: number, estado: string) => {
    const { error } = await supabase
      .from("facturas")
      .update({ estado })
      .eq("id", id);

    if (error) alert(error.message);
    else cargarDatos();
  };

  const eliminarFactura = async (id: number) => {
    if (!confirm("¿Eliminar comprobante?")) return;

    const { error } = await supabase.from("facturas").delete().eq("id", id);

    if (error) alert(error.message);
    else cargarDatos();
  };

  const totalFacturado = facturas.reduce(
    (sum, f) => sum + Number(f.total || 0),
    0
  );

  const pendientes = facturas.filter((f) => f.estado === "pendiente").length;
  const pagadas = facturas.filter((f) => f.estado === "pagada").length;

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Facturación</h1>
        <p className="text-gray-600">
          Emisión de comprobantes desde reservas. SUNAT API queda preparada para integración futura.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Comprobantes</p>
          <p className="text-2xl font-bold">{facturas.length}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Total facturado</p>
          <p className="text-2xl font-bold text-green-600">
            S/ {totalFacturado.toFixed(2)}
          </p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Pendientes</p>
          <p className="text-2xl font-bold text-yellow-600">{pendientes}</p>
        </div>

        <div className="bg-white rounded-xl border shadow p-4">
          <p className="text-sm text-gray-500">Pagadas</p>
          <p className="text-2xl font-bold text-blue-600">{pagadas}</p>
        </div>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 space-y-4">
        <h2 className="text-xl font-bold">Nuevo comprobante</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <select
            className="border rounded-lg p-3"
            value={form.reserva_id}
            onChange={(e) => seleccionarReserva(e.target.value)}
          >
            <option value="">Seleccionar reserva</option>
            {reservas.map((r) => (
              <option key={r.id} value={r.id}>
                {reservaTexto(r)}
              </option>
            ))}
          </select>

          <select
            className="border rounded-lg p-3"
            value={form.tipo_comprobante}
            onChange={(e) =>
              setForm({ ...form, tipo_comprobante: e.target.value })
            }
          >
            <option value="factura">Factura</option>
            <option value="boleta">Boleta</option>
            <option value="nota_credito">Nota de crédito</option>
          </select>

          <input
            className="border rounded-lg p-3"
            placeholder="Serie"
            value={form.serie}
            onChange={(e) => setForm({ ...form, serie: e.target.value })}
          />

          <input
            className="border rounded-lg p-3"
            placeholder="Número"
            value={form.numero}
            onChange={(e) => setForm({ ...form, numero: e.target.value })}
          />

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

          <input
            type="number"
            className="border rounded-lg p-3"
            placeholder="Subtotal sin IGV"
            value={form.subtotal}
            onChange={(e) => setForm({ ...form, subtotal: e.target.value })}
          />

          <select
            className="border rounded-lg p-3"
            value={form.estado}
            onChange={(e) => setForm({ ...form, estado: e.target.value })}
          >
            <option value="pendiente">Pendiente</option>
            <option value="emitida">Emitida</option>
            <option value="enviada">Enviada</option>
            <option value="aceptada">Aceptada</option>
            <option value="rechazada">Rechazada</option>
            <option value="anulada">Anulada</option>
            <option value="pagada">Pagada</option>
          </select>

          <select
            className="border rounded-lg p-3"
            value={form.metodo_pago}
            onChange={(e) =>
              setForm({ ...form, metodo_pago: e.target.value })
            }
          >
            <option value="pendiente">Pago pendiente</option>
            <option value="efectivo">Efectivo</option>
            <option value="transferencia">Transferencia</option>
            <option value="yape">Yape</option>
            <option value="plin">Plin</option>
            <option value="tarjeta">Tarjeta</option>
          </select>

          <input
            className="border rounded-lg p-3 md:col-span-3"
            placeholder="Observaciones"
            value={form.observaciones}
            onChange={(e) =>
              setForm({ ...form, observaciones: e.target.value })
            }
          />
        </div>

        <button
          onClick={guardarFactura}
          className="bg-slate-900 text-white px-6 py-3 rounded-lg font-bold"
        >
          Guardar comprobante
        </button>
      </section>

      <section className="bg-white rounded-xl border shadow p-6 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">Comprobantes emitidos</h2>

        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Comprobante</th>
              <th className="p-3 text-left">Cliente</th>
              <th className="p-3 text-left">Reserva</th>
              <th className="p-3 text-left">Emisión</th>
              <th className="p-3 text-left">Subtotal</th>
              <th className="p-3 text-left">IGV</th>
              <th className="p-3 text-left">Total</th>
              <th className="p-3 text-left">Estado</th>
              <th className="p-3 text-left">Pago</th>
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
            ) : facturas.length === 0 ? (
              <tr>
                <td colSpan={10} className="p-5 text-center">
                  No hay comprobantes registrados.
                </td>
              </tr>
            ) : (
              facturas.map((f) => (
                <tr key={f.id} className="border-t">
                  <td className="p-3 font-bold">
                    {f.tipo_comprobante.toUpperCase()} {f.serie}-{f.numero || f.id}
                  </td>

                  <td className="p-3">{nombreCliente(f.cliente_id)}</td>

                  <td className="p-3">Reserva #{f.reserva_id || "-"}</td>

                  <td className="p-3">{f.fecha_emision}</td>

                  <td className="p-3">
                    S/ {Number(f.subtotal || 0).toFixed(2)}
                  </td>

                  <td className="p-3">
                    S/ {Number(f.igv || 0).toFixed(2)}
                  </td>

                  <td className="p-3 font-bold text-green-600">
                    S/ {Number(f.total || 0).toFixed(2)}
                  </td>

                  <td className="p-3">
                    <select
                      className="border rounded p-1"
                      value={f.estado}
                      onChange={(e) => cambiarEstado(f.id, e.target.value)}
                    >
                      <option value="pendiente">Pendiente</option>
                      <option value="emitida">Emitida</option>
                      <option value="enviada">Enviada</option>
                      <option value="aceptada">Aceptada</option>
                      <option value="rechazada">Rechazada</option>
                      <option value="anulada">Anulada</option>
                      <option value="pagada">Pagada</option>
                    </select>
                  </td>

                  <td className="p-3">{f.metodo_pago}</td>

                  <td className="p-3 text-right">
                    <button
                      onClick={() => eliminarFactura(f.id)}
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