// Pruebas del LECTOR del mapa de /monitoreo: lib/monitoreo-datos.ts, contra una base FALSA en memoria
// (filtra, ordena, limita, proyecta y rechaza columnas que no existen como lo haría PostgREST). NO
// tocan la base real. Uso:  npx tsx scripts/prueba-monitoreo-datos.mts   (sale con 1 si algo falla)
//
// LO QUE FIJAN:
//   1. La lectura normal: una consulta por unidad VIGENTE (inactivo fuera, sin estado = vigente, los
//      ids propios y tercerizados se solapan y son dos claves), con la ventana de DIAS_ULTIMA_POSICION,
//      sin simulados, `limit(FILAS_POR_UNIDAD)`, `order(created_at desc)` y tope (abortSignal). La
//      unidad leída sin filas va a posiciones con null; la que tiene filas, a su posición —la MISMA
//      que da `ultimaPosicion` sobre sus filas—. Y el corolario: sin fallos, `sinLeer` está VACÍO (un
//      lector que lo mandara todo a sinLeer cumpliría las demás invariantes de forma trivial).
//   2. Una consulta que FALLA o que VENCE va a sinLeer, NUNCA a «sin posición», y no se reintenta a
//      ciegas (una sola consulta para esa unidad).
//   3. Una columna ACCESORIA que falta se suelta (solo la que el error nombra), la consulta se repite y
//      el `.or` del `simulado` se quita con ella; lo detectado se memoriza POR CLIENTE. Una columna
//      que NO es accesoria no se suelta: la unidad va a sinLeer.
//   4. El PRESUPUESTO corta y marca `parcial`; lo no leído va a sinLeer. posiciones y sinLeer son
//      DISJUNTOS y EXHAUSTIVOS sobre las unidades. La concurrencia nunca pasa del tope.
//   5. La identidad: una fila con los dos ids es del TERCERO; la posición nunca es de otra unidad,
//      aunque la base devolviera filas ajenas. Y la hora del TELÉFONO no ocupa el cupo: cinco filas
//      con `created_at` del futuro no tapan a las reales (la consulta lleva `.lte(created_at, ahora +
//      MARGEN_RELOJ_FUTURO_MS)`).
//   6. La flota se pagina (más de 1000 fichas); sin la columna `estado`, todas vigentes; otro error LANZA.
//   7. El umbral del «no inició»: el de la base si es un número ≥ 0; si no, o si falla, el defecto.
//   8. La respuesta trae EXACTAMENTE las claves del contrato (y cada posición, las suyas): nada de
//      placas, nombres ni teléfonos, aunque el motor algún día añadiera un campo.
//   9. `unidades`: posiciones[].unidad ∪ sin_leer ⊆ unidades, las dos disjuntas, y una unidad que no
//      está en ninguna de las dos es «leída sin posición» (null en el lector). En todos los escenarios
//      de arriba, y también si una lectura incoherente llegara a armarRespuestaFlota. Sin el `estado`
//      de la flota, `columnas_faltantes` lo NOMBRA («vehiculos_tercero.estado»).
import {
  unidadesVigentes, leerUltimasPosiciones, umbralNoInicio, flotaMonitoreo, armarRespuestaFlota,
  proyectarPosicion, COLS_OPCIONALES_GPS, type ClienteMonitoreo, type UnidadMonitoreo,
} from "../lib/monitoreo-datos";
import {
  DIAS_ULTIMA_POSICION, FILAS_POR_UNIDAD, MARGEN_RELOJ_FUTURO_MS, NO_INICIO_MIN_DEFECTO, ultimaPosicion, unidadDeFila,
  type FilaGpsMonitoreo, type PosicionUnidad,
} from "../lib/monitoreo-estado";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const seccion = (t: string) => console.log(`\n── ${t}`);

