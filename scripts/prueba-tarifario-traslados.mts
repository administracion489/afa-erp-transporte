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
    ok(JSON.stringify(enUso.segmentos) === JSON.stringify(leidaEn.generales) && JSON.stringify(leidaEn.incluye) === JSON.stringify(leidaEn.generales) && JSON.stringify(leidaEn.no_incluye) === JSON.stringify(leidaEn.generales),
      `${j.nombre}: se ofrecen consideraciones, Incluye y No incluye en los segmentos que las leen (${JSON.stringify(enUso.segmentos)} vs ${JSON.stringify(leidaEn.generales)})`);
    ok(enUso.enUso === (leidaEn.generales.length > 0), `${j.nombre}: las listas de Ajustes se editan ⟺ alguna fila las lee`);
    ok(enUso.usd === (leidaEn.usd.length > 0) && leidaEn.usd.every((x) => x === "extranjero"), `${j.nombre}: las de dólares se editan ⟺ alguna fila las lee (solo extranjero)`);
    const segsEnGrupos = grupos.flatMap((g) => g.segmentos.map((x) => x.segmento));
    ok(segsEnGrupos.length === 3 && PL.SEGMENTOS.every((sg) => segsEnGrupos.filter((x) => x === sg).length === 1), `${j.nombre}: cada segmento sale en un solo grupo`);
    ok(new Set(grupos.map((g) => g.clave)).size === grupos.length, `${j.nombre}: un grupo por fuente`);
    for (const segmento of PL.SEGMENTOS) {
      nCond++;
      const g = grupos.find((x) => x.segmentos.some((y) => y.segmento === segmento))!;
      const su = g.segmentos.find((y) => y.segmento === segmento)!;
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
  ok(gT.length === 2 && gT[0].segmentos.map((x) => x.segmento).join() === "empresa,particular" && P.segmentosTexto(gT[0]) === "empresa y particular", "el traspaso: empresa y particular juntos, extranjero aparte");
  ok(gT[1].incluye.propia === false && gT[1].incluye.items.length === 0, "lista NULL de la plantilla: «sin lista propia», nunca la de Ajustes");
  ok(!gT.some((g) => g.generales.items.some((x) => x.includes("15 minutos"))), "con plantillas, las consideraciones de Ajustes no se enseñan");
  // Sin una plantilla que la IA pueda usar: las de Ajustes, y en dólares con las de dólares.
  const gN = P.condicionesTrasladoIA([], [], CONFIGS[0]);
  ok(gN.length === 2 && gN.every((g) => g.fuente.tipo === "ajustes" && g.segmentos.every((x) => x.codigo === "sin_plantilla" && x.ambar)), "sin plantillas: las de Ajustes, en ámbar");
  ok(gN[1].generales.items.join("|") === "Precios por tramo. No incluyen IGV.|Incluye 15 minutos de espera.|Pago al tipo de cambio del día", "extranjero sin plantilla: generales + las de dólares, limpias");

  // La política de reserva (cotizaciones-06): Ajustes enseña la MISMA que la IA copia a la fila.
  {
    const POL = ["  Se confirma con el 50 % de adelanto. ", "", "Cancelación con 24 horas o más: sin costo."];
    const plsR = [CORP, { ...TIA, condiciones_reserva: POL }, { ...TUSD, condiciones_reserva: null }];
    const gR = P.condicionesTrasladoIA(plsR, JUEGOS[0].reglas, CONFIGS[0]);
    for (const segmento of PL.SEGMENTOS) {
      const g = gR.find((x) => x.segmentos.some((y) => y.segmento === segmento))!;
      const uso = PL.plantillaParaUso({ servicio: "traslado_ia", segmento }, plsR, JUEGOS[0].reglas);
      const usd = segmento === "extranjero";
      const cj = C.filaCotizacionTraslado(usd ? rUsd : rPen, entradaT(usd ? TEL.USD : TEL.PEN), {
        convId: "c", clienteId: null, atencion: null, config: { validez_dias: 30, espera_gratis_min: 30, ...CONFIGS[0] } as unknown as CfgT, firma: "f", hoy: HOY, plantilla: uso.plantilla,
      }).consideraciones_json;
      ok(JSON.stringify(g.reserva.items) === JSON.stringify(cj.reserva ?? []), `${segmento}: la política que enseña Ajustes = la que copia la IA (${JSON.stringify(g.reserva.items)} vs ${JSON.stringify(cj.reserva)})`);
      ok(g.reserva.propia === Array.isArray((uso.plantilla as any)?.condiciones_reserva), `${segmento}: «sin política» ⟺ la plantilla no la tiene`);
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
      const g = gS.find((x) => x.segmentos.some((y) => y.segmento === segmento))!;
      const uso = PL.plantillaParaUso({ servicio: "traslado_ia", segmento }, plsS, JUEGOS[0].reglas);
      const usd = segmento === "extranjero";
      const cj = C.filaCotizacionTraslado(usd ? rUsd : rPen, entradaT(usd ? TEL.USD : TEL.PEN), {
        convId: "c", clienteId: null, atencion: null, config: { validez_dias: 30, espera_gratis_min: 30, ...CONFIGS[0] } as unknown as CfgT, firma: "f", hoy: HOY, plantilla: uso.plantilla,
      }).consideraciones_json as { reserva?: string[]; reserva_resumen?: string[] };
      ok(JSON.stringify(g.reserva_resumen.items) === JSON.stringify(cj.reserva_resumen ?? []), `${segmento}: el resumen que enseña Ajustes = el que copia la IA (${JSON.stringify(g.reserva_resumen.items)} vs ${JSON.stringify(cj.reserva_resumen)})`);
      ok(g.reserva_resumen.propia === Array.isArray((uso.plantilla as any)?.condiciones_reserva_resumen), `${segmento}: «sin resumen» ⟺ la plantilla no lo tiene`);
      ok(JSON.stringify(P.lineasPoliticaYResumen(g)) === JSON.stringify([...(cj.reserva ?? []), ...(cj.reserva_resumen ?? [])]), `${segmento}: lineasPoliticaYResumen = la política y su resumen, en ese orden`);
    }
    const conPol = gS.find((g) => g.reserva.items.length > 0)!;
    ok(JSON.stringify(conPol.reserva_resumen.items) === JSON.stringify(["Adelanto del 50 %.", "Sin costo con 24 h."]), "limpio: sin espacios de más ni líneas vacías");
    const sinPol = gS.find((g) => g.fuente.tipo === "plantilla" && (g.fuente as any).plantilla.id === TUSD.id);
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
  ok(eN.length === 1 && eN[0].plantilla === null && eN[0].minutos.join() === "15" && eN[0].segmentos.join() === "empresa,particular,extranjero" && /aquí abajo/.test(eN[0].texto),
    "sin plantilla: las de Ajustes UNA vez (es el mismo texto), con sus tipos de cliente");

  // Mixto: unos segmentos con plantilla, otros caen a Ajustes.
  const gMix = P.condicionesTrasladoIA([CORP, TIA], r3("traslados_ia", "moderno_fotos", "apagada"), CONFIGS[0]); // sin principal activa → caen
  const gMix2 = P.condicionesTrasladoIA([{ ...CORP, es_principal: false }, TIA], r3("traslados_ia", "moderno_fotos", "apagada"), CONFIGS[0]);
  ok(P.listasDeAjustesEnUso(gMix).enUso === false, "con la principal que sirve, nadie cae a Ajustes: no se ofrecen");
  const uMix = P.listasDeAjustesEnUso(gMix2);
  ok(uMix.enUso && uMix.usd && JSON.stringify(uMix.segmentos) === JSON.stringify(["particular", "extranjero"]), "particular y extranjero caen a Ajustes: se ofrecen, con las de dólares");
  const eMix = P.esperaQueNoCoincideIA(gMix2, 30);
  ok(eMix.length === 1 && eMix[0].plantilla === null && eMix[0].segmentos.join() === "particular,extranjero", "la espera se coteja también con las de Ajustes donde caen");
  const uPen = P.listasDeAjustesEnUso(P.condicionesTrasladoIA([{ ...MOD, es_principal: true }, { ...CORP, es_principal: false }, OFF], r3("apagada", "apagada", "corporativo"), CONFIGS[0]));
  ok(uPen.enUso && !uPen.usd && JSON.stringify(uPen.segmentos) === JSON.stringify(["empresa", "particular"]), "solo los de soles caen: las de dólares no se ofrecen");
  ok(JSON.stringify(P.listasDeAjustesEnUso(null)) === JSON.stringify({ enUso: true, usd: true, segmentos: null }), "sin reglas (o sin poder comprobarlo): las cuatro, como antes");
  ok(P.avisoListasAjustes({ enUso: true, usd: true, segmentos: null }) === null && P.avisoListasAjustes({ enUso: false, usd: false, segmentos: [] }) === null, "sin reglas o sin segmentos que caigan: no hay aviso de segmentos");
  const avPen = P.avisoListasAjustes(uPen)!;
  ok(avPen.includes("empresa y particular") && avPen.includes("Los demás usan su plantilla.") && avPen.includes("dólares no se ofrecen"), "el aviso nombra los segmentos, dice que los demás usan su plantilla y por qué no salen las de dólares");
  const avTodos = P.avisoListasAjustes({ enUso: true, usd: true, segmentos: ["empresa", "particular", "extranjero"] })!;
  ok(!avTodos.includes("Los demás") && !avTodos.includes("no se ofrecen") && /Plantillas PDF/.test(avTodos), "con los tres: ni «los demás» ni las de dólares");
  ok(/ese tipo de cliente/.test(P.avisoListasAjustes({ enUso: true, usd: true, segmentos: ["extranjero"] })!), "con uno solo, en singular");

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
  ok(/considDeTraslado\(u\.plantilla, config, usd \? "USD" : "PEN"\)/.test(pantallaSrc) && !/considSnapshot/.test(pantallaSrc) && !/\.trim\(\)\)\.filter\(Boolean\)/.test(pantallaSrc),
    "la pantalla usa la copia de la fila (considDeTraslado), no una suya");
}

console.log(`\n${oks} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
