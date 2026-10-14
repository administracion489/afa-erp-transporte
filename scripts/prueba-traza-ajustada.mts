// scripts/prueba-traza-ajustada.mts — la traza ajustada a la vía que se guarda para siempre (fase 1).
//   npx tsx scripts/prueba-traza-ajustada.mts          (DETALLE=1 imprime los números)
//
// Fija:
//   0. la red INYECTABLE de lib/huella.ts: `mapMatchTrail`, `matchVentana` y `crearAjustadorHuella`
//      con el `fetch` por defecto (el global) y con el `fetch` inyectado dan EXACTAMENTE lo mismo que
//      los originales (copiados literal abajo, de HEAD antes de este cambio) — mismas coords,
//      `esCrudo`, `crudoRanges`, `colaClean`, `colaSnapped` y la MISMA secuencia de llamadas—, sobre
//      un corpus sintético (chip bueno, red degradada, servicio corto, backlog largo, mixto) contra un
//      Mapbox falso determinista que también contesta 429/500/422, corta la red y devuelve fragmentos
//      de baja confianza; y en uso incremental (el modal cada 15 s, con el reloj simulado). Este
//      archivo llega a la app del conductor (lib/km-servicio.ts): con los defectos, byte a byte.
//   1. `rangosDeCrudo` = el bloque original del ajustador, copiado literal, por barrido de vectores.
//   2. el códec: codificar → decodificar devuelve las coords a ≤ 0,5e-6°, el RLE exacto, colaSnapped,
//      y `crudoRanges`/`colaClean` = los del ajustador en memoria; las features del modal (colorearMatched
//      + colaViva + puentesCrudos) desde lo decodificado = desde lo de memoria. Divergencias declaradas,
//      las dos del redondeo de ≤ 0,11 m y juzgadas en el sitio exacto donde aparecen (se cuentan):
//      (a) una cuerda a < 0,25 m de un umbral de corte (300/60 m) puede quedar del otro lado;
//      (b) un vértice con sus dos fixes más cercanos casi empatados (< 0,25 m) puede tomar la velocidad
//      del otro (con paradas, la huella limpia tiene fixes en la MISMA posición: empate exacto).
//      Los puentes (umbral de 40 m) tienen que salir idénticos. Topes y rechazos del códec.
//   3. la firma (sha256 de VERSION_AJUSTE + canonEntradaAjuste): mismas filas → misma firma; una fila
//      tardía la cambia; un campo que `huellaDeFilas` no lee no la cambia (y los que lee sí).
//   4. el ciclo escritura → lectura con una base y un Mapbox falsos: lo calculado sobre
//      `huellaDelServicio` y releído por el camino de /api/cliente/gps sale `guardada`; y
//      `ajustarServicioCompleto` cuenta llamadas y transitorios y aborta en el tope.
//  4b. lib/gps-traza-ajustada-datos.ts con una base y un Mapbox falsos: el ciclo calcularYGuardar →
//      ajustadaParaRespuesta («guardada»; con `conocida`, sinCambios sin reenviar el jsonb), ya_guardada
//      sin consultas, desactualizada → espera de 30 min → recálculo → tope, candado (en_curso y el
//      muerto de > 5 min), presupuesto por hora y por mes, transitorios que no se guardan, el candado
//      soltado aunque el guardado lance, guardar=false sin tocar la tabla, sin migración, sin token,
//      no finalizada / fuera de ventana / inexistente, el tercero por la unidad de la reserva, el token
//      del servidor sin caer al público, y el cron (apagado, por_corrida, recientes, anotados, borrado).
//   5. barrido de `decidirLectura` y `resultadoDelCalculo`: nunca `guardada` con firma distinta;
//      `no_se_pudo_leer` nunca puede calcular; `apagada` nunca lee ni trae traza; transitorio o
//      abortado nunca se guarda. Corolario: el barrido SÍ produce `guardada` y `calculada`.
//   6. `huellaDelServicio` (+ lib/gps-huella-servicio.ts) = el bloque original de /api/cliente/gps
//      copiado literal, con una base falsa: misma respuesta en todos los escenarios (reserva, tercero
//      por ventana, varios viajes, sin fecha, antes de la ventana, paginado, páginas que fallan).
//   7. sin red: los módulos de lectura y la ruta no llaman a Mapbox ni hacen `fetch(`.

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://x.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "x";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "x";

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const H = await import("../lib/huella");
const HS = await import("../lib/gps-huella-servicio");
const HSD = await import("../lib/gps-huella-servicio-datos");
const TA = await import("../lib/gps-traza-ajustada");
const TC = await import("../lib/gps-traza-ajustada-calculo");
const { prepararPuntos, distM, ACC_CONFIABLE_M, suavizarPorDistancia, paginarFilas, PRECISION_MAX_HUELLA_M } = H;
type MatchPt = import("../lib/huella").MatchPt;

let ok = 0, fallas = 0, pendientes = 0;
function chk(nombre: string, cond: boolean, detalle?: string) {
  if (process.env.DETALLE && detalle) console.log(`  · ${nombre} — ${detalle}`);
  if (cond) ok++;
  else { fallas++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ""}`); }
}
function pendiente(nombre: string) { pendientes++; console.log(`  … PENDIENTE (T3): ${nombre}`); }
let okSeccion = 0;
const conteos: string[] = [];
let tituloActual = "";
const seccion = (t: string) => {
  if (tituloActual) conteos.push(`${tituloActual.split(" · ")[0]}: ${ok + fallas - okSeccion}`);
  okSeccion = ok + fallas;
  tituloActual = t;
  console.log(`\n── ${t}`);
};

// PRNG determinista.
let semilla = 20261014;
const rnd = () => { semilla = (semilla * 1664525 + 1013904223) >>> 0; return semilla / 2 ** 32; };
const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };

// ═════════════════════════════════════════════════════════════════════════════════════════
// LOS ORIGINALES, COPIADOS LITERAL de lib/huella.ts en HEAD (antes de inyectar el fetch). Solo se
// renombraron (sufijo Orig) y se les quitó el `export`. Usan el `fetch` GLOBAL.
// ═════════════════════════════════════════════════════════════════════════════════════════
const ACC_DEGRADADO_M = 30;   // privada en lib/huella.ts; mismo valor
async function mapMatchTrailOrig(
  pts: MatchPt[],
  token: string
): Promise<{ coords: [number, number][]; confidence: number; crudeFrac: number; maxCrudoChordM: number; esCrudo: boolean[] } | null> {
  const sample = prepararPuntos(pts);
  if (sample.length < 2) return null;
  const coords = sample.map(p => `${p.lng},${p.lat}`).join(";");
  const radii  = sample.map(p => String(Math.min(50, Math.max(5, Math.ceil((p.acc || 25) * 1.5))))).join(";");
  try {
    const url =
      `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
      `?geometries=geojson&overview=full&tidy=true&radiuses=${radii}&access_token=${token}`;
    // 429 (cuota por ráfaga — alcanzable con el lote paralelo del ajustador en backlogs de
    // full-day o varios visores a la vez): REINTENTAR con backoff en vez de devolver null.
    // Un null aquí se vuelve "no pegó" → la ventana se congela CRUDA para TODA la sesión del
    // modal (el congelado es inmutable por diseño) — un rate-limit transitorio no debe hornear
    // geometría degradada permanente (review ago-2026).
    let res: Response | null = null;
    for (let intento = 0; intento < 3; intento++) {
      res = await fetch(url);
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1200 * (intento + 1)));
    }
    if (!res || !res.ok) return null;
    const json = await res.json();
    const m = json?.matchings;
    if (!Array.isArray(m) || m.length === 0) return null;

    const tp = json?.tracepoints;
    if (!Array.isArray(tp) || tp.length !== sample.length) {
      // Sin tracepoints utilizables → conservador: solo aceptar el caso simple de 1 matching.
      if (m.length !== 1) return null;
      const c: [number, number][] = m[0]?.geometry?.coordinates || [];
      const conf = Number(m[0]?.confidence) || 0;
      // 1 matching nativo = geometría de vía PURA (sin rama de fix crudo) → 0 sucio por construcción.
      return c.length >= 2 && conf > 0 ? { coords: c, confidence: conf, crudeFrac: 0, maxCrudoChordM: 0, esCrudo: c.map(() => false) } : null;
    }

    const CONF_FRAG = 0.4;
    const keep = m.map((x: any) => (Number(x?.confidence) || 0) >= CONF_FRAG);
    const emitidos = new Set<number>();   // cada fragmento se emite UNA vez (1ª aparición en orden)
    const via: [number, number][] = [];
    // esCrudo POR VÉRTICE (alineado 1:1 con via): true = fix crudo de RED (acc>ACC_CONFIABLE_M) → se
    // ruteará por la ruta prevista (nunca recta sobre casas); false = geometría de vía Mapbox O crudo de
    // CHIP (acc≤20, que hugea la pista → se dibuja medido, como el legacy). Base del "no dibujar rectas".
    const esCrudo: boolean[] = [];
    let cubiertos = 0;
    // Métricas de SUCIEDAD del match (para la stickiness monótona del ajustador). NO tocan la
    // geometría; solo cuantifican cuánto de la traza es fix crudo (recta) vs vía real:
    //  • crudeFrac      = fixes crudos emitidos / vértices totales (0 = vía pura como #1138).
    //  • maxCrudoChordM = la cuerda más larga con un extremo crudo (road↔crudo o crudo↔crudo) =
    //    la "recta que cruza techos" medida directamente. Las cuerdas road→road interiores de un
    //    fragmento NO cuentan (son cortas y siguen la vía).
    let crudos = 0;
    let lastPt: [number, number] | null = null;   // última coord emitida
    let lastCrude = false;                         // ¿la última coord emitida fue un fix crudo?
    let maxCC = 0;
    for (let k = 0; k < sample.length; k++) {
      const t: any = tp[k];
      const mi: number | null = t && t.matchings_index != null ? t.matchings_index : null;
      if (mi != null && keep[mi]) {
        cubiertos++;
        if (!emitidos.has(mi)) {
          emitidos.add(mi);
          const g = (m[mi]?.geometry?.coordinates as [number, number][]) || [];
          if (g.length) {
            // Junta con lo previo: solo la mido si el lado previo era crudo (road↔crudo).
            if (lastPt && lastCrude) maxCC = Math.max(maxCC, distM(lastPt[1], lastPt[0], g[0][1], g[0][0]));
            via.push(...g);
            for (let j = 0; j < g.length; j++) esCrudo.push(false);   // geometría de vía Mapbox
            lastPt = g[g.length - 1];
            lastCrude = false;
          }
        }
      } else if (mi != null) {
        const p: [number, number] = [sample[k].lng, sample[k].lat];   // fragmento dudoso → el fix REAL del bus
        if (lastPt) maxCC = Math.max(maxCC, distM(lastPt[1], lastPt[0], p[1], p[0]));
        via.push(p);
        esCrudo.push((sample[k].acc || 25) > ACC_CONFIABLE_M);   // crudo de RED → rutear; crudo de CHIP (≤20m) → medido
        crudos++;
        lastPt = p;
        lastCrude = true;
      }
      // mi == null: tidy lo descartó como outlier/redundante → omitir (rechazo de outliers gratis)
    }
    const confidence = cubiertos / sample.length;
    const crudeFrac = via.length ? crudos / via.length : 1;
    return via.length >= 2 ? { coords: via, confidence, crudeFrac, maxCrudoChordM: maxCC, esCrudo } : null;
  } catch { return null; }
}

// Ajusta UNA ventana (≤100 puntos densos) a la vía. `confidence` = fracción de la ventana pegada
// a fragmentos confiables; si ni el 40% se pudo pegar (GPS pobre / parado en red), cae a la huella
// cruda suavizada por DISTANCIA: aplana el zigzag lento sin recortar las curvas rápidas.
// `snapped` = si logró pegar a la vía (confianza ≥ 0.4) o cayó al crudo → el ajustador lo usa para
// NO revertir a zigzag un tramo ya pegado (stickiness: con GPS de red la confianza baila y sin esto
// la cola parpadea entre pegada y cruda cada ciclo).
async function matchVentanaOrig(ventana: MatchPt[], token: string): Promise<{ coords: [number, number][]; snapped: boolean; crudeFrac: number; maxCrudoChordM: number; esCrudo: boolean[] }> {
  const r = await mapMatchTrailOrig(ventana, token);
  if (r && r.confidence >= 0.4 && r.coords.length >= 2) return { coords: r.coords, snapped: true, crudeFrac: r.crudeFrac, maxCrudoChordM: r.maxCrudoChordM, esCrudo: r.esCrudo };
  const suav = suavizarPorDistancia(ventana);   // fallback: crudo suavizado por distancia (no pegó a vía)
  const coords = suav.length >= 2 ? suav.map(p => [p.lng, p.lat] as [number, number]) : [];
  // Por vértice: crudo de RED (acc>20) se ruteará; un fallback de CHIP (acc≤20) queda medido → protege el oro.
  return { coords, snapped: false, crudeFrac: 1, maxCrudoChordM: 0, esCrudo: coords.map((_, i) => (suav[i]?.acc || 25) > ACC_CONFIABLE_M) };
}

async function congelarPrefijoLimpioOrig(
  ventana: MatchPt[], token: string, cancelado?: () => boolean,
): Promise<{ len: number; coords: [number, number][]; esCrudo: boolean[] } | null> {
  const MIN = 40;
  let lo = MIN, hi = ventana.length - 2, bestLen = 0, bestCoords: [number, number][] | null = null, bestEsCrudo: boolean[] | null = null;
  while (lo <= hi) {
    if (cancelado?.()) break;
    const mid = (lo + hi) >> 1;
    const r = await matchVentanaOrig(ventana.slice(0, mid), token);
    if (r.snapped && r.crudeFrac <= 0.1) { bestLen = mid; bestCoords = r.coords; bestEsCrudo = r.esCrudo; lo = mid + 1; }
    else hi = mid - 1;
  }
  return bestLen >= MIN && bestCoords ? { len: bestLen, coords: bestCoords, esCrudo: bestEsCrudo || [] } : null;
}

