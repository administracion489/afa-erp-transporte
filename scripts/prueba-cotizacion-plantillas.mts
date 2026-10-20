// Matriz de lib/cotizacion-plantillas.ts — npx tsx scripts/prueba-cotizacion-plantillas.mts
//
// Las plantillas del PDF: diseño, reglas de uso (servicio × segmento), condiciones fijadas en la fila
// (versión 2) y el editor honesto (CAMPOS_POR_DISENO contra el HTML real con valores centinela).
// Lo que no se puede aflojar, y la matriz fija:
//   · `plantillaParaUso` nunca devuelve una plantilla inactiva; en el traslado de la IA solo una que
//     el servidor sabe dibujar (o null); sin la tabla de reglas, el traslado de la IA devuelve null
//     (sigue con traslados_config) — y el corolario: con una regla válida, devuelve ESA.
//   · Abrir una cotización de antes y guardarla en versión 2 imprime EL MISMO HTML, en los cuatro
//     diseños y en los dos idiomas.
//   · Con versión 2, en español, la fila gana sobre la plantilla; en inglés no cambia nada.
//   · Un campo se ofrece en el editor ⟺ cambia el PDF de ese diseño.
//   · El SQL de la migración usa los mismos valores que el código (si ya existe).
import { readFileSync, existsSync } from "node:fs";
import * as P from "../lib/cotizacion-plantillas";
import { leerPlantillasYReglas } from "../lib/cotizacion-plantillas-datos";
import { considParaPdf, DEFAULT_CONSID_ES, CONSID_VERSION as CV_IDIOMA, esConsidFijada as fijadaIdioma, type ConsidCot } from "../lib/cotizacion-idioma";
import { htmlCotizacion, type EntradaPdfCot } from "../lib/cotizacion-pdf";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };
const J = (x: unknown) => JSON.stringify(x);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// RNG con semilla (mulberry32): el barrido es reproducible.
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

console.log("0. Catálogo y re-exportaciones");
{
  // (tsx puede cargar un módulo dos veces, como ESM y como CJS: se compara el comportamiento y el código, no la referencia).
  const fuentePl = readFileSync(new URL("../lib/cotizacion-plantillas.ts", import.meta.url), "utf8");
  ok(P.CONSID_VERSION === 2 && P.CONSID_VERSION === CV_IDIOMA && [{ version: 2 }, { version: 1 }, null, {}].every(v => P.esConsidFijada(v) === fijadaIdioma(v))
    && /export \{ CONSID_VERSION, esConsidFijada \}/.test(fuentePl) && !/function esConsidFijada|const CONSID_VERSION/.test(fuentePl), "CONSID_VERSION y esConsidFijada se re-exportan (una sola definición, en cotizacion-idioma)");
  ok(new Set(P.DISENOS).size === 4 && new Set(P.SERVICIOS_PLANTILLA).size === 4 && new Set(P.SEGMENTOS).size === 3, "4 diseños, 4 servicios, 3 segmentos, sin repetidos");
  ok(J(Object.keys(P.ETIQUETA_DISENO).sort()) === J([...P.DISENOS].sort()), "ETIQUETA_DISENO cubre los diseños");
  ok(J(Object.keys(P.ETIQUETA_SERVICIO).sort()) === J([...P.SERVICIOS_PLANTILLA].sort()) && J(Object.keys(P.DESCRIPCION_SERVICIO).sort()) === J([...P.SERVICIOS_PLANTILLA].sort()), "ETIQUETA/DESCRIPCION_SERVICIO cubren los servicios");
  ok(J(Object.keys(P.ETIQUETA_SEGMENTO).sort()) === J([...P.SEGMENTOS].sort()) && J(Object.keys(P.DESCRIPCION_SEGMENTO).sort()) === J([...P.SEGMENTOS].sort()), "ETIQUETA/DESCRIPCION_SEGMENTO cubren los segmentos");
  ok(J(Object.keys(P.CAMPOS_POR_DISENO).sort()) === J([...P.DISENOS].sort()), "CAMPOS_POR_DISENO tiene una fila por diseño");
  ok(J(Object.keys(P.ETIQUETA_CAMPO).sort()) === J([...P.CAMPOS_PLANTILLA].sort()), "ETIQUETA_CAMPO cubre los campos");
  ok(P.etiquetaCelda({ servicio: "turismo", segmento: "particular" }) === "Turismo · particular", "etiquetaCelda");
  // Cada diseño dibuja un documento DISTINTO (si `htmlCotizacion` dejara de reconocer uno, caería al corporativo).
  const e = P.ejemploParaVistaPrevia(new Date("2026-10-20T15:00:00Z"));
  const htmls = P.DISENOS.map(d => htmlCotizacion({ ...e, plantilla: d }).html);
  ok(new Set(htmls).size === 4 && htmls.every(h => !!h), "los cuatro diseños dibujan cuatro documentos distintos");
  ok(htmlCotizacion({ ...e, plantilla: "otra_cosa" }).html === htmls[0], "un diseño desconocido dibuja el corporativo");
}

console.log("1. disenoDe");
{
  const casos: [Any, P.Diseno][] = [
    [{ id: "corporativo" }, "corporativo"], [{ id: "moderno_fotos" }, "moderno_fotos"], [{ id: "turistico" }, "turistico"], [{ id: "ejecutivo" }, "ejecutivo"],
    [{ id: "corporativo", diseno: "ejecutivo" }, "ejecutivo"], [{ id: "traslados_ia", diseno: "corporativo" }, "corporativo"],
    [{ id: "mi_copia", diseno: "turistico" }, "turistico"], [{ id: "mi_copia" }, "corporativo"], [{ id: "mi_copia", diseno: null }, "corporativo"],
    [{ id: "moderno_fotos", diseno: "nada" }, "moderno_fotos"], [{ id: "x", diseno: " Moderno_Fotos " }, "moderno_fotos"], [{ id: "x", diseno: "" }, "corporativo"],
  ];
  for (const [p, d] of casos) ok(P.disenoDe(p) === d, `disenoDe(${J(p)}) = ${d}`);
}

console.log("2. segmentoDeCliente");
{
  const casos: [Any, Any, P.Segmento][] = [
    ["PEN", "b2b", "empresa"], ["PEN", "b2c", "particular"], ["PEN", null, "particular"], ["PEN", undefined, "particular"],
    ["USD", "b2b", "extranjero"], ["USD", "b2c", "extranjero"], ["USD", null, "extranjero"], ["usd", "b2b", "extranjero"],
    [null, "b2b", "empresa"], [undefined, " B2B ", "empresa"], ["EUR", "b2c", "particular"], ["PEN", "otro", "particular"],
  ];
  for (const [moneda, tipoCliente, s] of casos) ok(P.segmentoDeCliente({ moneda, tipoCliente }) === s, `segmento(${moneda}, ${tipoCliente}) = ${s}`);
}

