// lib/autorizacion-transporte.ts — ¿HASTA DÓNDE puede llegar legalmente este transportista?
// Módulo PURO: sin React, sin DOM, sin BD. Misma doctrina que lib/costeo-propio.ts y
// lib/radar/coherencia-voucher.ts — recibe datos, devuelve veredicto.
//
// ══════════════════════════════════════════════════════════════════════════════
// EL PROBLEMA: EL ERP PEDÍA DOS AUTORIZACIONES Y NINGÚN TRANSPORTISTA TIENE DOS
//
// La ficha de la empresa tercerizada pedía "N° Autorización MTC" y "N° Habilitación
// SUTRAN" como si todo operador tuviera las dos. No es así: **una empresa tiene UNA
// autorización, la da UNA autoridad, y esa autoridad decide HASTA DÓNDE puede circular.**
// Quien opera con autorización de la ATU no tiene número de MTC, así que dejaba el campo
// vacío — y el campo vacío se leía como "le falta un papel" en vez de "no le corresponde".
// SUTRAN, además, no autoriza: FISCALIZA. Pedirle su número a todo el mundo era pedir un
// dato que para la mayoría no existe.
//
// Peor: al no guardarse QUIÉN autorizó, el ERP no podía avisar de lo único que de verdad
// importa el día que se asigna un servicio — que el viaje se sale del ámbito autorizado.
// Un operador con autorización de ATU (Lima y Callao) que hace un paseo a Ica está prestando
// un servicio sin autorización, y la responsabilidad no se queda en el tercero: el cliente
// contrató a AFA.
//
// ══════════════════════════════════════════════════════════════════════════════
// EL MARCO (Ley 27181 · RNAT D.S. 017-2009-MTC · Ley 30900)
//
//   · MTC                       → ámbito NACIONAL     (recorridos que cruzan regiones)
//   · Gobierno Regional         → ámbito REGIONAL     (entre provincias de ESA región)
//   · ATU                       → ámbito PROVINCIAL, y solo el de Lima Metropolitana +
//                                 Provincia Constitucional del Callao (Ley 30900; antes lo
//                                 daban las municipalidades de Lima y Callao)
//   · Municipalidad Provincial  → ámbito PROVINCIAL   (dentro de ESA provincia)
//
// TRES REGLAS QUE SALEN DE AHÍ Y QUE ESTE MÓDULO IMPLEMENTA:
//
//   1. EL ÁMBITO MAYOR CUBRE AL MENOR, y no al revés. La autorización de ámbito nacional
//      para transporte de personas habilita a prestar el servicio de trabajadores en los
//      ámbitos nacional, regional y provincial. Por eso `cubreAmbito` compara RANGOS y no
//      igualdad: exigir coincidencia exacta habría bloqueado al operador nacional para un
//      servicio dentro de Lima, que sí puede hacer.
//   2. EL ÁMBITO MENOR ESTÁ ATADO A SU TERRITORIO. Una autorización regional vale en SU
//      región y una provincial en SU provincia: por eso `autoridad_emisor` no es adorno —
//      sin saber cuál, "regional" no dice nada. Es la diferencia entre "puede ir a Ica" y
//      "no puede salir de Lima".
//   3. UN VIAJE, UN ÁMBITO. El RNAT prohíbe destinar un vehículo a ámbitos territoriales
//      distintos en el mismo viaje, así que el ámbito del servicio es uno solo y se puede
//      comparar contra la autorización.
//
// LO QUE ESTE MÓDULO NO HACE: no bloquea nada por sí mismo y no adivina el ámbito de un
// servicio a partir del nombre de la ruta. Devuelve un veredicto; quién lo pinta y quién
// impide asignar se decide fuera. Misma línea que lib/documentos-estado.ts.

// ══════════════════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════════════════

/** Quién firma la autorización. Es el dato que se guarda; el ámbito se DERIVA de él. */
export type Autoridad = "mtc" | "atu" | "regional" | "provincial";

/** Alcance territorial. Ordenado de mayor a menor cobertura. */
export type Ambito = "nacional" | "regional" | "provincial";

export type ConfigAutoridad = {
  clave: Autoridad;
  /** Nombre corto para el chip: "MTC", "ATU", "GORE", "Municipalidad" */
  corto: string;
  /** Etiqueta del desplegable */
  label: string;
  ambito: Ambito;
  /**
   * ¿Hay que decir QUÉ gobierno regional o QUÉ municipalidad? La ATU no: es siempre Lima
   * Metropolitana y el Callao, y ofrecer un campo para escribirlo solo invita a escribirlo
   * mal. El MTC tampoco: es nacional por definición.
   */
  pideEmisor: boolean;
  /** Cómo se llama lo que hay que escribir en `autoridad_emisor` */
  etiquetaEmisor?: string;
  /** Una línea, en el idioma del operador, sobre hasta dónde puede ir */
  alcance: string;
};

