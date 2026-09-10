// scripts/diagnostico-tipo-combustible.mts
//
// ¿CUÁNTAS CARGAS TIENEN EL COMBUSTIBLE EQUIVOCADO, Y CUÁLES?
//
// Nace del caso CWQ400: la nota V97T-00001413 de COESTI imprime "GLP-G" y la recarga entró al
// ERP como DIÉSEL, porque `acciones.ts` resolvía el tipo con un `??` que dejaba la transcripción
// del producto como respaldo de la conclusión de la IA. Eso ya está arreglado para lo que entre
// de ahora en adelante (lib/radar/tipo-voucher.ts) — pero las filas YA GUARDADAS siguen mal, y
// un tipo equivocado envenena la capacidad de tanque, el precio referencial, el rendimiento
// km/gal de la unidad y, por ahí, el margen de sus servicios.
//
// POR DEFECTO SOLO LEE Y CUENTA. Para escribir hay que pasar `--aplicar`, y eso es deliberado:
// es la misma regla del botón "Poner en S/ 0.00" de /liquidaciones — la lista se mira primero y
// la pulsa una persona. Nunca un UPDATE masivo automático.
//
// USO:
//   npx tsx scripts/diagnostico-tipo-combustible.mts                  # cuenta y lista (no escribe)
//   npx tsx scripts/diagnostico-tipo-combustible.mts 2026-01-01       # desde una fecha
//   npx tsx scripts/diagnostico-tipo-combustible.mts --placa CWQ400   # solo una unidad
//   npx tsx scripts/diagnostico-tipo-combustible.mts --aplicar        # CORRIGE lo que propuso
//
// DOS EVIDENCIAS, Y NO VALEN LO MISMO — son las mismas dos de lib/radar/tipo-voucher.ts, y se
// usan LAS MISMAS FUNCIONES a propósito: si el motor y esta herramienta tuvieran cada uno su
// criterio, el script propondría cosas que el ERP ya no haría.
//
//   1. EL PAPEL (`papel`). La extracción cruda de la IA vive en `radar_mensajes.resultado`, y
//      ahí está `producto_voucher`: la descripción impresa, literal. Si dice "GLP-G" y la carga
//      quedó como diésel, no hay nada que discutir. Es la evidencia fuerte.
//   2. EL PRECIO (`precio`). Cuando no hay papel —o la IA no transcribió el producto— queda el
//      precio unitario contra `precios_combustible`: un "diésel" a S/ 7.55 se aleja un 69 % del
//      referencial del diésel y clava el del GLP al 1 %. Es evidencia CIRCUNSTANCIAL y por eso
//      se lista aparte y NO se aplica salvo que se pida con `--incluir-precio`: los precios se
//      mueven, hay promociones y hay grifos caros, y reescribir el producto desde un número que
//      no está en el papel es justo lo que el ERP se niega a hacer en vivo.
//
// Lo que se corrige es SOLO `combustible.tipo_combustible`. Ni galones, ni precio, ni monto: la
// plata de estas filas está bien, lo único mal es qué producto se compró. Y cada corrección se
// escribe además en `radar_combustible_correcciones` (campo `tipo_combustible`), que es el
// dataset que alimenta el prompt de la próxima foto — el mismo ciclo que cierra el panel de
// revisión cuando un humano corrige a mano.

import fs from "node:fs";
import path from "node:path";
import { resolverTipoCombustible, revisarTipoContraPrecio } from "../lib/radar/tipo-voucher";
import { configCombustible, familiaCombustible } from "../lib/combustible-tipos";
import { seriesRendimiento, tramosPorCarga, etiquetaMotivo, type CargaRendimiento } from "../lib/rendimiento";

