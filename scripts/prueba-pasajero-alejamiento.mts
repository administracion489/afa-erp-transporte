// Pruebas de «SE ALEJA» / «YA PASÓ» / «Tu bus está llegando» en la app del PASAJERO. NO tocan
// la base: datos en memoria contra el motor puro lib/pasajero-alejamiento.ts.
// Uso:  npx tsx scripts/prueba-pasajero-alejamiento.mts   (sale con código 1 si algo falla)
//
// EL CASO (reserva #30204, PIERIPLAST, 09-10-2026): el bus llegó al PRIMER paradero y esperó ahí
// 16 minutos. El pasajero del paradero 2 veía «SE ALEJA · El bus se aleja de tu paradero»: la racha
// de alejamiento se hizo mientras el bus iba HACIA el paradero 1 (ese tramo lo alejaba del 2) y, sin
// puerta de quietud, el jitter la sigue sumando con el bus parado. Es el mismo defecto que ya se
// arregló en el modal del operador (scripts/prueba-se-aleja.mts), en la otra copia de la máquina.
//
// LA TRAMPA DE LA PRIMERA VERSIÓN, que esta matriz existe también para no repetir: leer «la
// distancia no creció» como «el bus viene». Con el bus DETENIDO tras alejarse —en un semáforo
// después de pasarme, o esperando en el paradero anterior— volvían la cuenta regresiva, el «llega
// HH:MM», el «En N min», el banner «Tu bus está llegando · dirígete al paradero» y, peor, se
// liberaba el DISPARO de ese aviso de un solo uso. Y una ventana vacía (filas cada 65 s) se leía
// como «no se aleja» y callaba el «SE ALEJA» durante toda la marcha.
//
// Lo que fija esta matriz (por sección):
//   1. el caso #30204 desde el pasajero: el viejo pinta «SE ALEJA», el nuevo queda NEUTRAL (ni
//      «SE ALEJA» ni cuenta regresiva) y no dispara el aviso;
//   2. se acerca despacio desde más lejos que su mínimo: el viejo dice «se aleja», esconde la cuenta
//      regresiva y «Tu bus está llegando»; y una racha vieja retrasa el disparo. El nuevo, nada de eso;
//   3. EL LADO QUE NO SE AFLOJA: «YA PASÓ» igual que antes; el que se va en sentido contrario sigue
//      dando «SE ALEJA»; DETENIDO tras alejarse no vuelve la cuenta regresiva ni el banner ni se
//      dispara el aviso (semáforo, paradero anterior, app abierta con el bus ya pasado, hueco de
//      filas); y con filas espaciadas (sin evidencia del presente) se conserva el veredicto viejo;
//   4. LA EXTRACCIÓN: el bloque ORIGINAL de app/pasajero/page.tsx, copiado literal, contra el
//      módulo extraído (+ el pegamento nuevo de la página, también copiado literal) sobre cientos de
//      miles de muestras al azar: mismos setState y mismo estado en CADA muestra. Y sobre las mismas
//      trazas, el BARRIDO: nuevo ⊆ viejo en todo lo que se afirma, y cada diferencia con su
//      evidencia del presente — callar un «SE ALEJA» exige evidencia EN CONTRA; devolver una cuenta
//      regresiva o liberar el disparo exige la distancia BAJANDO;
//   5. la lectura en presente de lib/avance-paradas.ts: `distanciaCrecio` sigue contestando lo mismo
//      que la versión anterior (copiada literal), y «viene» es el espejo exacto de «aleja»;
//   6. la tabla de `lecturaPasajero` y `bloqueaAvisoLlegada` contra el original, combinación por
//      combinación;
//   7. EL CABLEADO DE LA PÁGINA: app/pasajero/page.tsx contiene el pegamento copiado aquí y llama a
//      las dos funciones puras en los sitios donde antes decidía a mano. Sin esto, revertir la página
//      dejaría esta matriz en verde.
import { readFileSync } from "node:fs";
import {
  segInicial, pasoSeguimiento, bloqueaAvisoLlegada, lecturaPasajero, RACHA_ALEJA_PASAJERO,
  type SeguimientoPasajero, type TendenciaPresente,
} from "../lib/pasajero-alejamiento";
import { distanciaCrecio, tendenciaPresente, type MuestraReciente } from "../lib/avance-paradas";
import { distM } from "../lib/huella";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── Tipos de la página (los mínimos que el bloque lee) ───────────────────────────────
type Parada = { id: number; lat: number | string | null; lng: number | string | null };
type UbicacionBus = {
  lat: number | string; lng: number | string;
  timestamp?: string | number | null; created_at?: string | null;
  /** km/h, como `ubicaciones_gps.velocidad`: lo que la página le pasa a calcETA. */
  velocidad?: number;
};

