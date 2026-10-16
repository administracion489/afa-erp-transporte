// Matriz del LECTOR + ORQUESTACIÓN del horario POR EMPLEADO: lib/rrhh/horario-datos.ts y la
// extensión de lib/rrhh/jornada-datos.ts. Corre contra una base FALSA en memoria (filtra, proyecta
// y rechaza columnas inexistentes como PostgREST). NO toca la base real.
// Uso:  npx tsx scripts/prueba-horario-datos.mts   (sale con 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ
//
// 1 · overridesHorarioDe lee de empleado_perfil SOLO los campos declarados (un campo NULL no se
//     guarda, `tolerancia_min: 0` SÍ —0 es una config real—), deduplica usuarios y con [] no consulta.
// 2 · DEGRADACIÓN: si el error NOMBRA una de las 4 columnas se suelta ESA y se reintenta; soltadas
//     las 4 ⇒ sinMigracion:true + overrides vacíos (y exactamente 4 consultas, no 5). Falta la TABLA ⇒
//     sinMigracion:true. OTRO error (permiso) ⇒ ABORTA (no es "sin override").
// 3 · cfgsEfectivasDe arma una cfg por usuario: el override gana campo a campo; un usuario SIN override
//     recibe una cfg IDÉNTICA al global campo a campo (herencia byte a byte).
// 4 · jornadasDelRango: SIN el parámetro `horario`, cada jornada usa el global —byte a byte igual a
//     pasar un Map todo-global y al comportamiento anterior—. Con `cfgPorUsuario`, cada empleado usa SU
//     cfg (el ausente cae al global). Con `porEmpleado:true`, el lector resuelve los overrides él mismo;
//     sin la migración rrhh-04 esa resolución cae al global para todos (misma salida que hoy).

import { overridesHorarioDe, cfgsEfectivasDe } from "../lib/rrhh/horario-datos";
import { jornadasDelRango, type JornadaDeDia } from "../lib/rrhh/jornada-datos";
import { horarioEfectivo } from "../lib/rrhh/horario";
import type { ConfigRrhh } from "../lib/rrhh/tipos";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const seccion = (t: string) => console.log(`\n── ${t}`);

const GLOBAL: ConfigRrhh = {
  sede_lat: -12.05, sede_lng: -77.04, sede_radio_m: 100,
  hora_entrada: "08:00", hora_salida: "17:00", tolerancia_min: 0, almuerzo_min: 60,
  geocerca_bloquea: true,
};

// ══ BASE FALSA ════════════════════════════════════════════════════════════════════════════
type Fila = Record<string, unknown>;
type ErrorFalso = { code: string; message: string } | null;

type OpcionesFalsa = {
  /** Columnas que EXISTEN por tabla (sin esto: todas las de las filas + usuario_id). */
  columnas?: Record<string, string[]>;
  /** Error forzado por tabla (se devuelve en TODA consulta a esa tabla). */
  error?: Record<string, ErrorFalso>;
};

