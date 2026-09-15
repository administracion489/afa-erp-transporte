// Pruebas del COSTO POR KILÓMETRO de un tipo de vehículo y de la PUERTA DE ESCRITURA de
// `parametros_costos`. No tocan la base: fixtures en memoria y un cliente Supabase de mentira.
// Uso:  npx tsx scripts/prueba-costos-parametros.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ CADA COSA
//
// 1 · QUE LA FÓRMULA SE EXTRAJO Y NO SE REESCRIBIÓ. La versión original de `calcCostoKm` y la
//     de `calcCostoVeh` están copiadas LITERAL aquí abajo, tal como estaban en
//     app/configuracion/costos/page.tsx y app/cotizaciones/page.tsx antes del cambio, y se
//     comparan con `===` (no "cerca de"): en coma flotante, reordenar los mismos seis términos
//     mueve el último decimal, y ese número se pinta a CUATRO decimales en la pantalla de
//     costos y multiplica los km de un precio en /cotizaciones. Es el mismo criterio con el que
//     scripts/prueba-costeo.mts congela lib/costeo-propio.ts.
//
// 2 · QUE EL BUG DE LA COLUMNA "S/km comb." ERA REAL Y ESTÁ ARREGLADO. La tabla "Impacto en
//     costo S/km" calculaba su propio `pc / rendimiento_1`, sin `pct_uso_1` y sin el segundo
//     combustible, así que en un tipo BIMODAL publicaba un número que no era el que usaba la
//     columna de al lado. La prueba fija las dos mitades: en monomodal no cambia nada (pct_uso_1
//     vale 1.0, que es toda la flota de hoy) y en bimodal el viejo y el nuevo DIFIEREN.
//
// 3 · QUE EL RENDIMIENTO MEDIDO NO PISA EL PARAMETRO CUANDO NO PUEDE. `decidirRendimiento`
//     es lo que decide si la mediana de una placa sustituye al numero tecleado de su tipo en
//     el presupuesto de un servicio. Antes la unica condicion era la familia del combustible,
//     asi que UN SOLO TRAMO medido ya pisaba el parametro, un tipo BIMODAL se costeaba a la
//     mitad, y el renglon firmaba "km/gal" sobre un numero en km/m3. La seccion 6 fija los
//     tres arreglos Y el lado que no se puede aflojar: una medicion buena tiene que seguir
//     mandando, o la funcionalidad quedaria apagada sin que nadie se entere.
//
// 4 · QUE LA PUERTA DE ESCRITURA SE NIEGA ANTES DE ESCRIBIR. `escribirParametro` es el único
//     código nuevo que escribe, y lo que protege es el caso en que `tipo_vehiculo` no identifica
//     a una sola fila. Sin esta sección se estaría reescribiendo `guardarParam` encima de un
//     guard que podría fallar dejando el bug intacto con más código encima.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const CKM = requerir("../lib/costos/costo-km-parametro") as typeof import("../lib/costos/costo-km-parametro");
const PAR = requerir("../lib/costos/parametros") as typeof import("../lib/costos/parametros");
const { componentesCostoKm, costoKmDeParametro } = CKM;
const { escribirParametro } = PAR;
const APL = requerir("../lib/costos/rendimiento-aplica") as typeof import("../lib/costos/rendimiento-aplica");
const REND = requerir("../lib/rendimiento") as typeof import("../lib/rendimiento");
const { decidirRendimiento } = APL;
const { MIN_TRAMOS_CONFIABLE } = REND;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── LAS VERSIONES ORIGINALES, COPIADAS LITERAL ────────────────────────────────
// No se tocan. Si alguna vez hay que cambiarlas para que la prueba pase, la fórmula cambió.

