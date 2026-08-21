// lib/retrasos.ts — Semáforo de PUNTUALIDAD (motor PURO: sin React, sin DOM, sin fetch, sin BD).
//
// PROBLEMA. Hasta ahora "retraso" se decidía así (app/seguimiento/page.tsx:108):
//     alerta = es_hoy && pasaron >15 min de hora_servicio && !checkin_realizado
// O sea, mirando un BOTÓN y nunca dónde está el bus, y siempre DESPUÉS de la hora. Un
// único chip rojo tapaba seis situaciones con responsable y remedio distintos: el bus a
// 30 km en la Panamericana y el bus ESTACIONADO en el paradero con el conductor
// embarcando (que solo olvidó pulsar Iniciar) producían exactamente la misma alerta.
//
// Este módulo separa esas situaciones y, sobre todo, ADELANTA el veredicto: con la
// posición del bus y un ETA se puede decir a T-40 que no va a llegar, que es cuando
// todavía se puede hacer algo (llamar, despachar reemplazo, reordenar la programación).
//
// TRI-ESTADO, NUNCA BINARIO. La cobertura de GPS en segundo plano va de 36 % a 100 %
// SEGÚN EL CONDUCTOR, con el mismo APK (panel /gps-salud). Por eso la posición responde
// SÍ / NO / NO SÉ y el "no sé" tiene su propio nivel: jamás se afirma un retraso a
// partir de la AUSENCIA de evidencia. Un módulo que lea "sin GPS" como "no llegó"
// mentiría en un tercio de la flota y se volvería ruido en una semana.
//
// CALIBRACIÓN CITADA, NO INVENTADA. Los umbrales de decisión geográfica se toman
// verbatim de lib/proximidad.ts:37-49 (máquina ya validada en producción): precisión
// máxima 150 m, radio de llegada adaptativo clamp(120, 1.5·acc, 250) y velocidad
// <= 20 km/h para afirmar "está ahí" (a 60 km/h cerca del paradero VA DE PASO).
// Cambiarlos es cambiar una máquina viva y este repo no tiene test runner.
//
// LO QUE ESTE MÓDULO NO HACE, DELIBERADAMENTE: no escribe en la base, no marca el
// servicio como iniciado, no manda avisos. Detectar el bus en el paradero NO autoriza a
// marcar el inicio: lib/avance-paradas.ts:30 ya fijó la doctrina de la casa —"inferir
// para PINTAR es otra cosa que inferir para ESCRIBIR"— porque una marca falsa avisa a
// pasajeros y ensucia el registro. Aquí sale un VEREDICTO; quién lo pinta y quién avisa
// se decide fuera.

import { distM, velocidadPorVentana, type FixVel } from "./huella";

// ══════════════════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════════════════

export type NivelRetraso =
  | "na"                    // no aplica: otro día, cancelada, o finalizada
  | "en_hora"               // llega con holgura (o ya está en el punto antes de la hora)
  | "sin_rastreo"           // NO SÉ: sin evidencia para opinar de puntualidad
  | "riesgo"                // PREDICCIÓN: no llegará al objetivo
  | "en_punto_sin_iniciar"  // el bus ESTÁ ahí; falta el toque de "Iniciar"
  | "retraso"               // pasó la hora, no inició y NO está en el punto
  | "retraso_en_ruta"       // ya inició, pero llegará tarde al siguiente paradero
  | "inicio_tarde"          // arrancó tarde: hecho CONSUMADO, informativo, no accionable
  | "no_realizado";         // pasó la hora hace horas y nunca hubo nada

export type ReservaPuntual = {
  id: number;
  estado: string;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  hora_real_inicio?: string | null;
};

export type ParadaPuntual = {
  id: number;
  orden: number;
  nombre?: string | null;
  lat: number | string | null;
  lng: number | string | null;
  hora_estimada?: string | null;
  estado?: string | null;
  /** TIMESTAMPTZ: hora REAL de arribo (la escribe el geofence del app del conductor).
   *  Es la evidencia más fiable que hay: presente en el 85 % de las paradas, mientras que
   *  `reservas.hora_real_inicio` está vacía en el 99,9 % (medido sobre 784 servicios). */
  hora_llegada?: string | null;
};

/** Fix GPS ya normalizado. `ts` en ms epoch; `acc` en metros. */
export type FixPuntual = {
  lat: number; lng: number; ts: number; acc: number;
  vel?: number | null;
  simulado?: boolean | null;
};

