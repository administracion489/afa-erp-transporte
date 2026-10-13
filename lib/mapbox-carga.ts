// lib/mapbox-carga.ts — SOLO NAVEGADOR.
// El motor de Mapbox bajo demanda, compartido por las pantallas que lo cargan perezoso
// (/cliente → "En vivo", /cotizaciones → mapa de paraderos).
//
// El motor son ~461 KB gz. Importarlo arriba de una página obliga a descargarlo, parsearlo y
// ejecutarlo antes de que la pantalla pida su primer dato, aunque nadie abra el mapa. Con
// este cargador se baja la primera vez que alguien lo necesita, y una sola vez por pestaña:
// las llamadas siguientes reciben la misma promesa.

export type MapboxAPI = (typeof import("mapbox-gl"))["default"];

let gl: MapboxAPI | null = null;
let carga: Promise<MapboxAPI> | null = null;

/** El token público de Mapbox. Vacío = el mapa no se puede montar (y la pantalla lo dice). */
export function tokenMapbox(): string {
  return process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
}

export function cargarMapbox(): Promise<MapboxAPI> {
  if (gl) return Promise.resolve(gl);
  if (!carga) {
    carga = import("mapbox-gl").then(mod => {
      const m = ((mod as { default?: MapboxAPI }).default ?? mod) as MapboxAPI;
      m.accessToken = tokenMapbox();
      gl = m;
      return m;
    }).catch(e => {
      // Un fallo de red al bajar el chunk no puede dejar el mapa roto para toda la sesión.
      carga = null;
      throw e;
    });
  }
  return carga;
}
