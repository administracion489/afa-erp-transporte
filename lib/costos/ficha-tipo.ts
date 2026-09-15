// lib/costos/ficha-tipo.ts — La FICHA de un tipo de vehículo: cómo se llama, cuántos asientos
// declara, en qué grupo se lista y con qué ícono. Módulo PURO: no lee la base, igual que
// `lib/costeo-propio.ts`, para que la matriz corra sin Supabase.
//
// POR QUÉ EXISTE. `/configuracion/costos → Flota / Vehículos` dejaba editar los QUINCE campos
// de dinero de cada tipo (rendimiento, neumáticos, depreciación, seguros, conductor) y ninguno
// de los cuatro que lo IDENTIFICAN en pantalla. El nombre se tecleaba una vez, en el formulario
// de alta, y a partir de ahí un `SUV 6 pax GLP` mal escrito —o una categoría que cambió de
// combustible y quedó con el nombre viejo— no tenía arreglo desde ninguna pantalla del ERP.
// Ese nombre es lo que se ve en el cotizador, en el comparativo de unidades y en el tarifario,
// así que el error se lee en cuatro sitios y no se corrige en ninguno.
//
// LO QUE NO SE EDITA, Y ES DELIBERADO: `tipo_vehiculo`, la CLAVE. Es texto sin FK y es el
// puente con la flota (`vehiculos.tipo_vehiculo_costeo`, `vehiculos_tercero.tipo_vehiculo_costeo`),
// con el historial (`historial_costos.tipo_vehiculo`, de donde sale el sello de procedencia del
// rendimiento medido) y con lo ya cotizado (`cotizaciones.tipo_vehiculo`). Renombrarla desde
// aquí dejaría todo eso apuntando a una clave que ya no existe: es exactamente *escribir con
// una identidad y leer con otra*, el patrón que este repo pagó tres veces en un día. La ficha
// es la ETIQUETA; la clave es la identidad y se queda quieta.
//
// LA CAPACIDAD DE LA FICHA NO ES LA DEL BUS NI LA CONTRATADA. Aquí son los asientos que declara
// la CATEGORÍA de costeo (lo que el cotizador ofrece como "6 pax"); la del vehículo vive en
// `vehiculos.capacidad_pasajeros` y la que se le cobra al cliente en
// `reservas.capacidad_contratada`. Tres números con tres dueños: ver la cascada de
// `resolverPaxContratado` en lib/liquidacion-rutas.ts.

/** Los grupos con los que se agrupa la tabla de tipos. Se declaran aquí —y no dentro de la
 *  página— porque el formulario de alta, el de edición y la validación tienen que ofrecer la
 *  MISMA lista: tres copias es como una se queda atrás. */
export const GRUPOS_VEHICULO = ["Ligeros", "Vans", "Buses", "Otros"] as const;

/** Los íconos que se pueden elegir. Misma razón que arriba. */
export const ICONOS_VEHICULO = ["🚗", "🚙", "🚐", "🚌", "🏎️", "🚚", "🚛", "🚑"] as const;

/** Lo que la ficha declara hoy, tal como viene de `parametros_costos`. */
export type FichaTipo = {
  tipo_vehiculo: string;
  nombre: string;
  capacidad: number;
  icono: string | null;
  grupo_vehiculo: string | null;
};

/** Lo que hay tecleado en el formulario. Todo texto: es lo que devuelve un `<input>`. */
export type FormFicha = {
  nombre: string;
  capacidad: string;
  icono: string;
  grupo_vehiculo: string;
};

export type CampoFicha = "nombre" | "capacidad" | "icono" | "grupo_vehiculo";

export type CambioFicha = {
  campo: CampoFicha;
  /** Cómo se lee el campo en pantalla y en el historial. */
  etiqueta: string;
  antes: string;
  despues: string;
};

/** Una fila de `historial_costos`, con la forma que pide `escribirParametro`. */
export type ActaFicha = {
  campo_modificado: string;
  valor_anterior: number | null;
  valor_nuevo: number | null;
  motivo: string;
};

export type PlanFicha = {
  /** Las columnas que hay que escribir. Vacío = no hay nada que guardar. */
  patch: Record<string, unknown>;
  /** Un acta POR CAMPO cambiado. El historial es por campo desde siempre (`campo_modificado`),
   *  y una sola fila resumen dejaría un cambio de capacidad sin sus dos números. */
  actas: ActaFicha[];
  cambios: CambioFicha[];
  /** Bloquean el guardado. La pantalla no llama a la base con errores presentes. */
  errores: string[];
  /** No bloquean: son cosas que conviene mirar antes de firmar. */
  avisos: string[];
  /** true solo si hay algo que escribir Y no hay ningún error. */
  guardable: boolean;
};

export const ETIQUETA_FICHA: Record<CampoFicha, string> = {
  nombre: "Nombre",
  capacidad: "Capacidad",
  icono: "Ícono",
  grupo_vehiculo: "Grupo",
};

/** El texto de la ficha tal como está guardado, para pre-llenar el formulario. */
export function fichaAForm(f: FichaTipo): FormFicha {
  return {
    nombre: f.nombre ?? "",
    capacidad: f.capacidad != null ? String(f.capacidad) : "",
    icono: f.icono ?? "",
    grupo_vehiculo: f.grupo_vehiculo ?? "",
  };
}

/** Un texto para comparar: sin espacios de sobra y sin dobles espacios internos. Se aplica a
 *  los DOS lados —lo guardado y lo tecleado— porque si no, un nombre que solo ganó un espacio
 *  al final se guardaría como "cambio" y dejaría un acta que no describe nada. */