function crearAjustadorHuellaOrig() {
  // La API topa en MAX coords/llamada. Cada ventana se arma con MAX puntos COMO MÁXIMO
  // (solape INCLUIDO) para que prepararPuntos NUNCA la diezme. Antes la ventana medía
  // WIN+SOLAPE = 101 > 100 → prepararPuntos tomaba 1 de cada 2 → media densidad → Map
  // Matching de baja confianza → RECTAS en servicios largos (todas las ventanas menos la
  // 1ª). Reservar el solape dentro del presupuesto de 100 elimina ese diezmado.
  const MAX = 100;             // máximo de coords por llamada de Map Matching (cap de la API)
  const SOLAPE = 1;            // punto(s) compartido(s) entre ventanas contiguas para unirlas
  const NUEVOS = MAX - SOLAPE; // puntos NUEVOS que congela cada ventana (deja sitio al solape)
  // Ventanas COMPLETAS matcheadas EN PARALELO al abrir con backlog (viaje largo ya andado). 4 es
  // seguro para la cuota de Map Matching (300 req/min): un backlog de 30 ventanas son 30 llamadas
  // en ~5-8 s, muy por debajo del tope, y recorta la primera huella de ~20-25 s a ~5-6 s.
  const PARALELO_VENTANAS = 4;
  // Umbrales ABSOLUTOS del gate de contenido-crudo (stickiness monótona). Una cola nueva solo puede
  // desplazar a "conservar la limpia" si supera este piso de suciedad. Para GPS bueno (#1138) el match
  // no tiene fixes crudos → crudeFrac=0 y maxCrudoChordM=0 → nunca "sucio" → el gate colapsa EXACTO al
  // legacy (sobrescribe siempre) → huella byte-idéntica. Calibrables (ver medición #954/#946/#1138).
  const CRUDE_SUCIO = 0.30;   // fracción de fixes crudos que marca la cola como "sucia" (rectas)
  const EMPALME_MAX = 120;    // m: cuerda con extremo crudo más larga tolerada antes de marcar "sucia"
  const congeladas: [number, number][][] = [];
  let congeladoHasta = 0;
  let lastMatchMs = 0;
  let lastTail: { lat: number; lng: number } | null = null;
  let lastCola: [number, number][] = [];   // stickiness: última geometría de la COLA (para no revertir a crudo lo ya pegado)
  let lastColaSnapped = false;              // ¿la última cola conservada estaba pegada a la vía?
  let lastColaCrude = 1;                    // crudeFrac de la geometría RETENIDA (1 = nada limpio aún)
  const congeladasSnapped: boolean[] = [];  // (histórico; los rangos ahora se derivan de esCrudo POR VÉRTICE)
  const congeladasEsCrudo: boolean[][] = []; // esCrudo por vértice de cada ventana congelada (LOCKSTEP con congeladas)
  let lastColaEsCrudo: boolean[] = [];       // esCrudo por vértice de la cola retenida (LOCKSTEP con lastCola)
  let ultimoCrudoRanges: Array<[number, number]> = [];  // rangos [ini,fin] de crudo POR VÉRTICE (incl. mixtas) a rellenar por ruta; excluye la punta viva
  let ultimoColaClean = 0;                  // último índice de VÍA limpia en las coords devueltas (frontera de colaViva)
  let ultimaColaSnapped = true;             // ¿el ÚLTIMO match de la cola viva pegó a la vía? (false = punta degradada)
  let ultimoEsCrudo: boolean[] = [];        // esCrudo POR VÉRTICE del último `ajustar` (alineado 1:1 con las coords devueltas)

  return {
    async ajustar(
      limpio: MatchPt[],
      token: string,
      cancelado?: () => boolean
    ): Promise<[number, number][] | null> {
      if (!token || limpio.length < 2) return null;
      const cola = limpio[limpio.length - 1];
      // Cadencia ADAPTATIVA de Map Matching. El throttle fijo de 60 s hacía que la cola reciente se
      // dibujara CRUDA (zigzag off-road de fixes de red) hasta ~1 min, "arreglándose sola" al
      // siguiente ajuste. Ahora: si la precisión reciente es DEGRADADA (la que zigzaguea) se re-ajusta
      // casi cada fetch (12 s) → pegado a la vía casi al instante; con GPS bueno el crudo ya va sobre
      // la pista y basta 60 s (no dispara llamadas a Mapbox en el caso común).
      const rec = limpio.slice(-12);
      const accsR = rec.map((p) => p.acc).sort((a, b) => a - b);
      const accMedR = accsR.length ? accsR[Math.floor(accsR.length / 2)] : 25;
      const throttleMs = accMedR > ACC_DEGRADADO_M ? 12000 : 60000;
      if (Date.now() - lastMatchMs < throttleMs) return null;
      // "Se movió" con umbral CONSCIENTE de la precisión: un bus PARADO con GPS de red jitterea
      // decenas de metros; con umbral fijo de 8 m eso contaría como movimiento y gastaría un match
      // ocioso cada 12 s. En degradado el umbral sube a la precisión mediana → el jitter no cuenta,
      // solo el avance REAL (a 46 km/h son ~150 m/ciclo, muy por encima).
      const umbralMov = Math.max(8, accMedR);
      const seMovio = !lastTail || distM(lastTail.lat, lastTail.lng, cola.lat, cola.lng) >= umbralMov;
      if (!seMovio && congeladas.length) return null;
      lastMatchMs = Date.now();
      lastTail = { lat: cola.lat, lng: cola.lng };

      // NUEVOS + 2 de margen (review): quitarPicosV puede re-juzgar los últimos ~2 puntos de la
      // cola en el ciclo siguiente (el último no tiene `next` aún). Sin margen, si el resto cae
      // exacto en 99 la ventana congelada incluiría un punto aún mutable → al eliminarse después,
      // los índices del prefijo se correrían y el pico quedaría horneado en la geometría congelada.
      const congeladoAntes = congeladoHasta;
      let loteMax = PARALELO_VENTANAS;   // adaptativo: 1 tras ventana sucia, 4 tras limpia (ver abajo)
      while (limpio.length - congeladoHasta >= NUEVOS + 2) {
        // LOTE PARALELO (fix ago-2026 "la huella tarda en crearse"): al abrir el modal a mitad de
        // un viaje largo hay 10-30 ventanas completas pendientes y matchearlas UNA POR UNA (un
        // await por llamada a Mapbox) tardaba 10-25 s. Aquí se PRE-LANZAN hasta PARALELO ventanas
        // con límites OPTIMISTAS (cada una asume que la anterior avanza NUEVOS — el caso común:
        // ventana limpia congelada completa) y los resultados se procesan EN ORDEN con la MISMA
        // lógica que el camino secuencial. Si una ventana avanza distinto de NUEVOS (prefijo
        // limpio), los límites de las siguientes ya no valen → se DESCARTAN esos resultados (solo
        // se pierde la llamada; jamás se hornea geometría con límites corridos) y el while
        // exterior re-arma el lote desde el límite correcto. Con GPS bueno (todas snapped) la
        // geometría es BYTE-IDÉNTICA a la secuencial: mismas ventanas, mismos límites, mismo orden.
        // LOTE ADAPTATIVO (review ago-2026): en régimen DEGRADADO sostenido (cada ventana sale
        // mixta → avanza por prefijo limpio ≠ NUEVOS) el lote de 4 tiraba 3 resultados por vuelta
        // (~40% más llamadas que el secuencial, en ráfagas 4× más densas). Tras una ventana sucia
        // el lote baja a 1 (= secuencial, cero desperdicio) y vuelve a PARALELO_VENTANAS cuando
        // congela una limpia completa (loteMax se ajusta al procesar, abajo).
        const lote: { ini: number; ventana: MatchPt[]; res: ReturnType<typeof matchVentanaOrig> }[] = [];
        let H = congeladoHasta;
        while (lote.length < loteMax && limpio.length - H >= NUEVOS + 2) {
          const ini = Math.max(0, H - SOLAPE);
          const ventana = limpio.slice(ini, ini + MAX);   // ≤ MAX SIEMPRE → no se diezma
          lote.push({ ini: H, ventana, res: matchVentanaOrig(ventana, token) });
          H += NUEVOS;
        }
        for (const w of lote) {
          const rw = await w.res;
          if (cancelado?.()) return null;
          if (w.ini !== congeladoHasta) break;   // una previa avanzó ≠ NUEVOS → límites corridos → descartar el resto
          if (rw.snapped) {
            // Ventana LIMPIA → congelar completa (caso común; GPS bueno #1138 IDÉNTICO al legacy).
            congeladas.push(rw.coords);
            congeladasSnapped.push(true);
            congeladasEsCrudo.push(rw.esCrudo);
            congeladoHasta += NUEVOS;
            loteMax = PARALELO_VENTANAS;   // régimen limpio → vale la pena pre-lanzar
          } else {
            loteMax = 1;                   // régimen degradado → secuencial (no desperdiciar lote)
            // Ventana CRUDA: el re-match completo ARRUINA los puntos viejos-buenos que trae la ventana (bug
            // #795: [0,60] pega limpio solo, pero [0,100] con la cola degradada sale crudo y RE-DIBUJA crudos
            // esos 60 buenos = "edita 20 puntos antes"). En vez de hornear crudo sobre lo bueno, se congela
            // SOLO el PREFIJO LIMPIO más largo (INMUTABLE); el resto degradado queda para el siguiente ciclo
            // (lo cubre puentesCrudos por la ruta). Así lo ya dibujado NO se re-edita.
            const pref = await congelarPrefijoLimpioOrig(w.ventana, token, cancelado);
            if (cancelado?.()) return null;
            if (pref) {
              congeladas.push(pref.coords);
              congeladasSnapped.push(true);
              congeladasEsCrudo.push(pref.esCrudo);
              congeladoHasta += Math.max(1, pref.len - SOLAPE);
            } else {
              // Ni el prefijo pega (degradación temprana) → congelar crudo y avanzar normal (genuino).
              congeladas.push(rw.coords);
              congeladasSnapped.push(false);
              congeladasEsCrudo.push(rw.esCrudo);
              congeladoHasta += NUEVOS;
            }
          }
        }
      }
      // Si congeló una ventana, la cola arranca de nuevo (otra región) → resetear la stickiness.
      if (congeladoHasta !== congeladoAntes) { lastCola = []; lastColaSnapped = false; lastColaCrude = 1; lastColaEsCrudo = []; }

      const colaVentana = limpio.slice(Math.max(0, congeladoHasta - SOLAPE));
      if (colaVentana.length >= 2) {
        const rc = await matchVentanaOrig(colaVentana, token);
        if (cancelado?.()) return null;
        ultimaColaSnapped = rc.snapped;   // señal para colaViva: si NO pegó, la punta viva sigue la ruta prevista
        // STICKINESS POR CONTENIDO-CRUDO: no revertir a rectas/crudo un tramo que ya se pegó a la vía.
        // El bug (#954): con GPS de red la cola puede PEGAR (snapped=true) pero MIXTA — trozos de vía
        // unidos por cuerdas crudas de 120-300 m (las "rectas que cruzan techos"), cobertura ~0.45. El
        // booleano `snapped` no la distinguía de una cola limpia (0.9) → la aceptaba y SOBRESCRIBÍA lo
        // ya bueno. Ahora se mide la SUCIEDAD del match (crudeFrac / cuerda cruda más larga) y solo se
        // sobrescribe con algo igual-o-más-limpio; si el match nuevo es MÁS sucio que lo retenido, se
        // CONSERVA la cola limpia y la punta la extiende colaViva con fixes reales. Dirección monótona:
        // lo pegado no se afea, solo se refina. (FASE 8 anti-parpadeo sigue viva vía `snapped`.)
        // Para #1138 (GPS bueno) crudeFrac/maxCrudoChordM son 0 → nuevoSucio nunca → idéntico al legacy.
        const nuevoSucio = rc.crudeFrac > CRUDE_SUCIO || rc.maxCrudoChordM > EMPALME_MAX;
        if (rc.snapped) {
          if (!(nuevoSucio && lastColaSnapped && rc.crudeFrac > lastColaCrude)) {
            lastCola = rc.coords; lastColaSnapped = true; lastColaCrude = rc.crudeFrac; lastColaEsCrudo = rc.esCrudo;
          }
        } else if (!lastColaSnapped) {
          lastCola = rc.coords; lastColaSnapped = false; lastColaCrude = 1; lastColaEsCrudo = rc.esCrudo;
        }
      }

      const todo = [...congeladas, lastCola].flat() as [number, number][];
      const esCrudoTodo = [...congeladasEsCrudo, lastColaEsCrudo].flat();   // alineado 1:1 con `todo`
      ultimoEsCrudo = esCrudoTodo;   // para colorearMatched: marcar `aprox` las cuerdas crudas largas que escapen a la supresión

      // Rangos de crudo POR VÉRTICE (esto SÍ incluye las ventanas MIXTAS: snapped=true con fixes crudos
      // de RED intercalados — el bug #875 de rectas naranjas sobre casas). Corridas contiguas de
      // esCrudoTodo=true sobre `todo`, fusionando las separadas por ≤1 vértice limpio (evita confeti).
      // Se EXCLUYE la corrida que toca el ÚLTIMO índice (punta viva → la cubre colaViva, no parpadea).
      const rangos: Array<[number, number]> = [];
      const n = Math.min(todo.length, esCrudoTodo.length);
      let idx = 0;
      while (idx < n) {
        if (esCrudoTodo[idx]) {
          let j = idx;
          while (j + 1 < n && (esCrudoTodo[j + 1] || (j + 2 < n && esCrudoTodo[j + 2]))) j++;   // fusiona ≤1 limpio
          rangos.push([idx, j]);
          idx = j + 1;
        } else idx++;
      }
      ultimoCrudoRanges = rangos.filter(([, e]) => e < n - 1);   // fuera la corrida de la punta viva (colaViva la cubre)

      // Frontera de la cola VIVA = último vértice de VÍA limpia. colaViva ancla ahí y el consumidor
      // NO dibuja el crudo de la punta como medido (lo rellena por la ruta). GPS bueno → n-1 → sin cambios.
      ultimoColaClean = n - 1;
      for (let k = n - 1; k >= 0; k--) { if (!esCrudoTodo[k]) { ultimoColaClean = k; break; } }

      return todo.length >= 2 ? todo : null;
    },
    // Rangos [ini,fin] de crudo POR VÉRTICE en las coords del último `ajustar` (para rutear como estimado).
    leerCrudoRanges: () => ultimoCrudoRanges,
    // esCrudo POR VÉRTICE (alineado con las coords del último `ajustar`) — para el corte/aprox de colorearMatched.
    leerEsCrudo: () => ultimoEsCrudo,
    // ¿El último match de la cola VIVA pegó a la vía? (false = punta degradada → colaViva sigue la ruta).
    leerColaSnapped: () => ultimaColaSnapped,
    // Último índice de VÍA limpia en las coords devueltas (frontera de colaViva; corta el crudo de la punta).
    leerColaClean: () => ultimoColaClean,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// EL BLOQUE ORIGINAL DE /api/cliente/gps (modo huella), COPIADO LITERAL de HEAD. Únicos cambios:
// envuelto en una función (recibe `supabase` y `body`) y `return NextResponse.json(x)` → `return (x)`.
// ═════════════════════════════════════════════════════════════════════════════════════════
const RutaOriginal = (() => {
// created_at es la columna fiable (la setea el insert del conductor); timestamp puede
// no venir. Se ordena/dedupea por la más reciente de ambas.
const tMs = (g: any) => {
  const a = g?.created_at ? new Date(g.created_at).getTime() : 0;
  const b = g?.timestamp ? new Date(g.timestamp).getTime() : 0;
  return Math.max(a || 0, b || 0);
};

const keyDe = (g: any) =>
  g.conductor_tercero_id != null ? `ct${g.conductor_tercero_id}`
  : g.conductor_id != null        ? `c${g.conductor_id}`
  : g.vehiculo_tercero_id != null ? `vt${g.vehiculo_tercero_id}`
  : g.vehiculo_id != null         ? `v${g.vehiculo_id}`
  : g.reserva_id != null          ? `r${g.reserva_id}` : "?";

// Garantiza que `timestamp` siempre tenga valor (cae a created_at). Los consumidores
// del portal calculan antigüedad con `timestamp`; si viniera null marcarían "sin señal".
const norm = (g: any) => (g ? { ...g, timestamp: g.timestamp ?? g.created_at ?? null } : g);

// Corte por tramos contiguos: un hueco > gapMs = la app dejó de transmitir = otro viaje (dentro
// de un servicio el conductor late cada ~25 s aun detenido). Sin él, la huella dibuja una recta
// larga uniendo el fin del viaje A con el inicio del viaje B. Ver tramoDelServicio, abajo.
const HUECO_VIAJE_MS = 30 * 60 * 1000; // 30 min: separa servicios sin cortar paradas/cortes de señal

// Cuánto ANTES de la hora programada puede empezar a contar el GPS, y solo con el inicio ya
// confirmado: es el traslado cochera → primer paradero, que sí pertenece al servicio.
const MARGEN_PREVIO_MS = 45 * 60 * 1000;
// Techo de duración de la ventana. 26 h y no 12: hay tours full day de hasta 24 h y una ventana
// más corta que el propio servicio le cortaría la huella por la mitad al final del viaje.
const DURACION_MAX_MS = 26 * 60 * 60 * 1000;

/** "HH:MM[:SS]" del día `fecha` (Lima, UTC-5 sin DST) en ms epoch. Igual que api/gps-salud. */
function limaMs(fecha: string | null | undefined, hora: string | null | undefined): number | null {
  if (!fecha) return null;
  const h = hora ? String(hora).slice(0, 8).padEnd(8, ":00").slice(0, 8) : "00:00:00";
  const t = Date.parse(`${fecha}T${h}-05:00`);
  return Number.isFinite(t) ? t : null;
}
/**
 * Parte la huella en tramos contiguos y devuelve EL DEL SERVICIO: el primer tramo que seguía
 * vivo a la hora de salida programada (`refTs`). La rama por-vehículo puede traer varios viajes
 * del mismo bus dentro de la ventana, y "quedarse con el último" —lo que hacía antes— solo
 * acierta cuando el servicio consultado es el que está ocurriendo AHORA: al abrir uno de ayer
 * devolvía el viaje de hoy.
 * LÍMITE CONOCIDO: si el bus hizo un traslado con hueco propio después de la hora de salida y el
 * servicio arrancó aún más tarde, gana el traslado. No se adivina más — el caso lo resuelve la
 * evidencia dura (puntos con reserva_id) y esta rama es el fallback.
 * `filas` viene ordenado por created_at asc.
 */
function tramoDelServicio(filas: any[], gapMs: number, refTs: number | null): any[] {
  if (filas.length < 2) return filas;
  const tramos: any[][] = [];
  let inicio = 0;
  for (let i = 1; i < filas.length; i++) {
    if (tMs(filas[i]) - tMs(filas[i - 1]) > gapMs) { tramos.push(filas.slice(inicio, i)); inicio = i; }
  }
  tramos.push(filas.slice(inicio));
  const ultimo = tramos[tramos.length - 1];
  if (refTs == null) return ultimo;   // sin hora programada no hay con qué anclar → el más reciente
  return tramos.find(t => tMs(t[t.length - 1]) >= refTs) ?? ultimo;
}
async function huella(supabase: any, body: any): Promise<any> {
    if (body.huella) {
      const reservaId         = body.reservaId ?? null;
      const vehiculoId        = body.vehiculoId ?? null;
      const vehiculoTerceroId = body.vehiculoTerceroId ?? null;
      const HCOLS = "lat,lng,velocidad,rumbo,created_at,timestamp,reserva_id,vehiculo_id,vehiculo_tercero_id,precision_m,fix_ts";
      let filas: any[] = [];
      let viaVehiculo = false; // ¿se usó la rama por-vehículo (sin reserva_id)?
      // PAGINADO (paginarFilas): PostgREST recorta toda respuesta al max-rows del servidor
      // (1000) aunque se pida .limit(5000) → la huella se congelaba en el punto 1000 y el
      // resto del viaje salía como "tramo estimado". Orden created_at+id = páginas estables.
      if (reservaId != null) {
        filas = await paginarFilas(() =>
          supabase.from("ubicaciones_gps").select(HCOLS)
            .eq("reserva_id", reservaId)
            .order("created_at", { ascending: true }).order("id", { ascending: true }));
      }
      // ── VENTANA DEL SERVICIO ─────────────────────────────────────────────────
      // Un punto GPS solo puede hablar de ESTE servicio si cae dentro de su ventana. La rama
      // por-vehículo no tiene reserva_id y sin esta cota traía "las últimas 12 h del bus": el
      // traslado desde cochera, el modo conectado-libre (enviarUbicacion manda reserva_id null
      // mientras no hay recorrido iniciado — app/conductor/page.tsx:1268) y hasta el servicio
      // anterior si la separación fue <30 min. Esa huella ajena SEMBRABA el motor de avance
      // (lib/avance-paradas.ts) y un servicio que aún no arrancaba aparecía con paraderos
      // "detectados por GPS", el itinerario al 33 % y un ETA calculado desde una parada por la
      // que el bus nunca pasó.
      const rsv = reservaId != null
        ? (await supabase.from("reservas").select("fecha_servicio,hora_servicio,estado")
            .eq("id", reservaId).maybeSingle()).data
        : null;
      const progMs = limaMs(rsv?.fecha_servicio, rsv?.hora_servicio);
      // EVIDENCIA DURA DE INICIO, en este orden: puntos atados a la reserva (la app del conductor
      // ata cada fix al servicio al iniciar el recorrido) → estado puesto por una persona.
      const iniciado = filas.length > 0 || rsv?.estado === "en_curso" || rsv?.estado === "finalizada";
      // Con el inicio confirmado la ventana se abre antes: ese traslado al primer paradero SÍ es
      // parte del servicio. Sin confirmar, abre en la hora programada EXACTA — antes de esa hora
      // nadie puede afirmar que el bus se mueve por este servicio, y en una ruta de retorno pasa
      // cerca de paraderos posteriores camino al origen: justo el movimiento que producía los
      // falsos "ya pasó".
      const T0 = progMs != null ? progMs - (iniciado ? MARGEN_PREVIO_MS : 0) : null;
      const T1 = T0 != null ? T0 + DURACION_MAX_MS : null;
      const antesDeLaVentana = T0 != null && Date.now() < T0;
      if (filas.length === 0 && (vehiculoTerceroId != null || vehiculoId != null) && !antesDeLaVentana) {
        // Tercero: los puntos no llevan reserva_id. Ventana del servicio; sin fecha/hora
        // programada (dato incompleto) se cae al comportamiento histórico de las últimas 12 h.
        const desde = new Date(T0 ?? Date.now() - 12 * 60 * 60 * 1000).toISOString();
        const hasta = T1 != null ? new Date(Math.min(T1, Date.now())).toISOString() : null;
        filas = await paginarFilas(() => {
          let q = supabase.from("ubicaciones_gps").select(HCOLS)
            .gte("created_at", desde)
            .order("created_at", { ascending: true }).order("id", { ascending: true });
          if (hasta) q = q.lte("created_at", hasta);
          return vehiculoTerceroId != null ? q.eq("vehiculo_tercero_id", vehiculoTerceroId) : q.eq("vehiculo_id", vehiculoId);
        });
        viaVehiculo = true;
      }
      // Rama por-vehículo: la ventana del servicio todavía puede contener dos viajes del mismo
      // bus (un full day de 24 h con relevo a media tarde) → quedarnos solo con el más reciente.
      // La rama por reserva_id ya está acotada a un único servicio, no se toca.
      const base = viaVehiculo ? tramoDelServicio(filas, HUECO_VIAJE_MS, progMs) : filas;
      // Coherencia escritura↔lectura: el conductor (enviarUbicacion) acepta fixes hasta
      // 1500 m a propósito (tablets/FUSED por red sin chip GPS) y DELEGA el suavizado a la
      // lectura. Si aquí cortáramos a 80 m, esos puntos (80–1500 m) se perderían → huella
      // vacía o con huecos → rectas, justo en equipos posicionados por red. La imprecisión
      // ya la absorben limpiarHuella + los radii de Map Matching (acc·1.5), así que basta
      // descartar solo la basura de torre celular (el MISMO techo que la escritura).
      const filasOk = base.filter((p: any) => p.precision_m == null || p.precision_m <= PRECISION_MAX_HUELLA_M);
      // `servicio` viaja con la huella para que el modal aplique la MISMA cota al fix EN VIVO
      // (que no pasa por aquí: llega por el modo individual) y no vuelva a envenenar el motor
      // por la puerta de atrás. `desdeTs` nunca recorta evidencia dura: si hay puntos atados a
      // la reserva manda el primero de ellos cuando es anterior a T0 — el bus pudo salir antes
      // de lo programado y ese tramo es del servicio, lo dice su propio reserva_id.
      const primeroReservaTs = !viaVehiculo && filasOk.length ? tMs(filasOk[0]) : null;
      const desdeTs = T0 == null ? null : primeroReservaTs ? Math.min(T0, primeroReservaTs) : T0;
      return ({
        huella: filasOk.map(norm),
        servicio: {
          iniciado, desdeTs, programadoTs: progMs,
          // El veredicto lo emite el SERVIDOR — es el mismo que acaba de dejar la huella vacía.
          // Recalcularlo en el cliente con su propio reloj abre la puerta a que discrepen.
          esperando: antesDeLaVentana && !iniciado,
          estado: rsv?.estado ?? null,
          via: viaVehiculo ? "vehiculo" : filasOk.length ? "reserva" : "ninguna",
        },
      });
    }
    return null;
}
return { huella, limaMs, tramoDelServicio, tMs, HUECO_VIAJE_MS, MARGEN_PREVIO_MS, DURACION_MAX_MS, norm };
})();

// ═════════════════════════════════════════════════════════════════════════════════════════
// Un MAPBOX FALSO determinista: la respuesta depende solo de la URL (y del nº de intento, para el 429
// que se reintenta). Corta la red, contesta 429/500/422, NoMatch, fragmentos de baja confianza, puntos
// descartados por tidy y respuestas sin tracepoints.
// ═════════════════════════════════════════════════════════════════════════════════════════
type ModoFake = {
  p429?: number; p429Siempre?: number; p500?: number; pRed?: number; p422?: number;
  pSinTp?: number; pVacio?: number; confBaja?: number; tidyNull?: number; maxFrag?: number;
};
type Fake = { fetch: (url: string) => Promise<Response>; urls: string[]; status: Array<number | "red"> };
function crearFake(modo: ModoFake): Fake {
  const intentos = new Map<string, number>();
  const urls: string[] = [];
  const status: Array<number | "red"> = [];
  const fetchFalso = async (url: string): Promise<Response> => {
    urls.push(url);
    const k = (intentos.get(url) ?? 0) + 1;
    intentos.set(url, k);
    const r = (sal: string) => fnv(`${url}#${sal}`) / 2 ** 32;
    const resp = (st: number, body: any) => { status.push(st); return new Response(JSON.stringify(body), { status: st }); };
    if (r("red") < (modo.pRed ?? 0)) { status.push("red"); throw new TypeError("fetch failed"); }
    if (r("429s") < (modo.p429Siempre ?? 0)) return resp(429, { message: "Too Many Requests" });
    if (k === 1 && r("429") < (modo.p429 ?? 0)) return resp(429, { message: "Too Many Requests" });
    if (r("500") < (modo.p500 ?? 0)) return resp(500, { message: "Server Error" });
    if (r("422") < (modo.p422 ?? 0)) return resp(422, { code: "InvalidInput" });
    const tramoCoords = url.split("/driving/")[1].split("?")[0];
    const pts = tramoCoords.split(";").map((c) => c.split(",").map(Number) as [number, number]);
    if (r("vacio") < (modo.pVacio ?? 0)) return resp(200, { code: "NoMatch", matchings: [] });
    const nFrag = Math.min(pts.length, 1 + Math.floor(r("frag") * (modo.maxFrag ?? 1)));
    // cortes contiguos
    const cortes = new Set<number>();
    for (let j = 1; j < nFrag; j++) cortes.add(1 + Math.floor(r(`corte${j}`) * (pts.length - 1)));
    const fragDe: number[] = [];
    let fr = 0;
    for (let i = 0; i < pts.length; i++) { if (cortes.has(i)) fr++; fragDe.push(fr); }
    const nf = fr + 1;
    const matchings: any[] = [];
    for (let j = 0; j < nf; j++) {
      const mine = pts.filter((_, i) => fragDe[i] === j);
      const g: [number, number][] = [];
      for (let i = 0; i < mine.length; i++) {
        const [lng, lat] = mine[i];
        g.push([Math.round(lng * 1e4) / 1e4 + 0.00001 * r(`gx${j}.${i}`), Math.round(lat * 1e4) / 1e4]);
        if (i + 1 < mine.length) g.push([lng + (mine[i + 1][0] - lng) * 0.37, lat + (mine[i + 1][1] - lat) * 0.37]);
      }
      const conf = r(`conf${j}`) < (modo.confBaja ?? 0) ? 0.1 * r(`cb${j}`) : 0.45 + 0.55 * r(`ca${j}`);
      matchings.push({ confidence: conf, geometry: { type: "LineString", coordinates: g } });
    }
    const tracepoints = pts.map((_, i) => (r(`tp${i}`) < (modo.tidyNull ?? 0) ? null : { matchings_index: fragDe[i] }));
    if (r("sintp") < (modo.pSinTp ?? 0)) return resp(200, { code: "Ok", matchings });
    return resp(200, { code: "Ok", matchings, tracepoints });
  };
  return { fetch: fetchFalso, urls, status };
}
const MODOS: Record<string, ModoFake> = {
  limpio: {},
  ruidoso: { maxFrag: 3, confBaja: 0.3, tidyNull: 0.05, pSinTp: 0.05, pVacio: 0.03 },
  fallos: { maxFrag: 3, confBaja: 0.3, tidyNull: 0.05, pSinTp: 0.05, pVacio: 0.03, p429: 0.2, p429Siempre: 0.03, p500: 0.05, pRed: 0.03, p422: 0.03 },
};

// ═════════════════════════════════════════════════════════════════════════════════════════
// EL CORPUS: filas crudas de ubicaciones_gps de viajes sintéticos → `huellaDeFilas(...).limpio`, la
// misma canalización del modal.
// ═════════════════════════════════════════════════════════════════════════════════════════
const T_BASE = Date.UTC(2026, 9, 9, 11, 0, 0);   // 06:00 Lima
type Fila = Record<string, any>;
let idFila = 1;
function viaje(o: { n: number; paso?: number; kmh?: number; acc: () => number; t0?: number; lat0?: number; lng0?: number; reservaId?: number | null; vt?: number | null; v?: number | null; paradas?: number }): Fila[] {
  const out: Fila[] = [];
  const paso = o.paso ?? 3;
  let lat = o.lat0 ?? -12.05, lng = o.lng0 ?? -77.03;
  let rumbo = rnd() * 2 * Math.PI;
  let t = o.t0 ?? T_BASE;
  let parado = 0;
  for (let i = 0; i < o.n; i++) {
    if (parado > 0) parado--;
    else if (o.paradas && rnd() < o.paradas) parado = 5 + Math.floor(rnd() * 40);
    if (rnd() < 0.08) rumbo += (rnd() - 0.5) * 1.6;
    const kmh = parado > 0 ? 0 : (o.kmh ?? 40) * (0.6 + 0.8 * rnd());
    const d = (kmh / 3.6) * paso;
    lat += (d * Math.cos(rumbo)) / 111_320;
    lng += (d * Math.sin(rumbo)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    const acc = o.acc();
    const j = acc / 111_320;
    out.push({
      id: idFila++,
      lat: +(lat + (rnd() - 0.5) * j).toFixed(7), lng: +(lng + (rnd() - 0.5) * j).toFixed(7),
      velocidad: Math.round(kmh), rumbo: Math.round((rumbo * 180) / Math.PI + 360) % 360,
      precision_m: acc, created_at: new Date(t).toISOString(), timestamp: null,
      fix_ts: new Date(t - 400).toISOString(),
      reserva_id: o.reservaId ?? null, vehiculo_id: o.v ?? null, vehiculo_tercero_id: o.vt ?? null,
    });
    t += paso * 1000;
  }
  return out;
}
const accChip = () => 3 + Math.round(rnd() * 6);
const accRed = () => 30 + Math.round(rnd() * 120);
const accMixto = () => (rnd() < 0.7 ? accChip() : accRed());
const CORPUS: Array<{ nombre: string; filas: Fila[] }> = [
  { nombre: "chip bueno", filas: viaje({ n: 420, acc: accChip, reservaId: 101 }) },
  { nombre: "red degradada", filas: viaje({ n: 520, acc: accRed, paradas: 0.01, reservaId: 102 }) },
  { nombre: "servicio corto (red)", filas: viaje({ n: 75, acc: () => 60 + Math.round(rnd() * 40), reservaId: 103 }) },
  { nombre: "backlog largo", filas: viaje({ n: 3200, acc: accMixto, paradas: 0.004, reservaId: 104 }) },
  { nombre: "mixto con paradas", filas: viaje({ n: 700, acc: accMixto, paradas: 0.02, reservaId: 105 }) },
];
const limpioDe = (filas: Fila[]) => H.huellaDeFilas(filas).limpio;

// Sin esperas reales: el 429 de mapMatchTrail espera 1,2 s y 2,4 s entre reintentos. Las dos versiones
// usan el mismo setTimeout global, así que reemplazarlo por un microtask no favorece a ninguna.
const setTimeoutReal = globalThis.setTimeout;
const fetchReal = globalThis.fetch;
const dateNowReal = Date.now;
function sinEsperas() { (globalThis as any).setTimeout = (fn: () => void) => { Promise.resolve().then(fn); return 0; }; }
function conEsperas() { (globalThis as any).setTimeout = setTimeoutReal; }
const fetchQueRevienta = (async () => { throw new Error("el fetch global NO debía usarse"); }) as any;

type SalidaAjuste = { r: any; esCrudo: boolean[]; crudoRanges: Array<[number, number]>; colaClean: number; colaSnapped: boolean };
const leerAj = (aj: any, r: any): SalidaAjuste => ({ r, esCrudo: aj.leerEsCrudo(), crudoRanges: aj.leerCrudoRanges(), colaClean: aj.leerColaClean(), colaSnapped: aj.leerColaSnapped() });

// LA DIVERGENCIA DECLARADA (14-10-2026, caso #1298): un fix de chip que Map Matching no pegó y que es
// extremo de una recta larga EN MARCHA pasa a `esCrudo` (H.fixEnRectaEnMarcha). Todo lo demás —las
// coordenadas, `snapped`, `crudeFrac`, las llamadas— sale idéntico; `esCrudo` solo puede GANAR
// verdaderos (nunca perderlos), y los rangos se derivan de ese `esCrudo` por rangosDeCrudo.
let crudosNuevos = 0;
const esSuperset = (o: boolean[] | undefined, n: boolean[] | undefined): boolean => {
  if (!o || !n) return o === n;
  if (o.length !== n.length) return false;
  for (let i = 0; i < o.length; i++) { if (o[i] && !n[i]) return false; if (n[i] && !o[i]) crudosNuevos++; }
  return true;
};
const sinCrudo = (x: any) => (x && typeof x === "object" ? { ...x, esCrudo: undefined } : x);
const salidaDeclarada = (o: SalidaAjuste, n: SalidaAjuste): boolean => {
  if (JSON.stringify(o.r) !== JSON.stringify(n.r) || o.colaSnapped !== n.colaSnapped) return false;
  if (!esSuperset(o.esCrudo, n.esCrudo)) return false;
  if (n.r == null) return true;
  const esp = H.rangosDeCrudo(n.esCrudo, Math.min(n.r.length, n.esCrudo.length));
  return JSON.stringify(esp.crudoRanges) === JSON.stringify(n.crudoRanges) && esp.colaClean === n.colaClean;
};
const matchDeclarado = (o: any, n: any): boolean =>
  JSON.stringify(sinCrudo(o)) === JSON.stringify(sinCrudo(n)) && esSuperset(o?.esCrudo, n?.esCrudo);

// ══ 0 · la red inyectable ═════════════════════════════════════════════════════════════════
seccion("0 · mapMatchTrail / matchVentana / crearAjustadorHuella con fetch inyectado = los originales (salvo la divergencia declarada)");
type CorridaMemoria = { caso: string; modo: string; limpio: any[]; salida: SalidaAjuste };
const MEMORIA: CorridaMemoria[] = [];
sinEsperas();
{
  // (a) una pasada completa por caso y modo: original (fetch global), nuevo con el defecto (fetch
  // global) y nuevo con el fetch INYECTADO (y el global reventando si alguien lo usara).
  for (const c of CORPUS) {
    const limpio = limpioDe(c.filas);
    for (const [modo, cfg] of Object.entries(MODOS)) {
      const f1 = crearFake(cfg), f2 = crearFake(cfg), f3 = crearFake(cfg);
      (globalThis as any).fetch = f1.fetch;
      const ajO = crearAjustadorHuellaOrig();
      const sO = leerAj(ajO, await ajO.ajustar(limpio, "tok"));
      (globalThis as any).fetch = f2.fetch;
      const ajD = H.crearAjustadorHuella();
      const sD = leerAj(ajD, await ajD.ajustar(limpio, "tok"));
      (globalThis as any).fetch = fetchQueRevienta;
      const ajI = H.crearAjustadorHuella({ fetch: f3.fetch });
      const sI = leerAj(ajI, await ajI.ajustar(limpio, "tok"));
      chk(`${c.nombre} · ${modo}: defecto = original (${limpio.length} pts, ${f1.urls.length} llamadas)`, salidaDeclarada(sO, sD) && JSON.stringify(f1.urls) === JSON.stringify(f2.urls));
      chk(`${c.nombre} · ${modo}: inyectado = defecto`, JSON.stringify(sD) === JSON.stringify(sI) && JSON.stringify(f1.urls) === JSON.stringify(f3.urls));
      if (modo !== "limpio") chk(`${c.nombre} · ${modo}: el escenario no es trivial (${f1.urls.length} llamadas, ${sO.esCrudo.filter(Boolean).length} vértices crudos)`,
        c.nombre.startsWith("servicio corto") ? f1.urls.length >= 1 : f1.urls.length >= 2);
      MEMORIA.push({ caso: c.nombre, modo, limpio, salida: sI });
    }
  }
  const fallosVistos = new Set<string>();
  for (const cfg of [MODOS.fallos]) {
    const f = crearFake(cfg);
    (globalThis as any).fetch = fetchQueRevienta;
    const aj = H.crearAjustadorHuella({ fetch: f.fetch });
    await aj.ajustar(limpioDe(CORPUS[3].filas), "tok");
    for (const s of f.status) fallosVistos.add(String(s));
  }
  chk(`el Mapbox falso sí contestó 429, 500, 422 y cortó la red en el backlog (${[...fallosVistos].join(",")})`,
    ["429", "500", "422", "red", "200"].every((x) => fallosVistos.has(x)));

  // (b) uso INCREMENTAL, como el modal (un ajustador por apertura, un ciclo cada 13 s con la huella
  // creciendo), con el reloj simulado: el throttle y el congelado deciden lo mismo.
  for (const c of [CORPUS[1], CORPUS[2], CORPUS[4], CORPUS[0]]) {
    const limpio = limpioDe(c.filas);
    for (const modo of ["ruidoso", "fallos"]) {
      const corrida = async (crear: () => any, fake: Fake, global: boolean) => {
        let reloj = T_BASE;
        (Date as any).now = () => reloj;
        (globalThis as any).fetch = global ? fake.fetch : fetchQueRevienta;
        const aj = crear();
        const pasos: string[] = [];
        for (let L = 20; L <= limpio.length + 36; L += 37) {
          reloj += 13_000;
          const r = await aj.ajustar(limpio.slice(0, Math.min(L, limpio.length)), "tok");
          pasos.push(JSON.stringify(leerAj(aj, r)));
        }
        (Date as any).now = dateNowReal;
        return pasos;
      };
      const fO = crearFake(MODOS[modo]), fD = crearFake(MODOS[modo]), fI = crearFake(MODOS[modo]);
      const pO = await corrida(() => crearAjustadorHuellaOrig(), fO, true);
      const pD = await corrida(() => H.crearAjustadorHuella(), fD, true);
      const pI = await corrida(() => H.crearAjustadorHuella({ fetch: fI.fetch }), fI, false);
      const nulos = pO.filter((p) => p.startsWith('{"r":null')).length;
      chk(`incremental ${c.nombre} · ${modo}: ${pO.length} ciclos idénticos (defecto e inyectado), ${fO.urls.length} llamadas, ${nulos} ciclos sin nada nuevo`,
        pO.length === pD.length && pO.every((x, i) => salidaDeclarada(JSON.parse(x), JSON.parse(pD[i]))) && JSON.stringify(pD) === JSON.stringify(pI)
        && JSON.stringify(fO.urls) === JSON.stringify(fD.urls) && JSON.stringify(fO.urls) === JSON.stringify(fI.urls));
    }
  }

  // (c) mapMatchTrail y matchVentana sueltos, sobre ventanas al azar del corpus.
  let iguales = 0, total = 0;
  for (let k = 0; k < 400; k++) {
    const c = CORPUS[k % CORPUS.length];
    const limpio = limpioDe(c.filas);
    const ini = Math.floor(rnd() * Math.max(1, limpio.length - 5));
    const ventana: MatchPt[] = limpio.slice(ini, ini + 1 + Math.floor(rnd() * 110));
    const modo = Object.values(MODOS)[k % 3];
    const fO = crearFake(modo), fD = crearFake(modo), fI = crearFake(modo);
    (globalThis as any).fetch = fO.fetch;
    const a = [await mapMatchTrailOrig(ventana, "tok"), await matchVentanaOrig(ventana, "tok")];
    (globalThis as any).fetch = fD.fetch;
    const b = [await H.mapMatchTrail(ventana, "tok"), await H.matchVentana(ventana, "tok")];
    (globalThis as any).fetch = fetchQueRevienta;
    const cI = JSON.stringify([await H.mapMatchTrail(ventana, "tok", fI.fetch), await H.matchVentana(ventana, "tok", fI.fetch)]);
    total++;
    if (matchDeclarado(a[0], b[0]) && matchDeclarado(a[1], b[1]) && JSON.stringify(b) === cI
        && JSON.stringify(fO.urls) === JSON.stringify(fD.urls) && JSON.stringify(fO.urls) === JSON.stringify(fI.urls)) iguales++;
  }
  chk(`mapMatchTrail + matchVentana: ${iguales}/${total} ventanas idénticas salvo la divergencia declarada (defecto e inyectado)`, iguales === total);
  chk(`corolario: la divergencia se ejercita (${crudosNuevos} vértices de chip en recta larga en marcha pasaron a crudo)`, crudosNuevos > 0);
  (globalThis as any).fetch = fetchReal;
  chk("sin token, el ajustador no llama (inyectado o no)", await (async () => {
    const f = crearFake({});
    const aj = H.crearAjustadorHuella({ fetch: f.fetch });
    return (await aj.ajustar(limpioDe(CORPUS[0].filas), "")) === null && f.urls.length === 0;
  })());
}
conEsperas();

// ══ 1 · rangosDeCrudo ═════════════════════════════════════════════════════════════════════
seccion("1 · rangosDeCrudo = el bloque original del ajustador (copiado literal)");
{
  // El bloque tal como estaba dentro de `ajustar` (HEAD), con `todo.length` → el `n` recibido.
  const original = (esCrudoTodo: boolean[], n: number) => {
    let ultimoCrudoRanges: Array<[number, number]> = [];
    let ultimoColaClean = 0;
    const rangos: Array<[number, number]> = [];
    let idx = 0;
    while (idx < n) {
      if (esCrudoTodo[idx]) {
        let j = idx;
        while (j + 1 < n && (esCrudoTodo[j + 1] || (j + 2 < n && esCrudoTodo[j + 2]))) j++;   // fusiona ≤1 limpio
        rangos.push([idx, j]);
        idx = j + 1;
      } else idx++;
    }
    ultimoCrudoRanges = rangos.filter(([, e]) => e < n - 1);   // fuera la corrida de la punta viva (colaViva la cubre)
    ultimoColaClean = n - 1;
    for (let k = n - 1; k >= 0; k--) { if (!esCrudoTodo[k]) { ultimoColaClean = k; break; } }
    return { crudoRanges: ultimoCrudoRanges, colaClean: ultimoColaClean };
  };
  let casos = 0, iguales = 0;
  for (let len = 0; len <= 11; len++) {
    for (let m = 0; m < 1 << len; m++) {
      const v = Array.from({ length: len }, (_, i) => !!((m >> i) & 1));
      for (const n of [len, Math.max(0, len - 1), Math.floor(len / 2)]) {
        casos++;
        if (JSON.stringify(H.rangosDeCrudo(v, n)) === JSON.stringify(original(v, n))) iguales++;
      }
    }
  }
  for (let k = 0; k < 3000; k++) {
    const len = 12 + Math.floor(rnd() * 400);
    const p = rnd();
    const v = Array.from({ length: len }, () => rnd() < p);
    casos++;
    if (JSON.stringify(H.rangosDeCrudo(v, len)) === JSON.stringify(original(v, len))) iguales++;
  }
  chk(`barrido: ${iguales}/${casos} vectores esCrudo idénticos`, iguales === casos && casos > 10_000);
  chk("sin vértices: sin rangos y colaClean = -1 (como el original)", JSON.stringify(H.rangosDeCrudo([], 0)) === JSON.stringify({ crudoRanges: [], colaClean: -1 }));
  chk("el corpus produce rangos de crudo de verdad (no es trivial)", MEMORIA.some((m) => m.salida.crudoRanges.length > 0) && MEMORIA.some((m) => m.salida.colaClean < m.salida.esCrudo.length - 1));
}

// ══ 2 · el códec ═════════════════════════════════════════════════════════════════════════
seccion("2 · codificar → decodificar: coords a ≤ 0,5e-6°, RLE exacto, y las features del modal");
const EPS_COORD = 0.5e-6 + 1e-12;
{
  // (a) las salidas reales del ajustador del corpus
  let roundtrips = 0, buenos = 0, bytesMax = 0;
  let featsTot = 0, featsIguales = 0, divergenciasUmbral = 0, divergenciasSinExplicar = 0;
  const feats = (coords: [number, number][], esCrudo: boolean[], crudoRanges: Array<[number, number]>, colaClean: number, colaSnapped: boolean, huella: any[]) => {
    const cruditos = H.puentesCrudos(coords, crudoRanges);
    const suprimir: Array<[number, number]> = cruditos.map((c) => [c.iA + 1, c.iB - 1]);
    const mLen = coords.length;
    if (colaClean >= 0 && colaClean < mLen - 1) suprimir.push([colaClean + 1, mLen - 1]);
    const cut = (colaClean >= 1 && colaClean < mLen - 1) ? colaClean : mLen - 1;
    return {
      puentes: cruditos.map((c) => [c.iA, c.iB, c.origen]),
      lineas: H.colorearMatched(coords, huella, suprimir, esCrudo),
      cola: H.colaViva(coords.slice(0, cut + 1), huella, null, undefined, !colaSnapped || cut < mLen - 1),
    };
  };
  // igualdad con tolerancia en coordenadas (1,5e-6°: el redondeo de la polyline y lo que el suavizado
  // de colaViva arrastra), exacta en todo lo demás.
  const casi = (a: any, b: any): boolean => {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1.5e-6;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => casi(x, b[i]));
    if (a && b && typeof a === "object" && typeof b === "object") {
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every((k) => (k === "velocidad" ? a[k] === b[k] : casi(a[k], b[k])));
    }
    return a === b;
  };
  // Las DOS divergencias declaradas, las dos del redondeo de ≤ 0,11 m de la polyline. Se juzga CADA
  // diferencia en el sitio exacto donde aparece (no «hay algo cerca en algún lugar de la traza»):
  //  (a) umbral: la cuerda que aparece o desaparece está a < 0,25 m de un corte (300 o 60 m);
  //  (b) empate: la velocidad cambia y el vértice que la toma tiene sus dos fixes más cercanos a
  //      < 0,25 m de diferencia (en la métrica de colorearMatched, o en metros la de colaViva): puede
  //      tomar la del otro.
  // Los puentes (umbral de 40 m de puentesCrudos) tienen que salir IDÉNTICOS.
  const M_GRADO = 111_320;
  const brecha = (lng: number, lat: number, huella: any[], metros: boolean) => {
    let d1 = Infinity, d2 = Infinity;
    for (const hh of huella) {
      const d = metros ? distM(lat, lng, hh.lat, hh.lng) : Math.sqrt((hh.lng - lng) ** 2 + (hh.lat - lat) ** 2) * M_GRADO;
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    return d2 - d1;
  };
  const cercaDeUmbral = (d: number) => [H.MAX_SEG_M, H.MAX_SEG_CRUDO_M].some((u) => Math.abs(d - u) < 0.25);
  const largoFeat = (f: any) => { const [[x1, y1], [x2, y2]] = f.geometry.coordinates; return distM(y1, x1, y2, x2); };
  const brechas: number[] = [];
  /** "igual" | "umbral" | "empate" | "sin_explicar" para una parte (lineas o cola). */
  const juzgarParte = (a: any[], b: any[], huella: any[], metros: boolean): string => {
    if (casi(a, b)) return "igual";
    if (a.length !== b.length) {
      const sobra = a.length > b.length ? a.filter((x) => !b.some((y) => casi(x.geometry, y.geometry))) : b.filter((x) => !a.some((y) => casi(x.geometry, y.geometry)));
      return sobra.length && sobra.every((f) => cercaDeUmbral(largoFeat(f))) ? "umbral" : "sin_explicar";
    }
    let res = "igual";
    for (let i = 0; i < a.length; i++) {
      if (casi(a[i], b[i])) continue;
      if (!casi(a[i].geometry, b[i].geometry)) return "sin_explicar";
      const [lng, lat] = a[i].geometry.coordinates[0];
      const g = brecha(lng, lat, huella, metros);
      brechas.push(g);
      if (g < 0.25) res = "empate"; else return "sin_explicar";
    }
    return res;
  };
  let divergenciasEmpate = 0;
  for (const m of MEMORIA) {
    const s = m.salida;
    if (!s.r) continue;
    const coords = s.r as [number, number][];
    const cod = TA.codificarTraza({ coords, esCrudo: s.esCrudo, colaSnapped: s.colaSnapped });
    roundtrips++;
    if (!cod.ok) { chk(`${m.caso} · ${m.modo}: se codifica`, false, cod.motivo); continue; }
    bytesMax = Math.max(bytesMax, cod.bytes);
    const dec = TA.decodificarTraza(JSON.parse(JSON.stringify(cod.traza)));   // pasando por jsonb (JSON)
    const okRt = !!dec && dec.coords.length === coords.length
      && dec.coords.every((c, i) => Math.abs(c[0] - coords[i][0]) <= EPS_COORD && Math.abs(c[1] - coords[i][1]) <= EPS_COORD)
      && JSON.stringify(dec.esCrudo) === JSON.stringify(s.esCrudo)
      && dec.colaSnapped === s.colaSnapped
      && JSON.stringify(dec.crudoRanges) === JSON.stringify(s.crudoRanges) && dec.colaClean === s.colaClean;
    if (okRt) buenos++;
    else chk(`${m.caso} · ${m.modo}: ida y vuelta`, false);
    if (!dec) continue;
    const huella = m.limpio.map((p: any) => ({ lat: p.lat, lng: p.lng, velocidad: p.velocidad, acc: p.acc }));
    const fm = feats(coords, s.esCrudo, s.crudoRanges, s.colaClean, s.colaSnapped, huella);
    const fd = feats(dec.coords, dec.esCrudo, dec.crudoRanges, dec.colaClean, dec.colaSnapped, huella);
    featsTot++;
    const js = [juzgarParte(fm.lineas, fd.lineas, huella, false), juzgarParte(fm.cola, fd.cola, huella, true),
      JSON.stringify(fm.puentes) === JSON.stringify(fd.puentes) ? "igual" : "sin_explicar"];
    if (js.includes("sin_explicar")) { divergenciasSinExplicar++; chk(`${m.caso} · ${m.modo}: features`, false, js.join(",")); }
    else if (js.every((j) => j === "igual")) featsIguales++;
    else { if (js.includes("umbral")) divergenciasUmbral++; if (js.includes("empate")) divergenciasEmpate++; }
  }
  chk(`ida y vuelta de las ${roundtrips} salidas del ajustador: ${buenos} exactas (coords ≤ 0,5e-6°, esCrudo, rangos, colaClean, colaSnapped)`, buenos === roundtrips && roundtrips >= 12, `${bytesMax} B la mayor`);
  chk(`features del modal desde lo decodificado = desde memoria en ${featsIguales}/${featsTot} trazas; el resto solo por las divergencias declaradas (cuerda en el umbral: ${divergenciasUmbral} · vecino casi empatado: ${divergenciasEmpate})`,
    divergenciasSinExplicar === 0 && featsTot >= 12 && featsIguales >= featsTot / 2,
    `brechas de los empates (m): ${brechas.map((b) => b.toFixed(3)).join(", ")}`);

  // (b) trazas al azar: valores en todo el rango, RLE que empieza crudo, todo crudo, n = 2…
  let rAz = 0, rAzOk = 0;
  for (let k = 0; k < 600; k++) {
    const n = 2 + Math.floor(rnd() ** 2 * 4000);
    const lat0 = (rnd() - 0.5) * 170, lng0 = (rnd() - 0.5) * 350;
    const coords: [number, number][] = [];
    let lat = lat0, lng = lng0;
    for (let i = 0; i < n; i++) {
      lat = Math.max(-89.9, Math.min(89.9, lat + (rnd() - 0.5) * (k % 5 === 0 ? 2 : 0.002)));
      lng = Math.max(-179.9, Math.min(179.9, lng + (rnd() - 0.5) * (k % 5 === 0 ? 2 : 0.002)));
      coords.push([lng, lat]);
    }
    const pc = [0, 1, rnd(), 0.05, 0.95][k % 5];
    const esCrudo = coords.map(() => rnd() < pc);
    const cs = rnd() < 0.5;
    const cod = TA.codificarTraza({ coords, esCrudo, colaSnapped: cs });
    rAz++;
    if (!cod.ok) continue;
    const dec = TA.decodificarTraza(JSON.parse(JSON.stringify(cod.traza)));
    const ref = H.rangosDeCrudo(esCrudo, n);
    if (dec && dec.coords.length === n && dec.coords.every((c, i) => Math.abs(c[0] - coords[i][0]) <= EPS_COORD && Math.abs(c[1] - coords[i][1]) <= EPS_COORD)
      && JSON.stringify(dec.esCrudo) === JSON.stringify(esCrudo) && dec.colaSnapped === cs
      && JSON.stringify(dec.crudoRanges) === JSON.stringify(ref.crudoRanges) && dec.colaClean === ref.colaClean
      && cod.traza.c.reduce((a, b) => a + b, 0) === n && cod.bytes === JSON.stringify(cod.traza).length) rAzOk++;
  }
  chk(`trazas al azar: ${rAzOk}/${rAz} vuelven exactas (RLE suma n; bytes = largo del JSON)`, rAzOk === rAz);
  chk("RLE: un primer vértice crudo deja c[0] = 0", (() => {
    const c = TA.codificarTraza({ coords: [[-77, -12], [-77.001, -12.001], [-77.002, -12.002]], esCrudo: [true, true, false], colaSnapped: true });
    return c.ok && JSON.stringify(c.traza.c) === "[0,2,1]" && c.traza.v === TA.VERSION_AJUSTE && c.traza.n === 3;
  })());

  // (c) rechazos y topes
  const rect: [number, number][] = [[-77, -12], [-77.001, -12.001]];
  const motivo = (e: any) => { const c = TA.codificarTraza(e); return c.ok ? "ok" : c.motivo; };
  chk("incoherente: 1 vértice, esCrudo de otro largo, coordenada no finita o fuera de rango, colaSnapped no booleano",
    motivo({ coords: [rect[0]], esCrudo: [false], colaSnapped: true }) === "incoherente"
    && motivo({ coords: rect, esCrudo: [false], colaSnapped: true }) === "incoherente"
    && motivo({ coords: [rect[0], [NaN, -12]], esCrudo: [false, false], colaSnapped: true }) === "incoherente"
    && motivo({ coords: [rect[0], [-77, -95]], esCrudo: [false, false], colaSnapped: true }) === "incoherente"
    && motivo({ coords: rect, esCrudo: [false, false], colaSnapped: "si" }) === "incoherente");
  const enorme: [number, number][] = Array.from({ length: TA.MAX_VERTICES_TRAZA + 1 }, (_, i) => [-77 + i * 1e-6, -12]);
  chk(`demasiado_grande: más de ${TA.MAX_VERTICES_TRAZA} vértices`, motivo({ coords: enorme, esCrudo: enorme.map(() => false), colaSnapped: true }) === "demasiado_grande");
  const disperso: [number, number][] = Array.from({ length: 79_000 }, () => [(rnd() - 0.5) * 350, (rnd() - 0.5) * 170]);
  chk(`demasiado_grande: menos vértices que el tope pero más de ${TA.MAX_BYTES_TRAZA} B`, motivo({ coords: disperso, esCrudo: disperso.map(() => false), colaSnapped: true }) === "demasiado_grande");
  const bueno = TA.codificarTraza({ coords: rect, esCrudo: [false, true], colaSnapped: false });
  const t = bueno.ok ? bueno.traza : (null as any);
  chk("decodificar rechaza: otra versión, n que no casa, RLE que no suma, RLE negativo, polyline cortada, basura",
    TA.decodificarTraza(t) != null
    && TA.decodificarTraza({ ...t, v: TA.VERSION_AJUSTE + 1 }) === null
    && TA.decodificarTraza({ ...t, v: 1 }) === null   // las de la versión 1 (guardadas con el token rechazado, #1608) se recalculan
    && TA.decodificarTraza({ ...t, n: 3 }) === null
    && TA.decodificarTraza({ ...t, c: [1] }) === null
    && TA.decodificarTraza({ ...t, c: [3, -1] }) === null
    && TA.decodificarTraza({ ...t, p: t.p.slice(0, -1) }) === null
    && TA.decodificarTraza({ ...t, p: 5 }) === null
    && TA.decodificarTraza(null) === null && TA.decodificarTraza("x") === null);
  // tamaño típico, para el informe
  const big = MEMORIA.find((m) => m.caso === "backlog largo" && m.modo === "limpio");
  if (big?.salida.r) {
    const c = TA.codificarTraza({ coords: big.salida.r, esCrudo: big.salida.esCrudo, colaSnapped: big.salida.colaSnapped });
    if (c.ok) chk(`peso: el backlog (${big.limpio.length} pts limpios → ${c.traza.n} vértices) ocupa ${c.bytes} B`, c.bytes < TA.MAX_BYTES_TRAZA);
  }
}

// ══ 3 · la firma ═════════════════════════════════════════════════════════════════════════
seccion("3 · la firma de la entrada: qué la cambia y qué no");
const firmaDe = (filas: any[]) => createHash("sha256").update(`${TA.VERSION_AJUSTE}\n${TA.canonEntradaAjuste(filas)}`).digest("hex");
{
  const filas = CORPUS[4].filas.slice(0, 300).map((f) => ({ ...f }));
  const f0 = firmaDe(filas);
  chk("las mismas filas (copiadas) dan la misma firma", firmaDe(filas.map((f) => ({ ...f }))) === f0);
  const tardia = { ...filas[150], id: 999_999, created_at: new Date(Date.parse(filas[150].created_at) + 1500).toISOString() };
  const conTardia = [...filas.slice(0, 151), tardia, ...filas.slice(151)];
  chk("una posición tardía (llegó después, con su created_at original) cambia la firma", firmaDe(conTardia) !== f0);
  chk("una posición más al final también", firmaDe([...filas, { ...filas[299], id: 1e6, created_at: new Date(Date.parse(filas[299].created_at) + 3000).toISOString() }]) !== f0);
  chk("el orden importa (las filas llegan ordenadas por created_at, id)", firmaDe([filas[1], filas[0], ...filas.slice(2)]) !== f0);

  // Los campos: los de CAMPOS_FIRMA cambian la firma; los demás no — y no cambian la huella.
  const huellaJson = (fs_: any[]) => JSON.stringify(H.huellaDeFilas(fs_));
  const hj0 = huellaJson(filas);
  const mutar = (k: string, v: (x: any) => any) => filas.map((f, i) => (i === 77 ? { ...f, [k]: v(f[k]) } : f));
  const noLeidos = HSD.HCOLS_HUELLA.split(",").filter((k) => !(TA.CAMPOS_FIRMA as readonly string[]).includes(k)).concat(["id", "estado"]);
  for (const k of noLeidos) {
    const m = mutar(k, (x) => (typeof x === "number" ? x + 1 : x == null ? 7 : `${x}x`));
    chk(`«${k}» no lo lee huellaDeFilas: no cambia la huella ni la firma`, huellaJson(m) === hj0 && firmaDe(m) === f0);
  }
  for (const k of TA.CAMPOS_FIRMA) {
    const m = mutar(k, (x) => (k === "created_at" || k === "timestamp" ? new Date(Date.parse(filas[77].created_at) + 999).toISOString() : typeof x === "number" ? x + 0.0001 : 5));
    chk(`«${k}» cambia la firma`, firmaDe(m) !== f0);
  }
  chk("null, \"\" y 0 no se confunden; un | dentro de un texto no corre los campos",
    TA.canonEntradaAjuste([{ precision_m: null }]) !== TA.canonEntradaAjuste([{ precision_m: "" }])
    && TA.canonEntradaAjuste([{ precision_m: 0 }]) !== TA.canonEntradaAjuste([{ precision_m: null }])
    && TA.canonEntradaAjuste([{ created_at: "a|", timestamp: "b" }]) !== TA.canonEntradaAjuste([{ created_at: "a", timestamp: "|b" }]));
  // Los campos que de verdad leen filasAPuntos y huellaDeFilas (sobre el CÓDIGO) ⊆ CAMPOS_FIRMA.
  const src = fs.readFileSync(path.join(process.cwd(), "lib/huella.ts"), "utf8");
  const cuerpo = (nombre: string) => { const i = src.indexOf(`export function ${nombre}(`); const j = src.indexOf("\n}\n", i); return src.slice(i, j); };
  const leidos = new Set<string>();
  for (const m of cuerpo("filasAPuntos").matchAll(/\bd\.([a-z_]+)/g)) leidos.add(m[1]);
  for (const m of cuerpo("huellaDeFilas").matchAll(/\bf\.([a-z_]+)/g)) leidos.add(m[1]);
  chk(`los campos que leen filasAPuntos y huellaDeFilas (${[...leidos].join(", ")}) están todos en la firma`,
    leidos.size >= 6 && [...leidos].every((k) => (TA.CAMPOS_FIRMA as readonly string[]).includes(k)));
}

// ── Una base FALSA en memoria con la forma del cliente de Supabase ─────────────────────────
type Db = { ubicaciones_gps: Fila[]; reservas: Fila[] };
function crearBase(db: Db, fallas: { paginaGps?: number; reserva?: boolean } = {}) {
  let rangos = 0;
  const llamadas: string[] = [];
  const builder = (tabla: keyof Db) => {
    let cols: string[] | null = null;
    const filtros: Array<(r: Fila) => boolean> = [];
    const b: any = {
      select(c: string) { cols = c.split(",").map((x) => x.trim()); return b; },
      eq(k: string, v: any) { filtros.push((r) => r[k] === v); llamadas.push(`${tabla}.eq.${k}`); return b; },
      gte(k: string, v: any) { filtros.push((r) => r[k] >= v); llamadas.push(`${tabla}.gte.${k}=${v}`); return b; },
      lte(k: string, v: any) { filtros.push((r) => r[k] <= v); llamadas.push(`${tabla}.lte.${k}=${v}`); return b; },
      order() { return b; },
      _filas() {
        const fs_ = db[tabla].filter((r) => filtros.every((f) => f(r)))
          .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id - y.id));
        return fs_.map((r) => (cols ? Object.fromEntries(cols.map((k) => [k, r[k] ?? null])) : { ...r }));
      },
      range(a: number, z: number) {
        rangos++;
        if (fallas.paginaGps != null && rangos === fallas.paginaGps) return Promise.resolve({ data: null, error: { message: "timeout" } });
        return Promise.resolve({ data: b._filas().slice(a, z + 1), error: null });
      },
      maybeSingle() {
        if (tabla === "reservas" && fallas.reserva) return Promise.resolve({ data: null, error: { message: "timeout" } });
        return Promise.resolve({ data: b._filas()[0] ?? null, error: null });
      },
    };
    return b;
  };
  return { from: (t: keyof Db) => builder(t), llamadas };
}

// ══ 4 · el ciclo escritura → lectura ═════════════════════════════════════════════════════
seccion("4 · lo calculado sobre huellaDelServicio y releído por el camino de /api/cliente/gps sale «guardada»");
sinEsperas();
{
  const reserva = { id: 501, fecha_servicio: "2026-10-09", hora_servicio: "06:00:00", estado: "finalizada", vehiculo_id: 9, vehiculo_tercero_id: null };
  const gps = viaje({ n: 900, acc: accMixto, paradas: 0.01, reservaId: 501, v: 9, t0: T_BASE - 10 * 60_000 });
  const db: Db = { ubicaciones_gps: gps.map((f) => ({ ...f })), reservas: [reserva] };
  const AHORA = T_BASE + 6 * 3600_000;
  const q = { reservaId: 501, vehiculoId: null, vehiculoTerceroId: null };

  // Escritura (lo que hará T3): lectura ESTRICTA → huella limpia → ajuste → códec → fila.
  const hEsc = await HSD.huellaDelServicio(crearBase(db), q, AHORA, { estricto: true });
  const limpio = H.huellaDeFilas(hEsc.filasOk).limpio;
  const fk = crearFake(MODOS.ruidoso);
  const aj = await TC.ajustarServicioCompleto(limpio, "tok", fk.fetch);
  const res = TA.resultadoDelCalculo(aj);
  chk(`el cálculo sale «calculada» y se guarda (${aj.llamadas} llamadas, ${aj.transitorios} transitorios)`, res.codigo === "calculada" && res.guardar && !!res.traza);
  chk("cuenta cada llamada al Mapbox falso", aj.llamadas === fk.urls.length && aj.llamadas >= TA.llamadasEstimadas(limpio.length));
  // la misma geometría que el ajustador del modal (uno nuevo, una pasada)
  const fm = crearFake(MODOS.ruidoso);
  const ajModal = H.crearAjustadorHuella({ fetch: fm.fetch });
  const rModal = await ajModal.ajustar(limpio, "tok");
  chk("la geometría calculada = la del ajustador del modal sobre las mismas filas",
    JSON.stringify([aj.coords, aj.esCrudo, aj.colaSnapped]) === JSON.stringify([rModal, ajModal.leerEsCrudo(), ajModal.leerColaSnapped()]));
  const fila = { version: TA.VERSION_AJUSTE, firma: firmaDe(hEsc.filasOk), nFilas: hEsc.filasOk.length, recalculos: 0, calculadoEn: new Date(AHORA).toISOString(), traza: JSON.parse(JSON.stringify(res.traza)) };

  // Lectura (lo que hará /api/cliente/gps): lectura INDULGENTE, como la ruta, sobre la misma base.
  const lectura = async (base: any, ahoraMs: number) => {
    const h = await HSD.huellaDelServicio(base, q, ahoraMs);
    return { h, r: TA.decidirLectura({
      finalizada: h.reserva?.estado === "finalizada", config: { estado: "ok", guardar: true }, lecturaCompleta: h.completa,
      guardada: fila, firmaAhora: firmaDe(h.filasOk), nFilasAhora: h.filasOk.length, dentroDeVentana: true, tokenServidor: true, ahoraMs,
    }) };
  };
  const l1 = await lectura(crearBase(db), AHORA + 60_000);
  chk("releída por el camino de la ruta: «guardada», sin recálculo, con la traza", l1.r.estado === "guardada" && !l1.r.puedeCalcular && !!l1.r.traza);
  const dec = TA.decodificarTraza(l1.r.traza);
  chk("y lo decodificado es lo calculado", !!dec && dec.coords.length === aj.coords.length && JSON.stringify(dec.esCrudo) === JSON.stringify(aj.esCrudo));
  chk("las filas de la escritura (estricta) y de la lectura (indulgente) son las mismas", JSON.stringify(l1.h.filasOk) === JSON.stringify(hEsc.filasOk) && l1.h.completa);

  // Llega una posición tardía (la cola offline del teléfono): la firma cambia.
  const db2: Db = { ...db, ubicaciones_gps: [...db.ubicaciones_gps, { ...gps[600], id: 777_777, created_at: new Date(Date.parse(gps[600].created_at) + 1000).toISOString() }] };
  const l2 = await lectura(crearBase(db2), AHORA + 60_000);
  chk("con una posición tardía: «desactualizada», se dibuja la guardada y aún no recalcula (< 30 min)", l2.r.estado === "desactualizada" && !!l2.r.traza && !l2.r.puedeCalcular);
  const l3 = await lectura(crearBase(db2), AHORA + 31 * 60_000);
  chk("pasados 30 min sí puede recalcular", l3.r.estado === "desactualizada" && l3.r.puedeCalcular);
  const l4 = await lectura(crearBase(db, { paginaGps: 1 }), AHORA + 60_000);
  chk("si una página de posiciones falla: «no_se_pudo_leer», sin traza y sin recálculo (nunca «falta»)", l4.r.estado === "no_se_pudo_leer" && !l4.r.traza && !l4.r.puedeCalcular && !l4.h.completa);
  let lanzo = false;
  try { await HSD.huellaDelServicio(crearBase(db, { paginaGps: 1 }), q, AHORA, { estricto: true }); } catch (e) { lanzo = e instanceof HSD.LecturaHuellaFallida; }
  chk("la lectura ESTRICTA (la del cálculo) lanza ante una página fallida", lanzo);
  lanzo = false;
  try { await HSD.huellaDelServicio(crearBase(db, { reserva: true }), q, AHORA, { estricto: true }); } catch (e) { lanzo = e instanceof HSD.LecturaHuellaFallida; }
  chk("…y ante la reserva que no se pudo leer", lanzo);

  // Transitorios y tope.
  const fF = crearFake(MODOS.fallos);
  const ajF = await TC.ajustarServicioCompleto(limpio, "tok", fF.fetch);
  const ultimoPorUrl = new Map<string, number | "red">();
  fF.urls.forEach((u, i) => ultimoPorUrl.set(u, fF.status[i]));
  const transEsperados = [...ultimoPorUrl.values()].filter((s) => s === "red" || s === 429 || (typeof s === "number" && s >= 500)).length;
  chk(`con fallos de Mapbox: ${ajF.transitorios} consultas terminaron en 429/5xx/red (contadas por su ÚLTIMO intento) → no se guarda`,
    ajF.transitorios === transEsperados && ajF.transitorios > 0 && TA.resultadoDelCalculo(ajF).codigo === "calculada_sin_guardar" && !TA.resultadoDelCalculo(ajF).guardar);
  const f429 = crearFake({ p429: 0.5 });
  const aj429 = await TC.ajustarServicioCompleto(limpio, "tok", f429.fetch);
  const n429 = f429.status.filter((x) => x === 429).length;
  chk(`un 429 que se reintentó y luego contestó 200 NO es transitorio (${n429} × 429 recuperados → 0 transitorios, se guarda)`,
    n429 > 0 && aj429.transitorios === 0 && TA.resultadoDelCalculo(aj429).guardar && aj429.llamadas === f429.urls.length);
  const fT = crearFake(MODOS.limpio);
  const ajT = await TC.ajustarServicioCompleto(limpio, "tok", fT.fetch, 3);
  chk(`con tope de 3 llamadas: aborta, no pasa del tope y no se guarda (${ajT.llamadas} llamadas)`,
    ajT.abortado && ajT.llamadas === 3 && fT.urls.length === 3 && ajT.coords.length === 0 && TA.resultadoDelCalculo(ajT).codigo === "excede_servicio" && !TA.resultadoDelCalculo(ajT).guardar);
  const fR = crearFake({});
  const ajR = await TC.ajustarServicioCompleto(limpio, "tok", async (u) => { await fR.fetch(u); throw new TypeError("sin red"); });
  chk("sin red en absoluto: todas las consultas son transitorias y no se guarda", ajR.transitorios === new Set(fR.urls).size && !TA.resultadoDelCalculo(ajR).guardar);
  // #1608: token del servidor rechazado (403 = restricción por URL; 401 = inválido) → cada ventana cae
  // al crudo suavizado. Antes eso NO contaba como fallo y se guardaba para siempre.
  for (const st of [401, 403]) {
    const urls: string[] = [];
    const ajX = await TC.ajustarServicioCompleto(limpio, "tok", async (u) => { urls.push(u); return new Response(JSON.stringify({ message: "Forbidden" }), { status: st }); });
    const rX = TA.resultadoDelCalculo(ajX);
    chk(`token rechazado (${st}): ${ajX.rechazos} consultas rechazadas, 0 transitorias → «token_rechazado», no se guarda ni se dibuja`,
      ajX.rechazos === new Set(urls).size && ajX.rechazos > 0 && ajX.transitorios === 0 && rX.codigo === "token_rechazado" && !rX.guardar && !rX.traza);
  }
  chk("con el token bueno no hay rechazos", aj.rechazos === 0 && ajF.rechazos === 0);

}
conEsperas();

// ── Una base FALSA más completa, para los lectores y escritores reales de T3 ──────────────
// Soporta select/eq/gte/lte/lt/is/in/order/limit/range/maybeSingle/single e insert/update/upsert/delete
// (thenable, como el cliente de Supabase). Una tabla ausente contesta el error de PostgREST (PGRST205);
// el índice único parcial del candado (un intento ABIERTO por reserva) contesta 23505.
type DbT = Record<string, Fila[]>;
function crearBaseT3(db: DbT, opts: { lanzarUpsert?: boolean } = {}) {
  const accesos: string[] = [];
  let seq = 1000;
  const from = (tabla: string) => {
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let cols: string[] | null = null, carga: any = null, conSelect = false, uno: "single" | "maybe" | null = null;
    const filtros: Array<(r: Fila) => boolean> = [];
    const ordenes: Array<[string, boolean]> = [];
    let lim: number | null = null, rango: [number, number] | null = null;
    const faltante = () => ({ data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${tabla}' in the schema cache` } });
    const ejecutar = (): any => {
      accesos.push(`${tabla}.${op}${cols ? `(${cols.join(",")})` : ""}`);
      if (!(tabla in db)) return faltante();
      const t = db[tabla];
      const pasa = (r: Fila) => filtros.every((f) => f(r));
      const proy = (r: Fila) => (cols ? Object.fromEntries(cols.map((k) => [k, r[k] ?? null])) : { ...r });
      if (op === "select") {
        let fs_ = t.filter(pasa);
        if (ordenes.length) fs_ = [...fs_].sort((x, y) => { for (const [k, asc] of ordenes) { if (x[k] < y[k]) return asc ? -1 : 1; if (x[k] > y[k]) return asc ? 1 : -1; } return 0; });
        if (rango) fs_ = fs_.slice(rango[0], rango[1] + 1);
        if (lim != null) fs_ = fs_.slice(0, lim);
        const data = fs_.map(proy);
        if (uno) return { data: data[0] ?? null, error: null };
        return { data, error: null };
      }
      if (op === "insert") {
        const filas = (Array.isArray(carga) ? carga : [carga]).map((r: any) => ({ id: seq++, terminado_en: null, ...r }));
        if (tabla === "gps_traza_ajuste_intentos") {
          for (const f of filas) if (f.terminado_en == null && t.some((x) => x.reserva_id === f.reserva_id && x.terminado_en == null)) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"uq_gps_traza_intento_abierto\"" } };
          }
        }
        t.push(...filas);
        const data = conSelect ? filas.map(proy) : null;
        return { data: uno && data ? data[0] : data, error: null };
      }
      if (op === "update") { for (const r of t.filter(pasa)) Object.assign(r, carga); return { data: null, error: null }; }
      if (op === "upsert") {
        if (opts.lanzarUpsert) throw new Error("la base se cayó a mitad del upsert");
        const i = t.findIndex((r) => r.reserva_id === carga.reserva_id);
        if (i >= 0) t[i] = { ...carga }; else t.push({ ...carga });
        return { data: null, error: null };
      }
      if (op === "delete") { const quedan = t.filter((r) => !pasa(r)); db[tabla] = quedan; return { data: null, error: null }; }
    };
    const b: any = {
      select(c?: string) { if (op === "select") cols = c ? c.split(",").map((x) => x.trim()) : null; else conSelect = true, cols = c ? c.split(",").map((x) => x.trim()) : null; return b; },
      insert(r: any) { op = "insert"; carga = r; return b; },
      update(r: any) { op = "update"; carga = r; return b; },
      upsert(r: any) { op = "upsert"; carga = r; return b; },
      delete() { op = "delete"; return b; },
      eq(k: string, v: any) { filtros.push((r) => r[k] === v); return b; },
      gte(k: string, v: any) { filtros.push((r) => r[k] >= v); return b; },
      lte(k: string, v: any) { filtros.push((r) => r[k] <= v); return b; },
      lt(k: string, v: any) { filtros.push((r) => r[k] < v); return b; },
      is(k: string, v: any) { filtros.push((r) => (r[k] ?? null) === v); return b; },
      in(k: string, vs: any[]) { filtros.push((r) => vs.includes(r[k])); return b; },
      order(k: string, o?: { ascending?: boolean }) { ordenes.push([k, o?.ascending !== false]); return b; },
      limit(n: number) { lim = n; return b; },
      range(a: number, z: number) { rango = [a, z]; return Promise.resolve().then(ejecutar); },
      maybeSingle() { uno = "maybe"; return Promise.resolve().then(ejecutar); },
      single() { uno = "single"; return Promise.resolve().then(ejecutar); },
      then(ok: any, ko: any) { return Promise.resolve().then(ejecutar).then(ok, ko); },
    };
    return b;
  };
  return { from, accesos, db };
}

