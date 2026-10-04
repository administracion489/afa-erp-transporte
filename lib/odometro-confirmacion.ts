// ─────────────────────────────────────────────────────────────────────────────
// lib/odometro-confirmacion.ts — ¿basta un toque para confirmar este km, o hay que reescribirlo?
//
// Módulo PURO. Lo usa la pantalla de confirmación de la app AFA Conductor (check-in y
// check-out) antes de enviar el kilometraje.
//
// El caso (D4V-955, 02/10/2026 05:43): el tablero dice ODO 178227 y entró 15,700,000 km.
// La base lo frenó —quedó "sospechosa" y no movió el vigente— pero llegó a la bandeja del
// operador, que tiene que adivinar el número desde una foto borrosa días después. El único
// momento en que alguien tiene el tablero DELANTE es cuando el conductor toma la foto: ahí
// tiene que confirmarse el número, no en la oficina.
//
// Dos niveles, y la diferencia es deliberada:
//   · "ok"      → pantalla grande con el número y la foto: un toque ("Sí, es correcto").
//   · "revisar" → el número tiene una forma imposible o se aleja de lo esperado: se pide
//                 ESCRIBIRLO otra vez. Un toque se da sin leer; reescribir obliga a mirar
//                 el tablero cifra por cifra, que es justo donde está el error.
// Nada bloquea: si el conductor reescribe el mismo número, se envía y la base lo juzga igual
// (puede quedar por revisar). Un km legítimo raro —unidad que estuvo parada, tablero cambiado—
// tiene que poder registrarse.
// ─────────────────────────────────────────────────────────────────────────────

import { revisarKmTecleado, digitosDe } from "@/lib/odometro-seleccion";

/**
 * Km de más sobre el vigente a partir del cual se pide reescribir. NO está medido: son dos
 * jornadas al tope de `KM_DIA_MAX` (1500). El vigente puede ser de hace días, así que un salto
 * mayor es posible; por eso solo pide reescribir y no bloquea.
 */
export const SALTO_REVISAR_KM = 3000;

export type JuicioKmConductor = { nivel: "ok" | "revisar"; motivos: string[] };

const fmt = (n: number) => Math.round(n).toLocaleString("es-PE");

export function juzgarKmConductor(e: {
  km: number | null | undefined;
  kmVigente?: number | null;
  kmOcr?: number | null;
}): JuicioKmConductor {
  const km = Number(e.km);
  const vigente = Number(e.kmVigente || 0);
  const motivos: string[] = [];
  if (!Number.isFinite(km) || km <= 0) return { nivel: "revisar", motivos: ["No hay un kilometraje válido."] };

  const d = digitosDe(km);
  if (d < 3 || d > 7) motivos.push(`${fmt(km)} tiene ${d} dígitos: un odómetro tiene entre 3 y 7.`);

  const digito = revisarKmTecleado({ km, kmVigente: vigente });
  if (digito) motivos.push(digito.aviso);
  else if (vigente > 0 && km - vigente > SALTO_REVISAR_KM)
    motivos.push(`Son ${fmt(km - vigente)} km más que el último registrado (${fmt(vigente)}).`);

  if (vigente > 0 && km < vigente)
    motivos.push(`Es MENOR que el último registrado de esta unidad (${fmt(vigente)}): el odómetro no retrocede.`);

  // Lo tecleado no coincide con lo que leyó la IA: no es un error en sí (el conductor pudo
  // corregir a la IA, que es lo correcto), pero uno de los dos números está mal.
  const ocr = Number(e.kmOcr || 0);
  if (ocr > 0 && Math.round(ocr) !== Math.round(km))
    motivos.push(`La foto se leyó como ${fmt(ocr)} y escribiste ${fmt(km)}.`);

  return { nivel: motivos.length ? "revisar" : "ok", motivos };
}

/** ¿El número reescrito coincide con el que se quiere enviar? (ignora puntos, comas y espacios) */
export function coincideReescrito(original: number, reescrito: string): boolean {
  const limpio = String(reescrito ?? "").replace(/[^\d]/g, "");
  return limpio.length > 0 && Number(limpio) === Math.round(Number(original));
}

