// Matriz de lib/cotizaciones-filtros.ts. Uso: npx tsx scripts/prueba-cotizaciones-filtros.mts
import {
  rangoDePeriodo, limitesConsulta, hoyLimaISO, sumarDias, textoBuscable, filtrarLista, kpisDe,
  colsSelect, COLS_LISTA, PERIODOS, ETIQUETA_PERIODO, PERIODO_DEFECTO, type Periodo, type CotLista,
} from "../lib/cotizaciones-filtros";
import { coincideBusqueda, terminosBusqueda } from "../lib/busqueda-texto";

let ok = 0, fallo = 0;
const fallos: string[] = [];
const check = (cond: boolean, nombre: string, detalle?: unknown) => {
  if (cond) ok++;
  else { fallo++; if (fallos.length < 40) fallos.push(`❌ ${nombre}${detalle !== undefined ? " → " + JSON.stringify(detalle) : ""}`); }
};
const seccion = (t: string) => { console.log(`\n── ${t}`); };
const fin = (t: string, antes: number) => console.log(`${fallo === antes ? "✅" : "❌"} ${t}`);

const diasEntre = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

/* ── (a) Barrido de rangoDePeriodo sobre 2026 y 2028 (bisiesto) ── */
seccion("(a) rangoDePeriodo, todos los días de 2026 y 2028");
{
  const f0 = fallo;
  let dias = 0;
  for (const anio of [2026, 2028]) {
    for (let d = `${anio}-01-01`; d.startsWith(String(anio)); d = sumarDias(d, 1)) {
      dias++;
      const manana = sumarDias(d, 1);
      for (const p of PERIODOS) {
        if (p === "rango" || p === "todo") continue;
        const r = rangoDePeriodo(p, d);
        check(r.codigo === "ok" && !!r.desde && !!r.hastaExcl, `${p} ${d} ok`, r);
        if (!r.desde || !r.hastaExcl) continue;
        check(r.desde < r.hastaExcl, `${p} ${d} desde<hastaExcl`, r);
        if (p !== "mes_anterior") check(r.hastaExcl === manana, `${p} ${d} hastaExcl=hoy+1`, r);
        if (p !== "mes_anterior") check(r.desde <= d, `${p} ${d} incluye hoy`, r);
      }
      check(diasEntre(...(Object.values(rangoDePeriodo("hoy", d)).slice(0, 2) as [string, string])) === 1, `hoy ${d} = 1 día`);
      const r7 = rangoDePeriodo("7d", d); check(diasEntre(r7.desde!, r7.hastaExcl!) === 7, `7d ${d} = 7 días`, r7);
      const r30 = rangoDePeriodo("30d", d); check(diasEntre(r30.desde!, r30.hastaExcl!) === 30, `30d ${d}`, r30);
      const r90 = rangoDePeriodo("90d", d); check(diasEntre(r90.desde!, r90.hastaExcl!) === 90, `90d ${d}`, r90);
      const rm = rangoDePeriodo("este_mes", d); check(rm.desde === d.slice(0, 7) + "-01", `este_mes ${d}`, rm);
      const ra = rangoDePeriodo("este_anio", d); check(ra.desde === `${anio}-01-01`, `este_anio ${d}`, ra);
      // mes anterior: mes completo y cerrado
      const ma = rangoDePeriodo("mes_anterior", d);
      const [y, m] = d.split("-").map(Number);
      const yp = m === 1 ? y - 1 : y, mp = m === 1 ? 12 : m - 1;
      const esperadoDesde = `${yp}-${String(mp).padStart(2, "0")}-01`;
      const largo = new Date(Date.UTC(yp, mp, 0)).getUTCDate();
      check(ma.desde === esperadoDesde, `mes_anterior ${d} desde`, ma);
      check(ma.hastaExcl === d.slice(0, 7) + "-01", `mes_anterior ${d} cerrado en el 1 del mes`, ma);
      check(diasEntre(ma.desde!, ma.hastaExcl!) === largo, `mes_anterior ${d} largo ${largo}`, ma);
      check(ma.hastaExcl! <= d, `mes_anterior ${d} ya cerrado`, ma);
    }
  }
  // cruce de año y bisiesto, explícitos
  check(JSON.stringify(rangoDePeriodo("mes_anterior", "2026-01-15")) === JSON.stringify({ desde: "2025-12-01", hastaExcl: "2026-01-01", codigo: "ok" }), "mes_anterior enero → diciembre previo");
  check(rangoDePeriodo("hoy", "2026-12-31").hastaExcl === "2027-01-01", "hoy 31/12 → 01/01");
  check(rangoDePeriodo("7d", "2026-01-03").desde === "2025-12-28", "7d cruza el año");
  check(diasEntre(...(Object.values(rangoDePeriodo("mes_anterior", "2028-03-10")).slice(0, 2) as [string, string])) === 29, "febrero 2028 bisiesto = 29");
  check(diasEntre(...(Object.values(rangoDePeriodo("mes_anterior", "2026-03-10")).slice(0, 2) as [string, string])) === 28, "febrero 2026 = 28");
  check(JSON.stringify(rangoDePeriodo("todo", "2026-05-05")) === JSON.stringify({ desde: null, hastaExcl: null, codigo: "ok" }), "todo sin límites");
  check(PERIODO_DEFECTO === "90d" && PERIODOS.every((p) => !!ETIQUETA_PERIODO[p]), "defecto y etiquetas");
  console.log(`  ${dias} días barridos`);
  fin("(a) rangos", f0);
}

