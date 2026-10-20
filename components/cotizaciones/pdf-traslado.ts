// components/cotizaciones/pdf-traslado.ts — SOLO NAVEGADOR. El PDF de /cotizaciones de un TRASLADO
// cotizado por la IA del CRM (la cotización tiene `traslado_json`) con la plantilla corporativa:
// imprime LO MISMO que el PDF que se manda por WhatsApp, porque arma su entrada con la MISMA
// función que el servidor (`entradaCorporativaTraslado`, lib/traslados/cotizacion-traslado.ts) y con
// los mismos datos que lee lib/traslados/enviar-cotizacion-datos.ts: la fila, el cliente del ERP
// vinculado, el wa_id de la conversación, las cuentas de la plantilla `corporativo` y la categoría
// del vehículo (con sus fotos y su descripción de traslados-07).
//
// Sin esto, la página pintaba el traslado con la plantilla genérica: sus seis condiciones generales
// pisaban las del traslado (los 30 min de espera, el TAM), el subtítulo decía «Válida 30 días» aunque
// venciera antes, y la unidad salía como «Bus con capacidad… A/C…» siendo un AUTO.
//
// TODO ES BEST-EFFORT: una categoría o una conversación que no se pudo leer deja el PDF con menos
// datos (como en el servidor); si la entrada no se puede armar, devuelve null y la página imprime
// como siempre. Las cotizaciones que NO son traslados no pasan por aquí.

import { supabase } from "@/lib/supabase";
import { faltaAlguna } from "@/lib/columna-faltante";
import { entradaCorporativaTraslado, type CategoriaPdf, type ClienteErp, type FilaCotizacionLeida } from "@/lib/traslados/cotizacion-traslado";
import type { EntradaPdfCot, PlantillaPdfCfg } from "@/lib/cotizacion-pdf";
import type { PerfilEmpresa } from "@/lib/empresa-perfil";
import { COLS_CATEGORIA_FOTOS } from "@/components/tarifario/traslados-datos";

/** Las columnas de la categoría que lee el PDF (las mismas que lee el servidor). */
const COLS_CATEGORIA_PDF = "clave, nombre, capacidad, maletas_bodega, tipo_vehiculo";

/** El aviso del modal cuando se pidió el PDF en inglés: el del traslado solo existe en castellano. */
export const AVISO_TRASLADO_EN_CASTELLANO =
  "Esta cotización de traslado la armó la IA del CRM: su PDF se imprime en castellano, igual que el que se envía por WhatsApp (la descripción del vehículo y la línea de disponibilidad no tienen versión en inglés).";

/** ¿Es un traslado cotizado por la IA? (`traslado_json` es un objeto). */
export function esTrasladoIA(cot: { traslado_json?: unknown } | null | undefined): boolean {
  const tj = cot?.traslado_json;
  return !!tj && typeof tj === "object" && !Array.isArray(tj);
}

/** El cliente de la pantalla como lo lee el PDF. */
export function clienteErpDe(c: {
  nombre?: string | null; empresa?: string | null; tipo?: string | null; ruc?: string | null; dni?: string | null;
  direccion?: string | null; telefono?: string | null; operativo_nombre?: string | null;
} | null | undefined): ClienteErp | null {
  if (!c) return null;
  return {
    nombre: c.nombre ?? null, empresa: c.empresa ?? null, tipo: c.tipo ?? null, ruc: c.ruc ?? null, dni: c.dni ?? null,
    direccion: c.direccion ?? null, telefono: c.telefono ?? null, operativo_nombre: c.operativo_nombre ?? null,
  };
}

/** La categoría del vehículo, soltando SOLO la columna de traslados-07 que el error nombre. null si no se pudo leer. */
async function leerCategoria(clave: unknown): Promise<CategoriaPdf | null> {
  if (typeof clave !== "string" || !clave.trim()) return null;
  let quedan: string[] = [...COLS_CATEGORIA_FOTOS];
  try {
    for (;;) {
      const cols = quedan.length ? `${COLS_CATEGORIA_PDF}, ${quedan.join(", ")}` : COLS_CATEGORIA_PDF;
      const { data, error } = await supabase.from("traslado_categorias").select(cols).eq("clave", clave).maybeSingle();
      if (error) {
        const col = faltaAlguna(error, quedan);
        if (!col) return null;
        quedan = quedan.filter((x) => x !== col);
        continue;
      }
      return (data ?? null) as CategoriaPdf | null;
    }
  } catch {
    return null;
  }
}

/** El wa_id de la conversación que pidió la cotización (el CELULAR que imprime el PDF sin cliente del ERP). */
async function leerCelular(conversacionId: unknown): Promise<string | null> {
  if (typeof conversacionId !== "string" || !conversacionId) return null;
  try {
    const { data, error } = await supabase.from("crm_conversaciones").select("id, crm_contactos(wa_id)").eq("id", conversacionId).maybeSingle();
    if (error || !data) return null;
    const c = Array.isArray(data.crm_contactos) ? data.crm_contactos[0] : data.crm_contactos;
    return typeof c?.wa_id === "string" ? c.wa_id : null;
  } catch {
    return null;
  }
}

/**
 * La entrada del PDF corporativo de un traslado de la IA, o null si no lo es o no se pudo armar.
 * `plantilla` es la fila `corporativo` de `cotizacion_plantillas` (solo se usan sus cuentas).
 */
export async function entradaTrasladoPagina(
  cot: FilaCotizacionLeida,
  x: { empresa: PerfilEmpresa | null; plantilla: PlantillaPdfCfg | null; cliente: ClienteErp | null },
): Promise<EntradaPdfCot | null> {
  if (!esTrasladoIA(cot)) return null;
  const [categoria, celular] = await Promise.all([leerCategoria(cot.traslado_json?.categoria?.clave), leerCelular(cot.crm_conversacion_id)]);
  try {
    return entradaCorporativaTraslado(cot, {
      empresa: x.empresa, cliente: x.cliente, celular, plantilla: x.plantilla, categoria,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    });
  } catch {
    return null;
  }
}
