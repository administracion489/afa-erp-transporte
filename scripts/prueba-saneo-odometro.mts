// Matriz del saneamiento del odómetro (lib/odometro-analitica.ts → sanearLecturas).
// NO toca la base. Uso:  npx tsx scripts/prueba-saneo-odometro.mts   (exit 1 si algo falla)
//
// El caso (06/10/2026): /mantenimiento → Odómetro → Recorrido por jornada, CWZ-371 del 01/10 al
// 06/10 → «Sin jornadas en el filtro», con la unidad leyendo odómetro cada día (19,814 km el 06/10
// en el Radar, «Registrada»). Una lectura ACEPTADA de 24,484 km del 12/09 (foto de otra unidad)
// quedó como base del trinquete y todo lo posterior salió como «retroceso».
//
// Lo que no se puede aflojar:
//   1. El algoritmo VIEJO (copiado literal) reproduce el bug: si deja de hacerlo, el escenario
//      dejó de ser el que se rompió.
//   2. Cuando el trinquete viejo ya daba la cadena más larga, el resultado nuevo es IDÉNTICO:
//      mismas lecturas, mismos motivos, mismo texto. El cambio solo actúa donde el viejo perdía.
//   3. Un retroceso de verdad (una lectura baja suelta) sigue saliendo como retroceso.
//   4. Ninguna lectura se pierde ni se duplica, y la secuencia conservada no baja nunca.

import { sanearLecturas, analizarVehiculo, hoyLima, type LecturaCruda, type Descartada } from "../lib/odometro-analitica";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const lec = (id: string, fecha: string, hora: string, km: number, estado = "aceptada"): LecturaCruda => ({
  id, vehiculo_id: 1, km, fuente: "whatsapp_foto", fecha, estado,
  created_at: `${fecha}T${hora}:00-05:00`, capturado_en: `${fecha}T${hora}:00-05:00`, foto_url: `https://x/${id}.jpg`,
});

// ── El trinquete VIEJO, copiado literal (solo la parte de la secuencia) ──────────────────────
function viejo(lecturas: LecturaCruda[]): { limpias: string[]; descartadas: { id: string; motivo: string; detalle: string }[] } {
  // Mismo orden que el nuevo: se comparan secuencias, no la función de orden.
  const ordenadas = [...lecturas].sort((a, b) => (a.fecha !== b.fecha ? (a.fecha < b.fecha ? -1 : 1) : new Date(a.capturado_en!).getTime() - new Date(b.capturado_en!).getTime()));
  const limpias: string[] = [];
  const descartadas: { id: string; motivo: string; detalle: string }[] = [];
  let base = 0;
  const hoy = hoyLima();
  for (const l of ordenadas) {
    const km = Number(l.km);
    if (l.estado === "rechazada" || l.estado === "anulada") { descartadas.push({ id: l.id, motivo: "rechazada", detalle: l.estado === "anulada" ? "Lectura anulada" : "Lectura rechazada" }); continue; }
    if (!Number.isFinite(km) || km <= 0) { descartadas.push({ id: l.id, motivo: "invalida", detalle: "Kilometraje inválido o ≤ 0" }); continue; }
    if (km > 3_000_000) { descartadas.push({ id: l.id, motivo: "absurda", detalle: `Valor absurdo: ${km.toLocaleString("es-PE")} km` }); continue; }
    if (l.fecha > hoy) { descartadas.push({ id: l.id, motivo: "invalida", detalle: `Fecha futura (${l.fecha}) — revisar reloj del dispositivo` }); continue; }
    if (l.estado === "reinicio") { base = km; limpias.push(l.id); continue; }
    if (l.estado !== "aceptada") { descartadas.push({ id: l.id, motivo: "no_aceptada", detalle: "Pendiente de revisión (no aceptada)" }); continue; }
    if (base > 0 && km < base) { descartadas.push({ id: l.id, motivo: "retrocede", detalle: `Retrocede: ${km.toLocaleString("es-PE")} < ${base.toLocaleString("es-PE")}` }); continue; }
    limpias.push(l.id);
    if (km > base) base = km;
  }
  return { limpias, descartadas };
}
const nuevo = (ls: LecturaCruda[]) => {
  const r = sanearLecturas(ls);
  return { limpias: r.limpias.map((l) => l.id), descartadas: r.descartadas.map((d: Descartada) => ({ id: d.lectura.id, motivo: d.motivo, detalle: d.detalle })) };
};

