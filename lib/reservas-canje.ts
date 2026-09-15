// ────────────────────────────────────────────────────────────────────────────
// reservas-canje.ts — Mover el origen contractual sin mover dinero sin querer:
// el CANJE entre dos servicios y el TRAMO SUELTO dentro de un par.
//
// EL CASO QUE RESUELVE
//
// Un día sale la ruta contratada y, además, un adicional que el cliente pidió
// aparte. Por una contingencia (avería, sobrecupo, un chofer que no llegó) las
// unidades se intercambian: la que iba al adicional cubre el servicio del
// contrato y viceversa. Cuando eso se registra, la etiqueta `origen_contractual`
// queda puesta en el servicio equivocado.
//
// Lo que de verdad pasó es un INTERCAMBIO: uno pasa a adicional y el otro vuelve
// a contrato, en el mismo acto. Así la cantidad de días contratados y la de
// adicionales no cambian, y el neto sobre la valorización es cero — que es la
// única forma de corregir una etiqueta sin mover dinero sin querer.
//
// EL TRAMO SUELTO
//
// Por defecto el cambio arrastra al hermano, porque la unidad que se cobra es el
// DÍA (ida + retorno = una tarifa). Pero a veces lo que cambió de manos es UN
// tramo —el retorno que cubrió la otra unidad—, y marcar el día entero diría más
// de lo que pasó. Eso ahora se puede: `origenDelPar` dejó de contagiar y el
// origen lo declara el tramo que LLEVA EL IMPORTE.
//
// La consecuencia hay que enseñarla antes, no descubrirla en la valorización, y
// de eso se encarga `efectoDeMarcarTramo`: marcar el tramo que lleva la tarifa
// mueve el día de subtotal; marcar el que va en S/ 0.00 deja la valorización
// intacta y queda como registro de ese tramo. Ninguna de las dos está mal — lo
// que está mal es no saber cuál de las dos se está haciendo.
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
   * Lo que ese lado pone en juego. Es la SUMA de sus tramos, no el precio de la
   * cabeza: en un par normal la tarifa va entera en un tramo y el otro va en 0, así
   * que sumar da el importe del día sin tener que decidir cuál es la cabeza. Con el
   * lado recortado a UN tramo (ver más abajo) el importe es el de ese tramo, que
   * puede ser S/ 0.00 — y entonces `avisos` lo dice.
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
 * siempre va al OPUESTO — ese es todo el canje. Ojo con el otro extremo del hilo: lo
 * que la pantalla BUSCA como contraparte tiene que ser lo que hoy lleva `destinoA`
 * (la etiqueta que este lado va a tomar). Buscarla por el origen contrario ofrece
 * filas a las que luego se les escribe el valor que ya tenían, y entonces el canje
 * mueve un solo lado sin intercambiar nada.
 *
 * Cada lado llega con los tramos que el operador decidió mover: normalmente el día
 * completo (ida + retorno, que es la unidad que se cobra), o un solo tramo cuando
 * está encendido "Cambiar solo el tramo marcado". Los avisos cubren las dos formas,
 * incluida la asimetría de 2 tramos contra 1.
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
      // Con un lado en S/ 0.00 no hay tarifa que reclasificar de ese lado: quien
      // clasifica el día es el tramo que lleva el importe, y ese quedó fuera.
      avisos.push(
        "Uno de los dos lados va en S/ 0.00: ahí no hay tarifa que reclasificar, así que " +
          "ese lado queda solo como registro. Revisa que la tarifa esté donde esperas."
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

export type EfectoTramo = {
  /**
   * El tramo que clasifica el día. null cuando no hay UNO solo: ni cuando ningún
   * tramo lleva tarifa, ni cuando la llevan los dos (ahí ya son dos servicios
   * independientes y cada uno se clasifica a sí mismo).
   */
  portador: FilaCanje | null;
  /** La tarifa del día: la suma de los tramos, porque el otro normalmente va en 0. */
  importe: number;
  /** Lo marcado cambia de subtotal algún importe. */
  mueveValorizacion: boolean;
  /** Qué va a pasar, en la frase que se le enseña al operador ANTES de aplicar. */
  aviso: string;
};

/**
 * Qué le pasa a la valorización si se marca SOLO una parte de un par.
 *
 * Como el origen del día lo declara el tramo que lleva el importe (ver
 * `origenDelPar`), marcar un tramo tiene efectos radicalmente distintos que desde la
 * pantalla no se distinguen si nadie los dice:
 *
 *   · se marca el tramo que lleva la tarifa  → el día entero cambia de subtotal;
 *   · se marca el tramo que va en S/ 0.00    → la valorización no se mueve, y la
 *     marca queda como registro de que ESE tramo fue el que cambió de manos;
 *   · los DOS tramos llevan tarifa           → `analizarServicios` ya los trata como
 *     dos servicios independientes (ver su rama "los dos cobran"), así que cada uno
 *     se clasifica solo y marcar uno mueve únicamente lo suyo. Ese estado es legal:
 *     Programación lo permite tras confirmar el candado del doble cobro.
 *
 * `par` son los tramos de UN día —los dos, o el único si no tiene hermano— y
 * `marcados` los ids que el operador va a cambiar. Pasarle una selección en lote de
 * varios días daría una sola frase para días que se deciden por separado: por eso el
 * llamador solo lo invoca sobre un par.
 */
export function efectoDeMarcarTramo(
  par: FilaCanje[],
  marcados: number[],
  destino: DestinoOrigen
): EfectoTramo {
  const monto = (f: FilaCanje) => Number(f.precio_cliente ?? 0);
  const importe = redondear(par.reduce((s, f) => s + monto(f), 0));
  const enMarcados = new Set(marcados);
  const conTarifa = par.filter((f) => monto(f) > 0);

  // Sin tarifa en ningún tramo el par ni siquiera entra a la liquidación: queda
  // bloqueado por "sin precio". Decirlo evita buscar el efecto donde no está.
  if (!conTarifa.length) {
    return {
      portador: null,
      importe,
      mueveValorizacion: false,
      aviso:
        "Ninguno de los dos tramos lleva importe, así que este día todavía no entra a " +
        "ninguna liquidación. La marca queda registrada igual.",
    };
  }

  // Los dos cobran: no hay "día" que mover, hay dos servicios que van cada uno por su
  // lado. Anunciar aquí "la valorización no se mueve" era decir lo contrario de lo que
  // pasa — el tramo marcado SÍ se lleva su propio importe al otro subtotal.
  if (conTarifa.length > 1) {
    const seMueve = redondear(
      conTarifa.filter((f) => enMarcados.has(f.id)).reduce((s, f) => s + monto(f), 0)
    );
    const quedan = redondear(importe - seMueve);
    return {
      portador: null,
      importe,
      mueveValorizacion: seMueve > 0,
      aviso:
        `Los dos tramos llevan importe, así que ya son dos servicios independientes y ` +
        `cada uno se clasifica solo: pasa a ${destino.toUpperCase()} ${soles(seMueve)} y ` +
        `${soles(quedan)} se queda como está.`,
    };
  }

  const portador = conTarifa[0];
  const mueveValorizacion = enMarcados.has(portador.id);

  const aviso = mueveValorizacion
    ? `El día completo pasará a cobrarse como ${destino.toUpperCase()} (${soles(importe)}): ` +
      `estás marcando el tramo que lleva la tarifa.`
    : `La valorización NO se mueve: la tarifa del día (${soles(importe)}) está en ` +
      `${rotulo(portador)}, que no estás marcando, y ese tramo es el que clasifica el día. ` +
      `Esta marca queda como registro de que fue este tramo el que cambió.`;

  return { portador, importe, mueveValorizacion, aviso };
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
