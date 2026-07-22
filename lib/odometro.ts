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
export function evaluarLectura(opts: {
  kmVigente: number | null | undefined;
  kmNuevo: number;
  kmDiaMax?: number;                  // tope de plausibilidad km/día
  diasDesdeUltima?: number | null;    // días desde la última lectura aceptada
}): EvalLectura {
  const kmNuevo = Number(opts.kmNuevo);
  const kmVigente = Number(opts.kmVigente || 0);
  const kmDiaMax = opts.kmDiaMax && opts.kmDiaMax > 0 ? opts.kmDiaMax : 1500;

  if (!Number.isFinite(kmNuevo) || kmNuevo < 0) {
    return { estado: "rechazada", motivo: "Lectura inválida" };
  }
  if (kmVigente <= 0) return { estado: "aceptada", motivo: null }; // primera lectura
  if (kmNuevo < kmVigente) {
    return {
      estado: "sospechosa",
      motivo: `Retrocede: ${kmNuevo.toLocaleString("es-PE")} < vigente ${kmVigente.toLocaleString("es-PE")}`,
    };
  }
  if (kmNuevo === kmVigente) return { estado: "aceptada", motivo: null };

  // Mayor al vigente: validar que el salto sea físicamente posible
  const dias = opts.diasDesdeUltima && opts.diasDesdeUltima > 0 ? opts.diasDesdeUltima : 30;
  const saltoMax = kmDiaMax * dias;
  const salto = kmNuevo - kmVigente;
  if (salto > saltoMax) {
    return {
      estado: "sospechosa",
      motivo: `Salto improbable: +${salto.toLocaleString("es-PE")} km en ~${dias} día(s)`,
    };
  }
  return { estado: "aceptada", motivo: null };
}

function diasEntre(fechaISO: string | null | undefined, hasta: Date): number | null {
  if (!fechaISO) return null;
  const base = fechaISO.length <= 10 ? fechaISO + "T00:00:00" : fechaISO;
  const t = new Date(base).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((hasta.getTime() - t) / 86400000));
}

