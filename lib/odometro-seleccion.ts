// lib/odometro-seleccion.ts
// Elige CUÁL de los números que la IA leyó en un tablero es el odómetro total.
//
// Por qué existe: en los tableros digitales conviven el parcial ("TRIP", con decimales) y el
// total. Un modelo de visión transcribe ambos bien y aun así los intercambia de campo — caso
// real de BUI-272: devolvió {kilometraje: 1803, trip_km: 174159} con el total correcto viajando
// dentro del mismo JSON, y ninguna línea de código lo miraba. Ningún prompt garantiza que eso
// no vuelva a pasar; el km vigente del vehículo sí lo decide sin ambigüedad.
//
// Reglas de diseño (aprendidas de la revisión adversarial de este fix):
//   1. NUNCA inventa. Si el modelo se abstuvo (kmIA null), el resultado se abstiene también.
//   2. NUNCA impide registrar. Cuando no puede decidir devuelve el número de la IA tal cual
//      (queda "sospechosa" como hoy y sigue apareciendo en la bandeja con su foto, que es
//      donde el operador la corrige y donde nace el dataset de aprendizaje).
//   3. Sin ancla (vehículo sin km vigente) el comportamiento es idéntico al de hoy.
//   4. Los números sueltos del texto libre solo DESEMPATAN; nunca ganan solos.
//   5. NO ADIVINA QUÉ DÍGITO SOBRA. Ver `codigo: "digito_de_mas"` más abajo: de 239.980 salen
//      tres borrados distintos que caen dentro de lo posible (23.980, 23.990, 23.998) y elegir
//      uno sería escribir un kilometraje al azar. Se NOMBRA el defecto y lo teclea una persona
//      mirando la foto — el mismo criterio que `cuadre_ambiguo` en el voucher de grifo.

import { RATIO_DIGITO_DE_MAS, PISO_RATIO_DIGITO } from "./odometro";

export type CandidatoOdometro = {
  valor: number;
  fuente: "kilometraje" | "trip" | "texto";
  decimal: boolean;   // el texto crudo lo mostraba con decimales → huele a parcial
  enBanda: boolean;
};

/**
 * Qué le pasa a la lectura, en un código que la pantalla puede enrutar sin olfatear el texto
 * del motivo (misma regla que los bloqueos de /liquidaciones y las anomalías del Radar):
 *   - `digito_de_mas`  la IA devolvió MÁS dígitos de los que tiene el odómetro de la unidad.
 *                      Es el error más frecuente de esta flota y tiene arreglo propio: mirar
 *                      la foto y teclear el número (nadie puede deducir cuál dígito sobra).
 *   - `fuera_de_banda` el número es imposible para la unidad por otra razón (retrocede, salta).
 *   - `eco`            el único número compatible clava el vigente: huele a que el modelo
 *                      repitió un dato que ya conocía en vez de leer la foto.
 *   - `parcial`        se registró otro número del tablero porque la IA entregó el trip.
 */
export type CodigoOdometro = "digito_de_mas" | "fuera_de_banda" | "eco" | "parcial";

export type VeredictoOdometro = {
  /** El km a registrar. null solo si la IA no leyó nada. */
  km: number | null;
  /** Lo que la IA había puesto en el campo kilometraje (para auditoría). */
  kmIA: number | null;
  origen: "ia" | "corregido";
  /** true = se puede seguir el curso normal; false = hay que mirarlo (no bloquea el registro). */
  autoOk: boolean;
  motivo: string | null;
  /** null cuando no hay nada que señalar (lectura normal o sin ancla contra qué juzgarla). */
  codigo: CodigoOdometro | null;
  candidatos: CandidatoOdometro[];
};

/** Un odómetro plausible tiene entre 3 y 7 dígitos (mismo criterio que ya usaba el Radar). */
function formaValida(n: number): boolean {
  if (!Number.isFinite(n) || n <= 0) return false;
  const d = Math.round(n).toString().length;
  return d >= 3 && d <= 7;
}

const fmt = (n: number) => Math.round(n).toLocaleString("es-PE");