/** app/configuracion/costos/page.tsx:65-75, antes del cambio. */
function calcCostoKm_ORIGINAL(p: any, pr: Record<string, number>): number {
  const pc1 = pr[p.tipo_combustible_1] || 0;
  const combKm = (pc1 / p.rendimiento_1) * p.pct_uso_1
    + (p.tipo_combustible_2 && p.rendimiento_2 && p.pct_uso_2 ? ((pr[p.tipo_combustible_2] || 0) / p.rendimiento_2) * p.pct_uso_2 : 0);
  const neumKm = (p.n_neumaticos * p.costo_neumatico) / p.vida_neumatico_km;
  const depKm = (p.valor_compra * (1 - p.residual_pct)) / (p.vida_util_anios * p.km_anio);
  const fijKm = (p.seguro_anual + p.soat_anual + p.revision_semestral * 2 + p.permisos_anual + p.otros_fijos_mensual * 12) / p.km_anio;
  const ureaKm = p.usa_urea && p.tipo_combustible_1 === "Diésel"
    ? (1 / p.rendimiento_1) * 3.785 * (p.consumo_urea_pct || 0.04) * (pr["UREA"] || 0) : 0;
  return combKm + neumKm + p.mantenimiento_km + depKm + fijKm + ureaKm;
}

/** app/configuracion/costos/page.tsx:423-425, antes del cambio. LA QUE ESTABA MAL. */
function combKmInline_ORIGINAL(p: any, pr: Record<string, number>): number {
  const pc = pr[p.tipo_combustible_1] || 0;
  return pc / p.rendimiento_1;
}

/** El `sub` de calcCostoVeh, app/cotizaciones/page.tsx:55-58, antes del cambio. */
function subCotizaciones_ORIGINAL(p: any, pr: Record<string, number>, km: number): number {
  const pc1 = pr[p.tipo_combustible_1] || 0;
  const combKm = (pc1 / p.rendimiento_1) * p.pct_uso_1 + (p.tipo_combustible_2 && p.rendimiento_2 && p.pct_uso_2 ? ((pr[p.tipo_combustible_2] || 0) / p.rendimiento_2) * p.pct_uso_2 : 0);
  const ureaRate = p.usa_urea && p.tipo_combustible_1 === "Diésel" ? (1 / p.rendimiento_1) * 3.785 * (p.consumo_urea_pct || 0.04) * (pr["UREA"] || 0) : 0;
  return ((combKm + ureaRate) * km) + ((p.n_neumaticos * p.costo_neumatico) / p.vida_neumatico_km) * km + p.mantenimiento_km * km + ((p.valor_compra * (1 - p.residual_pct)) / (p.vida_util_anios * p.km_anio)) * km + ((p.seguro_anual + p.soat_anual + p.revision_semestral * 2 + p.permisos_anual + p.otros_fijos_mensual * 12) / p.km_anio) * km;
}

/** El `sub` como queda ahora: los términos del módulo, el AGRUPAMIENTO literal. */
function subCotizaciones_NUEVO(p: any, pr: Record<string, number>, km: number): number {
  const c = componentesCostoKm(p, pr);
  return ((c.combustible + c.urea) * km) + c.neumaticos * km + c.mantenimiento * km + c.depreciacion * km + c.fijos * km;
}

// ── FIXTURES ──────────────────────────────────────────────────────────────────

const PRECIOS: Record<string, number> = { "Diésel": 25.74, "Gasolina": 22.0, "GLP": 8.5, "GNV": 1.9, "UREA": 2.5 };

const BASE = {
  tipo_combustible_1: "Diésel", rendimiento_1: 19.0, pct_uso_1: 1.0,
  tipo_combustible_2: null as string | null, rendimiento_2: null as number | null, pct_uso_2: null as number | null,
  usa_urea: false, consumo_urea_pct: null as number | null,
  n_neumaticos: 6, costo_neumatico: 1500, vida_neumatico_km: 65000,
  mantenimiento_km: 1.2, valor_compra: 650000, residual_pct: 0.15,
  vida_util_anios: 9, km_anio: 65000,
  seguro_anual: 33000, soat_anual: 2000, revision_semestral: 750,
  permisos_anual: 9000, otros_fijos_mensual: 0,
};