// ══ 4b · los lectores y escritores REALES de T3, con dobles ════════════════════════════════
seccion("4b · lib/gps-traza-ajustada-datos.ts con una base y un Mapbox falsos");
sinEsperas();
{
  const TD = await import("../lib/gps-traza-ajustada-datos");
  const AH0 = T_BASE + 6 * 3600_000;   // 2026-10-09 12:00 Lima
  const gps501 = viaje({ n: 700, acc: accMixto, paradas: 0.01, reservaId: 501, v: 9, t0: T_BASE - 10 * 60_000 });
  const cfg = (o: Fila = {}) => [{ id: 1, guardar: true, borrar_guardadas: false, presupuesto_hora: 2000, presupuesto_mes: 50000, precalcular_dias: 0, por_corrida: 20, ...o }];
  const R5 = (id: number, o: Fila = {}) => ({ id, fecha_servicio: "2026-10-09", hora_servicio: "06:00:00", estado: "finalizada", vehiculo_id: 9, vehiculo_tercero_id: null, cliente_id: 1, ...o });
  const nuevaDb = (o: Partial<DbT> = {}): DbT => ({
    reservas: [R5(501)], ubicaciones_gps: gps501.map((f) => ({ ...f })),
    gps_traza_config: cfg(), gps_traza_ajustada: [], gps_traza_ajuste_intentos: [], ...o,
  });
  const entorno = (db: DbT, o: { fetch?: Fake; token?: string | null; lanzarUpsert?: boolean } = {}) => {
    const base = crearBaseT3(db, { lanzarUpsert: o.lanzarUpsert });
    const fk = o.fetch ?? crearFake(MODOS.ruidoso);
    let reloj = AH0;
    const deps = { admin: base, fetch: fk.fetch, token: o.token === undefined ? "tok" : o.token, ahora: () => reloj };
    return { base, fk, deps, avanzar: (ms: number) => { reloj += ms; }, ahora: () => reloj };
  };
  // la lectura por el camino de /api/cliente/gps
  const leer = async (e: ReturnType<typeof entorno>, id = 501, conocida?: string) => {
    const h = await HSD.huellaDelServicio(e.base, { reservaId: id, vehiculoId: 9, vehiculoTerceroId: null }, e.ahora());
    return TD.ajustadaParaRespuesta({ reservaId: id, reserva: h.reserva, filasOk: h.filasOk, completa: h.completa, ahoraMs: e.ahora(), conocida }, e.deps);
  };

  chk("firmaDeFilas = sha256(`${VERSION_AJUSTE}\\n${canonEntradaAjuste}`) (la de §3/§4)", TD.firmaDeFilas(gps501) === firmaDe(gps501));

  // El ciclo completo.
  const e1 = entorno(nuevaDb());
  const l0 = await leer(e1);
  chk("antes de calcular: «falta» y puede calcular", l0.estado === "falta" && l0.puedeCalcular && !l0.traza);
  const c1 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e1.deps);
  const fila = e1.base.db.gps_traza_ajustada[0];
  const intento = e1.base.db.gps_traza_ajuste_intentos[0];
  chk(`calcularYGuardar: «calculada», una fila guardada y la traza devuelta (${c1.llamadas} llamadas)`,
    c1.codigo === "calculada" && !!c1.traza && e1.base.db.gps_traza_ajustada.length === 1 && fila.version === TA.VERSION_AJUSTE && JSON.stringify(fila.traza) === JSON.stringify(c1.traza));
  chk("la fila: firma de las filas, n_filas, vertices, bytes, llamadas, recalculos 0, origen, ultimo_ts",
    fila.firma === c1.firma && fila.n_filas > 0 && fila.vertices === c1.traza!.n && fila.bytes === JSON.stringify(c1.traza).length
    && fila.llamadas === e1.fk.urls.length && fila.recalculos === 0 && fila.origen === "apertura"
    && fila.ultimo_ts === new Date(Math.max(...gps501.map((g) => Date.parse(g.created_at)))).toISOString());
  chk("el candado quedó SOLTADO: terminado_en, llamadas reales y resultado", intento.terminado_en != null && intento.llamadas === e1.fk.urls.length && intento.resultado === "calculada" && intento.sujeto === "u:1");
  const l1 = await leer(e1);
  chk("releída por el camino de /api/cliente/gps: «guardada», con la MISMA traza", l1.estado === "guardada" && JSON.stringify(l1.traza) === JSON.stringify(c1.traza) && !l1.puedeCalcular);
  e1.base.accesos.length = 0;
  const l1b = await leer(e1, 501, c1.calculadoEn);
  chk("con `conocida` = su calculadoEn: «guardada», sinCambios, SIN traza y sin leer el jsonb",
    l1b.estado === "guardada" && l1b.sinCambios === true && !l1b.traza
    && e1.base.accesos.filter((a) => a.startsWith("gps_traza_ajustada.select")).every((a) => !a.includes("traza)") && !a.includes(",traza")));
  const l1c = await leer(e1, 501, "2020-01-01T00:00:00.000Z");
  chk("con un `conocida` viejo: la traza viaja entera", l1c.estado === "guardada" && !!l1c.traza && !l1c.sinCambios);
  const llamadasAntes = e1.fk.urls.length;
  const c2 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e1.deps);
  chk("calcular otra vez: «ya_guardada», sin consultas a Mapbox ni intentos nuevos", c2.codigo === "ya_guardada" && !!c2.traza && e1.fk.urls.length === llamadasAntes && e1.base.db.gps_traza_ajuste_intentos.length === 1);

  // Posición tardía: desactualizada → espera → recálculo → tope.
  e1.base.db.ubicaciones_gps.push({ ...gps501[400], id: 888_888, created_at: new Date(Date.parse(gps501[400].created_at) + 900).toISOString() });
  const l2 = await leer(e1);
  chk("con una posición tardía: «desactualizada» con la guardada y aún sin recálculo", l2.estado === "desactualizada" && !!l2.traza && !l2.puedeCalcular);
  const c3 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e1.deps);
  chk("calcular antes de 30 min: «ya_guardada» con la guardada y su motivo, sin consultas", c3.codigo === "ya_guardada" && !!c3.traza && /30 min/.test(c3.detalle) && e1.fk.urls.length === llamadasAntes);
  e1.avanzar(31 * 60_000);
  const c4 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e1.deps);
  chk("pasados 30 min: «calculada» otra vez, recalculos 1", c4.codigo === "calculada" && e1.base.db.gps_traza_ajustada[0].recalculos === 1);
  chk("y releída vuelve a ser «guardada»", (await leer(e1)).estado === "guardada");
  e1.base.db.gps_traza_ajustada[0].recalculos = TA.MAX_RECALCULOS;
  e1.base.db.ubicaciones_gps.push({ ...gps501[500], id: 888_889, created_at: new Date(Date.parse(gps501[500].created_at) + 900).toISOString() });
  e1.avanzar(31 * 60_000);
  const n0 = e1.fk.urls.length;
  const c5 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e1.deps);
  chk(`con ${TA.MAX_RECALCULOS} recálculos: «ya_guardada» con la guardada, sin consultas`, c5.codigo === "ya_guardada" && !!c5.traza && e1.fk.urls.length === n0);

  // Candado.
  const db6 = nuevaDb();
  const e6 = entorno(db6);
  db6.gps_traza_ajuste_intentos.push({ id: 1, reserva_id: 501, origen: "apertura", sujeto: "u:2", empezado_en: new Date(AH0 - 60_000).toISOString(), terminado_en: null, llamadas: 8, resultado: null });
  const c6 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e6.deps);
  chk("con otro cálculo abierto (1 min): «en_curso», sin consultas", c6.codigo === "en_curso" && e6.fk.urls.length === 0);
  db6.gps_traza_ajuste_intentos[0].empezado_en = new Date(AH0 - 6 * 60_000).toISOString();
  const c7 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e6.deps);
  chk("con uno abierto de más de 5 min: se da por muerto y se calcula", c7.codigo === "calculada" && db6.gps_traza_ajuste_intentos[0].resultado === "muerto" && db6.gps_traza_ajuste_intentos[0].terminado_en != null);

  // Presupuesto.
  const e8 = entorno(nuevaDb({ gps_traza_config: cfg({ presupuesto_hora: 3 }) }));
  const c8 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e8.deps);
  chk("presupuesto de la hora agotado: «presupuesto_agotado», sin consultas ni intento", c8.codigo === "presupuesto_agotado" && e8.fk.urls.length === 0 && e8.base.db.gps_traza_ajuste_intentos.length === 0 && /presupuesto_hora/.test(c8.detalle));
  const db9 = nuevaDb({ gps_traza_config: cfg({ presupuesto_mes: 100 }) });
  db9.gps_traza_ajuste_intentos.push({ id: 1, reserva_id: 7, origen: "apertura", empezado_en: new Date(AH0 - 3 * 86_400_000).toISOString(), terminado_en: new Date(AH0 - 3 * 86_400_000).toISOString(), llamadas: 95 });
  const e9 = entorno(db9);
  const c9 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e9.deps);
  chk("presupuesto del mes (lo gastado este mes en Lima cuenta): «presupuesto_agotado»", c9.codigo === "presupuesto_agotado" && /presupuesto_mes/.test(c9.detalle));
  chk("inicioMesLima: el 1 a las 00:00 de Lima", TD.inicioMesLima(Date.UTC(2026, 9, 1, 4, 59)) === "2026-09-01T05:00:00.000Z" && TD.inicioMesLima(Date.UTC(2026, 9, 1, 5, 0)) === "2026-10-01T05:00:00.000Z");

  // Transitorios, upsert que revienta.
  const e10 = entorno(nuevaDb(), { fetch: crearFake(MODOS.fallos) });
  const c10 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e10.deps);
  chk("con fallos pasajeros de Mapbox: «calculada_sin_guardar», devuelve la traza, NO guarda, y suelta el candado",
    c10.codigo === "calculada_sin_guardar" && !!c10.traza && e10.base.db.gps_traza_ajustada.length === 0
    && e10.base.db.gps_traza_ajuste_intentos[0].terminado_en != null && e10.base.db.gps_traza_ajuste_intentos[0].resultado === "calculada_sin_guardar");
  const e11 = entorno(nuevaDb(), { lanzarUpsert: true });
  const c11 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e11.deps);
  chk("si el guardado LANZA: «error» y el candado igual se suelta (terminado_en escrito)", c11.codigo === "error" && e11.base.db.gps_traza_ajuste_intentos[0].terminado_en != null && e11.base.db.gps_traza_ajuste_intentos[0].resultado === "error");

  // Interruptores y prerrequisitos.
  const e12 = entorno(nuevaDb({ gps_traza_config: cfg({ guardar: false }), gps_traza_ajustada: [{ reserva_id: 501, version: 1, firma: "x", n_filas: 1, traza: c1.traza, recalculos: 0, calculado_en: new Date(AH0).toISOString() }] }));
  const l12 = await leer(e12);
  const c12 = await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e12.deps);
  chk("guardar = false: lectura «apagada» y cálculo «apagada», sin tocar gps_traza_ajustada ni Mapbox",
    l12.estado === "apagada" && !l12.traza && c12.codigo === "apagada" && e12.fk.urls.length === 0 && !e12.base.accesos.some((a) => a.startsWith("gps_traza_ajustada")));
  const dbSin = nuevaDb(); delete (dbSin as any).gps_traza_config; delete (dbSin as any).gps_traza_ajustada; delete (dbSin as any).gps_traza_ajuste_intentos;
  const e13 = entorno(dbSin);
  chk("sin la migración: lectura y cálculo «sin_migracion»", (await leer(e13)).estado === "sin_migracion" && (await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e13.deps)).codigo === "sin_migracion" && e13.fk.urls.length === 0);
  const dbSinTabla = nuevaDb(); delete (dbSinTabla as any).gps_traza_ajustada;
  chk("con la config pero sin la tabla de trazas: «sin_migracion», no «no_se_pudo_leer»", (await leer(entorno(dbSinTabla))).estado === "sin_migracion");
  const e14 = entorno(nuevaDb(), { token: null });
  chk("sin token: lectura «sin_token» (como hoy: ajusta el navegador) y cálculo «sin_token»", (await leer(e14)).estado === "sin_token" && (await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e14.deps)).codigo === "sin_token");
  const e15 = entorno(nuevaDb({ reservas: [R5(501, { estado: "en_curso" }), R5(502, { fecha_servicio: "2026-06-01" })] }));
  chk("no finalizada: «no_finalizada»; más vieja que la ventana: «fuera_de_ventana»; inexistente: reservaNoExiste",
    (await TD.calcularYGuardar(501, { origen: "apertura", sujeto: "u:1" }, e15.deps)).codigo === "no_finalizada"
    && (await TD.calcularYGuardar(502, { origen: "apertura", sujeto: "u:1" }, e15.deps)).codigo === "fuera_de_ventana"
    && (await TD.calcularYGuardar(99, { origen: "apertura", sujeto: "u:1" }, e15.deps)).reservaNoExiste === true && e15.fk.urls.length === 0);
  const lNo = await TD.ajustadaParaRespuesta({ reservaId: 501, reserva: { estado: "en_curso", fecha_servicio: "2026-10-09", hora_servicio: null, vehiculo_id: 9, vehiculo_tercero_id: null }, filasOk: gps501, completa: true, ahoraMs: AH0 }, e15.deps);
  chk("la lectura de un servicio no finalizado: «no_aplica», sin leer nada", lNo.estado === "no_aplica" && !e15.base.accesos.some((a) => a.startsWith("gps_traza_ajustada")));
  const lErr = await TD.ajustadaParaRespuesta({ reservaId: 501, reserva: R5(501) as any, filasOk: gps501, completa: true, ahoraMs: AH0 }, { ...e1.deps, admin: { from: () => { throw new Error("se cayó"); } } });
  chk("la lectura es best-effort: si todo revienta, «no_se_pudo_leer» y nunca lanza", lErr.estado === "no_se_pudo_leer" && !lErr.puedeCalcular);

  // Tercero: los vehículos salen de la RESERVA (la huella por ventana), no de quien llama.
  const gpsT = viaje({ n: 400, acc: accRed, vt: 7, t0: T_BASE - 10 * 60_000 });
  const e16 = entorno(nuevaDb({ reservas: [R5(601, { vehiculo_id: null, vehiculo_tercero_id: 7 })], ubicaciones_gps: gpsT }));
  const c16 = await TD.calcularYGuardar(601, { origen: "apertura", sujeto: "u:1" }, e16.deps);
  const hT = await HSD.huellaDelServicio(e16.base, { reservaId: 601, vehiculoId: null, vehiculoTerceroId: 7 }, e16.ahora());
  chk("tercero: se calcula con la unidad de la reserva y la firma es la de la huella por ventana", c16.codigo === "calculada" && c16.firma === TD.firmaDeFilas(hT.filasOk) && hT.servicio.via === "vehiculo");

  // El token del servidor.
  const envAntes = { s: process.env.MAPBOX_TOKEN_SERVIDOR, p: process.env.NEXT_PUBLIC_MAPBOX_TOKEN };
  delete process.env.MAPBOX_TOKEN_SERVIDOR; process.env.NEXT_PUBLIC_MAPBOX_TOKEN = "pk.publico";
  const sinVar = TD.tokenMapboxServidor();
  process.env.MAPBOX_TOKEN_SERVIDOR = '  "sk.servidor"\n';
  const conVar = TD.tokenMapboxServidor();
  if (envAntes.s === undefined) delete process.env.MAPBOX_TOKEN_SERVIDOR; else process.env.MAPBOX_TOKEN_SERVIDOR = envAntes.s;
  if (envAntes.p === undefined) delete process.env.NEXT_PUBLIC_MAPBOX_TOKEN; else process.env.NEXT_PUBLIC_MAPBOX_TOKEN = envAntes.p;
  chk("tokenMapboxServidor: sin la variable es null (NO cae a NEXT_PUBLIC_MAPBOX_TOKEN) y limpia comillas y espacios", sinVar === null && conVar === "sk.servidor");

  // El cron.
  const eT0 = entorno(nuevaDb());
  chk("tick con precalcular_dias = 0: «apagado», sin consultas", (await TD.tickTrazaAjustada(eT0.deps)).estado === "apagado" && eT0.fk.urls.length === 0);
  const dbT = nuevaDb({
    gps_traza_config: cfg({ precalcular_dias: 5, por_corrida: 2 }),
    reservas: [R5(501, { fecha_servicio: "2026-10-07" }), R5(502, { fecha_servicio: "2026-10-06" }), R5(503, { fecha_servicio: "2026-10-09" }), R5(504, { fecha_servicio: "2026-10-05" }), R5(505, { fecha_servicio: "2026-10-01" })],
    ubicaciones_gps: [
      ...viaje({ n: 300, acc: accChip, reservaId: 501, t0: AH0 - 2 * 86_400_000 }),
      ...viaje({ n: 50, acc: accChip, reservaId: 503, t0: AH0 - 20 * 60_000 }),    // última posición hace < 60 min
      ...viaje({ n: 300, acc: accChip, reservaId: 504, t0: AH0 - 4 * 86_400_000 }),
    ],
  });
  const eT = entorno(dbT, { fetch: crearFake(MODOS.limpio) });
  const t1 = await TD.tickTrazaAjustada(eT.deps) as any;
  const guardadasT = dbT.gps_traza_ajustada.map((f) => f.reserva_id).sort();
  chk(`tick: respeta por_corrida (2), salta la de posiciones recientes y la de fuera de los 5 días (${JSON.stringify(t1.saltadas_por_codigo)})`,
    t1.estado === "ok" && t1.candidatas === 4 && t1.calculadas === 1 && JSON.stringify(guardadasT) === "[501]" && t1.saltadas_por_codigo.reciente === 1 && t1.saltadas_por_codigo.sin_filas === 1);
  chk("lo que el cron intentó sin gastar se anota cerrado (origen cron, 0 llamadas)", dbT.gps_traza_ajuste_intentos.some((f) => f.reserva_id === 502 && f.origen === "cron" && f.llamadas === 0 && f.terminado_en != null && f.resultado === "sin_filas"));
  const t2 = await TD.tickTrazaAjustada(eT.deps) as any;
  chk("la corrida siguiente no repite lo ya intentado ni lo guardado: calcula la que faltaba", t2.estado === "ok" && t2.calculadas === 1 && JSON.stringify(dbT.gps_traza_ajustada.map((f) => f.reserva_id).sort()) === "[501,504]" && typeof t2.gasto_mes === "number" && t2.gasto_mes > 0);
  dbT.gps_traza_config[0].borrar_guardadas = true;
  const t3 = await TD.tickTrazaAjustada(eT.deps) as any;
  chk("borrar_guardadas: borra todas las guardadas y termina", t3.estado === "borrando" && t3.borradas === 2 && !t3.quedan && dbT.gps_traza_ajustada.length === 0);
  const eTs = entorno(nuevaDb({ gps_traza_config: cfg({ precalcular_dias: 3 }) }), { token: null });
  chk("tick sin token: «sin_token»", (await TD.tickTrazaAjustada(eTs.deps)).estado === "sin_token");
}
conEsperas();

