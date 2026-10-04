// Matriz: la jornada con un salto imposible NOMBRA la lectura que lo causa.
// Caso real: CWZ-371 · 12/09/2026 · 17,758 (05:31) … 24,484 (17:02) = 6,726 km "Revisar"
// sin decir cuál de las cinco lecturas era la mala, y con su foto fuera de las miniaturas.
// Ejecutar: npx tsx scripts/prueba-jornada-salto.mts
import { analizarVehiculo, type LecturaCruda } from "../lib/odometro-analitica.ts";

let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fallos++; };

const lec = (id: string, fecha: string, hora: string, km: number, estado = "aceptada"): LecturaCruda => ({
  id, vehiculo_id: 1, km, fuente: "whatsapp_foto", fecha, estado,
  created_at: `${fecha}T${hora}:00-05:00`, capturado_en: `${fecha}T${hora}:00-05:00`, foto_url: `https://x/${id}.jpg`,
});

// Historial normal (~90 km/día) + la jornada del 12/09 con el salto en la ÚLTIMA lectura.
const base: LecturaCruda[] = [];
let km = 17_152;
for (let d = 5; d <= 11; d++) {
  const f = `2026-09-${String(d).padStart(2, "0")}`;
  base.push(lec(`a${d}`, f, "05:30", km));
  km += 90;
  base.push(lec(`c${d}`, f, "17:00", km));
}
const ini = km;
const dia12 = [
  lec("m1", "2026-09-12", "05:31", ini),
  lec("m2", "2026-09-12", "09:00", ini + 20),
  lec("m3", "2026-09-12", "12:00", ini + 50),
  lec("m4", "2026-09-12", "15:00", ini + 70),
  lec("m5", "2026-09-12", "17:02", 24_484),
];

{
  const { dias } = analizarVehiculo([...base, ...dia12]);
  const d = dias.find(x => x.fecha === "2026-09-12")!;
  ok(d.lecturas.length === 5, "la jornada conserva sus 5 lecturas (todas se pueden mostrar)");
  ok(d.sospechosaId === "m5", "señala la lectura que CIERRA el salto (17:02, 24,484 km)");
  const a = d.anomalias.filter(x => x.tipo === "excesivo");
  ok(a.length === 1 && a[0].severidad === "critico", "un solo rojo por el mismo hecho (no se duplica con 'fuera del patrón')");
  ok(/24,484|24\.484/.test(a[0].mensaje) && /17:02/.test(a[0].mensaje), "el mensaje nombra el km y la hora de la lectura mala");
}

// Lado que no se puede aflojar: un día largo legítimo, por debajo del tope, no señala a nadie.
{
  const largo = [lec("l1", "2026-09-12", "05:00", ini), lec("l2", "2026-09-12", "21:00", ini + 900)];
  const { dias } = analizarVehiculo([...base, ...largo]);
  const d = dias.find(x => x.fecha === "2026-09-12")!;
  ok(d.sospechosaId === null, "900 km en el día (bajo el tope de 1500) no se acusa como salto imposible");
}

// El tope configurado manda.
{
  const largo = [lec("l1", "2026-09-12", "05:00", ini), lec("l2", "2026-09-12", "21:00", ini + 900)];
  const { dias } = analizarVehiculo([...base, ...largo], { kmDiaMax: 800 });
  ok(dias.find(x => x.fecha === "2026-09-12")!.sospechosaId === "l2", "con km_dia_max = 800, el mismo salto sí se señala");
}

// Reinicio de tablero: el salto no significa nada.
{
  const r = [lec("r1", "2026-09-12", "05:00", ini), lec("r2", "2026-09-12", "10:00", 50, "reinicio"), lec("r3", "2026-09-12", "17:00", 9_000)];
  const { dias } = analizarVehiculo([...base, ...r]);
  ok(dias.find(x => x.fecha === "2026-09-12")!.sospechosaId === null, "con reinicio de tablero no se acusa salto");
}

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