const FIXTURES: { nombre: string; p: any }[] = [
  { nombre: "Sprinter 17 diésel (monomodal, sin urea)", p: { ...BASE } },
  { nombre: "el mismo con el rendimiento MEDIDO (28.5)", p: { ...BASE, rendimiento_1: 28.5 } },
  { nombre: "Euro V con urea", p: { ...BASE, usa_urea: true, consumo_urea_pct: 0.04 } },
  { nombre: "urea marcada pero consumo nulo (cae al 0.04)", p: { ...BASE, usa_urea: true, consumo_urea_pct: null } },
  { nombre: "urea marcada sobre GLP (no aplica)", p: { ...BASE, tipo_combustible_1: "GLP", usa_urea: true, consumo_urea_pct: 0.04 } },
  { nombre: "GNV monomodal", p: { ...BASE, tipo_combustible_1: "GNV", rendimiento_1: 3.2 } },
  { nombre: "BIMODAL diésel 70 / GLP 30", p: { ...BASE, pct_uso_1: 0.7, tipo_combustible_2: "GLP", rendimiento_2: 12.0, pct_uso_2: 0.3 } },
  { nombre: "BIMODAL con urea", p: { ...BASE, usa_urea: true, consumo_urea_pct: 0.05, pct_uso_1: 0.6, tipo_combustible_2: "GNV", rendimiento_2: 4.0, pct_uso_2: 0.4 } },
  { nombre: "combustible que no está en precios", p: { ...BASE, tipo_combustible_1: "Gasohol 90" } },
  { nombre: "otros fijos mensuales > 0", p: { ...BASE, otros_fijos_mensual: 850 } },
  { nombre: "unidad ya depreciada (valor 0)", p: { ...BASE, valor_compra: 0 } },
  { nombre: "residual 0", p: { ...BASE, residual_pct: 0 } },
  // Los divisores en cero se prueban A PROPÓSITO: fijan que el módulo NO los protege en
  // silencio. Un Infinity es ruidoso e imposible de confundir con un precio; un número finito
  // y barato salido de un guard mudo, no. Si algún día se protegen, es su propio cambio.
  { nombre: "rendimiento_1 = 0 (divisor vacío)", p: { ...BASE, rendimiento_1: 0 } },
  { nombre: "km_anio = 0 (divisor vacío)", p: { ...BASE, km_anio: 0 } },
  { nombre: "vida_neumatico_km = 0 (divisor vacío)", p: { ...BASE, vida_neumatico_km: 0 } },
];

// Un mismo número puede ser NaN por los dos lados: NaN !== NaN, así que se comparan aparte.
const identico = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

// ── 1 · LA EXTRACCIÓN ES LITERAL ──────────────────────────────────────────────
console.log("\n1 · costoKmDeParametro reproduce calcCostoKm EXACTAMENTE\n");

for (const { nombre, p } of FIXTURES) {
  const viejo = calcCostoKm_ORIGINAL(p, PRECIOS);
  const nuevo = costoKmDeParametro(p, PRECIOS);
  chk(nombre, identico(viejo, nuevo), `viejo ${viejo} · nuevo ${nuevo}`);
}

console.log("\n1b · el `sub` de /cotizaciones conserva su agrupamiento\n");
for (const km of [1, 300, 1250.5]) {
  for (const { nombre, p } of FIXTURES) {
    const viejo = subCotizaciones_ORIGINAL(p, PRECIOS, km);
    const nuevo = subCotizaciones_NUEVO(p, PRECIOS, km);
    chk(`${km} km · ${nombre}`, identico(viejo, nuevo), `viejo ${viejo} · nuevo ${nuevo}`);
  }
}

// ── 2 · EL BUG DE LA COLUMNA "S/km comb." ─────────────────────────────────────
console.log("\n2 · la columna S/km comb.: idéntica en monomodal, CORREGIDA en bimodal\n");

