// Pruebas del LECTOR del diagnóstico del rastreo: `leerTraza` (lib/gps-cobertura-datos.ts) contra una
// base FALSA en memoria, y las reglas puras de lib/gps-diagnostico-api.ts. NO tocan la base.
// Uso:  npx tsx scripts/prueba-gps-diagnostico-api.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN:
//   1. SIN `conFilas`, LA TRAZA ES LA DE SIEMPRE: el `trazaDe` viejo (el del regex /simulado/) copiado
//      literal contra el nuevo, sobre trazas al azar, con y sin la columna `simulado`: mismo select,
//      mismo resultado, y sin `filas` ni `sinRecibido` en la respuesta (lo usan /gps-salud y la torre).
//   2. EL REINTENTO GENÉRICO: se suelta SOLO la columna que el error NOMBRA (simulado, fix_ts,
//      recibido_en), en las dos formas del error, y se relee DESDE CERO (un fallo en la página 2 no
//      deja filas duplicadas). Cualquier otro error LANZA, también uno que nombre una columna que no
//      es accesoria: una traza a medias mediría una cobertura falsa.
//   3. QUIÉN ES EL CONDUCTOR: la identidad mayoritaria de la traza, con los ids de las dos tablas
//      separados (se solapan); la reserva solo de respaldo, y lo declara.
//   4. LA VENTANA de los reportes: con medición es la del %; sin ella, nunca invertida.
//   5. EL HISTORIAL: qué servicio es «anterior» (orden total por fecha, hora, id).
//   6. LO QUE SALE A LA PANTALLA: el estado del teléfono sin los identificadores de aparato.
//   7. SIN LA TABLA DEL TELÉFONO, el diagnóstico no dice «no reportó» (no PUDO): nombra el SQL.

/* eslint-disable @typescript-eslint/no-explicit-any -- la base falsa imita al cliente sin tipos de Supabase */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";

const { leerTraza } = await import("../lib/gps-cobertura-datos");
const { acumularFilasGps, trazaVacia, veredictoRastreo } = await import("../lib/gps-cobertura");
const { diagnosticarRastreo } = await import("../lib/gps-diagnostico");
const {
  conductorDeLaTraza, conductorDeReserva, conductorDelDiagnostico, ventanaDelServicio, anteriorA, ordenServicio,
  equipoParaPantalla, horaCorta,
} = await import("../lib/gps-diagnostico-api");
const { estadoDesdeFilas } = await import("../lib/gps-equipo");
type FilaGpsDiag = import("../lib/gps-cobertura").FilaGpsDiag;
type TrazaSaneada = import("../lib/gps-cobertura").TrazaSaneada;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
let semilla = 20261011;
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const T0 = Date.parse("2026-10-09T09:08:00Z");

// ══ La base falsa ════════════════════════════════════════════════════════════════════
type Fila = Record<string, unknown>;
type Opciones = {
  /** columnas que la tabla NO tiene */
  faltan?: string[];
  /** forma del error de columna: Postgres en un SELECT (42703) o PostgREST (PGRST204) */
  forma?: "postgres" | "postgrest";
  /** el error de columna sale solo a partir de esta página (0 = la primera) */
  desdePagina?: number;
  /** un error que NO es de columna, en esta página */
  otroError?: { pagina: number; error: { code?: string; message: string } };
};
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
          if (o.otroError && o.otroError.pagina === pagina) return Promise.resolve({ data: null, error: o.otroError.error });
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