class BaseFalsa {
  consultasPorTabla: Record<string, number> = {};
  constructor(public tablas: Record<string, Fila[]>, public o: OpcionesFalsa = {}) {}
  from(tabla: string) { return new Consulta(this, tabla); }
  existentes(tabla: string): Set<string> {
    if (this.o.columnas?.[tabla]) return new Set(this.o.columnas[tabla]);
    const s = new Set<string>(["usuario_id"]);
    for (const r of this.tablas[tabla] ?? []) for (const k of Object.keys(r)) s.add(k);
    return s;
  }
  async ejecutar(c: Consulta): Promise<{ data: unknown; error: ErrorFalso }> {
    this.consultasPorTabla[c.tabla] = (this.consultasPorTabla[c.tabla] ?? 0) + 1;
    const forzado = this.o.error?.[c.tabla];
    if (forzado) return { data: null, error: forzado };
    // Columna inexistente (SELECT con lista explícita): PostgREST → 42703 nombrando la PRIMERA.
    if (c.cols.length && c.cols[0] !== "*") {
      const hay = this.existentes(c.tabla);
      const falta = c.cols.find((k) => !hay.has(k));
      if (falta) return { data: null, error: { code: "42703", message: `column "${falta}" does not exist` } };
    }
    return { data: this.resolver(c), error: null };
  }
  resolver(c: Consulta): Fila[] {
    let filas = [...(this.tablas[c.tabla] ?? [])];
    for (const f of c.filtros) {
      if (f.op === "in") filas = filas.filter((r) => (f.val as unknown[]).some((v) => String(v) === String(r[f.col])));
      else if (f.op === "eq") filas = filas.filter((r) => String(r[f.col]) === String(f.val));
      else if (f.op === "gte") filas = filas.filter((r) => String(r[f.col]) >= String(f.val));
      else if (f.op === "lt") filas = filas.filter((r) => String(r[f.col]) < String(f.val));
    }
    for (const o of [...c.orden].reverse()) {
      filas.sort((a, b) => {
        const x = String(a[o.col] ?? ""), y = String(b[o.col] ?? "");
        return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1);
      });
    }
    if (c.rango) filas = filas.slice(c.rango[0], c.rango[1] + 1);
    if (c.cols.length && c.cols[0] !== "*") {
      const hay = this.existentes(c.tabla);
      filas = filas.map((r) => Object.fromEntries(c.cols.filter((k) => hay.has(k)).map((k) => [k, r[k] ?? null])));
    }
    return filas;
  }
}

class Consulta {
  cols: string[] = [];
  filtros: { op: "in" | "eq" | "gte" | "lt"; col: string; val: unknown }[] = [];
  orden: { col: string; asc: boolean }[] = [];
  rango: [number, number] | null = null;
  constructor(public db: BaseFalsa, public tabla: string) {}
  select(s: string) { this.cols = s.split(",").map((x) => x.trim()).filter(Boolean); return this; }
  in(col: string, val: unknown[]) { this.filtros.push({ op: "in", col, val }); return this; }
  eq(col: string, val: unknown) { this.filtros.push({ op: "eq", col, val }); return this; }
  gte(col: string, val: unknown) { this.filtros.push({ op: "gte", col, val }); return this; }
  lt(col: string, val: unknown) { this.filtros.push({ op: "lt", col, val }); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orden.push({ col, asc: o?.ascending !== false }); return this; }
  range(a: number, b: number) { this.rango = [a, b]; return this; }
  then<A, B>(ok?: (v: { data: unknown; error: ErrorFalso }) => A, ko?: (e: unknown) => B) {
    return this.db.ejecutar(this).then(ok, ko);
  }
}

const cliente = (db: BaseFalsa) => db as unknown as { from: (t: string) => any };

// ── 1 · overridesHorarioDe: lee lo declarado, el 0 cuenta, dedup, [] no consulta ──────────
seccion("1 · overridesHorarioDe");
{
  const db = new BaseFalsa({
    empleado_perfil: [
      { usuario_id: "A", hora_entrada: "09:00:00", hora_salida: null, tolerancia_min: null, almuerzo_min: null },
      { usuario_id: "B", hora_entrada: null, hora_salida: null, tolerancia_min: null, almuerzo_min: null },
      { usuario_id: "C", hora_entrada: null, hora_salida: null, tolerancia_min: 0, almuerzo_min: 45 },
    ],
  });
  const { overrides, sinMigracion } = await overridesHorarioDe(cliente(db), ["A", "A", "B", "C"]);
  chk("sinMigracion false con las 4 columnas presentes", sinMigracion === false);
  chk("A: solo el campo declarado (hora_entrada), los NULL no se guardan",
    JSON.stringify(overrides.get("A")) === JSON.stringify({ hora_entrada: "09:00:00" }));
  chk("B (todo NULL) NO entra al Map", overrides.has("B") === false);
  chk("C: tolerancia_min 0 SÍ cuenta (0 es config real), con almuerzo_min 45",
    JSON.stringify(overrides.get("C")) === JSON.stringify({ tolerancia_min: 0, almuerzo_min: 45 }));
  chk("dedup: A pedido dos veces, una sola entrada", overrides.get("A") !== undefined && overrides.size === 2);
}
{
  const db = new BaseFalsa({ empleado_perfil: [{ usuario_id: "A", hora_entrada: "09:00:00" }] });
  const { overrides, sinMigracion } = await overridesHorarioDe(cliente(db), []);
  chk("usuarioIds vacío ⇒ no consulta, overrides vacíos, no sinMigracion",
    overrides.size === 0 && sinMigracion === false && (db.consultasPorTabla.empleado_perfil ?? 0) === 0);
}

