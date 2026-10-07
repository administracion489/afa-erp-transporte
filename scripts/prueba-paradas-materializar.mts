// scripts/prueba-paradas-materializar.mts — Matriz de lib/paradas-materializar.ts.
// Correr: npx tsx scripts/prueba-paradas-materializar.mts
//
// Fija las promesas del módulo:
//   1. Las reglas son las del «Iniciar», EXTRAÍDAS, no reescritas: orden, cascada y mapeo dan lo
//      mismo que los originales copiados literal (sortLeg, la cascada de app/api/conductor-paradas
//      y de resolverParadasJSON, y el `.map` de las filas).
//   2. El cron solo crea paraderos para un servicio de hoy que «Elige tu ruta de hoy» ofrecería, que
//      no los tiene y que tiene semilla con nombres — y a un retorno de cotización SOLO la lista de
//      retorno de su cotización: nunca la de la ida, ni la actual ni una vieja.
//   3. Tras una carrera solo se borran filas NUESTRAS.
//   4. Propagar no toca servicios con actividad o pasajeros, ni retornos sin lista, ni idas sin lista;
//      y con las dos listas puestas hace exactamente lo que hacía antes.

import {
  ordenarTramo, semillaDeServicio, filasDeSemilla, tieneParaderosDeRetorno, firmaNombres,
  estadoRetorno, semillaConNombres, esCandidatoDeHoy, ESTADOS_SIN_INICIAR, planDeServicio, MOTIVO_MATERIALIZAR,
  sobrantesTrasCarrera, faltanCoordenadas, avisoRetorno, AVISO_GENERADOR_SIN_RETORNO,
  planDePropagacion, MOTIVO_NO_PROPAGA,
  type ServicioSemilla, type CotizacionSemilla, type CodigoMaterializar, type MotivoNoPropaga,
} from "../lib/paradas-materializar";

let fallos = 0, total = 0;
function ok(cond: boolean, nombre: string) {
  total++;
  if (!cond) { fallos++; console.log(`  ✗ ${nombre}`); }
  else console.log(`  ✓ ${nombre}`);
}
/** Para los barridos: cuenta todo, imprime solo los fallos (y como mucho 5). */
function barrido(nombre: string) {
  let n = 0, mal = 0; const ejemplos: string[] = [];
  return {
    check(cond: boolean, detalle: () => string) { n++; if (!cond) { mal++; if (ejemplos.length < 5) ejemplos.push(detalle()); } },
    fin() { ok(mal === 0, `${nombre} (${n} combinaciones${mal ? `, ${mal} fallan: ${ejemplos.join(" | ")}` : ""})`); },
  };
}
const igual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => igual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => igual((a as any)[k], (b as any)[k]));
  }
  return false;
};

// ── Los ORIGINALES, copiados literal (app/api/conductor-paradas y app/programacion, main 47fa64e) ──
const sortLeg = (arr: any[]) => [
  ...arr.filter((p: any) => p.tipo === "inicio"),
  ...arr.filter((p: any) => p.tipo === "intermedia"),
  ...arr.filter((p: any) => p.tipo === "destino"),
  ...arr.filter((p: any) => !["inicio", "intermedia", "destino"].includes(p.tipo)),
];
/** La cascada del «Iniciar», con la consulta de la cotización sustituida por su resultado. */
function cascadaVieja(reserva: any, cotDeLaBase: any): any[] {
  let jsonParadas: any[] = [];
  if (Array.isArray(reserva.paradas_json) && reserva.paradas_json.length > 0) {
    jsonParadas = sortLeg(reserva.paradas_json);
  } else if (reserva.cotizacion_id) {
    const cot = cotDeLaBase;
    if (reserva.direccion_servicio === "retorno") {
      const ret = Array.isArray(cot?.paradas_retorno_json) && cot.paradas_retorno_json.length > 0
        ? cot.paradas_retorno_json : cot?.paradas_json;
      if (Array.isArray(ret)) jsonParadas = sortLeg(ret);
    } else if (Array.isArray(cot?.paradas_json)) {
      jsonParadas = sortLeg(cot.paradas_json);
    }
  }
  return jsonParadas;
}
const filasViejas = (reservaId: number, jsonParadas: any[]) => jsonParadas.map((p: any, i: number) => ({
  reserva_id: reservaId, orden: i + 1, nombre: p.nombre, direccion: p.direccion || null,
  lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
  hora_estimada: p.hora || null, estado: "pendiente",
}));
/** Cómo los llamadores nuevos (Iniciar, Programación, el cron) piden la cotización: solo sin semilla propia. */
function cascadaNueva(reserva: any, cotDeLaBase: any): any[] {
  const propia = Array.isArray(reserva.paradas_json) && reserva.paradas_json.length > 0;
  const cot = !propia && reserva.cotizacion_id ? cotDeLaBase : null;
  return semillaDeServicio(reserva, cot).semilla;
}

