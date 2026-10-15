// ──────────────────────────────────────────────────────────────────────────────
// lib/documentos-vehiculo-datos.ts — La ÚNICA puerta que escribe `documentos_vehiculo`.
//
// /vehiculos y /documentos-vehiculares tenían cada una su propio update/insert de la misma
// tabla. Es la fila autoritativa del SOAT/CAT/Todo Riesgo/RC de cada placa (de ahí lo deriva
// /seguros), así que dos caminos de escritura son dos sitios donde una regla se queda atrás.
//
// Sin cambio de comportamiento: se escribe EXACTAMENTE el payload que arma la pantalla (las
// columnas que trae, ni una más). `conductor_id` solo viaja si la pantalla lo manda: /vehiculos
// nunca lo escribió y un `null` añadido aquí borraría el que puso /documentos-vehiculares.
// ──────────────────────────────────────────────────────────────────────────────

export type DocumentoVehiculoPayload = {
  vehiculo_id: number;
  conductor_id?: number | null;
  tipo: string;
  numero: string | null;
  fecha_emision: string | null;
  fecha_vencimiento: string | null;
  entidad_emisora: string | null;
  archivo_url: string | null;
  observaciones: string | null;
};

/** Inserta (sin `id`) o actualiza (con `id`) un documento de vehículo. Devuelve el `error` de
 *  Supabase tal cual, para que la pantalla lo muestre como hasta hoy. */
export async function guardarDocumentoVehiculo(
  db: any, doc: DocumentoVehiculoPayload & { id?: number | null },
): Promise<{ error: any }> {
  const { id, ...payload } = doc;
  const { error } = id
    ? await db.from("documentos_vehiculo").update(payload).eq("id", id)
    : await db.from("documentos_vehiculo").insert(payload);
  return { error };
}
