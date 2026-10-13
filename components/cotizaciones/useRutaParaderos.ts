"use client";
// components/cotizaciones/useRutaParaderos.ts
// UNA consulta de ruta (sin tráfico, la barata y cacheada en el servidor) por lista de
// paraderos, compartida por el mapa y por «⏱ Calcular horas» sin tráfico. Si cada uno pidiera
// la suya, mover un paradero costaría dos llamadas a Google y podrían quedar dibujando una
// ruta y calculando las horas con otra.
//
// · Solo con ≥ 2 paraderos con coordenadas; se pide por los que las tienen, en orden.
// · Debounce de 800 ms por FIRMA (firmaParaderos): escribir el nombre de un paradero no cambia
//   la firma y no consulta nada; arrastrar un marcador sí.
// · Una respuesta que llega cuando la lista ya cambió se descarta (no pisa la vigente).
// · `asegurar()` devuelve la ruta de la firma actual sin esperar el debounce: la usa el botón
//   de horas cuando se pulsa antes de que la consulta automática termine. Comparte la misma
//   promesa en vuelo, así que no duplica la llamada.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { firmaParaderos, segundosDeTramoRuta } from "@/lib/paradas-horario";

export type PuntoRuta = { id: string; nombre: string; lat: string; lng: string };

export type RutaParaderos = {
  /** Firma de los paraderos con coordenadas con que se pidió la ruta. */
  firma: string;
  poli: [number, number][];
  /** Segundos de cada tramo (null si la respuesta no lo trae). */
  tramosS: (number | null)[];
};

const DEBOUNCE_MS = 800;

export function coordsOk(p: { lat: string; lng: string }): boolean {
  if (String(p.lat ?? "").trim() === "" || String(p.lng ?? "").trim() === "") return false;
  const lat = Number(p.lat), lng = Number(p.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
}

async function pedirRuta(pts: PuntoRuta[], firma: string): Promise<RutaParaderos> {
  const r = await fetch("/api/ruta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paradas: pts.map(p => ({ nombre: p.nombre || "Paradero", lat: Number(p.lat), lng: Number(p.lng) })), conTrafico: false }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `No se pudo trazar la ruta (HTTP ${r.status}).`);
  return {
    firma,
    poli: Array.isArray(d?.coordenadas) ? d.coordenadas : [],
    tramosS: Array.isArray(d?.tramos) ? d.tramos.map((t: { duracion_s?: number | null; duracion_min?: number | null }) => segundosDeTramoRuta(t)) : [],
  };
}

export function useRutaParaderos(paradas: PuntoRuta[]) {
  const conCoords = useMemo(() => paradas.filter(coordsOk), [paradas]);
  const firma = conCoords.length >= 2 ? firmaParaderos(conCoords) : "";
  const completo = conCoords.length === paradas.length;

  const [ruta, setRuta] = useState<RutaParaderos | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<{ firma: string; msg: string } | null>(null);

  const firmaRef = useRef(firma);
  const puntosRef = useRef(conCoords);
  // Se declaran ANTES que el efecto del debounce: los efectos corren en orden, así que cuando
  // el debounce dispara ya leen la lista vigente.
  useEffect(() => { firmaRef.current = firma; puntosRef.current = conCoords; }, [firma, conCoords]);
  const vuelo = useRef<{ firma: string; p: Promise<RutaParaderos> } | null>(null);

  const lanzar = useCallback((f: string): Promise<RutaParaderos> => {
    if (vuelo.current?.firma === f) return vuelo.current.p;
    const p = pedirRuta(puntosRef.current, f);
    vuelo.current = { firma: f, p };
    setCargando(true);
    setError(null);
    p.then(r => { if (firmaRef.current === f) setRuta(r); })
      .catch(e => { if (firmaRef.current === f) setError({ firma: f, msg: e?.message || "No se pudo trazar la ruta." }); })
      .finally(() => {
        // Solo la consulta más reciente apaga el «cargando»: una vieja que termina tarde no.
        if (vuelo.current?.p === p) { vuelo.current = null; setCargando(false); }
      });
    return p;
  }, []);

  useEffect(() => {
    if (!firma) return;
    if (ruta?.firma === firma) return;
    const t = setTimeout(() => { lanzar(firma).catch(() => {}); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // `ruta` no va en las dependencias: solo se consulta cuando cambia la firma.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firma, lanzar]);

  /** La ruta de la firma actual: la que ya está, o la consulta en el momento. */
  const asegurar = useCallback(async (): Promise<RutaParaderos> => {
    const f = firmaRef.current;
    if (!f) throw new Error("Hacen falta al menos dos paraderos con coordenadas.");
    if (ruta?.firma === f) return ruta;
    return lanzar(f);
  }, [ruta, lanzar]);

  // La ruta dibujada se conserva mientras se pide la nueva (el mapa no parpadea); `vigente`
  // dice si describe los paraderos de AHORA.
  const vigente = !!ruta && ruta.firma === firma;
  // Sin dos paraderos con coordenadas no hay consulta: ni «cargando» ni el error de una vieja.
  return { ruta: firma ? ruta : null, vigente, cargando: !!firma && cargando, error: firma && error?.firma === firma ? error.msg : "", firma, completo, conCoords, asegurar };
}