// ── Datos ──────────────────────────────────────────────────────────────────────
const P = (nombre: string, tipo: string | null | undefined, extra: Record<string, unknown> = {}) =>
  ({ nombre, tipo, lat: "-12.0", lng: "-76.9", hora: "05:10", ...extra });
const IDA = [P("Ate", "inicio", { hora: "05:10" }), P("Puente Santa Anita", "intermedia", { hora: "05:25" }), P("Planta Lurín", "destino", { hora: "06:30" })];
const RET = [P("Planta Lurín", "inicio", { hora: "17:00" }), P("Puente Santa Anita (sur)", "intermedia", { hora: "18:10" }), P("Ate", "destino", { hora: "18:30" })];
const HOY = "2026-10-06";

console.log("\n1. ordenarTramo ≡ sortLeg (copiado literal)");
{
  const tipos = ["inicio", "intermedia", "destino", null, undefined, "otro", "INICIO"];
  const b = barrido("mismo orden y mismas referencias que sortLeg");
  const gen = (n: number, pref: any[]): any[][] => n === 0 ? [pref] : tipos.flatMap((t) => gen(n - 1, [...pref, { tipo: t, nombre: `p${pref.length}` }]));
  for (let n = 0; n <= 4; n++) {
    for (const arr of gen(n, [])) {
      const a = ordenarTramo(arr), v = sortLeg(arr);
      b.check(a.length === v.length && a.every((x, i) => x === v[i]), () => JSON.stringify(arr.map((p) => p.tipo)));
    }
  }
  b.fin();
  const sinTipo = [{ nombre: "x" }] as any[];
  ok(ordenarTramo(sinTipo).length === 1, "un paradero sin `tipo` no se pierde (va al final)");
}

console.log("\n2. semillaDeServicio ≡ la cascada del «Iniciar» (copiada literal)");
{
  const propias: unknown[] = [undefined, null, [], [P("Propio", "inicio")], "texto", {}];
  const direcciones = ["ida", "retorno", null, undefined, "RETORNO"];
  const cotIds = [null, undefined, 0, 7];
  const cots: any[] = [
    null,
    { paradas_json: [], paradas_retorno_json: [] },
    { paradas_json: IDA, paradas_retorno_json: undefined },
    { paradas_json: IDA, paradas_retorno_json: RET },
    { paradas_json: null, paradas_retorno_json: RET },
    { paradas_json: "x", paradas_retorno_json: [] },
    { paradas_json: IDA, paradas_retorno_json: {} },
    { paradas_json: [], paradas_retorno_json: null },
  ];
  const b = barrido("misma semilla, en el mismo orden");
  const bf = barrido("la fuente declarada es coherente con la semilla");
  for (const pj of propias) for (const d of direcciones) for (const cid of cotIds) for (const cot of cots) {
    const r = { id: 1, paradas_json: pj, direccion_servicio: d, cotizacion_id: cid };
    const nueva = cascadaNueva(r, cot), vieja = cascadaVieja(r, cot);
    b.check(nueva.length === vieja.length && nueva.every((x, i) => x === vieja[i]),
      () => JSON.stringify({ pj, d, cid, cot: cot && Object.keys(cot) }));
    const propia = Array.isArray(pj) && pj.length > 0;
    const { semilla, fuente } = semillaDeServicio(r, propia || !cid ? null : cot);
    bf.check(
      (fuente === "reserva") === propia
        && (fuente === "ninguna") === (semilla.length === 0)
        && (fuente === "cotizacion") === (!propia && semilla.length > 0),
      () => JSON.stringify({ pj, d, cid, fuente, n: semilla.length }));
  }
  b.fin();
  bf.fin();
  ok(semillaDeServicio({ paradas_json: null, direccion_servicio: "retorno" }, { paradas_json: IDA, paradas_retorno_json: RET })
    .semilla.map((p) => p.nombre).join(",") === "Planta Lurín,Puente Santa Anita (sur),Ate",
    "un retorno sin semilla propia toma la lista de RETORNO de su cotización");
  ok(semillaDeServicio({ paradas_json: null, direccion_servicio: "ida" }, { paradas_json: IDA, paradas_retorno_json: RET })
    .semilla[0].nombre === "Ate", "una ida toma la lista de ida");
}

