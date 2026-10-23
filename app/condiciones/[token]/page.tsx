"use client";
// Página PÚBLICA de las condiciones de reserva, cambios y cancelación de UNA cotización: la que abre el
// enlace (y el QR) del PDF y del WhatsApp. Sin usuario ni contraseña: el token del enlace ES la llave.
//
// Enseña la política GUARDADA EN ESA COTIZACIÓN (no la de hoy de la plantilla): si la empresa cambia
// la plantilla después, quien reservó sigue viendo la suya. Editar la cotización misma SÍ la cambia
// (no hay historial), y por eso el texto no promete más que eso. Arriba va el resumen (lo mismo que vio en el PDF)
// y debajo el texto completo. Nada del cliente, ni precios, ni cuentas: eso lo garantiza la ruta
// (app/api/condiciones/[token]/route.ts, lib/condiciones-publicas-armar.ts), que es lo único que lee.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { DETALLE_CONDICIONES, type CondicionesPublicasOk, type RespuestaCondicionesPublicas } from "@/lib/condiciones-publicas";

type Estado = { tipo: "cargando" } | { tipo: "ok"; d: CondicionesPublicasOk } | { tipo: "error"; detalle: string };

const TXT = {
  es: {
    titulo: "Condiciones de reserva, cambios y cancelación",
    cotizacion: "Cotización N°",
    emitida: "emitida el",
    resumen: "Lo principal",
    completa: "Condiciones completas",
    constancia: "Estas son las condiciones guardadas en esta cotización. Si la empresa cambia sus condiciones generales, esta página sigue mostrando las de esta cotización.",
    contacto: "Para cancelar, cambiar su reserva o hacer una consulta:",
    imprimir: "Imprimir o guardar en PDF",
  },
  en: {
    titulo: "Booking, changes and cancellation terms",
    cotizacion: "Quote No.",
    emitida: "issued on",
    resumen: "Key points",
    completa: "Full terms",
    constancia: "These are the terms saved with this quote. If the company changes its general terms, this page keeps showing the ones for this quote.",
    contacto: "To cancel, change your booking or ask a question:",
    imprimir: "Print or save as PDF",
  },
} as const;

/** AAAA-MM-DD → DD/MM/AAAA (o null). */
const fecha = (iso: string | null): string | null => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);

/** Solo https para la web y el logo que vienen del perfil (texto que se escribe a mano). */
const httpsOk = (u: string | null): string | null => {
  if (!u) return null;
  const t = u.trim();
  const conEsquema = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try { const x = new URL(conEsquema); return x.protocol === "https:" ? x.toString() : null; } catch { return null; }
};

export default function CondicionesPage() {
  const { token } = useParams<{ token: string }>();
  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await fetch(`/api/condiciones/${encodeURIComponent(String(token ?? ""))}`, { cache: "no-store" });
        const j = (await r.json().catch(() => null)) as RespuestaCondicionesPublicas | null;
        if (!vivo) return;
        if (j && j.ok) setEstado({ tipo: "ok", d: j });
        else setEstado({ tipo: "error", detalle: j && !j.ok ? (j.detalle || DETALLE_CONDICIONES[j.codigo] || DETALLE_CONDICIONES.error) : DETALLE_CONDICIONES.error });
      } catch {
        if (vivo) setEstado({ tipo: "error", detalle: DETALLE_CONDICIONES.error });
      }
    })();
    return () => { vivo = false; };
  }, [token]);

  if (estado.tipo === "cargando") {
    return <div className="min-h-screen grid place-items-center bg-gray-50 text-gray-400 text-sm">Cargando las condiciones…</div>;
  }
  if (estado.tipo === "error") {
    return (
      <div className="min-h-screen grid place-items-center bg-gray-50 p-6">
        <div className="max-w-md text-center">
          <div className="text-4xl mb-3">🔗</div>
          <h1 className="text-lg font-black text-[#0b315f] mb-2">No se pudieron mostrar las condiciones</h1>
          <p className="text-sm text-gray-600">{estado.detalle}</p>
        </div>
      </div>
    );
  }

  const d = estado.d;
  const t = TXT[d.idioma === "en" ? "en" : "es"];
  const e = d.empresa;
  const nombre = e.nombre || e.razon_social || "";
  const logo = httpsOk(e.logo_url);
  const web = httpsOk(e.web);
  const emitida = fecha(d.emitida);

  return (
    <div className="min-h-screen bg-gray-50 print:bg-white">
      <header className="bg-[#0b315f] text-white print:bg-white print:text-[#0b315f]">
        <div className="max-w-3xl mx-auto px-4 py-5 flex items-center gap-4">
          {logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt={nombre || "Logo"} className="h-12 w-auto bg-white rounded-lg p-1.5" referrerPolicy="no-referrer" />
          )}
          <div className="min-w-0">
            {nombre && <p className="text-sm font-semibold opacity-90 truncate">{nombre}</p>}
            {e.ruc && <p className="text-xs opacity-75">RUC {e.ruc}</p>}
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-[#0b315f] leading-tight">{t.titulo}</h1>
          <p className="text-sm text-gray-600 mt-1">
            {t.cotizacion} <span className="font-mono font-bold">{d.numero}</span>{emitida ? ` · ${t.emitida} ${emitida}` : ""}
          </p>
        </div>

        {d.resumen.length > 0 && (
          <section className="rounded-xl border-2 border-[#0b315f]/20 bg-white p-4">
            <h2 className="text-sm font-black uppercase tracking-wide text-[#0b315f] mb-2">{t.resumen}</h2>
            <ul className="space-y-1.5 text-sm text-gray-800 list-disc pl-5">
              {d.resumen.map((l, i) => <li key={i} className="break-words">{l}</li>)}
            </ul>
          </section>
        )}

        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-black uppercase tracking-wide text-gray-700 mb-2">{t.completa}</h2>
          <ol className="space-y-2 text-sm text-gray-800 list-decimal pl-5">
            {d.politica.map((l, i) => <li key={i} className="break-words leading-relaxed">{l}</li>)}
          </ol>
        </section>

        <p className="text-xs text-gray-500">{t.constancia}</p>

        {(e.telefono || e.email || web) && (
          <section className="rounded-xl bg-white border border-gray-200 p-4 text-sm text-gray-700 space-y-1">
            <p className="font-semibold">{t.contacto}</p>
            {e.telefono && <p>📞 {e.telefono}</p>}
            {e.email && <p>✉ <a href={`mailto:${e.email}`} className="text-[#0b315f] underline break-all">{e.email}</a></p>}
            {web && <p>🌐 <a href={web} target="_blank" rel="noopener noreferrer" className="text-[#0b315f] underline break-all">{web.replace(/^https:\/\//, "").replace(/\/$/, "")}</a></p>}
          </section>
        )}

        <div className="print:hidden">
          <button type="button" onClick={() => window.print()}
            className="text-sm px-4 py-2.5 rounded-xl border border-[#0b315f] text-[#0b315f] font-semibold hover:bg-[#0b315f]/5 min-h-[44px]">
            🖨 {t.imprimir}
          </button>
        </div>
      </main>
    </div>
  );
}
