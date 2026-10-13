// scripts/prueba-recorrido.mts — el mapa «Ver recorrido» (/seguimiento/gps/[id]).
//   npx tsx scripts/prueba-recorrido.mts
//
// Fija:
//   0. la extracción de `episodiosDeTraza`: `excesosDelServicio` da EXACTAMENTE lo mismo que la versión
//      anterior (copiada literal abajo) sobre un barrido de trazas;
//   1. el rojo del mapa es la columna «Excesos» de /uso-flota: los episodios que cuentan son tantos
//      como `excesos.n`, y sin `medido` no se publica ninguno;
//   2. cada exceso se dibuja con las posiciones de SU racha, dentro de su ventana y en orden;
//   3. la huella medida se corta en los saltos (> MAX_SEG_M) y en los «sin señal», y se decima sin
//      perder los extremos (decimarTramos = el de antes, copiado literal);
//   4. la URL: lo que compone `urlRecorrido` lo lee `leerInicio`/`leerUmbral` (el ciclo, no una mitad);
//   5. la página y el mapa no cargan Google Maps ni piden rutas a Google, y el servidor del recorrido
//      (motor, lector y ruta) no llama a NINGÚN tercero;
//   6. la huella del modal GPS extraída (huellaDeFilas, segmentosHuella/huellaCrudaFeatures, la rampa de
//      velocidad y rumboCardinal) = el bloque original copiado literal; divergencia declarada: una fila
//      sin coordenadas utilizables ya no entra como el punto (0,0);
//   7. los puentes del modal (fixesDelHueco, la fase 1 por la ruta prevista, la respuesta de
//      /api/ruta-puente y su dibujo) = el original copiado literal, y el ciclo de clavePuente
//      (quien escribe en rutas_cache y quien lee derivan la misma clave);
//   8. el ciclo de la firma de la ruta prevista: firmaRuta(paradasParaFirma(…).lista) = la clave con
//      que /api/ruta guarda lo que pide el modal; y leerRutasCache (una consulta, misma vigencia, lanza);
//  10. hechosDeParadas = las líneas de derivarTiempos copiadas literal;
//   9. el recorrido armado por la cadena real (lector con lectores falsos): el «sin señal» ES el de la
//      celda RASTREO, ningún segmento medido pasa de 300 m ni cruza un «sin señal», ningún hueco tiene
//      línea, los estimados son solo los que validarPuente aprobó, UNA consulta a rutas_cache; y el
//      corolario: el corte viejo por distancia (copiado literal) acusaba donde la medición da 0;
//      9b. cada código de la ruta prevista guardada;
//  11. la etiqueta de cada exceso: tri-estado contra un oráculo escrito aparte, y el conteo y la lista
//      de episodios idénticos con y sin etiqueta;
//  12. el peso de la respuesta: el peor caso de las listas topadas (< 450 KB con hasta 3 episodios en su
//      tope), el tope de posiciones de TODOS los episodios (lista y conteo idénticos) y la cota dura
//      lineal en la cantidad de episodios (la lista no se topa: 200 episodios pesan ~700 KB);
//  13. el tope de episodios descartados: una traza de 10 h con un punto rápido cada 11 s ya no lista
//      miles; los que cuentan y el conteo, idénticos.
//   DETALLE=1 imprime los números de cada comprobación.

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
  if (process.env.DETALLE && detalle) console.log(`  · ${nombre} — ${detalle}`);   // DETALLE=1: ver los números
  if (cond) ok++;
  else { fallas++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ""}`); }
}
let okSeccion = 0;
const seccion = (t: string) => {
  if (process.env.DETALLE && ok + fallas > 0) console.log(`   (${ok + fallas - okSeccion} comprobaciones en la sección anterior)`);
  okSeccion = ok + fallas;
  console.log(`\n── ${t}`);
};

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

const GC = await import("../lib/gps-cobertura");
/** La traza saneada y la medición de cobertura de unas filas, como las arma la celda RASTREO (sin la
 *  evidencia del conductor, que en las secciones 0-3 no hace falta). */
function medirFilas(filas: Fila[]) {
  const tr = GC.trazaVacia();
  GC.acumularFilasGps(tr, filas, true);
  tr.pts.sort((a, b) => a.ts - b.ts);
  return { tr, med: GC.medirCobertura({ pts: tr.pts, cierreTs: tr.cierreTs }) };
}

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
  chk("sin velocímetro: traza sí, episodios no, código sin_velocimetro", sinVel.medido.length > 0 && sinVel.episodios.length === 0 && sinVel.excesos.codigo === "sin_velocimetro" && sinVel.excesos.n === null);
  // No salió / no se leyó: nada.
  const noSalio = R.recorridoDeServicio({ reservaId: 9, crudas: filas, aplica: false, trazaLeida: false, rastreo: ver("no_aplica"), umbral: 90 });
  chk("no salió: sin traza ni episodios", noSalio.medido.length === 0 && noSalio.episodios.length === 0 && noSalio.excesos.codigo === "no_aplica");
  const noLeida = R.recorridoDeServicio({ reservaId: 9, crudas: null, aplica: true, trazaLeida: false, rastreo: ver("sin_medir"), umbral: 90 });
  chk("traza sin leer: sin_medir, nada dibujado", noLeida.medido.length === 0 && noLeida.excesos.codigo === "sin_medir");
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

// ══ 3 · la huella medida, los «sin señal» y el decimado ═════════════════════════════════════
// (Antes: `tramos`/`huecos` por distancia. El contrato cambió en T3: `medido` se corta en los saltos
// de más de MAX_SEG_M Y en los «sin señal» de la celda RASTREO, que van aparte, sin línea.)
seccion("3 · la huella medida se corta en los saltos y en los «sin señal», y se decima sin perder extremos");
{
  let casos = 0, bien = 0, conSinSenal = 0;
  for (let i = 0; i < 300; i++) {
    const filas = trazaAlAzar();
    const { tr, med } = medirFilas(filas);
    const rec = R.recorridoDeServicio({ reservaId: 2, crudas: filas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90, medicion: med, ptsCobertura: tr.pts });
    casos++;
    const sinSaltos = !rec.medidoDecimado && rec.medido.every((t) => t.coords.length >= 2 && t.vel.length === t.coords.length
      && t.coords.every((c, j) => j === 0 || distM(t.coords[j - 1][1], t.coords[j - 1][0], c[1], c[0]) <= MAX_SEG_M));
    const cuadra = rec.sinSenalTotal === (med ? med.tramos.length : null) && rec.sinSenal.length === (med ? med.tramos.length : 0);
    if (sinSaltos && cuadra) bien++;
    if ((rec.sinSenalTotal ?? 0) > 0) conSinSenal++;
  }
  chk(`ningún tramo medido salta más de ${MAX_SEG_M} m y los «sin señal» son los de la medición (${casos})`, bien === casos, `${casos - bien}`);
  chk("el barrido tiene tramos sin señal (no es trivial)", conSinSenal > 30, `${conSinSenal}`);

  const conHueco = [...tramo(T0, 60, 60, { conductor: 5 }), ...tramo(T0 + 200_000, 60, 60, { conductor: 5, lat0: -12.03 })];
  const mh = medirFilas(conHueco);
  const rh = R.recorridoDeServicio({ reservaId: 2, crudas: conHueco, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90, medicion: mh.med, ptsCobertura: mh.tr.pts });
  const h0 = rh.sinSenal[0];
  chk("un salto de ~2 km con 140 s sin posición: 2 tramos medidos y 1 «sin señal» con sus dos extremos, sin línea ni estimado",
    rh.medido.length === 2 && rh.sinSenal.length === 1 && h0.tipo === "hueco" && h0.durS > 100 && !!h0.desde && !!h0.hasta
    && h0.enMovimiento && !h0.estimado && rh.estimados.length === 0 && rh.cortesEnMovimiento === 1,
    JSON.stringify({ m: rh.medido.length, s: rh.sinSenal }));

  const largos: [number, number][][] = [Array.from({ length: 4000 }, (_, i) => [i, 0] as [number, number]), Array.from({ length: 3000 }, (_, i) => [i, 1] as [number, number])];
  const d = R.decimarTramos(largos, 1000);
  const total = d.tramos.reduce((a, t) => a + t.length, 0);
  chk("decimado: avisa, queda cerca del tope y conserva los extremos de cada tramo",
    d.decimada && total <= 1000 + 2 * largos.length
    && d.tramos.every((t, k) => t[0] === largos[k][0] && t[t.length - 1] === largos[k][largos[k].length - 1]), `${total}`);
  chk("sin pasar del tope no se decima", R.decimarTramos([[[0, 0], [1, 1]]], 10).decimada === false);

  // TOPE DURO (revisión de seguridad): con miles de tramos cortos los extremos solos pasaban del tope
  // (10 000 tramos de 2 vértices = 20 000 vértices sobre un «tope» de 5 000).
  const cortos: [number, number][][] = Array.from({ length: 10_000 }, (_, k) =>
    [[-77 + k * 1e-5, -12], [-77 + k * 1e-5, -12 + (1 + (k % 7)) * 1e-4]] as [number, number][]);
  const dc = R.decimarTramos(cortos);
  const tc = dc.tramos.reduce((a, t) => a + t.length, 0);
  chk(`10 000 tramos de 2 vértices: no pasa de ${R.MAX_VERTICES_TRAZA} y cuenta los omitidos`,
    dc.decimada && tc <= R.MAX_VERTICES_TRAZA && dc.omitidos === cortos.length - dc.tramos.length && dc.omitidos > 0, `${tc} · ${dc.omitidos}`);
  const largoDe = (t: [number, number][]) => distM(t[0][1], t[0][0], t[t.length - 1][1], t[t.length - 1][0]);
  const minQueda = Math.min(...dc.tramos.map(largoDe));
  const quedanSet = new Set(dc.tramos.map((t) => `${t[0][0]}`));
  const maxFuera = Math.max(...cortos.filter((t) => !quedanSet.has(`${t[0][0]}`)).map(largoDe));
  chk("se quedan los tramos más largos", minQueda >= maxFuera - 1e-6, `${minQueda} vs ${maxFuera}`);
  const posiciones = dc.tramos.map((t) => cortos.findIndex((c) => c[0][0] === t[0][0]));
  chk("y en su orden original", posiciones.every((p, i) => i === 0 || posiciones[i - 1] < p));
  // Barrido: ningún reparto de tramos pasa del tope, y sin pasarlo no se omite nada.
  let barridoOk = true;
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rnd() * 400);
    const ts = Array.from({ length: n }, (_, k) => Array.from({ length: 2 + Math.floor(rnd() * 60) }, (_, j) => [k, j] as [number, number]));
    const max = 20 + Math.floor(rnd() * 2000);
    const r = R.decimarTramos(ts, max);
    const tot = r.tramos.reduce((a, t) => a + t.length, 0);
    const antes = ts.reduce((a, t) => a + t.length, 0);
    if (tot > max || (antes <= max && (r.decimada || r.omitidos)) || r.tramos.length + r.omitidos !== n
      || r.tramos.some((t) => t.length < 2)) { barridoOk = false; console.log("   ", { n, max, tot, om: r.omitidos }); break; }
  }
  chk("barrido de 300 repartos: nunca pasa del tope, nada se pierde sin contarse", barridoOk);
  // decimarTramos se construye ahora sobre planDecimado (el mismo plan que decima la huella con su
  // velocidad): tiene que dar EXACTAMENTE lo que daba antes.
  // ── COPIA LITERAL de decimarTramos de lib/flota/recorrido.ts ANTES de T3 ──
  function decimarTramosViejo(tramos: [number, number][][], max = 5000): { tramos: [number, number][][]; decimada: boolean; omitidos: number } {
    const contarVertices = (ts: readonly [number, number][][]) => ts.reduce((acc, t) => acc + t.length, 0);
    const largoM = (t: readonly [number, number][]) => { let m = 0; for (let i = 1; i < t.length; i++) m += distM(t[i - 1][1], t[i - 1][0], t[i][1], t[i][0]); return m; };
    const total = contarVertices(tramos);
    if (total <= max) return { tramos, decimada: false, omitidos: 0 };
    const masLargo = tramos.reduce((acc, t) => Math.max(acc, t.length), 0);
    const decimar = (paso: number) => tramos.map((t) => t.filter((_, i) => i === 0 || i === t.length - 1 || i % paso === 0));
    let paso = Math.max(2, Math.ceil(total / max));
    let out = decimar(paso);
    while (contarVertices(out) > max && paso < masLargo) {
      paso += Math.max(1, Math.floor(paso / 4));
      out = decimar(paso);
    }
    if (contarVertices(out) <= max) return { tramos: out, decimada: true, omitidos: 0 };
    const orden = out.map((t, i) => ({ i, m: largoM(tramos[i]) })).sort((a, b) => b.m - a.m || a.i - b.i);
    const quedan = new Set<number>();
    let usados = 0;
    for (const { i } of orden) {
      if (usados + out[i].length > max) continue;
      quedan.add(i);
      usados += out[i].length;
    }
    return { tramos: out.filter((_, i) => quedan.has(i)), decimada: true, omitidos: out.length - quedan.size };
  }
  let decN = 0, decIg = 0;
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(rnd() * 300);
    const ts = Array.from({ length: n }, (_, k) => Array.from({ length: 1 + Math.floor(rnd() * 80) }, (_, j) => [-77 + k * 1e-4 + rnd() * 1e-3, -12 + j * 1e-4] as [number, number]));
    const max = 10 + Math.floor(rnd() * 3000);
    decN++;
    if (JSON.stringify(R.decimarTramos(ts, max)) === JSON.stringify(decimarTramosViejo(ts, max))) decIg++;
  }
  chk(`decimarTramos (sobre planDecimado) = el de antes, copiado literal (${decN} repartos)`, decIg === decN, `${decN - decIg}`);

  // «Sin señal»: se quedan los más LARGOS (duración), en orden, y se cuentan los que no.
  const muchos = Array.from({ length: 900 }, (_, k) => ({ tipo: "hueco" as const, desdeTs: k * 1000, hastaTs: k * 1000 + 61_000, durS: 61 + ((k * 37) % 900), avanceM: 10, enMovimiento: false }));
  const th = R.toparSinSenal(muchos);
  const minH = Math.min(...th.tramos.map((h) => h.durS));
  const fueraH = muchos.filter((h) => !th.tramos.includes(h));
  chk(`900 «sin señal»: quedan ${R.MAX_HUECOS}, los más largos, en orden, y ${900 - R.MAX_HUECOS} omitidos`,
    th.tramos.length === R.MAX_HUECOS && th.omitidos === 900 - R.MAX_HUECOS
    && fueraH.every((h) => h.durS <= minH) && th.tramos.every((h, i) => i === 0 || th.tramos[i - 1].desdeTs < h.desdeTs));
  chk("pocos «sin señal»: intactos", R.toparSinSenal(muchos.slice(0, 3)).omitidos === 0 && R.toparSinSenal(muchos.slice(0, 3)).tramos.length === 3);

  // Coordenadas de un episodio: muestreo con los extremos dentro.
  const serie = Array.from({ length: 2000 }, (_, k) => [k, k] as [number, number]);
  const mu = R.muestrear(serie, R.MAX_COORDS_EPISODIO);
  chk(`muestrear: ${R.MAX_COORDS_EPISODIO} puntos, primero y último incluidos, en orden`,
    mu.length === R.MAX_COORDS_EPISODIO && mu[0] === serie[0] && mu[mu.length - 1] === serie[serie.length - 1]
    && mu.every((c, i) => i === 0 || mu[i - 1][0] < c[0]));
  chk("muestrear sin pasar del tope: copia igual", JSON.stringify(R.muestrear(serie.slice(0, 5), 300)) === JSON.stringify(serie.slice(0, 5)));

  // Una traza que salta de lado a lado (> 300 m) en cada punto: la respuesta queda acotada.
  const salton: Fila[] = Array.from({ length: 20_000 }, (_, k) => ({
    created_at: new Date(T0 + k * 2000).toISOString(), lat: -12.05 + (k % 2) * 0.004 + Math.floor(k / 2) * 1e-6, lng: -77.03,
    precision_m: 5, simulado: null, estado: "en_ruta", velocidad: 40, rumbo: 0, timestamp: null, conductor_id: 5, conductor_tercero_id: null,
  }));
  const ms = medirFilas(salton);
  const rs = R.recorridoDeServicio({ reservaId: 3, crudas: salton, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90, medicion: ms.med, ptsCobertura: ms.tr.pts });
  const vRs = rs.medido.reduce((a, t) => a + t.coords.length, 0);
  const bytes = JSON.stringify(rs).length;
  chk(`traza de 20 000 saltos: ≤ ${R.MAX_VERTICES_TRAZA} vértices, ≤ ${R.MAX_HUECOS} «sin señal», ≤ ${R.MAX_PUNTOS_DATO} puntitos y respuesta acotada`,
    vRs <= R.MAX_VERTICES_TRAZA && rs.sinSenal.length <= R.MAX_HUECOS && rs.puntos.length <= R.MAX_PUNTOS_DATO && bytes < 400_000,
    `${vRs} · ${rs.sinSenal.length} · ${rs.puntos.length} · ${bytes} B`);
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

  // El servidor del recorrido NO llama a ningún tercero: ni Directions, ni Map Matching, ni Tilequery,
  // ni geocodificación, ni un fetch cualquiera. La ruta prevista y los puentes se leen de rutas_cache.
  // Se mira el CÓDIGO (sin comentarios de bloque, de línea ni al final de una línea).
  const sinComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
  const PROHIBIDO = /google-directions|consultarDirections|\/api\/ruta|matching\/v5|tilequery|geocodificar|fetch\(|mapMatchTrail|matchVentana|crearAjustadorHuella/i;
  for (const f of ["lib/flota/recorrido.ts", "lib/flota/recorrido-datos.ts", "app/api/seguimiento/recorrido/route.ts"]) {
    const codigo = sinComentarios(fs.readFileSync(path.join(raiz, f), "utf8"));
    const m = codigo.match(PROHIBIDO);
    chk(`${f}: sin Directions, /api/ruta, Map Matching, Tilequery, geocodificar ni fetch(`, !m, m?.[0]);
  }
  // …y el detector no es ciego: lo encuentra en un archivo que sí llama.
  chk("el detector encuentra las llamadas en lib/huella.ts (no es trivial)", PROHIBIDO.test(sinComentarios(fs.readFileSync(path.join(raiz, "lib/huella.ts"), "utf8"))));
  chk("la caché del recorrido es de 100 entradas", /const MAX_CACHE = 100;/.test(fs.readFileSync(path.join(raiz, "app/api/seguimiento/recorrido/route.ts"), "utf8")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// 6-8 y 10 · LAS EXTRACCIONES PARA «VER RECORRIDO» SIN LLAMADAS PAGADAS
// Cada pieza se compara contra el bloque ORIGINAL copiado literal (del modal GPS tal como estaba en
// HEAD 6924a54, antes de que T2 lo pasara a importar estas extracciones; de las dos rutas que
// escriben `rutas_cache` y de derivarTiempos), en barridos con el PRNG determinista de arriba.
// Las secciones 9, 11 y 12 (al final) prueban el armado del recorrido.
// ═════════════════════════════════════════════════════════════════════════════════════════
const H = await import("../lib/huella");
const RF = await import("../lib/ruta-firma");
const RC = await import("../lib/rutas-cache");
const ST = await import("../lib/servicio-tiempos");
const { coordValida } = await import("../lib/cotizacion-ruta-coords");
const leer = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

const M_LAT = 111_320;
const mLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Una ruta prevista al azar, densa (un vértice cada ~40 m, como la de Google), en [lng, lat]. */
function rutaAlAzar(): [number, number][] {
  let lat = -12.05 + (rnd() - 0.5) * 0.05, lng = -77.03 + (rnd() - 0.5) * 0.05;
  let rumbo = rnd() * 2 * Math.PI;
  const out: [number, number][] = [[lng, lat]];
  const nSeg = 3 + Math.floor(rnd() * 10);
  for (let s = 0; s < nSeg; s++) {
    rumbo += (rnd() - 0.5) * (Math.PI / 1.5);
    const largo = 300 + rnd() * 1800;
    const pasos = Math.max(1, Math.round(largo / 40));
    for (let k = 1; k <= pasos; k++) {
      lat += (Math.cos(rumbo) * largo / pasos) / M_LAT;
      lng += (Math.sin(rumbo) * largo / pasos) / mLng(lat);
      out.push([lng, lat]);
    }
  }
  return out;
}
function acumulada(ruta: [number, number][]): number[] {
  const cum = [0];
  for (let i = 1; i < ruta.length; i++) cum.push(cum[i - 1] + distM(ruta[i - 1][1], ruta[i - 1][0], ruta[i][1], ruta[i][0]));
  return cum;
}
/** El punto a `s` metros por la ruta, corrido `lateral` metros a la derecha de la marcha. */
function sobreRuta(ruta: [number, number][], cum: number[], s: number, lateral = 0): { lat: number; lng: number } {
  let i = 1;
  while (i < ruta.length - 1 && cum[i] < s) i++;
  const [aLng, aLat] = ruta[i - 1], [bLng, bLat] = ruta[i];
  const L = cum[i] - cum[i - 1];
  const f = L > 0 ? Math.max(0, Math.min(1, (s - cum[i - 1]) / L)) : 0;
  const lat = aLat + (bLat - aLat) * f, lng = aLng + (bLng - aLng) * f;
  if (!lateral) return { lat, lng };
  const dy = (bLat - aLat) * M_LAT, dx = (bLng - aLng) * mLng(aLat), n = Math.hypot(dx, dy) || 1;
  return { lat: lat + ((-dx / n) * lateral) / M_LAT, lng: lng + ((dy / n) * lateral) / mLng(lat) };
}
/** La ruta entera corrida `m` metros al norte (la ruta de OTRO servicio parecido). */
const correr = (ruta: [number, number][], m: number): [number, number][] => ruta.map(([lng, lat]) => [lng, lat + m / M_LAT]);

/**
 * Las filas de un servicio que recorre `ruta`: ritmo y cadencia al azar, huecos de señal (con y
 * sin fixes de torre dentro), paradas, desvíos de la ruta, equipos sin chip y numeric como texto.
 */
function trazaSobreRuta(ruta: [number, number][]): Fila[] {
  const cum = acumulada(ruta);
  const total = cum[cum.length - 1];
  const kmh = 18 + rnd() * 55, v = kmh / 3.6;
  const paso = 3 + Math.floor(rnd() * 6);
  const red = rnd() < 0.2, doppler = rnd() < 0.6, comoTexto = rnd() < 0.15;
  const filas: Fila[] = [];
  let t = 0, s = 0, lateral = 0, finDesvio = -1;
  const emitir = (sx: number, tx: number, acc: number, ruido: number) => {
    const p = sobreRuta(ruta, cum, Math.min(sx, total), lateral);
    const ang = rnd() * 2 * Math.PI, r = rnd() * ruido;
    const lat = p.lat + (Math.cos(ang) * r) / M_LAT, lng = p.lng + (Math.sin(ang) * r) / mLng(p.lat);
    filas.push({
      created_at: new Date(T0 + Math.round(tx * 1000)).toISOString(), timestamp: null,
      lat: comoTexto ? String(lat) : lat, lng: comoTexto ? String(lng) : lng,
      velocidad: doppler ? Math.max(0, kmh + (rnd() - 0.5) * 10) : 0, rumbo: doppler ? Math.floor(rnd() * 360) : 0,
      precision_m: acc, fix_ts: null, reserva_id: 1, estado: "en_ruta",
    });
  };
  while (s < total) {
    const u = rnd();
    if (u < 0.025) {                                       // hueco de señal (túnel, zona muerta)
      const dur = 25 + rnd() * 240;
      if (rnd() < 0.5) {                                   // con fixes de torre dentro: la evidencia de validarPuente
        const marcas = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => rnd() * dur).sort((a, b) => a - b);
        for (const dt of marcas) emitir(s + v * dt, t + dt, 400 + rnd() * 1000, 150);
      }
      t += dur; s += v * dur;
      continue;
    }
    if (u < 0.035) {                                       // detenido 1-3 min
      const dur = 60 + rnd() * 120;
      for (let dt = 0; dt < dur; dt += paso) emitir(s, t + dt, red ? 40 + rnd() * 60 : 5, red ? 50 : 6);
      t += dur;
      continue;
    }
    if (finDesvio < 0 && u < 0.045) { finDesvio = s + 400 + rnd() * 1200; lateral = (rnd() < 0.5 ? -1 : 1) * (120 + rnd() * 380); }
    if (finDesvio >= 0 && s > finDesvio) { finDesvio = -1; lateral = 0; }
    emitir(s, t, red ? 30 + rnd() * 90 : 3 + rnd() * 7, red ? 40 : 5);
    t += paso; s += v * paso * (0.7 + rnd() * 0.6);
  }
  return filas;
}

/** Filas basura metidas en una traza: coordenadas nulas, vacías, texto, (0,0), fuera de rango, torre. */
function ensuciar(filas: Fila[]): Fila[] {
  const out = filas.slice();
  const basura: ((f: Fila) => Fila)[] = [
    (f) => ({ ...f, lat: null }), (f) => ({ ...f, lng: null }), (f) => ({ ...f, lat: "" }),
    (f) => ({ ...f, lng: "abc" }), (f) => ({ ...f, lat: 0, lng: 0 }), (f) => ({ ...f, lat: 95 }),
    (f) => { const { lat, ...resto } = f; return resto; }, (f) => ({ ...f, precision_m: 2000 + rnd() * 3000 }),
    (f) => ({ ...f, precision_m: null }), (f) => ({ ...f, lat: "-12.0" + String(rnd()).slice(2, 7) }),
  ];
  const n = 1 + Math.floor(rnd() * 6);
  for (let k = 0; k < n && out.length; k++) {
    const i = Math.floor(rnd() * out.length);
    out.splice(i, 0, basura[Math.floor(rnd() * basura.length)](out[i]));
  }
  return out;
}

// ══ 6 · la huella del modal ═══════════════════════════════════════════════════════════════
seccion("6 · la huella del modal: huellaDeFilas, segmentosHuella y la rampa de velocidad");
{
  // ── COPIA LITERAL del modal (components/seguimiento/ModalGps.tsx en HEAD 6924a54, antes de T2), líneas 591-602 (la canalización) ──
  function huellaModalViejo(arr: any[]) {
    const brutos = H.filasAPuntos(arr);
    const crudos = H.anclarImprecisos(brutos);
    const limpio = H.conVelocidadColor(H.limpiarHuella(crudos));
    return { brutos, crudos, limpio };
  }
  // ── COPIA LITERAL del filtro de app/api/cliente/gps/route.ts:226 (antes de la constante) ──
  const filtroApi = (base: any[]) => base.filter((p: any) => p.precision_m == null || p.precision_m <= 1500);

  // ── COPIA LITERAL de huellaCrudaFeatures ANTES de construirse sobre segmentosHuella ──
  function huellaCrudaFeaturesVieja(
    huellaPts: { lat: number; lng: number; velocidad: number; acc?: number }[],
    maxSegM = H.MAX_SEG_M,
    omitirCrudoLargo = true,
  ): any[] {
    const tramos: typeof huellaPts[] = [];
    let cur: typeof huellaPts = [];
    for (let i = 0; i < huellaPts.length; i++) {
      if (i > 0 && H.distM(huellaPts[i - 1].lat, huellaPts[i - 1].lng, huellaPts[i].lat, huellaPts[i].lng) > maxSegM) {
        if (cur.length) tramos.push(cur);
        cur = [];
      }
      cur.push(huellaPts[i]);
    }
    if (cur.length) tramos.push(cur);

    const feats: any[] = [];
    for (const tramo of tramos) {
      const pts = H.suavizarPorDistancia(tramo);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const d = H.distM(a.lat, a.lng, b.lat, b.lng);
        if (omitirCrudoLargo && (H.esAccCruda(a.acc) || H.esAccCruda(b.acc)) && d > H.MAX_SEG_CRUDO_M) continue;
        feats.push({
          type: "Feature",
          properties: { velocidad: ((a.velocidad ?? 0) + (b.velocidad ?? 0)) / 2 },
          geometry: { type: "LineString", coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
        });
      }
    }
    return feats;
  }
  const comoFeature = (s: { a: any; b: any; velocidad: number }) => ({
    type: "Feature",
    properties: { velocidad: s.velocidad },
    geometry: { type: "LineString", coordinates: [[s.a.lng, s.a.lat], [s.b.lng, s.b.lat]] },
  });

  let n = 0, iguales = 0, conHuecos = 0, sucias = 0, sucIguales = 0, divergen = 0, cerosViejo = 0, basuraNueva = 0;
  let seg = 0, segIg = 0, conCorte = 0, corteIg = 0, cruzan = 0, tramoMal = 0, cortesReales = 0;
  for (let i = 0; i < 1000; i++) {
    const filas = trazaSobreRuta(rutaAlAzar());
    const api = filtroApi(filas);                       // lo que entrega /api/cliente/gps al modal
    n++;
    const h = H.huellaDeFilas(api);
    if (JSON.stringify(h) === JSON.stringify(huellaModalViejo(api))) iguales++;
    if (H.calcularPuentes(h.limpio).length > 0) conHuecos++;

    if (i % 2 === 0) {
      // Filas sucias: idéntica a la del modal sobre las filas que pasan los dos filtros…
      const sucia = ensuciar(filas);
      sucias++;
      const r = H.huellaDeFilas(sucia);
      if (JSON.stringify(r) === JSON.stringify(huellaModalViejo(filtroApi(sucia).filter((f: any) => coordValida(f.lat, f.lng))))) sucIguales++;
      // …y la divergencia es REAL: el modal metía (0,0) (o NaN) en la huella.
      const viejo = huellaModalViejo(filtroApi(sucia));
      if (viejo.brutos.some((p) => (p.lat === 0 && p.lng === 0) || !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) cerosViejo++;
      if (r.brutos.some((p) => (p.lat === 0 && p.lng === 0) || !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) basuraNueva++;
      if (JSON.stringify(viejo) !== JSON.stringify(r)) divergen++;
    }

    // huellaCrudaFeatures (y segmentosHuella sin corte) = la versión anterior, con y sin `acc`,
    // con los dos topes que usa el modal y los dos valores de omitirCrudoLargo.
    const conAcc = h.limpio.map((p) => ({ lat: p.lat, lng: p.lng, velocidad: p.velocidad, acc: p.acc }));
    const sinAcc = h.limpio.map((p) => ({ lat: p.lat, lng: p.lng, velocidad: p.velocidad }));
    for (const pts of [conAcc, sinAcc, h.limpio] as any[][]) for (const m of [H.MAX_SEG_M, 150]) for (const o of [true, false]) {
      seg++;
      const viejo = JSON.stringify(huellaCrudaFeaturesVieja(pts, m, o));
      if (JSON.stringify(H.huellaCrudaFeatures(pts, m, o)) === viejo
        && JSON.stringify(H.segmentosHuella(pts, m, o).map(comoFeature)) === viejo
        && JSON.stringify(H.segmentosHuella(pts, m, o, () => false).map(comoFeature)) === viejo) segIg++;
    }

    // cortaEntre: cortar en ciertos instantes es EXACTAMENTE partir la huella ahí y aplicar la
    // versión anterior a cada pedazo (el corte va antes del suavizado), y ningún segmento lo cruza.
    if (h.limpio.length > 4) {
      const t0 = h.limpio[0].ts, t1 = h.limpio[h.limpio.length - 1].ts;
      const cortes = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => t0 + rnd() * (t1 - t0));
      const corta = (a: { ts: number }, b: { ts: number }) => cortes.some((T) => a.ts < T && T <= b.ts);
      const pedazos: (typeof h.limpio)[] = [];
      let cur: typeof h.limpio = [];
      h.limpio.forEach((p, k) => {
        if (k > 0 && corta(h.limpio[k - 1], p)) {
          if (cur.length) pedazos.push(cur);
          cur = [];
          if (H.distM(h.limpio[k - 1].lat, h.limpio[k - 1].lng, p.lat, p.lng) <= H.MAX_SEG_M) cortesReales++;
        }
        cur.push(p);
      });
      if (cur.length) pedazos.push(cur);
      for (const o of [true, false]) {
        conCorte++;
        const segs = H.segmentosHuella(h.limpio, H.MAX_SEG_M, o, corta);
        if (JSON.stringify(segs.map(comoFeature)) === JSON.stringify(pedazos.flatMap((pz) => huellaCrudaFeaturesVieja(pz, H.MAX_SEG_M, o)))) corteIg++;
        if (segs.some((s) => corta(s.a, s.b))) cruzan++;
        if (segs.some((s, k) => k > 0 && s.tramo < segs[k - 1].tramo)) tramoMal++;
      }
    }
  }
  chk(`huellaDeFilas = la canalización del modal sobre ${n} trazas de /api/cliente/gps`, iguales === n, `${n - iguales} distintas`);
  chk("el barrido tiene huecos que puentear (no es trivial)", conHuecos > 200, `${conHuecos}`);
  chk(`filas sucias (${sucias}): idéntica a la del modal sobre las filas con coordenadas utilizables`, sucIguales === sucias, `${sucias - sucIguales}`);
  chk("DIVERGENCIA DECLARADA: el modal metía (0,0)/NaN en la huella; huellaDeFilas nunca", cerosViejo > 0 && basuraNueva === 0 && divergen > 0,
    `viejo ${cerosViejo} · nuevo ${basuraNueva} · divergen ${divergen}`);
  chk("una fila nula no rompe nada y no cuenta", JSON.stringify(H.huellaDeFilas([null, ...tramo(T0, 30, 40), null] as any)) === JSON.stringify(H.huellaDeFilas(tramo(T0, 30, 40))));
  chk("sin filas: las tres etapas vacías", JSON.stringify(H.huellaDeFilas(null)) === JSON.stringify({ brutos: [], crudos: [], limpio: [] }));
  const srcGps = leer("app/api/cliente/gps/route.ts");
  chk("PRECISION_MAX_HUELLA_M = 1500 y /api/cliente/gps lo usa (sin el literal)",
    H.PRECISION_MAX_HUELLA_M === 1500 && srcGps.includes("p.precision_m <= PRECISION_MAX_HUELLA_M") && !/precision_m\s*<=\s*1500/.test(srcGps));
  chk(`huellaCrudaFeatures y segmentosHuella = la versión anterior (${seg} combinaciones)`, segIg === seg, `${seg - segIg}`);
  chk(`cortaEntre = partir la huella ahí y aplicar la anterior a cada pedazo (${conCorte})`, corteIg === conCorte, `${conCorte - corteIg}`);
  chk("ningún segmento cruza un corte y `tramo` no retrocede", cruzan === 0 && tramoMal === 0, `${cruzan} · ${tramoMal}`);
  chk("los cortes extra cortan de verdad (no solo donde ya cortaba la distancia)", cortesReales > 100, `${cortesReales}`);

  // La rampa: la expresión de la línea y de los puntitos, la leyenda y el verde del estimado.
  const expModal = ["interpolate", ["linear"], ["get", "velocidad"], 0, "#dc2626", 15, "#f59e0b", 35, "#eab308", 55, "#16a34a"];
  chk("expresionColorVelocidad = la del modal (line-color y circle-color)", JSON.stringify(H.expresionColorVelocidad()) === JSON.stringify(expModal));
  chk("la leyenda: Parado · Lento · Moderado · Rápido, con las clases del modal",
    JSON.stringify(H.ETIQUETAS_VELOCIDAD) === JSON.stringify(["Parado", "Lento", "Moderado", "Rápido"])
    && JSON.stringify(H.RAMPA_VELOCIDAD.map((r) => r.claseLeyenda)) === JSON.stringify(["bg-red-500", "bg-amber-400", "bg-yellow-300", "bg-green-500"]));
  chk("el verde petróleo del tramo estimado", H.COLOR_TRAMO_ESTIMADO === "#0f766e");
  // ── COPIA LITERAL del modal (ModalGps.tsx en HEAD 6924a54, antes de T2), líneas 94-97 ──
  const rumboCardinalViejo = (deg: number) => {
    const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  };
  let rumbos = 0, rumbosIg = 0;
  for (let d = -1080; d <= 1080; d += 0.25) { rumbos++; if (H.rumboCardinal(d) === rumboCardinalViejo(d)) rumbosIg++; }
  for (const d of [NaN, Infinity, -Infinity, 22.4999, 22.5, 337.5, 359.99]) { rumbos++; if (H.rumboCardinal(d) === rumboCardinalViejo(d)) rumbosIg++; }
  chk(`rumboCardinal = el del modal (${rumbos} rumbos)`, rumbosIg === rumbos, `${rumbos - rumbosIg}`);
}

// ══ 7 · los puentes del modal ═════════════════════════════════════════════════════════════
seccion("7 · los puentes del modal: fixesDelHueco, la fase 1, la respuesta de Directions y clavePuente");
{
  /** Una polilínea recta y densa de A a B, en [lng, lat]. */
  const linea = (c: any, n: number): [number, number][] =>
    Array.from({ length: n + 1 }, (_, k) => [c.aLng + (c.bLng - c.aLng) * (k / n), c.aLat + (c.bLat - c.aLat) * (k / n)] as [number, number]);
  /** Corre un vértice `m` metros en una dirección al azar. */
  const mover = (p: [number, number], m: number): [number, number] => {
    const ang = rnd() * 2 * Math.PI;
    return [p[0] + (Math.sin(ang) * m) / mLng(p[1]), p[1] + (Math.cos(ang) * m) / M_LAT];
  };
  /** Lo que devuelve /api/ruta-puente (o lo que guardó en rutas_cache) para un candidato. */
  function respuestaAlAzar(c: any, ruta: [number, number][]): any {
    const u = rnd();
    if (u < 0.04) return undefined;
    if (u < 0.07) return null;
    if (u < 0.12) return { ocultar: true, status: "HTTP 429" };
    if (u < 0.17) return { ocultar: true, status: "ZERO_RESULTS" };
    if (u < 0.20) return { ocultar: true, status: "NOT_FOUND" };
    if (u < 0.23) return { ocultar: true, status: "SIN_GEOMETRIA" };
    if (u < 0.26) return { ocultar: true, status: "OVER_QUERY_LIMIT" };
    if (u < 0.28) return { error: "GOOGLE_MAPS_API_KEY no configurada" };
    if (u < 0.30) return { ocultar: true, status: "fetch failed" };
    if (u < 0.32) return { status: "OK", coords: [], roadM: c.dRecta * 1.3, rutasM: [] };
    const geo = H.puentePorRuta({ lat: c.aLat, lng: c.aLng }, { lat: c.bLat, lng: c.bLng }, ruta) ?? linea(c, 30);
    const gc = geo.map((p) => [p[0], p[1]] as [number, number]);
    gc[0] = mover(gc[0], rnd() * 60);
    gc[gc.length - 1] = mover(gc[gc.length - 1], rnd() * 60);
    const v = rnd();
    const roadM = v < 0.1 ? 0 : v < 0.2 ? undefined : v < 0.3 ? c.dRecta * (9 + rnd() * 3) : c.dRecta * (1 + rnd() * 2.5);
    return { coords: gc, roadM, rutasM: [roadM], status: "OK", ...(rnd() < 0.05 ? { ocultar: true } : {}) };
  }

  chk("MAX_PUENTES = 30 (el del modal)", H.MAX_PUENTES === 30);
  let trazas = 0, nCands = 0, nHueco = 0, fixIg = 0, conFixes = 0, f1 = 0, f1Ig = 0, porRutaN = 0, porGoogleN = 0, topados = 0;
  let resp = 0, respIg = 0, transitorios = 0, permanentes = 0, headSi = 0, headNo = 0, dib = 0, dibIg = 0, dibujados = 0;
  let claves = 0, clavesIg = 0;
  for (let i = 0; i < 1000; i++) {
    const ruta = rutaAlAzar();
    const { limpio, crudos } = H.huellaDeFilas(trazaSobreRuta(ruta));
    trazas++;
    // El modal saca las corridas crudas del Map Matching; aquí se fingen sobre la huella limpia.
    const matched: [number, number][] = limpio.map((p) => [p.lng, p.lat]);
    const matchedRef = { current: rnd() < 0.1 ? null : matched };
    const cruditos: any[] = [];
    for (let k = Math.floor(rnd() * 4); k > 0 && matched.length > 20; k--) {
      const iA = Math.floor(rnd() * (matched.length - 16)), iB = iA + 2 + Math.floor(rnd() * 14);
      const A = matched[iA], B = matched[iB], dRecta = distM(A[1], A[0], B[1], B[0]);
      if (dRecta >= 40) cruditos.push({ aLat: A[1], aLng: A[0], bLat: B[1], bLng: B[0], dt: 0, dRecta, iA, iB, origen: "crudo" });
    }
    // De vez en cuando, más candidatos que MAX_PUENTES (el tope corta igual en las dos).
    const extra = rnd() < 0.05 ? Array.from({ length: 35 }, () => cruditos[0]).filter(Boolean) : [];
    const candidatos = [...cruditos, ...extra, ...H.calcularPuentes(limpio)];
    if (candidatos.length > 30) topados++;
    const u = rnd();
    const rutaRef = { current: (u < 0.6 ? { coordenadas: ruta } : u < 0.7 ? null : u < 0.8 ? { coordenadas: [] } : u < 0.9 ? { coordenadas: correr(ruta, 150) } : { coordenadas: [...ruta].reverse() }) as any };

    // ── COPIA LITERAL del modal (ModalGps.tsx en HEAD 6924a54, antes de T2), líneas 630 y 637-667 ──
    const MAX_PUENTES = 30;
    const fixesDelTramo = (c: any): { lat: number; lng: number }[] => {
      if (c.origen === "crudo") {
        const m = matchedRef.current || [];
        return m.slice(c.iA + 1, c.iB).map(([lng, lat]: [number, number]) => ({ lat, lng }));
      }
      const tA = limpio[c.iA]?.ts ?? 0, tB = limpio[c.iB]?.ts ?? 0;
      if (!(tB > tA)) return [];
      return crudos.filter((x) => x.ts > tA && x.ts < tB).map((x) => ({ lat: x.lat, lng: x.lng }));
    };
    const cands = candidatos.slice(0, MAX_PUENTES);
    const slots: any[] = new Array(cands.length).fill(null);
    const fixesCand: { lat: number; lng: number }[][] = cands.map(fixesDelTramo);   // evidencia real por candidato
    const porGoogle: number[] = [];
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci];
      const A = { lat: c.aLat, lng: c.aLng }, B = { lat: c.bLat, lng: c.bLng };
      const porRuta = H.puentePorRuta(A, B, rutaRef.current?.coordenadas || []);
      if (porRuta && porRuta.length >= 2 && H.validarPuente(porRuta, A, B, fixesCand[ci], c.dt, c.dRecta)) {
        let mts = 0;
        for (let k = 1; k < porRuta.length; k++) mts += distM(porRuta[k - 1][1], porRuta[k - 1][0], porRuta[k][1], porRuta[k][0]);
        slots[ci] = { type: "Feature", geometry: { type: "LineString", coordinates: porRuta }, properties: { nivel: "puente", km: Math.round(mts / 100) / 10, min: Math.round(c.dt / 60) } };
      } else porGoogle.push(ci);
    }

    // ── lo extraído ──
    const cands2 = candidatos.slice(0, H.MAX_PUENTES);
    const fixes2 = cands2.map((c: any) => (c.origen === "crudo" ? fixesDelTramo(c) : H.fixesDelHueco(limpio, crudos, c)));
    for (let ci = 0; ci < cands.length; ci++) {
      if (cands[ci].origen === "crudo") continue;
      nHueco++;
      if (JSON.stringify(fixes2[ci]) === JSON.stringify(fixesCand[ci])) fixIg++;
      if (fixesCand[ci].length > 0) conFixes++;
    }
    nCands += cands.length;
    const fase1 = H.puentesPorRutaPrevista(cands2, fixes2, rutaRef.current?.coordenadas);
    f1++;
    if (JSON.stringify(fase1.slots.map((p) => (p ? H.featureDePuente(p) : null))) === JSON.stringify(slots)
      && JSON.stringify(fase1.porGoogle) === JSON.stringify(porGoogle)) f1Ig++;
    porRutaN += slots.filter(Boolean).length;
    porGoogleN += porGoogle.length;

    // FASE 2: la respuesta de /api/ruta-puente → la entrada de caché del modal → el dibujo.
    for (const ci of porGoogle) {
      const c = cands[ci];
      const j = respuestaAlAzar(c, ruta);
      // ── COPIA LITERAL del modal (ModalGps.tsx en HEAD 6924a54, antes de T2), líneas 686-706 ──
      let rr: any;
      if (j?.ocultar || j?.status !== "OK") {
        rr = { nivel: "ocultar", coords: [], km: 0, dt: c.dt };
        if (!["ZERO_RESULTS", "NOT_FOUND", "SIN_GEOMETRIA"].includes(j?.status)) rr.expira = Date.now() + 60000;
      } else {
        const nivel = H.decidirPuente(j.roadM, c.dRecta);
        const gc: [number, number][] = (j.coords || []) as [number, number][];
        const headOk = gc.length > 0 && distM(c.aLat, c.aLng, gc[0][1], gc[0][0]) <= 25;
        const tailOk = gc.length > 0 && distM(c.bLat, c.bLng, gc[gc.length - 1][1], gc[gc.length - 1][0]) <= 25;
        const coords: [number, number][] = nivel === "puente"
          ? [...(headOk ? [[c.aLng, c.aLat] as [number, number]] : []), ...gc, ...(tailOk ? [[c.bLng, c.bLat] as [number, number]] : [])]
          : [];
        rr = { nivel, coords, km: (j.roadM || c.dRecta) / 1000, dt: c.dt };
        if (headOk) headSi++; else headNo++;
      }
      const { transitorio, ...nuevo } = H.puenteDeDirections(j, c);
      const { expira, ...viejo } = rr;
      resp++;
      if (JSON.stringify(nuevo) === JSON.stringify(viejo) && (expira !== undefined) === transitorio) respIg++;
      if (rr.nivel === "ocultar" && expira !== undefined) transitorios++;
      if (rr.nivel === "ocultar" && expira === undefined) permanentes++;

      // ── COPIA LITERAL del modal (ModalGps.tsx en HEAD 6924a54, antes de T2), líneas 674 y 715-723 (el dibujo, con la entrada de caché `r`) ──
      const A = { lat: c.aLat, lng: c.aLng }, B = { lat: c.bLat, lng: c.bLng };
      const r = rr;
      let slotViejo: any = null;
      if (r && r.nivel !== "ocultar" && r.coords.length >= 2 && H.validarPuente(r.coords, A, B, fixesCand[ci], c.dt, c.dRecta)) {
        slotViejo = {
          type: "Feature",
          geometry: { type: "LineString", coordinates: r.coords },
          properties: { nivel: r.nivel, km: Math.round(r.km * 10) / 10, min: Math.round(c.dt / 60) },
        };
      }
      const est = H.puenteEstimadoDeDirections(H.puenteDeDirections(j, c), c, fixes2[ci]);
      dib++;
      if (JSON.stringify(est ? H.featureDePuente(est) : null) === JSON.stringify(slotViejo)) dibIg++;
      if (slotViejo) dibujados++;
    }

    // clavePuente: quien ESCRIBE (/api/ruta-puente, con el cuerpo que manda el modal por JSON) y
    // quien LEE (con los números del candidato) llegan a la MISMA clave.
    for (const c of cands as any[]) {
      const body = JSON.parse(JSON.stringify({ aLat: c.aLat, aLng: c.aLng, bLat: c.bLat, bLng: c.bLng }));
      const aLat = Number(body?.aLat), aLng = Number(body?.aLng);
      const bLat = Number(body?.bLat), bLng = Number(body?.bLng);
      // ── COPIA LITERAL de la clave que armaba app/api/ruta-puente/route.ts:46 ──
      const escrita = `puente:${aLat.toFixed(5)},${aLng.toFixed(5)}>${bLat.toFixed(5)},${bLng.toFixed(5)}`;
      claves++;
      if (escrita === RF.clavePuente(c.aLat, c.aLng, c.bLat, c.bLng) && escrita === RF.clavePuente(aLat, aLng, bLat, bLng)) clavesIg++;
    }
  }
  chk(`fixesDelHueco = la rama «hueco» del modal (${nHueco} candidatos)`, fixIg === nHueco, `${nHueco - fixIg}`);
  chk("hay huecos con evidencia de torre dentro (validarPuente juzga de verdad)", conFixes > 50, `${conFixes}`);
  chk(`fase 1: mismos slots y mismo porGoogle que el modal (${f1} trazas, ${nCands} candidatos)`, f1Ig === f1, `${f1 - f1Ig}`);
  chk("el barrido rellena por la ruta prevista Y manda a Google (no es trivial)", porRutaN > 300 && porGoogleN > 300, `ruta ${porRutaN} · google ${porGoogleN}`);
  chk("hay trazas con más candidatos que MAX_PUENTES", topados > 10, `${topados}`);
  chk(`puenteDeDirections = la entrada de caché del modal (${resp} respuestas; expira ⟺ transitorio)`, respIg === resp, `${resp - respIg}`);
  chk("hay ocultar transitorios y permanentes, y empalmes A sí y no", transitorios > 50 && permanentes > 50 && headSi > 50 && headNo > 50,
    `${transitorios} · ${permanentes} · ${headSi} · ${headNo}`);
  chk(`el dibujo de la fase 2 = el del modal (${dib})`, dibIg === dib && dibujados > 100, `${dib - dibIg} · dibujados ${dibujados}`);
  chk(`clavePuente: quien escribe y quien lee, la misma clave (${claves})`, clavesIg === claves && claves > 1000, `${claves - clavesIg}`);
  // Bordes del redondeo y del JSON: -0, decimales en el borde de 5 cifras, flotantes feos.
  const bordes = [0, -0, 1e-9, -1e-9, -12.000005, -12.0000049999, -77.123455, 0.1 + 0.2, -12.04640000000001, 179.999999, -89.9999951];
  let bordesIg = 0, bordesN = 0;
  for (const a of bordes) for (const b of bordes) {
    bordesN++;
    const body = JSON.parse(JSON.stringify({ aLat: a, aLng: b, bLat: b, bLng: a }));
    const aLat = Number(body?.aLat), aLng = Number(body?.aLng), bLat = Number(body?.bLat), bLng = Number(body?.bLng);
    if (`puente:${aLat.toFixed(5)},${aLng.toFixed(5)}>${bLat.toFixed(5)},${bLng.toFixed(5)}` === RF.clavePuente(a, b, b, a)) bordesIg++;
  }
  chk(`clavePuente en los bordes del redondeo y del JSON (${bordesN})`, bordesIg === bordesN, `${bordesN - bordesIg}`);
  const srcPuente = leer("app/api/ruta-puente/route.ts");
  chk("/api/ruta-puente escribe con clavePuente (sin una segunda plantilla) y lo cacheado vuelve tal cual",
    srcPuente.includes("const clave = clavePuente(aLat, aLng, bLat, bLng);") && !srcPuente.includes("`puente:${")
    && srcPuente.includes("if (cacheado) return NextResponse.json(cacheado);") && srcPuente.includes("await guardarRutaCache(clave, payload);")
    && srcPuente.includes('const payload = { coords: coordsFinal, roadM: rutasM[0] || 0, rutasM, status: "OK" };'));
  chk("lib/rutas-cache re-exporta la MISMA clavePuente", RC.clavePuente === RF.clavePuente);
  // Una respuesta de rutas_cache (status OK) se convierte igual que la de la red, sin reloj.
  const cOk = { aLat: -12.05, aLng: -77.03, bLat: -12.04, bLng: -77.03, dt: 60, dRecta: distM(-12.05, -77.03, -12.04, -77.03) };
  const pOk = H.puenteDeDirections({ coords: linea(cOk, 10), roadM: 1200, rutasM: [1200], status: "OK" }, cOk);
  // Los extremos de la vía caen justo en A y B (≤ 25 m), así que se empalman: 1 + 11 + 1 vértices.
  chk("una entrada de rutas_cache: nivel puente, km de la vía, nunca transitoria, con su empalme",
    pOk.nivel === "puente" && pOk.km === 1.2 && !pOk.transitorio && pOk.coords.length === 13, JSON.stringify({ ...pOk, coords: pOk.coords.length }));
}

