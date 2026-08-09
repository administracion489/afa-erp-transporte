"use client";

// Modal de ANULACIÓN de una lectura de odómetro ya registrada (típicamente una
// "aceptada" que estaba mal y contaminó el km vigente).
//
// No borra la fila: exige un motivo tipificado + el km correcto, guarda todo en
// `odometro_correcciones` (bitácora y a la vez dataset que la IA de visión recibe
// como ejemplos), deja la lectura en estado "anulada" con su foto como evidencia y
// recalcula el km vigente — ver lib/odometro.ts → anularLectura().
//
// Lo usan app/mantenimiento/_tabs/OdometroTab.tsx (flota propia) y
// app/tercerizadas/_components/OdometroTerceroModal.tsx (terceros).

import React, { useState } from "react";
import { supabase } from "@/lib/supabase";
import { anularLectura, MOTIVOS_ANULACION, type MotivoAnulacion } from "@/lib/odometro";

export type LecturaAnulable = {
  id: string; km: number; fecha: string; fuente: string; foto_url: string | null; estado: string;
};

export default function AnularLecturaOdometro({
  lectura, placa, onClose, onAnulada,
}: {
  lectura: LecturaAnulable;
  placa: string;
  onClose: () => void;
  onAnulada: (kmVigente: number | null) => void;
}) {
  const [motivo, setMotivo]   = useState<MotivoAnulacion | "">("");
  const [nota, setNota]       = useState("");
  const [kmOk, setKmOk]       = useState("");
  const [confirmar, setConfirmar] = useState(false);   // 2º paso: confirmación explícita
  const [guardando, setGuardando] = useState(false);

  // Carriles donde el número lo propuso una lectura automática. Debe coincidir con FUENTES_IA
  // de lib/odometro.ts (leccionesOdometro): es el mismo criterio que decide qué correcciones
  // se le enseñan a la IA, así que si aquí dijera otra cosa el aviso mentiría.
  const esIA = ["whatsapp_foto", "whatsapp_manual", "checklist", "servicio", "combustible"].includes(String(lectura.fuente));
  const kmFmt = Number(lectura.km).toLocaleString("es-PE");

  const motivoCfg = MOTIVOS_ANULACION.find(m => m.id === motivo) || null;
  // Espejo de MOTIVOS_NO_ENSENAN en lib/odometro.ts: todo lo que salió de un carril de IA
  // enseña, salvo los motivos que describen un acierto de la IA o un hecho del mundo.
  const ensenaEsteCaso = !!motivo && !["duplicada", "otra_unidad", "reinicio"].includes(motivo);
  const pideKm = !!motivoCfg?.corrige;                 // este motivo corrige el número
  const kmObligatorio = pideKm && motivo !== "otro";   // en "otro" el km es opcional
  const esReinicio = motivo === "reinicio";            // no anula: re-ancla el vigente a este km

  // Validación del km correcto ingresado.
  const kmNum = kmOk.trim() ? Number(kmOk) : null;
  const kmValido = kmNum != null && Number.isFinite(kmNum) && kmNum > 0;
  const kmIgual = kmValido && Math.round(kmNum!) === Number(lectura.km);
  const kmOkFmt = kmValido ? Number(Math.round(kmNum!)).toLocaleString("es-PE") : "";

  // Se puede continuar según el motivo:
  //  - no correctivo → basta el motivo (el km escrito, si quedó de otro motivo, se ignora).
  //  - correctivo obligatorio → km válido y distinto al mal leído.
  //  - correctivo opcional ("otro") → km vacío, o válido y distinto.
  const puedeSeguir = !!motivo && (
    !pideKm ? true
    : kmObligatorio ? (kmValido && !kmIgual)
    : (!kmOk.trim() || (kmValido && !kmIgual))
  );
  // Solo se registra lectura corregida si el motivo corrige y el km es válido y distinto.
  const vaACorregir = pideKm && kmValido && !kmIgual;

  const anular = async () => {
    if (!motivo || !puedeSeguir) return;
    setGuardando(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const r = await anularLectura(supabase, {
        lecturaId: lectura.id,
        motivo_tipo: motivo,
        nota: nota.trim() || null,
        // el km solo aplica a motivos correctivos (evita arrastrar un valor tecleado
        // antes de cambiar a un motivo que no corrige el número)
        km_correcto: pideKm && kmOk.trim() ? Number(kmOk) : null,
        usuario: sess?.session?.user?.email || null,
        placa,
      });
      if (!r.ok) throw new Error(r.error || "No se pudo anular");
      onAnulada(r.kmVigente ?? null);
      onClose();
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b">
          <h3 className="font-bold text-gray-900">¿Qué pasó con esta lectura?</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            <span className="font-mono font-bold">{placa}</span> · <span className="font-mono">{kmFmt} km</span> · {lectura.fecha}
            {" — "}corrige el número (y enseña a la IA) o descártala con un motivo.
          </p>
        </div>

        <div className="p-6 space-y-4">
          {lectura.foto_url && (
            <a href={lectura.foto_url} target="_blank" rel="noreferrer" className="block">
              <img src={lectura.foto_url} alt="Tablero" className="w-full max-h-48 object-contain rounded-xl border bg-gray-50" />
            </a>
          )}

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">¿Cuál fue el error? *</label>
            <div className="flex flex-wrap gap-1.5">
              {MOTIVOS_ANULACION.map(m => (
                <button key={m.id} type="button" onClick={() => setMotivo(m.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${
                    motivo === m.id ? "text-white border-transparent" : "text-gray-600 border-gray-200 hover:bg-gray-50"}`}
                  style={motivo === m.id ? { background: "#0b315f" } : undefined}>
                  {m.label}
                </button>
              ))}
            </div>
            {/* Qué se le enseña a la IA y qué no. Antes solo se confirmaba el caso bueno y se
                callaba el malo: el operador reformulaba la corrección creyendo que enseñaba y
                se archivaba en silencio. Ahora el aviso dice siempre en qué caso está. */}
            {motivo && esIA && ensenaEsteCaso && (
              <p className="text-[11px] text-green-700 mt-1.5">
                🤖 Esto se le enseña a la IA: {nota.trim()
                  ? "tu explicación se usará en las próximas lecturas de esta placa."
                  : "escribe abajo DÓNDE está el odómetro en este tablero y lo aplicará la próxima vez."}
              </p>
            )}
            {motivo && esIA && !ensenaEsteCaso && (
              <p className="text-[11px] text-amber-700 mt-1.5">
                Este motivo no le enseña nada a la IA (describe un problema de flujo, no una lectura mal hecha).
                Si el número lo leyó mal, elige otro motivo y explica en el detalle dónde está el odómetro.
              </p>
            )}
            {motivo && !esIA && (
              <p className="text-[11px] text-gray-500 mt-1.5">Esta lectura no la propuso la IA, así que no se usa como ejemplo.</p>
            )}
          </div>

          {/* KM CORRECTO — prominente cuando el motivo corrige el número */}
          {pideKm && (
            <div className="rounded-xl border-2 border-[#0b315f]/15 bg-[#0b315f]/[0.03] p-4">
              <label className="block text-xs font-bold text-[#0b315f] mb-1.5">
                ¿Cuál es la lectura correcta? {kmObligatorio ? <span className="text-red-500">*</span> : <span className="text-gray-400 font-normal">(opcional)</span>}
              </label>
              <div className="flex items-center gap-2">
                <input type="number" inputMode="numeric" autoFocus value={kmOk}
                  onChange={e => setKmOk(e.target.value)} placeholder={`Se leyó ${kmFmt}`}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-base font-mono focus:outline-none focus:ring-2 focus:ring-[#0b315f]/30 focus:border-[#0b315f]" />
                <span className="text-sm font-bold text-gray-400">km</span>
              </div>
              {kmOk.trim() && !kmValido && <p className="text-[11px] text-red-600 mt-1.5">Ingresa un kilometraje válido (número entero mayor a 0).</p>}
              {kmIgual && <p className="text-[11px] text-amber-700 mt-1.5">Es el mismo número que ya estaba: no habría nada que corregir.</p>}
              {vaACorregir && (
                <p className="text-[11px] text-green-700 mt-1.5">
                  ✓ Se registrará <b className="font-mono">{kmOkFmt} km</b> como lectura corregida{lectura.foto_url ? ", con esta misma foto" : ""}. El km vigente se recalcula con ese valor.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Detalle (opcional)</label>
            <input value={nota} onChange={e => setNota(e.target.value)} placeholder="Ej: el odómetro está debajo del texto km, antes del ícono de combustible"
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20" />
          </div>

          {esReinicio && (
            <p className="text-[11px] text-blue-700 bg-blue-50 rounded-xl p-3">
              Se marcará esta lectura como el <b>nuevo tablero</b> y el km vigente se re-anclará a
              <b className="font-mono"> {kmFmt} km</b> (no se pierde: queda como reinicio).
            </p>
          )}
          {!pideKm && !esReinicio && lectura.estado === "aceptada" && (
            <p className="text-[11px] text-gray-500 bg-gray-50 rounded-xl p-3">
              La lectura no se borra: queda como <b>anulada</b> con su foto. El km vigente se recalcula
              con las lecturas que quedan.
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-bold text-gray-500 hover:bg-gray-100">Cancelar</button>
          {!confirmar ? (
            <button onClick={() => setConfirmar(true)} disabled={!puedeSeguir}
              className={`px-5 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-40 hover:opacity-90 ${esReinicio ? "bg-blue-600" : "bg-red-600"}`}>
              {esReinicio ? "Marcar reinicio" : vaACorregir ? "Corregir lectura" : "Anular lectura"}
            </button>
          ) : (
            <button onClick={anular} disabled={guardando || !puedeSeguir}
              className={`px-5 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-60 hover:opacity-90 ${esReinicio ? "bg-blue-600" : "bg-red-600"}`}>
              {guardando ? "Guardando…" : esReinicio ? `Confirmar: reinicio a ${kmFmt} km` : vaACorregir ? `Confirmar: corregir a ${kmOkFmt} km` : `Confirmar: anular ${kmFmt} km`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
