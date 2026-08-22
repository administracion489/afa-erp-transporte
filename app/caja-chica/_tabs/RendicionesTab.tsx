"use client";

// Bandeja de rendiciones. Lee la VISTA v_caja_chica_rendiciones (no la tabla): los
// derivados —rendido, saldo, comprobantes, atrasada, días de atraso— se calculan en
// Postgres y ninguna pantalla los recalcula por su cuenta.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import {
  ESTADOS_RENDICION,
  ESTADOS_REVISION,
  configCategoriaCC,
  configRendicion,
  cuadra,
  type GastoCajaChica,
  type RendicionCajaChica,
} from "@/lib/finanzas/caja-chica";
import { exportarXlsx, type Columna } from "@/lib/finanzas/exportar";
import { PERFILES_CAJA_CHICA } from "@/lib/importador/perfiles-finanzas";
import ImportadorFinanzas from "@/app/_components/ImportadorFinanzas";
import ModalEntrega from "../ModalEntrega";
import ModalRendicion from "../ModalRendicion";

type Props = { onCambio: () => void };

type VehiculoRef = { id: number; placa: string };

const CABECERAS = [
  "",
  "Código",
  "Responsable",
  "Vehículo",
  "Entrega",
  "Límite",
  "Asignado",
  "Rendido",
  "Saldo",
  "Compr.",
  "Estado",
  "Acciones",
];

