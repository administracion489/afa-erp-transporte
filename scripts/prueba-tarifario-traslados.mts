// Matriz de components/tarifario/traslados-pantalla.ts — npx tsx scripts/prueba-tarifario-traslados.mts
//
// Lo que la pantalla «Zonas y traslados» decide por su cuenta: cómo lee un precio tecleado (vacío no
// es cero), qué alias rechaza («Lima» a secas), cómo agrupa filas con los mismos precios y qué
// enseña en gris como heredado. Lo heredado se cruza contra `tarifaDelPar` del motor: si la
// pantalla dijera «usa el de SJL» donde el cotizador no encuentra precio, esta matriz falla.
import * as M from "../lib/traslados/motor";
import * as E from "../lib/traslados/envio-ia";
import * as P from "../components/tarifario/traslados-pantalla";
import * as C from "../lib/traslados/cotizacion-traslado";
import { existsSync } from "node:fs";

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

// ── 7. Envío automático por zona (fase 2) ─────────────────────────────────────
// La pantalla NO tiene su propia regla de herencia: `envioDeZona` dice «sale sola» exactamente
// cuando `zonaConEnvio` (la del agente) dice que sí. Si la pantalla dijera «hereda de SJL» donde el
// agente deja la cotización en revisión, esta sección falla.
seccion("7. Envío automático: la pantalla dice lo mismo que el agente");
{
  const conMarca = (zs: P.ZonaFila[], ids: number[]) => zs.map((x) => ({ ...x, envio_automatico: ids.includes(x.id) }));
  let barridoEnvio = 0;
  const ids = ZONAS.map((x) => x.id);
  // Todas las combinaciones de marca sobre AER, SJL, CG y HUA, con SJL y CG activos o no.
  const sujetos = [AER.id, SJL.id, CG.id, HUA.id];
  for (let mascara = 0; mascara < 1 << sujetos.length; mascara++) {
    for (const sjlActivo of [true, false]) for (const cgActivo of [true, false]) {
      const marcadas = sujetos.filter((_, i) => mascara & (1 << i));
      const zs = conMarca(ZONAS, marcadas).map((x) =>
        x.id === SJL.id ? { ...x, activo: sjlActivo } : x.id === CG.id ? { ...x, activo: cgActivo } : x);
      for (const zona of zs) {
        barridoEnvio++;
        const e = P.envioDeZona(zona, zs);
        const motor = E.zonaConEnvio(zona, zs);
        ok((e.codigo === "propio" || e.codigo === "hereda") === motor, `envioDeZona = zonaConEnvio (${zona.nombre}, marcadas ${marcadas.join(",") || "ninguna"})`);
        if (e.codigo === "hereda") ok(zona.tipo === "subzona" && zona.envio_automatico !== true && e.distrito === SJL.nombre, "solo hereda una subzona sin marca propia, de su distrito");
        if (e.codigo === "sin_efecto") ok(zona.envio_automatico === true && zona.activo === false, "«sin efecto» = marcada pero inactiva");
      }
      const propias = P.zonasConEnvioPropio(zs).map((x) => x.id);
      ok(propias.every((id) => marcadas.includes(id)), "Ajustes solo nombra zonas que tienen la marca");
      ok(P.subzonasQueHeredan(zs).every((x) => !propias.includes(x.id)), "heredar y tener la marca son disjuntos");
    }
  }
  ok(ids.length > 0, "catálogo");
  console.log(`  barrido: ${barridoEnvio} zonas`);

  // Sin la migración la columna no viene: nada sale solo y nada se pinta.
  ok(ZONAS.every((x) => P.envioDeZona(x, ZONAS).codigo === "no"), "sin la columna, ninguna zona envía");
  // Una subzona hereda de su distrito ACTIVO; con el distrito inactivo, no.
  const conSjl = conMarca(ZONAS, [SJL.id]);
  ok(P.envioDeZona(CG, conSjl).codigo === "hereda", "Canto Grande hereda de SJL");
  ok(P.envioDeZona(CG, conSjl.map((x) => (x.id === SJL.id ? { ...x, activo: false } : x))).codigo === "no", "con SJL inactivo, no hereda");
  ok(P.subzonasQueHeredan(conSjl).map((x) => x.id).sort().join() === [CG.id, ZA.id].sort().join(), "las dos subzonas de SJL heredan");

  seccion("8. Las confirmaciones nombran lo que va a pasar");
  const m1 = P.mensajeEncenderEnvio({ zonas: ["Aeropuerto Jorge Chávez"], iaCotiza: true });
  ok(m1.includes("Aeropuerto Jorge Chávez") && /SIN que un ejecutivo/.test(m1), "encender el envío nombra la zona y dice «sin revisión»");
  ok(!/apagada/.test(m1), "con la IA encendida no avisa de la IA apagada");
  ok(/Ninguna zona/.test(P.mensajeEncenderEnvio({ zonas: [], iaCotiza: true })), "sin zonas marcadas lo dice");
  ok(/apagada/.test(P.mensajeEncenderEnvio({ zonas: ["X"], iaCotiza: false })), "con la IA apagada avisa que no sale nada");
  ok(P.mensajeEncenderEnvio({ zonas: ["A", "B", "C"], iaCotiza: true }).includes("A, B y C"), "lista con «y»");
  ok(/sin revisión|SIN revisión/i.test(P.mensajeEncenderIA({ envioMaestro: true, zonas: ["Aeropuerto Jorge Chávez"] }))
    && P.mensajeEncenderIA({ envioMaestro: true, zonas: ["Aeropuerto Jorge Chávez"] }).includes("Aeropuerto Jorge Chávez"), "encender la IA con envío nombra la zona que sale sola");
  ok(/inbox/.test(P.mensajeEncenderIA({ envioMaestro: false, zonas: ["Aeropuerto Jorge Chávez"] })), "encender la IA sin envío: todo al inbox");
  const mz = P.mensajeEnvioZona({ id: SJL.id, nombre: SJL.nombre, tipo: "distrito" }, ZONAS, false);
  ok(mz.includes("2 subzonas") && mz.includes(SJL.nombre) && /apagado en Ajustes/.test(mz), "marcar un distrito nombra sus subzonas y el maestro apagado");
  ok(!/subzona/.test(P.mensajeEnvioZona({ id: AER.id, nombre: AER.nombre, tipo: "punto" }, ZONAS, true)), "un punto no habla de subzonas");
  ok(/aplica desde que guardes/.test(P.mensajeEnvioZona({ id: null, nombre: "Nuevo", tipo: "distrito" }, ZONAS, true)), "con el maestro encendido, vale ya");
  ok(P.SQL_TRASLADOS.some((x) => x.archivo === P.SQL_COTIZACION_IA), "la lista de SQL incluye traslados-05");
}