// ══ 8 · la ruta prevista en rutas_cache ═══════════════════════════════════════════════════
seccion("8 · la clave de la ruta prevista (paradasParaFirma ↔ /api/ruta) y leerRutasCache");
{
  // ── COPIA LITERAL del modal (ModalGps.tsx en HEAD 6924a54, antes de T2): líneas 303-355 (cargarRuta) + 220-251 (geocodificarParadas, con la
  //    respuesta de /api/geocodificar cuando Google no encuentra ninguna) + 383-390 (el cuerpo) y de
  //    app/api/ruta/route.ts 58-81 (cómo lo lee el servidor). Cada `fallo(...); return;` devuelve su
  //    motivo en vez de pintar el error. ──
  function firmaDelModalViejo(paradas: any[], paradasJson: any[] | null | undefined, origen: string | null, destino: string | null): { firma: string | null; motivo: string | null; sinCoords: number } {
    let listaParadas = [...paradas].sort((a, b) => a.orden - b.orden);
    if (paradasJson && paradasJson.length > 0) {
      const byNombre = new Map<string, { lat: number; lng: number }>();
      paradasJson.forEach((p: any) => {
        if (p.lat && p.lng) byNombre.set(String(p.nombre || "").trim().toLowerCase(), { lat: Number(p.lat), lng: Number(p.lng) });
      });
      if (listaParadas.length > 0) {
        listaParadas = listaParadas.map(p => {
          if (!p.lat || !p.lng) {
            const coords = byNombre.get(String(p.nombre || "").trim().toLowerCase());
            if (coords) return { ...p, lat: coords.lat, lng: coords.lng };
          }
          return p;
        });
      } else {
        listaParadas = (paradasJson as any[])
          .filter((p: any) => p.nombre)
          .map((p: any, i: number) => ({
            id: -(i + 1), nombre: p.nombre,
            lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
            hora_estimada: p.hora || null, estado: "pendiente", orden: i + 1,
          }));
      }
    }
    if (listaParadas.length === 0) {
      if (origen && destino) {
        listaParadas = [
          { id: -1, nombre: origen,  lat: null, lng: null, hora_estimada: null, estado: "pendiente", orden: 1 },
          { id: -2, nombre: destino, lat: null, lng: null, hora_estimada: null, estado: "pendiente", orden: 2 },
        ];
      } else {
        return { firma: null, motivo: "sin_paradas", sinCoords: 0 };
      }
    }
    const sinCoords = listaParadas.filter(p => !p.lat || !p.lng);
    if (sinCoords.length > 0) {
      // geocodificarParadas: /api/geocodificar devuelve { ...p, lat: null, lng: null } a cada una.
      const data = JSON.parse(JSON.stringify({ paradas: sinCoords.map(p => ({ id: p.id, nombre: p.nombre, lat: null, lng: null })) }));
      const coordsMap = new Map<number, { lat: number | null; lng: number | null }>(
        data.paradas.map((p: any) => [p.id, { lat: p.lat, lng: p.lng }])
      );
      listaParadas = listaParadas.map(p => {
        const coords = coordsMap.get(p.id);
        return coords ? { ...p, lat: coords.lat, lng: coords.lng } : p;
      });
    }
    const paradasConCoords = listaParadas.filter(p => p.lat !== null && p.lng !== null);
    if (paradasConCoords.length < 2) return { firma: null, motivo: "menos_de_dos", sinCoords: sinCoords.length };
    const orig = paradasConCoords[0];
    const dest = paradasConCoords[paradasConCoords.length - 1];
    if (orig.lat === dest.lat && orig.lng === dest.lng) return { firma: null, motivo: "mismo_punto", sinCoords: sinCoords.length };
    const cuerpo = JSON.stringify({
      paradas: paradasConCoords.map(p => ({
        lat:    typeof p.lat === "string" ? parseFloat(p.lat as any) : p.lat,
        lng:    typeof p.lng === "string" ? parseFloat(p.lng as any) : p.lng,
        nombre: p.nombre,
      })),
    });
    // ── /api/ruta ──
    const body = JSON.parse(cuerpo);
    const paradasRaw = body?.paradas;
    if (!paradasRaw || !Array.isArray(paradasRaw) || paradasRaw.length < 2) return { firma: null, motivo: "menos_de_dos", sinCoords: sinCoords.length };
    const paradasS = paradasRaw.map((p: any) => ({
      nombre: p.nombre || "Parada",
      lat:    typeof p.lat === "string" ? parseFloat(p.lat) : Number(p.lat),
      lng:    typeof p.lng === "string" ? parseFloat(p.lng) : Number(p.lng),
    }));
    const invalidas = paradasS.filter((p: any) => isNaN(p.lat) || isNaN(p.lng));
    if (invalidas.length > 0) return { firma: null, motivo: "coordenada_invalida", sinCoords: sinCoords.length };
    return { firma: RF.firmaRuta(paradasS), motivo: null, sinCoords: sinCoords.length };
  }

  const NOMBRES = ["Puente Santa Anita", "BSF Punta Hermosa", "Óvalo Monitor", "Plaza Norte", "Paradero 1", "Grifo Repsol"];
  const variante = (n: string) => [n, n.toUpperCase(), `  ${n.toLowerCase()} `, `${n} (ref)`][Math.floor(rnd() * 4)];
  const coordRara = (base: number): any => {
    const u = rnd();
    if (u < 0.30) return String((base + (rnd() - 0.5) * 0.08).toFixed(4 + Math.floor(rnd() * 6)));
    if (u < 0.50) return null;
    if (u < 0.60) return 0;
    if (u < 0.67) return "";
    if (u < 0.74) return undefined;
    if (u < 0.81) return "abc";
    if (u < 0.88) return "0";
    if (u < 0.94) return "  ";
    return NaN;
  };
  const coord = (base: number, rara: boolean) => (rara ? coordRara(base) : base + (rnd() - 0.5) * 0.08);
  function paradasAlAzar(): any[] {
    const n = Math.floor(rnd() * 8);
    const out: any[] = [];
    for (let k = 0; k < n; k++) {
      const rara = rnd() < 0.15;
      out.push({
        id: 1000 + k * 7 + Math.floor(rnd() * 3), nombre: rnd() < 0.05 ? "" : variante(NOMBRES[Math.floor(rnd() * NOMBRES.length)]),
        lat: coord(-12.05, rara), lng: coord(-77.03, rara && rnd() < 0.7),
        hora_estimada: null, estado: rnd() < 0.3 ? "completada" : "pendiente",
        orden: rnd() < 0.05 ? null : 1 + Math.floor(rnd() * 5),        // empates de orden a propósito
      });
    }
    if (out.length >= 2 && rnd() < 0.08) { const z = out[out.length - 1]; z.lat = out[0].lat; z.lng = out[0].lng; z.orden = 99; out[0].orden = -1; }
    for (let k = out.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [out[k], out[j]] = [out[j], out[k]]; }
    return out;
  }
  function paradasJsonAlAzar(): any[] | null | undefined {
    const u = rnd();
    if (u < 0.35) return u < 0.15 ? null : u < 0.25 ? undefined : [];
    return Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => {
      const rara = rnd() < 0.2;
      return { nombre: rnd() < 0.08 ? "" : variante(NOMBRES[Math.floor(rnd() * NOMBRES.length)]), lat: coord(-12.05, rara), lng: coord(-77.03, rara), hora: rnd() < 0.5 ? "06:30" : null };
    });
  }

  let casos = 0, iguales = 0, garantizadas = 0, conFaltantes = 0, motivos: Record<string, number> = {}, desdeJson = 0, rellenas = 0, empates = 0;
  for (let i = 0; i < 4000; i++) {
    const paradas = paradasAlAzar();
    const pj = paradasJsonAlAzar();
    const o = rnd() < 0.5 ? variante("Origen") : null, d = rnd() < 0.5 ? "Destino" : null;
    const viejo = firmaDelModalViejo(paradas, pj, o, d);
    const nuevo = RF.paradasParaFirma(paradas, pj, { origen: o, destino: d });
    casos++;
    const mismo = viejo.firma !== null
      ? nuevo.sinRuta === null && RF.firmaRuta(nuevo.lista) === viejo.firma
      : nuevo.sinRuta === viejo.motivo && nuevo.lista.length === 0;
    if (mismo && nuevo.sinCoordenadas === viejo.sinCoords) iguales++;
    else if (casos - iguales < 4) console.log("   ", JSON.stringify({ paradas, pj, o, d, viejo, nuevo }).slice(0, 600));
    if (viejo.firma !== null && viejo.sinCoords === 0) garantizadas++;
    if (viejo.firma !== null && viejo.sinCoords > 0) conFaltantes++;
    motivos[viejo.motivo ?? "firma"] = (motivos[viejo.motivo ?? "firma"] ?? 0) + 1;
    if (!paradas.length && pj?.length) desdeJson++;
    if (paradas.some((p) => (!p.lat || !p.lng)) && pj?.length && paradas.length) rellenas++;
    const ord = paradas.map((p) => p.orden);
    if (ord.length !== new Set(ord).size) empates++;
  }
  chk(`firmaRuta(paradasParaFirma(…).lista) = la clave con que /api/ruta guarda lo que pide el modal (${casos} casos)`, iguales === casos, `${casos - iguales}`);
  chk("barrido no trivial: claves garantizadas, con faltantes, desde paradas_json, rellenos y empates de orden",
    garantizadas > 800 && conFaltantes > 100 && desdeJson > 100 && rellenas > 100 && empates > 500,
    JSON.stringify({ garantizadas, conFaltantes, desdeJson, rellenas, empates }));
  chk("los motivos sin ruta aparecen todos menos el inalcanzable", ["sin_paradas", "menos_de_dos", "mismo_punto"].every((m) => (motivos[m] ?? 0) > 20), JSON.stringify(motivos));

  // Los cuatro bordes que pide el contrato, uno por uno.
  const p = (id: number, orden: number | null, lat: any, lng: any, nombre = `P${id}`) => ({ id, orden, nombre, lat, lng, estado: "pendiente", hora_estimada: null });
  const A1 = p(1, 1, -12.0464, -77.0428), B2 = p(2, 2, -12.05, -77.03), C2 = p(3, 2, -12.06, -77.02), D3 = p(4, 3, -12.07, -77.01);
  const f1 = RF.firmaRuta(RF.paradasParaFirma([A1, B2, C2, D3]).lista), f2 = RF.firmaRuta(RF.paradasParaFirma([A1, C2, B2, D3]).lista);
  chk("empate de `orden`: decide el orden de entrada (y el modal hace lo mismo)",
    f1 !== f2 && f1 === firmaDelModalViejo([A1, B2, C2, D3], null, null, null).firma && f2 === firmaDelModalViejo([A1, C2, B2, D3], null, null, null).firma);
  chk("coordenadas como texto: misma clave que como número",
    RF.firmaRuta(RF.paradasParaFirma([p(1, 1, "-12.0464", "-77.0428"), p(2, 2, "-12.05", " -77.03")]).lista)
    === RF.firmaRuta(RF.paradasParaFirma([p(1, 1, -12.0464, -77.0428), p(2, 2, -12.05, -77.03)]).lista));
  const relleno = RF.paradasParaFirma([p(1, 1, null, null, "Óvalo Monitor"), B2], [{ nombre: "  óvalo monitor ", lat: "-12.0811", lng: -77.0122 }]);
  chk("relleno desde paradas_json por nombre (minúsculas y espacios)", relleno.sinRuta === null && relleno.sinCoordenadas === 0 && relleno.lista[0].lat === -12.0811);
  const cero = RF.paradasParaFirma([p(1, 1, 0, -77.04), B2, D3]);
  chk("coordenada 0 = faltante: se cuenta y queda fuera de la lista", cero.sinCoordenadas === 1 && cero.lista.length === 2 && cero.sinRuta === null);
  chk("sin nada: sin_paradas; solo origen/destino: dos por geocodificar",
    RF.paradasParaFirma([]).sinRuta === "sin_paradas" && RF.paradasParaFirma(null, null, { origen: "A", destino: "B" }).sinCoordenadas === 2);
  const srcRuta = leer("app/api/ruta/route.ts");
  chk("/api/ruta sigue leyendo las coordenadas y firmando como la copia literal",
    srcRuta.includes('lat:    typeof p.lat === "string" ? parseFloat(p.lat) : Number(p.lat),')
    && srcRuta.includes('lng:    typeof p.lng === "string" ? parseFloat(p.lng) : Number(p.lng),')
    && srcRuta.includes("const firma = firmaRuta(paradas);") && srcRuta.includes("await leerRutaCache(firma)")
    && srcRuta.includes("await guardarRutaCache(firma, payload)"));

  // ── leerRutasCache: un cliente falso que registra cada consulta ──
  function clienteFalso(filas: any[], error: any = null) {
    const llamadas: { tabla: string; cols?: string; col?: string; valores?: string[] }[] = [];
    return {
      llamadas,
      from(tabla: string) {
        const q: any = { tabla };
        llamadas.push(q);
        return {
          select(cols: string) {
            q.cols = cols;
            return {
              in(col: string, valores: string[]) {
                q.col = col; q.valores = valores;
                return Promise.resolve(error ? { data: null, error } : { data: filas.filter((f) => valores.includes(f.clave)), error: null });
              },
            };
          },
        };
      },
    };
  }
  const ahora = Date.now(), DIA = 86_400_000;
  const paradas30 = Array.from({ length: 30 }, (_, k) => ({ lat: -12.05 - k * 0.001234, lng: -77.03 + k * 0.000987 }));
  const firma30 = RF.firmaRuta(paradas30);
  const puentes30 = Array.from({ length: 30 }, (_, k) => RF.clavePuente(-12.05 + k / 997, -77.03 - k / 991, -12.04 + k / 983, -77.02 - k / 977));
  const filas = [
    { clave: firma30, payload: { coordenadas: [[-77.03, -12.05]] }, creado_at: new Date(ahora - DIA).toISOString() },
    { clave: puentes30[0], payload: { coords: [], status: "OK" }, creado_at: new Date(ahora - 31 * DIA).toISOString() },
    { clave: puentes30[1], payload: { coords: [[1, 2]], status: "OK" }, creado_at: "no-es-fecha" },
    { clave: puentes30[2], payload: { coords: [[3, 4]], status: "OK" }, creado_at: null },
    { clave: puentes30[3], payload: { coords: [[5, 6]], status: "OK" }, creado_at: new Date(ahora - 2 * 3_600_000).toISOString() },
    { clave: "otra", payload: 1, creado_at: new Date(ahora).toISOString() },
  ];
  const cf = clienteFalso(filas);
  const mapa = await RC.leerRutasCache([firma30, ...puentes30, firma30, ""], undefined, cf);
  chk("una ruta de 30 paradas + 30 puentes: UNA sola consulta `.in` a rutas_cache, sin repetidas ni vacías",
    cf.llamadas.length === 1 && cf.llamadas[0].tabla === "rutas_cache" && cf.llamadas[0].cols === "clave, payload, creado_at"
    && cf.llamadas[0].col === "clave" && cf.llamadas[0].valores!.length === 31);
  chk("misma vigencia que leerRutaCache: 1 día sí, 31 no, fecha basura sí, null no, 2 h sí",
    mapa.has(firma30) && !mapa.has(puentes30[0]) && mapa.has(puentes30[1]) && !mapa.has(puentes30[2]) && mapa.has(puentes30[3]) && !mapa.has("otra") && mapa.size === 3);
  chk("mismo valor que leerRutaCache: el payload tal cual (la misma referencia)", mapa.get(firma30) === filas[0].payload);
  const corto = await RC.leerRutasCache([puentes30[3]], 3_600_000, clienteFalso(filas));
  chk("ttl más corto: la de hace 2 h ya no vale con 1 h", corto.size === 0);
  const vacio = clienteFalso(filas);
  chk("sin claves: no consulta", (await RC.leerRutasCache([], undefined, vacio)).size === 0 && (await RC.leerRutasCache(["", ""], undefined, vacio)).size === 0 && vacio.llamadas.length === 0);
  let lanzo = "";
  try { await RC.leerRutasCache([firma30], undefined, clienteFalso([], { message: "relation \"rutas_cache\" does not exist" })); } catch (e: any) { lanzo = e.message; }
  chk("ante un error de la consulta LANZA (no devuelve «no hay nada»)", lanzo.includes("No se pudo leer rutas_cache") && lanzo.includes("does not exist"), lanzo);
  let lanzoSin = false;
  try { await RC.leerRutasCache([firma30], undefined, null); } catch { lanzoSin = true; }
  chk("sin cliente (falta la service-role) también LANZA", lanzoSin);
  // entradaVigente es la condición de leerRutaCache, copiada literal: `Date.now() - new Date(c).getTime() > ttl` → vencida.
  let vig = 0, vigIg = 0;
  for (const c of [null, undefined, "", "x", new Date(ahora).toISOString(), new Date(ahora - 29 * DIA).toISOString(), new Date(ahora - 30 * DIA).toISOString(), new Date(ahora - 30 * DIA - 1).toISOString(), new Date(ahora + DIA).toISOString(), "2026-10-01", "2026-10-01T05:00:00-05:00"]) {
    for (const ttl of [RC.TTL_MS, 3_600_000, 0]) {
      vig++;
      const vencida = ahora - new Date(c as any).getTime() > ttl;
      if (RC.entradaVigente(c as any, ttl, ahora) === !vencida) vigIg++;
    }
  }
  chk(`entradaVigente = la condición de leerRutaCache (${vig})`, vigIg === vig, `${vig - vigIg}`);
  chk("leerRutaCache usa la misma entradaVigente", leer("lib/rutas-cache.ts").includes("if (!entradaVigente(data.creado_at, ttlMs, Date.now())) return null;"));
  // Partición por largo de URL: no pierde, no repite, conserva el orden y respeta el tope.
  let lotesBien = true;
  for (let i = 0; i < 300; i++) {
    const cl = Array.from({ length: Math.floor(rnd() * 400) }, (_, k) => `k${k}:` + "x".repeat(Math.floor(rnd() * 900)) + ",|>");
    const tope = 500 + Math.floor(rnd() * 6000);
    const lotes = RC.lotesDeClaves(cl, tope);
    const largo = (l: string[]) => l.reduce((a, c) => a + encodeURIComponent(`"${c}",`).length, 0);
    if (JSON.stringify(lotes.flat()) !== JSON.stringify(cl) || lotes.some((l) => l.length === 0 || (l.length > 1 && largo(l) > tope))) { lotesBien = false; break; }
  }
  chk("lotesDeClaves: ni pierde ni repite, en orden, y cada lote cabe", lotesBien);
  chk("lo que lee el recorrido (1 ruta + 30 puentes) es UN lote", RC.lotesDeClaves([firma30, ...puentes30]).length === 1);
}

