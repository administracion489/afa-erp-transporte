// lib/radar/config.ts — Config del Radar IA: defaults + normalización COMPARTIDA.
//
// Módulo PURO y client-safe (sin dependencias de servidor): lo importan tanto el
// pipeline del motor (lib/radar/motor.ts, servidor) como el dashboard
// (app/radar-ia/page.tsx, "use client"). Tener UNA sola normalización evita que la UI
// y el backend interpreten distinto la MISMA fila de radar_config — ese desfase hacía
// que el toggle "Odómetro automático" se viera APAGADO en la UI mientras el motor lo
// trataba como ENCENDIDO (la UI leía la fila cruda; el motor le aplicaba defaults).

import type { RadarConfig } from "./tipos";
import { LISTA_CATEGORIAS } from "./tipos";

// Defaults seguros (si la tabla aún no existe, está vacía, o a una fila le faltan claves).
export const CONFIG_DEFECTO: RadarConfig = {
  id: 1,
  activo: true,
  horario_activo: false,
  hora_inicio: "06:00",
  hora_fin: "22:00",
  categorias_activas: LISTA_CATEGORIAS.filter((c) => c !== "otros"),
  acciones_automaticas: { combustible: true, odometro: true, mantenimiento: false, operaciones: false },
  palabras_clave: [],
  umbral_confianza: 0.7,
  modelo_triage: "claude-haiku-4-5",
  modelo_extraccion: "claude-sonnet-5",
  notificar_email: false,
  correos_alerta: null,
  limite_diario_usd: 5,
  guia_voucher: null,
  updated_at: "",
};

/**
 * Normaliza una fila cruda de radar_config a un RadarConfig completo, aplicando los
 * MISMOS defaults en todos los consumidores (motor + UI). Debe ser la única forma de
 * interpretar la fila: así lo que ve el operador == lo que ejecuta el motor.
 *
 * - `data` nulo/ inválido → CONFIG_DEFECTO (instalación nueva).
 * - Auto-migración de configs guardadas ANTES de que existiera la acción "odometro":
 *   la PRESENCIA de la clave "odometro" en acciones_automaticas marca que la config ya
 *   "conoce" la categoría; si falta, es una config vieja → se activa odometro por
 *   defecto (paridad con una instalación nueva) tanto en la categoría como en la acción.
 * - `acciones_automaticas` queda SIEMPRE con las 4 claves explícitas, de modo que un
 *   guardado posterior fija la preferencia en la BD y el desfase no puede reaparecer.
 */
export function normalizarConfigRadar(data: any): RadarConfig {
  if (!data || typeof data !== "object") return { ...CONFIG_DEFECTO };

  const accionesGuardadas =
    data.acciones_automaticas && typeof data.acciones_automaticas === "object" ? data.acciones_automaticas : {};
  const configConoceOdometro = "odometro" in accionesGuardadas;

  let categorias = Array.isArray(data.categorias_activas) ? data.categorias_activas : CONFIG_DEFECTO.categorias_activas;
  if (!configConoceOdometro && !categorias.includes("odometro")) {
    categorias = [...categorias, "odometro"];
  }

  return {
    ...CONFIG_DEFECTO,
    ...data,
    categorias_activas: categorias,
    // Fusión por clave (no reemplazo del objeto entero): una config vieja hereda los
    // defaults de las claves que le falten (odometro:true incluido); una que ya fijó su
    // preferencia la conserva. Las 4 claves quedan explícitas.
    acciones_automaticas: { ...CONFIG_DEFECTO.acciones_automaticas, ...accionesGuardadas },
    palabras_clave: Array.isArray(data.palabras_clave) ? data.palabras_clave : [],
  };
}