for (const { nombre, p } of FIXTURES) {
  const viejo = combKmInline_ORIGINAL(p, PRECIOS);
  const nuevo = componentesCostoKm(p, PRECIOS).combustible;
  const bimodal = !!(p.tipo_combustible_2 && p.rendimiento_2 && p.pct_uso_2);
  const ponderado = p.pct_uso_1 !== 1.0;
  if (bimodal || ponderado) {
    chk(`BIMODAL difiere (y debe): ${nombre}`, !identico(viejo, nuevo), `viejo ${viejo} · nuevo ${nuevo}`);
  } else {
    chk(`monomodal no se mueve: ${nombre}`, identico(viejo, nuevo), `${nuevo}`);
  }
}

// El caso que lo motivó, con números a mano: diésel 70 % + GLP 30 %.
{
  const p = { ...BASE, pct_uso_1: 0.7, tipo_combustible_2: "GLP", rendimiento_2: 12.0, pct_uso_2: 0.3 };
  const esperado = (25.74 / 19.0) * 0.7 + (8.5 / 12.0) * 0.3;
  chk("bimodal: el nuevo es la suma ponderada de los dos combustibles",
      componentesCostoKm(p, PRECIOS).combustible === esperado,
      `${componentesCostoKm(p, PRECIOS).combustible} vs ${esperado}`);
  chk("bimodal: el viejo ignoraba el 30 % de GLP y el 70 % del diésel",
      combKmInline_ORIGINAL(p, PRECIOS) === 25.74 / 19.0);
}

// ── 3 · LOS TÉRMINOS SON LOS QUE DICEN SER ────────────────────────────────────
console.log("\n3 · los seis términos, uno a uno\n");
{
  const c = componentesCostoKm(BASE, PRECIOS);
  chk("combustible = precio / rendimiento × pct_uso_1", c.combustible === (25.74 / 19.0) * 1.0);
  chk("urea = 0 cuando usa_urea es false", c.urea === 0);
  chk("neumáticos = (n × costo) / vida", c.neumaticos === (6 * 1500) / 65000);
  chk("mantenimiento = mantenimiento_km tal cual", c.mantenimiento === 1.2);
  chk("depreciación = (valor × (1 − residual)) / (años × km_año)", c.depreciacion === (650000 * 0.85) / (9 * 65000));
  chk("fijos = (seguro + soat + revisión×2 + permisos + otros×12) / km_año",
      c.fijos === (33000 + 2000 + 750 * 2 + 9000 + 0 * 12) / 65000);
  chk("el total es la suma de los seis",
      costoKmDeParametro(BASE, PRECIOS) === c.combustible + c.neumaticos + c.mantenimiento + c.depreciacion + c.fijos + c.urea);

  const conUrea = componentesCostoKm({ ...BASE, usa_urea: true, consumo_urea_pct: 0.04 }, PRECIOS);
  chk("urea = (1/rend) × 3.785 × pct × precio UREA", conUrea.urea === (1 / 19.0) * 3.785 * 0.04 * 2.5);
  chk("la urea NO se activa fuera del Diésel",
      componentesCostoKm({ ...BASE, tipo_combustible_1: "GLP", usa_urea: true, consumo_urea_pct: 0.04 }, PRECIOS).urea === 0);
}

// ── 4 · LOS DIVISORES VACÍOS SIGUEN SIENDO RUIDOSOS ───────────────────────────
console.log("\n4 · un parámetro sin llenar produce Infinity, no un número barato\n");
{
  chk("rendimiento_1 = 0 → Infinity (no un finito silencioso)",
      costoKmDeParametro({ ...BASE, rendimiento_1: 0 }, PRECIOS) === Infinity);
  chk("km_anio = 0 → Infinity", costoKmDeParametro({ ...BASE, km_anio: 0 }, PRECIOS) === Infinity);
  chk("combustible desconocido → 0 en ese término, no NaN",
      componentesCostoKm({ ...BASE, tipo_combustible_1: "Gasohol 90" }, PRECIOS).combustible === 0);
}

// ── 5 · LA PUERTA DE ESCRITURA ────────────────────────────────────────────────
console.log("\n5 · escribirParametro: se niega ANTES de escribir\n");

