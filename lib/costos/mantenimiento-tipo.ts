// lib/costos/mantenimiento-tipo.ts — Cuánto le cuesta a la flota mantener un KILÓMETRO de cada
// TIPO de vehículo, y si eso se puede proponer como `parametros_costos.mantenimiento_km`.
// Módulo PURO: recibe las órdenes de trabajo ya leídas y devuelve el veredicto con su motivo.
// No lee la base (el cargador es mantenimiento-flota.ts), igual que `lib/costeo-propio.ts` y
// `lib/costos/rendimiento-tipo.ts`.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE
//
// `mantenimiento_km` es el ÚNICO renglón grande del costeo que nadie medía. Se teclea una vez
// —hoy 1.20 S/km en casi toda la flota, que es el valor del alta (`FRM0`)— y ahí se queda para
// el bus de 2022 y para el de 2009. El ERP, mientras tanto, guarda cada orden de trabajo con su
// costo y su kilometraje en la tabla `mantenimiento` desde el día uno: el dato estaba, sin
// nadie que lo pusiera al lado del número que se usa para cotizar. Es exactamente la historia
// del rendimiento medido (`rendimiento-tipo.ts`), y por eso este módulo es su espejo.
//
// Y es el renglón que decide si una categoría ESTÁNDAR (unidad usada, comprada al 20-30 % de su
// valor 0 km) sale más barata o más cara que la PREMIUM. Bajar la depreciación de la usada sin
// subirle el mantenimiento es lo que hace que el ERP ofrezca por debajo de su costo real: la
// depreciación de un bus de 50 pax ronda 0.73 S/km y una unidad usada ahorra ~0.43 de eso, que
// un mantenimiento 0.70 S/km más caro se come entero. Sin medir, esa comparación es una opinión.
//
// ─────────────────────────────────────────────────────────────────────────────
// LAS TRES DECISIONES QUE NO SON COPIA DEL MÓDULO DEL RENDIMIENTO
//
// 1 · AQUÍ NO SE USA LA MEDIANA, SE USA LA TASA (Σ soles ÷ Σ km). Y es deliberado: el
//     mantenimiento es a tirones. La mediana de los tramos descartaría sistemáticamente la
//     reparación mayor —que es un costo REAL que ocurre cada tantos miles de km— y publicaría
//     el costo de los meses tranquilos. Eso es equivocarse hacia ABAJO, que en un costeo es el
//     error caro: un costo inflado se discute antes de vender; uno corto se descubre cuando el
//     servicio ya se prestó. En el combustible la mediana es la correcta por lo contrario: ahí
//     el outlier es un hueco de registro, no un gasto.
//
// 2 · NO HAY VENTANA RECIENTE QUE DECIDA. El módulo del rendimiento propone la MENOR entre el
//     histórico y los últimos 90 días. El espejo aquí sería proponer la MAYOR, y sería un error:
//     una reparación mayor dentro de la ventana la convierte en una tasa que la unidad no hace
//     todos los meses, y costear con ella dejaría la categoría fuera de mercado. La ventana se
//     ENSEÑA como evidencia (`reciente`) y no mueve la propuesta.
//
// 3 · EL NÚMERO MEDIDO ES UN PISO, NUNCA UN TECHO, y el módulo lo dice. Solo cuenta lo asentado
//     en `mantenimiento`: un repuesto pagado por caja chica que nadie convirtió en orden de
//     trabajo no está aquí. Por eso el detalle nunca afirma "esto es lo que cuesta mantenerla",
//     sino "esto es lo que está registrado".
//
// ─────────────────────────────────────────────────────────────────────────────
// LO QUE ESTE MÓDULO NO HACE, A PROPÓSITO: escribir. Devuelve un número y un motivo; quién lo
// aplica es una persona, y la escritura pasa por `escribirParametro` (lib/costos/parametros.ts).
// Subir `mantenimiento_km` encarece el S/km de esa categoría y, como el margen es sobre el
// PRECIO (`costo/(1−margen)`, ver lib/costeo-propio.ts), sube el precio ofertado de toda
// cotización nueva de ese tipo. Eso lo firma el dueño, no un cron.
import { MIN_TRAMOS_CONFIABLE, KM_DIA_MAX } from "@/lib/rendimiento";
import { DIAS_RECIENTE, type Flota } from "./rendimiento-tipo";

/** El paso del campo `mantenimiento_km` en la pantalla de costos (`CAMPOS_EDIT`, step 0.05).
 *  HEREDADO, no elegido: es la granularidad con la que el ERP ya declara que se teclea. */
export const PASO_MANTENIMIENTO = 0.05;

/** Cuántos TRAMOS hacen falta para que una placa vote. Heredado literal de
 *  `MIN_TRAMOS_CONFIABLE` (lib/rendimiento.ts): es el mínimo que este ERP ya declara para
 *  decir "esto es un patrón y no una anécdota". Cinco tramos son seis órdenes de trabajo con
 *  kilometraje — en un bus con servicio cada 5 000 km, medio año. */
export const MIN_TRAMOS_MANT = MIN_TRAMOS_CONFIABLE;

export { DIAS_RECIENTE };

/**
 * Días entre dos fechas ISO. COPIADO LITERAL de la función privada de lib/rendimiento.ts: los
 * dos motores comparan contra el mismo `KM_DIA_MAX`, así que "días entre dos fechas" tiene que
 * significar exactamente lo mismo en los dos o el mismo tramo sería plausible en uno e
 * imposible en el otro.
 */
function diasEntre(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 1;
}

// ─── LA ORDEN DE TRABAJO ──────────────────────────────────────────────────────

/** Una fila de `mantenimiento`, con lo mínimo que hace falta para medir. */
export type OtMantenimiento = {
  id: number | string;
  /** `yyyy-mm-dd`. La cadena se ordena por FECHA, nunca por kilometraje. */
  fecha: string;
  /** El odómetro al momento del servicio. `null` o `0` = no se anotó. */
  km: number | null;
  costo: number;
  /** `pendiente | en_proceso | finalizado | cancelado`. */
  estado: string | null;
  /** `preventivo | correctivo`. Informativo: los dos son costo de mantener. */
  tipo: string | null;
  descripcion: string | null;
};

/** Por qué una OT no aportó su costo a ningún tramo. Se DECLARA, no se olfatea. */
export type MotivoFueraOt =
  /** Se anuló: esa plata nunca salió. */
  | "cancelada"
  /** Programada para después de hoy: todavía no ocurrió. */
  | "futura"
  /** La primera con kilometraje: no hay tramo antes de ella, su desgaste es anterior. */
  | "cabecera"
  /** Sin kilometraje y sin ningún tramo posterior que la recoja. */
  | "sin_kilometraje"
  /** Su tramo no se puede medir: el odómetro retrocede o el salto es imposible. */
  | "tramo_implausible";

export type OtFuera = {
  id: number | string;
  fecha: string;
  costo: number;
  motivo: MotivoFueraOt;
  /** Lo que se vio, para poder enseñarlo en vez de esconderlo. */
  detalle: string;
};

/** Un intervalo entre dos órdenes de trabajo con kilometraje. */
export type TramoMant = {
  desde: string;
  hasta: string;
  km: number;
  dias: number;
  /** Soles de la OT que CIERRA el tramo, más los de las OT sin kilometraje que quedaron dentro. */
  costo: number;
  /** Cuántas OT aportaron ese costo. */
  ots: number;
  /** `costo / km`. Se publica por tramo para poder enseñarlo; el número del tipo NO es su
   *  mediana (ver la decisión 1 de la cabecera). */
  soleskm: number;
};