console.log("3. servicioDeCotizacion y esTrasladoIA");
{
  const casos: [Any, P.ServicioPlantilla][] = [
    [{ traslado_json: { zona: 1 } }, "traslado_ia"], [{ traslado_json: {}, modo_servicio: "fijo" }, "traslado_ia"],
    [{ traslado_json: [], modo_servicio: "eventual" }, "eventual"], [{ traslado_json: null }, "eventual"], [{ traslado_json: "x" }, "eventual"],
    [{ modo_servicio: "fijo", tipo_servicio: "transporte_personal" }, "fijo"], [{ modo_servicio: "fijo", tipo_servicio: "full_day" }, "fijo"],
    [{ modo_servicio: "eventual", tipo_servicio: "full_day" }, "turismo"], [{ modo_servicio: "eventual", tipo_servicio: "multi_dia" }, "turismo"],
    [{ modo_servicio: "full_day" }, "turismo"], [{ modo_servicio: "multi_dia", tipo_servicio: null }, "turismo"],
    [{ modo_servicio: "eventual", tipo_servicio: "ida_retorno" }, "eventual"], [{}, "eventual"], [{ modo_servicio: null, tipo_servicio: "solo_ida" }, "eventual"],
  ];
  for (const [c, s] of casos) ok(P.servicioDeCotizacion(c) === s, `servicio(${J(c)}) = ${s}`);
  // esTrasladoIA se EXTRAJO de components/cotizaciones/pdf-traslado.ts: la vieja, copiada literal.
  const viejo = (cot: { traslado_json?: unknown } | null | undefined): boolean => { const tj = cot?.traslado_json; return !!tj && typeof tj === "object" && !Array.isArray(tj); };
  const vals = [undefined, null, {}, { a: 1 }, [], [1], "x", 0, 1, true, false];
  ok(vals.every(v => P.esTrasladoIA({ traslado_json: v }) === viejo({ traslado_json: v })) && P.esTrasladoIA(null) === viejo(null) && P.esTrasladoIA(undefined) === viejo(undefined), "esTrasladoIA = la de pdf-traslado.ts");
  const fuente = readFileSync(new URL("../components/cotizaciones/pdf-traslado.ts", import.meta.url), "utf8");
  ok(/export \{ esTrasladoIA \}/.test(fuente) && !/function esTrasladoIA/.test(fuente), "pdf-traslado.ts la re-exporta, sin copia propia");
}

const PL = (id: string, o: Partial<P.PlantillaFila> = {}): P.PlantillaFila => ({ id, nombre: "Plantilla " + id, activa: true, es_principal: false, diseno: null, idioma: "es", orden: 1, ...o });

console.log("4. sirveParaIA");
{
  const casos: [P.PlantillaFila | null, boolean][] = [
    [PL("corporativo"), true], [PL("traslados_ia", { diseno: "corporativo" }), true], [PL("x", { diseno: "corporativo", activa: null }), true],
    [PL("x", { diseno: "corporativo", idioma: "es_en" }), true], [PL("x", { diseno: "corporativo", idioma: null }), true],
    [PL("x", { diseno: "corporativo", idioma: "en" }), false], [PL("x", { diseno: "corporativo", idioma: "EN" }), false],
    [PL("x", { diseno: "corporativo", activa: false }), false], [PL("moderno_fotos"), false], [PL("x", { diseno: "ejecutivo" }), false], [null, false],
  ];
  for (const [p, s] of casos) ok(P.sirveParaIA(p) === s, `sirveParaIA(${J(p && { id: p.id, diseno: p.diseno, idioma: p.idioma, activa: p.activa })}) = ${s}`);
}