console.log("\n3. filasDeSemilla ≡ el mapeo del «Iniciar» (copiado literal)");
{
  const lats: unknown[] = [undefined, null, "", 0, "0", "-12.05", -12.05, "abc", " "];
  const horas: unknown[] = [undefined, null, "", "05:10"];
  const dirs: unknown[] = [undefined, null, "", "Av. Grau 123"];
  const nombres: unknown[] = [undefined, null, "", "Ate"];
  const b = barrido("mismas filas campo por campo (NaN incluido)");
  for (const lat of lats) for (const lng of [lats[0], lats[3], lats[5], lats[7]]) for (const hora of horas) for (const direccion of dirs) for (const nombre of nombres) {
    const semilla = [{ tipo: "inicio", nombre, lat, lng, hora, direccion }, { tipo: "destino", nombre: "Fin", lat: "1", lng: "2" }] as any[];
    b.check(igual(filasDeSemilla(42, semilla), filasViejas(42, semilla)),
      () => JSON.stringify({ lat, lng, hora, direccion, nombre }));
  }
  b.fin();
  const f = filasDeSemilla(9, ordenarTramo(RET as any));
  ok(f.map((x) => x.orden).join(",") === "1,2,3", "orden 1..N en el orden del tramo");
  ok(f.every((x) => x.reserva_id === 9 && x.estado === "pendiente"), "todas de la reserva y pendientes");
  ok(f[0].hora_estimada === "17:00", "la hora del paradero viaja tal cual (no se deriva de otra cosa)");
}

console.log("\n4. faltanCoordenadas ≡ `!parada.lat || !parada.lng` del «Iniciar»");
{
  const vals: unknown[] = [undefined, null, 0, "", "0", -12.05, "abc", NaN];
  const b = barrido("misma decisión de geocodificar");
  for (const lat of vals) for (const lng of vals) {
    const parada: any = { lat, lng };
    b.check(faltanCoordenadas(parada) === (!parada.lat || !parada.lng), () => JSON.stringify({ lat, lng }));
  }
  b.fin();
}

console.log("\n5. Un retorno NO se deduce de la ida (estadoRetorno)");
{
  const cotSinRet: CotizacionSemilla = { paradas_json: IDA, paradas_retorno_json: [] };
  const cotConRet: CotizacionSemilla = { paradas_json: IDA, paradas_retorno_json: RET };
  const ret = (paradas_json: unknown, cotizacion_id: number | null = 240) => ({ paradas_json, direccion_servicio: "retorno", cotizacion_id });
  ok(estadoRetorno({ paradas_json: null, direccion_servicio: "ida", cotizacion_id: 240 }, cotSinRet) === "no_aplica", "una IDA no se juzga");
  ok(estadoRetorno(ret(RET, null), null) === "no_aplica", "un retorno suelto (sin cotización) usa su semilla");
  ok(estadoRetorno(ret(null), null) === "sin_cotizacion", "con cotización que no se pudo leer: no se afirma nada");
  ok(estadoRetorno(ret(null), cotSinRet) === "sin_lista", "cotización sin lista de retorno → no");
  ok(estadoRetorno(ret(IDA), cotSinRet) === "sin_lista", "la semilla que escribe el generador (la ida tal cual) → no");
  ok(estadoRetorno(ret(RET), cotSinRet) === "sin_lista", "ni con una semilla distinta: sin lista de retorno no hay contra qué probarla");
  ok(estadoRetorno(ret(null), cotConRet) === "ok", "sin semilla propia la cascada toma la lista de retorno → sí");
  ok(estadoRetorno(ret([]), cotConRet) === "ok", "semilla vacía → sí");
  ok(estadoRetorno(ret(RET), cotConRet) === "ok", "semilla = la lista de retorno → sí");
  ok(estadoRetorno(ret(RET.map((p) => ({ ...p, nombre: `  ${p.nombre.toUpperCase()}  `, hora: "17:30", lat: null }))), cotConRet) === "ok",
    "mismos nombres con otras mayúsculas, espacios, horas o sin coordenadas → sí (la firma es por nombre)");
  ok(estadoRetorno(ret([RET[2], RET[0], RET[1]]), cotConRet) === "ok", "misma lista en otro orden de array (mismo orden por tipo) → sí");
  // Revisión: los dos caminos por los que un retorno guarda la ida aunque la ida «actual» sea otra.
  const idaEditada = [IDA[0], P("Óvalo Santa Anita", "intermedia", { hora: "05:30" }), IDA[2]];
  ok(estadoRetorno(ret(IDA), { paradas_json: idaEditada, paradas_retorno_json: [] }) === "sin_lista",
    "caso A: la ida se editó y se propagó, el retorno quedó con la ida VIEJA → no");
  ok(estadoRetorno(ret(IDA), cotConRet) === "semilla_distinta",
    "caso B: la cotización ganó su lista de retorno pero no se propagó (el retorno guarda la ida) → no");
  ok(estadoRetorno(ret([RET[0], RET[2]]), cotConRet) === "semilla_distinta", "una versión vieja de la lista de retorno → no (falta propagar)");
  ok(tieneParaderosDeRetorno(cotConRet) && !tieneParaderosDeRetorno(cotSinRet) && !tieneParaderosDeRetorno(null)
    && !tieneParaderosDeRetorno({ paradas_retorno_json: "x" }), "tieneParaderosDeRetorno exige una lista no vacía");
  ok(firmaNombres(IDA as any) === "ate › puente santa anita › planta lurín", "la firma va por nombre, en el orden del tramo");
  ok(firmaNombres(null) === "", "firma de nada = vacía");
}