// ─── EL NEUMÁTICO, QUE YA SE COBRA EN OTRO RENGLÓN ────────────────────────────

/**
 * Términos que delatan una OT de LLANTAS. `parametros_costos` cobra los neumáticos en su propio
 * renglón (`n_neumaticos × costo_neumatico / vida_neumatico_km`), así que una compra de llantas
 * asentada como orden de trabajo entraría DOS VECES en el S/km del tipo.
 *
 * NO SE DESCUENTA SOLA, Y ESA ES LA DECISIÓN. Detectar por texto es adivinar, y aquí adivinar de
 * más es lo caro: una OT que solo MENCIONA una llanta ("cambio de aceite y revisión de llantas")
 * quedaría fuera y el costo medido saldría por debajo del real. Por eso las filas se cuentan
 * igual, el tipo se marca `revisar_neumaticos` —sin botón— y la pantalla enseña las dos cifras,
 * con y sin ellas, para que el número lo teclee una persona. Mismo criterio que `cuadre_ambiguo`
 * en el voucher de grifo: nadie adivina, se nombra.
 *
 * "Alineamiento" y "balanceo" NO están en la lista a propósito: son servicio, no compra de
 * llantas, y su costo es mantenimiento del que sí se cobra una sola vez.
 */
const TERMINOS_NEUMATICO = ["llanta", "neumatic", "neumátic", "vulcaniz", "reencauch", "cocada"];

export function pareceNeumatico(descripcion: string | null | undefined): boolean {
  const t = String(descripcion ?? "").toLowerCase();
  return TERMINOS_NEUMATICO.some((x) => t.includes(x));
}

// ─── LA SERIE DE UNA PLACA ────────────────────────────────────────────────────

export type ResumenMant = {
  /** Σ km de los tramos medidos. */
  km: number;
  /** Σ soles atribuidos a esos tramos. */
  costo: number;
  /** `costo / km`. null sin tramos: un cero se leería como "mantenerla no cuesta nada". */
  soleskm: number | null;
  tramos: number;
  /** Cuántas OT aportaron costo. */
  ots: number;
  confiable: boolean;
  /** La misma tasa sobre los tramos de los últimos `DIAS_RECIENTE` días. Se ENSEÑA, no decide.
   *  Sus dos sumandos viajan aparte porque el agregado del TIPO los vuelve a sumar: agrupar
   *  tasas ya calculadas le daría el mismo peso a la unidad que hizo 3 000 km y a la de 60 000. */
  recienteSolesKm: number | null;
  recienteSoles: number;
  recienteKm: number;
  recienteTramos: number;
  /** Soles que quedaron fuera de la medición, con su motivo. */
  costoFuera: number;
  /** OT sospechosas de ser compra de llantas, DENTRO de los tramos medidos. */
  neumaticosOts: number;
  neumaticosCosto: number;
  /** La tasa si esas OT no estuvieran. Se enseña al lado; nunca se propone sola. */
  soleskmSinNeumaticos: number | null;
  /** Órdenes PREVENTIVAS ocurridas, no anuladas y con costo. Es lo único que el intervalo del
   *  plan del fabricante sabe proyectar (ver `estimarPorPlan`): un correctivo no tiene
   *  periodicidad, y dividirlo entre 5 000 km le inventaría una. NO dependen del odómetro —
   *  ahí está la gracia: se cuentan aunque la orden no tenga kilometraje. */
  preventivasOts: number;
  preventivasCosto: number;
  /** De esas, cuántas parecen compra de llantas. Se NOMBRAN, no se descuentan (ver arriba). */
  preventivasNeumaticos: number;
  desde: string | null;
  hasta: string | null;
};

export type SerieMant = { tramos: TramoMant[]; fuera: OtFuera[]; resumen: ResumenMant };

const red2 = (n: number) => Math.round(n * 100) / 100;
const red4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Las órdenes de trabajo de UNA placa → tramos medibles y lo que quedó fuera.
 *
 * LA CADENA VA POR FECHA, NUNCA POR KILOMETRAJE — la misma regla, y por la misma razón, que
 * `serieRendimiento`: ordenar por el valor que se está midiendo es circular, el km mal tecleado
 * se acomoda al final en vez de delatarse y re-enlaza todos los tramos posteriores con el
 * predecesor equivocado.
 *
 * EL COSTO SE ATRIBUYE AL TRAMO QUE LA OT CIERRA, no al que abre. Es el espejo exacto del
 * `[kmPrev, km)` del combustible: el combustible de una carga se quema DESPUÉS de su lectura;
 * el mantenimiento se paga DESPUÉS del desgaste que lo causó. Por eso la primera OT con
 * kilometraje no aporta costo: su desgaste ocurrió antes de que empezara a haber registro.
 *
 * Una OT SIN kilometraje no rompe la cadena: su costo se acumula y lo recoge el primer tramo
 * que cierre después. La plata se gastó dentro de esos km aunque nadie anotara el odómetro —
 * dejarla fuera publicaría un mantenimiento más barato que el real, que es el lado caro.
 */
