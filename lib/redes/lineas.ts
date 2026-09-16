// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/lineas.ts — LAS LÍNEAS DE NEGOCIO que el canal puede publicar.
// Módulo PURO: no lee la base, no llama a ninguna API, no toca el DOM.
//
// QUÉ VIENE A ARREGLAR
// El prompt del redactor decía «una empresa de transporte de PERSONAL en Perú» y nada
// más, así que el canal hablaba todos los días del mismo negocio. AFA hace cuatro:
// personal, turismo, paseos escolares y alquiler de buses. Las tres que faltaban no se
// publicaban nunca — no porque alguien lo decidiera, sino porque el prompt no las nombraba.
//
// UNA LÍNEA NO ES UN «TEMA», Y POR ESO NO SE RESOLVIÓ AÑADIÉNDOLA A `redes_config.temas`.
// Un tema es de qué habla el post de hoy (el mantenimiento, la puntualidad). Una línea es
// A QUIÉN LE HABLA y QUÉ SE LE PUEDE PROMETER, que es otra cosa: al jefe de planta que
// contrata el transporte de su personal y al colegio que organiza un paseo no se les dice
// lo mismo, ni se les puede decir lo mismo. Son ortogonales: la línea enmarca, el tema es
// el ángulo dentro de ella.
//
// LO QUE ESTE CATÁLOGO NO AFIRMA: que una empresa preste estas cuatro. Son las que el ERP
// SABE describir; cuáles ofrece cada instalación lo declara una persona en Ajustes
// (`redes_config.lineas`). **Este ERP se vende**, y publicar sobre paseos escolares en el
// canal de quien no los hace sería un dato inventado de los caros — el mismo error que el
// respaldo de `empresa-perfil`, por la puerta del marketing. Sin la migración corrida solo
// queda `personal`, que es exactamente el comportamiento anterior.
//
// EL CAMPO `ojo` ES LA MITAD QUE IMPORTA. Cada línea tiene cosas que NO se pueden decir, y
// no son las mismas: en turismo es prometer un itinerario que nadie pactó; en alquiler es
// afirmar disponibilidad; en escolar es **enseñar la cara de un menor**, que no es un
// problema de marketing sino uno legal. Viven aquí, al lado de su línea, y no en una lista
// general de prohibiciones: una lista aparte hay que acordarse de actualizarla el día que
// se añade una línea — misma razón por la que `problema` se declara pegado a su motivo.
// ──────────────────────────────────────────────────────────────────────────────

export type LineaNegocio = "personal" | "turismo" | "escolar" | "alquiler";

/** El orden es el de la pantalla y el de la rotación. */
export const LINEAS: LineaNegocio[] = ["personal", "turismo", "escolar", "alquiler"];

/** La que asume el ERP cuando nadie ha declarado nada. Es lo que ya hacía. */
export const LINEA_DEFECTO: LineaNegocio = "personal";

export type FichaLinea = {
  clave: LineaNegocio;
  etiqueta: string;
  icono: string;
  /** Una línea para la pantalla. */
  resumen: string;
  /** Qué es el servicio, en las palabras que va a usar el modelo. */
  queEs: string;
  /** A quién le habla el post. Cambia el tono entero. */
  aQuien: string;
  /** De qué SÍ se puede hablar sin inventar nada. Material para el modelo. */
  angulos: string[];
  /** Lo que NO se puede decir en esta línea, con su porqué. */
  ojo: string[];
  /**
   * Aviso que la PANTALLA pinta cuando esta línea está elegida. Solo lo llevan las líneas
   * donde el riesgo lo corre una persona al elegir la foto, no el modelo al redactar: un
   * aviso en las cuatro se volvería paisaje.
   */
  avisoPantalla?: string;
};