// ── El caso CWZ-371 ─────────────────────────────────────────────────────────────────────────
// ~90 km/día del 01/09 al 06/10, dos lecturas por día; el 12/09 a las 17:02 entra 24,484 km.
const dias = (desde: string, n: number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${desde}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10);
});
const cwz: LecturaCruda[] = [];
let km = 16_400;
for (const f of dias("2026-09-01", 36)) {
  cwz.push(lec(`a${f}`, f, "05:30", km));
  km += 90;
  cwz.push(lec(`c${f}`, f, "17:00", km));
  if (f === "2026-09-12") cwz.push(lec("malo", f, "17:02", 24_484));
}

console.log("\n1 · El caso CWZ-371: una lectura alta aceptada borraba todo lo que venía después");
{
  const v = viejo(cwz);
  const despuesV = v.limpias.filter((id) => /^[ac]\d/.test(id) && id.slice(1) > "2026-09-12");
  chk("el algoritmo VIEJO reproduce el bug: ninguna lectura después del 12/09", despuesV.length === 0, `${despuesV.length} conservadas`);
  chk("…y el 24,484 quedaba como base", v.limpias.includes("malo"));

  const { dias: jornadas, descartadas } = analizarVehiculo(cwz);
  const oct = jornadas.filter((d) => d.fecha >= "2026-10-01" && d.fecha <= "2026-10-06");
  chk("ahora del 01/10 al 06/10 salen las 6 jornadas", oct.length === 6, `${oct.length}`);
  chk("cada una con su recorrido de 90 km", oct.every((d) => d.recorrido === 90));
  const malo = descartadas.find((d) => d.lectura.id === "malo");
  chk("la lectura de 24,484 queda FUERA como «no_encaja»", malo?.motivo === "no_encaja");
  chk("su detalle nombra el km y la siguiente lectura", !!malo && /24,484|24\.484/.test(malo.detalle) && /13\/09\/2026/.test(malo.detalle), malo?.detalle);
  chk("ninguna lectura buena sale como retroceso", !descartadas.some((d) => d.motivo === "retrocede"));
  const d12 = jornadas.find((d) => d.fecha === "2026-09-12")!;
  chk("el 12/09 la lleva colgada para poder corregirla", d12.fueraDeSecuencia.some((l) => l.id === "malo"));
  chk("…con un rojo que la nombra", d12.anomalias.some((a) => a.tipo === "no_encaja" && a.severidad === "critico"));
  chk("…y su recorrido es el de verdad (90 km), no el salto", d12.recorrido === 90 && d12.sospechosaId === null);
}

console.log("\n2 · Lo que no se puede aflojar");
{
  // Un retroceso suelto de verdad: 100, 200, 150, 300 → el 150 sigue siendo retroceso.
  const r = nuevo([lec("a", "2026-09-01", "05:00", 100), lec("b", "2026-09-01", "10:00", 200), lec("c", "2026-09-01", "12:00", 150), lec("d", "2026-09-01", "17:00", 300)]);
  chk("una lectura baja suelta sigue saliendo como retroceso", r.descartadas.length === 1 && r.descartadas[0].id === "c" && r.descartadas[0].motivo === "retrocede", JSON.stringify(r.descartadas));
  chk("…con el texto de siempre", r.descartadas[0]?.detalle === `Retrocede: ${(150).toLocaleString("es-PE")} < ${(200).toLocaleString("es-PE")}`);

  // La lectura alta al FINAL no tiene nada que la contradiga: se conserva (como antes) y la
  // jornada la señala como salto imposible (prueba-jornada-salto.mts).
  const fin = [...cwz.filter((l) => l.fecha <= "2026-09-12")];
  const rf = nuevo(fin);
  chk("la alta del final sin lecturas después se conserva, como antes", rf.limpias.includes("malo") && JSON.stringify(rf) === JSON.stringify(viejo(fin)));

  // Dos lecturas altas seguidas (el mismo error enviado dos veces) también salen.
  const doble = [...cwz, lec("malo2", "2026-09-13", "05:10", 24_490)];
  const rd = sanearLecturas(doble);
  chk("dos lecturas altas seguidas salen las dos como no_encaja",
    ["malo", "malo2"].every((id) => rd.descartadas.find((d) => d.lectura.id === id)?.motivo === "no_encaja"));

  // Reinicio de tablero: re-ancla aunque sea menor, como antes.
  const ri = [lec("a", "2026-09-01", "05:00", 150_000), lec("b", "2026-09-01", "10:00", 150_050), lec("r", "2026-09-02", "05:00", 10, "reinicio"), lec("c", "2026-09-02", "10:00", 60), lec("d", "2026-09-02", "17:00", 140)];
  const rr = nuevo(ri);
  chk("un reinicio re-ancla la secuencia aunque baje", JSON.stringify(rr) === JSON.stringify(viejo(ri)) && rr.limpias.length === 5);

  // Las anuladas no entran nunca (la forma de arreglar la base de datos sigue siendo anularla).
  const anulada = cwz.map((l) => (l.id === "malo" ? { ...l, estado: "anulada" } : l));
  const ra = nuevo(anulada);
  chk("con la mala ANULADA el resultado es el del trinquete viejo", JSON.stringify(ra) === JSON.stringify(viejo(anulada)));
}

