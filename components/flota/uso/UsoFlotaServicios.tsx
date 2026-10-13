"use client";

// components/flota/uso/UsoFlotaServicios.tsx — La pestaña «Servicios» de /uso-flota: la
// estadística de cada servicio (km por GPS, marcha, excesos, combustible, costo y CO₂ ESTIMADOS)
// y su corte por cliente.
//
// UN DÍA POR LLAMADA (GET /api/flota/servicios): medir un día lee la traza entera de cada servicio,
// así que una semana son siete llamadas SEGUIDAS, una tras otra, con su progreso y un botón para
// cancelar. Lo ya medido se conserva: «Medir los que faltan» no repite un día que salió bien.
//
// LA PANTALLA NO DECIDE NADA DE LO QUE MUESTRA:
//   · el km se publica (o no) según el veredicto RASTREO (`km.codigo`, lib/flota/km-gps.ts);
//   · combustible, costo y CO₂ traen su `codigo` y su `base` (cómo se llegó, o por qué no hay
//     número): la celda enruta por código y la base va en el `title`, con el sello «estimado»;
//   · un mínimo («≥») viene marcado del motor (`piso`); el corte por cliente lo arma
//     `resumirPorCliente` / `totalDelDia` (los MISMOS acumuladores que la API), nunca una suma aquí;
//   · RUTA y ORIGEN → DESTINO son dos datos (`identidadRuta`): nunca uno en lugar del otro.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { urlRecorrido } from "@/lib/flota/recorrido-url";
import { sumarDias } from "@/lib/odometro-analitica";
import { hhmmLima } from "@/lib/servicio-tiempos";
import { etiquetaEstado } from "@/lib/estados";
import { ETIQUETA_RUTA, ETIQUETA_RECORRIDO, SIN_NOMBRE_RUTA, SIN_RECORRIDO } from "@/lib/ruta-identidad";
import { textoKm, textoKmGps, CODIGOS_KM_GPS, KM_GPS_PUBLICA } from "@/lib/flota/km-gps";
import { TEXTO_EPISODIO, textoDuracion, UMBRALES_ACEPTADOS, DIAS_ATRAS_MAX_EXCESOS, type CodigoDescarte } from "@/lib/flota/excesos";
import {
  UMBRAL_SERVICIO, SIN_CLIENTE, resumirPorCliente, totalDelDia, textoCombustible, textoExcesos, textoCantidades,
  type RespuestaServicios, type EstadisticaServicio, type FilaCliente, type CodigoCo2Servicio, type CodigoCosto,
} from "@/lib/flota/servicio-estadistica";
import {
  pedirConReintento, fmtNum, fmtSoles, fmtKg, fmtMin, fmtFecha, nombreFamilia,
  Ambar, ErrorConReintento, Nota, ComoSeMide, Estimado, type Resultado,
} from "./comun";

export type ModoServicios = "dia" | "semana";

/** Los umbrales que se ofrecen: los que acepta /api/flota/servicios (60 a 130 de 5 en 5; otro valor
 *  da 400). La lista es la del motor, no una copia: `UMBRALES_ACEPTADOS` de lib/flota/excesos.ts. */
const UMBRALES = UMBRALES_ACEPTADOS;

/** Un día de la API ya pedido: bien, con su `error` dentro (200), o fallido. */
type DiaPedido = Resultado<RespuestaServicios>;
const diaBueno = (x: DiaPedido | undefined): boolean => !!x && x.ok && !x.data.error;

// ─── El componente ────────────────────────────────────────────────────────────