// ══ 10 · hechosDeParadas ══════════════════════════════════════════════════════════════════
seccion("10 · hechosDeParadas = las líneas de derivarTiempos (copiadas literal)");
{
  // ── COPIA LITERAL de lib/servicio-tiempos.ts: constantes, tsIso, limaMs, ventanaDelDia, dentro,
  //    normalizarParadas y las líneas 654, 661-662 y 677-697 de derivarTiempos ANTES de extraerlas ──
  const FUTURO_TOLERANCIA_MS = 6 * 3_600_000;
  const VENTANA_ANTES_MS  = 6 * 3_600_000;
  const VENTANA_DESPUES_MS = 50 * 3_600_000;
  function limaMs(fecha: string | null | undefined, hora: string | null | undefined): number | null {
    if (!fecha) return null;
    const h = hora ? String(hora).slice(0, 8).padEnd(8, ":00").slice(0, 8) : "00:00:00";
    const t = Date.parse(`${fecha}T${h}-05:00`);
    return Number.isFinite(t) ? t : null;
  }
  function tsIso(v: string | null | undefined): number | null {
    if (!v) return null;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
  }
  type Ventana = { min: number; max: number };
  function ventanaDelDia(fecha: string | null | undefined, ahoraMs: number): Ventana {
    const medianoche = limaMs(fecha, "00:00:00");
    const techoFuturo = ahoraMs + FUTURO_TOLERANCIA_MS;
    if (medianoche === null) return { min: -Infinity, max: techoFuturo };
    return {
      min: medianoche - VENTANA_ANTES_MS,
      max: Math.min(medianoche + VENTANA_DESPUES_MS, techoFuturo),
    };
  }
  const dentro = (ts: number | null, v: Ventana): boolean =>
    ts !== null && Number.isFinite(ts) && ts >= v.min && ts <= v.max;
  function normalizarParadas(paradas: any[] | null | undefined, v: Ventana): any[] {
    return (paradas || [])
      .filter((p: any) => !!p && p.id != null)
      .map((p: any, i: number) => {
        const ts = tsIso(p.hora_llegada);
        return {
          ...p,
          ordenN: Number.isFinite(Number(p.orden)) ? Number(p.orden) : i + 1,
          completada: p.estado === "completada",
          llegadaTs: dentro(ts, v) ? ts : null,
        };
      })
      .sort((a: any, b: any) => a.ordenN - b.ordenN || Number(a.id) - Number(b.id));
  }
  function hechosViejo(e: any) {
    const r = e.reserva || {};
    const ahoraMs = Number.isFinite(e.ahoraMs) ? e.ahoraMs : Date.now();
    const v = ventanaDelDia(r.fecha_servicio, ahoraMs);
    const paradas = normalizarParadas(e.paradas, v);
    const idsParada = new Set(paradas.map((p: any) => Number(p.id)));
    const abordajesConHora = (e.abordajes || [])
      .filter((a: any) => !!a)
      .map((a: any) => ({ paradaId: a.parada_id == null ? null : Number(a.parada_id), ts: tsIso(a.hora_abordaje) }))
      .filter((a: any): a is { paradaId: number | null; ts: number } => dentro(a.ts, v));
    const abordajesFuera = (e.abordajes || [])
      .filter((a: any) => !!a && tsIso(a.hora_abordaje) !== null).length - abordajesConHora.length;
    const abordajesTs = abordajesConHora
      .filter((a: any) => a.paradaId !== null && idsParada.has(a.paradaId))
      .map((a: any) => a.ts)
      .sort((x: number, y: number) => x - y);
    const abordajesEvidencia = abordajesConHora.length + abordajesFuera;
    return { paradas, abordajesTs, abordajesEvidencia };
  }

  const FECHAS = ["2026-10-09", "2026-10-10", "2026-10-11", null, "", "2026-13-40", undefined];
  const BASE = Date.UTC(2026, 9, 10, 5, 0, 0);   // 10-10-2026 00:00 Lima
  const horaAlAzar = (): any => {
    const u = rnd();
    if (u < 0.1) return null;
    if (u < 0.15) return "x";
    if (u < 0.2) return "";
    return new Date(BASE + (rnd() * 6 - 3) * 86_400_000).toISOString();   // de 3 días antes a 3 después
  };
  let n = 0, iguales = 0, conTs = 0, fueraVentana = 0, ajenos = 0;
  for (let i = 0; i < 4000; i++) {
    const nP = Math.floor(rnd() * 7);
    const paradas: any[] = Array.from({ length: nP }, (_, k) => ({
      id: rnd() < 0.05 ? null : rnd() < 0.1 ? String(200 + k) : 200 + k,
      orden: [1, 2, 3, 3, null, "2", "x", undefined][Math.floor(rnd() * 8)],
      nombre: `P${k}`, estado: rnd() < 0.6 ? "completada" : "pendiente",
      hora_estimada: "06:30", hora_llegada: horaAlAzar(),
    }));
    if (rnd() < 0.05) paradas.push(null);
    const abordajes: any[] = Array.from({ length: Math.floor(rnd() * 8) }, () => ({
      parada_id: [200, 201, 202, "203", 9999, null, undefined][Math.floor(rnd() * 7)],
      pasajero_id: 1, hora_abordaje: horaAlAzar(),
    }));
    if (rnd() < 0.05) abordajes.push(null);
    const e = {
      reserva: rnd() < 0.03 ? undefined : { fecha_servicio: FECHAS[Math.floor(rnd() * FECHAS.length)], estado: "finalizada" },
      paradas: rnd() < 0.05 ? null : paradas, abordajes: rnd() < 0.05 ? undefined : abordajes,
      ahoraMs: BASE + (rnd() * 4 - 1) * 86_400_000, hoy: rnd() < 0.5 ? "2026-10-10" : null,
    } as any;
    n++;
    const nuevo = ST.hechosDeParadas(e);
    if (JSON.stringify(nuevo) === JSON.stringify(hechosViejo(e))) iguales++;
    if (nuevo.abordajesTs.length) conTs++;
    if (nuevo.paradas.some((q) => q.completada && q.hora_llegada && q.llegadaTs === null)) fueraVentana++;
    if (nuevo.abordajesEvidencia > nuevo.abordajesTs.length) ajenos++;
  }
  chk(`hechosDeParadas = las líneas de derivarTiempos (${n} entradas)`, iguales === n, `${n - iguales}`);
  chk("barrido no trivial: abordajes que valen, llegadas fuera de la ventana y abordajes ajenos", conTs > 500 && fueraVentana > 500 && ajenos > 500,
    `${conTs} · ${fueraVentana} · ${ajenos}`);
  chk("`hoy` no cambia nada", (() => {
    const e = { reserva: { fecha_servicio: "2026-10-10" }, paradas: [{ id: 1, orden: 1, estado: "completada", hora_llegada: new Date(BASE + 6 * 3_600_000).toISOString() }], abordajes: [{ parada_id: 1, hora_abordaje: new Date(BASE + 6 * 3_600_000).toISOString() }], ahoraMs: BASE + 86_400_000 } as any;
    return JSON.stringify(ST.hechosDeParadas({ ...e, hoy: "2026-01-01" })) === JSON.stringify(ST.hechosDeParadas({ ...e, hoy: null }));
  })());
  const srcT = leer("lib/servicio-tiempos.ts");
  chk("derivarTiempos llama a hechosDeParadas y la regla de los abordajes vive UNA sola vez",
    srcT.includes("} = hechosDeParadas({") && srcT.split("const abordajesConHora =").length === 2 && srcT.split("const idsParada =").length === 2);
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// 9, 11 y 12 · EL RECORRIDO ARMADO (T3): el modal sin llamadas pagadas
// ═════════════════════════════════════════════════════════════════════════════════════════
const RD = await import("../lib/flota/recorrido-datos");
const GD = await import("../lib/gps-cobertura-datos");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN_MS = 60_000;

/** Un cliente falso de ubicaciones_gps: lo mínimo que usa `leerTraza` (las filas ya vienen en orden). */
const clienteTraza = (filas: Fila[]): any => ({
  from: () => ({
    select: () => {
      const q: any = { eq: () => q, order: () => q, range: (a: number, b: number) => Promise.resolve({ data: filas.slice(a, b + 1), error: null }) };
      return q;
    },
  }),
});
const lectorDe = (filas: Fila[]) => (id: number, op?: any) => GD.leerTraza(clienteTraza(filas), id, op);
const HOY = "2026-10-13", AHORA = Date.UTC(2026, 9, 13, 17, 0, 0);

/** Paradas de la reserva sobre la propia traza (el conductor marca al pasar), en orden. */
function paradasSobre(filas: Fila[]): any[] {
  // El paradero 1 cae entre el 5 % y el 60 % de la traza (lo de antes es el camino a recoger) y el
  // último cerca del final: así hay excesos antes, durante y después del servicio.
  const n = 2 + Math.floor(rnd() * 4);
  const ini = 0.05 + 0.55 * rnd(), fin = 0.8 + 0.2 * rnd();
  const idx = Array.from({ length: n }, (_, k) => Math.floor((ini + ((fin - ini) * k) / (n - 1)) * (filas.length - 1))).sort((a, b) => a - b);
  return idx.map((k, j) => {
    const f = filas[k];
    const marcada = rnd() < 0.85;
    const sinCoord = rnd() < 0.08;
    return {
      id: 500 + j, reserva_id: 77, orden: j + 1, nombre: `P${j + 1}`,
      lat: sinCoord ? null : Number(f.lat), lng: sinCoord ? null : Number(f.lng),
      estado: marcada ? "completada" : "pendiente", hora_llegada: marcada ? f.created_at : null,
      hora_estimada: rnd() < 0.5 ? "16:30" : null,
    };
  });
}

// ══ 9 · el recorrido armado ═══════════════════════════════════════════════════════════════
seccion("9 · el recorrido: «sin señal» = la celda RASTREO, el medido no lo cruza, estimados solo validados");
{
  /** Una polilínea recta y densa de A a B, en [lng, lat]. */
  const linea = (c: any, n: number): [number, number][] =>
    Array.from({ length: n + 1 }, (_, k) => [c.aLng + (c.bLng - c.aLng) * (k / n), c.aLat + (c.bLat - c.aLat) * (k / n)] as [number, number]);
  /** Un rodeo absurdo (10 veces la recta): validarPuente lo tiene que rechazar. */
  const rodeo = (c: any): [number, number][] => {
    const out: [number, number][] = [];
    for (let k = 0; k <= 40; k++) {
      const f = k / 40, lado = k % 2 ? 1 : -1;
      out.push([c.aLng + (c.bLng - c.aLng) * f + lado * 0.012, c.aLat + (c.bLat - c.aLat) * f]);
    }
    return out;
  };

  let trazas = 0, rastreoIg = 0, conteosIg = 0, tramosIg = 0, bordesBien = 0, medidoBien = 0, cruzan = 0, largos = 0, igualConstructor = 0;
  let conSinSenal = 0, conEstimado = 0, cubiertos = 0, soloExtremos = 0, estValidos = 0, estTotal = 0, malosDibujados = 0, rechazados = 0;
  let fueras = 0, fuerasBien = 0, techoMal = 0;
  let unaConsulta = 0, fallas = 0, fallaSinEstimados = 0, codigos: Record<string, number> = {}, etiquetados = 0, porRuta = 0, porPuente = 0, huecoConLinea = 0;
  const errorOriginal = console.error;
  console.error = () => {};   // las caídas simuladas de rutas_cache y pasajeros_parada se registran: aquí, ruido
  for (let i = 0; i < 400; i++) {
    const ruta = rutaAlAzar();
    // Las filas son de ESTA reserva y llevan su conductor (lo fuerza el servidor con el token).
    const filas: Fila[] = trazaSobreRuta(ruta).map((f) => ({ ...f, reserva_id: 77, conductor_id: 5, conductor_tercero_id: null }));
    const ps = paradasSobre(filas);
    const r = {
      id: 77, estado: "finalizada", fecha_servicio: "2026-10-09", hora_servicio: "16:00", vehiculo_id: 3, conductor_id: 5,
      origen: "Origen", destino: "Destino",
      paradas_json: rnd() < 0.5 ? ps.map((p) => ({ nombre: p.nombre, lat: Number(filas[0].lat), lng: Number(filas[0].lng) })) : null,
    };
    const lector = lectorDe(filas);
    const extremos = { origen: ps[0]?.nombre ?? r.origen, destino: (ps.length > 1 ? ps[ps.length - 1].nombre : null) ?? r.destino };
    const claves = R.clavesRutaPrevista(ps, r.paradas_json, extremos);
    const huella = H.huellaDeFilas(filas);
    const cands = R.candidatosPuente(huella.limpio);

    // rutas_cache: lo que el modal habría guardado (o no), y la consulta que puede fallar.
    const guardado = new Map<string, any>();
    const u = rnd();
    if (claves.variantes.length && u < 0.65) guardado.set(claves.variantes[0].firma, { coordenadas: ruta });
    else if (claves.variantes.length > 1 && u < 0.75) guardado.set(claves.variantes[1].firma, { coordenadas: ruta });
    const malas = new Set<string>();
    for (const c of cands) {
      const k = RF.clavePuente(c.aLat, c.aLng, c.bLat, c.bLng);
      const v = rnd();
      if (v < 0.35) guardado.set(k, { coords: linea(c, 20), roadM: c.dRecta * 1.1, rutasM: [c.dRecta * 1.1], status: "OK" });
      else if (v < 0.5) { guardado.set(k, { coords: rodeo(c), roadM: c.dRecta * 1.5, rutasM: [c.dRecta * 1.5], status: "OK" }); malas.add(k); }
    }
    const falla = rnd() < 0.06;
    let llamadas = 0, pedidas: string[] = [];
    const rutasCache = async (cl: string[]) => {
      llamadas++; pedidas = cl;
      if (falla) throw new Error("rutas_cache caída");
      return new Map(cl.filter((k) => guardado.has(k)).map((k) => [k, guardado.get(k)] as [string, any]));
    };
    const abordajes = async (ids: number[]) => {
      if (rnd() < 0.08) throw new Error("pasajeros_parada caída");
      return ps.filter((p) => ids.includes(p.id) && p.hora_llegada && rnd() < 0.5).map((p) => ({ parada_id: p.id, hora_abordaje: p.hora_llegada }));
    };

    const celda = await GD.medirServicio(r, ps, { hoy: HOY, ahoraMs: AHORA }, lector);   // la celda: sin conHuella
    // Umbral de 60: las trazas van de 18 a 73 km/h, y así hay excesos que etiquetar.
    // Uno de cada ~15 queda fuera del techo diario de la torre (MAX_RESERVAS): su celda dice `sin_medir`.
    const fuera = rnd() < 0.07;
    let techoPedido: any = null;
    const fueraDelTecho = async (x: any) => { techoPedido = x; return fuera; };
    const rec = await RD.armarRecorrido(r, ps, { hoy: HOY, ahoraMs: AHORA, umbral: 60 }, { traza: lector, rutasCache, abordajes, fueraDelTecho });
    trazas++;
    if (techoPedido?.id !== 77 || techoPedido?.fecha_servicio !== "2026-10-09") techoMal++;
    if (fuera) {
      // Fuera del techo: el veredicto ES el de su celda (`sin_medir`), sin medición («no se pudo medir»,
      // nunca 0), y la traza y los excesos se dibujan igual.
      fueras++;
      const sinCorte = R.medidoDeHuella(huella.limpio, []).map(({ ts, ...t }) => t);
      const exc = SE.excesosDelServicio({ reservaId: 77, crudas: filas, aplica: true, trazaLeida: true, rastreo: GD.veredictoFueraDelTecho(AHORA), umbral: 60, vehiculo: "p:3" });
      if (JSON.stringify(rec.rastreo) === JSON.stringify(GD.veredictoFueraDelTecho(AHORA)) && rec.rastreo.codigo === "sin_medir"
        && rec.sinSenal.length === 0 && rec.sinSenalTotal === null && rec.cortesEnMovimiento === null && rec.kmACiegas === null
        && (rec.medidoDecimado || JSON.stringify(rec.medido) === JSON.stringify(sinCorte)) && rec.medido.length > 0
        && JSON.stringify(rec.excesos) === JSON.stringify(exc)) fuerasBien++;
      continue;
    }
    const med = celda.medicion;
    codigos[rec.rutaPrevista.codigo] = (codigos[rec.rutaPrevista.codigo] ?? 0) + 1;

    // A. el veredicto y los conteos son los de la celda
    if (JSON.stringify(rec.rastreo) === JSON.stringify(celda.veredicto)) rastreoIg++;
    // Sin medición (menos de dos posiciones útiles): los conteos en null, nunca 0.
    if (med ? rec.sinSenalTotal === med.tramos.length && rec.cortesEnMovimiento === med.cortes && rec.kmACiegas === med.kmACiegas
      : rec.sinSenalTotal === null && rec.cortesEnMovimiento === null && rec.kmACiegas === null) conteosIg++;
    if (med && med.tramos.length) conSinSenal++;
    // B. los tramos son EXACTAMENTE los de la medición (avanceM en metros enteros)
    if (!med && rec.sinSenal.length === 0) tramosIg++;
    else if (med && rec.sinSenal.length === med.tramos.length && rec.sinSenal.every((t, k) => {
      const m = med.tramos[k];
      return t.tipo === m.tipo && t.desdeTs === m.desdeTs && t.hastaTs === m.hastaTs && t.durS === m.durS
        && t.enMovimiento === m.enMovimiento && t.avanceM === (m.avanceM == null ? null : Math.round(m.avanceM));
    })) tramosIg++;
    // C. los bordes de cada hueco son posiciones de la traza; la cabeza no tiene inicio ni la cola fin
    const pts = celda.traza?.pts ?? [];
    const en = (ts: number) => pts.filter((p) => p.ts === ts).map((p) => `${R.coordR(p.lng, p.lat)}`);
    if (rec.sinSenal.every((t) => (t.tipo === "hueco"
      ? !!t.desde && !!t.hasta && en(t.desdeTs).includes(`${t.desde}`) && en(t.hastaTs).includes(`${t.hasta}`)
      : t.tipo === "cabeza" ? t.desde === null && !!t.hasta : !!t.desde && t.hasta === null))) bordesBien++;
    // D. el medido: ningún segmento de más de 300 m ni que cruce un «sin señal» (mirado con la hora de
    //    cada vértice, que da el constructor), y la respuesta es el constructor sin la hora
    const cons = R.medidoDeHuella(huella.limpio, med?.tramos ?? []);
    const corta = R.cortaPorSinSenal(med?.tramos ?? []);
    if (cons.some((t) => t.ts.some((x, j) => j > 0 && corta({ ts: t.ts[j - 1] }, { ts: x })))) cruzan++;
    if (cons.some((t) => t.ts.some((x, j) => j > 0 && (med?.tramos ?? []).some((m) => Math.max(t.ts[j - 1], m.desdeTs) < Math.min(x, m.hastaTs))))) cruzan++;
    if (!rec.medidoDecimado && rec.medido.some((t) => t.coords.some((c, j) => j > 0 && distM(t.coords[j - 1][1], t.coords[j - 1][0], c[1], c[0]) > MAX_SEG_M))) largos++;
    if (!rec.medidoDecimado && JSON.stringify(rec.medido) === JSON.stringify(cons.map(({ ts, ...t }) => t))) igualConstructor++;
    if (rec.medido.every((t) => t.coords.length >= 2 && t.vel.length === t.coords.length && t.vel.every((v) => Number.isInteger(v)))) medidoBien++;
    // E. ningún hueco tiene línea propia: ningún segmento medido une sus dos bordes
    for (const t of rec.sinSenal) {
      if (!t.desde || !t.hasta) continue;
      if (rec.medido.some((l) => l.coords.some((c, j) => j > 0 && `${l.coords[j - 1]}` === `${t.desde}` && `${c}` === `${t.hasta}`))) huecoConLinea++;
    }
    // F. los estimados: solo los que validarPuente aprobó; ninguno de los guardados «malos»
    const { ruta: rutaUsada } = R.resolverRutaPrevista(claves, falla ? null : new Map([...guardado].filter(([k]) => pedidas.includes(k))));
    const internos = R.estimadosDeHuella(huella, rutaUsada, falla ? null : guardado);
    for (const x of internos) {
      estTotal++;
      const c = x.cand;
      if (H.validarPuente(x.crudas, { lat: c.aLat, lng: c.aLng }, { lat: c.bLat, lng: c.bLng }, x.fixes, c.dt, c.dRecta)) estValidos++;
      if (x.fuente === "puente_guardado" && malas.has(RF.clavePuente(c.aLat, c.aLng, c.bLat, c.bLng))) malosDibujados++;
      if (x.fuente === "ruta_prevista") porRuta++; else porPuente++;
    }
    for (const c of cands) if (malas.has(RF.clavePuente(c.aLat, c.aLng, c.bLat, c.bLng))) rechazados++;
    if (!rec.estimadosDecimados && rec.estimados.length === internos.length) conEstimado += rec.estimados.length ? 1 : 0;
    else if (!rec.estimadosDecimados) estTotal += 1000;   // fuerza el fallo: la respuesta no es el constructor
    // G. cada hueco: o un estimado DIBUJADO lo cubre entero (y lo dice), o solo sus extremos
    for (const t of rec.sinSenal) {
      const cubre = internos.some((x) => x.desdeTs <= t.desdeTs && t.hastaTs <= x.hastaTs);
      if (t.estimado !== cubre) estTotal += 1000;
      if (t.estimado) { cubiertos++; if (!rec.estimados.some((e) => e.sinSenal)) estTotal += 1000; } else soloExtremos++;
    }
    // H. UNA sola consulta a rutas_cache con la ruta y TODOS los puentes candidatos
    const esperadas = [...claves.variantes.map((v) => v.firma), ...cands.map((c) => RF.clavePuente(c.aLat, c.aLng, c.bLat, c.bLng))];
    if ((esperadas.length ? llamadas === 1 : llamadas === 0) && esperadas.every((k) => pedidas.includes(k))) unaConsulta++;
    // I. si la consulta falla: «no se pudo leer», nunca «no guardada», y ningún estimado
    if (falla) {
      fallas++;
      if (rec.estimados.length === 0 && (claves.variantes.length === 0 || rec.rutaPrevista.codigo === "no_se_pudo_leer")) fallaSinEstimados++;
    }
    etiquetados += rec.episodios.filter((e) => e.contexto.codigo !== "sin_dato").length;
  }
  console.error = errorOriginal;
  const dentro = trazas - fueras;
  chk(`el veredicto es el de la celda RASTREO, tal cual (${dentro})`, rastreoIg === dentro, `${dentro - rastreoIg}`);
  chk("sinSenalTotal, cortesEnMovimiento y kmACiegas = los de la medición", conteosIg === dentro, `${dentro - conteosIg}`);
  chk("los tramos «sin señal» son EXACTAMENTE medicion.tramos (avanceM en metros enteros)", tramosIg === dentro, `${dentro - tramosIg}`);
  chk("cada hueco lleva las posiciones de la traza en sus dos bordes (cabeza sin inicio, cola sin fin)", bordesBien === dentro, `${dentro - bordesBien}`);
  chk(`FUERA DEL TECHO DIARIO (${fueras}): rastreo = sin_medir como su celda, sin «sin señal» y conteos en null, traza y excesos dibujados`,
    fueras > 10 && fuerasBien === fueras && techoMal === 0, `${fueras} · ${fuerasBien} · pedido mal ${techoMal}`);
  chk("ningún segmento medido cruza un «sin señal» (con la hora de cada vértice)", cruzan === 0, `${cruzan}`);
  chk(`ningún segmento medido pasa de ${MAX_SEG_M} m`, largos === 0, `${largos}`);
  chk("el medido de la respuesta es el del constructor; vértices con su velocidad entera", igualConstructor === dentro && medidoBien === dentro, `${dentro - igualConstructor} · ${dentro - medidoBien}`);
  chk("ningún hueco tiene línea propia (ningún segmento une sus dos bordes)", huecoConLinea === 0, `${huecoConLinea}`);
  chk(`los estimados son solo los que validarPuente aprobó (${estTotal})`, estValidos === estTotal && malosDibujados === 0, `${estTotal - estValidos} · malos ${malosDibujados}`);
  chk("cada hueco: o lo cubre entero un estimado dibujado, o solo sus extremos", cubiertos + soloExtremos > 0);
  chk(`UNA sola consulta a rutas_cache con la ruta y todos los puentes (${dentro})`, unaConsulta === dentro, `${dentro - unaConsulta}`);
  chk("si rutas_cache falla: «no se pudo leer» y ningún estimado", fallas > 5 && fallaSinEstimados === fallas, `${fallas} · ${fallaSinEstimados}`);
  chk("barrido no trivial: huecos, estimados por la ruta Y por puente guardado, rodeos rechazados, huecos cubiertos y solo con extremos, excesos etiquetados",
    conSinSenal > 100 && porRuta > 100 && porPuente > 100 && rechazados > 50 && cubiertos > 50 && soloExtremos > 50 && etiquetados > 20,
    JSON.stringify({ conSinSenal, porRuta, porPuente, rechazados, cubiertos, soloExtremos, etiquetados }));
  chk("la ruta prevista sale guardada, no guardada, con paraderos sin coordenadas y sin poder leerse",
    (codigos.guardada ?? 0) > 50 && (codigos.no_guardada ?? 0) > 20 && (codigos.paraderos_sin_coordenadas ?? 0) > 5 && (codigos.no_se_pudo_leer ?? 0) > 5,
    JSON.stringify(codigos));

  // ── COROLARIO: el «sin señal» por distancia acusaba donde la celda dice 100 % ──
  // ── COPIA LITERAL de `tramosDeTraza` y del corte de la traza de lib/flota/recorrido.ts ANTES de T3 ──
  const coordValidaVieja = (lat: number, lng: number) =>
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  function tramosDeTrazaVieja(limpia: readonly { lat: number; lng: number; ts: number }[]): { tramos: [number, number][][]; huecos: { desde: [number, number]; hasta: [number, number]; segundos: number | null; metros: number }[] } {
    const pts = limpia.filter((p) => coordValidaVieja(p.lat, p.lng));
    const tramos: [number, number][][] = [];
    const huecos: { desde: [number, number]; hasta: [number, number]; segundos: number | null; metros: number }[] = [];
    let actual: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) {
        const a = pts[i - 1];
        const d = distM(a.lat, a.lng, p.lat, p.lng);
        if (d > MAX_SEG_M) {
          if (actual.length >= 2) tramos.push(actual);
          const dt = a.ts > 0 && p.ts > a.ts ? (p.ts - a.ts) / 1000 : null;
          huecos.push({ desde: [a.lng, a.lat], hasta: [p.lng, p.lat], segundos: dt, metros: Math.round(d) });
          actual = [];
        }
      }
      actual.push([p.lng, p.lat]);
    }
    if (actual.length >= 2) tramos.push(actual);
    return { tramos, huecos };
  }
  const huecosViejos = (crudas: any[]) => tramosDeTrazaVieja(H.limpiarHuella(H.filasAPuntos(crudas).filter((p) => coordValidaVieja(p.lat, p.lng)).sort((a, b) => a.ts - b.ts))).huecos;

  let rapidas = 0, viejoAcusa = 0, medicionCero = 0, nuevoCero = 0;
  for (let i = 0; i < 60; i++) {
    // 100 km/h, una posición cada 12 a 25 s: cada salto pasa de 300 m y ninguno de 60 s.
    const filas: Fila[] = [];
    let t = 0, lat = -12.2;
    while (t < 1800) {
      filas.push({ created_at: iso(T0 + Math.round(t * 1000)), lat, lng: -77.03, precision_m: 5, simulado: null, estado: "en_ruta",
        velocidad: 100, rumbo: 0, timestamp: null, conductor_id: 5, conductor_tercero_id: null });
      const dt = 12 + rnd() * 13;
      t += dt; lat += ((100 / 3.6) * dt) / 111_320;
    }
    const { tr, med } = medirFilas(filas);
    const rec = R.recorridoDeServicio({ reservaId: 9, crudas: filas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90, medicion: med, ptsCobertura: tr.pts });
    rapidas++;
    if (huecosViejos(filas).length > 0) viejoAcusa++;
    if (med && med.tramos.length === 0) medicionCero++;
    if (rec.sinSenalTotal === 0 && rec.sinSenal.length === 0) nuevoCero++;
  }
  chk(`COROLARIO (${rapidas} trazas a 100 km/h con saltos de 12 a 25 s): el corte viejo por distancia acusaba «sin señal» donde la medición da 0`,
    viejoAcusa === rapidas && medicionCero === rapidas, `${viejoAcusa} · ${medicionCero}`);
  chk("…y el recorrido nuevo da 0 «sin señal» en esas mismas trazas", nuevoCero === rapidas, `${nuevoCero}`);

  // DIVERGENCIA (a): un «sin señal» de más de 60 s con menos de 300 m de avance (bus lento) también corta.
  const lento = [...tramo(T0, 120, 8, { conductor: 5 }), ...tramo(T0 + 210_000, 120, 8, { conductor: 5, lat0: -12.05 + (8 / 3.6) * 213 / 111_320 })];
  const ml = medirFilas(lento);
  const rl = R.recorridoDeServicio({ reservaId: 9, crudas: lento, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90, medicion: ml.med, ptsCobertura: ml.tr.pts });
  const sinCorte = R.medidoDeHuella(H.huellaDeFilas(lento).limpio, []);
  chk("DIVERGENCIA (a): 90 s sin posición con ~200 m de avance — el corte por distancia no corta; el recorrido sí, y lo marca",
    huecosViejos(lento).length === 0 && sinCorte.length === 1 && rl.medido.length === 2 && rl.sinSenal.length === 1 && !rl.sinSenal[0].enMovimiento,
    JSON.stringify({ viejo: huecosViejos(lento).length, sinCorte: sinCorte.length, m: rl.medido.length, s: rl.sinSenal.length }));
}

