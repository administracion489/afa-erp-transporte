// Corrección retroactiva del TIPO DE COMBUSTIBLE de las cargas que el Radar IA ya
// registró con el default de diésel.
//
// Uso:
//   npx tsx scripts/corregir-combustible-tipo.mts                  ← INFORME, no escribe nada
//   npx tsx scripts/corregir-combustible-tipo.mts --solo-normalizar --aplicar
//   npx tsx scripts/corregir-combustible-tipo.mts --aplicar
//
// ANTES DE APLICAR, MIRA LOS PRECIOS OFICIALES. Toda la clasificación se calcula contra
// `precios_combustible`. Con una referencia mentida el script no falla: acierta MENOS y no
// puede avisarlo caso por caso — si el diésel oficial quedó en S/ 7.55, una carga de GLP a
// S/ 7.55 parece "diésel a precio de diésel" y no se detecta. Por eso, cuando ve un precio
// oficial muy lejos de su referencial, se NIEGA a escribir hasta que se arregle en
// /configuracion/costos (o se lo fuerce con `--igualmente`).
//
// EN SECO POR DEFECTO. Sin `--aplicar` solo lee y cuenta: es lo que hay que mirar antes de
// tocar nada. `--solo-normalizar` aplica únicamente los cambios de GRAFÍA ("PETROLEO D2" →
// diesel), que no cambian de combustible y por tanto no mueven ningún número — es la
// primera pasada segura. `--aplicar` a secas hace además los cambios de COMBUSTIBLE, que
// son los que importan y los que hay que haber leído antes en el informe.
//
// QUÉ ARREGLA
//
// Hasta la corrección del tipo, los dos escritores del Radar hacían
// `d.tipo_combustible ?? "diesel"`. Un voucher que no dijera el tipo entraba a
// `combustible` como diésel, y la pantalla no lo desmentía porque no mostraba la columna.
// Esas filas siguen ahí: ensucian el km/gal de la unidad (promedian dos combustibles), el
// control de precio y el costo por km del Cotizador.
//
// QUÉ **NO** HACE
//
// No cambia en bloque todo lo que dice "diesel". La flota es mayoritariamente de diésel:
// eso estropearía cientos de cargas correctas para arreglar unas pocas. Solo cambia de
// combustible cuando el precio pagado aterriza sobre la referencia de otro y ninguna banda
// incluye al diésel — el caso del GLP (S/ 7.55) y del GNV (S/ 1.78), que son justo los que
// el default se tragaba. Las reglas están en lib/radar/retro-tipo-combustible.ts y su
// matriz en scripts/prueba-retro-combustible.mts.
//
// No toca `radar_combustible` de las cargas PENDIENTES de revisión: esas ya las resuelve
// la pantalla, que ahora exige elegir el tipo antes de registrar.
//
// No reescribe la CANTIDAD ni la unidad. Si el combustible corregido se despacha en otra
// unidad (GNV en m³), lo avisa y deja la cantidad como está: cambiarla sería reinterpretar
// una medición que nadie volvió a tomar.
//
// SIEMPRE DEJA POR DÓNDE VOLVER: cada corrección anexa su porqué a `observaciones` (se ve
// en /combustible) y `--aplicar` escribe antes un archivo de reversión con los valores
// previos de cada fila tocada.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const RETRO = requerir("../lib/radar/retro-tipo-combustible") as typeof import("../lib/radar/retro-tipo-combustible");
const COMB = requerir("../lib/combustibles") as typeof import("../lib/combustibles");

const { clasificarCarga, notaDeCorreccion } = RETRO;
const { etiquetaCombustible, normalizarTipoCombustible, referenciasDePrecio, COMBUSTIBLES } = COMB;
type CargaRetro = import("../lib/radar/retro-tipo-combustible").CargaRetro;
type VeredictoRetro = import("../lib/radar/retro-tipo-combustible").VeredictoRetro;

