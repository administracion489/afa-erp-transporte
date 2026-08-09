// lib/odometro.ts
// Consolidación de kilometraje (odómetro) desde múltiples fuentes con regla
// anti-retroceso y detección de saltos imposibles.
//
// Reglas (ver diseño en memoria del proyecto):
//   - El "km vigente" (vehiculos.kilometraje_actual) es un valor DERIVADO.
//   - Toda lectura se guarda SIEMPRE en lecturas_odometro (no se destruye nada).
//   - Lectura menor al vigente  → "sospechosa" (retrocede): NO actualiza el vigente.
//   - Salto improbable hacia arriba → "sospechosa" (salto): NO actualiza.
//   - Lectura normal mayor       → "aceptada": actualiza el vigente.
//   - marcarReinicio() re-ancla el vigente cuando cambian el tablero (odómetro
//     físico reemplazado), evitando que "el mayor gana" deje al bus ciego.

export type EstadoLectura = "aceptada" | "sospechosa" | "rechazada" | "reinicio" | "anulada";
export type FuenteLectura =
  | "combustible" | "checklist" | "servicio"
  | "whatsapp_foto" | "whatsapp_manual" | "manual";

export type EvalLectura = { estado: EstadoLectura; motivo: string | null };

/**
 * Lectura viva VECINA en el tiempo (la de antes o la de después de la que se evalúa).
 * `ts` es el instante EFECTIVO (capturado_en, o created_at si aquella falta).
 */
export type RefLectura = {
  km: number;
  ts: number | null;
  fuente?: string | null;
  momento?: string | null;
  foto_url?: string | null;
  /** SHA-256 del binario de la foto: identifica la MISMA imagen aunque cambie la URL. */
  foto_hash?: string | null;
  /** false = el instante viene de created_at (inserción), no de capturado_en: es aproximado. */
  horaExacta?: boolean;
};

/** Etiqueta legible de una lectura de referencia: "de las 05:09 (97,271 km)". */
function describirRef(r: RefLectura | null | undefined): string {
  if (!r) return "el km vigente";
  const hora = r.ts != null ? horaLimaDeTs(r.ts) : null;
  const cuando = hora ? (r.horaExacta === false ? `de ~${hora}` : `de las ${hora}`) : "anterior";
  return `${cuando} (${Number(r.km).toLocaleString("es-PE")} km)`;
}

/** HH:MM en hora Lima (UTC-5) a partir de un epoch ms. */
function horaLimaDeTs(ts: number): string | null {
  if (!Number.isFinite(ts)) return null;
  return new Date(ts - 5 * 3600_000).toISOString().slice(11, 16);
}

/**
 * Margen por debajo del cual un desfase de reloj es indistinguible de la latencia normal
 * (subida de la foto, cola de reintentos, redondeos). Corregir dentro de este margen sería
 * ruido; por encima, el reloj del dispositivo está realmente mal puesto.
 */
const TOLERANCIA_RELOJ_MS = 5 * 60_000;

/**
 * Cuánto puede adelantarse la hora de una lectura con hora-tope para que su kilometraje encaje.
 * Cubre el retraso real entre fotografiar el tablero y mandar el mensaje (minutos u horas);
 * más allá, la explicación probable ya no es "la foto es vieja" sino "el número está mal".
 */
const MAX_AJUSTE_HORA_MS = 24 * 3600_000;

