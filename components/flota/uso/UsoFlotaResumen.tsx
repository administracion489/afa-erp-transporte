"use client";

// components/flota/uso/UsoFlotaResumen.tsx — La pestaña «Resumen» de /uso-flota: el uso de la
// flota en un periodo (km, servicios, horas, unidades sin uso, gasto y CO₂ de lo comprado)
// contra el periodo anterior del mismo largo.
//
// TODO LO QUE SE PINTA SALE DE GET /api/flota/uso (motor lib/flota/uso-flota.ts). La pantalla NO
// decide el sentido ni el tono de una variación (lo declara `comparacion.variaciones[m]`), no
// redacta los avisos (`comparacion.avisos`) ni las notas (`notas`), y no suma nada que el motor
// no haya sumado. Lo único que hace es escribir los números con su procedencia:
//   · un `null` es «sin dato (no es cero)», jamás un 0;
//   · un km que es un mínimo va con «≥» y con la cobertura del odómetro al lado;
//   · el combustible comprado va POR FAMILIA, cada una en su unidad: nunca galones con m³.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Ficha } from "@/components/analitica/FichaComparada";
import SerieComparada from "@/components/graficos/SerieComparada";
import { sumarDias, diasEntreFechas } from "@/lib/odometro-analitica";
import {
  FUENTES_KM_DIA, DIAS_ATRAS_MAX_USO,
  type RespuestaUso, type ResumenUso, type FuenteKmDia, type UnidadUso, type DiaSerieUso, type ProcedenciaConstante,
} from "@/lib/flota/uso-flota";
import {
  pedirConReintento, fmtNum, fmtKm, fmtSoles, fmtKg, fmtHoras, fmtFecha, nombreFamilia,
  Ambar, ErrorConReintento, Nota, ComoSeMide, type Resultado,
} from "./comun";

// ─── El periodo ───────────────────────────────────────────────────────────────

export type ModoPeriodo = "ultimos" | "semana" | "rango";
export type Periodo = { modo: ModoPeriodo; desde: string; hasta: string };

/** 0 = lunes … 6 = domingo, de una fecha AAAA-MM-DD (calendario, sin hora). */
const diaSemana = (f: string) => (new Date(`${f}T12:00:00Z`).getUTCDay() + 6) % 7;
export const lunesDe = (f: string) => sumarDias(f, -diaSemana(f));

/** La semana calendario lun–dom que empieza en `lunes`, recortada a hoy si está en curso. */
function semana(lunes: string, hoy: string): { desde: string; hasta: string } {
  const dom = sumarDias(lunes, 6);
  return { desde: lunes, hasta: dom > hoy ? hoy : dom };
}

/** El periodo que piden los parámetros de la URL, o los últimos 7 días. */
export function periodoInicial(hoy: string, desde: string | null, hasta: string | null): Periodo {
  const ultimos: Periodo = { modo: "ultimos", desde: sumarDias(hoy, -6), hasta: hoy };
  const valida = (f: string | null): f is string => !!f && /^\d{4}-\d{2}-\d{2}$/.test(f);
  if (!valida(desde) || !valida(hasta) || desde > hasta) return ultimos;
  if (desde === ultimos.desde && hasta === ultimos.hasta) return ultimos;
  if (diaSemana(desde) === 0) {
    const s = semana(desde, hoy);
    if (s.hasta === hasta) return { modo: "semana", desde, hasta };
  }
  return { modo: "rango", desde, hasta };
}

const SEMANAS_ATRAS = 12;

// ─── La métrica del gráfico ───────────────────────────────────────────────────

type MetricaSerie = "km" | "servicios" | "horas" | "gasto" | "co2";
const METRICAS_SERIE: { k: MetricaSerie; label: string; unidad: string; de: (d: DiaSerieUso) => number | null; fmt: (v: number) => string }[] = [
  { k: "km", label: "Km", unidad: "km", de: (d) => d.km, fmt: fmtKm },
  { k: "servicios", label: "Servicios", unidad: "servicios", de: (d) => d.servicios, fmt: (v) => `${fmtNum(v)} servicio(s)` },
  { k: "horas", label: "Horas", unidad: "h", de: (d) => d.horas, fmt: fmtHoras },
  { k: "gasto", label: "Gasto combustible", unidad: "S/", de: (d) => d.gasto, fmt: fmtSoles },
  { k: "co2", label: "CO₂ comprado", unidad: "kg CO₂", de: (d) => d.co2, fmt: fmtKg },
];

