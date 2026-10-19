// Matriz de components/tarifario/traslados-pantalla.ts — npx tsx scripts/prueba-tarifario-traslados.mts
//
// Lo que la pantalla «Zonas y traslados» decide por su cuenta: cómo lee un precio tecleado (vacío no
// es cero), qué alias rechaza («Lima» a secas), cómo agrupa filas con los mismos precios y qué
// enseña en gris como heredado. Lo heredado se cruza contra `tarifaDelPar` del motor: si la
// pantalla dijera «usa el de SJL» donde el cotizador no encuentra precio, esta matriz falla.
import * as M from "../lib/traslados/motor";
import * as P from "../components/tarifario/traslados-pantalla";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };
const seccion = (t: string) => console.log(`\n── ${t}`);

// ── 1. Precios tecleados ──────────────────────────────────────────────────────
seccion("1. leerPrecio: vacío no es cero");
const lp = (s: string) => P.leerPrecio(s);
ok(lp("").tipo === "vacio" && lp("   ").tipo === "vacio", "vacío = sin precio (borra la fila)");
const val = (s: string) => { const r = lp(s); return r.tipo === "ok" ? r.valor : null; };
ok(val("120") === 120, "120");
ok(val("120.5") === 120.5 && val("120,50") === 120.5, "decimales con punto o coma");
ok(val("1,200") === 1200 && val("1,200.50") === 1200.5, "coma de miles");
ok(val("S/ 100") === 100 && val("US$ 36") === 36, "con el símbolo delante");
ok(val("99.999") === 100, "se redondea a céntimos");
for (const malo of ["0", "0.00", "-5", "abc", "12a", "1.2.3", "1000000"]) ok(lp(malo).tipo === "error", `«${malo}» no es un precio`);
ok(P.fmtNum(100) === "100" && P.fmtNum(126.5) === "126.50", "fmtNum");
ok(P.fmtFecha("2026-10-20") === "20/10/2026", "fmtFecha");
ok(P.leerEntero("", 0, 10).tipo === "vacio" && P.leerEntero("11", 0, 10).tipo === "error" && P.leerEntero("1.5", 0, 10).tipo === "error", "leerEntero");
ok(P.normalizarClaveCategoria("van 12 páx") === "VAN_12_PAX", "clave de categoría normalizada");

// ── Catálogo de prueba ────────────────────────────────────────────────────────
const z = (id: number, nombre: string, tipo: M.TipoZona, extra: Partial<P.ZonaFila> = {}): P.ZonaFila =>
  ({ id, nombre, tipo, padre_id: null, sector: null, alias: [], activo: true, orden: id, ...extra });
const AER = z(1, "Aeropuerto Jorge Chávez", "punto", { sector: "Callao", lat: -12.03, lng: -77.11, radio_m: 2000 });
const MIR = z(2, "Miraflores", "distrito", { sector: "Lima Moderna" });
const SIS = z(3, "San Isidro", "distrito", { sector: "Lima Moderna" });
const BAR = z(4, "Barranco", "distrito", { sector: "Lima Moderna" });
const SJL = z(5, "San Juan de Lurigancho", "distrito", { sector: "Lima Este", alias: ["SJL"] });
const CG = z(6, "San Juan de Lurigancho · Canto Grande", "subzona", { padre_id: 5, lat: -11.98, lng: -76.99, alias: ["Canto Grande"] });
const ZA = z(7, "San Juan de Lurigancho · Zárate", "subzona", { padre_id: 5, lat: -12.02, lng: -77.0 });
const SJM = z(8, "San Juan de Miraflores", "distrito", { sector: "Lima Sur", alias: ["SJM"] });
const HUA = z(9, "Huaral", "distrito");
const ZONAS = [AER, MIR, SIS, BAR, SJL, CG, ZA, SJM, HUA];
const CATS: P.CategoriaFila[] = [
  { clave: "AUTO", nombre: "Auto", capacidad: 4, maletas_bodega: 0, orden: 10, activo: true },
  { clave: "SUV", nombre: "SUV", capacidad: 4, maletas_bodega: 0, orden: 20, activo: true },
  { clave: "BUS", nombre: "Bus", capacidad: 50, maletas_bodega: 45, orden: 70, activo: true },
];
let tid = 1;
const t = (a: number, b: number, cat: string, mon: M.Moneda, precio: number, activo = true): P.TarifaFila => {
  const [x, y] = M.parOrdenado(a, b);
  return { id: tid++, zona_a_id: x, zona_b_id: y, categoria: cat, moneda: mon, precio_tramo: precio, activo };
};

