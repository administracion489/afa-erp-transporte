// lib/radar/guardado-radar.ts — El INSERT de `radar_combustible`, tolerante a migraciones sin correr.
// Recibe el cliente de Supabase (no crea ninguno) para poder probarse con uno falso:
// scripts/prueba-radar-guardado.mts.
//
// ESTE ES EL GUARDADO QUE DEJÓ AL RADAR SIN REGISTRAR RECARGAS DEL 14/09 AL 06/10. La fila empezó
// a llevar `nivel_tanque` (combustible-02, que el deploy no corre). El respaldo «soltar la columna y
// reintentar» existía, pero reconocía solo el texto de Postgres («does not exist»), y en un INSERT
// quien rechaza una columna desconocida es PostgREST, con PGRST204 «Could not find the
// 'nivel_tanque' column…». Cada recarga lanzaba, el motor la marcaba «Procesado» igual, y se perdía.
// El reconocimiento vive ahora en lib/columna-faltante.ts, que entiende las dos formas.

import { faltaAlguna } from "@/lib/columna-faltante";

/**
 * Columnas de `radar_combustible` que viven en migraciones que el deploy NO corre, con el SQL que
 * las crea. Que falte un SQL accesorio no puede hacer que una recarga ya leída se pierda entera.
 */
export const OPCIONALES_RADAR = {
  fotos: "radar-ia-combustible-revision.sql",
  vehiculo_tercero_id: "radar-ia-combustible-revision.sql",
  nivel_tanque: "combustible-02-nivel-tanque-radar.sql",
} as const;
export type OpcionalRadar = keyof typeof OPCIONALES_RADAR;

/**
 * Inserta en `radar_combustible` soltando la columna ACCESORIA que el error NOMBRA —no un juego
 * fijo: con un juego fijo el aviso acaba acusando a la migración equivocada— y dice cuáles soltó,
 * para que el resultado nombre el SQL que falta en vez de fingir que se guardó todo. Una columna que
 * NO es accesoria nunca se suelta: ese error se lanza tal cual.
 */
export async function insertarFilaRadar(
  sb: any,
  fila: Record<string, unknown>,
  devolverId = false
): Promise<{ data: any; quitadas: OpcionalRadar[] }> {
  let payload = { ...fila };
  const opcionales = Object.keys(OPCIONALES_RADAR) as OpcionalRadar[];
  for (let intento = 0; intento <= opcionales.length; intento++) {
    const q = sb.from("radar_combustible").insert(payload);
    const { data, error } = devolverId ? await q.select("id").single() : await q;
    if (!error) {
      return { data, quitadas: opcionales.filter((k) => k in fila && !(k in payload)) };
    }
    const culpable = faltaAlguna(error, opcionales.filter((c) => c in payload));
    if (!culpable) throw new Error(`radar_combustible: ${error.message}`);
    const { [culpable]: _fuera, ...resto } = payload;
    payload = resto;
  }
  throw new Error("radar_combustible: no se pudo insertar");
}

/** Lo que se dejó de guardar por una migración sin correr, en una frase que nombra el SQL. */
export function avisoColumnasQuitadas(quitadas: OpcionalRadar[]): string {
  if (!quitadas.length) return "";
  // Agrupado por SQL: dos columnas del mismo archivo se arreglan corriendo UNO.
  const porSql = new Map<string, string[]>();
  for (const c of quitadas) porSql.set(OPCIONALES_RADAR[c], [...(porSql.get(OPCIONALES_RADAR[c]) ?? []), `«${c}»`]);
  const partes = [...porSql].map(([sql, cols]) => `${cols.join(" ni ")} (falta correr supabase/${sql})`);
  return ` · sin ${partes.join(" ni ")}: la carga se guardó igual`;
}
