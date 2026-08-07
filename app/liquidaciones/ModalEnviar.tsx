"use client";
// Envío de la liquidación para conformidad: correo, WhatsApp y Portal del Cliente.
// Los tres llevan al MISMO enlace /conformidad/<token>, así el cliente ve una sola
// versión del documento sin importar por dónde le llegó.
//
// El WhatsApp automático usa una plantilla aprobada por Meta. Mientras esa plantilla
// no exista, el botón "Abrir WhatsApp" arma el mensaje y lo deja listo para enviarlo
// desde el teléfono del operador — el circuito no se queda esperando a Meta.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import type { Sede } from "./ModalSede";

type Canal = "correo" | "whatsapp" | "portal";

/** Perú: 9 dígitos → +51. Si ya trae código de país, se respeta. */
function e164(tel: string | null | undefined): string {
  const d = String(tel ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("51") && d.length >= 11) return d;
  if (d.length === 9) return "51" + d;
  return d;
}

export default function ModalEnviar({
  liquidacion, lado, sede, contraparte, onCerrar, onEnviado,
}: {
  liquidacion: any;
  lado: "cliente" | "proveedor";
  sede: Sede | null;
  contraparte: any;
  onCerrar: () => void;
  onEnviado: () => void;
}) {
  const [canales, setCanales] = useState<Canal[]>(["correo", "whatsapp", "portal"]);
  const [contacto, setContacto] = useState("");
  const [correo, setCorreo] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<any[] | null>(null);
  const [error, setError] = useState("");
  const [historial, setHistorial] = useState<any[]>([]);

  const url = typeof window !== "undefined" ? `${location.origin}/conformidad/${liquidacion.token}` : "";
  const total = fmtMoneda(Number(liquidacion.total ?? 0), liquidacion.moneda);

  useEffect(() => {
    setContacto(sede?.usuario_solicita || (lado === "cliente" ? contraparte?.administrativo_nombre : contraparte?.contacto_nombre) || "");
    setCorreo(sede?.email_conformidad || (lado === "cliente" ? contraparte?.administrativo_email || contraparte?.email : contraparte?.email) || "");
    setWhatsapp(sede?.whatsapp_conformidad || (lado === "cliente" ? contraparte?.administrativo_celular : contraparte?.contacto_telefono) || "");
    (async () => {
      const { data } = await supabase.from("liquidacion_envio")
        .select("*").eq("entidad", lado).eq("liquidacion_id", liquidacion.id)
        .order("created_at", { ascending: false }).limit(10);
      setHistorial((data as any[]) ?? []);
    })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [liquidacion.id]);

  const mensajeWa =
    `Estimado(a) ${contacto || "cliente"}:\n\n` +
    `Ponemos a su disposición la liquidación *${liquidacion.codigo}* del periodo ${liquidacion.periodo}, ` +
    `por un total de *${total}*, para su revisión y conformidad.\n\n` +
    `Puede revisarla y aprobarla aquí:\n${url}\n\n` +
    `AFA Tours Perú S.A.C.`;

  function toggle(c: Canal) {
    setCanales((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  }

  async function enviar() {
    if (!canales.length) { setError("Elige al menos un canal."); return; }
    setEnviando(true); setError(""); setResultado(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const r = await fetch("/api/liquidaciones/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s?.session?.access_token ?? ""}` },
        body: JSON.stringify({
          id: liquidacion.id, lado, canales,
          destinos: { contacto, correo, whatsapp },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "No se pudo enviar.");
      setResultado(j.resultados ?? []);
      onEnviado();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setEnviando(false);
    }
  }

  const campo = "w-full px-3 py-2 rounded-xl border text-sm";
  const label = "text-[11px] font-bold text-gray-500 uppercase tracking-wide";

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b">
          <h3 className="font-black text-[#0b315f]">Enviar para conformidad</h3>
          <p className="text-xs text-gray-500">{liquidacion.codigo} · {liquidacion.periodo} · {total}</p>
        </div>

        <div className="p-5 grid gap-4">
          <div>
            <p className={label}>Canales</p>
            <div className="grid grid-cols-3 gap-2 mt-1.5">
              {([
                { c: "correo" as Canal, t: "✉ Correo", s: correo || "sin correo" },
                { c: "whatsapp" as Canal, t: "💬 WhatsApp", s: whatsapp || "sin número" },
                { c: "portal" as Canal, t: "🏢 Portal", s: "queda publicada" },
              ]).map(({ c, t, s }) => (
                <button key={c} onClick={() => toggle(c)}
                  className={`px-3 py-2.5 rounded-xl border-2 text-left transition ${canales.includes(c) ? "border-[#0b315f] bg-[#0b315f]/5" : "border-gray-200 hover:bg-gray-50"}`}>
                  <span className="block text-xs font-bold text-gray-700">{t}</span>
                  <span className="block text-[10px] text-gray-400 truncate">{s}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3">
            <div>
              <label className={label}>Contacto que aprueba</label>
              <input className={campo} value={contacto} onChange={(e) => setContacto(e.target.value)} placeholder="Nombre del responsable" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Correo</label>
                <input className={campo} value={correo} onChange={(e) => setCorreo(e.target.value)} placeholder="contacto@cliente.com" />
              </div>
              <div>
                <label className={label}>WhatsApp</label>
                <input className={campo} value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="987 654 321" />
              </div>
            </div>
            {!sede && lado === "cliente" && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                Esta liquidación no tiene sede asociada: los datos salen del cliente. Configura la sede para no volver a escribirlos cada periodo.
              </p>
            )}
          </div>

          <div className="bg-gray-50 border rounded-xl p-3">
            <p className={label}>Enlace de conformidad</p>
            <p className="text-[11px] text-gray-500 mt-1 break-all">{url}</p>
            <div className="flex gap-2 mt-2">
              <button onClick={() => navigator.clipboard?.writeText(url)}
                className="px-3 py-1.5 rounded-lg text-[11px] font-bold border bg-white hover:bg-gray-50">Copiar enlace</button>
              <a href={`https://wa.me/${e164(whatsapp)}?text=${encodeURIComponent(mensajeWa)}`} target="_blank" rel="noopener noreferrer"
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border bg-white hover:bg-gray-50 ${e164(whatsapp) ? "" : "opacity-40 pointer-events-none"}`}>
                Abrir WhatsApp con el mensaje
              </a>
            </div>
            <p className="text-[10px] text-gray-400 mt-2">
              El envío automático por WhatsApp requiere la plantilla <b>liquidacion_conformidad</b> aprobada en Meta.
              Mientras tanto, “Abrir WhatsApp” deja el mensaje listo para enviarlo desde tu teléfono.
            </p>
          </div>

          {resultado && (
            <div className="grid gap-1.5">
              {resultado.map((r, i) => (
                <div key={i} className={`px-3 py-2 rounded-xl text-xs border ${r.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-700"}`}>
                  <b>{r.canal}</b> {r.ok ? `→ enviado${r.destino ? " a " + r.destino : ""}` : `→ ${r.error}`}
                </div>
              ))}
            </div>
          )}
          {error && <div className="px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}

          {historial.length > 0 && (
            <div>
              <p className={label}>Envíos anteriores</p>
              <div className="mt-1.5 border rounded-xl divide-y max-h-40 overflow-y-auto">
                {historial.map((h) => (
                  <div key={h.id} className="px-3 py-1.5 text-[11px] flex gap-2 items-center">
                    <span className={`w-1.5 h-1.5 rounded-full ${h.estado === "enviado" ? "bg-emerald-500" : "bg-red-500"}`} />
                    <span className="font-bold text-gray-600">{h.canal}</span>
                    <span className="text-gray-400 flex-1 truncate">{h.destino ?? h.detalle ?? ""}</span>
                    <span className="text-gray-400">{new Date(h.created_at).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end">
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={enviar} disabled={enviando}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-[#0b315f] text-white hover:bg-[#092647] disabled:opacity-50">
            {enviando ? "Enviando…" : "Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}