// ── trazaDe VIEJO (lib/gps-cobertura-datos.ts antes de este cambio), copiado literal ──
// Lo único que cambia es el entorno de su clausura: `admin` es la base falsa.
async function trazaDeViejo(admin: any, reservaId: number): Promise<TrazaSaneada> {
  const acc = trazaVacia();
  let sinColumnaSimulado = false;
  for (let off = 0; off < 20000; off += 1000) {
    const { data, error } = await admin
      .from("ubicaciones_gps")
      .select("created_at, lat, lng, precision_m, simulado, estado")
      .eq("reserva_id", reservaId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) {
      // La columna `simulado` es opcional (supabase/ubicaciones-gps-simulado.sql). Sin ella el
      // panel debe seguir midiendo cobertura: el antifraude es un extra, no un requisito.
      if (/simulado/i.test(error.message || "")) { sinColumnaSimulado = true; break; }
      throw new Error(`traza ${reservaId}: ${error.message}`);
    }
    if (!data?.length) break;
    acumularFilasGps(acc, data, true);
    if (data.length < 1000) break;
  }
  // Reintento sin la columna nueva si la BD aún no la tiene.
  if (sinColumnaSimulado) {
    acc.pts.length = 0; acc.totalCrudo = 0; acc.porAntena = 0; acc.cierreTs = null;
    for (let off = 0; off < 20000; off += 1000) {
      const { data, error } = await admin
        .from("ubicaciones_gps")
        .select("created_at, lat, lng, precision_m, estado")
        .eq("reserva_id", reservaId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(`traza ${reservaId}: ${error.message}`);
      if (!data?.length) break;
      acumularFilasGps(acc, data, false);
      if (data.length < 1000) break;
    }
  }
  return { ...acc, pts: acc.pts.sort((a, b) => a.ts - b.ts) };
}

function trazaAlAzar(n: number): Fila[] {
  const out: Fila[] = [];
  let ts = T0, lat = -12.05, lng = -77.05;
  for (let i = 0; i < n; i++) {
    ts += Math.round(3000 + rnd() * (rnd() < 0.05 ? 600_000 : 20_000));
    lat += (rnd() - 0.5) * 0.002; lng += (rnd() - 0.5) * 0.002;
    const nulo = rnd() < 0.03;
    out.push({
      created_at: new Date(ts).toISOString(),
      lat: nulo ? null : lat, lng: nulo ? null : lng,
      precision_m: rnd() < 0.15 ? 200 + rnd() * 500 : rnd() < 0.1 ? null : 3 + rnd() * 20,
      simulado: rnd() < 0.05 ? true : rnd() < 0.5 ? false : null,
      estado: i === n - 1 && rnd() < 0.5 ? "finalizado" : "en_ruta",
      fix_ts: rnd() < 0.2 ? null : new Date(ts - Math.round(rnd() * 2000)).toISOString(),
      recibido_en: rnd() < 0.3 ? null : new Date(ts + Math.round(rnd() * 5000)).toISOString(),
      conductor_id: rnd() < 0.9 ? 7 : null,
      conductor_tercero_id: null,
    });
  }
  return out;
}
const firmaTraza = (t: TrazaSaneada) => JSON.stringify({ pts: t.pts, totalCrudo: t.totalCrudo, porAntena: t.porAntena, simulados: t.simulados, cierreTs: t.cierreTs ?? null });
const SELECT_DE_SIEMPRE = "created_at, lat, lng, precision_m, simulado, estado";

// ══ 1. Sin conFilas: la traza de siempre ═══════════════════════════════════════════════
console.log("\n1. Sin `conFilas`, `leerTraza` = el `trazaDe` viejo copiado literal");
{
  let iguales = 0, total = 0, selectOk = true, sinExtras = true;
  for (let k = 0; k < 60; k++) {
    const n = [0, 1, 2, 999, 1000, 1001, 2500][k % 7] + Math.floor(rnd() * 5);
    const filas = trazaAlAzar(n);
    for (const faltan of [[], ["simulado"]] as string[][]) {
      for (const forma of ["postgres", "postgrest"] as const) {
        const viejo = baseFalsa(filas, { faltan, forma });
        const nuevo = baseFalsa(filas, { faltan, forma });
        let a: TrazaSaneada | null = null, b: any = null, ea = "", eb = "";
        try { a = await trazaDeViejo(viejo.cliente, 1); } catch (e: any) { ea = e.message; }
        try { b = await leerTraza(nuevo.cliente, 1); } catch (e: any) { eb = e.message; }
        total++;
        if ((a && b && firmaTraza(a) === firmaTraza(b)) || (!a && !b && ea === eb)) iguales++;
        if (nuevo.selects[0] !== SELECT_DE_SIEMPRE) selectOk = false;
        if (b && ("filas" in b || "sinRecibido" in b)) sinExtras = false;
      }
    }
  }
  chk(`mismo resultado en ${total} lecturas (con y sin la columna simulado, las dos formas del error)`, iguales === total, `${iguales}/${total}`);
  chk(`el primer select es exactamente «${SELECT_DE_SIEMPRE}»`, selectOk);
  chk("sin `conFilas` la traza no trae `filas` ni `sinRecibido`", sinExtras);
}

// ══ 2. El reintento genérico ═══════════════════════════════════════════════════════════
console.log("\n2. Se suelta SOLO la columna que el error nombra, y se relee desde cero");
{
  const filas = trazaAlAzar(2500);
  const validas = filas.filter((f) => f.lat != null && f.lng != null).length;

  const todo = baseFalsa(filas);
  const t0 = await leerTraza(todo.cliente, 1, { conFilas: true });
  chk("con todas las columnas: una sola lectura, `sinRecibido` false", todo.selects.length === 3 && new Set(todo.selects).size === 1 && t0.sinRecibido === false);
  chk("pide fix_ts, recibido_en, conductor_id y conductor_tercero_id", /fix_ts/.test(todo.selects[0]) && /recibido_en/.test(todo.selects[0]) && /conductor_id/.test(todo.selects[0]) && /conductor_tercero_id/.test(todo.selects[0]));
  chk("una fila de diagnóstico por cada posición con coordenadas (útil o antena)", t0.filas?.length === validas && t0.totalCrudo === validas);
  chk("la medición no cambia por pedir las filas", firmaTraza(t0) === firmaTraza(await leerTraza(baseFalsa(filas).cliente, 1)));
  chk("las filas traen la hora de recepción", (t0.filas ?? []).some((f: FilaGpsDiag) => f.recibidoTs != null));

  for (const forma of ["postgres", "postgrest"] as const) {
    for (const desdePagina of [0, 1, 2]) {
      const b = baseFalsa(filas, { faltan: ["recibido_en"], forma, desdePagina });
      const t = await leerTraza(b.cliente, 1, { conFilas: true });
      chk(`sin recibido_en (${forma}, el error en la página ${desdePagina + 1}) → sinRecibido, sin duplicar filas`,
        t.sinRecibido === true && t.filas?.length === validas && t.totalCrudo === validas
        && (t.filas ?? []).every((f: FilaGpsDiag) => f.recibidoTs == null)
        && !/recibido_en/.test(b.selects[b.selects.length - 1]) && /fix_ts/.test(b.selects[b.selects.length - 1])
        && firmaTraza(t) === firmaTraza(t0));
    }
  }
  const sinTres = baseFalsa(filas, { faltan: ["simulado", "fix_ts", "recibido_en"] });
  const t3 = await leerTraza(sinTres.cliente, 1, { conFilas: true });
  chk("sin las tres columnas accesorias: cuatro lecturas, ninguna la pide, la traza se mide igual",
    t3.sinRecibido === true && t3.simulados === 0 && t3.filas?.length === validas
    && !/simulado|fix_ts|recibido_en/.test(sinTres.selects[sinTres.selects.length - 1])
    && JSON.stringify(t3.pts) === JSON.stringify(t0.pts) && t3.totalCrudo === t0.totalCrudo);
  chk("sin fix_ts: las filas salen con fixTs null y recibido_en sigue pidiéndose",
    await (async () => {
      const b = baseFalsa(filas, { faltan: ["fix_ts"] });
      const t = await leerTraza(b.cliente, 1, { conFilas: true });
      return t.sinRecibido === false && (t.filas ?? []).every((f: FilaGpsDiag) => f.fixTs == null) && /recibido_en/.test(b.selects[b.selects.length - 1]);
    })());

  const lanza = async (o: Opciones, conFilas: boolean) => {
    try { await leerTraza(baseFalsa(filas, o).cliente, 1, { conFilas }); return false; } catch { return true; }
  };
  chk("otro error (red, permiso) en cualquier página → LANZA, no devuelve media traza",
    await lanza({ otroError: { pagina: 0, error: { code: "57014", message: "canceling statement due to statement timeout" } } }, true)
    && await lanza({ otroError: { pagina: 1, error: { message: "fetch failed" } } }, false));
  chk("un error que menciona `simulado` pero NO es de columna → LANZA (el regex viejo se lo tragaba)",
    await lanza({ otroError: { pagina: 0, error: { code: "23514", message: "violates check constraint ubicaciones_gps_simulado_ck" } } }, false));
  chk("falta una columna que NO es accesoria (conductor_id) → LANZA", await lanza({ faltan: ["conductor_id"] }, true));
  chk("falta `fix_ts` sin `conFilas` → no se pide, no hay error", !(await lanza({ faltan: ["fix_ts", "recibido_en"] }, false)));
  chk("error de columna sin nombre (42703 a secas) → LANZA: no se adivina cuál soltar",
    await lanza({ otroError: { pagina: 0, error: { code: "42703", message: "undefined column" } } }, true));
}

// ══ 3. Quién es el conductor ═════════════════════════════════════════════════════════
console.log("\n3. El conductor del teléfono: el de la traza; la reserva, de respaldo");
{
  const f = (ts: number, c: number | null, t: number | null): FilaGpsDiag => ({
    ts, lat: 0, lng: 0, util: true, antena: false, precisionM: 5, recibidoTs: null, fixTs: null, conductorId: c, conductorTerceroId: t,
  });
  chk("mayoría simple", JSON.stringify(conductorDeLaTraza([f(1, 7, null), f(2, 7, null), f(3, 9, null)])) === JSON.stringify({ tabla: "conductores", id: 7 }));
  chk("los ids de las dos tablas no se mezclan (el 7 propio y el 7 tercero son dos personas)",
    JSON.stringify(conductorDeLaTraza([f(1, 7, null), f(2, null, 7), f(3, null, 7)])) === JSON.stringify({ tabla: "conductores_tercero", id: 7 }));
  chk("empate → la identidad de la fila más reciente",
    conductorDeLaTraza([f(1, 7, null), f(5, 9, null), f(2, 7, null), f(9, 9, null)])?.id === 9);
  chk("filas sin conductor, o con los dos, no votan", conductorDeLaTraza([f(1, null, null), f(2, 3, 4)]) === null
    && conductorDeLaTraza([f(1, null, null), f(2, 3, 4), f(3, null, 5)])?.id === 5);
  chk("sin filas (no leídas o vacías) → null", conductorDeLaTraza(null) === null && conductorDeLaTraza([]) === null);
  chk("respaldo: la reserva, propio primero; ids no válidos no cuentan",
    conductorDeReserva({ conductor_id: 3, conductor_tercero_id: 4 })?.tabla === "conductores"
    && conductorDeReserva({ conductor_id: null, conductor_tercero_id: "4" })?.tabla === "conductores_tercero"
    && conductorDeReserva({ conductor_id: 0, conductor_tercero_id: "x" }) === null);
  const d1 = conductorDelDiagnostico([f(1, null, 5)], { conductor_id: 3 });
  const d2 = conductorDelDiagnostico(null, { conductor_id: 3 });
  chk("declara de dónde salió: la traza manda sobre la reserva (reasignada), y si no, la reserva",
    d1?.por === "traza" && d1.tabla === "conductores_tercero" && d1.id === 5 && d2?.por === "reserva" && d2.id === 3
    && conductorDelDiagnostico([], {}) === null);
  // Barrido: la mayoría por fuerza bruta.
  let ok = true;
  for (let k = 0; k < 2000; k++) {
    const filas: FilaGpsDiag[] = [];
    const n = Math.floor(rnd() * 12);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      filas.push(f(Math.floor(rnd() * 1000), r < 0.45 ? 1 + Math.floor(rnd() * 3) : null, r >= 0.45 && r < 0.9 ? 1 + Math.floor(rnd() * 3) : r >= 0.97 ? 2 : null));
    }
    const cuenta = new Map<string, number>();
    for (const x of filas) {
      if ((x.conductorId == null) === (x.conductorTerceroId == null)) continue;
      const k2 = x.conductorId != null ? `conductores:${x.conductorId}` : `conductores_tercero:${x.conductorTerceroId}`;
      cuenta.set(k2, (cuenta.get(k2) ?? 0) + 1);
    }
    const max = Math.max(0, ...cuenta.values());
    const r = conductorDeLaTraza(filas);
    if (max === 0 ? r !== null : !r || cuenta.get(`${r.tabla}:${r.id}`) !== max) { ok = false; break; }
  }
  chk("barrido (2000 trazas): siempre la identidad con más filas", ok);
}