console.log("\n5b. Semillas sin nombre (el formato del Cotizador)");
{
  const cotizador = [{ id: "a", tipo: "inicio", texto: "Ate", place: { lat: -12, lng: -76.9 } }, { id: "b", tipo: "destino", texto: "Lurín", place: null }];
  ok(!semillaConNombres(cotizador as any), "los puntos del Cotizador (texto/place, sin nombre) no sirven");
  ok(!semillaConNombres([P("Ate", "inicio"), { tipo: "destino", nombre: "  " }] as any), "un solo paradero sin nombre basta para no servir");
  ok(semillaConNombres(IDA as any) && semillaConNombres([]), "una semilla con todos sus nombres sirve");
  const plan = planDeServicio({ id: 9, fecha_servicio: HOY, estado: "programada", permite_autoseleccion: true, cliente_id: 3,
    cotizacion_id: 300, direccion_servicio: "ida", paradas_json: cotizador }, HOY, false, { paradas_json: cotizador });
  ok(plan.codigo === "semilla_sin_nombres" && plan.filas.length === 0, "el cron no crea paraderos sin nombre para ofrecerlos al pasajero");
}

console.log("\n6. esCandidatoDeHoy = la rama «hoy» de «Elige tu ruta de hoy»");
{
  ok(ESTADOS_SIN_INICIAR.join(",") === "pendiente,programada,confirmada", "los estados sin iniciar son los de reservas_disponibles");
  const fechas = [HOY, `${HOY}T05:00:00`, "2026-10-05", "2026-10-07", null, undefined];
  const estados = ["pendiente", "programada", "confirmada", "en_curso", "finalizada", "cancelada", "PENDIENTE", null];
  const permites: unknown[] = [true, false, null, undefined, "true", 1];
  const clientes: unknown[] = [3, 0, null, undefined];
  const b = barrido("candidato ⟺ hoy ∧ sin iniciar ∧ casilla === true ∧ con cliente");
  for (const f of fechas) for (const e of estados) for (const p of permites) for (const c of clientes) {
    const r = { id: 1, fecha_servicio: f, estado: e, permite_autoseleccion: p, cliente_id: c } as ServicioSemilla;
    const esperado = String(f ?? "").slice(0, 10) === HOY
      && ["pendiente", "programada", "confirmada"].includes(String(e)) && p === true && c != null;
    b.check(esCandidatoDeHoy(r, HOY) === esperado, () => JSON.stringify({ f, e, p, c }));
  }
  b.fin();
}

