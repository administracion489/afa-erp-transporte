// ──────────────────────────────────────────────────────────────────────────────
// lib/manifiesto-nomina.ts — UNA PERSONA DE UN CLIENTE ES UNA SOLA FILA, Y ESTAR
// EN UN SERVICIO ES `pasajeros_parada`. Motor PURO: no lee la base.
//
// EL CASO (15-09, reportado por el dueño): VELIZ QUEZADA GIANFRANCO y CHAVEZ ROJAS
// CHRIS estaban "agregados a la nómina" y el manifiesto de la reserva #25525 no
// dejaba agregarlos por ninguna de las dos puertas: en «Agregar desde nómina» no
// aparecían al buscarlos, y «+ Agregar 1 pasajero» reventaba con el error crudo de
// Postgres. La pantalla, encima, remataba con la frase más engañosa posible:
// «Todos los pasajeros de la nómina ya están en este servicio».
//
// LA CAUSA ES UNA IDENTIDAD, NO UN FILTRO. `pasajeros` tiene UNA unique,
// `uq_pasajero_cliente_dni` sobre (dni, cliente_id) — SIN `reserva_id` dentro. O sea:
// para un cliente, un DNI existe en UNA fila y nada más. Y esa fila es una de dos
// cosas, nunca las dos:
//
//   · fila de NÓMINA   → `reserva_id = null`   (la persona del cliente)
//   · fila AD-HOC      → `reserva_id = <un servicio>` (la creó el manifiesto de ESE
//     servicio con «+ Agregar 1 pasajero» o «Cargar grupo»)
//
// Los dos altas del manifiesto insertaban la fila ad-hoc y ACTO SEGUIDO intentaban
// insertar su gemela de nómina con el mismo (cliente_id, dni): eso choca siempre con
// la unique. El error no se leía nunca y el contador se sumaba igual, así que el ERP
// decía «agregado al manifiesto y a la nómina ✓» sobre una fila de nómina que no
// llegó a existir. Desde ese momento la persona queda ATRAPADA en ese servicio:
//
//   · «Desde nómina» de otro servicio no la ve  → el panel pedía `reserva_id is null`
//     y la fila lleva el id del primer servicio.
//   · «+ Agregar 1 pasajero» no la deja entrar  → el INSERT choca con la unique y el
//     operador lee «duplicate key value violates unique constraint …», que para él es
//     literalmente «el sistema no me permite».
//   · «Cargar grupo» con esa persona en el archivo tumba el lote entero, por lo mismo.
//
// POR ESO NO SE DUPLICA LA FILA: SE REUTILIZA. Meter a alguien en un servicio es
// insertar en `pasajeros_parada`, que es lo que ya hacía —y documentaba— el botón
// «+ Agregar» del panel de nómina. Este módulo lleva esa misma regla a los otros dos
// caminos para que los tres contesten igual a «¿quién es esta persona?».
//
// Y EL MOTIVO SE DECLARA, NO SE OLFATEA. El panel ofrecía una lista y escondía en
// silencio todo lo que no cuadraba, así que «no está» significaba cinco cosas
// distintas con cinco arreglos distintos. Cada candidato sale ahora con su código y
// cada vacío nombra su causa: lo que no se puede ofrecer se VE, con el porqué al lado.
// ──────────────────────────────────────────────────────────────────────────────

/** Una fila de `pasajeros` del cliente del servicio. `reserva_id` es lo que decide si es nómina o ad-hoc. */
export type PersonaCliente = {
  id: number;
  nombre: string;
  dni: string | null;
  empresa: string | null;
  telefono: string | null;
  reserva_id: number | null;
};

/** Lo mínimo que hace falta saber de quien YA está en el manifiesto que se está editando. */
export type EnManifiesto = { id: number; nombre: string; dni: string | null };

export type CodigoCandidato =
  /** Fila de nómina libre: el caso normal, se agrega con un clic. */
  | "en_nomina"
  /** Su ficha la ocupa OTRO servicio (fila ad-hoc). Se agrega igual, sin duplicarla. */
  | "en_otro_servicio"
  /** Ya viaja en este servicio: no hay nada que hacer. */
  | "ya_en_este_servicio"
  /** Otra persona del manifiesto lleva su mismo DNI: hay un dato mal escrito. */
  | "dni_ocupado_por_otro";

