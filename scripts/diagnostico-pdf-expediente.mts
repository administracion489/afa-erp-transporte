// scripts/diagnostico-pdf-expediente.mts — ¿Qué archivos de una carpeta se pueden UNIR al expediente?
//   npx tsx scripts/diagnostico-pdf-expediente.mts <carpeta>
//
// SOLO LEE archivos locales (no toca la base ni la red, no escribe nada). Por cada archivo de la carpeta
// (sin entrar en subcarpetas) dice qué es por su FIRMA (PDF · PNG · JPEG · otro), su peso y, si es PDF,
// lo que dirá la emisión con el MISMO `revisarPdf` de lib/licitaciones/pdf/expediente.ts: cifrado
// (pdf_protegido, se omite — R11), ilegible (pdf_ilegible, se omite) o cuántas páginas aporta. Una imagen
// aporta UNA página; de un JPEG se dice además su orientación EXIF (si no es 1, sale girada en el PDF).

import * as fs from "node:fs";
import * as path from "node:path";
import { revisarPdf, formatoDeBytes, orientacionJpeg, declaraCifrado } from "../lib/licitaciones/pdf/expediente";

const carpeta = process.argv[2];
if (!carpeta || !fs.existsSync(carpeta) || !fs.statSync(carpeta).isDirectory()) {
  console.error("Uso: npx tsx scripts/diagnostico-pdf-expediente.mts <carpeta>");
  process.exit(2);
}

const peso = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);
const archivos = fs.readdirSync(carpeta).filter((n) => fs.statSync(path.join(carpeta, n)).isFile()).sort();
type Fila = { archivo: string; tipo: string; peso: string; estado: string; paginas: string; ms: string };
const filas: Fila[] = [];
let unibles = 0, paginasTotal = 0, bytesTotal = 0, protegidos = 0, ilegibles = 0, otros = 0;

for (const nombre of archivos) {
  const ruta = path.join(carpeta, nombre);
  const b = new Uint8Array(fs.readFileSync(ruta));
  bytesTotal += b.length;
  const fmt = formatoDeBytes(b);
  const t0 = Date.now();
  if (fmt === "pdf") {
    const r = await revisarPdf(b);
    const ms = `${Date.now() - t0}`;
    if (r.ok) {
      unibles++; paginasTotal += r.paginas;
      filas.push({ archivo: nombre, tipo: "PDF", peso: peso(b.length), estado: "se puede unir", paginas: String(r.paginas), ms });
    } else {
      if (r.codigo === "pdf_protegido") protegidos++; else ilegibles++;
      filas.push({ archivo: nombre, tipo: "PDF", peso: peso(b.length), estado: `${r.codigo === "pdf_protegido" ? "CIFRADO" : "ILEGIBLE"} (${r.codigo}) — ${r.detalle}${declaraCifrado(b) ? " [trailer con /Encrypt]" : ""}`, paginas: "—", ms });
    }
  } else if (fmt === "png" || fmt === "jpg") {
    unibles++; paginasTotal += 1;
    const o = fmt === "jpg" ? orientacionJpeg(b) : 1;
    filas.push({ archivo: nombre, tipo: fmt.toUpperCase(), peso: peso(b.length), estado: `se puede unir (una página${o !== 1 ? `, EXIF ${o}: se gira` : ""})`, paginas: "1", ms: `${Date.now() - t0}` });
  } else {
    otros++;
    filas.push({ archivo: nombre, tipo: "otro", peso: peso(b.length), estado: "no se une (ni PDF, ni PNG, ni JPEG: archivo_formato_no_soportado)", paginas: "—", ms: "—" });
  }
}

console.log(`\nCarpeta: ${carpeta} · ${archivos.length} archivo(s) · ${peso(bytesTotal)}\n`);
for (const f of filas) {
  console.log(`• ${f.archivo}`);
  console.log(`    ${f.tipo} · ${f.peso} · páginas: ${f.paginas} · leído en ${f.ms} ms`);
  console.log(`    ${f.estado}`);
}
console.log(`\nSe pueden unir: ${unibles} (${paginasTotal} página(s)) · cifrados: ${protegidos} · ilegibles: ${ilegibles} · otros formatos: ${otros}`);