console.log("5. plantillaParaUso: barrido contra un oráculo escrito aparte, e invariantes");
{
  const DIS = ["corporativo", "moderno_fotos", "turistico", "ejecutivo"];
  const activa = (p: Any) => !!p && p.activa !== false;
  const disenoOr = (p: Any) => { const d = String(p.diseno ?? "").trim().toLowerCase(); if (DIS.includes(d)) return d; const i = String(p.id).trim().toLowerCase(); return DIS.includes(i) ? i : "corporativo"; };
  const iaOk = (p: Any) => activa(p) && disenoOr(p) === "corporativo" && String(p.idioma ?? "").trim().toLowerCase() !== "en";
  const oraculo = (u: Any, pls: P.PlantillaFila[], reglas: P.ReglaPlantilla[] | null): [string | null, P.CodigoUso] => {
    const esIA = u.servicio === "traslado_ia";
    const princ = pls.filter(p => p.es_principal === true && activa(p)).sort((a, b) => ((a.orden ?? Infinity) - (b.orden ?? Infinity)) || (a.id < b.id ? -1 : 1))[0] ?? null;
    const usable = (p: Any) => !!p && activa(p) && (!esIA || iaOk(p));
    const fb = (c: P.CodigoUso): [string | null, P.CodigoUso] => (usable(princ) ? [princ!.id, c] : [null, "sin_plantilla"]);
    if (reglas === null) return esIA ? [null, "sin_reglas"] : fb("sin_reglas");
    const celda = reglas.find(r => r.servicio === u.servicio && r.segmento === u.segmento);
    if (!celda) return fb("principal");
    const p = pls.find(x => x.id === celda.plantilla_id);
    if (!p || !activa(p)) return fb("regla_inactiva");
    if (esIA && !iaOk(p)) return fb("regla_no_sirve_ia");
    return [p.id, "regla"];
  };
  const pares = P.SERVICIOS_PLANTILLA.flatMap(servicio => P.SEGMENTOS.map(segmento => ({ servicio, segmento })));
  const codigos = new Set<string>();
  let n = 0, malOraculo = 0, malInv = 0, corolario = 0;
  const revisar = (u: Any, pls: P.PlantillaFila[], reglas: P.ReglaPlantilla[] | null, rotulo: string) => {
    n++;
    const r = P.plantillaParaUso(u, pls, reglas);
    codigos.add(r.codigo);
    const [eid, ecod] = oraculo(u, pls, reglas);
    if ((r.plantilla?.id ?? null) !== eid || r.codigo !== ecod) { if (malOraculo++ < 3) console.log(`    ${rotulo} ${J(u)}: ${r.plantilla?.id ?? null}/${r.codigo} ≠ ${eid}/${ecod}`); }
    const inv: string[] = [];
    if (r.plantilla && r.plantilla.activa === false) inv.push("devolvió una inactiva");
    if (u.servicio === "traslado_ia" && r.plantilla && !P.sirveParaIA(r.plantilla)) inv.push("traslado_ia con una que la IA no dibuja");
    if (reglas === null && u.servicio === "traslado_ia" && (r.plantilla !== null || r.codigo !== "sin_reglas")) inv.push("sin reglas, traslado_ia no es null/sin_reglas");
    if ((r.plantilla === null) !== (r.codigo === "sin_plantilla" || (r.codigo === "sin_reglas" && u.servicio === "traslado_ia"))) inv.push("plantilla null ⟺ sin_plantilla (o sin_reglas en la IA)");
    if (r.plantilla && r.codigo !== "regla" && r.plantilla.id !== P.plantillaPrincipal(pls)?.id) inv.push("sin regla obedecida devolvió otra que la principal");
    if (!String(r.detalle).trim()) inv.push("sin detalle");
    const celda = reglas?.find(x => x.servicio === u.servicio && x.segmento === u.segmento);
    const pc = celda ? pls.find(x => x.id === celda.plantilla_id) : null;
    if (pc && pc.activa !== false && (u.servicio !== "traslado_ia" || P.sirveParaIA(pc))) {
      corolario++;
      if (r.codigo !== "regla" || r.plantilla?.id !== pc.id) inv.push("con una regla válida no devolvió esa");
    }
    if (r.codigo === "regla" && r.plantilla?.id !== celda?.plantilla_id) inv.push("«regla» con otra plantilla que la de la celda");
    if (inv.length && malInv++ < 3) console.log(`    ${rotulo} ${J(u)}: ${inv.join("; ")}`);
  };
  // Enumeración: la principal × otra plantilla × reglas × los 12 pares.
  const principales: [string, P.PlantillaFila[]][] = [
    ["ninguna", [PL("corporativo")]],
    ["corp", [PL("corporativo", { es_principal: true })]],
    ["corp_en", [PL("corporativo", { es_principal: true, idioma: "en" })]],
    ["moderno", [PL("moderno_fotos", { es_principal: true }), PL("corporativo")]],
    ["inactiva", [PL("corporativo", { es_principal: true, activa: false })]],
    ["dos", [PL("corporativo", { es_principal: true, orden: 5 }), PL("ejecutivo", { es_principal: true, orden: 2 })]],
  ];
  const otras: [string, P.PlantillaFila][] = [
    ["corp", PL("x1", { diseno: "corporativo", orden: 9 })], ["corp_inactiva", PL("x1", { diseno: "corporativo", activa: false })],
    ["moderno", PL("x1", { diseno: "moderno_fotos" })], ["corp_en", PL("x1", { diseno: "corporativo", idioma: "en" })],
    ["activa_null", PL("x1", { diseno: "corporativo", activa: null })], ["sin_diseno", PL("x1")],
  ];
  for (const [np, base] of principales) for (const [no, x] of otras) {
    const pls = [...base, x];
    for (const u of pares) {
      const reglasV: [string, P.ReglaPlantilla[] | null][] = [
        ["null", null], ["vacias", []],
        ["celda→x1", [{ ...u, plantilla_id: "x1" }]], ["celda→corporativo", [{ ...u, plantilla_id: "corporativo" }]],
        ["celda→fantasma", [{ ...u, plantilla_id: "fantasma" }]], ["todas→x1", pares.map(q => ({ ...q, plantilla_id: "x1" }))],
        ["otra celda", pares.filter(q => q.servicio !== u.servicio || q.segmento !== u.segmento).map(q => ({ ...q, plantilla_id: "x1" }))],
      ];
      for (const [nr, reglas] of reglasV) revisar(u, pls, reglas, `${np}/${no}/${nr}`);
    }
  }
  // Barrido aleatorio.
  const r = rng(20261020);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  for (let k = 0; k < 3000; k++) {
    const npl = Math.floor(r() * 6);
    const pls: P.PlantillaFila[] = [];
    for (let i = 0; i < npl; i++) {
      pls.push(PL(pick(["corporativo", "moderno_fotos", "turistico", "ejecutivo", "p_a", "p_b", "traslados_ia"]) + (i > 3 ? "_" + i : ""), {
        diseno: pick([null, undefined, "corporativo", "moderno_fotos", "ejecutivo", "turistico", "basura", ""]) as Any,
        activa: pick([true, false, null, undefined]) as Any, es_principal: pick([true, false, false, null]) as Any,
        idioma: pick(["es", "en", "es_en", null, "EN"]) as Any, orden: pick([1, 2, 3, null]) as Any,
      }));
    }
    const ids = [...pls.map(p => p.id), "fantasma"];
    const reglas: P.ReglaPlantilla[] | null = r() < 0.15 ? null : P.normalizarReglas(pares.filter(() => r() < 0.5).map(q => ({ ...q, plantilla_id: pick(ids) })));
    for (const u of pares) revisar(u, pls, reglas, `azar#${k}`);
  }
  ok(malOraculo === 0, `${n - malOraculo}/${n} casos iguales al oráculo`);
  ok(malInv === 0, `invariantes (nunca inactiva, IA siempre dibujable o null, sin reglas en la IA → null): ${malInv} fallas`);
  ok(corolario > 1000, `corolario: ${corolario} casos con una regla válida, todos devuelven esa`);
  for (const c of ["regla", "principal", "regla_inactiva", "regla_no_sirve_ia", "sin_reglas", "sin_plantilla"]) ok(codigos.has(c), `el barrido produce «${c}»`);
  // Casos de lectura directa.
  const pls = [PL("corporativo", { es_principal: true }), PL("traslados_ia", { diseno: "corporativo" }), PL("tur", { diseno: "turistico" })];
  const rg: P.ReglaPlantilla[] = [{ servicio: "traslado_ia", segmento: "particular", plantilla_id: "traslados_ia" }, { servicio: "traslado_ia", segmento: "empresa", plantilla_id: "tur" }, { servicio: "turismo", segmento: "particular", plantilla_id: "tur" }];
  const a = P.plantillaParaUso({ servicio: "traslado_ia", segmento: "particular" }, pls, rg);
  ok(a.codigo === "regla" && a.plantilla?.id === "traslados_ia", "IA particular → traslados_ia por la regla");
  const b = P.plantillaParaUso({ servicio: "traslado_ia", segmento: "empresa" }, pls, rg);
  ok(b.codigo === "regla_no_sirve_ia" && b.plantilla?.id === "corporativo" && /no puede dibujar/.test(b.detalle), "IA empresa → la turística no sirve: la principal, y lo dice");
  const c = P.plantillaParaUso({ servicio: "turismo", segmento: "particular" }, pls, rg);
  ok(c.codigo === "regla" && c.plantilla?.id === "tur" && c.detalle.includes("Turismo · particular"), "turismo particular → la turística");
  const d = P.plantillaParaUso({ servicio: "fijo", segmento: "empresa" }, pls, null);
  ok(d.codigo === "sin_reglas" && d.plantilla?.id === "corporativo" && d.detalle.includes(P.SQL_PLANTILLAS_USO), "sin la tabla: la principal, y nombra el SQL");
  ok(P.reglasQueUsan(rg, "tur").length === 2 && P.reglasQueUsan(null, "tur").length === 0, "reglasQueUsan");
  ok(J(P.normalizarReglas([{ servicio: "turismo", segmento: "empresa", plantilla_id: "a" }, { servicio: "turismo", segmento: "empresa", plantilla_id: "b" }, { servicio: "otra", segmento: "empresa", plantilla_id: "a" }, { servicio: "fijo", segmento: "nadie", plantilla_id: "a" }, { servicio: "fijo", segmento: "empresa", plantilla_id: " " }, null, "x"]))
    === J([{ servicio: "turismo", segmento: "empresa", plantilla_id: "a" }]), "normalizarReglas: valores conocidos, una por celda");
}