type Guion = {
  filasClave?: any[]; errorSelect?: { message: string };
  filasUpdate?: any[]; errorUpdate?: { message: string };
  errorInsert?: { message: string };
};

function sbFalso(g: Guion) {
  // `acta` es la PRIMERA fila y `actas` todas: la puerta manda un array (un acta por columna
  // escrita, porque el historial es por campo) y con un solo campo ese array tiene un elemento.
  const log = { updates: 0, inserts: 0, patch: null as any, acta: null as any, actas: [] as any[] };
  const encadenable = (valor: any): any => ({
    eq() { return this; },
    select() { return this; },
    then(res: any, rej: any) { return Promise.resolve(valor).then(res, rej); },
  });
  const sb = {
    from() {
      return {
        select: () => encadenable({ data: g.filasClave ?? [], error: g.errorSelect ?? null }),
        update: (patch: any) => { log.updates++; log.patch = patch; return encadenable({ data: g.filasUpdate ?? [], error: g.errorUpdate ?? null }); },
        insert: (acta: any) => {
          log.inserts++;
          log.actas = Array.isArray(acta) ? acta : [acta];
          log.acta = log.actas[0] ?? null;
          return Promise.resolve({ error: g.errorInsert ?? null });
        },
      };
    },
  };
  return { sb, log };
}

const ESCRITURA = {
  tipo_vehiculo: "SPRINTER_17_DIESEL",
  patch: { rendimiento_1: 28.5 },
  acta: { campo_modificado: "rendimiento_1", valor_anterior: 19, valor_nuevo: 28.5, motivo: "prueba" },
  por: "administracion@afatoursperu.com",
};

