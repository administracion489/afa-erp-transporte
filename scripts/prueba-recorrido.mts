// scripts/prueba-recorrido.mts — el mapa «Ver recorrido» (/seguimiento/gps/[id]).
//   npx tsx scripts/prueba-recorrido.mts
//
// Fija:
//   0. la extracción de `episodiosDeTraza`: `excesosDelServicio` da EXACTAMENTE lo mismo que la versión
//      anterior (copiada literal abajo) sobre un barrido de trazas;
//   1. el rojo del mapa es la columna «Excesos» de /uso-flota: los episodios que cuentan son tantos
//      como `excesos.n`, y sin `medido` no se publica ninguno;
//   2. cada exceso se dibuja con las posiciones de SU racha, dentro de su ventana y en orden;
//   3. la traza se corta en los huecos (> MAX_SEG_M) y se decima sin perder los extremos;
//   4. la URL: lo que compone `urlRecorrido` lo lee `leerInicio`/`leerUmbral` (el ciclo, no una mitad);
//   5. la página y el mapa no cargan Google Maps ni piden rutas a Google.

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://x.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "x";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "x";

import fs from "node:fs";
import path from "node:path";

const SE = await import("../lib/flota/servicio-estadistica");
const X = await import("../lib/flota/excesos");
const R = await import("../lib/flota/recorrido");
const U = await import("../lib/flota/recorrido-url");
const { distM, MAX_SEG_M } = await import("../lib/huella");
type VeredictoRastreo = import("../lib/gps-cobertura").VeredictoRastreo;
type CodigoRastreo = VeredictoRastreo["codigo"];

