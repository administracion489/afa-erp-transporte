// Sincroniza el precio "oficial" de /configuracion/costos (tabla `precios_combustible`)
// con el precio real de la última carga registrada en /combustible (tabla `combustible`).
//
// La carga real es la fuente más actual del precio, así que cada vez que un vehículo
// recarga se actualiza el precio vigente que alimenta el Cotizador (costo por km).
//
// Los identificadores de tipo difieren entre ambas tablas:
//   `combustible.tipo_combustible`  →  minúsculas: diesel, gasolina, glp, gnv, urea, biodiesel
//   `precios_combustible.tipo`      →  capitalizado con tilde: Diésel, Gasolina, GLP, GNV, UREA
// Este mapa hace el puente. Los tipos sin fila en `precios_combustible` (p. ej. biodiesel)
// simplemente se omiten.

const MAPA_TIPO: Record<string, string> = {
  diesel:    "Diésel",
  gasolina:  "Gasolina",
  glp:       "GLP",
  gnv:       "GNV",
  urea:      "UREA",
  biodiesel: "Biodiésel", // solo se aplica si existe la fila; si no, se omite
};

type SyncArgs = {
  tipoCombustible: string | null; // valor de combustible.tipo_combustible (minúscula)
  precio: number;                 // precio por unidad de la carga (precio_galon)
  fecha: string;                  // fecha de la carga (YYYY-MM-DD)
  actualizadoPor?: string;        // email del operador
};

/**
 * Actualiza `precios_combustible` con el precio de la carga recién registrada.
 * No lanza: cualquier error se traga y se loguea (nunca debe romper el guardado de la carga).
 * Devuelve true solo si efectivamente actualizó el precio.
 */
export async function sincronizarPrecioDesdeCarga(
  supabase: any,
  { tipoCombustible, precio, fecha, actualizadoPor }: SyncArgs
): Promise<boolean> {
  try {
    if (!tipoCombustible || !precio || precio <= 0) return false;

    const tipoOficial = MAPA_TIPO[tipoCombustible.toLowerCase()];
    if (!tipoOficial) return false;

    // Fila vigente para ese tipo.
    const { data: fila, error: errSel } = await supabase
      .from("precios_combustible")
      .select("id, tipo, precio, fecha_vigencia")
      .eq("tipo", tipoOficial)
      .maybeSingle();

    if (errSel || !fila) return false; // sin fila que actualizar (tipo no configurado)

    // No pisar el precio vigente con una carga más antigua que la última vigencia.
    if (fila.fecha_vigencia && fecha && fecha < fila.fecha_vigencia) return false;

    // Si el precio no cambió, no hay nada que hacer.
    if (Number(fila.precio) === Number(precio)) return false;

    const email = actualizadoPor || "Carga de combustible";
    const hoyISO = new Date().toISOString();

    const { error: errUpd } = await supabase
      .from("precios_combustible")
      .update({
        precio_anterior: fila.precio,
        precio:          Number(precio),
        fuente:          "Carga de combustible",
        fecha_vigencia:  fecha || hoyISO.split("T")[0],
        actualizado_en:  hoyISO,
        actualizado_por: email,
        notas:           `Auto desde carga de combustible (${email})`,
      })
      .eq("id", fila.id);

    if (errUpd) return false;

    // Auditoría (mismo formato que /configuracion/costos).
    await supabase.from("historial_costos").insert({
      tabla_origen:     "precios_combustible",
      tipo_combustible: fila.tipo,
      campo_modificado: "precio",
      valor_anterior:   fila.precio,
      valor_nuevo:      Number(precio),
      motivo:           "Auto: carga de combustible",
      cambiado_por:     email,
    });

    return true;
  } catch (e) {
    console.error("sincronizarPrecioDesdeCarga:", e);
    return false;
  }
}