{
  // Camino feliz.
  const { sb, log } = sbFalso({ filasClave: [{ id: 7 }], filasUpdate: [{ id: 7 }] });
  const r = await escribirParametro(sb, ESCRITURA);
  chk("1 fila: ok, acta escrita", r.ok && r.filas === 1 && r.acta && !r.error);
  chk("1 fila: se escribió el patch y el firmante", log.patch?.rendimiento_1 === 28.5 && log.patch?.updated_by === ESCRITURA.por);
  chk("1 fila: el acta lleva los dos valores", log.acta?.valor_anterior === 19 && log.acta?.valor_nuevo === 28.5);
  chk("1 fila: el acta apunta a parametros_costos", log.acta?.tabla_origen === "parametros_costos");
  chk("1 campo: UNA sola acta", log.actas.length === 1);
}
{
  // VARIOS CAMPOS A LA VEZ (la ficha del tipo: nombre · capacidad · grupo · ícono). El historial
  // es POR CAMPO, así que hay un acta por columna escrita — y todas en UN insert: o entran
  // todas o no entra ninguna, y así el historial no describe media edición.
  const { sb, log } = sbFalso({ filasClave: [{ id: 7 }], filasUpdate: [{ id: 7 }] });
  const r = await escribirParametro(sb, {
    tipo_vehiculo: "SUV_6_GLP",
    patch: { nombre: "SUV 6 pax GLP Euro III", capacidad: 7 },
    acta: [
      { campo_modificado: "nombre",    valor_anterior: null, valor_nuevo: null, motivo: "Nombre: «SUV 6 pax GLP» → «SUV 6 pax GLP Euro III»" },
      { campo_modificado: "capacidad", valor_anterior: 6,    valor_nuevo: 7,    motivo: "Capacidad: «6 pax» → «7 pax»" },
    ],
    por: "administracion@afatoursperu.com",
  });
  chk("ficha: ok con las dos actas", r.ok && r.acta);
  chk("ficha: UN solo insert con DOS filas", log.inserts === 1 && log.actas.length === 2);
  chk("ficha: cada acta nombra su campo",
    log.actas.map((a: any) => a.campo_modificado).join(",") === "nombre,capacidad");
  chk("ficha: la de la capacidad conserva sus dos números",
    log.actas[1]?.valor_anterior === 6 && log.actas[1]?.valor_nuevo === 7);
  chk("ficha: las dos llevan la misma clave y el mismo firmante",
    log.actas.every((a: any) => a.tipo_vehiculo === "SUV_6_GLP" && a.cambiado_por === "administracion@afatoursperu.com"));
  chk("ficha: el patch va entero, con el firmante",
    log.patch?.nombre === "SUV 6 pax GLP Euro III" && log.patch?.capacidad === 7 && !!log.patch?.updated_by);
  chk("ficha: la CLAVE nunca viaja en el patch", !("tipo_vehiculo" in (log.patch ?? {})));
}
{
  // LA CLAVE DUPLICADA. Lo único que importa: no se escribió NADA.
  const { sb, log } = sbFalso({ filasClave: [{ id: 7 }, { id: 12 }], filasUpdate: [{ id: 7 }, { id: 12 }] });
  const r = await escribirParametro(sb, ESCRITURA);
  chk("2 filas: se niega", !r.ok && r.filas === 2);
  chk("2 filas: NO llamó a update — el guard va ANTES de escribir", log.updates === 0);
  chk("2 filas: NO dejó acta", log.inserts === 0);
  chk("2 filas: el error nombra el script que lo arregla", /costos-01-identidad-tipo-vehiculo\.sql/.test(r.error ?? ""));
}
{
  // La clave que no existe.
  const { sb, log } = sbFalso({ filasClave: [] });
  const r = await escribirParametro(sb, ESCRITURA);
  chk("0 filas: se niega y no escribe", !r.ok && r.filas === 0 && log.updates === 0 && log.inserts === 0);
  chk("0 filas: el error nombra la clave", (r.error ?? "").includes("SPRINTER_17_DIESEL"));
}
{
  // EL SILENCIO QUE ESTE MÓDULO EXISTE PARA CORTAR: RLS deja el update en 0 filas y 0 errores.
  const { sb, log } = sbFalso({ filasClave: [{ id: 7 }], filasUpdate: [] });
  const r = await escribirParametro(sb, ESCRITURA);
  chk("update que no toca nada: NO devuelve ok", !r.ok);
  chk("update que no toca nada: NO deja acta de un cambio que no ocurrió", log.inserts === 0);
  chk("update que no toca nada: el error dice que NO se guardó", /NO se guardó/.test(r.error ?? ""));
}
{
  const { sb } = sbFalso({ errorSelect: { message: "permission denied" } });
  const r = await escribirParametro(sb, ESCRITURA);
  chk("select que falla: se niega y propaga el motivo", !r.ok && (r.error ?? "").includes("permission denied"));
}
{
  const { sb, log } = sbFalso({ filasClave: [{ id: 7 }], errorUpdate: { message: "violates check constraint" } });
  const r = await escribirParametro(sb, ESCRITURA);
  chk("update que falla: se niega y no deja acta", !r.ok && log.inserts === 0 && (r.error ?? "").includes("violates check constraint"));
}
{
  // El parámetro SÍ se guardó y el acta no. Es ok:true con acta:false, y hay que decirlo.
  const { sb } = sbFalso({ filasClave: [{ id: 7 }], filasUpdate: [{ id: 7 }], errorInsert: { message: "insert denied" } });
  const r = await escribirParametro(sb, ESCRITURA);
  chk("acta que falla: el guardado vale, pero se declara sin acta", r.ok && !r.acta && !!r.error);
}
{
  // La clave se usa CRUDA: normalizarla aquí inventaría una tercera identidad.
  const { sb, log } = sbFalso({ filasClave: [{ id: 7 }], filasUpdate: [{ id: 7 }] });
  await escribirParametro(sb, { ...ESCRITURA, tipo_vehiculo: "  bus_60 gnv  " });
  chk("la clave no se normaliza al escribir", log.acta?.tipo_vehiculo === "  bus_60 gnv  ");
}

