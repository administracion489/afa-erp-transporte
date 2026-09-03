// Cuántos ÍTEMS saldrían en el AFA-FL-07 según por dónde se decida que dos servicios
// "son la misma ruta". Solo LEE: no escribe nada, no propone nada, no toca la base.
//
// POR QUÉ EXISTE
//
// La LQC-2026-000004 salió con 30 ítems para 141 servicios de un solo cliente en un solo
// mes. No porque hubiera 30 rutas: porque la clave de agrupación es el NOMBRE de la ruta
// —texto libre, tecleado en tres pantallas distintas— y el mismo recorrido aparece escrito
// de varias formas:
//
//   · la hora va DENTRO del nombre       'RUTA A/ ENTRADA 06:30/…'  vs  '…06:35/…'
//   · el nombre lo sugirió el sistema    'W2VG+39R, EL AGUSTINO 15022, PERÚ→M5JG+GFG…'
//     desde el paradero sin renombrar       (ver lib/nombre-ruta.ts)
//   · el extremo se rotuló distinto      'BSF→1RO DE MAYO'  vs  'BSF→ALIPIO'
//
// Ninguna de las tres es una ruta distinta para el cliente que firma el papel. Pero
// tampoco se puede unir a ojo: 'ALIPIO' y '1RO DE MAYO' pueden ser el mismo punto con dos
// rótulos, o dos paraderos distintos a tres kilómetros. Unir mal es facturar mal, y se
// descubre semanas después, cuando el cliente rechaza la valorización.
//
// Este script NO decide: MIDE. Contesta la única pregunta que hace falta contestar antes
// de tocar la agrupación:
//
//     ¿cuántas de esas uniones se pueden DERIVAR de un dato, y cuántas necesitan que
//      alguien las declare a mano?
//
// LOS CUATRO CRITERIOS QUE COMPARA
//
//   A · nombre completo + tarifa     Lo que hace el ERP HOY (lib/liquidacion-agrupacion.ts).
//   B · nombre sin la hora + tarifa  Quitar la hora del texto. Derivable y seguro: la hora
//                                    de cada servicio sigue en el Anexo 1.
//   C · extremos en el MAPA + tarifa Comparar el paradero `inicio` y el `destino` de
//                                    `paradas_json` por coordenadas, ignorando los
//                                    intermedios. Es la definición que ya usa
//                                    lib/ruta-equivalente.ts ("fuente ÚNICA" de qué
//                                    servicios son la misma ruta), recortada a los extremos.
//   D · etiqueta RUTA + tarifa       'RUTA A' + S/ 550. Es lo que la operación tiene en la
//                                    cabeza, pero la etiqueta sale de un regex sobre el
//                                    nombre y NO es un dato: es el techo de lo alcanzable,
//                                    no una propuesta.
//
// LA TARIFA NUNCA SALE DE LA CLAVE, en ninguno de los cuatro. Es regla dura del negocio:
// dos ítems con precio unitario distinto no se unen jamás. El formato imprime
// CANT × P. UNITARIO = TOTAL, y promediar dos tarifas daría un unitario que nadie pactó.
//
// Uso:  npx tsx scripts/diagnostico-agrupacion.mts [desde] [hasta] [cliente|proveedor]
//   ej: npx tsx scripts/diagnostico-agrupacion.mts 2026-08-01 2026-08-31 cliente
import fs from "node:fs";
import path from "node:path";
import {
  analizarServicios,
  etiquetaRuta,
  nombreRuta,
  origenContractual,
  precioUnitario,
  type LadoLiquidacion,
  type ParServicio,
  type ReservaLiq,
} from "../lib/liquidacion-agrupacion";
import { fmtMoneda } from "../lib/finanzas/dinero";

const RAIZ = process.cwd();
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const DESDE = process.argv[2] ?? "2026-08-01";
const HASTA = process.argv[3] ?? "2026-08-31";
const LADO = (process.argv[4] ?? "cliente") as LadoLiquidacion;

/** PostgREST corta en 1000 filas y un mes de operación pasa de eso. */
async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${URL}/rest/v1/${ruta}`, { headers: { ...H, Range: `${desde}-${desde + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`PostgREST: ${JSON.stringify(j).slice(0, 300)}`);
    if (!j.length) break;
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