// ── Argumentos ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const APLICAR = argv.includes("--aplicar");
const INCLUIR_PRECIO = argv.includes("--incluir-precio");
const iPlaca = argv.indexOf("--placa");
const PLACA = iPlaca >= 0 ? String(argv[iPlaca + 1] ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
const DESDE = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? "2000-01-01";

// ── Credenciales ────────────────────────────────────────────────────────────

const RAIZ = process.cwd();
const RUTA_ENV = path.join(RAIZ, ".env.local");
if (!fs.existsSync(RUTA_ENV)) {
  console.error(
    `\n  No encuentro ${RUTA_ENV}.\n\n` +
    `  Este script lee la base de producción y saca las credenciales de ahí, igual que los\n` +
    `  demás diagnostico-*.mts. Córrelo desde la raíz del repo en una máquina que tenga su\n` +
    `  .env.local (no está versionado, por eso no viaja en el clon).\n`
  );
  process.exit(1);
}
const env = fs.readFileSync(RUTA_ENV, "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
if (!URL || !KEY) {
  console.error("\n  .env.local existe pero le falta NEXT_PUBLIC_SUPABASE_URL o la key.\n");
  process.exit(1);
}
if (APLICAR && !leer("SUPABASE_SERVICE_ROLE_KEY")) {
  console.error("\n  --aplicar necesita SUPABASE_SERVICE_ROLE_KEY (la anon no puede escribir).\n");
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

/** PostgREST corta en 1000 filas. */
async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${URL}/rest/v1/${ruta}`, {
      headers: { ...H, Range: `${desde}-${desde + 999}`, "Range-Unit": "items" },
    });
    if (!r.ok) throw new Error(`${ruta} → ${r.status} ${await r.text()}`);
    const filas = (await r.json()) as any[];
    out.push(...filas);
    if (filas.length < 1000) return out;
  }
}

const linea = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);
const etiqueta = (t?: string | null) => (t ? configCombustible(t).label : "—");
const soles = (n: unknown) => (Number(n) > 0 ? `S/ ${Number(n).toFixed(2)}` : "—");

// ── Datos ───────────────────────────────────────────────────────────────────

console.log(`\nTIPO DE COMBUSTIBLE · cargas guardadas desde ${DESDE}${PLACA ? ` · placa ${PLACA}` : ""}`);
console.log(APLICAR ? "MODO: --aplicar (VA A ESCRIBIR)" : "MODO: solo lectura");

const cargas = await traer(
  `combustible?select=id,vehiculo_id,fecha,kilometraje,galones,precio_galon,tipo_combustible,unidad,grifo,observaciones` +
  `&fecha=gte.${DESDE}&order=fecha.asc`
);
const vehiculos = await traer("vehiculos?select=id,placa");
const precios = await traer("precios_combustible?select=tipo,precio");

// El puente Radar → carga se lee AL REVÉS: `combustible` no guarda nada del Radar, así que la
// única forma de saber qué papel originó una carga es preguntarle al Radar cuál carga escribió.
const radar = await traer(
  `radar_combustible?select=id,combustible_id,mensaje_id,tipo_combustible,comprobante&combustible_id=not.is.null`
);

const placaDe = new Map<number, string>();
for (const v of vehiculos) placaDe.set(v.id, String(v.placa ?? ""));

const radarPorCarga = new Map<number, any>();
for (const r of radar) if (r.combustible_id != null) radarPorCarga.set(Number(r.combustible_id), r);

// La extracción cruda —con `producto_voucher`— vive en el blob del mensaje. Se piden solo los
// mensajes que de verdad hacen falta: `radar_mensajes.resultado` es grande y traerlos todos
// sería una tabla entera para leer un campo.
const idsMensaje = [...new Set(
  [...radarPorCarga.values()].map((r) => r.mensaje_id).filter(Boolean)
)] as string[];

const resultadoPorMensaje = new Map<string, any>();
for (let i = 0; i < idsMensaje.length; i += 50) {
  const lote = idsMensaje.slice(i, i + 50);
  const filas = await traer(
    `radar_mensajes?select=id,resultado&id=in.(${lote.map((x) => `"${x}"`).join(",")})`
  );
  for (const f of filas) resultadoPorMensaje.set(String(f.id), f.resultado);
}

/**
 * `producto_voucher` de la extracción cruda.
 *
 * `lib/radar/motor.ts` guarda `resultado: { extraccion: datos, accion: … }`, así que el producto
 * está en `resultado.extraccion.producto_voucher` — los otros dos caminos son por si alguna fila
 * vieja quedó con otra forma. Vale la pena mirarlo bien: si esta ruta estuviera equivocada el
 * script diría "0 a corregir" sobre datos que sí están mal, que es peor que no tenerlo.
 */
function productoDelPapel(mensajeId?: string | null): string | null {
  const res = mensajeId ? resultadoPorMensaje.get(String(mensajeId)) : null;
  if (!res || typeof res !== "object") return null;
  const d = (res as any).extraccion ?? (res as any).datos ?? res;
  const p = d?.producto_voucher;
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

// ── El juicio, con los MISMOS motores que usa el ERP en vivo ─────────────────

type Hallazgo = {
  id: number;
  fecha: string;
  placa: string;
  guardado: string | null;
  propuesto: string;
  evidencia: "papel" | "precio";
  detalle: string;
  precio: number;
  radarId: string | null;
  comprobante: string | null;
};

const hallazgos: Hallazgo[] = [];
let revisadas = 0;
/** Cuántas traen el producto impreso transcrito: la cobertura de la evidencia FUERTE. */
let conPapel = 0;

for (const c of cargas) {
  const placa = placaDe.get(Number(c.vehiculo_id)) ?? "";
  if (PLACA && placa.replace(/[^A-Z0-9]/gi, "").toUpperCase() !== PLACA) continue;
  revisadas++;

  const r = radarPorCarga.get(Number(c.id));
  const guardado = c.tipo_combustible ? String(c.tipo_combustible) : null;
  const producto = productoDelPapel(r?.mensaje_id);

  // 1) EL PAPEL. Misma función que corre en el pipeline: lo que diga el producto impreso manda.
  if (producto) {
    conPapel++;
    const v = resolverTipoCombustible({ declarado: guardado, producto });
    if (v.tipo && v.tipo !== guardado && v.anomalia?.codigo === "tipo_corregido_por_producto") {
      hallazgos.push({
        id: Number(c.id), fecha: String(c.fecha ?? "").slice(0, 10), placa,
        guardado, propuesto: v.tipo, evidencia: "papel",
        detalle: `el voucher imprime "${producto}"`,
        precio: Number(c.precio_galon) || 0,
        radarId: r?.id ?? null, comprobante: r?.comprobante ?? null,
      });
      continue;
    }
  }

  // 2) EL PRECIO. Circunstancial: solo se propone, y solo se aplica si se pide expresamente.
  const v = revisarTipoContraPrecio({
    tipo: guardado ?? "diesel",
    precio: Number(c.precio_galon) || null,
    referenciales: precios.map((p: any) => ({ tipo: String(p.tipo ?? ""), precio: Number(p.precio) })),
    leido: guardado != null,
  });
  if (v.anomalia) {
    // La familia candidata sale del propio detalle del motor; se recupera comparando referenciales.
    const fam = precios
      .map((p: any) => ({ t: String(p.tipo ?? "").toLowerCase(), p: Number(p.precio) }))
      .filter((x) => x.p > 0 && familiaCombustible(x.t) !== familiaCombustible(guardado ?? "diesel"))
      .filter((x) => Math.abs(Number(c.precio_galon) - x.p) / x.p <= 0.08)[0];
    if (fam) {
      hallazgos.push({
        id: Number(c.id), fecha: String(c.fecha ?? "").slice(0, 10), placa,
        guardado, propuesto: fam.t, evidencia: "precio",
        detalle: `pagó ${soles(c.precio_galon)}, el referencial de ${etiqueta(fam.t)} es ${soles(fam.p)}`,
        precio: Number(c.precio_galon) || 0,
        radarId: r?.id ?? null, comprobante: r?.comprobante ?? null,
      });
    }
  }
}

// ── Informe ─────────────────────────────────────────────────────────────────

const porPapel = hallazgos.filter((h) => h.evidencia === "papel");
const porPrecio = hallazgos.filter((h) => h.evidencia === "precio");

console.log(
  `\n${revisadas} carga(s) revisada(s) · ${radarPorCarga.size} nacidas del Radar · ` +
  `${conPapel} con el producto del voucher transcrito`
);

linea(`A CORREGIR — el papel lo dice: ${porPapel.length}`);
if (!porPapel.length) {
  // "0" significa dos cosas MUY distintas y hay que decir cuál, o el informe se lee como un
  // "está todo bien" que quizá sea sólo "no hay con qué comprobarlo".
  console.log(
    conPapel
      ? `  (ninguna: en las ${conPapel} cargas con producto transcrito, el tipo guardado coincide)`
      : `  (ninguna, pero OJO: NINGUNA carga trae el producto del voucher transcrito, así que no\n` +
        `   hay evidencia fuerte que revisar. \`producto_voucher\` es un campo del prompt reciente:\n` +
        `   las cargas anteriores no lo tienen. Para esas, lo único que queda es el precio — mira\n` +
        `   la lista de sospechosas de abajo.)`
  );
}
for (const h of porPapel) {
  console.log(
    `  #${h.id}  ${h.fecha}  ${(h.placa || "?").padEnd(8)}  ` +
    `${etiqueta(h.guardado).padEnd(18)} → ${etiqueta(h.propuesto).padEnd(18)}  ${h.detalle}` +
    (h.comprobante ? `  · ${h.comprobante}` : "")
  );
}

linea(`SOSPECHOSAS — solo el precio lo dice: ${porPrecio.length}`);
if (porPrecio.length) {
  console.log("  Evidencia circunstancial: revísalas contra la foto antes de tocarlas.");
  console.log("  (se aplican únicamente con --incluir-precio)\n");
}
if (!porPrecio.length) console.log("  (ninguna)");
for (const h of porPrecio) {
  console.log(
    `  #${h.id}  ${h.fecha}  ${(h.placa || "?").padEnd(8)}  ` +
    `${etiqueta(h.guardado).padEnd(18)} → ${etiqueta(h.propuesto).padEnd(18)}  ${h.detalle}`
  );
}

// ── INVENTARIO DE LA UNIDAD (solo con --placa) ──────────────────────────────
//
// Contesta "revísame las cargas de gasolina de la CWQ400", que NO es la misma pregunta que
// "cuáles están mal clasificadas": una unidad bicombustible puede tener todo bien tipificado y
// aun así conviene mirar cuántas veces cargó cada combustible, cuándo y por cuánto. Con la
// gasolina esporádica —aire acondicionado, subidas— el patrón esperado son pocas cargas y
// pequeñas; muchas cargas de gasolina en una van que anda a GLP es en sí mismo el hallazgo.
if (PLACA) {
  const suyas = cargas.filter(
    (c: any) => (placaDe.get(Number(c.vehiculo_id)) ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase() === PLACA
  );

  // El motor de rendimiento decide los veredictos, incluido el `familia_cruzada` de una unidad
  // bicombustible. Se le pasan TODAS sus cargas para que pueda derivar que lo es.
  const paraRend: CargaRendimiento[] = suyas.map((c: any) => ({
    id: Number(c.id),
    unidad: PLACA,
    fecha: String(c.fecha ?? "").slice(0, 10),
    kilometraje: c.kilometraje,
    cantidad: c.galones,
    unidadCantidad: c.unidad,
    tipo: c.tipo_combustible,
  }));
  const porCarga = tramosPorCarga(seriesRendimiento(paraRend));

  const familias = [...new Set(suyas.map((c: any) => familiaCombustible(c.tipo_combustible)))].sort();
  linea(`INVENTARIO DE ${PLACA} — ${suyas.length} carga(s), ${familias.length} combustible(s)`);
  if (familias.length > 1) {
    console.log(
      `  Es una unidad BICOMBUSTIBLE: sus km se reparten entre ${familias.join(" y ")}, así que\n` +
      `  ningún tramo que envuelva un repostaje del otro combustible se puede medir. Eso sale\n` +
      `  abajo como "bicombustible", y NO es una carga que falte registrar.\n`
    );
  }

  for (const fam of familias) {
    const delFam = suyas.filter((c: any) => familiaCombustible(c.tipo_combustible) === fam);
    const gal = delFam.reduce((s: number, c: any) => s + (Number(c.galones) || 0), 0);
    const soles_ = delFam.reduce(
      (s: number, c: any) => s + (Number(c.galones) || 0) * (Number(c.precio_galon) || 0), 0
    );
    const fechas = delFam.map((c: any) => String(c.fecha ?? "").slice(0, 10)).sort();
    console.log(
      `\n  ${etiqueta(delFam[0]?.tipo_combustible).toUpperCase()} — ${delFam.length} carga(s) · ` +
      `${gal.toFixed(2)} unid. · ${soles(soles_)} · ${fechas[0]} → ${fechas[fechas.length - 1]}`
    );
    for (const c of delFam) {
      const t = porCarga[Number(c.id)]?.tramo;
      const veredicto = t
        ? t.rendimiento != null
          ? `${t.rendimiento.toFixed(1)} km/gal`
          : etiquetaMotivo(t.motivo!)
        : "—";
      const sospecha = hallazgos.find((h) => h.id === Number(c.id));
      console.log(
        `    #${String(c.id).padEnd(6)} ${String(c.fecha ?? "").slice(0, 10)}  ` +
        `${String(Number(c.galones ?? 0).toFixed(3)).padStart(8)} @ ${soles(c.precio_galon).padStart(9)}  ` +
        `km ${String(c.kilometraje ?? 0).padStart(8)}  ${veredicto.padEnd(18)} ${c.grifo ?? ""}` +
        (sospecha ? `  ⚠ ${sospecha.evidencia}: sería ${etiqueta(sospecha.propuesto)}` : "")
      );
    }
  }
}

// Resumen por unidad: es lo que dice si una placa es bicombustible y estaba toda mal clasificada.
const porPlaca = new Map<string, Map<string, number>>();
for (const h of hallazgos) {
  const m = porPlaca.get(h.placa || "?") ?? new Map<string, number>();
  const k = `${etiqueta(h.guardado)} → ${etiqueta(h.propuesto)}`;
  m.set(k, (m.get(k) ?? 0) + 1);
  porPlaca.set(h.placa || "?", m);
}
if (porPlaca.size) {
  linea("POR UNIDAD");
  for (const [p, m] of [...porPlaca].sort()) {
    console.log(`  ${p.padEnd(10)} ${[...m].map(([k, n]) => `${n}× ${k}`).join(" · ")}`);
  }
}

// ── Aplicar ─────────────────────────────────────────────────────────────────

const aCorregir = INCLUIR_PRECIO ? hallazgos : porPapel;

if (!APLICAR) {
  linea("NO SE ESCRIBIÓ NADA");
  console.log(
    `  Para corregir las ${porPapel.length} que el papel respalda:\n` +
    `      npx tsx scripts/diagnostico-tipo-combustible.mts${PLACA ? ` --placa ${PLACA}` : ""} --aplicar\n` +
    (porPrecio.length
      ? `  Para incluir además las ${porPrecio.length} sospechosas por precio, agrega --incluir-precio\n`
      : "")
  );
  process.exit(0);
}

if (!aCorregir.length) {
  linea("NADA QUE APLICAR");
  process.exit(0);
}

linea(`APLICANDO ${aCorregir.length} corrección(es)`);
let ok = 0;
let falló = 0;

for (const h of aCorregir) {
  // SOLO el tipo. La plata de estas filas está bien; lo único mal es qué producto se compró.
  const r = await fetch(`${URL}/rest/v1/combustible?id=eq.${h.id}`, {
    method: "PATCH",
    headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ tipo_combustible: h.propuesto }),
  });
  if (!r.ok) {
    falló++;
    console.log(`  ✗ #${h.id}  ${r.status} ${await r.text()}`);
    continue;
  }
  ok++;
  console.log(`  ✓ #${h.id}  ${etiqueta(h.guardado)} → ${etiqueta(h.propuesto)}`);

  // El ciclo se cierra solo: la corrección entra al dataset que alimenta el prompt de la próxima
  // foto, igual que cuando un humano corrige el campo en /radar-ia. Best-effort: que falle la
  // lección no puede deshacer la corrección, que es lo que importa.
  if (h.radarId) {
    await fetch(`${URL}/rest/v1/radar_combustible_correcciones`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        radar_combustible_id: h.radarId,
        campo: "tipo_combustible",
        valor_ia: h.guardado,
        valor_correcto: h.propuesto,
        nota: `Corrección retroactiva (${h.evidencia}): ${h.detalle}`,
        usuario: "diagnostico_tipo_combustible",
      }),
    }).catch(() => {});
  }
}

linea("RESULTADO");
console.log(`  ${ok} corregida(s)${falló ? ` · ${falló} fallaron` : ""}`);
console.log(
  `\n  El rendimiento km/gal de las unidades tocadas cambia con esto: sus cargas pasan a la\n` +
  `  cadena del combustible correcto. Vale la pena correr después:\n` +
  `      npx tsx scripts/diagnostico-rendimiento.mts\n`
);