// ══ 4. La ventana de los reportes ═══════════════════════════════════════════════════════
console.log("\n4. La ventana: la del % si hay medición; sin ella, de la evidencia del conductor");
{
  const r = { fecha_servicio: "2026-10-09", hora_servicio: "04:00:00" };
  const prog = Date.parse("2026-10-09T04:00:00-05:00");
  const dia = Date.parse("2026-10-09T00:00:00-05:00");
  const base = { enCurso: false, inicioTs: null, finTs: null, finPrevistoTs: null };
  const ahora = Date.parse("2026-10-11T12:00:00-05:00");
  const conMed = ventanaDelServicio(r, base, { ventanaIniTs: 100, ventanaFinTs: 900 }, ahora);
  chk("con medición: exactamente la ventana del %", conMed.ini === 100 && conMed.fin === 900);
  chk("sin medición ni marcas: de la hora programada al fin de su día",
    JSON.stringify(ventanaDelServicio(r, base, null, ahora)) === JSON.stringify({ ini: prog, fin: dia + 86_400_000 }));
  chk("el inicio marcado manda sobre la hora programada", ventanaDelServicio(r, { ...base, inicioTs: prog + 600_000 }, null, ahora).ini === prog + 600_000);
  chk("fin: la llegada marcada, luego la prevista", ventanaDelServicio(r, { ...base, finTs: prog + 7_200_000, finPrevistoTs: prog + 3_600_000 }, null, ahora).fin === prog + 7_200_000
    && ventanaDelServicio(r, { ...base, finPrevistoTs: prog + 3_600_000 }, null, ahora).fin === prog + 3_600_000);
  chk("en curso: hasta ahora", ventanaDelServicio(r, { ...base, enCurso: true }, null, prog + 900_000).fin === prog + 900_000);
  chk("el día que no terminó: hasta ahora, no hasta medianoche", ventanaDelServicio(r, base, null, prog + 3_600_000).fin === prog + 3_600_000);
  chk("sin fecha ni hora: un punto (ahora), nunca NaN", (() => { const v = ventanaDelServicio({}, base, null, ahora); return v.ini === ahora && v.fin === ahora; })());
  let ok = true;
  for (let k = 0; k < 5000 && ok; k++) {
    const pick = () => (rnd() < 0.4 ? null : prog + Math.round((rnd() - 0.5) * 20 * 3_600_000));
    const ctx = { enCurso: rnd() < 0.3, inicioTs: pick(), finTs: pick(), finPrevistoTs: pick() };
    const med = rnd() < 0.3 ? (() => { const a = pick() ?? prog; return { ventanaIniTs: a, ventanaFinTs: a + Math.round(rnd() * 7_200_000) }; })() : null;
    const v = ventanaDelServicio(rnd() < 0.1 ? {} : r, ctx, med, prog + Math.round((rnd() - 0.3) * 30 * 3_600_000));
    if (!Number.isFinite(v.ini) || !Number.isFinite(v.fin) || v.fin < v.ini) ok = false;
    if (med && (v.ini !== med.ventanaIniTs || v.fin !== med.ventanaFinTs)) ok = false;
  }
  chk("barrido (5000): nunca invertida ni NaN, y con medición siempre la del %", ok);
}

