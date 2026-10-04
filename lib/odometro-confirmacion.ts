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