// ── 2. Sectores y orden ───────────────────────────────────────────────────────
seccion("2. Orden por sector");
const porId = P.mapaZonas(ZONAS);
const ord = P.ordenarZonas(ZONAS, porId).map((x) => x.id);
ok(ord[0] === AER.id, "los puntos van primero");
ok(ord.indexOf(CG.id) === ord.indexOf(SJL.id) + 1 || ord.indexOf(ZA.id) === ord.indexOf(SJL.id) + 1, "una subzona va justo detrás de su distrito");
ok(ord.indexOf(MIR.id) < ord.indexOf(SJL.id) && ord.indexOf(SJL.id) < ord.indexOf(SJM.id), "Lima Moderna → Lima Este → Lima Sur");
ok(ord[ord.length - 1] === HUA.id && P.sectorDe(HUA, porId) === P.SECTOR_OTROS, "sin sector va a «Otros», al final");
ok(P.sectorDe(CG, porId) === "Lima Este", "la subzona sin sector hereda el de su distrito");
ok(P.coincideZona(CG, "sjl", porId) && P.coincideZona(CG, "canto", porId) && !P.coincideZona(MIR, "sjl", porId), "buscar por alias y por el distrito de la subzona");
ok(P.nombreCorto(SJL) === "SJL" && P.nombreCorto(MIR) === "Miraflores", "nombre corto: siglas si las hay");

// ── 3. Alias ──────────────────────────────────────────────────────────────────
seccion("3. Alias que no se agregan");
for (const g of ["Lima", "lima", "LIMA ", "Perú", "Provincia de Lima"]) ok(!!P.motivoAliasInvalido(g, MIR, [], ZONAS), `«${g}» se rechaza (genérico)`);
ok(/varios distritos/.test(P.motivoAliasInvalido("Lima", MIR, [], ZONAS) ?? ""), "el motivo de «Lima» lo explica");
ok(!!P.motivoAliasInvalido("SJL", MIR, [], ZONAS), "un alias de OTRO distrito se rechaza");
ok(!!P.motivoAliasInvalido("miraflores", MIR, [], ZONAS), "su propio nombre no se repite como alias");
ok(!!P.motivoAliasInvalido("Barranco", MIR, [], ZONAS), "el nombre de otro distrito no es alias");
ok(P.motivoAliasInvalido("Larcomar", MIR, [], ZONAS) == null, "un alias nuevo se acepta");
ok(!!P.motivoAliasInvalido("Canto Grande", ZA, [], ZONAS), "dos subzonas del mismo distrito no comparten barrio");
ok(P.motivoAliasInvalido("Canto Grande", z(99, "Otro · X", "subzona", { padre_id: SJM.id, lat: 0, lng: 0 }), [], ZONAS) == null, "subzonas de distritos distintos sí pueden");
ok(P.motivoAliasInvalido("LIM", AER, [], ZONAS) == null, "un punto no compite por nombre (se reconoce por su geocerca)");
ok(!!P.motivoAliasInvalido("Surco", MIR, ["surco"], ZONAS), "ya agregado (sin importar mayúsculas)");
ok(P.nombreRepetido("san isidro", ZONAS)?.id === SIS.id && P.nombreRepetido("San Isidro", ZONAS, SIS.id) == null, "nombre repetido sin tildes ni mayúsculas");

// ── 4. Agrupación: el caso real de AFA ───────────────────────────────────────
seccion("4. Filas con los mismos precios se juntan");
const AFA = [MIR, SIS, BAR].flatMap((d) => [
  t(AER.id, d.id, "AUTO", "PEN", 100), t(AER.id, d.id, "AUTO", "USD", 30),
  t(AER.id, d.id, "SUV", "PEN", 126), t(AER.id, d.id, "BUS", "PEN", 900),
]);
let b = P.bloquesDePrecios(AER.id, ZONAS, AFA, CATS);
ok(b.length === 1 && b[0].tipo === "grupo" && b[0].filas.length === 3, "Miraflores · San Isidro · Barranco en un solo grupo");
const AFA2 = AFA.map((x) => (x.zona_b_id === BAR.id && x.categoria === "AUTO" && x.moneda === "PEN" ? { ...x, precio_tramo: 110 } : x));
b = P.bloquesDePrecios(AER.id, ZONAS, AFA2, CATS);
ok(b.length === 2 && b.filter((x) => x.tipo === "grupo").length === 1 && b.some((x) => x.tipo === "fila" && x.fila.zona.id === BAR.id), "un precio distinto separa esa zona");
ok(P.bloquesDePrecios(MIR.id, ZONAS, AFA, CATS).length === 1, "desde Miraflores, el aeropuerto es una fila (el par no tiene sentido)");
const inact = AFA.map((x) => (x.zona_b_id === SIS.id && x.categoria === "BUS" ? { ...x, activo: false } : x));
ok(P.bloquesDePrecios(AER.id, ZONAS, inact, CATS).some((x) => x.tipo === "fila" && x.fila.zona.id === SIS.id), "una tarifa inactiva no se agrupa con las activas");