// ── 6 · CUANDO EL RENDIMIENTO MEDIDO PUEDE PISAR AL TECLEADO ──────────────────
console.log("\n6 · decidirRendimiento: la medicion manda solo cuando puede\n");

const DIESEL = { rendimiento_1: 19, tipo_combustible_1: "Diésel", tipo_combustible_2: null, pct_uso_2: null };
const GNV    = { rendimiento_1: 3.2, tipo_combustible_1: "GNV",    tipo_combustible_2: null, pct_uso_2: null };
const BIMODAL= { rendimiento_1: 19, tipo_combustible_1: "Diésel", tipo_combustible_2: "GLP", pct_uso_2: 0.3 };

const midiendo = (o: any = {}) => ({
  kmGal: 28.5, tramos: 8, familia: "diesel", label: "km/gal", confiable: true, ...o,
});

// 6a · EL CASO REAL. CWZ-371: 10 cargas, 8 tramos medidos, mediana 28.5, contra un parametro
//      de 19.00 en el tipo SPRINTER_17_DIESEL.
{
  const d = decidirRendimiento(DIESEL, midiendo());
  chk("CWZ-371: la medicion buena SI manda", d.aplica && d.valor === 28.5, `valor ${d.valor}`);
  chk("CWZ-371: el renglon nombra los tramos", /28\.5 km\/gal medido en 8 tramos/.test(d.base), d.base);
  chk("CWZ-371: sin motivo cuando aplica", d.motivo === null);
}

// 6b · EL BUG 1. Un solo tramo medido pisaba el parametro del tipo en CADA servicio.
{
  const uno = decidirRendimiento(DIESEL, midiendo({ tramos: 1, confiable: false, kmGal: 41 }));
  chk("1 tramo NO manda", !uno.aplica && uno.motivo === "pocos_tramos" && uno.valor === 19);
  chk("1 tramo: el renglon dice cuantos hay y cuantos faltan",
      uno.base.includes("1 tramo(s)") && uno.base.includes(String(MIN_TRAMOS_CONFIABLE)), uno.base);

  // La frontera exacta de MIN_TRAMOS_CONFIABLE, por los dos lados.
  const cuatro = decidirRendimiento(DIESEL, midiendo({ tramos: 4, confiable: false }));
  const cinco  = decidirRendimiento(DIESEL, midiendo({ tramos: 5, confiable: true }));
  chk(`${MIN_TRAMOS_CONFIABLE - 1} tramos: no manda`, !cuatro.aplica && cuatro.motivo === "pocos_tramos");
  chk(`${MIN_TRAMOS_CONFIABLE} tramos: manda`, cinco.aplica && cinco.valor === 28.5);
}

// 6c · EL BUG 2. El "km/gal" estaba hardcodeado en LAS DOS ramas del renglon.
{
  const gnvOk = decidirRendimiento(GNV, midiendo({ familia: "gnv", label: "km/m³", kmGal: 4.1 }));
  chk("GNV medido: el renglon dice km/m3, no km/gal", gnvOk.aplica && gnvOk.label === "km/m³", gnvOk.base);
  chk("GNV medido: 'km/gal' no aparece por ningun lado", !gnvOk.base.includes("km/gal"), gnvOk.base);

  const gnvSin = decidirRendimiento(GNV, null);
  chk("GNV sin medicion: la rama del PARAMETRO tambien dice km/m3",
      gnvSin.label === "km/m³" && !gnvSin.base.includes("km/gal"), gnvSin.base);

  // Y la familia distinta: una mediana en km/m3 jamas puede sustituir un parametro en km/gal.
  const cruzado = decidirRendimiento(DIESEL, midiendo({ familia: "gnv", label: "km/m³", kmGal: 4.1 }));
  chk("GNV medido sobre parametro diesel: no manda", !cruzado.aplica && cruzado.motivo === "familia_distinta");
  chk("familia distinta: la unidad publicada es la del PARAMETRO", cruzado.label === "km/gal" && cruzado.valor === 19);
}

