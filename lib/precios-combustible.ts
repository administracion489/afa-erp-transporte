// Sincroniza el precio "oficial" de /configuracion/costos (tabla `precios_combustible`)
// con el precio real de la última carga registrada en /combustible (tabla `combustible`).
//
// La carga real es la fuente más actual del precio, así que cada vez que un vehículo
// recarga se actualiza el precio vigente que alimenta el Cotizador (costo por km).
//
// ── DOS VOCABULARIOS, UNA SOLA DERIVACIÓN ───────────────────────────────────
//
// Los identificadores difieren entre las dos tablas y eso no va a cambiar:
//   `combustible.tipo_combustible`  →  código del catálogo: diesel, glp, gnv, gasolina_premium…
//   `precios_combustible.tipo`      →  etiqueta capitalizada CON TILDE: Diésel, GLP, Gasolina…
//
// La etiqueta NO se puede renombrar: es la que guarda `parametros_costos.tipo_combustible_1` y
// la clave del mapa de precios que usan `costo-km-parametro.ts` y el cotizador. Lo que sí se
// puede es derivar su código por el MISMO camino que el resto del ERP, y eso es lo que hace
// `filaPrecioReferencial` (lib/combustible-tipos.ts).
//
// Aquí había un `MAPA_TIPO` escrito a mano —una TERCERA lista de tipos— y ya se había quedado
// atrás: **`gasolina_regular` y `gasolina_premium` no estaban**, así que desde que el catálogo
// abrió la gasolina por octanaje ninguna carga de gasolina actualizó el precio vigente del
// Cotizador. Con la derivación compartida, un grado sin fila propia cae a la de su FAMILIA
// (`Gasolina`), que es como está cargada la tabla hoy.
//
// ── Y EL PRECIO SE LLEVA A LA UNIDAD DE LA FICHA, NO SE COPIA ────────────────
//
// `precios_combustible.precio` es por la unidad CANÓNICA de la familia (S//galón, S//m³): el
// cotizador lo divide entre `rendimiento_1`, que está en km/gal o km/m³. Una carga de GLP
// capturada en LITROS trae un precio por litro —~S/ 2.00 donde la ficha espera ~S/ 7.55— y
// copiarlo tal cual habría metido un precio 3.8 veces menor en el renglón de combustible de
// toda cotización nueva de esa categoría. Se convierte (es exacto) y el acta lo dice; si la
// unidad no se puede convertir a la canónica, NO se escribe nada.

import {
  filaPrecioReferencial,
  factorAUnidadCanonica,
  configCombustible,
} from "@/lib/combustible-tipos";

type SyncArgs = {
  tipoCombustible: string | null; // valor de combustible.tipo_combustible (código del catálogo)
  precio: number;                 // precio por unidad de la carga (precio_galon)
  fecha: string;                  // fecha de la carga (YYYY-MM-DD)
  /** `combustible.unidad` de la carga. Sin dato se asume la canónica de la familia. */
  unidad?: string | null;
  actualizadoPor?: string;        // email del operador
};

/**
 * Actualiza `precios_combustible` con el precio de la carga recién registrada.
 * No lanza: cualquier error se traga y se loguea (nunca debe romper el guardado de la carga).
 * Devuelve true solo si efectivamente actualizó el precio.
 */
export async function sincronizarPrecioDesdeCarga(
  supabase: any,
  { tipoCombustible, precio, fecha, unidad, actualizadoPor }: SyncArgs
): Promise<boolean> {
  try {
    if (!tipoCombustible || !precio || precio <= 0) return false;

    // El precio de la carga, llevado a la unidad en la que vive la ficha. `null` = no hay
    // conversión posible (un m³ no es un galón): mejor no tocar el precio que escribir uno que
    // describe otra magnitud.
    const factor = factorAUnidadCanonica(unidad, tipoCombustible);
    if (factor === null) return false;
    const precioCanonico = precio * factor;
    const cfg = configCombustible(tipoCombustible);

    // Todas las filas, y la que toca se elige con la derivación compartida (tipo exacto primero,
    // familia después). Un `.eq("tipo", …)` obligaría a saber de antemano cómo está escrita.
    const { data: filas, error: errSel } = await supabase
      .from("precios_combustible")
      .select("id, tipo, precio, fecha_vigencia");
    if (errSel || !filas?.length) return false;

    const elegida = filaPrecioReferencial(filas as any[], tipoCombustible);
    if (!elegida) return false; // sin fila que actualizar (tipo no configurado)
    const fila: any = elegida.fila;

    // No pisar el precio vigente con una carga más antigua que la última vigencia.
    if (fila.fecha_vigencia && fecha && fecha < fila.fecha_vigencia) return false;

    // Si el precio no cambió, no hay nada que hacer.
    if (Number(fila.precio) === Number(precioCanonico)) return false;

    const email = actualizadoPor || "Carga de combustible";
    const hoyISO = new Date().toISOString();
    const convertido =
      factor !== 1
        ? ` (la carga se registró en ${String(unidad)} a S/ ${precio.toFixed(2)}; convertido a ${cfg.unidadLabel})`
        : "";

    const { error: errUpd } = await supabase
      .from("precios_combustible")
      .update({
        precio_anterior: fila.precio,
        precio:          Number(precioCanonico),
        fuente:          "Carga de combustible",
        fecha_vigencia:  fecha || hoyISO.split("T")[0],
        actualizado_en:  hoyISO,
        actualizado_por: email,
        notas:           `Auto desde carga de combustible (${email})${convertido}`,
      })
      .eq("id", fila.id);

    if (errUpd) return false;

    // Auditoría (mismo formato que /configuracion/costos).
    await supabase.from("historial_costos").insert({
      tabla_origen:     "precios_combustible",
      tipo_combustible: fila.tipo,
      campo_modificado: "precio",
      valor_anterior:   fila.precio,
      valor_nuevo:      Number(precioCanonico),
      motivo:           `Auto: carga de combustible${convertido}`,
      cambiado_por:     email,
    });

    return true;
  } catch (e) {
    console.error("sincronizarPrecioDesdeCarga:", e);
    return false;
  }
}