/* ── (b) límites de consulta y hoy de Lima ── */
seccion("(b) limitesConsulta y hoyLimaISO");
{
  const f0 = fallo;
  const r = rangoDePeriodo("30d", "2026-10-15");
  const e = limitesConsulta("emision", r);
  check(e.columna === "created_at" && e.gte === "2026-09-16T00:00:00-05:00" && e.lt === "2026-10-16T00:00:00-05:00", "emisión con -05:00", e);
  const s = limitesConsulta("servicio", r);
  check(s.columna === "fecha_servicio" && s.gte === "2026-09-16" && s.lt === "2026-10-16", "servicio tal cual", s);
  const t = limitesConsulta("emision", rangoDePeriodo("todo", "2026-10-15"));
  check(t.gte === null && t.lt === null, "todo sin gte/lt", t);
  check(hoyLimaISO(new Date("2026-10-16T04:59:00Z")) === "2026-10-15", "23:59 Lima sigue siendo hoy");
  check(hoyLimaISO(new Date("2026-10-16T05:00:00Z")) === "2026-10-16", "00:00 Lima ya es mañana");
  check(hoyLimaISO(new Date("2027-01-01T03:00:00Z")) === "2026-12-31", "año nuevo UTC sigue 31/12 en Lima");
  fin("(b) límites", f0);
}

