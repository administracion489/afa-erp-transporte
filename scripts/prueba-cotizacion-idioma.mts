// Matriz de lib/cotizacion-idioma.ts — npx tsx scripts/prueba-cotizacion-idioma.mts
import {
  TEXTOS_PDF, t, normalizarIdioma, fmtFechaDoc, fmtImporte, considParaPdf, descripcionServicio, descripcionParaPdf,
  DEFAULT_CONSID_ES, DEFAULT_CONSID_EN, etiquetaNivelIdioma, type ClaveTexto,
} from "../lib/cotizacion-idioma";
import { htmlCotizacion } from "../lib/cotizacion-pdf";
import { etiquetaNivel, equipamientoDeNivel, nivelDeFicha } from "../lib/costos/nivel-servicio";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };

console.log("1. Diccionario completo");
{
  const claves = Object.keys(TEXTOS_PDF.es) as ClaveTexto[];
  ok(claves.length > 50, `${claves.length} claves`);
  ok(JSON.stringify(Object.keys(TEXTOS_PDF.en).sort()) === JSON.stringify([...claves].sort()), "es y en tienen las mismas claves");
  for (const k of claves) ok(TEXTOS_PDF.es[k].trim() !== "" && TEXTOS_PDF.en[k].trim() !== "", `«${k}» no vacía en es y en`);
  for (const k of claves) {
    const ph = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join(",");
    ok(ph(TEXTOS_PDF.es[k]) === ph(TEXTOS_PDF.en[k]), `«${k}» mismas variables en es y en`);
  }
  ok(t("es", "corp_th_punit", { m: "S/" }) === "P. UNIT S/ sin IGV", "t reemplaza variables");
  for (const v of [null, undefined, "", "fr", "ES", 3]) ok(normalizarIdioma(v) === "es", `idioma ${JSON.stringify(v)} → es`);
  ok(normalizarIdioma("EN") === "en", "EN → en");
  ok(DEFAULT_CONSID_ES.incluye.length === DEFAULT_CONSID_EN.incluye.length && DEFAULT_CONSID_ES.no_incluye.length === DEFAULT_CONSID_EN.no_incluye.length && DEFAULT_CONSID_ES.generales.length === DEFAULT_CONSID_EN.generales.length, "consideraciones de fábrica: misma forma en es y en");
}

console.log("2. Fechas");
{
  const MESES_ES = /enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene\.|feb\.|mar\.|abr\.|jun\.|jul\.|ago\.|sept?\.|oct\.|nov\.|dic\.|lun|mié|jue|vie|sáb|dom/i;
  for (let m = 1; m <= 12; m++) for (const est of ["larga_mayus", "corta", "cronograma", "simple"] as const) {
    const iso = `2026-${String(m).padStart(2, "0")}-15`;
    ok(!MESES_ES.test(fmtFechaDoc(iso, "en", est)), `en ${est} ${iso}: «${fmtFechaDoc(iso, "en", est)}» sin español`);
  }
  // es = lo que hacían los generadores
  ok(fmtFechaDoc("2026-11-20", "es", "larga_mayus") === new Date("2026-11-20T00:00:00").toLocaleDateString("es-PE", { day: "numeric", month: "long", year: "numeric" }).toUpperCase(), "es larga = vieja");
  ok(fmtFechaDoc("2026-11-20", "es", "cronograma") === new Date("2026-11-20T00:00:00").toLocaleDateString("es-PE", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).toUpperCase(), "es cronograma = vieja");
  ok(fmtImporte(1234.5, "PEN", "es") === `S/ ${(1234.5).toLocaleString("es-PE", { minimumFractionDigits: 2 })}`, "PEN es = formato viejo");
  ok(fmtImporte(1234.5, "USD", "en") === "US$ 1,234.50", "USD en");
}

console.log("3. Consideraciones");
{
  const cfgs = [null, undefined, {}, { condiciones_incluye: ["A"] }, { condiciones_incluye: [], condiciones_no_incluye: ["B"], condiciones_generales: null }];
  const consids = [DEFAULT_CONSID_ES, { incluye: ["X"], no_incluye: [], generales: ["Y"] }];
  for (const cfg of cfgs as any[]) for (const c of consids) {
    const r = considParaPdf(cfg, c, "es");
    ok(r.incluye === (cfg?.condiciones_incluye || c.incluye) && r.no_incluye === (cfg?.condiciones_no_incluye || c.no_incluye) && r.generales === (cfg?.condiciones_generales || c.generales), `es = regla vieja (cfg ${JSON.stringify(cfg)})`);
    const e = considParaPdf(cfg, c, "en");
    if (c === DEFAULT_CONSID_ES) ok(JSON.stringify([e.incluye, e.no_incluye, e.generales]) === JSON.stringify([DEFAULT_CONSID_EN.incluye, DEFAULT_CONSID_EN.no_incluye, DEFAULT_CONSID_EN.generales]) && e.escritasTalCual.length === 0, "en: las de fábrica se traducen y la plantilla no manda");
    else ok(e.incluye === c.incluye && e.escritasTalCual.includes("incluye"), "en: lo escrito va tal cual y se avisa");
  }
  const casi = { ...DEFAULT_CONSID_ES, incluye: [...DEFAULT_CONSID_ES.incluye.slice(0, -1), "Seguro SOAT"] };
  const e = considParaPdf(null, casi, "en");
  ok(e.incluye === casi.incluye && e.no_incluye[0] === DEFAULT_CONSID_EN.no_incluye[0], "solo se traduce por igualdad exacta, lista por lista");
}