console.log("\n7. planDeServicio · el caso del 06-10");
{
  const base = { fecha_servicio: HOY, estado: "programada", permite_autoseleccion: true, cliente_id: 3, cotizacion_id: 240 };
  const cot: CotizacionSemilla = { id: 240, paradas_json: IDA, paradas_retorno_json: RET };
  // El retorno RUTA A 17:00 (#29413): nadie lo abrió, no tenía paraderos.
  const retorno = planDeServicio({ ...base, id: 29413, direccion_servicio: "retorno", paradas_json: RET }, HOY, false, cot);
  ok(retorno.codigo === "crear", "el retorno de hoy sin paraderos se materializa");
  ok(retorno.filas.map((f) => f.nombre).join(" › ") === "Planta Lurín › Puente Santa Anita (sur) › Ate",
    "con SUS paraderos de retorno (el del lado sur de la pista)");
  ok(retorno.filas[0].hora_estimada === "17:00", "y con SU hora, no la de la mañana");
  const ida = planDeServicio({ ...base, id: 29412, direccion_servicio: "ida", paradas_json: null }, HOY, false, cot);
  ok(ida.codigo === "crear" && ida.fuente === "cotizacion" && ida.filas.length === 3, "la ida sin semilla propia toma la de la cotización");
  ok(planDeServicio({ ...base, id: 1, direccion_servicio: "ida", paradas_json: IDA }, HOY, true, cot).codigo === "ya_tiene_paraderos",
    "uno que alguien ya abrió no se toca");
  ok(planDeServicio({ ...base, id: 1, fecha_servicio: "2026-10-07", direccion_servicio: "ida", paradas_json: IDA }, HOY, false, cot).codigo === "no_candidato",
    "el de mañana se queda como estaba (se materializa en su día)");

  // El retorno de una cotización SIN lista de retorno (lo que prohibió el dueño).
  const cotSinRet: CotizacionSemilla = { id: 250, paradas_json: IDA, paradas_retorno_json: [] };
  const her = planDeServicio({ ...base, id: 5, cotizacion_id: 250, direccion_servicio: "retorno", paradas_json: IDA }, HOY, false, cotSinRet);
  ok(her.codigo === "retorno_sin_lista" && her.filas.length === 0, "retorno con la lista de la ida → NO se materializa");
  ok(planDeServicio({ ...base, id: 5, cotizacion_id: 250, direccion_servicio: "retorno", paradas_json: null }, HOY, false, cotSinRet).codigo === "retorno_sin_lista",
    "ni aunque no tenga semilla (la cascada caería a la ida)");
  ok(planDeServicio({ ...base, id: 5, cotizacion_id: 250, direccion_servicio: "retorno", paradas_json: RET }, HOY, false, cotSinRet).codigo === "retorno_sin_lista",
    "ni con otra lista guardada: sin lista de retorno en la cotización no hay con qué probarla");
  ok(planDeServicio({ ...base, id: 5, direccion_servicio: "retorno", paradas_json: IDA }, HOY, false, cot).codigo === "retorno_semilla_distinta",
    "la cotización tiene lista de retorno pero este retorno guarda la ida (no se propagó) → NO");
  ok(planDeServicio({ ...base, id: 5, cotizacion_id: 250, direccion_servicio: "retorno", paradas_json: IDA }, HOY, false, undefined).codigo === "retorno_sin_cotizacion",
    "sin poder leer la cotización no se materializa un retorno");
  ok(planDeServicio({ ...base, id: 5, cotizacion_id: null, direccion_servicio: "retorno", paradas_json: RET }, HOY, false, undefined).codigo === "crear",
    "un retorno SIN cotización (suelto) con su semilla sí se materializa");
  ok(planDeServicio({ ...base, id: 6, cotizacion_id: null, direccion_servicio: "ida", paradas_json: null }, HOY, false, undefined).codigo === "sin_semilla",
    "sin semilla ni cotización (despachador/CRM) → no se inventan paraderos");
  for (const c of Object.keys(MOTIVO_MATERIALIZAR) as CodigoMaterializar[]) {
    ok(MOTIVO_MATERIALIZAR[c].length > 10, `«${c}» tiene su motivo escrito`);
  }
}