// ══ 9b · la ruta prevista guardada: cada código, uno por uno ══════════════════════════════
seccion("9b · la ruta prevista: las claves del modal y cada código de rutaPrevista");
{
  const p = (id: number, orden: number, lat: any, lng: any, nombre = `P${id}`) => ({ id, orden, nombre, lat, lng, estado: "pendiente", hora_estimada: null });
  const A = p(1, 1, -12.0464, -77.0428), B = p(2, 2, -12.05, -77.03), C = p(3, 3, -12.07, -77.01);
  const ruta = [[-77.0428, -12.0464], [-77.03, -12.05], [-77.01, -12.07]];
  const firmaModal = (ps: any[], pj: any, ex: any) => RF.firmaRuta(RF.paradasParaFirma(ps, pj, ex).lista);
  // La variante sin paradas_json es la clave con que el modal de /seguimiento guarda (sección 8 cierra el ciclo).
  const k1 = R.clavesRutaPrevista([A, B, C], null, { origen: "P1", destino: "P3" });
  chk("con todas las coordenadas: UNA clave, la del modal de /seguimiento, sin probar paradas_json",
    k1.variantes.length === 1 && k1.variantes[0].firma === firmaModal([A, B, C], null, null) && !k1.variantes[0].conParadasJson
    && R.clavesRutaPrevista([A, B, C], [{ nombre: "P2", lat: -1, lng: -1 }], null).variantes.length === 1);
  const g = R.resolverRutaPrevista(k1, new Map([[k1.variantes[0].firma, { coordenadas: ruta }]]));
  chk("guardada: devuelve la polilínea", g.estado.codigo === "guardada" && g.ruta?.length === 3);
  chk("no está en la caché: no_guardada (nadie abrió el modal)", R.resolverRutaPrevista(k1, new Map()).estado.codigo === "no_guardada");
  chk("guardada sin geometría utilizable: no_guardada", R.resolverRutaPrevista(k1, new Map([[k1.variantes[0].firma, { coordenadas: [[1, "x"]] }]])).estado.codigo === "no_guardada");
  chk("la consulta falló: no_se_pudo_leer, nunca no_guardada", R.resolverRutaPrevista(k1, null).estado.codigo === "no_se_pudo_leer" && R.resolverRutaPrevista(k1, null).ruta === null);
  // Una parada sin coordenadas: se prueba también la variante rellenada desde paradas_json.
  const Bsin = p(2, 2, null, null);
  const k2 = R.clavesRutaPrevista([A, Bsin, C], [{ nombre: " p2 ", lat: -12.05, lng: -77.03 }], null);
  chk("con una parada sin coordenadas: dos claves, primero la que no tiene faltantes (paradas_json)",
    k2.variantes.length === 2 && k2.variantes[0].conParadasJson && k2.variantes[0].sinCoordenadas === 0 && k2.variantes[1].sinCoordenadas === 1
    && k2.variantes[0].firma === firmaModal([A, Bsin, C], [{ nombre: " p2 ", lat: -12.05, lng: -77.03 }], null)
    && k2.variantes[1].firma === firmaModal([A, Bsin, C], null, null));
  chk("se encuentra por cualquiera de las dos", R.resolverRutaPrevista(k2, new Map([[k2.variantes[1].firma, { coordenadas: ruta }]])).estado.codigo === "guardada");
  const k3 = R.clavesRutaPrevista([A, Bsin, C], null, null);
  chk("con faltantes y sin encontrarla: paraderos_sin_coordenadas (no se geocodifica)", R.resolverRutaPrevista(k3, new Map()).estado.codigo === "paraderos_sin_coordenadas");
  chk("sin paraderos ni origen/destino: sin_paraderos", R.resolverRutaPrevista(R.clavesRutaPrevista([], null, { origen: null, destino: null }), null).estado.codigo === "sin_paraderos");
  chk("solo origen/destino (sin coordenadas): paraderos_sin_coordenadas, también si la consulta falla",
    R.resolverRutaPrevista(R.clavesRutaPrevista([], null, { origen: "A", destino: "B" }), null).estado.codigo === "paraderos_sin_coordenadas");
  chk("primer y último paradero en el mismo punto: mismo_punto (el modal no pide ruta; no se manda a abrirlo)",
    R.resolverRutaPrevista(R.clavesRutaPrevista([A, B, p(9, 9, -12.0464, -77.0428)], null, null), new Map()).estado.codigo === "mismo_punto");
  chk("sin paradas pero con paradas_json: la lista sale de la cotización",
    R.clavesRutaPrevista([], [{ nombre: "X", lat: -12.04, lng: -77.04 }, { nombre: "Y", lat: -12.06, lng: -77.02 }], { origen: "A", destino: "B" }).variantes[0]?.conParadasJson === true);
  const detalles = [R.resolverRutaPrevista(k1, null), R.resolverRutaPrevista(k1, new Map()), R.resolverRutaPrevista(k3, new Map())].map((x) => x.estado.detalle);
  const ptsD = [{ ts: 10, lat: -12.1, lng: -77.1 }, { ts: 20, lat: -12.2, lng: -77.2 }, { ts: 20, lat: -12.3, lng: -77.3 }, { ts: 30, lat: -12.4, lng: -77.4 }];
  chk("posicionEnTs: la posición de ESE instante (con varias: la primera o la última), o null",
    `${R.posicionEnTs(ptsD, 20)}` === `${R.coordR(-77.2, -12.2)}` && `${R.posicionEnTs(ptsD, 20, "ultimo")}` === `${R.coordR(-77.3, -12.3)}`
    && R.posicionEnTs(ptsD, 25) === null && R.posicionEnTs(ptsD, 31) === null && R.posicionEnTs([], 10) === null && R.posicionEnTs(null, 10) === null);
  chk("cortaPorSinSenal: corta solo si el segmento se solapa con un «sin señal», y sin hora no corta",
    (() => { const c = R.cortaPorSinSenal([{ desdeTs: 100, hastaTs: 200 }, { desdeTs: 300, hastaTs: 400 }]);
      return c({ ts: 100 }, { ts: 200 }) && c({ ts: 150 }, { ts: 160 }) && c({ ts: 50 }, { ts: 350 }) && !c({ ts: 50 }, { ts: 100 })
        && !c({ ts: 200 }, { ts: 300 }) && !c({ ts: 400 }, { ts: 500 }) && !c({ ts: 0 }, { ts: 150 }) && !R.cortaPorSinSenal(null)({ ts: 1 }, { ts: 2 }); })());
  chk("cada detalle dice qué pasó y dónde se arregla, en castellano", detalles.every((d) => d.length > 40) && /Programación/.test(detalles[2]) && /intentarlo/.test(detalles[0]));
}