export const AUTORIDADES: ConfigAutoridad[] = [
  {
    clave: "mtc", corto: "MTC", label: "MTC — autorización de ámbito nacional",
    ambito: "nacional", pideEmisor: false,
    alcance: "Puede prestar servicio en todo el país, incluidos los recorridos que cruzan de una región a otra.",
  },
  {
    clave: "regional", corto: "GORE", label: "Gobierno Regional — ámbito regional",
    ambito: "regional", pideEmisor: true, etiquetaEmisor: "Gobierno Regional que autoriza",
    alcance: "Puede prestar servicio DENTRO de su región, entre las provincias de esa región. Un viaje que cruce a otra región necesita autorización nacional del MTC.",
  },
  {
    clave: "atu", corto: "ATU", label: "ATU — Lima Metropolitana y Callao",
    ambito: "provincial", pideEmisor: false,
    alcance: "Puede prestar servicio DENTRO de Lima Metropolitana y la Provincia Constitucional del Callao. Salir de Lima y Callao —a Ica, Cañete, Huaral o cualquier otra provincia— requiere otra autorización.",
  },
  {
    clave: "provincial", corto: "Municipalidad", label: "Municipalidad Provincial — ámbito provincial",
    ambito: "provincial", pideEmisor: true, etiquetaEmisor: "Municipalidad Provincial que autoriza",
    alcance: "Puede prestar servicio DENTRO de esa provincia. Cualquier viaje que salga de ella requiere autorización regional o nacional.",
  },
];

const POR_CLAVE = new Map(AUTORIDADES.map((a) => [a.clave, a]));

export function configAutoridad(a: Autoridad | null | undefined): ConfigAutoridad | null {
  return a ? POR_CLAVE.get(a) ?? null : null;
}

/** El ámbito se DERIVA de la autoridad; NO se guarda. Regla de oro de la casa: un dato,
 *  una fila autoritativa. Guardarlo abriría la puerta a un "ATU · nacional" imposible. */
export function ambitoDeAutoridad(a: Autoridad | null | undefined): Ambito | null {
  return configAutoridad(a)?.ambito ?? null;
}

/** Los 25 gobiernos regionales (24 departamentos + la Provincia Constitucional del Callao). */
export const REGIONES_PERU = [
  "Amazonas", "Áncash", "Apurímac", "Arequipa", "Ayacucho", "Cajamarca", "Callao", "Cusco",
  "Huancavelica", "Huánuco", "Ica", "Junín", "La Libertad", "Lambayeque", "Lima", "Loreto",
  "Madre de Dios", "Moquegua", "Pasco", "Piura", "Puno", "San Martín", "Tacna", "Tumbes",
  "Ucayali",
];

// ══════════════════════════════════════════════════════════════════════════════
// LA AUTORIZACIÓN DE UNA EMPRESA
// ══════════════════════════════════════════════════════════════════════════════

export type AutorizacionEmpresa = {
  autoridad?: Autoridad | null;
  /** Gobierno regional o municipalidad provincial. Vacío para MTC y ATU. */
  emisor?: string | null;
  numero?: string | null;
  vencimiento?: string | null;
};

/** Territorio concreto que cubre la autorización, ya resuelto con su emisor.
 *  Para la ATU el territorio es fijo por ley y no depende de ningún campo. */
export function territorioDe(a: AutorizacionEmpresa): string | null {
  const cfg = configAutoridad(a.autoridad);
  if (!cfg) return null;
  if (cfg.clave === "mtc") return "Todo el país";
  if (cfg.clave === "atu") return "Lima Metropolitana y Callao";
  const emisor = (a.emisor || "").trim();
  if (!emisor) return null;   // sin emisor no se puede afirmar nada: ver `avisosAutorizacion`
  return cfg.clave === "regional" ? `Región ${emisor}` : `Provincia de ${emisor}`;
}

/** "ATU · Lima Metropolitana y Callao" — el rótulo del chip y del PDF. */
export function etiquetaAutorizacion(a: AutorizacionEmpresa): string | null {
  const cfg = configAutoridad(a.autoridad);
  if (!cfg) return null;
  const t = territorioDe(a);
  return t ? `${cfg.corto} · ${t}` : `${cfg.corto} · ámbito ${cfg.ambito} (falta indicar cuál)`;
}

// ── COBERTURA ─────────────────────────────────────────────────────────────────

const RANGO: Record<Ambito, number> = { nacional: 3, regional: 2, provincial: 1 };

/**
 * ¿La autorización de ámbito `tiene` cubre un servicio de ámbito `necesita`?
 *
 * Comparación por RANGO, no por igualdad: la autorización nacional habilita el servicio de
 * trabajadores en los tres ámbitos, así que exigir coincidencia exacta habría dejado fuera
 * al operador nacional para un servicio dentro de Lima — que sí puede hacer, y bloquearlo
 * habría enseñado a saltarse el aviso.
 */
export function cubreAmbito(tiene: Ambito | null | undefined, necesita: Ambito): boolean {
  if (!tiene) return false;
  return RANGO[tiene] >= RANGO[necesita];
}

