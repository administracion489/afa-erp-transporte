"use client";

// Las secciones de /seguridad-vial. NO DECIDEN NADA: los textos de cada código (episodio,
// velocímetro, motivo del total) y las constantes salen de lib/flota/excesos.ts tal cual; aquí solo
// se ordena y se pinta. Un «no se puede juzgar» nunca se pinta como 0, y la RUTA y el
// ORIGEN → DESTINO van siempre por separado (lib/ruta-identidad.ts).

import React, { useMemo, useState } from "react";
import {
  CODIGOS_DESCARTE, CODIGOS_EPISODIO, TEXTO_EPISODIO, TEXTO_VELOCIMETRO, textoDuracion,
  type CodigoDescarte, type ConstanteExcesos, type Episodio, type FilaConductorExcesos, type FilaUnidadExcesos,
  type ProcedenciaConstante, type ServicioExpuesto, type Velocimetro,
} from "@/lib/flota/excesos";
import { ETIQUETA_RECORRIDO, ETIQUETA_RUTA, SIN_NOMBRE_RUTA, SIN_RECORRIDO } from "@/lib/ruta-identidad";
import { fechaCorta, fechaHoraLima, ordenarPor, type Sentido } from "./excesos-vista";

// ── Directorio: de una clave a lo que se lee ─────────────────────────────────

export type InfoConductor = { nombre: string; tercero: boolean; velocimetro: Velocimetro | null };
export type InfoUnidad = { placa: string; tercero: boolean };
export type Directorio = {
  conductor: (clave: string | null) => InfoConductor;
  unidad: (clave: string | null) => InfoUnidad;
  servicio: (id: number | null) => ServicioExpuesto | null;
};

