// ─────────────────────────────────────────────────────────────────────────────
// lib/radar/procedencia-placa.ts — ¿DE DÓNDE salió la placa de una lectura de odómetro?
//
// Módulo PURO (no lee la base), igual que coherencia-voucher.ts.
//
// El caso (12/09/2026, 21:59): "~Cerna" mandó al grupo una foto de tablero con
// "Kilometraje final unidad en la cochera" — sin placa en el texto, y un tablero no muestra
// placa. Su número no está en `conductores`. Aun así el Radar registró 24,484 km a la CWZ-371:
// la IA tenía delante la lista de guías de odómetro por placa (lib/radar/prompts.ts) y eligió
// la unidad cuyo tablero "se parecía". La lectura entró aceptada, la jornada de la CWZ-371 salió
// con 6,726 km y, como el anti-retroceso toma ese km como vigente, las lecturas buenas de los
// días siguientes empezaron a descartarse como "retroceso".
//
// Lo que separa una placa LEÍDA de una ADIVINADA no se le puede preguntar al modelo (la que
// adivinó la dará por leída). Se comprueba con lo que el ERP tiene:
//   1. la placa está ESCRITA en el texto del mensaje (o de su ráfaga), o
//   2. quien la envió es un conductor que ese día tiene ESA unidad asignada.
// Sin ninguna de las dos la placa no tiene respaldo y la lectura NO se graba sola: va a
// alerta para registro manual. Grabar un km en la unidad equivocada envenena el vigente,
// el mantenimiento y el rendimiento de esa unidad; dejar una lectura sin grabar cuesta
// teclearla a mano.
// ─────────────────────────────────────────────────────────────────────────────

export type ProcedenciaPlaca = "texto" | "asignacion" | "sin_respaldo";

const soloAlnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * ¿La placa aparece escrita en el texto? Tolera cómo la escriben los conductores:
 * "CWZ-371", "cwz 371", "C W Z 3 7 1", "placa BUI 2 7 2". Se exige la placa completa
 * (letras + números, ≥ 5 caracteres): un "371" suelto es cualquier número.
 */
export function placaEnTexto(placa: string | null | undefined, textos: (string | null | undefined)[]): boolean {
  const p = soloAlnum(placa ?? "");
  if (p.length < 5 || !/[A-Z]/.test(p) || !/[0-9]/.test(p)) return false;
  return textos.some((t) => soloAlnum(String(t ?? "")).includes(p));
}

/**
 * Procedencia de la placa de una lectura. `asignadasAlRemitente` son los ids de las unidades
 * que el conductor remitente tiene en servicio ese día (vacío si el remitente no es un
 * conductor registrado o no tiene servicios).
 */
export function procedenciaPlaca(opts: {
  placa: string | null | undefined;
  unidadId: number | null | undefined;
  textos: (string | null | undefined)[];
  asignadasAlRemitente: number[];
}): ProcedenciaPlaca {
  if (placaEnTexto(opts.placa, opts.textos)) return "texto";
  if (opts.unidadId != null && opts.asignadasAlRemitente.includes(opts.unidadId)) return "asignacion";
  return "sin_respaldo";
}
