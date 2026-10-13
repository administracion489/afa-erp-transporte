"use client";
// components/cotizaciones/BarraHorasParaderos.tsx
// La barra «⏱ Calcular horas» de una lista de paraderos (ida o retorno, cada una la suya).
//
// ESTA PANTALLA NO COMPONE NINGUNA REGLA DE HORAS. Qué modo se propone, qué fecha se consulta,
// qué falta para calcular, cómo se encadenan los tramos, qué hora se pisa y cuánto cuesta
// salen de lib/paradas-horario.ts — la misma cadena que usa /api/cotizaciones/horas-paraderos
// para pedir el tráfico de cada tramo a la hora en que el bus sale de él. Si la pantalla
// encadenara a su manera, publicaría horas calculadas con un tráfico consultado a otra hora.
//
// Dos modos, y la diferencia es plata:
//  · Sin tráfico — usa la ruta que ya trajo el mapa (una consulta Essentials, cacheada en el
//    servidor): si el mapa ya la cargó, calcular no cuesta ninguna consulta nueva.
//  · Con tráfico previsto — una consulta Advanced POR TRAMO (cuesta el doble y su cuota gratis
//    es la mitad). Se NOMBRA el costo en el confirm() antes de gastarlo.

import { useEffect, useRef, useState } from "react";
import {
  modoRecomendado, fechaReferencia, planHoras, requisitosHoras, costoEstimado, firmaParaderos, pasoCadena,
  ESPERA_DEFECTO_MIN, MAX_PARADEROS_TRAFICO,
  type ModoHoras, type ParadaHorario, type FilaPlan,
  horaFijaDe,
} from "@/lib/paradas-horario";
import { hhmmAMinutos, minutosAHhmm } from "@/lib/alertas-horario";
import { cabecerasErp } from "@/lib/fetch-erp";
import type { RutaParaderos } from "./useRutaParaderos";

export type ContextoHoras = {
  modoServicio: string;
  fechaServicio?: string | null;
  sentido: "ida" | "retorno";
  /** Salida del primer paradero de la IDA (para fechar el retorno). */
  horaSalidaIda?: string | null;
  /** La hora de salida del formulario («Hora de ida» / «Hora de retorno»), si la hay. */
  horaSalidaForm?: string | null;
};

/** Lo que contesta /api/cotizaciones/horas-paraderos (éxito o error). */
type RespHoras = {
  error?: string; reintentar_en_s?: number;
  tramos?: { duracion_trafico_s?: number }[];
  llegada_pesimista_s?: number | null; pesimista_omitida?: string | null;
  consultas_google?: number; en_cache?: number;
};

type Resumen = { firma: string; llegada: string; dia: 0 | 1; punta?: string; puntaDia?: number; puntaNo?: string; consultas?: number; enCache?: number; modo: ModoHoras; dia_ref?: string };

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
/** «lun 19/10» de una fecha ISO (solo presentación). */
export function etiquetaDiaCorta(f?: string | null): string {
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return "";
  const [, m, d] = f.split("-");
  return `${DIAS[new Date(`${f}T12:00:00Z`).getUTCDay()]} ${d}/${m}`;
}

const TEXTO_REQ: Record<string, string> = {
  pocos_puntos: "Hacen falta al menos dos paraderos.",
  sin_hora_salida: "Escribe la hora del paradero 1: es la salida desde la que se encadena todo.",
  tramos_no_cuadran: "La ruta trazada no coincide con los paraderos de ahora (¿cambiaron mientras cargaba?). Espera a que el mapa se actualice y vuelve a calcular.",
};

