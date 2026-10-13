// lib/odometro-decimas-datos.ts
// El que LEE: qué unidades tienen el tambor de décimas, a partir de `odometro_correcciones`.
// Las reglas viven en lib/odometro-decimas.ts (puro); aquí solo hay consultas. Recibe el cliente
// (service-role en las rutas y el Radar, el de sesión en las pantallas: la tabla se lee con RLS).
//
// Todo es BEST-EFFORT: si la consulta falla, la unidad se trata como sin tambor conocido, que es
// exactamente el comportamiento de antes. Una lectura de odómetro no puede caerse por esto.

import { tamborDecimasDe, type TamborDecimas, type CorreccionOdometro } from "./odometro-decimas";

type Flota = "propia" | "tercero";

const COLS = "motivo_tipo, km_leido, km_correcto, created_at";

/** Clave de una unidad: los ids de las dos flotas se repiten, así que va con la flota. */
export const claveUnidad = (flota: Flota, id: number): string => `${flota}:${id}`;

/** El tambor de décimas de UNA unidad (sus correcciones), o null. */
export async function tamborDecimasDeUnidad(
  client: any,
  o: { vehiculo_id: number; flota?: Flota },
): Promise<TamborDecimas | null> {
  try {
    const fk = o.flota === "tercero" ? "vehiculo_tercero_id" : "vehiculo_id";
    const { data, error } = await client
      .from("odometro_correcciones").select(COLS).eq(fk, o.vehiculo_id)
      .order("created_at", { ascending: false }).limit(500);
    if (error) return null;
    return tamborDecimasDe((data ?? []) as CorreccionOdometro[]);
  } catch {
    return null;
  }
}

/**
 * Los tambores de TODA la flota, por `claveUnidad`. Lo usa el Radar, que arma una línea de prompt
 * por unidad. Se leen todas las correcciones (la forma del número se reconoce también en las que no
 * llevan el motivo), paginadas y con orden estable.
 */
export async function tamboresDecimasDeFlota(client: any): Promise<Map<string, TamborDecimas>> {
  const porUnidad = new Map<string, CorreccionOdometro[]>();
  try {
    const PAG = 1000;
    for (let desde = 0; desde < 10_000; desde += PAG) {
      const { data, error } = await client
        .from("odometro_correcciones").select(`vehiculo_id, vehiculo_tercero_id, ${COLS}`)
        .order("created_at", { ascending: false }).order("id", { ascending: true })
        .range(desde, desde + PAG - 1);
      if (error) break;
      for (const f of (data ?? []) as any[]) {
        const clave = f.vehiculo_tercero_id != null
          ? claveUnidad("tercero", Number(f.vehiculo_tercero_id))
          : f.vehiculo_id != null ? claveUnidad("propia", Number(f.vehiculo_id)) : null;
        if (!clave) continue;
        const lista = porUnidad.get(clave) ?? [];
        lista.push(f);
        porUnidad.set(clave, lista);
      }
      if (!data || data.length < PAG) break;
    }
  } catch {
    // best-effort: lo leído hasta aquí sirve
  }
  const out = new Map<string, TamborDecimas>();
  for (const [clave, filas] of porUnidad) {
    const t = tamborDecimasDe(filas);
    if (t) out.set(clave, t);
  }
  return out;
}