// ── `dist` de app/pasajero/page.tsx, copiada literal ─────────────────────────────────
function dist(lat1:number,lng1:number,lat2:number,lng2:number): number {
  const R=6371000,φ1=lat1*Math.PI/180,φ2=lat2*Math.PI/180,Δφ=(lat2-lat1)*Math.PI/180,Δλ=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(Δφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
// `calcETA` de la página, copiada literal (para el disparo de «Tu bus está llegando»). Con la
// velocidad de CADA muestra, como la página: detenido (≤ 5 km/h) supone 25 km/h, así que la banda de
// 5 min se ENSANCHA a 2.08 km justo cuando el bus se para.
function calcETA(d:number,v:number): number { return Math.ceil((d/1000)/(v>5?v:25)*60); }

// ── EL ORIGINAL: app/pasajero/page.tsx antes del cambio, copiado LITERAL ──────────────
// Solo cambia el envoltorio: el cuerpo del efecto pasa a una función que recibe lo que el efecto
// leía del cierre, y los setState se GRABAN en `llamadas` en vez de ejecutarse.
const segInicialViejo = () => ({ minDist: Infinity, lastD: null as number | null, lastTs: 0, lastLat: null as number | null, lastLng: null as number | null, recStreak: 0, apprStreak: 0 });
type SegViejo = ReturnType<typeof segInicialViejo>;

function bloqueViejo(
  segRef: { current: SegViejo },
  busPosicion: UbicacionBus, miEstado: string, miParada: Parada | null, rutaParadas: Parada[],
  llamadas: string[],
) {
  const setBusPasoMiParada = (v: boolean) => llamadas.push(`paso:${v}`);
  const setBusAlejando     = (v: boolean) => llamadas.push(`alejando:${v}`);
    if (miEstado === "esperando" && miParada?.lat && miParada?.lng) {
      const dMia = dist(Number(busPosicion.lat), Number(busPosicion.lng), Number(miParada.lat), Number(miParada.lng));
      const ts   = new Date(busPosicion.timestamp ?? busPosicion.created_at ?? 0).getTime();
      const s    = segRef.current;

      // El polling repite la misma fila GPS entre envíos del conductor (~10 s): solo
      // procesamos muestras NUEVAS para no contar la misma posición varias veces.
      if (ts > 0 && ts !== s.lastTs) {
        const busLat = Number(busPosicion.lat), busLng = Number(busPosicion.lng);
        const dt       = s.lastTs ? (ts - s.lastTs) / 1000 : 0;
        const saltoBus = s.lastLat != null ? dist(s.lastLat, s.lastLng!, busLat, busLng) : 0;
        // Descartar muestras físicamente imposibles (glitch de GPS): un bus urbano no supera
        // ~120 km/h (34 m/s). Sin este filtro una lectura errónea que caiga cerca de mi paradero
        // envenenaría minDist (mínimo monótono) y dispararía un falso "ya pasó" con el bus aún viniendo.
        const glitch = s.lastLat != null && dt > 0 && saltoBus > 400 && saltoBus / dt > 34;
        if (!glitch) {
          if (dMia < s.minDist) s.minDist = dMia;   // punto más cercano alcanzado
          const gap = dMia - s.minDist;             // cuánto se alejó de ese punto más cercano

          // Tendencia medida contra el punto MÁS CERCANO (no contra la muestra previa): así un
          // bus lento en tráfico que se aleja de a pocos (<40 m por muestra) igual acumula
          // alejamiento — el bug original se daba justo con buses lentos que "se despegaban" poco a poco.
          const bajando = s.lastD != null && dMia < s.lastD - 40;   // se acercó vs. la muestra previa
          if      (gap > 60)            { s.recStreak++;  s.apprStreak = 0; }  // se aleja de su mínimo
          else if (gap < 25 || bajando) { s.apprStreak++; s.recStreak  = 0; }  // en su mínimo o regresando
          // zona intermedia (25–60 m sin acercarse): conservar las rachas
          s.lastD = dMia; s.lastTs = ts; s.lastLat = busLat; s.lastLng = busLng;

          // Paradero SIGUIENTE al mío en la ruta (rutaParadas llega ordenada por `orden`).
          const idxMia = rutaParadas.findIndex((p) => p.id === miParada.id);
          const paradaSiguiente = idxMia >= 0 && idxMia < rutaParadas.length - 1 ? rutaParadas[idxMia + 1] : null;

          // Señales de que el bus quedó "aguas abajo" de mi paradero (para el aviso ROJO):
          //  A) ahora está MÁS CERCA del paradero siguiente que del mío → avanzó por la ruta
          //     (robusto a coords imprecisas; distingue "pasó de verdad" de "fue al retorno").
          //  B) se acercó de verdad (<450 m) y ya quedó MUY atrás (+600 m, más que un retorno típico
          //     de una avenida con separador, para no gritar "ya pasó" cuando el bus da la vuelta a recoger).
          const masCercaDelSiguiente = paradaSiguiente?.lat != null && paradaSiguiente?.lng != null &&
            dist(busLat, busLng, Number(paradaSiguiente.lat), Number(paradaSiguiente.lng)) < dMia;
          const dejoAtrasClaro = s.minDist < 450 && gap > 600;
          const sostenido = s.recStreak >= 3;   // ~3 muestras seguidas alejándose

          if (sostenido && (masCercaDelSiguiente || dejoAtrasClaro)) {
            // Confianza alta: el bus pasó mi paradero y sigue de largo → aviso rojo + cortar cuenta regresiva.
            setBusPasoMiParada(true);
            setBusAlejando(true);
          } else if (sostenido) {
            // Alejamiento sostenido sin confirmación locacional fuerte (p. ej. sobrepasa hacia un
            // retorno): no mostramos cuenta regresiva engañosa, pero aún no el aviso rojo de "ya pasó".
            setBusAlejando(true);
          } else if (s.apprStreak >= 2 && dMia < 400) {
            // El bus REGRESÓ y está cerca otra vez (fue al retorno / dio la vuelta a recoger):
            // limpiar AMBOS avisos y re-sembrar el mínimo. Exigir cercanía (<400 m) distingue un
            // retorno real (el bus vuelve al paradero) de una curva de la vía que solo acorta la
            // distancia en línea recta mientras el bus se va de verdad → así no borramos un "ya pasó" legítimo.
            setBusAlejando(false);
            setBusPasoMiParada(false);
            s.minDist = dMia;
            s.recStreak = 0;
          }
        }
      }
    }
}

// Los DERIVADOS del original (bloque «Derivados» y los tres sitios del banner), copiados literal.
// `banner` es la parte del filtro del banner que miraba la dirección: `!busPasoMiParada && !busAlejando`.
function derivadosViejos(miEstado: string, busPasoMiParada: boolean, busAlejando: boolean, estadoBus: string) {
  const esperando = miEstado === "esperando";
  const yaPaso    = esperando && busPasoMiParada;
  const seAleja   = esperando && busAlejando && estadoBus !== "sin_señal" && estadoBus !== "finalizado";
  const busYaNoViene = yaPaso || seAleja;
  const banner = !busPasoMiParada && !busAlejando;
  return { yaPaso, seAleja, busYaNoViene, escondeLlegada: !banner };
}

// ── EL NUEVO: el pegamento de app/pasajero/page.tsx, copiado literal, sobre el módulo ──
// Lo que va entre las dos marcas ⟦PEGAMENTO⟧ tiene que aparecer TAL CUAL en la página (sección 7).
// Devuelve el `presente` que la página asigna (undefined si el bloque no corrió).
function bloqueNuevo(
  segRef: { current: SeguimientoPasajero },
  busPosicion: UbicacionBus, miEstado: string, miParada: Parada | null, rutaParadas: Parada[],
  llamadas: string[],
): TendenciaPresente | undefined {
  const setBusPasoMiParada = (v: boolean) => llamadas.push(`paso:${v}`);
  const setBusAlejando     = (v: boolean) => llamadas.push(`alejando:${v}`);
  let presenteAsignado: TendenciaPresente | undefined;
  const setPresente = (v: TendenciaPresente) => { presenteAsignado = v; };
  // ⟦PEGAMENTO⟧
    if (miEstado === "esperando" && miParada?.lat && miParada?.lng) {
      const dMia = dist(Number(busPosicion.lat), Number(busPosicion.lng), Number(miParada.lat), Number(miParada.lng));
      const ts   = new Date(busPosicion.timestamp ?? busPosicion.created_at ?? 0).getTime();
      const busLat = Number(busPosicion.lat), busLng = Number(busPosicion.lng);

      // Paradero SIGUIENTE al mío en la ruta (rutaParadas llega ordenada por `orden`). Su distancia
      // alimenta la señal A de "ya pasó" (el bus quedó más cerca del siguiente que del mío).
      const idxMia = rutaParadas.findIndex((p) => p.id === miParada.id);
      const paradaSiguiente = idxMia >= 0 && idxMia < rutaParadas.length - 1 ? rutaParadas[idxMia + 1] : null;
      const dSiguiente = paradaSiguiente?.lat != null && paradaSiguiente?.lng != null
        ? dist(busLat, busLng, Number(paradaSiguiente.lat), Number(paradaSiguiente.lng))
        : null;

      // La máquina (dedupe por ts, filtro de glitch, rachas, "ya pasó"/"se aleja"/"regresó") vive
      // en lib/pasajero-alejamiento.ts, extraída tal cual estaba aquí. Devuelve qué setState hacer.
      const r = pasoSeguimiento(segRef.current, { lat: busLat, lng: busLng, ts, dMia, dSiguiente, miParada });
      segRef.current = r.estado;
      if (r.accion === "paso") {
        // Confianza alta: el bus pasó mi paradero y sigue de largo → aviso rojo + cortar cuenta regresiva.
        setBusPasoMiParada(true);
        setBusAlejando(true);
      } else if (r.accion === "alejando") {
        // Alejamiento sostenido sin confirmación locacional fuerte: sin cuenta regresiva engañosa.
        setBusAlejando(true);
      } else if (r.accion === "regreso") {
        // El bus REGRESÓ y está cerca otra vez: limpiar AMBOS avisos.
        setBusAlejando(false);
        setBusPasoMiParada(false);
      }
      // La lectura EN PRESENTE se asigna siempre (también en el dedupe: la ventana no cambió).
      setPresente(r.presente);
    }
  // ⟦PEGAMENTO⟧
  return presenteAsignado;
}

// ── La PÁGINA simulada: los dos lados a la vez sobre la misma traza ──────────────────
// Bus en vivo (ni sin señal ni finalizado) y pasajero esperando. El viejo deriva con
// `derivadosViejos` (literal); el nuevo, con `lecturaPasajero` — la MISMA función que llama la
// página (la sección 7 lo comprueba en el código de la página).
type Lado = {
  seg: { current: SegViejo } | { current: SeguimientoPasajero };
  busPaso: boolean; busAlejando: boolean; presente: TendenciaPresente;
  alerta: boolean;      // alertaRef.current / alerta5min
};
type Vista = {
  yaPaso: boolean; seAleja: boolean; pill: string;
  sinCuenta: boolean;        // busYaNoViene: sin cuenta regresiva, sin «En vivo · llega», sin «En N min»
  escondeLlegada: boolean;   // la parte del filtro del banner que mira la dirección
  bannerLlegada: boolean;    // «Tu bus está llegando» visible
  disparoBloqueado: boolean; // en esta muestra, ¿el disparo de la alerta habría quedado bloqueado?
  disparo: boolean;          // ¿se disparó en ESTA muestra?
  pasoAlDisparar: boolean;   // el «YA PASÓ» en pantalla cuando se juzgó el disparo
  presente: TendenciaPresente;        // (nuevo) tras procesar la muestra
  presenteDisparo: TendenciaPresente; // (nuevo) el que juzgó el disparo: el de la muestra anterior
};
const aplicar = (lado: Lado, llamadas: string[]) => {
  for (const c of llamadas) {
    const [k, v] = c.split(":");
    if (k === "paso") lado.busPaso = v === "true"; else lado.busAlejando = v === "true";
  }
};
function pill(yaPaso: boolean, seAleja: boolean) { return yaPaso ? "YA PASÓ" : seAleja ? "SE ALEJA" : "EN VIVO"; }

class Pagina {
  viejo: Lado = { seg: { current: segInicialViejo() }, busPaso: false, busAlejando: false, presente: null, alerta: false };
  nuevo: Lado = { seg: { current: segInicial() }, busPaso: false, busAlejando: false, presente: null, alerta: false };
  difLlamadas = 0; difEstado = 0; primeraDif = "";
  acciones = { paso: 0, alejando: 0, regreso: 0 };
  constructor(public miParada: Parada, public ruta: Parada[]) {}

  /** Una muestra. Antes del bloque direccional, como en la página: el disparo de la alerta lee el
   *  seguimiento de la muestra ANTERIOR (y el «YA PASÓ» que está en pantalla). */
  muestra(bp: UbicacionBus): { viejo: Vista; nuevo: Vista } {
    const mp = this.miParada;
    const d = dist(Number(bp.lat), Number(bp.lng), Number(mp.lat), Number(mp.lng));
    const eta = calcETA(d, bp.velocidad as number);
    const segN = this.nuevo.seg.current as SeguimientoPasajero;
    // Disparo: el viejo exigía `segRef.current.recStreak < 3`; el nuevo, `!bloqueaAvisoLlegada(...)`.
    const bloqViejo = !((this.viejo.seg.current as SegViejo).recStreak < 3);
    const bloqNuevo = bloqueaAvisoLlegada(segN, mp, this.nuevo.busPaso);
    const presenteDisparo = tendenciaPresente(segN.recientes, mp);
    const pasoAlDisparar = this.nuevo.busPaso;
    const dispV = eta <= 5 && !this.viejo.alerta && !bloqViejo;
    const dispN = eta <= 5 && !this.nuevo.alerta && !bloqNuevo;
    if (dispV) this.viejo.alerta = true;
    if (dispN) this.nuevo.alerta = true;

    const lv: string[] = [], ln: string[] = [];
    bloqueViejo(this.viejo.seg as { current: SegViejo }, bp, "esperando", mp, this.ruta, lv);
    const pr = bloqueNuevo(this.nuevo.seg as { current: SeguimientoPasajero }, bp, "esperando", mp, this.ruta, ln);
    aplicar(this.viejo, lv); aplicar(this.nuevo, ln);
    if (lv[0] === "paso:true") this.acciones.paso++;
    else if (lv[0] === "alejando:true") this.acciones.alejando++;
    else if (lv[0] === "alejando:false") this.acciones.regreso++;
    if (pr !== undefined) this.nuevo.presente = pr;

    // Paridad de la extracción: mismos setState, mismo estado.
    if (lv.join() !== ln.join()) { this.difLlamadas++; this.primeraDif ||= `llamadas ${lv.join()} vs ${ln.join()}`; }
    const sv = this.viejo.seg.current as SegViejo, sn = this.nuevo.seg.current as SeguimientoPasajero;
    for (const k of ["minDist", "lastD", "lastTs", "lastLat", "lastLng", "recStreak", "apprStreak"] as const) {
      if (!Object.is(sv[k], sn[k])) { this.difEstado++; this.primeraDif ||= `${k}: ${sv[k]} vs ${sn[k]}`; break; }
    }

    const v = derivadosViejos("esperando", this.viejo.busPaso, this.viejo.busAlejando, "en_camino");
    const n = lecturaPasajero({
      esperando: true, busPasoMiParada: this.nuevo.busPaso, busAlejando: this.nuevo.busAlejando,
      presente: this.nuevo.presente, senalViva: true,
    });
    return {
      viejo: {
        yaPaso: v.yaPaso, seAleja: v.seAleja, pill: pill(v.yaPaso, v.seAleja), sinCuenta: v.busYaNoViene,
        escondeLlegada: v.escondeLlegada, bannerLlegada: this.viejo.alerta && !v.escondeLlegada,
        disparoBloqueado: bloqViejo, disparo: dispV, pasoAlDisparar, presente: null, presenteDisparo: null,
      },
      nuevo: {
        yaPaso: n.yaPaso, seAleja: n.seAleja, pill: pill(n.yaPaso, n.seAleja), sinCuenta: n.busYaNoViene,
        escondeLlegada: n.escondeLlegada, bannerLlegada: this.nuevo.alerta && !n.escondeLlegada,
        disparoBloqueado: bloqNuevo, disparo: dispN, pasoAlDisparar, presente: this.nuevo.presente, presenteDisparo,
      },
    };
  }
}

// ── Geometría local en metros (x este, y norte) ──────────────────────────────────────
const LAT0 = -12.03, LNG0 = -76.95;
const K_LAT = 111_320, K_LNG = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const aGeo = (x: number, y: number) => ({ lat: LAT0 + y / K_LAT, lng: LNG0 + x / K_LNG });

// PRNG con semilla: la matriz tiene que dar lo mismo en cada corrida.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = Date.parse("2026-10-09T11:00:00Z");
const fila = (x: number, y: number, ts: number, velocidad: number): UbicacionBus =>
  ({ ...aGeo(x, y), timestamp: new Date(ts).toISOString(), velocidad });

/** Recorrido en línea recta de A a B a `v` m/s, una muestra cada `paso` s (sin la de salida). La
 *  velocidad que reporta cada fila es la del tramo, en km/h. */
function tramo(x0: number, y0: number, x1: number, y1: number, v: number, t0: number, paso = 5): { f: UbicacionBus[]; t: number } {
  const largo = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.round(largo / v / paso));
  const f: UbicacionBus[] = [];
  for (let k = 1; k <= n; k++) f.push(fila(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, t0 + k * paso * 1000, v * 3.6));
  return { f, t: t0 + n * paso * 1000 };
}
/** Bus detenido en (x, y) con jitter de hasta `jitter` m, una muestra cada `paso` s, velocidad 0. */
function detenido(x: number, y: number, t0: number, minutos: number, rnd: () => number, jitter = 15, paso = 10): { f: UbicacionBus[]; t: number } {
  const f: UbicacionBus[] = [];
  let t = t0;
  for (let s = paso; s <= minutos * 60; s += paso) {
    const r = jitter * Math.sqrt(rnd()), a = rnd() * 2 * Math.PI;
    t = t0 + s * 1000;
    f.push(fila(x + r * Math.cos(a), y + r * Math.sin(a), t, 0));
  }
  return { f, t };
}
const dMiaDe = (f: UbicacionBus, mp: Parada) => dist(Number(f.lat), Number(f.lng), Number(mp.lat), Number(mp.lng));

/** Paraderos en línea al sur: el 1 en el origen, el 2 (EL MÍO) a 6.1 km (la distancia del caso
 *  real), el 3 más allá. */
const P = (id: number, x: number, y: number): Parada => ({ id, ...aGeo(x, y) });
const RUTA = [P(1, 0, 0), P(2, 0, -6100), P(3, 0, -9000)];
const MIA = RUTA[1];

// ── 1. EL CASO #30204 desde el pasajero: esperando en el paradero ANTERIOR ───────────
// Viene desde la cochera (5 km al este, 3.5 km al sur) a 30 km/h hacia el paradero 1: ese tramo
// lo ALEJA de mi paradero (el 2). Llega y espera 16 min con jitter de GPS, a velocidad 0.
console.log("1. El caso #30204");
const pg1 = new Pagina(MIA, RUTA);
const llegada = tramo(5000, -3500, 0, 0, 8.33, T0);
let ultima1 = { viejo: {} as Vista, nuevo: {} as Vista };
for (const f of llegada.f) ultima1 = pg1.muestra(f);
chk("premisa: al llegar al paradero 1 el viejo ya dice «SE ALEJA» (se alejaba del 2, es cierto)", ultima1.viejo.pill === "SE ALEJA", ultima1.viejo.pill);
const espera = detenido(0, 0, llegada.t, 16, mulberry32(30204));
let nuevoMalTrasMinuto = 0, primerQuieto: number | null = null, cuentaEnEspera = 0, disparosEnEspera = 0;
espera.f.forEach((f, i) => {
  ultima1 = pg1.muestra(f);
  const t = (i + 1) * 10;
  if (!ultima1.nuevo.seAleja && primerQuieto == null) primerQuieto = t;
  if (t > 70 && ultima1.nuevo.seAleja) nuevoMalTrasMinuto++;
  if (!ultima1.nuevo.sinCuenta || !ultima1.nuevo.escondeLlegada) cuentaEnEspera++;
  if (ultima1.nuevo.disparo) disparosEnEspera++;
});
chk("(regresión) tras 16 min quieto en el paradero 1, el viejo pinta «SE ALEJA»", ultima1.viejo.pill === "SE ALEJA", ultima1.viejo.pill);
chk("el nuevo NO pinta «SE ALEJA» con el bus esperando", ultima1.nuevo.pill === "EN VIVO", ultima1.nuevo.pill);
chk("a más tardar al minuto y pico de detenerse deja de decirlo", primerQuieto != null && primerQuieto <= 70, `a los ${primerQuieto} s`);
chk("y no vuelve a decirlo mientras sigue detenido", nuevoMalTrasMinuto === 0, `${nuevoMalTrasMinuto} muestra(s)`);
chk("la pantalla queda NEUTRAL: sin cuenta regresiva ni banner en toda la espera (el bus no viene)",
  cuentaEnEspera === 0, `${cuentaEnEspera} muestra(s) con cuenta o banner`);
chk("y no dispara «Tu bus está llegando»", disparosEnEspera === 0 && !pg1.nuevo.alerta);
chk("«YA PASÓ» no se enciende en ninguno (el bus nunca estuvo cerca del 2)", !ultima1.viejo.yaPaso && !ultima1.nuevo.yaPaso);
chk("la racha histórica sigue intacta (no se tocó la máquina)", (pg1.nuevo.seg.current as SeguimientoPasajero).recStreak >= RACHA_ALEJA_PASAJERO && pg1.nuevo.busAlejando);

// ── 2. SE ACERCA DESPACIO desde más lejos que el mínimo ──────────────────────────────
// Tras la espera sale hacia mi paradero a 15 km/h (≈21 m por muestra: menos que los 40 m de
// `bajando`). El mínimo (5.6 km) se registró en la cochera, así que durante ~400 m el gap sigue por
// encima de 60 m y la racha sube: el viejo sigue diciendo «se aleja» hasta quedar a <400 m.
console.log("\n2. Se acerca desde más lejos que su mínimo");
{
  const pg = pg1;
  const hacia = tramo(0, 0, 0, -6050, 4.17, espera.t);
  let viejoDice = 0, nuevoDice = 0, viejoEsconde = 0, nuevoEsconde = 0, nuevoMuestra = 0, cuentaRecuperada = 0;
  for (const f of hacia.f) {
    const v = pg.muestra(f);
    if (v.viejo.seAleja) viejoDice++;
    if (v.nuevo.seAleja) nuevoDice++;
    if (pg.viejo.alerta && !v.viejo.bannerLlegada && !v.viejo.yaPaso) viejoEsconde++;
    if (pg.nuevo.alerta && !v.nuevo.bannerLlegada && !v.nuevo.yaPaso) nuevoEsconde++;
    if (v.nuevo.bannerLlegada) nuevoMuestra++;
    if (v.viejo.sinCuenta && !v.nuevo.sinCuenta) cuentaRecuperada++;
  }
  chk("(regresión) el viejo dice «se aleja» con el bus viniendo hacia mí", viejoDice > 0, `${viejoDice} muestra(s)`);
  chk("el nuevo no lo dice en ninguna muestra del acercamiento", nuevoDice === 0, `${nuevoDice} muestra(s)`);
  chk("el nuevo devuelve la cuenta regresiva que el viejo escondía (la distancia BAJA)", cuentaRecuperada > 0, `${cuentaRecuperada} muestra(s)`);
  chk("(regresión) el viejo esconde «Tu bus está llegando» con el aviso ya disparado", viejoEsconde > 0, `${viejoEsconde} muestra(s)`);
  chk("el nuevo no lo esconde y lo muestra", nuevoEsconde === 0 && nuevoMuestra > 0, `escondido ${nuevoEsconde} · visible ${nuevoMuestra}`);
  chk("al llegar al paradero ninguno dice «YA PASÓ»", !pg.viejo.busPaso && !pg.nuevo.busPaso);
  chk("las dos copias de la máquina hicieron exactamente lo mismo en todo el caso",
    pg.difLlamadas === 0 && pg.difEstado === 0, pg.primeraDif);
}

// Una racha VIEJA bloquea el DISPARO del aviso. El bus pasó por una avenida paralela a 700 m de mi
// paradero en tráfico lento (6 km/h: la banda de 5 min es de 500 m, así que no se disparó), siguió
// 1.5 km igual de lento y vuelve a 30 km/h (banda de 2.5 km). Mientras siga más lejos que su
// mínimo + 60 m, el viejo suma racha —el gap se mira antes que `bajando`— y el disparo exigía
// `recStreak < 3`: el aviso salía recién a ~760 m (2 min) en vez de al entrar a los 5 min.
{
  const pg = new Pagina(MIA, RUTA);
  const ida = tramo(-1500, -5400, 0, -5400, 1.67, T0);              // paralela, a 700 m del 2
  const sigue = tramo(0, -5400, 1500, -5400, 1.67, ida.t);          // se aleja 1.5 km, lento
  for (const f of [...ida.f, ...sigue.f]) pg.muestra(f);
  chk("premisa: en la pasada lenta no se disparó el aviso", !pg.viejo.alerta && !pg.nuevo.alerta);
  const vuelve = tramo(1500, -5400, 0, -6050, 8.33, sigue.t);       // y vuelve a 30 km/h
  let distViejo: number | null = null, distNuevo: number | null = null, presenteAlDisparar: TendenciaPresente = null;
  for (const f of vuelve.f) {
    const v = pg.muestra(f);
    if (v.viejo.disparo) distViejo = dMiaDe(f, MIA);
    if (v.nuevo.disparo) { distNuevo = dMiaDe(f, MIA); presenteAlDisparar = v.nuevo.presenteDisparo; }
  }
  chk("(regresión) con la racha vieja, el viejo dispara «Tu bus está llegando» tarde (< 800 m)",
    distViejo != null && distViejo < 800, `a ${distViejo?.toFixed(0)} m`);
  chk("el nuevo lo dispara en cuanto el bus viene (> 1.2 km)",
    distNuevo != null && distNuevo > 1200, `a ${distNuevo?.toFixed(0)} m`);
  chk("…y lo libera la distancia BAJANDO, no la falta de alejamiento", presenteAlDisparar === "viene", String(presenteAlDisparar));
  chk("las dos copias de la máquina hicieron exactamente lo mismo", pg.difLlamadas === 0 && pg.difEstado === 0, pg.primeraDif);
}

// ── 3. EL LADO QUE NO SE AFLOJA ──────────────────────────────────────────────────────
console.log("\n3. El lado que no se afloja");
// (a) Pasa mi paradero y sigue de largo hacia el 3: «YA PASÓ» en los dos, en la MISMA muestra.
{
  const pg = new Pagina(MIA, RUTA);
  const r = tramo(0, -3000, 0, -9000, 8.33, T0);
  let iV: number | null = null, iN: number | null = null, ult = { viejo: {} as Vista, nuevo: {} as Vista };
  r.f.forEach((f, i) => {
    ult = pg.muestra(f);
    if (iV == null && ult.viejo.yaPaso) iV = i;
    if (iN == null && ult.nuevo.yaPaso) iN = i;
  });
  chk("el que pasa mi paradero y sigue de largo da «YA PASÓ» (nuevo)", ult.nuevo.pill === "YA PASÓ", ult.nuevo.pill);
  chk("…en la misma muestra que el viejo", iV != null && iV === iN, `viejo ${iV} · nuevo ${iN}`);
  // Y «ya pasó» es DURABLE: detenido después en el paradero 3, sigue diciéndolo.
  const quieto = detenido(0, -9000, r.t, 5, mulberry32(9));
  for (const f of quieto.f) ult = pg.muestra(f);
  chk("«YA PASÓ» se conserva con el bus detenido después (conclusión durable)", ult.nuevo.pill === "YA PASÓ" && ult.nuevo.sinCuenta, ult.nuevo.pill);
}
// (b) Se acerca a 600 m de mi paradero y se va en sentido contrario: «SE ALEJA» en los dos.
{
  const pg = new Pagina(MIA, RUTA);
  const viene = tramo(0, -3000, 0, -5500, 8.33, T0);
  const vuelve = tramo(0, -5500, 0, -3500, 8.33, viene.t);
  let ult = { viejo: {} as Vista, nuevo: {} as Vista };
  let callaTrasMinuto = 0;
  for (const f of viene.f) ult = pg.muestra(f);
  // La ventana es de un minuto: mientras contenga el acercamiento, la distancia neta no creció.
  // Pasado ese minuto, tiene que decirlo en TODAS las muestras.
  vuelve.f.forEach((f, i) => { ult = pg.muestra(f); if ((i + 1) * 5 > 60 && !ult.nuevo.seAleja) callaTrasMinuto++; });
  chk("el que se va en sentido contrario SÍ «SE ALEJA» (nuevo)", ult.nuevo.pill === "SE ALEJA", ult.nuevo.pill);
  chk("…y el viejo también lo decía", ult.viejo.pill === "SE ALEJA");
  chk("pasado el primer minuto lo dice en todas las muestras del alejamiento", callaTrasMinuto === 0, `${callaTrasMinuto} muestra(s) calladas`);
  // Detenido 90 s en un semáforo: deja de afirmar movimiento (como el modal del operador)… y NO
  // vuelve a afirmar que viene: ni cuenta regresiva ni banner.
  const sem = detenido(0, -3500, vuelve.t, 1.5, mulberry32(7), 4);
  let cuentaEnSemaforo = 0;
  for (const f of sem.f) { ult = pg.muestra(f); if (!ult.nuevo.sinCuenta || !ult.nuevo.escondeLlegada) cuentaEnSemaforo++; }
  chk("90 s detenido: el nuevo ya no afirma que se aleja", ult.nuevo.seAleja === false);
  chk("…ni que viene: sin cuenta regresiva ni banner en ninguna muestra del semáforo", cuentaEnSemaforo === 0, `${cuentaEnSemaforo} muestra(s)`);
  // Y cuando arranca otra vez en sentido contrario, vuelve el «SE ALEJA».
  const arranca = tramo(0, -3500, 0, -2000, 8.33, sem.t);
  for (const f of arranca.f) ult = pg.muestra(f);
  chk("al arrancar otra vez alejándose vuelve «SE ALEJA»", ult.nuevo.pill === "SE ALEJA", ult.nuevo.pill);
}
// (c) Cruza la banda de 5 min ALEJÁNDOSE: el aviso de llegada sigue sin dispararse. Pasa a 700 m
// en tráfico lento (banda de 500 m: no se dispara), se aleja lento y ACELERA: a 40 km/h la banda es
// de 3.3 km y el bus, a 1.4-3 km y yéndose, queda dentro. Ninguno de los dos lo dispara. Y las dos
// variantes que la primera versión de este arreglo dejaba pasar: un SEMÁFORO dentro de la banda
// (detenido, calcETA supone 25 km/h y la banda se ensancha a 2.08 km) y un HUECO de filas (la
// primera fila después deja la ventana con una sola muestra: sin evidencia, no «viene»).
{
  const prepara = () => {
    const pg = new Pagina(MIA, RUTA);
    const viene = tramo(-1500, -5400, 0, -5400, 1.67, T0);
    const seva  = tramo(0, -5400, 1200, -5400, 1.67, viene.t);
    for (const f of [...viene.f, ...seva.f]) pg.muestra(f);
    return { pg, t: seva.t };
  };
  {
    const { pg, t } = prepara();
    const acelera = tramo(1200, -5400, 3000, -5400, 11.1, t);
    let bloqV = 0, bloqN = 0;
    for (const f of acelera.f) {
      const v = pg.muestra(f);
      if (v.viejo.disparoBloqueado) bloqV++;
      if (v.nuevo.disparoBloqueado) bloqN++;
    }
    chk("cruzando la banda de 5 min alejándose, el viejo no dispara «Tu bus está llegando»", !pg.viejo.alerta);
    chk("el nuevo tampoco", !pg.nuevo.alerta);
    chk("…porque lo bloquea en cada muestra, igual que el viejo", bloqN === acelera.f.length && bloqV === acelera.f.length,
      `viejo ${bloqV} · nuevo ${bloqN} de ${acelera.f.length}`);
  }
  {
    // Semáforo a ~1.93 km, dentro de la banda de 2.08 km que da la velocidad 0.
    const { pg, t } = prepara();
    const acelera = tramo(1200, -5400, 1800, -5400, 11.1, t);
    for (const f of acelera.f) pg.muestra(f);
    const sem = detenido(1800, -5400, acelera.t, 1.5, mulberry32(4), 4, 5);
    let cuenta = 0;
    for (const f of sem.f) { const v = pg.muestra(f); if (!v.nuevo.sinCuenta || !v.nuevo.escondeLlegada) cuenta++; }
    const etaSem = calcETA(dMiaDe(sem.f[sem.f.length - 1], MIA), 0);
    chk("premisa: detenido a ~1.9 km, la banda de 5 min lo alcanza", etaSem <= 5, `eta ${etaSem} min`);
    chk("detenido en un semáforo tras alejarse, el nuevo NO dispara el aviso", !pg.nuevo.alerta);
    chk("…(el viejo tampoco)", !pg.viejo.alerta);
    chk("…ni devuelve la cuenta regresiva ni el banner", cuenta === 0, `${cuenta} muestra(s)`);
  }
  {
    // Hueco de 90 s sin filas (túnel / sin datos) y sigue alejándose a 40 km/h. Cada fila llega dos
    // veces (el sondeo de 5 s la repite): la segunda juzga el disparo CON la fila nueva adentro.
    const { pg, t } = prepara();
    const acelera = tramo(1200, -5400, 2000, -5400, 11.1, t);
    for (const f of acelera.f) pg.muestra(f);
    const trasHueco = tramo(2000 + 11.1 * 90, -5400, 4000, -5400, 11.1, acelera.t + 90_000);
    let sinEvidencia = 0;
    for (const f of trasHueco.f) {
      pg.muestra(f);
      const v = pg.muestra(f);   // el sondeo siguiente repite la fila
      if (v.nuevo.presenteDisparo === null) sinEvidencia++;
    }
    chk("premisa: tras el hueco la ventana se quedó sin evidencia", sinEvidencia > 0, `${sinEvidencia} sondeo(s)`);
    chk("tras un hueco de filas, alejándose, el nuevo NO dispara el aviso", !pg.nuevo.alerta);
    chk("…(el viejo tampoco)", !pg.viejo.alerta);
  }
}
// (d) Me PASÓ y se detuvo en un semáforo antes del «YA PASÓ». El siguiente paradero está a 1.5 km
// del mío; el bus pasa a 50 m (el aviso ya salió en el acercamiento), sigue 580 m y espera 150 s
// con el latido del conductor detenido. Ahí «YA PASÓ» todavía no sale (ni más cerca del siguiente,
// ni 600 m de gap): el viejo decía «SE ALEJA»; la primera versión de este arreglo decía «llega en
// 2 min · dirígete al paradero». El nuevo: neutral.
{
  const ruta = [P(1, 0, 3000), P(2, 0, 0), P(3, 0, -1500)];
  const mia = ruta[1];
  const pg = new Pagina(mia, ruta);
  const viene = tramo(50, 3000, 50, -580, 8.33, T0, 3);
  for (const f of viene.f) pg.muestra(f);
  chk("premisa: el aviso ya salió en el acercamiento", pg.viejo.alerta && pg.nuevo.alerta);
  const sem = detenido(50, -580, viene.t, 2.5, mulberry32(650), 6, 15);
  let viejoSeAleja = 0, nuevoAfirmaViene = 0, nuevoSeAleja = 0, yaPaso = 0;
  sem.f.forEach((f, i) => {
    const v = pg.muestra(f);
    if (v.viejo.seAleja) viejoSeAleja++;
    if (v.nuevo.yaPaso || v.viejo.yaPaso) yaPaso++;
    if (!v.nuevo.sinCuenta || v.nuevo.bannerLlegada) nuevoAfirmaViene++;
    if ((i + 1) * 15 > 60 && v.nuevo.seAleja) nuevoSeAleja++;
  });
  chk("premisa: a esa distancia no hay «YA PASÓ» en ninguno", yaPaso === 0);
  chk("(regresión) el viejo dice «SE ALEJA» en todo el semáforo", viejoSeAleja === sem.f.length, `${viejoSeAleja} de ${sem.f.length}`);
  chk("el nuevo NUNCA dice que viene: ni cuenta regresiva, ni «llega», ni banner", nuevoAfirmaViene === 0, `${nuevoAfirmaViene} muestra(s)`);
  chk("…y pasado el minuto tampoco afirma «SE ALEJA» (está detenido)", nuevoSeAleja === 0, `${nuevoSeAleja} muestra(s)`);
}
// (e) Espera en el paradero ANTERIOR, a 1.8 km del mío (el #30204 con paraderos más cerca). Llega
// yéndose del mío a 10 km/h (banda de 830 m: no dispara) y espera 16 min a velocidad 0: la banda
// se ensancha a 2.08 km y el ETA cae a 5 min. El aviso NO puede salir ahí —es de un solo uso, y
// cuando el bus salga de verdad no habría aviso—. Sale cuando arranca hacia mí.
{
  const ruta = [P(1, 0, 0), P(2, 0, -1800), P(3, 0, -4000)];
  const mia = ruta[1];
  const pg = new Pagina(mia, ruta);
  const llega = tramo(1200, -1500, 0, 0, 2.78, T0);
  for (const f of llega.f) pg.muestra(f);
  chk("premisa: llegando al paradero anterior no se disparó", !pg.viejo.alerta && !pg.nuevo.alerta);
  const esp = detenido(0, 0, llega.t, 16, mulberry32(1800), 15, 15);
  let cuenta = 0;
  for (const f of esp.f) { const v = pg.muestra(f); if (!v.nuevo.sinCuenta || !v.nuevo.escondeLlegada) cuenta++; }
  chk("premisa: detenido ahí, el ETA de la página cae a la banda de 5 min",
    calcETA(dMiaDe(esp.f[esp.f.length - 1], mia), 0) <= 5);
  chk("esperando 16 min en el paradero anterior, el nuevo NO dispara el aviso", !pg.nuevo.alerta);
  chk("…ni muestra cuenta regresiva ni banner", cuenta === 0, `${cuenta} muestra(s)`);
  const sale = tramo(0, 0, 0, -1750, 5.56, esp.t);
  let distN: number | null = null, distV: number | null = null;
  for (const f of sale.f) {
    const v = pg.muestra(f);
    if (v.nuevo.disparo) distN = dMiaDe(f, mia);
    if (v.viejo.disparo) distV = dMiaDe(f, mia);
  }
  chk("cuando sale hacia mí, el nuevo SÍ lo dispara, y antes que el viejo",
    distN != null && (distV == null || distN > distV), `nuevo a ${distN?.toFixed(0)} m · viejo a ${distV?.toFixed(0)} m`);
}
// (f) Abro la app con el bus YA PASADO a 1.35 km, yéndose a 15 km/h hacia el siguiente: «YA PASÓ».
// Se detiene en un semáforo a 1.8 km: velocidad 0 → banda de 2.08 km. Con «YA PASÓ» en pantalla el
// teléfono no puede vibrar «llegando».
{
  const ruta = [P(1, 0, 3000), P(2, 0, 0), P(3, 0, -2500)];
  const mia = ruta[1];
  const pg = new Pagina(mia, ruta);
  const sigue = tramo(0, -1350, 0, -1800, 4.17, T0);
  for (const f of sigue.f) pg.muestra(f);
  chk("premisa: la pantalla dice «YA PASÓ»", pg.nuevo.busPaso && pg.viejo.busPaso);
  const sem = detenido(0, -1800, sigue.t, 1.5, mulberry32(3), 4, 15);
  for (const f of sem.f) pg.muestra(f);
  chk("con «YA PASÓ» en pantalla y el bus detenido, el nuevo NO dispara el aviso", !pg.nuevo.alerta);
  chk("…(el viejo tampoco: su racha seguía arriba)", !pg.viejo.alerta);
}
// (g) SIN EVIDENCIA SE CONSERVA EL VEREDICTO DE LA RACHA. Un teléfono que envía cada 65 s (red, o el
// conductor tercero web con la pantalla bloqueada) nunca tiene dos muestras en la ventana de un
// minuto. Se acerca a 300 m y se va en sentido contrario a 30 km/h durante 10 min.
{
  for (const cadencia of [10, 45, 65, 90, 180]) {
    const pg = new Pagina(MIA, RUTA);
    const viene = tramo(0, -3100, 0, -5800, 8.33, T0, cadencia);
    const seva = tramo(0, -5800, 0, -5800 + 8.33 * 600, 8.33, viene.t, cadencia);
    let viejoSi = 0, nuevoSi = 0, callaSinEvidencia = 0, cuentaSinEvidencia = 0;
    for (const f of [...viene.f, ...seva.f]) {
      const v = pg.muestra(f);
      if (v.viejo.seAleja) viejoSi++;
      if (v.nuevo.seAleja) nuevoSi++;
      if (v.viejo.seAleja && !v.nuevo.seAleja && (v.nuevo.presente === null || v.nuevo.presente === "aleja")) callaSinEvidencia++;
      if (v.viejo.sinCuenta && !v.nuevo.sinCuenta && v.nuevo.presente !== "viene") cuentaSinEvidencia++;
    }
    const exacto = cadencia > 60 ? nuevoSi === viejoSi : nuevoSi > 0;
    chk(`filas cada ${cadencia} s: el nuevo no calla ningún «SE ALEJA» sin evidencia en contra`,
      callaSinEvidencia === 0 && cuentaSinEvidencia === 0 && exacto,
      `viejo ${viejoSi} · nuevo ${nuevoSi}${cadencia > 60 ? " (sin ventana: tienen que ser iguales)" : ""}`);
  }
}

// ── 4. LA EXTRACCIÓN: el original contra el módulo, sobre trazas al azar ──────────────
// Marchas por la ruta (pasando o no mi paradero), retornos en U, esperas con jitter, más lo que el
// polling real trae: la misma fila repetida, filas fuera de orden, glitches (teletransportes de
// 1-3 km), filas sin tiempo o con tiempo inválido, coordenadas como texto, paraderos siguientes
// sin coordenadas, y teléfonos sin Doppler (velocidad 0 siempre). Mismos setState y mismo estado en
// CADA muestra. Y a la vez el BARRIDO: nuevo ⊆ viejo en cada muestra, cada diferencia con su evidencia.
console.log("\n4. La extracción y el barrido");
{
  const rnd = mulberry32(2026);
  let muestras = 0, difL = 0, difE = 0, primera = "";
  const vistas = { paso: 0, alejando: 0, regreso: 0, glitch: 0, repetida: 0, desorden: 0, sinTs: 0 };
  const viol = { seAleja: 0, callaSinEvidencia: 0, cuenta: 0, cuentaSinViene: 0, banner: 0, bannerSinViene: 0, disparoLibre: 0, disparoBloqueadoDeMas: 0, yaPaso: 0 };
  const cor = { nuevoSi: 0, apagados: 0, neutral: 0, cuentaRecuperada: 0, bannerRecuperado: 0, disparoLiberado: 0, disparoBloqueadoPorYaPaso: 0 };
  for (let caso = 0; caso < 1500; caso++) {
    const n = 3 + Math.floor(rnd() * 4);
    // Ruta con giros suaves, paraderos a 400-2500 m.
    const pts: { x: number; y: number }[] = [];
    let x = 0, y = 0, rumbo = rnd() * 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      pts.push({ x, y });
      rumbo += (rnd() - 0.5) * 1.2;
      const largo = 400 + rnd() * 2100;
      x += Math.cos(rumbo) * largo; y += Math.sin(rumbo) * largo;
    }
    const ruta: Parada[] = pts.map((p, i) => {
      const g = aGeo(p.x, p.y);
      const sinCoords = i > 0 && rnd() < 0.08;
      const comoTexto = rnd() < 0.15;
      return { id: 100 + i, lat: sinCoords ? null : comoTexto ? String(g.lat) : g.lat, lng: sinCoords ? null : comoTexto ? String(g.lng) : g.lng };
    });
    const idxMia = 1 + Math.floor(rnd() * (n - 1));
    if (ruta[idxMia].lat == null) { const g = aGeo(pts[idxMia].x, pts[idxMia].y); ruta[idxMia] = { ...ruta[idxMia], lat: g.lat, lng: g.lng }; }
    const pg = new Pagina(ruta[idxMia], ruta);
    const sinDoppler = rnd() < 0.1;

    // Itinerario: puntos por los que pasa el bus.
    const wp: { x: number; y: number; espera?: number }[] = [];
    const arranque = { x: pts[0].x + (rnd() - 0.5) * 6000, y: pts[0].y + (rnd() - 0.5) * 6000 };
    wp.push(arranque);
    const tipo = rnd();
    for (let i = 0; i < n; i++) {
      // Se desvía de la ruta hasta 250 m y a veces espera en el paradero.
      wp.push({ x: pts[i].x + (rnd() - 0.5) * 500 * rnd(), y: pts[i].y + (rnd() - 0.5) * 500 * rnd(), espera: rnd() < 0.3 ? rnd() * 6 : 0 });
      if (i === idxMia - 1 && tipo < 0.3) {
        // Retorno en U ANTES de mi paradero: llega cerca, vuelve, y regresa.
        const m = pts[idxMia];
        const dx = m.x - pts[i].x, dy = m.y - pts[i].y;
        const f = 0.6 + rnd() * 0.38;
        wp.push({ x: pts[i].x + dx * f, y: pts[i].y + dy * f });
        wp.push({ x: pts[i].x + dx * (f - 0.2 - rnd() * 0.3), y: pts[i].y + dy * (f - 0.2 - rnd() * 0.3), espera: rnd() * 3 });
      }
      if (i === idxMia && tipo > 0.85) break;   // termina en mi paradero
    }
    if (tipo > 0.6 && tipo <= 0.85) wp.push({ x: (rnd() - 0.5) * 10000, y: (rnd() - 0.5) * 10000 });   // se va a otra parte

    let t = T0 + Math.floor(rnd() * 3600) * 1000;
    let cx = wp[0].x, cy = wp[0].y;
    const historial: UbicacionBus[] = [];
    const emitir = (bp: UbicacionBus) => {
      const { viejo: v, nuevo: w } = pg.muestra(bp);
      muestras++;
      // Todo lo que el nuevo afirma, el viejo lo afirmaba (⊆).
      if (w.seAleja && !v.seAleja) viol.seAleja++;
      if (w.sinCuenta && !v.sinCuenta) viol.cuenta++;
      if (w.escondeLlegada && !v.escondeLlegada) viol.banner++;
      if (w.yaPaso !== v.yaPaso) viol.yaPaso++;
      // Y cada diferencia con su evidencia: callar «SE ALEJA» exige evidencia EN CONTRA (quieto o
      // viene, nunca null); devolver la cuenta o el banner, la distancia BAJANDO.
      if (v.seAleja && !w.seAleja && w.presente !== "quieto" && w.presente !== "viene") viol.callaSinEvidencia++;
      if (v.sinCuenta && !w.sinCuenta && w.presente !== "viene") viol.cuentaSinViene++;
      if (v.escondeLlegada && !w.escondeLlegada && w.presente !== "viene") viol.bannerSinViene++;
      // El disparo: liberado solo con la distancia bajando; bloqueado de más solo por «YA PASÓ».
      if (v.disparoBloqueado && !w.disparoBloqueado && w.presenteDisparo !== "viene") viol.disparoLibre++;
      if (w.disparoBloqueado && !v.disparoBloqueado && !w.pasoAlDisparar) viol.disparoBloqueadoDeMas++;
      // Corolarios: el cambio hace algo, en los dos sentidos.
      if (w.seAleja) cor.nuevoSi++;
      if (v.seAleja && !w.seAleja) cor.apagados++;
      if (w.sinCuenta && !w.seAleja && !w.yaPaso) cor.neutral++;
      if (v.sinCuenta && !w.sinCuenta) cor.cuentaRecuperada++;
      if (v.escondeLlegada && !w.escondeLlegada) cor.bannerRecuperado++;
      if (v.disparoBloqueado && !w.disparoBloqueado) cor.disparoLiberado++;
      if (w.disparoBloqueado && !v.disparoBloqueado) cor.disparoBloqueadoPorYaPaso++;
    };
    for (let w = 1; w < wp.length; w++) {
      const v = 2 + rnd() * 12;
      const largo = Math.hypot(wp[w].x - cx, wp[w].y - cy);
      const pasos = Math.max(1, Math.round(largo / v / 6));
      for (let k = 1; k <= pasos; k++) {
        const dt = 3 + Math.floor(rnd() * 10);
        t += dt * 1000;
        const px = cx + (wp[w].x - cx) * k / pasos, py = cy + (wp[w].y - cy) * k / pasos;
        const j = rnd() * 15;
        const vel = sinDoppler ? 0 : v * 3.6 * (0.8 + rnd() * 0.4);
        let bp: UbicacionBus = fila(px + (rnd() - 0.5) * j, py + (rnd() - 0.5) * j, t, vel);
        const r = rnd();
        if (r < 0.03) {
          // Glitch: un teletransporte de 1-3 km que vuelve en la muestra siguiente.
          const a = rnd() * 2 * Math.PI, dd = 1000 + rnd() * 2000;
          bp = fila(px + Math.cos(a) * dd, py + Math.sin(a) * dd, t, vel);
          vistas.glitch++;
        } else if (r < 0.04) { bp = { ...bp, timestamp: null, created_at: null }; vistas.sinTs++; }
        else if (r < 0.045) { bp = { ...bp, timestamp: "no-es-fecha" }; vistas.sinTs++; }
        else if (r < 0.06) { bp = { ...bp, lat: String(bp.lat), lng: String(bp.lng) }; }
        emitir(bp);
        historial.push(bp);
        // La misma fila repetida por el polling.
        if (rnd() < 0.15) { emitir(bp); vistas.repetida++; }
        // Una fila VIEJA que llega fuera de orden (carrera entre sondeos).
        if (historial.length > 3 && rnd() < 0.03) { emitir(historial[historial.length - 2 - Math.floor(rnd() * 2)]); vistas.desorden++; }
      }
      cx = wp[w].x; cy = wp[w].y;
      const esperaMin = wp[w].espera ?? 0;
      if (esperaMin > 0) { const q = detenido(cx, cy, t, esperaMin, rnd, 4 + rnd() * 20, 5 + Math.floor(rnd() * 10)); q.f.forEach((f) => { emitir(f); historial.push(f); }); t = q.t; }
    }
    difL += pg.difLlamadas; difE += pg.difEstado; if (!primera && pg.primeraDif) primera = `caso ${caso}: ${pg.primeraDif}`;
    vistas.paso += pg.acciones.paso; vistas.alejando += pg.acciones.alejando; vistas.regreso += pg.acciones.regreso;
  }
  chk(`extracción: mismos setState que el original en las ${muestras} muestras`, difL === 0, primera);
  chk("extracción: mismo estado que el original en cada muestra", difE === 0, primera);
  chk("el barrido ejercitó glitches, filas repetidas, fuera de orden y sin tiempo",
    vistas.glitch > 0 && vistas.repetida > 0 && vistas.desorden > 0 && vistas.sinTs > 0,
    JSON.stringify(vistas));
  chk("el barrido comparó las tres ramas de setState (paso, alejando, regreso)",
    vistas.paso > 0 && vistas.alejando > 0 && vistas.regreso > 0,
    `paso ${vistas.paso} · alejando ${vistas.alejando} · regreso ${vistas.regreso}`);
  chk("nuevo ⊆ viejo: «SE ALEJA»", viol.seAleja === 0, `${viol.seAleja} violación(es)`);
  chk("nuevo ⊆ viejo: «sin cuenta regresiva»", viol.cuenta === 0, `${viol.cuenta} violación(es)`);
  chk("nuevo ⊆ viejo: banner de llegada escondido", viol.banner === 0, `${viol.banner} violación(es)`);
  chk("«YA PASÓ» es idéntico en las dos versiones, muestra a muestra", viol.yaPaso === 0, `${viol.yaPaso} diferencia(s)`);
  chk("callar un «SE ALEJA» exige evidencia EN CONTRA (nunca la falta de muestras)", viol.callaSinEvidencia === 0, `${viol.callaSinEvidencia} violación(es)`);
  chk("devolver la cuenta regresiva exige la distancia BAJANDO", viol.cuentaSinViene === 0, `${viol.cuentaSinViene} violación(es)`);
  chk("devolver el banner exige la distancia BAJANDO", viol.bannerSinViene === 0, `${viol.bannerSinViene} violación(es)`);
  chk("liberar el disparo exige la distancia BAJANDO", viol.disparoLibre === 0, `${viol.disparoLibre} violación(es)`);
  chk("el disparo solo se bloquea de más con «YA PASÓ» en pantalla (divergencia declarada)",
    viol.disparoBloqueadoDeMas === 0, `${viol.disparoBloqueadoDeMas} violación(es)`);
  chk("el nuevo sigue afirmando «se aleja» cuando corresponde", cor.nuevoSi > 0, `${cor.nuevoSi} muestra(s)`);
  chk("y apaga casos que el viejo afirmaba", cor.apagados > 0, `${cor.apagados} muestra(s)`);
  chk("el estado NEUTRAL (ni «SE ALEJA» ni cuenta regresiva) aparece", cor.neutral > 0, `${cor.neutral} muestra(s)`);
  chk("y devuelve cuentas regresivas, banners y disparos que el viejo escondía",
    cor.cuentaRecuperada > 0 && cor.bannerRecuperado > 0 && cor.disparoLiberado > 0,
    `cuenta ${cor.cuentaRecuperada} · banner ${cor.bannerRecuperado} · disparo ${cor.disparoLiberado} · bloqueado por «YA PASÓ» ${cor.disparoBloqueadoPorYaPaso}`);
}