export type Candidato = {
  persona: PersonaCliente;
  codigo: CodigoCandidato;
  /** true ⇔ el botón «+ Agregar» tiene sentido. Deriva del código, no se declara aparte. */
  ofrecible: boolean;
  /** Qué pasa y, cuando no se puede, dónde se arregla. */
  detalle: string;
};

/** Clave de comparación de texto: sin acentos, sin mayúsculas, sin espacios de más. NUNCA se persiste. */
export function claveTexto(raw?: string | null): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Clave de un DNI: solo se le quitan los espacios. Un DNI vacío NO es una identidad. */
export function claveDni(raw?: string | null): string {
  return (raw ?? "").trim();
}

/**
 * Clasifica el padrón COMPLETO del cliente (nómina + fichas tomadas por otros servicios)
 * contra el manifiesto que se está editando. `ofrecibles` y `observados` son DISJUNTOS y
 * EXHAUSTIVOS: una persona del padrón que no saliera en ninguno de los dos sería una
 * persona que la pantalla no explica en ningún sitio, que es el defecto que se arregla.
 */
export function clasificarPadron(
  padron: PersonaCliente[],
  enManifiesto: EnManifiesto[],
  reservaId: number,
): { ofrecibles: Candidato[]; observados: Candidato[]; todos: Candidato[] } {
  const idsAqui = new Set(enManifiesto.map((p) => p.id));
  // Primer ocupante de cada DNI: con quién choca el que no se puede ofrecer.
  const porDni = new Map<string, EnManifiesto>();
  for (const p of enManifiesto) {
    const d = claveDni(p.dni);
    if (d && !porDni.has(d)) porDni.set(d, p);
  }

  const todos: Candidato[] = padron.map((persona) => {
    const dni = claveDni(persona.dni);
    const choque = dni ? porDni.get(dni) : undefined;

    if (idsAqui.has(persona.id) || persona.reserva_id === reservaId) {
      return {
        persona, codigo: "ya_en_este_servicio", ofrecible: false,
        detalle: "Ya viaja en este servicio.",
      };
    }
    if (choque && choque.id !== persona.id) {
      return {
        persona, codigo: "dni_ocupado_por_otro", ofrecible: false,
        detalle: `El DNI ${dni} ya está en este manifiesto a nombre de ${choque.nombre}. `
               + "Uno de los dos está mal escrito: corrígelo en la ficha del pasajero.",
      };
    }
    if (persona.reserva_id == null) {
      return { persona, codigo: "en_nomina", ofrecible: true, detalle: "En la nómina del cliente." };
    }
    return {
      persona, codigo: "en_otro_servicio", ofrecible: true,
      detalle: `Su ficha la ocupa el servicio #${persona.reserva_id}. Se agrega a este sin duplicarla.`,
    };
  });

  return {
    ofrecibles: todos.filter((c) => c.ofrecible),
    observados: todos.filter((c) => !c.ofrecible),
    todos,
  };
}

/** Filtra por nombre, DNI o empresa. Acento-insensible: "chavez" tiene que encontrar a "CHÁVEZ". */
export function filtrarCandidatos(cands: Candidato[], busqueda: string): Candidato[] {
  const q = claveTexto(busqueda);
  if (q === "") return cands;
  return cands.filter((c) =>
    claveTexto(c.persona.nombre).includes(q) ||
    claveTexto(c.persona.dni).includes(q) ||
    claveTexto(c.persona.empresa).includes(q),
  );
}

export type CodigoVacio =
  | "sin_cliente"       // el servicio no tiene cliente: no hay padrón que mirar
  | "padron_vacio"      // el cliente no tiene ni una persona registrada
  | "sin_coincidencias" // LA FRASE QUE MENTÍA: no hay match para lo que se tecleó
  | "todos_en_servicio";

