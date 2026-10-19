// Matriz de lib/tipo-cambio-sunat.ts (el parseo) — npx tsx scripts/prueba-tipo-cambio-sunat.mts
// Las dos respuestas son las reales del 19-10-2026.
import { parsearJsonApisNet, parsearTxtSunat, revisarParaGuardar } from "../lib/tipo-cambio-sunat";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };

const t = parsearTxtSunat("19/10/2026|3.423|3.431|\n");
ok(t?.fecha === "2026-10-19" && t.compra === 3.423 && t.venta === 3.431, "la línea de SUNAT");
ok(parsearTxtSunat("<html><head><title>Request Rejected</title>") === null, "la página de rechazo del firewall no es un tipo de cambio");
ok(parsearTxtSunat("19/10/2026|342.3|343.1|") === null, "un TC sin punto decimal se rechaza");
ok(parsearTxtSunat("") === null, "vacío");
ok(parsearTxtSunat("31/02/2026|3.4|3.5|") === null, "una fecha que no existe se rechaza");
const j = parsearJsonApisNet({ origen: "SUNAT", compra: 3.423, venta: 3.431, moneda: "USD", fecha: "2026-10-19" });
ok(j?.fecha === "2026-10-19" && j.venta === 3.431, "apis.net.pe v1");
ok(parsearJsonApisNet({ error: "Apikey Required / Falta de token" }) === null, "la respuesta de error de la v2");
ok(parsearJsonApisNet(null) === null, "null");

// Qué se guarda: ni fechas futuras ni viejas; el respaldo no puede saltar más de 3 %.
const hoy = "2026-10-19";
const sunat = { fecha: hoy, compra: 3.42, venta: 3.431, fuente: "SUNAT" };
const resp = { ...sunat, fuente: "SUNAT (apis.net.pe)" };
ok(revisarParaGuardar(sunat, hoy, { venta: 3.43 }).ok, "SUNAT del día se guarda");
ok(!revisarParaGuardar({ ...sunat, fecha: "2026-10-20" }, hoy, null).ok, "una fecha de mañana no se guarda");
ok(!revisarParaGuardar({ ...sunat, fecha: "2026-10-11" }, hoy, null).ok, "una de hace 8 días no se guarda");
ok(revisarParaGuardar({ ...sunat, fecha: "2026-10-12" }, hoy, null).ok, "una de hace 7 días sí (fin de semana largo)");
ok(revisarParaGuardar(resp, hoy, { venta: 3.40 }).ok, "el respaldo con 0.9 % de diferencia se guarda");
ok(!revisarParaGuardar({ ...resp, venta: 3.78 }, hoy, { venta: 3.431 }).ok, "el respaldo con 10 % de salto no se guarda");
ok(revisarParaGuardar({ ...sunat, venta: 3.78 }, hoy, { venta: 3.431 }).ok, "SUNAT, la fuente oficial, no se frena por el salto");
ok(revisarParaGuardar(resp, hoy, null).ok, "sin historial, el respaldo se guarda");

console.log(`\n${oks} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