/** ETA ya calculado por quien SÍ puede pagar (lib/eta-trafico.ts). Minutos hasta el punto. */
export type EtaPuntual = { minutos: number; fuente: "google" | "estimado"; calculadoTs: number };

export type Posicion = {
  estado: "en_punto" | "lejos" | "desconocida";
  /** alta = fix fresco y preciso · baja = fix rancio pero utilizable · nula = sin evidencia */
  confianza: "alta" | "baja" | "nula";
  distanciaM: number | null;
  /** minutos transcurridos desde el último fix (null si no hay ninguno) */
  hace: number | null;
  velKmh: number | null;
  motivo: string;
};

export type Veredicto = {
  nivel: NivelRetraso;
  /** minutos de retraso (previsto o consumado). Positivo = tarde. */
  minutos: number | null;
  causa: string;
  evidencia: string;
  posicion: Posicion;
  /** ¿amerita molestar al coordinador? (el chip azul de "en el punto" NO escala) */
  escala: boolean;
  /** minuto del día (Lima) en que el bus DEBÍA estar en el punto */
  objetivoMin: number | null;
  paradaRefId: number | null;
  /** true = el veredicto mejoraría con un ETA real; el llamador decide si lo paga */
  requiereEta: boolean;
};

export type ConfigRetraso = {
  /** el bus debe estar EN el punto estos minutos ANTES de la hora pactada (ventana de embarque) */
  anticipacionMin: number;
  /** gracia tras la hora pactada antes de declarar retraso consumado */
  toleranciaMin: number;
  /** el ETA debe exceder el objetivo en >= esto para declarar riesgo */
  riesgoMin: number;
  /** histéresis: por debajo de esto el riesgo se limpia (evita el chip parpadeante) */
  riesgoLimpiaMin: number;
  /** el bus lleva esto en el punto pasada la hora sin iniciar → escala a rojo */
  persistenciaPuntoMin: number;
  /** pasada la hora esto sin nada → ya no es "retraso", es servicio no realizado */
  noRealizadoMin: number;
  /** desde cuántos minutos antes se empieza a vigilar el servicio */
  ventanaPrevisionMin: number;
  /** gracia para el retraso EN RUTA (contra la hora_estimada del siguiente paradero) */
  toleranciaRutaMin: number;
};

export const CONFIG_RETRASO_DEFAULT: ConfigRetraso = {
  anticipacionMin:      10,   // decisión del operador (2026-08-20): "en el paradero 10 min antes"
  toleranciaMin:        10,   // = umbral histórico de `no_inicio` en alerta_config
  riesgoMin:             8,
  riesgoLimpiaMin:       3,
  persistenciaPuntoMin: 10,
  noRealizadoMin:      120,
  ventanaPrevisionMin:  60,
  toleranciaRutaMin:    10,
};

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTES DE DECISIÓN GEOGRÁFICA — citadas de lib/proximidad.ts:37-49
// ══════════════════════════════════════════════════════════════════════════════

const PRECISION_MAX_M   = 150;          // peor precisión → sin decisiones (fix de antena, no de satélite)
const VEL_MAX_QUIETO    = 20;           // km/h; más rápido cerca del paradero = va DE PASO
const FRESCO_MS         = 5 * 60_000;   // fix más nuevo que esto → decisión de confianza ALTA
const RANCIO_MS         = 20 * 60_000;  // entre FRESCO y RANCIO → confianza BAJA; más allá → no sé
const PERMANENCIA_MS    = 90_000;       // "está ahí" exige quedarse: >=2 fixes abarcando >=90 s
const HIST_VEL          = 15;           // ventana de fixes para velocidadPorVentana

// Estimación GRATIS de ETA. Existe para NO pagarle a Google salvo en la franja de duda:
// pedir tráfico cae en el SKU "Directions Advanced" ($10/1000, solo 5.000 gratis al mes,
// ver app/api/ruta/route.ts:5-18). Con 26 servicios/día × 6 chequeos serían ~4.700
// llamadas/mes solo por este módulo: pegado al techo y compitiendo con el resto del ERP.
const FACTOR_SINUOSIDAD = 1.35;         // recta → calle: factor urbano conservador
const VEL_OPTIMISTA: [number, number][] = [[2000, 25], [10000, 35], [Infinity, 50]];
const VEL_PESIMISTA: [number, number][] = [[2000, 12], [10000, 18], [Infinity, 28]];

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS DE TIEMPO (puros; el llamador entrega la hora de Lima ya resuelta)
// ══════════════════════════════════════════════════════════════════════════════

