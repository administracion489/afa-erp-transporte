// Las ETIQUETAS del ítem de liquidación: RUTA, TURNO y MÓVIL.
//
// El caso que lo abrió, con las palabras del dueño: «el RUTA A TURNO 1 antes era de 4:35
// y la siguiente semana de 5:00, sigue siendo el mismo PAX, RUTA y TURNO: debería seguir
// sumando la cantidad de servicios en el mismo ítem». Y la otra mitad: «solo se separan
// cuando cambian de tipo de vehículo (más o menos PAX) o cuando cambian el nombre de la
// ruta», más lo que ya separaba siempre —la tarifa— y el MÓVIL cuando salen dos buses a la
// vez en la misma ruta y turno.
//
// Lo que esta matriz fija y no se puede aflojar:
//   · un cambio de HORA no abre otro ítem si RUTA y TURNO son los mismos;
//   · dos TURNOS de la misma ruta son dos ítems aunque el nombre sin la hora coincida
//     (el defecto de la agrupación por nombre, que se conserva como regresión);
//   · la tarifa, los PAX, el origen y el falso flete siguen separando: una etiqueta no
//     puede fundir dos precios;
//   · sin etiquetas, la agrupación es la de siempre;
//   · la PROPUESTA nunca deduce el TURNO: solo hereda lo que el operador ya escribió;
//   · el guardado escribe los DOS tramos del día y solo los que cambian.
//
// Correr:  npx tsx scripts/prueba-etiquetas.mts
import {
  agruparServicios, analizarServicios, etiquetasDelPar, choquesDeEtiquetas,
  type LineaAgrupada, type OpcionesAgrupacion, type ReservaLiq,
} from "../lib/liquidacion-agrupacion";
import {
  normalizarRutaEtiqueta, normalizarNumeroEtiqueta, validarEtiquetas, etiquetasDelDia,
  etiquetasDeTramo, cambiaEtiquetas, totalMoviles, segmentosEtiquetas, rotuloEtiquetas,
  faltaMigracionEtiquetas, textoDeTramo, huecosDeEtiquetas,
} from "../lib/liquidacion-etiquetas";
import {
  armarDias, proponerEtiquetas, agruparParaEtiquetar, planDeGuardado, rutaDelNombre,
  type TramoEtq, type DecisionGrupo,
} from "../lib/liquidacion-etiquetas-propuesta";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

const OPTS: OpcionesAgrupacion = {
  lado: "cliente",
  catalogo: {
    placaDe: () => "",
    capacidadDe: () => null,
    conductorDe: () => "",
    paxContratadoDe: (par) => {
      for (const t of [par.ida, par.retorno, par.cabeza, ...par.adjuntas]) {
        const n = Number(t?.capacidad_contratada ?? 0);
        if (Number.isFinite(n) && n > 0) return Math.round(n);
      }
      return null;
    },
  },
  preciosIncluyenIgv: false,
  igvPct: 18,
  desde: "2026-09-01",
  hasta: "2026-09-30",
};

let idSeq = 1000;
type Etq = { ruta?: string | null; turno?: number | null; movil?: number | null };

/** Un día: ida + retorno enlazados, importe en la ida. Sin paradas: el mapa no ayuda aquí. */
function dia(o: {
  fecha: string;
  horaIda?: string;
  horaRet?: string | null;
  nombreIda: string;
  nombreRet?: string | null;
  precio?: number;
  pax?: number | null;
  origen?: string;
  etq?: Etq | null;
  /** Etiquetas SOLO en el retorno (la ida sin nada). */
  etqRetorno?: Etq | null;
  cliente?: number;
  estado?: string;
}): ReservaLiq[] {
  const a = ++idSeq;
  const b = o.nombreRet ? ++idSeq : null;
  const e = o.etq ?? null;
  const er = o.etqRetorno !== undefined ? o.etqRetorno : e;
  const base = {
    fecha_servicio: o.fecha, estado: o.estado ?? "finalizada", cliente_id: o.cliente ?? 1,
    origen_contractual: o.origen ?? "contrato", capacidad_contratada: o.pax ?? 50,
  };
  const filas: ReservaLiq[] = [{
    ...base, id: a, codigo: `S${a}`, hora_servicio: o.horaIda ?? "04:35", ruta_nombre: o.nombreIda,
    direccion_servicio: "ida", precio_cliente: o.precio ?? 790, reserva_vinculada_id: b,
    ruta_etiqueta: o.etqRetorno !== undefined && o.etq === undefined ? null : e?.ruta ?? null,
    turno: o.etqRetorno !== undefined && o.etq === undefined ? null : e?.turno ?? null,
    movil: o.etqRetorno !== undefined && o.etq === undefined ? null : e?.movil ?? null,
  } as ReservaLiq];
  if (b)
    filas.push({
      ...base, id: b, codigo: `S${b}`, hora_servicio: o.horaRet ?? "15:00", ruta_nombre: o.nombreRet!,
      direccion_servicio: "retorno", precio_cliente: 0, reserva_vinculada_id: a,
      ruta_etiqueta: er?.ruta ?? null, turno: er?.turno ?? null, movil: er?.movil ?? null,
    } as ReservaLiq);
  return filas;
}

