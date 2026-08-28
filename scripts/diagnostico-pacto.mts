// Censo de los servicios tercerizados SIN COSTO PACTADO — el bloque rojo de
// /liquidaciones, contado de verdad y con el importe propuesto donde ya existe.
//
// Responde lo que hoy nadie sabe antes de abrir la pantalla:
//   · Cuántas de las líneas rojas son RETORNOS de un par cuya ida sí tiene tarifa.
//     Ese cero es correcto (la tarifa va en la ida) y no hay nada que cargar.
//   · Cuántas son pares 0+0: un solo costo a decidir, no dos.
//   · A cuántas se les puede PROPONER el importe porque el servicio ya se pagó y el
//     dato está en la factura de compra o en el gasto de pago a tercero.
//   · Cuántas quedan de verdad para cargar a mano, agrupadas por proveedor y ruta.
//   · Si `reservas.margen` es columna generada o dato muerto: su DDL no está en el
//     repo y cuatro tableros la leen como verdad.
//
// Uso:  npx tsx scripts/diagnostico-pacto.mts [desde] [hasta]
//   ej: npx tsx scripts/diagnostico-pacto.mts 2026-07-01 2026-08-31
//
// Solo LEE. No escribe nada. Usa la service-role de .env.local para ver todo sin RLS.
import fs from "node:fs";
import path from "node:path";
import { fmtMoneda } from "../lib/finanzas/dinero";
import { costoReal, afectacionDe } from "../lib/finanzas/afectacion";

const RAIZ = process.cwd();
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const DESDE = process.argv[2] ?? "2026-01-01";
const HASTA = process.argv[3] ?? "2026-12-31";