// ── Datos comunes de los documentos ──────────────────────────────────────────
const AHORA = new Date("2026-10-20T15:00:00Z");
const COT: Any = {
  id: 77, numero_cotizacion: "Q-77", origen: "Lima", destino: "Paracas", km: 250, atencion: "Sra. Ruiz", asunto: "Paseo", punto_retorno: null,
  fecha_servicio: "2026-11-20", fecha_retorno: null, hora_ida: "06:30", hora_retorno: "18:00", tipo_servicio: "ida_retorno", incluye_igv: true,
  itinerario_texto: "Día 1\n06:30 - Salida de Lima\n10:00 – Llegada a Paracas", created_at: "2026-10-01T15:00:00Z",
  paradas_json: [{ nombre: "Plaza", tipo: "inicio", hora: "06:30" }], fechas_multidia_json: null,
};
const ITEMS = [{ descripcion: "Traslado Lima - Paracas", dias: 1, cantidad: 1, precio_unit: 1200, descuento_pct: 0 }];
const CLIENTE = { nombre: "Contacto", empresa: "Minera Sur", tipo: "b2b", ruc: "20123456789", direccion: "Av. 1", telefono: "1" };
const EMP_SIN_CUENTAS: Any = { nombre: "Transportes Demo", ruc: "20999999991", telefono: "555", email: "a@b.pe", web: "b.pe", direccion: "Jr. 1", cuentas_bancarias: [] };
const EMP_CON_CUENTAS: Any = { ...EMP_SIN_CUENTAS, cuentas_bancarias: [{ banco: "Banco Demo", cuenta: "191-1", cci: "002-1" }] };
const doc = (o: Partial<EntradaPdfCot>) => htmlCotizacion({ cot: COT, cliente: CLIENTE, items: ITEMS, vehiculos: [], repr: "Ana", empresa: EMP_SIN_CUENTAS, ahora: AHORA, ...o });

console.log("6. considSnapshot");
{
  const resp: ConsidCot = { incluye: ["R inc"], no_incluye: ["R no"], generales: ["R gen"] };
  const p = PL("p1", { condiciones_incluye: ["P inc"], condiciones_no_incluye: null, condiciones_generales: [] });
  const s = P.considSnapshot(p, resp);
  ok(J(s) === J({ incluye: ["P inc"], no_incluye: ["R no"], generales: [], version: 2, plantilla: "p1" }), "NULL → respaldo; [] → []; versión 2 y la plantilla");
  ok(s.incluye !== p.condiciones_incluye && s.no_incluye !== resp.no_incluye, "copia las listas (editar la fila no toca la plantilla ni el respaldo)");
  ok(J(P.considSnapshot(null, resp)) === J({ ...resp, version: 2, plantilla: null }), "sin plantilla: el respaldo, con plantilla null");
  ok(P.esConsidFijada(s) && !P.esConsidFijada(resp), "el snapshot está fijado");
  // Con una fila de antes como respaldo, el snapshot en español imprime lo mismo que la regla vieja.
  const cfgs: Any[] = [null, {}, { condiciones_incluye: ["A"], condiciones_no_incluye: [], condiciones_generales: null }, { condiciones_generales: ["G"] }];
  const filas: ConsidCot[] = [DEFAULT_CONSID_ES, { incluye: ["X"], no_incluye: [], generales: ["Y"] }];
  for (const cfg of cfgs) for (const f of filas) {
    const viejo = considParaPdf(cfg, f, "es");
    const nuevo = considParaPdf(null, P.considSnapshot(cfg ? { id: "c", nombre: "c", ...cfg } : null, f), "es");
    ok(J([viejo.incluye, viejo.no_incluye, viejo.generales]) === J([nuevo.incluye, nuevo.no_incluye, nuevo.generales]), `snapshot(cfg ${J(cfg)}, fila) imprime lo mismo que la regla vieja`);
  }
}

