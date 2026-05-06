"use client";

import { useMemo, useState } from "react";

type EstadoMulta = "Pendiente" | "Pagada" | "Impugnada" | "Vencida";
type Severidad = "Leve" | "Grave" | "Muy grave";

type Multa = {
  id: string;
  placa: string;
  conductor: string;
  entidad: string;
  infraccion: string;
  fecha: string;
  vencimiento: string;
  monto: number;
  estado: EstadoMulta;
  severidad: Severidad;
  puntos: number;
  ubicacion: string;
};

const multasIniciales: Multa[] = [
  {
    id: "M-2026-001",
    placa: "B7X-942",
    conductor: "Carlos Ramírez",
    entidad: "SAT Lima",
    infraccion: "Exceso de velocidad",
    fecha: "2026-05-01",
    vencimiento: "2026-05-20",
    monto: 412,
    estado: "Pendiente",
    severidad: "Grave",
    puntos: 20,
    ubicacion: "Av. Javier Prado, Lima",
  },
  {
    id: "M-2026-002",
    placa: "V9P-321",
    conductor: "Miguel Torres",
    entidad: "SUTRAN",
    infraccion: "No respetar control de ruta",
    fecha: "2026-04-28",
    vencimiento: "2026-05-10",
    monto: 824,
    estado: "Vencida",
    severidad: "Muy grave",
    puntos: 50,
    ubicacion: "Panamericana Sur",
  },
  {
    id: "M-2026-003",
    placa: "AFA-108",
    conductor: "Luis Mendoza",
    entidad: "Municipalidad Provincial",
    infraccion: "Estacionamiento en zona rígida",
    fecha: "2026-05-03",
    vencimiento: "2026-05-25",
    monto: 206,
    estado: "Pagada",
    severidad: "Leve",
    puntos: 5,
    ubicacion: "Centro histórico",
  },
];

const estadoColor: Record<EstadoMulta, string> = {
  Pendiente: "bg-yellow-100 text-yellow-800 border-yellow-300",
  Pagada: "bg-green-100 text-green-800 border-green-300",
  Impugnada: "bg-blue-100 text-blue-800 border-blue-300",
  Vencida: "bg-red-100 text-red-800 border-red-300",
};

const severidadColor: Record<Severidad, string> = {
  Leve: "bg-gray-100 text-gray-700",
  Grave: "bg-orange-100 text-orange-700",
  "Muy grave": "bg-red-100 text-red-700",
};