/** Cuántas cifras tiene un kilometraje. Es la FORMA del número, no su valor. */
export function digitosDe(n: number): number {
  return Math.round(Math.abs(Number(n) || 0)).toString().length;
}

/**
 * Aviso sobre un kilometraje que está EN UN CAMPO DE PANTALLA, antes de guardarlo — el que la
 * IA pre-llenó o el que acaba de teclear una persona. Lo usa el panel de revisión de
 * `/radar-ia?tab=combustible`, donde la recarga viene con su odómetro leído del tablero.
 *
 * Se limita A PROPÓSITO al salto de orden de magnitud, que es la única rama de
 * `evaluarLectura` que depende SOLO del km vigente y por tanto no puede dar un falso ámbar:
 *
 *   · el vigente es el MÁXIMO histórico, así que nada legítimo lo multiplica por ocho —
 *     ni una lectura retroactiva ni una unidad que estuvo parada;
 *   · en cambio "menor al vigente" SÍ puede ser legítimo (un voucher de hace tres días que
 *     se procesa hoy), y avisarlo aquí sería el ámbar que sale siempre y enseña a ignorarlos.
 *     De ese lado juzga `registrarLectura` al guardar, con las lecturas vecinas en la mano,
 *     y devuelve su veredicto para que la pantalla lo diga.
 *
 * Comparte constantes con quien escribe (`RATIO_DIGITO_DE_MAS`/`PISO_RATIO_DIGITO`), que es lo
 * que impide el choque de "bueno para la pantalla, dígito de más para la base".
 */
export type AvisoKmTecleado = { codigo: Extract<CodigoOdometro, "digito_de_mas">; aviso: string };

export function revisarKmTecleado(e: {
  km: number | null | undefined;
  kmVigente: number | null | undefined;
}): AvisoKmTecleado | null {
  const km = Number(e.km);
  const vigente = Number(e.kmVigente || 0);
  if (!Number.isFinite(km) || km <= 0) return null;
  // Sin ancla, o con el odómetro bajo (unidad nueva), un ×8 legítimo existe: no se juzga.
  if (vigente < PISO_RATIO_DIGITO) return null;
  if (km < vigente * RATIO_DIGITO_DE_MAS) return null;

  const dKm = digitosDe(km), dVig = digitosDe(vigente);
  return {
    codigo: "digito_de_mas",
    aviso:
      dKm > dVig
        ? `${fmt(km)} tiene ${dKm} dígitos y el odómetro de esta unidad tiene ${dVig} (vigente ${fmt(vigente)}): sobra un dígito. Míralo en la foto y escríbelo.`
        : `${fmt(km)} es ${Math.round(km / vigente)} veces el kilometraje vigente (${fmt(vigente)}): revisa el número en la foto.`,
  };
}

/**
 * Extrae números del texto libre que la IA devuelve como `texto_leido`. Es prosa, no una
 * lista ("1431.9 km (pantalla superior) y 1737787 (número mayor inferior)"), por eso lo que
 * salga de aquí solo sirve para desempatar: un número que el modelo nunca designó como
 * odómetro no puede convertirse en el dato registrado.
 */
function numerosDeTexto(texto: string | null | undefined): { valor: number; decimal: boolean }[] {
  if (!texto) return [];
  const out: { valor: number; decimal: boolean }[] = [];
  for (const m of String(texto).matchAll(/\d[\d.,]*/g)) {
    const crudo = m[0];
    // Separadores de miles vs decimal: "174,159" y "174.159" son el mismo entero; "1803.6" no.
    const decimal = /[.,]\d{1,2}$/.test(crudo);
    const entero = Number(crudo.replace(/[.,]/g, ""));
    const valor = decimal ? Math.floor(entero / Math.pow(10, crudo.length - 1 - crudo.search(/[.,]\d{1,2}$/))) : entero;
    if (Number.isFinite(valor) && valor > 0) out.push({ valor, decimal });
  }
  return out;
}