console.log("7. El ciclo: abrir una cotización de antes y guardarla en versión 2 imprime lo mismo");
{
  const cfgs: Any[] = [
    null, {},
    { condiciones_incluye: ["A1", "A2"], condiciones_no_incluye: ["B1"], condiciones_generales: ["G1"] },
    { condiciones_incluye: [], condiciones_no_incluye: null, condiciones_generales: ["G solo"] },
    { condiciones_incluye: null, condiciones_no_incluye: [], condiciones_generales: [] },
    { condiciones_incluye: [...DEFAULT_CONSID_ES.incluye], condiciones_no_incluye: [...DEFAULT_CONSID_ES.no_incluye], condiciones_generales: [...DEFAULT_CONSID_ES.generales] },
  ];
  const filas: (Any | null)[] = [
    null, DEFAULT_CONSID_ES, JSON.parse(J(DEFAULT_CONSID_ES)),
    { incluye: ["Agua"], no_incluye: [], generales: ["Pago al contado."] },
    { incluye: DEFAULT_CONSID_ES.incluye, no_incluye: ["Peajes"], generales: DEFAULT_CONSID_ES.generales },
    { incluye: [], no_incluye: [], generales: [] },
    P.considSnapshot(PL("corporativo", { condiciones_incluye: ["Fijada"] }), DEFAULT_CONSID_ES),
  ];
  let n = 0, igualesListas = 0, igualesHtml = 0, nHtml = 0;
  for (const cfg of cfgs) for (const fila of filas) for (const idioma of ["es", "en"] as const) {
    n++;
    const antes = considParaPdf(cfg, fila ?? DEFAULT_CONSID_ES, idioma);
    const form = P.considParaFormulario(cfg, fila, idioma);
    const guardada = { incluye: form.incluye, no_incluye: form.no_incluye, generales: form.generales, version: P.CONSID_VERSION, plantilla: "cualquiera" };
    const despues = considParaPdf(cfg, guardada, idioma);
    if (J([antes.incluye, antes.no_incluye, antes.generales, antes.escritasTalCual]) === J([despues.incluye, despues.no_incluye, despues.generales, despues.escritasTalCual])) igualesListas++;
    else console.log(`    listas cfg=${J(cfg)} fila=${J(fila)} ${idioma}: ${J(antes)} ≠ ${J(despues)}`);
    for (const d of P.DISENOS) {
      nHtml++;
      const h1 = doc({ consid: fila ?? undefined, cfg, plantilla: d, idioma }).html;
      const h2 = doc({ consid: guardada, cfg, plantilla: d, idioma }).html;
      if (h1 === h2) igualesHtml++; else if (nHtml - igualesHtml <= 2) console.log(`    html ${d} cfg=${J(cfg)} fila=${J(fila)} ${idioma} difiere`);
    }
  }
  ok(igualesListas === n, `listas y escritasTalCual idénticas: ${igualesListas}/${n}`);
  ok(igualesHtml === nHtml, `HTML idéntico en los cuatro diseños: ${igualesHtml}/${nHtml}`);
  // Lo que el formulario CARGA hoy (`c.consideraciones_json || DEFAULT`) no cumplía el ciclo: es el defecto.
  const cfg = cfgs[2];
  const cargabaAntes = DEFAULT_CONSID_ES;
  const imprimiaAntes = considParaPdf(cfg, cargabaAntes, "es");
  const conLoQueCargaba = considParaPdf(cfg, { ...cargabaAntes, version: 2 } as Any, "es");
  ok(J(imprimiaAntes.incluye) !== J(conLoQueCargaba.incluye), "regresión: guardar lo que el formulario cargaba antes SÍ cambiaba el PDF");
  ok(P.considParaFormulario(cfg, null, "es").incluye.join() === "A1,A2" && P.considParaFormulario(cfg, null, "en").incluye.join() === DEFAULT_CONSID_ES.incluye.join(), "sin fila: en español lo que imprime la plantilla; en inglés las de fábrica");
  const f2 = P.considParaFormulario(cfg, filas[6], "es");
  ok(f2.version === 2 && f2.plantilla === "corporativo" && f2.incluye.join() === "Fijada", "una fila fijada se carga tal cual, con su versión y su plantilla");
  const copia = P.considParaFormulario(cfg, filas[3], "en");
  ok(copia.incluye !== filas[3].incluye && J(copia.incluye) === J(filas[3].incluye), "el formulario recibe COPIAS (editar no toca la fila leída)");
}

console.log("8. Versión 2: en español gana la fila; en inglés no cambia nada");
{
  const cfg: Any = { condiciones_incluye: ["DE LA PLANTILLA"], condiciones_no_incluye: ["NO DE LA PLANTILLA"], condiciones_generales: ["GEN DE LA PLANTILLA"] };
  const fila = { incluye: ["DE LA FILA"], no_incluye: [], generales: ["GEN DE LA FILA"] };
  const v2 = { ...fila, version: 2, plantilla: "corporativo" };
  const es = considParaPdf(cfg, v2, "es");
  ok(J([es.incluye, es.no_incluye, es.generales, es.escritasTalCual]) === J([fila.incluye, [], fila.generales, []]), "es + v2: las listas de la fila");
  ok(J(considParaPdf(cfg, v2, "en")) === J(considParaPdf(cfg, fila, "en")), "en + v2: igual que sin versión");
  ok(J(considParaPdf(cfg, { ...fila, version: "2" } as Any, "es").incluye) === J(cfg.condiciones_incluye), "version «2» en texto no fija (regla de siempre)");
  const roto = considParaPdf(cfg, { incluye: "texto", no_incluye: null, generales: ["ok"], version: 2 } as Any, "es");
  ok(J([roto.incluye, roto.no_incluye, roto.generales]) === J([[], [], ["ok"]]), "v2 con una lista dañada: vacía, nunca la de la plantilla");
  for (const [v, s] of [[{ version: 2 }, true], [{ version: 1 }, false], [{ version: "2" }, false], [{}, false], [null, false], [[2], false], [2, false]] as [unknown, boolean][]) ok(P.esConsidFijada(v) === s, `esConsidFijada(${J(v)}) = ${s}`);
  for (const d of P.DISENOS) {
    const h = doc({ consid: v2, cfg, plantilla: d }).html!;
    ok(h.includes("DE LA FILA") && !h.includes("DE LA PLANTILLA"), `${d}: imprime la fila, no la plantilla`);
  }
  // El aviso en inglés ya no nombra «las condiciones de la plantilla» si la fila está fijada.
  const avEn = (consid: Any) => doc({ consid, cfg: { ...cfg, titulo_documento: "T" }, idioma: "en", plantilla: "moderno_fotos" }).avisos.find(a => a.codigo === "plantilla_en_espanol")?.detalle ?? "";
  ok(/las condiciones de la plantilla/.test(avEn(fila)) && !/las condiciones de la plantilla/.test(avEn(v2)) && /el título del documento/.test(avEn(v2)), "aviso en inglés: con v2 no nombra las condiciones de la plantilla");
}

