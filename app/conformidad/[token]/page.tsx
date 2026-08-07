"use client";
// Página PÚBLICA de conformidad. Es donde termina el circuito: el cliente recibe el
// enlace por correo, WhatsApp o el Portal, revisa la liquidación y la aprueba u
// observa — sin usuario, sin contraseña, sin imprimir ni escanear nada.
//
// Muestra el MISMO documento que se envía en PDF (dentro de un iframe aislado), para
// que no exista una "versión de pantalla" distinta de la versión firmada.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

const fMoneda = (n: number, moneda = "PEN") =>
  `${moneda === "USD" ? "$" : "S/"} ${Number(n ?? 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function ConformidadPage() {
  const { token } = useParams<{ token: string }>();
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [datos, setDatos] = useState<any>(null);
  const [html, setHtml] = useState("");
  const [verDoc, setVerDoc] = useState(false);

  const [decision, setDecision] = useState<"conforme" | "observada">("conforme");
  const [nombre, setNombre] = useState("");
  const [cargo, setCargo] = useState("");
  const [comentario, setComentario] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [listo, setListo] = useState<null | { decision: string; codigo: string }>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/liquidaciones/conformidad?token=${encodeURIComponent(String(token))}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "No se pudo cargar la liquidación.");
        setDatos(j.resumen);
        setHtml(j.html);
        setNombre(j.resumen?.usuario ?? "");
        setCargo(j.resumen?.cargo ?? "");
      } catch (e: any) {
        setError(String(e?.message ?? e));
      } finally {
        setCargando(false);
      }
    })();
  }, [token]);

  async function responder() {
    if (!nombre.trim()) { setError("Escribe tu nombre para registrar la conformidad."); return; }
    if (decision === "observada" && !comentario.trim()) { setError("Cuéntanos qué debemos corregir."); return; }
    setEnviando(true); setError("");
    try {
      const r = await fetch("/api/liquidaciones/conformidad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, decision, por: nombre.trim(), cargo: cargo.trim(), comentario: comentario.trim(), canal: "correo" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "No se pudo registrar tu respuesta.");
      setListo({ decision: j.decision, codigo: j.codigo });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setEnviando(false);
    }
  }

  if (cargando)
    return <div className="min-h-screen grid place-items-center text-gray-400 text-sm">Cargando la liquidación…</div>;

  if (error && !datos)
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="max-w-md text-center">
          <div className="text-4xl mb-3">🔗</div>
          <h1 className="text-lg font-black text-[#0b315f] mb-1">Enlace no válido</h1>
          <p className="text-sm text-gray-500">{error}</p>
          <p className="text-xs text-gray-400 mt-4">Si el enlace le llegó por correo o WhatsApp, escríbanos y le enviamos uno nuevo.</p>
        </div>
      </div>
    );

  const yaRespondida = datos?.conformidad?.estado && datos.conformidad.estado !== "pendiente";

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Cabecera */}
      <div className="bg-[#0b315f] text-white">
        <div className="max-w-3xl mx-auto px-5 py-5">
          <p className="text-[11px] uppercase tracking-widest text-white/60">{datos.empresa}</p>
          <h1 className="text-xl font-black mt-1">{datos.titulo}</h1>
          <p className="text-sm text-white/70 mt-1">{datos.codigo} · {datos.periodo}</p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-5 py-6 grid gap-4">
        {/* Resumen */}
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b">
            <p className="text-xs font-black text-gray-400 uppercase tracking-wide">Resumen del periodo</p>
            <p className="font-bold text-[#0b315f] mt-1">{datos.contraparte}</p>
            {datos.area && <p className="text-sm text-gray-500">{datos.area}</p>}
          </div>
          <div className="divide-y">
            {datos.lineas.map((l: any, i: number) => (
              <div key={i} className="px-5 py-3 flex gap-3 items-start text-sm">
                <span className="flex-1 text-gray-700">{l.descripcion}</span>
                <span className="text-xs text-gray-400 whitespace-nowrap">{l.cantidad} × {fMoneda(l.precio, datos.moneda)}</span>
                <span className={`w-28 text-right font-bold ${l.total < 0 ? "text-red-600" : "text-gray-800"}`}>
                  {fMoneda(l.total, datos.moneda)}
                </span>
              </div>
            ))}
          </div>
          <div className="px-5 py-4 bg-gray-50 border-t">
            <div className="flex justify-between text-sm text-gray-500"><span>Subtotal</span><span>{fMoneda(datos.subtotal, datos.moneda)}</span></div>
            <div className="flex justify-between text-sm text-gray-500 mt-1"><span>IGV</span><span>{fMoneda(datos.igv, datos.moneda)}</span></div>
            <div className="flex justify-between text-lg font-black text-[#0b315f] mt-2 pt-2 border-t">
              <span>Total</span><span>{fMoneda(datos.total, datos.moneda)}</span>
            </div>
          </div>
        </div>

        {/* Documento completo */}
        <button onClick={() => setVerDoc((v) => !v)}
          className="bg-white rounded-2xl border shadow-sm px-5 py-4 text-left hover:bg-gray-50 transition">
          <p className="font-bold text-[#0b315f] text-sm">
            {verDoc ? "▲ Ocultar" : "▼ Ver"} el documento completo
            {datos.servicios ? <span className="font-normal text-gray-500"> — incluye el detalle de los {datos.servicios} servicios ejecutados</span> : null}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">Fecha, unidad, conductor y horas reales de cada servicio del periodo.</p>
        </button>

        {verDoc && (
          <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            {/* srcDoc + sandbox: el documento se ve tal cual se imprime, aislado de esta página. */}
            <iframe srcDoc={html} sandbox="allow-same-origin" className="w-full" style={{ height: "78vh", border: 0 }} title="Liquidación" />
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => {
                  const w = window.open("", "_blank");
                  if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 400); }
                }}
                className="px-4 py-2 rounded-xl text-sm font-bold bg-[#0b315f] text-white">
                Descargar / imprimir PDF
              </button>
            </div>
          </div>
        )}

        {/* Conformidad */}
        {listo ? (
          <div className="bg-white rounded-2xl border shadow-sm p-8 text-center">
            <div className="text-5xl mb-3">{listo.decision === "conforme" ? "✅" : "📝"}</div>
            <h2 className="text-lg font-black text-[#0b315f]">
              {listo.decision === "conforme" ? "¡Conformidad registrada!" : "Observación registrada"}
            </h2>
            <p className="text-sm text-gray-500 mt-2">
              {listo.decision === "conforme"
                ? `Gracias. Quedó registrada su conformidad de la liquidación ${listo.codigo}. Procederemos con la facturación del periodo.`
                : `Recibimos su observación de la liquidación ${listo.codigo}. Nuestro equipo la revisará y le enviaremos la versión corregida.`}
            </p>
          </div>
        ) : yaRespondida ? (
          <div className="bg-white rounded-2xl border shadow-sm p-6 text-center">
            <p className="font-bold text-[#0b315f]">
              Esta liquidación ya fue {datos.conformidad.estado === "conforme" ? "conformada" : "observada"}
            </p>
            <p className="text-sm text-gray-500 mt-1">
              Por {datos.conformidad.por}{datos.conformidad.fecha ? ` el ${datos.conformidad.fecha}` : ""}.
              {datos.conformidad.sello ? ` Sello ${datos.conformidad.sello}.` : ""}
            </p>
            {datos.conformidad.comentario && (
              <p className="text-sm text-gray-600 mt-3 bg-gray-50 rounded-xl p-3">“{datos.conformidad.comentario}”</p>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b">
              <p className="font-black text-[#0b315f]">Conformidad del servicio</p>
              <p className="text-xs text-gray-500 mt-0.5">Su respuesta queda registrada con fecha y hora, y se imprime en el formato.</p>
            </div>
            <div className="p-5 grid gap-4">
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => setDecision("conforme")}
                  className={`px-4 py-3 rounded-xl border-2 text-sm font-bold transition ${decision === "conforme" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
                  ✓ Doy conformidad
                </button>
                <button onClick={() => setDecision("observada")}
                  className={`px-4 py-3 rounded-xl border-2 text-sm font-bold transition ${decision === "observada" ? "border-amber-500 bg-amber-50 text-amber-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}>
                  ✎ Tengo una observación
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Nombre y apellido</label>
                  <input value={nombre} onChange={(e) => setNombre(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border text-sm" placeholder="Su nombre" />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Cargo</label>
                  <input value={cargo} onChange={(e) => setCargo(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border text-sm" placeholder="Su cargo" />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">
                  {decision === "conforme" ? "Comentario (opcional)" : "¿Qué debemos corregir?"}
                </label>
                <textarea value={comentario} onChange={(e) => setComentario(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border text-sm min-h-[80px]"
                  placeholder={decision === "conforme" ? "Alguna observación sobre el servicio del periodo…" : "Indíquenos qué línea o servicio debemos revisar"} />
              </div>

              {error && <div className="px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}

              <button onClick={responder} disabled={enviando}
                className={`w-full py-3 rounded-xl font-black text-white disabled:opacity-50 ${decision === "conforme" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"}`}>
                {enviando ? "Registrando…" : decision === "conforme" ? "Registrar mi conformidad" : "Enviar observación"}
              </button>
            </div>
          </div>
        )}

        <p className="text-center text-[11px] text-gray-400 pb-8">
          {datos.empresa} · Este enlace es personal y corresponde únicamente a la liquidación {datos.codigo}.
        </p>
      </div>
    </div>
  );
}