// ── 9. Fotos y descripción de la categoría (traslados-07) ─────────────────────
seccion("9. Fotos de la categoría: qué se lee, qué se copia y cómo se dice");
{
  const bytes = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? [...x].map((ch) => ch.charCodeAt(0)) : [x])));
  const ftyp = (marca: string) => bytes(0, 0, 0, 24, "ftyp", marca, 0, 0, 0, 0);
  ok(P.esHeic("image/heic", "foto.jpg") && P.esHeic("image/heif", null) && P.esHeic("IMAGE/HEIC-SEQUENCE", null), "HEIC por el tipo");
  ok(P.esHeic("", "IMG_0001.HEIC") && P.esHeic(null, "x.heif"), "HEIC por la extensión");
  ok(P.esHeic("", "foto", ftyp("heic")) && P.esHeic("", "foto", ftyp("mif1")), "HEIC por la firma (sin tipo ni extensión)");
  ok(!P.esHeic("", "foto", ftyp("avif")), "un AVIF sí lo lee el navegador: no es HEIC");
  ok(!P.esHeic("image/jpeg", "foto.jpg", bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, "JFIF", 0, 1, 1)), "un JPEG no es HEIC");
  ok(/JPG o PNG/.test(P.MOTIVO_HEIC) && /captura/.test(P.MOTIVO_HEIC), "el motivo dice qué subir en su lugar");

  // ADAPTADA 22-10-2026: la descripción se guarda en RENGLONES (cada salto de línea sale en el PDF).
  ok(P.descripcionParaGuardar("  Minivan\n con   bodega  \n\n") === "Minivan\ncon bodega", "la descripción se guarda en renglones, sin bordes ni renglones vacíos");
  ok(P.descripcionParaGuardar(" - A \r\n - B ") === C.descripcionCategoria({ nombre: "x", capacidad: 1, maletas_bodega: 0, descripcion_cliente: " - A \r\n - B " }), "se guarda con la MISMA limpieza con que el PDF la imprime");
  ok(P.motivoDescripcionLarga(null) === null && P.motivoDescripcionLarga("x".repeat(1000)) === null, "hasta 1000 caracteres se guarda");
  ok(/1001 caracteres y el máximo es 1000/.test(P.motivoDescripcionLarga("x".repeat(1001)) ?? ""), "con 1001, dice cuántos tiene");
  ok(/21 renglones y el máximo es 20/.test(P.motivoDescripcionLarga(Array.from({ length: 21 }, () => "a").join("\n")) ?? ""), "con 21 renglones, lo dice");
  ok(P.esTopeViejoDescripcion({ code: "23514", message: 'new row for relation "traslado_categorias" violates check constraint "traslado_categorias_descripcion_ck"' }), "reconoce el CHECK viejo de 300");
  ok(!P.esTopeViejoDescripcion({ code: "23514", message: 'violates check constraint "traslado_categorias_foto_externa_ck"' }) && !P.esTopeViejoDescripcion(null), "otro CHECK no es el de la descripción");
  ok(P.MOTIVO_TOPE_VIEJO.includes(P.SQL_DESCRIPCION_LARGA) && existsSync(P.SQL_DESCRIPCION_LARGA), "el aviso nombra el SQL, y el SQL existe");
  ok(P.descripcionParaGuardar("   \n ") === null && P.descripcionParaGuardar(null) === null, "vacía = null (el PDF usa la frase por defecto)");
  ok(P.largoTexto("🚐 Van") === 5 && P.largoTexto("ñandú") === 5, "los caracteres se cuentan como la base (un emoji es uno)");

  const SB = "https://abc.supabase.co";
  const pub = (bucket: string, ruta = "propios/ABC123/ext.jpg") => `${SB}/storage/v1/object/public/${bucket}/${ruta}`;
  ok(P.origenFoto(pub("vehiculos-fotos"), SB)?.tipo === "copiable", "una foto pública del propio Supabase se puede copiar");
  for (const b of ["documentos", "pasajeros-fotos", "radar-media", "crm-media"]) ok(P.origenFoto(pub(b), SB)?.tipo === "otro", `un bucket privado (${b}) no se copia`);
  ok(P.origenFoto(pub("vehiculos-fotos").replace("abc.", "otro."), SB)?.tipo === "otro", "otro proyecto de Supabase no se copia");
  ok(P.origenFoto(pub("vehiculos-fotos").replace("https:", "http:"), SB)?.tipo === "otro", "http no se copia");
  ok(P.origenFoto(pub("vehiculos-fotos").replace("https://", "https://yo:clave@"), SB)?.tipo === "otro", "con usuario en la URL no se copia");
  ok(P.origenFoto(`${SB}/storage/v1/object/sign/vehiculos-fotos/x.jpg?token=1`, SB)?.tipo === "otro", "una URL firmada no se copia");
  ok(P.origenFoto(pub("vehiculos-fotos"), null)?.tipo === "otro", "sin la URL del proyecto, nada se da por propio");
  const dr = P.origenFoto("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWx/view?usp=sharing", SB);
  ok(dr?.tipo === "drive" && dr.miniatura === "https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOpQrStUvWx&sz=w400", "Drive: se reconoce y se arma la miniatura");
  ok(P.origenFoto("https://drive.google.com/drive/folders/x", SB)?.tipo === "drive" && (P.origenFoto("https://drive.google.com/drive/folders/x", SB) as { miniatura: string | null }).miniatura === null, "Drive sin id: sin miniatura");
  ok(P.origenFoto("", SB) === null && P.origenFoto(null, SB) === null && P.origenFoto("   ", SB) === null, "sin foto = null");
  ok(P.origenFoto("no es una url", SB)?.tipo === "otro" && P.origenFoto("https://ejemplo.com/bus.jpg", SB)?.tipo === "otro", "texto suelto u otro sitio: no se copia");

  const u = (id: number, flota: P.UnidadFotos["flota"], placa: string, tipo: string | null, estado: string | null, ext: string | null, int: string | null = null): P.UnidadFotos =>
    ({ id, flota, placa, tipo_vehiculo_costeo: tipo, estado, foto_externa_url: ext, foto_interna_url: int });
  const flota = [
    u(1, "tercerizada", "AAA-111", "SPRINTER_17", "disponible", "x"),
    u(2, "propia", "ZZZ-999", "SPRINTER_17", null, null, "y"),
    u(3, "propia", "BBB-222", "SPRINTER_17", "Inactivo", "x"),
    u(4, "propia", "CCC-333", "SPRINTER_17", "disponible", null, null),
    u(5, "propia", "DDD-444", "BUS_50", "disponible", "x"),
    u(6, "propia", "EEE-555", " SPRINTER_17 ", "ocupado", "x"),
  ];
  const sug = P.sugerenciasFlota(flota, "SPRINTER_17");
  ok(sug.map((x) => x.id).join() === "6,2,1", "solo la misma ficha, vigentes y con alguna foto; propias primero y por placa");
  ok(P.sugerenciasFlota(flota, null).length === 0 && P.sugerenciasFlota(flota, "  ").length === 0, "sin ficha de costeo no se sugiere nada");

  const m = (status: number, d: P.RespuestaFoto, accion?: "subir" | "quitar") => P.mensajeRespuestaFoto(status, d, accion);
  const sm = m(409, { codigo: "sin_migracion", detalle: "Falta correr supabase/traslados-07-fotos-categoria.sql en Supabase." });
  ok(sm.sinMigracion && sm.detalle.includes("traslados-07"), "sin migración: se marca y nombra el SQL");
  ok(m(409, { codigo: "sin_migracion" }).detalle.includes(P.SQL_FOTOS_CATEGORIA), "sin migración y sin detalle: nombra el SQL igual");
  ok(/sesión/.test(m(401, null).detalle) && !m(401, null).sinMigracion, "401: la sesión");
  ok(/origen/.test(m(403, { codigo: "origen" }).detalle) && /Tarifas/.test(m(403, { codigo: "sin_permiso", detalle: "x" }).detalle), "403: origen o el permiso que falta");
  ok(/desplegada/.test(m(404, null).detalle) && /Recargar/.test(m(404, { codigo: "sin_categoria" }).detalle), "404: sin despliegue o categoría borrada");
  ok(/Recargar/.test(m(409, { codigo: "cambio_concurrente" }).detalle), "409: otro la cambió");
  ok(m(429, { codigo: "tope", detalle: "Demasiadas fotos seguidas: espera 12 s." }).detalle.includes("12 s"), "429: dice cuánto esperar");
  ok(m(422, { codigo: "canales", detalle: "Es un JPEG en CMYK (de imprenta): conviértelo a RGB." }).detalle.includes("CMYK"), "422: el motivo de revisarJpeg");
  ok(m(413, { codigo: "muy_pesado", detalle: "La foto pesa 900 KB" }).detalle.includes("900 KB"), "413: el peso");
  ok(/servidor/.test(m(502, null).detalle) && m(500, { detalle: "No se pudo guardar." }).detalle.includes("No se pudo guardar."), "5xx: dicho en castellano");
  ok(/^No se quitó/.test(m(500, null, "quitar").detalle) && /^No se guardó/.test(m(500, null).detalle), "dice qué acción falló");

  const fs = await import("node:fs");
  ok(fs.existsSync(P.SQL_FOTOS_CATEGORIA), "el SQL que nombra la pantalla existe");
  ok(P.SQL_TRASLADOS.some((x) => x.archivo === P.SQL_FOTOS_CATEGORIA), "la lista de SQL incluye traslados-07");
  // El aviso «sin_foto» del PDF nombra el bloque de la pantalla con su título real.
  const pantalla = fs.readFileSync("components/tarifario/FotosCategorias.tsx", "utf8");
  const avisos = fs.readFileSync("lib/traslados/enviar-cotizacion-datos.ts", "utf8");
  ok(pantalla.includes("Fotos y descripción para la cotización") && avisos.includes("«Fotos y descripción para la cotización»"), "el aviso sin_foto nombra el bloque como se llama en la pantalla");

  // La descripción EN INGLÉS (traslados-10): su propia columna, la misma limpieza, y NUNCA la de castellano.
  const cat = { nombre: "Minivan H1 10 pax", capacidad: 10, maletas_bodega: 8, descripcion_cliente: "Aire acondicionado\nAsientos reclinables" };
  const enVacia = C.descripcionCategoria({ ...cat, descripcion_cliente_en: null }, "en");
  ok(!enVacia.includes("Aire acondicionado") && /for up to 10 passengers/.test(enVacia) && /luggage hold for 8 large/.test(enVacia), `en inglés y vacía: la frase del sistema en inglés, nunca la de castellano («${enVacia}»)`);
  ok(C.descripcionCategoria({ ...cat, descripcion_cliente_en: "  Air conditioning \n\n Reclining seats " }, "en") === "Air conditioning\nReclining seats", "en inglés y escrita: la escrita, en renglones");
  ok(P.descripcionParaGuardar("  Air conditioning \n\n Reclining seats ") === C.descripcionCategoria({ ...cat, descripcion_cliente_en: "  Air conditioning \n\n Reclining seats " }, "en"), "se guarda con la MISMA limpieza con que el PDF en inglés la imprime");
  ok(C.descripcionCategoria({ ...cat, descripcion_cliente_en: "Air conditioning" }) === "Aire acondicionado\nAsientos reclinables", "en castellano no se lee la de inglés");
  ok(fs.existsSync(P.SQL_DESCRIPCION_INGLES) && /traslados-10/.test(P.SQL_DESCRIPCION_INGLES), "el SQL de la descripción en inglés existe (es traslados-10, no el de las fotos)");

  // Las columnas: la de inglés va APARTE (si falta, las fotos siguen) y se suelta SOLA.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://prueba.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "clave-de-prueba";
  const D = await import("../components/tarifario/traslados-datos");
  ok(D.COLS_CATEGORIA_INGLES.every((x) => !(D.COLS_CATEGORIA_FOTOS as readonly string[]).includes(x)) && D.COLS_CATEGORIA_INGLES.join() === "descripcion_cliente_en", "la columna en inglés no está entre las de traslados-07");
  ok(D.normalizarCategoria({ clave: "VAN", descripcion_cliente_en: "Air conditioning" }).descripcion_cliente_en === "Air conditioning"
    && D.normalizarCategoria({ clave: "VAN", descripcion_cliente_en: "   " }).descripcion_cliente_en === null && D.normalizarCategoria({ clave: "VAN" }).descripcion_cliente_en === null,
    "normalizarCategoria lee la descripción en inglés (vacía o ausente = null)");
  ok(D.faltaDescripcionIngles(D.COLS_CATEGORIA) && D.faltaDescripcionIngles(`${D.COLS_CATEGORIA}, foto_externa_url, descripcion_cliente`)
    && !D.faltaDescripcionIngles(`${D.COLS_CATEGORIA}, descripcion_cliente,  descripcion_cliente_en`), "sin la columna en lo que se pudo pedir: falta traslados-10");
  // El lector con columnas accesorias suelta SOLO la que el error nombra (las dos formas: PostgREST y Postgres).
  const lector = (faltan: string[], otro?: { code: string; message: string }) => {
    const pedidas: string[] = [];
    return {
      pedidas,
      leer: async (cols: string) => {
        pedidas.push(cols);
        if (otro) return { filas: null, error: otro };
        const f = faltan.find((x) => cols.split(", ").includes(x));
        if (!f) return { filas: [{ clave: "VAN" }], error: null };
        return { filas: null, error: f.startsWith("foto")
          ? { code: "42703", message: `column traslado_categorias.${f} does not exist` }
          : { code: "PGRST204", message: `Could not find the '${f}' column of 'traslado_categorias' in the schema cache` } };
      },
    };
  };
  const acc = [...D.COLS_CATEGORIA_FOTOS, ...D.COLS_CATEGORIA_INGLES];
  const l1 = lector(["descripcion_cliente_en"]);
  const r1 = await D.conAccesorias(l1.leer, D.COLS_CATEGORIA, acc);
  ok(!r1.r.error && r1.faltan.join() === "descripcion_cliente_en" && r1.cols.includes("foto_externa_url") && r1.cols.includes("descripcion_cliente") && D.faltaDescripcionIngles(r1.cols),
    "sin traslados-10: se suelta solo la descripción en inglés, las fotos siguen");
  const l2 = lector(["foto_externa_url", "foto_interna_url", "descripcion_cliente", "descripcion_cliente_en"]);
  const r2 = await D.conAccesorias(l2.leer, D.COLS_CATEGORIA, acc);
  ok(!r2.r.error && r2.faltan.length === 4 && r2.cols === D.COLS_CATEGORIA, "sin traslados-07 ni -10: se sueltan las cuatro, una por una, y se lee lo básico");
  const l3 = lector([], { code: "42501", message: "permission denied for table traslado_categorias" });
  const r3 = await D.conAccesorias(l3.leer, D.COLS_CATEGORIA, acc);
  ok(!!r3.r.error && r3.faltan.length === 0 && l3.pedidas.length === 1, "otro error no suelta nada (una lectura que falla no es una columna que falta)");
  // La pantalla: el campo en inglés escribe SU columna y nombra el SQL si falta.
  ok(/const CAMPO_DESCRIPCION = \{ es: "descripcion_cliente", en: "descripcion_cliente_en" \} as const;/.test(pantalla)
    && /update\(\{ \[campo\]: nueva \}\)/.test(pantalla) && /descripcionCategoria\(\{ \.\.\.c, \[campo\]: nueva \}, idioma\)/.test(pantalla)
    && pantalla.includes("Descripción para el cliente (inglés)") && pantalla.includes("{SQL_DESCRIPCION_INGLES}")
    && /faltaAlguna\(res\.error, en \? COLS_CATEGORIA_INGLES : COLS_CATEGORIA_FOTOS\)/.test(pantalla),
    "la pantalla guarda la descripción en inglés en su columna, con la vista previa del PDF en inglés y el ámbar de traslados-10");
}