console.log("\n8. planDeServicio · invariantes por barrido");
{
  const semillas: unknown[] = [null, [], IDA, RET, [IDA[0], IDA[1]], "x", [{ tipo: "inicio", texto: "Ate" }]];
  const cots: (CotizacionSemilla | null | undefined)[] = [
    undefined, null,
    { paradas_json: IDA, paradas_retorno_json: RET },
    { paradas_json: IDA, paradas_retorno_json: [] },
    { paradas_json: [], paradas_retorno_json: RET },
    { paradas_json: [], paradas_retorno_json: [] },
    { paradas_json: IDA, paradas_retorno_json: null },
  ];
  const vistos = new Set<CodigoMaterializar>();
  const bFilas = barrido("filas > 0 ⟺ codigo = crear");
  const bCrear = barrido("crear ⟹ candidato ∧ sin paraderos ∧ semilla con nombres ∧ retorno probado");
  const bConPar = barrido("un servicio con paraderos NUNCA se materializa");
  const bIgual = barrido("lo que crea el cron ≡ lo que crearía el «Iniciar» (original literal)");
  const bIda = barrido("un retorno de cotización solo se crea con la lista de RETORNO de su cotización");
  const bSinCot = barrido("retorno con cotización ilegible ⟹ retorno_sin_cotizacion (si es candidato y sin paraderos)");
  for (const fecha of [HOY, "2026-10-07"]) for (const estado of ["programada", "en_curso"])
  for (const permite of [true, false]) for (const cliente of [3, null])
  for (const dir of ["ida", "retorno", null]) for (const cotizacion_id of [null, 240])
  for (const pj of semillas) for (const cot of cots) for (const conParaderos of [false, true]) {
    const r: ServicioSemilla = { id: 77, fecha_servicio: fecha, estado, permite_autoseleccion: permite, cliente_id: cliente,
      direccion_servicio: dir, cotizacion_id, paradas_json: pj };
    const cotPasada = cotizacion_id == null ? undefined : cot;
    const plan = planDeServicio(r, HOY, conParaderos, cotPasada);
    vistos.add(plan.codigo);
    const det = () => JSON.stringify({ fecha, estado, permite, cliente, dir, cotizacion_id, pj: Array.isArray(pj) ? pj.length : pj, cot: cot && Object.values(cot).map((v) => Array.isArray(v) ? v.length : v), conParaderos, codigo: plan.codigo });
    bFilas.check((plan.filas.length > 0) === (plan.codigo === "crear"), det);
    const estRet = estadoRetorno(r, cotPasada);
    const semilla = semillaDeServicio(r, cotPasada).semilla;
    bCrear.check(plan.codigo !== "crear" || (esCandidatoDeHoy(r, HOY) && !conParaderos && semilla.length > 0
      && semillaConNombres(semilla) && (estRet === "ok" || estRet === "no_aplica")), det);
    bConPar.check(!conParaderos || plan.codigo === "no_candidato" || plan.codigo === "ya_tiene_paraderos", det);
    if (plan.codigo === "crear") bIgual.check(igual(plan.filas, filasViejas(77, cascadaVieja(r, cotPasada ?? null))), det);
    const c = cotPasada;
    if (plan.codigo === "crear" && dir === "retorno" && cotizacion_id != null) {
      bIda.check(!!c && tieneParaderosDeRetorno(c)
        && firmaNombres(plan.filas.map((f) => ({ nombre: f.nombre }))) === firmaNombres(c.paradas_retorno_json as any), det);
    }
    if (dir === "retorno" && cotizacion_id != null && !cot && esCandidatoDeHoy(r, HOY) && !conParaderos) {
      bSinCot.check(plan.codigo === "retorno_sin_cotizacion", det);
    }
  }
  bFilas.fin(); bCrear.fin(); bConPar.fin(); bIgual.fin(); bIda.fin(); bSinCot.fin();
  // Corolario: un motor que no creara nunca nada cumpliría todo lo anterior.
  const todos = Object.keys(MOTIVO_MATERIALIZAR) as CodigoMaterializar[];
  ok(todos.every((c) => vistos.has(c)), `el barrido alcanza los ${todos.length} códigos, «crear» incluido (vistos: ${[...vistos].join(", ")})`);
}

