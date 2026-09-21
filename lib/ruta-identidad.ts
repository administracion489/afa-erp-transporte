// ══════════════════════════════════════════════════════════════════════════════
// lib/ruta-identidad.ts
// LA RUTA Y EL ORIGEN → DESTINO SON DOS DATOS DISTINTOS. Módulo PURO.
//
// En `reservas` conviven dos columnas que la pantalla llamaba "RUTA" a las dos:
//
//   1. `ruta_nombre`  — el NOMBRE que alguien tecleó:
//                       "RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF PUNTA HERMOSA".
//                       Es lo que el cliente reconoce, lo que identifica el
//                       servicio en su orden de compra, y lo que el PASAJERO ve
//                       para elegir su ruta y su paradero en la app.
//   2. `origen`/`destino` — los EXTREMOS del recorrido, que se geocodifican solos
//                       y por eso a veces salen como un plus code
//                       ("W2VG+39R, EL AGUSTINO 15022, PERÚ").
//
// EL DEFECTO NO ERA EL MODELO DE DATOS: ERA LA ETIQUETA. Las dos columnas están
// bien y ninguna sobra. Lo que estaba mal es que las dos se rotulaban "RUTA", y
// —peor— que CUATRO sitios del ERP hacían el mismo colapso en silencio:
//
//     ruta_nombre || `${origen} → ${destino}`
//
// (app/pasajero/page.tsx ×2, lib/liquidacion-agrupacion.ts, y el portal, que ni
// siquiera recibía `ruta_nombre` y pintaba SOLO el recorrido bajo el rótulo
// "RUTA"). Un campo rotulado RUTA que a veces enseña el nombre y a veces el
// recorrido, sin decir cuál, es exactamente la trampa de la ventana invertida del
// horario del conductor: nada falla, nada avisa, y quien lee saca la conclusión
// equivocada.
//
// LA REGLA QUE NO SE PUEDE AFLOJAR: `identidadRuta` devuelve los DOS por separado
// y NUNCA sustituye uno por el otro. Sin nombre, `nombre` es null y la pantalla
// dice "Sin nombre" — no se cae al recorrido, igual que el PAX contratado nunca
// se cae a la capacidad del vehículo y la autorización del MTC nunca se hereda.
//
// El colapso sigue existiendo en UN solo sitio y con su nombre puesto:
// `rotuloColapsado`, que es lo que necesita la LIQUIDACIÓN — ahí el ítem imprime
// un renglón y un servicio sin nombre tiene que salir igual, rotulado con lo que
// haya. Ese camino conserva su comportamiento byte a byte (lo fija la matriz) y
// declara su `fuente`, que es lo que permite avisar cuando el rótulo NO salió del
// nombre de la ruta.
//
// Matriz: npx tsx scripts/prueba-ruta-identidad.mts
// ══════════════════════════════════════════════════════════════════════════════

// ─── Las DOS etiquetas, en un solo sitio ─────────────────────────────────────
//
// Se eligió el rótulo más EXPLÍCITO posible para el recorrido en vez de una
// palabra corta ("RECORRIDO", "TRAMO"): la confusión que este módulo arregla fue
// de vocabulario, así que una palabra nueva que también hay que aprender no la
// cierra. "ORIGEN → DESTINO" no se puede leer como otra cosa, y la flecha lo
// repite dentro del propio valor.
export const ETIQUETA_RUTA = "RUTA";
export const ETIQUETA_RECORRIDO = "ORIGEN → DESTINO";

/** Lo que se pinta donde iría el nombre cuando nadie lo escribió. */
export const SIN_NOMBRE_RUTA = "Sin nombre";

/** Lo que se pinta donde iría el recorrido cuando faltan los dos extremos. */
export const SIN_RECORRIDO = "Sin origen ni destino";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Lo mínimo que hay que traer de una reserva para resolver su identidad. */
export type ServicioConRuta = {
  ruta_nombre?: string | null;
  origen?: string | null;
  destino?: string | null;
};

/**
 * De dónde salió el rótulo cuando hubo que colapsar los dos en uno.
 * Importa porque solo `nombre` produce el texto que el cliente reconoce: con
 * `tramo` o `ninguna` el servicio existe igual, pero sale rotulado de otra forma
 * y en otro lugar de una lista ordenada alfabéticamente — el operador lo lee
 * como "esa ruta no salió".
 */
export type FuenteEtiqueta = "nombre" | "tramo" | "ninguna";

export type IdentidadRuta = {
  /**
   * El NOMBRE tal como se escribió, con los espacios normalizados. `null` cuando
   * nadie lo tecleó. NUNCA es el recorrido.
   */
  nombre: string | null;
  /**
   * "ORIGEN → DESTINO" con los extremos tal como están guardados (sin forzar
   * mayúsculas: este texto se pinta al cliente). `null` cuando faltan los dos.
   * Con UNO solo se publica ese: media identidad es más que ninguna, y el que
   * falta se ve por el hueco.
   */
  recorrido: string | null;
  origen: string | null;
  destino: string | null;
  /** Qué tendría que usar una pantalla obligada a enseñar un solo texto. */
  fuente: FuenteEtiqueta;
};

