// Pruebas de los CIMIENTOS de la analítica de flota (lib/flota/km-gps.ts y lo que se extrajo o se
// agregó en lib/huella.ts, lib/columna-faltante.ts, lib/gps-cobertura-datos.ts, lib/rendimiento.ts y
// lib/turno-calculo.ts). NO tocan la base: datos sintéticos y una base falsa en memoria.
// Uso:  npx tsx scripts/prueba-km-gps.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN:
//   1. `resumenDeFilas` = LA TUBERÍA DE `kmDeServicio` (copiada literal, y la de verdad con un cliente
//      falso): km, % medido, horas de salida y llegada —y todo lo demás del resumen salvo la velocidad
//      máxima— idénticos sobre más de 2 000 trazas sintéticas, incluidos teléfonos sin Doppler. La
//      velocidad máxima es la del modal GPS (que también colorea la huella).
//   2. `kmPublicable`: el mapeo del veredicto RASTREO al km es TOTAL y ÚNICO; `km != null ⟺ medido|piso`;
//      `piso ⟺ código piso ⟹ veredicto con_cortes`. Corolario: un servicio completo publica su km.
//   3. `funcionQueFalta`: las dos formas del error dan el nombre; columna, tabla u operador dan null.
//   4. `tonoVariacion` = `colorDelta`, que vivía en app/combustible/ComparacionPeriodo.tsx, copiado literal.
//   5. `leerTraza(…, { conHuella })`: pide velocidad, rumbo, timestamp y el conductor, guarda las filas
//      crudas, y la medición NO cambia; sin la opción, el select y el resultado son los de siempre.
//   6. `medirServicio` / `medirReservas` = el `rastreoDelDia` viejo copiado literal (veredicto idéntico,
//      mismo techo, misma lectura).
//   7. `crearTurno`: nunca pasa del tope, la cola tiene techo (`ColaLlena`) y un error suelta el cupo.

/* eslint-disable @typescript-eslint/no-explicit-any -- la base falsa imita al cliente sin tipos de Supabase */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";

const {
  resumenDeFilas, paginarFilas, filasAPuntos, anclarImprecisos, limpiarHuella, resumenViaje, conVelocidadColor,
} = await import("../lib/huella");
const { kmDeServicio } = await import("../lib/km-servicio");
const { kmPublicable, textoKmGps, textoKm, CODIGOS_KM_GPS, KM_GPS_PUBLICA } = await import("../lib/flota/km-gps");
const { funcionQueFalta, columnaFaltante, tablaQueFalta } = await import("../lib/columna-faltante");
const { tonoVariacion } = await import("../lib/rendimiento");
const { leerTraza, medirServicio, medirReservas, veredictoFueraDelTecho, MAX_RESERVAS } = await import("../lib/gps-cobertura-datos");
const { acumularFilasGps, trazaVacia, contextoServicio, veredictoDeServicio } = await import("../lib/gps-cobertura");
const { crearTurno, ColaLlena } = await import("../lib/turno-calculo");
type VeredictoRastreo = import("../lib/gps-cobertura").VeredictoRastreo;
type CodigoRastreo = import("../lib/gps-cobertura").CodigoRastreo;
type TrazaSaneada = import("../lib/gps-cobertura").TrazaSaneada;
type ResumenViaje = import("../lib/huella").ResumenViaje;
type SentidoVariacion = import("../lib/rendimiento").SentidoVariacion;
type ServicioMedido = import("../lib/gps-cobertura-datos").ServicioMedido;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
let semilla = 20261012;
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const T0 = Date.parse("2026-10-09T11:00:00Z");   // 06:00 Lima

