// lib/costos/nivel-servicio.ts — FULL EQUIPO y ESTÁNDAR: una sola palabra para el nivel de servicio,
// sobre DOS columnas que siguen siendo distintas. Módulo PURO: no lee la base.
//
// ─────────────────────────────────────────────────────────────────────────────
// EL BUG: LA MISMA DECISIÓN COMERCIAL SE TOMABA DOS VECES CON DOS NOMBRES
//
// AFA vende dos niveles de servicio. En el ERP eso se expresaba en dos sitios que no se hablaban:
//
//   · `equipamiento` ∈ {full_equipo, basico} — el confort. Vive en `vehiculos` (por placa),
//     en `tarifario` (DENTRO de su índice único) y en `cotizaciones`.
//   · el sufijo `_ESTANDAR` de `parametros_costos.tipo_vehiculo` — la antigüedad, que decide
//     el COSTO (ver `equilibrio-usado.ts` y `costos-03-nombres-por-antiguedad.sql`).
//
// El operador elegía «⭐ Full Equipo» arriba y abajo seguía viendo las trece fichas
// `· Estándar (>10 años)` entre las que elegir, y el botón del cotizador no filtraba NADA: solo
// se guardaba al crear la cotización. Dos nombres para la misma decisión y ninguno de los dos
// acotaba al otro, así que nada impedía cotizar «Full Equipo» costeado con la ficha de una
// unidad de más de diez años — y el PDF del cliente imprime las dos cosas.
//
// ─────────────────────────────────────────────────────────────────────────────
// LO QUE SE UNIFICA ES LA PALABRA. LOS VALORES GUARDADOS NO SE TOCAN.
//
// `full_equipo`/`basico` son valores escritos en tres tablas, y en `tarifario` forman parte del
// índice único `(origen,destino,tipo_vehiculo,equipamiento,tipo_servicio)`. Renombrarlos a
// otra cosa dejaría huérfana cada fila del tarifario — que es la lista de precios —,
// o sea *escribir con una identidad y leer con otra*, el patrón que este repo ya pagó cuatro
// veces. Es exactamente la lección de `costos-03`: ahí cambió el NOMBRE de la ficha y la clave
// `_ESTANDAR` se quedó igual.
//
// Por eso la conversión entre los dos vocabularios vive AQUÍ y en un solo sitio: si cada
// pantalla la escribiera, bastaría con que una tratara el null como básico para que el mismo
// servicio saliera de dos niveles según quién lo abriera.
//
// LO QUE NO SE FUNDE, Y ES DELIBERADO: la antigüedad NO se afirma desde el equipamiento. El
// subtítulo de cada nivel dice lo que la columna SABE (AC · TV · USB · GPS / cumple ley); el
// «(<10 años)» vive en el nombre de la ficha, donde es cierto por construcción.
import { esUsado, clavePremiumDe, claveUsadaDe } from "./equilibrio-usado";

/**
 * Los dos niveles, con el nombre COMERCIAL que usa AFA con sus clientes: «Full Equipo» y
 * «Estándar». Nunca «Premium» — esa palabra no se usa al vender y tenerla en pantalla obligaba a
 * traducirla mentalmente en cada cotización.
 *
 * OJO CON LA TRAMPA QUE DEJA ESTE NOMBRE: `full_equipo` coincide por casualidad con el valor
 * guardado en la columna `equipamiento`, pero `estandar` NO — ahí el valor guardado es `basico`.
 * Así que la conversión sigue siendo obligatoria y pasa siempre por `equipamientoDeNivel`; darla
 * por identidad porque "se llaman igual" escribiría `"estandar"` dentro del índice único del
 * tarifario y dejaría huérfana esa fila de precios.
 */
export type NivelServicio = "full_equipo" | "estandar";

/** Los dos valores que de verdad están escritos en la base. No se renombran. */
export type Equipamiento = "full_equipo" | "basico";

export const NIVELES: NivelServicio[] = ["full_equipo", "estandar"];

