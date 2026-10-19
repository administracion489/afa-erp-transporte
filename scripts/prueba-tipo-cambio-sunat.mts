// Matriz de lib/tipo-cambio-sunat.ts (el parseo) — npx tsx scripts/prueba-tipo-cambio-sunat.mts
// Las dos respuestas son las reales del 19-10-2026.
import { parsearJsonApisNet, parsearTxtSunat } from "../lib/tipo-cambio-sunat";

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

console.log(`\n${oks} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
