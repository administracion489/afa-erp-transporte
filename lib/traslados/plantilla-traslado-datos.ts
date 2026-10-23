// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/plantilla-traslado-datos.ts — QUÉ PLANTILLA PDF le da las condiciones (y las cuentas)
// al traslado que cotiza la IA. Lee la base (recibe el cliente de Supabase); la regla es PURA y vive
// en lib/cotizacion-plantillas.ts (`plantillaTrasladoIA`, `plantillaParaUso`, `segmentoDeCliente`).
//
// LAS CONDICIONES DEL TRASLADO SE EDITABAN EN DOS SITIOS. Vivían en `traslados_config`
// (/tarifario → Ajustes de traslados) mientras las de toda otra cotización vivían en la plantilla
// (/cotizaciones/plantillas). Desde supabase/cotizaciones-05-plantillas-uso.sql las del traslado son
// las de la plantilla que dice la regla «Traslado de la IA × segmento» (la migración las TRASPASA a
// «Traslados (IA)» y, si había líneas solo para dólares, a «Traslados (IA) · dólares»), y la
// cotización las COPIA a su fila al crearse (versión 2: el PDF imprime la fila).
//
// DESDE supabase/cotizaciones-09-reglas-traslado-idioma.sql LA REGLA ES IDIOMA × MONEDA (cuatro
// celdas, `cotizacion_plantilla_reglas_traslado`): el idioma lo deriva el CÓDIGO de los mensajes del
// cliente (lib/idioma-cliente.ts) y la moneda la decide el motor. Con esa tabla el tipo del cliente
// ya no decide nada y NO se lee; las reglas viejas de `traslado_ia` quedan sin uso.
//
// LO QUE NO SE AFLOJA:
//  · SIN LA MIGRACIÓN (falta la tabla de reglas o la de plantillas) → `plantilla: null` y quien
//    llama usa `traslados_config` EXACTAMENTE como antes: la fila de la cotización sale byte a byte
//    la de siempre. Tampoco se lee el cliente: sin reglas su tipo no decide nada.
//  · SIN cotizaciones-09 (falta la tabla nueva) → la regla vieja por segmento, línea por línea la de
//    antes: el inglés no existe (`ingles: null`).
//  · UNA LECTURA QUE FALLA (plantillas, reglas o el tipo del cliente cuando decide) NO ES «NO HAY
//    REGLAS»: devuelve `ok: false` con el motivo, y la IA deriva al ejecutivo. Tomarla por una
//    ausencia elegiría en silencio OTRAS condiciones para un PDF que puede salir sin revisión.
//  · EL SEGMENTO SALE DE LA MONEDA DEL MOTOR Y DEL CLIENTE YA VERIFICADO (`clienteId`, el que
//    calcula `clienteIdDeRemitente`: vinculado al contacto por una persona, o con el número COMPLETO
//    del wa_id). Nunca del cuerpo de una petición ni de lo que escribe el modelo: este módulo no
//    recibe ningún texto libre. El `idioma` es un enum que deriva el código, no un texto.
//  · Una plantilla que la IA no sabe dibujar (otro diseño, otro idioma, inactiva) no se usa nunca
//    (`sirveParaIA`, dentro de `plantillaParaUso` y `plantillaTrasladoIA`).
// ──────────────────────────────────────────────────────────────────────────────

import { leerPlantillasYReglas } from "../cotizacion-plantillas-datos";
import {
  inglesDisponible, plantillaParaUso, plantillaTrasladoIA, segmentoDeCliente,
  type CeldaTraslado, type CodigoUso, type InglesTraslado, type PlantillaFila, type Segmento,
} from "../cotizacion-plantillas";
import { normalizarIdioma, type Idioma } from "../cotizacion-idioma";
import { normalizarMoneda } from "../cotizacion-moneda";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

export type PlantillaTraslado =
  | {
    ok: true; plantilla: PlantillaFila | null; codigo: CodigoUso; detalle: string;
    /** El segmento de la regla vieja (sin cotizaciones-09). Con la regla nueva no decide nada: va el de la moneda. */
    segmento: Segmento;
    /** La celda idioma × moneda que eligió la plantilla; null = la regla vieja por segmento. */
    celda: CeldaTraslado | null;
    /** El idioma de las condiciones que se copian (el de la plantilla); null = las de Ajustes (castellano). */
    idiomaCondiciones: Idioma | null;
    /** En qué monedas cotiza la IA en inglés (`inglesDisponible`); null = falta la tabla de cotizaciones-09. */
    ingles: InglesTraslado | null;
  }
  | { ok: false; detalle: string };

