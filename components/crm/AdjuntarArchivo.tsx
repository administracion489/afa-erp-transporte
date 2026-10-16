"use client";
// Adjuntar como en WhatsApp Web: 📎 → Documento / Fotos y videos / Cámara, vista previa con
// comentario y «Enviar». El archivo sube directo al bucket privado (URL firmada de subida)
// y el servidor lo manda por WhatsApp (app/api/crm/mensajes/adjuntar).
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";

const fmtTam = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);
const icono = (n: string) => (/\.pdf$/i.test(n) ? "📕" : /\.docx?$/i.test(n) ? "📘" : /\.(xlsx?|csv)$/i.test(n) ? "📗" : /\.(pptx?)$/i.test(n) ? "📙" : "📄");

export default function AdjuntarArchivo({
  conversacionId, habilitado, motivo, onEnviado, aviso,
}: {
  conversacionId: string;
  habilitado: boolean;
  motivo?: string;
  onEnviado: () => void;
  aviso: (m: string, ok?: boolean) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [archivos, setArchivos] = useState<File[]>([]);
  const [caption, setCaption] = useState("");
  const [enviando, setEnviando] = useState<string | null>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const fotoRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [previa, setPrevia] = useState<string | null>(null);

  useEffect(() => {
    const f = archivos[0];
    if (f && f.type.startsWith("image/")) {
      const u = URL.createObjectURL(f); setPrevia(u);
      return () => URL.revokeObjectURL(u);
    }
    setPrevia(null);
  }, [archivos]);

  const elegir = (lista: FileList | null) => {
    setMenu(false);
    if (lista?.length) { setArchivos(Array.from(lista).slice(0, 10)); setCaption(""); }
  };

  const enviar = async () => {
    for (let i = 0; i < archivos.length; i++) {
      const f = archivos[i];
      setEnviando(`Enviando ${i + 1} de ${archivos.length}: ${f.name}…`);
      const base = { conversacion_id: conversacionId, nombre: f.name, mime: f.type || "application/octet-stream" };
      const r1 = await fetch("/api/crm/mensajes/adjuntar", {
        method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ ...base, accion: "subir", tamano: f.size }),
      }).then((r) => r.json()).catch(() => ({ ok: false, error: "Sin conexión" }));
      if (!r1.ok) { aviso(`${f.name}: ${r1.error}`, false); continue; }
      const up = await supabase.storage.from(r1.bucket).uploadToSignedUrl(r1.ruta, r1.token, f, { contentType: base.mime });
      if (up.error) { aviso(`${f.name}: no se pudo subir (${up.error.message})`, false); continue; }
      const r2 = await fetch("/api/crm/mensajes/adjuntar", {
        method: "POST", headers: await cabecerasErp(),
        body: JSON.stringify({ ...base, accion: "enviar", ruta: r1.ruta, caption: i === 0 ? caption : "" }),
      }).then((r) => r.json()).catch(() => ({ ok: false, error: "Sin conexión" }));
      if (!r2.ok) aviso(`${f.name}: ${r2.error ?? "no se envió"}`, false);
    }
    setEnviando(null); setArchivos([]); setCaption(""); onEnviado();
  };

  return (
    <>
      <div className="relative">
        <button
          onClick={() => (habilitado ? setMenu((v) => !v) : aviso(motivo ?? "No se pueden enviar archivos aquí", false))}
          title={habilitado ? "Adjuntar documento, foto o video" : motivo}
          className={`px-2.5 py-2 rounded-xl text-lg border border-gray-200 hover:bg-gray-50 ${habilitado ? "text-gray-600" : "text-gray-300"}`}
        >
          📎
        </button>
        {menu && (
          <div className="absolute bottom-12 left-0 z-40 bg-white rounded-2xl shadow-xl border border-gray-100 py-2 w-56">
            {[
              { k: "doc", ic: "📄", bg: "#7f66ff", t: "Documento", f: () => docRef.current?.click() },
              { k: "foto", ic: "🖼️", bg: "#007bfc", t: "Fotos y videos", f: () => fotoRef.current?.click() },
              { k: "cam", ic: "📷", bg: "#ff2e74", t: "Cámara", f: () => camRef.current?.click() },
            ].map((o) => (
              <button key={o.k} onClick={o.f} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-sm text-gray-800">
                <span className="w-8 h-8 rounded-full flex items-center justify-center text-base" style={{ background: o.bg }}>{o.ic}</span>
                {o.t}
              </button>
            ))}
          </div>
        )}
        <input ref={docRef} type="file" multiple hidden
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,application/pdf"
          onChange={(e) => { elegir(e.target.files); e.target.value = ""; }} />
        <input ref={fotoRef} type="file" multiple hidden accept="image/jpeg,image/png,video/mp4"
          onChange={(e) => { elegir(e.target.files); e.target.value = ""; }} />
        <input ref={camRef} type="file" hidden accept="image/*" capture="environment"
          onChange={(e) => { elegir(e.target.files); e.target.value = ""; }} />
      </div>

      {archivos.length > 0 && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !enviando && setArchivos([])}>
          <div className="bg-[#f0f2f5] rounded-2xl w-full max-w-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 bg-white">
              <span className="font-semibold text-gray-800">{archivos.length > 1 ? `${archivos.length} archivos` : archivos[0].name}</span>
              <button disabled={!!enviando} onClick={() => setArchivos([])} className="text-gray-400 text-xl">×</button>
            </div>
            <div className="p-6 flex flex-col items-center gap-3 max-h-[55vh] overflow-y-auto">
              {previa ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previa} alt="" className="max-h-[45vh] rounded-lg object-contain" />
              ) : null}
              {archivos.map((f, i) => (previa && i === 0 ? null : (
                <div key={i} className="w-full flex items-center gap-3 bg-white rounded-xl px-4 py-3">
                  <span className="text-3xl">{f.type.startsWith("video/") ? "🎬" : f.type.startsWith("image/") ? "🖼️" : icono(f.name)}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{f.name}</div>
                    <div className="text-xs text-gray-500">{fmtTam(f.size)}</div>
                  </div>
                </div>
              )))}
            </div>
            <div className="flex gap-2 items-center px-4 py-3 bg-white">
              <input
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !enviando) enviar(); }}
                placeholder="Añade un comentario…"
                className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm"
                autoFocus
              />
              <button
                onClick={enviar}
                disabled={!!enviando}
                className="w-11 h-11 rounded-full bg-[#00a884] text-white text-lg flex items-center justify-center disabled:opacity-50"
                title="Enviar"
              >
                ➤
              </button>
            </div>
            {enviando && <div className="text-xs text-gray-600 px-5 pb-3 bg-white">{enviando}</div>}
          </div>
        </div>
      )}
    </>
  );
}
