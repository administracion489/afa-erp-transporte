"use client";
// El contenido de un mensaje del CRM como se ve en WhatsApp: foto, sticker, audio,
// video, documento (PDF, Word, Excel…), reacción y texto con su formato (*negrita*,
// _cursiva_, ~tachado~, y el **doble** que escribe la IA).
import React from "react";

const TIPOS_IMAGEN = new Set(["image", "imagen", "sticker"]);
const esPlaceholder = (t?: string) => !!t && /^\[[a-z_]+\]$/i.test(t.trim());

/** Formato de WhatsApp → React. Sin HTML crudo: todo pasa como texto. */
export function textoWhatsApp(texto: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/[^\s]+)/g;
  let ult = 0; let k = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    if (m.index > ult) out.push(texto.slice(ult, m.index));
    const t = m[0];
    if (t.startsWith("http")) out.push(<a key={k++} href={t} target="_blank" rel="noopener noreferrer" className="underline break-all">{t}</a>);
    else if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("*")) out.push(<strong key={k++}>{t.slice(1, -1)}</strong>);
    else if (t.startsWith("_")) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else out.push(<s key={k++}>{t.slice(1, -1)}</s>);
    ult = m.index + t.length;
  }
  if (ult < texto.length) out.push(texto.slice(ult));
  return out;
}

export function esBurbujaSinFondo(tipo: string) {
  return tipo === "sticker" || tipo === "reaction";
}

export default function MensajeContenido({
  tipo, contenido, url, tieneMedia, esMio,
}: {
  tipo: string; contenido?: string; url: string | null | undefined; tieneMedia: boolean; esMio: boolean;
}) {
  const texto = contenido && !esPlaceholder(contenido) ? contenido : "";

  if (tipo === "reaction")
    return <span className="text-xs text-gray-500">reaccionó <span className="text-2xl align-middle">{contenido || "👍"}</span></span>;

  let media: React.ReactNode = null;
  if (tieneMedia) {
    if (url === undefined) media = <div className="text-xs opacity-60 py-2">Cargando {tipo === "sticker" ? "sticker" : "archivo"}…</div>;
    else if (url === null) media = <div className="text-xs opacity-70 py-1">📎 {tipo} (ya no disponible en WhatsApp)</div>;
    else if (TIPOS_IMAGEN.has(tipo))
      media = (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={tipo} className={tipo === "sticker" ? "w-36 h-36 object-contain" : "rounded-lg max-w-full max-h-80 object-contain"} />
        </a>
      );
    else if (tipo === "audio" || tipo === "voice") media = <audio controls src={url} className="max-w-full" />;
    else if (tipo === "video") media = <video controls src={url} className="rounded-lg max-w-full max-h-80" />;
    else
      media = (
        <a href={url} target="_blank" rel="noopener noreferrer"
          className={`flex items-center gap-2 rounded-lg px-3 py-2 ${esMio ? "bg-white/10" : "bg-gray-50 border border-gray-200"}`}>
          <span className="text-2xl">{/pdf/i.test(texto) ? "📕" : /docx?$/i.test(texto) ? "📘" : /xlsx?$/i.test(texto) ? "📗" : "📄"}</span>
          <span className="text-sm font-medium truncate max-w-[220px]">{texto || "Documento"}</span>
          <span className="text-xs opacity-70 ml-auto">Abrir</span>
        </a>
      );
  } else if (!texto && esPlaceholder(contenido)) {
    const etiqueta: Record<string, string> = { sticker: "Sticker", image: "Foto", audio: "Audio", video: "Video", document: "Documento", location: "📍 Ubicación", contacts: "👤 Contacto" };
    return <span className="text-xs italic opacity-70">{etiqueta[tipo] ?? contenido} (no se recibió el archivo)</span>;
  }

  const mostrarTexto = texto && !(tipo === "document" && tieneMedia);
  return (
    <>
      {media && <div className={mostrarTexto ? "mb-1.5" : ""}>{media}</div>}
      {mostrarTexto && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{textoWhatsApp(texto)}</p>}
    </>
  );
}
