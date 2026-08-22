"use client";

// Revisión de una rendición, comprobante por comprobante.
//
// El módulo existe justamente para que nadie apruebe "en bloque" sin mirar: por eso
// cada foto se revisa por separado y `aprobarRendicion` rechaza el cierre mientras
// quede un comprobante pendiente. Aquí ese error se muestra como banner, no como
// alert, para que el revisor vea qué le falta sin perder el contexto.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import {
  ESTADOS_REVISION,
  aprobarRendicion,
  configCategoriaCC,
  configRendicion,
  cuadra,
  observarRendicion,
  revisarGasto,
  type GastoCajaChica,
  type RendicionCajaChica,
} from "@/lib/finanzas/caja-chica";

type Props = {
  rendicionId: number;
  puedeAprobar: boolean;
  usuarioNombre: string;
  onCerrar: () => void;
  /** Cierre definitivo (liquidada u observada): el padre refresca y avisa. */
  onListo: (mensaje: string) => void;
};

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

function fmtFecha(f: string | null | undefined): string {
  if (!f) return "—";
  // El sufijo T00:00:00 es obligatorio: sin él la fecha civil se corre un día por UTC-5.
  return new Date(f.slice(0, 10) + "T00:00:00").toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * El bucket "comprobantes" es PRIVADO: la foto solo se ve con una URL firmada.
 * `foto_url` guarda la RUTA dentro del bucket; las filas importadas de sistemas
 * viejos pueden traer una URL absoluta, y esas se usan tal cual.
 */
async function urlFirmada(ruta: string | null | undefined): Promise<string | null> {
  if (!ruta) return null;
  if (/^https?:\/\//i.test(ruta)) return ruta;
  const { data } = await supabase.storage.from("comprobantes").createSignedUrl(ruta, 3600);
  return data?.signedUrl ?? null;
}

export default function ModalRendicion({ rendicionId, puedeAprobar, usuarioNombre, onCerrar, onListo }: Props) {
  const [rendicion, setRendicion] = useState<RendicionCajaChica | null>(null);
  const [gastos, setGastos] = useState<GastoCajaChica[]>([]);
  const [fotos, setFotos] = useState<Record<number, string>>({});
  const [cargando, setCargando] = useState(true);

  const [rechazando, setRechazando] = useState<number | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const [devuelto, setDevuelto] = useState("0");
  // Aprobar o rechazar un comprobante vuelve a leer la rendición. Sin esta marca, ese
  // refresco pisaba el efectivo devuelto que el revisor ya había tecleado y la
  // liquidación se guardaba con monto_devuelto = 0: el saldo quedaba descuadrado.
  const devueltoTocado = useRef(false);
  const [promover, setPromover] = useState(true);
  const [observando, setObservando] = useState(false);
  const [motivoObservacion, setMotivoObservacion] = useState("");
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true);
    const [r, g] = await Promise.all([
      supabase.from("v_caja_chica_rendiciones").select("*").eq("id", rendicionId).maybeSingle(),
      supabase.from("caja_chica_gastos").select("*").eq("rendicion_id", rendicionId).order("fecha").order("id"),
    ]);

    const fila = (r.data ?? null) as RendicionCajaChica | null;
    const filas = (g.data ?? []) as GastoCajaChica[];
    setRendicion(fila);
    setGastos(filas);
    if (fila && !devueltoTocado.current) setDevuelto(String(Number(fila.monto_devuelto ?? 0)));

    const pares = await Promise.all(
      filas.filter((x) => x.foto_url).map(async (x) => [x.id, await urlFirmada(x.foto_url)] as const)
    );
    const mapa: Record<number, string> = {};
    for (const [id, url] of pares) if (url) mapa[id] = url;
    setFotos(mapa);
    setCargando(false);
  }, [rendicionId]);

  // Carga inicial (patrón de todo el ERP). La regla del linter apunta a otro caso
  // —setState síncrono en el cuerpo del efecto—; aquí se escribe tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  async function decidir(gastoId: number, decision: "aprobado" | "rechazado", motivo?: string) {
    setError("");
    setOcupado(true);
    const r = await revisarGasto(supabase, gastoId, decision, { motivo: motivo ?? null, revisado_por: usuarioNombre || null });
    setOcupado(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setRechazando(null);
    setMotivoRechazo("");
    await cargar();
  }

  async function observar() {
    setError("");
    if (!motivoObservacion.trim()) {
      setError("Indica el motivo de la observación.");
      return;
    }
    setOcupado(true);
    const r = await observarRendicion(supabase, rendicionId, motivoObservacion, usuarioNombre || null);
    setOcupado(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onListo("Rendición devuelta al responsable con observaciones");
  }

  async function aprobar() {
    setError("");
    setOcupado(true);
    const r = await aprobarRendicion(supabase, {
      rendicion_id: rendicionId,
      aprobada_por: usuarioNombre || "—",
      monto_devuelto: Number(devuelto) || 0,
      promover_a_gastos: promover,
    });
    setOcupado(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const extra = r.data.promovidos ? ` · ${r.data.promovidos} gasto(s) promovido(s)` : "";
    onListo(`Rendición liquidada${extra}`);
  }

  const pendientes = gastos.filter((g) => g.estado_revision === "pendiente").length;
  const cfgEstado = configRendicion(rendicion?.estado);
  const moneda = rendicion?.moneda ?? "PEN";

  // Saldo proyectado con el efectivo que el revisor está por confirmar: `cuadra()` se
  // evalúa sobre ese valor y no sobre el guardado, o el chip mentiría mientras se teclea.
  const saldoProyectado = rendicion
    ? Number(rendicion.monto_asignado) - Number(rendicion.monto_rendido) - (Number(devuelto) || 0)
    : 0;
  const cuadraProyectado = rendicion
    ? cuadra({
        monto_asignado: Number(rendicion.monto_asignado),
        monto_rendido: Number(rendicion.monto_rendido),
        monto_devuelto: Number(devuelto) || 0,
      })
    : false;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCerrar}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-bold text-gray-900">
                Revisar rendición <span className="font-mono text-[#0b315f]">{rendicion?.codigo ?? "—"}</span>
              </h3>
              <p className="text-xs text-gray-400 mt-1">
                {rendicion?.responsable_nombre ?? "—"} · Entregada el {fmtFecha(rendicion?.fecha_entrega)} · Límite{" "}
                {fmtFecha(rendicion?.fecha_limite)}
              </p>
            </div>
            <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: cfgEstado.bg, color: cfgEstado.color }}>
              {cfgEstado.label}
            </span>
          </div>

          {rendicion && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
              {[
                { label: "Asignado", valor: fmtMoneda(Number(rendicion.monto_asignado), moneda), color: "#0b315f", bg: "#eef3f8" },
                { label: "Rendido", valor: fmtMoneda(Number(rendicion.monto_rendido), moneda), color: "#166534", bg: "#dcfce7" },
                { label: "Devuelto", valor: fmtMoneda(Number(devuelto) || 0, moneda), color: "#1d4ed8", bg: "#dbeafe" },
                {
                  label: cuadraProyectado ? "Cuadra" : saldoProyectado > 0 ? "Falta rendir" : "Excedido",
                  valor: fmtMoneda(saldoProyectado, moneda),
                  color: cuadraProyectado ? "#166534" : saldoProyectado > 0 ? "#854d0e" : "#991b1b",
                  bg: cuadraProyectado ? "#dcfce7" : saldoProyectado > 0 ? "#fef9c3" : "#fee2e2",
                },
              ].map((k) => (
                <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>
                    {k.label}
                  </p>
                  <p className="text-lg font-black mt-0.5 leading-tight" style={{ color: k.color }}>
                    {k.valor}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-6 space-y-4">
          {!puedeAprobar && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
              <span className="text-lg leading-none">🔒</span>
              Solo gerencia puede aprobar rendiciones.
            </div>
          )}

          {rendicion?.motivo_observacion && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3 text-sm text-amber-800">
              <span className="text-lg leading-none">📝</span>
              <span>
                <span className="font-bold">Observación previa:</span> {rendicion.motivo_observacion}
              </span>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3 text-sm text-red-800">
              <span className="text-lg leading-none">⚠️</span>
              {error}
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
              Comprobantes ({gastos.length}){pendientes > 0 ? ` · ${pendientes} sin revisar` : ""}
            </p>
          </div>

          {cargando && (
            <div className="p-10 text-center text-gray-400">
              <div className="flex items-center justify-center gap-2">
                <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                Cargando…
              </div>
            </div>
          )}

          {!cargando && gastos.length === 0 && (
            <div className="p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">🧾</p>
              <p>Esta rendición no tiene comprobantes</p>
            </div>
          )}

          {!cargando &&
            gastos.map((g) => {
              const cat = configCategoriaCC(g.categoria);
              const rev = ESTADOS_REVISION[g.estado_revision] ?? ESTADOS_REVISION.pendiente;
              return (
                <div key={g.id} className="rounded-2xl border p-4" style={{ borderColor: "#e2e8f0" }}>
                  <div className="flex flex-col md:flex-row gap-4">
                    <div className="md:w-56 shrink-0">
                      {fotos[g.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={fotos[g.id]}
                          alt={`Comprobante ${g.id}`}
                          className="w-full h-44 object-cover rounded-xl border"
                          style={{ borderColor: "#e2e8f0" }}
                        />
                      ) : (
                        <div
                          className="w-full h-44 rounded-xl border flex flex-col items-center justify-center text-gray-300"
                          style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}
                        >
                          <p className="text-3xl">📷</p>
                          <p className="text-xs mt-1">Sin foto</p>
                        </div>
                      )}
                      {fotos[g.id] && (
                        <a
                          href={fotos[g.id]}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-center mt-2 text-xs font-bold text-[#0b315f] hover:underline"
                        >
                          Ver en grande
                        </a>
                      )}
                    </div>

                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: cat.bg, color: cat.color }}>
                          {cat.emoji} {cat.label}
                        </span>
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: rev.bg, color: rev.color }}>
                          {rev.label}
                        </span>
                        <span className="text-xs text-gray-400">{fmtFecha(g.fecha)}</span>
                      </div>

                      <p className="text-2xl font-black text-red-700">{fmtMoneda(Number(g.monto), g.moneda)}</p>
                      <p className="text-sm text-gray-700">{g.descripcion || "Sin descripción"}</p>
                      <p className="text-xs text-gray-400">
                        {[
                          g.tipo_comprobante,
                          g.comprobante_serie && g.comprobante_numero ? `${g.comprobante_serie}-${g.comprobante_numero}` : null,
                          g.ruc_proveedor ? `RUC ${g.ruc_proveedor}` : null,
                          `Origen: ${g.origen}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {g.motivo_rechazo && <p className="text-xs text-red-700 font-medium">Rechazado: {g.motivo_rechazo}</p>}

                      {rechazando === g.id ? (
                        <div className="flex flex-col md:flex-row gap-2 pt-1">
                          <input
                            className={inputCls("flex-1")}
                            placeholder="Motivo del rechazo…"
                            value={motivoRechazo}
                            onChange={(e) => setMotivoRechazo(e.target.value)}
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => decidir(g.id, "rechazado", motivoRechazo)}
                              disabled={ocupado || !motivoRechazo.trim()}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50 disabled:opacity-60"
                            >
                              Confirmar rechazo
                            </button>
                            <button
                              onClick={() => {
                                setRechazando(null);
                                setMotivoRechazo("");
                              }}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => decidir(g.id, "aprobado")}
                            disabled={ocupado || g.estado_revision === "aprobado"}
                            className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                          >
                            Aprobar
                          </button>
                          <button
                            onClick={() => {
                              setRechazando(g.id);
                              setMotivoRechazo(g.motivo_rechazo ?? "");
                            }}
                            disabled={ocupado}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50 disabled:opacity-60"
                          >
                            Rechazar
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>

        <div className="px-6 py-4 border-t space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Efectivo devuelto</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className={inputCls()}
                value={devuelto}
                onChange={(e) => {
                  devueltoTocado.current = true;
                  setDevuelto(e.target.value);
                }}
                disabled={!puedeAprobar}
              />
            </div>
            <label className="flex items-start gap-3 text-sm text-gray-700 md:pt-6">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={promover}
                onChange={(e) => setPromover(e.target.checked)}
                disabled={!puedeAprobar}
              />
              <span>
                <span className="font-bold">Promover gastos aprobados al módulo Gastos</span>
                <span className="block text-xs text-gray-400">Se contabilizan una sola vez: dejan de contarse por el lado de caja chica.</span>
              </span>
            </label>
          </div>

          {observando && (
            <input
              className={inputCls()}
              placeholder="Motivo de la observación…"
              value={motivoObservacion}
              onChange={(e) => setMotivoObservacion(e.target.value)}
            />
          )}

          <div className="flex justify-end gap-3 flex-wrap">
            <button onClick={onCerrar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cerrar
            </button>
            <button
              onClick={() => (observando ? observar() : setObservando(true))}
              disabled={!puedeAprobar || ocupado}
              className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50 disabled:opacity-60"
              style={{ borderColor: "#c2410c", color: "#c2410c" }}
            >
              {observando ? "Confirmar observación" : "Observar"}
            </button>
            <button
              onClick={aprobar}
              disabled={!puedeAprobar || ocupado || cargando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}
            >
              {ocupado ? "Procesando…" : "Aprobar y liquidar"}
            </button>
          </div>
          {!cuadraProyectado && rendicion && (
            <p className="text-xs text-amber-700 text-right">
              La rendición no cuadra:{" "}
              {saldoProyectado > 0
                ? `faltan ${fmtMoneda(saldoProyectado, moneda)} por rendir o devolver.`
                : `se gastaron ${fmtMoneda(Math.abs(saldoProyectado), moneda)} de más.`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