// ── 2 · DEGRADACIÓN ──────────────────────────────────────────────────────────────────────
seccion("2 · Degradación rrhh-04");
{
  // empleado_perfil existe pero SIN las 4 columnas de rrhh-04.
  const db = new BaseFalsa(
    { empleado_perfil: [{ usuario_id: "A" }] },
    { columnas: { empleado_perfil: ["usuario_id", "marca_asistencia"] } },
  );
  const { overrides, sinMigracion } = await overridesHorarioDe(cliente(db), ["A"]);
  chk("las 4 columnas faltan ⇒ sinMigracion:true, overrides vacíos", sinMigracion === true && overrides.size === 0);
  chk("se soltó UNA por consulta: exactamente 4 consultas (no 5)", db.consultasPorTabla.empleado_perfil === 4,
    `${db.consultasPorTabla.empleado_perfil}`);
}
{
  // Solo falta una columna (parcial, defensivo): se suelta esa y se lee el resto.
  const db = new BaseFalsa(
    { empleado_perfil: [{ usuario_id: "A", hora_entrada: "07:30:00", tolerancia_min: 5, almuerzo_min: 30 }] },
    { columnas: { empleado_perfil: ["usuario_id", "hora_entrada", "tolerancia_min", "almuerzo_min"] } }, // falta hora_salida
  );
  const { overrides, sinMigracion } = await overridesHorarioDe(cliente(db), ["A"]);
  chk("falta solo hora_salida ⇒ se lee el resto, sinMigracion false",
    sinMigracion === false &&
    JSON.stringify(overrides.get("A")) === JSON.stringify({ hora_entrada: "07:30:00", tolerancia_min: 5, almuerzo_min: 30 }));
}
{
  const db = new BaseFalsa({}, { error: { empleado_perfil: { code: "42P01", message: 'relation "public.empleado_perfil" does not exist' } } });
  const { overrides, sinMigracion } = await overridesHorarioDe(cliente(db), ["A"]);
  chk("falta la TABLA entera ⇒ sinMigracion:true, overrides vacíos", sinMigracion === true && overrides.size === 0);
}
{
  const db = new BaseFalsa({}, { error: { empleado_perfil: { code: "42501", message: "permission denied for table empleado_perfil" } } });
  let abortó = false;
  try { await overridesHorarioDe(cliente(db), ["A"]); } catch { abortó = true; }
  chk("OTRO error (permiso) ⇒ ABORTA, no se toma por 'sin override'", abortó === true);
}

// ── 3 · cfgsEfectivasDe: una cfg por usuario, override gana, sin override ≡ global ─────────
seccion("3 · cfgsEfectivasDe");
{
  const db = new BaseFalsa({
    empleado_perfil: [{ usuario_id: "A", hora_entrada: "09:00:00", almuerzo_min: 30 }],
  });
  const cfgs = await cfgsEfectivasDe(cliente(db), ["A", "B"], GLOBAL);
  chk("una entrada por usuario pedido", cfgs.size === 2 && cfgs.has("A") && cfgs.has("B"));
  const a = cfgs.get("A")!;
  chk("A: override gana campo a campo (entrada 09:00, almuerzo 30), el resto hereda",
    a.hora_entrada === "09:00" && a.almuerzo_min === 30 && a.hora_salida === GLOBAL.hora_salida && a.tolerancia_min === GLOBAL.tolerancia_min);
  chk("B (sin override) ≡ global campo a campo", JSON.stringify(cfgs.get("B")) === JSON.stringify(horarioEfectivo(null, GLOBAL)) &&
    JSON.stringify(cfgs.get("B")) === JSON.stringify(GLOBAL));
}