/* ── (c) filtro: nuevo vs VIEJO copiado literal ── */
seccion("(c) filtrarLista + textoBuscable vs filtro viejo");
{
  const f0 = fallo;
  type Cl = { id: number; empresa?: string; nombre: string; ruc?: string };
  const clientes: Cl[] = [
    { id: 1, nombre: "Rosa Quispe", empresa: "COMPAÑÍA HARD S.A.C.", ruc: "20123456789" },
    { id: 2, nombre: "Pedro Ruiz", empresa: "SNACKS AMERICA LATINA S.R.L.", ruc: "20555666777" },
    { id: 3, nombre: "María Núñez" },
    { id: 4, nombre: "Ángel Pérez", empresa: "" },
  ];
  const base = (o: Partial<CotLista>): CotLista => ({ id: 1, cliente_id: null, origen: "", destino: "", km: 0, precio_cliente: 0, costo_estimado: 0, margen_estimado: 0, estado: "pendiente", numero_cotizacion: null, atencion: null, asunto: null, punto_retorno: null, fecha_servicio: null, fecha_retorno: null, hora_ida: null, hora_retorno: null, descuento_pct: 0, tipo_vehiculo: null, tipo_servicio: null, equipamiento: null, vehiculo_flota_id: null, vehiculo_tercero_id: null, created_at: "2026-10-01T10:00:00Z", modo_servicio: null, dias_servicio: null, horas_servicio: null, pernocte_costo: null, precio_dia: null, precio_mes_estimado: null, precio_tarifario: null, precio_cotizador: null, costo_cotizador: null, margen_cotizador: null, vehiculo_cotizador: null, precio_sugerido: null, modo_precio: null, medio_envio: null, plantilla_pdf: null, enviado_automatico: false, incluye_igv: null, descuento_solicitado: false, descuento_pct_solicitado: null, descuento_autorizado: false, hora_solicitud_descuento: null, numero_aprobacion: null, tipo_aprobacion: null, ...o });
  const origenes = ["Lima", "Santa Anita", "PUNTA HERMOSA", "Callao"];
  const destinos = ["Ica", "Huacachina", "Planta Lurín", "BSF"];
  const estados = ["pendiente", "enviado", "aprobado", "rechazado", "borrador"];
  const modos: (string | null)[] = [null, "eventual", "fijo"];
  const cots: CotLista[] = [];
  let id = 1;
  for (const cl of [null, 1, 2, 3, 4, 99]) for (const e of estados) for (const m of modos) {
    const i = id;
    cots.push(base({
      id: i === 7 ? 42 : i + 100, cliente_id: cl, estado: e, modo_servicio: m,
      origen: origenes[i % 4], destino: destinos[(i * 3) % 4],
      asunto: i % 3 === 0 ? "Traslado de personal" : i % 3 === 1 ? "Full day turístico" : null,
      atencion: i % 2 ? "Sr. Gómez" : null,
      numero_cotizacion: i % 5 === 0 ? `COT-2026-${String(i).padStart(4, "0")}` : null,
      descuento_solicitado: i % 4 === 0, descuento_autorizado: i % 8 === 0,
    }));
    id++;
  }
  const busquedas = ["", "compania hard", "hard compañía", "COMPAÑIA", "00042", "42", "20123456789", "snacks latina", "santa", "huacachina full", "gomez", "cot 2026", "nunez maria", "zzz", "sac", "ángel", "lurin planta"];
  const estadosF = ["todos", ...estados];
  const modosF = ["todos", "eventual", "fijo"];
  // VIEJO, copiado literal de app/cotizaciones/page.tsx (const filtradas=…)
  const viejo = (cotizas: CotLista[], busqueda: string, filtroEst: string, filtroModo: string) => {
    const terminosCot = terminosBusqueda(busqueda);
    return cotizas.filter(c=>{const ncl=clientes.find(cl=>cl.id===c.cliente_id);const txt=[ncl?.empresa,ncl?.nombre,ncl?.ruc,c.origen,c.destino,c.asunto,c.atencion,c.numero_cotizacion,String(c.id).padStart(5,"0")].filter(Boolean).join(" ");return coincideBusqueda(txt,terminosCot)&&(filtroEst==="todos"||c.estado===filtroEst)&&(filtroModo==="todos"||c.modo_servicio===filtroModo||(filtroModo==="eventual"&&!c.modo_servicio));});
  };
  const textos = new Map(cots.map((c) => [c.id, textoBuscable(c, clientes.find((cl) => cl.id === c.cliente_id))]));
  let combos = 0, conResultados = 0;
  for (const b of busquedas) for (const e of estadosF) for (const m of modosF) {
    combos++;
    const v = viejo(cots, b, e, m).map((c) => c.id);
    const n = filtrarLista(cots, textos, { terminos: terminosBusqueda(b), estado: e, modo: m }).map((c) => c.id);
    if (v.length) conResultados++;
    check(JSON.stringify(v) === JSON.stringify(n), `filtro "${b}" ${e} ${m}`, { v, n });
  }
  check(conResultados > combos / 4, "corolario: el barrido sí encuentra cotizaciones", { conResultados, combos });
  check(filtrarLista(cots, textos, { terminos: terminosBusqueda("00042"), estado: "todos", modo: "todos" }).some((c) => c.id === 42), "00042 encuentra la #42");
  check(filtrarLista(cots, textos, { terminos: terminosBusqueda("20123456789"), estado: "todos", modo: "todos" }).every((c) => c.cliente_id === 1), "el RUC encuentra solo a su cliente");
  console.log(`  ${combos} combinaciones · ${cots.length} cotizaciones`);
  fin("(c) filtro idéntico al viejo", f0);

  /* ── (d) KPIs vs fórmula vieja ── */
  seccion("(d) kpisDe vs fórmula vieja");
  const f1 = fallo;
  const kViejo = (cotizas: CotLista[]) => {
    const totC=cotizas.length;const pend=cotizas.filter(c=>c.estado==="pendiente").length;const env=cotizas.filter(c=>c.estado==="enviado").length;const apr=cotizas.filter(c=>c.estado==="aprobado").length;const tasa=totC>0?Math.round(apr/totC*100):0;const pendDesc=cotizas.filter(c=>c.descuento_solicitado&&!c.descuento_autorizado).length;
    return { total: totC, eventuales: cotizas.filter(c=>!c.modo_servicio||c.modo_servicio==="eventual").length, fijos: cotizas.filter(c=>c.modo_servicio==="fijo").length, pendientes: pend, enviadas: env, aprobadas: apr, tasa, descPend: pendDesc };
  };
  for (let k = 0; k <= cots.length; k += 7) {
    const sub = cots.slice(0, k);
    check(JSON.stringify(kViejo(sub)) === JSON.stringify(kpisDe(sub)), `kpis ${k}`, { v: kViejo(sub), n: kpisDe(sub) });
  }
  check(kpisDe([]).tasa === 0, "sin filas, tasa 0");
  fin("(d) KPIs idénticos", f1);
}

