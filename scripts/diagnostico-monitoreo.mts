// /monitoreo sobre los datos REALES: ¿cuánto cuesta la lectura de GET /api/monitoreo/flota y qué
// encontraría? Corre EXACTAMENTE la consulta por unidad que pide el endpoint, para TODAS las unidades
// vigentes (vehiculos + vehiculos_tercero, estado ≠ 'inactivo'), con la misma concurrencia (12), el
// mismo tope por consulta (4 s, abortSignal) y el mismo presupuesto total (20 s), e imprime:
//   · latencia por consulta p50 / p95 / máx, el tiempo total de la vuelta, cuántas fallan o se
//     abortan, y las 5 unidades más lentas (una unidad cuyas últimas filas son TODAS simuladas obliga
//     al índice a recorrer sus 30 días: es el caso patológico del filtro de `simulado`);
//   · cuántas filas devolvió cada unidad (5 / 1-4 / 0);
//   · la edad de la última posición por flota, en los mismos tramos que
//     supabase/diagnostico-monitoreo-flota.sql (≤2 min, ≤1 h, ≤1 d, ≤7 d, ≤30 d, sin posición,
//     no se pudo leer), medida con el MOTOR del endpoint (`ultimaPosicion` de lib/monitoreo-estado.ts:
//     min(fix_ts ?? created_at, recibido_en, ahora)), no con una cuenta propia;
//   · lo que el motor tuvo que corregir: cierres imprecisos (`aproximada`), el reloj del teléfono
//     adelantado (created_at > recibido_en) y el enlace vivo con la posición vieja.
// Las unidades sin posición se clasifican aparte (>30 d / nunca) con UNA consulta extra sin fecha, que
// NO cuenta en la latencia: el endpoint no la hace.
//
// Uso:  npx tsx scripts/diagnostico-monitoreo.mts [vueltas]      (vueltas 1-5, por defecto 2:
//       la primera con la caché fría y la segunda como la verá el endpoint, cada 30 s)
//
// Solo LEE (service-role). Nunca escribe. Es la medición previa a fijar FILAS_POR_UNIDAD, la
// concurrencia y el tope por consulta del endpoint.
/* eslint-disable @typescript-eslint/no-explicit-any -- lee filas crudas de PostgREST, sin tipos generados */
import fs from "node:fs";
import path from "node:path";

const VUELTAS = Number(process.argv[2] ?? 2);
if (!Number.isInteger(VUELTAS) || VUELTAS < 1 || VUELTAS > 5) {
  console.error("\n❌ Uso: npx tsx scripts/diagnostico-monitoreo.mts [vueltas]   (vueltas: entero de 1 a 5)\n");
  process.exit(1);
}

// Credenciales: las del entorno si ya están; si no, las de .env.local. Sin ellas, un mensaje claro y
// no un stack de supabase-js («supabaseUrl is required») que no dice qué falta.
const RUTA_ENV = path.join(process.cwd(), ".env.local");
if (fs.existsSync(RUTA_ENV)) {
  const env = fs.readFileSync(RUTA_ENV, "utf8");
  const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[k] && leer(k)) process.env[k] = leer(k);
  }
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    `\n❌ Faltan las credenciales de Supabase.\n\n   Necesita NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY` +
    ` (en el entorno o en ${RUTA_ENV}).` +
    `\n   Córrelo desde la máquina donde tienes el .env.local. Solo lee.\n`,
  );
  process.exit(1);
}
const { createClient } = await import("@supabase/supabase-js");
const { columnaFaltante } = await import("../lib/columna-faltante");
const M = await import("../lib/monitoreo-estado");
const D = await import("../lib/monitoreo-datos");

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Los parámetros salen del LECTOR del endpoint (lib/monitoreo-datos.ts), no de una copia. Las columnas
// son las de su COLS_GPS (que no exporta): si el lector cambia la lista, cámbiala aquí.
const CONCURRENCIA = D.CONCURRENCIA_DEFECTO;
const TOPE_CONSULTA_MS = D.TOPE_CONSULTA_MS;
const PRESUPUESTO_MS = D.PRESUPUESTO_MS;
const OPCIONALES: string[] = [...D.COLS_OPCIONALES_GPS]; // migraciones accesorias: se sueltan si faltan
const COLUMNAS = ["lat", "lng", "created_at", "estado", "reserva_id", "velocidad",
  "vehiculo_id", "vehiculo_tercero_id", "conductor_id", "conductor_tercero_id"];

