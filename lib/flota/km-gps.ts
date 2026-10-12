// ──────────────────────────────────────────────────────────────────────────────
// lib/flota/km-gps.ts — Motor PURO: ¿el km que mide el GPS de un servicio se puede PUBLICAR, y cómo?
//
// El km por GPS de un servicio sale de su huella (`resumenDeFilas`, lib/huella.ts: la misma tubería
// de la Auditoría de km). Pero un número así solo vale lo que vale el rastreo que lo midió, y el ERP
// YA tiene ese juicio: el veredicto de la columna RASTREO (lib/gps-cobertura.ts). Aquí NO se inventa
// ningún umbral nuevo: el km se publica SOLO según ese veredicto.
//
//   completo, aceptable                      → `medido`        se publica
//   con_cortes                               → `piso`          se publica como «≥ N km»
//   incompleto                               → `insuficiente`  no
//   sin_senal, solo_antena, gps_inmovil      → `sin_gps`       no
//   en curso (senal_perdida, recien_iniciado
//             o cualquier veredicto en ruta) → `en_curso`      no (el km se publica al terminar)
//   sin_medir                                → `sin_medir`     no (un fallo de lectura no es un 0)
//   no_aplica                                → `no_aplica`     no
//   hay posiciones simuladas                 → `simulado`      no (antifraude)
//   rastreo bueno y ningún desplazamiento    → `sin_desplazamiento` no (no se publica un 0 km)
//
// POR QUÉ `con_cortes` ES UN PISO Y NO UN NÚMERO: `resumenViaje` corta los saltos de más de
// MAX_SEG_M como huecos y NO los cuenta, así que un GPS con cortes solo puede quedarse CORTO, nunca
// pasarse. Publicarlo como «≥ N km» es decir exactamente lo que se sabe. Y por eso todo lo que se
// derive de él (combustible, costo, CO₂) hereda `piso: true`.
//
// EL ORDEN VA DE LA EVIDENCIA AL JUICIO, y gana el primero que aplique: primero lo que impide leer
// nada (no salió, no se pudo leer), después lo que invalida lo leído (simulado), después lo que
// todavía no terminó (en curso), y recién al final la calidad del rastreo.
//
// Invariantes que fija scripts/prueba-km-gps.mts por barrido:
//   · `km != null ⟺ codigo ∈ {medido, piso}`
//   · `piso ⟺ codigo === "piso"`, y `piso ⟹ veredicto con_cortes`
//   · corolario: un servicio terminado con rastreo completo y desplazamiento publica su km.
// ──────────────────────────────────────────────────────────────────────────────

import type { VeredictoRastreo } from "../gps-cobertura";
import type { ResumenViaje } from "../huella";

export type CodigoKmGps =
  | "medido" | "piso" | "insuficiente" | "sin_gps" | "simulado"
  | "sin_desplazamiento" | "en_curso" | "sin_medir" | "no_aplica";

export const CODIGOS_KM_GPS: readonly CodigoKmGps[] = [
  "medido", "piso", "insuficiente", "sin_gps", "simulado", "sin_desplazamiento", "en_curso", "sin_medir", "no_aplica",
];

/** Qué códigos llevan un km publicado. Pegado a los códigos, no deducido en la pantalla. */
export const KM_GPS_PUBLICA: Record<CodigoKmGps, boolean> = {
  medido: true, piso: true,
  insuficiente: false, sin_gps: false, simulado: false, sin_desplazamiento: false,
  en_curso: false, sin_medir: false, no_aplica: false,
};

export type KmGps = {
  codigo: CodigoKmGps;
  /** km publicable; null en todo código que no publica. */
  km: number | null;
  /** el km es un MÍNIMO (rastreo con cortes): se enseña como «≥ N km». */
  piso: boolean;
  /** % del servicio con GPS (el del veredicto RASTREO), o null si no se midió. */
  coberturaPct: number | null;
  /** frase completa, con los números de ESTE servicio */
  detalle: string;
};