console.log("4. Descripción del ítem");
{
  // El compositor VIEJO del efecto «Auto-construir descripción» de app/cotizaciones/page.tsx, literal.
  const viejo = (form: { modo_servicio: string; tipo_vehiculo: string }, paramsDB: { tipo_vehiculo: string; nombre: string }[]) => {
    const servLbl=form.modo_servicio==="fijo"?"SERVICIO DE TRANSPORTE DE PERSONAL":"SERVICIO DE TRANSPORTE TURÍSTICO";
    const tipoNom=paramsDB.find(p=>p.tipo_vehiculo===form.tipo_vehiculo)?.nombre||"";
    const equipLbl=etiquetaNivel(equipamientoDeNivel(nivelDeFicha(form.tipo_vehiculo)));
    const yaLoDice=/full\s*equipo|est[aá]ndar/i.test(tipoNom);
    const autoDesc=tipoNom?`${servLbl} - ${tipoNom}${equipLbl&&!yaLoDice?" "+equipLbl:""}`:servLbl;
    return autoDesc;
  };
  const params = [{ tipo_vehiculo: "BUS_50", nombre: "Bus 50 pax" }, { tipo_vehiculo: "BUS_50_ESTANDAR", nombre: "Bus 50 pax · Estándar (>10 años)" }, { tipo_vehiculo: "VAN", nombre: "Van Full Equipo" }];
  for (const modo of ["fijo", "eventual", ""]) for (const tv of ["BUS_50", "BUS_50_ESTANDAR", "VAN", "NADA", ""]) {
    const nom = params.find(p => p.tipo_vehiculo === tv)?.nombre || "";
    const ctx = { modo_servicio: modo, tipo_vehiculo: tv, tipoNombre: nom };
    ok(descripcionServicio(ctx, "es") === viejo({ modo_servicio: modo, tipo_vehiculo: tv }, params), `es = compositor viejo (${modo}/${tv})`);
    const auto = descripcionServicio(ctx, "es");
    const r = descripcionParaPdf(auto, ctx, "en");
    ok(r.recompuesta && r.texto === descripcionServicio(ctx, "en") && !/SERVICIO|TURÍSTICO|PERSONAL$/.test(r.texto), `en recompone la automática (${r.texto})`);
    ok(!descripcionParaPdf(auto + " ", ctx, "en").recompuesta, "un espacio de más ya es texto de una persona");
    ok(descripcionParaPdf(auto, ctx, "es").texto === auto, "es nunca recompone");
  }
  ok(etiquetaNivelIdioma("basico", "en") === "STANDARD" && etiquetaNivelIdioma(null, "en") === "FULL EQUIPMENT" && etiquetaNivelIdioma("basico", "es") === etiquetaNivel("basico"), "nivel en ambos idiomas");
}

