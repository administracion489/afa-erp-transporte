// lib/json-canonico.ts — JSON con las claves ordenadas. Módulo PURO.
//
// Nació en lib/confirmacion-reserva.ts (la firma de cada versión de la Confirmación de Reserva) y se
// mudó aquí sin cambiar una coma porque la emisión de licitaciones firma su foto con la MISMA regla:
// dos módulos que firman documentos con dos serializaciones distintas terminan diciendo que el mismo
// documento cambió. confirmacion-reserva.ts lo re-exporta, así que ningún llamador viejo se movió.

/** JSON con las claves ordenadas: la misma foto da siempre la misma cadena. */
export function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