export function serieMantenimiento(ots: OtMantenimiento[], hoy: string): SerieMant {
  const tramos: TramoMant[] = [];
  const fuera: OtFuera[] = [];

  const orden = [...ots]
    .filter((o) => !!o.fecha)
    .sort((a, b) =>
      String(a.fecha).localeCompare(String(b.fecha)) ||
      (Number(a.km ?? 0) - Number(b.km ?? 0))          // desempate intradía por km
    );

  let ancla: OtMantenimiento | null = null;
  let pendientes: OtMantenimiento[] = [];   // OT sin km esperando al tramo que las recoja
  const prev = { ots: 0, costo: 0, neum: 0 };   // las preventivas, para el estimado por plan

  const soltarPendientes = (motivo: MotivoFueraOt, detalle: string) => {
    for (const p of pendientes) {
      fuera.push({ id: p.id, fecha: p.fecha, costo: Number(p.costo || 0), motivo, detalle });
    }
    pendientes = [];
  };

  for (const o of orden) {
    const costo = Number(o.costo || 0);
    const estado = String(o.estado ?? "").toLowerCase();

    // Una OT ANULADA es plata que nunca salió: contarla inventaría un costo. Y una PROGRAMADA
    // para después de hoy todavía no ocurrió — y sus km tampoco se han recorrido, así que
    // entraría al numerador sin su denominador.
    if (estado === "cancelado" || estado === "cancelada") {
      fuera.push({ id: o.id, fecha: o.fecha, costo, motivo: "cancelada", detalle: "orden anulada" });
      continue;
    }
    if (String(o.fecha) > hoy) {
      fuera.push({ id: o.id, fecha: o.fecha, costo, motivo: "futura", detalle: "programada, todavía no ocurrió" });
      continue;
    }

    // LAS PREVENTIVAS SE CUENTAN AQUÍ, y el sitio no es casual: las dos reglas que de verdad
    // importan —"se anuló, esa plata nunca salió" y "está programada, todavía no ocurrió"— acaban
    // de aplicarse dos líneas arriba. Contarlas en un segundo recorrido obligaría a repetirlas, y
    // la copia es siempre la que se queda atrás. Va ANTES del filtro de kilometraje a propósito:
    // el estimado por plan existe justamente para la orden que no tiene odómetro.
    //
    // Con `costo > 0`: una OT abierta automáticamente por el plan nace en S/ 0.00 y recibe su
    // costo después. Contarla con cero partiría el promedio por la mitad.
    if (String(o.tipo ?? "").toLowerCase() === "preventivo" && costo > 0) {
      prev.ots++;
      prev.costo += costo;
      if (pareceNeumatico(o.descripcion)) prev.neum++;
    }

    const km = Number(o.km ?? 0);
    if (!(km > 0)) {
      pendientes.push(o);
      continue;
    }

    if (!ancla) {
      ancla = o;
      fuera.push({
        id: o.id, fecha: o.fecha, costo, motivo: "cabecera",
        detalle: "es la primera con kilometraje: el desgaste que pagó es anterior a lo registrado",
      });
      // Lo que había pendiente antes de la cabecera tampoco tiene tramo donde caer.
      soltarPendientes("sin_kilometraje", "anterior a la primera orden con kilometraje");
      continue;
    }

    const kmPrev = Number(ancla.km ?? 0);
    const delta = km - kmPrev;
    const dias = Math.max(1, diasEntre(ancla.fecha, o.fecha));

    if (delta <= 0) {
      // El odómetro retrocede: uno de los dos números está mal y no se sabe cuál. No se adivina.
      fuera.push({
        id: o.id, fecha: o.fecha, costo, motivo: "tramo_implausible",
        detalle: `el kilometraje (${km.toLocaleString("es-PE")}) no es mayor que el de la orden anterior (${kmPrev.toLocaleString("es-PE")})`,
      });
      soltarPendientes("tramo_implausible", "su tramo no se pudo medir");
      ancla = o;   // la lectura nueva manda hacia adelante: seguir con la vieja arrastraría el error
      continue;
    }
    if (delta / dias > KM_DIA_MAX) {
      // Mismo tope que `registrarLectura`, `config_mantenimiento.km_dia_max` y lib/rendimiento.ts.
      // No es un umbral nuevo: es el que este ERP ya usa para decir "este odómetro está mal".
      fuera.push({
        id: o.id, fecha: o.fecha, costo, motivo: "tramo_implausible",
        detalle: `${delta.toLocaleString("es-PE")} km en ${dias} día(s) — por encima de ${KM_DIA_MAX} km/día`,
      });
      soltarPendientes("tramo_implausible", "su tramo no se pudo medir");
      ancla = o;
      continue;
    }

    const costoTramo = costo + pendientes.reduce((s, p) => s + Number(p.costo || 0), 0);
    tramos.push({
      desde: ancla.fecha, hasta: o.fecha, km: delta, dias,
      costo: red2(costoTramo), ots: 1 + pendientes.length,
      soleskm: red4(costoTramo / delta),
    });
    // Las que iban sin kilometraje ya viajan dentro del tramo: se vacían SIN pasar por `fuera`.
    pendientes = [];
    ancla = o;
  }

  // Lo que quedó colgando al final no tiene tramo que lo recoja.
  soltarPendientes("sin_kilometraje", "no hay ninguna orden con kilometraje después de ella");

  return { tramos, fuera, resumen: resumirMant(tramos, fuera, orden, hoy, prev) };
}

function resumirMant(
  tramos: TramoMant[], fuera: OtFuera[], orden: OtMantenimiento[], hoy: string,
  prev: { ots: number; costo: number; neum: number }
): ResumenMant {
  const km = tramos.reduce((s, t) => s + t.km, 0);
  const costo = tramos.reduce((s, t) => s + t.costo, 0);
  const ots = tramos.reduce((s, t) => s + t.ots, 0);

  const desdeReciente = sumarDiasISO(hoy, -DIAS_RECIENTE);
  const recientes = tramos.filter((t) => t.hasta >= desdeReciente);
  const kmR = recientes.reduce((s, t) => s + t.km, 0);
  const costoR = recientes.reduce((s, t) => s + t.costo, 0);

  // Las OT sospechosas de llantas se cuentan SOLO dentro de la ventana medida: una anterior al
  // primer tramo no está en el numerador, así que nombrarla sería un aviso sobre plata que no
  // entró en el número.
  const primerTramo = tramos[0]?.desde ?? null;
  const ultimoTramo = tramos[tramos.length - 1]?.hasta ?? null;
  const dentro = (f: string) => !!primerTramo && !!ultimoTramo && f > primerTramo && f <= ultimoTramo;
  const fueraIds = new Set(fuera.map((x) => String(x.id)));
  const neum = orden.filter(
    (o) => pareceNeumatico(o.descripcion) && dentro(String(o.fecha)) && !fueraIds.has(String(o.id))
  );
  const neumCosto = neum.reduce((s, o) => s + Number(o.costo || 0), 0);

  return {
    km,
    costo: red2(costo),
    soleskm: km > 0 ? red4(costo / km) : null,
    tramos: tramos.length,
    ots,
    confiable: tramos.length >= MIN_TRAMOS_MANT,
    recienteSolesKm: kmR > 0 && recientes.length ? red4(costoR / kmR) : null,
    recienteSoles: red2(costoR),
    recienteKm: kmR,
    recienteTramos: recientes.length,
    costoFuera: red2(fuera.reduce((s, f) => s + f.costo, 0)),
    neumaticosOts: neum.length,
    neumaticosCosto: red2(neumCosto),
    soleskmSinNeumaticos: km > 0 && neum.length ? red4((costo - neumCosto) / km) : null,
    preventivasOts: prev.ots,
    preventivasCosto: red2(prev.costo),
    preventivasNeumaticos: prev.neum,
    desde: tramos[0]?.desde ?? null,
    hasta: tramos[tramos.length - 1]?.hasta ?? null,
  };
}

/** `yyyy-mm-dd` ± días, en UTC. Local para que el módulo no dependa de nada que lea reloj. */
function sumarDiasISO(fecha: string, dias: number): string {
  const ms = Date.parse(`${fecha}T00:00:00Z`);
  if (!Number.isFinite(ms)) return fecha;
  return new Date(ms + dias * 86_400_000).toISOString().slice(0, 10);
}

// ─── LA PLACA, YA MEDIDA ──────────────────────────────────────────────────────

/** Una placa que apunta a un tipo de costeo, con su serie de mantenimiento ya resuelta. */
export type PlacaMantenimiento = {
  /** Clave sintética (`p12` / `t12`): los ids de las dos flotas se solapan. */
  uid: string;
  vehiculoId: number;
  placa: string;
  flota: Flota;
  /** El texto CRUDO de `tipo_vehiculo_costeo`. No se normaliza al leer. */
  tipoCosteo: string | null;
  /** `vehiculos.anio` — el año de fabricación. Null en las de tercero: esa tabla no lo tiene. */
  anio: number | null;
  /** Cuántas OT tiene en total, incluidas las que no midieron nada. */
  otsTotales: number;
  serie: SerieMant;
  /** Cada cuántos km le toca servicio, según el plan del fabricante al que está enrolada
   *  (`vehiculos_plan.intervalo_km_override` ?? `planes_mantenimiento.intervalo_base_km`).
   *
   *  ES OPCIONAL Y OMITIRLA DEJA EL COMPORTAMIENTO INTACTO, byte a byte: sin intervalo no hay
   *  estimado por plan y el agregado responde exactamente lo que respondía antes. Misma regla
   *  que `otrasFamilias` en `seriesRendimiento`; la matriz lo fija. */
  intervaloPlanKm?: number | null;
};