export default function BarraHorasParaderos({ paradas, contexto, ruta, onAplicar, onPonerSalida }: {
  /** Los paraderos EN ORDEN (inicio, intermedios, destino). */
  paradas: ParadaHorario[];
  contexto: ContextoHoras;
  ruta: { asegurar: () => Promise<RutaParaderos>; cargando: boolean };
  /** Escribe las filas calculadas; `avisos` por id de paradero. */
  onAplicar: (filas: FilaPlan[], firma: string, avisos: Record<string, string>) => void;
  /** Pone la hora de salida del formulario en el paradero 1. */
  onPonerSalida?: (hora: string) => void;
}) {
  const rec = modoRecomendado(contexto.modoServicio);
  const [modoElegido, setModoElegido] = useState<ModoHoras | null>(null);
  const modo = modoElegido ?? rec.modo;
  const [espera, setEspera] = useState(String(ESPERA_DEFECTO_MIN));
  const [pesimista, setPesimista] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState("");
  const [resumen, setResumen] = useState<Resumen | null>(null);

  // Lo que la barra lee DESPUÉS de un await (la consulta puede tardar): la lista de ahora.
  const vivo = useRef({ paradas, onAplicar });
  useEffect(() => { vivo.current = { paradas, onAplicar }; }, [paradas, onAplicar]);

  const req = requisitosHoras(paradas);
  const firma = firmaParaderos(paradas);
  const esperaNum = Number(String(espera).replace(",", "."));
  const esperaOk = String(espera).trim() !== "" && Number.isFinite(esperaNum) && esperaNum >= 0 && esperaNum <= 60;
  const demasiados = modo === "trafico" && paradas.length > MAX_PARADEROS_TRAFICO;

  // Un botón deshabilitado DICE qué le falta.
  let falta = "";
  if (req.codigo === "sin_coordenadas") falta = `Faltan coordenadas en: ${req.faltanCoords.join(", ")}. Elígelos desde el buscador, con 📐 coordenadas, o arrastrándolos en el mapa.`;
  else if (req.codigo !== "ok") falta = TEXTO_REQ[req.codigo] || "";
  else if (!esperaOk) falta = "Los minutos de embarque tienen que ser un número entre 0 y 60.";
  else if (demasiados) falta = `Con tráfico se calculan hasta ${MAX_PARADEROS_TRAFICO} paraderos (hay ${paradas.length}). Usa «Sin tráfico» o parte la ruta.`;
  const puede = !falta && !trabajando;

  const costo = costoEstimado(paradas.length, modo, pesimista);

  const calcular = async (cual: "vacias" | "todas") => {
    if (!puede) return;
    setError("");
    const snapshot = paradas;
    const firmaIni = firma;
    const fijas = snapshot.map(p => horaFijaDe(p, cual));

    // ¿Cambió la lista mientras se esperaba la respuesta? Entonces no se escribe nada.
    const cambio = () => {
      const ahora = vivo.current.paradas;
      return firmaParaderos(ahora) !== firmaIni
        || ahora.length !== snapshot.length
        || ahora.some((p, i) => p.id !== snapshot[i].id || (p.hora || "") !== (snapshot[i].hora || ""));
    };
    const aplicar = (plan: ReturnType<typeof planHoras>, extra: Omit<Resumen, "firma" | "llegada" | "dia" | "modo">) => {
      if (plan.codigo !== "ok") {
        setError(plan.codigo === "sin_coordenadas" ? `Faltan coordenadas en: ${plan.faltanCoords.join(", ")}.` : (TEXTO_REQ[plan.codigo] || "No se pudo calcular."));
        return;
      }
      if (cual === "todas" && plan.pisaria > 0
        && !window.confirm(`Se reemplazarán ${plan.pisaria} hora(s) que ya estaban escritas con las calculadas. ¿Continuar?`)) return;
      if (cambio()) { setError("Los paraderos cambiaron mientras se calculaba: no se escribió nada. Vuelve a calcular."); return; }
      const avisos: Record<string, string> = {};
      plan.filas.forEach(f => { if (f.aviso) avisos[f.id] = f.aviso; });
      vivo.current.onAplicar(plan.filas, firmaIni, avisos);
      const ult = plan.filas[plan.filas.length - 1];
      setResumen({ firma: firmaIni, llegada: plan.llegada || "", dia: ult?.dia ?? 0, modo, ...extra });
    };

    // En «todas» con sin tráfico se puede saber ANTES cuántas horas se pisan (no cuesta nada):
    // el confirm() de aplicar() lo nombra. Con tráfico, se sabe al volver la consulta.
    setTrabajando(true);
    try {
      if (modo === "sin_trafico") {
        let r: RutaParaderos;
        try { r = await ruta.asegurar(); }
        catch (e) { setError(`No se pudo trazar la ruta: ${(e as Error)?.message || "error desconocido"}`); return; }
        if (r.firma !== firmaIni || r.tramosS.some(s => s == null)) { setError(TEXTO_REQ.tramos_no_cuadran); return; }
        const plan = planHoras({
          paradas: snapshot, tramosS: r.tramosS as number[], esperaMin: esperaNum, modo: cual,
          calc: { modo: "sin_trafico", firma: firmaIni, espera_min: esperaNum },
        });
        aplicar(plan, {});
        return;
      }

      // ── Con tráfico previsto ─────────────────────────────────────────────
      const fr = fechaReferencia({
        modoServicio: contexto.modoServicio,
        fechaServicio: contexto.fechaServicio || null,
        horaSalida: snapshot[0].hora,
        sentido: contexto.sentido,
        horaSalidaIda: contexto.horaSalidaIda || null,
        ahoraMs: Date.now(),
      });
      if (!fr.ok) { setError(TEXTO_REQ.sin_hora_salida); return; }
      const salida = minutosAHhmm(hhmmAMinutos(snapshot[0].hora)!);
      const ok = window.confirm(
        `Hasta ${costo.consultas} consulta(s) con tráfico (~US$ ${costo.usd.toFixed(2)}; Directions con tráfico cuesta el doble y su cuota gratis es la mitad). `
        + `Lo ya calculado antes no se cobra.\n\nDía de referencia: ${fr.etiqueta}, salida ${salida}.`
        + (fr.supuesta ? "\n\nOjo: la fecha es SUPUESTA, no la del servicio." : "")
        + (cual === "todas" ? "\n\nModo «Recalcular todas»: se reemplazarán también las horas ya escritas (te diré cuántas antes de escribir)." : ""),
      );
      if (!ok) return;

      let res: Response;
      try {
        res = await fetch("/api/cotizaciones/horas-paraderos", {
          method: "POST",
          headers: await cabecerasErp(),
          body: JSON.stringify({
            paradas: snapshot.map(p => ({ nombre: p.nombre, lat: Number(p.lat), lng: Number(p.lng) })),
            fecha: fr.fecha, hora: salida, esperaMin: esperaNum, fijas, pesimista,
          }),
        });
      } catch {
        setError("No hubo respuesta del servidor (¿sin conexión?). No se escribió ninguna hora.");
        return;
      }
      const d: RespHoras = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) setError("Tu sesión venció: vuelve a entrar al ERP para calcular con tráfico.");
        else if (res.status === 403) setError("Te falta el permiso del módulo Cotizaciones para calcular con tráfico.");
        else if (res.status === 429) {
          const min = d?.reintentar_en_s ? Math.ceil(Number(d.reintentar_en_s) / 60) : null;
          setError(d?.error || `Llegaste al tope de cálculos con tráfico.${min ? ` Vuelve a intentarlo en ${min} min.` : ""}`);
        } else setError(d?.error || `Google no pudo calcular el tráfico (HTTP ${res.status}). No se escribió ninguna hora.`);
        return;
      }
      const tramos = Array.isArray(d?.tramos) ? d.tramos : [];
      const tramosS = tramos.map(t => Number(t?.duracion_trafico_s));
      if (tramosS.length !== snapshot.length - 1 || tramosS.some(s => !Number.isFinite(s))) {
        setError("La respuesta del tráfico no trae un tramo por paradero. No se escribió ninguna hora.");
        return;
      }
      let punta: string | undefined, puntaDia: number | undefined;
      if (d?.llegada_pesimista_s != null && Number.isFinite(Number(d.llegada_pesimista_s))) {
        // La pesimista recorre la ruta SIN detenerse (Google la pide con `via:`): se suma a la
        // salida tal cual y se rotula así. No mueve ninguna hora publicada.
        const lleg = pasoCadena({ min: hhmmAMinutos(salida)!, dia: 0 }, Number(d.llegada_pesimista_s), 0, false, null).llegada;
        punta = minutosAHhmm(lleg.min); puntaDia = lleg.dia;
      }
      // Se pidió y no vino: se dice por qué (las horas sí sirven).
      const puntaNo = pesimista && !punta
        ? ({ sin_tiempo: "Google tardó y no alcanzó el tiempo para consultarla.", cupo_agotado: "Se agotó tu cupo de consultas de tráfico de estos 10 minutos.", sin_clave: "Falta la clave de Google en el servidor." } as Record<string, string>)[String(d?.pesimista_omitida)] || "Google no la devolvió."
        : undefined;
      const plan = planHoras({
        paradas: snapshot, tramosS, esperaMin: esperaNum, modo: cual,
        calc: { modo: "trafico", fecha_ref: fr.fecha, firma: firmaIni, espera_min: esperaNum },
      });
      aplicar(plan, { punta, puntaDia, puntaNo, consultas: Number(d?.consultas_google) || 0, enCache: Number(d?.en_cache) || 0, dia_ref: fr.fecha });
    } finally {
      setTrabajando(false);
    }
  };

  const salidaForm = contexto.horaSalidaForm && hhmmAMinutos(contexto.horaSalidaForm) != null ? contexto.horaSalidaForm : "";

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-black text-sky-900">⏱ Horas de los paraderos</span>
        <div className="flex rounded-lg border border-sky-200 overflow-hidden text-[11px] font-bold">
          {([["sin_trafico", "Sin tráfico (barato)"], ["trafico", "Con tráfico previsto (cuesta más)"]] as [ModoHoras, string][]).map(([id, lbl]) => (
            <button key={id} type="button" onClick={() => setModoElegido(id)}
              className={`px-2.5 py-1 transition-colors ${modo === id ? "bg-sky-700 text-white" : "bg-white text-sky-800 hover:bg-sky-100"}`}>
              {lbl}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-gray-600">
          Min. de embarque por paradero
          <input type="text" inputMode="decimal" value={espera} onChange={e => setEspera(e.target.value)}
            className="w-12 border border-gray-200 rounded-md px-1.5 py-0.5 text-[11px] text-center bg-white focus:outline-none focus:border-sky-600" />
        </label>
        <span className="text-[10px] text-gray-400" title="Cuánto se detiene el bus en cada paradero intermedio. Valor de arranque, no medido: el lado seguro es bajarlo, porque una espera de más corre todas las horas siguientes hacia después y el pasajero llega cuando el bus ya pasó.">(no medido ⓘ)</span>
      </div>
      <p className="text-[10px] text-sky-800/80 leading-snug">
        {modo === rec.modo ? <>Propuesto: {rec.razon}</> : <>Elegiste el otro modo. Lo propuesto era «{rec.modo === "trafico" ? "Con tráfico" : "Sin tráfico"}»: {rec.razon}</>}
        {modo === "trafico" && <> Costo: hasta {costo.consultas} consulta(s), ~US$ {costo.usd.toFixed(2)} (tarifa de lista; lo ya consultado esta semana no se cobra).</>}
        {modo === "sin_trafico" && <> Usa la ruta del mapa: si ya cargó, no hace ninguna consulta nueva.</>}
      </p>
      {modo === "trafico" && (
        <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer w-fit">
          <input type="checkbox" checked={pesimista} onChange={e => setPesimista(e.target.checked)} className="accent-sky-700" />
          Ver llegada en hora punta (+1 consulta; solo se enseña, no mueve ninguna hora)
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!puede} onClick={() => calcular("vacias")}
          className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-sky-700 hover:bg-sky-600 disabled:opacity-40">
          {trabajando ? "⏳ Calculando…" : "⏱ Calcular horas"}
        </button>
        <button type="button" disabled={!puede} onClick={() => calcular("todas")}
          className="px-3 py-1.5 rounded-lg text-xs font-bold border border-sky-300 text-sky-800 bg-white hover:bg-sky-50 disabled:opacity-40">
          Recalcular todas
        </button>
        <span className="text-[10px] text-gray-500">«Calcular horas» solo llena las vacías y respeta las escritas; «Recalcular todas» las reemplaza (menos la del paradero 1).</span>
      </div>
      {falta && (
        <div className="text-[11px] text-gray-600 flex flex-wrap items-center gap-2">
          <span>⚠ {falta}</span>
          {req.codigo === "sin_hora_salida" && salidaForm && onPonerSalida && (
            <button type="button" onClick={() => onPonerSalida(salidaForm)} className="text-[10px] font-bold text-sky-800 underline">
              Poner {salidaForm} (la salida del formulario) en el paradero 1
            </button>
          )}
        </div>
      )}
      {!falta && modo === "sin_trafico" && ruta.cargando && <p className="text-[10px] text-gray-400">Trazando la ruta…</p>}
      {error && <p className="text-[11px] font-semibold text-red-600">⚠ {error}</p>}
      {resumen && resumen.firma === firma && !error && (
        <div className="text-[11px] text-sky-900 bg-white border border-sky-100 rounded-lg px-2.5 py-1.5 space-y-0.5">
          <p>Llegada al último paradero: <b>{resumen.llegada}{resumen.dia === 1 ? " (+1)" : ""}</b>
            {" "}<span className="text-gray-400">· {resumen.modo === "trafico" ? `tráfico previsto del ${etiquetaDiaCorta(resumen.dia_ref)}` : "sin tráfico"}</span></p>
          {resumen.punta && <p>En hora punta (sin contar las esperas): <b>{resumen.punta}{resumen.puntaDia ? " (+1)" : ""}</b> <span className="text-gray-400">· solo referencia, no mueve las horas</span></p>}
          {resumen.puntaNo && <p className="text-gray-500">Llegada en hora punta: no se calculó. {resumen.puntaNo}</p>}
          {resumen.consultas != null && <p className="text-gray-500">{resumen.consultas} consulta(s) a Google · {resumen.enCache ?? 0} en caché</p>}
        </div>
      )}
    </div>
  );
}
