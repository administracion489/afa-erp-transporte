// lib/pasajero-alejamiento.ts — ¿el bus viene, se aleja o ya pasó MI paradero? (PURO)
//
// Es la máquina direccional de app/pasajero/page.tsx, EXTRAÍDA, no reescrita: hasta ahora vivía
// dentro del efecto del marcador del bus, mezclada con setState, y no se podía probar. Hace
// exactamente lo mismo que hacía ahí —mismo filtro de glitch, mismo dedupe por ts, mismo orden de
// las ramas y la misma re-siembra del mínimo en el regreso— y la matriz
// scripts/prueba-pasajero-alejamiento.mts corre el original copiado literal contra esta versión
// sobre miles de trazas y exige las MISMAS acciones y el MISMO estado en cada muestra.
//
// LO QUE SE AGREGA, Y SOLO SE AGREGA: la lectura EN PRESENTE de la dirección del bus.
//
// El caso (reserva #30204, 09-10-2026): el bus llegó al PRIMER paradero y esperó ahí 16 minutos.
// El pasajero del paradero 2 veía «SE ALEJA · El bus se aleja de tu paradero». Dos defectos que son
// el mismo que tenía el modal del operador (ver VENTANA_PRESENTE_MS en lib/avance-paradas.ts):
//
//   (a) `recStreak` no cuenta «la distancia crece»: cuenta «estoy a más de 60 m de lo más cerca que
//       llegué a estar». La racha se hizo mientras el bus iba HACIA el paradero 1 (ese tramo lo
//       alejaba del 2) y no se borra con el bus quieto: aquí no hay puerta de quietud, así que cada
//       muestra con jitter sigue sumando, porque sigue lejos del mínimo.
//   (b) El gap se evalúa ANTES que `bajando`: un bus que se ACERCA desde más lejos que el mínimo
//       registrado (salió del paradero 1 hacia el 2) sigue sumando racha en cada muestra, y
//       `busAlejando` solo se apaga en la rama de regreso, o sea al quedar a menos de 400 m. Y no
//       era solo la píldora: «Tu bus está llegando» se escondía con `!busAlejando`, y el disparo de
//       esa alerta exigía `recStreak < 3` — con la racha vieja el aviso salía TARDE, recién cuando
//       el bus quedaba a menos de su mínimo + 60 m (en la matriz, a ~700 m en vez de a 1.4 km).
//
// Por qué no se arreglan las rachas: «YA PASÓ» se decide con ellas y es una conclusión DURABLE que
// costó calibrar (umbrales portados a lib/avance-paradas.ts y validados allí). Tocar la máquina es
// tocar ese veredicto. En vez de eso, la máquina devuelve además `presente`: qué hizo la distancia a
// mi paradero en el último minuto (`tendenciaPresente`, que se importa del motor del operador — dos
// definiciones de «ahora se aleja» terminarían contestando distinto en la misma reserva). Y las
// decisiones de pantalla que la racha tomaba sola se toman ahora con las DOS (`lecturaPasajero`,
// `bloqueaAvisoLlegada`):
//
//   • «SE ALEJA» se AFIRMA con la racha y la distancia CRECIENDO — o sin evidencia del presente.
//   • La cuenta regresiva, el chip «En vivo · llega», el «En N min» de mi paradero y el banner
//     «Tu bus está llegando» VUELVEN solo con la distancia BAJANDO. Y el disparo de ese aviso se
//     libera de la racha por lo mismo.
//
// LA ASIMETRÍA ES LO QUE HAY QUE ENTENDER ANTES DE TOCAR ESTO. Que la distancia NO crezca no
// significa que el bus venga. La primera versión de este arreglo lo trató así y devolvió el «llega
// en 2 min · dirígete al paradero» a un bus que acababa de pasarme y estaba parado en un semáforo a
// 650 m — y con él, el aviso de un solo uso, con vibración, gastado en un bus que se iba. Con la
// racha encendida y el bus detenido (o de costado) la pantalla queda NEUTRAL: ni «SE ALEJA» ni
// cuenta regresiva. Para afirmar lo primero hace falta verlo crecer; para lo segundo, verlo bajar.
//
// Y SIN EVIDENCIA SE CONSERVA EL VEREDICTO DE LA RACHA, que es el comportamiento anterior: una
// ventana con menos de dos muestras (un teléfono que envía cada 65 s, o el conductor tercero web
// con la pantalla bloqueada) no dice nada del presente, y leer eso como «no se aleja» callaba el
// «SE ALEJA» de un bus que se iba durante toda la marcha. El #30204 sigue arreglado: detenido, el
// conductor envía el latido cada 15 s (app/conductor/page.tsx, intervaloEnvioMs), cuatro por minuto.
//
// Límite declarado, el mismo que la máquina original resolvió para el regreso con sus 400 m: una
// curva de la vía que ACORTA la distancia en línea recta 60 m en un minuto se lee «viene» aunque el
// bus se esté yendo. Mientras dura, vuelve la cuenta regresiva; si toca la banda de 5 min, se gasta
// el aviso. Con «YA PASÓ» en pantalla eso no pasa: ese veredicto manda sobre todo lo demás.
//
// UNA DIVERGENCIA DECLARADA DEL DISPARO, y no es numérica: con «YA PASÓ» en pantalla el aviso de
// llegada NUNCA se dispara (el original lo dejaba salir si la racha caía bajo 3 por una muestra que
// «bajaba» 40 m, y el teléfono vibraba «llegando» debajo de un «YA PASÓ»). Si el bus de verdad
// vuelve, la rama de regreso apaga «YA PASÓ» y el aviso sale en la muestra siguiente, que es cuando
// corresponde.
//
// OTRA DIVERGENCIA DECLARADA, numérica: el salto del filtro de glitch se mide con `distM`
// (lib/huella.ts, la haversine canónica del repo) y no con la `dist` local de la página. Son la
// misma fórmula escrita con asin en vez de atan2; difieren en el noveno decimal de un metro contra
// un umbral de 400 m. Las distancias a los paraderos —las que quedan guardadas en el estado— las
// sigue midiendo la página con su `dist` y llegan aquí ya calculadas, así que el estado es
// idéntico bit a bit. La matriz lo comprueba.
//
// PURO: sin React, sin DOM, sin fetch. No escribe nada ni manda avisos: devuelve qué setState
// hacía el original (`accion`) y la página los llama.