const COLS_BASE =
  "id,codigo,fecha_servicio,hora_servicio,estado,estado_admin,cliente_id,cliente_sede_id," +
  "ruta_nombre,direccion_servicio,origen,destino,precio_cliente,costo_proveedor,tipo_asignacion," +
  "empresa_tercerizada_id,reserva_vinculada_id,liquidacion_cliente_id,liquidacion_proveedor_id," +
  "paradas_json";

/**
 * `origen_contractual` la agrega supabase/reservas-04 y `capacidad_contratada` la
 * liquidaciones-03. Se piden aparte y se reintenta sin ellas: un diagnóstico no puede
 * quedarse mudo porque falte una migración accesoria.
 */
async function traerReservas(): Promise<any[]> {
  const rango = `&fecha_servicio=gte.${DESDE}&fecha_servicio=lte.${HASTA}&order=fecha_servicio.asc,id.asc`;
  const extras = ["origen_contractual", "capacidad_contratada", "cotizacion_id"];
  try {
    return await traer(`reservas?select=${COLS_BASE},${extras.join(",")}${rango}`);
  } catch {
    return await traer(`reservas?select=${COLS_BASE}${rango}`);
  }
}

// ── Los extremos de un tramo, tal como los guarda el snapshot ────────────────
//
// `paradas_json` es el mismo campo que lee lib/ruta-equivalente.ts, y el mismo del que
// lib/nombre-ruta.ts saca el texto del nombre ('inicio→destino'). Aquí interesan SOLO los
// extremos: el usuario lo dijo con todas sus letras — "de repente varían en paraderos
// intermedios" —, y de hecho es lo que distingue este criterio de `huellaRuta`, que es
// sensible a la secuencia completa y por eso separaría lo que hay que unir.

type Punto = { nombre: string; lat: number | null; lng: number | null };

function extremo(paradas: unknown, tipo: "inicio" | "destino"): Punto | null {
  if (!Array.isArray(paradas)) return null;
  const p: any = paradas.find((x: any) => String(x?.tipo ?? "") === tipo);
  if (!p) return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  return {
    nombre: String(p.nombre ?? "").trim().toUpperCase().replace(/\s+/g, " "),
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
  };
}

/** Metros entre dos puntos (haversine). Sobra precisión para distinguir paraderos. */
function metros(a: Punto, b: Punto): number {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return Infinity;
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Agrupa puntos en "lugares" por cercanía. Greedy y determinista: se ordena primero, así
 * que la misma entrada da siempre el mismo reparto y el diagnóstico no baila entre corridas.
 *
 * Un punto SIN coordenadas no se fusiona con nadie por cercanía: cae en su propio lugar,
 * rotulado por su nombre. Es deliberado — sin coordenadas no hay evidencia de que dos
 * paraderos sean el mismo, y este script existe justamente para no afirmar de más.
 */
function agruparLugares(puntos: Punto[], radio: number): Map<string, string> {
  const clave = (p: Punto) => `${p.nombre}|${p.lat ?? ""}|${p.lng ?? ""}`;
  const unicos = new Map<string, Punto>();
  for (const p of puntos) if (!unicos.has(clave(p))) unicos.set(clave(p), p);

  const orden = [...unicos.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const centros: { punto: Punto; id: string }[] = [];
  const asignado = new Map<string, string>();

  for (const [k, p] of orden) {
    if (p.lat == null || p.lng == null) {
      asignado.set(k, `sin-coord:${p.nombre}`);
      continue;
    }
    const cerca = centros.find((c) => metros(c.punto, p) <= radio);
    if (cerca) asignado.set(k, cerca.id);
    else {
      const id = `L${centros.length + 1}:${p.nombre || "(sin nombre)"}`;
      centros.push({ punto: p, id });
      asignado.set(k, id);
    }
  }
  return asignado;
}

// ── Las cuatro claves ────────────────────────────────────────────────────────

/**
 * Quita la hora del nombre de la ruta, y solo eso.
 *
 * 'RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF' → 'RUTA A ENTRADA SANTA ANITA→BSF'
 *
 * Se conserva la palabra ENTRADA/RETORNO porque distingue el sentido, que sí importa.
 * Lo que se borra es el reloj: dos salidas de la misma ruta a las 06:30 y a las 06:35 no
 * son dos rutas contratadas, y la hora de cada servicio sigue impresa en el Anexo 1.
 */
function sinHora(s: string | null | undefined): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/\b(\d{1,2}):(\d{2})(:\d{2})?\b/g, " ")
    .replace(/[\/\s]+/g, " ")
    .trim();
}

