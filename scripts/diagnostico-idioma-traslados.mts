// ¿Qué haría la detección del idioma (lib/idioma-cliente.ts) sobre las conversaciones REALES del CRM
// en las que la IA cotizó un traslado? Es la medición previa a ENCENDER el inglés (asignar una
// plantilla en inglés a «Traslado de la IA · inglés» en /cotizaciones/plantillas): los tres umbrales
// del detector (VENTANA_IDIOMA_H, DECISIVOS_IDIOMA, MIN_PUNTOS_IDIOMA) no están medidos.
//
// Por cada cotización de traslado de la IA (`cotizaciones.traslado_json` no nulo y con
// `crm_conversacion_id`) de los últimos N días corre `idiomaDelCliente` sobre los mensajes ENTRANTES
// de su conversación ANTERIORES a la cotización (los que habría visto la IA al cotizar), con la hora
// de la cotización como «ahora», e imprime:
//   · cuántas salen castellano / inglés / otro idioma / sin evidencia, por prefijo del número
//     (+51 / otro país / sin número);
//   · la moneda con que se cotizó contra la que tendría con el inglés encendido (`monedaDelPedido`
//     con el idioma detectado), y en especial cuántos +51 pasarían de SOLES a DÓLARES (el cambio
//     que más le cuesta al cliente si la detección se equivoca);
//   · hasta 20 mensajes de números +51 que un solo mensaje ya decide como inglés, para revisar a mano
//     los falsos positivos (nombres de hoteles, palabras sueltas). Los dígitos largos se tapan.
// Con `todas` mide además TODAS las conversaciones de WhatsApp con mensajes entrantes en la ventana
// (cotizaran o no): el ruido del detector sobre el tráfico normal.
//
// Uso:  npx tsx scripts/diagnostico-idioma-traslados.mts [días] [todas]   (días 1-365, por defecto 90)
//
// Solo LEE (service-role). Nunca escribe ni manda nada.
/* eslint-disable @typescript-eslint/no-explicit-any -- lee filas crudas de PostgREST, sin tipos generados */
import fs from "node:fs";
import path from "node:path";
import type { IdiomaCliente, MensajeParaIdioma } from "../lib/idioma-cliente";

const DIAS = Number(process.argv[2] ?? 90);
const TODAS = process.argv.slice(2).includes("todas");
if (!Number.isInteger(DIAS) || DIAS < 1 || DIAS > 365) {
  console.error("\n❌ Uso: npx tsx scripts/diagnostico-idioma-traslados.mts [días] [todas]   (días: entero de 1 a 365)\n");
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
const { faltaColumna } = await import("../lib/columna-faltante");
const I = await import("../lib/idioma-cliente");
const { monedaDelPedido, monedaPorTelefono } = await import("../lib/traslados/motor");

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PAGINA = 1000;
const MAX_ENTRANTES = 60; // lo que lee la IA (lib/traslados/cotizar-ia-datos.ts → entrantesDe)
const ahora = Date.now();
const desdeIso = new Date(ahora - DIAS * 86_400_000).toISOString();

/** Una lectura que falla CORTA el diagnóstico: contar a medias diría que el detector no se equivoca. */
async function todas<T>(consulta: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: any }>, que: string): Promise<T[]> {
  const filas: T[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await consulta(desde, desde + PAGINA - 1);
    if (error) throw new Error(`No se pudo leer ${que}: ${error.message ?? error}`);
    filas.push(...(data ?? []));
    if (!data || data.length < PAGINA) return filas;
  }
}

type Cot = { id: number; numero_cotizacion: string | null; created_at: string; moneda: string | null; crm_conversacion_id: string; idioma_pdf?: string | null };
let sinIdiomaPdf = false;
async function leerCotizaciones(): Promise<Cot[]> {
  const cols = "id, numero_cotizacion, created_at, moneda, crm_conversacion_id, idioma_pdf";
  const q = (c: string) => (d: number, h: number) => admin.from("cotizaciones").select(c)
    .not("traslado_json", "is", null).not("crm_conversacion_id", "is", null).gte("created_at", desdeIso)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).range(d, h) as any;
  try {
    return await todas<Cot>(q(cols), "las cotizaciones de traslado");
  } catch (e) {
    // Solo se suelta la columna accesoria si el error la NOMBRA (cotizaciones-04).
    if (!faltaColumna({ message: String((e as Error).message) }, "idioma_pdf")) throw e;
    sinIdiomaPdf = true;
    return todas<Cot>(q(cols.replace(", idioma_pdf", "")), "las cotizaciones de traslado");
  }
}