// ─── EL INTERVALO DEL PLAN: UN DATO DECLARADO QUE NADIE ESTABA CRUZANDO ───────
//
// POR QUÉ EXISTE. Con UNA sola orden de trabajo no hay tramo —un tramo son dos odómetros— y este
// módulo decía, con razón, que no podía medir nada. Pero el ERP sabe algo más que no estaba
// mirando: `planes_mantenimiento.intervalo_base_km` declara que a esa unidad le toca servicio
// cada 5 000 km. Con eso, el costo de un servicio preventivo dividido entre su intervalo SÍ es un
// S/km defendible, y convierte un "no se puede medir nada" en un número.
//
// LAS TRES COSAS QUE LO ACOTAN, Y NINGUNA ES OPCIONAL:
//
// 1 · SOLO PREVENTIVAS. Un correctivo no tiene periodicidad: dividirlo entre 5 000 km le
//     inventaría una, y el número saldría de una avería que quizá no se repite nunca.
//
// 2 · MIDE OTRA COSA QUE `mantenimiento_km`, Y POR ESO NO SE PROPONE JAMÁS. El parámetro es
//     TODO el mantenimiento por km; esto es solo el servicio programado. Aunque los dos números
//     coincidieran por casualidad, adoptar uno como el otro sería un error de categoría — y como
//     el correctivo y el mantenimiento mayor quedan fuera por construcción, el estimado está
//     SIEMPRE por debajo. Aplicarlo recortaría el renglón de taller y abarataría el precio
//     ofertado de toda la categoría: un costo corto no se discute antes de vender, se descubre
//     cuando el servicio ya se prestó.
//
// 3 · ES UN PISO DEL PISO. El medido ya es un piso (solo cuenta lo asentado); este además deja
//     fuera todo lo no programado. El detalle lo dice con esas palabras: es lo que se está
//     absorbiendo, no lo que cuesta mantener la unidad.

export type EstimadoPlan = {
  /** `Σ costo preventivo ÷ Σ (servicios × intervalo)`. Nunca null: sin datos no se devuelve. */
  soleskm: number;
  /** El intervalo con el que se proyectó. Con varias placas es el ponderado — que en el caso
   *  normal (todas con el mismo plan) es exactamente el del plan. */
  intervaloKm: number;
  /** Cuántas órdenes preventivas con costo lo sustentan. */
  ots: number;
  /** Lo que cuesta un servicio, en promedio. Es el número que una persona puede verificar. */
  costoServicio: number;
  /** De esas, cuántas parecen compra de llantas — que este tipo ya cobra en su propio renglón. */
  neumaticos: number;
  placas: string[];
};

/**
 * El S/km del SERVICIO PROGRAMADO de un tipo, proyectando el costo de sus órdenes preventivas
 * sobre el intervalo que declara el plan del fabricante.
 *
 * Se agrupa Σ soles ÷ Σ km igual que `tasaAgrupada`, nunca promediando tasas: una unidad con seis
 * servicios registrados no puede pesar lo mismo que otra con uno. Devuelve `null` en cuanto falta
 * cualquiera de las dos mitades — un cero se leería como "el servicio programado es gratis".
 */
export function estimarPorPlan(placas: PlacaMantenimiento[]): EstimadoPlan | null {
  // No recibe `hoy`: las anuladas y las futuras ya quedaron fuera al construir la serie, y
  // volver a filtrarlas aquí sería una segunda definición de "esta orden ocurrió".
  let soles = 0, km = 0, ots = 0, neum = 0;
  const nombres: string[] = [];
  for (const p of placas) {
    // SOLO LAS PROPIAS, por lo mismo que en la medición: a un tercero no se le paga el
    // mantenimiento, se le paga una factura, y `mantenimiento` ni siquiera tiene sus órdenes.
    if (p.flota !== "propia") continue;
    const intervalo = Number(p.intervaloPlanKm ?? 0);
    const r = p.serie.resumen;
    if (!(intervalo > 0) || !(r.preventivasOts > 0) || !(r.preventivasCosto > 0)) continue;
    soles += r.preventivasCosto;
    km += r.preventivasOts * intervalo;
    ots += r.preventivasOts;
    neum += r.preventivasNeumaticos;
    nombres.push(p.placa);
  }
  if (!(km > 0) || !(soles > 0)) return null;
  return {
    soleskm: red4(soles / km),
    intervaloKm: Math.round(km / ots),
    ots,
    costoServicio: red2(soles / ots),
    neumaticos: neum,
    placas: nombres,
  };
}

// ─── EL AGREGADO DEL TIPO ─────────────────────────────────────────────────────

/** La última decisión humana sobre el mantenimiento de este tipo, DERIVADA de `historial_costos`. */
export type ProcedenciaMant = {
  origen: "manual" | "medido";
  fecha: string | null;
  por: string | null;
  /** El medido que alguien revisó y decidió NO adoptar. */
  descartado: number | null;
};

export const SIN_PROCEDENCIA_MANT: ProcedenciaMant = { origen: "manual", fecha: null, por: null, descartado: null };

export type CodigoMant =
  /** Hay número proponible. Es el ÚNICO código con botón. */
  | "medido"
  /** El tecleado ya está a menos de PASO_MANTENIMIENTO del medido. */
  | "coincide"
  /** Una persona revisó esta misma medición y decidió no adoptarla. */
  | "descartado"
  /** Hay órdenes que parecen compra de llantas: el parámetro ya las cobra aparte. */
  | "revisar_neumaticos"
  /** Dos o más placas lo miden: se enseñan las dos y decide una persona. */
  | "varias_placas"
  /** Ninguna unidad apunta a este tipo. */
  | "sin_placas"
  /** No hay tramo medible, pero el plan del fabricante declara cada cuántos km toca servicio y
   *  hay órdenes preventivas con costo. Trae número —en `plan`, NUNCA en `medido`— y NO se
   *  propone: mide el servicio programado, que es otra cosa que `mantenimiento_km`. */
  | "estimado_por_plan"
  /** Hay placas propias, ninguna con órdenes de trabajo. */
  | "sin_mantenimiento"
  /** Hay órdenes, y NINGUNA tiene kilometraje anotado. Se arregla en /mantenimiento → Historial. */
  | "sin_kilometraje"
  /** Hay UNA orden con kilometraje. No falta nada por corregir: el tramo lo cierra la siguiente.
   *  Vive aparte de `sin_kilometraje` porque aquel manda a rellenar un odómetro que aquí ya
   *  está puesto — el mismo rojo diciendo dos cosas con arreglos distintos. */
  | "una_sola_orden"
  /** Hay dos o más con kilometraje y sus odómetros no son coherentes (retrocede, o el salto es
   *  imposible). Lo que falta no es un dato: hay un número mal, y se corrige en el Historial. */
  | "kilometraje_incoherente"
  /** Hay tramos, ninguna placa llega a MIN_TRAMOS_MANT. */
  | "pocos_registros"
  /** La única evidencia es de flota ajena. */
  | "solo_terceros";

export type ParametroMant = {
  tipo_vehiculo: string;
  nombre: string;
  mantenimiento_km: number;
};