export const FICHA_LINEA: Record<LineaNegocio, FichaLinea> = {
  personal: {
    clave: "personal",
    etiqueta: "Transporte de personal",
    icono: "🏭",
    resumen: "El traslado diario de los trabajadores de una empresa.",
    queEs:
      "traslado diario de los trabajadores de una empresa entre sus paraderos y la sede, " +
      "con rutas y horarios fijos coordinados con el cliente",
    aQuien:
      "a quien decide el transporte dentro de una empresa: jefatura de planta, recursos " +
      "humanos, administración. Le importa que su gente entre a turno y que el servicio no " +
      "le dé problemas",
    angulos: [
      "la puntualidad mirada como un problema de producción, no como un eslogan",
      "la revisión de la unidad antes de salir",
      "la coordinación de rutas, paraderos y horarios con el cliente",
      "la documentación al día del conductor y del vehículo",
      "el control de quién sube y quién baja en cada paradero",
    ],
    ojo: [
      "NUNCA nombres al cliente, la ruta, la placa ni al conductor: son datos de un contrato",
      "no prometas «siempre puntuales» ni «cero incidentes»: nadie puede cumplir un absoluto",
    ],
  },
  turismo: {
    clave: "turismo",
    etiqueta: "Turismo",
    icono: "🏞️",
    resumen: "El bus y su conductor para una salida de grupo.",
    queEs:
      "el traslado de un grupo a su destino, con la unidad y el conductor, para una salida " +
      "de turismo o una excursión",
    aQuien:
      "a agencias de viaje, organizadores de grupos y empresas que arman una salida. Les " +
      "importa llegar y volver sin sobresaltos, y que el bus aguante carretera",
    angulos: [
      "lo que exige un viaje largo: descansos del conductor, revisión previa, repuestos",
      "la comodidad en carretera y el espacio para equipaje",
      "la coordinación de la hora de salida y la de retorno",
      "que el grupo viaje junto en vez de repartido",
    ],
    ojo: [
      "AFA pone el TRANSPORTE. No prometas destinos, itinerarios, precios, fechas de salida, " +
        "guías, entradas ni hoteles: eso se pacta viaje por viaje y no lo decide el post",
      "no inventes lugares concretos ni 'salidas todos los domingos'",
    ],
  },
  escolar: {
    clave: "escolar",
    etiqueta: "Paseos escolares",
    icono: "🎒",
    resumen: "Traslado de estudiantes para paseos, visitas y actividades del colegio.",
    queEs:
      "el traslado de estudiantes para un paseo, una visita de estudio o una actividad del " +
      "colegio, con la unidad y el conductor",
    aQuien:
      "a la dirección del colegio, a la coordinación de nivel y a los docentes que organizan " +
      "la salida. Lo primero que les importa es que los chicos vuelvan completos y a la hora",
    angulos: [
      "que viajan menores y lo que eso exige de la unidad y del conductor",
      "el conteo de quién sube y quién baja en cada parada",
      "que los docentes acompañan y el transporte se coordina con ellos",
      "los horarios de recojo y de entrega, acordados con el colegio",
      "la revisión de la unidad antes de una salida con estudiantes",
    ],
    ojo: [
      "NUNCA menciones el nombre de un colegio, de un alumno ni de un docente",
      "no afirmes nada absoluto sobre seguridad ('totalmente seguro', 'cero riesgo')",
      "no des a entender que el transporte reemplaza la supervisión del colegio",
    ],
    // El riesgo aquí no lo corre el modelo al redactar: lo corre quien sube la foto.
    avisoPantalla:
      "Revisa las fotos antes de publicar: NO pueden verse caras de menores identificables, " +
      "ni nombres de colegios, uniformes con logo o listas de alumnos. Publicar la imagen de " +
      "un menor sin autorización no es un problema de marketing.",
  },
  alquiler: {
    clave: "alquiler",
    etiqueta: "Alquiler de buses",
    icono: "🚌",
    resumen: "La unidad con conductor para un servicio puntual.",
    queEs:
      "el alquiler de una unidad con su conductor para un servicio puntual: un traslado, un " +
      "evento, una fecha concreta",
    aQuien:
      "a empresas, instituciones, organizadores de eventos y a quien tiene que mover un grupo " +
      "un día concreto. Lo que quiere es saber si hay unidad y qué tiene que decir para cotizar",
    angulos: [
      "que la unidad va CON conductor, no se entrega la llave",
      "los distintos tamaños de unidad según cuánta gente se mueve",
      "qué datos hacen falta para cotizar: fecha, ruta, cuántas personas, horario",
      "la flexibilidad del horario frente a un servicio de ruta fija",
    ],
    ojo: [
      "no des precios, tarifas ni rangos: se cotiza por servicio",
      "no afirmes disponibilidad ('tenemos unidades libres este fin de semana'): depende del día",
    ],
  },
};

