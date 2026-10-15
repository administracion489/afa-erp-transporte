"use client";
// Respuestas rápidas («/tarifa», «/requisitos»…), como Chatwoot o Wati. Se escriben con «/»
// al inicio del mensaje; {nombre} se reemplaza por el primer nombre del cliente.
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export type Rapida = { id: string; atajo: string; texto: string };

export function useRespuestasRapidas() {
  const [lista, setLista] = useState<Rapida[]>([]);
  const [falta, setFalta] = useState(false);
  const cargar = async () => {
    const { data, error } = await supabase.from("crm_respuestas_rapidas").select("id, atajo, texto").order("atajo");
    if (error) { setFalta(true); return; }
    setFalta(false); setLista((data ?? []) as Rapida[]);
  };
  useEffect(() => { cargar(); }, []);
  return { lista, falta, recargar: cargar };
}

export function aplicarVariables(texto: string, nombre?: string | null) {
  const primero = (nombre ?? "").trim().split(/\s+/)[0] || "";
  return texto.replace(/\{nombre\}/gi, primero);
}

/** Sugerencias mientras se escribe «/algo». */
export function SugerenciasRapidas({ reply, lista, onElegir }: { reply: string; lista: Rapida[]; onElegir: (r: Rapida) => void }) {
  if (!reply.startsWith("/") || reply.includes("\n")) return null;
  const q = reply.slice(1).toLowerCase();
  const hits = lista.filter((r) => r.atajo.toLowerCase().includes(q) || r.texto.toLowerCase().includes(q)).slice(0, 8);
  if (!hits.length) return <div className="text-xs text-gray-400 px-2 py-1">Sin respuestas rápidas para «/{q}». Créalas con ⚡.</div>;
  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm mb-2 max-h-56 overflow-y-auto">
      {hits.map((r) => (
        <button key={r.id} onClick={() => onElegir(r)} className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-50 last:border-0">
          <span className="text-xs font-semibold text-[#0b315f]">/{r.atajo}</span>
          <span className="text-xs text-gray-500 ml-2 truncate">{r.texto.slice(0, 90)}</span>
        </button>
      ))}
    </div>
  );
}

export function ModalRespuestasRapidas({ lista, falta, onClose, onCambio }: { lista: Rapida[]; falta: boolean; onClose: () => void; onCambio: () => void }) {
  const [atajo, setAtajo] = useState("");
  const [texto, setTexto] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const guardar = async () => {
    const a = atajo.trim().replace(/^\//, "").toLowerCase().replace(/\s+/g, "-");
    if (!a || !texto.trim()) { setMsg("Escribe el atajo y el texto."); return; }
    const { error } = await supabase.from("crm_respuestas_rapidas").upsert({ atajo: a, texto: texto.trim() }, { onConflict: "atajo" });
    if (error) { setMsg(`No se guardó: ${error.message}`); return; }
    setAtajo(""); setTexto(""); setMsg(`Guardada /${a}`); onCambio();
  };
  const borrar = async (r: Rapida) => {
    if (!confirm(`¿Borrar /${r.atajo}?`)) return;
    await supabase.from("crm_respuestas_rapidas").delete().eq("id", r.id);
    onCambio();
  };
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg p-5 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-[#0b315f]">⚡ Respuestas rápidas</h3>
          <button onClick={onClose} className="text-gray-400 text-xl">×</button>
        </div>
        {falta ? (
          <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-2">
            Falta correr <b>supabase/crm-respuestas-rapidas.sql</b> en Supabase.
          </div>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-3">En el chat escribe <b>/</b> y el atajo. <b>{"{nombre}"}</b> se cambia por el nombre del cliente.</p>
            <div className="space-y-2 mb-4">
              <input value={atajo} onChange={(e) => setAtajo(e.target.value)} placeholder="Atajo (ej. tarifa)" className="w-full border rounded-xl px-3 py-2 text-sm" />
              <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} placeholder="Hola {nombre}, nuestras tarifas…" className="w-full border rounded-xl px-3 py-2 text-sm" />
              <button onClick={guardar} className="bg-[#0b315f] text-white text-sm font-semibold px-4 py-2 rounded-xl">Guardar</button>
              {msg && <span className="text-xs text-gray-500 ml-2">{msg}</span>}
            </div>
            <div className="divide-y">
              {lista.length === 0 && <div className="text-sm text-gray-400 py-2">Aún no hay respuestas rápidas.</div>}
              {lista.map((r) => (
                <div key={r.id} className="py-2 flex gap-2 items-start">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-[#0b315f]">/{r.atajo}</div>
                    <div className="text-xs text-gray-600 whitespace-pre-wrap">{r.texto}</div>
                  </div>
                  <button onClick={() => { setAtajo(r.atajo); setTexto(r.texto); }} className="text-xs text-gray-500">Editar</button>
                  <button onClick={() => borrar(r)} className="text-xs text-red-500">Borrar</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