// ══ 5. El historial: qué servicio es «anterior» ══════════════════════════════════════════
console.log("\n5. El historial: orden total por fecha, hora programada e id");
{
  const s = (id: number, fecha: string, hora: string | null) => ({ id, fecha_servicio: fecha, hora_servicio: hora });
  const ref = s(50, "2026-10-09", "14:00:00");
  chk("el mismo día, antes → sí; después → no", anteriorA(s(10, "2026-10-09", "06:30"), ref) && !anteriorA(s(10, "2026-10-09", "17:00"), ref));
  chk("«06:30» y «06:30:00» son la misma hora (desempata el id)", ordenServicio(s(1, "2026-10-09", "06:30"), s(2, "2026-10-09", "06:30:00")) < 0
    && ordenServicio(s(2, "2026-10-09", "06:30"), s(1, "2026-10-09", "06:30:00")) > 0);
  chk("el propio servicio nunca es anterior a sí mismo", !anteriorA(ref, ref) && !anteriorA({ ...ref, hora_servicio: "01:00" }, ref));
  chk("sin hora: primero del día", anteriorA(s(99, "2026-10-09", null), ref));
  chk("otro día manda sobre la hora", anteriorA(s(1, "2026-10-08", "23:59"), ref) && !anteriorA(s(1, "2026-10-10", "00:01"), ref));
  let ok = true;
  const fechas = ["2026-10-07", "2026-10-08", "2026-10-09"], horas = [null, "06:30", "06:30:00", "14:00", "23:59:59"];
  const xs = Array.from({ length: 60 }, (_, i) => s(i + 1, fechas[Math.floor(rnd() * 3)], horas[Math.floor(rnd() * 5)]));
  for (const a of xs) for (const b of xs) {
    if (a.id === b.id) { if (anteriorA(a, b)) ok = false; continue; }
    if (anteriorA(a, b) === anteriorA(b, a)) ok = false;                     // total y antisimétrico
    for (const c of xs) if (anteriorA(a, b) && anteriorA(b, c) && !anteriorA(a, c)) ok = false; // transitivo
  }
  chk("barrido (60³): orden total, antisimétrico y transitivo", ok);
  chk("horaCorta", horaCorta("6:05:00") === "06:05" && horaCorta("14:30") === "14:30" && horaCorta(null) === null && horaCorta("x") === null);
}