/* ── (e) rango manual ── */
seccion("(e) rango invertido e incompleto");
{
  const f0 = fallo;
  const sinLimites = (r: { desde: string | null; hastaExcl: string | null }) => r.desde === null && r.hastaExcl === null;
  const inv = rangoDePeriodo("rango", "2026-10-15", { desde: "2026-10-10", hasta: "2026-10-01" });
  check(inv.codigo === "rango_invertido" && sinLimites(inv), "invertido", inv);
  for (const rg of [undefined, {}, { desde: "2026-10-01" }, { hasta: "2026-10-01" }, { desde: "", hasta: "2026-10-01" }, { desde: "01/10/2026", hasta: "2026-10-05" }]) {
    const r = rangoDePeriodo("rango", "2026-10-15", rg as { desde?: string; hasta?: string });
    check(r.codigo === "rango_incompleto" && sinLimites(r), `incompleto ${JSON.stringify(rg)}`, r);
  }
  const okR = rangoDePeriodo("rango", "2026-10-15", { desde: "2026-10-01", hasta: "2026-10-01" });
  check(okR.codigo === "ok" && okR.desde === "2026-10-01" && okR.hastaExcl === "2026-10-02", "un solo día", okR);
  const cruza = rangoDePeriodo("rango", "2026-10-15", { desde: "2025-12-20", hasta: "2026-12-31" });
  check(cruza.hastaExcl === "2027-01-01", "rango cruza el año", cruza);
  fin("(e) rango manual", f0);
}

/* ── columnas ── */
seccion("(f) columnas de la lista");
{
  const f0 = fallo;
  const prohibidas = ["items_json", "paradas_json", "paradas_retorno_json", "consideraciones_json", "fechas_multidia_json", "ficha_ruta_json", "ruta_coords_json", "itinerario_texto"];
  check(prohibidas.every((p) => !(COLS_LISTA as readonly string[]).includes(p)), "ningún jsonb ni itinerario");
  check(new Set(COLS_LISTA).size === COLS_LISTA.length, "sin repetidas");
  check(!colsSelect(["paradas_n"]).split(",").includes("paradas_n") && colsSelect().split(",").includes("paradas_n"), "colsSelect suelta la indicada");
  fin("(f) columnas", f0);
}

for (const f of fallos) console.log(f);
console.log(`\n${ok} ok · ${fallo} fallos`);
if (fallo) { console.log("HAY FALLOS"); process.exit(1); }
console.log("TODO OK");