const APLICAR = process.argv.includes("--aplicar");
const SOLO_NORMALIZAR = process.argv.includes("--solo-normalizar");
/** Escribir aunque un precio oficial se vea desviado — ver el freno al final de `principal`. */
const IGUALMENTE = process.argv.includes("--igualmente");

// ── Conexión (mismo patrón que scripts/diagnostico-agrupacion.mts) ──────────
const RAIZ = process.cwd();
const RUTA_ENV = path.join(RAIZ, ".env.local");
if (!fs.existsSync(RUTA_ENV)) {
  console.error(`\n  No encuentro ${RUTA_ENV}.\n  Corre el script desde la raíz del proyecto, donde está .env.local.\n`);
  process.exit(1);
}
const env = fs.readFileSync(RUTA_ENV, "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY");
if (!URL || !KEY) {
  console.error(
    "\n  Falta NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local.\n" +
    "  Este script necesita la clave de SERVICE ROLE: escribe en `combustible`, que está\n" +
    "  protegida por RLS y la clave anónima no puede modificar.\n"
  );
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

/** PostgREST corta en 1000 filas; el histórico de combustible pasa de eso. */
async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${URL}/rest/v1/${ruta}`, { headers: { ...H, Range: `${desde}-${desde + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`PostgREST (${ruta}): ${JSON.stringify(j).slice(0, 300)}`);
    if (!j.length) break;
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

/** Igual que `traer`, pero devuelve [] si la tabla/columna no existe en este despliegue. */
async function traerOpcional(ruta: string): Promise<any[]> {
  try {
    return await traer(ruta);
  } catch {
    return [];
  }
}

const soles = (n: number | null | undefined) =>
  n == null || !Number.isFinite(Number(n))
    ? "—"
    : `S/ ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const hoyLima = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

// ── Lectura ─────────────────────────────────────────────────────────────────

async function principal() {
  console.log(`\n  CORRECCIÓN RETROACTIVA · tipo de combustible de las cargas del Radar IA`);
  console.log(`  ${APLICAR ? (SOLO_NORMALIZAR ? "MODO: aplicar SOLO normalizaciones de grafía" : "MODO: APLICAR cambios") : "MODO: informe (no se escribe nada)"}\n`);

  // Las PENDIENTES van en consulta aparte a propósito: la de arriba filtra por
  // `combustible_id`, y una fila pendiente justamente no lo tiene todavía.
  const [precios, cargas, radar, pendientes, propios, terceros, params] = await Promise.all([
    traerOpcional("precios_combustible?select=tipo,precio,fuente,fecha_vigencia"),
    traer("combustible?select=id,vehiculo_id,vehiculo_tercero_id,fecha,galones,precio_galon,tipo_combustible,unidad,observaciones&order=id"),
    traerOpcional("radar_combustible?select=combustible_id,tipo_combustible&combustible_id=not.is.null"),
    traerOpcional("radar_combustible?select=id&estado=eq.pendiente_revision"),
    traer("vehiculos?select=id,placa,tipo_vehiculo_costeo"),
    traerOpcional("vehiculos_tercero?select=id,placa"),
    traerOpcional("parametros_costos?select=tipo_vehiculo,tipo_combustible_1"),
  ]);

  const refs = referenciasDePrecio(precios);
  const fichaPorTipoVeh = new Map<string, string | null>(
    params.map((p) => [String(p.tipo_vehiculo), normalizarTipoCombustible(p.tipo_combustible_1)])
  );
  const propioPorId = new Map<number, any>(propios.map((v) => [Number(v.id), v]));
  const terceroPorId = new Map<number, any>(terceros.map((v) => [Number(v.id), v]));
  // Una carga puede tener más de una fila de Radar apuntándola si se reprocesó; basta con
  // saber si ALGUNA leyó el tipo, porque eso es lo que descarta el default.
  const radarPorCarga = new Map<number, { leido: string | null }>();
  for (const r of radar) {
    const id = Number(r.combustible_id);
    const prev = radarPorCarga.get(id);
    radarPorCarga.set(id, { leido: prev?.leido ?? r.tipo_combustible ?? null });
  }

  console.log(`  Referencias de precio en uso: ${Object.entries(refs).map(([t, p]) => `${etiquetaCombustible(t)} ${soles(p)}`).join(" · ")}`);
  if (!precios.length) console.log(`  (aviso: 'precios_combustible' vino vacía — se usan los referenciales del catálogo)`);
  console.log(`  Cargas en 'combustible': ${cargas.length} · ligadas al Radar: ${radarPorCarga.size}\n`);

  // ── Clasificación ─────────────────────────────────────────────────────────
  type Fila = { carga: CargaRetro; cruda: any; v: VeredictoRetro };
  const filas: Fila[] = cargas.map((row) => {
    const veh = row.vehiculo_id != null ? propioPorId.get(Number(row.vehiculo_id)) : null;
    const ter = row.vehiculo_tercero_id != null ? terceroPorId.get(Number(row.vehiculo_tercero_id)) : null;
    const enRadar = radarPorCarga.get(Number(row.id));
    const carga: CargaRetro = {
      id: Number(row.id),
      tipo_combustible: row.tipo_combustible ?? null,
      precio_galon: row.precio_galon != null ? Number(row.precio_galon) : null,
      galones: row.galones != null ? Number(row.galones) : null,
      unidad: row.unidad ?? null,
      fecha: row.fecha ?? null,
      placa: veh?.placa ?? ter?.placa ?? null,
      ligada_al_radar: !!enRadar,
      radar_tipo_leido: enRadar?.leido ?? null,
      ficha_tipo: veh?.tipo_vehiculo_costeo ? fichaPorTipoVeh.get(String(veh.tipo_vehiculo_costeo)) ?? null : null,
    };
    return { carga, cruda: row, v: clasificarCarga(carga, refs) };
  });

  const porAccion = (a: VeredictoRetro["accion"]) => filas.filter((f) => f.v.accion === a);
  const corregir = porAccion("corregir");
  const normalizar = porAccion("normalizar");
  const revisar = porAccion("revisar");
  const dejar = porAccion("dejar");

  const importe = (f: Fila) => Number(f.carga.galones ?? 0) * Number(f.carga.precio_galon ?? 0);
  const suma = (fs_: Fila[]) => fs_.reduce((s, f) => s + importe(f), 0);

  console.log(`  ┌─ RESUMEN ────────────────────────────────────────────────────────`);
  console.log(`  │  cambian de combustible   ${String(corregir.length).padStart(5)}   ${soles(suma(corregir))}`);
  console.log(`  │  solo cambian de grafía   ${String(normalizar.length).padStart(5)}   ${soles(suma(normalizar))}`);
  console.log(`  │  necesitan que las mires  ${String(revisar.length).padStart(5)}   ${soles(suma(revisar))}`);
  console.log(`  │  quedan como están        ${String(dejar.length).padStart(5)}   ${soles(suma(dejar))}`);
  console.log(`  └──────────────────────────────────────────────────────────────────\n`);

  detallar("CAMBIAN DE COMBUSTIBLE — el precio pagado desmiente al diésel", corregir, true);
  detallar("SOLO CAMBIAN DE GRAFÍA — el mismo combustible, escrito de otra forma", normalizar, false);
  detallar("PARA MIRAR A MANO — el sistema no puede decidir por ti", revisar, false);

  if (corregir.length) {
    console.log(`  EFECTO POR UNIDAD (las que cambian de combustible)`);
    const porPlaca = new Map<string, Fila[]>();
    for (const f of corregir) {
      const k = f.carga.placa ?? "sin unidad";
      porPlaca.set(k, [...(porPlaca.get(k) ?? []), f]);
    }
    for (const [placa, fs_] of [...porPlaca].sort((a, b) => b[1].length - a[1].length)) {
      const tipos = [...new Set(fs_.map((f) => etiquetaCombustible(f.v.tipo!)))].join(", ");
      console.log(`    ${placa.padEnd(12)} ${String(fs_.length).padStart(4)} carga(s) → ${tipos}  ${soles(suma(fs_))}`);
    }
    console.log(`\n    El km/gal de estas unidades estaba mezclando dos combustibles. Después de\n` +
                `    aplicar, /combustible los separa y el rendimiento vuelve a significar algo.\n`);
  }

  const preciosDudosos = avisarPrecioOficial(precios);
  avisarPendientes(pendientes.length);

  // ── Escritura ─────────────────────────────────────────────────────────────
  const aEscribir = SOLO_NORMALIZAR ? normalizar : [...normalizar, ...corregir];
  if (!APLICAR) {
    console.log(`  Nada se ha escrito. Para aplicar:\n`);
    if (normalizar.length) console.log(`      npx tsx scripts/corregir-combustible-tipo.mts --solo-normalizar --aplicar   (${normalizar.length} fila(s), sin riesgo)`);
    if (corregir.length) console.log(`      npx tsx scripts/corregir-combustible-tipo.mts --aplicar                      (${aEscribir.length} fila(s))`);
    if (!normalizar.length && !corregir.length) console.log(`      (no hay nada que aplicar)`);
    console.log();
    return;
  }
  if (!aEscribir.length) {
    console.log(`  No hay filas que escribir.\n`);
    return;
  }
  // TODA la clasificación se apoya en `precios_combustible`. Si una referencia está
  // mentida, el script no falla: acierta MENOS y no lo dice. Comprobado en la prueba de
  // humo — con el diésel oficial puesto en S/ 7.55, las cargas de GLP a S/ 7.55 pasan a
  // parecer "diésel a precio de diésel" y dejan de detectarse. Por eso se niega a escribir
  // antes que aplicar una corrección calculada sobre una referencia rota.
  if (preciosDudosos && !IGUALMENTE) {
    console.log(
      `  NO SE APLICA NADA.\n\n` +
      `  Hay un precio oficial muy lejos de su referencial (arriba). Toda la clasificación\n` +
      `  se calcula contra esos precios, así que con uno mentido este script detecta MENOS\n` +
      `  cargas de las que hay y no tiene forma de avisarlo caso por caso.\n\n` +
      `  Arregla primero el precio en /configuracion/costos y vuelve a correrlo.\n` +
      `  Si el precio es correcto y solo se alejó del referencial del catálogo, añade --igualmente.\n`
    );
    return;
  }

  // El archivo de reversión se escribe ANTES del primer PATCH: si el proceso muere a
  // mitad, lo ya aplicado sigue teniendo por dónde volver.
  const sello = new Date().toISOString().replace(/[:.]/g, "-");
  const rutaRev = path.join(RAIZ, `reversion-tipo-combustible-${sello}.json`);
  fs.writeFileSync(
    rutaRev,
    JSON.stringify(
      aEscribir.map((f) => ({ id: f.carga.id, tipo_combustible: f.cruda.tipo_combustible ?? null, observaciones: f.cruda.observaciones ?? null })),
      null, 2
    )
  );
  console.log(`  Reversión guardada en ${rutaRev}\n`);

  const hoy = hoyLima();
  let ok = 0;
  const errores: string[] = [];
  for (const f of aEscribir) {
    const cuerpo: Record<string, unknown> = { tipo_combustible: f.v.tipo };
    // La nota va solo cuando cambia el COMBUSTIBLE. Una normalización de grafía no cambia
    // ningún número y no merece ensuciar el campo que el operador lee en /combustible.
    if (f.v.accion === "corregir") {
      cuerpo.observaciones = `${f.cruda.observaciones ?? ""}${notaDeCorreccion(f.v, f.cruda.tipo_combustible ?? null, hoy)}`.trim();
    }
    const r = await fetch(`${URL}/rest/v1/combustible?id=eq.${f.carga.id}`, {
      method: "PATCH",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(cuerpo),
    });
    if (r.ok) ok++;
    else errores.push(`#${f.carga.id}: ${r.status} ${(await r.text()).slice(0, 160)}`);
  }

  console.log(`  Aplicadas ${ok}/${aEscribir.length} fila(s).`);
  if (errores.length) {
    console.log(`\n  ${errores.length} fallaron:`);
    for (const e of errores.slice(0, 20)) console.log(`    ${e}`);
    console.log(`\n  Las que sí se aplicaron están en el archivo de reversión y se pueden deshacer.`);
  }
  console.log(`\n  Para revertir: volver a poner tipo_combustible y observaciones de cada id\n  del archivo ${path.basename(rutaRev)}.\n`);
}