const money = (n: number) => n.toFixed(2);

type Claves = { A: string; B: string; C: string; D: string };

function clavesDelPar(p: ParServicio, lado: LadoLiquidacion, lugar: (r: ReservaLiq | null, t: "inicio" | "destino") => string): Claves {
  const precio = money(precioUnitario(p.cabeza, lado, { preciosIncluyenIgv: false, igvPct: 18 }));
  const org = origenContractual(p.cabeza);
  const nIda = p.ida ? nombreRuta(p.ida) : "";
  const nRet = p.retorno ? nombreRuta(p.retorno) : "";

  const extremos = (r: ReservaLiq | null) =>
    r ? `${lugar(r, "inicio")}→${lugar(r, "destino")}` : "";

  return {
    A: [nIda.toUpperCase(), nRet.toUpperCase(), precio, org].join("|"),
    B: [sinHora(nIda), sinHora(nRet), precio, org].join("|"),
    C: [extremos(p.ida), extremos(p.retorno), precio, org].join("|"),
    D: [etiquetaRuta(p.ida ?? p.cabeza), precio, org].join("|"),
  };
}

// ── Carga ────────────────────────────────────────────────────────────────────

const [reservas, clientes, terceros, sedes] = await Promise.all([
  traerReservas(),
  traer("clientes?select=id,nombre,empresa"),
  traer("empresas_tercerizadas?select=id,razon_social"),
  traer("cliente_sedes?select=id,cliente_id,nombre,servicio_contratado,patrones&activo=is.true").catch(() => []),
]);

const nombreCliente = new Map<number, string>(clientes.map((c: any) => [c.id, c.empresa || c.nombre]));
const nombreTercero = new Map<number, string>(terceros.map((t: any) => [t.id, t.razon_social]));

// Mismo filtro que /liquidaciones: lo que de verdad entraría al cierre.
const candidatas = (reservas as any[]).filter((r) =>
  LADO === "cliente"
    ? !r.liquidacion_cliente_id && (r.estado_admin === "por_liquidar" || !r.estado_admin)
    : !r.liquidacion_proveedor_id && (r.tipo_asignacion === "tercerizado" || !!r.empresa_tercerizada_id)
);

// ── 1) ¿Está el dato para poder comparar por mapa? ───────────────────────────
//
// Es la pregunta que manda: si `paradas_json` viene vacío, el criterio C no existe y la
// única salida honesta para las uniones que el texto no alcanza es que alguien las declare.

const conParadas = candidatas.filter((r) => Array.isArray(r.paradas_json) && r.paradas_json.length > 0);
const conExtremos = conParadas.filter((r) => extremo(r.paradas_json, "inicio") && extremo(r.paradas_json, "destino"));
const conCoords = conExtremos.filter((r) => {
  const i = extremo(r.paradas_json, "inicio")!;
  const d = extremo(r.paradas_json, "destino")!;
  return i.lat != null && i.lng != null && d.lat != null && d.lng != null;
});
const pct = (n: number) => (candidatas.length ? ((n * 100) / candidatas.length).toFixed(1) : "0.0");

console.log("═".repeat(84));
console.log(`DIAGNÓSTICO DE AGRUPACIÓN · ${DESDE} → ${HASTA} · lado ${LADO.toUpperCase()}`);
console.log("═".repeat(84));
console.log(`Reservas del periodo: ${reservas.length}  ·  candidatas al cierre: ${candidatas.length}\n`);
console.log("COBERTURA DEL DATO — ¿se pueden comparar los extremos en el mapa?");
console.log(`  con paradas_json         ${String(conParadas.length).padStart(5)}  (${pct(conParadas.length)}%)`);
console.log(`  con inicio Y destino     ${String(conExtremos.length).padStart(5)}  (${pct(conExtremos.length)}%)`);
console.log(`  con lat/lng en los dos   ${String(conCoords.length).padStart(5)}  (${pct(conCoords.length)}%)   ← sin esto, el criterio C no aplica`);
if (!conCoords.length)
  console.log("\n  ⚠ NINGUNA reserva trae coordenadas en sus extremos: unir por mapa es imposible\n" +
              "    con estos datos. Lo que el texto no una tendrá que declararlo un humano.");
console.log("");

// ── 2) Los cuatro criterios, por grupo del cierre ────────────────────────────

