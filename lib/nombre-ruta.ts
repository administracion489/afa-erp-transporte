/**
 * Sugerencia del nombre de ruta que verá el PASAJERO al elegir su bus
 * (`reservas.ruta_nombre`, leído en app/pasajero/page.tsx).
 *
 * Se construye con el formato que ya usa la operación:
 *
 *   RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA
 *   RUTA B/ RETORNO 17:00/ BSF PUNTA HERMOSA→CHILCA
 *
 * La letra ("RUTA B") NO es derivable de las paradas ni de la hora: no existe
 * como campo. Se rescata del `asunto` de la cotización cuando ahí aparece; si
 * no, el nombre sale sin letra y el operador la completa en el campo editable
 * del modal de generación. Nunca se inventa.
 */

export type SentidoRuta = "ida" | "retorno";

type ParadaLike = { tipo?: string | null; nombre?: string | null; hora?: string | null };

/** "Cot. RUTA B - personal" → "RUTA B". null si el asunto no nombra una ruta. */
export function letraRuta(asunto: string | null | undefined): string | null {
  const m = /\bRUTA\s+([A-Z0-9]{1,3})\b/i.exec(asunto || "");
  return m ? `RUTA ${m[1].toUpperCase()}` : null;
}

/** "05:10:00" → "05:10". Vacío si no hay hora utilizable. */
function hhmm(hora: string | null | undefined): string {
  const s = String(hora || "").trim();
  return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5).padStart(5, "0") : "";
}

function extremo(paradas: ParadaLike[] | null | undefined, tipo: "inicio" | "destino"): string {
  const p = (paradas || []).find((x) => x?.tipo === tipo);
  return (p?.nombre || "").trim().toUpperCase();
}

export function sugerirNombreRuta(opts: {
  asunto?: string | null;
  paradas?: ParadaLike[] | null;
  hora?: string | null;
  sentido: SentidoRuta;
}): string {
  const origen  = extremo(opts.paradas, "inicio");
  const destino = extremo(opts.paradas, "destino");
  // Sin extremos no hay nada que nombrar: mejor vacío que "- → -" visible al pasajero.
  if (!origen && !destino) return "";

  const letra   = letraRuta(opts.asunto);
  const etiqueta = opts.sentido === "retorno" ? "RETORNO" : "ENTRADA";
  const hora    = hhmm(opts.hora);

  const tramo = `${origen || "-"}→${destino || "-"}`;
  return [
    letra ? `${letra}/` : null,
    hora ? `${etiqueta} ${hora}/` : `${etiqueta}/`,
    tramo,
  ].filter(Boolean).join(" ");
}
