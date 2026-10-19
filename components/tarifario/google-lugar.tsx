"use client";
// components/tarifario/google-lugar.tsx — SOLO NAVEGADOR. Google Places para «Zonas y traslados»:
// el campo de dirección del Simulador y el «Ir a un lugar» del mapa de subzonas y puntos.
//
// Reusa el MISMO <script id="gmaps-script"> que cargan /tarifario, /cotizaciones y /programacion
// (misma URL, con places): si otra pantalla ya lo puso, no se baja dos veces. El estado vive en el
// módulo y se lee con useSyncExternalStore, así ningún efecto hace setState al montar.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { iCls } from "./traslados-comun";

type EstadoGoogle = "nada" | "cargando" | "listo" | "error";
type GoogleNs = typeof google;

let estado: EstadoGoogle = "nada";
const oyentes = new Set<() => void>();
const avisar = () => oyentes.forEach((f) => f());

function goog(): GoogleNs | null {
  if (typeof window === "undefined") return null;
  const g = (window as unknown as { google?: GoogleNs }).google;
  return g?.maps?.places ? g : null;
}

function iniciar() {
  if (typeof window === "undefined" || estado === "cargando" || estado === "listo") return;
  if (goog()) { estado = "listo"; return; }
  const clave = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!clave) { estado = "error"; return; }
  estado = "cargando";
  const listo = () => { estado = goog() ? "listo" : "error"; avisar(); };
  const fallo = () => { estado = "error"; avisar(); };
  const ex = document.getElementById("gmaps-script") as HTMLScriptElement | null;
  if (ex) {
    ex.addEventListener("load", listo, { once: true });
    ex.addEventListener("error", fallo, { once: true });
    // Pudo terminar de cargar entre la comprobación y el listener.
    window.setTimeout(() => { if (goog() && estado !== "listo") listo(); }, 0);
    return;
  }
  const s = document.createElement("script");
  s.id = "gmaps-script";
  s.src = `https://maps.googleapis.com/maps/api/js?key=${clave}&libraries=places&language=es&region=PE`;
  s.async = true;
  s.defer = true;
  s.onload = listo;
  s.onerror = fallo;
  document.head.appendChild(s);
}

function suscribir(cb: () => void) {
  oyentes.add(cb);
  iniciar();
  return () => { oyentes.delete(cb); };
}

const leerEstado = (): EstadoGoogle => (goog() ? "listo" : estado);

/** «listo» cuando Google Places se puede usar; «error» sin clave o si el script no cargó. */
export function useGoogle(): EstadoGoogle {
  return useSyncExternalStore(suscribir, leerEstado, () => "nada");
}

export type LugarValor = { texto: string; lat: number | null; lng: number | null };
export const LUGAR_VACIO: LugarValor = { texto: "", lat: null, lng: null };

/**
 * Campo de dirección con autocompletado. Elegir una sugerencia trae sus COORDENADAS; teclear a mano
 * las borra (el texto ya no es el del punto elegido). Sin Google, es un campo de texto normal.
 */
export function LugarInput({ valor, onCambio, placeholder, ariaLabel }: {
  valor: LugarValor; onCambio: (v: LugarValor) => void; placeholder: string; ariaLabel: string;
}) {
  const g = useGoogle();
  const ref = useRef<HTMLInputElement>(null);
  const ac = useRef<google.maps.places.Autocomplete | null>(null);
  const cb = useRef(onCambio);
  useEffect(() => { cb.current = onCambio; });

  useEffect(() => {
    const G = goog();
    if (g !== "listo" || !G || !ref.current || ac.current) return;
    const a = new G.maps.places.Autocomplete(ref.current, {
      componentRestrictions: { country: "pe" },
      fields: ["formatted_address", "geometry.location", "name"],
      types: ["geocode", "establishment"],
    });
    a.addListener("place_changed", () => {
      const p = a.getPlace();
      const loc = p.geometry?.location;
      if (!loc) return;
      const nombre = p.name || "";
      const dir = p.formatted_address || "";
      const texto = nombre && dir && !dir.toLowerCase().includes(nombre.toLowerCase()) ? `${nombre}, ${dir}` : dir || nombre;
      cb.current({ texto, lat: loc.lat(), lng: loc.lng() });
    });
    ac.current = a;
    return () => {
      G.maps.event.clearInstanceListeners(a);
      ac.current = null;
    };
  }, [g]);

  const conCoords = valor.lat != null && valor.lng != null;
  return (
    <div>
      <div className="relative">
        <input ref={ref} type="text" value={valor.texto} aria-label={ariaLabel} placeholder={placeholder} autoComplete="off"
          onChange={(e) => onCambio({ texto: e.target.value, lat: null, lng: null })}
          className={iCls("pr-8")} />
        {valor.texto && (
          <button type="button" onClick={() => onCambio(LUGAR_VACIO)} aria-label={`Vaciar ${ariaLabel}`}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600 font-bold text-xs w-6 h-6">✕</button>
        )}
      </div>
      <p className="text-[10px] text-gray-400 mt-0.5">
        {g === "error" ? "Sin autocompletado de Google: se envía el texto tal cual."
          : conCoords ? `📍 Elegido de la lista: se envían sus coordenadas (${valor.lat!.toFixed(5)}, ${valor.lng!.toFixed(5)}).`
            : valor.texto ? "Se envía el texto tal cual, como lo escribiría el cliente."
              : g === "listo" ? "Escribe y elige de la lista, o deja el texto como lo escribiría el cliente." : "Cargando el autocompletado…"}
      </p>
    </div>
  );
}

/**
 * Dónde queda un texto (p. ej. «Ventanilla, Lima, Perú»), para encuadrar el mapa. Best-effort: sin
 * Google o si no lo encuentra, null — el mapa se queda donde estaba.
 */
export async function ubicarParaMapa(texto: string): Promise<{ lat: number; lng: number; zoom: number } | null> {
  const esperar = () => new Promise<GoogleNs | null>((res) => {
    const ya = goog();
    if (ya) return res(ya);
    iniciar();
    let n = 0;
    const t = window.setInterval(() => {
      const g = goog();
      if (g || estado === "error" || ++n > 50) { window.clearInterval(t); res(g); }
    }, 200);
  });
  const G = await esperar();
  if (!G) return null;
  try {
    const r = await new G.maps.Geocoder().geocode({ address: texto, region: "pe" });
    const res = r.results?.[0];
    const loc = res?.geometry?.location;
    if (!loc) return null;
    return { lat: loc.lat(), lng: loc.lng(), zoom: res.types?.includes("locality") || res.types?.includes("political") ? 13 : 15 };
  } catch {
    return null;
  }
}