// ── 5. La lectura en presente de lib/avance-paradas.ts ───────────────────────────────
// `distanciaCrecio` pasó a ser `tendenciaPresente(...) === "aleja"`. La versión anterior, copiada
// literal (main, PR #171), contra la nueva sobre ventanas al azar: tiene que contestar lo mismo en
// cada una, o el modal del operador cambió sin que nadie lo pidiera. Y «viene» es el espejo exacto
// de «aleja»: invertir la ventana en el tiempo cambia uno por el otro.
console.log("\n5. La lectura en presente");
{
  const GAP_ALEJA_M = 60;
  type ParadaAvanceVieja = { lat: number | null; lng: number | null; completada: boolean };
  const tieneCoords = (p: ParadaAvanceVieja | undefined): boolean =>
    !!p && p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
  function distanciaCrecioVieja(recientes: MuestraReciente[] | undefined, p: ParadaAvanceVieja | undefined): boolean {
    if (!recientes || recientes.length < 2 || !tieneCoords(p)) return false;
    const pLat = Number(p!.lat), pLng = Number(p!.lng);
    const d = (q: { lat: number; lng: number }) => distM(q.lat, q.lng, pLat, pLng);
    const n = recientes.length;
    const ini = n >= 4 ? Math.max(d(recientes[0]), d(recientes[1])) : d(recientes[0]);
    const fin = n >= 4 ? Math.min(d(recientes[n - 2]), d(recientes[n - 1])) : d(recientes[n - 1]);
    return fin - ini > GAP_ALEJA_M;
  }
  const rnd = mulberry32(171);
  let ventanas = 0, difCrecio = 0, difEspejo = 0, difNull = 0;
  const cuenta = { aleja: 0, viene: 0, quieto: 0, nulo: 0 };
  for (let k = 0; k < 60_000; k++) {
    const n = Math.floor(rnd() * 9);   // 0..8 muestras
    const x0 = (rnd() - 0.5) * 3000, y0 = (rnd() - 0.5) * 3000, vx = (rnd() - 0.5) * 30, vy = (rnd() - 0.5) * 30;
    const ventana: MuestraReciente[] = [];
    for (let i = 0; i < n; i++) {
      const j = rnd() < 0.1 ? 200 : 12;   // a veces un fix desviado
      ventana.push({ ...aGeo(x0 + vx * i * 6 + (rnd() - 0.5) * j, y0 + vy * i * 6 + (rnd() - 0.5) * j), ts: T0 + i * 6000 });
    }
    const r = rnd();
    // Paradas con y sin coordenadas, incluida la trampa de Number(null) === 0.
    const par: ParadaAvanceVieja = r < 0.05 ? { lat: null, lng: null, completada: false }
      : r < 0.08 ? { lat: null, lng: aGeo(0, 0).lng, completada: false }
      : { ...aGeo(0, 0), completada: false };
    ventanas++;
    const t = tendenciaPresente(ventana, par);
    if (distanciaCrecio(ventana, par) !== distanciaCrecioVieja(ventana, par)) difCrecio++;
    const esperaNull = n < 2 || par.lat == null || par.lng == null;
    if ((t === null) !== esperaNull) difNull++;
    const inv = tendenciaPresente(ventana.slice().reverse(), par);
    if ((t === "viene") !== (inv === "aleja") || (t === "aleja") !== (inv === "viene")) difEspejo++;
    if (t === null) cuenta.nulo++; else cuenta[t]++;
  }
  chk(`distanciaCrecio contesta lo mismo que la versión anterior en ${ventanas} ventanas`, difCrecio === 0, `${difCrecio} diferencia(s)`);
  chk("sin evidencia (menos de 2 muestras, o el paradero sin coordenadas) → null, nunca «quieto»", difNull === 0, `${difNull} diferencia(s)`);
  chk("«viene» es el espejo exacto de «aleja» (invertir la ventana los intercambia)", difEspejo === 0, `${difEspejo} diferencia(s)`);
  chk("el barrido vio los cuatro valores", cuenta.aleja > 0 && cuenta.viene > 0 && cuenta.quieto > 0 && cuenta.nulo > 0, JSON.stringify(cuenta));
}