export type AgregadoMant = {
  tipoVehiculo: string;
  nombre: string;
  codigo: CodigoMant;
  /** INVARIANTE 1: `proponible === (codigo === "medido")`. La matriz la fija. */
  proponible: boolean;
  parametro: number;
  /** INVARIANTE 2: no es null exactamente en los seis códigos que tienen número
   *  (medido · coincide · descartado · revisar_neumaticos · varias_placas · pocos_registros). */
  medido: number | null;
  /** La misma tasa sin las órdenes que parecen llantas. Solo con `revisar_neumaticos`. */
  medidoSinNeumaticos: number | null;
  /** El servicio programado proyectado sobre el intervalo del plan. **NO OCUPA `medido`**, y eso
   *  es deliberado: `medido` significa "gastado de verdad, medido entre dos odómetros", y meter
   *  aquí otro número haría que el chip y el modal lo publicaran como si lo fuera — escribir bajo
   *  una identidad y leer con otra, el patrón que este repo ya pagó seis veces. Es EVIDENCIA:
   *  se publica siempre que se pueda calcular y no mueve el código salvo cuando no hay nada
   *  medido (`estimado_por_plan`). */
  plan: EstimadoPlan | null;
  /** Tasa de los últimos DIAS_RECIENTE días. EVIDENCIA: no mueve la propuesta. */
  reciente: number | null;
  /** `(medido − parametro) / parametro`. null si `parametro <= 0` — jamás Infinity. */
  desvio: number | null;
  /** Los soles y los km sobre los que se midió. Sin esto el número no se puede verificar. */
  soles: number;
  km: number;
  tramos: number;
  /** Las que votaron. */
  aportan: PlacaMantenimiento[];
  /** Las que se ven y NO votan, con su motivo. Disjunta de `aportan` y exhaustiva con ella. */
  observadas: { placa: PlacaMantenimiento; motivo: CodigoMant }[];
  /** Quién hereda este número sin medirlo. */
  heredan: { placa: string; flota: Flota; motivo: string }[];
  procedencia: ProcedenciaMant;
  /** De dónde salió, y si no salió, DÓNDE se arregla. Ninguna pantalla lo redacta. */
  detalle: string;
};

/**
 * POR QUÉ UNA PLACA CON ÓRDENES NO MIDIÓ NINGÚN TRAMO. Se DERIVA de lo que su propia serie ya
 * declaró en `fuera`; no se olfatea nada nuevo.
 *
 * ESTO ERA UN SOLO ROJO DICIENDO TRES COSAS, y el error se reportó desde la pantalla: una unidad
 * con UNA orden con kilometraje recibía el texto de `sin_kilometraje` —"sin kilometraje no se
 * puede medir ningún tramo… se completa en /mantenimiento → Historial"—, o sea el ERP mandando a
 * rellenar un odómetro que ya estaba puesto. Los tres casos tienen arreglos distintos:
 *
 *  · `sin_kilometraje`        → falta el dato. Se teclea en el Historial.
 *  · `una_sola_orden`         → NO falta nada. El tramo lo cierra la siguiente orden.
 *  · `kilometraje_incoherente`→ el dato está, pero uno de los números es falso. Se corrige.
 *
 * Es exhaustivo por construcción: `serieMantenimiento` mete en `fuera` una `cabecera` por cada
 * re-ancla, así que una orden con kilometraje deja SIEMPRE rastro de uno de los dos tipos.
 */
function porQueNoMidio(p: PlacaMantenimiento): CodigoMant {
  const f = p.serie.fuera;
  // Dos o más lecturas que no se pueden encadenar: el retroceso o el salto imposible SOLO
  // aparecen con un ancla previa, así que este caso implica ≥ 2 órdenes con odómetro.
  if (f.some((x) => x.motivo === "tramo_implausible")) return "kilometraje_incoherente";
  if (f.some((x) => x.motivo === "cabecera")) return "una_sola_orden";
  return "sin_kilometraje";
}

const MOTIVO_HEREDA: Record<string, string> = {
  sin_kilometraje: "sus órdenes no tienen kilometraje",
  una_sola_orden: "solo tiene una orden con kilometraje: falta la siguiente para cerrar el tramo",
  kilometraje_incoherente: "sus órdenes con kilometraje no encadenan",
};

/** La tasa agrupada de varias placas: Σ soles ÷ Σ km. NO es el promedio de sus tasas — eso le
 *  daría el mismo peso a la unidad que hizo 3 000 km que a la que hizo 60 000. */
function tasaAgrupada(placas: PlacaMantenimiento[]): { soles: number; km: number; tasa: number | null; tramos: number } {
  const soles = placas.reduce((s, p) => s + p.serie.resumen.costo, 0);
  const km = placas.reduce((s, p) => s + p.serie.resumen.km, 0);
  const tramos = placas.reduce((s, p) => s + p.serie.resumen.tramos, 0);
  return { soles: red2(soles), km, tasa: km > 0 ? red4(soles / km) : null, tramos };
}

/**
 * Qué mantenimiento por kilómetro mide la flota para este tipo, y si se puede proponer.
 *
 * El orden de las comprobaciones va de lo ESTRUCTURAL a lo estadístico, igual que
 * `agregarRendimientoTipo`: a un tipo sin placas no le va a servir ninguna medición nunca, así
 * que decirlo gana sobre decir que hoy faltan órdenes.
 */
