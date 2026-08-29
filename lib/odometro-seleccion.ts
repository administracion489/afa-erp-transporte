// lib/odometro-seleccion.ts
// Elige CUÁL de los números que la IA leyó en un tablero es el odómetro total.
//
// Por qué existe: en los tableros digitales conviven el parcial ("TRIP", con decimales) y el
// total. Un modelo de visión transcribe ambos bien y aun así los intercambia de campo — caso
// real de BUI-272: devolvió {kilometraje: 1803, trip_km: 174159} con el total correcto viajando
// dentro del mismo JSON, y ninguna línea de código lo miraba. Ningún prompt garantiza que eso
// no vuelva a pasar; el km vigente del vehículo sí lo decide sin ambigüedad.
//
// El segundo modo de fallo, el de CUP-435: la lectura trae UN DÍGITO DE MÁS AL FINAL — 22.744
// transcrito como 227.447, el mismo número ×10. Ahí no hay que elegir otro número del tablero:
// hay que quitarle el dígito sobrante al que ya se leyó (ver kmSinDigitoDeMas).
//
// De dónde sale ese dígito NO se afirma aquí. En algunos tableros es la décima del total; en
// CUP-435 no —el operador verificó la unidad en físico: su odómetro es de enteros, sin décimas—
// así que ahí el dígito lo añade la lectura (un vecino de la pantalla, un segmento mal leído).
// La corrección no depende de la causa: se prueba por la FORMA del número y por el kilometraje
// que el ERP ya conoce de la unidad, que es lo único verificable desde el código.
//
// Reglas de diseño (aprendidas de la revisión adversarial de este fix):
//   1. NUNCA inventa. Si el modelo se abstuvo (kmIA null), el resultado se abstiene también.
//   2. NUNCA impide registrar. Cuando no puede decidir devuelve el número de la IA tal cual
//      (queda "sospechosa" como hoy y sigue apareciendo en la bandeja con su foto, que es
//      donde el operador la corrige y donde nace el dataset de aprendizaje).
//   3. Sin ancla (vehículo sin km vigente) el comportamiento es idéntico al de hoy.
//   4. Los números sueltos del texto libre solo DESEMPATAN; nunca ganan solos.

export type CandidatoOdometro = {
  valor: number;
  fuente: "kilometraje" | "trip" | "texto";
  decimal: boolean;   // el texto crudo lo mostraba con decimales → huele a parcial
  enBanda: boolean;
};

export type VeredictoOdometro = {
  /** El km a registrar. null solo si la IA no leyó nada. */
  km: number | null;
  /** Lo que la IA había puesto en el campo kilometraje (para auditoría). */
  kmIA: number | null;
  origen: "ia" | "corregido";
  /** true = se puede seguir el curso normal; false = hay que mirarlo (no bloquea el registro). */
  autoOk: boolean;
  motivo: string | null;
  candidatos: CandidatoOdometro[];
};

/** Un odómetro plausible tiene entre 3 y 7 dígitos (mismo criterio que ya usaba el Radar). */
function formaValida(n: number): boolean {
  if (!Number.isFinite(n) || n <= 0) return false;
  const d = Math.round(n).toString().length;
  return d >= 3 && d <= 7;
}

/** Cuántos dígitos tiene el entero: la FORMA del número, que es lo que delata el dígito de más. */
function digitosDe(n: number): number {
  return Math.abs(Math.round(n)).toString().length;
}

const fmt = (n: number) => Math.round(n).toLocaleString("es-PE");

/**
 * ¿El número leído es el kilometraje de la unidad con UN DÍGITO DE MÁS AL FINAL (×10)?
 *
 * Es el error sistemático de CUP-435: 22.744 transcrito como 227.447 foto tras foto, hasta
 * morir todas en "Lecturas por revisar", donde el único botón verde ("Aceptar") habría escrito
 * 230.056 km como km vigente de una unidad que va por 23.005.
 *
 * Solo mira la FORMA, no la causa (el tablero de CUP-435 no tiene décimas: verificado en
 * físico): exige que el número tenga EXACTAMENTE un dígito más que la base conocida y que, al
 * quitarle el último, caiga dentro del rango plausible de la unidad. Si algo de eso no encaja
 * devuelve null y el caso sigue su curso normal (revisión humana).
 *
 * Se quita SIEMPRE el último dígito, nunca uno intermedio: es donde aparece de hecho (los
 * dígitos de la izquierda coinciden con la serie real de la unidad), y probar otras posiciones
 * daría dos candidatos plausibles a la vez, o sea una corrección adivinada.
 */