/** "3 h 20 min" / "45 min" — para explicarle al operador cuánto miente un reloj. */
function fmtDesfase(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/**
 * Corrige la hora de captura que reporta un dispositivo usando el desfase de SU reloj.
 *
 * `capturado_en` sale de `new Date()` en el celular del conductor: si tiene la hora mal puesta,
 * miente, y con ella mienten el orden de la jornada y el juicio de retroceso. El truco es que
 * el cliente sella también el instante del ENVÍO con ese mismo reloj: comparándolo con el del
 * servidor se mide el error del reloj —sin confundirlo con el tiempo que la lectura pasó en la
 * cola offline, que afecta a ambos sellos por igual— y se le aplica a la hora de captura.
 *
 * Detecta relojes ATRASADOS, que el clamp de "no puede venir del futuro" de registrarLectura
 * no puede ver. Sin `clienteTs` (llamador que no lo manda) devuelve la hora tal cual.
 */
export function corregirCapturaPorReloj(opts: {
  capturado_en?: string | null;
  clienteTs?: string | null;   // reloj del dispositivo en el instante del envío
  ahora?: Date;                // reloj del servidor (inyectable para pruebas)
}): { capturado_en: string | null; desfaseMin: number | null; nota: string | null } {
  const cap = opts.capturado_en ?? null;
  const tsCap = tsDe(cap);
  const tsCli = tsDe(opts.clienteTs ?? null);
  const ahora = (opts.ahora ?? new Date()).getTime();
  if (tsCap == null || tsCli == null) return { capturado_en: cap, desfaseMin: null, nota: null };

  const desfase = ahora - tsCli; // > 0 → el reloj del dispositivo va ATRASADO
  const desfaseMin = Math.round(desfase / 60_000);
  if (Math.abs(desfase) <= TOLERANCIA_RELOJ_MS) return { capturado_en: cap, desfaseMin, nota: null };

  // Nunca por delante del servidor: no se puede haber capturado después de llegar aquí.
  const corregido = Math.min(tsCap + desfase, ahora);
  return {
    capturado_en: new Date(corregido).toISOString(),
    desfaseMin,
    nota: `Hora corregida: el reloj del dispositivo va ${fmtDesfase(desfase)} ${desfase > 0 ? "atrasado" : "adelantado"}`,
  };
}

/** Flota a la que pertenece la lectura. Default "propia" (retrocompatible). */
export type Flota = "propia" | "tercero";

/**
 * Resuelve la tabla del vehículo y la columna FK de lecturas_odometro según la flota.
 * Ambas tablas exponen `id` y `kilometraje_actual`, así que el resto de la lógica
 * (anti-retroceso, vigente derivado) es idéntica para propia y tercero.
 */
function targetFlota(flota: Flota | undefined): { tabla: "vehiculos" | "vehiculos_tercero"; fk: "vehiculo_id" | "vehiculo_tercero_id" } {
  return flota === "tercero"
    ? { tabla: "vehiculos_tercero", fk: "vehiculo_tercero_id" }
    : { tabla: "vehiculos", fk: "vehiculo_id" };
}

/** Decide el estado de una lectura nueva frente al km vigente. Función pura. */
/** Tolerancia de horas por delante para no marcar "futuro" por desfase de reloj. */
const HORAS_FUTURO_TOLERANCIA = 6;
/** Factor de salto de orden de magnitud: ×8 sobre el vigente = casi seguro un dígito de más. */
const RATIO_DIGITO_DE_MAS = 8;

export function evaluarLectura(opts: {
  kmVigente: number | null | undefined;
  kmNuevo: number;
  kmDiaMax?: number;                  // tope de plausibilidad km/día
  horasDesdeUltima?: number | null;   // horas reales desde la última lectura aceptada
  origenIA?: boolean;                 // la fuente es automática/IA (whatsapp_foto/manual, combustible)
  /** La MISMA imagen (igual URL o igual hash) ya se registró → una evidencia contada dos veces. */
  duplicadoProbable?: boolean;
  /** Mismo km desde una fuente DISTINTA: las dos evidencias se confirman entre sí. */
  corroborada?: boolean;
  fechaLectura?: string | null;       // fecha (o timestamp) de la lectura, para el guard de "futuro"
  ahora?: Date;                       // inyectable (default: ahora)
  /**
   * Vecinas EN EL TIEMPO de la lectura que se evalúa (por hora de captura, no de inserción).
   * Comparar contra el km vigente —que es el MÁXIMO histórico— acusa de "retroceso" a toda
   * lectura que llega tarde pero pertenece a un momento anterior (foto de WhatsApp procesada
   * después del check-out, reproceso del Radar, carga manual de un día pasado). El vecino
   * anterior es la única referencia correcta; el posterior detecta el error simétrico
   * (una lectura que no puede ser mayor que la que vino después).
   * Si no se pasan, se cae al comportamiento anterior (comparar contra el vigente).
   */
  refAnterior?: RefLectura | null;
  refPosterior?: RefLectura | null;
}): EvalLectura {
  const kmNuevo = Number(opts.kmNuevo);
  const kmVigente = Number(opts.kmVigente || 0);
  const kmDiaMax = opts.kmDiaMax && opts.kmDiaMax > 0 ? opts.kmDiaMax : 1500;
  const ahora = opts.ahora ?? new Date();

  if (!Number.isFinite(kmNuevo) || kmNuevo < 0) {
    return { estado: "rechazada", motivo: "Lectura inválida" };
  }

  // Guard de "lectura del futuro": un reloj adelantado (teléfono del conductor) mete una
  // fecha posterior a ahora que ordenaría al final de la jornada e inflaría el vigente.
  const tLectura = tsDe(opts.fechaLectura);
  if (tLectura != null && tLectura > ahora.getTime() + HORAS_FUTURO_TOLERANCIA * 3600_000) {
    return { estado: "sospechosa", motivo: "Fecha/hora futura: revisar reloj del dispositivo" };
  }

  // Base de comparación, en este orden:
  //   1. la lectura viva inmediatamente ANTERIOR en el tiempo (lo correcto);
  //   2. si no hay anterior pero sí posterior, esta es la más antigua de la serie: no hay nada
  //      contra qué compararla hacia atrás (el vigente es de un momento futuro → base 0);
  //   3. sin vecinos —unidad dada de alta con su odómetro a mano, o llamador que no los
  //      informa— manda el vigente, igual que antes.
  const ref = opts.refAnterior ?? null;
  const post = opts.refPosterior ?? null;
  const kmBase = ref ? Number(ref.km) || 0 : (post ? 0 : kmVigente);

  // Una lectura que llega DESPUÉS de otra cuya captura es posterior es retroactiva: no puede
  // superar a la que ya vino después (el odómetro solo avanza).
  if (post && kmNuevo > Number(post.km)) {
    return {
      estado: "sospechosa",
      motivo: `Incoherente con la lectura ${describirRef(post)}, que es posterior: el odómetro no puede bajar después`,
    };
  }

  if (kmBase <= 0) return { estado: "aceptada", motivo: null }; // primera lectura de la unidad

  if (kmNuevo < kmBase) {
    // Retroceso graduado: un ruido de OCR de pocos km no es lo mismo que un rollback grande.
    const retro = kmBase - kmNuevo;
    const tol = Math.max(5, Math.round(kmBase * 0.001)); // ±0.1% de la base, mínimo 5 km
    const contra = ref ? `frente a la lectura ${describirRef(ref)}` : `frente al vigente ${kmBase.toLocaleString("es-PE")}`;
    return retro <= tol
      ? { estado: "sospechosa", motivo: `Retroceso leve (−${retro.toLocaleString("es-PE")} km) ${contra}: posible ruido de lectura` }
      : { estado: "sospechosa", motivo: `Retrocede ${retro.toLocaleString("es-PE")} km ${contra} (posible manipulación)` };
  }

  if (kmNuevo === kmBase) {
    // ── Mismo kilometraje que la lectura anterior ──────────────────────────────────────
    // Lo que decide aquí es la IMAGEN, no el número. Dos fotos DISTINTAS con el mismo km son
    // dos evidencias de que la unidad no se movió: el patrón normal de la flota (check-out
    // ~21:00 y check-in ~05:20 del día siguiente, bus en cochera). La regla anterior marcaba
    // como "posible reenvío" todo lo que cayera dentro de 12 h, así que acusaba justamente a
    // ese patrón: en 58 grupos con km repetido de la BD, NINGUNO compartía foto.
    // El reenvío real —la misma imagen contada dos veces— lo detecta `duplicadoProbable`
    // por URL o por hash del binario, y ese sí sigue yendo a revisión.
    if (opts.duplicadoProbable) {
      return { estado: "sospechosa", motivo: `Duplicada: es la MISMA foto de la lectura ${describirRef(ref)} (reenvío)` };
    }
    // Dos fuentes independientes que coinciden no son un problema: son la confirmación más
    // fuerte de que el número es correcto (la app del conductor y la foto del grupo).
    if (opts.corroborada && ref) {
      return { estado: "aceptada", motivo: `Confirmada: coincide con la lectura ${describirRef(ref)}, de otra fuente` };
    }
    if (!opts.origenIA) return { estado: "aceptada", motivo: null };
    return { estado: "aceptada", motivo: ref ? `Sin avance: unidad detenida desde la lectura ${describirRef(ref)}` : null };
  }

  // Mayor a la base.
  const salto = kmNuevo - kmBase;

  // 1) Salto de ORDEN DE MAGNITUD (dígito de más, p.ej. 43,546 → 435,461 = ×10). Un umbral
  //    de km/día no lo captura por diseño; el ratio sí. Solo con el vigente ya ALTO: en
  //    odómetros bajos (unidad nueva) un ×8 legítimo es posible, así que el piso evita
  //    falsos positivos sin perder el caso real (un dígito de más siempre deja el vigente alto).
  if (kmBase >= 5000 && kmNuevo >= kmBase * RATIO_DIGITO_DE_MAS) {
    const veces = Math.round(kmNuevo / kmBase);
    return { estado: "sospechosa", motivo: `Salto ×${veces} (${kmNuevo.toLocaleString("es-PE")}): posible dígito de más` };
  }

  // 2) Salto físicamente imposible. Se usa el tiempo real transcurrido pero con PISO de 1 día
  //    completo: una segunda lectura del mismo día (check-out, combustible) conserva el
  //    presupuesto de una jornada entera y no se marca por prorratear el tope a pocas horas
  //    (un bus interprovincial recorre en 10–14 h más de lo que daría kmDiaMax×horas/24).
  //    Sin tiempo conocido se cae a 30 días; el guard de ratio de arriba es el respaldo.
  //    Ojo con el 0: dos lecturas del mismo instante (o una retroactiva, cuyo delta se aplasta
  //    a 0) NO significan "no se sabe" — significan "sin tiempo para avanzar". Tratarlas como
  //    desconocido daba 30 días de presupuesto y desactivaba este guard justo cuando más hace
  //    falta, así que solo `null` cae al fallback.
  const dias = opts.horasDesdeUltima != null
    ? Math.max(opts.horasDesdeUltima / 24, 1)  // piso de 1 día completo
    : 30;
  const saltoMax = kmDiaMax * dias;
  if (salto > saltoMax) {
    const cuando = opts.horasDesdeUltima != null
      ? (opts.horasDesdeUltima < 36 ? "el día" : `~${Math.round(opts.horasDesdeUltima / 24)} día(s)`)
      : "período largo";
    return { estado: "sospechosa", motivo: `Salto improbable: +${salto.toLocaleString("es-PE")} km en ${cuando}` };
  }
  return { estado: "aceptada", motivo: null };
}

/** Parsea una fecha (YYYY-MM-DD) o timestamp a epoch ms, o null si no es válida. */
function tsDe(fechaISO: string | null | undefined): number | null {
  if (!fechaISO) return null;
  const base = fechaISO.length <= 10 ? fechaISO + "T00:00:00-05:00" : fechaISO; // fecha suelta = medianoche Lima
  const t = new Date(base).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Horas transcurridas entre un timestamp de referencia y ahora (o null si no se puede). */
function horasEntre(tsRef: number | null, hasta: Date): number | null {
  if (tsRef == null) return null;
  return Math.max(0, (hasta.getTime() - tsRef) / 3600_000);
}

/** Fecha de HOY en hora Lima (UTC-5), YYYY-MM-DD. Antes usaba UTC y de noche saltaba a mañana. */
function hoyISO(): string {
  return new Date(Date.now() - 5 * 3600_000).toISOString().split("T")[0];
}

/**
 * Lo que el ERP YA SABE del odómetro de una unidad: el km vigente, el ritmo histórico y
 * cuánto tiempo pasó desde la última lectura viva.
 *
 * Vivía dentro de registrarLectura, es decir se calculaba DESPUÉS de que el número ya
 * estaba elegido. Extraído aquí para que también lo usen (a) el selector que decide cuál
 * de los números del tablero es el odómetro (lib/odometro-seleccion.ts) y (b) los prompts
 * de visión, que sin este ancla no tienen forma de distinguir el total del parcial.
 *
 * Es una función de LECTURA pura contra la BD: no escribe nada.
 */
export type ContextoOdometro = {
  existe: boolean;              // el vehículo existe en la tabla de su flota
  kmVigente: number;            // 0 si no hay ninguno (unidad nueva)
  ritmoKmDia: number | null;    // ritmo histórico, null si no hay suficiente historia
  ritmoFiable: boolean;         // ≥5 lecturas aceptadas y ≥7 días de historia
  horasDesdeUltima: number | null;
  kmDiaMax: number;             // tope de plausibilidad km/día (misma fórmula que registrarLectura)
  hayHistorial: boolean;        // hay al menos una lectura viva (aceptada/reinicio)
  /** Lectura viva inmediatamente ANTERIOR a `tsRef` (por hora de captura). */
  anterior: RefLectura | null;
  /** Lectura viva inmediatamente POSTERIOR a `tsRef`; si existe, la nueva llega retroactiva. */
  posterior: RefLectura | null;
  /**
   * Instante en el que la lectura queda realmente ubicada. Difiere de `tsRef` solo cuando la
   * hora conocida es un TOPE (ver `horaEsTope`) y el kilometraje exige colocarla antes.
   */
  tsUbicado: number;
  /** Explicación del reajuste de hora, si lo hubo (va al motivo de la lectura). */
  notaHora: string | null;
};

/** Fila cruda de lecturas_odometro → referencia con su instante efectivo. */
function aRef(f: { km: number; created_at: string; capturado_en: string | null; fuente?: string; momento?: string | null; foto_url?: string | null; foto_hash?: string | null }): RefLectura {
  return {
    km: Number(f.km),
    ts: tsDe(f.capturado_en) ?? tsDe(f.created_at),
    fuente: f.fuente ?? null,
    momento: f.momento ?? null,
    foto_url: f.foto_url ?? null,
    foto_hash: f.foto_hash ?? null,
    horaExacta: !!f.capturado_en,
  };
}

/**
 * SHA-256 del binario de una foto, para reconocer la MISMA imagen aunque llegue con otra URL
 * (un reenvío de WhatsApp es un mensaje nuevo: el worker lo sube con otro nombre).
 *
 * Es best-effort a propósito: si la descarga falla, tarda o el bucket no responde, devuelve
 * null y el registro sigue su curso sin hash. Perder la huella de una foto degrada el dedupe;
 * bloquear la lectura del odómetro por eso perdería el dato que importa.
 */
export async function hashDeFoto(
  origen: { url?: string | null; base64?: string | null },
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  try {
    const { createHash } = await import("node:crypto");
    if (origen.base64) return createHash("sha256").update(Buffer.from(origen.base64, "base64")).digest("hex");
    if (!origen.url) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
    try {
      const r = await fetch(origen.url, { signal: ctrl.signal });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 25 * 1024 * 1024) return null;
      return createHash("sha256").update(buf).digest("hex");
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null; // sin red, sin crypto (navegador), timeout… → se sigue sin hash
  }
}

export async function contextoOdometro(
  client: any,
  opts: {
    vehiculo_id: number;
    flota?: Flota;
    tsRef?: string | null;
    /**
     * `tsRef` es la hora de ENVÍO, no la de la foto: una imagen de WhatsApp puede haberse
     * tomado mucho antes de mandarse ("buenos días, km inicial" a las 06:06 con una foto del
     * tablero de las 04:50). Con esto la hora se trata como COTA SUPERIOR y la lectura se
     * ubica en el hueco que su kilometraje exige, en vez de acusar un retroceso inexistente.
     */
    horaEsTope?: boolean;
    /** Kilometraje que se va a registrar: necesario para ubicar una lectura con hora-tope. */
    kmNuevo?: number | null;
  }
): Promise<ContextoOdometro> {
  const vacio: ContextoOdometro = {
    existe: false, kmVigente: 0, ritmoKmDia: null, ritmoFiable: false,
    horasDesdeUltima: null, kmDiaMax: 1500, hayHistorial: false,
    anterior: null, posterior: null, tsUbicado: Date.now(), notaHora: null,
  };
  if (!opts.vehiculo_id) return vacio;
  const { tabla, fk } = targetFlota(opts.flota);

  const { data: veh } = await client
    .from(tabla).select("kilometraje_actual").eq("id", opts.vehiculo_id).maybeSingle();
  if (!veh) return vacio;
  const kmVigente = Number(veh?.kilometraje_actual || 0);

  const tsNueva = tsDe(opts.tsRef ?? null) ?? Date.now();
  const diaRef = new Date(tsNueva - 5 * 3600_000).toISOString().slice(0, 10); // día Lima de la lectura

  // Vecinas en el TIEMPO, no en el orden de inserción. Se acota por la columna `fecha` (día
  // Lima, indexada) y se afina en JS con el instante efectivo, porque `capturado_en` puede ser
  // NULL y PostgREST no ordena por un COALESCE. El día de la propia lectura entra en ambas
  // consultas a propósito: sus vecinas más probables son del mismo día.
  // select("*") en vez de nombrar las columnas: migration-safe. `foto_hash` es nueva
  // (supabase/odometro-foto-hash.sql) y nombrarla antes de correr la migración haría fallar
  // el SELECT entero, dejando el odómetro sin contexto. Son ≤60 filas: el coste es nulo.
  const cols = "*";
  const [{ data: prevRaw }, { data: postRaw }] = await Promise.all([
    client.from("lecturas_odometro").select(cols)
      .eq(fk, opts.vehiculo_id).in("estado", ["aceptada", "reinicio"])
      .lte("fecha", diaRef).order("fecha", { ascending: false }).order("created_at", { ascending: false }).limit(40),
    client.from("lecturas_odometro").select(cols)
      .eq(fk, opts.vehiculo_id).in("estado", ["aceptada", "reinicio"])
      .gte("fecha", diaRef).order("fecha", { ascending: true }).order("created_at", { ascending: true }).limit(20),
  ]);

  type Fila = { km: number; fecha: string; created_at: string; capturado_en: string | null; estado: string; fuente?: string; momento?: string | null; foto_url?: string | null; foto_hash?: string | null };
  const todas = [...((prevRaw || []) as Fila[]), ...((postRaw || []) as Fila[])];
  const conTs = todas.map((f) => ({ f, ts: tsDe(f.capturado_en) ?? tsDe(f.created_at) ?? 0 }));

  // ── Ubicación temporal de la lectura ───────────────────────────────────────────────────
  // Con hora exacta, la lectura va donde dice su reloj. Con hora-TOPE (la de envío del
  // mensaje) solo se sabe que se tomó en o antes de ese instante: si entre su hueco por
  // kilometraje y el tope ya hay lecturas de km MAYOR, la foto es necesariamente anterior a
  // ellas y se la ubica justo antes. Es la diferencia entre "el odómetro retrocedió" y "la
  // foto llegó tarde", que hasta ahora el ERP no distinguía.
  let tsUbicado = tsNueva;
  let notaHora: string | null = null;
  const kmNuevo = opts.kmNuevo != null ? Number(opts.kmNuevo) : null;
  if (opts.horaEsTope && kmNuevo != null && Number.isFinite(kmNuevo)) {
    const serie = conTs.filter((x) => x.ts > 0).sort((a, b) => a.ts - b.ts);
    // Última lectura hasta el tope cuyo km no supera al nuevo: el piso del hueco.
    let iAnt = -1;
    for (let i = 0; i < serie.length; i++) {
      if (serie[i].ts <= tsNueva && Number(serie[i].f.km) <= kmNuevo) iAnt = i;
    }
    const sig = serie[iAnt + 1];
    // Solo se reubica si esa siguiente lectura ya ocurrió antes del tope y tiene MÁS km: es
    // la prueba de que la foto se tomó antes que ella.
    if (sig && sig.ts <= tsNueva && Number(sig.f.km) > kmNuevo) {
      const techo = sig.ts - 60_000;                       // un minuto antes de la que la supera
      const piso = iAnt >= 0 ? serie[iAnt].ts + 1_000 : techo;
      const candidato = Math.max(Math.min(techo, tsNueva), piso);
      // Un conductor manda la foto del tablero con horas de retraso, no con días. Si para que
      // el kilometraje encaje hubiera que retroceder más que eso, lo probable no es que la foto
      // sea vieja sino que el número esté mal: no se reubica y la lectura va a revisión.
      if (tsNueva - candidato <= MAX_AJUSTE_HORA_MS) {
        tsUbicado = candidato;
        notaHora =
          `Hora ajustada a ${horaLimaDeTs(tsUbicado)}: la foto llegó ${horaLimaDeTs(tsNueva)} pero su kilometraje ` +
          `exige que se tomara antes de la lectura de las ${horaLimaDeTs(sig.ts)} (${Number(sig.f.km).toLocaleString("es-PE")} km)`;
      }
    }
  }

  // Anterior = la de mayor ts que no supera el de la lectura; posterior = la de menor ts por encima.
  let anterior: RefLectura | null = null, tsAnt = -Infinity;
  let posterior: RefLectura | null = null, tsPost = Infinity;
  for (const { f, ts } of conTs) {
    if (ts <= tsUbicado) { if (ts > tsAnt) { tsAnt = ts; anterior = aRef(f); } }
    else if (ts < tsPost) { tsPost = ts; posterior = aRef(f); }
  }

  // El histórico que alimenta el ritmo es el ANTERIOR a esta lectura (al reprocesar una foto
  // vieja, lo que vino después todavía no había ocurrido).
  const vivas = ((prevRaw || []) as Fila[]);

  const horasDesdeUltima = anterior?.ts != null ? Math.max(0, (tsUbicado - anterior.ts) / 3600_000) : null;

  const aceptadas = vivas.filter((v) => v.estado === "aceptada");
  const ritmoKmDia = kmPorDia(aceptadas.map((a) => ({ km: a.km, fecha: a.fecha })));
  // Fiable = hay masa suficiente para que el ritmo signifique algo. Con menos historia el
  // ritmo existe pero es ruido, así que quien lo consuma debe caer a un tope conservador.
  const fechas = aceptadas.map((a) => a.fecha).filter(Boolean).sort();
  const diasHistoria = fechas.length >= 2
    ? (new Date(fechas[fechas.length - 1]).getTime() - new Date(fechas[0]).getTime()) / 86400000
    : 0;
  const ritmoFiable = ritmoKmDia != null && aceptadas.length >= 5 && diasHistoria >= 7;

  // MISMA fórmula que usaba registrarLectura (no se toca el comportamiento existente).
  const kmDiaMax = ritmoKmDia != null
    ? Math.min(Math.max(Math.round(ritmoKmDia * 3), 1500), 8000)
    : 1500;

  return {
    existe: true, kmVigente, ritmoKmDia, ritmoFiable, horasDesdeUltima, kmDiaMax,
    hayHistorial: anterior != null || posterior != null,
    anterior, posterior, tsUbicado, notaHora,
  };
}

/**
 * Registra una lectura y, si es aceptada, actualiza vehiculos.kilometraje_actual.
 * Recibe el cliente supabase (anon o service-role) para reusarse desde páginas
 * cliente y desde rutas API.
 */
export async function registrarLectura(
  client: any,
  l: {
    vehiculo_id: number;       // id de `vehiculos` (propia) o `vehiculos_tercero` (tercero, según `flota`)
    km: number;
    fuente: FuenteLectura;
    fecha?: string;            // YYYY-MM-DD
    foto_url?: string | null;
    /**
     * SHA-256 del binario de la foto. Si el caller ya tiene el archivo en memoria conviene
     * pasarlo (evita una descarga); si no, se calcula desde `foto_url`. Identifica la MISMA
     * imagen aunque cambie la URL, que es como llega un reenvío de WhatsApp.
     */
    foto_hash?: string | null;
    ref_origen?: string | null;
    kmDiaMax?: number;
    forzar?: boolean;          // saltar validación (aceptar desde panel de revisión)
    flota?: Flota;             // "propia" (default) | "tercero"
    capturado_en?: string | null; // cuándo se TOMÓ la lectura (no cuándo se insertó)
    /**
     * `capturado_en` es la hora de ENVÍO, no la de la foto (mensajes de WhatsApp): se trata
     * como cota superior y la lectura se ubica donde su kilometraje lo exige. Ver
     * `contextoOdometro`. Las fuentes que sellan la captura en el momento —el check-in y el
     * check-out de la app del conductor— NO deben usarlo: ahí la hora es exacta.
     */
    horaEsTope?: boolean;
    momento?: "checkin" | "checkout" | null; // rol en la jornada
    idemKey?: string | null;   // clave estable por evento de origen → dedupe idempotente
    /**
     * Nota que se ANTEPONE al motivo derivado de evaluarLectura. Aditiva: no cambia el
     * estado ni ninguna decisión. La usa el selector de odómetro para dejar visible en la
     * bandeja que el sistema cambió el número que devolvió la IA (auditoría sin SQL).
     */
    motivo?: string | null;
  }
): Promise<{ ok: boolean; estado: EstadoLectura; motivo: string | null; lecturaId?: string; error?: string }> {
  const km = Number(l.km);
  if (!l.vehiculo_id || !Number.isFinite(km) || km <= 0) {
    return { ok: false, estado: "rechazada", motivo: "Datos incompletos", error: "Datos incompletos" };
  }

  const { tabla, fk } = targetFlota(l.flota);

  // ── Idempotencia (Grupo C) ──────────────────────────────────────────────────
  // (a) Por clave de evento: reproceso del Radar, doble-POST del conductor, cron+trigger.
  if (l.idemKey) {
    const { data: yaIdem } = await client
      .from("lecturas_odometro").select("id,estado,motivo")
      .eq("idem_key", l.idemKey).limit(1).maybeSingle();
    if (yaIdem) return { ok: true, estado: yaIdem.estado, motivo: yaIdem.motivo, lecturaId: yaIdem.id };
  }
  // (b) Por foto: la MISMA foto reenviada a otro grupo o el mensaje reprocesado.
  if (l.foto_url) {
    const { data: yaFoto } = await client
      .from("lecturas_odometro").select("id,estado,motivo")
      .eq(fk, l.vehiculo_id).eq("foto_url", l.foto_url).neq("estado", "anulada").limit(1).maybeSingle();
    if (yaFoto) return { ok: true, estado: yaFoto.estado, motivo: yaFoto.motivo, lecturaId: yaFoto.id };
  }
  // (c) Por CONTENIDO de la foto: un reenvío de WhatsApp es un mensaje nuevo, el worker lo sube
  //     con otro nombre y (b) no lo ve — pero el binario es el mismo. El hash lo delata.
  //     Si el caller no lo trae, se calcula aquí (best-effort: null si la descarga falla).
  const fotoHash = l.foto_hash ?? (await hashDeFoto({ url: l.foto_url }));
  if (fotoHash) {
    const { data: yaHash, error: eHash } = await client
      .from("lecturas_odometro").select("id,estado,motivo")
      .eq(fk, l.vehiculo_id).eq("foto_hash", fotoHash).neq("estado", "anulada").limit(1).maybeSingle();
    // Si la columna aún no existe (migración sin correr) el error se ignora: se sigue sin (c).
    if (!eHash && yaHash) return { ok: true, estado: yaHash.estado, motivo: yaHash.motivo, lecturaId: yaHash.id };
  }

  // Momento de CAPTURA de esta lectura (no el de inserción/proceso): al reprocesar una foto
  // vieja el tiempo transcurrido y las validaciones deben medirse contra cuándo se tomó.
  //
  // `capturado_en` lo pone el ORIGEN (el reloj del celular del conductor, el sello del mensaje
  // de WhatsApp), así que un reloj mal configurado puede mentir. La única cota que el ERP
  // controla es la suya: nada puede haberse capturado DESPUÉS de llegar aquí. Si lo dice, el
  // reloj de origen está adelantado y la hora se ancla a la de llegada — de lo contrario esa
  // lectura se ordenaría al final de la jornada y falsearía el anti-retroceso y el recorrido.
  // (Un reloj ATRASADO no se puede detectar así; para eso las rutas que reciben un sello del
  //  dispositivo usan `corregirCapturaPorReloj`.)
  const ahoraSrv = Date.now();
  let capturadoEn = l.capturado_en ?? null;
  let fecha = l.fecha || hoyISO();
  let notaReloj: string | null = null;
  const tsCapOriginal = tsDe(capturadoEn);
  if (tsCapOriginal != null && tsCapOriginal > ahoraSrv + TOLERANCIA_RELOJ_MS) {
    notaReloj = `Hora corregida: el dispositivo la reportó ${fmtDesfase(tsCapOriginal - ahoraSrv)} en el futuro (revisar su reloj)`;
    capturadoEn = new Date(ahoraSrv).toISOString();
    // La fecha del día venía del MISMO reloj que mintió: si ya no coincide, manda la corregida.
    const diaReal = new Date(ahoraSrv - 5 * 3600_000).toISOString().slice(0, 10);
    if (diaReal !== fecha) fecha = diaReal;
  }

  // Vigente + historial (horas desde la última, km/día adaptativo). Mismo cálculo de siempre,
  // ahora compartido con el selector de odómetro y con los prompts de visión.
  const ctx = await contextoOdometro(client, {
    vehiculo_id: l.vehiculo_id, flota: l.flota, tsRef: capturadoEn ?? fecha,
    horaEsTope: l.horaEsTope, kmNuevo: km,
  });
  if (!ctx.existe) {
    return { ok: false, estado: "rechazada", motivo: "Vehículo no encontrado", error: "Vehículo no encontrado" };
  }
  const { kmVigente, horasDesdeUltima, anterior, posterior } = ctx;
  let tsNueva = tsDe(capturadoEn) ?? tsDe(fecha) ?? Date.now();

  // La hora era un tope y el kilometraje obligó a adelantarla: se guarda la hora ubicada (es la
  // mejor estimación coherente de cuándo se tomó la foto) con la explicación en el motivo.
  if (ctx.notaHora && ctx.tsUbicado !== tsNueva) {
    notaReloj = [notaReloj, ctx.notaHora].filter(Boolean).join(" · ");
    tsNueva = ctx.tsUbicado;
    capturadoEn = new Date(ctx.tsUbicado).toISOString();
    const diaUbicado = new Date(ctx.tsUbicado - 5 * 3600_000).toISOString().slice(0, 10);
    if (diaUbicado !== fecha) fecha = diaUbicado; // el ajuste cruzó la medianoche → cambia la jornada
  }
  // El caller puede fijar el tope; si no, manda el adaptativo del contexto.
  const kmDiaMax = l.kmDiaMax && l.kmDiaMax > 0 ? l.kmDiaMax : ctx.kmDiaMax;

  // Mismo km que la lectura anterior: lo que decide es la IMAGEN, no el intervalo de tiempo.
  //   · misma imagen (URL o hash del binario) → una evidencia contada dos veces = reenvío;
  //   · fotos distintas y otra fuente          → dos evidencias que se confirman entre sí;
  //   · fotos distintas y la misma fuente      → la unidad simplemente no se movió.
  let duplicadoProbable = false;
  let corroborada = false;
  if (anterior && Number(anterior.km) === km) {
    const mismaImagen =
      (!!l.foto_url && anterior.foto_url === l.foto_url) ||
      (!!fotoHash && !!anterior.foto_hash && anterior.foto_hash === fotoHash);
    duplicadoProbable = mismaImagen;
    corroborada = !mismaImagen && !!anterior.fuente && anterior.fuente !== l.fuente;
  }

  const origenIA = l.fuente === "whatsapp_foto" || l.fuente === "whatsapp_manual" || l.fuente === "combustible";

  const evalr: EvalLectura = l.forzar
    ? { estado: "aceptada", motivo: null }
    : evaluarLectura({
        kmVigente, kmNuevo: km, kmDiaMax, horasDesdeUltima, origenIA, duplicadoProbable, corroborada,
        fechaLectura: l.capturado_en ?? fecha,
        refAnterior: anterior, refPosterior: posterior,
      });

  // El motivo del caller (p.ej. "el sistema corrigió el número de la IA") y el aviso de reloj
  // se anteponen al de evaluarLectura para que queden visibles en la bandeja; no alteran el estado.
  const motivoFinal = [l.motivo?.trim() || null, notaReloj, evalr.motivo].filter(Boolean).join(" · ") || null;

  const fila: Record<string, any> = {
    [fk]: l.vehiculo_id,
    km,
    fuente: l.fuente,
    fecha,
    foto_url: l.foto_url ?? null,
    foto_hash: fotoHash,
    ref_origen: l.ref_origen ?? null,
    capturado_en: capturadoEn,
    momento: l.momento ?? null,
    idem_key: l.idemKey ?? null,
    estado: evalr.estado,
    motivo: motivoFinal,
  };
  let { data: ins, error } = await client.from("lecturas_odometro").insert(fila).select("id").single();
  // Migration-safe: si `foto_hash` todavía no existe en la tabla, se reintenta sin ella. El
  // dedupe por contenido queda inactivo hasta correr supabase/odometro-foto-hash.sql, pero la
  // lectura —el dato que importa— no se pierde por una migración pendiente.
  if (error && esColumnaInexistenteOdo(error)) {
    delete fila.foto_hash;
    ({ data: ins, error } = await client.from("lecturas_odometro").insert(fila).select("id").single());
  }

  if (error) {
    // Carrera perdida contra el índice único parcial (otro proceso insertó el mismo idem_key):
    // no es un fallo real, la lectura ya existe → devolverla como idempotente.
    if (esViolacionUnica(error) && l.idemKey) {
      const { data: yaIdem } = await client
        .from("lecturas_odometro").select("id,estado,motivo").eq("idem_key", l.idemKey).limit(1).maybeSingle();
      if (yaIdem) return { ok: true, estado: yaIdem.estado, motivo: yaIdem.motivo, lecturaId: yaIdem.id };
    }
    return { ok: false, estado: evalr.estado, motivo: evalr.motivo, error: error.message };
  }

  if (evalr.estado === "aceptada" && km > kmVigente) {
    await client.from(tabla).update({ kilometraje_actual: km }).eq("id", l.vehiculo_id);
  }

  return { ok: true, estado: evalr.estado, motivo: evalr.motivo, lecturaId: ins?.id };
}

/** ¿El error de Postgres/PostgREST es una violación de índice único (23505)? */
function esViolacionUnica(error: any): boolean {
  return error?.code === "23505" || /duplicate key|unique constraint/i.test(String(error?.message ?? ""));
}

/** ¿El error se debe a una columna que aún no existe (migración sin correr)? */
function esColumnaInexistenteOdo(error: any): boolean {
  return error?.code === "42703" || error?.code === "PGRST204" ||
    /column .* does not exist|could not find the .* column/i.test(String(error?.message ?? ""));
}

/** Fuentes cuya hora es la del ENVÍO del mensaje, no la de la foto. */
const FUENTES_HORA_TOPE: string[] = ["whatsapp_foto", "whatsapp_manual", "combustible"];

/** Acepta manualmente una lectura sospechosa (desde el panel de revisión). */
export async function aceptarLectura(
  client: any,
  lecturaId: string
): Promise<{ ok: boolean; error?: string }> {
  // select("*") en vez de nombrar vehiculo_tercero_id: migration-safe (si el código se
  // despliega antes de correr odometro-terceros.sql, nombrar la columna nueva haría fallar
  // el SELECT y rompería el "Aceptar" de flota propia en silencio). Pre-migración la columna
  // simplemente no viene → esTercero = (undefined != null) = false → se trata como propia.
  const { data: l } = await client
    .from("lecturas_odometro").select("*").eq("id", lecturaId).single();
  if (!l) return { ok: false, error: "Lectura no encontrada" };
  // La flota se deriva de qué columna FK está poblada (propia XOR tercero por CHECK).
  const esTercero = l.vehiculo_tercero_id != null;
  const tabla = esTercero ? "vehiculos_tercero" : "vehiculos";
  const vid = esTercero ? l.vehiculo_tercero_id : l.vehiculo_id;

  // Si la lectura viene de una fuente cuya hora es la del ENVÍO (foto de WhatsApp), aceptarla
  // sin más la dejaría con una hora que la ordena DESPUÉS de lecturas de más km: la analítica
  // la descartaría por "retroceder" y el operador la habría aceptado para nada. Se la reubica
  // en el hueco que su kilometraje exige, igual que al registrarla.
  const parche: Record<string, any> = { estado: "aceptada", motivo: "Aceptada manualmente" };
  if (FUENTES_HORA_TOPE.includes(String(l.fuente))) {
    const ctx = await contextoOdometro(client, {
      vehiculo_id: vid, flota: esTercero ? "tercero" : "propia",
      tsRef: l.capturado_en ?? l.created_at ?? l.fecha,
      horaEsTope: true, kmNuevo: Number(l.km),
    });
    if (ctx.notaHora) {
      parche.capturado_en = new Date(ctx.tsUbicado).toISOString();
      parche.motivo = `Aceptada manualmente · ${ctx.notaHora}`;
      const diaUbicado = new Date(ctx.tsUbicado - 5 * 3600_000).toISOString().slice(0, 10);
      if (diaUbicado !== l.fecha) parche.fecha = diaUbicado;
    }
  }

  await client.from("lecturas_odometro").update(parche).eq("id", lecturaId);
  const { data: veh } = await client
    .from(tabla).select("kilometraje_actual").eq("id", vid).single();
  if (Number(l.km) > Number(veh?.kilometraje_actual || 0)) {
    await client.from(tabla).update({ kilometraje_actual: Number(l.km) }).eq("id", vid);
  }
  return { ok: true };
}

/**
 * Reinicio / cambio de tablero: re-ancla el km vigente al nuevo valor aunque sea
 * menor. Resuelve el caso en que "el mayor gana" dejaría al vehículo ciego.
 */
export async function marcarReinicio(
  client: any,
  opts: { vehiculo_id: number; km: number; fecha?: string; flota?: Flota }
): Promise<{ ok: boolean; error?: string }> {
  const km = Number(opts.km);
  if (!opts.vehiculo_id || !Number.isFinite(km) || km < 0) return { ok: false, error: "Datos incompletos" };
  const fecha = opts.fecha || hoyISO();
  const { tabla, fk } = targetFlota(opts.flota);
  const { data: veh } = await client.from(tabla).select("id").eq("id", opts.vehiculo_id).maybeSingle();
  if (!veh) return { ok: false, error: "Vehículo no encontrado" };
  const { error } = await client.from("lecturas_odometro").insert({
    [fk]: opts.vehiculo_id, km, fuente: "manual", fecha,
    estado: "reinicio", motivo: "Reinicio / cambio de tablero",
  });
  if (error) return { ok: false, error: error.message };
  await client.from(tabla).update({ kilometraje_actual: km }).eq("id", opts.vehiculo_id);
  return { ok: true };
}

// ─── ANULACIÓN + APRENDIZAJE ─────────────────────────────────────────────────

/**
 * Motivos tipificados de anulación. La clave viaja a odometro_correcciones.motivo_tipo.
 *   - ensena  → el caso se inyecta como ejemplo en el prompt de visión (errores de lectura IA).
 *   - corrige → el motivo pide el km correcto y registra una lectura corregida en su lugar
 *               (para "otro" es opcional; para el resto de correctivos es obligatorio).
 */
export const MOTIVOS_ANULACION = [
  { id: "ia_digito",   label: "La IA leyó mal un dígito",      ensena: true,  corrige: true  },
  { id: "ia_trip",     label: "La IA leyó el parcial (trip)",  ensena: true,  corrige: true  },
  { id: "tipeo",       label: "Se leyó/tecleó mal el número",  ensena: false, corrige: true  },
  { id: "otra_unidad", label: "Foto de otra unidad",           ensena: false, corrige: false },
  { id: "duplicada",   label: "Lectura duplicada",             ensena: false, corrige: false },
  { id: "reinicio",    label: "Era un reinicio de tablero",    ensena: false, corrige: false },
  { id: "otro",        label: "Otro",                          ensena: false, corrige: true  },
] as const;
export type MotivoAnulacion = (typeof MOTIVOS_ANULACION)[number]["id"];

/**
 * Recalcula `kilometraje_actual` a partir de las lecturas que siguen vivas.
 * Necesario tras anular una lectura aceptada: el vigente es derivado, y si la
 * lectura anulada era la que lo empujó, el vehículo quedaría con un km inventado.
 *
 * Regla: si hay un reinicio de tablero, solo cuentan las lecturas desde ese
 * reinicio (antes de él el odómetro medía otra cosa). El vigente es el mayor km
 * entre el reinicio y las lecturas aceptadas posteriores.
 */
export async function recalcularKmVigente(
  client: any,
  opts: { vehiculo_id: number; flota?: Flota }
): Promise<{ ok: boolean; km: number | null; error?: string }> {
  const { tabla, fk } = targetFlota(opts.flota);
  const { data, error } = await client
    .from("lecturas_odometro").select("km,fecha,estado,created_at")
    .eq(fk, opts.vehiculo_id)
    .in("estado", ["aceptada", "reinicio"])
    .order("created_at", { ascending: true });
  if (error) return { ok: false, km: null, error: error.message };

  const filas = (data || []) as { km: number; estado: string; created_at: string }[];
  const idxReinicio = filas.map(f => f.estado).lastIndexOf("reinicio");
  const vivas = idxReinicio >= 0 ? filas.slice(idxReinicio) : filas;
  const km = vivas.length ? Math.max(...vivas.map(f => Number(f.km) || 0)) : null;

  const { error: eUp } = await client.from(tabla)
    .update({ kilometraje_actual: km }).eq("id", opts.vehiculo_id);
  if (eUp) return { ok: false, km, error: eUp.message };
  return { ok: true, km };
}

/**
 * Anula una lectura (no la borra) y registra POR QUÉ estuvo mal.
 * La corrección alimenta `odometro_correcciones`, que /api/mantenimiento/leer-odometro
 * usa como ejemplos para que la lectura por foto deje de repetir el mismo error.
 * Al final recalcula el km vigente del vehículo.
 */
export async function anularLectura(
  client: any,
  opts: {
    lecturaId: string;
    motivo_tipo: MotivoAnulacion;
    nota?: string | null;
    km_correcto?: number | null;
    usuario?: string | null;
    placa?: string | null;
  }
): Promise<{ ok: boolean; kmVigente?: number | null; lecturaCorregidaId?: string | null; error?: string }> {
  const { data: l } = await client.from("lecturas_odometro").select("*").eq("id", opts.lecturaId).single();
  if (!l) return { ok: false, error: "Lectura no encontrada" };

  const esTercero = l.vehiculo_tercero_id != null;
  const vid = esTercero ? l.vehiculo_tercero_id : l.vehiculo_id;
  const flota: Flota = esTercero ? "tercero" : "propia";
  const fk = esTercero ? "vehiculo_tercero_id" : "vehiculo_id";

  // km correcto normalizado: se registra una lectura corregida solo si es un entero
  // positivo y DISTINTO al mal leído (si coincide, no hay nada que corregir).
  const kmC = opts.km_correcto;
  const kmCorrecto =
    kmC != null && Number.isFinite(Number(kmC)) && Number(kmC) > 0 ? Math.round(Number(kmC)) : null;
  const hayCorreccion = kmCorrecto != null && kmCorrecto !== Number(l.km);

  // Registra (o recupera) la lectura CORREGIDA: clon del original con el número bueno,
  // la MISMA foto y la MISMA marca temporal (created_at/momento) para no desordenar la
  // jornada, forzada a "aceptada". Es IDEMPOTENTE: se identifica por ref_origen, así un
  // reintento tras un fallo parcial no la duplica ni la pierde.
  const refCorreccion = `correccion:${l.id}`;
  const asegurarCorregida = async (): Promise<{ ok: boolean; id?: string | null; error?: string }> => {
    if (!hayCorreccion) return { ok: true, id: null };
    const { data: ya } = await client.from("lecturas_odometro").select("id").eq("ref_origen", refCorreccion).limit(1).maybeSingle();
    if (ya) return { ok: true, id: ya.id };
    const { data: nueva, error } = await client.from("lecturas_odometro").insert({
      [fk]: vid,
      km: kmCorrecto,
      fuente: l.fuente,
      fecha: l.fecha,
      foto_url: l.foto_url ?? null,
      momento: l.momento ?? null,
      created_at: l.created_at,                 // conserva la posición temporal en la jornada
      ref_origen: refCorreccion,                // trazabilidad + idempotencia
      estado: "aceptada",
      motivo: `Corregida desde ${Number(l.km).toLocaleString("es-PE")} km`,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: nueva?.id ?? null };
  };

  // Ya anulada → reintento idempotente: NO se repiten la bitácora ni el flip (duplicaría),
  // pero SÍ se asegura la lectura corregida (recupera el caso en que su INSERT falló antes)
  // y se re-deriva el vigente. Así una anulación que quedó a medias se completa al reintentar.
  if (l.estado === "anulada") {
    const c = await asegurarCorregida();
    const rec = await recalcularKmVigente(client, { vehiculo_id: vid, flota });
    if (!c.ok) return { ok: false, error: "La lectura ya estaba anulada; no se pudo registrar la corrección: " + c.error };
    if (!rec.ok) return { ok: false, error: "La lectura ya estaba anulada y no se pudo recalcular el km vigente: " + rec.error };
    return { ok: true, kmVigente: rec.km, lecturaCorregidaId: c.id };
  }

  // 1) Bitácora + dataset de aprendizaje. Se escribe ANTES de mutar la lectura. Dedupe
  //    por lectura_id para que un reintento tras un fallo posterior no la duplique.
  const { data: yaCorr } = await client.from("odometro_correcciones").select("id").eq("lectura_id", l.id).limit(1).maybeSingle();
  if (!yaCorr) {
    const { error: eCorr } = await client.from("odometro_correcciones").insert({
      lectura_id: l.id,
      vehiculo_id: esTercero ? null : vid,
      vehiculo_tercero_id: esTercero ? vid : null,
      placa: opts.placa ?? null,
      km_leido: Number(l.km),
      km_correcto: kmCorrecto,
      fuente: l.fuente,
      motivo_tipo: opts.motivo_tipo,
      nota: opts.nota || null,
      foto_url: l.foto_url || null,
      usuario: opts.usuario || null,
    });
    if (eCorr) return { ok: false, error: "No se pudo guardar la corrección: " + eCorr.message };
  }

  // Caso especial: "era un reinicio de tablero". La lectura no está mala, es el nuevo
  // odómetro físico. En vez de anularla (que dejaría el vigente anclado en los km
  // altos previos → bus "ciego"), se re-ancla el vigente a este valor marcándola como
  // 'reinicio' — misma semántica que marcarReinicio() pero sobre la fila existente.
  if (opts.motivo_tipo === "reinicio") {
    const kmAncla = kmCorrecto ?? Number(l.km);
    const { error: eR } = await client.from("lecturas_odometro")
      .update({ estado: "reinicio", km: kmAncla, motivo: `Reinicio de tablero${opts.nota ? " — " + opts.nota : ""}` })
      .eq("id", l.id);
    if (eR) return { ok: false, error: eR.message };
    const rec = await recalcularKmVigente(client, { vehiculo_id: vid, flota });
    return rec.ok
      ? { ok: true, kmVigente: rec.km }
      : { ok: false, kmVigente: rec.km, error: "Se marcó el reinicio pero no se pudo recalcular el km vigente: " + rec.error };
  }

  // 2) Registrar la lectura corregida ANTES de anular la mala: si esto falla, el original
  //    sigue intacto y el reintento es limpio (nada que recuperar). El clon es idempotente.
  const c = await asegurarCorregida();
  if (!c.ok) return { ok: false, error: "No se pudo registrar la lectura corregida: " + c.error };
  const lecturaCorregidaId = c.id;

  // 3) Anular la lectura mala (se conserva la fila y la foto como evidencia). Si falla, el
  //    clon ya quedó guardado; el reintento entra por la rama "ya anulada"/limpia y converge.
  const etiqueta = MOTIVOS_ANULACION.find(m => m.id === opts.motivo_tipo)?.label || opts.motivo_tipo;
  const { error: eUpd } = await client.from("lecturas_odometro")
    .update({ estado: "anulada", motivo: `Anulada: ${etiqueta}${opts.nota ? " — " + opts.nota : ""}` })
    .eq("id", l.id);
  if (eUpd) return { ok: false, lecturaCorregidaId, error: eUpd.message };

  // 4) El vigente es derivado → recalcular con la lectura corregida (si la hubo) y sin la
  //    anulada. Si el recálculo falla, se avisa (no se traga): reintentar lo completa.
  const rec = await recalcularKmVigente(client, { vehiculo_id: vid, flota });
  if (!rec.ok) {
    return { ok: false, kmVigente: rec.km, lecturaCorregidaId, error: "Se anuló/corrigió la lectura, pero no se pudo recalcular el km vigente. Reintenta: " + rec.error };
  }
  return { ok: true, kmVigente: rec.km, lecturaCorregidaId };
}

/**
 * Últimas correcciones de lecturas hechas por IA, en texto plano, para inyectar
 * como ejemplos en el prompt de visión. Solo los motivos que enseñan algo sobre
 * cómo mirar la foto (dígito mal leído, parcial confundido con total).
 */
/** Motivos que describen un ACIERTO de la IA o un hecho del mundo, no un error de lectura. */
const MOTIVOS_NO_ENSENAN: string[] = ["duplicada", "otra_unidad", "reinicio"];

/** Carriles donde el número lo propuso una lectura automática (por foto o por WhatsApp). */
const FUENTES_IA: FuenteLectura[] = ["whatsapp_foto", "whatsapp_manual", "checklist", "servicio", "combustible"];

/** ¿La nota del operador dice que la foto no se podía leer? Entonces enseña a ABSTENERSE. */
const NOTA_ILEGIBLE = /no se ve|no se lee|no logr|borros|no est[aá] clar|no se distin|mucha luz|reflejo|apagad|no es un tablero|no parece|no hay n[uú]mero/i;

/** Frase base según el tipo de error que reportó el operador. */
function encabezadoLeccion(motivo: string): string {
  if (motivo === "ia_trip") return "Confundiste el parcial/trip con el odómetro TOTAL.";
  if (motivo === "ia_digito") return "Añadiste o perdiste un dígito al leer el número.";
  if (motivo === "tipeo") return "El número quedó mal leído.";
  return "";
}

export async function leccionesOdometro(
  client: any,
  opts?: { placa?: string | null; limite?: number }
): Promise<string> {
  const limite = opts?.limite ?? 10;
  const { data } = await client
    .from("odometro_correcciones")
    .select("placa,km_leido,km_correcto,motivo_tipo,nota,fuente,created_at")
    .in("fuente", FUENTES_IA)
    .order("created_at", { ascending: false })
    .limit(120);

  // Qué entra y qué no:
  //  - Se filtra por FUENTE (el número lo propuso la IA), no por el motivo que eligió el
  //    operador. Antes solo enseñaban 'ia_trip'/'ia_digito', así que 23 de 28 correcciones
  //    reales —incluidas las notas más precisas que ha escrito el operador— se descartaban
  //    en silencio: esa es la mitad "le corrijo y no aprende" del problema.
  //  - Se excluyen los motivos que NO describen un error de lectura ('duplicada' viene con
  //    notas del tipo "la IA hizo lo correcto": enseñarlas produciría abstenciones espurias).
  //  - Se emiten SIN CIFRAS. Los ejemplos numéricos eran contraproducentes: 10 de 11
  //    correcciones históricas terminan en un número MENOR, y ese patrón es exactamente el
  //    que empuja al modelo a elegir el parcial en una unidad donde el total es el mayor.
  //    Lo que enseña es la instrucción del operador sobre DÓNDE mirar, no los números.
  const filas = ((data || []) as any[]).filter(
    (c) => !MOTIVOS_NO_ENSENAN.includes(String(c.motivo_tipo)) && (c.nota || c.km_correcto != null)
  );
  if (!filas.length) return "";

  const placaObj = (opts?.placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const mismaPlaca = (p: unknown) => placaObj && String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") === placaObj;

  // Dedupe por (placa, tipo de error, ¿trae número correcto?) quedándose con la más reciente:
  // hay unidades con 8 redacciones distintas del mismo "no se ve el número" que si no ahogan
  // al resto de la flota.
  const vistas = new Set<string>();
  const unicas = filas.filter((c) => {
    const k = `${c.placa ?? "?"}|${c.motivo_tipo}|${c.km_correcto != null}`;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });

  // La unidad que se está leyendo va primero y nunca se queda fuera del cupo.
  const propias = unicas.filter((c) => mismaPlaca(c.placa));
  const otras = unicas.filter((c) => !mismaPlaca(c.placa));
  const elegidas = [...propias.slice(0, 6), ...otras.slice(0, Math.max(0, limite - Math.min(propias.length, 6)))];

  return elegidas
    .map((c) => {
      const placa = c.placa ? `[${c.placa}] ` : "";
      const nota = String(c.nota ?? "").trim().slice(0, 200);
      const cab = encabezadoLeccion(String(c.motivo_tipo));
      // Nota que describe una foto ilegible → la lección es abstenerse, no adivinar.
      if (!cab && nota && NOTA_ILEGIBLE.test(nota)) {
        return `- ${placa}«${nota}» → cuando la foto esté así, devuelve "kilometraje": null y dilo en "observaciones"; no adivines un número.`;
      }
      const detalle = nota ? ` El operador precisó: «${nota}»` : "";
      return `- ${placa}${cab || "Lectura corregida por el operador."}${detalle}`;
    })
    .join("\n");
}

/** Promedio km/día a partir de lecturas aceptadas ordenadas. Null si no es fiable. */
export function kmPorDia(lecturas: { km: number; fecha: string }[]): number | null {
  const acc = (lecturas || [])
    .filter(l => Number(l.km) > 0 && l.fecha)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (acc.length < 2) return null;
  const primero = acc[0], ultimo = acc[acc.length - 1];
  const dias = (new Date(ultimo.fecha).getTime() - new Date(primero.fecha).getTime()) / 86400000;
  const dkm = Number(ultimo.km) - Number(primero.km);
  if (dias <= 0 || dkm <= 0) return null;
  return dkm / dias;
}