const MIN = 60_000, H = 3_600_000, DIA = 86_400_000;
/** 2026-10-13 12:00 en Lima (17:00 UTC). */
const T = Date.UTC(2026, 9, 13, 17, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const dormir = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

// ══ LA BASE FALSA ═════════════════════════════════════════════════════════════════════════

type Fila = Record<string, unknown>;
type ErrorFalso = { code: string; message: string };
type Filtro = { op: "eq" | "is" | "gte" | "lte" | "not"; col: string; val: unknown };

const COLUMNAS_GPS = [
  "id", "lat", "lng", "created_at", "fix_ts", "recibido_en", "simulado", "precision_m", "estado", "reserva_id",
  "velocidad", "vehiculo_id", "vehiculo_tercero_id", "conductor_id", "conductor_tercero_id", "timestamp", "rumbo",
];

type OpcionesFalsa = {
  /** Columnas que EXISTEN por tabla (por defecto, todas las conocidas). */
  columnas?: Partial<Record<string, string[]>>;
  retardoMs?: (c: Consulta) => number;
  error?: (c: Consulta) => ErrorFalso | null;
  cuelga?: (c: Consulta) => boolean;
  /** Una base que se porta MAL: ignora el filtro de unidad y devuelve filas ajenas. */
  ignorarFiltroUnidad?: boolean;
};

class BaseFalsa {
  consultas: Consulta[] = [];
  enVuelo = 0;
  maxEnVuelo = 0;
  respuestasConError = 0;
  constructor(public tablas: Record<string, Fila[]>, public o: OpcionesFalsa = {}) {}
  from(tabla: string) {
    const c = new Consulta(this, tabla);
    this.consultas.push(c);
    return c;
  }
  existentes(tabla: string): string[] {
    const def: Record<string, string[]> = {
      ubicaciones_gps: COLUMNAS_GPS,
      vehiculos: ["id", "estado", "placa"],
      vehiculos_tercero: ["id", "estado", "placa"],
      alerta_config: ["clave", "umbral", "activo"],
    };
    return this.o.columnas?.[tabla] ?? def[tabla] ?? [];
  }
  async ejecutar(c: Consulta): Promise<{ data: unknown; error: ErrorFalso | null }> {
    this.enVuelo++;
    this.maxEnVuelo = Math.max(this.maxEnVuelo, this.enVuelo);
    try {
      const r = this.o.retardoMs?.(c) ?? 0;
      if (r > 0) await dormir(r);
      if (this.o.cuelga?.(c)) return await new Promise<never>(() => {});
      const err = this.o.error?.(c) ?? this.columnaInexistente(c);
      if (err) { this.respuestasConError++; return { data: null, error: err }; }
      return { data: this.resolver(c), error: null };
    } finally {
      this.enVuelo--;
    }
  }
  columnaInexistente(c: Consulta): ErrorFalso | null {
    const hay = new Set(this.existentes(c.tabla));
    const usadas = [...c.cols, ...c.filtros.map((f) => f.col), ...c.orden.map((x) => x.col)];
    if (c.orFiltro) usadas.push(...[...c.orFiltro.matchAll(/(\w+)\.(?:is|eq)\./g)].map((m) => m[1]));
    const falta = usadas.find((x) => !hay.has(x));
    // Forma de Postgres (42703) para un SELECT/filtro sobre una columna que no existe.
    return falta ? { code: "42703", message: `column ${c.tabla}.${falta} does not exist` } : null;
  }
  resolver(c: Consulta): unknown {
    let filas = [...(this.tablas[c.tabla] ?? [])];
    for (const f of c.filtros) {
      if (this.o.ignorarFiltroUnidad && (f.col === "vehiculo_id" || f.col === "vehiculo_tercero_id")) continue;
      if (f.op === "eq") filas = filas.filter((r) => r[f.col] != null && String(r[f.col]) === String(f.val));
      else if (f.op === "is") filas = filas.filter((r) => (f.val === null ? r[f.col] == null : r[f.col] === f.val));
      else if (f.op === "gte") filas = filas.filter((r) => r[f.col] != null && String(r[f.col]) >= String(f.val));
      else if (f.op === "lte") filas = filas.filter((r) => r[f.col] != null && String(r[f.col]) <= String(f.val));
      else if (f.op === "not") filas = filas.filter((r) => r[f.col] != null);
    }
    if (c.orFiltro) {
      if (c.orFiltro !== "simulado.is.null,simulado.eq.false") throw new Error(`or no soportado: ${c.orFiltro}`);
      filas = filas.filter((r) => r.simulado == null || r.simulado === false);
    }
    for (const o of [...c.orden].reverse()) {
      filas.sort((a, b) => {
        const x = String(a[o.col] ?? ""), y = String(b[o.col] ?? "");
        return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1);
      });
    }
    if (c.rango) filas = filas.slice(c.rango[0], c.rango[1] + 1);
    if (c.limite != null) filas = filas.slice(0, c.limite);
    const hay = new Set(this.existentes(c.tabla));
    const proyectadas = filas.map((r) => Object.fromEntries(c.cols.filter((k) => hay.has(k)).map((k) => [k, r[k] ?? null])));
    if (c.unico) return proyectadas[0] ?? null;
    return proyectadas;
  }
}