/** El wa_id del contacto de cada conversación (null si no tiene). */
async function waDeConversaciones(ids: string[]): Promise<Map<string, string | null>> {
  const m = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    const { data, error } = await admin.from("crm_conversaciones").select("id, canal, crm_contactos(wa_id)").in("id", lote);
    if (error) throw new Error(`No se pudieron leer las conversaciones: ${error.message}`);
    for (const c of (data ?? []) as any[]) {
      const ct = Array.isArray(c.crm_contactos) ? c.crm_contactos[0] : c.crm_contactos;
      m.set(String(c.id), typeof ct?.wa_id === "string" && ct.wa_id.trim() ? ct.wa_id.trim() : null);
    }
  }
  return m;
}

/** Los entrantes de una conversación hasta `hastaIso`, del más reciente al más antiguo (como los lee la IA). */
async function entrantes(convId: string, hastaIso: string | null): Promise<MensajeParaIdioma[]> {
  let q = admin.from("crm_mensajes").select("contenido, tipo, created_at").eq("conversacion_id", convId).eq("direccion", "entrante");
  if (hastaIso) q = q.lte("created_at", hastaIso);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(MAX_ENTRANTES);
  if (error) throw new Error(`No se pudieron leer los mensajes de la conversación ${convId}: ${error.message}`);
  return ((data ?? []) as MensajeParaIdioma[]).filter((m) => String(m.contenido ?? "").trim() !== "");
}

const prefijo = (wa: string | null): "+51" | "otro país" | "sin número" => {
  if (!wa) return "sin número";
  const p = monedaPorTelefono(wa).moneda;
  return p === "PEN" ? "+51" : "otro país";
};
type Celda = "castellano" | "inglés" | "otro idioma" | "sin evidencia";
const celdaDe = (i: IdiomaCliente | null): Celda => (i === "es" ? "castellano" : i === "en" ? "inglés" : i === "otro" ? "otro idioma" : "sin evidencia");
const tapar = (t: string) => t.replace(/\d[\d\s.-]{4,}\d/g, "▒▒▒").replace(/\s+/g, " ").trim().slice(0, 140);
const esTexto = (m: MensajeParaIdioma) => m.tipo == null || m.tipo === "texto" || m.tipo === "text";

type Tabla = Map<string, Map<Celda, number>>;
const sumar = (t: Tabla, fila: string, col: Celda) => {
  const f = t.get(fila) ?? new Map<Celda, number>();
  f.set(col, (f.get(col) ?? 0) + 1);
  t.set(fila, f);
};
const imprimirTabla = (t: Tabla) => {
  const cols: Celda[] = ["castellano", "inglés", "otro idioma", "sin evidencia"];
  console.log(`   ${"".padEnd(12)}${cols.map((c) => c.padStart(15)).join("")}${"total".padStart(9)}`);
  for (const fila of ["+51", "otro país", "sin número"]) {
    const f = t.get(fila);
    if (!f) continue;
    const tot = cols.reduce((s, c) => s + (f.get(c) ?? 0), 0);
    console.log(`   ${fila.padEnd(12)}${cols.map((c) => String(f.get(c) ?? 0).padStart(15)).join("")}${String(tot).padStart(9)}`);
  }
};

console.log(`\n🔎 Idioma del cliente en los traslados de la IA · últimos ${DIAS} días (desde ${desdeIso.slice(0, 10)})`);
console.log(`   Umbrales del detector (no medidos): ventana ${I.VENTANA_IDIOMA_H} h · mayoría de ${I.DECISIVOS_IDIOMA} mensajes · ${I.MIN_PUNTOS_IDIOMA} puntos para decidir.`);

const cots = await leerCotizaciones();
if (sinIdiomaPdf) console.log("   (Falta supabase/cotizaciones-04-moneda-idioma.sql: no se lee idioma_pdf.)");
console.log(`   ${cots.length} cotizaciones de traslado de la IA con conversación.`);
const wa = await waDeConversaciones([...new Set(cots.map((c) => String(c.crm_conversacion_id)))]);