console.log("\n9. sobrantesTrasCarrera · solo se borran filas NUESTRAS");
{
  ok(sobrantesTrasCarrera([1, 2, 3], [1, 2, 3]).length === 0, "sin carrera no se borra nada");
  ok(igual(sobrantesTrasCarrera([4, 5], [1, 2, 4, 5]), [4, 5]), "con filas ajenas, se borran las nuestras");
  ok(sobrantesTrasCarrera([4, 5], [1, 2]).length === 0, "si las nuestras ya no están, nada que borrar");
  ok(sobrantesTrasCarrera([], [1, 2]).length === 0, "sin haber insertado, nunca se borra");
  const b = barrido("resultado ⊆ insertadas ∩ actuales, y vacío ⟺ sin filas ajenas o sin nuestras");
  for (let mascara = 0; mascara < 1 << 8; mascara++) {
    const ins = [1, 2, 3, 4].filter((_, i) => mascara & (1 << i));
    const act = [1, 2, 3, 4, 10, 11, 12, 13].filter((_, i) => mascara & (1 << ((i + 3) % 8)));
    const s = sobrantesTrasCarrera(ins, act);
    const ajenas = act.some((id) => !ins.includes(id));
    const nuestras = act.filter((id) => ins.includes(id));
    b.check(s.every((id) => ins.includes(id) && act.includes(id))
      && (s.length > 0) === (ajenas && nuestras.length > 0)
      && (!ajenas || igual(s, nuestras)), () => JSON.stringify({ ins, act, s }));
  }
  b.fin();
}

console.log("\n10. planDePropagacion · qué rehace Propagar");
{
  /** El Propagar viejo, copiado literal (sin las llamadas a la base). */
  const propagarViejo = (reservas: any[], paradasIda: any[], paradasRet: any[], idsConActividad: Set<number>) => {
    const reservasAfectar = reservas.filter((r) => !idsConActividad.has(r.id));
    const tramoRet = paradasRet.length > 0 ? paradasRet : paradasIda;
    const idsIda = reservasAfectar.filter((r) => r.direccion_servicio !== "retorno").map((r) => r.id);
    const idsRet = reservasAfectar.filter((r) => r.direccion_servicio === "retorno").map((r) => r.id);
    return { idsIda, idsRet, tramoRet };
  };
  // El defecto que se cierra: el retorno recibía la lista de la ida, y la ida sin lista se quedaba sin nada.
  const resv = [{ id: 1, direccion_servicio: "ida" }, { id: 2, direccion_servicio: "retorno" }];
  const viejo = propagarViejo(resv, IDA, [], new Set());
  ok(viejo.idsRet.includes(2) && viejo.tramoRet === IDA, "el Propagar viejo le ponía al retorno la lista de la IDA (el defecto existe)");
  const nuevo = planDePropagacion(resv, { ida: IDA, retorno: [] }, new Set(), new Set());
  ok(!nuevo.retorno.includes(2) && nuevo.fuera.some((f) => f.id === 2 && f.motivo === "retorno_sin_lista"),
    "el nuevo deja ese retorno como está, con su motivo");
  ok(planDePropagacion(resv, { ida: [], retorno: RET }, new Set(), new Set()).fuera.some((f) => f.id === 1 && f.motivo === "ida_sin_lista"),
    "una ida sin lista de ida no se borra (antes quedaba sin paraderos)");
  ok(planDePropagacion(resv, { ida: IDA, retorno: RET }, new Set(), new Set([2])).fuera.some((f) => f.id === 2 && f.motivo === "con_pasajeros"),
    "un servicio con pasajeros asignados no se rehace");

  const dirs = ["ida", "retorno", null];
  const listas = [{ ida: IDA, retorno: RET }, { ida: IDA, retorno: [] }, { ida: [], retorno: RET }, { ida: [], retorno: [] }];
  const bDisj = barrido("ida, retorno y fuera son disjuntos y cubren todos los servicios");
  const bNunca = barrido("nunca se tocan actividad, pasajeros, retornos sin lista ni idas sin lista");
  const bMotivo = barrido("el motivo respeta la precedencia actividad → pasajeros → lista");
  const bAntes = barrido("con las dos listas y sin pasajeros, toca EXACTAMENTE lo mismo que el Propagar viejo");
  const motivos = new Set<MotivoNoPropaga>();
  for (let n = 0; n <= 4; n++) for (let combo = 0; combo < 3 ** n; combo++) {
    const reservas = Array.from({ length: n }, (_, i) => ({ id: i + 1, direccion_servicio: dirs[Math.floor(combo / 3 ** i) % 3] }));
    for (let mAct = 0; mAct < 1 << n; mAct++) for (let mPas = 0; mPas < 1 << n; mPas += Math.max(1, (1 << n) - 1)) for (const l of listas) {
      const act = new Set(reservas.filter((_, i) => mAct & (1 << i)).map((r) => r.id));
      const pas = new Set(reservas.filter((_, i) => mPas & (1 << i)).map((r) => r.id));
      const p = planDePropagacion(reservas, l, act, pas);
      p.fuera.forEach((f) => motivos.add(f.motivo));
      const det = () => JSON.stringify({ reservas: reservas.map((r) => r.direccion_servicio), act: [...act], pas: [...pas], ida: l.ida.length, ret: l.retorno.length, p });
      const todos = [...p.ida, ...p.retorno, ...p.fuera.map((f) => f.id)];
      bDisj.check(todos.length === reservas.length && new Set(todos).size === reservas.length, det);
      bNunca.check([...p.ida, ...p.retorno].every((id) => !act.has(id) && !pas.has(id))
        && (l.retorno.length > 0 || p.retorno.length === 0) && (l.ida.length > 0 || p.ida.length === 0)
        && p.retorno.every((id) => reservas.find((r) => r.id === id)!.direccion_servicio === "retorno")
        && p.ida.every((id) => reservas.find((r) => r.id === id)!.direccion_servicio !== "retorno"), det);
      bMotivo.check(p.fuera.every((f) => act.has(f.id) ? f.motivo === "con_actividad"
        : pas.has(f.id) ? f.motivo === "con_pasajeros"
        : reservas.find((r) => r.id === f.id)!.direccion_servicio === "retorno" ? f.motivo === "retorno_sin_lista" : f.motivo === "ida_sin_lista"), det);
      if (l.ida.length && l.retorno.length && pas.size === 0) {
        const v = propagarViejo(reservas, l.ida, l.retorno, act);
        bAntes.check(igual(p.ida, v.idsIda) && igual(p.retorno, v.idsRet) && v.tramoRet === l.retorno, det);
      }
    }
  }
  bDisj.fin(); bNunca.fin(); bMotivo.fin(); bAntes.fin();
  ok((Object.keys(MOTIVO_NO_PROPAGA) as MotivoNoPropaga[]).every((m) => motivos.has(m)), "el barrido alcanza los cuatro motivos");
}