// ══ 11 · la etiqueta de cada exceso ═══════════════════════════════════════════════════════
seccion("11 · la etiqueta de cada exceso: tri-estado, ninguna afirmación sin su hecho, y no cambia el conteo ni la lista");
{
  const M = R.MARGEN_RELOJ_ETIQUETA_MS;
  chk("el margen de reloj es de 2 min", M === 2 * MIN_MS);
  const P1 = T0 + 20 * MIN_MS, FIN = T0 + 80 * MIN_MS;
  type Hechos = import("../lib/flota/recorrido").HechosContexto;
  const p1s: Hechos["paradero1"][] = [null, { ts: P1, nombre: "Puente Santa Anita" }];
  const fines: Hechos["fin"][] = [null, { ts: FIN, por: "ultimo_paradero", nombre: "BSF" }, { ts: FIN, por: "cierre", nombre: null },
    { ts: P1 - 5 * MIN_MS, por: "cierre", nombre: null }];   // el último: contradice (fin antes del paradero 1)
  const abs: (number[] | null)[] = [null, [], [P1 - 30 * MIN_MS], [P1 - MIN_MS], [P1 + 2 * MIN_MS], [P1 + 30 * MIN_MS], [FIN + 10 * MIN_MS], [P1 + 5 * MIN_MS, FIN + 5 * MIN_MS]];
  // EL ORÁCULO: la regla escrita otra vez, aparte.
  function esperado(ep: { inicioTs: number; finTs: number }, h: Hechos): string {
    const p1 = h.paradero1?.ts ?? null, fin = h.fin?.ts ?? null, ab = h.abordajesTs;
    const A = p1 !== null && ep.finTs < p1 - M;
    const D = fin !== null && ep.inicioTs > fin + M;
    const S = p1 !== null && fin !== null && ep.inicioTs > p1 + M && ep.finTs < fin - M;
    if ([A, D, S].filter(Boolean).length !== 1) return "sin_dato";
    if (A) return ab !== null && ab.every((a) => a > ep.finTs + M) ? "antes_paradero_1" : "sin_dato";
    if (D) return ab === null || ab.every((a) => a <= fin! + M) ? "despues_ultimo_paradero" : "sin_dato";
    if (ab === null) return "sin_dato";
    const a0 = ab.length ? Math.min(...ab) : null;
    if (a0 !== null && a0 < ep.inicioTs - M) return "en_servicio_con_pasajeros";
    if (a0 === null || a0 > ep.inicioTs + M) return "en_servicio";
    return "sin_dato";
  }
  let n = 0, igual = 0, sinHecho = 0, textoBien = 0;
  const vistos: Record<string, number> = {};
  for (const paradero1 of p1s) for (const fin of fines) for (const abordajesTs of abs) {
    const h: Hechos = { paradero1, paradero1Falta: paradero1 ? null : "el paradero 1 no está marcado como llegado", fin, abordajesTs };
    for (let ini = T0 - 10 * MIN_MS; ini <= T0 + 100 * MIN_MS; ini += 30_000) for (const dur of [20, 90, 300]) {
      const ep = { inicioTs: ini, finTs: ini + dur * 1000 };
      const c = R.contextoDeExceso(ep, h);
      n++;
      if (c.codigo === esperado(ep, h)) igual++;
      vistos[c.codigo] = (vistos[c.codigo] ?? 0) + 1;
      // Ninguna afirmación sin su hecho.
      const necesitaP1 = c.codigo === "antes_paradero_1" || c.codigo.startsWith("en_servicio");
      const necesitaFin = c.codigo === "despues_ultimo_paradero" || c.codigo.startsWith("en_servicio");
      const necesitaAb = c.codigo === "antes_paradero_1" || c.codigo.startsWith("en_servicio");
      if ((necesitaP1 && !paradero1) || (necesitaFin && !fin) || (necesitaAb && abordajesTs === null)) sinHecho++;
      if (c.codigo === "sin_dato" ? c.texto === null && c.motivo.length > 10 : c.texto === (R.TEXTO_CONTEXTO as any)[c.codigo] && c.motivo.length > 10) textoBien++;
    }
  }
  chk(`la etiqueta = el oráculo escrito aparte (${n} combinaciones de hechos × posición × duración)`, igual === n, `${n - igual}`);
  chk("ninguna afirmación sin su hecho (paradero 1, fin del servicio, abordajes leídos)", sinHecho === 0, `${sinHecho}`);
  chk("texto ⟺ etiqueta (sin_dato sin texto) y siempre con su motivo", textoBien === n, `${n - textoBien}`);
  chk("COROLARIO: las cuatro etiquetas aparecen (un motor que dijera siempre «sin dato» no pasa)",
    ["antes_paradero_1", "en_servicio_con_pasajeros", "en_servicio", "despues_ultimo_paradero", "sin_dato"].every((k) => (vistos[k] ?? 0) > 100), JSON.stringify(vistos));
  chk("sin hechos: sin_dato", R.contextoDeExceso({ inicioTs: T0, finTs: T0 + 60_000 }, null).codigo === "sin_dato");
  const hc: Hechos = { paradero1: { ts: P1, nombre: null }, paradero1Falta: null, fin: { ts: FIN, por: "ultimo_paradero", nombre: null }, abordajesTs: [] };
  chk("en el margen de la llegada al paradero 1: sin_dato (y lo dice)",
    R.contextoDeExceso({ inicioTs: P1 - 3 * MIN_MS, finTs: P1 - 90_000 }, hc).codigo === "sin_dato"
    && /menos de 2 min/.test(R.contextoDeExceso({ inicioTs: P1 - 3 * MIN_MS, finTs: P1 - 90_000 }, hc).motivo)
    && R.contextoDeExceso({ inicioTs: P1 - 5 * MIN_MS, finTs: P1 - 2 * MIN_MS - 1 }, hc).codigo === "antes_paradero_1");

  // hechosDelServicio = hechosDeParadas: el paradero de menor orden, su llegada CREÍBLE, el último, y los
  // abordajes de ESTA reserva.
  const res = { fecha_servicio: "2026-10-09" };
  const AH = Date.UTC(2026, 9, 13);
  const par = (id: number, orden: number, estado: string, hora: number | null, nombre = `P${id}`) => ({ id, orden, nombre, estado, hora_llegada: hora == null ? null : iso(hora) });
  const h1 = R.hechosDelServicio({ reserva: res, paradas: [par(3, 3, "completada", FIN), par(1, 1, "completada", P1, "Inicio"), par(2, 2, "pendiente", null)],
    abordajes: [{ parada_id: 1, hora_abordaje: iso(P1 + MIN_MS) }, { parada_id: 999, hora_abordaje: iso(T0) }], ahoraMs: AH });
  chk("paradero 1 = el de menor orden (aunque llegue desordenado), fin = el último marcado, abordajes solo de esta reserva",
    h1.paradero1?.ts === P1 && h1.paradero1?.nombre === "Inicio" && h1.fin?.ts === FIN && h1.fin?.por === "ultimo_paradero"
    && JSON.stringify(h1.abordajesTs) === JSON.stringify([P1 + MIN_MS]));
  const h2 = R.hechosDelServicio({ reserva: res, paradas: [par(1, 1, "pendiente", null), par(2, 2, "pendiente", null)], abordajes: null, ahoraMs: AH, cierreTs: FIN });
  chk("paradero 1 sin marcar: null con su motivo; sin el último marcado, el fin es el «Finalizar»; abordajes sin leer: null",
    h2.paradero1 === null && /no está marcado/.test(h2.paradero1Falta ?? "") && h2.fin?.por === "cierre" && h2.fin.ts === FIN && h2.abordajesTs === null);
  const h3 = R.hechosDelServicio({ reserva: res, paradas: [par(1, 1, "completada", P1 + 3 * 86_400_000), par(2, 2, "completada", FIN)], abordajes: [], ahoraMs: AH + 5 * 86_400_000 });
  chk("una llegada fuera de la ventana de sanidad no es un hecho", h3.paradero1 === null && /creíble/.test(h3.paradero1Falta ?? ""));
  chk("sin paradas ni cierre: ni paradero 1 ni fin", (() => { const h = R.hechosDelServicio({ reserva: res, paradas: [], abordajes: [], ahoraMs: AH }); return h.paradero1 === null && h.fin === null; })());

  // El conteo y la lista de episodios son IDÉNTICOS con y sin etiqueta.
  let trazas = 0, iguales = 0, conEps = 0, etiq = 0, sinHechosSinDato = 0;
  for (let i = 0; i < 300; i++) {
    const filas = trazaAlAzar();
    const { tr, med } = medirFilas(filas);
    const ts = filas.map((f) => Date.parse(String(f.created_at)));
    const t0 = ts[0], t1 = ts[ts.length - 1];
    const hechos: Hechos = {
      paradero1: rnd() < 0.85 ? { ts: t0 + (t1 - t0) * rnd() * 0.6, nombre: null } : null, paradero1Falta: null,
      fin: rnd() < 0.85 ? { ts: t1 - (t1 - t0) * rnd() * 0.3, por: "ultimo_paradero", nombre: null } : null,
      abordajesTs: rnd() < 0.1 ? null : rnd() < 0.5 ? [] : [t0 + (t1 - t0) * rnd()],
    };
    const base = { reservaId: 5, crudas: filas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90, vehiculo: "p:1", medicion: med, ptsCobertura: tr.pts };
    const con = R.recorridoDeServicio({ ...base, hechos });
    const sin = R.recorridoDeServicio(base);
    trazas++;
    const quitar = (r: any) => JSON.stringify({ ...r, episodios: r.episodios.map(({ contexto, ...x }: any) => x) });
    if (quitar(con) === quitar(sin)) iguales++;
    if (con.episodios.length) conEps++;
    etiq += con.episodios.filter((e) => e.contexto.codigo !== "sin_dato").length;
    if (sin.episodios.every((e) => e.contexto.codigo === "sin_dato")) sinHechosSinDato++;
  }
  chk(`con y sin etiqueta, la respuesta es la misma salvo la etiqueta: conteo, lista y todo lo demás (${trazas})`, iguales === trazas, `${trazas - iguales}`);
  chk("sin hechos, toda etiqueta es sin_dato", sinHechosSinDato === trazas);
  chk("barrido no trivial: hay excesos y etiquetas (trazas cortas: el margen de 2 min deja muchas en sin_dato)", conEps > 100 && etiq > 15, `${conEps} · ${etiq}`);
}