// ─── Normalizadores (compartidos por los dos caminos) ────────────────────────

/**
 * Solo se colapsan los espacios. Ni mayúsculas ni acentos se tocan: este texto lo
 * lee el cliente en su portal y el pasajero en su app, y tiene que decir lo mismo
 * en los dos sitios que en la pantalla donde se tecleó.
 */
const limpiar = (v: unknown): string => String(v ?? "").trim().replace(/\s+/g, " ");

// ─── La identidad, sin colapsar ──────────────────────────────────────────────

export function identidadRuta(r: ServicioConRuta | null | undefined): IdentidadRuta {
  const nombre = limpiar(r?.ruta_nombre) || null;
  const origen = limpiar(r?.origen) || null;
  const destino = limpiar(r?.destino) || null;

  const recorrido = origen && destino ? `${origen} → ${destino}` : origen || destino || null;

  return {
    nombre,
    recorrido,
    origen,
    destino,
    fuente: nombre ? "nombre" : recorrido ? "tramo" : "ninguna",
  };
}

/** ¿Este servicio no tiene nombre de ruta escrito? */
export const sinNombreDeRuta = (r: ServicioConRuta | null | undefined): boolean =>
  identidadRuta(r).nombre === null;

// ─── El colapso, con su nombre puesto ────────────────────────────────────────
//
// Este es el camino de la LIQUIDACIÓN y de cualquier documento que imprima un
// renglón por servicio: ahí no hay dos huecos, hay uno, y un servicio sin nombre
// tiene que salir igual. Por eso aquí SÍ se cae al recorrido — y por eso devuelve
// la `fuente`, para que quien lo llame pueda avisar de que ese rótulo no es el
// nombre que el cliente reconoce.
//
// El recorrido va en MAYÚSCULAS y el texto de respaldo es "SIN NOMBRE DE RUTA":
// los dos son el comportamiento histórico de `nombreRutaDetalle` y la matriz los
// compara contra la implementación original copiada literal. Si eso cambiara, se
// movería el texto impreso de renglones ya emitidos y la CLAVE de agrupación que
// sale de él — o sea, cómo se parten los ítems de una liquidación.

// OJO: el tramo se compone con los extremos CRUDOS (`r.origen`, `r.destino`), no
// con los normalizados de `identidadRuta`. No es un descuido: `filter(Boolean)`
// conserva una cadena de solo espacios y el `join` no colapsa los dobles, así que
// normalizar aquí cambiaría el texto de un puñado de servicios reales — y ese
// texto es la CLAVE con la que la liquidación parte sus ítems. Escribir bajo una
// clave y leer con otra, por enésima vez. `identidadRuta` sí normaliza porque lo
// suyo es la PANTALLA, donde un espacio de más solo se ve feo.
export function rotuloColapsado(
  r: ServicioConRuta | null | undefined,
): { nombre: string; fuente: FuenteEtiqueta } {
  const nombre = limpiar(r?.ruta_nombre);
  if (nombre) return { nombre, fuente: "nombre" };
  const tramo = [r?.origen, r?.destino].filter(Boolean).join(" → ").toUpperCase();
  return tramo ? { nombre: tramo, fuente: "tramo" } : { nombre: "SIN NOMBRE DE RUTA", fuente: "ninguna" };
}

/**
 * Separador entre "RUTA" y su letra. Con `\s+` a secas, "RUTA-A" y "RUTA:A" —que
 * se escriben a mano en tres pantallas distintas— no calzaban y el servicio salía
 * rotulado con su tramo. El `+` es deliberado: sin él "RUTAS" produciría "RUTA S".
 */
const RE_ETIQUETA_RUTA = /\bRUTA[\s:.\-–—]+([A-Z0-9]{1,3})\b/i;

/**
 * Etiqueta CORTA ("RUTA A", "RUTA 1") + por qué es esa. El nombre completo trae
 * hora y extremos y esos ya se muestran aparte; aquí solo interesa el
 * identificador que el cliente reconoce.
 */
export function etiquetaCortaDetalle(
  r: ServicioConRuta,
): { etiqueta: string; fuente: FuenteEtiqueta } {
  const m = RE_ETIQUETA_RUTA.exec(String(r.ruta_nombre ?? ""));
  if (m) return { etiqueta: `RUTA ${m[1].toUpperCase()}`, fuente: "nombre" };
  const tramo = [r.origen, r.destino].filter(Boolean).join(" → ").toUpperCase();
  return tramo ? { etiqueta: tramo, fuente: "tramo" } : { etiqueta: "RUTA ÚNICA", fuente: "ninguna" };
}