const lineasDe = (rs: ReservaLiq[], opts: Partial<OpcionesAgrupacion> = {}): LineaAgrupada[] =>
  agruparServicios(analizarServicios(rs, "cliente").pares, { ...OPTS, ...opts }).filter((l) => l.cantidad > 0);

const fechas = (desde: number, n: number) =>
  Array.from({ length: n }, (_, i) => `2026-09-${String(desde + i).padStart(2, "0")}`);

// ══ 1 · Normalización ═══════════════════════════════════════════════════════
titulo("1 · Normalización de lo que se teclea");
{
  const casos: [string, string | null][] = [
    ["a", "RUTA A"], ["Ruta a", "RUTA A"], ["RUTA-B", "RUTA B"], ["ruta: c", "RUTA C"],
    ["  ruta   12 ", "RUTA 12"], ["RUTA 12A", "RUTA 12A"], ["RUTA NORTE", "RUTA NORTE"],
    ["norte", "NORTE"], ["", null], ["   ", null], ["Ruta Única", "RUTA ÚNICA"],
  ];
  for (const [e, s] of casos) ok(normalizarRutaEtiqueta(e) === s, `ruta «${e}» → ${s}`, normalizarRutaEtiqueta(e));
  ok(casos.every(([, s]) => s == null || normalizarRutaEtiqueta(s) === s), "normalizar lo normalizado no cambia nada (idempotente)");

  const nums: [unknown, number | null][] = [
    ["1", 1], [" 01 ", 1], ["T2", 2], ["turno 3", 3], ["M2", 2], ["MÓVIL 4", 4], [5, 5],
    ["0", null], ["1.5", null], ["primero", null], [100, null], [0, null], [null, null],
  ];
  for (const [e, s] of nums) ok(normalizarNumeroEtiqueta(e) === s, `número «${String(e)}» → ${s}`, normalizarNumeroEtiqueta(e));
}

titulo("1b · RUTA y TURNO van juntos o no van");
{
  const v = (ruta: string, turno: string, movil = "") => validarEtiquetas({ ruta, turno, movil });
  const vacio = v("", "");
  ok(vacio.ok && vacio.etiquetas === null, "las tres vacías = quitar / no poner");
  ok(!v("A", "").ok, "RUTA sin TURNO no se acepta");
  ok(!v("", "1").ok, "TURNO sin RUTA no se acepta");
  ok(!v("", "", "2").ok, "un MÓVIL solo no se acepta");
  const bien = v("a", "1");
  ok(bien.ok && bien.etiquetas?.ruta === "RUTA A" && bien.etiquetas?.turno === 1 && bien.etiquetas?.movil === null,
    "«a» + «1» → RUTA A · TURNO 1 · sin móvil");
  const conMovil = v("B", "2", "2");
  ok(conMovil.ok && conMovil.etiquetas?.movil === 2, "con móvil 2");
  ok(!v("B", "2", "x").ok, "un MÓVIL que no es número no se acepta");
  ok(!v("X".repeat(41), "1").ok, "una RUTA de más de 40 caracteres no se acepta (el CHECK de la base)");
}

// ══ 2 · Las etiquetas del día ═══════════════════════════════════════════════
titulo("2 · Las etiquetas son del DÍA: basta con que un tramo las lleve");
{
  const A = { ruta_etiqueta: "RUTA A", turno: 1, movil: null };
  const B = { ruta_etiqueta: "RUTA A", turno: 2, movil: null };
  const nada = { ruta_etiqueta: null, turno: null, movil: null };
  const d1 = etiquetasDelDia([A, nada]);
  ok(d1.etiquetas?.turno === 1 && d1.tramosSinEtiqueta === 1 && !d1.conflicto, "ida etiquetada, retorno vacío → el día es RUTA A · T1");
  const d2 = etiquetasDelDia([nada, A]);
  ok(d2.etiquetas?.turno === 1, "retorno etiquetado, ida vacía → también");
  const d3 = etiquetasDelDia([A, B]);
  ok(d3.etiquetas?.turno === 1 && d3.conflicto?.pierde.turno === 2, "ida T1 y retorno T2 → gana la ida y se declara el conflicto");
  const d4 = etiquetasDelDia([A, { ...A, movil: 1 }]);
  ok(!d4.conflicto, "móvil vacío y móvil 1 son el mismo puesto: no es conflicto");
  const d5 = etiquetasDelDia([{ ruta_etiqueta: "RUTA A", turno: null, movil: null }]);
  ok(d5.etiquetas === null && d5.aMedias, "RUTA sin TURNO no etiqueta el día, y se declara a medias");
  ok(etiquetasDeTramo({ ruta_etiqueta: "a", turno: "1" })?.ruta === "RUTA A", "lo leído de la base también se normaliza");
  ok(textoDeTramo({ ruta_etiqueta: "RUTA C", turno: 2, movil: null }).turno === "2", "el formulario se precarga con lo escrito");
}

