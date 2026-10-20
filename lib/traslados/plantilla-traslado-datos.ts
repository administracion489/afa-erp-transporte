// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/plantilla-traslado-datos.ts — QUÉ PLANTILLA PDF le da las condiciones (y las cuentas)
// al traslado que cotiza la IA. Lee la base (recibe el cliente de Supabase); la regla es PURA y vive
// en lib/cotizacion-plantillas.ts (`plantillaParaUso`, `segmentoDeCliente`).
//
// LAS CONDICIONES DEL TRASLADO SE EDITABAN EN DOS SITIOS. Vivían en `traslados_config`
// (/tarifario → Ajustes de traslados) mientras las de toda otra cotización vivían en la plantilla
// (/cotizaciones/plantillas). Desde supabase/cotizaciones-05-plantillas-uso.sql las del traslado son
// las de la plantilla que dice la regla «Traslado de la IA × segmento» (la migración las TRASPASA a
// «Traslados (IA)» y, si había líneas solo para dólares, a «Traslados (IA) · dólares»), y la
// cotización las COPIA a su fila al crearse (versión 2: el PDF imprime la fila).
//
// LO QUE NO SE AFLOJA:
//  · SIN LA MIGRACIÓN (falta la tabla de reglas o la de plantillas) → `plantilla: null` y quien
//    llama usa `traslados_config` EXACTAMENTE como antes: la fila de la cotización sale byte a byte
//    la de siempre. Tampoco se lee el cliente: sin reglas su tipo no decide nada.
//  · UNA LECTURA QUE FALLA (plantillas, reglas o el tipo del cliente cuando decide) NO ES «NO HAY
//    REGLAS»: devuelve `ok: false` con el motivo, y la IA deriva al ejecutivo. Tomarla por una
//    ausencia elegiría en silencio OTRAS condiciones para un PDF que puede salir sin revisión.
//  · EL SEGMENTO SALE DE LA MONEDA DEL MOTOR Y DEL CLIENTE YA VERIFICADO (`clienteId`, el que
//    calcula `clienteIdDeRemitente`: vinculado al contacto por una persona, o con el número COMPLETO
//    del wa_id). Nunca del cuerpo de una petición ni de lo que escribe el modelo: este módulo no
//    recibe ningún texto libre.
//  · Una plantilla que la IA no sabe dibujar (otro diseño, inglés, inactiva) no se usa nunca
//    (`sirveParaIA`, dentro de `plantillaParaUso`).
// ──────────────────────────────────────────────────────────────────────────────

import { leerPlantillasYReglas } from "../cotizacion-plantillas-datos";
import { plantillaParaUso, segmentoDeCliente, type CodigoUso, type PlantillaFila, type Segmento } from "../cotizacion-plantillas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

export type PlantillaTraslado =
  | { ok: true; plantilla: PlantillaFila | null; segmento: Segmento; codigo: CodigoUso; detalle: string }
  | { ok: false; detalle: string };

/** El tipo del cliente del ERP (`clientes.tipo`), o null si no tiene. LANZA si no se puede leer. */
async function tipoDeCliente(sb: Sb, clienteId: number): Promise<string | null> {
  const { data, error } = await sb.from("clientes").select("id, tipo").eq("id", clienteId).maybeSingle();
  if (error) throw new Error(String(error.message ?? "error desconocido"));
  const t = (data as { tipo?: unknown } | null)?.tipo;
  return typeof t === "string" ? t : null;
}

/**
 * La plantilla del PDF de un traslado de la IA. `plantilla: null` con `ok: true` = las condiciones
 * de `traslados_config` (sin la migración, o sin una plantilla que la IA pueda usar: `codigo` y
 * `detalle` dicen cuál). `ok: false` = no se pudo saber: quien llama deriva (la IA) o lo dice (el
 * simulador).
 */
export async function plantillaParaTraslado(sb: Sb, x: { moneda: unknown; clienteId: number | null }): Promise<PlantillaTraslado> {
  let lect: Awaited<ReturnType<typeof leerPlantillasYReglas>>;
  try {
    lect = await leerPlantillasYReglas(sb);
  } catch (e) {
    return { ok: false, detalle: `No se pudieron leer las plantillas del PDF: ${String((e as Error)?.message ?? e)}` };
  }
  if (!lect.ok) return { ok: false, detalle: lect.error };

  // Sin reglas (falta supabase/cotizaciones-05): el comportamiento de siempre, sin leer al cliente.
  if (lect.reglas === null) {
    const segmento = segmentoDeCliente({ moneda: x.moneda, tipoCliente: null });
    const u = plantillaParaUso({ servicio: "traslado_ia", segmento }, lect.plantillas, null);
    return { ok: true, plantilla: u.plantilla, segmento, codigo: u.codigo, detalle: u.detalle };
  }

  // El tipo del cliente solo se lee si puede decidir algo: con dólares el segmento es `extranjero`
  // sea quien sea, y sin cliente verificado es `particular`.
  let tipoCliente: string | null = null;
  const id = Number(x.clienteId);
  if (segmentoDeCliente({ moneda: x.moneda, tipoCliente: null }) !== "extranjero" && x.clienteId != null && Number.isInteger(id) && id > 0) {
    try {
      tipoCliente = await tipoDeCliente(sb, id);
    } catch (e) {
      return { ok: false, detalle: `No se pudo leer el tipo del cliente ${id} (empresa o particular), que decide qué plantilla usa la cotización: ${String((e as Error)?.message ?? e)}` };
    }
  }
  const segmento = segmentoDeCliente({ moneda: x.moneda, tipoCliente });
  const u = plantillaParaUso({ servicio: "traslado_ia", segmento }, lect.plantillas, lect.reglas);
  return { ok: true, plantilla: u.plantilla, segmento, codigo: u.codigo, detalle: u.detalle };
}
