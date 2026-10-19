// npx tsx scripts/prueba-nomina-envio.mts — el envío masivo de la nómina se acota por fecha de alta.
import { fechaLimaDeTs, rangoDePeriodo, filtrarPorAlta } from "../lib/nomina-envio";

let fallos = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else console.log("✓", m); };

// Hora de Lima: 18/10 a las 20:30 Lima es 19/10 01:30 UTC.
ok(fechaLimaDeTs("2026-10-19T01:30:00Z") === "2026-10-18", "un alta de las 20:30 de Lima cuenta en su día de Lima");
ok(fechaLimaDeTs("basura") === null, "fecha inválida → null");

const hoy = "2026-10-18";
const r7 = rangoDePeriodo("7d", hoy);
ok(JSON.stringify(r7) === JSON.stringify({ desde: "2026-10-12", hasta: "2026-10-18" }), "7 días incluye hoy y 6 atrás");
const rm = rangoDePeriodo("mes", "2026-03-05");
ok(JSON.stringify(rm) === JSON.stringify({ desde: "2026-03-01", hasta: "2026-03-05" }), "este mes desde el día 1");
ok(JSON.stringify(rangoDePeriodo("30d", "2026-03-01")) === JSON.stringify({ desde: "2026-01-31", hasta: "2026-03-01" }), "30 días cruza meses");
ok("invalido" in rangoDePeriodo("rango", hoy, "2026-10-10"), "rango incompleto es inválido");
ok("invalido" in rangoDePeriodo("rango", hoy, "2026-10-12", "2026-10-01"), "rango al revés es inválido");

const nomina = [
  { id: 1, created_at: "2026-10-18T15:00:00Z" },
  { id: 2, created_at: "2026-10-12T04:59:00Z" }, // 11/10 23:59 Lima → fuera de 7 días
  { id: 3, created_at: "2026-10-12T05:00:00Z" }, // 12/10 00:00 Lima → dentro
  { id: 4, created_at: null },
  { id: 5, created_at: "2025-01-01T12:00:00Z" },
];
const ids = (r: any) => filtrarPorAlta(nomina, r).map(p => p.id).join(",");
ok(ids(r7) === "1,3", "7 días: borde exacto en hora de Lima, y sin fecha no entra");
ok(ids({ desde: null, hasta: null }) === "1,2,3,4,5", "todos incluye a los que no tienen fecha");
ok(ids({ desde: "2026-10-12", hasta: "2026-10-12" }) === "3", "rango de un día");

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
