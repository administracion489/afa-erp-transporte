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
  duplicadoProbable?: boolean;        // misma foto/mismo evento/ventana corta → casi seguro repetido
  fechaLectura?: string | null;       // fecha (o timestamp) de la lectura, para el guard de "futuro"
  ahora?: Date;                       // inyectable (default: ahora)
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

  if (kmVigente <= 0) return { estado: "aceptada", motivo: null }; // primera lectura

  if (kmNuevo < kmVigente) {
    // Retroceso graduado: un ruido de OCR de pocos km no es lo mismo que un rollback grande.
    const retro = kmVigente - kmNuevo;
    const tol = Math.max(5, Math.round(kmVigente * 0.001)); // ±0.1% del vigente, mínimo 5 km
    return retro <= tol
      ? { estado: "sospechosa", motivo: `Retroceso leve (−${retro.toLocaleString("es-PE")} km): posible ruido de lectura` }
      : { estado: "sospechosa", motivo: `Retrocede: ${kmNuevo.toLocaleString("es-PE")} < vigente ${kmVigente.toLocaleString("es-PE")} (posible manipulación)` };
  }

  if (kmNuevo === kmVigente) {
    // Sin avance. Del conductor (check-in/out manual de un bus parqueado) es legítimo; de una
    // fuente automática/IA es casi siempre una foto reenviada o un doble registro → advertir.
    if (!opts.origenIA) return { estado: "aceptada", motivo: null };
    return opts.duplicadoProbable
      ? { estado: "sospechosa", motivo: "Duplicada: mismo km y misma foto/origen (posible reenvío)" }
      : { estado: "sospechosa", motivo: "Sin avance: km igual al vigente — ¿unidad detenida o lectura repetida?" };
  }

  // Mayor al vigente.
  const salto = kmNuevo - kmVigente;

  // 1) Salto de ORDEN DE MAGNITUD (dígito de más, p.ej. 43,546 → 435,461 = ×10). Un umbral
  //    de km/día no lo captura por diseño; el ratio sí. Solo con el vigente ya ALTO: en
  //    odómetros bajos (unidad nueva) un ×8 legítimo es posible, así que el piso evita
  //    falsos positivos sin perder el caso real (un dígito de más siempre deja el vigente alto).
  if (kmVigente >= 5000 && kmNuevo >= kmVigente * RATIO_DIGITO_DE_MAS) {
    const veces = Math.round(kmNuevo / kmVigente);
    return { estado: "sospechosa", motivo: `Salto ×${veces} (${kmNuevo.toLocaleString("es-PE")}): posible dígito de más` };
  }

  // 2) Salto físicamente imposible. Se usa el tiempo real transcurrido pero con PISO de 1 día
  //    completo: una segunda lectura del mismo día (check-out, combustible) conserva el
  //    presupuesto de una jornada entera y no se marca por prorratear el tope a pocas horas
  //    (un bus interprovincial recorre en 10–14 h más de lo que daría kmDiaMax×horas/24).
  //    Sin tiempo conocido se cae a 30 días; el guard de ratio de arriba es el respaldo.
  const dias = opts.horasDesdeUltima != null && opts.horasDesdeUltima > 0
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
};