const tabla: Tabla = new Map();
const cambios = new Map<string, number>(); // «PEN → USD (+51)», etc.
const muestras: string[] = [];
let yaEnIngles = 0;
for (const c of cots) {
  const conv = String(c.crm_conversacion_id);
  const w = wa.get(conv) ?? null;
  const pre = prefijo(w);
  const lista = await entrantes(conv, c.created_at);
  const det = I.idiomaDelCliente(lista, Date.parse(c.created_at));
  sumar(tabla, pre, celdaDe(det.idioma));
  if (c.idioma_pdf === "en") yaEnIngles++;
  // La moneda con que se cotizó contra la que tendría con el inglés encendido. Pidió dólares si,
  // desde un número peruano, se cotizó en dólares (no queda escrito de otro modo).
  const porNumero = monedaPorTelefono(w).moneda;
  const pideDolares = c.moneda === "USD" && porNumero === "PEN";
  const idiomaMoneda = det.idioma === "en" || det.idioma === "otro" ? det.idioma : null;
  const conIngles = monedaDelPedido(w, pideDolares, { idiomaCliente: idiomaMoneda }).moneda ?? "?";
  const cotizada = c.moneda === "USD" ? "USD" : "PEN";
  if (conIngles !== cotizada) {
    const k = `${cotizada} → ${conIngles} (${pre})`;
    cambios.set(k, (cambios.get(k) ?? 0) + 1);
  }
  // Muestras: mensajes de un +51 que por sí solos deciden inglés.
  if (pre === "+51" && muestras.length < 20) {
    for (const m of lista) {
      if (muestras.length >= 20) break;
      if (!esTexto(m)) continue;
      if (I.idiomaDeMensaje(String(m.contenido ?? "")).idioma === "en") muestras.push(`   · N° ${c.numero_cotizacion ?? c.id} · «${tapar(String(m.contenido ?? ""))}»`);
    }
  }
}

console.log("\n1) Idioma detectado al cotizar, por prefijo del número:");
imprimirTabla(tabla);
if (yaEnIngles) console.log(`   (${yaEnIngles} ya se cotizaron en inglés: idioma_pdf = en.)`);

console.log("\n2) La moneda con el inglés encendido (contra la que se cotizó):");
if (!cambios.size) console.log("   Ninguna cambiaría.");
for (const [k, n] of [...cambios.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${n}`);
const solesADolares = cambios.get("PEN → USD (+51)") ?? 0;
console.log(`   ⇒ ${solesADolares} cotización(es) de números +51 pasarían de soles a dólares (el caso que hay que revisar a mano).`);

console.log("\n3) Mensajes de números +51 que un solo mensaje decide como inglés (revisar falsos positivos):");
if (!muestras.length) console.log("   Ninguno.");
for (const m of muestras) console.log(m);

if (TODAS) {
  console.log(`\n4) Todas las conversaciones de WhatsApp con mensajes entrantes desde ${desdeIso.slice(0, 10)}:`);
  const convs = await todas<any>((d, h) => admin.from("crm_conversaciones").select("id, canal, ultimo_mensaje_at, crm_contactos(wa_id)")
    .eq("canal", "whatsapp").gte("ultimo_mensaje_at", desdeIso).order("ultimo_mensaje_at", { ascending: true }).order("id", { ascending: true }).range(d, h) as any, "las conversaciones");
  const t2: Tabla = new Map();
  for (const c of convs) {
    const ct = Array.isArray(c.crm_contactos) ? c.crm_contactos[0] : c.crm_contactos;
    const w = typeof ct?.wa_id === "string" && ct.wa_id.trim() ? ct.wa_id.trim() : null;
    const lista = await entrantes(String(c.id), null);
    if (!lista.length) continue;
    // «Ahora» es el último mensaje de la conversación: la ventana de la detección se mide desde ahí.
    const fin = Date.parse(String(c.ultimo_mensaje_at ?? ""));
    sumar(t2, prefijo(w), celdaDe(I.idiomaDelCliente(lista, Number.isFinite(fin) ? fin : ahora).idioma));
  }
  console.log(`   ${convs.length} conversaciones (la ventana de ${I.VENTANA_IDIOMA_H} h, contada desde el último mensaje de cada una).`);
  imprimirTabla(t2);
}
console.log("\nSolo se leyó; no se escribió nada.\n");