export function agregarMantenimientoTipo(
  parametro: ParametroMant,
  placas: PlacaMantenimiento[],
  procedencia: ProcedenciaMant = SIN_PROCEDENCIA_MANT
): AgregadoMant {
  const base = {
    tipoVehiculo: parametro.tipo_vehiculo,
    nombre: parametro.nombre,
    parametro: parametro.mantenimiento_km,
    medido: null as number | null,
    medidoSinNeumaticos: null as number | null,
    plan: estimarPorPlan(placas),
    reciente: null as number | null,
    desvio: null as number | null,
    soles: 0,
    km: 0,
    tramos: 0,
    aportan: [] as PlacaMantenimiento[],
    observadas: [] as { placa: PlacaMantenimiento; motivo: CodigoMant }[],
    heredan: [] as { placa: string; flota: Flota; motivo: string }[],
    procedencia,
  };
  const no = (codigo: CodigoMant, detalle: string, extra: Partial<AgregadoMant> = {}): AgregadoMant => ({
    ...base, codigo, proponible: false, detalle, ...extra,
  });

  if (!placas.length) {
    return no("sin_placas",
      "Ninguna unidad de la flota tiene este tipo asignado como su categoría de costeo, así que " +
      "nadie lo mide. Se asigna en la ficha de la unidad (/vehiculos → Editar → Categoría de costeo).");
  }

  // 1 · EL REPARTO. `aportan` y `observadas` son disjuntas y cubren TODAS las placas: un filtro
  //     silencioso aquí sería una unidad que se ve en la flota y no se explica en ningún sitio.
  const aportan: PlacaMantenimiento[] = [];
  const conTramos: PlacaMantenimiento[] = [];   // miden algo aunque no lleguen al mínimo
  const observadas: { placa: PlacaMantenimiento; motivo: CodigoMant }[] = [];
  const heredan: { placa: string; flota: Flota; motivo: string }[] = [];

  for (const p of placas) {
    // SOLO VOTAN LAS PROPIAS, y aquí la razón es todavía más dura que en el rendimiento: a una
    // unidad de tercero AFA no le paga el mantenimiento — le paga una factura por servicio. Su
    // taller, sus repuestos y sus decisiones no son de esta empresa. `vehiculos_tercero` ni
    // siquiera tiene órdenes de trabajo en esta tabla.
    if (p.flota === "tercero") {
      observadas.push({ placa: p, motivo: "solo_terceros" });
      heredan.push({ placa: p.placa, flota: "tercero", motivo: "unidad de tercero: usa este costo, no lo mide" });
      continue;
    }
    if (p.otsTotales === 0) {
      observadas.push({ placa: p, motivo: "sin_mantenimiento" });
      heredan.push({ placa: p.placa, flota: "propia", motivo: "sin órdenes de trabajo registradas" });
      continue;
    }
    if (p.serie.resumen.tramos === 0) {
      const motivo = porQueNoMidio(p);
      observadas.push({ placa: p, motivo });
      heredan.push({ placa: p.placa, flota: "propia", motivo: MOTIVO_HEREDA[motivo] });
      continue;
    }
    conTramos.push(p);
    if (!p.serie.resumen.confiable) {
      observadas.push({ placa: p, motivo: "pocos_registros" });
      continue;
    }
    aportan.push(p);
  }

  base.aportan = aportan;
  base.observadas = observadas;
  base.heredan = heredan;

  if (!aportan.length) {
    // Sin votantes, pero con algo medido, EL NÚMERO SE ENSEÑA IGUAL. Es la diferencia con el
    // módulo del rendimiento, y es a propósito: el mantenimiento se registra a tirones, así que
    // esconder el número dejaría la columna vacía en toda la flota, y una columna vacía se lee
    // como "aquí no hay nada que medir" — que es justo lo contrario de lo que pasa.
    if (conTramos.length) {
      const g = tasaAgrupada(conTramos);
      return no("pocos_registros",
        `Se midió ${fmt4(g.tasa)} S/km sobre ${g.tramos} tramo(s) y ${fmtKm(g.km)} km, que no alcanza para ` +
        `un patrón (hacen falta ${MIN_TRAMOS_MANT} tramos en una misma unidad). El número está a la vista ` +
        "para compararlo, no para aplicarlo. Se cierra registrando las órdenes de trabajo con su " +
        "kilometraje y su costo en /mantenimiento.",
        { medido: g.tasa, soles: g.soles, km: g.km, tramos: g.tramos,
          desvio: desvioDe(parametro.mantenimiento_km, g.tasa) });
    }
    // El motivo más ACCIONABLE primero: un número mal se corrige hoy, un odómetro que falta se
    // teclea hoy, y "solo hay una orden" no tiene nada que hacer más que esperar a la siguiente.
    const orden: CodigoMant[] = [
      "kilometraje_incoherente", "sin_kilometraje", "una_sola_orden", "sin_mantenimiento", "solo_terceros",
    ];
    const motivo = orden.find((m) => observadas.some((o) => o.motivo === m)) ?? "sin_mantenimiento";
    const textos: Record<string, string> = {
      sin_kilometraje:
        "Las unidades de este tipo tienen órdenes de trabajo, pero ninguna con el odómetro anotado, así que " +
        "no hay ningún tramo que medir: hacen falta dos órdenes seguidas con kilometraje. Se completa en " +
        "/mantenimiento → Historial.",
      una_sola_orden:
        "Solo hay UNA orden de trabajo con kilometraje, y un tramo son dos odómetros: el trecho lo cierra la " +
        "orden siguiente. No falta ningún dato por corregir — con anotar el kilometraje del próximo servicio, " +
        "esta categoría empieza a medirse sola.",
      kilometraje_incoherente:
        "Hay dos o más órdenes con kilometraje, pero sus odómetros no encadenan: alguno retrocede o el salto " +
        "entre dos fechas es imposible. Aquí no falta un dato, hay un número equivocado — se corrige en " +
        "/mantenimiento → Historial y el tramo se mide solo.",
      sin_mantenimiento:
        "Las unidades propias de este tipo no tienen ninguna orden de trabajo registrada. Mientras el " +
        "mantenimiento se pague sin asentarlo, el S/km de esta categoría solo puede ser el que alguien teclee.",
      solo_terceros:
        "Las únicas unidades con este tipo son de tercero. Su mantenimiento no entra: a un proveedor se le " +
        "paga por factura, y su taller no es de esta empresa.",
    };

    // EL INTERVALO DEL PLAN CONVIERTE ESE "NO SE PUEDE MEDIR NADA" EN UN NÚMERO. Gana sobre el
    // motivo seco porque trae una cifra verificable — pero SIGUE NOMBRANDO por qué no hay
    // medición, que es lo que dice dónde se arregla.
    if (base.plan) {
      const pl = base.plan;
      return no("estimado_por_plan",
        `${textos[motivo]}\n\n` +
        `Con lo que SÍ está declarado —servicio cada ${fmtKm(pl.intervaloKm)} km en el plan del fabricante— ` +
        `y ${pl.ots} orden(es) preventiva(s) por ${fmtS(pl.costoServicio)} de media, el servicio programado ` +
        `sale a ${fmt4(pl.soleskm)} S/km, contra los ${fmt4(parametro.mantenimiento_km)} tecleados.\n\n` +
        "NO se propone, y no es por prudencia: mide OTRA COSA. El parámetro es todo el mantenimiento por " +
        "kilómetro; esto es solo el servicio programado, sin correctivos ni mantenimiento mayor, así que está " +
        "por debajo por construcción. La diferencia entre las dos cifras es, justamente, lo que el parámetro " +
        "está absorbiendo de lo no programado." +
        (pl.neumaticos > 0
          ? ` Ojo además: ${pl.neumaticos} de esas órdenes parece compra de llantas, y este tipo ya las cobra en su propio renglón.`
          : ""));
    }

    return no(motivo, textos[motivo]);
  }

  // 2 · LA TASA DEL TIPO: Σ soles ÷ Σ km de las votantes. Ni mediana ni promedio de tasas — ver
  //     la decisión 1 de la cabecera.
  const g = tasaAgrupada(aportan);
  base.medido = g.tasa;
  base.soles = g.soles;
  base.km = g.km;
  base.tramos = g.tramos;
  base.desvio = desvioDe(parametro.mantenimiento_km, g.tasa);

  base.reciente = tasaReciente(aportan);

  const placasTxt = aportan.map((p) => p.placa).join(", ");

  // 3 · EL NEUMÁTICO QUE YA SE COBRA APARTE. Bloquea la propuesta y enseña las dos cifras: el
  //     ERP no puede saber si esa orden fue una compra de llantas o una revisión que las
  //     menciona, y aplicar de un clic un número que quizá las cuenta dos veces es peor que
  //     pedir que se teclee.
  const neumOts = aportan.reduce((s, p) => s + p.serie.resumen.neumaticosOts, 0);
  if (neumOts > 0) {
    const neumSoles = red2(aportan.reduce((s, p) => s + p.serie.resumen.neumaticosCosto, 0));
    const sin = g.km > 0 ? red4((g.soles - neumSoles) / g.km) : null;
    return no("revisar_neumaticos",
      `Se midió ${fmt4(g.tasa)} S/km, pero ${neumOts} orden(es) por ${fmtS(neumSoles)} parecen compra de ` +
      "llantas — y este mismo tipo ya cobra los neumáticos en su propio renglón, así que aplicarlo " +
      `tal cual los contaría dos veces. Sin ellas la tasa sería ${fmt4(sin)} S/km. Las dos cifras están ` +
      "a la vista: el número lo tecleas tú en la celda.",
      { medido: g.tasa, medidoSinNeumaticos: sin, soles: g.soles, km: g.km, tramos: g.tramos,
        reciente: base.reciente, desvio: base.desvio });
  }

  // 4 · CON DOS O MÁS VOTANTES NO SE PROPONE: se enseñan y decide una persona. Mismo criterio
  //     —y misma falta deliberada de umbral de dispersión— que el rendimiento medido.
  if (aportan.length >= 2) {
    const detalle = aportan.map((p) => `${p.placa} ${fmt4(p.serie.resumen.soleskm)}`).join(" · ");
    return no("varias_placas",
      `Lo miden ${aportan.length} unidades y no dan lo mismo: ${detalle}. Juntas dan ${fmt4(g.tasa)} S/km ` +
      `sobre ${fmtKm(g.km)} km, pero cuál va al parámetro lo decides tú.`,
      { medido: g.tasa, soles: g.soles, km: g.km, tramos: g.tramos, reciente: base.reciente, desvio: base.desvio });
  }

  // 5 · YA SE REVISÓ Y NO SE ADOPTÓ.
  if (procedencia.descartado !== null && g.tasa !== null &&
      Math.abs(procedencia.descartado - g.tasa) < PASO_MANTENIMIENTO) {
    return no("descartado",
      `Ya revisaste esta medición (${fmt4(g.tasa)} S/km) y decidiste conservar el número tecleado. ` +
      "Vuelve a proponerse solo si lo medido se mueve.",
      { medido: g.tasa, soles: g.soles, km: g.km, tramos: g.tramos, reciente: base.reciente, desvio: base.desvio });
  }

  // 6 · YA COINCIDEN. El paso es el del propio campo: por debajo de eso no hay nada que aplicar.
  if (g.tasa !== null && Math.abs(g.tasa - parametro.mantenimiento_km) < PASO_MANTENIMIENTO) {
    return no("coincide",
      `El número tecleado ya coincide con lo que gasta ${placasTxt}.`,
      { medido: g.tasa, soles: g.soles, km: g.km, tramos: g.tramos, reciente: base.reciente, desvio: base.desvio });
  }

  return {
    ...base,
    codigo: "medido",
    proponible: true,
    detalle:
      `${placasTxt} gastó ${fmtS(g.soles)} de mantenimiento en ${fmtKm(g.km)} km (${g.tramos} tramo(s)) = ` +
      `${fmt4(g.tasa)} S/km, contra los ${fmt4(parametro.mantenimiento_km)} tecleados. Es un PISO: solo ` +
      "cuenta lo asentado como orden de trabajo — un repuesto pagado por caja chica y no registrado no está aquí.",
  };
}

