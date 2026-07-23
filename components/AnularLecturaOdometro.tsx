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

  const esIA = lectura.fuente === "whatsapp_foto";
  const kmFmt = Number(lectura.km).toLocaleString("es-PE");

  const motivoCfg = MOTIVOS_ANULACION.find(m => m.id === motivo) || null;
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
            {motivo && motivoCfg?.ensena && (
              <p className="text-[11px] text-green-700 mt-1.5">
                🤖 Este caso se le enseña a la IA: la próxima lectura por foto verá este error como ejemplo.
              </p>
            )}
            {motivo && !esIA && motivoCfg?.ensena && (
              <p className="text-[11px] text-amber-700 mt-1">Ojo: esta lectura no vino de foto con IA.</p>
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
            <input value={nota} onChange={e => setNota(e.target.value)} placeholder="Ej: confundió el 3 con un 8"
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
