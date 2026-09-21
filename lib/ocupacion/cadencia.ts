// ══════════════════════════════════════════════════════════════════════════════
// lib/ocupacion/cadencia.ts
// CADA CUÁNTO SE MANDA y CUÁNTO PERIODO ABARCA son DOS EJES, no uno. Módulo PURO.
//
// El reporte nació mandándose los sábados con los últimos 7 días, y las dos cosas
// venían pegadas. Lo pidió el dueño separado y tiene razón: se puede querer un
// envío QUINCENAL que mire los últimos 30 días (una foto rodante, cada dos
// semanas), o uno SEMANAL que mire solo 7 (lo que pasó esa semana). Atarlos
// obligaría a elegir entre las dos mitades de lo que alguien quiere.
//
// ─── TODO SE DERIVA DEL CALENDARIO, SIN GUARDAR UN ANCLA ────────────────────
//
// «Cada 15 días» se podría implementar como «un sábado sí y otro no», pero eso
// necesita un ANCLA guardada y, el día que el cron falle una vez, la paridad se
// invierte para siempre y nadie entiende por qué el reporte cambió de semana. Los
// días 1 y 16 salen del calendario solos: un envío perdido no mueve los
// siguientes, y cualquiera puede predecir en qué fecha toca sin mirar la base.
// Mismo criterio que `publicadas_hoy` en /redes, que se DERIVA en vez de guardarse
// en un contador que hay que resetear.
//
// ─── EL PERIODO SIEMPRE CIERRA EL DÍA DEL ENVÍO ─────────────────────────────
//
// … salvo la ventana `mes`, que es el último mes calendario COMPLETO. Esa
// excepción es lo que hace coherentes las cuatro frecuencias: un envío del día 1
// con ventana «mes» reporta el mes que acaba de cerrar, no un solo día. Sin ella,
// «mensual + mes calendario» habría mandado un reporte de 24 horas.
//
// Toda la aritmética va sobre la cadena ISO en UTC. El servidor corre en UTC y
// «hoy» en Perú es UTC-5: `new Date()` local es justo la trampa que el resto del
// ERP tiene documentada.
//
// Matriz: la sección 12 de `npx tsx scripts/prueba-ocupacion-semanal.mts`
// ══════════════════════════════════════════════════════════════════════════════

// ─── Hora de Perú ────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" de hoy en Perú (UTC-5, sin horario de verano). */
export function hoyLima(ahora = Date.now()): string {
  return new Date(ahora - 5 * 3600000).toISOString().slice(0, 10);
}