/** PostgREST corta en 1000 filas: un periodo de operación pasa de eso. */
async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${URL}/rest/v1/${ruta}`, { headers: { ...H, Range: `${desde}-${desde + 999}` } });
    if (!r.ok) return out;
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) break;
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

const COLS =
  "id,codigo,fecha_servicio,hora_servicio,estado,estado_proveedor,ruta_nombre,direccion_servicio," +
  "precio_cliente,costo_proveedor,tipo_asignacion,empresa_tercerizada_id,vehiculo_tercero_id," +
  "reserva_vinculada_id,liquidacion_proveedor_id,cotizacion_id";

const [reservas, terceros, docs, gastos] = await Promise.all([
  traer(`reservas?select=${COLS}&fecha_servicio=gte.${DESDE}&fecha_servicio=lte.${HASTA}&estado=neq.cancelada`),
  traer("empresas_tercerizadas?select=id,razon_social,afectacion_defecto,emite_factura"),
  traer(`documentos_compra?select=id,empresa_tercerizada_id,serie,numero,total,fecha_emision,estado_conciliacion&fecha_emision=gte.${DESDE}`),
  traer(`gastos?select=id,reserva_id,categoria,monto,fecha&fecha=gte.${DESDE}`),
]);

const nombreTer = new Map<number, string>(terceros.map((t: any) => [Number(t.id), t.razon_social ?? "—"]));
const fichaTer = new Map<number, any>(terceros.map((t: any) => [Number(t.id), t]));
const porId = new Map<number, any>(reservas.map((r: any) => [Number(r.id), r]));

const esTercerizado = (r: any) =>
  (r.tipo_asignacion ?? "") === "tercerizado" || r.empresa_tercerizada_id != null || r.vehiculo_tercero_id != null;

// ── El universo: tercerizados, sin costo, todavía no liquidados al proveedor ──
const sinCosto = reservas.filter(
  (r: any) => esTercerizado(r) && Number(r.costo_proveedor ?? 0) === 0 && r.liquidacion_proveedor_id == null
);

// ── Clasificación ────────────────────────────────────────────────────────────
// Un RETORNO cuya IDA sí lleva tarifa no está roto: está incluido. Contarlo como
// problema es lo que infla "43 con problema" a casi el doble de lo real.
const cubiertos: any[] = [];
const paresCero = new Map<number, any[]>();   // clave = id menor del par
const sueltos: any[] = [];

for (const r of sinCosto) {
  const par = r.reserva_vinculada_id ? porId.get(Number(r.reserva_vinculada_id)) : undefined;
  if (par && Number(par.costo_proveedor ?? 0) > 0) { cubiertos.push(r); continue; }
  if (par && Number(par.costo_proveedor ?? 0) === 0 && esTercerizado(par)) {
    const clave = Math.min(Number(r.id), Number(par.id));
    paresCero.set(clave, [...(paresCero.get(clave) ?? []), r]);
    continue;
  }
  sueltos.push(r);
}

// ── ¿A cuáles les podemos proponer el importe? ───────────────────────────────
const docsPorTer = new Map<number, any[]>();
for (const d of docs) {
  if (d.empresa_tercerizada_id == null || d.estado_conciliacion === "anulado") continue;
  const k = Number(d.empresa_tercerizada_id);
  docsPorTer.set(k, [...(docsPorTer.get(k) ?? []), d]);
}
const gastoPorReserva = new Map<number, any>();
for (const g of gastos) {
  if (g.reserva_id == null) continue;
  if (!["pago_tercero", "tercero", "tercerizado"].includes(String(g.categoria ?? "").toLowerCase())) continue;
  gastoPorReserva.set(Number(g.reserva_id), g);
}

const dias = (a: string, b: string) => Math.round((+new Date(a) - +new Date(b)) / 86400000);

const candidatasDe = (r: any) =>
  (docsPorTer.get(Number(r.empresa_tercerizada_id)) ?? []).filter((d: any) => {
    const dd = dias(d.fecha_emision, r.fecha_servicio);
    return dd >= -15 && dd <= 45;
  });

/**
 * Solo se propone un importe cuando el cruce es INEQUÍVOCO en ambas direcciones: un
 * servicio ↔ un comprobante. Una factura que calza con seis servicios no dice el costo
 * de ninguno, dice el TOTAL de todos: aceptarla en cada uno multiplicaría el costo por
 * seis. Mismo criterio que la vista v_costo_tercero_propuesta.
 */
function propuesta(r: any, universo: any[]): { monto: number; fuente: string } | null {
  const g = gastoPorReserva.get(Number(r.id));
  if (g) return { monto: Number(g.monto ?? 0), fuente: "gasto pago a tercero" };

  const cands = candidatasDe(r);
  if (cands.length !== 1) return null;              // el servicio calza con 2+ facturas

  const doc = cands[0];
  const servicios = universo.filter((o) => candidatasDe(o).some((d: any) => d.id === doc.id));
  if (servicios.length !== 1) return null;          // la factura calza con 2+ servicios

  return { monto: Number(doc.total ?? 0), fuente: `CxP ${doc.serie ?? ""}-${doc.numero ?? ""}` };
}

// ── ¿reservas.margen es columna generada o dato muerto? ──────────────────────
const conAmbos = reservas.filter((r: any) => Number(r.precio_cliente ?? 0) > 0 && Number(r.costo_proveedor ?? 0) > 0);
let margenVeredicto = "sin datos suficientes para decidir";
if (conAmbos.length) {
  const muestra = await traer(
    `reservas?select=id,precio_cliente,costo_proveedor,margen&id=in.(${conAmbos.slice(0, 200).map((r: any) => r.id).join(",")})`
  );
  const conMargen = muestra.filter((r: any) => r.margen != null);
  const cuadran = conMargen.filter(
    (r: any) => Math.abs(Number(r.margen) - (Number(r.precio_cliente) - Number(r.costo_proveedor))) < 0.02
  );
  if (!conMargen.length) margenVeredicto = "SIEMPRE NULL — es dato muerto, no la uses";
  else if (cuadran.length === conMargen.length) margenVeredicto = `cuadra en ${conMargen.length}/${conMargen.length} — parece generada o mantenida`;
  else margenVeredicto = `DESCUADRA en ${conMargen.length - cuadran.length} de ${conMargen.length} — es dato muerto que nadie recalcula`;
}

// ── Informe ──────────────────────────────────────────────────────────────────
const T = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const soles = (n: number) => fmtMoneda(n);

console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  CENSO DEL PACTO — servicios tercerizados sin costo                   ║`);
console.log(`║  Periodo ${DESDE} a ${HASTA}                                  ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝`);