type Unidad = { flota: "propia" | "tercero"; id: number; placa: string; clave: string };
type Lectura = { u: Unidad; ms: number; filas: any[] | null; error: string | null; abortada: boolean; fueraDePresupuesto: boolean };

const percentil = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)} ms` : "—");

/** Lee una tabla de unidades entera (paginada con orden total) y suelta `estado` si no existe. */
async function unidadesDe(tabla: "vehiculos" | "vehiculos_tercero"): Promise<Unidad[]> {
  let cols = "id, placa, estado";
  for (let intento = 0; intento < 2; intento++) {
    const filas: any[] = [];
    let fallo: any = null;
    for (let off = 0; off < 100_000; off += 1000) {
      const { data, error } = await admin.from(tabla).select(cols).order("id", { ascending: true }).range(off, off + 999);
      if (error) { fallo = error; break; }
      filas.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    if (fallo && columnaFaltante(fallo) === "estado" && cols.includes("estado")) { cols = "id, placa"; continue; }
    if (fallo) throw new Error(`${tabla}: ${fallo.message}`);
    const flota = tabla === "vehiculos" ? "propia" : "tercero";
    return filas.filter((f) => M.unidadVigente(f.estado)).map((f) => ({
      flota, id: Number(f.id), placa: String(f.placa ?? `#${f.id}`), clave: `${flota === "propia" ? "p" : "t"}:${f.id}`,
    }));
  }
  return [];
}

/** Columnas que existen de verdad: prueba la consulta con LIMIT 1 y suelta la que el error nombre. */
async function columnasReales(): Promise<{ cols: string[]; sinSimulado: boolean; soltadas: string[] }> {
  let cols = [...COLUMNAS, ...OPCIONALES];
  const soltadas: string[] = [];
  for (let i = 0; i <= OPCIONALES.length; i++) {
    const { error } = await admin.from("ubicaciones_gps").select(cols.join(",")).limit(1);
    if (!error) break;
    const c = columnaFaltante(error);
    if (!c || !OPCIONALES.includes(c)) throw new Error(`ubicaciones_gps: ${error.message}`);
    cols = cols.filter((x) => x !== c);
    soltadas.push(c);
  }
  return { cols, sinSimulado: !cols.includes("simulado"), soltadas };
}

/** LA consulta del endpoint (leerUltimasPosiciones de lib/monitoreo-datos.ts), para una unidad. */
function consulta(u: Unidad, cols: string[], sinSimulado: boolean, desdeISO: string, signal: AbortSignal) {
  let q: any = admin.from("ubicaciones_gps").select(cols.join(", "))
    .eq(u.flota === "propia" ? "vehiculo_id" : "vehiculo_tercero_id", u.id);
  if (u.flota === "propia") q = q.is("vehiculo_tercero_id", null);
  q = q.gte("created_at", desdeISO).not("lat", "is", null);
  if (!sinSimulado) q = q.or("simulado.is.null,simulado.eq.false");
  return q.order("created_at", { ascending: false }).limit(M.FILAS_POR_UNIDAD).abortSignal(signal);
}

/** Una vuelta del endpoint: todas las unidades, CONCURRENCIA a la vez. */
async function vuelta(unidades: Unidad[], cols: string[], sinSimulado: boolean): Promise<{ lecturas: Lectura[]; totalMs: number; ahora: number }> {
  const ahora = Date.now();
  const desdeISO = new Date(ahora - M.DIAS_ULTIMA_POSICION * 86_400_000).toISOString();
  const t0 = performance.now();
  const lecturas: Lectura[] = [];
  let siguiente = 0;
  async function trabajador() {
    while (siguiente < unidades.length) {
      const u = unidades[siguiente++];
      const fueraDePresupuesto = performance.now() - t0 > PRESUPUESTO_MS;
      const signal = AbortSignal.timeout(TOPE_CONSULTA_MS);
      const t = performance.now();
      let filas: any[] | null = null, error: string | null = null;
      try {
        const r = await consulta(u, cols, sinSimulado, desdeISO, signal);
        if (r.error) error = r.error.message || String(r.error.code ?? "error"); else filas = r.data ?? [];
      } catch (e: any) { error = e?.message ?? String(e); }
      lecturas.push({ u, ms: performance.now() - t, filas, error, abortada: signal.aborted, fueraDePresupuesto });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, unidades.length) }, trabajador));
  return { lecturas, totalMs: performance.now() - t0, ahora };
}