function fmtFecha(f: string | null | undefined): string {
  if (!f) return "—";
  // Sin el sufijo T00:00:00 la fecha civil se corre un día por UTC-5.
  return new Date(f.slice(0, 10) + "T00:00:00").toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function etiquetaMes(m: string): string {
  const d = new Date(m + "-01T00:00:00");
  return d.toLocaleDateString("es-PE", { month: "long", year: "numeric" });
}

/**
 * El bucket "comprobantes" es PRIVADO: `foto_url` guarda la RUTA dentro del bucket y
 * solo se ve con una URL firmada. Las filas heredadas pueden traer una URL absoluta.
 */
async function urlFirmada(ruta: string | null | undefined): Promise<string | null> {
  if (!ruta) return null;
  if (/^https?:\/\//i.test(ruta)) return ruta;
  const { data } = await supabase.storage.from("comprobantes").createSignedUrl(ruta, 3600);
  return data?.signedUrl ?? null;
}

export default function RendicionesTab({ onCambio }: Props) {
  const [rendiciones, setRendiciones] = useState<RendicionCajaChica[]>([]);
  const [placas, setPlacas] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [estado, setEstado] = useState("");
  const [mes, setMes] = useState("");
  const [soloAtrasadas, setSoloAtrasadas] = useState(false);

  const [expandida, setExpandida] = useState<number | null>(null);
  const [gastos, setGastos] = useState<GastoCajaChica[]>([]);
  const [fotos, setFotos] = useState<Record<number, string>>({});
  const [cargandoGastos, setCargandoGastos] = useState(false);

  const [entregando, setEntregando] = useState(false);
  const [importando, setImportando] = useState(false);
  const [revisando, setRevisando] = useState<number | null>(null);
  const [puedeAprobar, setPuedeAprobar] = useState(false);
  const [usuarioNombre, setUsuarioNombre] = useState("");

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    const [rs, vs] = await Promise.all([
      supabase.from("v_caja_chica_rendiciones").select("*").order("fecha_entrega", { ascending: false }).order("id", { ascending: false }),
      supabase.from("vehiculos").select("id, placa"),
    ]);
    setRendiciones((rs.data ?? []) as RendicionCajaChica[]);
    const mapa: Record<number, string> = {};
    for (const v of (vs.data ?? []) as VehiculoRef[]) mapa[v.id] = v.placa;
    setPlacas(mapa);
    setLoading(false);
  }, []);

  // Carga inicial (patrón de todo el ERP). La regla del linter apunta a otro caso
  // —setState síncrono en el cuerpo del efecto—; aquí se escribe tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  // El rol decide si el botón "Revisar" puede llegar a aprobar. No se usa usePermiso:
  // no contempla admin y expulsaría a un admin sin fila en permisos_usuario.
  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user?.id) return;
      const { data } = await supabase.from("usuarios").select("nombre, rol").eq("id", session.user.id).maybeSingle();
      setUsuarioNombre(String(data?.nombre ?? ""));
      setPuedeAprobar(data?.rol === "admin" || data?.rol === "gerente");
    })();
  }, []);

  const meses = useMemo(() => {
    const set = new Set<string>();
    for (const r of rendiciones) if (r.fecha_entrega) set.add(r.fecha_entrega.slice(0, 7));
    return Array.from(set).sort().reverse();
  }, [rendiciones]);

  const filtradas = useMemo(() => {
    const texto = q.trim().toLowerCase();
    return rendiciones.filter((r) => {
      if (estado && r.estado !== estado) return false;
      if (mes && (r.fecha_entrega ?? "").slice(0, 7) !== mes) return false;
      if (soloAtrasadas && !r.atrasada) return false;
      if (!texto) return true;
      return (
        (r.responsable_nombre ?? "").toLowerCase().includes(texto) ||
        (r.codigo ?? "").toLowerCase().includes(texto) ||
        (r.fondo_nombre ?? "").toLowerCase().includes(texto)
      );
    });
  }, [rendiciones, q, estado, mes, soloAtrasadas]);

  const totalFiltrado = useMemo(
    () => filtradas.reduce((s, r) => s + Number(r.saldo_pendiente ?? 0), 0),
    [filtradas]
  );

  const cargarGastos = useCallback(async (id: number) => {
    setCargandoGastos(true);
    setGastos([]);
    setFotos({});
    const { data } = await supabase.from("caja_chica_gastos").select("*").eq("rendicion_id", id).order("fecha").order("id");
    const filas = (data ?? []) as GastoCajaChica[];
    setGastos(filas);

    const pares = await Promise.all(
      filas.filter((g) => g.foto_url).map(async (g) => [g.id, await urlFirmada(g.foto_url)] as const)
    );
    const mapa: Record<number, string> = {};
    for (const [gid, url] of pares) if (url) mapa[gid] = url;
    setFotos(mapa);
    setCargandoGastos(false);
  }, []);

  const alternarFila = useCallback(
    async (id: number) => {
      if (expandida === id) {
        setExpandida(null);
        return;
      }
      setExpandida(id);
      await cargarGastos(id);
    },
    [expandida, cargarGastos]
  );

  /**
   * Cerrar el modal de revisión deja la fila desplegada mostrando los chips viejos
   * (pendiente/aprobado) de los comprobantes que se acaban de decidir: si es la misma
   * rendición, se releen sus gastos junto con la bandeja.
   */
  const refrescarTras = useCallback(
    (id: number) => {
      cargar();
      if (expandida === id) cargarGastos(id);
      onCambio();
    },
    [cargar, cargarGastos, expandida, onCambio]
  );

  function colorSaldo(r: RendicionCajaChica): string {
    if (cuadra(r)) return "text-emerald-700";
    return Number(r.saldo_pendiente) > 0 ? "text-amber-700" : "text-red-700";
  }

  async function exportar() {
    const columnas: Columna<RendicionCajaChica>[] = [
      { titulo: "Código", valor: (r) => r.codigo ?? "" },
      { titulo: "Responsable", valor: (r) => r.responsable_nombre ?? "" },
      { titulo: "Fondo", valor: (r) => r.fondo_nombre ?? "" },
      { titulo: "Vehículo", valor: (r) => (r.vehiculo_id ? placas[r.vehiculo_id] ?? "" : "") },
      { titulo: "Entrega", valor: (r) => r.fecha_entrega, tipo: "fecha" },
      { titulo: "Límite", valor: (r) => r.fecha_limite ?? "", tipo: "fecha" },
      { titulo: "Días de atraso", valor: (r) => (r.atrasada ? Number(r.dias_atraso ?? 0) : 0), tipo: "entero" },
      { titulo: "Asignado", valor: (r) => Number(r.monto_asignado ?? 0), tipo: "monto" },
      { titulo: "Rendido", valor: (r) => Number(r.monto_rendido ?? 0), tipo: "monto" },
      { titulo: "Devuelto", valor: (r) => Number(r.monto_devuelto ?? 0), tipo: "monto" },
      { titulo: "Saldo", valor: (r) => Number(r.saldo_pendiente ?? 0), tipo: "monto" },
      { titulo: "Comprobantes", valor: (r) => Number(r.comprobantes ?? 0), tipo: "entero" },
      { titulo: "Estado", valor: (r) => configRendicion(r.estado).label },
    ];
    await exportarXlsx(filtradas, columnas, {
      nombre: "caja_chica_rendiciones",
      hoja: "Rendiciones",
      titulo: "Caja chica · Rendiciones",
      subtitulo: [
        estado ? `Estado: ${configRendicion(estado).label}` : "Todos los estados",
        mes ? etiquetaMes(mes) : "Todos los meses",
        soloAtrasadas ? "Solo atrasadas" : null,
        `${filtradas.length} registro(s)`,
      ]
        .filter(Boolean)
        .join(" · "),
      totales: true,
    });
  }

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Rendiciones</h1>
          <p className="text-gray-400 text-sm mt-1">
            Entregas a rendir · Saldo pendiente por responsable · Comprobantes con foto
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setImportando(true)}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}
          >
            📥 Importar histórico
          </button>
          <button
            onClick={exportar}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}
          >
            📤 Exportar
          </button>
          <button
            onClick={() => setEntregando(true)}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: "#0b315f" }}
          >
            + Entregar dinero
          </button>
        </div>
      </div>

      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input
            className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por responsable o código…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={estado} onChange={(e) => setEstado(e.target.value)}>
          <option value="">Todos los estados</option>
          {Object.entries(ESTADOS_RENDICION).map(([k, cfg]) => (
            <option key={k} value={k}>
              {cfg.label}
            </option>
          ))}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={mes} onChange={(e) => setMes(e.target.value)}>
          <option value="">Todos los meses</option>
          {meses.map((m) => (
            <option key={m} value={m}>
              {etiquetaMes(m)}
            </option>
          ))}
        </select>
        <button
          onClick={() => setSoloAtrasadas((v) => !v)}
          className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all"
          style={{
            background: soloAtrasadas ? "#fee2e2" : "white",
            borderColor: soloAtrasadas ? "#991b1b22" : "#e2e8f0",
            color: soloAtrasadas ? "#991b1b" : "#9ca3af",
          }}
        >
          ⏰ Solo atrasadas
        </button>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
          {filtradas.length} resultados
        </div>
      </section>

      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {CABECERAS.map((h, i) => (
                  <th
                    key={h || `c${i}`}
                    className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                      Cargando…
                    </div>
                  </td>
                </tr>
              )}

              {!loading && filtradas.length === 0 && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">🧾</p>
                    <p>No hay rendiciones con estos filtros</p>
                  </td>
                </tr>
              )}

              {!loading &&
                filtradas.map((r) => {
                  const cfg = configRendicion(r.estado);
                  const abierta = expandida === r.id;
                  return (
                    <React.Fragment key={r.id}>
                      <tr className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                        <td className="p-3">
                          <button
                            onClick={() => alternarFila(r.id)}
                            className="w-7 h-7 rounded-lg border text-xs font-bold text-gray-500 hover:bg-gray-100"
                            title={abierta ? "Ocultar comprobantes" : "Ver comprobantes"}
                          >
                            {abierta ? "▾" : "▸"}
                          </button>
                        </td>
                        <td className="p-3 font-mono font-black text-xs text-[#0b315f]">{r.codigo ?? "—"}</td>
                        <td className="p-3 text-xs text-gray-600 font-medium">
                          {r.responsable_nombre}
                          <span className="block text-[10px] text-gray-400">{r.fondo_nombre}</span>
                        </td>
                        <td className="p-3 font-mono font-black text-xs text-[#0b315f]">
                          {r.vehiculo_id ? placas[r.vehiculo_id] ?? "—" : "—"}
                        </td>
                        <td className="p-3 text-xs text-gray-600 font-medium">{fmtFecha(r.fecha_entrega)}</td>
                        <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">
                          {fmtFecha(r.fecha_limite)}
                          {r.atrasada && (
                            <span
                              className="ml-2 text-xs font-bold px-2.5 py-1 rounded-lg"
                              style={{ background: "#fee2e2", color: "#991b1b" }}
                            >
                              Vencida hace {Number(r.dias_atraso ?? 0)} día{Number(r.dias_atraso ?? 0) === 1 ? "" : "s"}
                            </span>
                          )}
                        </td>
                        <td className="p-3 font-black text-xs text-[#0b315f]">{fmtMoneda(Number(r.monto_asignado), r.moneda)}</td>
                        <td className="p-3 font-black text-xs text-red-700">{fmtMoneda(Number(r.monto_rendido), r.moneda)}</td>
                        <td className={`p-3 font-black text-xs ${colorSaldo(r)}`}>{fmtMoneda(Number(r.saldo_pendiente), r.moneda)}</td>
                        <td className="p-3 text-xs text-gray-600 font-medium">{Number(r.comprobantes ?? 0)}</td>
                        <td className="p-3">
                          <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: cfg.bg, color: cfg.color }}>
                            {cfg.label}
                          </span>
                        </td>
                        <td className="p-3">
                          <button
                            onClick={() => setRevisando(r.id)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                          >
                            Revisar
                          </button>
                        </td>
                      </tr>

                      {abierta && (
                        <tr style={{ background: "#f8fafc" }}>
                          <td colSpan={CABECERAS.length} className="p-4">
                            {cargandoGastos && (
                              <div className="flex items-center justify-center gap-2 text-gray-400 py-6">
                                <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                                Cargando comprobantes…
                              </div>
                            )}

                            {!cargandoGastos && gastos.length === 0 && (
                              <div className="text-center text-gray-400 py-6">
                                <p className="text-3xl mb-2">📭</p>
                                <p>Esta rendición aún no tiene comprobantes</p>
                              </div>
                            )}

                            {!cargandoGastos && gastos.length > 0 && (
                              <div className="space-y-2">
                                {gastos.map((g) => {
                                  const cat = configCategoriaCC(g.categoria);
                                  const rev = ESTADOS_REVISION[g.estado_revision] ?? ESTADOS_REVISION.pendiente;
                                  return (
                                    <div
                                      key={g.id}
                                      className="bg-white rounded-xl border p-3 flex items-center gap-3 flex-wrap"
                                      style={{ borderColor: "#e2e8f0" }}
                                    >
                                      {fotos[g.id] ? (
                                        <a href={fotos[g.id]} target="_blank" rel="noreferrer" className="shrink-0">
                                          {/* eslint-disable-next-line @next/next/no-img-element */}
                                          <img
                                            src={fotos[g.id]}
                                            alt={`Comprobante ${g.id}`}
                                            className="w-14 h-14 object-cover rounded-lg border"
                                            style={{ borderColor: "#e2e8f0" }}
                                          />
                                        </a>
                                      ) : (
                                        <div
                                          className="w-14 h-14 rounded-lg border flex items-center justify-center text-gray-300 shrink-0"
                                          style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}
                                        >
                                          📷
                                        </div>
                                      )}
                                      <span className="text-xs text-gray-600 font-medium w-24 shrink-0">{fmtFecha(g.fecha)}</span>
                                      <span
                                        className="text-xs font-bold px-2.5 py-1 rounded-lg shrink-0"
                                        style={{ background: cat.bg, color: cat.color }}
                                      >
                                        {cat.emoji} {cat.label}
                                      </span>
                                      <span className="text-xs text-gray-600 flex-1 min-w-[140px]">
                                        {g.descripcion || "Sin descripción"}
                                        {g.motivo_rechazo && (
                                          <span className="block text-[11px] text-red-700 font-medium">Rechazado: {g.motivo_rechazo}</span>
                                        )}
                                      </span>
                                      <span className="font-black text-xs text-red-700 w-28 text-right shrink-0">
                                        {fmtMoneda(Number(g.monto), g.moneda)}
                                      </span>
                                      <span
                                        className="text-xs font-bold px-2.5 py-1 rounded-lg shrink-0"
                                        style={{ background: rev.bg, color: rev.color }}
                                      >
                                        {rev.label}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>{filtradas.length} de {rendiciones.length} rendiciones</span>
          <span>Saldo pendiente filtrado: {fmtMoneda(totalFiltrado)}</span>
        </div>
      </section>

      {entregando && (
        <ModalEntrega
          onCerrar={() => setEntregando(false)}
          onListo={(msg) => {
            setEntregando(false);
            showToast(msg);
            cargar();
            onCambio();
          }}
        />
      )}

      {revisando !== null && (
        <ModalRendicion
          rendicionId={revisando}
          puedeAprobar={puedeAprobar}
          usuarioNombre={usuarioNombre}
          onCerrar={() => {
            const id = revisando;
            setRevisando(null);
            refrescarTras(id);
          }}
          onListo={(msg) => {
            const id = revisando;
            setRevisando(null);
            showToast(msg);
            refrescarTras(id);
          }}
        />
      )}

      <ImportadorFinanzas
        abierto={importando}
        onCerrar={() => setImportando(false)}
        perfiles={PERFILES_CAJA_CHICA}
        titulo="Importar histórico de caja chica"
        descripcion="Cada responsable se agrupa en una rendición histórica ya liquidada. Si aún no tiene fondo, se le crea uno."
        plantilla={{
          cabeceras: ["Responsable", "Fecha", "Categoría", "Descripción", "Monto", "Placa", "RUC", "Nº comprobante", "Moneda", "Observaciones"],
          ejemplos: [["Juan Pérez", "05/03/2026", "peaje", "Peaje Serpentín", 12.5, "ABC-123", "", "B001-0001234", "PEN", ""]],
          instrucciones: [
            "Una fila por comprobante, no por rendición.",
            "La categoría debe ser una de: peaje, lavado, estacionamiento, viáticos, movilidad, repuesto menor, combustible, trámite, multa, otro.",
            "Los gastos se agrupan por responsable: cada grupo se registra como una rendición histórica liquidada.",
          ],
        }}
        onImportado={(resumen) => {
          // NO se cierra el modal aquí: el paso 3 del importador es donde se ven los
          // KPIs del resultado, las incidencias del servidor y el botón de descargar
          // rechazos. Cerrarlo al terminar los haría desaparecer sin que nadie los lea.
          // El propio modal se cierra con su botón "Cerrar".
          showToast(
            `Histórico importado · ${resumen.creadas} creada(s)${resumen.errores.length ? ` · ${resumen.errores.length} con error` : ""}`,
            resumen.errores.length === 0
          );
          cargar();
          onCambio();
        }}
      />

      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white ${
            toast.ok ? "bg-[#0b315f]" : "bg-red-600"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </main>
  );
}
