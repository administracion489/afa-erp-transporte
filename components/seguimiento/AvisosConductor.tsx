"use client";
// components/seguimiento/AvisosConductor.tsx — «¿Le llegaron los avisos al conductor?»,
// contestado en la ficha del servicio de /seguimiento.
//
// Lee el registro (`notificaciones_enviadas`, con el estado de entrega que escribe el webhook
// de Meta) y los reclamos del motor (`alerta_enviada`). La lectura de cada fila —leído,
// entregado, sin confirmar, falló— la decide `estadoEntrega` (lib/escalera-inicio.ts), no
// esta pantalla: el resumen que recibe el coordinador por WhatsApp sale de la MISMA función.
//
// Dos honestidades que no se aflojan:
//   · «Entregado» sin «leído» NO es «lo ignoró»: la confirmación de lectura se apaga en
//     WhatsApp. Se dice «sin confirmación de lectura».
//   · Un aviso que el motor procesó antes de que existiera este registro (salían sin reserva)
//     se ENSEÑA como «procesado, sin detalle», no se calla: callarlo diría «no se le avisó».

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  estadoEntrega, etiquetaAviso, horaLimaDeIso, reclamosSinDetalle, resumenAvisosConductor,
  type FilaAviso, type Reclamo,
} from "@/lib/escalera-inicio";
import { lecturaLlamada, type CodigoLectura, type FilaLlamada } from "@/lib/llamadas-central";

const ETIQUETA_TRIGGER: Record<string, string> = {
  asignacion: "Servicio asignado",
  cambio: "Cambio de servicio",
  cron_recordatorio: "Recordatorio",
  proximidad_llego: "Llegada a paradero",
  manual: "Aviso",
};
const CANAL: Record<string, string> = { whatsapp: "WhatsApp", push: "App", email: "Correo", sms: "SMS" };
const TONO: Record<string, string> = {
  leido: "text-emerald-700",
  entregado: "text-[#0b315f]",
  enviado: "text-gray-500",
  fallo: "text-red-600",
  error: "text-red-600",
  sin_canal: "text-amber-700",
};

type Fila = FilaAviso & { id?: number; trigger_origen?: string | null; destinatario?: string | null };
type Llamada = FilaLlamada & { id?: number };

/** El tono de cada lectura de la llamada: lo mismo que se dice, en color. */
const TONO_LLAMADA: Partial<Record<CodigoLectura, string>> = {
  contestada: "text-emerald-700",
  no_contesto: "text-amber-700",
  ocupado: "text-amber-700",
  fallida: "text-red-600",
  vencida: "text-red-600",
  cancelada: "text-gray-500",
  pendiente: "text-gray-500",
  marcando: "text-[#0b315f]",
};

