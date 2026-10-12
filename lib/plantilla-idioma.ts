// lib/plantilla-idioma.ts — PURO (sin red ni base): en qué idioma se manda una plantilla de
// WhatsApp, y qué decir cuando Meta contesta que no existe.
//
// EL CASO (11-10-2026): «🧪 Probar los avisos» devolvió en los 8 WhatsApp
//   (#132001) Template name does not exist in the translation
// El ERP manda TODAS las plantillas en «es» (es como las crea desde /configuracion/operaciones), y en
// la cuenta de avisos (Afa Notificaciones) tres NO EXISTÍAN —conductor_recuerda_iniciar,
// conductor_no_inicio y coordinador_alerta— y una estaba registrada en INGLÉS con el texto en español
// (conductor_proximo_inicio). Meta da el MISMO error para los dos casos, en inglés, y sin decir qué
// hacer. Y como los avisos de inicio no quedaban registrados, nadie lo había visto: esos WhatsApp no
// salían en producción.
//
// LA REGLA: el camino normal NO cambia — se manda en «es». Solo cuando Meta contesta 132001 se
// consulta la lista de plantillas de la cuenta:
//   · existe APROBADA en otro idioma → se reintenta UNA vez en ese idioma y se recuerda (los envíos
//     siguientes van directo, sin el intento fallido);
//   · no existe, o no está aprobada → el error pasa a decir eso, en castellano y con dónde se arregla;
//   · la lista no se pudo consultar → queda el error original de Meta: no se afirma lo que no se sabe.
// Un 132001 fallido no se cobra (Meta no entrega el mensaje), así que el intento extra es gratis.

/** Idioma con el que el ERP crea y manda sus plantillas. */
export const IDIOMA_POR_DEFECTO = "es";
/** Lo que el ERP recuerda que una plantilla va en otro idioma. Una hora: si alguien la cambia en
 *  Meta, el próximo 132001 vuelve a consultar. */
export const TTL_IDIOMA_MS = 60 * 60 * 1000;

/** Una traducción de la plantilla en la cuenta: su código de idioma y su estado en Meta. */
export type IdiomaEnMeta = { codigo: string; estado: string };

export type DecisionIdioma =
  | { tipo: "usar"; codigo: string }
  | { tipo: "no_existe" }
  | { tipo: "no_aprobada"; estados: string[] };

export type MemoIdiomas = Map<string, { codigo: string; hasta: number }>;

/** ¿Es el error de Meta «esa plantilla no existe en ese idioma»? */
export function esFaltaDePlantilla(mensaje: unknown): boolean {
  return typeof mensaje === "string" && /#?132001\b/.test(mensaje);
}

/**
 * Con qué idioma se puede mandar la plantilla, según la lista de la cuenta. Solo una traducción
 * APROBADA sirve: Meta rechaza las que están en revisión, rechazadas o pausadas. Prefiere el idioma
 * por defecto, después una variante suya (es_MX, es_AR…) y al final cualquier otra aprobada —el caso
 * real es una plantilla registrada en inglés con el texto en español—, en orden alfabético para que
 * la elección no dependa del orden en que Meta la devuelva.
 */
export function decidirIdioma(idiomas: IdiomaEnMeta[], preferido = IDIOMA_POR_DEFECTO): DecisionIdioma {
  const validas = idiomas.filter((i) => i && typeof i.codigo === "string" && i.codigo.trim());
  if (validas.length === 0) return { tipo: "no_existe" };
  const aprobadas = validas
    .filter((i) => String(i.estado ?? "").toUpperCase() === "APPROVED")
    .map((i) => i.codigo.trim())
    .sort();
  if (aprobadas.length === 0) {
    const estados = [...new Set(validas.map((i) => String(i.estado || "SIN ESTADO").toUpperCase()))].sort();
    return { tipo: "no_aprobada", estados };
  }
  const base = preferido.split("_")[0];
  const elegido = aprobadas.find((c) => c === preferido)
    ?? aprobadas.find((c) => c.split("_")[0] === base)
    ?? aprobadas[0];
  return { tipo: "usar", codigo: elegido };
}

const ESTADO_LEGIBLE: Record<string, string> = {
  PENDING: "en revisión", IN_APPEAL: "en apelación", REJECTED: "rechazada",
  PAUSED: "pausada", DISABLED: "desactivada",
};

/**
 * El error que se registra y se enseña, en castellano y con dónde se arregla. Lleva el código de
 * Meta al final para poder buscarlo. `probado` es el idioma con el que se acaba de fallar: si la
 * lista dice que la plantilla está aprobada justo en ese idioma, el problema no es la plantilla
 * sino el número desde el que se manda.
 */
export function motivoPlantilla(nombre: string, d: DecisionIdioma, probado: string): string {
  const n = `«${nombre}»`;
  switch (d.tipo) {
    case "no_existe":
      return `La plantilla ${n} no existe en la cuenta de WhatsApp de avisos. Hay que crearla en Meta `
        + `(en el ERP: Configuración → Alertas y Mensajes → Crear plantilla nueva). (Meta #132001)`;
    case "no_aprobada":
      return `La plantilla ${n} está en Meta pero no aprobada (${d.estados.map((e) => ESTADO_LEGIBLE[e] ?? e.toLowerCase()).join(", ")}): `
        + `no sale hasta que Meta la apruebe. (Meta #132001)`;
    case "usar":
      return d.codigo === probado
        ? `La plantilla ${n} está aprobada en la cuenta de avisos, pero Meta no la encuentra para el número que envía: `
          + `revisa qué número está marcado como «avisos». (Meta #132001)`
        : `La plantilla ${n} no salió en «${probado}» ni en «${d.codigo}». (Meta #132001)`;
  }
}

/**
 * Manda una plantilla con el idioma correcto. `enviar` hace el envío real en el idioma que se le pase
 * (y lanza con el mensaje de Meta si falla); `consultar` trae las traducciones de la plantilla en la
 * cuenta, o null si no se pudo. `memo` recuerda el idioma que funcionó, para no repetir el intento
 * fallido en cada destinatario.
 */
export async function enviarConIdiomaCorrecto<T>(args: {
  plantilla: string;
  enviar: (idioma: string) => Promise<T>;
  consultar: () => Promise<IdiomaEnMeta[] | null>;
  memo: MemoIdiomas;
  ahoraMs: number;
}): Promise<T> {
  const { plantilla, enviar, consultar, memo, ahoraMs } = args;
  const recordado = memo.get(plantilla);
  const primero = recordado && recordado.hasta > ahoraMs ? recordado.codigo : IDIOMA_POR_DEFECTO;
  try {
    return await enviar(primero);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!esFaltaDePlantilla(msg)) throw e;
    memo.delete(plantilla);
    let idiomas: IdiomaEnMeta[] | null = null;
    try { idiomas = await consultar(); } catch { idiomas = null; }
    if (!idiomas) throw e;
    const d = decidirIdioma(idiomas);
    if (d.tipo === "usar" && d.codigo !== primero) {
      const r = await enviar(d.codigo);
      memo.set(plantilla, { codigo: d.codigo, hasta: ahoraMs + TTL_IDIOMA_MS });
      return r;
    }
    throw new Error(motivoPlantilla(plantilla, d, primero));
  }
}