// ── 6. La tabla de las dos funciones de pantalla contra el original ──────────────────
// Combinación por combinación: con el presente SIN evidencia o «aleja», `lecturaPasajero` dice
// EXACTAMENTE lo que decía el original; con «quieto» solo calla el texto «SE ALEJA» (la pantalla
// queda neutral: la cuenta regresiva y el banner siguen escondidos); solo «viene» los devuelve.
console.log("\n6. Las funciones de pantalla, combinación por combinación");
{
  const presentes: TendenciaPresente[] = [null, "aleja", "quieto", "viene"];
  let combos = 0, malNull = 0, malQuieto = 0, malViene = 0, noSubconj = 0;
  for (const miEstado of ["esperando", "embarcado"])
  for (const busPaso of [false, true])
  for (const busAlejando of [false, true])
  for (const estadoBus of ["en_camino", "retrasado", "sin_señal", "finalizado"])
  for (const presente of presentes) {
    combos++;
    const v = derivadosViejos(miEstado, busPaso, busAlejando, estadoBus);
    const w = lecturaPasajero({
      esperando: miEstado === "esperando", busPasoMiParada: busPaso, busAlejando, presente,
      senalViva: estadoBus !== "sin_señal" && estadoBus !== "finalizado",
    });
    const igual = w.yaPaso === v.yaPaso && w.seAleja === v.seAleja && w.busYaNoViene === v.busYaNoViene && w.escondeLlegada === v.escondeLlegada;
    if ((presente === null || presente === "aleja") && !igual) malNull++;
    if (presente === "quieto" && !(w.yaPaso === v.yaPaso && w.busYaNoViene === v.busYaNoViene && w.escondeLlegada === v.escondeLlegada
      && w.seAleja === false)) malQuieto++;
    if (presente === "viene" && !(w.yaPaso === v.yaPaso && w.seAleja === false && w.busYaNoViene === v.yaPaso && w.escondeLlegada === busPaso)) malViene++;
    if ((w.seAleja && !v.seAleja) || (w.busYaNoViene && !v.busYaNoViene) || (w.escondeLlegada && !v.escondeLlegada)) noSubconj++;
  }
  chk(`sin evidencia o «aleja»: idéntico al original (${combos} combinaciones en total)`, malNull === 0, `${malNull} diferencia(s)`);
  chk("«quieto»: solo calla «SE ALEJA»; cuenta regresiva y banner como el original", malQuieto === 0, `${malQuieto} diferencia(s)`);
  chk("«viene»: devuelve la cuenta regresiva y el banner salvo con «YA PASÓ»", malViene === 0, `${malViene} diferencia(s)`);
  chk("todo lo que el nuevo afirma, el original lo afirmaba", noSubconj === 0, `${noSubconj} violación(es)`);

  // bloqueaAvisoLlegada: ventanas construidas para cada presente, rachas 0..5, con y sin «YA PASÓ».
  const mia = { lat: aGeo(0, 0).lat, lng: aGeo(0, 0).lng };
  const ventanaDe = (pres: TendenciaPresente): MuestraReciente[] => {
    const ys = pres === "aleja" ? [-1000, -1100, -1200, -1300] : pres === "viene" ? [-1300, -1200, -1100, -1000]
      : pres === "quieto" ? [-1000, -1005, -1002, -1004] : [-1000];
    return ys.map((y, i) => ({ ...aGeo(0, y), ts: T0 + i * 15_000 }));
  };
  let malBloqueo = 0, verificados = 0;
  for (const pres of presentes)
  for (let rec = 0; rec <= 5; rec++)
  for (const busPaso of [false, true]) {
    const est: SeguimientoPasajero = { ...segInicial(), recStreak: rec, recientes: ventanaDe(pres) };
    if (tendenciaPresente(est.recientes, mia) !== pres) { malBloqueo++; continue; }
    verificados++;
    const viejo = !(rec < 3);
    const esperado = busPaso || (viejo && pres !== "viene");
    if (bloqueaAvisoLlegada(est, mia, busPaso) !== esperado) malBloqueo++;
  }
  chk(`bloqueaAvisoLlegada: «YA PASÓ» bloquea siempre; la racha, salvo con la distancia bajando (${verificados} combinaciones)`,
    malBloqueo === 0 && verificados === 48, `${malBloqueo} diferencia(s)`);
}