// ══ jornadasDelRango ══════════════════════════════════════════════════════════════════════
// Marcas: A y B entran 08:30 y salen 17:00 el mismo día de Lima. Sin almuerzo (default). Con el
// global (entrada 08:00, tolerancia 0) ambos llegan 30 min tarde.
let nMarca = 0;
const marca = (usuario_id: string, tipo: string, hhmm: string, fecha = "2026-01-10"): Fila =>
  ({ id: ++nMarca, usuario_id, tipo, marcado_en: `${fecha}T${hhmm}:00-05:00` });
const MARCAS: Fila[] = [
  marca("A", "entrada", "08:30"), marca("A", "salida", "17:00"),
  marca("B", "entrada", "08:30"), marca("B", "salida", "17:00"),
];
const tard = (js: JornadaDeDia[], u: string) => js.find((j) => j.usuario_id === u)?.tardanza_min;
const rango = { desde: "2026-01-10", hasta: "2026-01-10" };

seccion("4 · jornadasDelRango");
{
  const db = new BaseFalsa({ rrhh_marca: MARCAS });
  const base = await jornadasDelRango(cliente(db), rango, GLOBAL);
  chk("SIN parámetro: A y B llegan 30 tarde (global para todos)", tard(base.jornadas, "A") === 30 && tard(base.jornadas, "B") === 30);

  // Byte a byte: pasar un Map TODO-global da exactamente el mismo resultado que no pasar nada.
  const todoGlobal = new Map([["A", horarioEfectivo(null, GLOBAL)], ["B", horarioEfectivo(null, GLOBAL)]]);
  const conGlobal = await jornadasDelRango(cliente(new BaseFalsa({ rrhh_marca: MARCAS })), rango, GLOBAL, { cfgPorUsuario: todoGlobal });
  chk("Map todo-global ≡ sin parámetro (byte a byte)", JSON.stringify(conGlobal.jornadas) === JSON.stringify(base.jornadas));

  // cfgPorUsuario: A entra 09:00 ⇒ 08:30 ya no es tarde; B ausente del Map ⇒ global (30).
  const soloA = new Map([["A", horarioEfectivo({ hora_entrada: "09:00:00" }, GLOBAL)]]);
  const conA = await jornadasDelRango(cliente(new BaseFalsa({ rrhh_marca: MARCAS })), rango, GLOBAL, { cfgPorUsuario: soloA });
  chk("cfgPorUsuario: A sin tardanza (su horario), B sigue 30 (ausente ⇒ global)",
    tard(conA.jornadas, "A") === 0 && tard(conA.jornadas, "B") === 30);
}
{
  // porEmpleado:true resuelve internamente leyendo empleado_perfil.
  const db = new BaseFalsa({
    rrhh_marca: MARCAS,
    empleado_perfil: [{ usuario_id: "A", hora_entrada: "09:00:00" }],
  });
  const r = await jornadasDelRango(cliente(db), rango, GLOBAL, { porEmpleado: true });
  chk("porEmpleado:true ⇒ A usa su horario (0), B hereda global (30)",
    tard(r.jornadas, "A") === 0 && tard(r.jornadas, "B") === 30);
}
{
  // porEmpleado:true SIN la migración rrhh-04 ⇒ todos al global: byte a byte lo de hoy.
  const sinMig = new BaseFalsa(
    { rrhh_marca: MARCAS, empleado_perfil: [{ usuario_id: "A" }] },
    { columnas: { empleado_perfil: ["usuario_id", "marca_asistencia"] } },
  );
  const r = await jornadasDelRango(cliente(sinMig), rango, GLOBAL, { porEmpleado: true });
  const base = await jornadasDelRango(cliente(new BaseFalsa({ rrhh_marca: MARCAS })), rango, GLOBAL);
  chk("porEmpleado:true sin rrhh-04 ≡ sin parámetro (byte a byte)", JSON.stringify(r.jornadas) === JSON.stringify(base.jornadas));
}

console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
