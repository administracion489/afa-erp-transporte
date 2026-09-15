// lib/radar/cluster-remitente.ts — QUIÉN REPORTÓ, en UN solo sitio. Módulo PURO.
//
// Un reporte de recarga llega partido (tablero, surtidor, nota) y `resolverCluster` lo vuelve a
// juntar por **mismo remitente + mismo grupo + ±10 min**. La ventana y el grupo son datos
// duros; el remitente NO lo es, y ahí estaba el agujero: se confiaba en que
// `radar_mensajes.remitente_wa` identifica a una persona, sin mirar nunca el valor.
//
// **EN PRODUCCIÓN SE FUSIONARON FOTOS DE VARIOS CELULARES EN UNA SOLA RECARGA**: seis fotos de
// tablero con odómetros distintos (29117, 17238, 29113…) —o sea, de unidades distintas y por
// tanto de conductores distintos— quedaron en una fila con la placa de una y los números de
// otra. Basta con que el jid llegue vacío o con un valor de relleno para que el `.eq()` de la
// consulta empareje a TODO el grupo: el filtro parece estricto y no lo es, porque un
// comodín compartido casa con todos.
//
// De ahí las dos reglas de este módulo, y hacen falta las dos:
//
//   1. **UN JID QUE NO IDENTIFICA A NADIE NO AGRUPA A NADIE.** Vacío, `"undefined"`,
//      `"[object Object]"`, un jid de GRUPO o de difusión no son personas. Sin remitente
//      utilizable el mensaje se procesa solo: perder el agrupado cuesta una fila de más en
//      revisión; fusionar de más pierde una recarga entera y nadie se entera.
//   2. **SE CRUZAN LAS DOS SEÑALES QUE MANDA WHATSAPP, no una**: el número (`remitente_wa`) y
//      el nombre con el que aparece (`remitente_nombre`, el pushName). Dos nombres distintos
//      son dos personas aunque el número que quedó guardado sea el mismo — que es exactamente
//      el caso que se coló. Es el mismo criterio que ya usan `esFalsaDiscrepancia` (comparar
//      los dos valores en vez de creerle al texto) y `leerAlbumRecargas` (cruzar lo extraído
//      con `comprobantes_vistos`): no confiar en un solo campo cuando el error es caro.
//
// El pushName FALTA a veces (WhatsApp no siempre lo manda), y eso **no** es evidencia de otra
// persona: solo contradice cuando los dos están escritos y son distintos.

/** Un remitente tal como quedó guardado en `radar_mensajes`. */
export type RemitenteRadar = { remitente_wa?: string | null; remitente_nombre?: string | null };

// Valores de relleno que han llegado (o pueden llegar) en lugar de un jid. Todos comparten el
// mismo defecto: son IGUALES para todo el mundo, así que agrupan a personas distintas.
const RELLENOS = new Set(["", "0", "undefined", "null", "nan", "[object object]", "false", "true"]);

/** Dominios que NO son una persona: el grupo entero, la difusión, los estados. */
const DOMINIOS_NO_PERSONA = ["@g.us", "@broadcast", "@newsletter", "@call"];

/**
 * El jid del autor, normalizado, o `null` si no identifica a una persona.
 *
 * Quita el sufijo de DISPOSITIVO (`51987654321:12@s.whatsapp.net` y `51987654321@s.whatsapp.net`
 * son el mismo teléfono en dos aparatos) y exige que la parte de usuario parezca un
 * identificador real: WhatsApp usa números, tanto para el teléfono como para el `@lid`.
 */
export function normalizarRemitente(wa?: string | null): string | null {
  const bruto = String(wa ?? "").trim().toLowerCase();
  if (!bruto || RELLENOS.has(bruto)) return null;
  if (DOMINIOS_NO_PERSONA.some((d) => bruto.endsWith(d))) return null;

  const arroba = bruto.indexOf("@");
  const usuarioBruto = arroba >= 0 ? bruto.slice(0, arroba) : bruto;
  const dominio = arroba >= 0 ? bruto.slice(arroba) : "";
  // El sufijo `:NN` es el dispositivo desde el que se envió, no otra persona.
  const usuario = usuarioBruto.split(":")[0].trim();
  if (!usuario || RELLENOS.has(usuario)) return null;
  // Un identificador de WhatsApp es numérico y largo. Cualquier otra cosa —un nombre, una
  // etiqueta, un resto de serialización— no sirve para decir "estas fotos son de la misma
  // persona", y creerle es lo que fusionó las de varios celulares.
  const digitos = usuario.replace(/\D+/g, "");
  if (digitos.length < 5) return null;
  return dominio ? `${usuario}${dominio}` : usuario;
}

/** El pushName normalizado para comparar, o `null` si no vino. */
export function normalizarNombreRemitente(nombre?: string | null): string | null {
  const n = String(nombre ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return n ? n : null;
}

/** Si de este mensaje se puede decir quién lo mandó (y por tanto si puede agrupar). */
export function remitenteUtilizable(m: RemitenteRadar): boolean {
  return normalizarRemitente(m.remitente_wa) !== null;
}

/**
 * Si dos mensajes los mandó la MISMA persona. Exige el mismo jid utilizable y que el pushName
 * no lo contradiga: dos nombres escritos y distintos son dos personas, aunque el jid guardado
 * haya salido igual. Un pushName ausente no contradice nada.
 */
export function mismoRemitente(a: RemitenteRadar, b: RemitenteRadar): boolean {
  const wa = normalizarRemitente(a.remitente_wa);
  if (!wa || wa !== normalizarRemitente(b.remitente_wa)) return false;
  const na = normalizarNombreRemitente(a.remitente_nombre);
  const nb = normalizarNombreRemitente(b.remitente_nombre);
  if (na && nb && na !== nb) return false;
  return true;
}

/**
 * Los miembros del cluster que de verdad mandó la misma persona que la referencia. La
 * referencia va incluida (si es utilizable) y el orden de entrada se conserva.
 */
export function miembrosDelMismoRemitente<T extends RemitenteRadar>(referencia: RemitenteRadar, candidatos: T[]): T[] {
  if (!remitenteUtilizable(referencia)) return [];
  return candidatos.filter((c) => mismoRemitente(referencia, c));
}