// 6d · EL BUG 3. En un tipo bimodal, rendimiento_1 significa "km por galon del combustible 1
//      SOBRE LOS KM HECHOS CON EL COMBUSTIBLE 1". La mediana medida no sabe de que tanque
//      salieron los km, asi que sustituirla descuenta pct_uso_1 dos veces.
{
  const bi = decidirRendimiento(BIMODAL, midiendo());
  chk("bimodal: NO manda ni con una medicion perfecta", !bi.aplica && bi.motivo === "tipo_bimodal" && bi.valor === 19);
  chk("bimodal: el renglon explica el porque", /dos combustibles/.test(bi.base), bi.base);

  // Lo estructural gana sobre lo estadistico: un bimodal no va a poder usar una medicion
  // NUNCA, y decir eso es mas util que decir que hoy no hay cargas.
  chk("bimodal sin medicion: sigue siendo tipo_bimodal",
      decidirRendimiento(BIMODAL, null).motivo === "tipo_bimodal");

  // Un segundo combustible declarado pero sin uso NO es bimodal: la formula no lo suma.
  chk("pct_uso_2 = 0 no es bimodal",
      decidirRendimiento({ ...BIMODAL, pct_uso_2: 0 }, midiendo()).aplica);
  chk("tipo_combustible_2 null no es bimodal",
      decidirRendimiento({ ...BIMODAL, tipo_combustible_2: null }, midiendo()).aplica);
}

// 6e · SIN MEDICION.
{
  const d = decidirRendimiento(DIESEL, null);
  chk("sin medicion: se usa el tecleado", !d.aplica && d.motivo === "sin_medicion" && d.valor === 19);
  chk("sin medicion: el renglon no inventa un porque", d.base === "19 km/gal del parámetro del tipo", d.base);
}

// 6f · LA INVARIANTE, sobre una rejilla.
{
  let malas = 0, sinValor = 0, sinLabel = 0;
  for (const par of [DIESEL, GNV, BIMODAL, { ...BIMODAL, pct_uso_2: 0 }]) {
    for (const med of [null, midiendo(), midiendo({ confiable: false, tramos: 2 }),
                       midiendo({ familia: "gnv", label: "km/m³" }),
                       midiendo({ familia: "glp", label: "km/gal" })]) {
      const d = decidirRendimiento(par as any, med);
      if (d.aplica !== (d.motivo === null)) malas++;
      if (!Number.isFinite(d.valor)) sinValor++;
      if (!d.label || !d.base.includes(d.label)) sinLabel++;
    }
  }
  chk("INVARIANTE: aplica === (motivo === null), en las 20 combinaciones", malas === 0, `${malas} fallan`);
  chk("el valor siempre es un numero finito", sinValor === 0);
  chk("el renglon siempre lleva la unidad que declara", sinLabel === 0);
}

// 6g · EL LADO QUE NO SE PUEDE AFLOJAR. Este cambio RESTRINGE cuando se usa lo medido, asi
//      que el riesgo es apagar la funcionalidad entera sin que nadie lo note: el presupuesto
//      volveria al parametro tecleado siempre y nadie veria la diferencia hasta cotizar mal.
{
  const casos = [
    ["diesel confiable 8 tramos", DIESEL, midiendo()],
    ["diesel confiable justo en el minimo", DIESEL, midiendo({ tramos: MIN_TRAMOS_CONFIABLE })],
    ["diesel confiable con muchos tramos", DIESEL, midiendo({ tramos: 40, kmGal: 27.1 })],
    ["GNV confiable sobre parametro GNV", GNV, midiendo({ familia: "gnv", label: "km/m³", kmGal: 4.1 })],
  ] as const;
  for (const [nombre, par, med] of casos) {
    const d = decidirRendimiento(par as any, med as any);
    chk(`sigue mandando: ${nombre}`, d.aplica && d.valor === (med as any).kmGal, d.base);
  }
}

console.log(`\n${fallos ? `❌ ${fallos} fallo(s)` : "✅ todo en verde"}\n`);
process.exit(fallos ? 1 : 0);
