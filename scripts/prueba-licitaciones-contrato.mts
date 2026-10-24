// scripts/prueba-licitaciones-contrato.mts — Matriz del contrato del módulo Licitaciones y sus piezas compartidas.
//   npx tsx scripts/prueba-licitaciones-contrato.mts
//
// Lo que fija, y por qué:
//  1. Cada tipo canónico que la licitación exige (CANONICOS_DOC_UNIDAD) EXISTE en TIPOS_DOC_UNIDAD: si
//     alguien renombra un documento de unidad, la licitación dejaría de encontrarlo sin avisar.
//  2. GRAVEDAD_HALLAZGO declara exactamente los códigos de CodigoHallazgo (una entrada por código).
//  3. La lista única de categorías empieza por las 9 que /documentos ya escribía, en el mismo orden.
//  4. Las licencias: A-IIIc cubre A-IIIa; A-IIIb (carga) NO cubre A-IIIa (pasajeros); texto libre → null.
//  5. origenArchivo: Drive y otro proyecto son `externo` (no se pueden unir); el bucket nuevo es privado.
//  6. Rutas: escribir y leer con la misma identidad (rutaNueva ↔ RE_RUTA_BASE ↔ objetoPrivadoDe).
//  7. canonico extraído: la Confirmación de Reserva sigue firmando igual.

import { StorageClient } from "@supabase/storage-js";
import {
  CANONICOS_DOC_UNIDAD, CODIGOS_LEGAJO, CODIGOS_DOC_CONDUCTOR, GRAVEDAD_HALLAZGO, TIPOS_REGLA, CARPETAS_LICITACION,
  type CodigoHallazgo,
} from "../lib/licitaciones/tipos";
import { TIPOS_DOC_UNIDAD } from "../lib/documentos-estado";
import { CATEGORIAS_DOCUMENTO, CATEGORIAS_GENERALES, GRUPOS_CATEGORIA, etiquetaCategoria, estadoParaColumna } from "../lib/documentos-empresa-categorias";
import { cubreCategoria, cubreAlguna, normalizarCategoria } from "../lib/licencias-conducir";
import { origenArchivo, rutaNueva, RE_RUTA_BASE, nombreArchivoEmitido, rutaEmision, mimeDeNombre } from "../lib/licitaciones/archivos";
import { objetoPrivadoDe, BUCKETS_PRIVADOS } from "../lib/storage-privado";
import { canonico } from "../lib/json-canonico";
import { canonico as canonicoReserva } from "../lib/confirmacion-reserva";
import { todasLasPaginas, LecturaIncompleta } from "../lib/paginar-estricto";
import { readFileSync } from "node:fs";

const BASE = "https://qakhcezrmpksxgiwzmvd.supabase.co";
let ok = 0, fallos = 0;
const check = (cond: unknown, msg: string) => { if (cond) ok++; else { fallos++; console.log("  ✗", msg); } };
const sec = (t: string) => console.log(`\n── ${t}`);

// ── 1. Documentos de unidad ───────────────────────────────────────────────────
sec("1. CANONICOS_DOC_UNIDAD existen en TIPOS_DOC_UNIDAD");
const canonicos = new Set(TIPOS_DOC_UNIDAD.map((t) => t.canonico));
for (const [doc, lista] of Object.entries(CANONICOS_DOC_UNIDAD)) {
  for (const c of lista) check(canonicos.has(c), `${doc}: "${c}" no está en TIPOS_DOC_UNIDAD`);
}