console.log("\n3 · Barrido: idéntico al viejo donde el viejo era óptimo; nada se pierde; nada baja");
{
  // Generador determinista.
  let semilla = 7;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
  let casos = 0, identicos = 0, mejores = 0, compatMal = 0, perdidas = 0, bajan = 0, peores = 0, clasMal = 0;
  for (let c = 0; c < 4000; c++) {
    const n = 2 + Math.floor(azar() * 14);
    const ls: LecturaCruda[] = [];
    let k = 10_000 + Math.floor(azar() * 1000);
    for (let i = 0; i < n; i++) {
      const f = `2026-09-${String(1 + Math.floor(i / 2)).padStart(2, "0")}`;
      const hora = i % 2 ? "17:00" : "05:00";
      const r = azar();
      let valor = k;
      let estado = "aceptada";
      if (r < 0.12) valor = k + 5_000 + Math.floor(azar() * 9000);      // alta equivocada
      else if (r < 0.22) valor = Math.max(1, k - 50 - Math.floor(azar() * 500)); // baja equivocada
      else if (r < 0.26) { estado = "reinicio"; k = 5 + Math.floor(azar() * 100); valor = k; }
      else if (r < 0.30) estado = "sospechosa";
      else if (r < 0.33) estado = "anulada";
      else { k += Math.floor(azar() * 150); valor = k; }
      ls.push(lec(`L${i}`, f, hora, valor, estado));
    }
    casos++;
    const v = viejo(ls), nw = nuevo(ls);
    // Mismo largo → idéntico en todo.
    if (nw.limpias.length === v.limpias.length) {
      if (JSON.stringify(nw) === JSON.stringify(v)) identicos++; else compatMal++;
    } else if (nw.limpias.length > v.limpias.length) mejores++;
    else peores++;
    // Nada se pierde ni se duplica.
    const ids = [...nw.limpias, ...nw.descartadas.map((d) => d.id)];
    if (ids.length !== ls.length || new Set(ids).size !== ls.length) perdidas++;
    // La secuencia conservada no baja salvo en un reinicio.
    const san = sanearLecturas(ls).limpias;
    for (let i = 1; i < san.length; i++) if (!san[i].esReinicio && Number(san[i].km) < Number(san[i - 1].km)) { bajan++; break; }
    // Cada no_encaja es MAYOR que alguna conservada posterior del mismo tramo; cada retrocede, menor que una anterior.
    const conservadas = new Set(nw.limpias);
    const orden = [...ls].sort((a, b) => (a.fecha !== b.fecha ? (a.fecha < b.fecha ? -1 : 1) : new Date(a.capturado_en!).getTime() - new Date(b.capturado_en!).getTime()));
    for (const d of sanearLecturas(ls).descartadas) {
      const i = orden.findIndex((l) => l.id === d.lectura.id);
      if (d.motivo === "no_encaja") {
        const ok = orden.slice(i + 1).some((l) => conservadas.has(l.id) && l.estado !== "reinicio" && Number(l.km) < Number(d.lectura.km));
        if (!ok) clasMal++;
      }
      if (d.motivo === "retrocede") {
        const ok = orden.slice(0, i).some((l) => conservadas.has(l.id) && Number(l.km) > Number(d.lectura.km));
        if (!ok) clasMal++;
      }
    }
  }
  chk(`nunca conserva MENOS lecturas que el viejo (${casos} historiales)`, peores === 0, `${peores}`);
  chk("con el mismo número de conservadas, el resultado es IDÉNTICO (lecturas, motivos y texto)", compatMal === 0, `${compatMal} distintos`);
  chk("ninguna lectura se pierde ni se duplica", perdidas === 0, `${perdidas}`);
  chk("la secuencia conservada no baja nunca (salvo reinicio)", bajan === 0, `${bajan}`);
  chk("cada no_encaja supera a una posterior; cada retrocede queda bajo una anterior", clasMal === 0, `${clasMal}`);
  chk("corolario: el barrido tiene casos donde el viejo perdía lecturas", mejores > 100, `${mejores} mejores · ${identicos} idénticos`);
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