import { distM } from "./huella";
import {
  registrarReciente, tendenciaPresente,
  type CoordsParada, type MuestraReciente, type TendenciaPresente,
} from "./avance-paradas";

export type { TendenciaPresente };

// Umbrales del original (app/pasajero/page.tsx), sin tocar. Son los mismos que lib/avance-paradas.ts
// ya porta «verbatim» con su justificación; se repiten aquí como literales del original porque la
// matriz exige paridad exacta con él.
// OJO con GAP_ALEJA_M: este decide la RACHA; la lectura EN PRESENTE (`tendenciaPresente`) usa el de
// lib/avance-paradas.ts. Tienen que valer lo mismo, o la misma pantalla mediría «alejarse» con dos
// umbrales distintos (allá está la nota gemela).
const SALTO_GLITCH_M = 400;  // salto mínimo para sospechar teletransporte
const VEL_GLITCH_MS  = 34;    // ~120 km/h: techo físico de un bus urbano
const GAP_ALEJA_M    = 60;    // gap > 60 → se aleja de su mínimo
const GAP_CERCA_M    = 25;    // gap < 25 → sigue en su mínimo
const BAJANDO_M      = 40;    // se acercó ≥ 40 m vs. la muestra previa
const MIN_CERCA_M    = 450;   // «se acercó de verdad»
const GAP_ATRAS_M    = 600;   // «+600 m, más que un retorno típico de avenida con separador»
const RACHA_REGRESO  = 2;
const REGRESO_M      = 400;   // volvió a < 400 m = retorno real, no una curva de la vía

/** Muestras seguidas alejándose del mínimo que el original llama «sostenido». */
export const RACHA_ALEJA_PASAJERO = 3;