export default function MultasPage() {
  const [busqueda, setBusqueda] = useState("");
  const [estado, setEstado] = useState<"Todos" | EstadoMulta>("Todos");
  const [multas] = useState<Multa[]>(multasIniciales);

  const multasFiltradas = useMemo(() => {
    return multas.filter((multa) => {
      const texto = `${multa.placa} ${multa.conductor} ${multa.entidad} ${multa.infraccion} ${multa.ubicacion}`.toLowerCase();

      const coincideBusqueda = texto.includes(busqueda.toLowerCase());
      const coincideEstado = estado === "Todos" || multa.estado === estado;

      return coincideBusqueda && coincideEstado;
    });
  }, [busqueda, estado, multas]);

  const totalPendiente = multas
    .filter((m) => m.estado === "Pendiente" || m.estado === "Vencida")
    .reduce((sum, m) => sum + m.monto, 0);

  const totalPagado = multas
    .filter((m) => m.estado === "Pagada")
    .reduce((sum, m) => sum + m.monto, 0);

  const multasVencidas = multas.filter((m) => m.estado === "Vencida").length;

  return (
    <main className="min-h-screen bg-slate-50 p-6 space-y-6">
      <section className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-blue-700">
          ERP Transporte Perú
        </p>
        <h1 className="text-3xl font-bold text-slate-900">
          Gestión Inteligente de Multas
        </h1>
        <p className="text-slate-600 max-w-3xl">
          Control de infracciones vehiculares, conductores, placas, entidades,
          vencimientos, pagos, impugnaciones y riesgo operativo para flotas de
          transporte.
        </p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card titulo="Multas registradas" valor={multas.length.toString()} />
        <Card titulo="Pendiente por pagar" valor={`S/ ${totalPendiente.toFixed(2)}`} />
        <Card titulo="Pagado" valor={`S/ ${totalPagado.toFixed(2)}`} />
        <Card titulo="Vencidas" valor={multasVencidas.toString()} alerta />
      </section>

      <section className="bg-white border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              Registro de multas
            </h2>
            <p className="text-sm text-slate-500">
              Busca por placa, conductor, entidad, infracción o ubicación.
            </p>
          </div>

          <div className="flex flex-col md:flex-row gap-3">
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar multa..."
              className="border rounded-xl px-4 py-2 w-full md:w-72 outline-none focus:ring-2 focus:ring-blue-500"
            />

            <select
              value={estado}
              onChange={(e) => setEstado(e.target.value as "Todos" | EstadoMulta)}
              className="border rounded-xl px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option>Todos</option>
              <option>Pendiente</option>
              <option>Pagada</option>
              <option>Impugnada</option>
              <option>Vencida</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-100 text-slate-700">
                <th className="text-left p-3">Código</th>
                <th className="text-left p-3">Placa</th>
                <th className="text-left p-3">Conductor</th>
                <th className="text-left p-3">Entidad</th>
                <th className="text-left p-3">Infracción</th>
                <th className="text-left p-3">Monto</th>
                <th className="text-left p-3">Estado</th>
                <th className="text-left p-3">Riesgo</th>
              </tr>
            </thead>

            <tbody>
              {multasFiltradas.map((multa) => (
                <tr key={multa.id} className="border-b hover:bg-slate-50">
                  <td className="p-3 font-medium">{multa.id}</td>
                  <td className="p-3 font-bold">{multa.placa}</td>
                  <td className="p-3">{multa.conductor}</td>
                  <td className="p-3">{multa.entidad}</td>
                  <td className="p-3">
                    <div className="font-medium">{multa.infraccion}</div>
                    <div className="text-xs text-slate-500">
                      {multa.ubicacion} · Vence: {multa.vencimiento}
                    </div>
                  </td>
                  <td className="p-3 font-semibold">S/ {multa.monto.toFixed(2)}</td>
                  <td className="p-3">
                    <span
                      className={`px-3 py-1 rounded-full border text-xs font-semibold ${estadoColor[multa.estado]}`}
                    >
                      {multa.estado}
                    </span>
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${severidadColor[multa.severidad]}`}
                    >
                      {multa.severidad} · {multa.puntos} pts
                    </span>
                  </td>
                </tr>
              ))}

              {multasFiltradas.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500">
                    No se encontraron multas con esos filtros.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel
          titulo="Alertas operativas"
          items={[
            "Verificar multas vencidas antes de asignar servicios.",
            "Priorizar unidades con infracciones muy graves.",
            "Cruzar multas con mantenimiento, conductor y liquidación.",
          ]}
        />

        <Panel
          titulo="Adaptado a Perú"
          items={[
            "Control por SAT, SUTRAN y municipalidades.",
            "Montos en soles y vencimientos por infracción.",
            "Puntos del conductor para gestión preventiva.",
          ]}
        />

        <Panel
          titulo="Próximas mejoras"
          items={[
            "Conexión con Supabase.",
            "Carga de papeletas PDF o imagen.",
            "Reportes por placa, conductor, ruta y cliente.",
          ]}
        />
      </section>
    </main>
  );
}

function Card({
  titulo,
  valor,
  alerta = false,
}: {
  titulo: string;
  valor: string;
  alerta?: boolean;
}) {
  return (
    <div className="bg-white border rounded-2xl p-5 shadow-sm">
      <p className="text-sm text-slate-500">{titulo}</p>
      <p className={`text-2xl font-bold ${alerta ? "text-red-600" : "text-slate-900"}`}>
        {valor}
      </p>
    </div>
  );
}

function Panel({ titulo, items }: { titulo: string; items: string[] }) {
  return (
    <div className="bg-white border rounded-2xl p-5 shadow-sm">
      <h3 className="font-bold text-slate-900 mb-3">{titulo}</h3>
      <ul className="space-y-2 text-sm text-slate-600">
        {items.map((item) => (
          <li key={item}>• {item}</li>
        ))}
      </ul>
    </div>
  );
}