/**
 * Por qué el panel no muestra a nadie. Sin esto, un padrón cargado y una búsqueda sin
 * resultados se anunciaban como «todos ya están en este servicio» — que es la
 * afirmación que hizo al dueño concluir que el ERP no le dejaba agregarlos.
 */
export function motivoPanelVacio(args: {
  hayCliente: boolean;
  padron: number;
  busqueda: string;
}): { codigo: CodigoVacio; texto: string } {
  const q = args.busqueda.trim();
  if (!args.hayCliente) {
    return { codigo: "sin_cliente", texto: "Este servicio no tiene cliente asignado, así que no hay nómina que ofrecer." };
  }
  if (args.padron === 0) {
    return { codigo: "padron_vacio", texto: "La nómina de este cliente está vacía. Cárgala en Clientes → Nómina, o usa «+ Agregar 1 pasajero»." };
  }
  if (q !== "") {
    return {
      codigo: "sin_coincidencias",
      texto: `Ningún pasajero del cliente coincide con «${q}» (se buscó en los ${args.padron} de su nómina, por nombre, DNI y empresa). `
           + "Si es alguien nuevo, dalo de alta con «+ Agregar 1 pasajero».",
    };
  }
  return { codigo: "todos_en_servicio", texto: "Todos los pasajeros de la nómina ya están en este servicio." };
}

export type CodigoAlta =
  /** No existe ficha con ese DNI en el cliente: se INSERTA. */
  | "crear"
  /** Ya existe (nómina o ad-hoc de otro servicio): se REUTILIZA, jamás se vuelve a insertar. */
  | "reusar"
  | "ya_en_este_servicio"
  | "dni_ocupado_por_otro";

export type PlanAlta = {
  codigo: CodigoAlta;
  /** false ⇒ no se escribe nada y se explica por qué. */
  puede: boolean;
  /** Fila a reutilizar. null en "crear". */
  pasajeroId: number | null;
  aviso: string;
};

/**
 * Qué hacer al dar de alta a alguien por «+ Agregar 1 pasajero» o «Cargar grupo».
 *
 * LO QUE IMPIDE: insertar una segunda fila con el mismo (cliente_id, dni). Eso es lo que
 * chocaba contra `uq_pasajero_cliente_dni` y dejaba al operador leyendo un error de
 * Postgres. Con ficha existente la persona ya está creada: lo único que falta es
 * subirla a este servicio, y eso es `pasajeros_parada`.
 */
export function planDeAlta(args: {
  dni: string;
  nombre: string;
  /** La fila de (cliente_id, dni) si el cliente ya la tiene. */
  existente: PersonaCliente | null;
  enManifiesto: EnManifiesto[];
  reservaId: number;
}): PlanAlta {
  const dni = claveDni(args.dni);
  const { existente, enManifiesto, reservaId } = args;

  const aqui = enManifiesto.find((p) => claveDni(p.dni) === dni && dni !== "");
  const existenteAqui = existente != null
    && (enManifiesto.some((p) => p.id === existente.id) || existente.reserva_id === reservaId);

  if (existenteAqui || (aqui && existente && aqui.id === existente.id)) {
    return {
      codigo: "ya_en_este_servicio", puede: false, pasajeroId: existente!.id,
      aviso: `${existente!.nombre} ya está en este manifiesto.`,
    };
  }
  if (aqui && (!existente || aqui.id !== existente.id)) {
    return {
      codigo: "dni_ocupado_por_otro", puede: false, pasajeroId: null,
      aviso: `El DNI ${dni} ya está en este manifiesto a nombre de ${aqui.nombre}. `
           + "Revisa cuál de los dos números está mal antes de volver a intentarlo.",
    };
  }
  if (existente) {
    return {
      codigo: "reusar", puede: true, pasajeroId: existente.id,
      aviso: existente.reserva_id == null
        ? `${existente.nombre} ya estaba en la nómina del cliente: se usa su ficha, no se duplica.`
        : `${existente.nombre} ya tenía ficha (la ocupa el servicio #${existente.reserva_id}): se agrega a este sin duplicarla.`,
    };
  }
  return { codigo: "crear", puede: true, pasajeroId: null, aviso: "" };
}
