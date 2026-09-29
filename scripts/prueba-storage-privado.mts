// scripts/prueba-storage-privado.mts — Matriz de lib/storage-privado.ts y lib/storage-firmado.ts.
//   npx tsx scripts/prueba-storage-privado.mts
//
// Lo que fija, y por qué cada cosa:
//  1. IDA Y VUELTA con la librería REAL: el enlace que compuso `getPublicUrl` (storage-js, con su
//     `encodeURI`) devuelve EXACTAMENTE la ruta con la que se subió, también con espacios,
//     paréntesis, tildes y `%`. Si esto falla, se firma una ruta que no existe y la foto sale rota.
//  2. Lo que NO es de un bucket privado de ESTE proyecto contesta null y pasa tal cual: Drive,
//     `vehiculos-fotos`, `documentos-clientes` (el prefijo que casi se confunde), otro proyecto.
//  3. `firmarUrls`: una llamada por bucket y por lote, cada enlace recibido sale en el mapa, y si
//     firmar falla vuelve el ORIGINAL (nunca null) — con el bucket aún público ese sigue abriendo.

import { StorageClient } from "@supabase/storage-js";
import { objetoPrivadoDe, BUCKETS_PRIVADOS } from "../lib/storage-privado";
import { firmarUrls, firmarUrl } from "../lib/storage-firmado";

// La base se lee al LLAMAR (baseSupabase()), no al importar: basta con fijarla aquí.
const BASE = "https://qakhcezrmpksxgiwzmvd.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;

let ok = 0, fallos = 0;
const check = (cond: unknown, msg: string) => {
  if (cond) ok++; else { fallos++; console.log("  ✗", msg); }
};
const sec = (t: string) => console.log(`\n── ${t}`);

const storage = new StorageClient(`${BASE}/storage/v1`, {});
const publica = (bucket: string, ruta: string) => storage.from(bucket).getPublicUrl(ruta).data.publicUrl;

// ── 1. Ida y vuelta con getPublicUrl real ────────────────────────────────────
sec("1. getPublicUrl → objetoPrivadoDe devuelve la ruta exacta");
const RUTAS = [
  "1732000000000_SOAT 2026.pdf",
  "proveedores/12/3f2a-uuid.pdf",
  "planes-mantenimiento/1732000000000.pdf",
  "15/9b1c0e3e-uuid.jpg",
  "120363025@g.us/3EB0A1B2C3.jpg",
  "carpeta/Licencia (copia) final.pdf",
  "Póliza año 2026 ñandú.pdf",
  "100% pagado + IGV & otros.pdf",
  "a,b;c=d:e@f$g!h*i'j~k.pdf",
  "doble  espacio/y__guion-bajo.pdf",
];
for (const bucket of BUCKETS_PRIVADOS) {
  for (const ruta of RUTAS) {
    const url = publica(bucket, ruta);
    const o = objetoPrivadoDe(url, BASE);
    check(o?.bucket === bucket && o?.ruta === ruta, `${bucket} · «${ruta}» → ${JSON.stringify(o)} (url ${url})`);
  }
}

// ── 2. Lo que no es de un bucket privado de este proyecto ────────────────────
sec("2. null para todo lo demás");
const NO = [
  publica("vehiculos-fotos", "abc/foto.jpg"),
  publica("documentos-clientes", "c/contrato.pdf"),   // prefijo de "documentos": NO es el mismo bucket
  publica("redes-publicaciones", "x.jpg"),
  publica("documentos", "x.pdf").replace(BASE, "https://otroproyecto.supabase.co"),
  "https://drive.google.com/file/d/1AbC/view",
  "documentos/a.pdf",
  "/storage/v1/object/public/documentos/a.pdf",
  "",
  "   ",
  "javascript:alert(1)",
  "https://",
  `${BASE}/storage/v1/object/public/documentos/`,
  `${BASE}/storage/v1/object/public/documentos`,
];
for (const u of NO) check(objetoPrivadoDe(u, BASE) === null, `debió ser null: ${u}`);
for (const u of [null, undefined, 42, {}, []]) check(objetoPrivadoDe(u as unknown, BASE) === null, `debió ser null: ${String(u)}`);

// ── 3. Formas alternativas del mismo objeto ─────────────────────────────────
sec("3. Firmado guardado, query y fragmento");
{
  const firmadoViejo = `${BASE}/storage/v1/object/sign/radar-media/g/m.jpg?token=eyJ.vencido`;
  const o = objetoPrivadoDe(firmadoViejo, BASE);
  check(o?.bucket === "radar-media" && o?.ruta === "g/m.jpg", `el firmado viejo se re-firma: ${JSON.stringify(o)}`);
  const conQuery = publica("documentos", "a b.pdf") + "?download=a.pdf";
  check(objetoPrivadoDe(conQuery, BASE)?.ruta === "a b.pdf", "la query no es parte de la ruta");
  const conHash = publica("documentos", "a.pdf") + "#page=2";
  check(objetoPrivadoDe(conHash, BASE)?.ruta === "a.pdf", "el fragmento no es parte de la ruta");
  // Sin base no se compara el origen (solo pruebas); con base de otra forma (barra final) sí casa.
  check(objetoPrivadoDe(publica("documentos", "a.pdf"), `${BASE}/`)?.ruta === "a.pdf", "la barra final de la base no importa");
  check(objetoPrivadoDe(publica("documentos", "a.pdf").replace(BASE, "https://otro.supabase.co"))?.ruta === "a.pdf", "sin base se acepta cualquier origen");
}