// ── Presentación ────────────────────────────────────────────────────────────

function detallar(titulo: string, filas: { carga: CargaRetro; v: VeredictoRetro }[], mostrarTipo: boolean) {
  if (!filas.length) return;
  console.log(`  ${titulo}  (${filas.length})`);
  const tope = 40;
  for (const f of filas.slice(0, tope)) {
    const c = f.carga;
    const destino = mostrarTipo || f.v.tipo ? ` → ${etiquetaCombustible(f.v.tipo ?? null)}` : "";
    console.log(
      `    #${String(c.id).padEnd(7)} ${(c.fecha ?? "—").padEnd(11)} ${(c.placa ?? "—").padEnd(12)}` +
      `${String(c.galones ?? "—").padStart(8)} × ${soles(c.precio_galon).padStart(10)}   ` +
      `${(c.tipo_combustible ?? "sin tipo").padEnd(10)}${destino}`
    );
    console.log(`             ${f.v.motivo}`);
    if (f.v.nota) console.log(`             ⚠ ${f.v.nota}`);
  }
  if (filas.length > tope) console.log(`    … y ${filas.length - tope} más (el archivo de reversión las lista todas al aplicar)`);
  console.log();
}

/**
 * `sincronizarPrecioDesdeCarga` (lib/precios-combustible.ts) pisa el precio OFICIAL de un
 * tipo con el de la última carga registrada desde /combustible. Si alguna vez se guardó
 * ahí una carga de GLP eligiendo "diésel" en el selector, el precio oficial del diésel
 * quedó en ~S/ 7. Eso alimenta el costo por km del Cotizador, así que se avisa: no lo
 * arregla este script, pero es del mismo problema y no debería descubrirse por accidente.
 */
