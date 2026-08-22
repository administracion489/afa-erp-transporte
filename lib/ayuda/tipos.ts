// ──────────────────────────────────────────────────────────────────────────────
// lib/ayuda/tipos.ts — Contrato del sistema de ayuda contextual del ERP.
//
// La idea: cada pantalla tiene un panel "?" que explica QUÉ es, PARA QUÉ sirve, los
// CONCEPTOS contables que aparecen ahí y las PREGUNTAS que la gente hace de verdad.
//
// Regla de una sola fuente: un término contable ("detracción", "IGV", "devengado") se
// define UNA vez en el glosario y los módulos lo referencian por clave. Así "detracción"
// dice lo mismo en Cuentas por Pagar, en Facturación y en Contabilidad, y se corrige en
// un solo sitio cuando cambia la norma.
// ──────────────────────────────────────────────────────────────────────────────

/** Un término del glosario: se define una vez y lo referencian N módulos. */
export type Concepto = {
  /** Clave estable, en minúscula y sin tildes: "detraccion", "credito_fiscal". */
  clave: string;
  /** Cómo se escribe de cara al usuario: "Detracción (SPOT)". */
  termino: string;
  /** Explicación en castellano llano, sin jerga. Dos o tres frases. */
  definicion: string;
  /** Un ejemplo con números de AFA. Es lo que más ayuda a entenderlo. */
  ejemplo?: string;
  /** Errores típicos o confusiones frecuentes con este término. */
  ojo?: string;
  /** Otros términos que conviene leer junto a este. */
  verTambien?: string[];
};

/** Una pregunta frecuente. */
export type Faq = {
  pregunta: string;
  /** Respuesta directa. Se permite markdown mínimo: **negrita** y saltos de línea. */
  respuesta: string;
};

/** Un procedimiento paso a paso. */
export type ComoHacer = {
  titulo: string;
  pasos: string[];
  /** Advertencia que aparece al pie del procedimiento. */
  advertencia?: string;
};

/** La ayuda de una pantalla (o de un grupo de pantallas hermanas). */
export type AyudaModulo = {
  /** Clave estable del módulo: "tesoreria", "caja-chica". */
  clave: string;
  /**
   * Rutas que abren esta ayuda. Se resuelve por prefijo, así que "/crm" cubre
   * "/crm/pipeline" salvo que exista una entrada más específica, que siempre gana.
   */
  rutas: string[];
  titulo: string;
  /** Una o dos frases: qué es esta pantalla y para quién. */
  resumen: string;
  /** Para qué sirve, en viñetas cortas. */
  paraQueSirve: string[];
  /** Claves del glosario relevantes aquí, en el orden en que conviene leerlas. */
  conceptos?: string[];
  faqs: Faq[];
  comoHacer?: ComoHacer[];
  /** Enlaces a otras pantallas del ERP relacionadas. */
  relacionadas?: { etiqueta: string; href: string }[];
};