// ══ 3 · EL CASO DEL DUEÑO ═══════════════════════════════════════════════════
titulo("3 · RUTA A TURNO 1 cambia de 04:35 a 05:00 → UN solo ítem");
{
  const semana1 = fechas(1, 5).flatMap((f) => dia({
    fecha: f, horaIda: "04:35", nombreIda: "RUTA A/ ENTRADA 04:35/ SANTA ANITA→BSF",
    nombreRet: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA", horaRet: "17:00",
    etq: { ruta: "RUTA A", turno: 1 },
  }));
  const semana2 = fechas(8, 5).flatMap((f) => dia({
    fecha: f, horaIda: "05:00", nombreIda: "RUTA A/ ENTRADA 05:00/ SANTA ANITA→BSF PUNTA HERMOSA",
    nombreRet: "RUTA A/ RETORNO 16:00/ BSF PUNTA HERMOSA→SANTA ANITA", horaRet: "16:00",
    etq: { ruta: "RUTA A", turno: 1 },
  }));
  const conEtq = lineasDe([...semana1, ...semana2]);
  ok(conEtq.length === 1, "con etiquetas: UN ítem", `${conEtq.length} ítem(s)`);
  ok(conEtq[0]?.cantidad === 10, "con los 10 servicios de las dos semanas", conEtq[0]?.cantidad);
  const desc = conEtq[0]?.descripcion ?? "";
  ok(desc === "TRANSPORTE DE PERSONAL / 50 PAX / DEL 01-09-2026 AL 30-09-2026 / RUTA A / TURNO 1",
    "la descripción es la que pidió el dueño", desc);
  ok(!/\d{1,2}:\d{2}/.test(desc), "y no imprime ninguna hora (sería falsa para la mitad de los días)");
  ok(conEtq[0]?.etiquetas?.ruta === "RUTA A" && conEtq[0]?.clave.startsWith("ETQ|"), "la línea declara sus etiquetas y su clave empieza en ETQ|");

  // El defecto que esto arregla, conservado como regresión: sin etiquetas, el nombre (que
  // además cambió de redacción) parte el mismo servicio en dos ítems.
  const strip = (rs: ReservaLiq[]) => rs.map((r) => ({ ...r, ruta_etiqueta: null, turno: null, movil: null }));
  const sinEtq = lineasDe(strip([...semana1, ...semana2]));
  ok(sinEtq.length === 2, "REGRESIÓN: sin etiquetas el mismo turno sale en 2 ítems (el defecto reportado)", `${sinEtq.length}`);
}

titulo("3b · Dos TURNOS de la misma ruta son dos ítems aunque el nombre sin hora coincida");
{
  const t1 = fechas(1, 4).flatMap((f) => dia({
    fecha: f, horaIda: "04:35", nombreIda: "RUTA C/ENTRADA 4:35/ 1RO MAYO→BSF", nombreRet: "RUTA C/RETORNO 15:00/ BSF→1RO MAYO",
    etq: { ruta: "RUTA C", turno: 1 },
  }));
  const t2 = fechas(1, 4).flatMap((f) => dia({
    fecha: f, horaIda: "06:35", nombreIda: "RUTA C/ENTRADA 06:35/ 1RO MAYO→BSF", nombreRet: "RUTA C/RETORNO 15:00/ BSF→1RO MAYO",
    etq: { ruta: "RUTA C", turno: 2 },
  }));
  const ls = lineasDe([...t1, ...t2]);
  ok(ls.length === 2, "con etiquetas: T1 y T2 en dos ítems", `${ls.length}`);
  ok(ls[0]?.descripcion.endsWith("RUTA C / TURNO 1") && ls[1]?.descripcion.endsWith("RUTA C / TURNO 2"),
    "en orden: TURNO 1 antes que TURNO 2", ls.map((l) => l.descripcion.split(" / ").slice(-2).join(" ")).join(" · "));
  const strip = (rs: ReservaLiq[]) => rs.map((r) => ({ ...r, ruta_etiqueta: null, turno: null, movil: null }));
  const viejo = lineasDe(strip([...t1, ...t2]));
  ok(viejo.length === 1 && viejo[0].cantidad === 8,
    "REGRESIÓN: sin etiquetas los dos turnos se fundían en 1 ítem de 8 (la hora era lo único que los separaba)",
    `${viejo.length} ítem(s)`);
}