// ══ 12 · el peso de la respuesta en el peor caso de los topes ═════════════════════════════
seccion("12 · el peso: cada lista topada, el dibujo de los episodios topado, y la cota dura según cuántos episodios haya");
{
  const TOPE_BYTES = 450_000;
  const peso = (x: unknown) => JSON.stringify(x).length;

  // ── A · por la cadena real: una traza que llena TODOS los topes a la vez ──
  // 650 tramos de 30 posiciones (cada 3 s a 60 km/h) separados por 65 s sin señal con el bus avanzando:
  // ~19 500 vértices medidos, 649 «sin señal», ~9 400 puntitos y 30 puentes guardados de 150 vértices.
  // 21 de los tramos (uno de cada 32) van a 100 km/h: 21 excesos, etiquetados salvo el que cruza el paradero 1.
  const filas: Fila[] = [];
  let t = 0, lat = -12.05, lng = -77.03;
  for (let k = 0; k < 650; k++) {
    const kmh = k % 32 === 5 ? 100 : 60;
    for (let j = 0; j < 30; j++) {
      filas.push({ created_at: iso(T0 + t * 1000), lat, lng, precision_m: 4.7, simulado: null, estado: "en_ruta",
        velocidad: kmh + (j % 3) * 0.37, rumbo: 359.5, timestamp: null, reserva_id: 77, conductor_id: 5, conductor_tercero_id: null });
      t += 3; lat += ((kmh / 3.6) * 3) / 111_320 * 0.8; lng += ((kmh / 3.6) * 3) / 111_320 * 0.6;
    }
    t += 65; lat += ((60 / 3.6) * 65) / 111_320 * 0.8; lng += ((60 / 3.6) * 65) / 111_320 * 0.6;
  }
  const { tr, med } = medirFilas(filas);
  const huella = H.huellaDeFilas(filas);
  const guardados = new Map<string, any>();
  for (const c of R.candidatosPuente(huella.limpio)) {
    const coords = Array.from({ length: 150 }, (_, k) => [c.aLng + (c.bLng - c.aLng) * (k / 149), c.aLat + (c.bLat - c.aLat) * (k / 149)]);
    guardados.set(RF.clavePuente(c.aLat, c.aLng, c.bLat, c.bLng), { coords, roadM: c.dRecta, rutasM: [c.dRecta], status: "OK" });
  }
  const ts = filas.map((f) => Date.parse(String(f.created_at)));
  const hechos = { paradero1: { ts: ts[0] + 3 * 3_600_000, nombre: "Paradero con un nombre bastante largo de la ruta" }, paradero1Falta: null,
    fin: { ts: ts[ts.length - 1] - 3 * 3_600_000, por: "ultimo_paradero" as const, nombre: "Último paradero con un nombre bastante largo" }, abordajesTs: [ts[0] + 4 * 3_600_000] };
  const recA = R.recorridoDeServicio({
    reservaId: 77, crudas: filas, aplica: true, trazaLeida: true, umbral: 90, vehiculo: "p:3",
    rastreo: { ...ver("incompleto"), detalle: "x".repeat(300) }, medicion: med, ptsCobertura: tr.pts,
    ruta: null, estadoRuta: R.resolverRutaPrevista({ variantes: [{ firma: "f", conParadasJson: false, sinCoordenadas: 0 }], sinRuta: null, sinCoordenadas: 0 }, new Map()).estado,
    puentesGuardados: guardados, hechos,
  });
  const vM = recA.medido.reduce((a, l) => a + l.coords.length + R.COSTO_TRAMO_MEDIDO, 0);
  // Decimar conserva la velocidad de cada vértice que queda y los dos extremos de cada tramo.
  const cons = R.medidoDeHuella(huella.limpio, med?.tramos ?? []);
  const velDe = new Map<string, number>();
  const extremosCons = new Set<string>();
  for (const l of cons) { l.coords.forEach((x, j) => velDe.set(`${x}`, l.vel[j])); extremosCons.add(`${l.coords[0]}>${l.coords[l.coords.length - 1]}`); }
  chk("el decimado de la huella conserva la velocidad de cada vértice y los extremos de cada tramo",
    recA.medido.every((l) => l.coords.every((x, j) => velDe.get(`${x}`) === l.vel[j]) && extremosCons.has(`${l.coords[0]}>${l.coords[l.coords.length - 1]}`)));
  const vE = recA.estimados.reduce((a, l) => a + l.coords.length, 0);
  const bA = peso(recA);
  const partes = (r: any) => Object.fromEntries(Object.keys(r).map((k) => [k, peso(r[k])]));
  if (process.env.DETALLE) console.log("   A:", JSON.stringify(partes(recA)));
  chk(`A · la cadena real llena los cuatro topes a la vez (medido ${vM}/${R.MAX_VERTICES_TRAZA}, estimados ${vE}/${R.MAX_VERTICES_ESTIMADO}, «sin señal» ${recA.sinSenal.length}/${R.MAX_HUECOS}, puntitos ${recA.puntos.length}/${R.MAX_PUNTOS_DATO})`,
    // El decimado va por pasos enteros: puede quedar bastante por debajo del tope, nunca por encima.
    recA.medidoDecimado && vM <= R.MAX_VERTICES_TRAZA && vM > R.MAX_VERTICES_TRAZA / 2
    && recA.estimadosDecimados && vE <= R.MAX_VERTICES_ESTIMADO && vE > R.MAX_VERTICES_ESTIMADO / 2
    && recA.sinSenal.length === R.MAX_HUECOS && recA.sinSenalOmitidos === (recA.sinSenalTotal ?? 0) - R.MAX_HUECOS && recA.sinSenalOmitidos > 0
    && recA.puntos.length === R.MAX_PUNTOS_DATO && recA.puntosTotal > R.MAX_PUNTOS_DATO,
    JSON.stringify({ vM, vE, s: recA.sinSenal.length, om: recA.sinSenalOmitidos, p: recA.puntos.length, pt: recA.puntosTotal }));
  chk(`A · con 21 excesos (20 etiquetados), pesa ${bA} B (< ${TOPE_BYTES})`,
    recA.excesos.n === 21 && recA.episodios.filter((e) => e.cuenta && e.contexto.codigo !== "sin_dato").length >= 20 && bA < TOPE_BYTES, `${bA} B · ${recA.excesos.n} excesos`);

  // ── B · la cota: cada lista topada llena con su elemento MÁS PESADO posible ──
  const c: [number, number] = R.coordR(-77.123456, -12.123456);
  const tsMax = 9_999_999_999_999;
  const medidoFrag = Array.from({ length: Math.floor(R.MAX_VERTICES_TRAZA / (2 + R.COSTO_TRAMO_MEDIDO)) }, () => ({ coords: [c, c], vel: [130, 130] }));
  const medidoLargo = [{ coords: Array.from({ length: R.MAX_VERTICES_TRAZA - R.COSTO_TRAMO_MEDIDO }, () => c), vel: Array.from({ length: R.MAX_VERTICES_TRAZA - R.COSTO_TRAMO_MEDIDO }, () => 130) }];
  const estimados = Array.from({ length: H.MAX_PUENTES }, () => ({ coords: Array.from({ length: R.MAX_VERTICES_ESTIMADO / H.MAX_PUENTES }, () => c), km: 99.9, min: 300, sinSenal: false, fuente: "puente_guardado" }));
  const sinSenal = Array.from({ length: R.MAX_HUECOS }, () => ({ tipo: "hueco", desdeTs: tsMax, hastaTs: tsMax, durS: 99999.999, avanceM: 49999, enMovimiento: false, desde: c, hasta: c, estimado: false }));
  const puntos = Array.from({ length: R.MAX_PUNTOS_DATO }, () => ({ c, ts: tsMax, vel: 130, velReal: false, rumbo: 359, rumboReal: false, acc: 1500 }));
  // El resto (excesos, veredicto, ruta prevista, contadores) tal como sale de A, sin episodios.
  const fijo = { ...recA, medido: [], estimados: [], sinSenal: [], puntos: [], episodios: [] };
  const cotaSinEpisodios = Math.max(peso({ ...fijo, medido: medidoFrag }), peso({ ...fijo, medido: medidoLargo })) + peso(estimados) + peso(sinSenal) + peso(puntos);
  // Un episodio en su tope de posiciones, con coordenadas crudas de 17 cifras y los textos más largos.
  const crudo: [number, number] = [-77.03123456789012, -12.046512345678901];
  const epMax = { ...recA.episodios[0], codigo: "sin_corroborar", velMaxSensor: 123.45678901234, velMediaSensor: 98.765432109876, velGeom: 87.654321098765,
    precisionMediana: 12.345678901234, latPico: crudo[1], lngPico: crudo[0], detalle: "x".repeat(220),
    coords: Array.from({ length: R.MAX_COORDS_EPISODIO }, () => crudo), contexto: { codigo: "sin_dato", texto: null, motivo: "y".repeat(260) } };
  const pesoEp = peso(epMax) + 1;
  const caben = Math.floor((TOPE_BYTES - cotaSinEpisodios) / pesoEp);
  if (process.env.DETALLE) console.log(`   B: cota sin episodios ${cotaSinEpisodios} B · episodio en su tope ${pesoEp} B · caben ${caben}`);
  chk(`B · cada lista topada llena con su elemento más pesado: ${cotaSinEpisodios} B, y caben ${caben} episodios en su tope de ${R.MAX_COORDS_EPISODIO} posiciones antes de ${TOPE_BYTES} B`,
    cotaSinEpisodios < TOPE_BYTES && caben >= 3, `${cotaSinEpisodios} · ${pesoEp} · ${caben}`);
  // ── C · el tope de posiciones de TODOS los episodios (la lista y el conteo no se topan) ──
  chk("MAX_COORDS_EPISODIOS_TOTAL = 3000", R.MAX_COORDS_EPISODIOS_TOTAL === 3000);
  let topN = 0, topBien = 0, topActivo = 0;
  const sub = (a: [number, number][], b: [number, number][]) => { let j = 0; for (const x of a) { while (j < b.length && b[j] !== x) j++; if (j === b.length) return false; j++; } return true; };
  for (let i = 0; i < 400; i++) {
    const n = Math.floor(rnd() * 250);
    const eps = Array.from({ length: n }, (_, k) => ({ id: k, otro: `x${k}`, coords: Array.from({ length: Math.floor(rnd() * (R.MAX_COORDS_EPISODIO + 1)) }, (_, j) => [k, j] as [number, number]) }));
    const max = rnd() < 0.5 ? R.MAX_COORDS_EPISODIOS_TOTAL : 10 + Math.floor(rnd() * 4000);
    const { episodios: out, decimadas } = R.toparCoordsEpisodios(eps, max);
    const antes = eps.reduce((a, e) => a + e.coords.length, 0), despues = out.reduce((a, e) => a + e.coords.length, 0);
    topN++;
    if (decimadas) topActivo++;
    const ok = out.length === eps.length && out.every((e, k) => e.id === eps[k].id && e.otro === eps[k].otro)
      && despues <= Math.max(max, eps.reduce((a, e) => a + Math.min(2, e.coords.length), 0))
      && out.every((e, k) => sub(e.coords, eps[k].coords)
        && (eps[k].coords.length === 0 || (e.coords[0] === eps[k].coords[0] && e.coords[e.coords.length - 1] === eps[k].coords[eps[k].coords.length - 1])))
      && decimadas === (antes > max) && (antes > max || out.every((e, k) => e === eps[k]));
    if (ok) topBien++;
  }
  chk(`toparCoordsEpisodios (${topN} repartos): misma lista y mismos campos, cada uno con sus dos extremos y en orden; total ≤ máx(tope, 2 por episodio); sin pasarse, intacto`,
    topBien === topN && topActivo > 100, `${topN - topBien} · activos ${topActivo}`);

  // Por la cadena real: 15 excesos largos (> 300 posiciones cada uno) → más de 3000 posiciones en total.
  const largas: Fila[] = [];
  let tL = 0, latL = -12.05;
  for (let k = 0; k < 31; k++) {
    const rapido = k % 2 === 1, n = rapido ? 320 : 20;
    for (let j = 0; j < n; j++) {
      largas.push({ created_at: iso(T0 + tL * 1000), lat: latL, lng: -77.03, precision_m: 4, simulado: null, estado: "en_ruta",
        velocidad: rapido ? 100 : 30, rumbo: 0, timestamp: null, reserva_id: 77, conductor_id: 5, conductor_tercero_id: null });
      const kmh = rapido ? 100 : 30;
      tL += 3; latL += ((kmh / 3.6) * 3) / 111_320;
    }
  }
  const recL = R.recorridoDeServicio({ reservaId: 77, crudas: largas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90, vehiculo: "p:3" });
  const { puntos: ptsL, episodios: epsL } = SE.episodiosDeTraza({ reservaId: 77, crudas: largas, umbral: 90, vehiculo: "p:3" });
  const sinTope = epsL.map((ep) => R.muestrear(R.coordsDeEpisodio(ptsL, ep), R.MAX_COORDS_EPISODIO));
  const totalSinTope = sinTope.reduce((a, c) => a + c.length, 0), totalCon = recL.episodios.reduce((a, e) => a + e.coords.length, 0);
  // Los campos de cada episodio (todos menos `coords`) son los del motor de excesos, en el mismo orden.
  const ordenados = [...epsL].sort((a, b) => a.inicioTs - b.inicioTs);
  const camposIg = recL.episodios.length === ordenados.length && recL.episodios.every((e, k) => {
    const o = ordenados[k];
    return e.codigo === o.codigo && e.cuenta === (o.codigo === "exceso") && e.inicioTs === o.inicioTs && e.finTs === o.finTs
      && e.durS === o.durS && e.puntos === o.puntos && e.velMaxSensor === o.velMaxSensor && e.velMediaSensor === o.velMediaSensor
      && e.velGeom === o.velGeom && e.precisionMediana === o.precisionMediana && e.latPico === o.latPico && e.lngPico === o.lngPico
      && e.cortado === o.cortado && e.detalle === o.detalle;
  });
  const txt = (xs: [number, number][]) => xs.map((x) => `${x}`);
  const dibujoIg = recL.episodios.every((e, k) => {
    const o = txt(sinTope[epsL.indexOf(ordenados[k])]), c = txt(e.coords);
    return sub(c as any, o as any) && c[0] === o[0] && c[c.length - 1] === o[o.length - 1];
  });
  chk(`con el tope, el conteo y la lista (sin coords) son los mismos: ${recL.episodios.length} episodios, ${totalSinTope} → ${totalCon} posiciones`,
    recL.episodiosCoordsDecimadas && totalSinTope > R.MAX_COORDS_EPISODIOS_TOTAL && totalCon <= R.MAX_COORDS_EPISODIOS_TOTAL
    && recL.excesos.n === epsL.filter((e) => e.codigo === "exceso").length && camposIg && dibujoIg,
    JSON.stringify({ n: recL.episodios.length, totalSinTope, totalCon, flag: recL.episodiosCoordsDecimadas, camposIg, dibujoIg }));
  chk("sin pasarse del tope, las posiciones son las de siempre y no se marca nada",
    recA.episodiosCoordsDecimadas === false && recA.episodios.every((e) => e.coords.length <= R.MAX_COORDS_EPISODIO));

  // La cota DURA del dibujo de los episodios: sea cual sea la cantidad, sus posiciones no pasan de
  // MAX_COORDS_EPISODIOS_TOTAL (o de 2 por episodio). Lo que NO se topa es la lista: cada episodio pesa
  // además su ficha (~0,7 KB), y con 200 eso solo ya pasa del margen que dejan las otras listas.
  const epsMuchos = Array.from({ length: 200 }, () => ({ ...epMax }));
  const topados = R.toparCoordsEpisodios(epsMuchos).episodios;
  const pesoSinTope = peso(epsMuchos), pesoTopados = peso(topados);
  const fichaEp = peso({ ...epMax, coords: [] }) + 1;
  const cotaDibujo = R.MAX_COORDS_EPISODIOS_TOTAL * (peso([crudo]) - 1);
  const total200 = cotaSinEpisodios + pesoTopados;
  if (process.env.DETALLE) console.log(`   C: 200 episodios en su tope: ${pesoSinTope} B sin el tope de posiciones, ${pesoTopados} B con él (fichas ${200 * fichaEp} B); respuesta ${total200} B`);
  chk(`200 episodios en su tope: el dibujo queda en ≤ ${cotaDibujo} B (sin el tope serían ${pesoSinTope} B)`,
    topados.reduce((a, e) => a + e.coords.length, 0) <= R.MAX_COORDS_EPISODIOS_TOTAL && pesoTopados <= 200 * fichaEp + cotaDibujo && pesoSinTope > 2_000_000,
    `${pesoTopados} · ${pesoSinTope}`);
  chk(`la cota dura de la respuesta es lineal en la cantidad de episodios: listas topadas + ${fichaEp} B por ficha + ${cotaDibujo} B de dibujo`,
    total200 <= cotaSinEpisodios + 200 * fichaEp + cotaDibujo, `${total200}`);

  // La envoltura de cada tramo cuenta: sin ella, la huella partida en tramos de 2 vértices pesaría bastante más.
  const fragSinCosto = Array.from({ length: Math.floor(R.MAX_VERTICES_TRAZA / 2) }, () => ({ coords: [c, c], vel: [130, 130] }));
  chk("la envoltura de cada tramo medido cuenta contra el tope (sin eso, una huella partida pesaba ~40 % más)",
    peso(fragSinCosto) > peso(medidoFrag) * 1.4 && R.COSTO_TRAMO_MEDIDO === 1, `${peso(fragSinCosto)} vs ${peso(medidoFrag)}`);
}