// ══ 5 · barrido de decidirLectura y resultadoDelCalculo ══════════════════════════════════
seccion("5 · decidirLectura y resultadoDelCalculo: invariantes por barrido");
{
  const trazaBuena = (() => { const c = TA.codificarTraza({ coords: [[-77, -12], [-77.001, -12.001], [-77.002, -12.0]], esCrudo: [false, true, false], colaSnapped: true }); return c.ok ? c.traza : null; })();
  const AH = Date.UTC(2026, 9, 14, 15, 0, 0);
  const configs: any[] = [{ estado: "ok", guardar: true }, { estado: "ok", guardar: false }, { estado: "sin_migracion" }, { estado: "no_se_pudo_leer" }];
  const guardadas: Array<[string, (rec: number, edadMs: number) => any]> = [
    ["ninguna", () => null],
    ["error", () => "error"],
    ["misma firma", (rec, e) => ({ version: TA.VERSION_AJUSTE, firma: "F", nFilas: 10, recalculos: rec, calculadoEn: Number.isFinite(e) ? new Date(AH - e).toISOString() : "basura", traza: trazaBuena })],
    ["otra firma", (rec, e) => ({ version: TA.VERSION_AJUSTE, firma: "G", nFilas: 10, recalculos: rec, calculadoEn: Number.isFinite(e) ? new Date(AH - e).toISOString() : "basura", traza: trazaBuena })],
    ["corrupta", (rec, e) => ({ version: TA.VERSION_AJUSTE, firma: "F", nFilas: 10, recalculos: rec, calculadoEn: new Date(AH - (Number.isFinite(e) ? e : 0)).toISOString(), traza: { v: 1, p: "??", c: [2], s: true, n: 2 } })],
    ["otra versión", (rec, e) => ({ version: TA.VERSION_AJUSTE + 1, firma: "F", nFilas: 10, recalculos: rec, calculadoEn: new Date(AH - (Number.isFinite(e) ? e : 0)).toISOString(), traza: trazaBuena ? { ...trazaBuena, v: TA.VERSION_AJUSTE + 1 } : null })],
  ];
  const vistos = new Set<string>();
  let combinaciones = 0, malas = 0;
  const falla = (m: string) => { if (malas++ < 5) console.log(`  ✗ ${m}`); };
  for (const finalizada of [true, false])
  for (const config of configs)
  for (const lecturaCompleta of [true, false])
  for (const [gNombre, gFab] of guardadas)
  for (const rec of [0, 1, 2])
  for (const edad of [0, 29 * 60_000, 31 * 60_000, NaN])
  for (const dentro of [true, false])
  for (const token of [true, false])
  for (const nF of [0, 1, 2, 100])
  for (const clienteLaTiene of [false, true]) {
    combinaciones++;
    const g = gFab(rec, edad);
    // con clienteLaTiene, el lector NO lee el jsonb: la fila llega sin traza
    const gL = clienteLaTiene && g && typeof g === "object" ? { ...g, traza: undefined } : g;
    const ctx: any = { finalizada, config, lecturaCompleta, guardada: gL, firmaAhora: "F", nFilasAhora: nF, dentroDeVentana: dentro, tokenServidor: token, ahoraMs: AH, clienteLaTiene };
    const r = TA.decidirLectura(ctx);
    const previo = TA.previoALectura(ctx);
    vistos.add(`${r.estado}${r.puedeCalcular ? "+calc" : ""}`);
    if (r.sinCambios) vistos.add(`${r.estado}+sinCambios`);
    const tag = `${gNombre}/${JSON.stringify(config)}/fin=${finalizada}/comp=${lecturaCompleta}/rec=${rec}/edad=${edad}/dentro=${dentro}/tok=${token}/n=${nF}`;
    if (r.estado === "guardada" && !(g && typeof g === "object" && g.firma === "F" && g.version === TA.VERSION_AJUSTE && (clienteLaTiene || TA.decodificarTraza(g.traza)))) falla(`guardada sin firma/versión/traza buenas: ${tag}`);
    if (r.estado === "no_se_pudo_leer" && (r.puedeCalcular || r.traza)) falla(`no_se_pudo_leer con cálculo o traza: ${tag}`);
    if (r.estado === "apagada" && (r.traza || r.puedeCalcular || previo == null)) falla(`apagada lee o trae traza: ${tag}`);
    if (config.estado === "ok" && !config.guardar && finalizada && r.estado !== "apagada") falla(`guardar=false y no apagada: ${tag}`);
    if (!finalizada && r.estado !== "no_aplica") falla(`no finalizada y no no_aplica: ${tag}`);
    if (previo && JSON.stringify(previo) !== JSON.stringify(r)) falla(`previoALectura ≠ decidirLectura: ${tag}`);
    if (previo && JSON.stringify(TA.decidirLectura({ ...ctx, guardada: "error", clienteLaTiene: false })) !== JSON.stringify(r)) falla(`con previo, la guardada influye: ${tag}`);
    if (r.puedeCalcular && !(["falta", "desactualizada"].includes(r.estado) && dentro && token && nF >= 2)) falla(`puedeCalcular sin sus condiciones: ${tag}`);
    if (r.estado === "desactualizada" && r.puedeCalcular && !(rec < TA.MAX_RECALCULOS && Number.isFinite(edad) && edad >= TA.ESPERA_RECALCULO_MS)) falla(`recalcula sin tope o espera: ${tag}`);
    if ((!!r.traza || r.sinCambios === true) !== ["guardada", "desactualizada"].includes(r.estado)) falla(`(traza o sinCambios) ⇔ guardada|desactualizada: ${tag}`);
    if (r.sinCambios && (r.traza || !clienteLaTiene)) falla(`sinCambios con traza o sin que el cliente la tenga: ${tag}`);
    if (r.estado === "guardada" && !clienteLaTiene && !r.traza) falla(`guardada sin traza y el cliente no la tiene: ${tag}`);
    if (clienteLaTiene && r.estado === "guardada" && r.traza) falla(`reenvía una traza que el cliente ya tiene: ${tag}`);
    if (!r.detalle || !TA.MOTIVO_LECTURA[r.estado]) falla(`sin detalle o sin motivo declarado: ${tag}`);
    if (!lecturaCompleta && finalizada && config.estado === "ok" && config.guardar && r.estado !== "no_se_pudo_leer") falla(`lectura incompleta no es no_se_pudo_leer: ${tag}`);
    const tx = TA.textoEstadoTraza({ lectura: r });
    if (!tx.texto || tx.cae !== TA.MOTIVO_LECTURA[r.estado].cae) falla(`texto del chip: ${tag}`);
  }
  chk(`decidirLectura: ${combinaciones} combinaciones sin violar ninguna invariante`, malas === 0, `${malas} malas`);
  for (const e of ["guardada", "guardada+sinCambios", "desactualizada+sinCambios", "desactualizada", "desactualizada+calc", "falta+calc", "no_aplica", "apagada", "sin_migracion", "sin_token", "fuera_de_ventana", "no_se_pudo_leer"]) {
    chk(`corolario: el barrido produce «${e}»`, vistos.has(e));
  }
  chk("un servicio fuera de la ventana con su traza guardada la sigue sirviendo (es «para siempre»)",
    TA.decidirLectura({ finalizada: true, config: { estado: "ok", guardar: true }, lecturaCompleta: true, guardada: { version: TA.VERSION_AJUSTE, firma: "F", nFilas: 3, recalculos: 0, calculadoEn: new Date(AH).toISOString(), traza: trazaBuena }, firmaAhora: "F", nFilasAhora: 3, dentroDeVentana: false, tokenServidor: false, ahoraMs: AH }).estado === "guardada");

  // resultadoDelCalculo
  let cMalas = 0, cComb = 0;
  const cVistos = new Set<string>();
  const coordsOk: [number, number][] = [[-77, -12], [-77.001, -12.001], [-77.002, -12.0]];
  for (const coords of [coordsOk, [coordsOk[0]], []] as [number, number][][])
  for (const esCrudoBien of [true, false])
  for (const trans of [0, 1, 7])
  for (const abortado of [false, true]) {
    cComb++;
    const esCrudo = esCrudoBien ? coords.map(() => false) : [true];
    const r = TA.resultadoDelCalculo({ coords, esCrudo, colaSnapped: true, transitorios: trans, abortado });
    cVistos.add(r.codigo);
    if ((trans > 0 || abortado) && r.guardar) cMalas++;
    if (r.guardar && !(r.codigo === "calculada" && r.traza)) cMalas++;
    if (abortado && r.traza) cMalas++;
    if (!TA.MOTIVO_CALCULO[r.codigo]) cMalas++;
  }
  chk(`resultadoDelCalculo: ${cComb} combinaciones; con transitorios o abortado nunca se guarda`, cMalas === 0);
  chk("corolario: el barrido produce «calculada» (se guarda) y «calculada_sin_guardar»", cVistos.has("calculada") && cVistos.has("calculada_sin_guardar") && cVistos.has("excede_servicio") && cVistos.has("sin_filas") && cVistos.has("error"));
  // #1608: con el token del servidor rechazado (401/403) TODAS las ventanas caían al crudo y la traza se
  // guardaba igual. Ahora no se guarda, no se devuelve para dibujar, y el modal ajusta en el navegador.
  const rechazo = TA.resultadoDelCalculo({ coords: coordsOk, esCrudo: coordsOk.map(() => true), colaSnapped: false, transitorios: 0, abortado: false, rechazos: 12 });
  chk("#1608: token rechazado → «token_rechazado», sin guardar ni traza, y el modal ajusta en vivo",
    rechazo.codigo === "token_rechazado" && !rechazo.guardar && !rechazo.traza && TA.MOTIVO_CALCULO.token_rechazado.cae === "en_vivo_como_antes");
  chk("sin `rechazos` (llamadores viejos) el resultado no cambia",
    TA.resultadoDelCalculo({ coords: coordsOk, esCrudo: coordsOk.map(() => false), colaSnapped: true, transitorios: 0, abortado: false }).codigo === "calculada");
  chk("ninguna salida «guardada» del cálculo trae fallos: calculada_sin_guardar ya no se dibuja (ajusta en el navegador)",
    TA.MOTIVO_CALCULO.calculada_sin_guardar.cae === "sin_ajuste");
  const codigos: string[] = ["calculada", "calculada_sin_guardar", "ya_guardada", "en_curso", "presupuesto_agotado", "limite_usuario", "excede_servicio", "no_finalizada", "sin_filas", "apagada", "sin_migracion", "sin_token", "token_rechazado", "fuera_de_ventana", "error"];
  chk("MOTIVO_CALCULO declara los 15 códigos, cada uno con texto, qué dibuja y tono", codigos.length === Object.keys(TA.MOTIVO_CALCULO).length
    && codigos.every((c) => { const m = (TA.MOTIVO_CALCULO as any)[c]; return m && m.texto && ["guardada", "sin_ajuste", "en_vivo_como_antes"].includes(m.cae) && ["gris", "ambar"].includes(m.tono); }));
  chk("las frases del chip: «Ajustado ahora y guardado», «Ajuste guardado · calculado el …» (hora de Lima), «Ajustando en el navegador (sin guardar): …», «Ajustando en vivo (no se guarda): …»",
    TA.textoEstadoTraza({ calculo: { codigo: "calculada" } }).texto === "Ajustado ahora y guardado"
    && TA.textoEstadoTraza({ lectura: { estado: "guardada", puedeCalcular: false, detalle: "x", calculadoEn: "2026-10-14T15:07:00Z" } }).texto === "Ajuste guardado · calculado el 14/10/2026 10:07"
    && TA.textoEstadoTraza({ calculo: { codigo: "presupuesto_agotado" } }).texto.startsWith("Ajustando en el navegador (sin guardar): ")
    && TA.textoEstadoTraza({ calculo: { codigo: "sin_token" } }).texto.startsWith("Ajustando en vivo (no se guarda): ")
    && codigos.every((c) => TA.textoEstadoTraza({ calculo: { codigo: c as any } }).texto.length > 5));
}