// ── 2. Gravedad declarada por código ──────────────────────────────────────────
sec("2. GRAVEDAD_HALLAZGO cubre la unión de CodigoHallazgo");
const fuente = readFileSync(new URL("../lib/licitaciones/tipos.ts", import.meta.url), "utf8");
const bloque = fuente.slice(fuente.indexOf("export type CodigoHallazgo"), fuente.indexOf("export const GRAVEDAD_HALLAZGO"));
const enUnion = new Set([...bloque.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
const enMapa = new Set(Object.keys(GRAVEDAD_HALLAZGO));
check(enUnion.size > 60, `la unión tiene ${enUnion.size} códigos (se esperaban > 60)`);
for (const c of enUnion) check(enMapa.has(c), `falta la gravedad de ${c}`);
for (const c of enMapa) check(enUnion.has(c), `gravedad de un código que no está en la unión: ${c}`);
const gravs = new Set(Object.values(GRAVEDAD_HALLAZGO));
check(gravs.has("alarma") && gravs.has("aviso") && gravs.has("info"), "deben existir las tres gravedades");
check(new Set(TIPOS_REGLA).size === TIPOS_REGLA.length, "TIPOS_REGLA sin repetidos");
const _tipado: CodigoHallazgo = "pdf_protegido"; void _tipado;

// ── 3. Categorías de documentos_empresa ───────────────────────────────────────
sec("3. Lista única de categorías");
const viejas = ["contrato", "guia_remision", "sst", "capacitacion", "permiso", "legal", "factura", "interno", "otro"];
check(JSON.stringify(CATEGORIAS_GENERALES) === JSON.stringify(viejas), "las 9 generales de /documentos, mismo orden");
check(JSON.stringify(CATEGORIAS_DOCUMENTO.slice(0, 9)) === JSON.stringify(viejas), "CATEGORIAS_DOCUMENTO empieza por las 9 de siempre");
check(new Set(CATEGORIAS_DOCUMENTO).size === CATEGORIAS_DOCUMENTO.length, "sin categorías repetidas");
for (const c of CODIGOS_LEGAJO) check(CATEGORIAS_DOCUMENTO.includes(c), `legajo ${c} en la lista única`);
for (const c of CODIGOS_DOC_CONDUCTOR) check(CATEGORIAS_DOCUMENTO.includes(c), `doc conductor ${c} en la lista única`);
const enGrupos = GRUPOS_CATEGORIA.flatMap((g) => g.codigos);
check(enGrupos.length === CATEGORIAS_DOCUMENTO.length && enGrupos.every((c) => CATEGORIAS_DOCUMENTO.includes(c)), "los grupos particionan la lista");
for (const c of CATEGORIAS_DOCUMENTO) check(etiquetaCategoria(c) !== c || c === "otro", `etiqueta de ${c}`);
check(etiquetaCategoria("algo_raro") === "algo raro", "categoría desconocida sale legible");
check(estadoParaColumna("2026-10-01", "2026-10-24") === "vencido", "vencido");
check(estadoParaColumna("2026-11-10", "2026-10-24") === "por_vencer", "por vencer (≤ 30 días)");
check(estadoParaColumna(null, "2026-10-24") === "vigente", "sin vencimiento → vigente");

// ── 4. Licencias ──────────────────────────────────────────────────────────────
sec("4. Licencias de conducir");
check(normalizarCategoria("A-IIIa") === "A-IIIa", "A-IIIa");
check(normalizarCategoria("a iii a") === "A-IIIa", "a iii a");
check(normalizarCategoria("A3C") === "A-IIIc", "A3C");
check(normalizarCategoria("B-IIb") === null, "B-IIb no es de la clase A");
check(normalizarCategoria("profesional") === null, "texto libre → null");
check(cubreCategoria("A-IIIc", "A-IIIa"), "A-IIIc cubre A-IIIa");
check(!cubreCategoria("A-IIIb", "A-IIIa"), "A-IIIb (carga) no cubre A-IIIa (pasajeros)");
check(cubreCategoria("A-IIIa", "A-IIb"), "A-IIIa cubre A-IIb");
check(!cubreCategoria("A-IIb", "A-IIIa"), "A-IIb no cubre A-IIIa");
check(cubreAlguna("A-IIIa", ["A-IIb", "A-IIIa"]) === true, "cubre alguna");
check(cubreAlguna("A-IIa", ["A-IIIa"]) === false, "no cubre");
check(cubreAlguna(null, ["A-IIIa"]) === null, "sin categoría → no se puede juzgar");

// ── 5. Orígenes de archivo ────────────────────────────────────────────────────
sec("5. origenArchivo");
const storage = new StorageClient(`${BASE}/storage/v1`, {});
const publica = (bucket: string, ruta: string) => storage.from(bucket).getPublicUrl(ruta).data.publicUrl;
check(BUCKETS_PRIVADOS.includes("licitaciones" as never), "licitaciones es privado");
check(origenArchivo(null, BASE) === "vacio" && origenArchivo("  ", BASE) === "vacio", "vacío");
check(origenArchivo("https://drive.google.com/file/d/abc/view", BASE) === "externo", "Drive es externo");
check(origenArchivo(publica("documentos", "x/soat.pdf").replace("qakhcezrmpksxgiwzmvd", "otro"), BASE) === "externo", "otro proyecto es externo");
check(origenArchivo(publica("documentos", "x/soat.pdf"), BASE) === "storage_privado", "documentos es privado");
check(origenArchivo(publica("licitaciones", "bases/7/a.pdf"), BASE) === "storage_privado", "licitaciones es privado");
check(origenArchivo(publica("vehiculos-fotos", "foto.jpg"), BASE) === "storage_publico", "vehiculos-fotos es público");
check(origenArchivo("ftp://x/y.pdf", BASE) === "externo", "otro protocolo");

// ── 6. Rutas: misma identidad al escribir y al leer ───────────────────────────
sec("6. Rutas");
const uuid = "0b7c2a4e-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const r = rutaNueva("bases", 7, uuid, "pdf");
check(r === `bases/7/${uuid}.pdf`, "ruta de base");
check(RE_RUTA_BASE(7).test(r), "RE_RUTA_BASE casa con lo que escribe rutaNueva");
check(!RE_RUTA_BASE(8).test(r), "no casa con otra licitación");
check(!RE_RUTA_BASE(7).test(`bases/7/../8/${uuid}.pdf`), "sin ../");
const obj = objetoPrivadoDe(publica("licitaciones", r), BASE);
check(obj?.bucket === "licitaciones" && obj.ruta === r, "objetoPrivadoDe devuelve exactamente la ruta subida");
check(rutaNueva("experiencia", null, uuid, "PDF") === `experiencia/${uuid}.pdf`, "experiencia sin licId");
let lanzo = false; try { rutaNueva("bases", 7, "no-es-uuid", "pdf"); } catch { lanzo = true; }
check(lanzo, "uuid inválido lanza");
lanzo = false; try { rutaNueva("bases", 7, uuid, "exe"); } catch { lanzo = true; }
check(lanzo, "extensión no permitida lanza");
lanzo = false; try { rutaNueva("otra" as never, 7, uuid, "pdf"); } catch { lanzo = true; }
check(lanzo, "carpeta no permitida lanza");
check(CARPETAS_LICITACION.length === 6, "seis carpetas");
check(nombreArchivoEmitido("Sección II · Requisitos legales", "pdf") === "Seccion_II_Requisitos_legales.pdf", nombreArchivoEmitido("Sección II · Requisitos legales", "pdf"));
check(!nombreArchivoEmitido("../../etc/passwd", "pdf").includes(".."), "sin ..");
check(!nombreArchivoEmitido("a/b\\c", "zip").match(/[\\/]/), "sin separadores");
check(rutaEmision(7, uuid, "Propuesta.pdf") === `emisiones/7/${uuid}/Propuesta.pdf`, "ruta de emisión");
lanzo = false; try { rutaEmision(7, uuid, "../x.pdf"); } catch { lanzo = true; }
check(lanzo, "nombre con .. lanza");
check(mimeDeNombre("bases.PDF") === "application/pdf" && mimeDeNombre("foto.jpeg") === "image/jpeg" && mimeDeNombre("x.exe") === null, "mimeDeNombre");

// ── 7. canonico extraído ──────────────────────────────────────────────────────
sec("7. canonico");
const muestra = { b: 1, a: [3, { z: null, y: undefined, x: "ñ" }], c: { e: true, d: 2 } };
check(canonico(muestra) === '{"a":[3,{"x":"ñ","z":null}],"b":1,"c":{"d":2,"e":true}}', canonico(muestra));
// tsx puede cargar el módulo dos veces (ESM desde la matriz, CJS desde confirmacion-reserva): se compara la salida.
check(canonicoReserva(muestra) === canonico(muestra), "confirmacion-reserva re-exporta la misma regla");

// ── 8. Paginador estricto ─────────────────────────────────────────────────────
sec("8. todasLasPaginas lanza ante una página fallida");
const filas = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
const consulta = (falla: number | null) => () => ({
  range: async (a: number, b: number) => (falla !== null && a >= falla ? { data: null, error: { message: "timeout" } } : { data: filas.slice(a, b + 1), error: null }),
});
check((await todasLasPaginas(consulta(null))).length === 2500, "lee todo");
let error: unknown = null;
try { await todasLasPaginas(consulta(1000)); } catch (e) { error = e; }
check(error instanceof LecturaIncompleta, "una página fallida LANZA (no devuelve 1000 filas como si fueran todas)");
error = null;
try { await todasLasPaginas(consulta(null), { maxFilas: 2000 }); } catch (e) { error = e; }
check(error instanceof LecturaIncompleta, "pasar el tope lanza");

console.log(`\n${fallos === 0 ? "✓" : "✗"} ${ok} comprobaciones, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