// ─── Consejo de foto: solo aparece cuando la foto salió mal ──────────────────
//
// La guía no va PERMANENTE sobre la cámara (saturaría la app y obligaría a una cámara propia,
// más lenta que la nativa): aparece cuando la IA dice que ESTA foto no se ve clara, con el
// arreglo concreto de lo que falló. El conductor que hace bien la foto no ve nada extra.

export type ConsejoFoto = { titulo: string; consejos: string[] };

const CONSEJOS: { re: RegExp; consejo: string }[] = [
  { re: /reflej|brillo|destell|luz/i,          consejo: "Hay reflejo sobre el número: inclina un poco el celular hasta que el brillo salga del número." },
  { re: /borros|desenfoc|movid/i,              consejo: "Salió movida: apoya el codo, toca la pantalla sobre el número para enfocar y espera un segundo." },
  { re: /oscur|poca luz|apagad|nocturn/i,      consejo: "Está oscura: enciende el tablero (contacto en ON) y no uses el flash, que refleja en el vidrio." },
  { re: /lejos|pequeñ|peque|distanc/i,         consejo: "El número sale muy pequeño: acércate hasta que el ODO llene el centro de la foto." },
  { re: /inclin|ángulo|angulo|torcid|lateral/i,consejo: "Está de lado: toma la foto de frente al tablero." },
  { re: /cortad|parcial|tapad|no se ve|incomplet/i, consejo: "El número sale cortado o tapado: que se vean todas las cifras del ODO." },
  { re: /trip|parcial/i,                       consejo: "Que se vea la línea ODO (el total), no solo el TRIP." },
];

/** Por qué la foto no sirvió y qué hacer, a partir de lo que respondió la IA. */
export function consejoFoto(e: { calidad?: string | null; confianza?: string | null; motivo?: string | null; repetido?: boolean }): ConsejoFoto | null {
  const mala = e.calidad === "mala";
  const dudosa = !!e.confianza && e.confianza !== "alta";
  if (!mala && !dudosa) return null;
  const consejos = [...new Set(CONSEJOS.filter(c => c.re.test(String(e.motivo ?? ""))).map(c => c.consejo))];
  // Sin un motivo reconocible se dan los dos que más fallan en esta flota. Con fallos repetidos
  // se da la lista completa: el aviso corto ya no funcionó.
  if (e.repetido) {
    for (const c of [CONSEJOS[0], CONSEJOS[1], CONSEJOS[3], CONSEJOS[4]]) if (!consejos.includes(c.consejo)) consejos.push(c.consejo);
  } else if (!consejos.length) {
    consejos.push(CONSEJOS[0].consejo, CONSEJOS[1].consejo);
  }
  return {
    titulo: mala ? "La foto no se ve clara" : "La IA no está segura del número",
    consejos,
  };
}

// ─── Odómetro del día contra el GPS ──────────────────────────────────────────
//
// Dos fuentes independientes del mismo recorrido. La asimetría decide todo: el GPS solo puede
// QUEDARSE CORTO (los huecos de señal se descartan, y no cuenta los traslados en vacío entre
// servicios), así que:
//   · odómetro MENOR que el GPS → físicamente imposible: una de las dos lecturas del día está mal.
//   · odómetro MAYOR que el GPS → normal (vacíos, huecos); solo se avisa si es desproporcionado.
// Sin GPS suficientemente medido no se juzga nada: un "no cuadra" con una huella de 20 % es ruido.

/** % mínimo de huella medida para confiar en el km del GPS. Heredado de MEDIDO_MIN_CONFIABLE (55) de la analítica de odómetro. */
export const GPS_MEDIDO_MIN = 55;
/** Tolerancia del lado corto: el GPS suaviza curvas, así que puede pasar al odómetro por poco. No medido. */
export const TOLERANCIA_CORTO = 0.85;
/** Del lado largo, cuántas veces el GPS + un margen fijo de vacíos. No medido; solo avisa. */
export const FACTOR_LARGO = 2.5;
export const MARGEN_LARGO_KM = 150;

export type CotejoGps =
  | { codigo: "coincide" | "sin_gps" | "sin_odometro"; detalle: string | null }
  | { codigo: "odometro_corto" | "odometro_largo"; detalle: string };