// ── 10. Las condiciones del PDF del traslado (cotizaciones-05) ────────────────
// Con reglas, Ajustes ENSEÑA (solo lectura) lo que la IA copia a la fila en cada segmento. Lo que se
// pinta sale de `condicionesTrasladoIA`, y aquí se cruza contra `filaCotizacionTraslado` —la fila
// que arma la IA— con la plantilla que elige `plantillaParaUso`: si la pantalla enseñara otras
// listas, otra plantilla u otra fuente que la IA, esta sección falla.
seccion("10. Ajustes y el Simulador dicen las condiciones que la IA copia de verdad");
{
  const C = await import("../lib/traslados/cotizacion-traslado");
  const PL = await import("../lib/cotizacion-plantillas");
  type Pl = import("../lib/cotizacion-plantillas").PlantillaFila;
  type Rg = import("../lib/cotizacion-plantillas").ReglaPlantilla;
  const HOY = "2026-10-20";
  // Oráculo escrito aparte (no `sirveParaIA`): activa, diseño corporativo y no en inglés.
  const sirve = (p: Pl): boolean => p.activa !== false && (p.diseno ?? "corporativo") === "corporativo" && p.idioma !== "en";

  // Un traslado cotizable de verdad (el motor), en soles y en dólares: aeropuerto → Miraflores.
  const tarifasT = [t(AER.id, MIR.id, "AUTO", "PEN", 100), t(AER.id, MIR.id, "AUTO", "USD", 35)];
  const ctxT: M.ContextoTraslado = { zonas: ZONAS, categorias: CATS, tarifas: tarifasT, tipoCambio: { fecha: HOY, venta: 3.4 }, hoy: HOY, igvPct: 18, validezDias: 30 };
  const pedidoT = (tel: string): M.PedidoTraslado => ({
    origen: { texto: "Aeropuerto Jorge Chávez", lat: -12.03, lng: -77.11, localidades: ["Callao"], barrios: [] },
    destino: { texto: "Miraflores", lat: -12.12, lng: -77.03, localidades: ["Miraflores"], barrios: [] },
    fecha_servicio: "2026-10-25", sentido: "ida", pax: 2, maletas: 0, telefono: tel,
  });
  const entradaT = (tel: string) => ({ origen: "Aeropuerto Jorge Chávez", destino: "Miraflores", fecha_servicio: "2026-10-25", hora_servicio: null, sentido: "ida" as const, fecha_retorno: null, hora_retorno: null, pax: 2, maletas: 0, telefono: tel });
  const TEL = { PEN: "+51966707225", USD: "+13055551234" };
  const rPen = M.evaluarTraslado(pedidoT(TEL.PEN), ctxT);
  const rUsd = M.evaluarTraslado(pedidoT(TEL.USD), ctxT);
  ok(rPen.codigo === "cotizable" && rPen.precio?.moneda === "PEN", `el traslado en soles es cotizable (${rPen.codigo}: ${rPen.motivo})`);
  ok(rUsd.codigo === "cotizable" && rUsd.precio?.moneda === "USD", `el traslado en dólares es cotizable (${rUsd.codigo}: ${rUsd.motivo})`);
  ok(PL.segmentoDeCliente({ moneda: "USD", tipoCliente: "b2b" }) === "extranjero" && PL.segmentoDeCliente({ moneda: "PEN", tipoCliente: "b2b" }) === "empresa",
    "en el traslado, «extranjero» es siempre en dólares y los otros dos en soles (lo que supone la pantalla)");

  const pl = (id: string, extra: Partial<Pl> = {}): Pl => ({ id, nombre: id.toUpperCase(), activa: true, es_principal: false, diseno: "corporativo", idioma: "es", orden: 1, ...extra });
  const CORP = pl("corporativo", { nombre: "Corporativo", es_principal: true, condiciones_generales: ["General de la corporativa", "  "], condiciones_incluye: ["Incluye de la corporativa"], condiciones_no_incluye: null });
  const TIA = pl("traslados_ia", { nombre: "Traslados (IA)", orden: 2, condiciones_generales: ["Precios por tramo.", "Incluye 30 minutos de espera gratis.", ""], condiciones_incluye: ["  Conductor profesional "], condiciones_no_incluye: [] });
  const TUSD = pl("traslados_ia_usd", { nombre: "Traslados (IA) · dólares", orden: 3, condiciones_generales: ["Incluye 30 minutos de espera gratis.", "IGV exonerado con TAM y pasaporte."], condiciones_incluye: null, condiciones_no_incluye: ["Parqueo del aeropuerto"] });
  const MOD = pl("moderno_fotos", { diseno: "moderno_fotos", condiciones_generales: ["No la dibuja la IA"] });
  const ING = pl("en_ingles", { idioma: "en", condiciones_generales: ["In English"] });
  const OFF = pl("apagada", { activa: false, condiciones_generales: ["Desactivada"] });
  const r3 = (e: string, p: string, x: string): Rg[] => [
    { servicio: "traslado_ia", segmento: "empresa", plantilla_id: e },
    { servicio: "traslado_ia", segmento: "particular", plantilla_id: p },
    { servicio: "traslado_ia", segmento: "extranjero", plantilla_id: x },
  ];
  const JUEGOS: { nombre: string; pls: Pl[]; reglas: Rg[] }[] = [
    { nombre: "el traspaso", pls: [CORP, TIA, TUSD, MOD, ING, OFF], reglas: r3("traslados_ia", "traslados_ia", "traslados_ia_usd") },
    { nombre: "celdas vacías", pls: [CORP, TIA, TUSD], reglas: [] },
    { nombre: "reglas rotas", pls: [CORP, TIA, MOD, ING, OFF], reglas: r3("moderno_fotos", "apagada", "no_existe") },
    { nombre: "inglés", pls: [CORP, ING], reglas: r3("en_ingles", "en_ingles", "en_ingles") },
    { nombre: "sin principal", pls: [{ ...CORP, es_principal: false }, TIA], reglas: r3("traslados_ia", "moderno_fotos", "apagada") },
    { nombre: "principal que la IA no dibuja", pls: [{ ...MOD, es_principal: true }, { ...CORP, es_principal: false }, OFF], reglas: r3("apagada", "apagada", "corporativo") },
    { nombre: "nada", pls: [], reglas: [] },
    { nombre: "otras reglas que no son de la IA", pls: [CORP, TIA], reglas: [{ servicio: "eventual", segmento: "empresa", plantilla_id: "traslados_ia" }] },
  ];
  const CONFIGS: P.ConfigCondiciones[] = [
    { consideraciones: ["Precios por tramo. No incluyen IGV.", "Incluye 15 minutos de espera."], consideraciones_usd: ["Pago al tipo de cambio del día", "  "], incluye: ["Ajustes incluye"], no_incluye: ["Ajustes no incluye"] },
    { consideraciones: [], consideraciones_usd: [] },
    { consideraciones: ["  Solo esta  ", ""], consideraciones_usd: [], incluye: null, no_incluye: [] },
  ];
  type CfgT = import("../lib/traslados/datos").ConfigTraslados;
  const consDeFila = (segmento: string, cfg: P.ConfigCondiciones, plantilla: Pl | null) => {
    const usd = segmento === "extranjero";
    return C.filaCotizacionTraslado(usd ? rUsd : rPen, entradaT(usd ? TEL.USD : TEL.PEN), {
      convId: "c", clienteId: null, atencion: null, config: { validez_dias: 30, espera_gratis_min: 30, ...cfg } as unknown as CfgT, firma: "f", hoy: HOY, plantilla,
    }).consideraciones_json;
  };
  const codigosVistos = new Set<string>();
  let nCond = 0;
  for (const j of JUEGOS) for (const cfg of CONFIGS) {
    const grupos = P.condicionesTrasladoIA(j.pls, j.reglas, cfg);
    // Qué listas de Ajustes se ofrecen (y se guardan): EXACTAMENTE las que la IA lee. Se prueba con
    // centinelas: cambiar una columna cambia alguna fila ⟺ la pantalla la ofrece en ese segmento.
    const enUso = P.listasDeAjustesEnUso(grupos);
    const SENT: Record<string, P.ConfigCondiciones> = {
      generales: { ...cfg, consideraciones: [...cfg.consideraciones, "CENTINELA_G"] },
      usd: { ...cfg, consideraciones_usd: [...cfg.consideraciones_usd, "CENTINELA_U"] },
      incluye: { ...cfg, incluye: ["CENTINELA_I"] },
      no_incluye: { ...cfg, no_incluye: ["CENTINELA_N"] },
    };
    const leidaEn: Record<string, string[]> = { generales: [], usd: [], incluye: [], no_incluye: [] };
    for (const segmento of PL.SEGMENTOS) {
      const plSeg = PL.plantillaParaUso({ servicio: "traslado_ia", segmento }, j.pls, j.reglas).plantilla;
      const base = JSON.stringify(consDeFila(segmento, cfg, plSeg));
      for (const k of Object.keys(SENT)) if (JSON.stringify(consDeFila(segmento, SENT[k], plSeg)) !== base) leidaEn[k].push(segmento);
    }
    const clavesEnUso = enUso.usos?.map((u) => u.clave) ?? null;
    ok(JSON.stringify(clavesEnUso) === JSON.stringify(leidaEn.generales) && JSON.stringify(leidaEn.incluye) === JSON.stringify(leidaEn.generales) && JSON.stringify(leidaEn.no_incluye) === JSON.stringify(leidaEn.generales),
      `${j.nombre}: se ofrecen consideraciones, Incluye y No incluye en los segmentos que las leen (${JSON.stringify(clavesEnUso)} vs ${JSON.stringify(leidaEn.generales)})`);
    ok(enUso.enUso === (leidaEn.generales.length > 0), `${j.nombre}: las listas de Ajustes se editan ⟺ alguna fila las lee`);
    ok(enUso.usd === (leidaEn.usd.length > 0) && leidaEn.usd.every((x) => x === "extranjero"), `${j.nombre}: las de dólares se editan ⟺ alguna fila las lee (solo extranjero)`);
    const segsEnGrupos = grupos.flatMap((g) => g.usos.map((x) => x.segmento));
    ok(segsEnGrupos.length === 3 && PL.SEGMENTOS.every((sg) => segsEnGrupos.filter((x) => x === sg).length === 1), `${j.nombre}: cada segmento sale en un solo grupo`);
    ok(new Set(grupos.map((g) => g.clave)).size === grupos.length, `${j.nombre}: un grupo por fuente`);
    for (const segmento of PL.SEGMENTOS) {
      nCond++;
      const g = grupos.find((x) => x.usos.some((y) => y.segmento === segmento))!;
      const su = g.usos.find((y) => y.segmento === segmento)!;
      const uso = PL.plantillaParaUso({ servicio: "traslado_ia", segmento }, j.pls, j.reglas);
      codigosVistos.add(uso.codigo);
      const usd = segmento === "extranjero";
      const fila = C.filaCotizacionTraslado(usd ? rUsd : rPen, entradaT(usd ? TEL.USD : TEL.PEN), {
        convId: "c", clienteId: null, atencion: null, config: { validez_dias: 30, espera_gratis_min: 30, ...cfg } as unknown as CfgT, firma: "f", hoy: HOY, plantilla: uso.plantilla,
      });
      const cj = fila.consideraciones_json;
      ok(JSON.stringify([g.generales.items, g.incluye.items, g.no_incluye.items]) === JSON.stringify([cj.generales, cj.incluye, cj.no_incluye]),
        `${j.nombre} · ${segmento}: las listas que enseña Ajustes = las que copia la IA (${JSON.stringify(g.generales.items)} vs ${JSON.stringify(cj.generales)})`);
      ok((g.fuente.tipo === "plantilla") === (uso.plantilla != null), `${j.nombre} · ${segmento}: de una plantilla ⟺ la IA usa una plantilla`);
      if (g.fuente.tipo === "plantilla") ok(g.fuente.plantilla.id === uso.plantilla?.id && fila.plantilla_pdf === uso.plantilla?.id, `${j.nombre} · ${segmento}: la misma plantilla que la IA`);
      else ok(g.fuente.usd === usd && !("plantilla_pdf" in fila), `${j.nombre} · ${segmento}: sin plantilla, las de Ajustes (con las de dólares solo en extranjero)`);
      ok(su.codigo === uso.codigo && su.detalle === uso.detalle && su.ambar === ["regla_inactiva", "regla_no_sirve_ia", "sin_plantilla", "sin_reglas"].includes(uso.codigo), `${j.nombre} · ${segmento}: el código y el ámbar del motor`);
      ok(su.porque.length > 0 && !su.porque.startsWith("Traslado de la IA"), `${j.nombre} · ${segmento}: el porqué sin el nombre de la celda delante`);
      if (g.fuente.tipo === "plantilla") {
        const p = g.fuente.plantilla;
        ok(g.generales.propia === Array.isArray(p.condiciones_generales) && g.incluye.propia === Array.isArray(p.condiciones_incluye) && g.no_incluye.propia === Array.isArray(p.condiciones_no_incluye), `${j.nombre} · ${segmento}: «sin lista propia» ⟺ NULL en la plantilla`);
        ok(sirve(p), `${j.nombre} · ${segmento}: nunca enseña una plantilla que la IA no dibuja`);
      }
      // La pantalla del simulador: con la respuesta que arma la ruta para esta misma resolución.
      const resp = {
        plantilla: uso.plantilla ? { id: uso.plantilla.id, nombre: uso.plantilla.nombre || uso.plantilla.id, segmento, codigo: uso.codigo } : null,
        condiciones: { fuente: uso.plantilla ? "plantilla" : "ajustes", segmento, codigo: uso.codigo, detalle: uso.detalle },
      };
      const cs = P.condicionesDelSimulador(resp);
      ok(cs != null && cs.texto.startsWith("Condiciones del PDF:"), `${j.nombre} · ${segmento}: el simulador lo dice`);
      if (cs) {
        ok(uso.plantilla ? cs.texto.includes(`«${uso.plantilla.nombre}»`) && !/Ajustes/.test(cs.texto) : /Ajustes/.test(cs.texto), `${j.nombre} · ${segmento}: el simulador nombra la misma fuente`);
        ok(cs.ambar === su.ambar, `${j.nombre} · ${segmento}: el simulador pinta ámbar lo mismo que Ajustes`);
        ok(cs.enlace != null, `${j.nombre} · ${segmento}: siempre dice dónde se arregla`);
      }
    }
  }
  console.log(`  barrido: ${nCond} segmentos · códigos vistos: ${[...codigosVistos].sort().join(", ")}`);
  ok(["regla", "principal", "regla_inactiva", "regla_no_sirve_ia", "sin_plantilla"].every((c) => codigosVistos.has(c)), "el barrido pasa por los cinco códigos que hay con reglas");

  // El traspaso: empresa y particular comparten «Traslados (IA)»; extranjero, la de dólares.
  const gT = P.condicionesTrasladoIA(JUEGOS[0].pls, JUEGOS[0].reglas, CONFIGS[0]);
  ok(gT.length === 2 && gT[0].usos.map((x) => x.segmento).join() === "empresa,particular" && P.usosTexto(gT[0]) === "empresa y particular", "el traspaso: empresa y particular juntos, extranjero aparte");
  ok(gT.every((g) => g.usos.every((u) => u.celda === null && !u.sinUso)), "con la regla vieja no hay celdas idioma × moneda ni celdas sin uso");
  ok(gT[1].incluye.propia === false && gT[1].incluye.items.length === 0, "lista NULL de la plantilla: «sin lista propia», nunca la de Ajustes");
  ok(!gT.some((g) => g.generales.items.some((x) => x.includes("15 minutos"))), "con plantillas, las consideraciones de Ajustes no se enseñan");
  // Sin una plantilla que la IA pueda usar: las de Ajustes, y en dólares con las de dólares.
  const gN = P.condicionesTrasladoIA([], [], CONFIGS[0]);
  ok(gN.length === 2 && gN.every((g) => g.fuente.tipo === "ajustes" && g.usos.every((x) => x.codigo === "sin_plantilla" && x.ambar)), "sin plantillas: las de Ajustes, en ámbar");
  ok(gN[1].generales.items.join("|") === "Precios por tramo. No incluyen IGV.|Incluye 15 minutos de espera.|Pago al tipo de cambio del día", "extranjero sin plantilla: generales + las de dólares, limpias");

  // La política de reserva (cotizaciones-06): Ajustes enseña la MISMA que la IA copia a la fila.
  {
    const POL = ["  Se confirma con el 50 % de adelanto. ", "", "Cancelación con 24 horas o más: sin costo."];
    const plsR = [CORP, { ...TIA, condiciones_reserva: POL }, { ...TUSD, condiciones_reserva: null }];
    const gR = P.condicionesTrasladoIA(plsR, JUEGOS[0].reglas, CONFIGS[0]);
    for (const segmento of PL.SEGMENTOS) {
      const g = gR.find((x) => x.usos.some((y) => y.segmento === segmento))!;
      const uso = PL.plantillaParaUso({ servicio: "traslado_ia", segmento }, plsR, JUEGOS[0].reglas);
      const usd = segmento === "extranjero";
      const cj = C.filaCotizacionTraslado(usd ? rUsd : rPen, entradaT(usd ? TEL.USD : TEL.PEN), {
        convId: "c", clienteId: null, atencion: null, config: { validez_dias: 30, espera_gratis_min: 30, ...CONFIGS[0] } as unknown as CfgT, firma: "f", hoy: HOY, plantilla: uso.plantilla,
      }).consideraciones_json;
      ok(JSON.stringify(g.reserva.items) === JSON.stringify(cj.reserva ?? []), `${segmento}: la política que enseña Ajustes = la que copia la IA (${JSON.stringify(g.reserva.items)} vs ${JSON.stringify(cj.reserva)})`);
      ok(g.reserva.propia === Array.isArray(uso.plantilla?.condiciones_reserva), `${segmento}: «sin política» ⟺ la plantilla no la tiene`);
    }
    ok(JSON.stringify(gR[0].reserva.items) === JSON.stringify(["Se confirma con el 50 % de adelanto.", "Cancelación con 24 horas o más: sin costo."]), "limpia: sin espacios de más ni líneas vacías");
    const gSin = P.condicionesTrasladoIA([], [], CONFIGS[0]);
    ok(gSin.every((g) => g.reserva.propia === false && g.reserva.items.length === 0), "con las listas de Ajustes no hay política (no la tienen)");
    const ajustesSrc = (await import("node:fs")).readFileSync("components/tarifario/AjustesTraslado.tsx", "utf8");
    ok(/titulo="Reserva, cambios y cancelación" lista=\{g\.reserva\}/.test(ajustesSrc), "la pantalla de Ajustes enseña la política de cada plantilla");
  }

  // Su resumen (cotizaciones-08): Ajustes enseña el MISMO que la IA copia a la fila, y solo con política.
  {
    const POL = ["Se confirma con el 50 % de adelanto.", "Cancelación con 24 horas o más: sin costo."];
    const RES = ["  Adelanto del 50 %. ", "", "Sin costo con 24 h."];
    const plsS = [CORP, { ...TIA, condiciones_reserva: POL, condiciones_reserva_resumen: RES }, { ...TUSD, condiciones_reserva: null, condiciones_reserva_resumen: RES }];
    const gS = P.condicionesTrasladoIA(plsS, JUEGOS[0].reglas, CONFIGS[0]);
    for (const segmento of PL.SEGMENTOS) {
      const g = gS.find((x) => x.usos.some((y) => y.segmento === segmento))!;
      const uso = PL.plantillaParaUso({ servicio: "traslado_ia", segmento }, plsS, JUEGOS[0].reglas);
      const usd = segmento === "extranjero";
      const cj = C.filaCotizacionTraslado(usd ? rUsd : rPen, entradaT(usd ? TEL.USD : TEL.PEN), {
        convId: "c", clienteId: null, atencion: null, config: { validez_dias: 30, espera_gratis_min: 30, ...CONFIGS[0] } as unknown as CfgT, firma: "f", hoy: HOY, plantilla: uso.plantilla,
      }).consideraciones_json as { reserva?: string[]; reserva_resumen?: string[] };
      ok(JSON.stringify(g.reserva_resumen.items) === JSON.stringify(cj.reserva_resumen ?? []), `${segmento}: el resumen que enseña Ajustes = el que copia la IA (${JSON.stringify(g.reserva_resumen.items)} vs ${JSON.stringify(cj.reserva_resumen)})`);
      ok(g.reserva_resumen.propia === Array.isArray(uso.plantilla?.condiciones_reserva_resumen), `${segmento}: «sin resumen» ⟺ la plantilla no lo tiene`);
      ok(JSON.stringify(P.lineasPoliticaYResumen(g)) === JSON.stringify([...(cj.reserva ?? []), ...(cj.reserva_resumen ?? [])]), `${segmento}: lineasPoliticaYResumen = la política y su resumen, en ese orden`);
    }
    const conPol = gS.find((g) => g.reserva.items.length > 0)!;
    ok(JSON.stringify(conPol.reserva_resumen.items) === JSON.stringify(["Adelanto del 50 %.", "Sin costo con 24 h."]), "limpio: sin espacios de más ni líneas vacías");
    const sinPol = gS.find((g) => g.fuente.tipo === "plantilla" && g.fuente.plantilla.id === TUSD.id);
    ok(!sinPol || sinPol.reserva_resumen.items.length === 0, "un resumen sin política no se copia (la IA no lo manda)");
    const gSinR = P.condicionesTrasladoIA([], [], CONFIGS[0]);
    ok(gSinR.every((g) => g.reserva_resumen.propia === false && g.reserva_resumen.items.length === 0 && P.lineasPoliticaYResumen(g).length === 0), "con las listas de Ajustes no hay resumen");
  }

  // La espera gratis se coteja con lo que el PDF imprime, y se nombra la plantilla.
  ok(P.esperaQueNoCoincideIA(gT, 30).length === 0, "con 30 min en las plantillas y 30 de espera: nada");
  const e45 = P.esperaQueNoCoincideIA(gT, 45);
  ok(e45.length === 2 && e45[0].texto.includes("«Traslados (IA)»") && e45[0].texto.includes("empresa y particular") && e45[0].texto.includes("30 min") && e45[0].texto.includes("45 min"), "con 45 de espera: nombra la plantilla, sus segmentos y los dos números");
  ok(e45[1].texto.includes("«Traslados (IA) · dólares»") && e45.every((d) => d.plantilla != null), "y la de dólares aparte");
  ok(P.esperaQueNoCoincideIA(gT, 15).length === 2, "los «15 minutos» de Ajustes no cuentan: no los imprime ningún PDF");
  const eN = P.esperaQueNoCoincideIA(gN, 30);
  ok(eN.length === 1 && eN[0].plantilla === null && eN[0].minutos.join() === "15" && eN[0].quienes.join() === "empresa,particular,extranjero" && /aquí abajo/.test(eN[0].texto),
    "sin plantilla: las de Ajustes UNA vez (es el mismo texto), con sus tipos de cliente");

  // Mixto: unos segmentos con plantilla, otros caen a Ajustes.
  const gMix = P.condicionesTrasladoIA([CORP, TIA], r3("traslados_ia", "moderno_fotos", "apagada"), CONFIGS[0]); // sin principal activa → caen
  const gMix2 = P.condicionesTrasladoIA([{ ...CORP, es_principal: false }, TIA], r3("traslados_ia", "moderno_fotos", "apagada"), CONFIGS[0]);
  ok(P.listasDeAjustesEnUso(gMix).enUso === false, "con la principal que sirve, nadie cae a Ajustes: no se ofrecen");
  const uMix = P.listasDeAjustesEnUso(gMix2);
  ok(uMix.enUso && uMix.usd && JSON.stringify(uMix.usos?.map((u) => u.segmento)) === JSON.stringify(["particular", "extranjero"]), "particular y extranjero caen a Ajustes: se ofrecen, con las de dólares");
  const eMix = P.esperaQueNoCoincideIA(gMix2, 30);
  ok(eMix.length === 1 && eMix[0].plantilla === null && eMix[0].quienes.join() === "particular,extranjero", "la espera se coteja también con las de Ajustes donde caen");
  const uPen = P.listasDeAjustesEnUso(P.condicionesTrasladoIA([{ ...MOD, es_principal: true }, { ...CORP, es_principal: false }, OFF], r3("apagada", "apagada", "corporativo"), CONFIGS[0]));
  ok(uPen.enUso && !uPen.usd && JSON.stringify(uPen.usos?.map((u) => u.segmento)) === JSON.stringify(["empresa", "particular"]), "solo los de soles caen: las de dólares no se ofrecen");
  ok(JSON.stringify(P.listasDeAjustesEnUso(null)) === JSON.stringify({ enUso: true, usd: true, usos: null, total: 0, ingles: [] }), "sin reglas (o sin poder comprobarlo): las cuatro, como antes");
  ok(P.avisoListasAjustes({ enUso: true, usd: true, usos: null, total: 0, ingles: [] }) === null && P.avisoListasAjustes({ enUso: false, usd: false, usos: [], total: 3, ingles: [] }) === null, "sin reglas o sin segmentos que caigan: no hay aviso de segmentos");
  const avPen = P.avisoListasAjustes(uPen)!;
  ok(avPen.includes("empresa y particular") && avPen.includes("Los demás usan su plantilla.") && avPen.includes("dólares no se ofrecen"), "el aviso nombra los segmentos, dice que los demás usan su plantilla y por qué no salen las de dólares");
  const usosN = P.listasDeAjustesEnUso(gN);
  const avTodos = P.avisoListasAjustes(usosN)!;
  ok(usosN.usos?.length === 3 && usosN.total === 3 && !avTodos.includes("Los demás") && !avTodos.includes("no se ofrecen") && /Plantillas PDF/.test(avTodos), "con los tres: ni «los demás» ni las de dólares");
  ok(/ese tipo de cliente/.test(P.avisoListasAjustes({ ...usosN, usos: usosN.usos!.filter((u) => u.segmento === "extranjero") })!), "con uno solo, en singular");

  // El enlace al editor solo lleva un id de forma válida (va en la URL).
  ok(P.enlaceEditarPlantilla("traslados_ia") === "/cotizaciones/plantillas?editar=traslados_ia", "enlace a editar esa plantilla");
  ok(P.enlaceEditarPlantilla("../x?y=1") === "/cotizaciones/plantillas" && P.enlaceEditarPlantilla(null) === "/cotizaciones/plantillas" && P.enlaceEditarPlantilla("AB") === "/cotizaciones/plantillas", "un id de otra forma no va en la URL");

  // El simulador: la frase pedida, los códigos sin plantilla, y una respuesta de antes no dice nada.
  const csR = P.condicionesDelSimulador({ plantilla: { id: "traslados_ia", nombre: "Traslados (IA)", segmento: "particular", codigo: "regla" }, condiciones: { fuente: "plantilla", segmento: "particular", codigo: "regla", detalle: "x" } });
  ok(csR?.texto === "Condiciones del PDF: plantilla «Traslados (IA)» (traslado de la IA · particular)" && csR.detalle === null && !csR.ambar, "por la regla: la frase pedida, sin más");
  ok(csR?.enlace?.tipo === "plantilla" && (csR.enlace as { href: string }).href === "/cotizaciones/plantillas?editar=traslados_ia", "con el enlace a editar esa plantilla");
  ok(!!csR?.nota && /particular/.test(csR.nota) && /empresa/.test(csR.nota), "en soles avisa que el simulador no prueba la celda «empresa»");
  ok(P.condicionesDelSimulador({ plantilla: { id: "traslados_ia_usd", nombre: "D", segmento: "extranjero", codigo: "regla" } })?.nota === null, "en dólares no hay nada que avisar");
  const csS = P.condicionesDelSimulador({ plantilla: null, condiciones: { fuente: "ajustes", segmento: "particular", codigo: "sin_reglas", detalle: "x" } });
  ok(!!csS && csS.texto.includes("las de Ajustes") && csS.texto.includes(PL.SQL_PLANTILLAS_USO) && csS.ambar && csS.enlace?.tipo === "ajustes", "sin reglas: las de Ajustes, nombrando el SQL");
  const csP = P.condicionesDelSimulador({ plantilla: null, condiciones: { fuente: "ajustes", segmento: "extranjero", codigo: "sin_plantilla", detalle: "No hay una plantilla principal activa." } });
  ok(!!csP && /hay reglas, pero ninguna plantilla que la IA pueda dibujar/.test(csP.texto) && csP.ambar && csP.enlace?.tipo === "plantillas" && csP.detalle!.includes("No hay una plantilla principal activa."), "sin plantilla: lo dice y manda a Plantillas PDF");
  for (const vieja of [null, undefined, {}, { envio: { decision: "automatico", motivos: [] } }, { plantilla: null }, { plantilla: { id: 5, segmento: "otro", codigo: "regla" } }, { condiciones: { codigo: "inventado" } }]) {
    ok(P.condicionesDelSimulador(vieja as Parameters<typeof P.condicionesDelSimulador>[0]) === null, `una respuesta sin esos campos (o deformes) no dice nada: ${JSON.stringify(vieja)}`);
  }
  const largo = P.condicionesDelSimulador({ plantilla: { id: "x_larga", nombre: "N".repeat(500), segmento: "empresa", codigo: "regla" } });
  ok(!!largo && Array.from(largo.texto).length < 200, "un nombre desmesurado se recorta");

  // Ajustes no escribe las cuatro listas cuando las lee una plantilla.
  const fsA = await import("node:fs");
  const src = fsA.readFileSync("components/tarifario/AjustesTraslado.tsx", "utf8");
  ok(/if \(e\.gen\) fila\.consideraciones = limpias\(cons\);/.test(src) && /if \(e\.usd\) fila\.consideraciones_usd = limpias\(consUsd\);/.test(src)
    && /if \(e\.listas\) \{ fila\.incluye = limpias\(incl\); fila\.no_incluye = limpias\(noIncl\); \}/.test(src) && !/consideraciones: limpias\(cons\)/.test(src),
    "«Guardar ajustes» solo escribe las listas que la IA lee hoy");
  ok(/const enUso = plantillas == null \? null : listasDeAjustesEnUso\(grupos\);/.test(src)
    && /const edita = \{ gen: !!enUso\?\.enUso, usd: !!enUso\?\.usd, listas: !!enUso\?\.enUso && !sinMigracionListas \};/.test(src),
    "qué se ofrece lo decide listasDeAjustesEnUso (y mientras se comprueba, nada)");
  const pantallaSrc = fsA.readFileSync("components/tarifario/traslados-pantalla.ts", "utf8");
  // ADAPTADA 23-10-2026 (cotizaciones-09): una sola llamada para las dos reglas, con la moneda de la celda.
  ok(/const c = considDeTraslado\(plantilla, config, moneda\);/.test(pantallaSrc) && (pantallaSrc.match(/considDeTraslado\(/g) ?? []).length === 1
    && !/considSnapshot/.test(pantallaSrc) && !/\.trim\(\)\)\.filter\(Boolean\)/.test(pantallaSrc),
    "la pantalla usa la copia de la fila (considDeTraslado), no una suya");

  // ── 11. La regla idioma × moneda (cotizaciones-09): las cuatro celdas, el inglés y el Simulador ──
  // Con la tabla nueva, Ajustes ENSEÑA lo que la IA copia en cada celda (castellano o inglés, en
  // soles o en dólares). Se cruza contra `filaCotizacionTraslado` con la plantilla que elige
  // `plantillaTrasladoIA` y el idioma de la celda, y contra `revisionPorCondiciones`: si la pantalla
  // dice «queda en revisión» donde la IA no lo deja, o calla donde sí, esta sección falla.
  seccion("11. Idioma × moneda: Ajustes, el inglés y el Simulador dicen lo que hace la IA");
  {
    type Rt = import("../lib/cotizacion-plantillas").ReglaTraslado;
    type Celda = import("../lib/cotizacion-plantillas").CeldaTraslado;
    // Oráculo aparte: activa, corporativa y en el idioma de la celda (castellano = todo lo que no es inglés).
    const sirveEn = (p: Pl | null | undefined, idioma: "es" | "en"): boolean =>
      !!p && p.activa !== false && (p.diseno ?? "corporativo") === "corporativo" && (idioma === "en" ? p.idioma === "en" : p.idioma !== "en");
    const AMBAR = ["regla_inactiva", "regla_no_sirve_ia", "sin_plantilla", "sin_reglas", "sin_plantilla_idioma"];
    const ENG = pl("en_ingles", { idioma: "en", nombre: "Transfers (AI) · PEN", orden: 4, condiciones_generales: ["Prices per leg.", "Includes 30 minutes of free waiting time."], condiciones_incluye: ["Professional driver"], condiciones_no_incluye: [] });
    const ENG_USD = pl("en_ingles_usd", { idioma: "en", nombre: "Transfers (AI) · USD", orden: 5, condiciones_generales: ["Includes 30 minutes of free waiting time.", "IGV is waived with TAM and passport."], condiciones_incluye: null, condiciones_no_incluye: ["Airport parking"] });
    const ENG_OFF = pl("en_apagada", { idioma: "en", activa: false, condiciones_generales: ["Disabled"] });
    const ENG_MOD = pl("en_moderno", { idioma: "en", diseno: "moderno_fotos", condiciones_generales: ["Not drawn by the AI"] });
    const rt = (esPen: string | null, esUsd: string | null, enPen: string | null, enUsd: string | null): Rt[] => [
      ...(esPen ? [{ idioma: "es" as const, moneda: "PEN" as const, plantilla_id: esPen }] : []),
      ...(esUsd ? [{ idioma: "es" as const, moneda: "USD" as const, plantilla_id: esUsd }] : []),
      ...(enPen ? [{ idioma: "en" as const, moneda: "PEN" as const, plantilla_id: enPen }] : []),
      ...(enUsd ? [{ idioma: "en" as const, moneda: "USD" as const, plantilla_id: enUsd }] : []),
    ];
    const TODAS = [CORP, TIA, TUSD, MOD, OFF, ENG, ENG_USD, ENG_OFF, ENG_MOD];
    const JUEGOS2: { nombre: string; pls: Pl[]; rt: Rt[] }[] = [
      { nombre: "el traspaso, sin inglés", pls: TODAS, rt: rt("traslados_ia", "traslados_ia_usd", null, null) },
      { nombre: "inglés completo", pls: TODAS, rt: rt("traslados_ia", "traslados_ia_usd", "en_ingles", "en_ingles_usd") },
      { nombre: "inglés solo en dólares", pls: TODAS, rt: rt("traslados_ia", "traslados_ia_usd", null, "en_ingles_usd") },
      { nombre: "inglés solo en soles", pls: TODAS, rt: rt("traslados_ia", "traslados_ia_usd", "en_ingles", null) },
      { nombre: "inglés con reglas rotas", pls: TODAS, rt: rt("traslados_ia", "traslados_ia_usd", "en_apagada", "en_moderno") },
      { nombre: "inglés a una plantilla en castellano", pls: TODAS, rt: rt("traslados_ia", "traslados_ia_usd", "en_ingles", "traslados_ia") },
      { nombre: "castellano a Ajustes e inglés a medias", pls: [{ ...CORP, es_principal: false }, ENG_USD], rt: rt(null, null, null, "en_ingles_usd") },
      { nombre: "principal en inglés sin regla de inglés", pls: [{ ...ENG, es_principal: true }, { ...CORP, es_principal: false }, TIA], rt: rt("traslados_ia", null, null, null) },
      { nombre: "castellano con reglas rotas", pls: TODAS, rt: rt("apagada", "moderno_fotos", null, null) },
      { nombre: "inglés con una regla rota y principal en inglés", pls: [{ ...ENG, es_principal: true }, { ...CORP, es_principal: false }, TIA, TUSD, ENG_OFF], rt: rt("traslados_ia", "traslados_ia_usd", "en_ingles", "en_apagada") },
      { nombre: "celdas vacías", pls: [CORP, TIA, ENG], rt: [] },
      { nombre: "nada", pls: [], rt: [] },
    ];
    const filaDe = (celda: Celda, cfg: P.ConfigCondiciones, plantilla: Pl | null) => {
      const usd = celda.moneda === "USD";
      return C.filaCotizacionTraslado(usd ? rUsd : rPen, entradaT(usd ? TEL.USD : TEL.PEN), {
        convId: "c", clienteId: null, atencion: null, config: { validez_dias: 30, espera_gratis_min: 30, ...cfg } as unknown as CfgT, firma: "f", hoy: HOY, plantilla, idioma: celda.idioma,
      });
    };
    const vistos = new Set<string>();
    let nCeldas = 0;
    for (const j of JUEGOS2) for (const cfg of CONFIGS) {
      const grupos = P.condicionesTrasladoIA(j.pls, [], cfg, j.rt);
      const on = PL.inglesActivo(PL.inglesDisponible(j.pls, j.rt));
      const usos = grupos.flatMap((g) => g.usos);
      ok(usos.length === 4 && PL.CELDAS_TRASLADO.every((c) => usos.filter((u) => u.clave === `${c.idioma}|${c.moneda}`).length === 1), `${j.nombre}: cada una de las cuatro celdas sale en un solo grupo`);
      ok(new Set(grupos.map((g) => g.clave)).size === grupos.length && usos.every((u) => u.segmento === null && u.celda != null), `${j.nombre}: un grupo por fuente, y son celdas (no segmentos)`);
      // Qué listas de Ajustes lee cada celda: con centinelas.
      const SENT: Record<string, P.ConfigCondiciones> = {
        generales: { ...cfg, consideraciones: [...cfg.consideraciones, "CENTINELA_G"] },
        usd: { ...cfg, consideraciones_usd: [...cfg.consideraciones_usd, "CENTINELA_U"] },
        incluye: { ...cfg, incluye: ["CENTINELA_I"] },
      };
      const lee: Record<string, string[]> = { generales: [], usd: [], incluye: [] };
      for (const celda of PL.CELDAS_TRASLADO) {
        const plC = PL.plantillaTrasladoIA(celda, j.pls, j.rt, { reglas: [], segmento: "particular" }).plantilla;
        const base = JSON.stringify(filaDe(celda, cfg, plC).consideraciones_json);
        for (const k of Object.keys(SENT)) if (JSON.stringify(filaDe(celda, SENT[k], plC).consideraciones_json) !== base) lee[k].push(`${celda.idioma}|${celda.moneda}`);
      }
      const enUso = P.listasDeAjustesEnUso(grupos);
      const esLee = lee.generales.filter((x) => x.startsWith("es|"));
      ok(JSON.stringify(enUso.usos?.map((u) => u.clave)) === JSON.stringify(esLee) && JSON.stringify(lee.incluye) === JSON.stringify(lee.generales),
        `${j.nombre}: se ofrecen las listas de Ajustes ⟺ alguna celda de castellano las lee (${JSON.stringify(enUso.usos?.map((u) => u.clave))} vs ${JSON.stringify(esLee)})`);
      ok(enUso.usd === lee.usd.some((x) => x.startsWith("es|")) && lee.usd.every((x) => x.endsWith("|USD")), `${j.nombre}: las de dólares se ofrecen ⟺ una celda de castellano en dólares las lee`);
      ok(lee.generales.filter((x) => x.startsWith("en|")).every((x) => lee.generales.includes(`es|${x.slice(3)}`)),
        `${j.nombre}: una celda en inglés NUNCA cae sola a las listas de Ajustes: solo si su castellano de la misma moneda cae (${JSON.stringify(lee.generales)})`);
      ok(JSON.stringify(enUso.ingles.map((u) => u.clave)) === JSON.stringify(on ? lee.generales.filter((x) => x.startsWith("en|")) : []),
        `${j.nombre}: el aviso nombra las celdas en inglés en uso que salen con las listas de Ajustes`);
      ok(enUso.total === 2, `${j.nombre}: cuentan las dos celdas de castellano`);
      for (const celda of PL.CELDAS_TRASLADO) {
        nCeldas++;
        const clave = `${celda.idioma}|${celda.moneda}`;
        const g = grupos.find((x) => x.usos.some((u) => u.clave === clave))!;
        const su = g.usos.find((u) => u.clave === clave)!;
        const uso = PL.plantillaTrasladoIA(celda, j.pls, j.rt, { reglas: [], segmento: "particular" });
        vistos.add(uso.codigo);
        const fila = filaDe(celda, cfg, uso.plantilla);
        const cj = fila.consideraciones_json;
        ok(JSON.stringify([g.generales.items, g.incluye.items, g.no_incluye.items]) === JSON.stringify([cj.generales, cj.incluye, cj.no_incluye]),
          `${j.nombre} · ${clave}: las listas que enseña Ajustes = las que copia la IA`);
        ok((g.fuente.tipo === "plantilla") === (uso.plantilla != null) && (g.fuente.tipo !== "plantilla" || g.fuente.plantilla.id === uso.plantilla?.id), `${j.nombre} · ${clave}: la misma fuente que la IA`);
        if (g.fuente.tipo === "ajustes") ok(g.fuente.usd === (celda.moneda === "USD"), `${j.nombre} · ${clave}: de Ajustes, con las de dólares solo en dólares`);
        ok(su.codigo === uso.codigo && su.detalle === uso.detalle && su.usd === (celda.moneda === "USD"), `${j.nombre} · ${clave}: el código y la frase del motor`);
        ok(su.sinUso === (celda.idioma === "en" && !on), `${j.nombre} · ${clave}: «sin uso» ⟺ celda en inglés con el inglés apagado`);
        ok(su.ambar === (!su.sinUso && AMBAR.includes(uso.codigo)), `${j.nombre} · ${clave}: ámbar = código del motor que contradice, nunca en una celda sin uso`);
        ok(su.porque.length > 0 && !su.porque.startsWith("Traslado de la IA"), `${j.nombre} · ${clave}: el porqué sin el nombre de la celda delante`);
        ok(fila.idioma_pdf === celda.idioma, `${j.nombre} · ${clave}: la fila sale en el idioma de la celda`);
        // Nunca una plantilla que la IA no dibuja en ese idioma, salvo la caída al castellano declarada.
        if (uso.plantilla) {
          ok(uso.codigo === "sin_plantilla_idioma" ? sirveEn(uso.plantilla, "es") && celda.idioma === "en" : sirveEn(uso.plantilla, celda.idioma),
            `${j.nombre} · ${clave}: la plantilla que enseña la puede dibujar la IA en ese idioma (o es la caída al castellano)`);
        }
        if (celda.idioma === "en" && !su.sinUso) {
          const rev = E.revisionPorCondiciones({ avisosPdf: [], consideraciones: cj, idiomaPdf: fila.idioma_pdf }).motivos.includes("condiciones_en_otro_idioma");
          ok(rev === (uso.codigo === "sin_plantilla_idioma"), `${j.nombre} · ${clave}: queda en revisión por el idioma ⟺ la pantalla dice que cae al castellano (${uso.codigo})`);
          if (rev) {
            const es = P.celdaCastellanoDe(celda);
            ok(su.ambar && su.porque.includes(`cae a castellano · ${celda.moneda === "USD" ? "dólares" : "soles"}`) && /revisión/.test(su.porque) && !/^Se usa/.test(su.porque),
              `${j.nombre} · ${clave}: lo dice así: cae a la celda castellano de su moneda y queda en revisión («${su.porque}»)`);
            ok(uso.detalle.includes(P.MARCA_SIN_PLANTILLA_INGLES), `${j.nombre} · ${clave}: la frase del motor trae la marca con que la pantalla separa la razón`);
            const deEs = PL.plantillaTrasladoIA(es, j.pls, j.rt, { reglas: [], segmento: "particular" }).plantilla;
            ok(deEs ? su.porque.includes(`plantilla «${deEs.nombre || deEs.id}»`) : su.porque.includes("las listas de Ajustes de traslados"), `${j.nombre} · ${clave}: y nombra lo que usa ese castellano`);
          }
        }
        if (!su.sinUso) {
          // El Simulador, con la respuesta que arma la ruta para esta misma resolución.
          const resp = {
            plantilla: uso.plantilla ? { id: uso.plantilla.id, nombre: uso.plantilla.nombre || uso.plantilla.id, segmento: "particular", codigo: uso.codigo, celda } : null,
            condiciones: { fuente: uso.plantilla ? "plantilla" : "ajustes", segmento: "particular", codigo: uso.codigo, detalle: uso.detalle, celda },
          };
          const cs = P.condicionesDelSimulador(resp);
          ok(!!cs && cs.ambar === su.ambar && cs.nota === null && cs.enlace != null, `${j.nombre} · ${clave}: el simulador pinta lo mismo que Ajustes, sin la nota del tipo de cliente`);
          const lbl = PL.etiquetaCeldaTraslado(celda).replace("Traslado", "traslado");
          if (cs) ok((cs.texto.includes(lbl) || (cs.detalle ?? "").includes(lbl)) && (!uso.plantilla || cs.texto.includes(`«${uso.plantilla.nombre}»`)),
            `${j.nombre} · ${clave}: el simulador nombra la celda y la plantilla («${cs.texto}»)`);
          if (cs && uso.codigo === "sin_plantilla_idioma") ok(/en castellano/.test(cs.texto), `${j.nombre} · ${clave}: el simulador dice que las condiciones van en castellano`);
        }
      }
      // La espera: nunca se avisa de una plantilla que solo usan celdas sin uso.
      for (const d of P.esperaQueNoCoincideIA(grupos, 45)) {
        ok(d.quienes.length > 0 && !grupos.some((g) => g.clave === d.clave && P.grupoSinUso(g)), `${j.nombre}: la espera solo se coteja con lo que algún PDF imprime`);
      }
    }
    console.log(`  barrido: ${nCeldas} celdas · códigos vistos: ${[...vistos].sort().join(", ")}`);
    ok(["regla", "principal", "regla_inactiva", "regla_no_sirve_ia", "sin_plantilla", "sin_plantilla_idioma"].every((c) => vistos.has(c)), "el barrido pasa por los seis códigos de la regla nueva");

    // Casos con nombre.
    const gOn = P.condicionesTrasladoIA(TODAS, [], CONFIGS[0], rt("traslados_ia", "traslados_ia_usd", "en_ingles", "en_ingles_usd"));
    ok(gOn.length === 4 && gOn.every((g) => g.usos.length === 1 && !g.usos[0].ambar && g.fuente.tipo === "plantilla"), "inglés completo: cuatro celdas, cuatro plantillas, nada en ámbar");
    ok(gOn[2].usos[0].etiqueta === "Inglés · soles" && P.usosTexto(gOn[3]) === "inglés · dólares", "las celdas se nombran «Inglés · soles» / «inglés · dólares»");
    const gOff = P.condicionesTrasladoIA(TODAS, [], CONFIGS[0], rt("traslados_ia", "traslados_ia_usd", null, null));
    ok(gOff.length === 2 && gOff.every((g) => g.usos.filter((u) => u.sinUso).length === 1 && !P.grupoSinUso(g) && P.usosTexto(g).split(" y ").length === 1),
      "inglés apagado: cada celda en inglés va con su castellano, sin uso, y no se nombra en las frases");
    ok(gOff.every((g) => g.usos.every((u) => !u.ambar)) && gOff.flatMap((g) => g.usos).filter((u) => u.sinUso).every((u) => /apagado/.test(u.porque)), "inglés apagado: nada en ámbar, y lo dice");
    const gMedio = P.condicionesTrasladoIA([{ ...CORP, es_principal: false }, ENG_USD], [], CONFIGS[0], rt(null, null, null, "en_ingles_usd"));
    const uMedio = P.listasDeAjustesEnUso(gMedio);
    ok(uMedio.enUso && uMedio.usd && uMedio.usos?.map((u) => u.clave).join() === "es|PEN,es|USD" && uMedio.ingles.map((u) => u.clave).join() === "en|PEN",
      "castellano a Ajustes e inglés a medias: se ofrecen las listas (por el castellano) y se nombra la celda en inglés que cae");
    const avMedio = P.avisoListasAjustes(uMedio)!;
    ok(/castellano · soles y castellano · dólares/.test(avMedio) && /inglés en soles no tiene plantilla en inglés y cae a castellano · soles/.test(avMedio) && /en castellano, y queda en revisión/.test(avMedio) && !/La otra celda/.test(avMedio),
      `el aviso lo dice así: cae al castellano y queda en revisión («${avMedio}»)`);
    const uUna = P.listasDeAjustesEnUso(P.condicionesTrasladoIA([{ ...CORP, es_principal: false }, TIA], [], CONFIGS[0], rt("traslados_ia", null, null, null)));
    const avUna = P.avisoListasAjustes(uUna)!;
    ok(uUna.usos?.map((u) => u.clave).join() === "es|USD" && /castellano · dólares/.test(avUna) && /La otra celda usa su plantilla\./.test(avUna) && !/no se ofrecen/.test(avUna), "una sola celda cae: la otra usa su plantilla");
    const uPenSolo = P.listasDeAjustesEnUso(P.condicionesTrasladoIA([{ ...CORP, es_principal: false }, TUSD], [], CONFIGS[0], rt(null, "traslados_ia_usd", null, null)));
    ok(/en dólares se usa una plantilla/.test(P.avisoListasAjustes(uPenSolo)!) && !uPenSolo.usd, "solo soles cae: las de dólares no se ofrecen, y se dice por qué");
    const ePen = P.esperaQueNoCoincideIA(gOn, 45);
    ok(ePen.length === 4 && ePen.some((d) => d.texto.includes("«Transfers (AI) · USD»") && d.texto.includes("traslado de la IA · inglés · dólares")), "la espera nombra la plantilla en inglés y su celda");
    ok(P.esperaQueNoCoincideIA(gOff, 45).every((d) => !d.quienes.some((x) => x.startsWith("inglés"))), "con el inglés apagado, la espera no nombra celdas en inglés");

    // La línea del inglés en Ajustes: gris apagado, ámbar a medias, verde encendido.
    const lNull = P.lineasInglesIA(null);
    ok(lNull.tono === "gris" && lNull.lineas.join(" ").includes(PL.SQL_REGLAS_TRASLADO) && existsSync(PL.SQL_REGLAS_TRASLADO), "sin la tabla: gris, nombra el SQL (que existe)");
    const lOff = P.lineasInglesIA({ PEN: false, USD: false });
    ok(lOff.tono === "gris" && /Inglés apagado/.test(lOff.titulo) && /castellano, como hoy/.test(lOff.lineas.join(" ")), "apagado: gris, todo en castellano como hoy");
    const lOn = P.lineasInglesIA({ PEN: true, USD: true });
    ok(lOn.tono === "verde" && /dólares aunque escriban desde un número peruano/.test(lOn.lineas.join(" ")) && /no la IA/.test(lOn.lineas.join(" ")), "encendido: verde, dice la moneda y quién detecta el idioma");
    const lUsd = P.lineasInglesIA({ PEN: false, USD: true });
    ok(lUsd.tono === "ambar" && /solo en dólares/.test(lUsd.titulo) && lUsd.lineas.join(" ").includes("«Traslado de la IA · inglés · soles»") && lUsd.lineas.join(" ").includes("«Traslado de la IA · castellano · soles»") && /revisión/.test(lUsd.lineas.join(" ")),
      "solo en dólares: ámbar, nombra la celda que falta, adónde cae y que queda en revisión");
    const lPen = P.lineasInglesIA({ PEN: true, USD: false });
    ok(lPen.tono === "ambar" && /solo en soles/.test(lPen.titulo) && lPen.lineas.join(" ").includes("«Traslado de la IA · inglés · dólares»"), "solo en soles: ámbar, y nombra la de dólares");
    for (const j of JUEGOS2) {
      const ing = PL.inglesDisponible(j.pls, j.rt);
      const l = P.lineasInglesIA(ing);
      ok((l.tono === "gris") === !PL.inglesActivo(ing) && (l.tono === "verde") === (!!ing && ing.PEN && ing.USD), `${j.nombre}: el tono del inglés sale de inglesDisponible`);
    }
    ok(P.lineasInglesIA(PL.inglesDisponible(TODAS, null)).tono === "gris", "sin la tabla nueva, el inglés está apagado");

    // El Simulador: respuestas viejas no dicen nada nuevo; las nuevas, la celda.
    const csNueva = P.condicionesDelSimulador({ plantilla: { id: "en_ingles_usd", nombre: "Transfers (AI) · USD", segmento: "extranjero", codigo: "regla", celda: { idioma: "en", moneda: "USD" } }, condiciones: { fuente: "plantilla", segmento: "extranjero", codigo: "regla", detalle: "x", celda: { idioma: "en", moneda: "USD" } } });
    ok(csNueva?.texto === "Condiciones del PDF: plantilla «Transfers (AI) · USD» (traslado de la IA · inglés · dólares)" && !csNueva.ambar && csNueva.nota === null, "con la celda: la nombra (no el segmento) y sin la nota del tipo de cliente");
    const csCaida = P.condicionesDelSimulador({ plantilla: { id: "traslados_ia", nombre: "Traslados (IA)", segmento: "particular", codigo: "sin_plantilla_idioma", celda: { idioma: "en", moneda: "PEN" } }, condiciones: { fuente: "plantilla", segmento: "particular", codigo: "sin_plantilla_idioma", detalle: "Traslado de la IA · inglés · soles: sin regla. …", celda: { idioma: "en", moneda: "PEN" } } });
    ok(!!csCaida && csCaida.ambar && /«Traslados \(IA\)», en castellano/.test(csCaida.texto) && csCaida.texto.includes("traslado de la IA · inglés · soles no tiene una plantilla en inglés") && csCaida.enlace?.tipo === "plantillas",
      "sin plantilla en inglés: la de castellano, dicho, en ámbar y con el enlace a asignar una");
    const csAj = P.condicionesDelSimulador({ plantilla: null, condiciones: { fuente: "ajustes", segmento: "particular", codigo: "sin_plantilla_idioma", detalle: "x", celda: { idioma: "en", moneda: "PEN" } } });
    ok(!!csAj && csAj.ambar && /Ajustes de traslados, en castellano/.test(csAj.texto), "sin plantilla en inglés y su castellano en Ajustes: lo dice");
    const csSinP = P.condicionesDelSimulador({ plantilla: null, condiciones: { fuente: "ajustes", segmento: "particular", codigo: "sin_plantilla", detalle: "x", celda: { idioma: "es", moneda: "PEN" } } });
    ok(!!csSinP && /en el idioma de la cotización/.test(csSinP.detalle!) && csSinP.detalle!.includes("traslado de la IA · castellano · soles") && csSinP.nota === null, "sin plantilla con la celda: nombra la celda que hay que asignar");
    ok(P.condicionesDelSimulador({ plantilla: { id: "x_y", nombre: "X", codigo: "regla", celda: { idioma: "fr", moneda: "EUR" } } }) === null, "una celda deforme sin segmento no dice nada");

    // La línea del idioma en el Simulador.
    const ING3 = P.mensajesDelSimulador("Hello, I need a transfer from the airport tomorrow\nWe are 3 people with 2 bags\nThank you so much, see you");
    ok(ING3.length === 3 && ING3[0].startsWith("Hello") && ING3[2].startsWith("Thank you"), "los mensajes van en el orden del chat: el de abajo es el más reciente, y va último");
    const iEn = P.idiomaDelSimulador({ idioma: { idioma: "en", cliente: "en", codigo: "ingles", detalle: "El cliente escribe en inglés." }, resultado: { moneda: "USD" } }, { telefono: TEL.PEN, mensajes_cliente: ING3 });
    ok(iEn?.texto === "Idioma: inglés (3 mensajes) · moneda USD (cliente en inglés)" && iEn.tono === "azul" && iEn.ingles, `la frase pedida («${iEn?.texto}»)`);
    const iOff = P.idiomaDelSimulador({ idioma: { idioma: "es", cliente: "en", codigo: "ingles_apagado", detalle: "x" }, resultado: { moneda: "PEN" } }, { telefono: TEL.PEN, mensajes_cliente: ING3 });
    ok(iOff?.texto === "Inglés apagado: no hay plantilla en inglés asignada" && iOff.tono === "gris" && iOff.enlace === "/cotizaciones/plantillas" && !iOff.ingles, "con el inglés apagado: lo dice y dónde se enciende");
    ok(iOff?.detalle === "x" && /ninguna celda «Traslado de la IA · inglés»/.test(P.idiomaDelSimulador({ idioma: { idioma: "es", cliente: "en", codigo: "ingles_apagado", detalle: "" } }, { mensajes_cliente: ING3 })?.detalle ?? ""),
      "debajo, el motivo que dio el servidor (o, sin él, el de siempre)");
    const PT = P.mensajesDelSimulador("Olá, preciso de um transfer do aeroporto amanhã");
    const iOtro = P.idiomaDelSimulador({ idioma: { idioma: "en", cliente: "otro", codigo: "otro_idioma", detalle: "x" }, resultado: { moneda: "PEN" } }, { telefono: TEL.PEN, mensajes_cliente: PT });
    ok(iOtro?.texto === "Idioma: inglés, porque el cliente escribe en otro idioma (1 mensaje) · moneda PEN (número peruano)", `otro idioma: inglés, con la moneda de su número («${iOtro?.texto}»)`);
    const iSoles = P.idiomaDelSimulador({ idioma: { idioma: "en", cliente: "en", codigo: "ingles", detalle: "x" }, resultado: { moneda: "PEN" } }, { telefono: TEL.USD, pide_soles: true, mensajes_cliente: ING3 });
    ok(/moneda PEN \(pidió soles\)$/.test(iSoles?.texto ?? ""), "pide soles: la moneda dice por qué");
    const iNoCuadra = P.idiomaDelSimulador({ idioma: { idioma: "en", cliente: "en", codigo: "ingles", detalle: "x" }, resultado: { moneda: "USD" } }, { telefono: TEL.USD, pide_soles: true, mensajes_cliente: ING3 });
    ok(/moneda USD$/.test(iNoCuadra?.texto ?? ""), "si el motor no cotizó en la moneda que se recalcula, no se afirma un motivo");
    const iEs = P.idiomaDelSimulador({ idioma: { idioma: "es", cliente: null, codigo: "sin_evidencia", detalle: "x" }, resultado: { moneda: "PEN" } }, { telefono: TEL.PEN, mensajes_cliente: ["ok", "25/12 15:00"] });
    ok(iEs?.texto === "Idioma: castellano (ningún mensaje dice el idioma) · moneda PEN (número peruano)" && iEs.tono === "gris", "mensajes sin idioma: castellano, dicho");
    ok(P.idiomaDelSimulador({ idioma: { idioma: "es", cliente: null, codigo: "sin_evidencia", detalle: "x" }, resultado: { moneda: "PEN" } }, { telefono: TEL.PEN }) === null, "sin mensajes y en castellano: nada nuevo que decir");
    ok(P.idiomaDelSimulador({ idioma: { idioma: "en", cliente: "en", codigo: "ingles", detalle: "x" }, resultado: { moneda: "USD" } }, { telefono: TEL.PEN, mensajes_cliente: ["Hola, quiero un traslado mañana"] })?.texto === "Idioma: inglés · moneda USD (cliente en inglés)",
      "si lo escrito aquí no da el mismo idioma que el servidor, no se cuentan mensajes");
    for (const vieja of [null, undefined, {}, { resultado: { moneda: "USD" } }, { idioma: null }, { idioma: { idioma: "fr", cliente: "en", codigo: "ingles" } }, { idioma: { idioma: "en", cliente: "xx", codigo: "ingles" } }, { idioma: { idioma: "en", cliente: "en", codigo: "inventado" } }]) {
      ok(P.idiomaDelSimulador(vieja as Parameters<typeof P.idiomaDelSimulador>[0], { telefono: TEL.PEN, mensajes_cliente: ING3 }) === null, `una respuesta sin «idioma» (o deforme) no dice nada nuevo: ${JSON.stringify(vieja)}`);
    }
    // Los mensajes: los 10 últimos renglones, de 500 unidades como mucho y sin partir un emoji.
    const doce = Array.from({ length: 12 }, (_, i) => `mensaje ${i + 1}`).join("\n");
    const m10 = P.mensajesDelSimulador(`  \n${doce}\n\n   `);
    ok(m10.length === P.MAX_MENSAJES_SIMULADOR && m10[0] === "mensaje 3" && m10[9] === "mensaje 12", "los 10 últimos renglones con texto, en el orden del chat");
    // El orden importa: se miran los 3 últimos que deciden. Dos en inglés y, al final, tres en castellano → castellano.
    const mezcla = P.mensajesDelSimulador("Hello, I need a transfer from the airport\nWe are 3 people with 2 bags\nHola, quiero un traslado mañana\n¿Cuánto cuesta?\nGracias, somos dos personas");
    ok(P.idiomaDeMensajesSimulador(mezcla).idioma === "es", "manda lo más reciente (los de abajo): el cliente que pasó al castellano es castellano");
    ok(P.idiomaDeMensajesSimulador([...mezcla].reverse()).idioma === "en", "y al revés, inglés (la detección da vuelta la lista: los lee del más reciente al más antiguo)");
    ok(P.mensajesDelSimulador("x".repeat(600))[0].length === P.MAX_CARACTERES_MENSAJE_SIMULADOR, "un renglón largo se recorta a 500");
    const conEmoji = P.mensajesDelSimulador(`${"a".repeat(499)}😀 fin`)[0];
    ok(conEmoji.length === 499 && !/[\uD800-\uDBFF]$/.test(conEmoji), "el recorte no parte un emoji");
    ok(P.mensajesDelSimulador("").length === 0 && P.mensajesDelSimulador(null).length === 0, "vacío: ningún mensaje");
    ok(P.puedePedirSoles("en") && P.puedePedirSoles("otro") && !P.puedePedirSoles("es") && !P.puedePedirSoles(null), "«Pide soles» solo en inglés u otro idioma");
    ok(P.idiomaDeMensajesSimulador(ING3).idioma === "en" && P.idiomaDeMensajesSimulador(PT).idioma === "otro" && P.idiomaDeMensajesSimulador(["¿Cuánto cuesta?"]).idioma === "es"
      && P.idiomaDeMensajesSimulador(["ok", "👍"]).idioma === null, "la detección del simulador es la del chat");
    // El contrato con POST /api/traslados/simular: los mensajes en el orden del chat (el servidor los da
    // vuelta) y `pide_soles` suelto, que el servidor lee del cuerpo y solo toma con el inglés encendido.
    // La regla vive en lib/traslados/simular-idioma.ts (pura, la barre prueba-traslados-ia.mts § 25 h);
    // la ruta la importa y le pasa el `pide_soles` del cuerpo.
    const rutaSrc = fsA.readFileSync("app/api/traslados/simular/route.ts", "utf8");
    const idiomaSrc = fsA.readFileSync("lib/traslados/simular-idioma.ts", "utf8");
    ok(/\[\.\.\.x\.mensajes\]\.reverse\(\)/.test(idiomaSrc) && /from "@\/lib\/traslados\/simular-idioma"/.test(rutaSrc) && /pedido\.pide_soles === true/.test(rutaSrc),
      "la ruta da vuelta los mensajes (le llegan en el orden del chat) y lee el pedido de soles del cuerpo");
    const simSrc = fsA.readFileSync("components/tarifario/SimuladorTraslado.tsx", "utf8");
    ok(simSrc.includes("Lo que escribió el cliente (para probar el idioma)") && /\.\.\.\(mensajes\.length \? \{ mensajes_cliente: mensajes \} : \{\}\)/.test(simSrc)
      && /const pideSoles = f\.pideSoles && solesPermitido;/.test(simSrc) && /\.\.\.\(pideSoles \? \{ pide_soles: true as const \} : \{\}\)/.test(simSrc)
      && !/idioma_cliente:/.test(simSrc) && /disabled=\{!solesPermitido\}/.test(simSrc) && /idiomaDelSimulador\(resp, entrada\)/.test(simSrc),
      "el simulador manda los mensajes, el pedido de soles solo con lo escrito en inglés u otro idioma, y nunca fija el idioma él mismo");
    const ajSrc = fsA.readFileSync("components/tarifario/AjustesTraslado.tsx", "utf8");
    ok(/condicionesTrasladoIA\(plantillas\.plantillas, plantillas\.reglas, \{[^}]*\}, plantillas\.reglasTraslado\)/.test(ajSrc) && /lineasInglesIA\(inglesDisponible\(lectura\.plantillas, lectura\.reglasTraslado\)\)/.test(ajSrc),
      "Ajustes enseña las cuatro celdas con la regla nueva y la línea del inglés con inglesDisponible");
  }
}

console.log(`\n${oks} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