titulo("3c · MÓVIL 1 DE 2: dos buses a la vez en la misma ruta y turno");
{
  const rs = fechas(1, 3).flatMap((f) => [
    ...dia({ fecha: f, horaIda: "07:00", nombreIda: "RUTA B/ ENTRADA 07:00/ CHILCA→BSF", etq: { ruta: "RUTA B", turno: 1, movil: 1 } }),
    ...dia({ fecha: f, horaIda: "07:00", nombreIda: "RUTA B/ ENTRADA 07:00/ CHILCA→BSF", etq: { ruta: "RUTA B", turno: 1, movil: 2 } }),
  ]);
  const ls = lineasDe(rs);
  ok(ls.length === 2, "dos ítems, uno por móvil", `${ls.length}`);
  ok(ls[0]?.descripcion.endsWith("RUTA B / TURNO 1 / MÓVIL 1 DE 2") && ls[1]?.descripcion.endsWith("MÓVIL 2 DE 2"),
    "«MÓVIL 1 DE 2» y «MÓVIL 2 DE 2»", ls.map((l) => l.descripcion.split(" / ").pop()).join(" · "));
  ok(ls.every((l) => l.cantidad === 3), "con 3 servicios cada uno");

  // El móvil vacío es el único, o sea el 1: con un móvil 2 al lado, sale como «MÓVIL 1 DE 2».
  const rs2 = fechas(1, 2).flatMap((f) => [
    ...dia({ fecha: f, horaIda: "07:00", nombreIda: "RUTA B/ ENTRADA 07:00/ X", etq: { ruta: "RUTA B", turno: 1 } }),
    ...dia({ fecha: f, horaIda: "07:00", nombreIda: "RUTA B/ ENTRADA 07:00/ X", etq: { ruta: "RUTA B", turno: 1, movil: 2 } }),
  ]);
  const ls2 = lineasDe(rs2);
  ok(ls2.some((l) => l.descripcion.endsWith("MÓVIL 1 DE 2")), "el móvil vacío se imprime como MÓVIL 1 DE 2 si hay un móvil 2");

  // Un solo móvil: no se imprime ningún MÓVIL (no es obligatorio).
  const solo = lineasDe(fechas(1, 2).flatMap((f) => dia({ fecha: f, nombreIda: "RUTA D/ X", etq: { ruta: "RUTA D", turno: 1, movil: 1 } })));
  ok(solo.length === 1 && !/MÓVIL/.test(solo[0].descripcion), "con un solo móvil no se imprime «MÓVIL»", solo[0]?.descripcion);
  ok(JSON.stringify(segmentosEtiquetas({ ruta: "RUTA A", turno: 1, movil: 2 }, 3)) === '["RUTA A","TURNO 1","MÓVIL 2 DE 3"]', "segmentos del ítem");
  const tot = totalMoviles([{ ruta: "RUTA A", turno: 1, movil: 2 }, { ruta: "RUTA A", turno: 1, movil: null }, { ruta: "RUTA A", turno: 2, movil: null }]);
  ok(tot.get("RUTA A|T1") === 2 && tot.get("RUTA A|T2") === 1, "el «DE N» se cuenta por RUTA + TURNO");
}

titulo("3d · Lo que separaba siempre SIGUE separando: tarifa, PAX, origen");
{
  const base = { nombreIda: "RUTA A/ ENTRADA 04:35/ X", etq: { ruta: "RUTA A", turno: 1 } };
  const rs = [
    ...dia({ ...base, fecha: "2026-09-01", precio: 790, pax: 50 }),
    ...dia({ ...base, fecha: "2026-09-02", precio: 790, pax: 50 }),
    ...dia({ ...base, fecha: "2026-09-03", precio: 820, pax: 50 }),   // otra tarifa
    ...dia({ ...base, fecha: "2026-09-04", precio: 790, pax: 30 }),   // otros PAX (otro tipo de bus)
    ...dia({ ...base, fecha: "2026-09-05", precio: 790, pax: 50, origen: "adicional" }),
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 4, "4 ítems: contrato 790×50, 820×50, 790×30 y el adicional", `${ls.length}`);
  ok(new Set(ls.map((l) => l.precio_unitario)).size === 2 && ls.every((l) => l.cantidad >= 1), "cada ítem con UNA tarifa");
  const adic = ls.find((l) => l.tipo === "adicional");
  ok(!!adic && adic.descripcion.startsWith("SERVICIO ADICIONAL / "), "el adicional sale aparte y rotulado", adic?.descripcion);
  ok(ls[ls.length - 1]?.tipo === "adicional", "y al final, como en el formato");
  ok(ls.some((l) => l.pax_contratado === 30 && l.descripcion.includes("/ 30 PAX /")), "el de 30 PAX imprime 30 PAX");
}

titulo("3e · Lo etiquetado y lo sin etiquetar no se mezclan");
{
  const rs = [
    ...dia({ fecha: "2026-09-01", nombreIda: "RUTA A/ ENTRADA 04:35/ X", etq: { ruta: "RUTA A", turno: 1 } }),
    ...dia({ fecha: "2026-09-02", nombreIda: "RUTA A/ ENTRADA 04:35/ X" }),
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 2, "el día sin etiqueta queda en su propio ítem (el ERP no adivina a cuál va)", `${ls.length}`);
  ok(!!ls[0].etiquetas && !ls[1].etiquetas, "primero el etiquetado, después el que agrupa por nombre");
}