export const NIVEL_CFG: Record<NivelServicio, {
  /** Lo que se lee en pantalla. Una sola palabra para todo el ERP. */
  label: string;
  icono: string;
  /** Lo que el dato SABE. Nunca la antigüedad: eso lo declara la ficha. */
  sub: string;
  /** El valor real de la columna `equipamiento`. */
  equipamiento: Equipamiento;
  color: string;
  bg: string;
}> = {
  full_equipo: { label: "Full Equipo", icono: "⭐", sub: "AC · TV · USB · GPS", equipamiento: "full_equipo", color: "#7c3aed", bg: "#f5f3ff" },
  estandar:    { label: "Estándar",    icono: "📦", sub: "Cumple ley",          equipamiento: "basico",      color: "#4b5563", bg: "#f3f4f6" },
};

/**
 * El nivel que declara una columna `equipamiento`.
 *
 * El respaldo es FULL EQUIPO y no es una elección estética: `vehiculos.equipamiento` nació con
 * `default 'full_equipo'` y media flota tiene el valor implícito, así que tratar el null como
 * básico degradaría en pantalla a unidades que nadie marcó — y el nivel se imprime en el PDF
 * del cliente.
 */
export function nivelDeEquipamiento(equip: string | null | undefined): NivelServicio {
  return equip === "basico" ? "estandar" : "full_equipo";
}

export function equipamientoDeNivel(nivel: NivelServicio): Equipamiento {
  return NIVEL_CFG[nivel].equipamiento;
}

/**
 * El nivel que declara una FICHA de costeo. Se deriva de `esUsado` —el sufijo `_ESTANDAR`— y no
 * se re-deduce mirando el nombre, que es texto editable desde `ModalFichaTipo`.
 */
export function nivelDeFicha(tipoVehiculo: string | null | undefined): NivelServicio {
  return esUsado(tipoVehiculo) ? "estandar" : "full_equipo";
}

/**
 * Las fichas de un nivel.
 *
 * PARTICIÓN TOTAL: toda ficha cae en exactamente uno de los dos niveles, así que las dos listas
 * son disjuntas y su unión es la flota entera. Una ficha activa que ninguna pantalla lista es
 * una ficha que se sigue cotizando y que nadie ve — la matriz lo fija contándolas.
 */
export function fichasDelNivel<T extends { tipo_vehiculo: string }>(
  fichas: T[], nivel: NivelServicio
): T[] {
  return fichas.filter(f => nivelDeFicha(f.tipo_vehiculo) === nivel);
}

/** La clave gemela de `clave` en `nivel`. Null cuando esa categoría no existe en ese nivel. */
export function fichaEquivalente(
  clave: string | null | undefined, nivel: NivelServicio, claves: string[]
): string | null {
  if (!clave) return null;
  if (nivelDeFicha(clave) === nivel) return claves.includes(clave) ? clave : null;
  const gemela = nivel === "estandar" ? claveUsadaDe(clave) : clavePremiumDe(clave);
  return gemela && claves.includes(gemela) ? gemela : null;
}

export type CodigoPlanNivel =
  | "sin_seleccion"   // no había ficha elegida: no hay nada que mover
  | "ya_en_nivel"     // la ficha elegida ya es de ese nivel
  | "cambia"          // se pasa a la gemela: misma capacidad, otro nivel
  | "sin_gemela"      // esa categoría no tiene ficha en el nivel destino → se suelta y se DICE
  | "nivel_vacio";    // no hay NINGUNA ficha en ese nivel

export type PlanNivel = {
  codigo: CodigoPlanNivel;
  /** La ficha que queda seleccionada. `null` = ninguna, y la pantalla tiene que decir por qué. */
  clave: string | null;
  detalle: string;
};

/**
 * QUÉ LE PASA A LA SELECCIÓN CUANDO SE CAMBIA DE NIVEL.
 *
 * La regla que importa: cambiar de nivel es **cambiar de nivel, no perder el bus**. Si hay
 * gemela, se pasa a ella (misma capacidad, otro nivel) en vez de dejar el selector en blanco
 * obligando a rebuscar la categoría; es lo que el operador quiere decir al pulsar el botón.
 *
 * Y las dos salidas que NO se pueden tomar cuando no hay gemela:
 *  · dejar la ficha del otro nivel puesta → la pantalla diría «Full Equipo» y el costo saldría de una
 *    ficha de más de diez años, en silencio. Es el bug de arriba por otra puerta.
 *  · soltarla sin decir nada → el operador ve el selector vacío y cree que la pantalla se rompió.
 * Se suelta y se NOMBRA qué categoría falta, que es lo único accionable (crearla, o elegir otra).
 */