// ══ Trazas sintéticas (filas de ubicaciones_gps) ══════════════════════════════════════════
type Fila = Record<string, unknown>;
/** Un recorrido con paradas, jitter, fixes de red, huecos y, a veces, un teléfono sin Doppler. */
function trazaSintetica(n: number, o: { sinDoppler?: boolean; quieta?: boolean } = {}): Fila[] {
  const out: Fila[] = [];
  let ts = T0 + Math.floor(rnd() * 3_600_000);
  let lat = -12.05 + (rnd() - 0.5) * 0.1, lng = -77.03 + (rnd() - 0.5) * 0.1;
  let rumbo = rnd() * 360;
  let parado = 0;
  for (let i = 0; i < n; i++) {
    const dt = rnd() < 0.03 ? 120_000 + rnd() * 900_000 : 3000 + rnd() * 12_000;   // a veces, un hueco
    ts += Math.round(dt);
    if (parado <= 0 && rnd() < 0.04) parado = 5 + Math.floor(rnd() * 30);
    let kmh = 0;
    if (!o.quieta && parado <= 0) {
      kmh = 15 + rnd() * 75;
      if (rnd() < 0.08) rumbo += (rnd() - 0.5) * 120;
      const m = (kmh / 3.6) * (dt / 1000) * (rnd() < 0.02 ? 25 : 1);          // a veces, un salto absurdo
      lat += (m * Math.cos((rumbo * Math.PI) / 180)) / 111_320;
      lng += (m * Math.sin((rumbo * Math.PI) / 180)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    } else parado--;
    const jit = () => (rnd() - 0.5) * 0.0002;
    const red = rnd() < 0.1;
    const nulo = rnd() < 0.01;
    out.push({
      lat: nulo ? null : lat + jit() + (red ? (rnd() - 0.5) * 0.004 : 0),
      lng: nulo ? null : lng + jit() + (red ? (rnd() - 0.5) * 0.004 : 0),
      velocidad: o.sinDoppler ? 0 : Math.round(kmh + (kmh === 0 && rnd() < 0.2 ? 30 * rnd() : 0)),   // fantasma FUSED parado
      precision_m: red ? 60 + rnd() * 600 : rnd() < 0.05 ? null : 3 + rnd() * 15,
      rumbo: o.sinDoppler ? 0 : Math.round(rumbo) % 360,
      created_at: rnd() < 0.01 ? null : new Date(ts).toISOString(),
      timestamp: new Date(ts - Math.round(rnd() * 1500)).toISOString(),
    });
  }
  return out;
}

/** Cliente falso con lo que usan `paginarFilas` y `kmDeServicio`. */
function clienteFilas(filas: Fila[]) {
  return {
    from: () => {
      const q: any = {
        select() { return q; }, eq() { return q; }, order() { return q; },
        range(a: number, b: number) { return Promise.resolve({ data: filas.slice(a, b + 1), error: null }); },
      };
      return q;
    },
  };
}

// ── kmDeServicio (lib/km-servicio.ts), copiado LITERAL. Lo único que cambia es el cliente. ──
type KmServicio = { reserva_id: number; kmRecorridos: number; medidoPct: number; puntos: number; horaSalida: number | null; horaLlegada: number | null };
async function kmDeServicioViejo(client: any, reservaId: number): Promise<KmServicio & { _resumen: ResumenViaje | null }> {
  const vacio: KmServicio = { reserva_id: reservaId, kmRecorridos: 0, medidoPct: 0, puntos: 0, horaSalida: null, horaLlegada: null };
  if (!reservaId) return { ...vacio, _resumen: null };

  const filas = await paginarFilas(() =>
    client
      .from("ubicaciones_gps")
      .select("lat,lng,velocidad,precision_m,rumbo,created_at,timestamp")
      .eq("reserva_id", reservaId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
  );
  const crudos = filasAPuntos(filas);
  if (crudos.length < 2) return { ...vacio, puntos: crudos.length, _resumen: null };

  const limpia = limpiarHuella(anclarImprecisos(crudos));
  const resumen = resumenViaje(limpia, crudos);
  if (!resumen) return { ...vacio, puntos: crudos.length, _resumen: null };

  return {
    reserva_id: reservaId,
    kmRecorridos: Math.round(resumen.kmRecorridos * 10) / 10,
    medidoPct: Math.round(resumen.medidoPct),
    puntos: resumen.puntosTotales,
    horaSalida: resumen.horaSalida || null,
    horaLlegada: resumen.horaLlegada || null,
    _resumen: resumen,
  };
}
/** La forma de kmDeServicio, armada desde `resumenDeFilas`. */
function comoKmServicio(reservaId: number, filas: Fila[], r: ResumenViaje | null): KmServicio {
  if (!r) return { reserva_id: reservaId, kmRecorridos: 0, medidoPct: 0, puntos: filasAPuntos(filas).length, horaSalida: null, horaLlegada: null };
  return {
    reserva_id: reservaId, kmRecorridos: Math.round(r.kmRecorridos * 10) / 10, medidoPct: Math.round(r.medidoPct),
    puntos: r.puntosTotales, horaSalida: r.horaSalida || null, horaLlegada: r.horaLlegada || null,
  };
}

// ══ 1. resumenDeFilas = la tubería de kmDeServicio ═══════════════════════════════════════
console.log("\n1. `resumenDeFilas` = la tubería de `kmDeServicio` (copiada literal y la de verdad)");
{
  let total = 0, iguales = 0, igualesReal = 0, restoIgual = 0, conResumen = 0, velModal = 0, sinDoppler = 0, sinDopplerConVel = 0;
  const campos4 = (k: KmServicio) => JSON.stringify([k.kmRecorridos, k.medidoPct, k.horaSalida, k.horaLlegada, k.puntos]);
  const resto = (r: ResumenViaje | null) => r && JSON.stringify([r.kmRecorridos, r.tiempoTotalMin, r.tiempoMovimientoMin, r.tiempoDetenidoMin,
    r.paradas, r.horaSalida, r.horaLlegada, r.medidoPct, r.precisionMedianaM, r.puntosTotales]);
  for (let k = 0; k < 2200; k++) {
    const n = k < 30 ? k % 4 : Math.floor(rnd() * 320);   // también vacías, de 1 y de 2 filas
    const sd = rnd() < 0.35;
    const filas = trazaSintetica(n, { sinDoppler: sd, quieta: rnd() < 0.05 });
    const viejo = await kmDeServicioViejo(clienteFilas(filas), k + 1);
    const real = await kmDeServicio(clienteFilas(filas), k + 1);
    const r = resumenDeFilas(filas);
    const nuevo = comoKmServicio(k + 1, filas, r);
    total++;
    if (campos4(viejo) === campos4(nuevo)) iguales++;
    if (campos4(real) === campos4(nuevo)) igualesReal++;
    if ((viejo._resumen == null) === (r == null) && resto(viejo._resumen) === resto(r)) restoIgual++;
    if (r) {
      conResumen++;
      // El modal GPS: crudos anclados y huella coloreada (components/seguimiento/ModalGps.tsx).
      const brutos = filasAPuntos(filas);
      const crudos = anclarImprecisos(brutos);
      const modal = resumenViaje(conVelocidadColor(limpiarHuella(crudos)), crudos);
      if (modal && modal.velMaxKmh === r.velMaxKmh) velModal++;
      if (sd) { sinDoppler++; if (r.velMaxKmh > 0) sinDopplerConVel++; }
    }
  }
  chk(`km, % medido, horas y puntos idénticos al kmDeServicio copiado literal`, iguales === total && total > 2000, `${iguales}/${total}`);
  chk(`…y al kmDeServicio de verdad (lib/km-servicio.ts, sin tocar)`, igualesReal === total, `${igualesReal}/${total}`);
  chk(`todo el resumen salvo la velocidad máxima es idéntico (marcha, detenido, paradas, precisión)`, restoIgual === total, `${restoIgual}/${total}`);
  chk(`la «Vel. máx (p95)» es la del modal GPS`, velModal === conResumen && conResumen > 1500, `${velModal}/${conResumen}`);
  chk(`corolario: teléfonos sin Doppler entran al barrido y su velocidad se deriva (no queda en 0)`, sinDoppler > 500 && sinDopplerConVel > sinDoppler * 0.8,
    `${sinDopplerConVel}/${sinDoppler}`);
  chk("menos de 2 filas → null (como el corte de kmDeServicio)", resumenDeFilas([]) === null && resumenDeFilas(trazaSintetica(1)) === null);
}

// ══ 2. kmPublicable ══════════════════════════════════════════════════════════════════════
console.log("\n2. `kmPublicable`: el km se publica solo según el veredicto RASTREO");
{
  // Record<CodigoRastreo, …>: si se agrega un código de rastreo, esta matriz deja de compilar.
  const ESPERADO_LIMPIO: Record<CodigoRastreo, string> = {
    completo: "medido", aceptable: "medido", con_cortes: "piso", incompleto: "insuficiente",
    sin_senal: "sin_gps", solo_antena: "sin_gps", gps_inmovil: "sin_gps",
    senal_perdida: "en_curso", recien_iniciado: "en_curso",
    sin_medir: "sin_medir", no_aplica: "no_aplica",
  };
  const CODIGOS = Object.keys(ESPERADO_LIMPIO) as CodigoRastreo[];
  const mkV = (codigo: CodigoRastreo, enCurso: boolean, pct: number | null): VeredictoRastreo => ({
    codigo, pct, problema: null, celda: pct == null ? "—" : `${pct} %`, color: "#000", bg: "#fff",
    detalle: `veredicto ${codigo}`, ultimaSenalTs: null, enCurso,
  });
  const mkR = (km: number): ResumenViaje => ({
    kmRecorridos: km, tiempoTotalMin: 60, tiempoMovimientoMin: 50, tiempoDetenidoMin: 10, velMaxKmh: 70, paradas: 3,
    horaSalida: T0, horaLlegada: T0 + 3_600_000, medidoPct: 98, precisionMedianaM: 6, puntosTotales: 400,
  });
  let total = 0, enLista = 0, invKm = 0, invPiso = 0, pisoDeCortes = 0, limpios = 0, limpiosOk = 0, cobertura = 0, detalle = 0;
  const vistos = new Set<string>();
  for (const codigo of CODIGOS) for (const enCurso of [false, true]) for (const pct of [null, 0, 55, 80, 92, 99]) {
    for (const r of [null, mkR(0), mkR(12.3), mkR(240.5)]) for (const sim of [0, 3, NaN, -1]) {
      const v = mkV(codigo, enCurso, pct);
      const k = kmPublicable(v, r, sim);
      total++;
      vistos.add(k.codigo);
      if ((CODIGOS_KM_GPS as readonly string[]).includes(k.codigo)) enLista++;
      if ((k.km != null) === KM_GPS_PUBLICA[k.codigo] && (k.km != null) === (k.codigo === "medido" || k.codigo === "piso")) invKm++;
      if (k.piso === (k.codigo === "piso")) invPiso++;
      if (!k.piso || v.codigo === "con_cortes") pisoDeCortes++;
      if (k.coberturaPct === (v.pct ?? null)) cobertura++;
      if (k.detalle.length > 10 && textoKmGps(k.codigo).length > 0) detalle++;
      // Los casos «limpios» (terminado, sin simulados, con desplazamiento) siguen la tabla del plan.
      if (!enCurso && !(sim > 0) && r && r.kmRecorridos > 0) {
        limpios++;
        if (k.codigo === ESPERADO_LIMPIO[codigo] && (k.km == null || k.km === r.kmRecorridos)) limpiosOk++;
      }
    }
  }
  chk(`mapeo total: cada combinación da un código de la lista`, enLista === total, `${enLista}/${total}`);
  chk(`km != null ⟺ código ∈ {medido, piso} (y KM_GPS_PUBLICA lo dice igual)`, invKm === total, `${invKm}/${total}`);
  chk(`piso ⟺ código piso`, invPiso === total);
  chk(`piso ⟹ veredicto con_cortes`, pisoDeCortes === total);
  chk(`la tabla del plan en los casos limpios (terminado, sin simulados, con desplazamiento)`, limpiosOk === limpios && limpios > 0, `${limpiosOk}/${limpios}`);
  chk(`la cobertura publicada es la del veredicto`, cobertura === total);
  chk(`todo código lleva su detalle y su rótulo`, detalle === total);
  chk(`el barrido alcanza los nueve códigos`, CODIGOS_KM_GPS.every((c) => vistos.has(c)), [...vistos].sort().join(", "));

  // Casos con nombre.
  const comp = kmPublicable(mkV("completo", false, 98), mkR(31.4), 0);
  chk("COROLARIO: un servicio terminado con rastreo completo publica su km", comp.codigo === "medido" && comp.km === 31.4 && !comp.piso && textoKm(comp) === "31.4 km", textoKm(comp));
  const cort = kmPublicable(mkV("con_cortes", false, 78), mkR(31.4), 0);
  chk("con cortes: un mínimo, «≥ N km»", cort.codigo === "piso" && cort.km === 31.4 && cort.piso && textoKm(cort) === "≥ 31.4 km", textoKm(cort));
  chk("en curso nunca publica, aunque el rastreo vaya completo", kmPublicable(mkV("completo", true, 99), mkR(10), 0).codigo === "en_curso");
  chk("un solo punto simulado invalida el km", kmPublicable(mkV("completo", false, 99), mkR(10), 1).codigo === "simulado");
  chk("rastreo completo sin desplazamiento: no se publica un 0", kmPublicable(mkV("completo", false, 99), mkR(0), 0).codigo === "sin_desplazamiento"
    && kmPublicable(mkV("aceptable", false, 91), null, 0).codigo === "sin_desplazamiento");
  chk("un fallo de lectura no es un 0 km", kmPublicable(mkV("sin_medir", false, null), mkR(10), 0).km === null
    && textoKm(kmPublicable(mkV("sin_medir", false, null), null, 0)) === "—");
}

// ══ 3. funcionQueFalta ═══════════════════════════════════════════════════════════════════
console.log("\n3. `funcionQueFalta`: las dos formas del error, y nada más");
{
  const casos: { e: any; esperado: string | null; etq: string }[] = [
    { etq: "PostgREST con parámetros", esperado: "fn_gps_puntos_rapidos",
      e: { code: "PGRST202", message: "Could not find the function public.fn_gps_puntos_rapidos(p_desde, p_hasta, p_umbral) in the schema cache" } },
    { etq: "PostgREST sin parámetros", esperado: "fn_x",
      e: { code: "PGRST202", message: "Could not find the function public.fn_x without parameters in the schema cache" } },
    { etq: "PostgREST sin código", esperado: "fn_gps_velocimetro",
      e: { message: "Could not find the function public.fn_gps_velocimetro(p_desde, p_hasta, p_propios, p_terceros) in the schema cache" } },
    { etq: "Postgres", esperado: "fn_gps_velocimetro",
      e: { code: "42883", message: "function fn_gps_velocimetro(timestamp with time zone, timestamp with time zone, bigint[], bigint[]) does not exist" } },
    { etq: "Postgres con esquema", esperado: "fn_y", e: { code: "42883", message: "function public.fn_y(integer) does not exist" } },
    { etq: "PGRST202 sin mensaje → seguro que falta, sin nombre", esperado: "", e: { code: "PGRST202", message: "" } },
    { etq: "42883 sin mensaje", esperado: "", e: { code: "42883" } },
    { etq: "42883 de OPERADOR (error de tipos, no migración)", esperado: null, e: { code: "42883", message: "operator does not exist: text = integer" } },
    { etq: "columna PostgREST", esperado: null, e: { code: "PGRST204", message: "Could not find the 'velocidad' column of 'ubicaciones_gps' in the schema cache" } },
    { etq: "columna Postgres", esperado: null, e: { code: "42703", message: "column ubicaciones_gps.simulado does not exist" } },
    { etq: "tabla PostgREST", esperado: null, e: { code: "PGRST205", message: "Could not find the table 'public.gps_equipo_reportes' in the schema cache" } },
    { etq: "tabla dentro de una función instalada", esperado: null, e: { code: "42P01", message: 'relation "public.ubicaciones_gps" does not exist' } },
    { etq: "timeout", esperado: null, e: { code: "57014", message: "canceling statement due to statement timeout" } },
    { etq: "red", esperado: null, e: { message: "fetch failed" } },
    { etq: "permiso", esperado: null, e: { code: "42501", message: "permission denied for function fn_gps_puntos_rapidos" } },
    { etq: "sin error", esperado: null, e: null },
  ];
  for (const c of casos) chk(`${c.etq} → ${JSON.stringify(c.esperado)}`, funcionQueFalta(c.e) === c.esperado, JSON.stringify(funcionQueFalta(c.e)));
  const disjuntos = casos.every((c) => !(funcionQueFalta(c.e) != null && (columnaFaltante(c.e) != null || tablaQueFalta(c.e) != null)));
  chk("nunca contesta a la vez «falta una función» y «falta una columna/tabla»", disjuntos);
}

// ══ 4. tonoVariacion = colorDelta ════════════════════════════════════════════════════════
console.log("\n4. `tonoVariacion` = `colorDelta` de ComparacionPeriodo.tsx, copiado literal");
{
  // ── app/combustible/ComparacionPeriodo.tsx (antes de mudar el tono al motor), copiado LITERAL ──
  type Sentido = "subir_malo" | "bajar_malo" | "neutro";
  function colorDelta(v: number | null, sentido: Sentido): string {
    if (v === null || Math.abs(v) < 0.05) return "#64748b";
    if (sentido === "neutro") return "#334155";
    const malo = sentido === "subir_malo" ? v > 0 : v < 0;
    return malo ? "#b91c1c" : "#166534";
  }
  const COLOR = { sin_dato: "#64748b", igual: "#64748b", neutro: "#334155", malo: "#b91c1c", bueno: "#166534" } as const;
  const vs: (number | null)[] = [null, -300, -25, -1, -0.05, -0.0499, -0.01, 0, 0.01, 0.0499, 0.05, 0.051, 1, 25, 300];
  for (let i = 0; i < 400; i++) vs.push((rnd() - 0.5) * (rnd() < 0.3 ? 0.2 : 200));
  let total = 0, iguales = 0;
  for (const v of vs) for (const s of ["subir_malo", "bajar_malo", "neutro"] as SentidoVariacion[]) {
    total++;
    if (COLOR[tonoVariacion(v, s)] === colorDelta(v, s)) iguales++;
  }
  chk(`mismo color en ${total} combinaciones`, iguales === total, `${iguales}/${total}`);
  chk("null es sin_dato (no «igual»): se distingue de una variación cero", tonoVariacion(null, "subir_malo") === "sin_dato" && tonoVariacion(0, "subir_malo") === "igual");
  chk("una métrica neutra nunca es buena ni mala", tonoVariacion(40, "neutro") === "neutro" && tonoVariacion(-40, "neutro") === "neutro");
  chk("subir_malo: +10 malo, −10 bueno; bajar_malo al revés",
    tonoVariacion(10, "subir_malo") === "malo" && tonoVariacion(-10, "subir_malo") === "bueno"
    && tonoVariacion(10, "bajar_malo") === "bueno" && tonoVariacion(-10, "bajar_malo") === "malo");
}

// ══ 5. leerTraza con la huella ═══════════════════════════════════════════════════════════
console.log("\n5. `leerTraza(…, { conHuella })`: las filas crudas de la MISMA lectura");
type Opciones = { faltan?: string[]; forma?: "postgres" | "postgrest"; desdePagina?: number };
function baseFalsa(filas: Fila[], o: Opciones = {}) {
  const selects: string[] = [];
  const cliente = {
    from: () => {
      let cols: string[] = [];
      const q: any = {
        select(c: string) { selects.push(c); cols = c.split(",").map((x) => x.trim()); return q; },
        eq() { return q; },
        order() { return q; },
        range(a: number, b: number) {
          const pagina = Math.floor(a / 1000);
          const falta = cols.find((c) => (o.faltan ?? []).includes(c));
          if (falta && pagina >= (o.desdePagina ?? 0)) {
            const error = o.forma === "postgrest"
              ? { code: "PGRST204", message: `Could not find the '${falta}' column of 'ubicaciones_gps' in the schema cache` }
              : { code: "42703", message: `column ubicaciones_gps.${falta} does not exist` };
            return Promise.resolve({ data: null, error });
          }
          const data = filas.slice(a, b + 1).map((f) => Object.fromEntries(cols.map((c) => [c, f[c]])));
          return Promise.resolve({ data, error: null });
        },
      };
      return q;
    },
  };
  return { cliente, selects };
}
const firmaTraza = (t: TrazaSaneada) => JSON.stringify({ pts: t.pts, totalCrudo: t.totalCrudo, porAntena: t.porAntena, simulados: t.simulados, cierreTs: t.cierreTs ?? null });
function filasCompletas(n: number): Fila[] {
  return trazaSintetica(n).map((f, i) => ({
    ...f, estado: i === n - 1 ? "finalizado" : "en_ruta", simulado: rnd() < 0.02 ? true : null,
    fix_ts: f.created_at, recibido_en: f.created_at, conductor_id: rnd() < 0.9 ? 7 : null, conductor_tercero_id: null,
  }));
}
{
  const filas = filasCompletas(2500);
  const solo = baseFalsa(filas);
  const t0 = await leerTraza(solo.cliente, 1);
  chk("sin opciones: el select de siempre", solo.selects[0] === "created_at, lat, lng, precision_m, simulado, estado", solo.selects[0]);
  chk("sin opciones: sin `crudas`", !("crudas" in t0));

  const h = baseFalsa(filas);
  const t1 = await leerTraza(h.cliente, 1, { conHuella: true });
  const cols1 = h.selects[0].split(", ");
  chk("conHuella pide velocidad, rumbo, timestamp, conductor_id y conductor_tercero_id",
    ["velocidad", "rumbo", "timestamp", "conductor_id", "conductor_tercero_id"].every((c) => cols1.includes(c)), h.selects[0]);
  chk("…sin repetir columnas", new Set(cols1).size === cols1.length);
  chk("la medición no cambia por pedir la huella", firmaTraza(t1) === firmaTraza(t0));
  chk("`crudas` = todas las filas, en el orden de la lectura, con sus columnas", (t1.crudas ?? []).length === filas.length
    && (t1.crudas ?? []).every((f: any, i: number) => f.created_at === filas[i].created_at && f.velocidad === filas[i].velocidad && f.lat === filas[i].lat));
  chk("conHuella sin conFilas no trae `filas` ni `sinRecibido`", !("filas" in t1) && !("sinRecibido" in t1));

  const hf = baseFalsa(filas);
  const t2 = await leerTraza(hf.cliente, 1, { conHuella: true, conFilas: true });
  const cols2 = hf.selects[0].split(", ");
  chk("conHuella + conFilas: las dos cosas, sin duplicar el conductor", new Set(cols2).size === cols2.length
    && (t2.crudas ?? []).length === filas.length && (t2.filas ?? []).length > 0 && t2.sinRecibido === false);

  for (const forma of ["postgres", "postgrest"] as const) for (const desdePagina of [0, 1, 2]) {
    const b = baseFalsa(filas, { faltan: ["simulado"], forma, desdePagina });
    const t = await leerTraza(b.cliente, 1, { conHuella: true });
    chk(`sin la columna simulado (${forma}, desde la página ${desdePagina + 1}): crudas se releen desde cero, sin duplicar`,
      (t.crudas ?? []).length === filas.length && !/simulado/.test(b.selects[b.selects.length - 1]) && t.simulados === 0);
  }
  // De punta a punta: una traza completa leída con la huella publica su km.
  const corta = filasCompletas(300);
  const t3 = await leerTraza(baseFalsa(corta).cliente, 1, { conHuella: true });
  const r3 = resumenDeFilas(t3.crudas ?? []);
  const v3: VeredictoRastreo = { codigo: "completo", pct: 99, problema: null, celda: "99 %", color: "", bg: "", detalle: "", ultimaSenalTs: null, enCurso: false };
  const k3 = kmPublicable(v3, r3, 0);
  chk("COROLARIO: de la misma lectura salen la medición y un km publicado", k3.codigo === "medido" && (k3.km ?? 0) > 0, textoKm(k3));
  const viejo = await kmDeServicioViejo(clienteFilas(corta), 1);
  chk("…y es el km de la Auditoría de km (kmDeServicio sobre las mismas filas)", viejo.kmRecorridos === Math.round((r3?.kmRecorridos ?? -1) * 10) / 10,
    `${viejo.kmRecorridos} vs ${r3?.kmRecorridos}`);
}

// ══ 6. medirServicio / medirReservas = rastreoDelDia viejo ════════════════════════════════
console.log("\n6. `medirServicio` / `medirReservas` = el bucle de `rastreoDelDia`, copiado literal");
{
  const LOTE = 8;
  // ── rastreoDelDia (lib/gps-cobertura-datos.ts antes de la extracción), copiado LITERAL. Lo único que
  //    cambia es el entorno: las reservas y las paradas llegan ya leídas y `trazaDe` sale de un mapa. ──
  async function rastreoDelDiaViejo(reservas: any[], paradasDe: Map<number, any[]>, hoy: string, ahoraMs: number,
    trazaDe: (id: number) => Promise<TrazaSaneada>): Promise<Record<number, VeredictoRastreo>> {
    const out: Record<number, VeredictoRastreo> = {};
    const medir = async (r: any) => {
      const ps = paradasDe.get(r.id) ?? [];
      const ctx = contextoServicio(r, ps, { hoy, ahoraMs });
      // Solo se lee el GPS de lo que corrió o está corriendo: `veredictoDeServicio` ignora la traza
      // de un servicio que no aplica.
      let traza: TrazaSaneada | null = null;
      if (ctx.aplica) { try { traza = await trazaDe(r.id); } catch { traza = null; } }
      out[r.id] = veredictoDeServicio(ctx, traza, ps, ahoraMs).veredicto;
    };
    const lote = reservas.slice(0, MAX_RESERVAS);
    for (let i = 0; i < lote.length; i += LOTE) await Promise.all(lote.slice(i, i + LOTE).map(medir));
    // Lo que pasa del techo NO se mide y lo dice: nunca un 0 % por no haberlo mirado.
    for (const r of reservas.slice(MAX_RESERVAS)) out[r.id] = veredictoFueraDelTecho(ahoraMs);
    return out;
  }
  // El envoltorio nuevo (`rastreoDelDia` de hoy), sobre las mismas reservas ya leídas.
  async function rastreoDelDiaNuevo(reservas: any[], paradasDe: Map<number, any[]>, hoy: string, ahoraMs: number,
    leer: (id: number, o?: any) => Promise<any>): Promise<Record<number, VeredictoRastreo>> {
    const out: Record<number, VeredictoRastreo> = {};
    const { fueraDelTecho } = await medirReservas(reservas, paradasDe, hoy, ahoraMs, {
      alMedir: (s) => { out[s.reserva.id] = s.veredicto; },
    }, leer);
    for (const id of fueraDelTecho) out[id] = veredictoFueraDelTecho(ahoraMs);
    return out;
  }

  const HOY = "2026-10-09", AYER = "2026-10-08";
  const ESTADOS = ["finalizada", "en_curso", "programada", "confirmada", "pendiente"];
  const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const iso = (fecha: string, min: number) => new Date(Date.parse(`${fecha}T00:00:00-05:00`) + min * 60_000).toISOString();
  let diasIguales = 0, dias = 0, reservasTotal = 0, sinOpcion = true, lecturasDeMas = 0, conTecho = 0;
  const codigos = new Set<string>();
  for (let d = 0; d < 14; d++) {
    const n = d === 13 ? MAX_RESERVAS + 12 : 5 + Math.floor(rnd() * 40);
    if (n > MAX_RESERVAS) conTecho++;
    const reservas: any[] = [];
    const paradasDe = new Map<number, any[]>();
    const trazas = new Map<number, TrazaSaneada | null>();
    const ahoraMs = T0 + Math.floor(rnd() * 12 * 3_600_000);
    for (let k = 0; k < n; k++) {
      const id = d * 1000 + k + 1;
      const fecha = rnd() < 0.75 ? HOY : AYER;
      const horaMin = 300 + Math.floor(rnd() * 900);
      reservas.push({
        id, estado: ESTADOS[Math.floor(rnd() * ESTADOS.length)], fecha_servicio: fecha,
        hora_servicio: rnd() < 0.95 ? hhmm(horaMin) : null,
        hora_real_inicio: rnd() < 0.3 ? hhmm(horaMin + Math.floor(rnd() * 20)) + ":00" : null,
        inicio_real_ts: rnd() < 0.15 ? iso(fecha, horaMin + Math.floor(rnd() * 15)) : null,
        inicio_real_fuente: rnd() < 0.5 ? "parada" : "operador",
      });
      const np = Math.floor(rnd() * 6);
      paradasDe.set(id, Array.from({ length: np }, (_, i) => {
        const completada = rnd() < 0.6;
        return {
          id: id * 10 + i, reserva_id: id, orden: i + 1, estado: completada ? "completada" : "pendiente",
          hora_estimada: rnd() < 0.85 ? hhmm(horaMin + i * 12) : null,
          hora_llegada: completada && rnd() < 0.8 ? iso(fecha, horaMin + i * 12 + Math.floor((rnd() - 0.3) * 20)) : null,
          lat: rnd() < 0.85 ? -12.05 + i * 0.02 : null, lng: rnd() < 0.85 ? -77.03 + i * 0.01 : null,
        };
      }));
      const u = rnd();
      if (u < 0.1) trazas.set(id, null);                   // no se pudo leer
      else {
        const acc = trazaVacia();
        const filas = trazaSintetica(Math.floor(rnd() * 200)).map((f) => ({
          ...f, estado: "en_ruta",
          created_at: f.created_at ? new Date(Date.parse(String(f.created_at)) - T0 + Date.parse(`${fecha}T00:00:00-05:00`) + horaMin * 60_000).toISOString() : null,
        }));
        acumularFilasGps(acc, filas, true);
        trazas.set(id, { ...acc, pts: acc.pts.sort((a, b) => a.ts - b.ts) });
      }
    }
    const lecturas: number[] = [];
    const trazaDe = async (id: number) => { const t = trazas.get(id); if (!t) throw new Error("no se pudo leer"); return t; };
    const leer = async (...args: any[]) => {
      lecturas.push(args[0]);
      if (args.length > 1) sinOpcion = false;
      return trazaDe(args[0]);
    };
    const viejo = await rastreoDelDiaViejo(reservas, paradasDe, HOY, ahoraMs, trazaDe);
    const nuevo = await rastreoDelDiaNuevo(reservas, paradasDe, HOY, ahoraMs, leer);
    dias++;
    reservasTotal += n;
    if (JSON.stringify(viejo) === JSON.stringify(nuevo)) diasIguales++;
    for (const v of Object.values(nuevo)) codigos.add(v.codigo);
    // Solo se lee lo que aplica, una vez, y nunca lo que pasó del techo.
    const debian = reservas.slice(0, MAX_RESERVAS).filter((r) => contextoServicio(r, paradasDe.get(r.id) ?? [], { hoy: HOY, ahoraMs }).aplica).map((r) => r.id);
    if (JSON.stringify([...lecturas].sort((a, b) => a - b)) !== JSON.stringify([...debian].sort((a, b) => a - b))) lecturasDeMas++;
  }
  chk(`rastreoDelDia: la misma salida en ${dias} días (${reservasTotal} servicios)`, diasIguales === dias, `${diasIguales}/${dias}`);
  chk("…incluido un día que pasa del techo de MAX_RESERVAS", conTecho > 0);
  chk("sin conHuella la lectura es la de siempre (`trazaDe(id)`, sin opciones)", sinOpcion);
  chk("solo se lee la traza de lo que aplica, una vez, y nada fuera del techo", lecturasDeMas === 0, `${lecturasDeMas} día(s) con lecturas distintas`);
  chk("corolario: el barrido cubre varios veredictos", codigos.size >= 6, [...codigos].sort().join(", "));

  // medirServicio con la huella: pide la opción y devuelve todo lo que la estadística necesita.
  const r = { id: 99, estado: "finalizada", fecha_servicio: HOY, hora_servicio: "06:00" };
  const ps = [{ id: 1, reserva_id: 99, orden: 1, estado: "completada", hora_estimada: "06:00", lat: -12.05, lng: -77.03 }];
  const filas = filasCompletas(120);
  let pidio: any = null;
  const s: ServicioMedido = await medirServicio(r, ps, { hoy: HOY, ahoraMs: T0 + 86_400_000, conHuella: true },
    async (id: number, o?: any) => { pidio = o; return leerTraza(baseFalsa(filas).cliente, id, o); });
  chk("con conHuella, `leer` recibe { conHuella: true } y la traza trae las crudas", pidio?.conHuella === true && (s.traza?.crudas ?? []).length === 120);
  chk("ServicioMedido trae reserva, paradas, contexto, traza, veredicto y medición",
    s.reserva === r && s.paradas.length === 1 && s.ctx.terminado && s.veredicto.codigo !== "no_aplica" && (s.medicion == null || s.medicion.cobertura === s.veredicto.pct));
  let leido = false;
  const noSale = await medirServicio({ id: 5, estado: "programada", fecha_servicio: HOY, hora_servicio: "23:00" }, [], { hoy: HOY, ahoraMs: T0, conHuella: true },
    async () => { leido = true; return trazaVacia(); });
  chk("un servicio que no salió no lee su GPS", !leido && noSale.veredicto.codigo === "no_aplica" && noSale.traza === null);
  const roto = await medirServicio(r, ps, { hoy: HOY, ahoraMs: T0 + 86_400_000 }, async () => { throw new Error("red"); });
  chk("una traza que no se pudo leer sale sin_medir, nunca 0 %", roto.veredicto.codigo === "sin_medir" && roto.traza === null);
}

// ══ 7. crearTurno ════════════════════════════════════════════════════════════════════════
console.log("\n7. `crearTurno`: tope, cola acotada y traspaso del cupo");
{
  const espera = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
  // Carga al azar: nunca más de `max` a la vez, y todo termina.
  for (const max of [1, 2, 3]) {
    const turno = crearTurno(max, 1000);
    let corriendo = 0, pico = 0, hechos = 0;
    const tareas = Array.from({ length: 60 }, (_, i) => turno(async () => {
      corriendo++; pico = Math.max(pico, corriendo);
      await espera(Math.floor(rnd() * 4));
      corriendo--; hechos++;
      return i;
    }));
    // Tareas que llegan mientras otras terminan (el traspaso no deja colarse a nadie).
    await espera(2);
    const tarde = Array.from({ length: 20 }, () => turno(async () => { corriendo++; pico = Math.max(pico, corriendo); await espera(1); corriendo--; hechos++; return -1; }));
    const res = await Promise.all([...tareas, ...tarde]);
    chk(`max ${max}: nunca más de ${max} a la vez, y las 80 terminan con su resultado`, pico <= max && pico === max && hechos === 80 && res[7] === 7, `pico ${pico}`);
  }
  // Cola llena.
  {
    const turno = crearTurno(1, 2);
    let soltar!: () => void;
    const bloqueo = new Promise<void>((ok) => { soltar = ok; });
    const a = turno(() => bloqueo.then(() => "a"));
    const b = turno(async () => "b");
    const c = turno(async () => "c");
    let llena = false;
    try { await turno(async () => "d"); } catch (e) { llena = e instanceof ColaLlena; }
    soltar();
    const r = await Promise.all([a, b, c]);
    chk("con la cola en su techo, el siguiente recibe ColaLlena (la ruta responde 503 + reintentar)", llena);
    chk("…y los que esperaban terminan en orden", JSON.stringify(r) === JSON.stringify(["a", "b", "c"]));
    chk("después, el turno vuelve a aceptar", (await turno(async () => "e")) === "e");
  }
  // Un error suelta el cupo.
  {
    const turno = crearTurno(1, 5);
    let fallo = false;
    try { await turno(async () => { throw new Error("x"); }); } catch { fallo = true; }
    chk("un cálculo que lanza propaga el error y suelta el cupo", fallo && (await turno(async () => 1)) === 1);
  }
  // Turnos independientes.
  {
    const t1 = crearTurno(1, 0), t2 = crearTurno(1, 0);
    let soltar!: () => void;
    const p = t1(() => new Promise<void>((ok) => { soltar = ok; }));
    const otro = await t2(async () => "libre");
    let llena = false;
    try { await t1(async () => 0); } catch (e) { llena = e instanceof ColaLlena; }
    soltar(); await p;
    chk("cada crearTurno tiene su propio cupo (y maxCola 0 = no se espera)", otro === "libre" && llena);
  }
}

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