// ══ 13 · el tope de episodios DESCARTADOS (hallazgo de seguridad de T5) ════════════════════
seccion("13 · una traza con un punto rápido cada 11 s ya no fabrica miles de descartados: ≤ 300, los que cuentan intactos");
{
  const peso = (x: unknown) => JSON.stringify(x).length;
  chk("MAX_EPISODIOS_DESCARTADOS = 300", R.MAX_EPISODIOS_DESCARTADOS === 300);
  // toparDescartados: los que cuentan quedan TODOS y en su sitio; de los otros, los más largos en su orden.
  let n = 0, bien = 0, activos = 0;
  for (let i = 0; i < 400; i++) {
    const eps = Array.from({ length: Math.floor(rnd() * 900) }, (_, k) => ({ k, cuenta: rnd() < 0.2, durS: Math.floor(rnd() * 120) }));
    const max = rnd() < 0.5 ? R.MAX_EPISODIOS_DESCARTADOS : Math.floor(rnd() * 500);
    const { episodios: out, omitidos } = R.toparDescartados(eps, max);
    const desc = eps.filter((e) => !e.cuenta), descOut = out.filter((e) => !e.cuenta);
    const fuera = desc.filter((e) => !out.includes(e));
    n++;
    if (omitidos) activos++;
    if (JSON.stringify(out.filter((e) => e.cuenta)) === JSON.stringify(eps.filter((e) => e.cuenta))
      && descOut.length === Math.min(desc.length, max) && omitidos === desc.length - descOut.length
      && out.every((e, j) => j === 0 || out[j - 1].k < e.k)
      && (!descOut.length || fuera.every((f) => f.durS <= Math.min(...descOut.map((d) => d.durS))))) bien++;
  }
  chk(`toparDescartados (${n} listas): los que cuentan, todos y en su sitio; de los descartados quedan los más largos, en orden, y se cuentan los demás`,
    bien === n && activos > 100, `${n - bien} · activos ${activos}`);

  // 10 h de traza: a 30 km/h una posición cada 5,5 s y, cada 11 s, una a 100 km/h (un `breve` cada una).
  // En medio, 6 excesos sostenidos de verdad (2 min a 100 km/h cada uno).
  const filas: Fila[] = [];
  let t = 0, lat = -12.3, k = 0;
  const empujar = (vel: number, mov: number, paso: number) => {
    filas.push({ created_at: iso(T0 + Math.round(t * 1000)), lat, lng: -77.03, precision_m: 4, simulado: null, estado: "en_ruta",
      velocidad: vel, rumbo: 0, timestamp: null, reserva_id: 77, conductor_id: 5, conductor_tercero_id: null });
    t += paso; lat += ((mov / 3.6) * paso) / 111_320;
  };
  while (t < 10 * 3600) {
    if (k % 600 === 300) { for (let j = 0; j < 40; j++) empujar(100, 100, 3); }   // exceso sostenido
    empujar(k % 2 ? 100 : 30, 30, 5.5);
    k++;
  }
  const { episodios: crudos } = SE.episodiosDeTraza({ reservaId: 77, crudas: filas, umbral: 90, vehiculo: "p:3" });
  const cuentanMotor = crudos.filter((e) => e.codigo === "exceso").sort((a, b) => a.inicioTs - b.inicioTs);
  const descMotor = crudos.length - cuentanMotor.length;
  const rec = R.recorridoDeServicio({ reservaId: 77, crudas: filas, aplica: true, trazaLeida: true, rastreo: ver("completo"), umbral: 90, vehiculo: "p:3" });
  const descRec = rec.episodios.filter((e) => !e.cuenta), cuentanRec = rec.episodios.filter((e) => e.cuenta);
  const bytes = peso(rec);
  if (process.env.DETALLE) console.log(`   10 h: ${filas.length} posiciones · ${descMotor} descartados del motor → ${descRec.length} listados (${rec.episodiosDescartadosOmitidos} omitidos) · ${cuentanRec.length} que cuentan · ${bytes} B`);
  chk(`ANTES: el motor fabrica miles de descartados (${descMotor}); AHORA se listan ≤ ${R.MAX_EPISODIOS_DESCARTADOS} y el resto se cuenta`,
    descMotor > 2000 && descRec.length === R.MAX_EPISODIOS_DESCARTADOS && rec.episodiosDescartadosOmitidos === descMotor - R.MAX_EPISODIOS_DESCARTADOS,
    `${descMotor} · ${descRec.length} · ${rec.episodiosDescartadosOmitidos}`);
  const campos = (e: any) => JSON.stringify([e.codigo, e.inicioTs, e.finTs, e.durS, e.puntos, e.velMaxSensor, e.velMediaSensor, e.velGeom, e.precisionMediana, e.latPico, e.lngPico, e.cortado, e.detalle]);
  chk(`el conteo y los que cuentan son los mismos con y sin el tope (${cuentanMotor.length} excesos)`,
    cuentanMotor.length >= 6 && rec.excesos.n === cuentanMotor.length
    && JSON.stringify(cuentanRec.map(campos)) === JSON.stringify(cuentanMotor.map((e) => campos({ ...e }))),
    `${cuentanMotor.length} · n ${rec.excesos.n} · ${cuentanRec.length}`);
  chk(`y la respuesta queda acotada: ${bytes} B (< 1 MB, el tope de lo que se cachea)`, bytes < 1_000_000, `${bytes}`);

  const srcRuta = fs.readFileSync(path.join(process.cwd(), "app/api/seguimiento/recorrido/route.ts"), "utf8");
  chk("la ruta no cachea un recorrido de más de 1 MB (y lo sirve igual)",
    /const MAX_BYTES_CACHE = 1_000_000;/.test(srcRuta) && srcRuta.includes("if (JSON.stringify(payload).length > MAX_BYTES_CACHE) return;"));
}

if (process.env.DETALLE) console.log(`   (${ok + fallas - okSeccion} comprobaciones en la sección anterior)`);
console.log(`\n${fallas ? "❌" : "✅"} prueba-recorrido: ${ok} ok, ${fallas} fallas`);
if (fallas) process.exit(1);