export function cotejarOdometroGps(e: { odoDia: number | null | undefined; gpsKm: number; medidoPct: number }): CotejoGps {
  // Ojo: Number(null) es 0, que sería "no se movió" — sin check-in no hay odómetro del día.
  const odo = e.odoDia == null ? NaN : Number(e.odoDia);
  if (!Number.isFinite(odo) || odo < 0) return { codigo: "sin_odometro", detalle: null };
  if (!(e.gpsKm > 0) || e.medidoPct < GPS_MEDIDO_MIN) return { codigo: "sin_gps", detalle: null };
  const gps = Math.round(e.gpsKm);
  if (odo < e.gpsKm * TOLERANCIA_CORTO)
    return { codigo: "odometro_corto", detalle: `El GPS registró al menos ${fmt(gps)} km en tus servicios de hoy, pero el odómetro da ${fmt(odo)} km (inicio → fin). El odómetro no puede marcar menos de lo recorrido: revisa el número.` };
  if (odo > e.gpsKm * FACTOR_LARGO + MARGEN_LARGO_KM)
    return { codigo: "odometro_largo", detalle: `El odómetro da ${fmt(odo)} km hoy y el GPS de tus servicios registró ${fmt(gps)} km. Revisa el número.` };
  return { codigo: "coincide", detalle: null };
}

// ─── Quién tomó la lectura (para el ranking por conductor) ───────────────────

/**
 * El conductor que registró una lectura de la app sale de su `idem_key`, que el route del
 * conductor arma como `checkin|checkout:<p|t>:<vehiculo>:<fecha>:<conductor_id>`. No hay una
 * columna conductor en `lecturas_odometro`: leer la clave con la que se ESCRIBIÓ es el mismo
 * camino, no una segunda deducción.
 */
export function conductorDeIdemKey(k: string | null | undefined): { momento: "checkin" | "checkout"; flotaVehiculo: "propia" | "tercero"; conductorId: number } | null {
  const m = /^(checkin|checkout):([pt]):\d+:\d{4}-\d{2}-\d{2}:(\d+)$/.exec(String(k ?? ""));
  if (!m) return null;
  return { momento: m[1] as "checkin" | "checkout", flotaVehiculo: m[2] === "t" ? "tercero" : "propia", conductorId: Number(m[3]) };
}

// ─── Ranking por conductor: cuántas lecturas suyas tuvo que corregir la oficina ───

/** Motivos de anulación que NO son un error de lectura (no cuentan contra el conductor). */
const NO_ES_ERROR = new Set(["duplicada", "reinicio"]);
/** Con menos lecturas que esto, el porcentaje no dice nada: se lista al final y en gris. */
export const MIN_LECTURAS_RANKING = 4;

export type FilaRanking = {
  conductorId: number; flotaVehiculo: "propia" | "tercero";
  lecturas: number; corregidas: number; porRevisar: number; tasa: number; poca: boolean;
};

export function rankingConductores(
  lecturas: { id: string; idem_key: string | null; estado: string }[],
  correcciones: { lectura_id: string; motivo_tipo: string }[],
): FilaRanking[] {
  const motivoDe = new Map(correcciones.map(c => [String(c.lectura_id), c.motivo_tipo]));
  const por = new Map<number, FilaRanking>();
  for (const l of lecturas) {
    const q = conductorDeIdemKey(l.idem_key);
    if (!q) continue;
    const f = por.get(q.conductorId) ?? { conductorId: q.conductorId, flotaVehiculo: q.flotaVehiculo, lecturas: 0, corregidas: 0, porRevisar: 0, tasa: 0, poca: true };
    f.lecturas++;
    if (l.estado === "anulada" && !NO_ES_ERROR.has(motivoDe.get(String(l.id)) ?? "")) f.corregidas++;
    if (l.estado === "sospechosa") f.porRevisar++;
    por.set(q.conductorId, f);
  }
  const filas = [...por.values()].map(f => ({ ...f, tasa: f.lecturas ? (f.corregidas + f.porRevisar) / f.lecturas : 0, poca: f.lecturas < MIN_LECTURAS_RANKING }));
  // Peor primero; las de pocas lecturas al final (un 1 de 1 no es un patrón).
  return filas.sort((a, b) => Number(a.poca) - Number(b.poca) || b.tasa - a.tasa || b.lecturas - a.lecturas);
}