export function elegirOdometro(e: {
  kmIA: number | null;
  tripIA: number | null;
  textoLeido?: string | null;
  kmVigente: number;
  kmDiaMax: number;
  horasDesdeUltima: number | null;
  hayHistorial: boolean;
}): VeredictoOdometro {
  const kmIA = e.kmIA != null && Number.isFinite(e.kmIA) && e.kmIA > 0 ? Math.round(e.kmIA) : null;
  const neutro = (motivo: string | null = null, autoOk = true): VeredictoOdometro => ({
    km: kmIA, kmIA, origen: "ia", autoOk, motivo, codigo: null, candidatos: [],
  });

  // (1) La abstención del modelo manda: si no leyó un número, aquí no se fabrica uno.
  if (kmIA == null) return neutro(null, false);

  // (2) Sin ancla no hay nada contra qué comparar → exactamente el comportamiento de hoy.
  const kmVigente = Number(e.kmVigente || 0);
  if (kmVigente <= 0) return neutro();

  // ── Banda de lo posible para ESTA unidad ───────────────────────────────────────────────
  // Piso: el odómetro no retrocede (con la misma tolerancia de ruido que evaluarLectura).
  // Techo: el mismo presupuesto km/día del anti-salto, con el fallback de 30 días cuando no
  // se sabe cuánto tiempo pasó (si se usara 1 día se estrecharía 30 veces y rechazaría
  // lecturas legítimas de unidades sin historial reciente).
  const tol = Math.max(5, Math.round(kmVigente * 0.001));
  const piso = kmVigente - tol;
  const dias = e.horasDesdeUltima != null && e.horasDesdeUltima > 0
    ? Math.max(e.horasDesdeUltima / 24, 1)
    : 30;
  // Una unidad dada de alta con su odómetro a mano (sin ninguna lectura) no tiene ritmo que
  // medir: no se le aplica el techo de km/día, que la dejaría ciega.
  const techoRitmo = e.hayHistorial ? kmVigente + (e.kmDiaMax > 0 ? e.kmDiaMax : 1500) * dias : Infinity;
  // …pero SÍ el de orden de magnitud, que es el mismo que evaluarLectura aplica al escribir y
  // que no necesita ninguna historia: le basta el km vigente. Sin él, `hayHistorial === false`
  // dejaba el techo en Infinity y un 239.980 sobre una unidad que va en 23.980 salía "en banda"
  // → la pantalla lo pre-llenaba como bueno y, al guardarlo, evaluarLectura lo marcaba "Salto
  // ×10: posible dígito de más". El mismo número, dos veredictos opuestos, con la lectura mala
  // ya tecleada. Y `hayHistorial` no es solo "unidad nueva": una unidad cuyas lecturas van
  // TODAS a sospechosa se queda sin ninguna viva, así que el agujero se realimentaba —
  // el segundo dígito de más entraba tan liso como el primero.
  const techoRatio = kmVigente >= PISO_RATIO_DIGITO ? kmVigente * RATIO_DIGITO_DE_MAS - 1 : Infinity;
  const techo = Math.min(techoRitmo, techoRatio);

  // ── Candidatos ─────────────────────────────────────────────────────────────────────────
  const bruto: CandidatoOdometro[] = [];
  const push = (valor: number | null | undefined, fuente: CandidatoOdometro["fuente"], decimal: boolean) => {
    if (valor == null || !formaValida(valor)) return;
    const v = Math.round(valor);
    const ya = bruto.find((c) => c.valor === v);
    if (ya) { ya.decimal = ya.decimal || decimal; return; }
    bruto.push({ valor: v, fuente, decimal, enBanda: false });
  };
  const delTexto = numerosDeTexto(e.textoLeido);
  const decimalEnTexto = (v: number) => delTexto.some((t) => t.valor === v && t.decimal);

  push(kmIA, "kilometraje", decimalEnTexto(kmIA));
  push(e.tripIA, "trip", true); // el parcial es parcial por definición
  for (const t of delTexto) push(t.valor, "texto", t.decimal);

  for (const c of bruto) c.enBanda = c.valor >= piso && c.valor <= techo;
  const enBanda = bruto.filter((c) => c.enBanda);

  const kmIAEnBanda = enBanda.some((c) => c.valor === kmIA);

  // (3) Lo que la IA eligió encaja con la realidad de la unidad → no se toca nada.
  if (kmIAEnBanda) return { km: kmIA, kmIA, origen: "ia", autoOk: true, motivo: null, codigo: null, candidatos: bruto };

  // (4) La IA eligió algo imposible. ¿Hay OTRO número del tablero que sí encaje?
  //     Solo los que el modelo designó explícitamente (kilometraje/trip) pueden ganar: un
  //     entero rescatado de la prosa serviría para desempatar, nunca para decidir solo.
  const designados = enBanda.filter((c) => c.fuente !== "texto");
  const elegibles = designados.length ? designados : [];

  if (elegibles.length === 0) {
    // Cuando el número tiene MÁS CIFRAS que el odómetro de la unidad, el defecto tiene nombre y
    // arreglo propio: sobra un dígito. Decir solo "imposible para esta unidad" obliga a deducir
    // qué pasó mirando dos números grandes; decir "leyó 6 dígitos y esta unidad tiene 5" es una
    // instrucción. Lo que NO se hace es adivinar cuál sobra (ver la regla 5 de la cabecera).
    const dIA = digitosDe(kmIA), dVig = digitosDe(kmVigente);
    if (dIA > dVig) {
      return {
        km: kmIA, kmIA, origen: "ia", autoOk: false, codigo: "digito_de_mas", candidatos: bruto,
        motivo:
          `la IA devolvió ${fmt(kmIA)}: ${dIA} dígitos, y el odómetro de esta unidad tiene ${dVig} ` +
          `(vigente ${fmt(kmVigente)}). Sobra un dígito — el número está entre ${fmt(piso)} y ` +
          `${Number.isFinite(techo) ? fmt(techo) : "el que muestre el tablero"}: míralo en la foto y escríbelo`,
      };
    }
    const detalle = enBanda.length
      ? `la IA devolvió ${fmt(kmIA)}, imposible para esta unidad (vigente ${fmt(kmVigente)}), y ningún número leído del tablero encaja`
      : `la IA devolvió ${fmt(kmIA)}, imposible para esta unidad (vigente ${fmt(kmVigente)})`;
    return { km: kmIA, kmIA, origen: "ia", autoOk: false, motivo: detalle, codigo: "fuera_de_banda", candidatos: bruto };
  }

  // Desempate: fuera los que se leyeron con decimales (un total no los tiene), y si aún
  // quedan varios, el mayor — el parcial siempre es menor que el total en el mismo tablero.
  const sinDecimal = elegibles.filter((c) => !c.decimal);
  const finalistas = sinDecimal.length ? sinDecimal : elegibles;
  const ganador = finalistas.reduce((a, b) => (b.valor > a.valor ? b : a));

  // Guard anti-eco: un candidato que CLAVA el vigente no es una lectura, es el modelo
  // repitiendo un número que ya conocía. Se exige coincidencia casi exacta (≤2 km): la
  // tolerancia del piso (0,1% = 174 km en un odómetro de 174.000) es más que un día de
  // recorrido, y usarla aquí descartaría avances reales como si fueran ecos.
  if (Math.abs(ganador.valor - kmVigente) <= 2) {
    return {
      km: kmIA, kmIA, origen: "ia", autoOk: false, codigo: "eco",
      motivo: `la IA devolvió ${fmt(kmIA)} y el único número compatible (${fmt(ganador.valor)}) coincide con el km vigente — puede ser un eco, no una lectura`,
      candidatos: bruto,
    };
  }

  return {
    km: ganador.valor,
    kmIA,
    origen: "corregido",
    autoOk: true,
    codigo: "parcial",
    motivo: `la IA devolvió ${fmt(kmIA)} (${ganador.fuente === "trip" ? "el parcial/trip" : "un valor imposible"}); el sistema registró ${fmt(ganador.valor)}, el único número del tablero coherente con el vigente ${fmt(kmVigente)}`,
    candidatos: bruto,
  };
}
