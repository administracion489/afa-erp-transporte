"use client";

// Drawer de analítica operativa de UN vehículo. Se autoabastece: al abrir carga el
// último año de lecturas de odómetro de esa unidad (propia o tercero), su combustible
// (flota propia) y su plan de mantenimiento, y arma el tablero completo:
//   Hoy · Semana · Mes · Históricos · Rango esperado · Gráficos · Anomalías ·
//   Mantenimiento · Económico · Atribución por servicio (GPS, on-demand).

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { paginarFilas } from "@/lib/huella";
import {
  analizarVehiculo, estadisticasVehiculo, resumenPeriodo, indicadoresEconomicos,
  hoyLima, sumarDias,
  type LecturaCruda, type DiaRecorrido, type RegistroCombustible,
} from "@/lib/odometro-analitica";
import { BarrasVertical, BarrasHorizontal, LineaTendencia } from "./_charts";

export type VehiculoAnalitica = {
  key: string; id: number; flota: "propia" | "tercero";
  placa: string; categoria?: string; kilometraje_actual?: number;
};

type PlanInfo = { intervalo_base_km?: number; intervalo_base_meses?: number; marca?: string; modelo?: string };

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const AZUL = "#0b315f";
function fmt(n: number | null | undefined) { return n == null ? "—" : Number(n).toLocaleString("es-PE"); }
function fmtDec(n: number | null | undefined, d = 1) { return n == null ? "—" : Number(n).toLocaleString("es-PE", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtSoles(n: number | null | undefined) { return n == null ? "—" : `S/ ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtFechaCorta(f: string) {
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
}
function minutosATexto(m: number | null) {
  if (m == null) return "—";
  const h = Math.floor(m / 60), mm = m % 60;
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

function Kpi({ label, valor, sub, color = AZUL }: { label: string; valor: React.ReactNode; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl border p-3 bg-white">
      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="text-xl font-black mt-0.5 leading-tight" style={{ color }}>{valor}</p>
      {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Seccion({ titulo, icon, children, extra }: { titulo: string; icon: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border shadow-sm p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold text-gray-800 text-sm flex items-center gap-2"><span>{icon}</span>{titulo}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

// Semanas ISO-lunes de los últimos N días → serie para la tendencia.
function serieSemanal(dias: DiaRecorrido[], hasta: string, nSemanas: number) {
  const out: { label: string; value: number }[] = [];
  for (let s = nSemanas - 1; s >= 0; s--) {
    const fin = sumarDias(hasta, -7 * s);
    const ini = sumarDias(fin, -6);
    const r = resumenPeriodo(dias, ini, fin);
    out.push({ label: fmtFechaCorta(ini), value: r.kmTotal });
  }
  return out;
}

// ─── ATRIBUCIÓN (GPS por servicio) ──────────────────────────────────────────────

type Agr = { label: string; km: number; servicios: number };
type AgrRuta = Agr & { kmPlan: number | null; kmReal: number | null; desvioPct: number | null };
type Atribucion = {
  gpsTotal: number; medidoPctMin: number | null; nServicios: number; servConGps: number;
  truncado: boolean; totalReservas: number; ingresoTotal: number;
  usoGoogle: boolean; kmProductivo: number; kmVacioTramos: number; nTramosVacio: number; tramosSinMedir: number;
  porConductor: Agr[];
  porCliente: Agr[];
  porRuta: AgrRuta[];
  porSentido: Agr[];
};

// ─── COMPONENTE ─────────────────────────────────────────────────────────────────

export default function AnaliticaVehiculo({ veh, onClose }: { veh: VehiculoAnalitica; onClose: () => void }) {
  const [cargando, setCargando] = useState(true);
  const [dias, setDias] = useState<DiaRecorrido[]>([]);
  const [combustible, setCombustible] = useState<RegistroCombustible[]>([]);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [ultServKm, setUltServKm] = useState<number | null>(null);

  const [atrib, setAtrib] = useState<Atribucion | null>(null);
  const [atribCargando, setAtribCargando] = useState(false);
  const [atribError, setAtribError] = useState<string | null>(null);

  const hoy = hoyLima();

  useEffect(() => {
    let vivo = true;
    (async () => {
      setCargando(true);
      const desde = sumarDias(hoy, -400);
      const fkCol = veh.flota === "tercero" ? "vehiculo_tercero_id" : "vehiculo_id";

      const lecturas = await paginarFilas(() =>
        supabase.from("lecturas_odometro")
          .select("id,vehiculo_id,vehiculo_tercero_id,km,fuente,fecha,estado,motivo,created_at,capturado_en,momento,foto_url")
          .eq(fkCol, veh.id)
          .gte("fecha", desde)
          .order("fecha", { ascending: false })
      );

      // Combustible + plan solo para flota propia (no hay FK de terceros en combustible/plan).
      const [combRes, planRes, mantRes] = veh.flota === "propia"
        ? await Promise.all([
            supabase.from("combustible").select("vehiculo_id,fecha,kilometraje,galones,precio_galon,total,tipo_combustible").eq("vehiculo_id", veh.id).gte("fecha", desde),
            supabase.from("vehiculos_plan").select("plan:planes_mantenimiento(intervalo_base_km,intervalo_base_meses,marca,modelo)").eq("vehiculo_id", veh.id).eq("activo", true).maybeSingle(),
            supabase.from("mantenimiento").select("kilometraje,fecha").eq("vehiculo_id", veh.id).eq("tipo", "preventivo").order("fecha", { ascending: false }).limit(1).maybeSingle(),
          ])
        : [{ data: [] }, { data: null }, { data: null }] as any;

      if (!vivo) return;
      const { dias: d } = analizarVehiculo(lecturas as LecturaCruda[]);
      setDias(d);
      setCombustible((combRes.data || []) as RegistroCombustible[]);
      const p = (planRes.data as any)?.plan;
      setPlan(Array.isArray(p) ? p[0] : p || null);
      setUltServKm((mantRes.data as any)?.kilometraje ?? null);
      setCargando(false);
    })();
    return () => { vivo = false; };
  }, [veh.id, veh.flota]);

  const est = useMemo(() => estadisticasVehiculo(dias, hoy), [dias, hoy]);

  // Serie km/día (últimos 30 días, cronológico) con max/min resaltados.
  const serieDia = useMemo(() => {
    const desde = sumarDias(hoy, -29);
    const enRango = dias.filter((d) => d.fecha >= desde && d.fecha <= hoy && !d.pendiente && d.recorrido != null);
    const cron = [...enRango].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    const vals = cron.map((d) => d.recorrido as number).filter((v) => v > 0);
    const max = vals.length ? Math.max(...vals) : -1;
    const min = vals.length ? Math.min(...vals) : -1;
    return cron.map((d) => ({
      label: fmtFechaCorta(d.fecha),
      value: d.recorrido as number,
      resaltar: (d.recorrido === max ? "max" : d.recorrido === min && (d.recorrido as number) > 0 ? "min" : null) as "max" | "min" | null,
    }));
  }, [dias, hoy]);

  const serieSem = useMemo(() => serieSemanal(dias, hoy, 8), [dias, hoy]);

  const anomalias = useMemo(
    () => dias.filter((d) => d.anomalias.some((a) => a.tipo === "excesivo" || a.tipo === "bajo" || a.tipo === "retroceso")).slice(0, 12),
    [dias]
  );

  // Económico del mes en curso (costo/km usa el km real del odómetro del mes).
  const eco = useMemo(() => {
    const inicioMes = hoy.slice(0, 8) + "01";
    return indicadoresEconomicos(combustible, est.mes.kmTotal, inicioMes, hoy);
  }, [combustible, est.mes.kmTotal, hoy]);

  // Mantenimiento (flota propia enrolada a un plan).
  const mant = useMemo(() => {
    if (!plan?.intervalo_base_km) return null;
    const inter = Number(plan.intervalo_base_km);
    const kmAct = Number(veh.kilometraje_actual ?? est.kmAcumulado ?? 0);
    const dueKm = ultServKm != null ? ultServKm + inter : (Math.floor(kmAct / inter) + 1) * inter;
    const faltanKm = dueKm - kmAct;
    const kmDia = est.historicos.prom30 ?? est.historicos.prom7 ?? null;
    const diasPara = kmDia && kmDia > 0 && faltanKm > 0 ? Math.round(faltanKm / kmDia) : null;
    return { dueKm, faltanKm, diasPara, kmDia, inter, kmAct };
  }, [plan, ultServKm, veh.kilometraje_actual, est]);

  // Atribución (GPS por servicio) del mes en curso — on-demand.
  const calcularAtribucion = async () => {
    setAtribCargando(true); setAtribError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const inicioMes = hoy.slice(0, 8) + "01";
      const res = await fetch("/api/mantenimiento/odometro-analitica", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ flota: veh.flota, vehiculo_id: veh.id, desde: inicioMes, hasta: hoy }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || `Error ${res.status}`);
      setAtrib(data as Atribucion);
    } catch (e: any) {
      setAtribError(e.message);
    } finally {
      setAtribCargando(false);
    }
  };

  // Cuadre del mes: odómetro = productivo (con pasajeros) + vacío (tramos) + sin explicar (residual).
  const kmSinExplicar = atrib ? Math.round((est.mes.kmTotal - atrib.kmProductivo - atrib.kmVacioTramos) * 10) / 10 : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="bg-gray-50 w-full max-w-3xl h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b px-5 py-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-black font-mono text-[#0b315f]">{veh.placa}</h2>
              {veh.flota === "tercero" && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">Tercero</span>}
            </div>
            <p className="text-xs text-gray-400">{veh.categoria || "—"} · {fmt(veh.kilometraje_actual ?? est.kmAcumulado)} km acumulados</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl px-2">✕</button>
        </div>

        {cargando ? (
          <div className="p-10 text-center text-gray-400">Cargando analítica…</div>
        ) : (
          <div className="p-4 space-y-4">

            {/* HOY */}
            <Seccion titulo="Hoy" icon="📅">
              {est.hoy && !est.hoy.pendiente && est.hoy.recorrido != null ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                  <Kpi label="Km recorridos" valor={fmt(est.hoy.recorrido)} />
                  <Kpi label="Primer registro" valor={est.hoy.primeraHora || "—"} color="#0f766e" />
                  <Kpi label="Último registro" valor={est.hoy.ultimaHora || "—"} color="#0f766e" />
                  <Kpi label="Tiempo operación" valor={minutosATexto(est.hoy.minutosOperacion)} color="#854d0e" />
                </div>
              ) : (
                <p className="text-sm text-gray-500 bg-amber-50 rounded-xl p-3">
                  {est.hoy ? "⏳ Pendiente de completar jornada — falta la lectura de cierre." : "Sin lecturas hoy."}
                </p>
              )}
            </Seccion>

            {/* SEMANA / MES */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Seccion titulo="Esta semana" icon="🗓️">
                <div className="grid grid-cols-2 gap-2.5">
                  <Kpi label="Km recorridos" valor={fmt(est.semana.kmTotal)} />
                  <Kpi label="Promedio diario" valor={fmt(est.semana.promedioDiario)} sub="km/día" />
                  <Kpi label="Día mayor" valor={fmt(est.semana.diaMax?.recorrido)} sub={est.semana.diaMax ? fmtFechaCorta(est.semana.diaMax.fecha) : ""} color="#166534" />
                  <Kpi label="Día menor" valor={fmt(est.semana.diaMin?.recorrido)} sub={est.semana.diaMin ? fmtFechaCorta(est.semana.diaMin.fecha) : ""} color="#b45309" />
                </div>
              </Seccion>
              <Seccion titulo="Este mes" icon="📆">
                <div className="grid grid-cols-2 gap-2.5">
                  <Kpi label="Total km" valor={fmt(est.mes.kmTotal)} />
                  <Kpi label="Promedio diario" valor={fmt(est.mes.promedioDiario)} sub="km/día" />
                  <Kpi label="Máximo" valor={fmt(est.mes.diaMax?.recorrido)} sub={est.mes.diaMax ? fmtFechaCorta(est.mes.diaMax.fecha) : ""} color="#166534" />
                  <Kpi label="Mínimo" valor={fmt(est.mes.diaMin?.recorrido)} sub={est.mes.diaMin ? fmtFechaCorta(est.mes.diaMin.fecha) : ""} color="#b45309" />
                </div>
              </Seccion>
            </div>

            {/* HISTÓRICOS + RANGO ESPERADO */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Seccion titulo="Promedios históricos" icon="📈">
                <div className="grid grid-cols-2 gap-2.5">
                  <Kpi label="Últimos 7 días" valor={fmt(est.historicos.prom7)} sub="km/día" />
                  <Kpi label="Últimos 30 días" valor={fmt(est.historicos.prom30)} sub="km/día" />
                  <Kpi label="Últimos 90 días" valor={fmt(est.historicos.prom90)} sub="km/día" />
                  <Kpi label="Anual" valor={fmt(est.historicos.promAnual)} sub="km/día" />
                </div>
              </Seccion>
              <Seccion titulo="Rango esperado" icon="🧠" extra={<span className="text-[10px] text-gray-400">inteligencia operativa</span>}>
                {est.rango.confiable ? (
                  <div className="space-y-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-black text-[#0b315f]">{fmt(est.rango.min)}–{fmt(est.rango.max)}</span>
                      <span className="text-xs text-gray-400">km/jornada esperados</span>
                    </div>
                    <p className="text-xs text-gray-500">
                      Patrón normal: ~{fmt(est.rango.media)} km/jornada (±{fmt(est.rango.desv)}), aprendido de {est.rango.n} jornadas.
                      Fuera de este rango se marca como anomalía.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">Aún no hay suficientes jornadas ({est.rango.n}) para establecer un patrón fiable. Se necesitan ≥ 5.</p>
                )}
              </Seccion>
            </div>

            {/* GRÁFICOS */}
            <Seccion titulo="Kilómetros por día (últimos 30)" icon="📊">
              <BarrasVertical data={serieDia} />
            </Seccion>
            <Seccion titulo="Tendencia semanal (8 semanas)" icon="📉">
              <LineaTendencia data={serieSem} />
            </Seccion>

            {/* ANOMALÍAS */}
            <Seccion titulo={`Anomalías detectadas (${anomalias.length})`} icon="⚠️">
              {anomalias.length === 0 ? (
                <p className="text-sm text-green-700 bg-green-50 rounded-xl p-3">✓ Sin anomalías de recorrido en el historial reciente.</p>
              ) : (
                <div className="space-y-1.5">
                  {anomalias.map((d) => (
                    <div key={d.fecha} className="flex items-start gap-2 text-xs border-b border-gray-100 pb-1.5">
                      <span className="font-mono text-gray-500 w-16 shrink-0">{fmtFechaCorta(d.fecha)}</span>
                      <div className="flex-1">
                        {d.anomalias.filter((a) => a.tipo !== "sin_recorrido" && a.tipo !== "duplicada").map((a, i) => (
                          <p key={i} className={a.severidad === "critico" ? "text-red-700" : "text-amber-700"}>
                            {a.severidad === "critico" ? "❌" : "⚠"} {a.mensaje}
                          </p>
                        ))}
                      </div>
                      <span className="text-gray-400 tabular-nums">{fmt(d.recorrido)} km</span>
                    </div>
                  ))}
                </div>
              )}
            </Seccion>

            {/* MANTENIMIENTO */}
            <Seccion titulo="Mantenimiento" icon="🔧">
              {veh.flota === "tercero" ? (
                <p className="text-sm text-gray-500">El plan de mantenimiento aplica solo a la flota propia.</p>
              ) : !mant ? (
                <p className="text-sm text-gray-500">Sin plan de fabricante enrolado. Enrola la unidad en <b>Planes Fabricante</b> para proyectar servicios.</p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                  <Kpi label="Próximo servicio" valor={`${fmt(mant.dueKm)} km`} sub={`cada ${fmt(mant.inter)} km`} />
                  <Kpi label="Faltan" valor={mant.faltanKm <= 0 ? "Vencido" : `${fmt(mant.faltanKm)} km`} color={mant.faltanKm <= 0 ? "#991b1b" : AZUL} />
                  <Kpi label="Estimado" valor={mant.diasPara != null ? `~${mant.diasPara} días` : "—"} sub={mant.kmDia ? `${fmt(mant.kmDia)} km/día` : ""} color="#854d0e" />
                  <Kpi label="Km actual" valor={fmt(mant.kmAct)} />
                </div>
              )}
            </Seccion>

            {/* ECONÓMICO */}
            <Seccion titulo="Indicadores económicos (mes)" icon="💰">
              {veh.flota === "tercero" ? (
                <p className="text-sm text-gray-500">No se registra combustible de la flota tercerizada.</p>
              ) : eco.nRegistros === 0 ? (
                <p className="text-sm text-gray-500">Sin registros de combustible este mes.</p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                  {/* La etiqueta sale de la FAMILIA del combustible: una unidad de GNV rinde
                      en km/m³ y aquí se imprimía "km/gal" sobre ese número. El sub declara
                      además cuántos tramos lo sostienen: 2 tramos no son un patrón. */}
                  <Kpi
                    label="Rendimiento"
                    valor={eco.rendimientoKmGal != null ? fmtDec(eco.rendimientoKmGal) : "—"}
                    sub={eco.rendimientoTramos > 0 ? `${eco.rendimientoLabel} · ${eco.rendimientoTramos} tramo${eco.rendimientoTramos === 1 ? "" : "s"}` : eco.rendimientoLabel}
                    color="#0f766e"
                  />
                  <Kpi label="Costo / km" valor={eco.costoPorKm != null ? fmtSoles(eco.costoPorKm) : "—"} color="#991b1b" />
                  <Kpi label="Costo total" valor={fmtSoles(eco.costoTotal)} sub={`${fmtDec(eco.galonesTotal)} gal`} />
                  <Kpi label="Costo / día" valor={fmtSoles(eco.costoPromedioDia)} color="#854d0e" />
                </div>
              )}
            </Seccion>

            {/* ATRIBUCIÓN */}
            <Seccion titulo="Atribución por servicio (mes)" icon="🧭"
              extra={!atrib && <button onClick={calcularAtribucion} disabled={atribCargando}
                className="text-xs font-bold px-3 py-1.5 rounded-lg text-white disabled:opacity-60" style={{ background: AZUL }}>
                {atribCargando ? "Calculando GPS…" : "Calcular (GPS)"}
              </button>}>
              {atribError && <p className="text-sm text-red-600 bg-red-50 rounded-xl p-3">Error: {atribError}</p>}
              {!atrib && !atribError && (
                <p className="text-sm text-gray-500">
                  Reparte los km del mes por conductor, cliente, ruta y sentido cruzando cada servicio finalizado con su huella GPS.
                  {" "}Es un cálculo pesado, por eso es bajo demanda.
                </p>
              )}
              {atrib && (
                <div className="space-y-4">
                  {/* CUADRE: odómetro = productivo + vacío + sin explicar */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                    <Kpi label="Km con pasajeros" valor={fmt(atrib.kmProductivo)} sub={`${atrib.servConGps}/${atrib.nServicios} con GPS`} color="#0f766e" />
                    <Kpi label="Km en vacío" valor={fmt(atrib.kmVacioTramos)} sub={`${atrib.nTramosVacio} tramos entre servicios`} color="#854d0e" />
                    <Kpi label="Km sin explicar" valor={kmSinExplicar == null ? "—" : fmt(kmSinExplicar)} sub="odómetro − prod. − vacío"
                      color={kmSinExplicar != null && Math.abs(kmSinExplicar) > est.mes.kmTotal * 0.25 ? "#991b1b" : "#6b7280"} />
                    <Kpi label="Confianza GPS" valor={atrib.medidoPctMin != null ? `${atrib.medidoPctMin}%` : "—"} sub="mínimo medido" />
                  </div>
                  <p className="text-[11px] text-gray-400">
                    Odómetro del mes {fmt(est.mes.kmTotal)} km · GPS real {fmt(atrib.gpsTotal)} km · Ingreso {fmtSoles(atrib.ingresoTotal)}.
                    {!atrib.usoGoogle && " (Google Directions no disponible: km en vacío estimado en línea recta)."}
                    {atrib.truncado && ` Se procesaron los primeros ${atrib.nServicios} de ${atrib.totalReservas} servicios.`}
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-bold text-gray-500 mb-2">Por conductor</p>
                      <BarrasHorizontal data={atrib.porConductor.slice(0, 6).map((x) => ({ label: x.label, value: x.km, sub: `${x.servicios} serv` }))} />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-gray-500 mb-2">Por cliente</p>
                      <BarrasHorizontal data={atrib.porCliente.slice(0, 6).map((x) => ({ label: x.label, value: x.km, sub: `${x.servicios} serv` }))} color="#0f766e" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-gray-500 mb-2">Por sentido</p>
                      <BarrasHorizontal data={atrib.porSentido.map((x) => ({ label: x.label, value: x.km, sub: `${x.servicios} serv` }))} color="#7c3aed" />
                    </div>
                  </div>

                  {/* POR RUTA: plan (Google) vs real (GPS) + desvío */}
                  <div>
                    <p className="text-xs font-bold text-gray-500 mb-2">Por ruta — plan (Google) vs real (GPS)</p>
                    <div className="overflow-x-auto border rounded-xl">
                      <table className="w-full text-xs">
                        <thead><tr className="bg-gray-50 text-gray-400">
                          {["Ruta", "Km atribuido", "Plan", "Real", "Desvío", "Serv."].map((h) => (
                            <th key={h} className="p-2 text-left font-bold uppercase tracking-wide">{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>
                          {atrib.porRuta.slice(0, 8).map((x, i) => (
                            <tr key={i} className="border-t" style={{ borderColor: "#f1f5f9" }}>
                              <td className="p-2 text-gray-700 max-w-[180px] truncate" title={x.label}>{x.label}</td>
                              <td className="p-2 font-mono font-bold text-[#0b315f]">{fmt(x.km)}</td>
                              <td className="p-2 font-mono text-gray-500">{x.kmPlan != null ? fmtDec(x.kmPlan) : "—"}</td>
                              <td className="p-2 font-mono text-gray-500">{x.kmReal != null ? fmtDec(x.kmReal) : "—"}</td>
                              <td className="p-2">
                                {x.desvioPct == null ? <span className="text-gray-300">—</span> : (
                                  <span className="font-bold" style={{ color: Math.abs(x.desvioPct) >= 25 ? "#991b1b" : Math.abs(x.desvioPct) >= 10 ? "#b45309" : "#166534" }}>
                                    {x.desvioPct > 0 ? "+" : ""}{x.desvioPct}%
                                  </span>
                                )}
                              </td>
                              <td className="p-2 text-gray-400">{x.servicios}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">Desvío = real − plan. Alto y positivo = la unidad recorrió más que la ruta planificada (desvíos/tráfico); negativo grande = huecos de GPS.</p>
                  </div>
                </div>
              )}
            </Seccion>

            <p className="text-[11px] text-gray-400 text-center pb-4">
              Analítica sobre lecturas aceptadas del odómetro (se descartan rechazadas, retrocesos y valores absurdos).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