class Consulta {
  cols: string[] = [];
  filtros: Filtro[] = [];
  orFiltro: string | null = null;
  orden: { col: string; asc: boolean }[] = [];
  limite: number | null = null;
  rango: [number, number] | null = null;
  unico = false;
  conAbort = false;
  constructor(public db: BaseFalsa, public tabla: string) {}
  select(s: string) { this.cols = s.split(",").map((x) => x.trim()).filter(Boolean); return this; }
  eq(col: string, val: unknown) { this.filtros.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filtros.push({ op: "is", col, val }); return this; }
  gte(col: string, val: unknown) { this.filtros.push({ op: "gte", col, val }); return this; }
  lte(col: string, val: unknown) { this.filtros.push({ op: "lte", col, val }); return this; }
  not(col: string, _op: string, val: unknown) { this.filtros.push({ op: "not", col, val }); return this; }
  or(s: string) { this.orFiltro = s; return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orden.push({ col, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.limite = n; return this; }
  range(a: number, b: number) { this.rango = [a, b]; return this; }
  abortSignal() { this.conAbort = true; return this; }
  maybeSingle() { this.unico = true; return this; }
  then<A, B>(ok?: (v: { data: unknown; error: ErrorFalso | null }) => A, ko?: (e: unknown) => B) {
    return this.db.ejecutar(this).then(ok, ko);
  }
  /** La unidad que pide (para los ganchos). */
  get unidad(): string | null {
    const p = this.filtros.find((f) => f.op === "eq" && f.col === "vehiculo_id");
    const t = this.filtros.find((f) => f.op === "eq" && f.col === "vehiculo_tercero_id");
    return t ? `t:${t.val}` : p ? `p:${p.val}` : null;
  }
}

const cliente = (db: BaseFalsa) => db as unknown as ClienteMonitoreo;

let idFila = 0;
/** Una fila sana: creada hace `edad`, recibida medio segundo después. */
function gps(veh: { p?: number; t?: number }, edadMs: number, o: Fila = {}): Fila {
  const c = T - edadMs;
  return {
    id: ++idFila, lat: -12.05 + idFila * 1e-5, lng: -77.04, created_at: iso(c), fix_ts: iso(c), recibido_en: iso(c + 500),
    simulado: false, precision_m: 8, estado: "en_ruta", reserva_id: 100, velocidad: 30,
    vehiculo_id: veh.p ?? null, vehiculo_tercero_id: veh.t ?? null, conductor_id: veh.p ? 7 : null, conductor_tercero_id: veh.t ? 7 : null,
    ...o,
  };
}

function baseNormal(): Record<string, Fila[]> {
  return {
    vehiculos: [
      { id: 1, estado: "activo", placa: "AAA-111" }, { id: 2, estado: null, placa: "BBB-222" },
      { id: 3, estado: "inactivo", placa: "CCC-333" }, { id: 12, estado: "operativo", placa: "DDD-444" },
    ],
    vehiculos_tercero: [{ id: 12, estado: "activo", placa: "EEE-555" }, { id: 5, estado: " INACTIVO ", placa: "FFF-666" }],
    ubicaciones_gps: [
      gps({ p: 1 }, 5 * MIN), gps({ p: 1 }, 1 * MIN), gps({ p: 1 }, 3 * MIN),
      gps({ p: 1 }, 10_000, { simulado: true }),                  // el más nuevo, pero simulado
      gps({ p: 2 }, 40 * DIA),                                    // fuera de la ventana
      gps({ p: 3 }, 1 * MIN),                                     // unidad inactiva
      gps({ p: 12 }, 10 * MIN),
      gps({ t: 12 }, 2 * H),
      gps({ t: 5 }, 1 * MIN),                                     // tercero inactivo
    ],
    alerta_config: [{ clave: "no_inicio", umbral: 15, activo: false }],
  };
}

const consultasGps = (db: BaseFalsa) => db.consultas.filter((c) => c.tabla === "ubicaciones_gps");
const filasDe = (db: BaseFalsa, clave: string): FilaGpsMonitoreo[] =>
  (db.tablas.ubicaciones_gps as FilaGpsMonitoreo[]).filter((f) => unidadDeFila(f) === clave && f.simulado !== true
    && String(f.created_at) >= iso(T - DIAS_ULTIMA_POSICION * DIA) && String(f.created_at) <= iso(T + MARGEN_RELOJ_FUTURO_MS));
const igualJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ══ 1. LECTURA NORMAL ═════════════════════════════════════════════════════════════════════

seccion("1. Lectura normal");
{
  const db = new BaseFalsa(baseNormal());
  const unidades = await unidadesVigentes(cliente(db));
  chk("vigentes: p:1, p:12, p:2, t:12 (inactivo fuera, null vigente, ids solapados = dos claves)",
    igualJson(unidades.map((u) => u.clave), ["p:1", "p:12", "p:2", "t:12"]), unidades.map((u) => u.clave).join(","));
  chk("cada unidad declara su tabla e id", unidades.every((u) => (u.clave.startsWith("p:") ? u.tabla === "vehiculos" : u.tabla === "vehiculos_tercero") && u.clave.endsWith(`:${u.id}`)));

  const lec = await leerUltimasPosiciones(cliente(db), unidades, { ahoraMs: T });
  const qs = consultasGps(db);
  chk("una consulta de GPS por unidad", qs.length === unidades.length, String(qs.length));
  chk("todas con tope (abortSignal), limit FILAS_POR_UNIDAD y order created_at desc",
    qs.every((c) => c.conAbort && c.limite === FILAS_POR_UNIDAD && c.orden.length === 1 && c.orden[0].col === "created_at" && !c.orden[0].asc));
  chk("todas con la ventana de DIAS_ULTIMA_POSICION hasta ahora + MARGEN_RELOJ_FUTURO_MS, lat no nula y sin simulados",
    qs.every((c) => c.filtros.some((f) => f.op === "gte" && f.col === "created_at" && f.val === iso(T - DIAS_ULTIMA_POSICION * DIA))
      && c.filtros.some((f) => f.op === "lte" && f.col === "created_at" && f.val === iso(T + MARGEN_RELOJ_FUTURO_MS))
      && c.filtros.some((f) => f.op === "not" && f.col === "lat") && c.orFiltro === "simulado.is.null,simulado.eq.false"));
  chk("las propias piden vehiculo_tercero_id is null; las tercerizadas no",
    qs.every((c) => (c.unidad?.startsWith("p:") ? c.filtros.some((f) => f.op === "is" && f.col === "vehiculo_tercero_id" && f.val === null)
      : !c.filtros.some((f) => f.op === "is"))));
  chk("se piden las columnas del contrato del motor (y ninguna de placa/nombre/teléfono)",
    qs.every((c) => ["lat", "lng", "created_at", "fix_ts", "recibido_en", "simulado", "precision_m", "estado", "reserva_id", "velocidad",
      "vehiculo_id", "vehiculo_tercero_id", "conductor_id", "conductor_tercero_id"].every((k) => c.cols.includes(k))
      && !c.cols.some((k) => /placa|nombre|telefono/.test(k))));
  chk("COROLARIO: sin fallos, sinLeer VACÍO y parcial = false", lec.sinLeer.length === 0 && lec.parcial === false);
  chk("p:2 (fila de hace 40 días) se LEYÓ y no tiene posición: null en el mapa, no en sinLeer",
    lec.posiciones.has("p:2") && lec.posiciones.get("p:2") === null);
  const p1 = lec.posiciones.get("p:1");
  chk("p:1: la posición más reciente NO simulada (hace 1 min)", p1 != null && p1.posicionTs === T - MIN, p1 ? iso(p1.posicionTs) : "null");
  chk("p:12 y t:12 son dos posiciones distintas, cada una con su clave",
    lec.posiciones.get("p:12")?.unidad === "p:12" && lec.posiciones.get("t:12")?.unidad === "t:12"
    && lec.posiciones.get("p:12")?.posicionTs === T - 10 * MIN && lec.posiciones.get("t:12")?.posicionTs === T - 2 * H);
  chk("cada posición es EXACTAMENTE la de `ultimaPosicion` sobre las filas de esa unidad",
    unidades.every((u) => igualJson(lec.posiciones.get(u.clave), ultimaPosicion(filasDe(db, u.clave), T))));
  chk("columnasFaltantes vacío con la base completa", lec.columnasFaltantes.length === 0);
  chk("sin unidades: nada que leer, ni parcial", await leerUltimasPosiciones(cliente(new BaseFalsa(baseNormal())), [], { ahoraMs: T })
    .then((r) => r.posiciones.size === 0 && r.sinLeer.length === 0 && !r.parcial));
}

// ══ 2. FALLA Y VENCE ═══════════════════════════════════════════════════════════════════════

seccion("2. Una consulta que falla o vence va a sinLeer, nunca a «sin posición»");
{
  const db = new BaseFalsa(baseNormal(), {
    error: (c) => (c.tabla === "ubicaciones_gps" && c.unidad === "p:12" ? { code: "08006", message: "connection reset by peer" } : null),
  });
  const unidades = await unidadesVigentes(cliente(db));
  const lec = await leerUltimasPosiciones(cliente(db), unidades, { ahoraMs: T });
  chk("p:12 (error de red) en sinLeer", lec.sinLeer.includes("p:12"));
  chk("p:12 NO está en posiciones (ni como null)", !lec.posiciones.has("p:12"));
  chk("no se reintenta a ciegas: UNA sola consulta para p:12", consultasGps(db).filter((c) => c.unidad === "p:12").length === 1);
  chk("las demás se leyeron igual y no es parcial", lec.posiciones.get("p:1") != null && lec.posiciones.has("p:2") && !lec.parcial);
}
{
  const db = new BaseFalsa(baseNormal(), { cuelga: (c) => c.tabla === "ubicaciones_gps" && c.unidad === "t:12" });
  const unidades = await unidadesVigentes(cliente(db));
  const t0 = Date.now();
  const lec = await leerUltimasPosiciones(cliente(db), unidades, { ahoraMs: T, topeConsultaMs: 40 });
  const dt = Date.now() - t0;
  chk("t:12 (no contesta nunca) en sinLeer por el tope", lec.sinLeer.includes("t:12") && !lec.posiciones.has("t:12"));
  chk("el tope corta: la lectura no se queda colgada", dt < 1000, `${dt} ms`);
  chk("las demás se leyeron", lec.posiciones.get("p:1") != null && lec.posiciones.get("p:12") != null);
}
{
  // Un cliente que LANZA (en vez de devolver error) tampoco tumba la lectura.
  const db = new BaseFalsa(baseNormal());
  const lanza: ClienteMonitoreo = {
    from: (t: string) => (t === "ubicaciones_gps" ? { select: () => { throw new Error("explotó"); } } : db.from(t)),
  };
  const lec = await leerUltimasPosiciones(lanza, [{ clave: "p:1", tabla: "vehiculos", id: 1 }], { ahoraMs: T });
  chk("un cliente que lanza: la unidad va a sinLeer, sin excepción", igualJson(lec.sinLeer, ["p:1"]) && lec.posiciones.size === 0);
}

// ══ 3. COLUMNAS ACCESORIAS ═════════════════════════════════════════════════════════════════

seccion("3. Columnas accesorias que faltan");
{
  const sinDos = COLUMNAS_GPS.filter((c) => c !== "recibido_en" && c !== "simulado");
  const tablas = baseNormal();
  // Sin la columna `simulado` no existen filas simuladas: se quitan para que la base sea coherente.
  tablas.ubicaciones_gps = tablas.ubicaciones_gps.filter((f) => f.simulado !== true);
  const db = new BaseFalsa(tablas, { columnas: { ubicaciones_gps: sinDos } });
  const cl = cliente(db);
  const unidades = await unidadesVigentes(cl);
  const lec = await leerUltimasPosiciones(cl, unidades, { ahoraMs: T, concurrencia: 1 });
  chk("se sueltan recibido_en y simulado (y solo esas)", igualJson(lec.columnasFaltantes, ["recibido_en", "simulado"]), lec.columnasFaltantes.join(","));
  chk("todas las unidades se leyeron igual", lec.sinLeer.length === 0 && lec.posiciones.get("p:1") != null && lec.posiciones.has("p:2"));
  const qs = consultasGps(db);
  chk("con concurrencia 1: dos errores (uno por columna) y después nada más", db.respuestasConError === 2, String(db.respuestasConError));
  chk("tras soltar `simulado`, el `.or` que la usa también se quita",
    qs.slice(2).every((c) => c.orFiltro === null && !c.cols.includes("simulado") && !c.cols.includes("recibido_en")));
  chk("la posición sale igual sin las dos columnas (edad por fix_ts/created_at)", lec.posiciones.get("p:1")?.posicionTs === T - MIN);
  const antes = db.respuestasConError;
  const otra = await leerUltimasPosiciones(cl, unidades, { ahoraMs: T });
  chk("MEMORIA: la segunda lectura con el MISMO cliente ya no paga ningún error", db.respuestasConError === antes && otra.sinLeer.length === 0);
  chk("y sigue declarando las columnas que faltan", igualJson(otra.columnasFaltantes, ["recibido_en", "simulado"]));
  const db2 = new BaseFalsa(baseNormal());
  const fresca = await leerUltimasPosiciones(cliente(db2), unidades, { ahoraMs: T });
  chk("la memoria es POR CLIENTE: otro cliente con la base completa pide todas", fresca.columnasFaltantes.length === 0 && db2.respuestasConError === 0);
}
{
  // Con concurrencia, varias consultas fallan a la vez por la misma columna: ninguna unidad se pierde.
  const sinFix = COLUMNAS_GPS.filter((c) => c !== "fix_ts");
  const db = new BaseFalsa(baseNormal(), { columnas: { ubicaciones_gps: sinFix }, retardoMs: () => 5 });
  const cl = cliente(db);
  const lec = await leerUltimasPosiciones(cl, await unidadesVigentes(cl), { ahoraMs: T, concurrencia: 12 });
  chk("en paralelo: fix_ts se suelta y ninguna unidad va a sinLeer", lec.sinLeer.length === 0 && igualJson(lec.columnasFaltantes, ["fix_ts"]));
}
{
  // `velocidad` NO es accesoria: no se suelta y no se reintenta.
  const db = new BaseFalsa(baseNormal(), { columnas: { ubicaciones_gps: COLUMNAS_GPS.filter((c) => c !== "velocidad") } });
  const cl = cliente(db);
  const unidades = await unidadesVigentes(cl);
  const lec = await leerUltimasPosiciones(cl, unidades, { ahoraMs: T });
  chk("una columna NO accesoria que falta: todas a sinLeer", lec.sinLeer.length === unidades.length && lec.posiciones.size === 0);
  chk("…sin reintentar a ciegas (una consulta por unidad) y sin declararla soltada",
    consultasGps(db).length === unidades.length && lec.columnasFaltantes.length === 0);
}
chk("las accesorias son exactamente fix_ts, recibido_en, simulado y precision_m",
  igualJson([...COLS_OPCIONALES_GPS].sort(), ["fix_ts", "precision_m", "recibido_en", "simulado"]));
{
  // precision_m también se puede soltar: la posición sale sin precisión (el motor la trata como imprecisa).
  const db = new BaseFalsa(baseNormal(), { columnas: { ubicaciones_gps: COLUMNAS_GPS.filter((c) => c !== "precision_m") } });
  const cl = cliente(db);
  const lec = await leerUltimasPosiciones(cl, await unidadesVigentes(cl), { ahoraMs: T });
  chk("sin precision_m: se suelta y la posición sale con precisionM null",
    igualJson(lec.columnasFaltantes, ["precision_m"]) && lec.posiciones.get("p:1")?.precisionM === null && lec.sinLeer.length === 0);
}

// ══ 4. PRESUPUESTO Y CONCURRENCIA ═════════════════════════════════════════════════════════

seccion("4. Presupuesto y concurrencia");
{
  const tablas = baseNormal();
  tablas.vehiculos = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, estado: "activo" }));
  tablas.vehiculos_tercero = [];
  tablas.ubicaciones_gps = tablas.vehiculos.map((v) => gps({ p: Number(v.id) }, MIN));
  const db = new BaseFalsa(tablas, { retardoMs: (c) => (c.tabla === "ubicaciones_gps" ? 40 : 0) });
  const cl = cliente(db);
  const unidades = await unidadesVigentes(cl);
  const lec = await leerUltimasPosiciones(cl, unidades, { ahoraMs: T, concurrencia: 2, presupuestoMs: 100 });
  const leidas = [...lec.posiciones.keys()];
  chk("el presupuesto corta: parcial = true", lec.parcial === true);
  chk("algo se leyó y algo no", leidas.length > 0 && lec.sinLeer.length > 0, `${leidas.length} leídas · ${lec.sinLeer.length} sin leer`);
  chk("posiciones y sinLeer son DISJUNTOS", leidas.every((k) => !lec.sinLeer.includes(k)));
  chk("…y EXHAUSTIVOS sobre las unidades", igualJson([...leidas, ...lec.sinLeer].sort(), unidades.map((u) => u.clave).sort()));
  chk("lo no leído por presupuesto NO se consultó (no es «sin posición»)",
    lec.sinLeer.every((k) => !lec.posiciones.has(k)) && consultasGps(db).length === leidas.length, `${consultasGps(db).length} consultas`);
  chk("la concurrencia nunca pasó de 2", db.maxEnVuelo <= 2, String(db.maxEnVuelo));
}
{
  const tablas = baseNormal();
  tablas.vehiculos = Array.from({ length: 30 }, (_, i) => ({ id: 200 + i, estado: null }));
  tablas.vehiculos_tercero = [];
  tablas.ubicaciones_gps = tablas.vehiculos.map((v) => gps({ p: Number(v.id) }, 2 * H));
  const db = new BaseFalsa(tablas, { retardoMs: (c) => (c.tabla === "ubicaciones_gps" ? 10 : 0) });
  const cl = cliente(db);
  const lec = await leerUltimasPosiciones(cl, await unidadesVigentes(cl), { ahoraMs: T, concurrencia: 12 });
  chk("30 unidades con concurrencia 12: todas leídas, nunca más de 12 a la vez", lec.posiciones.size === 30 && db.maxEnVuelo <= 12, String(db.maxEnVuelo));
  chk("COROLARIO: el pool de verdad lee en paralelo (más de 1 a la vez)", db.maxEnVuelo > 1);
}
{
  const db = new BaseFalsa(baseNormal());
  const cl = cliente(db);
  const lec = await leerUltimasPosiciones(cl, await unidadesVigentes(cl), { ahoraMs: T, presupuestoMs: 0 });
  chk("presupuesto 0: nada se consulta, todo a sinLeer y parcial", consultasGps(db).length === 0 && lec.sinLeer.length === 4 && lec.parcial);
}
{
  // Reloj simulado: el presupuesto se agota entre la 1.ª y la 2.ª vuelta de una columna faltante.
  let ahora = 0;
  const db = new BaseFalsa(baseNormal(), { columnas: { ubicaciones_gps: COLUMNAS_GPS.filter((c) => c !== "fix_ts") } });
  const reloj = () => { const r = ahora; ahora += 60; return r; };
  const lec = await leerUltimasPosiciones(cliente(db), [{ clave: "p:1", tabla: "vehiculos", id: 1 }], { ahoraMs: T, presupuestoMs: 100, concurrencia: 1, reloj });
  chk("sin presupuesto para el reintento: la unidad va a sinLeer y parcial (no se pierde callada)",
    igualJson(lec.sinLeer, ["p:1"]) && lec.parcial && !lec.posiciones.has("p:1"));
}

