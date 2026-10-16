"use client";
// Asignación («quién atiende este chat») y etiquetas de color, como Chatwoot / Kommo.
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export const ETIQUETAS: { clave: string; color: string; bg: string }[] = [
  { clave: "Cotización", color: "#1d4ed8", bg: "#dbeafe" },
  { clave: "Reserva", color: "#047857", bg: "#d1fae5" },
  { clave: "Reclamo", color: "#b91c1c", bg: "#fee2e2" },
  { clave: "Urgente", color: "#c2410c", bg: "#ffedd5" },
  // La pone la IA al derivar un chat (lib/crm-ia.ts, ETIQUETA_EJECUTIVO): mismo texto.
  { clave: "Para ejecutivo", color: "#a16207", bg: "#fef9c3" },
  { clave: "Colegio", color: "#7e22ce", bg: "#f3e8ff" },
  { clave: "Turismo", color: "#0e7490", bg: "#cffafe" },
  { clave: "Personal", color: "#4d7c0f", bg: "#ecfccb" },
  { clave: "Proveedor", color: "#57534e", bg: "#f5f5f4" },
];
export const estiloEtiqueta = (e: string) => ETIQUETAS.find((x) => x.clave === e) ?? { clave: e, color: "#374151", bg: "#f3f4f6" };

export function ChipEtiqueta({ e }: { e: string }) {
  const s = estiloEtiqueta(e);
  return <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ color: s.color, background: s.bg }}>{e}</span>;
}

export type Usuario = { id: string; nombre: string };
let cacheUsuarios: Promise<Usuario[]> | null = null;
export function useUsuarios() {
  const [u, setU] = useState<Usuario[]>([]);
  useEffect(() => {
    cacheUsuarios ??= (async () => {
      const { data } = await supabase.from("usuarios").select("id, nombre, activo");
      return ((data ?? []) as any[]).filter((x) => x.activo !== false).map((x) => ({ id: String(x.id), nombre: x.nombre ?? "Sin nombre" }));
    })();
    cacheUsuarios.then(setU);
  }, []);
  return u;
}

export function useYo() {
  const [yo, setYo] = useState<string | null>(null);
  useEffect(() => { supabase.auth.getUser().then(({ data }: any) => setYo(data.user?.id ?? null)); }, []);
  return yo;
}

export default function EquipoConversacion({
  conv, onCambio, aviso,
}: {
  conv: { id: string; asignado_a?: string | null; etiquetas?: string[] | null };
  onCambio: (patch: { asignado_a?: string | null; etiquetas?: string[] }) => void;
  aviso: (msg: string, ok?: boolean) => void;
}) {
  const usuarios = useUsuarios();
  const yo = useYo();
  const [abrirEtq, setAbrirEtq] = useState(false);
  const [nueva, setNueva] = useState("");
  const etiquetas = conv.etiquetas ?? [];

  const guardar = async (patch: { asignado_a?: string | null; etiquetas?: string[] }) => {
    const { error } = await supabase.from("crm_conversaciones").update(patch).eq("id", conv.id);
    if (error) {
      aviso(/asignado_a|etiquetas/.test(error.message) ? "Falta correr supabase/crm-inbox-equipo.sql" : `No se guardó: ${error.message}`, false);
      return;
    }
    onCambio(patch);
  };
  const alternar = (e: string) => guardar({ etiquetas: etiquetas.includes(e) ? etiquetas.filter((x) => x !== e) : [...etiquetas, e] });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={conv.asignado_a ?? ""}
        onChange={(e) => guardar({ asignado_a: e.target.value || null })}
        className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white max-w-[150px]"
        title="Quién atiende este chat"
      >
        <option value="">👤 Sin asignar</option>
        {usuarios.map((u) => <option key={u.id} value={u.id}>{u.id === yo ? `${u.nombre} (yo)` : u.nombre}</option>)}
      </select>
      {yo && conv.asignado_a !== yo && (
        <button onClick={() => guardar({ asignado_a: yo })} className="text-xs px-2 py-1.5 rounded-lg bg-[#0b315f]/10 text-[#0b315f] font-semibold">Tomar</button>
      )}
      <div className="relative">
        <button onClick={() => setAbrirEtq((v) => !v)} className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white">🏷 Etiquetas</button>
        {abrirEtq && (
          <div className="absolute right-0 top-9 z-30 bg-white border border-gray-200 rounded-xl shadow-lg p-2 w-56">
            {[...ETIQUETAS.map((x) => x.clave), ...etiquetas.filter((e) => !ETIQUETAS.some((x) => x.clave === e))].map((e) => (
              <label key={e} className="flex items-center gap-2 px-1 py-1 text-sm cursor-pointer">
                <input type="checkbox" checked={etiquetas.includes(e)} onChange={() => alternar(e)} />
                <ChipEtiqueta e={e} />
              </label>
            ))}
            <div className="flex gap-1 mt-1">
              <input value={nueva} onChange={(e) => setNueva(e.target.value)} placeholder="Otra…" className="flex-1 border rounded-lg px-2 py-1 text-xs" />
              <button
                onClick={() => { const v = nueva.trim(); if (v && !etiquetas.includes(v)) guardar({ etiquetas: [...etiquetas, v] }); setNueva(""); }}
                className="text-xs bg-[#0b315f] text-white rounded-lg px-2"
              >+</button>
            </div>
          </div>
        )}
      </div>
      {etiquetas.map((e) => <ChipEtiqueta key={e} e={e} />)}
    </div>
  );
}