const kmh = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)} km/h`);
const pct = (x: number | null) => (x == null ? null : `${Math.round(x * 100)} %`);

function EtiquetaFlota({ tercero }: { tercero: boolean }) {
  return tercero
    ? <span className="ml-1 text-[10px] font-bold text-purple-700">(3ro)</span>
    : null;
}

export function ChipVelocimetro({ v }: { v: Velocimetro | null }) {
  if (!v) return <span className="text-xs text-gray-400">—</span>;
  const t = TEXTO_VELOCIMETRO[v];
  // Informativo en los cuatro: con velocímetro en azul (se puede juzgar), el resto en gris.
  const cls = v === "con_velocimetro" ? "bg-blue-50 text-[#0b315f] border-blue-100" : "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span title={t.detalle} className={`inline-block rounded-lg border px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${cls}`}>
      {t.titulo}
    </span>
  );
}

// ── Cabecera ordenable ────────────────────────────────────────────────────────

export type Orden<K extends string> = { clave: K | null; sentido: Sentido };

function Th<K extends string>({ label, k, orden, setOrden, alinear = "left", titulo }: {
  label: string; k?: K; orden?: Orden<K>; setOrden?: (o: Orden<K>) => void; alinear?: "left" | "right"; titulo?: string;
}) {
  const activo = k != null && orden?.clave === k;
  const base = `p-3 text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap ${alinear === "right" ? "text-right" : "text-left"}`;
  if (k == null || !orden || !setOrden) return <th className={base} title={titulo}>{label}</th>;
  return (
    <th className={base} title={titulo} aria-sort={activo ? (orden.sentido === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => setOrden(activo ? { clave: k, sentido: orden.sentido === "asc" ? "desc" : "asc" } : { clave: k, sentido: "desc" })}
        className={`inline-flex items-center gap-1 uppercase hover:text-[#0b315f] ${activo ? "text-[#0b315f]" : ""}`}
      >
        {label}<span className="text-[9px]">{activo ? (orden.sentido === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

function Tarjeta({ titulo, sub, children }: { titulo: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm min-w-0">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-base font-bold text-gray-800">{titulo}</h2>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

const Vacio = ({ texto, cols }: { texto: string; cols: number }) => (
  <tr><td colSpan={cols} className="p-6 text-center text-sm text-gray-400">{texto}</td></tr>
);

/** El selector de orden de las tarjetas (móvil): las cabeceras de la tabla no se ven ahí. */
function OrdenMovil<K extends string>({ id, orden, setOrden, opciones }: {
  id: string; orden: Orden<K>; setOrden: (o: Orden<K>) => void; opciones: { clave: K | null; sentido: Sentido; etiqueta: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pb-2 text-xs text-gray-500">
      <label htmlFor={id}>Ordenar:</label>
      <select
        id={id}
        value={`${orden.clave ?? ""}|${orden.sentido}`}
        onChange={(ev) => {
          const [k, sd] = ev.target.value.split("|");
          setOrden({ clave: (k || null) as K | null, sentido: sd as Sentido });
        }}
        className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white"
      >
        {!opciones.some((o) => o.clave === orden.clave && o.sentido === orden.sentido) && (
          <option value={`${orden.clave ?? ""}|${orden.sentido}`}>Por defecto</option>
        )}
        {opciones.map((o) => <option key={`${o.clave}|${o.sentido}`} value={`${o.clave ?? ""}|${o.sentido}`}>{o.etiqueta}</option>)}
      </select>
    </div>
  );
}

/** «2 / 5 (40 %)»: servicios con exceso / prestados. Sin juicio, el numerador es «—», nunca 0. */
function Servicios({ con, prestados, tasa }: { con: number | null; prestados: number; tasa: number | null }) {
  return (
    <>
      {con == null ? "—" : con} / {prestados}
      {pct(tasa) && <span className="ml-1 text-[11px] text-gray-400">({pct(tasa)})</span>}
    </>
  );
}

const Dato = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="min-w-0"><dt className="text-gray-400">{k}</dt><dd className="font-semibold text-gray-800">{children}</dd></div>
);

// ── Por conductor ─────────────────────────────────────────────────────────────

type ClaveConductor = "nombre" | "excesos" | "segundos" | "velPico" | "velSostenida" | "tasa";

export function SeccionConductores({ filas, dir, umbral }: { filas: readonly FilaConductorExcesos[]; dir: Directorio; umbral: number }) {
  const [orden, setOrden] = useState<Orden<ClaveConductor>>({ clave: null, sentido: "desc" });
  const lista = useMemo(() => {
    const k = orden.clave;
    const f = k == null ? null
      : k === "nombre" ? (x: FilaConductorExcesos) => dir.conductor(x.conductor).nombre
      : (x: FilaConductorExcesos) => x[k];
    return ordenarPor(filas, f, orden.sentido);
  }, [filas, orden, dir]);
  const vacio = "Ningún conductor con servicios prestados ni excesos en el rango.";
  return (
    <Tarjeta
      titulo="Por conductor"
      sub={<>Quien llevaba el teléfono, no el asignado. «Servicios» = con exceso / prestados en el rango. Umbral {umbral} km/h.</>}
    >
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-y border-slate-200">
              <Th label="Conductor" k="nombre" orden={orden} setOrden={setOrden} />
              <Th label="Excesos" k="excesos" orden={orden} setOrden={setOrden} alinear="right" />
              <Th label="Tiempo" k="segundos" orden={orden} setOrden={setOrden} alinear="right" titulo="Tiempo total por encima del umbral, sumando sus excesos" />
              <Th label="Pico" k="velPico" orden={orden} setOrden={setOrden} alinear="right" titulo="La mayor velocidad que marcó el sensor dentro de un exceso" />
              <Th label="Sostenida" k="velSostenida" orden={orden} setOrden={setOrden} alinear="right" titulo="La mayor velocidad media de uno de sus excesos" />
              <Th label="Servicios" k="tasa" orden={orden} setOrden={setOrden} alinear="right" titulo="Servicios con exceso / servicios prestados (ordena por la proporción)" />
              <Th label="Velocímetro" />
            </tr>
          </thead>
          <tbody>
            {lista.length === 0 ? <Vacio cols={7} texto={vacio} /> : lista.map((f) => {
              const c = dir.conductor(f.conductor);
              return (
                <tr key={f.conductor} className="border-t border-slate-100 hover:bg-gray-50">
                  <td className="p-3 min-w-[12rem]">
                    <div className="font-semibold text-gray-800">{c.nombre}<EtiquetaFlota tercero={c.tercero} /></div>
                  </td>
                  {f.excesos != null ? (
                    <>
                      <td className={`p-3 text-right font-bold ${f.excesos > 0 ? "text-red-700" : "text-gray-700"}`}>{f.excesos}</td>
                      <td className="p-3 text-right text-gray-700 whitespace-nowrap">{f.segundos ? textoDuracion(f.segundos) : "—"}</td>
                    </>
                  ) : (
                    <td colSpan={2} className="p-3 text-right text-xs text-gray-500" title={TEXTO_VELOCIMETRO[f.velocimetro].detalle}>
                      No se puede juzgar
                    </td>
                  )}
                  <td className="p-3 text-right text-gray-700 whitespace-nowrap">{kmh(f.velPico)}</td>
                  <td className="p-3 text-right text-gray-700 whitespace-nowrap">{kmh(f.velSostenida)}</td>
                  <td className="p-3 text-right text-gray-700 whitespace-nowrap">
                    <Servicios con={f.serviciosConExceso} prestados={f.serviciosPrestados} tasa={f.tasa} />
                  </td>
                  <td className="p-3"><ChipVelocimetro v={f.velocimetro} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="md:hidden px-3 pb-3">
        <OrdenMovil id="orden-conductores" orden={orden} setOrden={setOrden} opciones={[
          { clave: "excesos", sentido: "desc", etiqueta: "Más excesos primero" },
          { clave: "segundos", sentido: "desc", etiqueta: "Más tiempo en exceso" },
          { clave: "velSostenida", sentido: "desc", etiqueta: "Mayor velocidad sostenida" },
          { clave: "tasa", sentido: "desc", etiqueta: "Mayor proporción de servicios" },
          { clave: "nombre", sentido: "asc", etiqueta: "Por nombre" },
        ]} />
        {lista.length === 0 ? <p className="p-4 text-center text-sm text-gray-400">{vacio}</p> : (
          <ul className="space-y-2">
            {lista.map((f) => {
              const c = dir.conductor(f.conductor);
              return (
                <li key={f.conductor} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 text-sm font-semibold text-gray-800 break-words">{c.nombre}<EtiquetaFlota tercero={c.tercero} /></div>
                    <ChipVelocimetro v={f.velocimetro} />
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    {f.excesos != null ? (
                      <>
                        <Dato k="Excesos"><span className={f.excesos > 0 ? "text-red-700" : ""}>{f.excesos}</span></Dato>
                        <Dato k="Tiempo">{f.segundos ? textoDuracion(f.segundos) : "—"}</Dato>
                      </>
                    ) : (
                      <div className="col-span-2 text-gray-500" title={TEXTO_VELOCIMETRO[f.velocimetro].detalle}>No se puede juzgar (ver su velocímetro).</div>
                    )}
                    <Dato k="Pico · sostenida">{kmh(f.velPico)} · {kmh(f.velSostenida)}</Dato>
                    <Dato k="Servicios con exceso / prestados"><Servicios con={f.serviciosConExceso} prestados={f.serviciosPrestados} tasa={f.tasa} /></Dato>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Tarjeta>
  );
}

// ── Por unidad ────────────────────────────────────────────────────────────────

type ClaveUnidad = "placa" | "excesos" | "segundos" | "velPico" | "velSostenida" | "tasa";

const UNIDAD_NO_JUZGABLE = "Ninguno de los conductores de sus servicios tiene un teléfono que reporte la velocidad del sensor.";

export function SeccionUnidades({ filas, dir }: { filas: readonly FilaUnidadExcesos[]; dir: Directorio }) {
  const [orden, setOrden] = useState<Orden<ClaveUnidad>>({ clave: null, sentido: "desc" });
  const lista = useMemo(() => {
    const k = orden.clave;
    const f = k == null ? null
      : k === "placa" ? (x: FilaUnidadExcesos) => dir.unidad(x.unidad).placa
      : (x: FilaUnidadExcesos) => x[k];
    return ordenarPor(filas, f, orden.sentido);
  }, [filas, orden, dir]);
  const vacio = "Ninguna unidad con servicios prestados ni excesos en el rango.";
  return (
    <Tarjeta titulo="Por unidad" sub="La unidad escrita en el servicio. Se puede juzgar si alguno de sus servicios lo manejó alguien con velocímetro.">
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-y border-slate-200">
              <Th label="Unidad" k="placa" orden={orden} setOrden={setOrden} />
              <Th label="Excesos" k="excesos" orden={orden} setOrden={setOrden} alinear="right" />
              <Th label="Tiempo" k="segundos" orden={orden} setOrden={setOrden} alinear="right" />
              <Th label="Pico" k="velPico" orden={orden} setOrden={setOrden} alinear="right" />
              <Th label="Sostenida" k="velSostenida" orden={orden} setOrden={setOrden} alinear="right" />
              <Th label="Servicios" k="tasa" orden={orden} setOrden={setOrden} alinear="right" titulo="Servicios con exceso / servicios prestados" />
            </tr>
          </thead>
          <tbody>
            {lista.length === 0 ? <Vacio cols={6} texto={vacio} /> : lista.map((f) => {
              const u = dir.unidad(f.unidad);
              return (
                <tr key={f.unidad} className="border-t border-slate-100 hover:bg-gray-50">
                  <td className="p-3 font-semibold text-gray-800 whitespace-nowrap">{u.placa}<EtiquetaFlota tercero={u.tercero} /></td>
                  {f.excesos != null ? (
                    <>
                      <td className={`p-3 text-right font-bold ${f.excesos > 0 ? "text-red-700" : "text-gray-700"}`}>{f.excesos}</td>
                      <td className="p-3 text-right text-gray-700 whitespace-nowrap">{f.segundos ? textoDuracion(f.segundos) : "—"}</td>
                    </>
                  ) : (
                    <td colSpan={2} className="p-3 text-right text-xs text-gray-500" title={UNIDAD_NO_JUZGABLE}>No se puede juzgar</td>
                  )}
                  <td className="p-3 text-right text-gray-700 whitespace-nowrap">{kmh(f.velPico)}</td>
                  <td className="p-3 text-right text-gray-700 whitespace-nowrap">{kmh(f.velSostenida)}</td>
                  <td className="p-3 text-right text-gray-700 whitespace-nowrap">
                    <Servicios con={f.serviciosConExceso} prestados={f.serviciosPrestados} tasa={f.tasa} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="md:hidden px-3 pb-3">
        <OrdenMovil id="orden-unidades" orden={orden} setOrden={setOrden} opciones={[
          { clave: "excesos", sentido: "desc", etiqueta: "Más excesos primero" },
          { clave: "segundos", sentido: "desc", etiqueta: "Más tiempo en exceso" },
          { clave: "velSostenida", sentido: "desc", etiqueta: "Mayor velocidad sostenida" },
          { clave: "placa", sentido: "asc", etiqueta: "Por placa" },
        ]} />
        {lista.length === 0 ? <p className="p-4 text-center text-sm text-gray-400">{vacio}</p> : (
          <ul className="space-y-2">
            {lista.map((f) => {
              const u = dir.unidad(f.unidad);
              return (
                <li key={f.unidad} className="rounded-xl border border-slate-200 p-3">
                  <div className="text-sm font-semibold text-gray-800">{u.placa}<EtiquetaFlota tercero={u.tercero} /></div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    {f.excesos != null ? (
                      <>
                        <Dato k="Excesos"><span className={f.excesos > 0 ? "text-red-700" : ""}>{f.excesos}</span></Dato>
                        <Dato k="Tiempo">{f.segundos ? textoDuracion(f.segundos) : "—"}</Dato>
                      </>
                    ) : (
                      <div className="col-span-2 text-gray-500">No se puede juzgar: {UNIDAD_NO_JUZGABLE.charAt(0).toLowerCase() + UNIDAD_NO_JUZGABLE.slice(1)}</div>
                    )}
                    <Dato k="Pico · sostenida">{kmh(f.velPico)} · {kmh(f.velSostenida)}</Dato>
                    <Dato k="Servicios con exceso / prestados"><Servicios con={f.serviciosConExceso} prestados={f.serviciosPrestados} tasa={f.tasa} /></Dato>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Tarjeta>
  );
}

// ── Episodios ─────────────────────────────────────────────────────────────────

/** La identidad del servicio de un episodio: RUTA y ORIGEN → DESTINO por separado, o «fuera de servicio». */
function ServicioDe({ e, dir, compacto = false }: { e: Episodio; dir: Directorio; compacto?: boolean }) {
  if (e.reservaId == null) {
    return <span className="text-xs font-semibold text-gray-500">Fuera de servicio <span className="font-normal">(la app abierta sin servicio)</span></span>;
  }
  const s = dir.servicio(e.reservaId);
  if (!s) return <span className="text-xs text-gray-500">Servicio #{e.reservaId} <span className="text-gray-400">(no se pudieron leer sus datos)</span></span>;
  const cab = [`#${s.reservaId}`, s.codigo, s.fecha ? `${fechaCorta(s.fecha)}${s.hora ? ` ${s.hora}` : ""}` : null, s.cliente].filter(Boolean).join(" · ");
  return (
    <div className={`min-w-0 ${compacto ? "" : "max-w-[300px]"}`}>
      <div className="text-xs text-gray-500 break-words">{cab}</div>
      <div className="text-xs mt-0.5 break-words">
        <span className="font-bold text-gray-500">{ETIQUETA_RUTA}:</span>{" "}
        <span className={s.ruta.nombre ? "text-gray-800 font-semibold" : "text-gray-400 italic"}>{s.ruta.nombre ?? SIN_NOMBRE_RUTA}</span>
      </div>
      <div className="text-xs break-words">
        <span className="font-bold text-gray-500">{ETIQUETA_RECORRIDO}:</span>{" "}
        <span className={s.ruta.recorrido ? "text-gray-700" : "text-gray-400 italic"}>{s.ruta.recorrido ?? SIN_RECORRIDO}</span>
      </div>
    </div>
  );
}

const enlaceRecorrido = (e: Episodio) => e.reservaId != null ? (
  <a href={`/seguimiento/gps/${e.reservaId}`} target="_blank" rel="noopener noreferrer"
    className="inline-block rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-[#0b315f] hover:bg-blue-50 whitespace-nowrap">
    Ver recorrido ↗
  </a>
) : null;

type ClaveEpisodio = "inicio" | "durS" | "velMediaSensor" | "velMaxSensor" | "velGeom" | "conductor";

export function SeccionEpisodios({ titulo, sub, episodios, dir, resaltar, vacio }: {
  titulo: string; sub?: React.ReactNode; episodios: readonly Episodio[]; dir: Directorio; resaltar: number | null; vacio: string;
}) {
  const [orden, setOrden] = useState<Orden<ClaveEpisodio>>({ clave: null, sentido: "asc" });
  const lista = useMemo(() => {
    const k = orden.clave;
    const f = k == null ? null
      : k === "inicio" ? (x: Episodio) => x.inicioTs
      : k === "conductor" ? (x: Episodio) => dir.conductor(x.conductor).nombre
      : (x: Episodio) => x[k];
    return ordenarPor(episodios, f, orden.sentido);
  }, [episodios, orden, dir]);
  const marcado = (e: Episodio) => resaltar != null && e.reservaId === resaltar;
  const idFila = (e: Episodio, i: number) => (marcado(e) && lista.findIndex(marcado) === i ? `exceso-servicio-${resaltar}` : undefined);

  return (
    <Tarjeta titulo={titulo} sub={sub}>
      {/* Escritorio: tabla. El porqué de cada uno lo compone el motor y va debajo de su fila. */}
      <div className="hidden lg:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-y border-slate-200">
              <Th label="Inicio (Lima)" k="inicio" orden={orden} setOrden={setOrden} />
              <Th label="Conductor · unidad" k="conductor" orden={orden} setOrden={setOrden} />
              <Th label="Servicio" />
              <Th label="Duración" k="durS" orden={orden} setOrden={setOrden} alinear="right" />
              <Th label="Sensor" k="velMediaSensor" orden={orden} setOrden={setOrden} alinear="right" titulo="Media del sensor durante el exceso (la velocidad sostenida) y su pico" />
              <Th label="Posiciones" k="velGeom" orden={orden} setOrden={setOrden} alinear="right" titulo="Distancia en línea recta entre muestras / duración: una cota inferior de lo recorrido" />
              <Th label="Precisión" alinear="right" titulo="Precisión mediana del GPS durante el exceso" />
              <Th label="" />
            </tr>
          </thead>
          <tbody>
            {lista.length === 0 ? <Vacio cols={8} texto={vacio} /> : lista.map((e, i) => {
              const c = dir.conductor(e.conductor), u = dir.unidad(e.vehiculo);
              const m = marcado(e);
              return (
                <React.Fragment key={`${e.inicioTs}|${e.conductor}|${e.reservaId}|${i}`}>
                  <tr id={idFila(e, i)} className={`border-t border-slate-100 align-top ${m ? "bg-blue-50" : ""}`}>
                    <td className="p-3 whitespace-nowrap text-gray-800">
                      {fechaHoraLima(e.inicioTs)}
                      {m && <div className="text-[10px] font-bold text-[#0b315f] mt-0.5">Servicio del enlace</div>}
                    </td>
                    <td className="p-3">
                      <div className="font-semibold text-gray-800">{c.nombre}<EtiquetaFlota tercero={c.tercero} /></div>
                      <div className="text-xs text-gray-500">{u.placa}</div>
                    </td>
                    <td className="p-3"><ServicioDe e={e} dir={dir} /></td>
                    <td className="p-3 text-right whitespace-nowrap text-gray-800">
                      {e.cortado ? "≥ " : ""}{textoDuracion(e.durS)}
                      <div className="text-[11px] text-gray-400">{e.puntos} muestras</div>
                    </td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <span className="font-bold text-gray-800">{kmh(e.velMediaSensor)}</span>
                      <div className="text-[11px] text-gray-400">pico {kmh(e.velMaxSensor)}</div>
                    </td>
                    <td className="p-3 text-right whitespace-nowrap text-gray-700">{kmh(e.velGeom)}</td>
                    <td className="p-3 text-right whitespace-nowrap text-gray-700">{e.precisionMediana == null ? "—" : `${Math.round(e.precisionMediana)} m`}</td>
                    <td className="p-3 text-right">{enlaceRecorrido(e)}</td>
                  </tr>
                  <tr className={m ? "bg-blue-50" : ""}>
                    <td colSpan={8} className="px-3 pb-3 pt-0 text-xs text-gray-500">{e.detalle}</td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Móvil y tableta: tarjetas, sin desplazamiento horizontal. */}
      <div className="lg:hidden px-3 pb-3">
        <OrdenMovil id={`orden-${titulo}`} orden={orden} setOrden={setOrden} opciones={[
          { clave: null, sentido: "asc", etiqueta: "Por hora de inicio" },
          { clave: "durS", sentido: "desc", etiqueta: "Más largos primero" },
          { clave: "velMediaSensor", sentido: "desc", etiqueta: "Más rápidos primero" },
          { clave: "conductor", sentido: "asc", etiqueta: "Por conductor" },
        ]} />
        {lista.length === 0 ? <p className="p-4 text-center text-sm text-gray-400">{vacio}</p> : (
          <ul className="space-y-2">
            {lista.map((e, i) => {
              const c = dir.conductor(e.conductor), u = dir.unidad(e.vehiculo);
              const m = marcado(e);
              return (
                <li key={`${e.inicioTs}|${e.conductor}|${e.reservaId}|${i}`} id={idFila(e, i) ? `${idFila(e, i)}-m` : undefined}
                  className={`rounded-xl border p-3 ${m ? "border-[#0b315f] bg-blue-50" : "border-slate-200"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-gray-800">{c.nombre}<EtiquetaFlota tercero={c.tercero} /></div>
                      <div className="text-xs text-gray-500">{u.placa} · {fechaHoraLima(e.inicioTs)}</div>
                    </div>
                    {enlaceRecorrido(e)}
                  </div>
                  <div className="mt-2"><ServicioDe e={e} dir={dir} compacto /></div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <div><dt className="text-gray-400">Duración</dt><dd className="font-semibold text-gray-800">{e.cortado ? "≥ " : ""}{textoDuracion(e.durS)} · {e.puntos} muestras</dd></div>
                    <div><dt className="text-gray-400">Sensor</dt><dd className="font-semibold text-gray-800">{kmh(e.velMediaSensor)} (pico {kmh(e.velMaxSensor)})</dd></div>
                    <div><dt className="text-gray-400">Posiciones</dt><dd className="text-gray-700">{kmh(e.velGeom)}</dd></div>
                    <div><dt className="text-gray-400">Precisión</dt><dd className="text-gray-700">{e.precisionMediana == null ? "—" : `${Math.round(e.precisionMediana)} m`}</dd></div>
                  </dl>
                  <p className="mt-2 text-xs text-gray-500">{e.detalle}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Tarjeta>
  );
}

// ── Descartados ───────────────────────────────────────────────────────────────

export function SeccionDescartados({ enServicio, fuera, deTodas }: {
  enServicio: Record<CodigoDescarte, number>; fuera: Record<CodigoDescarte, number>; deTodas: boolean;
}) {
  const total = CODIGOS_DESCARTE.reduce((s, k) => s + enServicio[k], 0);
  const totalFuera = CODIGOS_DESCARTE.reduce((s, k) => s + fuera[k], 0);
  return (
    <details className="bg-white rounded-2xl border border-slate-200 shadow-sm group">
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-800">Descartados: no cuentan como exceso</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {total} en servicio · {totalFuera} fuera de servicio{deTodas ? " · de todas las flotas (el motor no los separa por flota)" : ""}
          </p>
        </div>
        <span className="text-xs font-bold text-[#0b315f] whitespace-nowrap group-open:hidden">Ver ▸</span>
        <span className="text-xs font-bold text-[#0b315f] whitespace-nowrap hidden group-open:inline">Ocultar ▾</span>
      </summary>
      <div className="px-4 pb-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-y border-slate-200">
              <th className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Motivo</th>
              <th className="p-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">En servicio</th>
              <th className="p-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">Fuera</th>
            </tr>
          </thead>
          <tbody>
            {CODIGOS_DESCARTE.map((k) => (
              <tr key={k} className="border-t border-slate-100 align-top">
                <td className="p-3">
                  <div className="font-semibold text-gray-800">{TEXTO_EPISODIO[k].titulo}</div>
                  <div className="text-xs text-gray-500">{TEXTO_EPISODIO[k].explicacion}</div>
                </td>
                <td className="p-3 text-right text-gray-700">{enServicio[k]}</td>
                <td className="p-3 text-right text-gray-700">{fuera[k]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ── Cómo se mide ──────────────────────────────────────────────────────────────

/** Cómo se rotula cada procedencia que declara el motor (el código manda; esto solo lo nombra). */
const PROCEDENCIA: Record<ProcedenciaConstante, string> = {
  valor_por_defecto: "Valor por defecto",
  estructural: "Estructural",
  heredada: "Heredada",
  pedido_del_dueno: "Pedido del dueño · no medida",
  no_medida: "No medida",
};

export function ComoSeMide({ constantes }: { constantes: readonly ConstanteExcesos[] }) {
  return (
    <details className="bg-white rounded-2xl border border-slate-200 shadow-sm group">
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-800">Cómo se mide</h2>
          <p className="text-xs text-gray-500 mt-0.5">El veredicto de cada exceso y los números que usa, con su procedencia.</p>
        </div>
        <span className="text-xs font-bold text-[#0b315f] whitespace-nowrap group-open:hidden">Ver ▸</span>
        <span className="text-xs font-bold text-[#0b315f] whitespace-nowrap hidden group-open:inline">Ocultar ▾</span>
      </summary>
      <div className="px-4 pb-4 space-y-4">
        <div>
          <p className="text-sm text-gray-700">
            Un exceso es una racha de muestras del mismo conductor y servicio con la velocidad del sensor en el umbral o más.
            Se juzga en este orden y gana el primer motivo que aplique; solo el último cuenta.
          </p>
          <ol className="mt-2 space-y-1.5">
            {CODIGOS_EPISODIO.map((k, i) => (
              <li key={k} className="text-sm">
                <span className="font-bold text-gray-500 mr-1">{i + 1}.</span>
                <span className={`font-semibold ${TEXTO_EPISODIO[k].cuenta ? "text-red-700" : "text-gray-800"}`}>{TEXTO_EPISODIO[k].titulo}</span>
                <span className="ml-1 text-[11px] font-bold text-gray-400">{TEXTO_EPISODIO[k].cuenta ? "(cuenta)" : "(no cuenta)"}</span>
                <div className="text-xs text-gray-500">{TEXTO_EPISODIO[k].explicacion}</div>
              </li>
            ))}
          </ol>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-y border-slate-200">
                <th className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Constante</th>
                <th className="p-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wide">Valor</th>
                <th className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">Procedencia</th>
                <th className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">Lado seguro</th>
              </tr>
            </thead>
            <tbody>
              {constantes.map((c) => (
                <tr key={c.clave} className="border-t border-slate-100 align-top">
                  <td className="p-3">
                    <div className="font-mono text-xs text-gray-800 break-all">{c.clave}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{c.nota}</div>
                  </td>
                  <td className="p-3 text-right whitespace-nowrap font-semibold text-gray-800">{c.valor} {c.unidad}</td>
                  <td className="p-3 text-xs text-gray-700 whitespace-nowrap">{PROCEDENCIA[c.procedencia] ?? c.procedencia}</td>
                  <td className="p-3 text-xs text-gray-700 whitespace-nowrap">
                    {c.ladoSeguro === "subir" ? "Subirla" : c.ladoSeguro === "bajar" ? "Bajarla" : "No tiene (ver nota)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500">
          «Lado seguro» es hacia dónde moverla para no acusar de más. Un exceso fuera de servicio (la app abierta sin servicio)
          no prueba que el teléfono iba en el bus: se cuenta aparte y no suma al ranking.
        </p>
      </div>
    </details>
  );
}