export const ETIQUETA_LINEA: Record<LineaNegocio, string> = {
  personal: FICHA_LINEA.personal.etiqueta,
  turismo: FICHA_LINEA.turismo.etiqueta,
  escolar: FICHA_LINEA.escolar.etiqueta,
  alquiler: FICHA_LINEA.alquiler.etiqueta,
};

/** Lo que llegue de la base, convertido a líneas conocidas y sin repetir. */
export function lineasValidas(crudo: unknown): LineaNegocio[] {
  const lista = Array.isArray(crudo) ? crudo : [];
  const out = lista.filter((l): l is LineaNegocio => LINEAS.includes(l as LineaNegocio));
  return LINEAS.filter((l) => out.includes(l));
}

/**
 * Las líneas que esta instalación publica.
 *
 * Una lista vacía —o la columna sin migrar— cae a `personal`, que es byte a byte el
 * comportamiento anterior. **Nunca cae a las cuatro**: eso publicaría sobre negocios que
 * nadie declaró, que es exactamente el dato inventado que el módulo prohíbe.
 */
export function lineasActivas(crudo: unknown): LineaNegocio[] {
  const v = lineasValidas(crudo);
  return v.length ? v : [LINEA_DEFECTO];
}

/**
 * La línea de la que toca hablar hoy.
 *
 * ROTA POR EL DÍA DEL AÑO, NO AL AZAR — misma regla que `temaDelDia`, y por la misma
 * razón: con `random`, cuatro líneas activas producen dos y tres días seguidos de la misma
 * con toda naturalidad, y el canal se ve monotemático justo la semana que alguien lo mira.
 * Rotando, cuatro líneas dan una vuelta completa cada cuatro días.
 */
export function lineaDelDia(activas: LineaNegocio[], fecha: string): LineaNegocio {
  const lista = lineasActivas(activas);
  const t = new Date(`${fecha}T12:00:00Z`).getTime();
  if (!Number.isFinite(t)) return lista[0];
  const dias = Math.floor(t / 86_400_000);
  return lista[((dias % lista.length) + lista.length) % lista.length];
}

/**
 * El bloque que se le entrega al modelo sobre la línea del día.
 *
 * Se compone AQUÍ y no dentro del prompt por lo mismo que `describirHorario` vive en el
 * motor: el texto que describe una regla tiene que salir de la misma estructura que la
 * declara, o el día que se añade una línea el prompt sigue contando las de antes.
 */
export function bloqueLinea(linea: LineaNegocio): string {
  const f = FICHA_LINEA[linea];
  return [
    `LÍNEA DE NEGOCIO DE HOY: ${f.etiqueta.toUpperCase()}`,
    `Qué es: ${f.queEs}.`,
    `A quién le hablas: ${f.aQuien}.`,
    "",
    "De esto SÍ puedes hablar (elige UNA idea, no las enumeres):",
    ...f.angulos.map((a) => `• ${a}`),
    "",
    `CUIDADO EN ESTA LÍNEA:`,
    ...f.ojo.map((o) => `• ${o}`),
  ].join("\n");
}