let ok = 0, fallas = 0;
function chk(nombre: string, cond: boolean, detalle?: string) {
  if (cond) ok++;
  else { fallas++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ""}`); }
}
const seccion = (t: string) => console.log(`\n── ${t}`);

// PRNG determinista.
let semilla = 20261013;
const rnd = () => { semilla = (semilla * 1664525 + 1013904223) >>> 0; return semilla / 2 ** 32; };

type Fila = Record<string, unknown>;
const T0 = Date.UTC(2026, 9, 9, 21, 0, 0);
/** Filas crudas de un tramo: una cada `paso` s, a `kmh` en línea recta. */
function tramo(desdeMs: number, segs: number, kmh: number, o: { conductor?: number; tercero?: number; paso?: number; quieto?: boolean; prec?: number | null; velSensor?: number; lat0?: number; lng0?: number } = {}): Fila[] {
  const out: Fila[] = [];
  const paso = o.paso ?? 3;
  let lat = o.lat0 ?? -12.05;
  for (let t = 0; t <= segs; t += paso) {
    if (!o.quieto) lat += ((kmh / 3.6) * paso) / 111_320;
    const jit = o.quieto ? (rnd() - 0.5) * 0.00004 : 0;
    out.push({
      created_at: new Date(desdeMs + t * 1000).toISOString(), lat: lat + jit, lng: (o.lng0 ?? -77.03) + jit,
      precision_m: o.prec === undefined ? 4 + (t % 3) : o.prec, simulado: null, estado: "en_ruta",
      velocidad: o.velSensor ?? kmh, rumbo: 0, timestamp: null,
      conductor_id: o.tercero ? null : o.conductor ?? 5, conductor_tercero_id: o.tercero ?? null,
    });
  }
  return out;
}
const ver = (codigo: CodigoRastreo, enCurso = false): VeredictoRastreo =>
  ({ codigo, pct: 98, problema: null, celda: "", color: "", bg: "", detalle: "", ultimaSenalTs: null, enCurso });

/** Una traza de servicio al azar: tramos seguidos de velocidades y duraciones variadas. */
function trazaAlAzar(): Fila[] {
  const filas: Fila[] = [];
  let cursor = T0;
  let lat = -12.05;
  const n = 2 + Math.floor(rnd() * 6);
  const tercero = rnd() < 0.3;
  for (let k = 0; k < n; k++) {
    const kmh = [0, 30, 55, 85, 92, 98, 105, 125, 140][Math.floor(rnd() * 9)];
    const segs = [6, 20, 35, 60, 120][Math.floor(rnd() * 5)];
    const t = tramo(cursor, segs, kmh, { conductor: tercero ? undefined : 5, tercero: tercero ? 5 : undefined, quieto: kmh === 0, lat0: lat, prec: rnd() < 0.1 ? 60 : rnd() < 0.05 ? null : undefined });
    filas.push(...t);
    lat = Number(t[t.length - 1].lat);
    cursor += (segs + 2) * 1000;
    if (rnd() < 0.25) { cursor += 90_000; lat += 0.008; } // hueco de señal: salto de ~900 m
  }
  return filas;
}

// ══ 0 · la extracción ══════════════════════════════════════════════════════════════════════
seccion("0 · excesosDelServicio = la versión anterior (copiada literal)");
{
  // ── COPIA LITERAL de excesosDelServicio ANTES de extraer episodiosDeTraza ──
  function excesosViejo(e: { reservaId: number; crudas: any[] | null; aplica: boolean; trazaLeida: boolean; rastreo: VeredictoRastreo; umbral: number; vehiculo?: string | null }) {
    const piso = e.rastreo.enCurso || !(e.rastreo.codigo === "completo" || e.rastreo.codigo === "aceptable");
    const vacio = (codigo: string, base: string) => ({ codigo, n: null, segundos: null, velMax: null, descartados: {}, umbral: e.umbral, piso: false, base });
    if (!e.aplica) return vacio("no_aplica", "El servicio no salió: no hay velocidad que juzgar.");
    if (!e.trazaLeida || !e.crudas) return vacio("sin_medir", "No se pudo leer el GPS de este servicio: no se afirma ningún exceso.");
    const puntos = X.puntosDeCrudas(e.crudas, { reservaId: e.reservaId, vehiculo: e.vehiculo ?? null });
    // filasDeConductor (privada) cuenta las filas con coordenadas y hora; en estas trazas son todas.
    const hayPuntos = e.crudas.filter((f: any) => f && Number.isFinite(Number(f.lat)) && Number.isFinite(Number(f.lng)) && f.created_at).length > 0;
    const hayVelocidad = puntos.some((p) => p.velocidad > 0);
    const vel = X.velocimetroDe(hayPuntos, hayPuntos ? hayVelocidad : null);
    if (vel === "sin_gps") return vacio("sin_posiciones", "El servicio corrió y no llegó ninguna posición GPS: no hay velocidad que juzgar.");
    if (vel === "sin_velocimetro") {
      return vacio("sin_velocimetro", "El teléfono no reporta la velocidad del sensor (siempre 0): este servicio no se puede juzgar, y no es «0 excesos».");
    }
    if (vel !== "con_velocimetro") return vacio("sin_medir", "No se pudo saber si el teléfono reporta velocidad: no se afirma ningún exceso.");
    const eps = X.detectarExcesos(puntos, e.umbral).filter((x) => x.reservaId === e.reservaId);
    const cuentan = eps.filter((x) => x.codigo === "exceso");
    const descartados: Record<string, number> = {};
    for (const x of eps) if (x.codigo !== "exceso") descartados[x.codigo] = (descartados[x.codigo] ?? 0) + 1;
    const segundos = cuentan.reduce((acc, x) => acc + x.durS, 0);
    const velMax = cuentan.length ? Math.max(...cuentan.map((x) => x.velMaxSensor)) : null;
    const nDesc = eps.length - cuentan.length;
    return {
      codigo: "medido", n: cuentan.length, segundos, velMax, descartados, umbral: e.umbral, piso,
      base: `${cuentan.length} exceso(s) sostenido(s) y corroborado(s) sobre ${e.umbral} km/h`
        + `${cuentan.length ? ` (${Math.round(segundos)} s en total, máx. ${Math.round(velMax ?? 0)} km/h)` : ""}`
        + `${nDesc ? `; ${nDesc} episodio(s) descartado(s) (breves, imprecisos o sin corroborar)` : ""}`
        + `${piso ? ". El rastreo no cubrió todo el servicio: es un mínimo" : ""}.`,
    };
  }
  let n = 0, iguales = 0, conExceso = 0;
  const codigos = ["completo", "aceptable", "con_cortes", "insuficiente"] as CodigoRastreo[];
  for (let i = 0; i < 600; i++) {
    const filas = trazaAlAzar();
    // Un 10 % sin velocímetro (siempre 0) y otro 5 % vacías.
    const crudas = rnd() < 0.1 ? filas.map((f) => ({ ...f, velocidad: 0 })) : rnd() < 0.05 ? [] : filas;
    for (const umbral of [60, 90, 120]) {
      const e = { reservaId: 77, crudas, aplica: true, trazaLeida: true, rastreo: ver(codigos[i % 4], i % 7 === 0), umbral, vehiculo: "p:3" };
      const a = JSON.stringify(SE.excesosDelServicio(e));
      const b = JSON.stringify(excesosViejo(e));
      n++;
      if (a === b) iguales++; else if (iguales + 3 > n) console.log("   ", a, "\n   ", b);
      if ((SE.excesosDelServicio(e).n ?? 0) > 0) conExceso++;
    }
  }
  chk(`idéntica sobre ${n} trazas × umbral`, iguales === n, `${n - iguales} distintas`);
  chk("el barrido tiene excesos de verdad (no es trivial)", conExceso > 100, `${conExceso}`);
  for (const [aplica, leida, crudas, cod] of [[false, true, [], "no_aplica"], [true, false, null, "sin_medir"], [true, true, null, "sin_medir"]] as const) {
    const e = { reservaId: 1, crudas: crudas as any, aplica, trazaLeida: leida, rastreo: ver("completo"), umbral: 90 };
    chk(`${cod}: igual a la anterior`, JSON.stringify(SE.excesosDelServicio(e)) === JSON.stringify(excesosViejo(e)));
  }
}

// ══ 1 · el rojo del mapa es la columna ═════════════════════════════════════════════════════
seccion("1 · los episodios que cuentan son los de excesosDelServicio");
{
  let n = 0, cuadra = 0, sinMedidoSinEps = 0, sinMedido = 0, conRojo = 0;
  for (let i = 0; i < 500; i++) {
    const filas = trazaAlAzar();
    const crudas = rnd() < 0.1 ? filas.map((f) => ({ ...f, velocidad: 0 })) : filas;
    const umbral = [60, 90, 100][i % 3];
    const e = { reservaId: 5, crudas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral, vehiculo: "p:1" };
    const rec = R.recorridoDeServicio(e);
    const col = SE.excesosDelServicio(e);
    n++;
    if (JSON.stringify(rec.excesos) === JSON.stringify(col)) {
      if (col.codigo === "medido") {
        if (rec.episodios.filter((x) => x.cuenta).length === col.n) cuadra++;
        if ((col.n ?? 0) > 0) conRojo++;
      } else {
        sinMedido++;
        if (rec.episodios.length === 0) sinMedidoSinEps++;
        cuadra++;
      }
    }
  }
  chk(`el resumen del mapa ES el de la columna, y cuentan tantos como n (${n})`, cuadra === n, `${n - cuadra}`);
  chk("sin «medido» no se publica ningún episodio", sinMedidoSinEps === sinMedido, `${sinMedido - sinMedidoSinEps}`);
  chk("el barrido tiene rojo de verdad", conRojo > 50, `${conRojo}`);

  // El orden de los episodios es por hora de inicio, y los descartados no cuentan.
  // Los tramos van encadenados (cada uno arranca donde terminó el anterior) y separados por 30 s
  // a velocidad baja, para que el motor no una dos rachas.
  const filas: Fila[] = [];
  let latC = -12.05, tC = T0;
  for (const [segs, kmh] of [[60, 100], [30, 40], [6, 110], [30, 40], [60, 50], [45, 104]] as const) {
    const t = tramo(tC, segs, kmh, { conductor: 5, lat0: latC });
    filas.push(...t);
    latC = Number(t[t.length - 1].lat);
    tC += (segs + 3) * 1000;
  }
  const rec = R.recorridoDeServicio({ reservaId: 9, crudas: filas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90 });
  chk("caso de libro: 2 excesos y 1 descartado", rec.episodios.filter((x) => x.cuenta).length === 2 && rec.episodios.filter((x) => !x.cuenta).length === 1,
    JSON.stringify(rec.episodios.map((x) => x.codigo)));
  chk("ordenados por inicio", rec.episodios.every((x, i, a) => i === 0 || a[i - 1].inicioTs <= x.inicioTs));
  chk("la columna dice 2", rec.excesos.n === 2);

  // Sin velocímetro: la traza se dibuja igual, sin rojo y sin decir «0 excesos».
  const sinVel = R.recorridoDeServicio({ reservaId: 9, crudas: filas.map((f) => ({ ...f, velocidad: 0 })), aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90 });
  chk("sin velocímetro: traza sí, episodios no, código sin_velocimetro", sinVel.tramos.length > 0 && sinVel.episodios.length === 0 && sinVel.excesos.codigo === "sin_velocimetro" && sinVel.excesos.n === null);
  // No salió / no se leyó: nada.
  const noSalio = R.recorridoDeServicio({ reservaId: 9, crudas: filas, aplica: false, trazaLeida: false, rastreo: ver("no_aplica"), umbral: 90 });
  chk("no salió: sin traza ni episodios", noSalio.tramos.length === 0 && noSalio.episodios.length === 0 && noSalio.excesos.codigo === "no_aplica");
  const noLeida = R.recorridoDeServicio({ reservaId: 9, crudas: null, aplica: true, trazaLeida: false, rastreo: ver("sin_medir"), umbral: 90 });
  chk("traza sin leer: sin_medir, nada dibujado", noLeida.tramos.length === 0 && noLeida.excesos.codigo === "sin_medir");
}

// ══ 2 · cada exceso con las posiciones de su racha ═════════════════════════════════════════
seccion("2 · las coordenadas de cada episodio");
{
  let eps = 0, buenos = 0;
  for (let i = 0; i < 300; i++) {
    const filas = trazaAlAzar();
    const rec = R.recorridoDeServicio({ reservaId: 4, crudas: filas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90 });
    const puntos = X.puntosDeCrudas(filas, { reservaId: 4 });
    for (const ep of rec.episodios) {
      eps++;
      // Cada coordenada es una posición cruda de la ventana del episodio, en orden de tiempo.
      const enVentana = puntos.filter((p) => p.ts >= ep.inicioTs && p.ts <= ep.finTs).sort((a, b) => a.ts - b.ts).map((p) => `${p.lng},${p.lat}`);
      const coords = ep.coords.map((c) => `${c[0]},${c[1]}`);
      const subsec = coords.every((c) => enVentana.includes(c)) && coords.join("|") === enVentana.filter((c) => coords.includes(c)).join("|");
      const minimo = !ep.cuenta || ep.coords.length >= 2;
      if (subsec && minimo && ep.coords.length >= 1) buenos++;
    }
  }
  chk(`${eps} episodios: sus coordenadas son las de su ventana, en orden, y un exceso tiene 2+`, buenos === eps && eps > 50, `${eps - buenos}`);
}

// ══ 3 · tramos, huecos y decimado ══════════════════════════════════════════════════════════
seccion("3 · la traza se corta en los huecos y se decima sin perder extremos");
{
  let casos = 0, cortesBien = 0;
  for (let i = 0; i < 300; i++) {
    const filas = trazaAlAzar();
    const rec = R.recorridoDeServicio({ reservaId: 2, crudas: filas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90 });
    casos++;
    const sinSaltos = rec.tramos.every((t) => t.length >= 2 && t.every((c, j) => j === 0 || distM(t[j - 1][1], t[j - 1][0], c[1], c[0]) <= MAX_SEG_M));
    const huecosLargos = rec.huecos.every((h) => h.metros > MAX_SEG_M);
    if (sinSaltos && huecosLargos) cortesBien++;
  }
  chk(`ningún tramo salta más de ${MAX_SEG_M} m y todo hueco lo hace (${casos})`, cortesBien === casos, `${casos - cortesBien}`);

  const conHueco = [...tramo(T0, 60, 60, { conductor: 5 }), ...tramo(T0 + 200_000, 60, 60, { conductor: 5, lat0: -12.03 })];
  const rh = R.recorridoDeServicio({ reservaId: 2, crudas: conHueco, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90 });
  chk("un salto de ~2 km: 2 tramos y 1 hueco con su tiempo", rh.tramos.length === 2 && rh.huecos.length === 1 && (rh.huecos[0].segundos ?? 0) > 100, JSON.stringify({ t: rh.tramos.length, h: rh.huecos }));

  const largos: [number, number][][] = [Array.from({ length: 4000 }, (_, i) => [i, 0] as [number, number]), Array.from({ length: 3000 }, (_, i) => [i, 1] as [number, number])];
  const d = R.decimarTramos(largos, 1000);
  const total = d.tramos.reduce((a, t) => a + t.length, 0);
  chk("decimado: avisa, queda cerca del tope y conserva los extremos de cada tramo",
    d.decimada && total <= 1000 + 2 * largos.length
    && d.tramos.every((t, k) => t[0] === largos[k][0] && t[t.length - 1] === largos[k][largos[k].length - 1]), `${total}`);
  chk("sin pasar del tope no se decima", R.decimarTramos([[[0, 0], [1, 1]]], 10).decimada === false);
}

// ══ 4 · la URL: el ciclo ═══════════════════════════════════════════════════════════════════
seccion("4 · urlRecorrido ↔ leerInicio / leerUmbral");
{
  let n = 0, bien = 0;
  for (const umbral of X.UMBRALES_ACEPTADOS) for (const ini of [null, T0, T0 + 123_456]) {
    n++;
    const url = new URL(U.urlRecorrido(17493, { umbral, inicioTs: ini }), "https://x");
    const u = X.leerUmbral(url.searchParams.get("umbral"));
    const i = U.leerInicio(url.searchParams.get("inicio"));
    if (url.pathname === "/seguimiento/gps/17493" && u.ok && u.umbral === umbral && i === ini) bien++;
  }
  chk(`el umbral y el inicio vuelven tal cual (${n})`, bien === n, `${n - bien}`);
  chk("sin parámetros, la ruta pelada", U.urlRecorrido(5) === "/seguimiento/gps/5");
  chk("leerInicio rechaza basura", [null, "", "abc", "12", "-5", "1e12", "99999999999999999"].every((x) => U.leerInicio(x) === null));
  const eps = [{ inicioTs: T0 }, { inicioTs: T0 + 60_000 }];
  chk("episodioEnfocado: exacto, con 1 s de holgura, y null si no está",
    U.episodioEnfocado(eps, T0 + 60_000)?.inicioTs === T0 + 60_000 && U.episodioEnfocado(eps, T0 + 800)?.inicioTs === T0
    && U.episodioEnfocado(eps, T0 + 30_000) === null && U.episodioEnfocado(eps, null) === null);
}

// ══ 5 · sin Google ═════════════════════════════════════════════════════════════════════════
seccion("5 · la página y el mapa no cargan Google Maps ni piden rutas a Google");
{
  const raiz = process.cwd();
  for (const f of ["app/seguimiento/gps/[id]/page.tsx", "components/seguimiento/MapaRecorrido.tsx", "app/api/seguimiento/recorrido/route.ts"]) {
    const src = fs.readFileSync(path.join(raiz, f), "utf8");
    const codigo = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    chk(`${f}: sin maps.googleapis / google.maps / DirectionsService`, !/maps\.googleapis|google\.maps|DirectionsService|TrafficLayer/.test(codigo));
  }
  const enlaces = ["components/flota/SeguridadVial.tsx", "components/flota/ExcesosSecciones.tsx", "components/flota/uso/UsoFlotaServicios.tsx"];
  for (const f of enlaces) {
    const src = fs.readFileSync(path.join(raiz, f), "utf8");
    chk(`${f}: el enlace se compone con urlRecorrido`, src.includes("urlRecorrido(") && !src.includes("`/seguimiento/gps/${"));
  }
}

console.log(`\n${fallas ? "❌" : "✅"} prueba-recorrido: ${ok} ok, ${fallas} fallas`);
if (fallas) process.exit(1);