// ══ 6. Lo que sale a la pantalla ═════════════════════════════════════════════════════════
console.log("\n6. El estado del teléfono sale sin los identificadores de aparato");
{
  const e = estadoDesdeFilas([
    { dispositivo: "aparato-uno-1234", motivo: "arranque", plataforma: "apk", reportado_en: new Date(T0).toISOString(), visto_hasta: new Date(T0 + 600_000).toISOString(), bateria_exenta: true },
    { dispositivo: "aparato-dos-5678", motivo: "cambio", plataforma: "apk", reportado_en: new Date(T0 + 60_000).toISOString(), visto_hasta: new Date(T0 + 900_000).toISOString(), bateria_exenta: false },
  ]);
  const p = equipoParaPantalla(e) as Record<string, unknown> | null;
  chk("sin `dispositivos`, con `aparatos`", !!p && !("dispositivos" in p) && p.aparatos === 2);
  chk("todo lo demás igual", !!e && !!p && Object.keys(e).filter((k) => k !== "dispositivos").every((k) => JSON.stringify((e as any)[k]) === JSON.stringify(p[k])));
  chk("null → null", equipoParaPantalla(null) === null);
  chk("ningún identificador de aparato en el JSON", !JSON.stringify(p).includes("aparato-uno") && !JSON.stringify(p).includes("aparato-dos"));
}