// ── 7. EL CABLEADO DE LA PÁGINA ──────────────────────────────────────────────────────
// La mitad del arreglo vive en app/pasajero/page.tsx. Sin estas comprobaciones, revertir allí
// `seAleja`, el filtro del banner o el disparo dejaría esta matriz en verde: el lado nuevo de la
// página simulada llama a las funciones puras por su cuenta.
console.log("\n7. El cableado de la página");
{
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const pagina = readFileSync(new URL("../app/pasajero/page.tsx", import.meta.url), "utf8");
  const esta = readFileSync(new URL(import.meta.url), "utf8");
  const partes = esta.split("// " + "⟦PEGAMENTO⟧");   // armada, para no partir este archivo en esta línea
  const pegamento = partes.length === 3 ? norm(partes[1]) : "";
  const P_ = norm(pagina);
  chk("el pegamento de la página es el que esta matriz prueba, copiado literal", pegamento.length > 500 && P_.includes(pegamento),
    pegamento.length > 500 ? "" : "no se encontraron las marcas");
  chk("la pantalla decide con lecturaPasajero, con las mismas entradas",
    P_.includes(norm(`const { yaPaso, seAleja, busYaNoViene, escondeLlegada } = lecturaPasajero({
      esperando, busPasoMiParada, busAlejando, presente,
      senalViva: estadoBus !== "sin_señal" && estadoBus !== "finalizado",
    });`)));
  chk("el disparo se juzga con bloqueaAvisoLlegada (estado anterior, mi paradero, «YA PASÓ» en pantalla)",
    P_.includes(norm(`if (eta <= 5 && !alertaRef.current && miEstado !== "embarcado" && !bloqueaAvisoLlegada(segRef.current, miParada, busPasoMiParada)) {`)));
  const usosBanner = (pagina.match(/alerta5min && !alertaDismiss && miEstado !== "embarcado" && !escondeLlegada/g) ?? []).length;
  chk("los TRES sitios de «Tu bus está llegando» filtran con escondeLlegada", usosBanner === 3, `${usosBanner} sitio(s)`);
  chk("ninguno filtra ya con la racha a secas (!busAlejando)", !/!busAlejando\b/.test(pagina));
  chk("la página no vuelve a decidir a mano «se aleja» ni la cuenta regresiva",
    !/const\s+(seAleja|busYaNoViene)\s*=/.test(pagina) && !/recStreak/.test(pagina));
  chk("«En N min» de mi paradero respeta busYaNoViene",
    P_.includes(norm(`) : !busYaNoViene && etaMin !== null && etaMin > 0 ? (`)));
  chk("la cabecera no dice «En camino» con la pantalla neutral",
    P_.includes(norm(`: busYaNoViene ? "El bus no se acerca a tu paradero"
                        : "En camino a tu paradero"}`)));
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