// ══ 6 · huellaDelServicio = el bloque original de la ruta ═════════════════════════════════
seccion("6 · huellaDelServicio (+ lib/gps-huella-servicio.ts) = el bloque original de /api/cliente/gps");
{
  // (a) limaMs y tramoDelServicio sueltos.
  let iguales = 0, total = 0;
  const fechas = [null, undefined, "", "2026-10-09", "2026-02-29", "basura"];
  const horas = [null, undefined, "", "06:00", "06:00:00", "23:59:59", "6:5", "06:00:00.123", "xx"];
  for (const f of fechas) for (const h of horas) { total++; if (Object.is(HS.limaMs(f as any, h as any), RutaOriginal.limaMs(f as any, h as any))) iguales++; }
  for (let k = 0; k < 2000; k++) {
    const n = Math.floor(rnd() * 30);
    let t = T_BASE;
    const filas = Array.from({ length: n }, (_, i) => {
      t += rnd() < 0.15 ? Math.floor(rnd() * 3 * 3600_000) : Math.floor(rnd() * 60_000);
      return { id: i, created_at: rnd() < 0.05 ? null : new Date(t).toISOString(), timestamp: rnd() < 0.3 ? new Date(t + 500).toISOString() : null };
    });
    const ref = [null, T_BASE, T_BASE + 2 * 3600_000, T_BASE + 9e9][k % 4];
    const gap = [HS.HUECO_VIAJE_MS, 10 * 60_000][k % 2];
    total++;
    if (JSON.stringify(HS.tramoDelServicio(filas, gap, ref)) === JSON.stringify(RutaOriginal.tramoDelServicio(filas, gap, ref))
      && filas.every((x) => HS.tMs(x) === RutaOriginal.tMs(x))) iguales++;
  }
  chk(`limaMs, tramoDelServicio y tMs: ${iguales}/${total} idénticos`, iguales === total);
  chk("las constantes de la ventana son las de antes", HS.HUECO_VIAJE_MS === RutaOriginal.HUECO_VIAJE_MS && HS.MARGEN_PREVIO_MS === RutaOriginal.MARGEN_PREVIO_MS && HS.DURACION_MAX_MS === RutaOriginal.DURACION_MAX_MS);

  // (b) la respuesta entera, escenario por escenario, con el reloj fijo.
  const norm = (g: any) => (g ? { ...g, timestamp: g.timestamp ?? g.created_at ?? null } : g);
  const AH = Date.UTC(2026, 9, 9, 20, 0, 0);   // 15:00 Lima del 09-10
  const R = (id: number, fecha: string | null, hora: string | null, estado: string, v: number | null, vt: number | null) =>
    ({ id, fecha_servicio: fecha, hora_servicio: hora, estado, vehiculo_id: v, vehiculo_tercero_id: vt });
  const reservas = [
    R(1, "2026-10-09", "06:00:00", "finalizada", 5, null),
    R(2, "2026-10-09", "06:00:00", "finalizada", null, 7),
    R(3, "2026-10-09", "06:00", "en_curso", null, 7),
    R(4, null, null, "programada", null, 7),
    R(5, "2026-10-09", "18:00:00", "programada", null, 7),    // antes de la ventana
    R(6, "2026-10-09", "06:00:00", "programada", 5, null),     // sin iniciar: ventana exacta
    R(7, "2026-10-08", "22:00:00", "finalizada", null, 8),     // nocturno
  ];
  const gps: Fila[] = [
    ...viaje({ n: 1500, acc: accMixto, reservaId: 1, v: 5, t0: T_BASE - 20 * 60_000 }),                      // > 1000: pagina
    ...viaje({ n: 300, acc: () => (rnd() < 0.05 ? 2000 : accRed()), vt: 7, t0: T_BASE - 2 * 3600_000 }),     // traslado previo (fuera)
    ...viaje({ n: 500, acc: () => (rnd() < 0.05 ? 2000 : accRed()), vt: 7, t0: T_BASE - 10 * 60_000 }),      // el servicio del tercero
    ...viaje({ n: 200, acc: accRed, vt: 7, t0: T_BASE + 3 * 3600_000 }),                                     // segundo viaje (hueco > 30 min)
    ...viaje({ n: 300, acc: accChip, v: 5, t0: T_BASE + 2 * 3600_000 }),                                     // propio sin reserva_id
    ...viaje({ n: 400, acc: accChip, vt: 8, t0: Date.UTC(2026, 9, 9, 2, 30, 0) }),                            // nocturno
  ];
  const db: Db = { ubicaciones_gps: gps, reservas };
  const cuerpos: Array<[string, any]> = [
    ["reserva propia con 1 500 posiciones (paginado)", { huella: true, reservaId: 1, vehiculoId: 5 }],
    ["tercero por ventana (traslado previo y segundo viaje fuera)", { huella: true, reservaId: 2, vehiculoTerceroId: 7 }],
    ["tercero en curso", { huella: true, reservaId: 3, vehiculoTerceroId: 7 }],
    ["tercero sin fecha (últimas 12 h)", { huella: true, reservaId: 4, vehiculoTerceroId: 7 }],
    ["antes de la ventana", { huella: true, reservaId: 5, vehiculoTerceroId: 7 }],
    ["propio sin iniciar (ventana exacta)", { huella: true, reservaId: 6, vehiculoId: 5 }],
    ["nocturno de un tercero", { huella: true, reservaId: 7, vehiculoTerceroId: 8 }],
    ["reserva inexistente con vehículo", { huella: true, reservaId: 99, vehiculoId: 5 }],
    ["sin reserva, solo vehículo", { huella: true, vehiculoId: 5 }],
    ["sin nada", { huella: true }],
    ["reservaId como texto", { huella: true, reservaId: "1" }],
  ];
  const fallasBase: Array<[string, any]> = [["sin fallas", {}], ["falla la 2.ª página", { paginaGps: 2 }], ["falla la 1.ª página", { paginaGps: 1 }], ["falla la reserva", { reserva: true }]];
  let esc = 0, escIguales = 0;
  (Date as any).now = () => AH;
  for (const [nombreB, body] of cuerpos) {
    for (const [nombreF, fl] of fallasBase) {
      const bO = crearBase(db, fl), bN = crearBase(db, fl);
      const orig = await RutaOriginal.huella(bO, { ...body });
      const h = await HSD.huellaDelServicio(bN, { reservaId: body.reservaId ?? null, vehiculoId: body.vehiculoId ?? null, vehiculoTerceroId: body.vehiculoTerceroId ?? null });
      const nuevo = { huella: h.filasOk.map(norm), servicio: h.servicio };
      esc++;
      const igual = JSON.stringify(orig) === JSON.stringify(nuevo) && JSON.stringify(bO.llamadas) === JSON.stringify(bN.llamadas);
      if (igual) escIguales++;
      else chk(`${nombreB} · ${nombreF}`, false, `${JSON.stringify(orig).length} vs ${JSON.stringify(nuevo).length} B`);
      if (nombreF === "sin fallas" && process.env.DETALLE) console.log(`   ${nombreB}: ${nuevo.huella.length} posiciones · via ${nuevo.servicio.via} · completa ${h.completa}`);
    }
  }
  (Date as any).now = dateNowReal;
  chk(`${escIguales}/${esc} escenarios con la MISMA respuesta y las MISMAS consultas`, escIguales === esc && esc === cuerpos.length * fallasBase.length);
  // el reloj por defecto se consulta una vez, después de leer la reserva (donde la ruta llamaba a Date.now()).
  let consultas = 0;
  (Date as any).now = () => { consultas++; return AH; };
  await HSD.huellaDelServicio(crearBase(db), { reservaId: 2, vehiculoId: null, vehiculoTerceroId: 7 });
  (Date as any).now = dateNowReal;
  chk("con el reloj por defecto, huellaDelServicio lo consulta una sola vez", consultas === 1, `${consultas}`);
  // escenarios no triviales y la bandera `completa`
  const hT = await HSD.huellaDelServicio(crearBase(db), { reservaId: 2, vehiculoId: null, vehiculoTerceroId: 7 }, AH);
  chk(`el tercero se lee por ventana y se queda con SU tramo (${hT.filasOk.length} de 1000 posiciones de la unidad)`, hT.servicio.via === "vehiculo" && hT.filasOk.length > 300 && hT.filasOk.length < 500 && hT.completa);
  chk("el filtro de precisión quitó los fixes de torre", hT.filasOk.every((f) => f.precision_m == null || f.precision_m <= PRECISION_MAX_HUELLA_M));
  const hP = await HSD.huellaDelServicio(crearBase(db, { paginaGps: 2 }), { reservaId: 1, vehiculoId: 5, vehiculoTerceroId: null }, AH);
  chk("una página fallida conserva lo leído (como antes) pero marca la lectura como incompleta", hP.filasOk.length === 1000 && !hP.completa);
  const hR = await HSD.huellaDelServicio(crearBase(db), { reservaId: 1, vehiculoId: null, vehiculoTerceroId: null }, AH);
  chk("devuelve la reserva con sus vehículos (para que T3 los derive de ella, nunca del cuerpo)", hR.reserva?.estado === "finalizada" && hR.reserva?.vehiculo_id === 5 && hR.reserva?.vehiculo_tercero_id === null && hR.completa);

  // (c) la ruta ya no tiene la lógica inline: la importa.
  const ruta = fs.readFileSync(path.join(process.cwd(), "app/api/cliente/gps/route.ts"), "utf8");
  chk("app/api/cliente/gps/route.ts usa huellaDelServicio y ya no define limaMs/tramoDelServicio/las constantes",
    ruta.includes("huellaDelServicio(") && !/function limaMs|function tramoDelServicio|const HUECO_VIAJE_MS|const MARGEN_PREVIO_MS|const DURACION_MAX_MS/.test(ruta)
    && ruta.includes('if (reserva?.estado !== "finalizada") return NextResponse.json({ huella: filasOk.map(norm), servicio });')
    && ruta.includes("return NextResponse.json({ huella: filasOk.map(norm), servicio, ajustada });"));
}