console.log("5. PDF en inglés sin textos fijos en español (4 plantillas × 2 monedas)");
{
  const frag = new Set<string>();
  const enVals = new Set(Object.values(TEXTOS_PDF.en));
  for (const [k, v] of Object.entries(TEXTOS_PDF.es)) {
    if (enVals.has(v) || v === TEXTOS_PDF.en[k as ClaveTexto]) continue;
    for (const p of v.split(/\{\w+\}/)) { const s = p.trim(); if (s.length >= 4 && ![...enVals].some(e => e.includes(s))) frag.add(s); }
  }
  for (const l of [...DEFAULT_CONSID_ES.incluye, ...DEFAULT_CONSID_ES.no_incluye, ...DEFAULT_CONSID_ES.generales]) frag.add(l);
  for (const w of ["pasajeros", "vehículos", "Dir.:", "UNIDAD", "PASAJEROS", "noviembre", "NOVIEMBRE", "Bus con capacidad"]) frag.add(w);
  const vehs = [{ categoria: null, capacidad_pasajeros: 50, equipamiento: null, foto_externa_url: null, foto_interna_url: null, descripcion_unidad: null }, { categoria: "BUS", capacidad_pasajeros: 20, equipamiento: "basico", foto_externa_url: null, foto_interna_url: null, descripcion_unidad: null }];
  const cfg = { titulo_documento: "MI TÍTULO", mensaje_cierre: "Gracias por su preferencia", condiciones_incluye: ["Agua"], color_primario: "#123456" };
  const emp = { nombre: "Demo Transport", ruc: "20999999991", direccion: "Jr. Lima 100", telefono: "555", email: "a@b.pe", web: "b.pe", cuentas_bancarias: [{ banco: "BCP", cuenta: "1", cci: "2" }] };
  for (const p of ["corporativo", "moderno_fotos", "turistico", "ejecutivo"]) for (const moneda of ["PEN", "USD"]) for (const igv of [true, false]) for (const retorno of [null, "2026-11-21"]) {
    const ctx = { modo_servicio: "eventual", tipo_vehiculo: "BUS_50", tipoNombre: "Bus 50 pax" };
    const cot = {
      id: 7, numero_cotizacion: "Q-1", origen: "Lima", destino: "Paracas", km: 250, atencion: "Mr. Smith", asunto: "Trip", punto_retorno: null,
      fecha_servicio: "2026-11-20", fecha_retorno: retorno, hora_ida: "06:30", hora_retorno: "18:00", tipo_servicio: "ida_retorno", incluye_igv: igv,
      itinerario_texto: null, created_at: "2026-10-01T15:00:00Z", paradas_json: [{ nombre: "Main Square", tipo: "inicio", hora: "06:30" }],
      fechas_multidia_json: [{ dia: 1, fecha: "2026-11-20", hora_ida: "06:00", destino_nombre: "Ica", hora_fin: "", tipo_noche: "pernocte" }, { dia: 2, fecha: "2026-11-21", hora_ida: "07:00", destino_nombre: "Lima", tipo_noche: "cochera" }, { dia: 3, fecha: "2026-11-22", hora_ida: "", destino_nombre: "" }],
      modo_servicio: ctx.modo_servicio, tipo_vehiculo: ctx.tipo_vehiculo, moneda, tipo_cambio: 3.75, idioma_pdf: "en",
    };
    const items = [{ descripcion: descripcionServicio(ctx, "es"), dias: 1, cantidad: 1, precio_unit: 1000, descuento_pct: 5 }, { descripcion: "Extra hours", dias: 1, cantidad: 2, precio_unit: 80, descuento_pct: 0 }, { descripcion: "Tolls", dias: 1, cantidad: 1, precio_unit: 40, descuento_pct: 0 }];
    const r = htmlCotizacion({ cot, cliente: { nombre: "Acme Corp", tipo: "b2b", empresa: "Acme Corp", ruc: "20111111111", direccion: "Main St 1", telefono: "1" }, items, vehiculos: vehs, repr: "Ann", consid: DEFAULT_CONSID_ES, plantilla: p, cfg, empresa: emp, tipoVehiculoNombre: ctx.tipoNombre });
    const h = r.html!;
    const encontrados = [...frag].filter(f => h.includes(f));
    ok(encontrados.length === 0, `${p} ${moneda} IGV=${igv} ret=${!!retorno}: sin español${encontrados.length ? " — " + encontrados.join(" | ") : ""}`);
    ok(h.includes('lang="en"'), `${p}: lang=en`);
    ok(r.avisos.some(a => a.codigo === "plantilla_en_espanol"), `${p}: avisa de los textos de la plantilla`);
    ok(!h.includes("MI TÍTULO") && !h.includes("Gracias"), `${p}: no imprime los textos libres de la plantilla`);
  }
  // Corolario: el detector sí encuentra español en el mismo documento pedido en español.
  ok(frag.size > 60, `${frag.size} fragmentos fijos en español vigilados`);
  {
    const r = htmlCotizacion({ cot: { id: 7, numero_cotizacion: "Q-1", origen: "Lima", destino: "Paracas", km: 0, atencion: null, asunto: null, punto_retorno: null, fecha_servicio: "2026-11-20", fecha_retorno: null, hora_ida: null, hora_retorno: null, tipo_servicio: null, incluye_igv: true, itinerario_texto: null, created_at: "", idioma_pdf: "es" }, items: [{ descripcion: "x", dias: 1, cantidad: 1, precio_unit: 1, descuento_pct: 0 }], vehiculos: vehs, plantilla: "corporativo" });
    ok([...frag].filter(f => r.html!.includes(f)).length > 10, "en español el detector sí encuentra los textos fijos");
  }
  // Lo escrito en español va tal cual y se avisa con su código
  const r2 = htmlCotizacion({ cot: { id: 1, numero_cotizacion: null, origen: "Lima", destino: "Ica", km: 0, atencion: null, asunto: null, punto_retorno: null, fecha_servicio: null, fecha_retorno: null, hora_ida: null, hora_retorno: null, tipo_servicio: null, incluye_igv: true, itinerario_texto: "Día 1\nSalida", created_at: "", idioma_pdf: "en" }, items: [{ descripcion: "Traslado a Ica", dias: 1, cantidad: 1, precio_unit: 100, descuento_pct: 0 }], vehiculos: [], consid: { incluye: ["Agua"], no_incluye: [], generales: [] } });
  ok(r2.html!.includes("Traslado a Ica") && r2.avisos.some(a => a.codigo === "textos_escritos_tal_cual"), "lo escrito va tal cual, con aviso textos_escritos_tal_cual");
}

console.log(fallos ? `\n${fallos} FALLAN (${oks} ok)` : `\nTODO OK (${oks} comprobaciones)`);
process.exit(fallos ? 1 : 0);