const TRAMOS = ["≤2 min", "≤1 h", "≤1 d", "≤7 d", "≤30 d", "sin posición", "no se pudo leer"] as const;
function tramo(min: number): (typeof TRAMOS)[number] {
  return min <= M.EN_LINEA_MIN ? "≤2 min" : min <= 60 ? "≤1 h" : min <= 1440 ? "≤1 d" : min <= 10080 ? "≤7 d" : "≤30 d";
}

async function main() {
  console.log(`\nMONITOREO · la lectura de /api/monitoreo/flota sobre los datos reales\n${"═".repeat(72)}`);
  const unidades = [...await unidadesDe("vehiculos"), ...await unidadesDe("vehiculos_tercero")];
  const { cols, sinSimulado, soltadas } = await columnasReales();
  console.log(`${unidades.length} unidad(es) vigente(s): ${unidades.filter((u) => u.flota === "propia").length} propia(s), ` +
    `${unidades.filter((u) => u.flota === "tercero").length} tercerizada(s).`);
  console.log(`Consulta: ${M.FILAS_POR_UNIDAD} filas por unidad, ${M.DIAS_ULTIMA_POSICION} días, concurrencia ${CONCURRENCIA}, ` +
    `tope ${TOPE_CONSULTA_MS} ms, presupuesto ${PRESUPUESTO_MS} ms.` +
    (soltadas.length ? `\n⚠ Columnas que NO existen y el endpoint soltaría: ${soltadas.join(", ")}` +
      (sinSimulado ? " (sin `simulado` tampoco va el filtro .or())." : "") : ""));

  let ultima: Awaited<ReturnType<typeof vuelta>> | null = null;
  for (let v = 1; v <= VUELTAS; v++) {
    const r = await vuelta(unidades, cols, sinSimulado);
    ultima = r;
    const lat = r.lecturas.map((l) => l.ms);
    const abortadas = r.lecturas.filter((l) => l.abortada).length;
    const errores = r.lecturas.filter((l) => l.error && !l.abortada);
    const tarde = r.lecturas.filter((l) => l.fueraDePresupuesto).length;
    console.log(`\n── VUELTA ${v}${v === 1 ? " (caché fría)" : ""} ${"─".repeat(56)}`);
    console.log(`Total ${ms(r.totalMs)} · por consulta p50 ${ms(percentil(lat, 0.5))} · p95 ${ms(percentil(lat, 0.95))} · máx ${ms(Math.max(...lat))}`);
    console.log(`Fallan ${errores.length + abortadas} de ${r.lecturas.length}: ${abortadas} abortada(s) por el tope de ${TOPE_CONSULTA_MS} ms, ` +
      `${errores.length} con error.` + (tarde ? ` ⚠ ${tarde} habrían empezado DESPUÉS del presupuesto de ${PRESUPUESTO_MS} ms.` : ""));
    for (const e of errores.slice(0, 5)) console.log(`   ! ${e.u.placa} (${e.u.clave}): ${e.error}`);
    const lentas = [...r.lecturas].sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(`Las 5 más lentas: ${lentas.map((l) => `${l.u.placa} ${ms(l.ms)}${l.abortada ? " (abortada)" : ""}`).join(" · ")}`);
    const n = (f: (k: number) => boolean) => r.lecturas.filter((l) => l.filas && f(l.filas.length)).length;
    console.log(`Filas devueltas: ${M.FILAS_POR_UNIDAD} → ${n((k) => k === M.FILAS_POR_UNIDAD)} · 1-${M.FILAS_POR_UNIDAD - 1} → ` +
      `${n((k) => k > 0 && k < M.FILAS_POR_UNIDAD)} · 0 → ${n((k) => k === 0)}`);
  }
  if (!ultima) return;

  // ── Edades, con el motor del endpoint, sobre la última vuelta ──
  const ahora = ultima.ahora;
  const sinPosicion: Unidad[] = [];
  const cuenta = new Map<string, number>();
  let aproximadas = 0, cierres = 0, relojAdelantado = 0, enlaceVivoPosVieja = 0, filasNoDibujables = 0;
  for (const l of ultima.lecturas) {
    let t: (typeof TRAMOS)[number];
    if (l.error || !l.filas) t = "no se pudo leer";
    else {
      const p = M.ultimaPosicion(l.filas.filter((f) => M.unidadDeFila(f) === l.u.clave), ahora);
      if (!p) {
        t = "sin posición";
        sinPosicion.push(l.u);
        if (l.filas.length) filasNoDibujables++;
      } else {
        t = tramo((ahora - p.posicionTs) / 60_000);
        if (p.aproximada) aproximadas++;
        if (p.cierreTs != null) cierres++;
        const f0 = l.filas[0];
        if (f0?.recibido_en && Date.parse(f0.created_at) - Date.parse(f0.recibido_en) > 2 * 60_000) relojAdelantado++;
        if (ahora - p.enlaceTs <= M.EN_LINEA_MIN * 60_000 && ahora - p.posicionTs > M.SENAL_PERDIDA_MIN * 60_000) enlaceVivoPosVieja++;
      }
    }
    const k = `${l.u.flota}|${t}`;
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
  }
  console.log(`\n── ÚLTIMA POSICIÓN (motor del endpoint: min(fix_ts ?? created_at, recibido_en, ahora)) ${"─".repeat(4)}`);
  for (const flota of ["propia", "tercero"] as const) {
    const total = unidades.filter((u) => u.flota === flota).length;
    console.log(`${flota.padEnd(8)} (${total}): ` + TRAMOS.map((t) => `${t} ${cuenta.get(`${flota}|${t}`) ?? 0}`).join(" · "));
  }
  console.log(`Cierres de servicio como última fila: ${cierres}, de ellos con la posición aproximada (cierre impreciso): ${aproximadas}.`);
  console.log(`Reloj del teléfono adelantado > 2 min (created_at − recibido_en): ${relojAdelantado}. ` +
    `Enlace vivo (≤ ${M.EN_LINEA_MIN} min) con la posición de > ${M.SENAL_PERDIDA_MIN} min: ${enlaceVivoPosVieja}.`);
  if (filasNoDibujables) console.log(`⚠ ${filasNoDibujables} unidad(es) con filas pero ninguna dibujable ((0,0), coordenadas inválidas…): ` +
    `con ${M.FILAS_POR_UNIDAD} filas no alcanzó para encontrar una buena.`);

  // ── Las que no tienen posición: ¿>30 d o nunca? (consulta EXTRA, no la hace el endpoint) ──
  if (sinPosicion.length) {
    const clase = new Map<string, string[]>();
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, sinPosicion.length) }, async () => {
      while (i < sinPosicion.length) {
        const u = sinPosicion[i++];
        const { data, error } = await admin.from("ubicaciones_gps").select("created_at")
          .eq(u.flota === "propia" ? "vehiculo_id" : "vehiculo_tercero_id", u.id)
          .order("created_at", { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(TOPE_CONSULTA_MS));
        const ts = data?.[0]?.created_at ? Date.parse(data[0].created_at) : null;
        const c = error ? "no se pudo leer" : ts == null ? "nunca"
          : ts >= ahora - M.DIAS_ULTIMA_POSICION * 86_400_000 ? "solo filas descartadas en 30 d" : ">30 d";
        clase.set(c, [...(clase.get(c) ?? []), u.placa]);
      }
    }));
    console.log(`\nSin posición válida (${sinPosicion.length}), por su última fila de cualquier tipo:`);
    for (const [c, placas] of clase) console.log(`   ${c}: ${placas.length} — ${placas.slice(0, 12).join(", ")}${placas.length > 12 ? "…" : ""}`);
  }
  console.log(`\nCarga del endpoint: ${unidades.length} consultas por vuelta; con la caché de 30 s, como mucho ` +
    `${unidades.length * 2} por minuto, sea cual sea el número de pantallas abiertas.\n`);
}

main().catch((e) => { console.error(`\n❌ ${e?.message ?? e}\n`); process.exit(1); });