// ══ 5. IDENTIDAD ═══════════════════════════════════════════════════════════════════════════

seccion("5. La posición nunca es de otra unidad");
{
  const tablas = baseNormal();
  // Una fila con LOS DOS ids, la más nueva de todas: es del tercero (precedencia de claveUnidad).
  tablas.ubicaciones_gps.push(gps({ p: 1, t: 12 }, 5_000));
  const db = new BaseFalsa(tablas);
  const cl = cliente(db);
  const lec = await leerUltimasPosiciones(cl, await unidadesVigentes(cl), { ahoraMs: T });
  chk("la fila con los dos ids NO es de p:1 (sigue la de hace 1 min)", lec.posiciones.get("p:1")?.posicionTs === T - MIN);
  chk("…es de t:12 (pasa a ser su última)", lec.posiciones.get("t:12")?.posicionTs === T - 5_000);
}
{
  const db = new BaseFalsa(baseNormal(), { ignorarFiltroUnidad: true });
  const cl = cliente(db);
  const unidades = await unidadesVigentes(cl);
  const lec = await leerUltimasPosiciones(cl, unidades, { ahoraMs: T });
  chk("una base que devuelve filas AJENAS: cada posición es de su unidad o null",
    unidades.every((u) => { const p = lec.posiciones.get(u.clave); return p == null || p.unidad === u.clave; }));
}
{
  // Hallazgo de seguridad (b): un teléfono con el reloj 3 h adelantado mandó ayer cinco filas (la base
  // las recibió ayer). Hoy su reloj está bien y transmite. Sin el tope, esas cinco quedarían primeras
  // en el `order desc` para siempre y la posición real no se leería nunca.
  const tablas = baseNormal();
  const futuro = iso(T + 3 * H);
  for (let i = 0; i < FILAS_POR_UNIDAD; i++) {
    tablas.ubicaciones_gps.push(gps({ p: 1 }, 0, { created_at: futuro, fix_ts: futuro, recibido_en: iso(T - 20 * H - i * MIN), lat: -12.9 }));
  }
  const db = new BaseFalsa(tablas);
  const cl = cliente(db);
  const lec = await leerUltimasPosiciones(cl, await unidadesVigentes(cl), { ahoraMs: T });
  const p1 = lec.posiciones.get("p:1");
  chk("cinco filas con created_at del futuro NO tapan a las reales: p:1 sale con su fila de hace 1 min",
    p1 != null && p1.posicionTs === T - MIN && p1.lat !== -12.9, p1 ? `${iso(p1.posicionTs)} · ${p1.lat}` : "null");
  chk("…porque la consulta las deja FUERA (no llegaron al motor)",
    !consultasGps(db).some((c) => c.unidad === "p:1" && db.resolver(c) && (db.resolver(c) as Fila[]).some((f) => f.lat === -12.9)));
  const tablas2 = baseNormal();
  tablas2.ubicaciones_gps = [gps({ p: 1 }, 0, { created_at: iso(T + 3 * MIN), fix_ts: null, recibido_en: null })];
  const db2 = new BaseFalsa(tablas2);
  const lec2 = await leerUltimasPosiciones(cliente(db2), [{ clave: "p:1", tabla: "vehiculos", id: 1 }], { ahoraMs: T });
  chk("un reloj adelantado DENTRO del margen (3 min) sí se lee", lec2.posiciones.get("p:1")?.posicionTs === T);
}

