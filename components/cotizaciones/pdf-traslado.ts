// components/cotizaciones/pdf-traslado.ts — SOLO NAVEGADOR. El PDF de /cotizaciones de un TRASLADO
// cotizado por la IA del CRM (la cotización tiene `traslado_json`) con la plantilla corporativa:
// imprime LO MISMO que el PDF que se manda por WhatsApp, porque arma su entrada con la MISMA
// función que el servidor (`entradaCorporativaTraslado`, lib/traslados/cotizacion-traslado.ts) y con
// los mismos datos que lee lib/traslados/enviar-cotizacion-datos.ts: la fila, el cliente del ERP
// (que solo se imprime si está vinculado al contacto o su número completo es el wa_id), el wa_id y
// el cliente vinculado del contacto de la conversación, las CUENTAS de la plantilla de la cotización
// (`plantilla_pdf`; si no existe o no dibuja el diseño corporativo, `corporativo`, igual que el
// servidor) y la categoría del vehículo (con sus fotos y su descripción de traslados-07). Las
// CONDICIONES salen siempre de la fila: desde supabase/cotizaciones-05 la IA las copia ahí, en
// versión 2, desde la plantilla de su regla; en las de antes, de Ajustes de traslados.
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
import { clienteParaPdf, entradaCorporativaTraslado, type CategoriaPdf, type ClienteErp, type FilaCotizacionLeida } from "@/lib/traslados/cotizacion-traslado";
import type { EntradaPdfCot, PlantillaPdfCfg } from "@/lib/cotizacion-pdf";
import type { PerfilEmpresa } from "@/lib/empresa-perfil";
import { COLS_CATEGORIA_FOTOS } from "@/components/tarifario/traslados-datos";
import { esTrasladoIA } from "@/lib/cotizacion-plantillas";

/** Las columnas de la categoría que lee el PDF (las mismas que lee el servidor). */
const COLS_CATEGORIA_PDF = "clave, nombre, capacidad, maletas_bodega, tipo_vehiculo";

/** El aviso del modal cuando se pidió el PDF en inglés: el del traslado solo existe en castellano. */
/**
 * El aviso del modal cuando la cotización tiene un cliente del ERP que el PDF NO imprime: no está
 * vinculado al contacto de la conversación ni su número completo es el WhatsApp. Es la misma regla
 * del envío por WhatsApp (`clienteParaPdf`), así que callarlo haría creer que se imprimió.
 */
export const AVISO_CLIENTE_NO_VERIFICADO =
  "El cliente elegido en esta cotización no se imprime: no está vinculado al contacto de WhatsApp que la pidió ni su teléfono es ese número. El PDF sale con el nombre de quien escribió y su celular, igual que el que se envía por WhatsApp. Para imprimirlo, vincula el cliente al contacto en el CRM.";

export const AVISO_TRASLADO_EN_CASTELLANO =
  "Esta cotización de traslado la armó la IA del CRM: su PDF se imprime en castellano, igual que el que se envía por WhatsApp (la descripción del vehículo y la línea de disponibilidad no tienen versión en inglés).";

// ¿Es un traslado cotizado por la IA? (`traslado_json` es un objeto). La regla vive en
// lib/cotizacion-plantillas.ts (la usa también `servicioDeCotizacion`); aquí se re-exporta.
export { esTrasladoIA };

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

/**
 * El wa_id de la conversación que pidió la cotización (el CELULAR que imprime el PDF) y el cliente
 * del ERP vinculado a su contacto: los datos del cliente solo se imprimen si está vinculado o si su
 * número COMPLETO es el wa_id (`clienteParaPdf`, la misma regla que el servidor).
 */
async function leerConversacion(conversacionId: unknown): Promise<{ celular: string | null; contactoClienteId: number | null }> {
  const nada = { celular: null, contactoClienteId: null };
  if (typeof conversacionId !== "string" || !conversacionId) return nada;
  try {
    const { data, error } = await supabase.from("crm_conversaciones").select("id, crm_contactos(wa_id, cliente_id)").eq("id", conversacionId).maybeSingle();
    if (error || !data) return nada;
    const c = (Array.isArray(data.crm_contactos) ? data.crm_contactos[0] : data.crm_contactos) as { wa_id?: unknown; cliente_id?: unknown } | null;
    const vinc = Number(c?.cliente_id);
    return { celular: typeof c?.wa_id === "string" ? c.wa_id : null, contactoClienteId: Number.isInteger(vinc) && vinc > 0 ? vinc : null };
  } catch {
    return nada;
  }
}

/**
 * La entrada del PDF corporativo de un traslado de la IA, o null si no lo es o no se pudo armar.
 * `plantilla` es la plantilla con la que se imprime (la de `plantilla_pdf` de la cotización, de
 * diseño corporativo; o `corporativo`): solo se usan sus CUENTAS (`cfgSoloCuentas`), las condiciones
 * salen de la fila.
 */
export async function entradaTrasladoPagina(
  cot: FilaCotizacionLeida,
  x: { empresa: PerfilEmpresa | null; plantilla: PlantillaPdfCfg | null; cliente: ClienteErp | null },
): Promise<(EntradaPdfCot & { clienteNoVerificado: boolean }) | null> {
  if (!esTrasladoIA(cot)) return null;
  const [categoria, conv] = await Promise.all([leerCategoria(cot.traslado_json?.categoria?.clave), leerConversacion(cot.crm_conversacion_id)]);
  try {
    const entrada = entradaCorporativaTraslado(cot, {
      empresa: x.empresa, cliente: x.cliente, celular: conv.celular, contactoClienteId: conv.contactoClienteId,
      plantilla: x.plantilla, categoria,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    });
    const { vinculo } = clienteParaPdf(cot.cliente_id, x.cliente, { contactoClienteId: conv.contactoClienteId, waId: conv.celular });
    return { ...entrada, clienteNoVerificado: vinculo === "no_verificado" };
  } catch {
    return null;
  }
}
