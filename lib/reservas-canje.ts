// ────────────────────────────────────────────────────────────────────────────
// reservas-canje.ts — El CANJE de origen: dos servicios que se intercambian el
// lado del contrato.
//
// EL CASO QUE RESUELVE
//
// Un día sale la ruta contratada y, además, un adicional que el cliente pidió
// aparte. Por una contingencia (avería, sobrecupo, un chofer que no llegó) las
// unidades se intercambian: la que iba al adicional cubre el servicio del
// contrato y viceversa. Cuando eso se registra, la etiqueta `origen_contractual`
// queda puesta en el servicio equivocado.
//
// La corrección NO es unilateral. Marcar uno solo como adicional mueve un día
// entero del subtotal del contrato al de adicionales, porque `origenDelPar`
// (lib/liquidacion-agrupacion.ts) CONTAGIA el origen al par completo: basta con
// que un tramo esté marcado para que el día se cobre como adicional. Es decir,
// el arrastre del hermano que hace Programación no es una molestia que se pueda
// saltar — es lo que mantiene la pantalla diciendo lo mismo que el AFA-FL-07.
//
// Lo que de verdad pasó es un INTERCAMBIO: uno pasa a adicional y el otro vuelve
// a contrato, en el mismo acto. Así la cantidad de días contratados y la de
// adicionales no cambian, y el neto sobre la valorización es cero — que es la
// única forma de corregir una etiqueta sin mover dinero sin querer.
//
// Este módulo NO lee la base ni escribe nada: recibe los dos lados ya resueltos
// (cada uno con sus tramos hermanos) y devuelve el plan con sus avisos, para que
// la pantalla pueda mostrar la consecuencia ANTES de aplicarla. Mismo criterio
// que lib/costeo-propio.ts: quien tiene acceso a los datos los resuelve; aquí
// solo se decide.
// ────────────────────────────────────────────────────────────────────────────

/** Lo mínimo que hace falta de cada tramo. Compatible con `Reserva` de Programación. */
export type FilaCanje = {
  id: number;
  codigo?: string | null;
  precio_cliente?: number | null;
  fecha_servicio?: string | null;
  hora_servicio?: string | null;
  origen_contractual?: string | null;
};

export type DestinoOrigen = "adicional" | "contrato";

export type LadoCanje = {
  ids: number[];
  codigos: string[];
  /**
   * Lo que ese lado factura el día. Es la SUMA de los tramos, no el precio de la
   * cabeza: en un par normal la tarifa va entera en un tramo y el otro va en 0,
   * así que sumar da el importe del día sin tener que decidir cuál es la cabeza.
   */
  importe: number;
  destino: DestinoOrigen;
};

export type PlanCanje = {
  /** El lado que el operador estaba marcando. */
  a: LadoCanje;
  /** La contraparte elegida, que se va al lado opuesto. */
  b: LadoCanje;
  /** Cuánto sube (+) o baja (−) el subtotal "Adicionales autorizados" del formato. */
  netoAdicionales: number;
  /** Ids presentes en los dos lados. Con uno solo el canje es inaplicable. */
  solapados: number[];
  /** Se puede aplicar: hay dos lados y no comparten tramos. */
  aplicable: boolean;
  /** Lo que la pantalla tiene que decir antes de aplicar. Nunca bloquean salvo el solape. */
  avisos: string[];
};

export const opuesto = (d: DestinoOrigen): DestinoOrigen =>
  d === "adicional" ? "contrato" : "adicional";

const redondear = (n: number) => Math.round(n * 100) / 100;

const soles = (n: number) =>
  "S/ " + n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const rotulo = (f: FilaCanje) => f.codigo ?? `#${f.id}`;

const lado = (filas: FilaCanje[], destino: DestinoOrigen): LadoCanje => ({
  ids: filas.map((f) => f.id),
  codigos: filas.map(rotulo),
  importe: redondear(filas.reduce((s, f) => s + Number(f.precio_cliente ?? 0), 0)),
  destino,
});