const limpiar = (s: string) => s.trim().replace(/\s+/g, " ");

/** Cuántos asientos declara el texto, o null si no es un número de asientos. Entero y > 0: medio
 *  asiento no existe, y un 0 haría que el tipo se ofreciera como "0 pax" en el cotizador. */
export function parsearCapacidad(txt: string): number | null {
  const t = txt.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Qué se va a escribir, qué acta queda y qué impide guardar.
 *
 * No escribe nada: devuelve el plan para que la pantalla lo ENSEÑE antes del botón. Es el mismo
 * criterio que `planDeCancelacion` y `planDeCanje` — sobre un dato que se lee en cuatro
 * pantallas, se ve primero lo que va a pasar.
 *
 * @param actual   la ficha tal como está guardada
 * @param form     lo tecleado
 * @param nota     el "motivo del cambio" global de la pantalla; se ANEXA a cada acta
 * @param otros    los demás tipos activos, para avisar de un nombre repetido (no bloquea)
 */
export function planDeFicha(
  actual: FichaTipo,
  form: FormFicha,
  nota?: string,
  otros: { tipo_vehiculo: string; nombre: string }[] = []
): PlanFicha {
  const patch: Record<string, unknown> = {};
  const actas: ActaFicha[] = [];
  const cambios: CambioFicha[] = [];
  const errores: string[] = [];
  const avisos: string[] = [];
  const sufijo = nota && nota.trim() ? ` | ${nota.trim()}` : "";

  const anota = (campo: CampoFicha, antes: string, despues: string, a: number | null, n: number | null) => {
    const etiqueta = ETIQUETA_FICHA[campo];
    cambios.push({ campo, etiqueta, antes, despues });
    actas.push({
      campo_modificado: campo,
      valor_anterior: a,
      valor_nuevo: n,
      motivo: `${etiqueta}: «${antes}» → «${despues}»${sufijo}`,
    });
  };

  // ── NOMBRE ──────────────────────────────────────────────────────────────────
  // Es lo único que el operador ve del tipo en el cotizador y en el tarifario. Vaciarlo dejaría
  // botones sin texto en tres pantallas, así que es obligatorio.
  const nombreAnt = limpiar(actual.nombre ?? "");
  const nombreNue = limpiar(form.nombre);
  if (!nombreNue) {
    errores.push("El nombre no puede quedar vacío: es lo que se ve en el cotizador y en el tarifario.");
  } else if (nombreNue !== nombreAnt) {
    patch.nombre = nombreNue;
    anota("nombre", nombreAnt || "—", nombreNue, null, null);
    const choca = otros.filter(o => o.tipo_vehiculo !== actual.tipo_vehiculo && limpiar(o.nombre ?? "") === nombreNue);
    if (choca.length) {
      avisos.push(
        `Ya hay otro tipo activo llamado «${nombreNue}» (${choca.map(o => o.tipo_vehiculo).join(", ")}). ` +
        `Se puede guardar —cada tipo se identifica por su clave, no por su nombre— pero en el ` +
        `cotizador van a verse dos opciones con el mismo texto.`
      );
    }
  }

  // ── CAPACIDAD ───────────────────────────────────────────────────────────────
  const capNue = parsearCapacidad(form.capacidad);
  if (capNue === null) {
    errores.push("La capacidad tiene que ser un número entero de asientos mayor que 0.");
  } else if (capNue !== actual.capacidad) {
    patch.capacidad = capNue;
    anota("capacidad", `${actual.capacidad} pax`, `${capNue} pax`, actual.capacidad ?? null, capNue);
    avisos.push(
      "La capacidad de la ficha son los asientos que declara la CATEGORÍA de costeo: cambia cómo " +
      "se ofrece este tipo en el cotizador y el orden de la tabla. No toca la capacidad de " +
      "ninguna placa (/vehículos) ni el PAX contratado de ningún servicio (/programación)."
    );
  }

  // ── GRUPO ───────────────────────────────────────────────────────────────────
  // Un grupo desconocido NO se rechaza: puede haber filas antiguas con un grupo que ya no está
  // en la lista, y bloquear el guardado obligaría a cambiarlo para poder corregir el nombre.
  const grupoAnt = limpiar(actual.grupo_vehiculo ?? "");
  const grupoNue = limpiar(form.grupo_vehiculo);
  if (!grupoNue) {
    errores.push("El grupo no puede quedar vacío: es cómo se agrupan los tipos en la tabla.");
  } else if (grupoNue !== grupoAnt) {
    patch.grupo_vehiculo = grupoNue;
    anota("grupo_vehiculo", grupoAnt || "—", grupoNue, null, null);
    if (!(GRUPOS_VEHICULO as readonly string[]).includes(grupoNue)) {
      avisos.push(`«${grupoNue}» no es uno de los grupos habituales (${GRUPOS_VEHICULO.join(", ")}): va a salir en su propio bloque.`);
    }
  }

  // ── ÍCONO ───────────────────────────────────────────────────────────────────
  // Es decoración, así que vacío es un dato válido: la tabla ya pinta 🚌 cuando no hay ninguno.
  const iconoAnt = (actual.icono ?? "").trim();
  const iconoNue = form.icono.trim();
  if (iconoNue !== iconoAnt) {
    patch.icono = iconoNue || null;
    anota("icono", iconoAnt || "—", iconoNue || "—", null, null);
  }

  const hayCambio = Object.keys(patch).length > 0;
  return { patch, actas, cambios, errores, avisos, guardable: hayCambio && errores.length === 0 };
}