// ── 4. firmarUrls con un cliente simulado ────────────────────────────────────
sec("4. firmarUrls: lotes, mapa exhaustivo y el original como respaldo");
type Llamada = { bucket: string; paths: string[]; ttl: number };
const cliente = (opts: { falla?: string; sinPath?: boolean; errorItem?: string } = {}) => {
  const llamadas: Llamada[] = [];
  return {
    llamadas,
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrls(paths: string[], ttl: number) {
            llamadas.push({ bucket, paths, ttl });
            if (opts.falla === bucket) return { data: null, error: new Error("sin política") };
            return {
              data: paths.map((p) => ({
                path: opts.sinPath ? null : p,
                signedUrl: p === opts.errorItem ? null : `${BASE}/storage/v1/object/sign/${bucket}/${p}?token=T`,
                error: p === opts.errorItem ? "not found" : null,
              })),
              error: null,
            };
          },
        };
      },
    },
  };
};

{
  const docs = RUTAS.map((r) => publica("documentos", r));
  const radar = ["g/1.jpg", "g/2.jpg"].map((r) => publica("radar-media", r));
  const otros = ["https://drive.google.com/x", publica("vehiculos-fotos", "v.jpg")];
  const c = cliente();
  const mapa = await firmarUrls(c, [...docs, ...radar, ...otros, null, undefined, "", docs[0]], 3600);
  check(c.llamadas.length === 2, `una llamada por bucket (hubo ${c.llamadas.length})`);
  check(c.llamadas.every((l) => l.ttl === 3600), "el TTL viaja");
  const pDocs = c.llamadas.find((l) => l.bucket === "documentos")?.paths ?? [];
  check(JSON.stringify(pDocs) === JSON.stringify(RUTAS), "a la API van las rutas DECODIFICADAS, una vez cada una");
  for (const u of [...docs, ...radar, ...otros]) check(mapa.has(u), `el mapa trae cada enlace: ${u}`);
  for (const u of docs) check(mapa.get(u)!.includes("/object/sign/documentos/"), `privado → firmado: ${u}`);
  for (const u of otros) check(mapa.get(u) === u, `lo público pasa igual: ${u}`);
  check(!mapa.has("") && !mapa.has(null as never), "los vacíos no entran");
}
{
  // Más de 100 rutas en un bucket: se parte en lotes.
  const muchas = Array.from({ length: 250 }, (_, i) => publica("pasajeros-fotos", `${i}/f.jpg`));
  const c = cliente();
  const mapa = await firmarUrls(c, muchas);
  check(c.llamadas.length === 3 && c.llamadas.map((l) => l.paths.length).join() === "100,100,50", `lotes de 100: ${c.llamadas.map((l) => l.paths.length)}`);
  check(muchas.every((u) => mapa.get(u)!.includes("/object/sign/")), "los 250 salen firmados");
}
{
  // Si la firma del bucket falla (el SQL aún no se corrió), vuelve el ORIGINAL.
  const u = publica("radar-media", "g/1.jpg");
  const c = cliente({ falla: "radar-media" });
  const mapa = await firmarUrls(c, [u, publica("documentos", "a.pdf")]);
  check(mapa.get(u) === u, "fallo del bucket → original");
  check(mapa.get(publica("documentos", "a.pdf"))!.includes("/object/sign/"), "un bucket que falla no tumba al otro");
}
{
  // Un archivo que ya no existe: ese vuelve original, el resto firmado.
  const a = publica("documentos", "existe.pdf"), b = publica("documentos", "borrado.pdf");
  const mapa = await firmarUrls(cliente({ errorItem: "borrado.pdf" }), [a, b]);
  check(mapa.get(a)!.includes("/object/sign/") && mapa.get(b) === b, "error por archivo → ese original");
}
{
  // La API no devuelve `path`: se casa por posición.
  const a = publica("documentos", "uno.pdf"), b = publica("documentos", "dos.pdf");
  const mapa = await firmarUrls(cliente({ sinPath: true }), [a, b]);
  check(mapa.get(a)!.endsWith("/uno.pdf?token=T") && mapa.get(b)!.endsWith("/dos.pdf?token=T"), "sin path, por posición");
}
{
  // Un cliente que LANZA (red caída) no rompe: todo vuelve original.
  const lanza = { storage: { from() { return { async createSignedUrls(): Promise<never> { throw new Error("red"); } }; } } };
  const u = publica("documentos", "a.pdf");
  check((await firmarUrls(lanza, [u])).get(u) === u, "excepción → original");
  check((await firmarUrl(lanza, u)) === u, "firmarUrl con excepción → original");
  check((await firmarUrl(lanza, null)) === null && (await firmarUrl(lanza, undefined)) === null, "firmarUrl(null) → null");
}

console.log(`\n${fallos ? "✗" : "✓"} ${ok} comprobaciones OK, ${fallos} fallos`);
if (fallos) process.exit(1);
