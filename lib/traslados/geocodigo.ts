// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/geocodigo.ts — Lo que dijo Google de una dirección, convertido en PuntoUbicado.
// Motor PURO (lo usa lib/traslados/ubicar.ts y lo prueba scripts/prueba-traslados.mts).
//
// El DISTRITO se busca en la localidad (locality → administrative_area_level_3 → level_2), no en
// los barrios: «Santa Rosa» es un distrito de Lima Norte y también un barrio de Ate, y un barrio
// leído primero mandaría el pedido a la otra punta de la ciudad. Los barrios (sublocality,
// neighborhood) sirven para elegir SUBZONA y, solo si la localidad no dijo nada, de respaldo.
// ──────────────────────────────────────────────────────────────────────────────

import { claveNombre, esGenerico, type PuntoUbicado } from "./motor";

export type ComponenteGoogle = { long_name?: string; short_name?: string; types?: string[] };
export type ResultadoGoogle = {
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  address_components?: ComponenteGoogle[];
  types?: string[];
};

export const TIPOS_LOCALIDAD = ["locality", "administrative_area_level_3", "administrative_area_level_2"] as const;
export const TIPOS_BARRIO = ["sublocality_level_1", "sublocality", "neighborhood", "sublocality_level_2"] as const;

/** Los nombres, primero por tipo (del más específico) y dentro de cada tipo por orden de resultado. */
function recoger(resultados: readonly ResultadoGoogle[], tipos: readonly string[]): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const t of tipos) {
    for (const r of resultados) {
      for (const c of r.address_components ?? []) {
        if (!c.types?.includes(t)) continue;
        for (const n of [c.long_name, c.short_name]) {
          const k = claveNombre(n);
          if (!k || vistos.has(k)) continue;
          vistos.add(k);
          out.push(String(n));
        }
      }
    }
  }
  return out;
}

export function nombresDeResultados(resultados: readonly ResultadoGoogle[]): { localidades: string[]; barrios: string[] } {
  return { localidades: recoger(resultados, TIPOS_LOCALIDAD), barrios: recoger(resultados, TIPOS_BARRIO) };
}

/** El punto de la geocodificación directa: las coordenadas del primer resultado. */
export function puntoDeResultados(texto: string | null, resultados: readonly ResultadoGoogle[]): PuntoUbicado | null {
  const r0 = resultados[0];
  const lat = Number(r0?.geometry?.location?.lat);
  const lng = Number(r0?.geometry?.location?.lng);
  if (!r0 || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { texto: r0.formatted_address ?? texto ?? null, lat, lng, ...nombresDeResultados(resultados) };
}

/** ¿La localidad dice un distrito? Si solo dice «Lima» (o nada), conviene preguntar por las coordenadas. */
export function localidadUtil(p: PuntoUbicado | null | undefined): boolean {
  return !!p && p.localidades.some((n) => claveNombre(n) && !esGenerico(n));
}

/** Une lo que dio la dirección con lo que dio la geocodificación inversa de su punto, sin repetir. */
export function unirNombres(a: PuntoUbicado, b: { localidades: string[]; barrios: string[] }): PuntoUbicado {
  const une = (x: string[], y: string[]) => {
    const vistos = new Set(x.map(claveNombre));
    return [...x, ...y.filter((n) => !vistos.has(claveNombre(n)) && vistos.add(claveNombre(n)))];
  };
  return { ...a, localidades: une(a.localidades, b.localidades), barrios: une(a.barrios, b.barrios) };
}
