import * as XLSX from "xlsx";
import { leerZip } from "../lib/licitaciones/docx/zip-lectura";
const CFB: any = (XLSX as any).CFB;
const z = CFB.utils.cfb_new(); CFB.utils.cfb_add(z, "x.txt", new TextEncoder().encode("b".repeat(1024 * 1024)));
const o = CFB.write(z, { fileType: "zip", type: "array", compression: true });
const m = new Uint8Array(o.buffer, o.byteOffset, o.byteLength).slice();
const dv = new DataView(m.buffer);
let e = m.length - 22; while (dv.getUint32(e, true) !== 0x06054b50) e--;
const cd = dv.getUint32(e + 16, true); const local = dv.getUint32(cd + 42, true);
dv.setUint32(cd + 24, 1000, true); dv.setUint32(local + 22, 1000, true);
try { const r = leerZip(m); console.log("acotada:", r.get("x.txt")?.length); } catch (err: any) { console.log("rechazada:", err.codigo, err.message); }