/**
 * Seguimiento direccional del bus respecto de MI paradero.
 *   minDist  = distancia mínima (punto más cercano) alcanzada, en m
 *   lastD    = última distancia procesada, en m
 *   lastTs   = timestamp de la última muestra GPS procesada (dedupe del polling)
 *   lastLat/lastLng = última posición del bus aceptada (para descartar saltos imposibles)
 *   recStreak/apprStreak = muestras consecutivas alejándose / acercándose
 *   recientes = muestras aceptadas del último minuto (lo único nuevo; ver la cabecera)
 */
export type SeguimientoPasajero = {
  minDist: number;
  lastD: number | null;
  lastTs: number;
  lastLat: number | null;
  lastLng: number | null;
  recStreak: number;
  apprStreak: number;
  recientes: MuestraReciente[];
};

/** Estado inicial (el `segInicial` que vivía en la página, más la ventana vacía). */
export const segInicial = (): SeguimientoPasajero => ({
  minDist: Infinity, lastD: null, lastTs: 0, lastLat: null, lastLng: null, recStreak: 0, apprStreak: 0,
  recientes: [],
});

/** Una muestra del bus, con las distancias ya medidas por la página (ver la cabecera). */
export type MuestraPasajero = {
  /** Posición del bus (Number() ya aplicado). */
  lat: number;
  lng: number;
  /** ms epoch de la fila GPS; 0 o NaN = sin tiempo válido (no se procesa, igual que el original). */
  ts: number;
  /** Distancia bus → mi paradero, en m. */
  dMia: number;
  /** Distancia bus → paradero SIGUIENTE al mío; null si no hay siguiente o no tiene coordenadas. */
  dSiguiente: number | null;
  /** Mi paradero: solo para la lectura en presente (`presente`). */
  miParada: CoordsParada | null | undefined;
};

/**
 * Lo que el original hacía con setState en esa muestra, y nada más:
 *   "paso"     → setBusPasoMiParada(true) + setBusAlejando(true)
 *   "alejando" → setBusAlejando(true)
 *   "regreso"  → setBusAlejando(false) + setBusPasoMiParada(false)
 *   null       → ningún setState (dedupe, glitch, o ninguna rama aplicó)
 */
export type AccionSeguimiento = "paso" | "alejando" | "regreso" | null;

export type PasoSeguimiento = {
  estado: SeguimientoPasajero;
  accion: AccionSeguimiento;
  /** Qué hizo la distancia a mi paradero en el último minuto (`tendenciaPresente`): "aleja",
   *  "viene", "quieto" o null = sin evidencia. Se calcula en TODA llamada (también en el dedupe y el
   *  glitch, donde la ventana no cambia), así la página puede asignarlo siempre. */
  presente: TendenciaPresente;
};

/**
 * Un paso de la máquina. PURA: no muta `estado`; devuelve el nuevo.
 * El cuerpo es el del efecto de la página, línea por línea; los comentarios son los suyos.
 */