// ══ 6. LA FLOTA ═══════════════════════════════════════════════════════════════════════════

seccion("6. La flota: paginada, sin `estado`, y un error que LANZA");
{
  const tablas = baseNormal();
  tablas.vehiculos = Array.from({ length: 2300 }, (_, i) => ({ id: i + 1, estado: i % 10 === 0 ? "inactivo" : i % 3 === 0 ? null : "activo" }));
  const db = new BaseFalsa(tablas);
  const unidades = await unidadesVigentes(cliente(db));
  const pags = db.consultas.filter((c) => c.tabla === "vehiculos");
  chk("2300 fichas: se leen en 3 páginas ordenadas por id", pags.length === 3 && pags.every((c) => c.rango && c.orden[0]?.col === "id"), String(pags.length));
  chk("las 230 inactivas fuera, las 2070 vigentes dentro (más el tercero vigente)", unidades.filter((u) => u.tabla === "vehiculos").length === 2070
    && unidades.filter((u) => u.tabla === "vehiculos_tercero").length === 1);
}
{
  const db = new BaseFalsa(baseNormal(), { columnas: { vehiculos_tercero: ["id", "placa"] } });
  const unidades = await unidadesVigentes(cliente(db));
  chk("sin la columna `estado` en vehiculos_tercero: todas vigentes (también la que decía inactivo)",
    unidades.some((u) => u.clave === "t:5") && unidades.some((u) => u.clave === "t:12"));
  chk("…y las propias siguen filtrando por su estado", !unidades.some((u) => u.clave === "p:3"));
  const r = await flotaMonitoreo(cliente(db), { ahoraMs: T });
  chk("columnas_faltantes NOMBRA «vehiculos_tercero.estado» (no queda callado)",
    r.columnas_faltantes.includes("vehiculos_tercero.estado") && !r.columnas_faltantes.includes("vehiculos.estado"), r.columnas_faltantes.join(","));
  const errores = db.respuestasConError;
  await unidadesVigentes(cliente(db));
  chk("…y se memoriza: la siguiente lectura de la flota ya no paga el error", db.respuestasConError === errores);
  const db2 = new BaseFalsa(baseNormal(), { columnas: { vehiculos: ["id", "placa"], vehiculos_tercero: ["id", "placa"] } });
  const r2 = await flotaMonitoreo(cliente(db2), { ahoraMs: T });
  chk("sin `estado` en las dos: se nombran las dos, junto a las del GPS si faltaran",
    igualJson(r2.columnas_faltantes, ["vehiculos.estado", "vehiculos_tercero.estado"]), r2.columnas_faltantes.join(","));
  chk("con la flota completa, columnas_faltantes no inventa nada",
    (await flotaMonitoreo(cliente(new BaseFalsa(baseNormal())), { ahoraMs: T })).columnas_faltantes.length === 0);
}
{
  const db = new BaseFalsa(baseNormal(), { error: (c) => (c.tabla === "vehiculos" ? { code: "57014", message: "canceling statement due to statement timeout" } : null) });
  let lanzo = false;
  try { await unidadesVigentes(cliente(db)); } catch { lanzo = true; }
  chk("otro error al leer la flota LANZA (no se convierte en «no hay flota»)", lanzo);
  let lanzo2 = false;
  try { await flotaMonitoreo(cliente(new BaseFalsa(baseNormal(), { error: (c) => (c.tabla === "vehiculos_tercero" ? { code: "XX000", message: "boom" } : null) })), { ahoraMs: T }); }
  catch { lanzo2 = true; }
  chk("…y el cálculo entero también lanza (la ruta responde 500)", lanzo2);
}