const grupos = new Map<string, { nombre: string; sede: any; filas: ReservaLiq[] }>();
for (const r of candidatas as any[]) {
  const id = LADO === "cliente" ? r.cliente_id : r.empresa_tercerizada_id;
  const delCliente = sedes.filter((s: any) => s.cliente_id === r.cliente_id);
  const sede = r.cliente_sede_id
    ? sedes.find((s: any) => s.id === r.cliente_sede_id)
    : delCliente.length === 1
    ? delCliente[0]
    : delCliente.find((s: any) =>
        (s.patrones ?? []).some((p: string) =>
          `${r.ruta_nombre ?? ""} ${r.origen ?? ""} ${r.destino ?? ""}`.toUpperCase().includes(p)
        )
      );
  const clave = `${id ?? "x"}|${sede?.id ?? 0}`;
  const nombre = (LADO === "cliente" ? nombreCliente.get(Number(id)) : nombreTercero.get(Number(id))) ?? `#${id}`;
  const g = grupos.get(clave) ?? { nombre, sede: sede ?? null, filas: [] };
  g.filas.push(r as ReservaLiq);
  grupos.set(clave, g);
}

/** Radios a los que se prueba el criterio C: muestra si el resultado es robusto o de filo. */
const RADIOS = [50, 200, 500];