// ─── Rótulos de los códigos (la pantalla enruta por código) ───────────────────

const FUENTE_KM: Record<FuenteKmDia, { label: string; title: string }> = {
  odometro: { label: "odómetro", title: "Jornada completa del odómetro (primera y última lectura del día, saneadas)." },
  gps: { label: "GPS", title: "Sin jornada de odómetro: la suma del km por GPS de sus servicios (un mínimo)." },
  gps_parcial: { label: "GPS parcial", title: "Sin jornada de odómetro y solo algunos servicios con km por GPS publicable (un mínimo)." },
  sin_dato: { label: "sin dato", title: "Sin jornada de odómetro y ningún servicio con km por GPS publicable: no es cero." },
  tope: { label: "sin medir (tope)", title: "No se midió por el tope de trazas por consulta: no es cero." },
};

const PROCEDENCIA: Record<ProcedenciaConstante, string> = {
  operativo: "operativo (no medido)",
  heredado: "heredado",
  no_medido: "no medido",
};

const MOTIVO_SIN_USO = {
  en_mantenimiento: "En mantenimiento (según su ficha)",
  sin_servicio: "Sin servicios en el periodo",
} as const;

// ─── Formatos de las fichas ───────────────────────────────────────────────────

const SIN_DATO = "sin dato";
const kmDe = (r: ResumenUso) => (r.km.total == null ? SIN_DATO : `${r.km.esPiso ? "≥ " : ""}${fmtKm(r.km.total)}`);
const horasDe = (r: ResumenUso) => (r.horas.total == null ? SIN_DATO : fmtHoras(r.horas.total));
const gastoDe = (r: ResumenUso) =>
  r.combustible.gasto == null ? SIN_DATO : fmtSoles(r.combustible.gasto);
const co2De = (r: ResumenUso) => (r.combustible.co2Kg == null ? SIN_DATO : fmtKg(r.combustible.co2Kg));
const pctTercDe = (r: ResumenUso) =>
  r.servicios.pctTercerizado == null ? "sin servicios" : `${fmtNum(r.servicios.pctTercerizado, 1)} %`;

/** «4 odómetro · 2 GPS» — los días de la unidad por fuente del km, en el orden del motor. */
function textoFuentes(f: Record<FuenteKmDia, number>): React.ReactNode {
  const partes = FUENTES_KM_DIA.filter((k) => f[k] > 0);
  if (!partes.length) return <span className="text-gray-300">sin jornadas</span>;
  return partes.map((k, i) => (
    <span key={k} title={FUENTE_KM[k].title} className={k === "odometro" ? "text-gray-500" : k === "sin_dato" || k === "tope" ? "text-amber-700" : "text-slate-500"}>
      {i > 0 && " · "}{f[k]} {FUENTE_KM[k].label}
    </span>
  ));
}

// ─── El componente ────────────────────────────────────────────────────────────

