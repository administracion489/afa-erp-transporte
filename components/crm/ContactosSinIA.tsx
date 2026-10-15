"use client";
// Lista de contactos de WhatsApp con un interruptor de IA. Un proveedor o un conductor
// escribe por trabajo: que el agente le conteste «¿Cotizar un servicio?» no tiene sentido.
// «Marcar proveedores» cruza el teléfono con conductores (propios y de terceros) y
// empresas tercerizadas; lo aplica una persona viendo la lista.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { tel9 } from "@/lib/crm-telefono";

type Contacto = { id: string; nombre: string | null; empresa: string | null; telefono: string | null; wa_id: string | null; ia_desactivada?: boolean };
type Origen = Record<string, string>; // tel9 → «Conductor · Juan»

async function telefonosDeTrabajo(): Promise<Origen> {
  const out: Origen = {};
  const fuentes: [string, string, string][] = [
    ["conductores", "id, nombre, telefono", "Conductor"],
    ["conductores_tercero", "id, nombre, telefono", "Conductor tercero"],
    ["empresas_tercerizadas", "id, razon_social, telefono", "Proveedor"],
  ];
  for (const [tabla, cols, rot] of fuentes) {
    const { data } = await supabase.from(tabla).select(cols).limit(5000);
    for (const r of (data ?? []) as any[]) {
      const t = tel9(r.telefono);
      if (t.length === 9 && !out[t]) out[t] = `${rot} · ${r.nombre ?? r.razon_social ?? ""}`;
    }
  }
  return out;
}

export default function ContactosSinIA() {
  const [contactos, setContactos] = useState<Contacto[] | null>(null);
  const [origen, setOrigen] = useState<Origen>({});
  const [falta, setFalta] = useState(false);
  const [q, setQ] = useState("");
  const [solo, setSolo] = useState<"todos" | "sin_ia" | "trabajo">("trabajo");
  const [msg, setMsg] = useState<string | null>(null);

  const cargar = async () => {
    const r = await supabase.from("crm_contactos").select("id, nombre, empresa, telefono, wa_id, ia_desactivada").order("nombre").limit(5000);
    if (r.error) {
      setFalta(/ia_desactivada/.test(r.error.message));
      const r2 = await supabase.from("crm_contactos").select("id, nombre, empresa, telefono, wa_id").order("nombre").limit(5000);
      setContactos((r2.data ?? []) as Contacto[]);
    } else setContactos((r.data ?? []) as Contacto[]);
  };
  useEffect(() => { cargar(); telefonosDeTrabajo().then(setOrigen); }, []);

  const telDe = (c: Contacto) => tel9(c.telefono ?? c.wa_id);
  const lista = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (contactos ?? []).filter((c) => (c.telefono || c.wa_id))
      .filter((c) => solo === "todos" || (solo === "sin_ia" ? c.ia_desactivada : !!origen[telDe(c)]))
      .filter((c) => !n || `${c.nombre ?? ""} ${c.empresa ?? ""} ${c.telefono ?? ""} ${c.wa_id ?? ""}`.toLowerCase().includes(n));
  }, [contactos, origen, q, solo]);

  const poner = async (ids: string[], valor: boolean) => {
    if (!ids.length) return;
    const { error } = await supabase.from("crm_contactos").update({ ia_desactivada: valor }).in("id", ids);
    if (error) { setMsg(`No se guardó: ${error.message}`); return; }
    setContactos((p) => (p ?? []).map((c) => (ids.includes(c.id) ? { ...c, ia_desactivada: valor } : c)));
    setMsg(`${ids.length} contacto(s) ${valor ? "sin IA" : "con IA"}.`);
  };

  const proveedoresConIA = (contactos ?? []).filter((c) => origen[telDe(c)] && !c.ia_desactivada);

  return (
    <div className="mt-6 bg-white rounded-2xl border border-gray-200 p-5">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div>
          <h2 className="font-bold text-[#0b315f]">🚫 Contactos sin IA</h2>
          <p className="text-xs text-gray-500">Proveedores y conductores escriben por trabajo: apágales la IA y les responde una persona.</p>
        </div>
        <button
          disabled={falta || proveedoresConIA.length === 0}
          onClick={() => {
            if (confirm(`Desactivar la IA a ${proveedoresConIA.length} contacto(s) que son conductores o proveedores?\n\n` +
              proveedoresConIA.slice(0, 15).map((c) => `• ${c.nombre ?? c.telefono} — ${origen[telDe(c)]}`).join("\n")))
              poner(proveedoresConIA.map((c) => c.id), true);
          }}
          className="bg-[#0b315f] text-white text-xs font-semibold px-3 py-2 rounded-xl disabled:opacity-40"
        >
          Desactivar IA a proveedores y conductores ({proveedoresConIA.length})
        </button>
      </div>
      {falta && (
        <div className="mt-3 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-2">
          Falta correr <b>supabase/crm-ia-contactos.sql</b> en Supabase: hasta entonces no se puede guardar.
        </div>
      )}
      {msg && <div className="mt-2 text-xs text-gray-600">{msg}</div>}
      <div className="flex flex-wrap gap-2 mt-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nombre o número…" className="border rounded-xl px-3 py-1.5 text-sm flex-1 min-w-[180px]" />
        {(["trabajo", "sin_ia", "todos"] as const).map((k) => (
          <button key={k} onClick={() => setSolo(k)} className={`text-xs px-3 py-1.5 rounded-xl border ${solo === k ? "bg-[#0b315f] text-white" : "bg-white text-gray-600"}`}>
            {k === "trabajo" ? "Proveedores / conductores" : k === "sin_ia" ? "Sin IA" : "Todos"}
          </button>
        ))}
      </div>
      <div className="mt-3 max-h-96 overflow-y-auto divide-y">
        {contactos === null ? <div className="text-sm text-gray-400 py-3">Cargando…</div>
          : lista.length === 0 ? <div className="text-sm text-gray-400 py-3">Ningún contacto en este filtro.</div>
          : lista.map((c) => (
            <label key={c.id} className="flex items-center gap-3 py-2 text-sm cursor-pointer">
              <input type="checkbox" disabled={falta} checked={!c.ia_desactivada} onChange={(e) => poner([c.id], !e.target.checked)} />
              <span className="flex-1 min-w-0">
                <span className="font-medium text-gray-800">{c.nombre ?? "Sin nombre"}</span>
                <span className="text-gray-400 ml-2">{c.telefono ?? c.wa_id}</span>
                {origen[telDe(c)] && <span className="ml-2 text-[11px] bg-blue-50 text-blue-700 rounded px-1.5">{origen[telDe(c)]}</span>}
              </span>
              <span className={`text-xs ${c.ia_desactivada ? "text-red-600" : "text-green-600"}`}>{c.ia_desactivada ? "IA apagada" : "IA activa"}</span>
            </label>
          ))}
      </div>
    </div>
  );
}