T("1 · De líneas rojas a decisiones reales");
const nPares = paresCero.size;
const lineasRojas = sinCosto.length;
const decisiones = nPares + sueltos.length;
console.log(`  Líneas rojas en pantalla ............ ${lineasRojas}`);
console.log(`  − retornos ya cubiertos por su ida .. ${cubiertos.length}   (su cero es correcto: nada que cargar)`);
console.log(`  − pares 0+0 contados dos veces ...... ${[...paresCero.values()].reduce((a, v) => a + v.length, 0)} líneas → ${nPares} costo(s) a decidir`);
console.log(`  − servicios sueltos ................. ${sueltos.length}`);
console.log(`  \x1b[1m= DECISIONES REALES ................. ${decisiones}\x1b[0m`);
if (lineasRojas > 0)
  console.log(`  El bloque rojo exagera el problema en ${Math.round((1 - decisiones / lineasRojas) * 100)} %.`);

T("2 · Cuántas se resuelven solas (el importe ya está en el ERP)");
const aDecidir = [...[...paresCero.values()].map((v) => v[0]), ...sueltos];
const conPropuesta = aDecidir.map((r) => ({ r, p: propuesta(r, aDecidir) })).filter((x) => x.p);
console.log(`  Con importe propuesto ............... ${conPropuesta.length} de ${aDecidir.length}`);
console.log(`  Suma de lo propuesto ................ ${soles(conPropuesta.reduce((a, x) => a + x.p!.monto, 0))}`);
console.log(`  Quedan para cargar a mano ........... ${aDecidir.length - conPropuesta.length}`);
for (const { r, p } of conPropuesta.slice(0, 10))
  console.log(`    ${String(r.codigo ?? "#" + r.id).padEnd(18)} ${r.fecha_servicio}  ${soles(p!.monto).padStart(12)}  ${p!.fuente}`);
if (conPropuesta.length > 10) console.log(`    …y ${conPropuesta.length - 10} más`);

T("3 · Lo que queda, agrupado para cargar en lote");
const grupos = new Map<string, any[]>();
for (const { r, p } of aDecidir.map((r) => ({ r, p: propuesta(r, aDecidir) }))) {
  if (p) continue;
  const k = `${nombreTer.get(Number(r.empresa_tercerizada_id)) ?? "SIN EMPRESA"} · ${r.ruta_nombre ?? "sin ruta"}`;
  grupos.set(k, [...(grupos.get(k) ?? []), r]);
}
for (const [k, v] of [...grupos.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const fechas = v.map((r) => r.fecha_servicio).sort();
  console.log(`  ${String(v.length).padStart(4)} serv.  ${k}`);
  console.log(`             del ${fechas[0]} al ${fechas[fechas.length - 1]}`);
}
if (!grupos.size) console.log(`  Nada pendiente: todo tiene propuesta o ya está pactado.`);

T("4 · Servicios ya EJECUTADOS sin costo (lo más urgente)");
const hoy = new Date().toISOString().slice(0, 10);
const ejecutados = aDecidir.filter((r) => r.fecha_servicio < hoy);
console.log(`  ${ejecutados.length} servicio(s) ya prestados que nadie pactó.`);
console.log(`  El proveedor ya trabajó y está esperando su plata sin que el ERP sepa cuánto.`);

T("5 · ¿reservas.margen sirve?");
console.log(`  ${margenVeredicto}`);

T("6 · Afectación de los proveedores involucrados");
const tersInvolucrados = [...new Set(aDecidir.map((r) => Number(r.empresa_tercerizada_id)).filter(Boolean))];
let sinDeclarar = 0;
for (const id of tersInvolucrados) {
  const f = fichaTer.get(id);
  if (!f?.afectacion_defecto) { sinDeclarar++; continue; }
  const af = afectacionDe(f.afectacion_defecto);
  console.log(`  ${String(f.razon_social ?? id).padEnd(34)} ${af.etiqueta.padEnd(12)} S/ 500 te cuesta ${soles(costoReal(500, f.afectacion_defecto, { emiteFactura: f.emite_factura !== false }))}`);
}
if (sinDeclarar) console.log(`  ${sinDeclarar} proveedor(es) sin afectación declarada → se asumen gravados. Revísalos en el maestro.`);

console.log(`\n─────────────────────────────────────────────────────────────────────────`);
console.log(`Nada de esto se escribió: es solo lectura. Los importes propuestos son`);
console.log(`PROPUESTAS cruzadas por proveedor y fecha — confírmalas antes de cargarlas.`);
console.log(`─────────────────────────────────────────────────────────────────────────\n`);