/**
 * Tasa de los últimos `DIAS_RECIENTE` días, agrupada. Es EVIDENCIA: no entra en la propuesta
 * (ver la decisión 2 de la cabecera — una reparación mayor dentro de la ventana publicaría una
 * tasa que la unidad no hace todos los meses).
 *
 * Se suman los SOLES y los KM que cada serie ya dejó calculados, nunca sus tasas: promediar
 * tasas le daría el mismo peso a la unidad que hizo 3 000 km que a la que hizo 60 000.
 */
function tasaReciente(placas: PlacaMantenimiento[]): number | null {
  let soles = 0, km = 0;
  for (const p of placas) {
    soles += p.serie.resumen.recienteSoles;
    km += p.serie.resumen.recienteKm;
  }
  return km > 0 ? red4(soles / km) : null;
}

function desvioDe(parametro: number, medido: number | null): number | null {
  return parametro > 0 && medido !== null ? (medido - parametro) / parametro : null;
}

const fmt4 = (n: number | null) => (n === null ? "—" : n.toFixed(2));
const fmtS = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtKm = (n: number) => n.toLocaleString("es-PE");

/** El agregado de cada tipo. Las placas se reparten por su `tipo_vehiculo_costeo` CRUDO. */
export function agregarMantenimientoPorTipo(
  parametros: ParametroMant[],
  placas: PlacaMantenimiento[],
  procedencias: Map<string, ProcedenciaMant> = new Map()
): Map<string, AgregadoMant> {
  const porTipo = new Map<string, PlacaMantenimiento[]>();
  for (const p of placas) {
    const k = (p.tipoCosteo ?? "").trim();
    if (!k) continue;                       // nunca al cubo `null`: sería un tipo fantasma
    if (!porTipo.has(k)) porTipo.set(k, []);
    porTipo.get(k)!.push(p);
  }
  const out = new Map<string, AgregadoMant>();
  for (const par of parametros) {
    out.set(par.tipo_vehiculo, agregarMantenimientoTipo(
      par,
      porTipo.get(par.tipo_vehiculo) ?? [],
      procedencias.get(par.tipo_vehiculo) ?? SIN_PROCEDENCIA_MANT
    ));
  }
  return out;
}

// ─── TEXTOS Y HISTORIAL ───────────────────────────────────────────────────────

const ETIQUETAS_MANT: Record<CodigoMant, string> = {
  medido: "medido",
  coincide: "ya coincide",
  descartado: "revisado y no adoptado",
  revisar_neumaticos: "revisa las llantas",
  varias_placas: "lo miden varias unidades",
  sin_placas: "ninguna unidad lo mide",
  estimado_por_plan: "estimado por el plan",
  sin_mantenimiento: "sin órdenes registradas",
  sin_kilometraje: "órdenes sin kilometraje",
  una_sola_orden: "falta la segunda orden",
  kilometraje_incoherente: "kilometrajes que no encadenan",
  pocos_registros: "pocos tramos",
  solo_terceros: "solo unidades de tercero",
};

/** Un código sin etiqueta imprime el código crudo — el bug de `multiples_recargas_en_cluster`. */
export function etiquetaMant(c: CodigoMant): string {
  return ETIQUETAS_MANT[c] ?? c;
}

/** El `campo_modificado` de la fila que registra una medición REVISADA y no adoptada. No es una
 *  columna de `parametros_costos`: es un registro de decisión, no de cambio. */
export const CAMPO_DESCARTE_MANT = "mantenimiento_km_medido";

/** Los campos de `historial_costos` que hablan del mantenimiento de un tipo. */
export const CAMPOS_PROCEDENCIA_MANT = ["mantenimiento_km", CAMPO_DESCARTE_MANT];

/**
 * El motivo que va a `historial_costos`. El número DELANTE: esa columna se pinta truncada a
 * `max-w-[180px]`, así que lo que se corta tiene que ser lo prescindible.
 *
 * EL PREFIJO "Auto:" NO ES DECORACIÓN: `procedenciaMantDeHistorial` reconoce una adopción por
 * él, así que quien escribe y quien lee derivan la clave por el mismo camino — la regla que este
 * repo pagó tres veces en un solo día.
 */
export function motivoHistorialMant(a: AgregadoMant): string {
  const placas = a.aportan.map((p) => p.placa).join(", ");
  return `Auto: medido ${fmt4(a.medido)} S/km · ${fmtS(a.soles)} en ${fmtKm(a.km)} km · ${a.tramos} tramos · ${placas}`
    .replace(/\s+/g, " ").trim();
}

/**
 * La procedencia, DERIVADA de `historial_costos`. Sin columnas nuevas: el hecho ya está
 * registrado una vez y copiarlo obligaría a mantener dos verdades.
 *
 * NO se reutiliza `procedenciaDeHistorial` (rendimiento-tipo.ts) aunque la forma sea parecida:
 * aquella CADUCA su sello cuando cambia `tipo_combustible_1`, porque un km/gal de diésel no
 * describe una unidad que pasó a GLP. Aquí no hay ningún campo que invalide la medición —
 * el mantenimiento medido sigue siendo el de esa flota pase lo que pase con el combustible—, y
 * heredar esa caducidad borraría sellos sin motivo.
 */
export function procedenciaMantDeHistorial(
  filas: {
    campo_modificado: string; valor_nuevo: number | null; motivo: string | null;
    cambiado_por: string | null; cambiado_en: string;
  }[]
): ProcedenciaMant {
  const orden = [...filas].sort((a, b) => String(a.cambiado_en).localeCompare(String(b.cambiado_en)));
  let out: ProcedenciaMant = { ...SIN_PROCEDENCIA_MANT };
  for (const f of orden) {
    if (f.campo_modificado === "mantenimiento_km") {
      out = String(f.motivo ?? "").startsWith("Auto:")
        ? { origen: "medido", fecha: f.cambiado_en, por: f.cambiado_por, descartado: out.descartado }
        : { origen: "manual", fecha: f.cambiado_en, por: f.cambiado_por, descartado: out.descartado };
    } else if (f.campo_modificado === CAMPO_DESCARTE_MANT) {
      out = { ...out, descartado: f.valor_nuevo };
    }
  }
  return out;
}