/**
 * Arma el plan del canje y sus avisos.
 *
 * `destinoA` es a dónde va el lado que el operador estaba marcando; la contraparte
 * siempre va al opuesto. Los dos lados llegan YA expandidos con sus hermanos: partir
 * un par por la mitad es justamente lo que el canje evita.
 */
export function planDeCanje(
  filasA: FilaCanje[],
  filasB: FilaCanje[],
  destinoA: DestinoOrigen
): PlanCanje {
  const a = lado(filasA, destinoA);
  const b = lado(filasB, opuesto(destinoA));

  const enB = new Set(b.ids);
  const solapados = a.ids.filter((id) => enB.has(id));

  // El lado que se vuelve adicional suma al subtotal; el que vuelve a contrato lo
  // deja. Si los dos importes son iguales —lo normal cuando se cobró la misma
  // tarifa— el neto es cero y el canje solo corrige la etiqueta.
  const haciaAdicional = a.destino === "adicional" ? a : b;
  const haciaContrato = a.destino === "adicional" ? b : a;
  const netoAdicionales = redondear(haciaAdicional.importe - haciaContrato.importe);

  const avisos: string[] = [];

  if (solapados.length) {
    // Comparten tramo = son el mismo día. No hay nada que intercambiar, y aplicarlo
    // escribiría dos valores opuestos sobre la misma fila.
    avisos.push(
      `Los dos lados comparten ${solapados.length} servicio(s): son el mismo día, no un intercambio.`
    );
  }

  if (!filasA.length || !filasB.length) {
    avisos.push("Falta elegir la contraparte del intercambio.");
  }

  if (filasA.length && filasB.length && filasA.length !== filasB.length) {
    // Un día completo (ida + retorno) contra una salida suelta. Se puede hacer, pero
    // el operador tiene que saber que no está cambiando manzanas por manzanas.
    avisos.push(
      `El intercambio no es simétrico: ${filasA.length} tramo(s) de un lado contra ${filasB.length} del otro.`
    );
  }

  if (filasA.length && filasB.length) {
    if (haciaAdicional.importe === 0 || haciaContrato.importe === 0) {
      // Con un lado en cero el canje mueve toda la tarifa a una sola categoría. Casi
      // siempre significa que la tarifa quedó en un tramo que no entró a este lado.
      avisos.push(
        "Uno de los dos lados va en S/ 0.00: revisa en qué tramo quedó la tarifa antes de aplicar."
      );
    }
    if (netoAdicionales !== 0) {
      avisos.push(
        `El subtotal de adicionales ${netoAdicionales > 0 ? "sube" : "baja"} ${soles(
          Math.abs(netoAdicionales)
        )} (${soles(haciaAdicional.importe)} entran, ${soles(haciaContrato.importe)} salen).`
      );
    }
  }

  return {
    a,
    b,
    netoAdicionales,
    solapados,
    aplicable: filasA.length > 0 && filasB.length > 0 && solapados.length === 0,
    avisos,
  };
}

/**
 * La nota que se escribe en el lado que queda como ADICIONAL.
 *
 * El lado que vuelve a contrato limpia `adicional_motivo` y `adicional_nota` —esa es
 * la regla que ya tenía Programación: describían un adicional que dejó de existir y
 * `v_adicionales` ni siquiera lo publica—, así que el ÚNICO sitio donde queda escrito
 * el canje es esta nota. Por eso nombra a la contraparte por su código: es lo que
 * permite reconstruir el intercambio meses después.
 */
export function notaDeCanje(nota: string, codigosContraparte: string[]): string {
  const canje = codigosContraparte.length
    ? `Canje de origen con ${codigosContraparte.join(", ")}`
    : "Canje de origen";
  const texto = nota.trim();
  return texto ? `${texto} · ${canje}` : canje;
}