function hoyISO(): string {
  return new Date().toISOString().split("T")[0];
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
  }
): Promise<{ ok: boolean; estado: EstadoLectura; motivo: string | null; lecturaId?: string; error?: string }> {
  const km = Number(l.km);
  if (!l.vehiculo_id || !Number.isFinite(km) || km <= 0) {
    return { ok: false, estado: "rechazada", motivo: "Datos incompletos", error: "Datos incompletos" };
  }

  const { tabla, fk } = targetFlota(l.flota);

  const { data: veh } = await client
    .from(tabla).select("kilometraje_actual").eq("id", l.vehiculo_id).maybeSingle();
  if (!veh) {
    return { ok: false, estado: "rechazada", motivo: "Vehículo no encontrado", error: "Vehículo no encontrado" };
  }
  const { data: ult } = await client
    .from("lecturas_odometro").select("fecha")
    .eq(fk, l.vehiculo_id).eq("estado", "aceptada")
    .order("fecha", { ascending: false }).limit(1).maybeSingle();

  const kmVigente = Number(veh?.kilometraje_actual || 0);
  const diasDesdeUltima = diasEntre(ult?.fecha, new Date());

  const evalr: EvalLectura = l.forzar
    ? { estado: "aceptada", motivo: null }
    : evaluarLectura({ kmVigente, kmNuevo: km, kmDiaMax: l.kmDiaMax, diasDesdeUltima });

  const fecha = l.fecha || hoyISO();

  const { data: ins, error } = await client.from("lecturas_odometro").insert({
    [fk]: l.vehiculo_id,
    km,
    fuente: l.fuente,
    fecha,
    foto_url: l.foto_url ?? null,
    ref_origen: l.ref_origen ?? null,
    estado: evalr.estado,
    motivo: evalr.motivo,
  }).select("id").single();

  if (error) return { ok: false, estado: evalr.estado, motivo: evalr.motivo, error: error.message };

  if (evalr.estado === "aceptada" && km > kmVigente) {
    await client.from(tabla).update({ kilometraje_actual: km }).eq("id", l.vehiculo_id);
  }

  return { ok: true, estado: evalr.estado, motivo: evalr.motivo, lecturaId: ins?.id };
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

/** Motivos tipificados de anulación. La clave viaja a odometro_correcciones.motivo_tipo. */
export const MOTIVOS_ANULACION = [
  { id: "ia_digito",   label: "La IA leyó mal un dígito",      ensena: true  },
  { id: "ia_trip",     label: "La IA leyó el parcial (trip)",  ensena: true  },
  { id: "otra_unidad", label: "Foto de otra unidad",           ensena: false },
  { id: "duplicada",   label: "Lectura duplicada",             ensena: false },
  { id: "tipeo",       label: "Error al tipear el km",         ensena: false },
  { id: "reinicio",    label: "Era un reinicio de tablero",    ensena: false },
  { id: "otro",        label: "Otro",                          ensena: false },
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
): Promise<{ ok: boolean; kmVigente?: number | null; error?: string }> {
  const { data: l } = await client.from("lecturas_odometro").select("*").eq("id", opts.lecturaId).single();
  if (!l) return { ok: false, error: "Lectura no encontrada" };
  if (l.estado === "anulada") return { ok: false, error: "La lectura ya está anulada" };

  const esTercero = l.vehiculo_tercero_id != null;
  const vid = esTercero ? l.vehiculo_tercero_id : l.vehiculo_id;
  const flota: Flota = esTercero ? "tercero" : "propia";

  // 1) Bitácora + dataset de aprendizaje. Se escribe ANTES de mutar la lectura:
  //    si esto falla, no anulamos (no queremos anulaciones sin explicación).
  const { error: eCorr } = await client.from("odometro_correcciones").insert({
    lectura_id: l.id,
    vehiculo_id: esTercero ? null : vid,
    vehiculo_tercero_id: esTercero ? vid : null,
    placa: opts.placa ?? null,
    km_leido: Number(l.km),
    km_correcto: opts.km_correcto != null && Number.isFinite(Number(opts.km_correcto)) ? Number(opts.km_correcto) : null,
    fuente: l.fuente,
    motivo_tipo: opts.motivo_tipo,
    nota: opts.nota || null,
    foto_url: l.foto_url || null,
    usuario: opts.usuario || null,
  });
  if (eCorr) return { ok: false, error: "No se pudo guardar la corrección: " + eCorr.message };

  // 2) Anular la lectura (se conserva la fila y la foto como evidencia).
  const etiqueta = MOTIVOS_ANULACION.find(m => m.id === opts.motivo_tipo)?.label || opts.motivo_tipo;
  const { error: eUpd } = await client.from("lecturas_odometro")
    .update({ estado: "anulada", motivo: `Anulada: ${etiqueta}${opts.nota ? " — " + opts.nota : ""}` })
    .eq("id", l.id);
  if (eUpd) return { ok: false, error: eUpd.message };

  // 3) El vigente es derivado → recalcular sin la lectura anulada.
  const rec = await recalcularKmVigente(client, { vehiculo_id: vid, flota });
  return { ok: true, kmVigente: rec.km };
}

/**
 * Últimas correcciones de lecturas hechas por IA, en texto plano, para inyectar
 * como ejemplos en el prompt de visión. Solo los motivos que enseñan algo sobre
 * cómo mirar la foto (dígito mal leído, parcial confundido con total).
 */
export async function leccionesOdometro(client: any, limite = 12): Promise<string> {
  const ensenables = MOTIVOS_ANULACION.filter(m => m.ensena).map(m => m.id);
  const { data } = await client
    .from("odometro_correcciones")
    .select("km_leido,km_correcto,motivo_tipo,nota")
    .in("motivo_tipo", ensenables)
    .order("created_at", { ascending: false })
    .limit(limite);
  const filas = (data || []) as any[];
  if (!filas.length) return "";
  return filas.map(c => {
    const corr = c.km_correcto ? `lo correcto era ${Number(c.km_correcto).toLocaleString("es-PE")}` : "el valor era incorrecto";
    const tipo = c.motivo_tipo === "ia_trip" ? "leíste el parcial/trip en vez del total" : "leíste mal un dígito";
    return `- Devolviste ${Number(c.km_leido).toLocaleString("es-PE")} y ${corr}: ${tipo}${c.nota ? ` (${c.nota})` : ""}.`;
  }).join("\n");
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