titulo("3f · El retorno etiquetado arrastra el día; el conflicto se avisa");
{
  const rs = dia({
    fecha: "2026-09-01", nombreIda: "RUTA A/ ENTRADA 04:35/ X", nombreRet: "RUTA A/ RETORNO 15:00/ X",
    etqRetorno: { ruta: "RUTA A", turno: 2 },
  });
  const ls = lineasDe(rs);
  ok(ls.length === 1 && ls[0].etiquetas?.turno === 2, "solo el retorno dice RUTA A · T2 → el día va a ese ítem");

  const conflicto = dia({
    fecha: "2026-09-02", nombreIda: "RUTA A/ ENTRADA 04:35/ X", nombreRet: "RUTA A/ RETORNO 15:00/ X",
    etq: { ruta: "RUTA A", turno: 1 }, etqRetorno: { ruta: "RUTA A", turno: 2 },
  });
  const an = analizarServicios(conflicto, "cliente");
  ok(an.pares.length === 1 && etiquetasDelPar(an.pares[0]).etiquetas?.turno === 1, "ida T1 y retorno T2 → gana la ida");
  ok(an.avisos.some((a) => /etiquetas distintas/.test(a.mensaje)), "y se avisa, no se traga en silencio",
    an.avisos.map((a) => a.mensaje).join(" | "));
}

titulo("3g · Sin etiquetas, la agrupación es la de siempre");
{
  const conjunto = [
    ...fechas(1, 3).flatMap((f) => dia({ fecha: f, nombreIda: "RUTA A/ ENTRADA 04:35/ X", nombreRet: "RUTA A/ RETORNO 15:00/ X" })),
    ...fechas(1, 3).flatMap((f) => dia({ fecha: f, horaIda: "07:00", nombreIda: "RUTA B/ ENTRADA 07:00/ Y", precio: 350 })),
  ];
  const variantes = [
    conjunto.map((r) => ({ ...r, ruta_etiqueta: undefined, turno: undefined, movil: undefined })),
    conjunto.map((r) => ({ ...r, ruta_etiqueta: null, turno: null, movil: null })),
    conjunto.map((r) => ({ ...r, ruta_etiqueta: "   ", turno: null, movil: 3 })),   // a medias: no etiqueta
  ];
  const huella = (ls: LineaAgrupada[]) => JSON.stringify(ls.map((l) => [l.clave, l.descripcion, l.cantidad, l.total_linea]));
  const ref = huella(lineasDe(variantes[0] as ReservaLiq[]));
  ok(variantes.every((v) => huella(lineasDe(v as ReservaLiq[])) === ref),
    "columna ausente, NULL o etiqueta a medias → exactamente el mismo resultado");
  ok(lineasDe(variantes[0] as ReservaLiq[]).every((l) => l.etiquetas === null && !l.clave.startsWith("ETQ|")),
    "y ninguna línea se declara etiquetada");
}

titulo("3i · Sin paraderos, dos rutas distintas NO se funden por el mapa");
{
  // El eje del mapa devolvía "→" para un tramo sin paraderos, y "→" no es vacío: todos los
  // tramos sin paraderos compartían esa firma y quedaban unidos aunque fueran otra ruta.
  const rs = [
    ...dia({ fecha: "2026-09-01", nombreIda: "RUTA A/ ENTRADA 04:35/ SANTA ANITA→BSF" }),
    ...dia({ fecha: "2026-09-02", nombreIda: "RUTA B/ ENTRADA 07:00/ CHILCA→BSF" }),
  ];
  ok(rs.every((r) => r.paradas_json == null), "ninguno trae paraderos");
  ok(lineasDe(rs).length === 2, "RUTA A y RUTA B a la misma tarifa y PAX son DOS ítems", lineasDe(rs).length);
  const mismos = [
    ...dia({ fecha: "2026-09-01", nombreIda: "RUTA A/ ENTRADA 04:35/ SANTA ANITA→BSF" }),
    ...dia({ fecha: "2026-09-02", nombreIda: "RUTA A/ ENTRADA 04:40/ SANTA ANITA→BSF" }),
  ];
  ok(lineasDe(mismos).length === 1, "y el mismo nombre sin la hora sigue uniéndose por el eje del nombre");
}

titulo("3h · Barrido: ninguna etiqueta puede fundir dos tarifas ni dos PAX, ni perder un día");
{
  let combos = 0, malos = 0;
  const rutas = ["RUTA A", "RUTA B"];
  for (const precios of [[790], [790, 820]])
    for (const paxes of [[50], [50, 30]])
      for (const turnos of [[1], [1, 2]])
        for (const moviles of [[null], [1, 2]])
          for (const conSinEtq of [false, true]) {
            combos++;
            const rs: ReservaLiq[] = [];
            let k = 0;
            for (const ruta of rutas)
              for (const turno of turnos)
                for (const movil of moviles)
                  for (const f of fechas(1, 3)) {
                    k++;
                    const sinEtq = conSinEtq && k % 4 === 0;
                    rs.push(...dia({
                      fecha: f, horaIda: `0${4 + turno}:00`, nombreIda: `${ruta}/ ENTRADA 0${4 + turno}:${k % 2 ? "00" : "30"}/ X`,
                      nombreRet: `${ruta}/ RETORNO 1${4 + turno}:00/ X`,
                      precio: precios[k % precios.length], pax: paxes[(k >> 1) % paxes.length],
                      etq: sinEtq ? null : { ruta, turno, movil },
                    }));
                  }
            const an = analizarServicios(rs, "cliente");
            let ls: LineaAgrupada[] = [];
            try { ls = agruparServicios(an.pares, OPTS); } catch { malos++; continue; }
            const dias = ls.reduce((a, l) => a + l.cantidad_programada, 0);
            const unaTarifa = ls.every((l) => l.reservas_periodo.length > 0);
            const etiquetadasBien = ls.filter((l) => l.etiquetas).every((l) => {
              const claves = new Set(l.reservas_periodo.map((id) => {
                const r = rs.find((x) => x.id === id)!;
                return `${r.ruta_etiqueta}|${r.turno}|${r.movil ?? 1}|${r.capacidad_contratada}`;
              }));
              return claves.size === 1;
            });
            if (dias !== an.pares.length || !unaTarifa || !etiquetadasBien) malos++;
          }
  ok(malos === 0, `${combos} combinaciones: cada ítem etiquetado tiene UNA ruta/turno/móvil/PAX y ningún día se pierde`, `${malos} mal`);
}