/** El tipo del cliente del ERP (`clientes.tipo`), o null si no tiene. LANZA si no se puede leer. */
async function tipoDeCliente(sb: Sb, clienteId: number): Promise<string | null> {
  const { data, error } = await sb.from("clientes").select("id, tipo").eq("id", clienteId).maybeSingle();
  if (error) throw new Error(String(error.message ?? "error desconocido"));
  const t = (data as { tipo?: unknown } | null)?.tipo;
  return typeof t === "string" ? t : null;
}

const idiomaDePlantilla = (p: PlantillaFila | null): Idioma | null => (p ? normalizarIdioma(p.idioma) : null);

/**
 * La plantilla del PDF de un traslado de la IA. `plantilla: null` con `ok: true` = las condiciones
 * de `traslados_config` (sin la migración, o sin una plantilla que la IA pueda usar: `codigo` y
 * `detalle` dicen cuál). `ok: false` = no se pudo saber: quien llama deriva (la IA) o lo dice (el
 * simulador). `idioma` (el de la cotización, «es» si no viene) elige la fila de la regla nueva.
 */
export async function plantillaParaTraslado(sb: Sb, x: { moneda: unknown; clienteId: number | null; idioma?: Idioma }): Promise<PlantillaTraslado> {
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
    return { ok: true, plantilla: u.plantilla, segmento, codigo: u.codigo, detalle: u.detalle, celda: null, idiomaCondiciones: idiomaDePlantilla(u.plantilla), ingles: null };
  }

  // Con la regla idioma × moneda (cotizaciones-09): la celda la deciden el idioma y la moneda; el
  // tipo del cliente ya no decide nada, así que no se lee.
  if (lect.reglasTraslado !== null) {
    const segmento = segmentoDeCliente({ moneda: x.moneda, tipoCliente: null });
    const celda: CeldaTraslado = { idioma: x.idioma === "en" ? "en" : "es", moneda: normalizarMoneda(x.moneda) };
    const u = plantillaTrasladoIA(celda, lect.plantillas, lect.reglasTraslado, { reglas: lect.reglas, segmento });
    return {
      ok: true, plantilla: u.plantilla, segmento, codigo: u.codigo, detalle: u.detalle,
      celda: u.celda, idiomaCondiciones: u.idiomaCondiciones, ingles: inglesDisponible(lect.plantillas, lect.reglasTraslado),
    };
  }

  // La regla vieja por segmento. El tipo del cliente solo se lee si puede decidir algo: con dólares
  // el segmento es `extranjero` sea quien sea, y sin cliente verificado es `particular`.
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
  return { ok: true, plantilla: u.plantilla, segmento, codigo: u.codigo, detalle: u.detalle, celda: null, idiomaCondiciones: idiomaDePlantilla(u.plantilla), ingles: null };
}

/**
 * ¿Está encendido el inglés de la IA, y en qué monedas? (`inglesDisponible`: una celda «inglés»
 * ASIGNADA con una plantilla en inglés que la IA pueda usar). `ingles: null` = falta la tabla de
 * cotizaciones-09 (todo en castellano, como antes). Una lectura que falla es `ok: false`: quien llama
 * decide (la IA sigue en castellano —lo de siempre— y la plantilla del paso de la cotización deriva
 * igual si tampoco se puede leer).
 */
export async function leerInglesTraslado(sb: Sb): Promise<{ ok: true; ingles: InglesTraslado | null } | { ok: false; detalle: string }> {
  let lect: Awaited<ReturnType<typeof leerPlantillasYReglas>>;
  try {
    lect = await leerPlantillasYReglas(sb);
  } catch (e) {
    return { ok: false, detalle: `No se pudieron leer las plantillas del PDF: ${String((e as Error)?.message ?? e)}` };
  }
  if (!lect.ok) return { ok: false, detalle: lect.error };
  return { ok: true, ingles: inglesDisponible(lect.plantillas, lect.reglasTraslado) };
}
