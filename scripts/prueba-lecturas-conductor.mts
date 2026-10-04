// Matriz: consejo de foto, cotejo odómetro↔GPS y ranking por conductor.
// Ejecutar: npx tsx scripts/prueba-lecturas-conductor.mts
import { consejoFoto, cotejarOdometroGps, conductorDeIdemKey, rankingConductores } from "../lib/odometro-confirmacion";

let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fallos++; };

// Consejo de foto: solo cuando la foto salió mal.
ok(consejoFoto({ calidad: "buena", confianza: "alta", motivo: "lectura nítida" }) === null, "foto buena → no se muestra nada");
const c1 = consejoFoto({ calidad: "regular", confianza: "media", motivo: "reflejo rojo sobre el último dígito" });
ok(!!c1 && c1.consejos.length === 1 && /reflejo/i.test(c1.consejos[0]), "reflejo → el consejo del reflejo, y solo ese");
const c2 = consejoFoto({ calidad: "mala", confianza: "baja", motivo: "" });
ok(!!c2 && c2.consejos.length === 2 && c2.titulo === "La foto no se ve clara", "sin motivo reconocible → los dos consejos más comunes");
const c3 = consejoFoto({ calidad: "mala", confianza: "baja", motivo: "borrosa", repetido: true });
ok(!!c3 && c3.consejos.length >= 4, "fallos repetidos → lista completa");

// Odómetro ↔ GPS.
ok(cotejarOdometroGps({ odoDia: 40, gpsKm: 210, medidoPct: 80 }).codigo === "odometro_corto", "odómetro 40 vs GPS 210 → odómetro corto (imposible)");
ok(cotejarOdometroGps({ odoDia: 15_521_773, gpsKm: 120, medidoPct: 80 }).codigo === "odometro_largo", "15.7 millones vs GPS 120 → odómetro largo");
ok(cotejarOdometroGps({ odoDia: 230, gpsKm: 210, medidoPct: 80 }).codigo === "coincide", "230 vs 210 → coincide");
ok(cotejarOdometroGps({ odoDia: 300, gpsKm: 120, medidoPct: 80 }).codigo === "coincide", "300 vs 120 (vacíos entre servicios) → no se acusa");
ok(cotejarOdometroGps({ odoDia: 40, gpsKm: 210, medidoPct: 30 }).codigo === "sin_gps", "GPS medido al 30 % → no se juzga");
ok(cotejarOdometroGps({ odoDia: null, gpsKm: 210, medidoPct: 90 }).codigo === "sin_odometro", "sin check-in → no se juzga");
ok(cotejarOdometroGps({ odoDia: 190, gpsKm: 210, medidoPct: 90 }).codigo === "coincide", "190 vs 210 (GPS suaviza curvas, dentro del 15 %) → coincide");

// Conductor desde la idem_key con la que escribe el route.
ok(JSON.stringify(conductorDeIdemKey("checkout:p:12:2026-10-02:57")) === JSON.stringify({ momento: "checkout", flotaVehiculo: "propia", conductorId: 57 }), "lee la clave del check-out");
ok(conductorDeIdemKey("radar_odo:abc") === null, "una lectura del Radar no es de la app");
ok(conductorDeIdemKey(null) === null, "sin clave → null");

// Ranking.
const lect = [
  ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, idem_key: `checkin:p:1:2026-09-${String(i + 1).padStart(2, "0")}:7`, estado: i < 3 ? "anulada" : "aceptada" })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, idem_key: `checkin:p:2:2026-09-${String(i + 1).padStart(2, "0")}:8`, estado: i === 0 ? "sospechosa" : "aceptada" })),
  { id: "c0", idem_key: "checkin:p:3:2026-09-01:9", estado: "anulada" },
  { id: "d0", idem_key: "radar_odo:x", estado: "anulada" },
];
const corr = [{ lectura_id: "a0", motivo_tipo: "ia_digito" }, { lectura_id: "a1", motivo_tipo: "tipeo" }, { lectura_id: "a2", motivo_tipo: "duplicada" }, { lectura_id: "c0", motivo_tipo: "tipeo" }];
const r = rankingConductores(lect, corr);
ok(r[0].conductorId === 7 && r[0].corregidas === 2, "conductor 7: 2 corregidas (la duplicada no cuenta) y va primero");
ok(r[1].conductorId === 8 && r[1].porRevisar === 1, "conductor 8: 1 por revisar, segundo");
ok(r[r.length - 1].conductorId === 9 && r[r.length - 1].poca, "conductor 9 con 1 lectura: al final, marcado como poca muestra");
ok(!r.some(f => f.conductorId === 0), "las lecturas del Radar no se atribuyen a nadie");

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