// ══ 7. UMBRAL DEL «NO INICIÓ» ═════════════════════════════════════════════════════════════

seccion("7. Umbral del «no inició»");
{
  const con = async (filas: Fila[], o: OpcionesFalsa = {}) => umbralNoInicio(cliente(new BaseFalsa({ ...baseNormal(), alerta_config: filas }, o)));
  chk("15 en la base (aunque la tarjeta esté apagada) → 15 · config", igualJson(await con([{ clave: "no_inicio", umbral: 15, activo: false }]), { min: 15, fuente: "config" }));
  chk("0 es un valor válido → 0 · config", igualJson(await con([{ clave: "no_inicio", umbral: 0 }]), { min: 0, fuente: "config" }));
  chk("\"20\" (numeric de PostgREST como texto) → 20 · config", igualJson(await con([{ clave: "no_inicio", umbral: "20" }]), { min: 20, fuente: "config" }));
  const def = { min: NO_INICIO_MIN_DEFECTO, fuente: "defecto" };
  chk("umbral null → defecto", igualJson(await con([{ clave: "no_inicio", umbral: null }]), def));
  chk("sin la fila → defecto", igualJson(await con([{ clave: "otra", umbral: 99 }]), def));
  chk("negativo → defecto", igualJson(await con([{ clave: "no_inicio", umbral: -3 }]), def));
  chk("texto basura → defecto", igualJson(await con([{ clave: "no_inicio", umbral: "abc" }]), def));
  chk("la lectura falla → defecto", igualJson(await con([{ clave: "no_inicio", umbral: 15 }], { error: (c) => (c.tabla === "alerta_config" ? { code: "08006", message: "red" } : null) }), def));
  chk("la lectura cuelga → defecto (con tope)", igualJson(await umbralNoInicio(cliente(new BaseFalsa(baseNormal(), { cuelga: (c) => c.tabla === "alerta_config" })), 30), def));
  chk("sin la columna umbral → defecto", igualJson(await con([{ clave: "no_inicio", umbral: 15 }], { columnas: { alerta_config: ["clave"] } }), def));
}