export default function AvisosConductor({ reservaId }: { reservaId: number }) {
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [reclamos, setReclamos] = useState<Reclamo[]>([]);
  // Las llamadas de la central propia (supabase/llamadas-01-central.sql). Sin la tabla, ninguna.
  const [llamadas, setLlamadas] = useState<Llamada[]>([]);
  const [fallo, setFallo] = useState(false);
  // El instante de la lectura: «ningún WhatsApp le llegó» se juzga contra él (render puro).
  const [leidoEn, setLeidoEn] = useState(0);

  useEffect(() => {
    let vivo = true;
    (async () => {
      // `*`: las columnas de entrega son de una migración accesoria
      // (supabase/alertas-escalera-inicio.sql); pedirlas por nombre tumbaría la consulta sin ella.
      const [n, a, l] = await Promise.all([
        supabase.from("notificaciones_enviadas").select("*")
          .eq("reserva_id", reservaId).not("conductor_id", "is", null)
          .order("created_at", { ascending: true }).limit(200),
        supabase.from("alerta_enviada").select("clave, created_at").eq("ref", String(reservaId)),
        supabase.from("llamadas_conductor")
          .select("id, estado, intentos, created_at, tomada_en, terminada_en, proximo_intento_en, duracion_seg, opcion, detalle, motivo")
          .eq("reserva_id", reservaId).order("created_at", { ascending: true }).limit(20),
      ]);
      if (!vivo) return;
      if (n.error) { setFallo(true); setFilas([]); return; }
      setLeidoEn(Date.now());
      setFilas((n.data ?? []) as Fila[]);
      setReclamos(a.error ? [] : ((a.data ?? []) as Reclamo[]));
      setLlamadas(l.error ? [] : ((l.data ?? []) as Llamada[]));
    })().catch(() => { if (vivo) { setFallo(true); setFilas([]); } });
    return () => { vivo = false; };
  }, [reservaId]);

  if (filas === null) return <p className="text-xs text-gray-400 px-1">Buscando avisos…</p>;
  if (fallo) return <p className="text-xs text-red-600 px-1">No se pudieron leer los avisos de este servicio.</p>;

  const viejos = reclamosSinDetalle(reclamos, filas);
  const resumen = resumenAvisosConductor(filas, leidoEn);
  const items = [
    ...filas.map((f) => ({ tipo: "fila" as const, t: String(f.created_at ?? ""), f })),
    ...viejos.map((r) => ({ tipo: "reclamo" as const, t: String(r.created_at ?? ""), r })),
    ...llamadas.map((l) => ({ tipo: "llamada" as const, t: String(l.created_at ?? ""), l })),
  ].sort((x, y) => x.t.localeCompare(y.t));

  if (items.length === 0) {
    return <p className="text-xs text-gray-500 px-1">No hay avisos registrados al conductor para este servicio.</p>;
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-3">
      {resumen.sinEntregar && (
        <p className="mb-2 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
          Ningún WhatsApp de inicio le llegó: el teléfono no tenía datos o estaba apagado. Lo que sirve es llamarlo.
        </p>
      )}
      <ul className="space-y-1.5">
        {items.map((it, i) => {
          if (it.tipo === "llamada") {
            const lec = lecturaLlamada(it.l);
            return (
              <li key={`l${it.l.id ?? i}`} className="flex items-start gap-2 text-xs">
                <span className="w-11 flex-shrink-0 font-mono text-gray-400">{horaLimaDeIso(it.l.created_at) ?? "—"}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-gray-700">{it.l.motivo === "prueba" ? "Llamada de prueba" : "Llamada de la central"}</span>
                  <span className="ml-1.5 inline-block rounded-full bg-gray-100 px-1.5 py-px text-[10px] font-semibold text-gray-500">Llamada</span>
                  <span className={`block ${TONO_LLAMADA[lec.codigo] ?? "text-gray-500"}`}>{lec.texto}</span>
                </span>
              </li>
            );
          }
          if (it.tipo === "reclamo") {
            return (
              <li key={`r${i}`} className="flex items-start gap-2 text-xs">
                <span className="w-11 flex-shrink-0 font-mono text-gray-400">{horaLimaDeIso(it.r.created_at) ?? "—"}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-gray-700">{etiquetaAviso(it.r.clave)}</span>
                  <span className="block text-gray-400">Procesado por el sistema, sin detalle de canal ni de entrega (anterior al registro de avisos).</span>
                </span>
              </li>
            );
          }
          const f = it.f;
          const e = estadoEntrega(f);
          const titulo = f.alerta_clave ? etiquetaAviso(f.alerta_clave) : (ETIQUETA_TRIGGER[String(f.trigger_origen)] ?? "Aviso");
          return (
            <li key={`f${f.id ?? i}`} className="flex items-start gap-2 text-xs">
              <span className="w-11 flex-shrink-0 font-mono text-gray-400">{horaLimaDeIso(f.created_at) ?? "—"}</span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-gray-700">{titulo}</span>
                <span className="ml-1.5 inline-block rounded-full bg-gray-100 px-1.5 py-px text-[10px] font-semibold text-gray-500">
                  {CANAL[String(f.tipo)] ?? f.tipo}
                </span>
                <span className={`block ${TONO[e.codigo] ?? "text-gray-500"}`}>{e.texto}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {filas.length > 0 && !filas.some((f) => "entregado_en" in f) && filas.some((f) => f.tipo === "whatsapp") && (
        <p className="mt-2 text-[11px] text-gray-400">
          Para ver «entregado / leído» falta correr supabase/alertas-escalera-inicio.sql.
        </p>
      )}
    </div>
  );
}