// ══ 4 · La propuesta ════════════════════════════════════════════════════════
let tid = 5000;
function tramo(o: Partial<TramoEtq> & { fecha: string; hora: string | null; nombre: string; dir?: "ida" | "retorno" }): TramoEtq {
  return {
    id: ++tid, codigo: `T${tid}`, cliente_id: o.cliente_id ?? 1, fecha_servicio: o.fecha, hora_servicio: o.hora,
    direccion_servicio: o.dir ?? "ida", ruta_nombre: o.nombre, reserva_vinculada_id: o.reserva_vinculada_id ?? null,
    estado: "programada", origen_contractual: o.origen_contractual ?? "contrato",
    capacidad_contratada: o.capacidad_contratada ?? 50, origen: "A", destino: "B",
    ruta_etiqueta: o.ruta_etiqueta ?? null, turno: o.turno ?? null, movil: o.movil ?? null,
  };
}
/** Ida + retorno enlazados en los dos sentidos. */
function par(fecha: string, horaIda: string, horaRet: string, nombre: string, extra: Partial<TramoEtq> = {}): TramoEtq[] {
  const a = tramo({ fecha, hora: horaIda, nombre: `${nombre}/ ENTRADA ${horaIda}/ SANTA ANITA→BSF`, ...extra });
  const b = tramo({ fecha, hora: horaRet, nombre: `${nombre}/ RETORNO ${horaRet}/ BSF→SANTA ANITA`, dir: "retorno", ...extra });
  a.reserva_vinculada_id = b.id; b.reserva_vinculada_id = a.id;
  return [a, b];
}

titulo("4 · La RUTA sale del nombre; el TURNO lo decide el operador");
{
  ok(rutaDelNombre("RUTA A/ ENTRADA 04:35/ SANTA ANITA") === "RUTA A", "«RUTA A/ ENTRADA…» → RUTA A");
  ok(rutaDelNombre("RUTA C/ENTRADA 4:35/ 1RO MAYO") === "RUTA C", "«RUTA C/ENTRADA…» → RUTA C (sin espacio tras la barra)");
  ok(rutaDelNombre("ENTRADA 06:30/ HOTEL EL VUELO") === null, "sin «RUTA X» en el nombre no se inventa");
  ok(rutaDelNombre(null) === null, "sin nombre tampoco");

  const tramos: TramoEtq[] = [];
  for (const f of fechas(1, 5)) { tramos.push(...par(f, "04:35", "15:00", "RUTA A")); tramos.push(...par(f, "06:30", "17:00", "RUTA A")); }
  const dias = proponerEtiquetas(armarDias(tramos));
  ok(dias.every((d) => d.propuesta.ruta === "RUTA A"), "la RUTA se propone del nombre");
  ok(dias.every((d) => d.propuesta.turno === null && d.motivo === "escribe_turno"),
    "sin nada escrito, el TURNO NO se deduce del orden de salida: lo escribe el operador");
  // Un feriado con una sola salida tampoco inventa nada (la regresión de la versión por orden).
  const solo = proponerEtiquetas(armarDias(par("2026-09-10", "06:30", "17:00", "RUTA A")));
  ok(solo[0].propuesta.turno === null, "la única salida del día NO se vuelve TURNO 1");

  // Herencia: lo ya escrito a la misma hora se propone a los días sin etiqueta.
  const conEscrito = tramos.map((t) => ({ ...t }));
  for (const t of conEscrito) if (t.fecha_servicio === "2026-09-01" && t.hora_servicio === "04:35") { t.ruta_etiqueta = "RUTA A"; t.turno = 3; }
  const d2 = proponerEtiquetas(armarDias(conEscrito));
  ok(d2.filter((d) => d.horaIda === "04:35" && !d.actual.etiquetas).every((d) => d.propuesta.turno === 3 && d.motivo === "propuesta"),
    "los días a las 04:35 heredan el TURNO que el operador escribió a esa hora (aunque sea el 3)");
  ok(d2.filter((d) => d.horaIda === "06:30").every((d) => d.propuesta.turno === null), "las 06:30 no heredan nada");
  // Escrito contradictorio → no se elige.
  for (const t of conEscrito) if (t.fecha_servicio === "2026-09-02" && t.hora_servicio === "04:35") { t.ruta_etiqueta = "RUTA A"; t.turno = 1; }
  const d3 = proponerEtiquetas(armarDias(conEscrito));
  ok(d3.filter((d) => d.horaIda === "04:35" && !d.actual.etiquetas).every((d) => d.propuesta.turno === null),
    "si lo escrito a esa hora no coincide (T3 y T1), no se hereda ninguno");
  const otra = proponerEtiquetas(armarDias(tramos));
  ok(JSON.stringify(otra.map((d) => [d.clave, d.propuesta, d.motivo])) === JSON.stringify(dias.map((d) => [d.clave, d.propuesta, d.motivo])),
    "misma entrada, misma propuesta");
}