console.log("\n11. Lo que se le dice al operador");
{
  const a = avisoRetorno("sin_lista", "COT-0240")!;
  ok(a.chip === "SIN PARADEROS DE RETORNO", "sin lista: el chip nombra lo que falta");
  ok(a.detalle.includes("COT-0240") && /no deduce los paraderos de un retorno/.test(a.detalle), "el detalle nombra la cotización y la regla");
  ok(/Propagar/.test(a.detalle), "y dice dónde se arregla");
  ok(avisoRetorno("sin_lista", null)!.detalle.startsWith("Su cotización"), "sin número no imprime «null»");
  const d = avisoRetorno("semilla_distinta", "COT-0240")!;
  ok(d.chip === "PARADEROS DE RETORNO SIN PROPAGAR" && /Propagar/.test(d.detalle), "semilla distinta: su propio chip, y el arreglo es propagar");
  ok(avisoRetorno("ok", "x") === null && avisoRetorno("no_aplica", "x") === null && avisoRetorno("sin_cotizacion", "x") === null,
    "sin nada que decir (o sin poder juzgar) no hay chip");
  // El chip y el cron dicen lo mismo: hay chip ⟺ el cron se niega por el retorno.
  const b = barrido("chip ⟺ el cron no materializa por el retorno (sin lista o semilla distinta)");
  for (const pj of [null, [], IDA, RET, [RET[0]]]) for (const cr of [[], RET, null] as unknown[]) {
    const r: ServicioSemilla = { id: 1, fecha_servicio: HOY, estado: "programada", permite_autoseleccion: true, cliente_id: 3,
      cotizacion_id: 240, direccion_servicio: "retorno", paradas_json: pj };
    const cotX = { paradas_json: IDA, paradas_retorno_json: cr };
    const chip = avisoRetorno(estadoRetorno(r, cotX), null) !== null;
    const codigo = planDeServicio(r, HOY, false, cotX).codigo;
    b.check(chip === (codigo === "retorno_sin_lista" || codigo === "retorno_semilla_distinta"), () => JSON.stringify({ pj, cr, codigo }));
  }
  b.fin();
  ok(/no los deduce de la ida/.test(AVISO_GENERADOR_SIN_RETORNO) && /Elige tu ruta de hoy/.test(AVISO_GENERADOR_SIN_RETORNO),
    "el generador dice la MISMA regla y su consecuencia");
}

console.log(`\n${total - fallos}/${total} comprobaciones OK`);
if (fallos > 0) { console.log(`\n${fallos} FALLO(S)`); process.exit(1); }