console.log("9. CAMPOS_POR_DISENO contra el HTML (valores centinela)");
{
  // Cada campo, su par (sin, con centinela). «cambia» = el HTML no es el mismo.
  type Prueba = (d: P.Diseno) => boolean;
  const cambia = (a: Partial<EntradaPdfCot>, b: Partial<EntradaPdfCot>) => doc(a).html !== doc(b).html;
  const lista = (k: "condiciones_incluye" | "condiciones_no_incluye" | "condiciones_generales"): Prueba => d => {
    // Fila de antes: la plantilla manda al imprimir.
    const viejo = cambia({ plantilla: d, cfg: {}, consid: DEFAULT_CONSID_ES }, { plantilla: d, cfg: { [k]: ["LISTA CENTINELA"] }, consid: DEFAULT_CONSID_ES });
    // Fila nueva: la plantilla se COPIA a la fila y el PDF imprime la fila.
    const nuevo = cambia({ plantilla: d, cfg: null, consid: P.considSnapshot(PL("p"), DEFAULT_CONSID_ES) }, { plantilla: d, cfg: null, consid: P.considSnapshot(PL("p", { [k]: ["LISTA CENTINELA"] }), DEFAULT_CONSID_ES) });
    if (viejo !== nuevo) console.log(`    ${d}/${k}: el camino viejo (${viejo}) y el de la versión 2 (${nuevo}) no coinciden`);
    return viejo && nuevo;
  };
  const texto = (k: string, v: string): Prueba => d => {
    const h = doc({ plantilla: d, cfg: { [k]: v } as Any }).html!;
    return h !== doc({ plantilla: d, cfg: {} }).html && h.includes(v);
  };
  const PRUEBAS: Record<Exclude<P.CampoPlantilla, "idioma">, Prueba> = {
    titulo_documento: texto("titulo_documento", "TITULO CENTINELA"),
    mensaje_cierre: texto("mensaje_cierre", "CIERRE CENTINELA"),
    color_primario: texto("color_primario", "#a1b2c3"),
    color_secundario: texto("color_secundario", "#b2c3d4"),
    color_acento: texto("color_acento", "#c3d4e5"),
    condiciones_incluye: lista("condiciones_incluye"),
    condiciones_no_incluye: lista("condiciones_no_incluye"),
    condiciones_generales: lista("condiciones_generales"),
    // Las cuentas: las propias de la plantilla (sin cuentas en la empresa) o apagarlas (con cuentas en la empresa).
    cuentas: d => cambia({ plantilla: d, cfg: {} }, { plantilla: d, cfg: { usar_bancos_propios: true, banco_1_nombre: "BANCO CENTINELA", banco_1_cuenta: "111", banco_1_cci: "" } })
      || cambia({ plantilla: d, cfg: {}, empresa: EMP_CON_CUENTAS }, { plantilla: d, cfg: { mostrar_cuentas_bancarias: false }, empresa: EMP_CON_CUENTAS }),
  };
  const leido: Record<string, string[]> = {};
  for (const d of P.DISENOS) {
    leido[d] = [];
    for (const [campo, prueba] of Object.entries(PRUEBAS) as [Exclude<P.CampoPlantilla, "idioma">, Prueba][]) {
      const lee = prueba(d);
      if (lee) leido[d].push(campo);
      ok(lee === P.leeCampo(d, campo), `${d}/${campo}: ${lee ? "cambia" : "no cambia"} el PDF y la tabla dice ${P.leeCampo(d, campo) ? "que lo lee" : "que no"}`);
    }
    ok(P.leeCampo(d, "idioma"), `${d}: el idioma se ofrece (lo lee el formulario de la cotización)`);
  }
  console.log("    medido: " + P.DISENOS.map(d => `${d} = ${leido[d].join(", ")}`).join(" | "));
  // Corolario: la prueba distingue (cada diseño lee algo y cada campo lo lee alguno).
  ok(P.DISENOS.every(d => leido[d].length >= 3), "cada diseño lee al menos tres campos");
  ok((Object.keys(PRUEBAS)).every(c => P.DISENOS.some(d => leido[d].includes(c))), "cada campo lo lee al menos un diseño");
  // Lo que el editor de hoy ofrece y ningún diseño lee: no cambia el PDF de ninguno.
  const NUNCA: Record<string, unknown> = {
    fuente: "Georgia", subtitulo: "SUBTITULO CENTINELA", mostrar_logo: false, mostrar_fotos_vehiculo: false, mostrar_itinerario: false,
    mostrar_precio_pax: false, mostrar_sla: false, mostrar_firma: true, firma_url: "https://x.test/firma.png", recomendado_para: "B2B", icono: "🚌", descripcion: "x",
  };
  for (const d of P.DISENOS) for (const [k, v] of Object.entries(NUNCA)) {
    ok(!cambia({ plantilla: d, cfg: {} }, { plantilla: d, cfg: { [k]: v } as Any }), `${d}/${k}: no lo lee (no se ofrece)`);
  }
}

console.log("10. idNuevaPlantilla");
{
  const casos: [string, string[], string, string][] = [
    ["Traslado aeropuerto", [], "a1b2", "traslado_aeropuerto"],
    ["  Ñandú VIP  ", [], "a1b2", "nandu_vip"],
    ["Corporativo", ["corporativo"], "Zx9!", "corporativo_zx9"],
    ["Moderno fotos", [], "q1", "moderno_fotos_q1"],
    ["Traslados IA", [], "k7", "traslados_ia_k7"],
    ["", [], "abc", "plantilla"],
    ["a", ["plantilla"], "abc", "plantilla_abc"],
    ["Mi copia", ["mi_copia", "mi_copia_abc"], "abc", "mi_copia_2"],
    ["Mi copia", ["mi_copia"], "", "mi_copia_2"],
    ["Mi copia", ["MI_COPIA"], "", "mi_copia_2"],
  ];
  for (const [nombre, ex, az, esp] of casos) ok(P.idNuevaPlantilla(nombre, ex, az) === esp, `idNuevaPlantilla(${J(nombre)}, ${J(ex)}, ${J(az)}) = ${esp} (dio ${P.idNuevaPlantilla(nombre, ex, az)})`);
  const largo = P.idNuevaPlantilla("Plantilla con un nombre larguísimo para clientes corporativos de la costa", ["plantilla_con_un_nombre_larguisimo_para"], "zz99");
  ok(P.esIdPlantillaValido(largo) && largo.length <= 40 && largo.endsWith("_zz99"), `nombre largo → ${largo}`);
  // Barrido.
  const r = rng(7);
  const letras = "abcñáéíóúü ÁÉÍÓÚÑ_-.,;:!?¿¡/\\\"'()[]{}#&%$0123456789 🚌 xyzXYZ";
  const tomados: string[] = [];
  let mal = 0;
  for (let k = 0; k < 4000; k++) {
    const nombre = Array.from({ length: Math.floor(r() * 70) }, () => letras[Math.floor(r() * letras.length)]).join("");
    const azar = Array.from({ length: Math.floor(r() * 12) }, () => letras[Math.floor(r() * letras.length)]).join("");
    const ex = r() < 0.5 ? tomados.slice(-50) : [...tomados.slice(-20), ...P.DISENOS];
    const id = P.idNuevaPlantilla(nombre, ex, azar);
    if (!P.RE_ID_PLANTILLA.test(id) || ex.includes(id) || P.IDS_RESERVADOS.includes(id)) { if (mal++ < 3) console.log(`    ${J(nombre)} → ${id}`); }
    tomados.push(id);
  }
  ok(mal === 0, `4000 nombres al azar: formato válido, nunca un id tomado ni reservado (${mal} fallas)`);
  ok(P.IDS_RESERVADOS.includes(P.ID_PLANTILLA_TRASLADOS) && P.IDS_RESERVADOS.includes(P.ID_PLANTILLA_TRASLADOS_USD) && P.DISENOS.every(d => P.IDS_RESERVADOS.includes(d)), "reservados: diseños y los ids de la migración");
  ok(!P.esIdPlantillaValido("ab") && !P.esIdPlantillaValido("a".repeat(41)) && !P.esIdPlantillaValido("Mayus") && !P.esIdPlantillaValido("con-guion") && P.esIdPlantillaValido("abc") && !P.esIdPlantillaValido(null), "esIdPlantillaValido");
}