titulo("4b · Dos buses a la misma hora → MÓVIL 1 y 2 (el de más PAX primero)");
{
  const tramos: TramoEtq[] = [];
  for (const f of fechas(1, 3)) {
    tramos.push(...par(f, "07:00", "16:00", "RUTA B", { capacidad_contratada: 30 }));
    tramos.push(...par(f, "07:00", "16:00", "RUTA B", { capacidad_contratada: 50 }));
  }
  const dias = proponerEtiquetas(armarDias(tramos));
  ok(dias.filter((d) => d.pax === 50).every((d) => d.propuesta.movil === 1), "el de 50 PAX es el MÓVIL 1");
  ok(dias.filter((d) => d.pax === 30).every((d) => d.propuesta.movil === 2), "el de 30 PAX es el MÓVIL 2");
}

titulo("4c · Lo que no se puede proponer, se DICE");
{
  const tramos: TramoEtq[] = [
    ...par("2026-09-01", "06:30", "17:00", "ENTRADA 06:30/ HOTEL EL VUELO"),
    tramo({ fecha: "2026-09-01", hora: null, nombre: "RUTA Z/ SIN HORA" }),
  ];
  const dias = proponerEtiquetas(armarDias(tramos));
  ok(dias.find((d) => d.nombre?.startsWith("ENTRADA"))!.motivo === "sin_ruta_en_nombre", "sin «RUTA X» → `sin_ruta_en_nombre`");
  ok(dias.find((d) => d.nombre?.startsWith("RUTA Z"))!.motivo === "sin_hora", "sin hora → `sin_hora`");
}

// ══ 5 · Grupos y guardado ═══════════════════════════════════════════════════
titulo("5 · Grupos del modal y lo que se escribe");
{
  const tramos: TramoEtq[] = [];
  for (const f of fechas(1, 3)) { tramos.push(...par(f, "04:35", "15:00", "RUTA A")); tramos.push(...par(f, "06:30", "17:00", "RUTA A")); }
  tramos.push(...par("2026-09-04", "05:00", "15:00", "RUTA A"));   // cambio de horario del T1
  tramos[0].ruta_etiqueta = "RUTA A"; tramos[0].turno = 1;          // un día ya etiquetado (retorno vacío)
  const dias = proponerEtiquetas(armarDias(tramos));
  const grupos = agruparParaEtiquetar(dias);
  const actual = grupos.find((g) => g.fuente === "actual")!;
  const g435 = grupos.find((g) => g.fuente === "propuesta" && g.horas[0]?.hora === "04:35")!;
  const g630 = grupos.find((g) => g.fuente === "propuesta" && g.horas[0]?.hora === "06:30")!;
  const g500 = grupos.find((g) => g.fuente === "propuesta" && g.horas[0]?.hora === "05:00")!;
  ok(!!actual && !!g435 && !!g630 && !!g500, "grupos: lo etiquetado, y los demás POR HORA de salida",
    grupos.map((g) => `${g.fuente}:${g.inicial.turno || g.horas[0]?.hora}×${g.dias.length}`).join(" · "));
  ok(actual.aMedio === 1, "el ya etiquetado declara que su retorno está vacío");
  ok(g435.inicial.turno === "1" && g435.completo, "las 04:35 heredan el T1 escrito y llegan completas");
  ok(!g630.completo && g630.inicial.turno === "", "las 06:30 llegan con el TURNO en blanco");

  // El operador escribe T1 a las 05:00 y T2 a las 06:30: todo queda guardable.
  const dec = new Map<string, DecisionGrupo>();
  for (const g of grupos) dec.set(g.clave, { ...g.inicial, aplicar: true });
  dec.set(g630.clave, { ...g630.inicial, turno: "2", aplicar: true });
  dec.set(g500.clave, { ...g500.inicial, turno: "1", aplicar: true });
  const plan = planDeGuardado(grupos, dec);
  ok(plan.errores.length === 0, "sin errores", plan.errores.map((e) => e.error).join(";"));
  ok(plan.tramos === 13 && plan.sinCambio === 1, "escribe 13 tramos y no cuenta el que ya decía eso", `${plan.tramos}/${plan.sinCambio}`);
  const ids = plan.lotes.flatMap((l) => l.ids);
  ok(new Set(ids).size === ids.length, "cada tramo recibe UN solo destino");

  const malo = new Map(dec);
  malo.set(g630.clave, { ruta: "RUTA A", turno: "", movil: "", aplicar: true });
  const p2 = planDeGuardado(grupos, malo);
  ok(p2.errores.length === 1 && /TURNO/.test(p2.errores[0].error), "RUTA sin TURNO → error con su porqué", p2.errores[0]?.error);

  const quitar = new Map<string, DecisionGrupo>([[actual.clave, { ruta: "", turno: "", movil: "", aplicar: true }]]);
  const p3 = planDeGuardado(grupos, quitar);
  ok(p3.quitar === 1 && p3.lotes[0]?.patch.ruta_etiqueta === null, "vaciar los tres campos QUITA las etiquetas", p3.quitar);
  ok(planDeGuardado(grupos, new Map()).tramos === 0, "sin grupos marcados no se escribe nada");
  ok(agruparParaEtiquetar(dias, { reemplazar: true }).every((g) => g.fuente === "propuesta"), "«reemplazar» agrupa todo por la propuesta");
  ok(cambiaEtiquetas({ ruta_etiqueta: "RUTA A", turno: 1, movil: null }, { ruta: "RUTA A", turno: 1, movil: null }) === false,
    "escribir lo mismo no es un cambio");
}