// ══ 7 · sin red ══════════════════════════════════════════════════════════════════════════
seccion("7 · los módulos de lectura y la ruta no llaman a Mapbox ni hacen fetch(");
{
  const sinComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
  const PROHIBIDO = /matching\/v5|tilequery|mapMatchTrail|matchVentana|crearAjustadorHuella|fetch\(/i;
  const leerF = (f: string) => sinComentarios(fs.readFileSync(path.join(process.cwd(), f), "utf8"));
  for (const f of ["lib/gps-traza-ajustada.ts", "app/api/cliente/gps/route.ts", "lib/gps-huella-servicio.ts", "lib/gps-huella-servicio-datos.ts",
    "lib/gps-traza-ajustada-datos.ts", "app/api/seguimiento/traza-ajustada/route.ts", "app/api/gps/traza-ajustada/tick/route.ts"]) {
    const m = leerF(f).match(PROHIBIDO);
    chk(`${f}: sin Map Matching, Tilequery ni fetch(`, !m, m?.[0]);
  }
  chk("el detector no es ciego: encuentra el ajustador en lib/gps-traza-ajustada-calculo.ts y las llamadas en lib/huella.ts",
    PROHIBIDO.test(leerF("lib/gps-traza-ajustada-calculo.ts")) && PROHIBIDO.test(leerF("lib/huella.ts")));
  for (const f of ["lib/gps-traza-ajustada.ts", "lib/gps-huella-servicio.ts", "lib/gps-traza-ajustada-calculo.ts"]) {
    const src = leerF(f);
    chk(`${f}: PURO (no importa Supabase, ni next, ni lee process.env)`, !/@supabase|from "next|process\.env/.test(src));
  }
  {
    const calc = leerF("lib/gps-traza-ajustada-calculo.ts");
    const usos = calc.match(/[^.\w]fetch\(/g) ?? [];
    const enServidor = /export function fetchMapboxServidor[\s\S]*?return \(url\) => fetch\(url, \{ signal: AbortSignal\.timeout\(plazoMs\) \}\);/.test(calc);
    chk("lib/gps-traza-ajustada-calculo.ts: el fetch global solo dentro de fetchMapboxServidor (con plazo); el ajuste usa el inyectado", usos.length === 1 && enServidor);
  }
  chk("el lector pasa al ajuste el fetch inyectado o fetchMapboxServidor()", /d\?\.fetch \?\? fetchMapboxServidor\(\)/.test(leerF("lib/gps-traza-ajustada-datos.ts")));
  {
    const cob = await import("../lib/gps-cobertura-datos");
    chk("DIAS_CALCULO del módulo puro = DIAS_RASTREO del lector", TA.DIAS_CALCULO === cob.DIAS_RASTREO);
  }
  {
    const rTraza = fs.readFileSync(path.join(process.cwd(), "app/api/seguimiento/traza-ajustada/route.ts"), "utf8");
    chk("la ruta de cálculo: módulos seguimiento/monitoreo/vehiculos o token del portal con su reserva; vehículos de la reserva (el cuerpo solo trae el id)",
      /verificarUsuarioApiAlguno\(req, MODULOS\)/.test(rTraza) && /\["seguimiento", "monitoreo", "vehiculos"\]/.test(rTraza)
      && /reservaEsDelCliente\(/.test(rTraza) && !/body\??\.vehiculo/.test(rTraza) && /maxDuration = 60/.test(rTraza) && /crearTurno\(2, 6\)/.test(rTraza));
    const rTick = fs.readFileSync(path.join(process.cwd(), "app/api/gps/traza-ajustada/tick/route.ts"), "utf8");
    const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"));
    chk("el cron falla cerrado (esCronAutorizado) y está en vercel.json a las «15 * * * *»",
      /if \(!esCronAutorizado\(req\)\)/.test(rTick) && vercel.crons.some((c: any) => c.path === "/api/gps/traza-ajustada/tick" && c.schedule === "15 * * * *"));
    const todo = ["lib/gps-traza-ajustada-datos.ts", "app/api/seguimiento/traza-ajustada/route.ts", "app/api/gps/traza-ajustada/tick/route.ts", "app/api/cliente/gps/route.ts"]
      .map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
    chk("ni el token ni una URL de Mapbox van a un log ni a una respuesta", !/console\.\w+\([^)]*(token|url)\b/i.test(todo) && !/NEXT_PUBLIC_MAPBOX_TOKEN/.test(leerF("lib/gps-traza-ajustada-datos.ts")));
  }
}

seccion("fin");
console.log(`\nsecciones: ${conteos.join(" · ")}`);
console.log(`\n${fallas ? "❌" : "✅"} prueba-traza-ajustada: ${ok} ok, ${fallas} fallas${pendientes ? `, ${pendientes} pendientes (T3)` : ""}`);
if (fallas) process.exit(1);
