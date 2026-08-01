"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ── Tipos ────────────────────────────────────────────────────────────────────
type Canal = "whatsapp" | "email";
type Adjunto = { url: string; nombre: string; tipo: string; esImagen: boolean };
type Cliente = { id: number; nombre: string | null; empresa: string | null; tipo: string | null };

type Comunicado = {
  id: string;
  titulo: string;
  cliente_id: number | null;
  canales: Canal[] | null;
  asunto: string | null;
  cuerpo_html: string | null;
  mensaje_wa: string | null;
  adjuntos: Adjunto[] | null;
  wa_pdf_url: string | null;
  solo_nomina_fija: boolean | null;
  estado: string;
  total: number;
  enviados: number;
  errores: number;
  omitidos: number;
  created_at: string;
};

const input =
  "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-xs font-semibold text-gray-500 mb-1.5";

const ESTADO_COLOR: Record<string, string> = {
  borrador: "bg-gray-100 text-gray-600",
  enviando: "bg-blue-100 text-blue-700",
  enviada: "bg-green-100 text-green-700",
  cancelada: "bg-red-100 text-red-700",
};

const nombreEmpresa = (c: Cliente | undefined) =>
  (c?.empresa || c?.nombre || `Cliente #${c?.id ?? ""}`).trim();

export default function ComunicadosPage() {
  const [comunicados, setComunicados] = useState<Comunicado[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [cargando, setCargando] = useState(true);
  const [faltaTabla, setFaltaTabla] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [ocupada, setOcupada] = useState<string | null>(null);

  // Formulario
  const [clienteId, setClienteId] = useState<string>("");
  const [titulo, setTitulo] = useState("");
  const [canales, setCanales] = useState<Canal[]>(["whatsapp", "email"]);
  const [asunto, setAsunto] = useState("");
  const [cuerpo, setCuerpo] = useState("");
  const [mensajeWa, setMensajeWa] = useState("");
  const [soloNominaFija, setSoloNominaFija] = useState(true);
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const [creando, setCreando] = useState(false);
  const [audiencia, setAudiencia] = useState<{ total: number; conTelefono: number; conCorreo: number } | null>(null);

  // Prueba (por comunicado)
  const [probarId, setProbarId] = useState<string | null>(null);
  const [probarCanal, setProbarCanal] = useState<Canal>("email");
  const [probarDestino, setProbarDestino] = useState("");
  const [probando, setProbando] = useState(false);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4500);
  };

  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
  };

  const cargar = useCallback(async () => {
    const [{ data: coms, error: e1 }, { data: cls }] = await Promise.all([
      supabase.from("comunicados").select("*").order("created_at", { ascending: false }),
      supabase.from("clientes").select("id, nombre, empresa, tipo").order("empresa", { ascending: true }),
    ]);
    if (e1) setFaltaTabla(true);
    else setComunicados((coms ?? []) as Comunicado[]);
    setClientes((cls ?? []) as Cliente[]);
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
    // Pre-selección de empresa vía ?cliente=<id> (atajo desde /clientes).
    const cid = new URLSearchParams(window.location.search).get("cliente");
    if (cid) setClienteId(cid);
  }, [cargar]);

  // Vista previa de audiencia (pasajeros con teléfono / correo).
  const refrescarAudiencia = useCallback(async () => {
    if (!clienteId) { setAudiencia(null); return; }
    try {
      const res = await fetch("/api/comunicados/audiencia", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ cliente_id: Number(clienteId), solo_nomina_fija: soloNominaFija }),
      });
      const j = await res.json();
      if (res.ok) setAudiencia(j);
    } catch { /* silencioso */ }
  }, [clienteId, soloNominaFija]);

  useEffect(() => { if (!faltaTabla) refrescarAudiencia(); }, [refrescarAudiencia, faltaTabla]);

  const toggleCanal = (c: Canal) =>
    setCanales((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  // ── Adjuntos → bucket público comunicados-media ────────────────────────────
  const subirAdjuntos = async (files: FileList | null) => {
    if (!files?.length) return;
    setSubiendo(true);
    try {
      const nuevos: Adjunto[] = [];
      for (const file of Array.from(files)) {
        const esImagen = file.type.startsWith("image/");
        const safe = file.name.replace(/[^\w.\-]+/g, "_");
        const path = `adjuntos/${Date.now()}-${safe}`;
        const { error } = await supabase.storage.from("comunicados-media").upload(path, file, {
          upsert: true, contentType: file.type || (esImagen ? "image/png" : "application/octet-stream"),
        });
        if (error) throw error;
        const { data } = supabase.storage.from("comunicados-media").getPublicUrl(path);
        nuevos.push({ url: data.publicUrl, nombre: file.name, tipo: file.type, esImagen });
      }
      setAdjuntos((prev) => [...prev, ...nuevos]);
    } catch (e: any) {
      showToast("Error al subir: " + (e.message ?? e), false);
    } finally {
      setSubiendo(false);
    }
  };

  const quitarAdjunto = (url: string) => setAdjuntos((prev) => prev.filter((a) => a.url !== url));

  const crear = async () => {
    if (!clienteId) return showToast("Elige la empresa cliente", false);
    if (!titulo.trim()) return showToast("Ponle un título al comunicado", false);
    if (canales.length === 0) return showToast("Elige al menos un canal", false);
    if (canales.includes("email") && (!asunto.trim() || !cuerpo.trim()))
      return showToast("El correo necesita asunto y cuerpo", false);
    if (canales.includes("whatsapp") && adjuntos.length === 0)
      return showToast("Para WhatsApp adjunta al menos una imagen o PDF (se envía como documento)", false);

    setCreando(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("comunicados").insert({
      titulo: titulo.trim(),
      cliente_id: Number(clienteId),
      canales,
      asunto: canales.includes("email") ? asunto.trim() : null,
      cuerpo_html: canales.includes("email") ? cuerpo : null,
      mensaje_wa: canales.includes("whatsapp") ? (mensajeWa.trim() || titulo.trim()) : null,
      adjuntos,
      solo_nomina_fija: soloNominaFija,
      estado: "borrador",
      creada_por: user?.id ?? null,
    });
    setCreando(false);
    if (error) return showToast("Error al crear: " + error.message, false);
    setTitulo(""); setAsunto(""); setCuerpo(""); setMensajeWa(""); setAdjuntos([]);
    showToast("Comunicado creado como borrador");
    cargar();
  };

  // ── Envío ──────────────────────────────────────────────────────────────────
  const drenar = async (id: string) => {
    for (let i = 0; i < 500; i++) {
      const res = await fetch("/api/comunicados/procesar", {
        method: "POST", headers: await authHeaders(), body: JSON.stringify({ comunicado_id: id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      await cargar();
      if ((j.restantes ?? 0) <= 0) return j;
      showToast(`Enviando… pendientes ${j.restantes}`);
    }
    return { restantes: 0 };
  };

  const enviar = async (c: Comunicado) => {
    const cli = clientes.find((x) => x.id === c.cliente_id);
    // Conteo real antes de confirmar.
    let resumen = "";
    try {
      const res = await fetch("/api/comunicados/audiencia", {
        method: "POST", headers: await authHeaders(),
        body: JSON.stringify({ cliente_id: c.cliente_id, solo_nomina_fija: c.solo_nomina_fija !== false }),
      });
      const j = await res.json();
      if (res.ok) {
        const partes: string[] = [];
        if ((c.canales ?? []).includes("whatsapp")) partes.push(`${j.conTelefono} por WhatsApp`);
        if ((c.canales ?? []).includes("email")) partes.push(`${j.conCorreo} por correo`);
        resumen = `\n\nSe enviará a ${j.total} pasajero(s) de ${nombreEmpresa(cli)}: ${partes.join(" y ")}.`;
      }
    } catch { /* usa confirmación genérica */ }

    if (!confirm(`¿Enviar el comunicado "${c.titulo}"?${resumen}\n\nEsto contacta a los pasajeros de verdad.`)) return;

    setOcupada(c.id);
    try {
      const res = await fetch("/api/comunicados/enviar", {
        method: "POST", headers: await authHeaders(), body: JSON.stringify({ comunicado_id: c.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      if (j.total === 0) {
        showToast("Audiencia vacía: ningún pasajero con teléfono/correo", false);
      } else {
        await cargar();
        if ((j.restantes ?? 0) > 0) await drenar(c.id);
        showToast("Comunicado enviado");
      }
    } catch (e: any) {
      showToast("Error: " + e.message, false);
    } finally {
      setOcupada(null);
      cargar();
    }
  };

  const continuar = async (c: Comunicado) => {
    setOcupada(c.id);
    try { await drenar(c.id); showToast("Comunicado enviado"); }
    catch (e: any) { showToast("Error: " + e.message, false); }
    finally { setOcupada(null); cargar(); }
  };

  const cancelar = async (c: Comunicado) => {
    if (!confirm(`¿Cancelar "${c.titulo}"? Los envíos pendientes no se harán.`)) return;
    await supabase.from("comunicados").update({ estado: "cancelada" }).eq("id", c.id);
    cargar();
  };

  const probar = async (c: Comunicado) => {
    if (!probarDestino.trim()) return showToast("Pon un número o correo de prueba", false);
    setProbando(true);
    try {
      const res = await fetch("/api/comunicados/probar", {
        method: "POST", headers: await authHeaders(),
        body: JSON.stringify({ comunicado_id: c.id, canal: probarCanal, destino: probarDestino.trim() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      showToast(`Prueba enviada por ${probarCanal === "whatsapp" ? "WhatsApp" : "correo"} a ${probarDestino.trim()}`);
      setProbarId(null); setProbarDestino("");
    } catch (e: any) {
      showToast("Prueba falló: " + e.message, false);
    } finally {
      setProbando(false);
    }
  };

  const clientesOrdenados = useMemo(
    () => [...clientes].sort((a, b) => nombreEmpresa(a).localeCompare(nombreEmpresa(b))),
    [clientes],
  );

  if (cargando) return <div className="p-8 text-sm text-gray-400">Cargando…</div>;

  if (faltaTabla) {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-xl font-bold text-[#0b315f] mb-2">Comunicados</h1>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          Falta crear las tablas. Ejecuta <code className="font-mono">supabase/comunicados.sql</code> en el
          SQL Editor de Supabase y recarga.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-[#0b315f]">Comunicados</h1>
        <p className="text-sm text-gray-500">Envíos masivos por WhatsApp y correo a los pasajeros de una empresa cliente.</p>
      </div>

      {/* Nota WhatsApp / Meta */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-5 text-[13px] text-blue-800 leading-relaxed">
        El <strong>correo</strong> funciona de inmediato (cuadros incrustados + PDF adjunto). El <strong>WhatsApp</strong> sale
        del número de avisos como un documento PDF y requiere una <strong>plantilla aprobada por Meta con encabezado de documento</strong>
        {" "}(por defecto <code className="font-mono">comunicado_afa</code>). Mientras Meta la aprueba, usa solo el canal correo.
      </div>

      {/* Nuevo comunicado */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-6">
        <h2 className="text-sm font-bold text-gray-700 mb-4">Nuevo comunicado</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className={label}>Empresa cliente</label>
            <select className={input} value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
              <option value="">— Elegir empresa —</option>
              {clientesOrdenados.map((c) => (
                <option key={c.id} value={c.id}>{nombreEmpresa(c)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Título (interno)</label>
            <input className={input} value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ej: Horarios de paraderos — julio" />
          </div>

          <div className="md:col-span-2 flex flex-wrap items-center gap-4">
            <span className={label + " mb-0"}>Canales:</span>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={canales.includes("whatsapp")} onChange={() => toggleCanal("whatsapp")} /> 💬 WhatsApp
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={canales.includes("email")} onChange={() => toggleCanal("email")} /> 📧 Correo
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 ml-auto">
              <input type="checkbox" checked={soloNominaFija} onChange={(e) => setSoloNominaFija(e.target.checked)} /> Solo nómina fija
            </label>
          </div>

          {canales.includes("email") && (
            <>
              <div className="md:col-span-2">
                <label className={label}>Asunto del correo</label>
                <input className={input} value={asunto} onChange={(e) => setAsunto(e.target.value)} placeholder="Horarios de sus paraderos — AFA Transportes" />
              </div>
              <div className="md:col-span-2">
                <label className={label}>Cuerpo del correo (HTML; usa {"{{nombre}}"} o {"{{empresa}}"})</label>
                <textarea className={input + " min-h-[120px]"} value={cuerpo} onChange={(e) => setCuerpo(e.target.value)}
                  placeholder="<p>Estimado(a) {{nombre}},</p><p>Compartimos los horarios actualizados de sus paraderos:</p>" />
                <p className="text-[11px] text-gray-400 mt-1">Los cuadros que subas se incrustan automáticamente debajo del cuerpo.</p>
              </div>
            </>
          )}

          {canales.includes("whatsapp") && (
            <div className="md:col-span-2">
              <label className={label}>Mensaje de WhatsApp (variable {"{{2}}"} de la plantilla)</label>
              <textarea className={input + " min-h-[70px]"} value={mensajeWa} onChange={(e) => setMensajeWa(e.target.value)}
                placeholder="Le compartimos los horarios actualizados de sus paraderos. Cualquier consulta, responda este mensaje." />
            </div>
          )}

          {/* Adjuntos */}
          <div className="md:col-span-2">
            <label className={label}>Adjuntos (los cuadros de horario — imágenes y/o PDF)</label>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="cursor-pointer bg-gray-50 border border-dashed border-gray-300 rounded-xl px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-100">
                {subiendo ? "Subiendo…" : "＋ Agregar archivos"}
                <input type="file" multiple accept="image/*,application/pdf" className="hidden"
                  onChange={(e) => subirAdjuntos(e.target.files)} disabled={subiendo} />
              </label>
              {adjuntos.length === 0 && <span className="text-[12px] text-gray-400">Ninguno aún</span>}
            </div>
            {adjuntos.length > 0 && (
              <div className="flex flex-wrap gap-3 mt-3">
                {adjuntos.map((a) => (
                  <div key={a.url} className="relative border border-gray-200 rounded-xl p-2 w-28 text-center">
                    {a.esImagen
                      ? <img src={a.url} alt={a.nombre} className="w-full h-20 object-cover rounded-lg" />
                      : <div className="w-full h-20 flex items-center justify-center bg-red-50 rounded-lg text-red-500 text-xs font-bold">PDF</div>}
                    <div className="text-[10px] text-gray-500 truncate mt-1" title={a.nombre}>{a.nombre}</div>
                    <button onClick={() => quitarAdjunto(a.url)} className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-5 h-5 text-xs leading-none">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Vista previa de audiencia */}
          <div className="md:col-span-2 text-sm text-gray-600">
            {clienteId ? (
              audiencia
                ? <>Audiencia: <strong className="text-[#0b315f]">{audiencia.total}</strong> pasajero(s) · <strong>{audiencia.conTelefono}</strong> con teléfono · <strong>{audiencia.conCorreo}</strong> con correo</>
                : <>Calculando audiencia…</>
            ) : <span className="text-gray-400">Elige una empresa para ver la audiencia.</span>}
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button onClick={crear} disabled={creando || subiendo}
            className="bg-[#0b315f] text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-[#0a2a52] disabled:opacity-50">
            {creando ? "Creando…" : "Crear borrador"}
          </button>
        </div>
      </div>

      {/* Lista */}
      <h2 className="text-sm font-bold text-gray-700 mb-3">Comunicados ({comunicados.length})</h2>
      <div className="space-y-3">
        {comunicados.length === 0 && <div className="text-sm text-gray-400">Aún no hay comunicados.</div>}
        {comunicados.map((c) => {
          const cli = clientes.find((x) => x.id === c.cliente_id);
          const pendientes = Math.max(0, (c.total ?? 0) - (c.enviados ?? 0) - (c.errores ?? 0) - (c.omitidos ?? 0));
          const busy = ocupada === c.id;
          const cnl = c.canales ?? [];
          return (
            <div key={c.id} className="bg-white border border-gray-200 rounded-2xl p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-800 text-sm">{c.titulo}</span>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${ESTADO_COLOR[c.estado] ?? "bg-gray-100 text-gray-600"}`}>{c.estado}</span>
                    <span className="text-[11px] text-gray-400">{nombreEmpresa(cli)}</span>
                    <span className="text-[11px] text-gray-400">{cnl.includes("whatsapp") && "💬"} {cnl.includes("email") && "📧"}</span>
                  </div>
                  <div className="text-[12px] text-gray-500 mt-1">
                    Total {c.total ?? 0} · ✅ {c.enviados ?? 0} · ⚠️ {c.errores ?? 0} · 🚫 {c.omitidos ?? 0}
                    {pendientes > 0 && <> · ⏳ {pendientes}</>}
                    {(c.adjuntos?.length ?? 0) > 0 && <> · 📎 {c.adjuntos!.length}</>}
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {(c.estado === "borrador" || c.estado === "enviando") && (
                    <button onClick={() => { setProbarId(probarId === c.id ? null : c.id); setProbarDestino(""); }}
                      className="border border-gray-200 text-gray-600 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-gray-50">
                      Probar
                    </button>
                  )}
                  {c.estado === "borrador" && (
                    <button onClick={() => enviar(c)} disabled={busy}
                      className="bg-green-600 text-white text-xs font-semibold px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50">
                      {busy ? "Enviando…" : "Enviar"}
                    </button>
                  )}
                  {c.estado === "enviando" && pendientes > 0 && (
                    <button onClick={() => continuar(c)} disabled={busy}
                      className="bg-blue-600 text-white text-xs font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                      {busy ? "Procesando…" : `Continuar (${pendientes})`}
                    </button>
                  )}
                  {(c.estado === "borrador" || c.estado === "enviando") && (
                    <button onClick={() => cancelar(c)} disabled={busy}
                      className="border border-gray-200 text-gray-500 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-gray-50">
                      Cancelar
                    </button>
                  )}
                </div>
              </div>

              {/* Panel de prueba */}
              {probarId === c.id && (
                <div className="mt-3 border-t border-gray-100 pt-3 flex flex-wrap items-end gap-2">
                  <div>
                    <label className={label}>Canal</label>
                    <select className={input + " w-40"} value={probarCanal} onChange={(e) => setProbarCanal(e.target.value as Canal)}>
                      {cnl.includes("email") && <option value="email">📧 Correo</option>}
                      {cnl.includes("whatsapp") && <option value="whatsapp">💬 WhatsApp</option>}
                    </select>
                  </div>
                  <div className="flex-1 min-w-[200px]">
                    <label className={label}>{probarCanal === "whatsapp" ? "Número de prueba" : "Correo de prueba"}</label>
                    <input className={input} value={probarDestino} onChange={(e) => setProbarDestino(e.target.value)}
                      placeholder={probarCanal === "whatsapp" ? "987654321" : "tucorreo@ejemplo.com"} />
                  </div>
                  <button onClick={() => probar(c)} disabled={probando}
                    className="bg-[#0b315f] text-white text-xs font-semibold px-4 py-2.5 rounded-lg hover:bg-[#0a2a52] disabled:opacity-50">
                    {probando ? "Enviando…" : "Enviar prueba"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl text-sm text-white shadow-lg ${toast.ok ? "bg-[#0b315f]" : "bg-red-600"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