titulo("7 · Choques y huecos");
{
  // Dos buses el mismo día con la misma RUTA · TURNO · MÓVIL → aviso con los dos códigos.
  const rs = [
    ...dia({ fecha: "2026-09-01", nombreIda: "RUTA A/ E", nombreRet: "RUTA A/ R", etq: { ruta: "RUTA A", turno: 1 } }),
    ...dia({ fecha: "2026-09-01", horaIda: "06:30", nombreIda: "RUTA A/ E2", nombreRet: "RUTA A/ R2", etq: { ruta: "RUTA A", turno: 1 } }),
    ...dia({ fecha: "2026-09-01", nombreIda: "RUTA A/ E3", nombreRet: "RUTA A/ R3", etq: { ruta: "RUTA A", turno: 1, movil: 2 } }),
  ];
  const an = analizarServicios(rs, "cliente");
  ok(choquesDeEtiquetas(an.pares).length === 1, "un choque: dos días RUTA A · T1 sin móvil el mismo día");
  ok(an.avisos.some((a) => /mismas etiquetas/.test(a.mensaje)), "y el cierre lo avisa");
  const sinChoque = analizarServicios([
    ...dia({ fecha: "2026-09-01", nombreIda: "RUTA A/ E", nombreRet: "RUTA A/ R", etq: { ruta: "RUTA A", turno: 1, movil: 1 } }),
    ...dia({ fecha: "2026-09-01", nombreIda: "RUTA A/ E", nombreRet: "RUTA A/ R", etq: { ruta: "RUTA A", turno: 1, movil: 2 } }),
    ...dia({ fecha: "2026-09-02", nombreIda: "RUTA A/ E", nombreRet: "RUTA A/ R", etq: { ruta: "RUTA A", turno: 1, movil: 1 } }),
  ], "cliente");
  ok(choquesDeEtiquetas(sinChoque.pares).length === 0, "MÓVIL 1 y 2 el mismo día, o el mismo móvil en días distintos, no chocan");

  // Huecos: T1 sale lun-vie tres semanas y falta el miércoles 16.
  const e = { ruta: "RUTA A", turno: 1, movil: null };
  const dias = fechas(1, 21)
    .filter((f) => ![0, 6].includes(new Date(f + "T00:00:00Z").getUTCDay()) && f !== "2026-09-16")
    .map((f) => ({ cliente_id: 1, fecha: f, etiquetas: e }));
  const h = huecosDeEtiquetas(dias, "2026-09-01", "2026-09-30");
  ok(h.length === 1 && h[0].fecha === "2026-09-16", "falta el miércoles 16 → un hueco; los fines de semana no", h.map((x) => x.fecha).join(","));
  const adic = huecosDeEtiquetas([{ cliente_id: 1, fecha: "2026-09-01", etiquetas: e, adicional: true }], "2026-09-01", "2026-09-30");
  ok(adic.length === 0, "los adicionales no definen el patrón");
}

titulo("6 · Utilidades de pantalla");
{
  ok(rotuloEtiquetas({ ruta: "RUTA A", turno: 1, movil: 2 }, 50) === "RUTA A · T1 · M2 · 50 PAX", "chip corto", rotuloEtiquetas({ ruta: "RUTA A", turno: 1, movil: 2 }, 50));
  ok(faltaMigracionEtiquetas("column reservas.ruta_etiqueta does not exist"), "reconoce la migración que falta");
  ok(!faltaMigracionEtiquetas("duplicate key value violates unique constraint"), "y no confunde otro error con ella");
}

console.log(`\n${fallos ? `${fallos} FALLA(S)` : "TODO EN VERDE"}`);
process.exit(fallos ? 1 : 0);