console.log("11. avisoCondicionesDeOtraPlantilla");
{
  const nombres: Record<string, string> = { corporativo: "Clásico", tur: "Turismo" };
  const nombreDe = (id: string) => nombres[id] ?? null;
  const v2 = P.considSnapshot(PL("tur", { nombre: "Turismo" }), DEFAULT_CONSID_ES);
  const a = P.avisoCondicionesDeOtraPlantilla(v2, { id: "corporativo", nombre: "Clásico" }, nombreDe);
  ok(!!a && a.codigo === "condiciones_de_otra_plantilla" && !a.bloquea && a.detalle.includes("«Turismo»") && a.detalle.includes("«Clásico»"), "fijada con otra plantilla → aviso que nombra las dos");
  ok(P.avisoCondicionesDeOtraPlantilla(v2, { id: "tur", nombre: "Turismo" }, nombreDe) === null, "con la misma plantilla → nada");
  ok(P.avisoCondicionesDeOtraPlantilla(DEFAULT_CONSID_ES, { id: "corporativo", nombre: "Clásico" }, nombreDe) === null, "fila de antes → nada");
  ok(P.avisoCondicionesDeOtraPlantilla(null, { id: "corporativo", nombre: "Clásico" }, nombreDe) === null, "sin fila → nada");
  ok(P.avisoCondicionesDeOtraPlantilla({ ...v2, plantilla: null }, { id: "corporativo", nombre: "Clásico" }, nombreDe) === null, "fijada sin plantilla → nada");
  ok(P.avisoCondicionesDeOtraPlantilla({ ...v2, plantilla: "borrada" }, { id: "corporativo", nombre: "Clásico" }, nombreDe)!.detalle.includes("«borrada»"), "plantilla sin nombre → su id");
}

console.log("12. Vista previa sin datos reales, y ningún nombre de empresa en el código");
{
  const e = P.ejemploParaVistaPrevia(AHORA);
  const txt = J(e);
  ok(!/\bafa\b|tours peru|transportes afa/i.test(txt), "el ejemplo no lleva datos de la empresa");
  ok(e.cot.fecha_servicio === "2026-10-27" && e.cot.created_at === AHORA.toISOString() && e.ahora === AHORA, "fechas del ejemplo desde `ahora`");
  ok(e.consid === undefined && !("cfg" in e) && !("empresa" in e) && !("plantilla" in e), "sin consid, cfg, empresa ni plantilla (los pone quien llama)");
  for (const d of P.DISENOS) {
    const h = htmlCotizacion({ ...e, plantilla: d, cfg: null, empresa: null }).html;
    ok(!!h && h.includes("Cliente de ejemplo"), `${d}: el ejemplo se dibuja`);
  }
  const codigo = readFileSync(new URL("../lib/cotizacion-plantillas.ts", import.meta.url), "utf8").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok(!/\bafa\b|tours peru/i.test(codigo), "lib/cotizacion-plantillas.ts no nombra a la empresa");
  const codigoDatos = readFileSync(new URL("../lib/cotizacion-plantillas-datos.ts", import.meta.url), "utf8");
  ok(!/\bafa\b|tours peru/i.test(codigoDatos), "lib/cotizacion-plantillas-datos.ts no nombra a la empresa");
}