// ══ 7. Sin la tabla del teléfono ═══════════════════════════════════════════════════════════
console.log("\n7. Sin `gps_equipo_reportes`, el diagnóstico nombra el SQL en vez de decir «no reportó»");
{
  const traza = trazaVacia();
  const veredicto = veredictoRastreo({ aplica: true, enCurso: false, traza, medicion: null, avanzo: true, inmovil: false, inicioTs: null, ahoraMs: T0 });
  const base = { veredicto, medicion: null, traza, filas: [], enCurso: false, equipo: { durante: null, anterior: null }, reinicios: [], recibidoMedible: false };
  const sinTabla = diagnosticarRastreo({ ...base, sinTablaEquipo: true });
  const sinReporte = diagnosticarRastreo(base);
  chk("el caso es `sin_senal` → la causa es la app detenida", veredicto.codigo === "sin_senal" && sinTabla.causaDominante === "app_detenida");
  chk("sin la tabla: `no_se_sabe`, nombra supabase/gps-equipo-01.sql y no dice «no reportó»",
    sinTabla.codigo === "no_se_sabe" && sinTabla.detalle.includes("supabase/gps-equipo-01.sql") && !/no reportó|no ha enviado/.test(sinTabla.titular + sinTabla.detalle));
  chk("con la tabla y sin reporte: el texto de siempre (opción omitida = como antes)",
    sinReporte.codigo === "no_se_sabe" && sinReporte.titular === "El teléfono no reportó su configuración"
    && JSON.stringify(sinReporte) === JSON.stringify(diagnosticarRastreo({ ...base, sinTablaEquipo: false })));
}

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