// ══ 8. LA RESPUESTA ═══════════════════════════════════════════════════════════════════════

seccion("8. La respuesta trae EXACTAMENTE el contrato");
const CLAVES_RESPUESTA = ["generado_en", "hoy", "ventana_dias", "no_inicio_min", "fuente_no_inicio", "unidades", "posiciones", "sin_leer", "parcial", "columnas_faltantes"];
const CLAVES_POSICION = ["unidad", "lat", "lng", "posicionTs", "enlaceTs", "estado", "reservaId", "conductor", "velocidadKmh", "precisionM", "aproximada", "cierreTs", "ultimo", "respaldo"];
const CLAVES_PUNTO = ["lat", "lng", "posicionTs", "puntoTs", "enlaceTs", "estado", "reservaId", "conductor", "velocidadKmh", "precisionM", "orden"];
const mismas = (o: object, claves: string[]) => igualJson(Object.keys(o).sort(), [...claves].sort());
{
  const tablas = baseNormal();
  // Un cierre impreciso para que haya `respaldo` en la respuesta.
  tablas.ubicaciones_gps.push(gps({ p: 12 }, 2 * MIN, { estado: "finalizado", precision_m: 900, reserva_id: 300 }));
  tablas.ubicaciones_gps.push(gps({ p: 12 }, 4 * MIN, { estado: "en_ruta", precision_m: 6, reserva_id: 300 }));
  const db = new BaseFalsa(tablas, { error: (c) => (c.tabla === "ubicaciones_gps" && c.unidad === "t:12" ? { code: "08006", message: "red" } : null) });
  const r = await flotaMonitoreo(cliente(db), { ahoraMs: T });
  chk("claves de la respuesta = las del contrato", mismas(r, CLAVES_RESPUESTA), Object.keys(r).join(","));
  chk("generado_en, hoy (Lima) y ventana_dias", r.generado_en === iso(T) && r.hoy === "2026-10-13" && r.ventana_dias === DIAS_ULTIMA_POSICION);
  chk("no_inicio_min y su fuente", r.no_inicio_min === 15 && r.fuente_no_inicio === "config");
  chk("posiciones = solo las NO nulas, ordenadas por unidad", igualJson(r.posiciones.map((p) => p.unidad), ["p:1", "p:12"]));
  chk("sin_leer = t:12 (falló), parcial false", igualJson(r.sin_leer, ["t:12"]) && r.parcial === false);
  chk("cada posición trae EXACTAMENTE sus claves", r.posiciones.every((p) => mismas(p, CLAVES_POSICION)));
  chk("ultimo y respaldo traen EXACTAMENTE las suyas", r.posiciones.every((p) => mismas(p.ultimo, CLAVES_PUNTO) && (p.respaldo == null || mismas(p.respaldo, CLAVES_PUNTO))));
  chk("el cierre impreciso viaja con su respaldo (aproximada)", r.posiciones.find((p) => p.unidad === "p:12")?.respaldo != null
    && r.posiciones.find((p) => p.unidad === "p:12")?.aproximada === true);
  const texto = JSON.stringify(r);
  chk("ni placas, ni nombres, ni teléfonos en el JSON", !/placa|nombre|telefono|AAA-111|DDD-444/i.test(texto));
  chk("JSON ida y vuelta sin pérdida (números finitos, nada de Infinity)", igualJson(JSON.parse(texto), r) && !/Infinity|NaN/.test(texto));
}
{
  // Si el motor algún día añadiera un campo, la proyección lo deja fuera.
  const base = ultimaPosicion([gps({ p: 1 }, MIN) as FilaGpsMonitoreo], T)!;
  const sucia = { ...base, telefono: "999888777", ultimo: { ...base.ultimo, nombre: "JUAN" } } as unknown as PosicionUnidad;
  const limpia = proyectarPosicion(sucia);
  chk("proyectarPosicion suelta un campo ajeno al contrato (también dentro de `ultimo`)",
    mismas(limpia, CLAVES_POSICION) && mismas(limpia.ultimo, CLAVES_PUNTO) && !JSON.stringify(limpia).includes("999888777"));
  const r = armarRespuestaFlota({
    ahoraMs: T, noInicio: { min: 10, fuente: "defecto" },
    lectura: { unidades: ["p:1", "p:2", "t:9"], posiciones: new Map<string, PosicionUnidad | null>([["p:1", sucia], ["p:2", null]]), sinLeer: ["t:9"], columnasFaltantes: ["simulado"], parcial: true },
  });
  chk("armarRespuestaFlota: claves exactas, null fuera, sin_leer/parcial/columnas tal cual",
    mismas(r, CLAVES_RESPUESTA) && r.posiciones.length === 1 && !JSON.stringify(r).includes("telefono")
    && igualJson(r.sin_leer, ["t:9"]) && r.parcial === true && igualJson(r.columnas_faltantes, ["simulado"]));
}
{
  const unidades: UnidadMonitoreo[] = [];
  const r = await flotaMonitoreo(cliente(new BaseFalsa({ ...baseNormal(), vehiculos: [], vehiculos_tercero: [] })), { ahoraMs: T });
  chk("flota vacía: respuesta válida, sin posiciones y sin parcial", r.posiciones.length === 0 && r.sin_leer.length === 0 && !r.parcial && unidades.length === 0);
}