/** Rótulo corto de cada código (chips, columnas estrechas). */
export function textoKmGps(codigo: CodigoKmGps): string {
  switch (codigo) {
    case "medido": return "Medido por GPS";
    case "piso": return "Mínimo (GPS con cortes)";
    case "insuficiente": return "Rastreo insuficiente";
    case "sin_gps": return "Sin GPS útil";
    case "simulado": return "GPS simulado";
    case "sin_desplazamiento": return "Sin desplazamiento";
    case "en_curso": return "En curso";
    case "sin_medir": return "No se pudo medir";
    case "no_aplica": return "No salió";
  }
}

/** «12.3 km», «≥ 12.3 km» o «—». Una sola forma de escribir el km para todas las pantallas. */
export function textoKm(k: KmGps): string {
  if (k.km == null) return "—";
  const n = k.km.toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${k.piso ? "≥ " : ""}${n} km`;
}

/**
 * El km del GPS de un servicio, juzgado por su veredicto de RASTREO.
 * `r` es el resumen de su huella (`resumenDeFilas`), null si no hubo huella con que medir;
 * `simulados` es `traza.simulados` (posiciones marcadas por el antifraude).
 */
export function kmPublicable(v: VeredictoRastreo, r: ResumenViaje | null, simulados: number): KmGps {
  const pct = v.pct ?? null;
  const nSim = Number.isFinite(simulados) && simulados > 0 ? simulados : 0;
  const no = (codigo: CodigoKmGps, detalle: string): KmGps => ({ codigo, km: null, piso: false, coberturaPct: pct, detalle });

  // 1. Lo que impide leer nada.
  if (v.codigo === "no_aplica") return no("no_aplica", "El servicio no salió: no hay km que medir.");
  if (v.codigo === "sin_medir") return no("sin_medir", "No se pudo leer el GPS de este servicio: no se afirma ningún km.");
  // 2. Lo que invalida lo leído.
  if (nSim > 0) return no("simulado", `${nSim} posición(es) llegaron marcadas como GPS simulado: el km de esa huella no se publica.`);
  // 3. Lo que todavía no terminó.
  if (v.enCurso || v.codigo === "senal_perdida" || v.codigo === "recien_iniciado") {
    return no("en_curso", "El servicio está en curso: el km se publica cuando termine.");
  }
  // 4. La calidad del rastreo.
  switch (v.codigo) {
    case "sin_senal":
    case "solo_antena":
    case "gps_inmovil":
      return no("sin_gps", `Sin GPS útil (${v.celda}): no hay km que publicar. ${v.detalle}`);
    case "incompleto":
      return no("insuficiente", `El GPS cubrió solo el ${pct ?? 0} % del servicio: su km no describe el recorrido y no se publica.`);
    case "completo":
    case "aceptable":
    case "con_cortes": {
      const km = r && Number.isFinite(r.kmRecorridos) && r.kmRecorridos > 0 ? r.kmRecorridos : null;
      if (km == null) return no("sin_desplazamiento", "El rastreo del servicio no registró desplazamiento: no se publica un km de 0.");
      if (v.codigo === "con_cortes") {
        return {
          codigo: "piso", km, piso: true, coberturaPct: pct,
          detalle: `Al menos ${km} km: el GPS tuvo cortes (${pct ?? "?"} % del servicio con señal) y en un corte solo puede quedarse corto.`,
        };
      }
      return { codigo: "medido", km, piso: false, coberturaPct: pct, detalle: `${km} km medidos por GPS (${pct ?? "?"} % del servicio con señal).` };
    }
    default: {
      // Un código de rastreo nuevo que este módulo no conoce: no se afirma nada.
      const _nunca: never = v.codigo;
      void _nunca;
      return no("sin_medir", "No se pudo juzgar el GPS de este servicio: no se afirma ningún km.");
    }
  }
}
