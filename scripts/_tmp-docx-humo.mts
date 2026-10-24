import { readFileSync } from "node:fs";
import { importarDocx } from "../lib/licitaciones/docx/importar";
const b = readFileSync(process.argv[2]);
let n = 0;
const t0 = Date.now();
const r = importarDocx(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), { nuevoId: () => `id${++n}` });
console.log("ms", Date.now() - t0);
if (!r.ok) { console.log(r); process.exit(1); }
for (const [i, s] of r.secciones.entries()) {
  const c: Record<string, number> = {};
  for (const bl of s.bloques) c[bl.tipo] = (c[bl.tipo] ?? 0) + 1;
  console.log(i + 1, s.titulo, JSON.stringify(c));
}
console.log(JSON.stringify(r.preliminares, null, 1).slice(0, 4000));
console.log(r.avisos);
console.log(r.imagenes.map((x) => [x.clave, x.ruta, x.mime, x.bytes.length, x.anchoEmu]));
console.log(r.pendientes);
console.log("conFirma", r.preliminares.carta?.conFirma, "resto", JSON.stringify(r.preliminares.resto));
for (const s of r.secciones) for (const bl of s.bloques) {
  if (bl.tipo === "imagen") console.log("IMG", s.titulo.slice(0, 20), bl.anchoPct, bl.pie);
}
const s6 = r.secciones[5];
for (const bl of s6.bloques.slice(0, 40)) console.log(bl.tipo, JSON.stringify(bl).slice(0, 220));
const s1 = r.secciones[0];
for (const bl of s1.bloques) console.log(bl.tipo, JSON.stringify(bl).slice(0, 400));