console.log("13. leerPlantillasYReglas (base falsa)");
{
  type Resp = { data?: Any[]; error?: Any; lanza?: boolean };
  const sbFalso = (tablas: Record<string, Resp | ((rango: [number, number] | null) => Resp)>) => ({
    from(t: string) {
      let rango: [number, number] | null = null;
      const q: Any = {
        select: () => q, order: () => q,
        range: (a: number, b: number) => { rango = [a, b]; return q; },
        then: (res: (v: Any) => unknown, rej: (e: unknown) => unknown) => {
          const def = tablas[t];
          const r = typeof def === "function" ? def(rango) : def;
          if (!r) return Promise.resolve({ data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${t}' in the schema cache` } }).then(res, rej);
          if (r.lanza) return Promise.reject(new Error("red caída")).then(res, rej);
          const data = r.data && rango ? r.data.slice(rango[0], rango[1] + 1) : r.data ?? null;
          return Promise.resolve({ data: r.error ? null : data, error: r.error ?? null }).then(res, rej);
        },
      };
      return q;
    },
  });
  const pls = [{ id: "corporativo", nombre: "Clásico", diseno: "corporativo", es_principal: true, activa: true, orden: 1 }, { id: "tur", nombre: null, diseno: "turistico", activa: true, orden: 2 }, { id: null }, { id: "  " }];
  const reglas = [{ servicio: "turismo", segmento: "particular", plantilla_id: "tur" }, { servicio: "nada", segmento: "particular", plantilla_id: "tur" }];
  const a = await leerPlantillasYReglas(sbFalso({ cotizacion_plantillas: { data: pls }, cotizacion_plantilla_reglas: { data: reglas } }));
  ok(a.ok && a.plantillas.length === 2 && a.plantillas[1].nombre === "tur" && J(a.reglas) === J([reglas[0]]) && !a.sinDiseno && a.error === null, "normal: plantillas válidas, reglas normalizadas, con diseño");
  const b = await leerPlantillasYReglas(sbFalso({ cotizacion_plantillas: { data: pls } }));
  ok(b.ok && b.reglas === null && b.plantillas.length === 2, "falta la tabla de reglas → reglas null (y ok)");
  const c = await leerPlantillasYReglas(sbFalso({ cotizacion_plantillas: { data: pls }, cotizacion_plantilla_reglas: { error: { code: "42501", message: "permission denied" } } }));
  ok(!c.ok && c.reglas === null && /reglas de uso/.test(c.error ?? "") && /permission denied/.test(c.error ?? ""), "otro error en las reglas → ok:false con el motivo (nunca «sin reglas»)");
  const d = await leerPlantillasYReglas(sbFalso({ cotizacion_plantillas: { data: pls }, cotizacion_plantilla_reglas: { lanza: true } }));
  ok(!d.ok && /red caída/.test(d.error ?? ""), "una excepción en las reglas → ok:false");
  const e = await leerPlantillasYReglas(sbFalso({ cotizacion_plantillas: { data: [{ id: "corporativo", nombre: "C", es_principal: true }] }, cotizacion_plantilla_reglas: { data: [] } }));
  ok(e.ok && e.sinDiseno && J(e.reglas) === "[]", "filas sin la clave `diseno` → sinDiseno; tabla de reglas vacía → []");
  const f = await leerPlantillasYReglas(sbFalso({ cotizacion_plantillas: { error: { code: "XX000", message: "boom" } }, cotizacion_plantilla_reglas: { data: [] } }));
  ok(!f.ok && /plantillas del PDF/.test(f.error ?? "") && f.plantillas.length === 0, "error en las plantillas → ok:false");
  const g = await leerPlantillasYReglas(sbFalso({}));
  ok(g.ok && g.plantillas.length === 0 && g.reglas === null, "sin la tabla de plantillas → ok, vacío y sin reglas");
  const muchas = Array.from({ length: 1500 }, (_, i) => ({ id: `p_${String(i).padStart(4, "0")}`, nombre: "x", diseno: "corporativo" }));
  const h = await leerPlantillasYReglas(sbFalso({ cotizacion_plantillas: { data: muchas }, cotizacion_plantilla_reglas: { data: [] } }));
  ok(h.ok && h.plantillas.length === 1500, `pagina: ${h.plantillas.length}/1500 plantillas`);
  let segunda = false;
  const i = await leerPlantillasYReglas(sbFalso({ cotizacion_plantillas: (rg) => { if (rg && rg[0] > 0) { segunda = true; return { error: { message: "corte" } }; } return { data: muchas }; }, cotizacion_plantilla_reglas: { data: [] } }));
  ok(segunda && !i.ok && /corte/.test(i.error ?? ""), "una página que falla → ok:false, no la primera página sola");
}

console.log("14. El SQL de la migración");
{
  const dir = new URL("../supabase/", import.meta.url);
  const uno = "cotizaciones-05-plantillas-uso.sql";
  const partes = existsSync(new URL(uno, dir)) ? [uno]
    : ["cotizaciones-05a-plantillas-diseno.sql", "cotizaciones-05b-plantillas-reglas.sql"].filter(n => existsSync(new URL(n, dir)));
  if (!partes.length) {
    console.log(`    ⏳ todavía no existe supabase/${uno} (ni 05a/05b): se comprueba cuando datos-sql lo entregue.`);
  } else {
    const sqls = partes.map(n => ({ n, sql: readFileSync(new URL(n, dir), "utf8") }));
    for (const { n, sql } of sqls) {
      const lineas = sql.replace(/\n+$/, "").split("\n");
      ok(lineas.length < 100, `${n}: menos de 100 líneas (${lineas.length})`);
      ok(lineas[lineas.length - 1] === `-- FIN de ${n}`, `${n}: termina en «-- FIN de ${n}»`);
      const codigo = sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
      ok(!/\bselect\b(?:(?!;|\bfrom\b|\binsert\b)[\s\S])*?\binto\b/i.test(codigo), `${n}: sin «SELECT … INTO»`);
      ok(!/create\s+(temp|temporary)\s+table/i.test(codigo), `${n}: sin «create temp table»`);
      ok(P.SQL_PLANTILLAS_USO.includes(n), `SQL_PLANTILLAS_USO nombra ${n}`);
    }
    const todo = sqls.map(s => s.sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n")).join("\n");
    const valores = (col: string): string[] | null => {
      const m = new RegExp(`\\b${col}\\s+in\\s*\\(([^)]*)\\)`, "i").exec(todo) ?? new RegExp(`\\b${col}\\s*=\\s*any\\s*\\(\\s*array\\s*\\[([^\\]]*)\\]`, "i").exec(todo);
      return m ? [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]).sort() : null;
    };
    ok(J(valores("servicio")) === J([...P.SERVICIOS_PLANTILLA].sort()), `CHECK de servicio = SERVICIOS_PLANTILLA (${J(valores("servicio"))})`);
    ok(J(valores("segmento")) === J([...P.SEGMENTOS].sort()), `CHECK de segmento = SEGMENTOS (${J(valores("segmento"))})`);
    ok(J(valores("diseno")) === J([...P.DISENOS].sort()), `CHECK de diseno = DISENOS (${J(valores("diseno"))})`);
    ok(new RegExp(`create table if not exists public\\.${P.TABLA_REGLAS}\\b`).test(todo) && todo.includes(`public.${P.TABLA_PLANTILLAS}`), "las tablas se llaman como en el código");
    ok(/primary key\s*\(\s*servicio\s*,\s*segmento\s*\)/i.test(todo), "una celda, una plantilla: primary key (servicio, segmento)");
    ok(new RegExp(`revoke all on public\\.${P.TABLA_REGLAS} from anon`, "i").test(todo), "revoke … from anon en la tabla de reglas");
    ok(todo.includes(`'${P.ID_PLANTILLA_TRASLADOS}'`) && todo.includes(`'${P.ID_PLANTILLA_TRASLADOS_USD}'`), "los ids del traspaso son los del código");
    ok(todo.includes(`'${P.RE_ID_PLANTILLA.source}'`), `el CHECK del id usa el mismo formato (${P.RE_ID_PLANTILLA.source})`);
    // Lo que el traspaso crea, la IA tiene que poder usarlo.
    ok(/'diseno',\s*'corporativo'/.test(todo) && /'idioma',\s*'es'/.test(todo) && /'activa',\s*true/.test(todo) && /'es_principal',\s*false/.test(todo), "el traspaso crea plantillas corporativas, en castellano, activas y no principales (sirveParaIA)");
    ok(/'traslado_ia',\s*'empresa'/.test(todo) && /'traslado_ia',\s*'particular'/.test(todo) && /'traslado_ia',\s*'extranjero'/.test(todo), "el traspaso llena las tres celdas del traslado de la IA");
  }
}

console.log(fallos ? `\n${fallos} FALLAN (${oks} ok)` : `\nTODO OK (${oks} comprobaciones)`);
process.exit(fallos ? 1 : 0);