export function pasoSeguimiento(estado: SeguimientoPasajero, m: MuestraPasajero): PasoSeguimiento {
  const s: SeguimientoPasajero = { ...estado, recientes: estado.recientes ?? [] };
  let accion: AccionSeguimiento = null;
  const { ts, dMia } = m;

  // El polling repite la misma fila GPS entre envíos del conductor (~10 s): solo
  // procesamos muestras NUEVAS para no contar la misma posición varias veces.
  if (ts > 0 && ts !== s.lastTs) {
    const busLat = m.lat, busLng = m.lng;
    const dt       = s.lastTs ? (ts - s.lastTs) / 1000 : 0;
    const saltoBus = s.lastLat != null ? distM(s.lastLat, s.lastLng!, busLat, busLng) : 0;
    // Descartar muestras físicamente imposibles (glitch de GPS): un bus urbano no supera
    // ~120 km/h (34 m/s). Sin este filtro una lectura errónea que caiga cerca de mi paradero
    // envenenaría minDist (mínimo monótono) y dispararía un falso "ya pasó" con el bus aún viniendo.
    const glitch = s.lastLat != null && dt > 0 && saltoBus > SALTO_GLITCH_M && saltoBus / dt > VEL_GLITCH_MS;
    if (!glitch) {
      if (dMia < s.minDist) s.minDist = dMia;   // punto más cercano alcanzado
      const gap = dMia - s.minDist;             // cuánto se alejó de ese punto más cercano

      // Tendencia medida contra el punto MÁS CERCANO (no contra la muestra previa): así un
      // bus lento en tráfico que se aleja de a pocos (<40 m por muestra) igual acumula
      // alejamiento — el bug original se daba justo con buses lentos que "se despegaban" poco a poco.
      const bajando = s.lastD != null && dMia < s.lastD - BAJANDO_M;   // se acercó vs. la muestra previa
      if      (gap > GAP_ALEJA_M)                 { s.recStreak++;  s.apprStreak = 0; }  // se aleja de su mínimo
      else if (gap < GAP_CERCA_M || bajando)      { s.apprStreak++; s.recStreak  = 0; }  // en su mínimo o regresando
      // zona intermedia (25–60 m sin acercarse): conservar las rachas
      s.lastD = dMia; s.lastTs = ts; s.lastLat = busLat; s.lastLng = busLng;
      // LO ÚNICO NUEVO: la muestra aceptada entra a la ventana «en presente». Las quietas también
      // (un bus detenido es justo lo que la ventana tiene que ver), igual que en el motor.
      s.recientes = registrarReciente(s.recientes, { lat: busLat, lng: busLng, ts });

      // Señales de que el bus quedó "aguas abajo" de mi paradero (para el aviso ROJO):
      //  A) ahora está MÁS CERCA del paradero siguiente que del mío → avanzó por la ruta
      //     (robusto a coords imprecisas; distingue "pasó de verdad" de "fue al retorno").
      //  B) se acercó de verdad (<450 m) y ya quedó MUY atrás (+600 m, más que un retorno típico
      //     de una avenida con separador, para no gritar "ya pasó" cuando el bus da la vuelta a recoger).
      const masCercaDelSiguiente = m.dSiguiente != null && m.dSiguiente < dMia;
      const dejoAtrasClaro = s.minDist < MIN_CERCA_M && gap > GAP_ATRAS_M;
      const sostenido = s.recStreak >= RACHA_ALEJA_PASAJERO;   // ~3 muestras seguidas alejándose

      if (sostenido && (masCercaDelSiguiente || dejoAtrasClaro)) {
        // Confianza alta: el bus pasó mi paradero y sigue de largo → aviso rojo + cortar cuenta regresiva.
        accion = "paso";
      } else if (sostenido) {
        // Alejamiento sostenido sin confirmación locacional fuerte (p. ej. sobrepasa hacia un
        // retorno): no mostramos cuenta regresiva engañosa, pero aún no el aviso rojo de "ya pasó".
        accion = "alejando";
      } else if (s.apprStreak >= RACHA_REGRESO && dMia < REGRESO_M) {
        // El bus REGRESÓ y está cerca otra vez (fue al retorno / dio la vuelta a recoger):
        // limpiar AMBOS avisos y re-sembrar el mínimo. Exigir cercanía (<400 m) distingue un
        // retorno real (el bus vuelve al paradero) de una curva de la vía que solo acorta la
        // distancia en línea recta mientras el bus se va de verdad → así no borramos un "ya pasó" legítimo.
        accion = "regreso";
        s.minDist = dMia;
        s.recStreak = 0;
      }
    }
  }

  return { estado: s, accion, presente: tendenciaPresente(s.recientes, m.miParada) };
}

