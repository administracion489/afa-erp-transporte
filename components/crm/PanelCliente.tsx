"use client";
// Panel lateral del cliente (como Respond.io / Chatwoot): sus datos, sus cotizaciones y
// servicios del ERP y atajos para crear una cotización. Se reconoce al cliente por el
// enlace escrito (crm_contactos.cliente_id) o, si no hay, por el teléfono o el correo.
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { tel9 } from "@/lib/crm-telefono";

type Contacto = { id: string; nombre?: string | null; empresa?: string | null; telefono?: string | null; email?: string | null; wa_id?: string | null; cliente_id?: number | null };

export default function PanelCliente({ contacto, onClose }: { contacto: Contacto; onClose: () => void }) {
  const [cliente, setCliente] = useState<any | null | undefined>(undefined);
  const [cots, setCots] = useState<any[]>([]);
  const [servs, setServs] = useState<any[]>([]);
  const [por, setPor] = useState<string>("");

  useEffect(() => {
    let vivo = true;
    (async () => {
      setCliente(undefined); setCots([]); setServs([]);
      let cl: any = null; let via = "";
      if (contacto.cliente_id) {
        const { data } = await supabase.from("clientes").select("id,nombre,empresa,ruc,email,telefono,tipo").eq("id", contacto.cliente_id).maybeSingle();
        if (data) { cl = data; via = "enlazado"; }
      }
      const t = tel9(contacto.telefono ?? contacto.wa_id);
      if (!cl && t.length === 9) {
        const { data } = await supabase.from("clientes").select("id,nombre,empresa,ruc,email,telefono,tipo").ilike("telefono", `%${t.slice(-6)}%`).limit(20);
        cl = ((data ?? []) as any[]).find((c) => tel9(c.telefono) === t) ?? null;
        if (cl) via = "por teléfono";
      }
      if (!cl && contacto.email) {
        const { data } = await supabase.from("clientes").select("id,nombre,empresa,ruc,email,telefono,tipo").ilike("email", contacto.email).limit(1);
        cl = data?.[0] ?? null;
        if (cl) via = "por correo";
      }
      if (!vivo) return;
      setCliente(cl); setPor(via);
      if (!cl) return;
      const [c, r] = await Promise.all([
        supabase.from("cotizaciones").select("id, numero_cotizacion, asunto, estado, fecha_servicio, precio_cliente, created_at").eq("cliente_id", cl.id).order("created_at", { ascending: false }).limit(6),
        supabase.from("reservas").select("id, codigo, fecha_servicio, hora_servicio, ruta_nombre, origen, destino, estado").eq("cliente_id", cl.id).order("fecha_servicio", { ascending: false }).limit(6),
      ]);
      if (!vivo) return;
      setCots(c.data ?? []); setServs(r.data ?? []);
    })();
    return () => { vivo = false; };
  }, [contacto.id, contacto.cliente_id, contacto.telefono, contacto.wa_id, contacto.email]);

  const enlazar = async () => {
    if (!cliente) return;
    await supabase.from("crm_contactos").update({ cliente_id: cliente.id }).eq("id", contacto.id);
    setPor("enlazado");
  };

  const urlCot = cliente
    ? `/cotizaciones?nuevo=1&cliente=${cliente.id}&asunto=${encodeURIComponent("Cotización solicitada por WhatsApp")}`
    : null;

  return (
    // En el celular, a pantalla completa ENCIMA del chat (que ya es fixed z-30 en BandejaCRM); en
    // escritorio, la columna de la derecha de siempre.
    <aside className="fixed inset-0 z-[35] w-full md:static md:z-auto md:w-[300px] flex-shrink-0 bg-white border-l border-gray-100 flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <span className="font-semibold text-sm text-[#0b315f]">Ficha del cliente</span>
        <button onClick={onClose} aria-label="Cerrar la ficha del cliente" className="text-gray-400 text-lg w-9 h-9 -mr-2 rounded-full hover:bg-gray-100 flex items-center justify-center">×</button>
      </div>
      <div className="p-4 space-y-4 text-sm">
        <div>
          <div className="font-semibold text-gray-900">{contacto.nombre ?? "Sin nombre"}</div>
          {contacto.empresa && <div className="text-gray-500 text-xs">{contacto.empresa}</div>}
          {(contacto.telefono || contacto.wa_id) && <div className="text-gray-500 text-xs">📞 {contacto.telefono ?? contacto.wa_id}</div>}
          {contacto.email && <div className="text-gray-500 text-xs">✉ {contacto.email}</div>}
        </div>

        {cliente === undefined ? (
          <div className="text-xs text-gray-400">Buscando en Clientes…</div>
        ) : cliente === null ? (
          <div className="text-xs bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
            <div>No está en <b>Clientes</b> (ni por teléfono ni por correo).</div>
            <a
              href={`/clientes?nuevo=1&nombre=${encodeURIComponent(contacto.empresa || contacto.nombre || "")}`}
              target="_blank" rel="noopener noreferrer"
              className="inline-block bg-[#0b315f] text-white font-semibold px-3 py-1.5 rounded-lg"
            >+ Crear cliente</a>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-xs bg-green-50 border border-green-200 rounded-xl p-3">
              <div className="font-semibold text-green-800">{cliente.empresa || cliente.nombre}</div>
              {cliente.ruc && <div className="text-green-700">RUC {cliente.ruc}</div>}
              <div className="text-green-700/80 mt-1">Cliente del ERP · {por}</div>
              {por !== "enlazado" && <button onClick={enlazar} className="mt-1 underline text-green-800">Enlazar este contacto</button>}
            </div>
            <div className="flex gap-2">
              <a href={urlCot!} target="_blank" rel="noopener noreferrer" className="flex-1 text-center bg-[#0b315f] text-white text-xs font-semibold px-3 py-2 rounded-lg">+ Crear cotización</a>
              <a href="/clientes" target="_blank" rel="noopener noreferrer" className="text-xs border border-gray-200 px-3 py-2 rounded-lg">Ver</a>
            </div>
          </div>
        )}

        {cliente && (
          <>
            <div>
              <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Cotizaciones</div>
              {cots.length === 0 ? <div className="text-xs text-gray-400">Ninguna.</div> : cots.map((c) => (
                <a key={c.id} href={`/cotizaciones?buscar=${encodeURIComponent(c.numero_cotizacion ?? "")}`} target="_blank" rel="noopener noreferrer"
                  className="block text-xs border-b border-gray-50 py-1.5 hover:bg-gray-50">
                  <span className="font-semibold">N° {c.numero_cotizacion ?? c.id}</span> · {c.estado}
                  {c.precio_cliente != null && <> · S/ {Number(c.precio_cliente).toFixed(2)}</>}
                  <div className="text-gray-500 truncate">{c.asunto ?? ""}{c.fecha_servicio ? ` · ${c.fecha_servicio}` : ""}</div>
                </a>
              ))}
            </div>
            <div>
              <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Servicios</div>
              {servs.length === 0 ? <div className="text-xs text-gray-400">Ninguno.</div> : servs.map((r) => (
                <div key={r.id} className="text-xs border-b border-gray-50 py-1.5">
                  <span className="font-semibold">{r.fecha_servicio}</span> {r.hora_servicio?.slice(0, 5) ?? ""} · {r.estado}
                  <div className="text-gray-500 truncate">{r.ruta_nombre || [r.origen, r.destino].filter(Boolean).join(" → ")}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