// ─── LA EDAD DE LA FLOTA CONTRA LA FICHA ──────────────────────────────────────
//
// POR QUÉ EXISTE, Y ES LA OTRA MITAD DE LA PREGUNTA "PREMIUM vs ESTÁNDAR".
//
// `parametros_costos` deprecia con UNA sola cifra por tipo: `valor_compra`, `residual_pct`,
// `vida_util_anios` y `km_anio`. Eso describe una unidad, no dos. Cuando la misma ficha se le
// asigna a un bus de 2022 comprado 0 km y a uno de 2009 comprado al 25 % de su valor, esa cifra
// está mal para los dos a la vez: infla el costo del viejo (que costó una cuarta parte) y
// desinfla el del nuevo si alguien la corrige hacia abajo pensando en el usado.
//
// El dato para verlo ya existe y nadie lo cruzaba: `vehiculos.anio`. Esto no mide nada nuevo —
// cruza dos columnas que ya están escritas, igual que `cotejarFichaConTanques`.
//
// NO DECIDE NI ESCRIBE: devuelve un código. Y no inventa ningún umbral — el que usa es la VIDA
// ÚTIL que declara la propia ficha.

export type CodigoAntiguedad =
  /** Dos unidades separadas por más de una vida útil comparten la misma ficha. */
  | "mezcla"
  /** Alguna unidad ya superó la vida útil que su ficha declara. */
  | "supera_vida"
  /** Las edades caben dentro de la vida útil de la ficha. */
  | "coherente"
  /** Ninguna unidad tiene año de fabricación: no hay con qué cotejar. */
  | "sin_anio"
  /** Ninguna unidad apunta a este tipo. */
  | "sin_placas";

export type UnidadConEdad = {
  placa: string;
  flota: Flota;
  anio: number | null;
  /** Años cumplidos al año de referencia. null sin `anio`. */
  edad: number | null;
  superaVida: boolean;
};

export type AntiguedadTipo = {
  tipoVehiculo: string;
  codigo: CodigoAntiguedad;
  vidaUtil: number;
  minAnio: number | null;
  maxAnio: number | null;
  /** Años entre la unidad más vieja y la más nueva. */
  brecha: number | null;
  unidades: UnidadConEdad[];
  sinAnio: number;
  detalle: string;
};

/**
 * ¿La edad real de las unidades cabe en la ficha con la que se las deprecia?
 *
 * @param anioRef  El año contra el que se mide la edad. Se recibe, no se lee del reloj: el
 *                 módulo es puro y la matriz tiene que poder fijar un resultado.
 */
export function cotejarAntiguedadTipo(
  parametro: { tipo_vehiculo: string; vida_util_anios: number },
  placas: PlacaMantenimiento[],
  anioRef: number
): AntiguedadTipo {
  const vida = Number(parametro.vida_util_anios || 0);
  const unidades: UnidadConEdad[] = placas.map((p) => {
    const anio = p.anio && p.anio > 1900 ? p.anio : null;
    const edad = anio !== null ? anioRef - anio : null;
    return {
      placa: p.placa, flota: p.flota, anio, edad,
      superaVida: edad !== null && vida > 0 && edad > vida,
    };
  });
  const conAnio = unidades.filter((u) => u.anio !== null);
  const sinAnio = unidades.length - conAnio.length;
  const base = { tipoVehiculo: parametro.tipo_vehiculo, vidaUtil: vida, unidades, sinAnio };

  if (!placas.length) {
    return { ...base, codigo: "sin_placas", minAnio: null, maxAnio: null, brecha: null, detalle: "" };
  }
  if (!conAnio.length) {
    // NO se afirma que la ficha esté mal: no hay con qué compararla. Misma regla que
    // `sin_tanques` en `cotejarFichaConTanques` y que el tri-estado del semáforo de puntualidad.
    return {
      ...base, codigo: "sin_anio", minAnio: null, maxAnio: null, brecha: null,
      detalle:
        "Ninguna unidad de este tipo tiene año de fabricación, así que el ERP no puede comprobar que la " +
        "depreciación de esta ficha describa a la flota que la usa. Se llena en /vehiculos → Editar → Año.",
    };
  }

  const anios = conAnio.map((u) => u.anio as number);
  const minAnio = Math.min(...anios);
  const maxAnio = Math.max(...anios);
  const brecha = maxAnio - minAnio;
  const viejas = conAnio.filter((u) => u.superaVida);

  // EL UMBRAL NO SE INVENTA: es la vida útil que la propia ficha declara. Si dos unidades están
  // separadas por una vida útil entera, cuando la nueva se compró la vieja ya debía estar
  // amortizada — y las dos se están costeando con el mismo `valor_compra`.
  if (vida > 0 && brecha >= vida) {
    return {
      ...base, codigo: "mezcla", minAnio, maxAnio, brecha,
      detalle:
        `Esta ficha se aplica a unidades de ${minAnio} y ${maxAnio} —${brecha} años de diferencia, más que ` +
        `la vida útil de ${vida} años que ella misma declara— y deprecia a todas con un solo valor de compra. ` +
        "Una unidad comprada usada cuesta una fracción de una 0 km, así que un solo número está mal para las " +
        "dos: la separación correcta es DUPLICAR la categoría (una premium y una estándar) y reasignar cada " +
        "placa en /vehiculos → Categoría de costeo. Ojo: al hacerlo, la estándar necesita también su propia " +
        "vida útil RESTANTE y su propio mantenimiento — bajar solo la depreciación la deja más barata de lo que es.",
    };
  }
  if (viejas.length) {
    return {
      ...base, codigo: "supera_vida", minAnio, maxAnio, brecha,
      detalle:
        `${viejas.map((u) => `${u.placa} (${u.anio}, ${u.edad} años)`).join(", ")} ya superó los ${vida} años de ` +
        "vida útil de esta ficha. Si se compró usada, su valor de compra y su vida útil RESTANTE no son los de " +
        "esta categoría; si ya está amortizada, su depreciación real es otra (la contable de esa placa vive en " +
        "`activos_fijos` y manda sobre el parámetro en el presupuesto de cada servicio).",
    };
  }
  return {
    ...base, codigo: "coherente", minAnio, maxAnio, brecha,
    detalle: `Las unidades de este tipo son de ${minAnio}${maxAnio !== minAnio ? `–${maxAnio}` : ""}, dentro de los ${vida} años de vida útil de la ficha.`,
  };
}

export function cotejarAntiguedadPorTipo(
  parametros: { tipo_vehiculo: string; vida_util_anios: number }[],
  placas: PlacaMantenimiento[],
  anioRef: number
): Map<string, AntiguedadTipo> {
  const porTipo = new Map<string, PlacaMantenimiento[]>();
  for (const p of placas) {
    const k = (p.tipoCosteo ?? "").trim();
    if (!k) continue;
    if (!porTipo.has(k)) porTipo.set(k, []);
    porTipo.get(k)!.push(p);
  }
  const out = new Map<string, AntiguedadTipo>();
  for (const par of parametros) {
    out.set(par.tipo_vehiculo, cotejarAntiguedadTipo(par, porTipo.get(par.tipo_vehiculo) ?? [], anioRef));
  }
  return out;
}

const ETIQUETAS_ANTIGUEDAD: Record<CodigoAntiguedad, string> = {
  mezcla: "mezcla flota nueva y usada",
  supera_vida: "superó su vida útil",
  coherente: "edades coherentes",
  sin_anio: "sin año de fabricación",
  sin_placas: "ninguna unidad",
};

export function etiquetaAntiguedad(c: CodigoAntiguedad): string {
  return ETIQUETAS_ANTIGUEDAD[c] ?? c;
}