/**
 * ¿Se BLOQUEA el disparo de «Tu bus está llegando»? Es un aviso de UN SOLO USO por servicio (vibra y
 * consume `alertaRef`), así que dispararlo con un bus que no viene no es un falso positivo más:
 * es quedarse sin aviso para cuando el bus venga de verdad.
 *
 *   • Con «YA PASÓ» en pantalla, siempre (divergencia declarada en la cabecera).
 *   • Con la racha sostenida (la condición del original, `recStreak >= 3`), salvo que la distancia
 *     esté BAJANDO ahora. Detenido, de costado o sin evidencia del presente, sigue bloqueado: que
 *     la distancia no crezca no es que el bus venga, y un bus parado tras alejarse ensancha la banda
 *     de 5 min (calcETA supone 25 km/h con velocidad ≤ 5) justo al detenerse.
 *
 * Se juzga con el estado de la muestra ANTERIOR, como hacía el original (el disparo corre antes que
 * la máquina en el efecto de la página).
 */
export function bloqueaAvisoLlegada(
  estado: SeguimientoPasajero,
  miParada: CoordsParada | null | undefined,
  busPasoMiParada: boolean,
): boolean {
  if (busPasoMiParada) return true;
  return estado.recStreak >= RACHA_ALEJA_PASAJERO && tendenciaPresente(estado.recientes, miParada) !== "viene";
}

/** Lo que la página necesita para decidir qué AFIRMA sobre la dirección del bus. */
export type EntradaLectura = {
  /** miEstado === "esperando" (las afirmaciones de dirección solo aplican esperando el recojo). */
  esperando: boolean;
  /** Estado `busPasoMiParada` («YA PASÓ», durable). */
  busPasoMiParada: boolean;
  /** Estado `busAlejando` (la racha histórica). */
  busAlejando: boolean;
  /** Último `presente` de `pasoSeguimiento`. */
  presente: TendenciaPresente;
  /** estadoBus no es "sin_señal" ni "finalizado": «se aleja» no se afirma con el GPS obsoleto. */
  senalViva: boolean;
};

export type LecturaPasajero = {
  /** «YA PASÓ» (píldora, cabecera, héroe, etiqueta de mi paradero). */
  yaPaso: boolean;
  /** «SE ALEJA» (píldora, cabecera, héroe, etiqueta de mi paradero). */
  seAleja: boolean;
  /** Sin cuenta regresiva, sin chip «En vivo · llega» y sin «En N min» en mi paradero. */
  busYaNoViene: boolean;
  /** Esconde «Tu bus está llegando»: el banner, su hueco bajo el aviso de GPS y el punto de la
   *  pestaña. Los TRES sitios leen esto y nada más. */
  escondeLlegada: boolean;
};

/**
 * Qué afirma la pantalla. Es la ÚNICA definición: la página la llama con su estado y la matriz con
 * el suyo, así una pantalla que vuelva a decidirlo a mano no pasa la prueba.
 *
 * El original: `seAleja = esperando && busAlejando && señal`, `busYaNoViene = yaPaso || seAleja` y
 * el banner escondido con `busPasoMiParada || busAlejando`. Aquí la racha (`busAlejando`) se lee
 * con el presente:
 *   • «SE ALEJA» → racha Y (la distancia crece, o no hay evidencia del presente).
 *   • «ya no viene» / banner escondido → racha Y la distancia NO baja. Solo un acercamiento medido
 *     devuelve la cuenta regresiva; detenido o de costado, la pantalla queda neutral.
 * Las tres salidas son ⊆ de las del original: el cambio solo puede callar un «SE ALEJA» con
 * evidencia en contra, y solo puede devolver una cuenta regresiva con el bus bajando la distancia.
 */
export function lecturaPasajero(e: EntradaLectura): LecturaPasajero {
  const yaPaso = e.esperando && e.busPasoMiParada;
  // La racha sigue en pie mientras no la desmienta un acercamiento MEDIDO.
  const rachaEnPie = e.busAlejando && e.presente !== "viene";
  // Y para AFIRMAR «se aleja» hace falta verlo crecer; sin evidencia, se conserva la racha.
  const afirmaAleja = e.busAlejando && (e.presente === "aleja" || e.presente === null);
  const seAleja = e.esperando && afirmaAleja && e.senalViva;
  const busYaNoViene = yaPaso || (e.esperando && rachaEnPie && e.senalViva);
  const escondeLlegada = e.busPasoMiParada || rachaEnPie;
  return { yaPaso, seAleja, busYaNoViene, escondeLlegada };
}