export function kmSinDigitoDeMas(opts: {
  kmLeido: number;
  kmBase: number;   // km vigente / última lectura viva de la unidad
  piso: number;     // mínimo plausible (anti-retroceso)
  techo: number;    // máximo plausible (anti-salto)
}): number | null {
  const leido = Math.round(Number(opts.kmLeido));
  const base = Math.round(Number(opts.kmBase));
  if (!Number.isFinite(leido) || !Number.isFinite(base) || leido <= 0 || base <= 0) return null;
  if (digitosDe(leido) !== digitosDe(base) + 1) return null;
  const sinUltimo = Math.floor(leido / 10);
  if (!formaValida(sinUltimo)) return null;
  return sinUltimo >= opts.piso && sinUltimo <= opts.techo ? sinUltimo : null;
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
    km: kmIA, kmIA, origen: "ia", autoOk, motivo, candidatos: [],
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
  // medir: solo se le aplica el piso anti-retroceso, nunca un techo que la deje ciega.
  const techo = e.hayHistorial ? kmVigente + (e.kmDiaMax > 0 ? e.kmDiaMax : 1500) * dias : Infinity;

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
  if (kmIAEnBanda) return { km: kmIA, kmIA, origen: "ia", autoOk: true, motivo: null, candidatos: bruto };

  // (4) La IA eligió algo imposible. ¿Hay OTRO número del tablero que sí encaje?
  //     Solo los que el modelo designó explícitamente (kilometraje/trip) pueden ganar: un
  //     entero rescatado de la prosa serviría para desempatar, nunca para decidir solo.
  const designados = enBanda.filter((c) => c.fuente !== "texto");
  const elegibles = designados.length ? designados : [];

  // Candidato "sin el dígito de más": el MISMO número que leyó la IA, sin su último dígito. No
  // es otro número del tablero, así que no compite con los designados —solo entra cuando
  // ninguno de ellos resuelve el caso— pero cuando la forma encaja es la explicación más
  // probable de un valor ×10 (ver kmSinDigitoDeMas).
  const sinSobrante = kmSinDigitoDeMas({ kmLeido: kmIA, kmBase: kmVigente, piso, techo });
  const corroboraTexto = sinSobrante != null && delTexto.some((t) => t.decimal && t.valor === sinSobrante);
  const corregirSobrante = (): VeredictoOdometro => ({
    km: sinSobrante!,
    kmIA,
    origen: "corregido",
    autoOk: true,
    motivo:
      `la IA devolvió ${fmt(kmIA)}, imposible para esta unidad (vigente ${fmt(kmVigente)}): es su lectura con un ` +
      `DÍGITO DE MÁS al final${corroboraTexto ? " (en el texto leído ese último dígito va separado)" : ""}; ` +
      `el sistema registró ${fmt(sinSobrante!)}`,
    candidatos: bruto,
  });

  if (elegibles.length === 0) {
    if (sinSobrante != null) return corregirSobrante();
    const detalle = enBanda.length
      ? `la IA devolvió ${fmt(kmIA)}, imposible para esta unidad (vigente ${fmt(kmVigente)}), y ningún número leído del tablero encaja`
      : `la IA devolvió ${fmt(kmIA)}, imposible para esta unidad (vigente ${fmt(kmVigente)})`;
    return { km: kmIA, kmIA, origen: "ia", autoOk: false, motivo: detalle, candidatos: bruto };
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
    // Antes de mandarlo a revisión: si el número de la IA era el de siempre con un dígito de
    // más al final, esa sí es una lectura (no un eco) y resuelve el caso.
    if (sinSobrante != null) return corregirSobrante();
    return {
      km: kmIA, kmIA, origen: "ia", autoOk: false,
      motivo: `la IA devolvió ${fmt(kmIA)} y el único número compatible (${fmt(ganador.valor)}) coincide con el km vigente — puede ser un eco, no una lectura`,
      candidatos: bruto,
    };
  }

  return {
    km: ganador.valor,
    kmIA,
    origen: "corregido",
    autoOk: true,
    motivo: `la IA devolvió ${fmt(kmIA)} (${ganador.fuente === "trip" ? "el parcial/trip" : "un valor imposible"}); el sistema registró ${fmt(ganador.valor)}, el único número del tablero coherente con el vigente ${fmt(kmVigente)}`,
    candidatos: bruto,
  };
}