/** Día de la semana en Perú. 0 = domingo … 6 = sábado. */
export function diaSemanaLima(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/** ¿Es sábado en Perú? */
export function esSabadoLima(ahora = Date.now()): boolean {
  return diaSemanaLima(hoyLima(ahora)) === 6;
}

// ─── Aritmética de calendario ────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** Cuántos días tiene ese mes. El día 0 del siguiente ES el último del actual. */
export function diasDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

export function restarDias(iso: string, n: number): string {
  // Mediodía UTC para que ningún desplazamiento de zona cruce la medianoche.
  return new Date(Date.parse(`${iso}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

export function esUltimoDiaDelMes(iso: string): boolean {
  const [a, m, d] = iso.split("-").map(Number);
  return d === diasDelMes(a, m);
}

// ─── Los dos ejes ────────────────────────────────────────────────────────────

export type Frecuencia = "semanal" | "quincenal" | "mensual" | "fin_de_mes";
export type Ventana = "7" | "15" | "30" | "mes";

export const FRECUENCIAS: { clave: Frecuencia; etiqueta: string; detalle: string }[] = [
  { clave: "semanal",    etiqueta: "Cada sábado",        detalle: "Al cerrar el sábado, todas las semanas." },
  { clave: "quincenal",  etiqueta: "Cada 15 días",       detalle: "Los días 1 y 16 de cada mes." },
  { clave: "mensual",    etiqueta: "Una vez al mes",     detalle: "El día 1 de cada mes." },
  { clave: "fin_de_mes", etiqueta: "Fin de mes",         detalle: "El último día de cada mes (28, 29, 30 o 31)." },
];

export const VENTANAS: { clave: Ventana; etiqueta: string; detalle: string }[] = [
  { clave: "7",   etiqueta: "Últimos 7 días",  detalle: "Los 7 días que cierran el día del envío." },
  { clave: "15",  etiqueta: "Últimos 15 días", detalle: "Los 15 días que cierran el día del envío." },
  { clave: "30",  etiqueta: "Últimos 30 días", detalle: "Los 30 días que cierran el día del envío." },
  { clave: "mes", etiqueta: "Mes calendario",  detalle: "El último mes completo (del 1 al último día)." },
];

/**
 * Un valor desconocido cae al DEFECTO, nunca se descarta la fila: sin migración
 * corrida las columnas llegan `undefined`, y tratar eso como «no mandar» apagaría
 * el reporte de un cliente que sí lo tiene encendido. El defecto es lo que el
 * módulo hacía antes de existir estos dos ejes — sábados con 7 días— así que la
 * migración no cambia el comportamiento de nadie.
 */
export function normalizarFrecuencia(v: unknown): Frecuencia {
  const s = String(v ?? "").trim().toLowerCase();
  return FRECUENCIAS.some((f) => f.clave === s) ? (s as Frecuencia) : "semanal";
}

export function normalizarVentana(v: unknown): Ventana {
  const s = String(v ?? "").trim().toLowerCase();
  return VENTANAS.some((x) => x.clave === s) ? (s as Ventana) : "7";
}

// ─── ¿Toca hoy? ──────────────────────────────────────────────────────────────

/**
 * Se decide SOLO con la fecha, sin mirar qué se mandó antes. El candado contra el
 * envío repetido es otro y vive en Postgres (`periodo_fin` único por cliente): son
 * dos preguntas distintas y mezclarlas haría que un envío fallido corriera la
 * fecha del siguiente.
 */
export function tocaHoy(frecuencia: Frecuencia, fechaLima: string): boolean {
  const dia = Number(fechaLima.split("-")[2]);
  switch (frecuencia) {
    case "semanal":    return diaSemanaLima(fechaLima) === 6;
    case "quincenal":  return dia === 1 || dia === 16;
    case "mensual":    return dia === 1;
    case "fin_de_mes": return esUltimoDiaDelMes(fechaLima);
  }
}

// ─── ¿Qué periodo abarca? ────────────────────────────────────────────────────

/**
 * El periodo que cierra en `fin`.
 *
 * Para 7/15/30 es literal: los N días que terminan ese día, `fin` incluido.
 *
 * Para `mes` es **el último mes calendario COMPLETO que ya cerró en `fin`**, y esa
 * definición es la que hace coherentes las cuatro frecuencias:
 *   · fin = 30-09 (último día)  → septiembre completo
 *   · fin = 01-10 (día 1)        → septiembre completo, no un día suelto
 *   · fin = 15-10 (a mitad)      → septiembre completo, no medio octubre
 * Un mes a medias no se puede comparar contra una factura mensual, y publicar
 * «octubre» con quince días dentro sería un número que nadie pactó.
 */
export function ventanaDe(ventana: Ventana, fin: string): { inicio: string; fin: string } {
  if (ventana !== "mes") {
    const n = Number(ventana);
    return { inicio: restarDias(fin, n - 1), fin };
  }
  const [a, m] = fin.split("-").map(Number);
  if (esUltimoDiaDelMes(fin)) {
    return { inicio: `${a}-${pad(m)}-01`, fin };
  }
  const ay = m === 1 ? a - 1 : a;
  const am = m === 1 ? 12 : m - 1;
  return { inicio: `${ay}-${pad(am)}-01`, fin: `${ay}-${pad(am)}-${pad(diasDelMes(ay, am))}` };
}

// ─── Lo que se dice en pantalla, derivado de los MISMOS valores ──────────────

/**
 * La frase que describe la configuración, compuesta con los mismos datos que usa
 * el motor. Compuesta dentro del TSX, una pantalla puede describir al revés lo que
 * el sistema hace sin que nada falle — que es exactamente lo que pasó con la
 * etiqueta del horario del conductor.
 */
export function describirCadencia(frecuencia: Frecuencia, ventana: Ventana): string {
  const f = FRECUENCIAS.find((x) => x.clave === frecuencia)!;
  const v = VENTANAS.find((x) => x.clave === ventana)!;
  const cuando = f.detalle.replace(/\.$/, "");
  const que = ventana === "mes"
    ? "el último mes calendario completo"
    : `los últimos ${ventana} días`;
  return `Se envía ${cuando.toLowerCase()}, con ${que}.`;
}

/**
 * El aviso de la combinación que NO hace lo que parece.
 *
 * Con la ventana `mes`, dos envíos del mismo mes piden el MISMO periodo, y el
 * candado de Postgres (único por `periodo_fin`) frena el segundo. No es un fallo
 * —es el candado haciendo su trabajo— pero sin decirlo, el operador configura
 * «cada sábado» y recibe un correo al mes sin entender por qué.
 *
 * No se BLOQUEA la combinación: querer intentarlo cada sábado por si el primero
 * falló es legítimo. Se DICE antes de guardar, misma conclusión que la ventana
 * invertida del horario y que el `hora_fija` con el modo en `anticipacion`.
 */
export function avisoCadencia(frecuencia: Frecuencia, ventana: Ventana): string | null {
  if (ventana !== "mes") return null;
  if (frecuencia === "semanal" || frecuencia === "quincenal") {
    // La primera redacción decía «solo saldrá el PRIMERO de cada mes» y la matriz la
    // desmintió: el 31-10-2026 cae sábado, así que ESE envío pide octubre y sale
    // también. Lo cierto —y lo único que hay que prometer— es que sale UNO por
    // periodo, que es exactamente lo que hace el candado.
    return "Con el mes calendario, varios envíos seguidos piden el MISMO periodo, así que "
      + "saldrá uno solo por mes: los demás lo encuentran ya enviado. "
      + "Para un correo por semana, elige una ventana de 7, 15 o 30 días.";
  }
  return null;
}

// ─── Compatibilidad ──────────────────────────────────────────────────────────

/** La ventana de siempre. Se conserva porque la usan el motor y su matriz. */
export function ventanaSemanal(fin: string, dias = 7): { inicio: string; fin: string } {
  return { inicio: restarDias(fin, dias - 1), fin };
}