export type VeredictoAlcance = {
  /** false = el servicio se sale de lo autorizado, con lo que se sabe */
  permitido: boolean;
  /** true = falta un dato para poder afirmarlo; NUNCA se resuelve inventando */
  indeterminado: boolean;
  /** una frase para el operador */
  texto: string;
};

/**
 * ¿Puede esta empresa prestar un servicio en tal territorio?
 *
 * `regionServicio` / `provinciaServicio` son de dónde a dónde va el viaje, ya resueltos por
 * quien llama (este módulo no adivina geografía). Si el llamador no los sabe, se responde
 * INDETERMINADO y se dice qué falta: un "permitido" inventado es peor que un "no sé", porque
 * el despachador deja de mirar.
 */
export function verificarAlcance(
  a: AutorizacionEmpresa,
  destino: { region?: string | null; provincia?: string | null },
): VeredictoAlcance {
  const cfg = configAutoridad(a.autoridad);
  if (!cfg) {
    return { permitido: false, indeterminado: true,
             texto: "No consta quién autorizó a este proveedor: no se puede saber hasta dónde puede llegar." };
  }
  if (cfg.clave === "mtc") {
    return { permitido: true, indeterminado: false,
             texto: "Autorización nacional del MTC: cubre cualquier destino del país." };
  }

  const norm = (s: string | null | undefined) =>
    (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  if (cfg.clave === "atu") {
    // Territorio fijo por ley: Lima Metropolitana + Provincia Constitucional del Callao.
    const p = norm(destino.provincia), r = norm(destino.region);
    if (!p && !r) {
      return { permitido: false, indeterminado: true,
               texto: "Autorización de la ATU (Lima y Callao): falta saber a qué provincia va el servicio." };
    }
    const dentro = ["lima", "callao"].includes(p) || (!p && ["lima", "callao"].includes(r));
    return dentro
      ? { permitido: true, indeterminado: false, texto: "Dentro de Lima y Callao: cubierto por la autorización de la ATU." }
      : { permitido: false, indeterminado: false,
          texto: `La autorización de la ATU solo cubre Lima Metropolitana y Callao; este servicio va a ${destino.provincia || destino.region}.` };
  }

  const emisor = norm(a.emisor);
  if (!emisor) {
    return { permitido: false, indeterminado: true,
             texto: `Consta autorización de ámbito ${cfg.ambito} pero no de qué ${cfg.clave === "regional" ? "región" : "provincia"}: no se puede verificar el destino.` };
  }
  const contra = cfg.clave === "regional" ? norm(destino.region) : norm(destino.provincia);
  if (!contra) {
    return { permitido: false, indeterminado: true,
             texto: `Autorización de ámbito ${cfg.ambito} (${a.emisor}): falta saber la ${cfg.clave === "regional" ? "región" : "provincia"} del servicio.` };
  }
  return contra === emisor
    ? { permitido: true, indeterminado: false, texto: `Dentro de ${a.emisor}: cubierto por la autorización de ámbito ${cfg.ambito}.` }
    : { permitido: false, indeterminado: false,
        texto: `La autorización es de ámbito ${cfg.ambito} y solo cubre ${a.emisor}; este servicio va a ${cfg.clave === "regional" ? destino.region : destino.provincia}.` };
}

// ── AVISOS DE LA FICHA ────────────────────────────────────────────────────────

export type AvisoAutorizacion = { codigo: string; nivel: "alto" | "medio"; texto: string };

/**
 * Lo que le falta o le sobra a la ficha de la empresa. Se enruta por CÓDIGO y no por el
 * texto (misma disciplina que `bloqueosDe` en la liquidación): la pantalla decide el color
 * y el botón mirando el código, no olfateando la frase.
 */
export function avisosAutorizacion(a: AutorizacionEmpresa): AvisoAutorizacion[] {
  const out: AvisoAutorizacion[] = [];
  const cfg = configAutoridad(a.autoridad);
  if (!cfg) {
    out.push({ codigo: "sin_autoridad", nivel: "medio",
               texto: "Falta indicar qué autoridad autorizó a esta empresa (MTC, ATU, Gobierno Regional o Municipalidad Provincial). Sin eso no se puede saber hasta dónde puede llegar." });
    return out;
  }
  if (cfg.pideEmisor && !(a.emisor || "").trim()) {
    out.push({ codigo: "sin_emisor", nivel: "medio",
               texto: `Falta indicar ${cfg.etiquetaEmisor?.toLowerCase() ?? "el emisor"}: una autorización de ámbito ${cfg.ambito} solo vale en su propio territorio, así que sin ese dato no se puede verificar ningún destino.` });
  }
  if (!(a.numero || "").trim()) {
    out.push({ codigo: "sin_numero", nivel: "medio",
               texto: "Falta el número de la resolución que autoriza a la empresa." });
  }
  if (!a.vencimiento) {
    out.push({ codigo: "sin_vencimiento", nivel: "medio",
               texto: "La autorización no tiene fecha de vencimiento cargada: el ERP no puede avisar cuando esté por caducar." });
  }
  return out;
}