function avisarPrecioOficial(precios: any[]): boolean {
  const sospechosos = precios.filter((p) => {
    const tipo = normalizarTipoCombustible(p.tipo);
    const cfg = tipo ? COMBUSTIBLES[tipo] : null;
    const precio = Number(p.precio);
    if (!cfg || !Number.isFinite(precio) || precio <= 0) return false;
    return Math.abs(precio - cfg.precioRef) / cfg.precioRef > 0.5;
  });
  if (!sospechosos.length) return false;
  console.log(`  ⚠ PRECIOS OFICIALES QUE CONVIENE MIRAR (no los toca este script)`);
  for (const p of sospechosos) {
    const tipo = normalizarTipoCombustible(p.tipo)!;
    console.log(`    ${etiquetaCombustible(tipo).padEnd(14)} ${soles(Number(p.precio))}  (referencial ${soles(COMBUSTIBLES[tipo].precioRef)})${p.fuente ? ` · fuente: ${p.fuente}` : ""}`);
  }
  console.log(`    Un precio oficial muy lejos de su referencial suele venir de una carga guardada\n` +
              `    con el tipo equivocado en /combustible: esa pantalla sincroniza el precio vigente\n` +
              `    con la última carga. Se corrige en /configuracion/costos.\n`);
  return true;
}

/** Las que el Radar capturó y nunca registró no son asunto del script: las resuelve la pantalla. */
function avisarPendientes(pendientes: number) {
  if (!pendientes) return;
  console.log(`  (${pendientes} fila(s) del Radar siguen en revisión: esas se resuelven en\n` +
              `   /radar-ia > Combustible, que ahora exige elegir el tipo antes de registrar.)\n`);
}

principal().catch((e) => {
  console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