// ══ 9. UNIDADES: LO QUE EL SERVIDOR QUISO LEER ════════════════════════════════════════════

seccion("9. `unidades`: posiciones ∪ sin_leer ⊆ unidades, disjuntas; el resto, leídas sin posición");
/** Comprueba la invariante sobre una respuesta y, si se da, el mapa del lector del que salió. */
function invariantesUnidades(r: { unidades: string[]; posiciones: { unidad: string }[]; sin_leer: string[] }): string | null {
  const U = new Set(r.unidades), P = r.posiciones.map((p) => p.unidad), S = r.sin_leer;
  if (U.size !== r.unidades.length) return "unidades repetidas";
  if (new Set(P).size !== P.length) return "una unidad con dos posiciones";
  if (P.some((k) => !U.has(k))) return "una posición fuera de unidades";
  if (S.some((k) => !U.has(k))) return "un sin_leer fuera de unidades";
  if (P.some((k) => S.includes(k))) return "posición y sin_leer se cruzan";
  return null;
}
{
  const escenarios: { nombre: string; db: BaseFalsa; o?: { topeConsultaMs?: number; presupuestoMs?: number; concurrencia?: number } }[] = [
    { nombre: "normal", db: new BaseFalsa(baseNormal()) },
    { nombre: "una falla", db: new BaseFalsa(baseNormal(), { error: (c) => (c.tabla === "ubicaciones_gps" && c.unidad === "p:12" ? { code: "08006", message: "red" } : null) }) },
    { nombre: "una cuelga", db: new BaseFalsa(baseNormal(), { cuelga: (c) => c.tabla === "ubicaciones_gps" && c.unidad === "t:12" }), o: { topeConsultaMs: 30 } },
    { nombre: "faltan columnas", db: new BaseFalsa(baseNormal(), { columnas: { ubicaciones_gps: COLUMNAS_GPS.filter((c) => c !== "fix_ts"), vehiculos: ["id"] } }) },
    { nombre: "presupuesto", db: new BaseFalsa(baseNormal(), { retardoMs: (c) => (c.tabla === "ubicaciones_gps" ? 40 : 0) }), o: { presupuestoMs: 50, concurrencia: 1 } },
    { nombre: "filas ajenas", db: new BaseFalsa(baseNormal(), { ignorarFiltroUnidad: true }) },
  ];
  let malos = 0, conSinPosicion = 0, conSinLeer = 0;
  for (const e of escenarios) {
    const cl = cliente(e.db);
    const vig = await unidadesVigentes(cl);
    const lec = await leerUltimasPosiciones(cl, vig, { ahoraMs: T, ...e.o });
    const r = armarRespuestaFlota({ ahoraMs: T, noInicio: { min: 10, fuente: "defecto" }, lectura: lec });
    const mal = invariantesUnidades(r);
    // unidades = exactamente las vigentes que el servidor quiso leer.
    const mismas = igualJson(r.unidades, vig.map((u) => u.clave).sort());
    // El resto (ni posición ni sin_leer) es «leída sin posición»: null en el mapa del lector.
    const resto = r.unidades.filter((k) => !r.sin_leer.includes(k) && !r.posiciones.some((p) => p.unidad === k));
    const restoNull = resto.every((k) => lec.posiciones.has(k) && lec.posiciones.get(k) === null);
    if (mal || !mismas || !restoNull) { malos++; console.log(`   ${e.nombre}: ${mal ?? ""} ${mismas ? "" : "unidades ≠ vigentes"} ${restoNull ? "" : "resto no es null"}`); }
    if (resto.length) conSinPosicion++;
    if (r.sin_leer.length) conSinLeer++;
  }
  chk(`en los ${escenarios.length} escenarios: ⊆ unidades, disjuntas, unidades = vigentes y el resto, leídas sin posición`, malos === 0, `${malos} mal`);
  chk("COROLARIO: los escenarios ejercitan las dos ramas (alguna leída sin posición, algún sin_leer)", conSinPosicion > 0 && conSinLeer > 0);
}
{
  // Una lectura INCOHERENTE no rompe la respuesta: sin_leer gana y unidades contiene todo.
  const pos = ultimaPosicion([gps({ p: 1 }, MIN) as FilaGpsMonitoreo], T)!;
  const pos7 = ultimaPosicion([gps({ p: 7 }, MIN) as FilaGpsMonitoreo], T)!;
  const r = armarRespuestaFlota({
    ahoraMs: T, noInicio: { min: 10, fuente: "defecto" },
    lectura: {
      unidades: ["p:1", "p:2"],
      posiciones: new Map<string, PosicionUnidad | null>([["p:1", pos], ["p:7", pos7], ["p:2", null]]),
      sinLeer: ["p:1", "t:3", "t:3"], columnasFaltantes: [], parcial: false,
    },
  });
  chk("lectura incoherente: la invariante se cumple por construcción", invariantesUnidades(r) === null, invariantesUnidades(r) ?? "");
  chk("…una unidad en posiciones Y sin_leer: gana sin_leer (no se dibuja)", r.sin_leer.includes("p:1") && !r.posiciones.some((p) => p.unidad === "p:1"));
  chk("…una posición o un sin_leer fuera de `unidades` se suma a unidades (no se esconde)",
    igualJson(r.unidades, ["p:1", "p:2", "p:7", "t:3"]) && igualJson(r.sin_leer, ["p:1", "t:3"]));
}

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