/** "HH:MM[:SS]" → minutos del día. null si no parsea. */
export function hhmmMin(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
}

/** TIMESTAMPTZ ISO → minutos del día en LIMA (UTC-5). null si no parsea. */
export function tsMinLima(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - 5 * 3600000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Minutos del día → "HH:MM" (envuelve a 24 h por si un ETA cruza la medianoche). */
export function minHhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** Radio de llegada adaptativo a la precisión — lib/proximidad.ts:47 verbatim. */
export function radioLlegadaM(acc: number): number {
  return Math.min(250, Math.max(120, 1.5 * acc));
}

// ══════════════════════════════════════════════════════════════════════════════
// ETA GRATIS — la franja de duda es lo ÚNICO que se le paga a Google
// ══════════════════════════════════════════════════════════════════════════════

function velDe(tabla: [number, number][], distancia: number): number {
  for (const [tope, kmh] of tabla) if (distancia < tope) return kmh;
  return tabla[tabla.length - 1][1];
}

/**
 * Cota OPTIMISTA y PESIMISTA del tiempo de viaje, sin llamar a nadie. Con esto:
 *   • si ni con la cota optimista llega  → RIESGO seguro, sin pagar;
 *   • si hasta con la pesimista llega    → SIN riesgo, sin pagar;
 *   • solo lo de en medio justifica el SKU con tráfico.
 */
export function etaLibreMin(distanciaRectaM: number): { optimista: number; pesimista: number } {
  const km = (distanciaRectaM * FACTOR_SINUOSIDAD) / 1000;
  return {
    optimista: Math.max(1, Math.round((km / velDe(VEL_OPTIMISTA, distanciaRectaM)) * 60)),
    pesimista: Math.max(2, Math.round((km / velDe(VEL_PESIMISTA, distanciaRectaM)) * 60)),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ¿DÓNDE ESTÁ EL BUS? — SÍ / NO / NO SÉ
// ══════════════════════════════════════════════════════════════════════════════

const POSICION_NULA: Posicion = {
  estado: "desconocida", confianza: "nula", distanciaM: null, hace: null, velKmh: null, motivo: "",
};

/**
 * Decide la posición del bus respecto de UN punto. Nunca con un fix suelto: un GPS de
 * red a ±150 m colocaría el bus "en el paradero" desde media cuadra, y un bus que PASA
 * a 60 km/h no está ahí. Las puertas son las de lib/proximidad.ts, más una de
 * PERMANENCIA que aquí sí hace falta: proximidad decide "llegó" para avisar al pasajero
 * (donde un falso positivo es barato); aquí decide APAGAR una alerta de retraso, y
 * apagarla por error es exactamente el fallo que este módulo viene a corregir.
 */
export function posicionRespectoA(
  fixes: FixPuntual[],
  punto: { lat: number; lng: number },
  ahoraMs: number,
): Posicion {
  const vacia = (motivo: string, hace?: number): Posicion => ({ ...POSICION_NULA, motivo, hace: hace ?? null });

  const buenos = (fixes || [])
    .filter((f) => Number.isFinite(f?.lat) && Number.isFinite(f?.lng) && Number.isFinite(f?.ts))
    .sort((a, b) => a.ts - b.ts);
  if (!buenos.length) return vacia("sin puntos GPS");

  const ultimo = buenos[buenos.length - 1];
  const hace = Math.max(0, Math.round((ahoraMs - ultimo.ts) / 60000));

  // GPS falso (isFromMockProvider). Un conductor que simula estar en el paradero apagaría
  // justo la alerta que importa: se trata como SIN evidencia y se delata el motivo.
  if (ultimo.simulado === true) return vacia("GPS simulado detectado", hace);

  if (ahoraMs - ultimo.ts > RANCIO_MS) return vacia(`última posición hace ${hace} min`, hace);

  const acc = Number.isFinite(ultimo.acc) ? Number(ultimo.acc) : 999;
  if (acc > PRECISION_MAX_M) return vacia(`precisión ±${Math.round(acc)} m (antena)`, hace);

  const dist = distM(ultimo.lat, ultimo.lng, punto.lat, punto.lng);
  const confianza: "alta" | "baja" = ahoraMs - ultimo.ts <= FRESCO_MS ? "alta" : "baja";

  const hist: FixVel[] = buenos.slice(-HIST_VEL).map((f) => ({
    lat: f.lat, lng: f.lng, ts: f.ts, acc: Number.isFinite(f.acc) ? f.acc : 50,
  }));
  const velKmh = velocidadPorVentana(hist, Number(ultimo.vel ?? 0));

  const radio = radioLlegadaM(acc);
  if (dist > radio) {
    return { estado: "lejos", confianza, distanciaM: Math.round(dist), hace, velKmh, motivo: "" };
  }

  // Dentro del radio: exigir QUIETO y PERMANENCIA antes de afirmar "está ahí".
  if (velKmh !== null && velKmh > VEL_MAX_QUIETO) {
    return { estado: "lejos", confianza, distanciaM: Math.round(dist), hace, velKmh, motivo: "pasa de largo" };
  }
  const dentro = buenos.filter((f) => distM(f.lat, f.lng, punto.lat, punto.lng) <= radio);
  const permanece = dentro.length >= 2 && dentro[dentro.length - 1].ts - dentro[0].ts >= PERMANENCIA_MS;

  return {
    estado: "en_punto",
    // Un solo fix dentro del radio es indicio, no permanencia: se reporta con confianza baja
    // para que quien escale sepa que no es un hecho firme.
    confianza: permanece ? confianza : "baja",
    distanciaM: Math.round(dist),
    hace, velKmh,
    motivo: permanece ? "" : "un solo fix dentro del radio",
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// VEREDICTO
// ══════════════════════════════════════════════════════════════════════════════

export type EntradaPuntualidad = {
  reserva: ReservaPuntual;
  paradas: ParadaPuntual[];
  /** últimos fixes del bus (cualquier orden; se ordenan aquí) */
  fixes: FixPuntual[];
  ahoraMs: number;
  /** minutos del día en Lima */
  ahoraMin: number;
  /** fecha de hoy en Lima (YYYY-MM-DD) */
  hoy: string;
  eta?: EtaPuntual | null;
  cfg?: Partial<ConfigRetraso>;
  /** unidad tercerizada: sin GPS hasta que el conductor abre el link del token */
  esTercero?: boolean;
};

const SIN_VEREDICTO = (nivel: NivelRetraso, causa: string): Veredicto => ({
  nivel, minutos: null, causa, evidencia: "",
  posicion: POSICION_NULA,
  escala: false, objetivoMin: null, paradaRefId: null, requiereEta: false,
});

/** Primera parada CON coordenadas: el punto contra el que se mide la puntualidad de salida. */
function paradaOrigen(paradas: ParadaPuntual[]): (ParadaPuntual & { lat: number; lng: number }) | null {
  const ord = [...(paradas || [])].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  for (const p of ord) {
    const la = num(p.lat), ln = num(p.lng);
    if (la !== null && ln !== null) return { ...p, lat: la, lng: ln };
  }
  return null;
}

/** Siguiente parada pendiente CON coordenadas (para el retraso EN RUTA). */
function paradaSiguiente(paradas: ParadaPuntual[]): (ParadaPuntual & { lat: number; lng: number }) | null {
  const ord = [...(paradas || [])].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  for (const p of ord) {
    if (p.estado === "completada") continue;
    const la = num(p.lat), ln = num(p.lng);
    if (la !== null && ln !== null) return { ...p, lat: la, lng: ln };
  }
  return null;
}

/**
 * Minuto (Lima) en que el servicio ARRANCÓ de verdad.
 *
 * `reservas.hora_real_inicio` es papel mojado: está vacía en 783 de 784 servicios de los
 * últimos 30 días — el botón de check-in de la torre no lo usa nadie y la app del
 * conductor solo mueve `estado`. La fuente que SÍ existe es `paradas.hora_llegada` del
 * primer paradero, que escribe el geofence del app (85 % de cobertura). Se prefiere la
 * declarada y se cae a la registrada.
 */
function inicioRealMin(r: ReservaPuntual, paradas: ParadaPuntual[]): number | null {
  const declarado = hhmmMin(r.hora_real_inicio);
  if (declarado !== null) return declarado;
  const conLlegada = [...(paradas || [])]
    .filter((p) => p.hora_llegada)
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  return conLlegada.length ? tsMinLima(conLlegada[0].hora_llegada) : null;
}

function frase(partes: (string | null | undefined | false)[]): string {
  return partes.filter(Boolean).join(" · ");
}

/** Posición respecto a la hora pactada, en palabras. `desdeHora` positivo = ya pasó. */
function relojDe(desdeHora: number): string {
  const m = Math.round(Math.abs(desdeHora));
  if (desdeHora < -0.5) return `faltan ${m} min`;
  if (desdeHora <= 0.5) return "es la hora";
  return `${m} min pasada la hora`;
}

/**
 * Veredicto de puntualidad de UN servicio. Puro y determinista: mismas entradas,
 * misma salida. El llamador decide qué hacer con `nivel` y `escala`.
 */
export function evaluarPuntualidad(e: EntradaPuntualidad): Veredicto {
  const cfg = { ...CONFIG_RETRASO_DEFAULT, ...(e.cfg || {}) };
  const r = e.reserva;

  if (r.estado === "cancelada") return SIN_VEREDICTO("na", "cancelada");
  if (r.fecha_servicio !== e.hoy) return SIN_VEREDICTO("na", "otro día");

  const horaPactada = hhmmMin(r.hora_servicio);
  if (horaPactada === null) return SIN_VEREDICTO("na", "sin hora pactada");

  // ── Servicio ya cerrado: el retraso deja de ser alerta VIVA y pasa a ser un dato
  //    histórico. Es lo que arregla el tablero con 6 chips rojos a las 23:54.
  if (r.estado === "finalizada") {
    const ini = inicioRealMin(r, e.paradas);
    const dif = ini === null ? null : ini - horaPactada;
    const tarde = dif !== null && dif > cfg.toleranciaMin;
    // Servicio cerrado que arrancó tarde: se conserva como HECHO, en gris y sin escalar.
    // No es una alerta viva (no hay nada que despachar), pero borrarlo dejaría el día sin
    // memoria — y es justo el dato que permite ver si una hora pactada está mal puesta.
    return {
      ...SIN_VEREDICTO(tarde ? "inicio_tarde" : "na", tarde ? "inició tarde" : "finalizada"),
      minutos: dif,
      evidencia: tarde ? `llegó al primer paradero a las ${minHhmm(ini as number)}` : "",
    };
  }

  // El objetivo NO es la hora pactada: es estar EN el punto con holgura para embarcar.
  // Si el bus llega justo a la hora, para el pasajero ya llegó tarde.
  const objetivoMin = horaPactada - cfg.anticipacionMin;
  const origen = paradaOrigen(e.paradas);
  const desdeHora = e.ahoraMin - horaPactada;   // + = ya pasó la hora

  // ── RAMA EN RUTA ────────────────────────────────────────────────────────────
  if (r.estado === "en_curso") {
    const sig = paradaSiguiente(e.paradas);
    const pos = sig ? posicionRespectoA(e.fixes, sig, e.ahoraMs) : POSICION_NULA;
    const objSig = hhmmMin(sig?.hora_estimada ?? null);
    const inicio = inicioRealMin(r, e.paradas);
    const difInicio = inicio === null ? null : inicio - horaPactada;
    const base = {
      posicion: pos, objetivoMin: objSig, paradaRefId: sig?.id ?? null,
      escala: false, requiereEta: false,
    };

    // Sin hora planificada del siguiente paradero no hay contra qué comparar: no se
    // inventa un retraso (ese fue el bug b03caba, "la hora de ahora" como ETA).
    // Arrancó tarde: hecho consumado. Se pinta (gris) aunque el resto vaya bien — antes
    // esto salía VERDE y el día perdía el único retraso que de verdad ocurrió.
    const arrancoTarde = difInicio !== null && difInicio > cfg.toleranciaMin;
    if (!sig || objSig === null || pos.estado === "desconocida") {
      return {
        ...base, nivel: arrancoTarde ? "inicio_tarde" : "en_hora", minutos: difInicio,
        causa: arrancoTarde ? `inició ${difInicio} min tarde` : "en ruta",
        evidencia: sig ? frase([sig.nombre, pos.motivo]) : "sin paradas pendientes con coordenadas",
      };
    }

    const dist = pos.distanciaM ?? 0;
    const libre = etaLibreMin(dist);
    const etaMin = e.eta?.minutos ?? null;
    // Sin ETA pagado se usa la cota OPTIMISTA: así el chip morado nunca aparece por la
    // incertidumbre del propio estimador, solo cuando ni en el mejor caso llega.
    const llegada = (etaMin ?? libre.optimista) + e.ahoraMin;
    const desvio = llegada - objSig;
    // Una sola puerta (`toleranciaRutaMin`), no dos: restarla Y exigir `riesgoMin` encima
    // subía el disparo real a 18 min sin que nadie lo hubiera decidido.
    if (desvio >= cfg.toleranciaRutaMin) {
      return {
        ...base, nivel: "retraso_en_ruta", minutos: Math.round(desvio), escala: true,
        causa: `llegará tarde a ${sig.nombre || "el paradero"}`,
        evidencia: frase([
          `a ${(dist / 1000).toFixed(1)} km`,
          `ETA ${minHhmm(llegada)} vs ${minHhmm(objSig)} plan`,
          e.eta?.fuente === "google" ? "con tráfico" : "estimado",
          pos.hace !== null ? `GPS hace ${pos.hace} min` : null,
        ]),
        requiereEta: e.eta?.fuente !== "google",
      };
    }
    return {
      ...base, nivel: arrancoTarde ? "inicio_tarde" : "en_hora", minutos: difInicio,
      causa: arrancoTarde ? `inició ${difInicio} min tarde, recuperando` : "en ruta, en hora",
      evidencia: frase([`ETA ${minHhmm(llegada)}`, `plan ${minHhmm(objSig)}`]),
    };
  }

  // ── RAMA PRE-INICIO (programada / confirmada / pendiente) ───────────────────
  // Sin coordenadas en el primer paradero no hay geometría posible. Es un problema de
  // DATOS, no de operación: se distingue del "sin GPS" para que nadie llame al conductor
  // a preguntarle por algo que se arregla en la ficha de la ruta.
  const sinCoords = !origen;
  const posGps = origen
    ? posicionRespectoA(e.fixes, origen, e.ahoraMs)
    : { ...POSICION_NULA, motivo: "el primer paradero no tiene coordenadas" };

  // SEGUNDA FUENTE DE EVIDENCIA: la llegada REGISTRADA al primer paradero
  // (`paradas.hora_llegada`, que escribe el geofence del app del conductor). Cubre
  // justo el agujero que deja el GPS: de 26 servicios medidos el 19-ago, 10 no tenían
  // señal utilizable —sin puntos, fix de antena a ±600 m o posición de hace 21 min— y
  // sobre todos ellos el módulo solo podía decir "no sé".
  //
  // NO PISA AL GPS: solo se usa cuando la posición es DESCONOCIDA. Si hay señal fresca
  // diciendo que el bus está lejos, manda el GPS — el bus pudo llegar, no iniciar y
  // marcharse; el hecho registrado es del pasado, el fix es del presente.
  // Solo cuenta si YA ocurrió: un timestamp futuro (reloj desfasado del móvil, o un
  // replay histórico) no puede usarse como prueba de que el bus está ahí.
  const llegadaOrigenMin = origen ? tsMinLima(origen.hora_llegada) : null;
  const llegadaRegistrada = llegadaOrigenMin !== null && llegadaOrigenMin <= e.ahoraMin
    ? llegadaOrigenMin : null;
  const pos: Posicion =
    posGps.estado === "desconocida" && llegadaRegistrada !== null
      ? { ...posGps, estado: "en_punto", confianza: "alta", distanciaM: 0,
          motivo: `llegada registrada ${minHhmm(llegadaRegistrada)}` }
      : posGps;
  const base = { posicion: pos, objetivoMin, paradaRefId: origen?.id ?? null, requiereEta: false, escala: false };

  // Servicio no realizado: pasada la hora hace horas, sin inicio y sin nada. No es un
  // retraso operativo (ya no hay nada que despachar): es una incidencia.
  if (desdeHora > cfg.noRealizadoMin) {
    return {
      ...base, nivel: "no_realizado", minutos: Math.round(desdeHora), escala: true,
      causa: "no se realizó",
      evidencia: frase([
        `${Math.floor(desdeHora / 60)} h ${Math.round(desdeHora % 60)} min de la hora pactada`,
        "sin inicio registrado",
      ]),
    };
  }

  // Fuera de la ventana de vigilancia: todavía es demasiado pronto para opinar.
  if (desdeHora < -cfg.ventanaPrevisionMin) {
    return { ...base, nivel: "na", minutos: null, causa: "aún no", evidencia: "" };
  }

  // ── EL BUS ESTÁ EN EL PUNTO ───────────────────────────────────────────────
  // Lo más importante del módulo: esto NO es un retraso. El bus está donde debe estar;
  // lo que falta es el toque de "Iniciar". Escala solo si PERSISTE pasada la hora.
  //
  // Antes del OBJETIVO (hora pactada menos la anticipación de embarque) llegar al punto
  // es simplemente puntualidad ejemplar: nada que avisar. Empujar a un conductor a
  // "iniciar" 30 min antes sería pedirle que arranque el servicio antes de tiempo.
  if (pos.estado === "en_punto" && e.ahoraMin < objetivoMin) {
    return {
      ...base, nivel: "en_hora", minutos: 0,
      causa: "ya en el punto",
      evidencia: frase([
        origen?.nombre ? `en ${origen.nombre}` : "en el primer paradero",
        `${Math.round(objetivoMin - e.ahoraMin)} min antes de lo previsto`,
      ]),
    };
  }
  if (pos.estado === "en_punto") {
    const persiste = desdeHora > cfg.persistenciaPuntoMin;
    return {
      ...base,
      nivel: "en_punto_sin_iniciar",
      minutos: desdeHora > 0 ? Math.round(desdeHora) : 0,
      escala: persiste,
      causa: persiste ? "en el punto y sin iniciar" : "en el punto, falta iniciar",
      evidencia: frase([
        origen?.nombre ? `en ${origen.nombre}` : "en el primer paradero",
        llegadaRegistrada !== null && posGps.estado === "desconocida"
          ? `llegada registrada ${minHhmm(llegadaRegistrada)}`
          : pos.hace !== null ? `GPS hace ${pos.hace} min` : null,
        pos.confianza === "baja" ? `confianza baja (${pos.motivo || "fix rancio"})` : null,
        persiste ? `${Math.round(desdeHora)} min pasada la hora` : null,
      ]),
    };
  }

  // ── PASÓ LA HORA + TOLERANCIA, NO INICIÓ Y NO ESTÁ EN EL PUNTO ────────────
  // Que no haya GPS no borra el hecho: el servicio no arrancó. El GPS solo cambia la CAUSA.
  if (desdeHora > cfg.toleranciaMin) {
    const ciego = pos.estado === "desconocida";
    return {
      ...base, nivel: "retraso", minutos: Math.round(desdeHora), escala: true,
      causa: ciego ? "retraso · sin rastreo para confirmar" : "retraso confirmado",
      evidencia: ciego
        ? frase([`${Math.round(desdeHora)} min pasada la hora`, "sin inicio en la app", pos.motivo || "sin GPS"])
        : frase([
            `${Math.round(desdeHora)} min pasada la hora`,
            // "pasa de largo": el bus SÍ está junto al paradero pero en marcha. Decir
            // "a 0.0 km del punto" sería literalmente cierto y operativamente absurdo.
            pos.motivo === "pasa de largo"
              ? "pasó junto al paradero sin detenerse"
              : pos.distanciaM !== null ? `a ${(pos.distanciaM / 1000).toFixed(1)} km del punto` : null,
            pos.hace !== null ? `GPS hace ${pos.hace} min` : null,
          ]),
    };
  }

  // ── ANTES DE LA HORA: aquí es donde el módulo gana su sueldo ───────────────
  if (pos.estado === "desconocida") {
    // NO SÉ. Nunca se dice "retraso" por falta de evidencia. Para un tercero esto es
    // además un incumplimiento medible: no abrió el link (decisión del operador
    // 2026-08-20 → avisa al proveedor y suma al reporte mensual de cumplimiento).
    return {
      ...base,
      nivel: "sin_rastreo",
      minutos: null,
      // Desde ~T-30 ya vale avisar. Salvo que el problema sean las coordenadas: eso no
      // se resuelve llamando a nadie, así que no despierta al coordinador.
      escala: !sinCoords && desdeHora > -cfg.ventanaPrevisionMin / 2,
      causa: sinCoords ? "sin coordenadas del paradero"
           : e.esTercero ? "el tercero no abrió el link" : "sin rastreo",
      evidencia: frase([pos.motivo || "sin GPS", relojDe(desdeHora)]),
    };
  }

  const dist = pos.distanciaM ?? 0;
  const libre = etaLibreMin(dist);
  const etaMin = e.eta?.minutos ?? null;

  // DOS PLAZOS DISTINTOS, y confundirlos es lo que convierte esto en ruido:
  //   • OBJETIVO (blando) = hora pactada − anticipación. Es la meta de planificación:
  //     estar con margen para embarcar. Quedarse corto NO es una alerta, es "sin margen".
  //   • LÍMITE DURO = hora pactada + tolerancia. Llegar después de esto SÍ es un retraso
  //     que el cliente nota y que hay que avisar.
  // La primera versión escalaba contra el objetivo: con anticipación 10 y umbral 8, un bus
  // a 200 m que llegaba 1 min después de la hora salía como "RIESGO +16". El replay del
  // 19-ago dio 8 falsos así de 26 servicios — un tercio del día en ámbar sin motivo.
  const limiteDuro = horaPactada + cfg.toleranciaMin;
  const riesgoDe = (llegada: number, detalle: string[]): Veredicto => ({
    ...base, nivel: "riesgo", minutos: Math.round(llegada - horaPactada), escala: true,
    causa: "riesgo de retraso",
    evidencia: frase([`a ${(dist / 1000).toFixed(1)} km`, ...detalle, `pactada ${minHhmm(horaPactada)}`]),
  });
  const sinMargen = (llegada: number): Veredicto => ({
    ...base, nivel: "en_hora", minutos: Math.round(llegada - horaPactada),
    // Llega dentro de lo tolerable pero pierde la ventana de embarque: se muestra, no se avisa.
    causa: llegada > objetivoMin ? "llega justo, sin margen" : "llega a tiempo",
    evidencia: frase([
      `ETA ${minHhmm(llegada)}`,
      llegada > objetivoMin ? `objetivo ${minHhmm(objetivoMin)}` : null,
    ]),
  });

  if (etaMin !== null) {
    const llegada = e.ahoraMin + etaMin;
    if (llegada > limiteDuro) {
      return riesgoDe(llegada, [
        `ETA ${minHhmm(llegada)} ${e.eta?.fuente === "google" ? "con tráfico" : "estimado"}`,
      ]);
    }
    return sinMargen(llegada);
  }

  // Sin ETA pagado: se decide con las dos cotas gratis y solo se pide pagar en la duda.
  const llegadaOpt = e.ahoraMin + libre.optimista;
  const llegadaPes = e.ahoraMin + libre.pesimista;
  if (llegadaOpt > limiteDuro) {
    // Ni en el mejor de los casos llega a tiempo: es riesgo SIN gastar un centavo.
    return riesgoDe(llegadaOpt, [`ni en el mejor caso llega antes de ${minHhmm(llegadaOpt)}`]);
  }
  if (llegadaPes <= limiteDuro) {
    // Hasta con la cota pesimista llega: tampoco hace falta pagar.
    return {
      ...sinMargen(llegadaOpt),
      evidencia: frase([`a ${(dist / 1000).toFixed(1)} km`, "llega incluso con tráfico pesado"]),
    };
  }
  // Franja de duda: AQUÍ (y solo aquí) vale la pena el SKU con tráfico.
  return {
    ...base, nivel: "en_hora", minutos: Math.round(llegadaOpt - horaPactada), requiereEta: true,
    causa: "por confirmar con tráfico",
    evidencia: frase([`a ${(dist / 1000).toFixed(1)} km`, `entre ${minHhmm(llegadaOpt)} y ${minHhmm(llegadaPes)}`]),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PRESENTACIÓN (compartida por torre, drawer y avisos: una sola etiqueta por nivel)
// ══════════════════════════════════════════════════════════════════════════════

export const NIVEL_RETRASO: Record<NivelRetraso, { label: string; corto: string; color: string; bg: string; orden: number }> = {
  retraso:              { label: "Retraso confirmado",       corto: "RETRASO",       color: "#dc2626", bg: "#fef2f2", orden: 1 },
  no_realizado:         { label: "No se realizó",            corto: "NO SALIÓ",      color: "#991b1b", bg: "#fee2e2", orden: 2 },
  riesgo:               { label: "Riesgo de retraso",        corto: "RIESGO",        color: "#b45309", bg: "#fffbeb", orden: 3 },
  retraso_en_ruta:      { label: "Retraso en ruta",          corto: "TARDE EN RUTA", color: "#7c3aed", bg: "#f5f3ff", orden: 4 },
  en_punto_sin_iniciar: { label: "En el punto, sin iniciar", corto: "EN EL PUNTO",   color: "#1d4ed8", bg: "#eff6ff", orden: 5 },
  sin_rastreo:          { label: "Sin rastreo",              corto: "SIN GPS",       color: "#475569", bg: "#f1f5f9", orden: 6 },
  inicio_tarde:         { label: "Inició tarde",             corto: "INICIÓ",        color: "#78716c", bg: "#fafaf9", orden: 7 },
  en_hora:              { label: "En hora",                  corto: "EN HORA",       color: "#15803d", bg: "#f0fdf4", orden: 8 },
  na:                   { label: "—",                        corto: "",              color: "#94a3b8", bg: "#f8fafc", orden: 9 },
};

/** ¿Este nivel es una alerta VIVA que debe contar en el KPI de la torre? */
export function esAlertaViva(v: Veredicto): boolean {
  return v.escala && v.nivel !== "na" && v.nivel !== "en_hora";
}