// ── 5. Herencia de la subzona: la decide el motor ────────────────────────────
seccion("5. Lo heredado sale de tarifaDelPar");
const HER = [t(AER.id, SJL.id, "AUTO", "PEN", 150), t(AER.id, SJL.id, "BUS", "PEN", 1100), t(AER.id, ZA.id, "AUTO", "PEN", 160)];
b = P.bloquesDePrecios(AER.id, ZONAS, HER, CATS);
const filas = b.flatMap((x) => (x.tipo === "fila" ? [x.fila] : x.filas));
const fSJL = filas.find((f) => f.zona.id === SJL.id);
const fCG = filas.find((f) => f.zona.id === CG.id);
const fZA = filas.find((f) => f.zona.id === ZA.id);
ok(!!fSJL && fSJL.nivel === 0 && fSJL.exactas.length === 2, "SJL con sus precios propios");
ok(!!fCG && fCG.nivel === 1 && fCG.exactas.length === 0, "Canto Grande colgada debajo, sin precio propio");
const hCG = fCG?.celdas[P.claveCelda("AUTO", "PEN")].heredada;
ok(hCG?.precio === 150 && hCG.de === "SJL", "Canto Grande «usa el de SJL» (150)");
ok(fCG?.celdas[P.claveCelda("SUV", "PEN")].heredada == null && fCG?.celdas[P.claveCelda("AUTO", "USD")].heredada == null, "sin precio en el distrito, no hereda nada (no se inventa)");
ok(!!fZA && fZA.nivel === 0 && fZA.exactas.length === 1, "Zárate con precio propio es fila propia");
ok(fZA?.celdas[P.claveCelda("AUTO", "PEN")].exacta?.precio_tramo === 160 && fZA?.celdas[P.claveCelda("BUS", "PEN")].heredada?.precio === 1100, "Zárate: AUTO propio, BUS heredado");
// Desde la subzona como ORIGEN: las zonas con las que su distrito tiene precio aparecen heredadas.
b = P.bloquesDePrecios(CG.id, ZONAS, HER, CATS);
const fAer = b.flatMap((x) => (x.tipo === "fila" ? [x.fila] : x.filas)).find((f) => f.zona.id === AER.id);
ok(!!fAer && fAer.exactas.length === 0 && fAer.celdas[P.claveCelda("AUTO", "PEN")].heredada?.precio === 150, "origen Canto Grande: el aeropuerto con el precio de SJL");

// Barrido: toda celda heredada coincide con lo que encontraría el cotizador, y lo exacto también.
let barrido = 0;
const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
for (let i = 0; i < 300; i++) {
  tid = 1;
  const ts: P.TarifaFila[] = [];
  for (const a of ZONAS) for (const c of ZONAS) {
    if (a.id > c.id || rnd() > 0.25) continue;
    for (const cat of CATS) for (const mon of ["PEN", "USD"] as M.Moneda[]) if (rnd() < 0.5) ts.push(t(a.id, c.id, cat.clave, mon, Math.round(rnd() * 500) + 1, rnd() > 0.1));
  }
  for (const o of ZONAS) {
    const bl = P.bloquesDePrecios(o.id, ZONAS, ts, CATS);
    const fs = bl.flatMap((x) => (x.tipo === "fila" ? [x.fila] : x.filas));
    // Toda zona con un precio propio con el origen aparece exactamente una vez.
    const conPrecio = new Set(ts.map((x) => P.otraPunta(x, o.id)).filter((x): x is number => x != null));
    const vistas = fs.filter((f) => f.nivel === 0).map((f) => f.zona.id);
    ok([...conPrecio].every((id) => vistas.filter((v) => v === id).length === 1), `barrido ${i}/${o.nombre}: cada destino con precio una sola vez`);
    for (const f of fs) for (const cat of CATS) for (const mon of ["PEN", "USD"] as M.Moneda[]) {
      const c = f.celdas[P.claveCelda(cat.clave, mon)];
      const motor = M.tarifaDelPar(o, f.zona, cat.clave, mon, ts, ZONAS);
      barrido++;
      if (c.heredada) ok(motor?.nivel === "por_distrito" && Number(motor.tarifa.precio_tramo) === c.heredada.precio, `heredada = motor (${o.nombre} ↔ ${f.zona.nombre} ${cat.clave} ${mon})`);
      else if (c.exacta && c.exacta.activo !== false) ok(motor?.nivel === "exacta" && motor.tarifa.id === c.exacta.id, "exacta = motor");
      else ok(motor == null || motor.nivel === "exacta", `sin nada en pantalla ⇒ el motor no hereda (${o.nombre} ↔ ${f.zona.nombre})`);
    }
    for (const g of bl) if (g.tipo === "grupo") {
      ok(g.filas.length >= 2, "un grupo tiene al menos dos zonas");
      const firma = (f: P.FilaPrecio) => f.exactas.map((x) => `${x.categoria}${x.moneda}${x.precio_tramo}${x.activo}`).sort().join();
      ok(g.filas.every((f) => firma(f) === firma(g.filas[0])), "un grupo junta solo precios idénticos");
    }
  }
}
console.log(`  barrido: ${barrido} celdas`);

// ── 6. Ajustes ────────────────────────────────────────────────────────────────
seccion("6. Minutos de espera contra el texto");
ok(P.minutosQueNoCoinciden(["Incluye 30 minutos de espera gratis."], 30).length === 0, "coinciden");
ok(P.minutosQueNoCoinciden(["Incluye 30 minutos de espera gratis."], 45).join() === "30", "no coinciden: se avisa");
ok(P.minutosQueNoCoinciden(["Precios por tramo."], 45).length === 0, "sin minutos en el texto, nada que avisar");

console.log(`\n${oks} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
