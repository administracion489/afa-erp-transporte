"use client";
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// ── Tipos ────────────────────────────────────────────────────────────────────
type Canal = "whatsapp" | "email";
type Segmento = "todos" | "clientes" | "prospectos";

type Campana = {
  id: string;
  nombre: string;
  canal: Canal;
  plantilla: string | null;
  idioma: string | null;
  parametros: string[] | null;
  asunto: string | null;
  cuerpo: string | null;
  audiencia: { segmento?: Segmento } | null;
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
  borrador:  "bg-gray-100 text-gray-600",
  enviando:  "bg-blue-100 text-blue-700",
  enviada:   "bg-green-100 text-green-700",
  cancelada: "bg-red-100 text-red-700",
};

export default function CampanasPage() {
  const [campanas, setCampanas] = useState<Campana[]>([]);
  const [cargando, setCargando] = useState(true);
  const [faltaTabla, setFaltaTabla] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [ocupada, setOcupada] = useState<string | null>(null); // id de campaña en envío

  // Formulario nueva campaña
  const [nombre, setNombre] = useState("");
  const [canal, setCanal] = useState<Canal>("whatsapp");
  const [segmento, setSegmento] = useState<Segmento>("todos");
  const [plantilla, setPlantilla] = useState("");
  const [idioma, setIdioma] = useState("es");
  const [parametros, setParametros] = useState("{{nombre}}");
  const [asunto, setAsunto] = useState("");
  const [cuerpo, setCuerpo] = useState("");
  const [creando, setCreando] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);

  // Probador de los números oficiales
  const [telPrueba, setTelPrueba] = useState("");
  const [tplPrueba, setTplPrueba] = useState("hello_world");
  const [numPrueba, setNumPrueba] = useState<"avisos" | "crm">("avisos");
  const [probando, setProbando] = useState(false);
  const [resPrueba, setResPrueba] = useState<{ ok: boolean; texto: string } | null>(null);
  const [plantillasReales, setPlantillasReales] = useState<{ name: string; status: string; language: string; category: string }[] | null>(null);
  const [cargandoPlantillas, setCargandoPlantillas] = useState(false);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const cargar = useCallback(async () => {
    const { data, error } = await supabase
      .from("campanas")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) setFaltaTabla(true);
    else setCampanas((data ?? []) as Campana[]);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Conteo de audiencia elegible según canal + consentimiento + segmento.
  const contarAudiencia = useCallback(async () => {
    let q = supabase.from("crm_contactos").select("id", { count: "exact", head: true });
    if (segmento === "clientes")   q = q.not("cliente_id", "is", null);
    if (segmento === "prospectos") q = q.is("cliente_id", null);
    if (canal === "whatsapp") {
      q = q.not("wa_id", "is", null).eq("wa_opt_in", true).not("wa_baja", "is", true);
    } else {
      // email O gmail_email (igual que resolverAudiencia en el backend).
      q = q.or("email.not.is.null,gmail_email.not.is.null").not("email_baja", "is", true);
    }
    const { count } = await q;
    setPreview(count ?? 0);
  }, [canal, segmento]);

  useEffect(() => { if (!faltaTabla) contarAudiencia(); }, [contarAudiencia, faltaTabla]);

  const crear = async () => {
    if (!nombre.trim()) return showToast("Ponle un nombre a la campaña", false);
    if (canal === "whatsapp" && !plantilla.trim())
      return showToast("Indica el nombre de la plantilla aprobada en Meta", false);
    if (canal === "email" && (!asunto.trim() || !cuerpo.trim()))
      return showToast("El email necesita asunto y cuerpo", false);

    setCreando(true);
    const { error } = await supabase.from("campanas").insert({
      nombre: nombre.trim(),
      canal,
      plantilla: canal === "whatsapp" ? plantilla.trim() : null,
      idioma: canal === "whatsapp" ? idioma.trim() : null,
      parametros: canal === "whatsapp"
        ? parametros.split("\n").map((s) => s.trim()).filter(Boolean)
        : [],
      asunto: canal === "email" ? asunto.trim() : null,
      cuerpo: canal === "email" ? cuerpo : null,
      audiencia: { segmento },
      estado: "borrador",
    });
    setCreando(false);
    if (error) return showToast("Error al crear: " + error.message, false);
    setNombre(""); setPlantilla(""); setAsunto(""); setCuerpo("");
    showToast("Campaña creada como borrador");
    cargar();
  };

  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
  };

  // Drena en bucle llamando /api/campanas/procesar hasta agotar pendientes. Cada
  // lote es de ~40 (cabe en el límite de 60s de la función); refresca contadores.
  const drenar = async (campanaId: string) => {
    for (let i = 0; i < 500; i++) {
      const res = await fetch("/api/campanas/procesar", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ campana_id: campanaId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      await cargar();
      if ((j.restantes ?? 0) <= 0) return j;
      showToast(`Enviando… pendientes ${j.restantes}`);
    }
    return { restantes: 0 };
  };

  const probar = async () => {
    if (!telPrueba.trim()) return showToast("Pon un número para la prueba", false);
    setProbando(true);
    setResPrueba(null);
    try {
      const res = await fetch("/api/campanas/probar", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ telefono: telPrueba.trim(), plantilla: tplPrueba.trim(), numero: numPrueba }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      setResPrueba({ ok: true, texto: `✅ Enviado a ${j.enviadoA} desde ${j.desde} con la plantilla "${j.plantilla}" (${j.idioma}). ID: ${j.messageId}` });
    } catch (e: any) {
      setResPrueba({ ok: false, texto: `❌ ${e.message}` });
    } finally {
      setProbando(false);
    }
  };

  const verPlantillas = async () => {
    setCargandoPlantillas(true);
    setPlantillasReales(null);
    try {
      const res = await fetch(`/api/campanas/plantillas?numero=${numPrueba}`, { headers: await authHeaders() });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      setPlantillasReales(j.plantillas ?? []);
    } catch (e: any) {
      showToast("Error al listar plantillas: " + e.message, false);
    } finally {
      setCargandoPlantillas(false);
    }
  };

  const enviar = async (c: Campana) => {
    const destino = c.canal === "whatsapp" ? "WhatsApp" : "correo";
    if (!confirm(`¿Enviar la campaña "${c.nombre}" por ${destino}?\nEsto contacta a los destinatarios de verdad.`)) return;
    setOcupada(c.id);
    try {
      const res = await fetch("/api/campanas/enviar", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ campana_id: c.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      if (j.total === 0) {
        showToast("Audiencia vacía: nadie con consentimiento/canal válido", false);
      } else {
        await cargar();
        if ((j.restantes ?? 0) > 0) await drenar(c.id);
        showToast("Campaña enviada");
      }
    } catch (e: any) {
      showToast("Error: " + e.message, false);
    } finally {
      setOcupada(null);
      cargar();
    }
  };

  const continuar = async (c: Campana) => {
    setOcupada(c.id);
    try {
      await drenar(c.id);
      showToast("Campaña enviada");
    } catch (e: any) {
      showToast("Error: " + e.message, false);
    } finally {
      setOcupada(null);
      cargar();
    }
  };

  const cancelar = async (c: Campana) => {
    if (!confirm(`¿Cancelar la campaña "${c.nombre}"? Los envíos pendientes no se harán.`)) return;
    await supabase.from("campanas").update({ estado: "cancelada" }).eq("id", c.id);
    cargar();
  };

  if (cargando) return <div className="p-8 text-sm text-gray-400">Cargando…</div>;

  if (faltaTabla) {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-xl font-bold text-[#0b315f] mb-2">Campañas</h1>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          Falta crear las tablas. Ejecuta <code className="font-mono">supabase/avisos-2do-numero.sql</code> en
          el SQL Editor de Supabase y recarga.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-[#0b315f]">Campañas</h1>
        <p className="text-sm text-gray-500">Envíos masivos a contactos del CRM por WhatsApp o correo.</p>
      </div>

      {/* Nota de cumplimiento */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-5 text-[13px] text-blue-800 leading-relaxed">
        <strong>Las campañas salen del número del CRM (966707225)</strong>, el mismo por el que el contacto ya
        conversa contigo. Por política de Meta van <strong>solo a quienes te escribieron</strong> (tienen
        consentimiento); para prospectos en frío usa el canal <strong>Email</strong>. Quien responda “BAJA” deja de
        recibir automáticamente. El número de avisos (905438216) queda reservado a pasajeros y conductores.
      </div>

      {/* Probador de los números oficiales */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-6">
        <h2 className="text-sm font-bold text-gray-700 mb-1">Probar envío de WhatsApp</h2>
        <p className="text-xs text-gray-500 mb-4">
          Manda un WhatsApp de prueba desde cualquiera de tus dos números con API oficial. Usa{" "}
          <code className="font-mono">hello_world</code> (aprobada por defecto) para verificar la conexión
          antes de que Meta apruebe tus plantillas propias.
        </p>
        <div className="grid md:grid-cols-4 gap-3">
          <div>
            <label className={label}>Enviar desde</label>
            <select className={input} value={numPrueba} onChange={(e) => setNumPrueba(e.target.value as "avisos" | "crm")}>
              <option value="avisos">Avisos · 905438216</option>
              <option value="crm">CRM · 966707225</option>
            </select>
          </div>
          <div>
            <label className={label}>Número destino</label>
            <input className={input} value={telPrueba} onChange={(e) => setTelPrueba(e.target.value)} placeholder="987654321" />
          </div>
          <div>
            <label className={label}>Plantilla</label>
            <input className={input} value={tplPrueba} onChange={(e) => setTplPrueba(e.target.value)} placeholder="hello_world" />
          </div>
          <div className="flex items-end gap-2">
            <button
              onClick={probar}
              disabled={probando}
              className="flex-1 bg-green-600 text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-green-700 disabled:opacity-50"
            >
              {probando ? "Enviando…" : "Enviar prueba"}
            </button>
          </div>
        </div>
        <div className="mt-3">
          <button
            onClick={verPlantillas}
            disabled={cargandoPlantillas}
            className="text-xs font-semibold text-[#0b315f] underline disabled:opacity-50"
          >
            {cargandoPlantillas ? "Consultando Meta…" : `Ver plantillas reales de "${numPrueba === "crm" ? "CRM" : "Avisos"}"`}
          </button>
        </div>
        {resPrueba && (
          <div className={`mt-3 text-[13px] rounded-xl p-3 border ${resPrueba.ok ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"}`}>
            {resPrueba.texto}
          </div>
        )}
        {plantillasReales && (
          <div className="mt-3 border border-gray-200 rounded-xl overflow-hidden">
            {plantillasReales.length === 0 ? (
              <div className="p-3 text-[13px] text-gray-500">
                Esta cuenta no tiene NINGUNA plantilla todavía (ni siquiera hello_world). Hay que crear una en
                WhatsApp Manager y esperar su aprobación antes de poder enviar.
              </div>
            ) : (
              <table className="w-full text-[12px]">
                <thead className="bg-gray-50 text-gray-500">
                  <tr><th className="text-left p-2">Nombre</th><th className="text-left p-2">Idioma</th><th className="text-left p-2">Categoría</th><th className="text-left p-2">Estado</th></tr>
                </thead>
                <tbody>
                  {plantillasReales.map((p, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="p-2 font-mono">{p.name}</td>
                      <td className="p-2">{p.language}</td>
                      <td className="p-2">{p.category}</td>
                      <td className="p-2">{p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Nueva campaña */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-6">
        <h2 className="text-sm font-bold text-gray-700 mb-4">Nueva campaña</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className={label}>Nombre</label>
            <input className={input} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej: Promo julio" />
          </div>
          <div>
            <label className={label}>Canal</label>
            <select className={input} value={canal} onChange={(e) => setCanal(e.target.value as Canal)}>
              <option value="whatsapp">WhatsApp (plantilla)</option>
              <option value="email">Email</option>
            </select>
          </div>
          <div>
            <label className={label}>Segmento</label>
            <select className={input} value={segmento} onChange={(e) => setSegmento(e.target.value as Segmento)}>
              <option value="todos">Todos los contactos</option>
              <option value="clientes">Solo clientes</option>
              <option value="prospectos">Solo prospectos</option>
            </select>
          </div>
          <div className="flex items-end">
            <div className="text-sm text-gray-600">
              Audiencia elegible: <strong className="text-[#0b315f]">{preview ?? "…"}</strong> contacto(s)
            </div>
          </div>

          {canal === "whatsapp" ? (
            <>
              <div>
                <label className={label}>Plantilla aprobada (Meta)</label>
                <input className={input} value={plantilla} onChange={(e) => setPlantilla(e.target.value)} placeholder="nombre_de_plantilla" />
              </div>
              <div>
                <label className={label}>Idioma</label>
                <input className={input} value={idioma} onChange={(e) => setIdioma(e.target.value)} placeholder="es" />
              </div>
              <div className="md:col-span-2">
                <label className={label}>Variables de la plantilla (una por línea; usa {"{{nombre}}"} o {"{{empresa}}"})</label>
                <textarea className={input + " min-h-[70px] font-mono"} value={parametros} onChange={(e) => setParametros(e.target.value)} />
              </div>
            </>
          ) : (
            <>
              <div className="md:col-span-2">
                <label className={label}>Asunto</label>
                <input className={input} value={asunto} onChange={(e) => setAsunto(e.target.value)} placeholder="Novedades de AFA Transportes" />
              </div>
              <div className="md:col-span-2">
                <label className={label}>Cuerpo (HTML; usa {"{{nombre}}"} o {"{{empresa}}"})</label>
                <textarea className={input + " min-h-[120px]"} value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} />
              </div>
            </>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={crear}
            disabled={creando}
            className="bg-[#0b315f] text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-[#0a2a52] disabled:opacity-50"
          >
            {creando ? "Creando…" : "Crear borrador"}
          </button>
        </div>
      </div>

      {/* Lista */}
      <h2 className="text-sm font-bold text-gray-700 mb-3">Campañas ({campanas.length})</h2>
      <div className="space-y-3">
        {campanas.length === 0 && <div className="text-sm text-gray-400">Aún no hay campañas.</div>}
        {campanas.map((c) => {
          const pendientes = Math.max(0, (c.total ?? 0) - (c.enviados ?? 0) - (c.errores ?? 0) - (c.omitidos ?? 0));
          const busy = ocupada === c.id;
          return (
            <div key={c.id} className="bg-white border border-gray-200 rounded-2xl p-4 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[200px]">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-800 text-sm">{c.nombre}</span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${ESTADO_COLOR[c.estado] ?? "bg-gray-100 text-gray-600"}`}>{c.estado}</span>
                  <span className="text-[11px] text-gray-400">{c.canal === "whatsapp" ? "💬 WhatsApp" : "📧 Email"}</span>
                </div>
                <div className="text-[12px] text-gray-500 mt-1">
                  Total {c.total ?? 0} · ✅ {c.enviados ?? 0} · ⚠️ {c.errores ?? 0} · 🚫 {c.omitidos ?? 0}
                  {pendientes > 0 && <> · ⏳ {pendientes}</>}
                </div>
              </div>
              <div className="flex gap-2">
                {(c.estado === "borrador") && (
                  <button onClick={() => enviar(c)} disabled={busy}
                    className="bg-green-600 text-white text-xs font-semibold px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50">
                    {busy ? "Enviando…" : "Enviar"}
                  </button>
                )}
                {(c.estado === "enviando" && pendientes > 0) && (
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