export default function UsoFlotaResumen({ hoy, periodoDeInicio, onPeriodo }: {
  hoy: string;
  periodoDeInicio: Periodo;
  /** para que la página escriba `desde`/`hasta` en la URL */
  onPeriodo: (p: Periodo) => void;
}) {
  const [periodo, setPeriodo] = useState<Periodo>(periodoDeInicio);
  const [borrador, setBorrador] = useState({ desde: periodoDeInicio.desde, hasta: periodoDeInicio.hasta });
  const [intento, setIntento] = useState(0);
  const [metrica, setMetrica] = useState<MetricaSerie>("km");

  const clave = `${periodo.desde}|${periodo.hasta}|${intento}`;
  const [res, setRes] = useState<{ clave: string; r: Resultado<RespuestaUso> } | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const url = `/api/flota/uso?desde=${periodo.desde}&hasta=${periodo.hasta}`;
    void pedirConReintento<RespuestaUso>(url, ac.signal).then((r) => {
      if (!ac.signal.aborted) setRes({ clave, r });
    });
    return () => ac.abort();
  }, [clave, periodo.desde, periodo.hasta]);

  useEffect(() => { onPeriodo(periodo); }, [periodo, onPeriodo]);

  const cargando = res?.clave !== clave;
  const r = res?.r;
  const d = r?.ok ? r.data : null;

  const elegir = (p: Periodo) => { setPeriodo(p); setBorrador({ desde: p.desde, hasta: p.hasta }); };

  // Las semanas calendario que se ofrecen: la en curso y las SEMANAS_ATRAS anteriores.
  const semanas = useMemo(() => {
    const out: { lunes: string; desde: string; hasta: string; enCurso: boolean }[] = [];
    const l0 = lunesDe(hoy);
    for (let i = 0; i <= SEMANAS_ATRAS; i++) {
      const lunes = sumarDias(l0, -7 * i);
      const s = semana(lunes, hoy);
      out.push({ lunes, ...s, enCurso: i === 0 });
    }
    return out;
  }, [hoy]);

  // El tope de la API (`desde` ≥ hoy − DIAS_ATRAS_MAX_USO): se ofrece como mínimo del calendario.
  const minimo = sumarDias(hoy, -DIAS_ATRAS_MAX_USO);
  const rangoInvalido = !borrador.desde || !borrador.hasta || borrador.desde > borrador.hasta;

  return (
    <div className="space-y-4">
      {/* ── Periodo ── */}
      <section className="bg-white rounded-2xl border shadow-sm p-3.5 space-y-3">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Periodo">
          {([
            ["ultimos", "Últimos 7 días"],
            ["semana", "Semana (lun–dom)"],
            ["rango", "Rango libre"],
          ] as [ModoPeriodo, string][]).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={periodo.modo === k}
              onClick={() => {
                if (k === "ultimos") elegir({ modo: "ultimos", desde: sumarDias(hoy, -6), hasta: hoy });
                else if (k === "semana") {
                  const s = semanas.find((x) => !x.enCurso) ?? semanas[0];
                  elegir({ modo: "semana", desde: s.desde, hasta: s.hasta });
                } else setPeriodo((p) => ({ ...p, modo: "rango" }));
              }}
              className={`px-3 py-2 rounded-xl text-xs font-bold min-h-[40px] transition-colors ${periodo.modo === k ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              style={periodo.modo === k ? { background: "#0b315f" } : undefined}>
              {l}
            </button>
          ))}
        </div>

        {periodo.modo === "semana" && (
          <select value={periodo.desde}
            onChange={(e) => { const s = semanas.find((x) => x.lunes === e.target.value); if (s) elegir({ modo: "semana", desde: s.desde, hasta: s.hasta }); }}
            className="w-full sm:w-auto border border-gray-200 rounded-xl px-3 py-2 text-sm min-h-[40px]">
            {semanas.map((s) => (
              <option key={s.lunes} value={s.lunes}>
                {s.enCurso ? `Semana en curso: ${fmtFecha(s.desde)} – hoy` : `${fmtFecha(s.desde)} – ${fmtFecha(s.hasta)}`}
              </option>
            ))}
          </select>
        )}

        {periodo.modo === "rango" && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] font-bold uppercase text-gray-400">
              Desde
              <input type="date" value={borrador.desde} min={minimo} max={hoy}
                onChange={(e) => setBorrador((b) => ({ ...b, desde: e.target.value }))}
                className="block mt-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 font-normal normal-case min-h-[40px]" />
            </label>
            <label className="text-[11px] font-bold uppercase text-gray-400">
              Hasta
              <input type="date" value={borrador.hasta} min={minimo} max={hoy}
                onChange={(e) => setBorrador((b) => ({ ...b, hasta: e.target.value }))}
                className="block mt-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 font-normal normal-case min-h-[40px]" />
            </label>
            <button type="button" disabled={rangoInvalido}
              onClick={() => elegir({ modo: "rango", desde: borrador.desde, hasta: borrador.hasta })}
              className="px-4 py-2 rounded-xl text-sm font-bold text-white min-h-[40px] disabled:opacity-40"
              style={{ background: "#0b315f" }}>
              Medir
            </button>
            <p className="w-full text-[11px] text-gray-400">
              {rangoInvalido
                ? "Falta elegir las dos fechas, y «desde» no puede ir después de «hasta»."
                : `${diasEntreFechas(borrador.desde, borrador.hasta) + 1} día(s), comparados con los ${diasEntreFechas(borrador.desde, borrador.hasta) + 1} anteriores. Si el servidor no acepta el largo, lo dice.`}
            </p>
          </div>
        )}

        <p className="text-[11px] text-gray-500">
          {d && !cargando ? (
            <>
              <b className="text-gray-700">{fmtFecha(d.desde)} – {fmtFecha(d.hasta)}</b> ({d.actual.periodo.dias} días)
              {" contra "}
              <b className="text-gray-700">{fmtFecha(d.anteriorDesde)} – {fmtFecha(d.anteriorHasta)}</b>
              {" "}(el periodo anterior del mismo largo)
            </>
          ) : cargando ? (
            <>Midiendo {fmtFecha(periodo.desde)} – {fmtFecha(periodo.hasta)} y el periodo anterior del mismo largo…</>
          ) : (
            <>{fmtFecha(periodo.desde)} – {fmtFecha(periodo.hasta)}: no se pudo medir (abajo, por qué).</>
          )}
        </p>
      </section>

      {/* ── Estado de la medición ── */}
      {cargando && !d && (
        <div className="bg-white rounded-2xl border shadow-sm p-8 text-center text-sm text-gray-500">
          Midiendo… (lee el odómetro, los servicios y, donde falta odómetro, el GPS de cada servicio: puede tardar)
        </div>
      )}
      {!cargando && r && !r.ok && (
        <ErrorConReintento texto={r.error} onReintentar={r.permiso || r.status === 400 ? undefined : () => setIntento((i) => i + 1)} />
      )}

      {d && (
        <div className="space-y-4" style={{ opacity: cargando ? 0.45 : 1, transition: "opacity .2s" }} aria-busy={cargando}>
          {cargando && <Nota>Midiendo el periodo nuevo… mientras tanto se ven los números de {fmtFecha(d.desde)} – {fmtFecha(d.hasta)}.</Nota>}
          <Contenido d={d} metrica={metrica} setMetrica={setMetrica} />
        </div>
      )}
    </div>
  );
}

// ─── El contenido medido ──────────────────────────────────────────────────────

function Contenido({ d, metrica, setMetrica }: { d: RespuestaUso; metrica: MetricaSerie; setMetrica: (m: MetricaSerie) => void }) {
  const a = d.actual, p = d.anterior, v = d.comparacion.variaciones;
  const cob = a.km.cobertura;
  const sinUsoMant = a.unidades.sinUso.filter((u) => u.motivo === "en_mantenimiento").length;
  const met = METRICAS_SERIE.find((m) => m.k === metrica) ?? METRICAS_SERIE[0];
  const diasKmPiso = metrica === "km" ? a.serie.filter((x) => x.kmPiso).length : 0;
  const difTerc = v.pctTercerizado.diferencia;

  const unidades = [...a.porUnidad]
    .filter((u) => u.servicios > 0 || u.cargas > 0 || u.km != null)
    .sort((x, y) => y.servicios - x.servicios || (y.km ?? -1) - (x.km ?? -1) || x.placa.localeCompare(y.placa));
  const sinActividad = a.porUnidad.length - unidades.length;
  const rel = d.relleno;

  return (
    <>
      {/* ── Fichas ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Ficha label="Km recorridos" valor={kmDe(a)} previo={kmDe(p)} delta={v.km.pct} sentido={v.km.sentido}
          nota={a.km.total == null
            ? "(no es cero) ninguna jornada con servicio tiene km medido"
            : cob.jornadasConServicio > 0
              ? <>odómetro en {cob.conOdometro} de {cob.jornadasConServicio} jornadas con servicio{cob.pct != null ? ` (${fmtNum(cob.pct)} %)` : ""}
                {cob.conGps > 0 && <> · {cob.conGps} por GPS (mínimo)</>}
                {cob.sinDato > 0 && <> · <span className="text-amber-700">{cob.sinDato} sin dato</span></>}
                {cob.tope > 0 && <> · <span className="text-amber-700">{cob.tope} sin medir (tope)</span></>}</>
              : "sin jornadas con servicio"} />
        <Ficha label="Servicios" valor={fmtNum(a.servicios.noCancelados)} previo={fmtNum(p.servicios.noCancelados)}
          delta={v.servicios.pct} sentido={v.servicios.sentido}
          nota={<>no cancelados: {a.servicios.prestados} prestados
            {a.servicios.sinCerrar > 0 && <> · <span className="text-amber-700 font-bold" title="De un día pasado y sin cerrar (programada, confirmada, pendiente o en curso de otro día): no se sabe si salió.">{a.servicios.sinCerrar} sin cerrar</span></>}
            {a.servicios.enCurso > 0 && <> · {a.servicios.enCurso} en curso</>}
            {a.servicios.programados > 0 && <> · {a.servicios.programados} por salir</>}</>} />
        <Ficha label="Horas en servicio" valor={horasDe(a)} previo={horasDe(p)} delta={v.horas.pct} sentido={v.horas.sentido}
          nota={a.horas.total == null
            ? <>(no es cero) {a.horas.sinHora} servicio(s) terminado(s) y ninguno con hora</>
            : a.horas.sinHora > 0
              ? <><span className="text-amber-700">{a.horas.sinHora} servicio(s) sin hora</span>: no suman (no se inventa ninguna)</>
              : `de ${a.horas.conHora} servicio(s) con inicio y fin`} />
        <Ficha label="Unidades activas" valor={`${a.unidades.activas} / ${a.unidades.flota}`}
          previo={`${p.unidades.activas} / ${p.unidades.flota}`} delta={v.unidadesActivas.pct} sentido={v.unidadesActivas.sentido}
          nota="con algún servicio, sobre la flota propia de hoy" />
        <Ficha label="Unidades sin uso" valor={fmtNum(a.unidades.sinUso.length)} previo={fmtNum(p.unidades.sinUso.length)}
          delta={v.unidadesSinUso.pct} sentido={v.unidadesSinUso.sentido}
          nota={a.unidades.sinUso.length ? `${sinUsoMant} en mantenimiento · lista abajo` : "toda la flota tuvo algún servicio"} />
        <Ficha label="Gasto de combustible" valor={gastoDe(a)} previo={gastoDe(p)} delta={v.gastoCombustible.pct} sentido={v.gastoCombustible.sentido}
          nota={!a.combustible.leido
            ? "(no es cero) no se pudieron leer las cargas"
            : <>{a.combustible.cargas} carga(s) propias{a.combustible.cargasSinImporte > 0 && <> · <span className="text-amber-700">{a.combustible.cargasSinImporte} sin importe</span></>}</>} />
        <Ficha label="CO₂ de lo comprado" valor={co2De(a)} previo={co2De(p)} delta={v.co2.pct} sentido={v.co2.sentido}
          nota={!a.combustible.leido
            ? "(no es cero) no se pudieron leer las cargas"
            : <>estimado sobre lo comprado
              {a.combustible.cargasSinFactor > 0 && <> · {a.combustible.cargasSinFactor} carga(s) sin factor{a.combustible.cargasAditivo > 0 ? ` (${a.combustible.cargasAditivo} de urea)` : ""}</>}
              {a.combustible.cargasSinCantidad > 0 && <> · <span className="text-amber-700">{a.combustible.cargasSinCantidad} sin cantidad</span></>}</>} />
        <Ficha label="% tercerizado" valor={pctTercDe(a)} previo={pctTercDe(p)} delta={v.pctTercerizado.pct} sentido={v.pctTercerizado.sentido}
          nota={<>{a.servicios.tercerizados} de {a.servicios.noCancelados} servicios
            {difTerc != null && <> · {difTerc > 0 ? "+" : difTerc < 0 ? "−" : "±"}{fmtNum(Math.abs(difTerc), 1)} puntos</>}</>} />
      </div>

      {/* ── Lo que hace engañosa la comparación (lo redacta el motor) ── */}
      {d.comparacion.avisos.length > 0 && (
        <Ambar>
          <ul className="space-y-1">
            {d.comparacion.avisos.map((x) => <li key={x.codigo}>⚠ {x.texto}</li>)}
          </ul>
        </Ambar>
      )}
      {(rel.sinMedirPorTope > 0 || rel.noLeidas > 0) && (
        <Ambar>
          De {rel.candidatos} servicio(s) sin jornada de odómetro (los dos periodos) se midieron por GPS {rel.medidas}.
          {rel.sinMedirPorTope > 0 && <> {rel.sinMedirPorTope} quedaron sin medir por {rel.porTiempo ? "el tiempo de la consulta" : `el tope de ${rel.maxTrazas} trazas por consulta`}: su km sale «sin medir (tope)», no cero.</>}
          {rel.noLeidas > 0 && <> {rel.noLeidas} no se pudieron leer: su km sale «sin dato», no cero.</>}
          {" "}Un periodo más corto mide más.
        </Ambar>
      )}

      {/* ── Serie diaria ── */}
      <section className="bg-white rounded-2xl border shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold text-gray-800 text-sm">Día a día contra el periodo anterior</h3>
          <div className="flex flex-wrap gap-1">
            {METRICAS_SERIE.map((m) => (
              <button key={m.k} type="button" onClick={() => setMetrica(m.k)} aria-pressed={metrica === m.k}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold min-h-[32px] ${metrica === m.k ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                style={metrica === m.k ? { background: "#0b315f" } : undefined}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <SerieComparada
          actual={a.serie.map((x) => ({ fecha: x.fecha, valor: met.de(x) }))}
          previa={p.serie.map((x) => ({ fecha: x.fecha, valor: met.de(x) }))}
          unidad={met.unidad}
          etiquetas={{ actual: "Este periodo", previa: "Periodo anterior" }}
          formatear={met.fmt}
          vacio="Sin datos en los dos periodos"
        />
        {diasKmPiso > 0 && (
          <p className="text-[11px] text-slate-500">
            En {diasKmPiso} día(s) el km es un mínimo (≥): alguna jornada con servicio no tiene odómetro y su km sale del GPS, que solo se queda corto.
          </p>
        )}
        {metrica === "co2" && <p className="text-[11px] text-slate-500">CO₂ de lo comprado ese día (cargas propias × factor), no del recorrido: una carga se compra un día y se quema varios.</p>}
      </section>

      {/* ── Combustible comprado por familia ── */}
      {a.combustible.leido && a.combustible.cargas > 0 && (
        <section className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
          <h3 className="font-bold text-gray-800 text-sm">Combustible comprado (cargas propias)</h3>
          <p className="text-[11px] text-gray-400">Cada combustible en su unidad: los galones y los m³ no se suman. Lo que sí se suma son soles y kilos.</p>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs min-w-[460px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                  <th className="px-1 py-1.5">Combustible</th>
                  <th className="px-1 py-1.5 text-right">Cantidad</th>
                  <th className="px-1 py-1.5 text-right">Gasto</th>
                  <th className="px-1 py-1.5 text-right">CO₂ (estimado)</th>
                  <th className="px-1 py-1.5 text-right">Cargas</th>
                </tr>
              </thead>
              <tbody>
                {a.combustible.porFamilia.map((f) => (
                  <tr key={f.familia} className="border-t border-gray-100">
                    <td className="px-1 py-1.5 font-bold text-gray-700">{nombreFamilia(f.familia)}</td>
                    <td className="px-1 py-1.5 text-right tabular-nums">
                      {fmtNum(f.cantidad, 1)} {f.unidadLabel}
                      {f.cargasSinCantidad > 0 && <span className="block text-[10px] text-amber-700">+{f.cargasSinCantidad} carga(s) sin cantidad</span>}
                    </td>
                    <td className="px-1 py-1.5 text-right tabular-nums">{fmtSoles(f.gasto)}</td>
                    <td className="px-1 py-1.5 text-right tabular-nums">{f.co2Kg == null ? <span className="text-gray-400" title="Sin factor de emisión declarado (o sin cantidad estimable): no es cero.">sin factor</span> : fmtKg(f.co2Kg)}</td>
                    <td className="px-1 py-1.5 text-right tabular-nums text-gray-500">{f.cargas}</td>
                  </tr>
                ))}
                {a.combustible.sinFamilia.cargas > 0 && (
                  <tr className="border-t border-gray-100 text-amber-800">
                    <td className="px-1 py-1.5 font-bold">Tipo no reconocido</td>
                    <td className="px-1 py-1.5 text-right" title="Su cantidad no se puede sumar a ningún combustible.">—</td>
                    <td className="px-1 py-1.5 text-right tabular-nums">{fmtSoles(a.combustible.sinFamilia.gasto)}</td>
                    <td className="px-1 py-1.5 text-right">sin factor</td>
                    <td className="px-1 py-1.5 text-right tabular-nums">{a.combustible.sinFamilia.cargas}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Por unidad ── */}
      <section className="bg-white rounded-2xl border shadow-sm">
        <div className="px-4 pt-4 pb-2">
          <h3 className="font-bold text-gray-800 text-sm">Por unidad</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Unidades propias con servicios, cargas o km en el periodo.
            {sinActividad > 0 && ` ${sinActividad} sin ninguna actividad: están en «Sin uso».`}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[860px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500" style={{ background: "#f8fafc" }}>
                <th className="px-3 py-2 sticky left-0 z-10" style={{ background: "#f8fafc" }}>Placa</th>
                <th className="px-3 py-2 text-right">Servicios</th>
                <th className="px-3 py-2 text-right">Días activos</th>
                <th className="px-3 py-2 text-right">Km</th>
                <th className="px-3 py-2">Km por día, según</th>
                <th className="px-3 py-2 text-right">Horas</th>
                <th className="px-3 py-2 text-right">Gasto comb.</th>
                <th className="px-3 py-2 text-right">CO₂ comprado</th>
                <th className="px-3 py-2">Cantidad comprada</th>
              </tr>
            </thead>
            <tbody>
              {unidades.map((u) => <FilaUnidad key={u.vehiculoId} u={u} leido={a.combustible.leido} />)}
              {!unidades.length && (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">Ninguna unidad propia tuvo servicios, cargas ni km en el periodo.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Sin uso ── */}
      <section className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
        <h3 className="font-bold text-gray-800 text-sm">Sin uso en el periodo ({a.unidades.sinUso.length})</h3>
        <p className="text-[11px] text-gray-400">Unidades de la flota de hoy sin ningún servicio no cancelado entre {fmtFecha(d.desde)} y {fmtFecha(d.hasta)}.</p>
        {a.unidades.sinUso.length === 0 ? (
          <p className="text-xs text-gray-500">Toda la flota de hoy tuvo al menos un servicio.</p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {a.unidades.sinUso.map((u) => (
              <div key={u.vehiculoId} className="rounded-xl border px-3 py-2 text-xs">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono font-black text-[#0b315f]">{u.placa}</span>
                  {u.categoria && <span className="text-gray-400 truncate">{u.categoria}</span>}
                </div>
                <p className={u.motivo === "en_mantenimiento" ? "text-slate-600 mt-0.5" : "text-gray-600 mt-0.5"}>{MOTIVO_SIN_USO[u.motivo]}</p>
                <p className="text-[11px] text-gray-400">
                  Último servicio:{" "}
                  {!u.ultimoServicioLeido ? <span className="text-amber-700">no se pudo leer</span>
                    : u.ultimoServicio ? fmtFecha(u.ultimoServicio) : "ninguno registrado"}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Cómo se mide ── */}
      <ComoSeMide>
        <ul className="list-disc pl-4 space-y-1">
          {d.notas.map((n) => <li key={n}>{n}</li>)}
        </ul>
        <div>
          <p className="font-bold text-gray-700 mb-1">De dónde sale el km de cada unidad y día</p>
          <ul className="space-y-0.5">
            {FUENTES_KM_DIA.map((k) => <li key={k}><b>{FUENTE_KM[k].label}</b>: {FUENTE_KM[k].title}</li>)}
          </ul>
        </div>
        <div>
          <p className="font-bold text-gray-700 mb-1">Constantes</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px]">
              <tbody>
                {d.constantes.map((c) => (
                  <tr key={c.clave} className="border-t border-gray-100 align-top">
                    <td className="py-1.5 pr-3 whitespace-nowrap font-bold text-gray-700">{fmtNum(c.valor)} {c.unidad}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-gray-400">{PROCEDENCIA[c.procedencia]}</td>
                    <td className="py-1.5">{c.texto}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-gray-400">Medido el {new Date(d.medidoEn).toLocaleString("es-PE", { timeZone: "America/Lima" })} (hora de Lima)</p>
      </ComoSeMide>
    </>
  );
}

function FilaUnidad({ u, leido }: { u: UnidadUso; leido: boolean }) {
  const sinCargas = leido && u.cargas === 0;
  return (
    <tr className="border-t border-gray-100 hover:bg-gray-50/60">
      <td className="px-3 py-2 sticky left-0 bg-white z-10">
        <span className="font-mono font-black text-[#0b315f]">{u.placa}</span>
        {u.categoria && <span className="block text-[10px] text-gray-400 truncate max-w-[140px]">{u.categoria}</span>}
        {!u.enFlota && <span className="block text-[10px] text-slate-500" title="No está en la flota de hoy (inactiva o sin ficha), pero tuvo actividad en el periodo.">fuera de la flota de hoy</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {u.servicios}
        {u.servicios > 0 && <span className="block text-[10px] text-gray-400 whitespace-nowrap">{u.prestados} prestado(s)</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{u.diasActivos}</td>
      <td className="px-3 py-2 text-right tabular-nums font-bold text-gray-800 whitespace-nowrap">
        {u.km == null ? <span className="font-normal text-gray-400" title="Ninguna jornada con km medido: no es cero.">sin dato</span> : `${u.kmPiso ? "≥ " : ""}${fmtKm(u.km)}`}
      </td>
      <td className="px-3 py-2 text-[11px]">{textoFuentes(u.kmFuentes)}</td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
        {u.horas == null ? <span className="text-gray-400">sin dato</span> : fmtHoras(u.horas)}
        {u.serviciosSinHora > 0 && <span className="block text-[10px] text-amber-700">{u.serviciosSinHora} sin hora</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
        {sinCargas ? <span className="text-gray-300">sin cargas</span>
          : u.gasto == null ? <span className="text-gray-400" title={leido ? "Tuvo cargas y ninguna con importe." : "No se pudieron leer las cargas."}>sin dato</span>
            : fmtSoles(u.gasto)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
        {sinCargas ? <span className="text-gray-300">sin cargas</span>
          : u.co2Kg == null ? <span className="text-gray-400" title="Tuvo cargas que emiten y ninguna estimable (o no se pudieron leer).">sin dato</span>
            : fmtKg(u.co2Kg)}
      </td>
      <td className="px-3 py-2 text-[11px] text-gray-600">
        {u.porFamilia.length
          ? u.porFamilia.map((f, i) => <span key={f.familia} className="whitespace-nowrap">{i > 0 && " · "}{fmtNum(f.cantidad, 1)} {f.unidadLabel} {nombreFamilia(f.familia)}</span>)
          : <span className="text-gray-300">—</span>}
      </td>
    </tr>
  );
}

/** Los enlaces de la cabecera: lo que esta pantalla NO duplica. */
export function EnlacesResumen() {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <Link href="/combustible?vista=analisis" prefetch={false}
        className="px-3 py-2 rounded-xl border bg-white font-bold text-[#0b315f] hover:bg-[#eef3f8] min-h-[36px] inline-flex items-center">
        ⛽ Costo por km y rendimiento
      </Link>
      <Link href="/auditoria-jornada" prefetch={false}
        className="px-3 py-2 rounded-xl border bg-white font-bold text-[#0b315f] hover:bg-[#eef3f8] min-h-[36px] inline-flex items-center">
        🧾 Auditoría de km (GPS vs odómetro)
      </Link>
    </div>
  );
}