export function planDeNivel<T extends { tipo_vehiculo: string; nombre?: string | null }>(
  claveActual: string | null | undefined, nivel: NivelServicio, fichas: T[]
): PlanNivel {
  const delNivel = fichasDelNivel(fichas, nivel);
  const nom = NIVEL_CFG[nivel].label;

  if (!delNivel.length) {
    return {
      codigo: "nivel_vacio", clave: null,
      detalle: `No hay ninguna categoría de costeo en el nivel ${nom}. Se crean en Configuración → Costos.`,
    };
  }
  if (!claveActual) return { codigo: "sin_seleccion", clave: null, detalle: "" };
  if (nivelDeFicha(claveActual) === nivel) {
    return { codigo: "ya_en_nivel", clave: claveActual, detalle: "" };
  }

  const gemela = fichaEquivalente(claveActual, nivel, fichas.map(f => f.tipo_vehiculo));
  const actual = fichas.find(f => f.tipo_vehiculo === claveActual);
  const nombreActual = actual?.nombre || claveActual;

  if (!gemela) {
    return {
      codigo: "sin_gemela", clave: null,
      detalle: `«${nombreActual}» no tiene categoría ${nom}: elige otra unidad de la lista, o créala en Configuración → Costos.`,
    };
  }
  const nombreGemela = fichas.find(f => f.tipo_vehiculo === gemela)?.nombre || gemela;
  return { codigo: "cambia", clave: gemela, detalle: `${nombreActual} → ${nombreGemela}` };
}

export type CodigoCotejoNivel = "coincide" | "discrepa" | "sin_dato";

export type CotejoNivel = { codigo: CodigoCotejoNivel; detalle: string };

/**
 * LA PLACA ELEGIDA CONTRA EL NIVEL DEL SERVICIO. Cruza dos campos del MISMO formulario, igual
 * que `cotejarFichaConTanques`.
 *
 * Hace falta porque la unidad de flota se puede elegir ANTES que el nivel: al revés, `selVeh` ya
 * escribe el nivel desde la placa y no hay contradicción posible. El daño es concreto y llega al
 * cliente: `lib/pdf-chrome.ts` imprime en el ANEXO 1 el nivel de la PLACA y su
 * `descripcion_unidad`, así que se vende «Full Equipo» y el papel dice «cumple ley».
 *
 * SIN DATO NO SE AFIRMA NADA, y ese caso es la mayoría: `vehiculos_tercero` **no tiene** columna
 * `equipamiento` —86 de las 89 unidades—, así que juzgar ahí sería inventar el nivel de casi
 * toda la flota. Tri-estado, la misma regla del semáforo de puntualidad.
 */
export function cotejarUnidadConNivel(
  equipUnidad: string | null | undefined, nivel: NivelServicio, tieneDato: boolean
): CotejoNivel {
  if (!tieneDato) return { codigo: "sin_dato", detalle: "" };
  const nivelUnidad = nivelDeEquipamiento(equipUnidad);
  if (nivelUnidad === nivel) return { codigo: "coincide", detalle: "" };
  return {
    codigo: "discrepa",
    detalle: `La unidad está marcada como ${NIVEL_CFG[nivelUnidad].label} y el servicio se está cotizando como ${NIVEL_CFG[nivel].label}. El PDF del cliente imprime la descripción de la unidad, así que va a decir «${NIVEL_CFG[nivelUnidad].sub}». Corrige el nivel arriba, o el equipamiento de la placa en Vehículos.`,
  };
}

/** El rótulo del nivel para documentos: el ANEXO 1 del PDF y la descripción del ítem. */
export function etiquetaNivel(equip: string | null | undefined): string {
  return NIVEL_CFG[nivelDeEquipamiento(equip)].label.toUpperCase();
}