export default function UsoFlotaServicios({ hoy, fechaInicial, reservaResaltada, onFecha }: {
  hoy: string;
  fechaInicial: string;
  /** `?reserva=` de la URL: esa fila se resalta y se lleva a la vista */
  reservaResaltada: number | null;
  onFecha: (fecha: string) => void;
}) {
  const [modo, setModo] = useState<ModoServicios>("dia");
  const [fecha, setFecha] = useState(fechaInicial);
  const [umbral, setUmbral] = useState<number>(UMBRAL_SERVICIO.defecto);
  const [ronda, setRonda] = useState(0);

  const dias = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return [] as string[];
    if (modo === "dia") return [fecha];
    return Array.from({ length: 7 }, (_, i) => sumarDias(fecha, i - 6));
  }, [modo, fecha]);

  // Lo medido, por día y umbral. Se conserva entre rondas: un día bueno no se vuelve a pedir.
  const [cache, setCache] = useState<Record<string, DiaPedido>>({});
  const cacheRef = useRef<Record<string, DiaPedido>>({});
  const k = useCallback((f: string) => `${f}|${umbral}`, [umbral]);

  const claveRun = `${dias.join(",")}|${umbral}|${ronda}`;
  const [fin, setFin] = useState<{ clave: string; cancelado?: boolean; error?: string } | null>(null);
  const [progreso, setProgreso] = useState<{ clave: string; hechos: number; total: number } | null>(null);
  const acRef = useRef<AbortController | null>(null);
  const pendientesAhora = dias.filter((f) => !diaBueno(cache[k(f)])).length;
  // Con todo lo pedido ya medido no hay nada corriendo, aunque la ronda todavía no haya cerrado.
  const corriendo = dias.length > 0 && pendientesAhora > 0 && fin?.clave !== claveRun;

  useEffect(() => {
    if (!dias.length) return;
    const ac = new AbortController();
    acRef.current = ac;
    const pendientes = dias.filter((f) => !diaBueno(cacheRef.current[`${f}|${umbral}`]));
    void (async () => {
      let hechos = 0;
      for (const f of pendientes) {
        const r = await pedirConReintento<RespuestaServicios>(`/api/flota/servicios?fecha=${f}&umbral=${umbral}`, ac.signal);
        if (ac.signal.aborted) return;
        cacheRef.current = { ...cacheRef.current, [`${f}|${umbral}`]: r };
        setCache(cacheRef.current);
        setProgreso({ clave: claveRun, hechos: ++hechos, total: pendientes.length });
        // Sin permiso no tiene sentido seguir: los demás días dirían lo mismo.
        if (!r.ok && r.permiso) { setFin({ clave: claveRun, error: r.error }); return; }
      }
      setFin({ clave: claveRun });
    })();
    return () => ac.abort();
  }, [claveRun, dias, umbral]);

  useEffect(() => { if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) onFecha(fecha); }, [fecha, onFecha]);

  const cancelar = () => { acRef.current?.abort(); setFin({ clave: claveRun, cancelado: true }); };
  const medirFaltantes = () => setRonda((x) => x + 1);
  const actualizar = () => {
    // Vuelve a medir TODO lo que está en pantalla (lo de hoy cambia minuto a minuto).
    const nuevo = { ...cacheRef.current };
    for (const f of dias) delete nuevo[`${f}|${umbral}`];
    cacheRef.current = nuevo;
    setCache(nuevo);
    setRonda((x) => x + 1);
  };

  const hechos = progreso?.clave === claveRun ? progreso.hechos : 0;
  const total = progreso?.clave === claveRun ? progreso.total : pendientesAhora;
  const finActual = fin?.clave === claveRun ? fin : null;

  // ── Lo que se pinta ──
  const buenos = dias.flatMap((f) => {
    const x = cache[k(f)];
    return x && x.ok && !x.data.error ? [{ f, x }] : [];
  });
  const filas: EstadisticaServicio[] = buenos.flatMap((e) => e.x.data.servicios);
  const unSoloDia = dias.length === 1;
  // Un día: el corte que ya mandó la API. Varios: los MISMOS acumuladores del motor sobre la unión.
  const porCliente: FilaCliente[] = unSoloDia && buenos[0] ? buenos[0].x.data.porCliente : resumirPorCliente(filas);
  const totalCorte: FilaCliente = unSoloDia && buenos[0] ? buenos[0].x.data.total : totalDelDia(filas);
  const metodo = buenos[0]?.x.data.metodo ?? null;
  const fueraTecho = buenos.flatMap((e) => e.x.data.fueraDelTecho.map((id) => ({ f: e.f, id })));
  const resaltadaFuera = reservaResaltada != null && fueraTecho.some((x) => x.id === reservaResaltada);
  const resaltadaEncontrada = reservaResaltada != null && filas.some((s) => s.reservaId === reservaResaltada);

  // La fila de ?reserva se lleva a la vista UNA vez, cuando aparece.
  const yaDesplazado = useRef(false);
  const refFila = useCallback((el: HTMLTableRowElement | null) => {
    if (el && !yaDesplazado.current) {
      yaDesplazado.current = true;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  return (
    <div className="space-y-4">
      {/* ── Qué medir ── */}
      <section className="bg-white rounded-2xl border shadow-sm p-3.5 space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex gap-1.5" role="tablist" aria-label="Alcance">
            {([["dia", "Un día"], ["semana", "7 días"]] as [ModoServicios, string][]).map(([m, l]) => (
              <button key={m} type="button" role="tab" aria-selected={modo === m} onClick={() => setModo(m)}
                className={`px-3 py-2 rounded-xl text-xs font-bold min-h-[40px] ${modo === m ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                style={modo === m ? { background: "#0b315f" } : undefined}>
                {l}
              </button>
            ))}
          </div>
          <label className="text-[11px] font-bold uppercase text-gray-400">
            {modo === "dia" ? "Día" : "Hasta el día"}
            {/* El mínimo es el de la API (los últimos DIAS_RASTREO días, el mismo literal que
                DIAS_ATRAS_MAX_EXCESOS); si igual llega una fecha fuera, la API lo dice con su 400. */}
            <input type="date" value={fecha} min={sumarDias(hoy, -DIAS_ATRAS_MAX_EXCESOS)} max={hoy} onChange={(e) => setFecha(e.target.value)}
              className="block mt-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 font-normal normal-case min-h-[40px]" />
          </label>
          <label className="text-[11px] font-bold uppercase text-gray-400" title="Velocidad a partir de la cual un tramo sostenido y corroborado cuenta como exceso. Es el mismo umbral de Seguridad vial.">
            Excesos sobre
            <select value={umbral} onChange={(e) => setUmbral(Number(e.target.value))}
              className="block mt-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 font-normal normal-case min-h-[40px]">
              {UMBRALES.map((u) => <option key={u} value={u}>{u} km/h{u === UMBRAL_SERVICIO.defecto ? " (defecto)" : ""}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2 ml-auto">
            {corriendo ? (
              <button type="button" onClick={cancelar}
                className="px-4 py-2 rounded-xl text-sm font-bold border border-gray-300 bg-white text-gray-700 min-h-[40px]">
                Cancelar
              </button>
            ) : (
              <>
                {pendientesAhora > 0 && (
                  <button type="button" onClick={medirFaltantes}
                    className="px-4 py-2 rounded-xl text-sm font-bold text-white min-h-[40px]" style={{ background: "#0b315f" }}>
                    Medir {pendientesAhora === dias.length ? (unSoloDia ? "el día" : `los ${dias.length} días`)
                      : pendientesAhora === 1 ? "el día que falta" : `los ${pendientesAhora} días que faltan`}
                  </button>
                )}
                <button type="button" onClick={actualizar}
                  className="px-4 py-2 rounded-xl text-sm font-bold border border-gray-300 bg-white text-gray-700 min-h-[40px]">
                  Volver a medir
                </button>
              </>
            )}
          </div>
        </div>
        {modo === "semana" && dias.length > 0 && (
          <p className="text-[11px] text-gray-500">{fmtFecha(dias[0])} – {fmtFecha(dias[dias.length - 1])}: un día por llamada, uno tras otro.</p>
        )}
        {corriendo && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden" aria-hidden="true">
              <div className="h-full rounded-full transition-all" style={{ width: `${total ? (hechos / total) * 100 : 0}%`, background: "#0b315f" }} />
            </div>
            <span className="text-xs font-bold text-[#0b315f] whitespace-nowrap" aria-live="polite">
              Midiendo {Math.min(hechos + 1, Math.max(total, 1))}/{Math.max(total, 1)}…
            </span>
          </div>
        )}
      </section>

      {/* ── Estado ── */}
      {finActual?.error && <ErrorConReintento texto={finActual.error} />}
      {finActual?.cancelado && pendientesAhora > 0 && (
        <Nota>Se canceló la medición: {pendientesAhora} día(s) quedaron sin medir (no es que no tengan servicios).</Nota>
      )}
      {dias.map((f) => {
        const x = cache[k(f)];
        if (!x || diaBueno(x)) return null;
        if (!x.ok && x.permiso) return null;   // ya se dijo arriba, una vez
        const texto = x.ok ? x.data.error ?? "" : x.error;
        return (
          <ErrorConReintento key={f} texto={`${unSoloDia ? "" : `${fmtFecha(f)}: `}${texto}`}
            onReintentar={!corriendo && (x.ok || x.status !== 400) ? medirFaltantes : undefined} />
        );
      })}
      {buenos.map((e) => (e.x.data.avisos.length > 0 && (
        <Ambar key={e.f}>
          {!unSoloDia && <b>{fmtFecha(e.f)}: </b>}
          {e.x.data.avisos.join(" ")}
          {e.x.data.fueraDelTecho.length > 0 && (
            <span className="block mt-1 text-[11px]">
              Sin medir por el tope: {e.x.data.fueraDelTecho.map((id) => `#${id}`).join(", ")}.
            </span>
          )}
        </Ambar>
      )))}
      {resaltadaFuera && (
        <Ambar>El servicio #{reservaResaltada} es de los que no se midieron por el tope del día: no tiene km ni CO₂ (no es un cero).</Ambar>
      )}
      {reservaResaltada != null && !corriendo && !resaltadaEncontrada && !resaltadaFuera && buenos.length === dias.length && (
        <Nota>El servicio #{reservaResaltada} no está entre los servicios medidos de {unSoloDia ? "este día" : "estos días"} (¿es de otra fecha, o está cancelado?).</Nota>
      )}

      {/* ── La tabla ── */}
      <section className="bg-white rounded-2xl border shadow-sm">
        <div className="px-4 pt-4 pb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-bold text-gray-800 text-sm">
            Servicios{buenos.length ? ` (${filas.length})` : ""}
          </h3>
          <p className="text-[11px] text-gray-400">
            Combustible, costo y CO₂ son <b>estimados</b> sobre el km del GPS: cada celda dice de dónde sale al pasarle el puntero.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[1500px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 align-bottom" style={{ background: "#f8fafc" }}>
                <th className="px-3 py-2 sticky left-0 z-10" style={{ background: "#f8fafc" }}>Fecha · Servicio</th>
                <th className="px-3 py-2">Cliente</th>
                <th className="px-3 py-2">{ETIQUETA_RUTA} / {ETIQUETA_RECORRIDO}</th>
                <th className="px-3 py-2">Placa (flota)</th>
                <th className="px-3 py-2">Conductor</th>
                <th className="px-3 py-2" title="Inicio y fin con la evidencia del conductor; la franja del GPS va aparte, marcada «~GPS».">Inicio y fin</th>
                <th className="px-3 py-2">Rastreo</th>
                <th className="px-3 py-2 text-right">Km GPS</th>
                <th className="px-3 py-2">Marcha / Detenido</th>
                <th className="px-3 py-2 text-right">Vel. máx (p95)</th>
                <th className="px-3 py-2">Excesos (&gt; {umbral})</th>
                <th className="px-3 py-2">Combustible</th>
                <th className="px-3 py-2 text-right">Costo</th>
                <th className="px-3 py-2 text-right">CO₂</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filas.map((s) => (
                <FilaServicio key={s.reservaId} s={s} umbral={umbral}
                  resaltada={s.reservaId === reservaResaltada}
                  refFila={s.reservaId === reservaResaltada ? refFila : undefined} />
              ))}
              {!filas.length && (
                <tr>
                  <td colSpan={15} className="px-3 py-8 text-center text-gray-400">
                    {corriendo ? "Midiendo… (lee el GPS de cada servicio: puede tardar)"
                      : buenos.length === 0 ? "Todavía no hay ningún día medido."
                        : `Sin servicios para medir ${unSoloDia ? "ese día" : "en esos días"}.`}
                  </td>
                </tr>
              )}
              {filas.length > 0 && corriendo && (
                <tr><td colSpan={15} className="px-3 py-3 text-center text-[11px] text-gray-400">Midiendo los días que faltan…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Por cliente ── */}
      {buenos.length > 0 && (
        <CortePorCliente filas={porCliente} total={totalCorte} diasMedidos={buenos.length} diasPedidos={dias.length} />
      )}

      {/* ── Cómo se mide ── */}
      {metodo && (
        <ComoSeMide>
          <div>
            <p className="font-bold text-gray-700 mb-1">El km del GPS se publica solo según el veredicto del RASTREO</p>
            <ul className="space-y-0.5">
              {CODIGOS_KM_GPS.map((c) => (
                <li key={c}><b>{textoKmGps(c)}</b>: {KM_GPS_PUBLICA[c] ? (c === "piso" ? "se publica como mínimo (≥)" : "se publica") : "no se publica"}</li>
              ))}
            </ul>
          </div>
          <p>
            <b>Combustible, costo y CO₂ son estimados</b>: km del GPS × consumo por km de la categoría de costeo de la unidad
            (el rendimiento medido de la placa si es confiable; si no, el del parámetro), recorrido {metodo.recorrido}, como el
            presupuesto del servicio. Si el km es un mínimo, todo lo que sale de él también. A una unidad tercerizada se le paga
            la factura del proveedor: no tiene costo de combustible, pero sí CO₂ si su categoría tiene parámetro.
          </p>
          <div>
            <p className="font-bold text-gray-700 mb-1">Factores de CO₂ (solo CO₂, no CO₂e)</p>
            <ul className="space-y-0.5">
              {metodo.factoresCo2.map((f) => (
                <li key={f.familia}>{nombreFamilia(f.familia)}: {fmtNum(f.kgPorUnidad, f.kgPorUnidad < 5 ? 4 : 2)} kg por {f.unidad === "m3" ? "m³" : "galón"}</li>
              ))}
            </ul>
            <p className="text-gray-400 mt-1">{metodo.fuenteCo2}</p>
          </div>
          <p>
            <b>Excesos</b>: tramos sostenidos y corroborados por encima del umbral (entre {metodo.umbral.min} y {metodo.umbral.max} km/h; por
            defecto {metodo.umbral.defecto}), con el mismo motor que Seguridad vial. Un teléfono que no reporta la velocidad del sensor sale
            «Sin velocímetro», nunca «0 excesos».
          </p>
          <p>
            El CO₂ de esta pestaña es el del recorrido EN SERVICIO; el del Resumen es el de lo COMPRADO (incluye el km en vacío y el
            combustible que se quema otro día): no tienen por qué cuadrar.
          </p>
        </ComoSeMide>
      )}
    </div>
  );
}

// ─── Una fila ─────────────────────────────────────────────────────────────────

const gris = "text-gray-400";

function FilaServicio({ s, umbral, resaltada, refFila }: {
  s: EstadisticaServicio; umbral: number; resaltada: boolean;
  refFila?: (el: HTMLTableRowElement | null) => void;
}) {
  const fondo = resaltada ? "#fef9c3" : "#ffffff";
  const sinHuella = `No se publica: ${textoKmGps(s.km.codigo)}. ${s.km.detalle}`;
  const descartados = Object.entries(s.excesos.descartados) as [CodigoDescarte, number][];
  const nDesc = descartados.reduce((a, [, n]) => a + n, 0);
  const rastreoVisible = s.rastreo.codigo !== "no_aplica" && s.rastreo.codigo !== "recien_iniciado" && s.rastreo.codigo !== "sin_medir";
  return (
    <tr ref={refFila} className="border-t border-gray-100 align-top" style={resaltada ? { background: fondo } : undefined}>
      {/* Fecha · Servicio */}
      <td className="px-3 py-2 sticky left-0 z-10 whitespace-nowrap" style={{ background: fondo, boxShadow: "inset -1px 0 0 #f1f5f9" }}>
        <span className="font-black text-[#0b315f]">{s.codigo ?? `#${s.reservaId}`}</span>
        <span className="block text-[10px] text-gray-500">{fmtFecha(s.fecha)}{s.hora ? ` · ${s.hora}` : ""}</span>
        <span className="block text-[10px] text-gray-400">{etiquetaEstado(s.estado)}</span>
      </td>
      {/* Cliente */}
      <td className="px-3 py-2 max-w-[160px]">
        <span className="block truncate font-bold text-gray-700" title={s.cliente.nombre ?? undefined}>
          {s.cliente.nombre ?? (s.cliente.id != null ? `Cliente #${s.cliente.id}` : SIN_CLIENTE)}
        </span>
      </td>
      {/* RUTA / ORIGEN → DESTINO: dos datos, nunca uno en lugar del otro */}
      <td className="px-3 py-2 max-w-[260px]">
        <span className="block truncate" title={s.ruta.nombre ?? undefined}>
          <span className="text-[9px] font-bold uppercase text-gray-400 mr-1">{ETIQUETA_RUTA}</span>
          {s.ruta.nombre ? <span className="text-gray-800">{s.ruta.nombre}</span> : <i className={gris}>{SIN_NOMBRE_RUTA}</i>}
        </span>
        <span className="block truncate text-[11px]" title={s.ruta.recorrido ?? undefined}>
          <span className="text-[9px] font-bold uppercase text-gray-400 mr-1">{ETIQUETA_RECORRIDO}</span>
          {s.ruta.recorrido ? <span className="text-gray-600">{s.ruta.recorrido}</span> : <i className={gris}>{SIN_RECORRIDO}</i>}
        </span>
      </td>
      {/* Placa (flota) */}
      <td className="px-3 py-2 whitespace-nowrap">
        {s.vehiculo ? (
          <>
            <span className="font-mono font-black text-gray-800">{s.placa ?? <i className={`${gris} font-sans font-normal`}>sin placa</i>}</span>
            <span className={`ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded ${s.flota === "tercero" ? "bg-purple-50 text-purple-700" : "bg-[#eef3f8] text-[#0b315f]"}`}>
              {s.flota === "tercero" ? "Tercero" : "Propia"}
            </span>
          </>
        ) : <span className={gris}>Sin unidad</span>}
      </td>
      {/* Conductor */}
      <td className="px-3 py-2 max-w-[170px]">
        <span className="block truncate text-gray-700" title={s.conductor.nombre ?? undefined}>
          {s.conductor.nombre ?? (s.conductor.clave ? <i className={gris}>sin nombre</i> : <span className={gris}>Sin asignar</span>)}
        </span>
        {s.conductorGps && (
          <span className="block text-[10px] font-bold text-amber-700 truncate"
            title="La mayoría de las posiciones GPS de este servicio las envió el teléfono de otro conductor: quizás se reasignó sin cambiarlo en la reserva.">
            GPS de otro conductor: {s.conductorGps.nombre ?? "sin nombre"}
          </span>
        )}
      </td>
      {/* Inicio y fin (evidencia del conductor) + franja del GPS aparte */}
      <td className="px-3 py-2 whitespace-nowrap">
        {s.inicio || s.fin ? (
          <span className="text-gray-800">
            <Instante i={s.inicio} /> – <Instante i={s.fin} />
          </span>
        ) : <span className="text-gray-300" title="Sin hora de inicio ni de fin registrada (no se inventa)">—</span>}
        {s.duracionMin != null && <span className="block text-[10px] text-gray-500">{fmtMin(s.duracionMin)}</span>}
        {s.gpsDesdeTs != null && s.gpsHastaTs != null && (
          <span className="block text-[10px] text-gray-400" title="Primera y última posición en movimiento del GPS: no es la evidencia del conductor.">
            ~GPS {hhmmLima(s.gpsDesdeTs)}–{hhmmLima(s.gpsHastaTs)}
          </span>
        )}
      </td>
      {/* Rastreo: la misma celda y el mismo color que /seguimiento */}
      <td className="px-3 py-2 whitespace-nowrap" title={s.rastreo.detalle}>
        {rastreoVisible ? (
          <span className="inline-block text-[10px] font-black px-1.5 py-0.5 rounded-md" style={{ color: s.rastreo.color, background: s.rastreo.bg }}>
            {s.rastreo.celda}
          </span>
        ) : <span className="text-xs font-black text-gray-300">{s.rastreo.celda}</span>}
      </td>
      {/* Km GPS */}
      <td className="px-3 py-2 text-right whitespace-nowrap" title={s.km.detalle}>
        {s.km.km != null
          ? <span className="font-bold text-gray-800 tabular-nums">{textoKm(s.km)}</span>
          : <span className={`text-[11px] ${gris}`}>{textoKmGps(s.km.codigo)}</span>}
      </td>
      {/* Marcha / Detenido */}
      <td className="px-3 py-2 whitespace-nowrap" title={s.marchaMin == null ? sinHuella : s.km.piso ? "Mínimos: el GPS tuvo cortes." : undefined}>
        {s.marchaMin != null && s.detenidoMin != null ? (
          <>
            <span className="tabular-nums text-gray-700">{s.km.piso ? "≥ " : ""}{fmtMin(s.marchaMin)}</span>
            <span className="text-gray-300"> / </span>
            <span className="tabular-nums text-gray-500">{s.km.piso ? "≥ " : ""}{fmtMin(s.detenidoMin)}</span>
            {s.paradas != null && <span className="block text-[10px] text-gray-400">{s.paradas} parada(s)</span>}
          </>
        ) : <span className="text-gray-300">—</span>}
      </td>
      {/* Vel. máx (p95) */}
      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums" title={s.velMaxP95 == null ? sinHuella : "Percentil 95 de la velocidad del viaje: el mismo número del modal GPS."}>
        {s.velMaxP95 != null ? `${Math.round(s.velMaxP95)} km/h` : <span className="text-gray-300">—</span>}
      </td>
      {/* Excesos */}
      <td className="px-3 py-2 whitespace-nowrap"
        title={`${s.excesos.base}${nDesc ? `\nDescartados: ${descartados.map(([c, n]) => `${n} ${TEXTO_EPISODIO[c]?.titulo ?? c}`).join(", ")}.` : ""}`}>
        {s.excesos.codigo === "medido" && s.excesos.n != null ? (
          s.excesos.n > 0 ? (
            <Link prefetch={false}
              href={`/seguridad-vial?desde=${s.fecha}&hasta=${s.fecha}&reserva=${s.reservaId}&umbral=${umbral}`}
              className="font-black text-red-700 underline decoration-red-300 hover:decoration-red-700">
              {s.excesos.piso ? "≥ " : ""}{s.excesos.n} exceso(s)
            </Link>
          ) : (
            <span className="text-gray-600">{s.excesos.piso ? "≥ " : ""}0</span>
          )
        ) : <span className={`text-[11px] ${gris}`}>{textoExcesos(s.excesos.codigo)}</span>}
        {s.excesos.codigo === "medido" && s.excesos.n != null && s.excesos.n > 0 && s.excesos.segundos != null && (
          <span className="block text-[10px] text-gray-500">{textoDuracion(s.excesos.segundos)}{s.excesos.velMax != null ? ` · máx ${Math.round(s.excesos.velMax)} km/h` : ""}</span>
        )}
        {nDesc > 0 && <span className="block text-[10px] text-gray-400">{nDesc} descartado(s)</span>}
      </td>
      {/* Combustible estimado */}
      <td className="px-3 py-2 whitespace-nowrap" title={s.combustible.base}>
        {s.combustible.codigo === "estimado"
          ? <><span className="tabular-nums text-gray-700">{textoCantidades(s.combustible)}</span><Estimado /></>
          : <span className={`text-[11px] ${gris}`}>{textoCombustible(s.combustible.codigo)}</span>}
      </td>
      {/* Costo estimado */}
      <td className="px-3 py-2 text-right whitespace-nowrap" title={s.costo.base}>
        {s.costo.codigo === "estimado" && s.costo.soles != null
          ? <><span className="tabular-nums text-gray-700">{s.costo.piso ? "≥ " : ""}{fmtSoles(s.costo.soles)}</span><Estimado /></>
          : <span className={`text-[11px] ${s.costo.codigo === "tercero" ? "text-slate-500" : gris}`}>{textoCombustible(s.costo.codigo)}</span>}
      </td>
      {/* CO₂ estimado */}
      <td className="px-3 py-2 text-right whitespace-nowrap" title={s.co2.base}>
        {s.co2.codigo === "estimado" && s.co2.kg != null
          ? <><span className="tabular-nums text-gray-700">{s.co2.piso ? "≥ " : ""}{fmtKg(s.co2.kg)}</span><Estimado /></>
          : <span className={`text-[11px] ${gris}`}>{textoCombustible(s.co2.codigo)}</span>}
      </td>
      {/* Ver recorrido */}
      <td className="px-3 py-2 whitespace-nowrap">
        <Link href={urlRecorrido(s.reservaId, { umbral })} prefetch={false} target="_blank" rel="noopener"
          className="text-[11px] font-bold text-[#0b315f] hover:underline">
          Ver recorrido ↗
        </Link>
      </td>
    </tr>
  );
}

/** «06:32», «~06:35» (estimado, en cursiva) o «—»; el title dice de dónde sale. */
function Instante({ i }: { i: EstadisticaServicio["inicio"] }) {
  if (!i) return <span className="text-gray-300" title="Sin hora registrada (no se inventa)">—</span>;
  return (
    <span title={i.etiqueta} className={i.estimado ? "italic text-gray-500" : undefined}>
      {i.estimado ? "~" : ""}{i.hhmm}
    </span>
  );
}

// ─── Corte por cliente ────────────────────────────────────────────────────────

function textoSinTotal(m: Partial<Record<CodigoCo2Servicio | CodigoCosto, number>>): string[] {
  return (Object.entries(m) as [CodigoCo2Servicio | CodigoCosto, number][])
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${n} · ${textoCombustible(c)}`);
}

function CortePorCliente({ filas, total, diasMedidos, diasPedidos }: {
  filas: FilaCliente[]; total: FilaCliente; diasMedidos: number; diasPedidos: number;
}) {
  const sinKm = total.sinCo2.sin_km ?? 0;
  const otrosSinCo2 = textoSinTotal(Object.fromEntries(Object.entries(total.sinCo2).filter(([c]) => c !== "sin_km")));
  const terceros = total.sinCosto.tercero ?? 0;
  const fila = (f: FilaCliente, esTotal: boolean) => {
    const sinCo2 = textoSinTotal(f.sinCo2);
    return (
      <tr key={esTotal ? "total" : `${f.clienteId ?? "sin"}`} className={`border-t align-top ${esTotal ? "border-gray-300 font-bold bg-[#f8fafc]" : "border-gray-100"}`}>
        <td className="px-3 py-2 sticky left-0 z-10 max-w-[180px]" style={{ background: esTotal ? "#f8fafc" : "#ffffff" }}>
          <span className="block truncate text-gray-800" title={f.nombre}>{f.nombre}</span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {f.servicios}
          <span className="block text-[10px] font-normal text-gray-400">
            {f.propios} propio(s) · {f.terceros} tercero(s){f.sinUnidad ? ` · ${f.sinUnidad} sin unidad` : ""}
          </span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
          {f.kmServicios ? `${f.kmPiso ? "≥ " : ""}${fmtNum(f.km, 1)} km` : <span className="font-normal text-gray-400">sin km medible</span>}
          {f.kmServicios > 0 && <span className="block text-[10px] font-normal text-gray-400">de {f.kmServicios} servicio(s)</span>}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          {f.combustibleServicios ? <>{textoCantidades(f.combustible, f.combustiblePiso)}<Estimado /></> : <span className="font-normal text-gray-400">—</span>}
        </td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
          {f.costoServicios ? <>{f.costoPiso ? "≥ " : ""}{fmtSoles(f.costoSoles)}<Estimado /></> : <span className="font-normal text-gray-400">—</span>}
          {f.costoServicios > 0 && <span className="block text-[10px] font-normal text-gray-400">de {f.costoServicios} servicio(s)</span>}
        </td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
          {f.co2Servicios ? <>{f.co2Piso ? "≥ " : ""}{fmtKg(f.co2Kg)}<Estimado /></> : <span className="font-normal text-gray-400">—</span>}
          {f.co2Servicios > 0 && <span className="block text-[10px] font-normal text-gray-400">de {f.co2Servicios} servicio(s)</span>}
        </td>
        <td className="px-3 py-2 text-[10px] font-normal text-gray-500">
          {sinCo2.length ? sinCo2.join(" · ") : <span className="text-gray-300">—</span>}
        </td>
      </tr>
    );
  };
  return (
    <section className="bg-white rounded-2xl border shadow-sm">
      <div className="px-4 pt-4 pb-2">
        <h3 className="font-bold text-gray-800 text-sm">Por cliente</h3>
        <p className="text-[11px] text-gray-400 mt-0.5">
          {diasMedidos < diasPedidos ? `De ${diasMedidos} de ${diasPedidos} días medidos. ` : ""}
          El combustible va por combustible, cada uno en su unidad (los galones y los m³ no se suman); los soles y los kilos sí.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[920px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500" style={{ background: "#f8fafc" }}>
              <th className="px-3 py-2 sticky left-0 z-10" style={{ background: "#f8fafc" }}>Cliente</th>
              <th className="px-3 py-2 text-right">Servicios</th>
              <th className="px-3 py-2 text-right">Km GPS</th>
              <th className="px-3 py-2">Combustible</th>
              <th className="px-3 py-2 text-right">Costo (propias)</th>
              <th className="px-3 py-2 text-right">CO₂</th>
              <th className="px-3 py-2">Sin CO₂ en el total</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => fila(f, false))}
            {filas.length > 1 && fila(total, true)}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-3 space-y-1 text-[11px] text-slate-500">
        {sinKm > 0 && <p>{sinKm} servicio(s) sin km medible: su CO₂ no está en el total (no es un cero).</p>}
        {otrosSinCo2.length > 0 && <p>Tampoco entran al CO₂ del total: {otrosSinCo2.join(" · ")}.</p>}
        {terceros > 0 && <p>{terceros} servicio(s) tercerizados: su costo es la factura del proveedor, no entra al costo estimado (su CO₂ sí, si su categoría tiene parámetro).</p>}
        <p>Las celdas con «≥» son mínimos: alguno de sus servicios tuvo un GPS con cortes.</p>
      </div>
    </section>
  );
}