export async function contextoOdometro(
  client: any,
  opts: { vehiculo_id: number; flota?: Flota; tsRef?: string | null }
): Promise<ContextoOdometro> {
  const vacio: ContextoOdometro = {
    existe: false, kmVigente: 0, ritmoKmDia: null, ritmoFiable: false,
    horasDesdeUltima: null, kmDiaMax: 1500, hayHistorial: false,
  };
  if (!opts.vehiculo_id) return vacio;
  const { tabla, fk } = targetFlota(opts.flota);

  const { data: veh } = await client
    .from(tabla).select("kilometraje_actual").eq("id", opts.vehiculo_id).maybeSingle();
  if (!veh) return vacio;
  const kmVigente = Number(veh?.kilometraje_actual || 0);

  const { data: histAcept } = await client
    .from("lecturas_odometro").select("km,fecha,created_at,capturado_en,estado")
    .eq(fk, opts.vehiculo_id).in("estado", ["aceptada", "reinicio"])
    .order("created_at", { ascending: false }).limit(30);
  const vivas = (histAcept || []) as { km: number; fecha: string; created_at: string; capturado_en: string | null; estado: string }[];

  const tsUltima = vivas.length ? tsDe(vivas[0].capturado_en) ?? tsDe(vivas[0].created_at) : null;
  const tsNueva = tsDe(opts.tsRef ?? null) ?? Date.now();
  const horasDesdeUltima = tsUltima != null ? Math.max(0, (tsNueva - tsUltima) / 3600_000) : null;

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

  return { existe: true, kmVigente, ritmoKmDia, ritmoFiable, horasDesdeUltima, kmDiaMax, hayHistorial: vivas.length > 0 };
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
    ref_origen?: string | null;
    kmDiaMax?: number;
    forzar?: boolean;          // saltar validación (aceptar desde panel de revisión)
    flota?: Flota;             // "propia" (default) | "tercero"
    capturado_en?: string | null; // cuándo se TOMÓ la lectura (no cuándo se insertó)
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

  // Momento de CAPTURA de esta lectura (no el de inserción/proceso): al reprocesar una foto
  // vieja el tiempo transcurrido y las validaciones deben medirse contra cuándo se tomó.
  const fecha = l.fecha || hoyISO();

  // Vigente + historial (horas desde la última, km/día adaptativo). Mismo cálculo de siempre,
  // ahora compartido con el selector de odómetro y con los prompts de visión.
  const ctx = await contextoOdometro(client, {
    vehiculo_id: l.vehiculo_id, flota: l.flota, tsRef: l.capturado_en ?? fecha,
  });
  if (!ctx.existe) {
    return { ok: false, estado: "rechazada", motivo: "Vehículo no encontrado", error: "Vehículo no encontrado" };
  }
  const { kmVigente, horasDesdeUltima } = ctx;
  const tsNueva = tsDe(l.capturado_en) ?? tsDe(fecha) ?? Date.now();
  // El caller puede fijar el tope; si no, manda el adaptativo del contexto.
  const kmDiaMax = l.kmDiaMax && l.kmDiaMax > 0 ? l.kmDiaMax : ctx.kmDiaMax;

  // Señal de duplicado: última lectura viva con el MISMO km en una ventana corta (≤ 12 h).
  let duplicadoProbable = false;
  if (kmVigente > 0 && km === kmVigente) {
    const { data: ultViva } = await client
      .from("lecturas_odometro").select("km,created_at,capturado_en,foto_url")
      .eq(fk, l.vehiculo_id).neq("estado", "anulada")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (ultViva && Number(ultViva.km) === km) {
      const tPrev = tsDe(ultViva.capturado_en) ?? tsDe(ultViva.created_at);
      const horas = tPrev != null ? Math.abs(tsNueva - tPrev) / 3600_000 : null;
      duplicadoProbable = (horas != null && horas <= 12) || (!!l.foto_url && ultViva.foto_url === l.foto_url);
    }
  }

  const origenIA = l.fuente === "whatsapp_foto" || l.fuente === "whatsapp_manual" || l.fuente === "combustible";

  const evalr: EvalLectura = l.forzar
    ? { estado: "aceptada", motivo: null }
    : evaluarLectura({
        kmVigente, kmNuevo: km, kmDiaMax, horasDesdeUltima, origenIA, duplicadoProbable,
        fechaLectura: l.capturado_en ?? fecha,
      });

  // El motivo del caller (p.ej. "el sistema corrigió el número de la IA") se antepone al de
  // evaluarLectura para que quede visible en la bandeja; no altera el estado.
  const motivoFinal = [l.motivo?.trim() || null, evalr.motivo].filter(Boolean).join(" · ") || null;

  const { data: ins, error } = await client.from("lecturas_odometro").insert({
    [fk]: l.vehiculo_id,
    km,
    fuente: l.fuente,
    fecha,
    foto_url: l.foto_url ?? null,
    ref_origen: l.ref_origen ?? null,
    capturado_en: l.capturado_en ?? null,
    momento: l.momento ?? null,
    idem_key: l.idemKey ?? null,
    estado: evalr.estado,
    motivo: motivoFinal,
  }).select("id").single();

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
  await client.from("lecturas_odometro")
    .update({ estado: "aceptada", motivo: "Aceptada manualmente" }).eq("id", lecturaId);
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