for (const [, g] of [...grupos].sort((a, b) => b[1].filas.length - a[1].filas.length)) {
  const analisis = analizarServicios(g.filas, LADO);
  const pares = analisis.pares.filter((p) => p.ejecutado);
  if (!pares.length) continue;

  console.log("─".repeat(84));
  console.log(`${g.nombre}${g.sede ? "  ·  " + g.sede.nombre : "  ·  (sin sede)"}`);
  console.log(`  ${g.filas.length} reservas → ${pares.length} servicios facturables · ${analisis.bloqueadas.length} bloqueadas`);

  // Los "lugares" se calculan sobre los extremos de ESTE grupo: un cliente no comparte
  // paraderos con otro, y mezclarlos solo agrandaría el radio de confusión.
  const puntos: Punto[] = [];
  for (const p of pares)
    for (const r of [p.ida, p.retorno])
      for (const t of ["inicio", "destino"] as const) {
        const e = r ? extremo((r as any).paradas_json, t) : null;
        if (e) puntos.push(e);
      }

  const cuentaPorRadio = new Map<number, number>();
  let clavesRef: Map<string, ParServicio[]> | null = null;

  for (const radio of RADIOS) {
    const mapa = agruparLugares(puntos, radio);
    const lugar = (r: ReservaLiq | null, t: "inicio" | "destino") => {
      const e = r ? extremo((r as any).paradas_json, t) : null;
      if (!e) return `sin-parada:${t}`;
      return mapa.get(`${e.nombre}|${e.lat ?? ""}|${e.lng ?? ""}`) ?? `?${e.nombre}`;
    };
    const porC = new Map<string, ParServicio[]>();
    for (const p of pares) {
      const k = clavesDelPar(p, LADO, lugar).C;
      (porC.get(k) ?? porC.set(k, []).get(k)!).push(p);
    }
    cuentaPorRadio.set(radio, porC.size);
    if (radio === 200) clavesRef = porC;
  }

  // A, B y D no dependen del radio.
  const sinLugar = () => "";
  const cuenta = (sel: (c: Claves) => string) => {
    const m = new Map<string, ParServicio[]>();
    for (const p of pares) {
      const k = sel(clavesDelPar(p, LADO, sinLugar));
      (m.get(k) ?? m.set(k, []).get(k)!).push(p);
    }
    return m;
  };
  const A = cuenta((c) => c.A);
  const B = cuenta((c) => c.B);
  const D = cuenta((c) => c.D);

  console.log("");
  console.log("  ÍTEMS QUE SALDRÍAN, según cómo se decida que dos servicios son la misma ruta:");
  console.log(`    A · nombre completo + tarifa   ${String(A.size).padStart(4)}   ← lo que hace el ERP hoy`);
  console.log(`    B · nombre sin la hora + tarifa${String(B.size).padStart(4)}   ← derivable, sin riesgo`);
  for (const radio of RADIOS)
    console.log(`    C · extremos en el mapa ±${String(radio).padStart(3)}m ${String(cuentaPorRadio.get(radio) ?? 0).padStart(4)}   ← derivable si hay coordenadas`);
  console.log(`    D · etiqueta RUTA + tarifa     ${String(D.size).padStart(4)}   ← techo: la etiqueta NO es un dato`);

  // ── Qué gana cada escalón, con nombre y apellido ──────────────────────────
  const rotulo = (p: ParServicio) => {
    const n = nombreRuta(p.ida ?? p.cabeza);
    const precio = precioUnitario(p.cabeza, LADO, { preciosIncluyenIgv: false, igvPct: 18 });
    return `${n}  ·  ${fmtMoneda(precio)}`;
  };

  const detalle = (
    titulo: string,
    grueso: Map<string, ParServicio[]>,
    fino: Map<string, ParServicio[]>
  ) => {
    // Grupos del criterio grueso que reúnen a 2+ grupos del fino: eso es lo que UNE de más.
    const uniones: string[][] = [];
    for (const [, ps] of grueso) {
      const finos = new Set<string>();
      for (const p of ps) {
        for (const [k, qs] of fino) if (qs.includes(p)) { finos.add(k); break; }
      }
      if (finos.size > 1) {
        const etiquetas = [...new Set(ps.map(rotulo))];
        uniones.push(etiquetas);
      }
    }
    if (!uniones.length) return;
    console.log(`\n  ${titulo}`);
    for (const u of uniones.slice(0, 12)) {
      console.log(`    ┌ une ${u.length} descripciones distintas en un solo ítem:`);
      for (const e of u) console.log(`    │   ${e}`);
    }
    if (uniones.length > 12) console.log(`    … y ${uniones.length - 12} uniones más`);
  };

  detalle("LO QUE GANA QUITAR LA HORA (B sobre A):", B, A);
  if (clavesRef) detalle("LO QUE GANA COMPARAR EL MAPA A ±200 m (C sobre B):", clavesRef, B);
  detalle("LO QUE SOLO SE CONSIGUE DECLARÁNDOLO A MANO (D sobre C a ±200 m):", D, clavesRef ?? B);

  // ── El invariante de caja: unir NUNCA puede mover un sol ──────────────────
  const total = (m: Map<string, ParServicio[]>) =>
    [...m.values()].reduce(
      (a, ps) => a + ps.length * precioUnitario(ps[0].cabeza, LADO, { preciosIncluyenIgv: false, igvPct: 18 }),
      0
    );
  const tA = total(A);
  console.log("");
  console.log("  INVARIANTE DE CAJA (unir no puede mover un sol):");
  for (const [n, m] of [["A", A], ["B", B], ["D", D]] as const)
    console.log(`    ${n}: ${fmtMoneda(total(m)).padStart(14)}   ${Math.abs(total(m) - tA) < 0.005 ? "✓ igual que A" : "✗ DIFIERE DE A"}`);
  if (clavesRef)
    console.log(`    C: ${fmtMoneda(total(clavesRef)).padStart(14)}   ${Math.abs(total(clavesRef) - tA) < 0.005 ? "✓ igual que A" : "✗ DIFIERE DE A"}`);

  // ── Misma ruta a varias tarifas: no se unen (regla dura), pero hay que verlo ──
  //
  // El precio JAMÁS sale de la clave. Pero cuando la misma ruta aparece a dos tarifas,
  // la mitad de las veces es un importe mal tecleado, y hoy eso no se ve en ningún lado:
  // salen como dos ítems y nadie los confronta.
  const porRuta = new Map<string, Map<number, number>>();
  for (const p of pares) {
    const etiqueta = `${etiquetaRuta(p.ida ?? p.cabeza)} · ${origenContractual(p.cabeza)}`;
    const precio = precioUnitario(p.cabeza, LADO, { preciosIncluyenIgv: false, igvPct: 18 });
    const m = porRuta.get(etiqueta) ?? new Map<number, number>();
    m.set(precio, (m.get(precio) ?? 0) + 1);
    porRuta.set(etiqueta, m);
  }
  const dispares = [...porRuta].filter(([, m]) => m.size > 1);
  if (dispares.length) {
    console.log("\n  MISMA RUTA A VARIAS TARIFAS (no se unen nunca — solo para revisar):");
    for (const [etiqueta, m] of dispares) {
      const detalle = [...m].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${fmtMoneda(p)} × ${n}`).join("   ");
      console.log(`    ${etiqueta.padEnd(28)} ${detalle}`);
    }
  }
  console.log("");
}

console.log("═".repeat(84));
console.log("Este script solo LEE. No modifica ninguna fila ni propone ninguna unión.");
console.log("═".repeat(84));
