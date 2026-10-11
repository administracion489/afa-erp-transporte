// lib/entrega-whatsapp.ts — Los estados «entregado / leído / falló» que Meta manda al webhook
// por cada WhatsApp que sale del número de AVISOS, casados con la fila del registro
// (`notificaciones_enviadas.wamid`). Hasta este cambio el webhook los DESCARTABA: el ERP
// sabía que un aviso «salió» pero nunca si llegó al teléfono, y a la pregunta «¿le llegó el
// aviso al conductor?» no había respuesta posible.
//
// `estadosAOperaciones` es PURO (lo prueba scripts/prueba-escalera-inicio.mts); el que
// escribe recibe el cliente de Supabase inyectado.
//
// Tres reglas:
//   · SOLO AVANZA: cada columna se escribe una vez (`is null`). Meta reintenta y entrega los
//     estados sin orden garantizado; un «delivered» que llega después del «read» no puede
//     pisar nada.
//   · «LEÍDO» IMPLICA «ENTREGADO»: si el «delivered» se perdió, el «read» lo rellena.
//   · No es lectura obligatoria: quien tiene las confirmaciones de lectura apagadas nunca
//     manda «read». Por eso la pantalla dice «sin confirmación de lectura», no «no lo leyó».

import type { SupabaseClient } from "@supabase/supabase-js";
import { faltaAlguna } from "@/lib/columna-faltante";

export type EstadoMeta = {
  id?: string | null;
  status?: string | null;
  timestamp?: string | number | null;
  errors?: { code?: number | string | null; title?: string | null; message?: string | null; error_data?: { details?: string | null } | null }[] | null;
};

export type OperacionEntrega = {
  wamid: string;
  /** Columna a escribir. */
  campo: "entregado_en" | "leido_en" | "fallo_entrega";
  valor: string;
  /** true = solo si la columna sigue vacía (las dos fechas). */
  soloSiVacio: boolean;
};

function isoDe(ts: EstadoMeta["timestamp"], ahoraMs: number): string {
  const n = Number(ts);
  const ms = Number.isFinite(n) && n > 0 ? n * 1000 : ahoraMs;
  return new Date(ms).toISOString();
}

function motivoFallo(e: EstadoMeta): string {
  const err = e.errors?.[0];
  if (!err) return "Meta no pudo entregarlo";
  const partes = [err.code != null ? String(err.code) : "", err.title || err.message || "", err.error_data?.details || ""]
    .map((x) => String(x).trim()).filter(Boolean);
  // Sin duplicar título y detalle cuando Meta los repite.
  const unicos = partes.filter((p, i) => partes.indexOf(p) === i);
  return unicos.join(" · ").slice(0, 300) || "Meta no pudo entregarlo";
}

/** Estados de Meta → escrituras. Por mensaje y columna se queda la fecha MÁS TEMPRANA. */
export function estadosAOperaciones(estados: EstadoMeta[], ahoraMs = Date.now()): OperacionEntrega[] {
  const porClave = new Map<string, OperacionEntrega>();
  const poner = (op: OperacionEntrega) => {
    const k = `${op.wamid}|${op.campo}`;
    const prev = porClave.get(k);
    if (!prev || (op.soloSiVacio && op.valor < prev.valor)) porClave.set(k, op);
  };
  for (const e of estados ?? []) {
    const wamid = String(e?.id ?? "").trim();
    if (!wamid) continue;
    const st = String(e.status ?? "").toLowerCase();
    if (st === "delivered") {
      poner({ wamid, campo: "entregado_en", valor: isoDe(e.timestamp, ahoraMs), soloSiVacio: true });
    } else if (st === "read") {
      const iso = isoDe(e.timestamp, ahoraMs);
      poner({ wamid, campo: "leido_en", valor: iso, soloSiVacio: true });
      poner({ wamid, campo: "entregado_en", valor: iso, soloSiVacio: true });
    } else if (st === "failed") {
      poner({ wamid, campo: "fallo_entrega", valor: motivoFallo(e), soloSiVacio: false });
    }
    // "sent" (aceptado por Meta) no agrega nada: el registro ya dice "enviado".
  }
  return [...porClave.values()];
}

let avisadoSinMigracion = false;

/**
 * Aplica los estados al registro. Nunca lanza: un estado que no se pudo escribir no puede
 * tumbar el webhook (Meta lo reintentaría y duplicaría los mensajes entrantes del lote).
 */
export async function registrarEstadosEntrega(sb: SupabaseClient, estados: EstadoMeta[]): Promise<number> {
  const ops = estadosAOperaciones(estados);
  let escritas = 0;
  for (const op of ops) {
    try {
      let q = sb.from("notificaciones_enviadas").update({ [op.campo]: op.valor }).eq("wamid", op.wamid);
      if (op.soloSiVacio) q = q.is(op.campo, null);
      const { error } = await q;
      if (error) {
        // Sin la migración (alertas-escalera-inicio.sql) la columna no existe: se avisa una
        // vez por instancia y se deja de intentar en este lote.
        if (faltaAlguna(error, ["wamid", "entregado_en", "leido_en", "fallo_entrega"])) {
          if (!avisadoSinMigracion) {
            console.warn("[entrega-whatsapp] falta supabase/alertas-escalera-inicio.sql:", error.message);
            avisadoSinMigracion = true;
          }
          return escritas;
        }
        console.warn("[entrega-whatsapp] no se pudo registrar el estado:", error.message);
        continue;
      }
      escritas++;
    } catch (e) {
      console.warn("[entrega-whatsapp]", e instanceof Error ? e.message : e);
    }
  }
  return escritas;
}
