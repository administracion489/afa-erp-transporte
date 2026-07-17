"use client";
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Destinatario = { id: number; nombre: string; funcion: string | null; telefono: string; activo: boolean };
type ModoTiempo = "evento" | "anticipacion" | "hora_fija";
type AlertaCfg = {
  clave: string; nombre: string; descripcion: string | null; activo: boolean;
  modo_tiempo: ModoTiempo; min_anticipacion: number | null; hora_fija: string | null; umbral: number | null;
  notifica_conductor: boolean; notifica_pasajero: boolean; destinatarios: number[]; plantilla: string | null;
};

const input = "w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-[11px] font-semibold text-gray-500 mb-1";

// Etiqueta contextual del campo "umbral" según el tipo de alerta.
const UMBRAL_LABEL: Record<string, string> = {
  no_inicio: "Min. de gracia tras la hora",
  gps_silencio: "Min. sin señal",
  doc_vence: "Días de anticipación",
  jornada: "Horas máx. de jornada",
};

export default function ConfigOperacionesPage() {
  const [cfgs, setCfgs] = useState<AlertaCfg[]>([]);
  const [dests, setDests] = useState<Destinatario[]>([]);
  const [cargando, setCargando] = useState(true);
  const [faltaTabla, setFaltaTabla] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Alta de destinatario
  const [nNombre, setNNombre] = useState("");
  const [nFuncion, setNFuncion] = useState("");
  const [nTel, setNTel] = useState("");

  // Canales del pasajero (anti-spam)
  type Canales = { push_activo: boolean; email_activo: boolean; email_solo_sin_app: boolean; whatsapp_activo: boolean; whatsapp_solo_sin_app: boolean };
  const [canales, setCanales] = useState<Canales | null>(null);

  const showToast = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  const cargar = useCallback(async () => {
    const [c, d, ca] = await Promise.all([
      supabase.from("alerta_config").select("*").order("clave"),
      supabase.from("alerta_destinatarios").select("*").order("id"),
      supabase.from("config_canales").select("*").eq("id", 1).maybeSingle(),
    ]);
    if (c.error || d.error) { setFaltaTabla(true); setCargando(false); return; }
    setCfgs((c.data ?? []).map((x: any) => ({ ...x, destinatarios: Array.isArray(x.destinatarios) ? x.destinatarios.map(Number) : [] })));
    setDests(d.data ?? []);
    if (ca.data) setCanales(ca.data as Canales);
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const setCfg = (clave: string, patch: Partial<AlertaCfg>) =>
    setCfgs((prev) => prev.map((c) => (c.clave === clave ? { ...c, ...patch } : c)));

  const guardarCfg = async (c: AlertaCfg) => {
    const { error } = await supabase.from("alerta_config").update({
      activo: c.activo, modo_tiempo: c.modo_tiempo,
      min_anticipacion: c.modo_tiempo === "anticipacion" ? (c.min_anticipacion ?? 90) : c.min_anticipacion,
      hora_fija: c.modo_tiempo === "hora_fija" ? (c.hora_fija ?? "08:00") : c.hora_fija,
      umbral: c.umbral, notifica_conductor: c.notifica_conductor, notifica_pasajero: c.notifica_pasajero,
      destinatarios: c.destinatarios, updated_at: new Date().toISOString(),
    }).eq("clave", c.clave);
    showToast(error ? "Error al guardar" : `Guardado: ${c.nombre}`, !error);
  };

  const setCanal = (patch: Partial<Canales>) => setCanales((c) => (c ? { ...c, ...patch } : c));
  const guardarCanales = async () => {
    if (!canales) return;
    const { error } = await supabase.from("config_canales").update({ ...canales, updated_at: new Date().toISOString() }).eq("id", 1);
    showToast(error ? "Error al guardar" : "Canales guardados", !error);
  };

  const toggleDest = (c: AlertaCfg, id: number) => {
    const set = new Set(c.destinatarios);
    set.has(id) ? set.delete(id) : set.add(id);
    setCfg(c.clave, { destinatarios: [...set] });
  };

  const agregarDest = async () => {
    if (!nNombre.trim() || !nTel.trim()) return showToast("Nombre y teléfono son obligatorios", false);
    const { error } = await supabase.from("alerta_destinatarios").insert({ nombre: nNombre.trim(), funcion: nFuncion.trim() || null, telefono: nTel.trim(), activo: true });
    if (error) return showToast("Error: " + error.message, false);
    setNNombre(""); setNFuncion(""); setNTel(""); showToast("Contacto agregado"); cargar();
  };
  const guardarDest = async (d: Destinatario) => {
    const { error } = await supabase.from("alerta_destinatarios").update({ nombre: d.nombre, funcion: d.funcion, telefono: d.telefono, activo: d.activo }).eq("id", d.id);
    showToast(error ? "Error al guardar" : "Contacto actualizado", !error);
  };
  const borrarDest = async (id: number) => {
    if (!confirm("¿Eliminar este contacto de las alertas?")) return;
    await supabase.from("alerta_destinatarios").delete().eq("id", id);
    cargar();
  };
  const setDest = (id: number, patch: Partial<Destinatario>) => setDests((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  if (cargando) return <div className="p-8 text-sm text-gray-400">Cargando…</div>;
  if (faltaTabla) return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-xl font-bold text-[#0b315f] mb-2">Alertas Operativas</h1>
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        Falta crear las tablas. Ejecuta <code className="font-mono">supabase/alertas-operativas.sql</code> en el SQL Editor de Supabase y recarga.
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-[#0b315f]">Centro de mensajes y alertas</h1>
        <p className="text-sm text-gray-500">Controla qué avisos se envían, cuándo, y a quién.</p>
      </div>

      {/* Canales del pasajero (anti-spam) */}
      {canales && (
        <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-6">
          <h2 className="text-sm font-bold text-gray-700 mb-1">Canales de aviso al pasajero</h2>
          <p className="text-xs text-gray-500 mb-4">
            Evita el spam de 3 canales. Con <strong>“solo si no tiene la app”</strong>, ese canal se manda únicamente a quien
            no tenga la app instalada. Recomendado: con app → solo notificación push; sin app → email y/o WhatsApp.
          </p>
          <div className="space-y-2 text-sm text-gray-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={canales.push_activo} onChange={(e) => setCanal({ push_activo: e.target.checked })} />
              <span className="font-semibold">📲 Push (app)</span> <span className="text-gray-400 text-xs">— el canal principal, gratis e instantáneo</span>
            </label>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={canales.email_activo} onChange={(e) => setCanal({ email_activo: e.target.checked })} />
                <span className="font-semibold">📧 Email</span>
              </label>
              <label className="flex items-center gap-1 text-xs text-gray-500">
                <input type="checkbox" checked={canales.email_solo_sin_app} disabled={!canales.email_activo} onChange={(e) => setCanal({ email_solo_sin_app: e.target.checked })} />
                solo si no tiene la app
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={canales.whatsapp_activo} onChange={(e) => setCanal({ whatsapp_activo: e.target.checked })} />
                <span className="font-semibold">💬 WhatsApp</span>
              </label>
              <label className="flex items-center gap-1 text-xs text-gray-500">
                <input type="checkbox" checked={canales.whatsapp_solo_sin_app} disabled={!canales.whatsapp_activo} onChange={(e) => setCanal({ whatsapp_solo_sin_app: e.target.checked })} />
                solo si no tiene la app
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button onClick={guardarCanales} className="text-xs font-semibold text-white bg-[#0b315f] px-4 py-2 rounded-lg hover:bg-[#0a2a52]">Guardar canales</button>
          </div>
        </div>
      )}

      {/* Directorio de contactos */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-6">
        <h2 className="text-sm font-bold text-gray-700 mb-1">Directorio de contactos</h2>
        <p className="text-xs text-gray-500 mb-4">Personal que recibe alertas según su función. Estos números se eligen luego en cada tipo de mensaje.</p>
        <div className="space-y-2 mb-4">
          {dests.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2">
              <input className={input + " flex-1 min-w-[140px]"} value={d.nombre} onChange={(e) => setDest(d.id, { nombre: e.target.value })} placeholder="Nombre" />
              <input className={input + " flex-1 min-w-[140px]"} value={d.funcion ?? ""} onChange={(e) => setDest(d.id, { funcion: e.target.value })} placeholder="Función (ej: Coord. Operaciones)" />
              <input className={input + " w-32"} value={d.telefono} onChange={(e) => setDest(d.id, { telefono: e.target.value })} placeholder="987654321" />
              <label className="flex items-center gap-1 text-xs text-gray-600"><input type="checkbox" checked={d.activo} onChange={(e) => setDest(d.id, { activo: e.target.checked })} /> Activo</label>
              <button onClick={() => guardarDest(d)} className="text-xs font-semibold text-white bg-[#0b315f] px-3 py-1.5 rounded-lg">Guardar</button>
              <button onClick={() => borrarDest(d.id)} className="text-xs text-red-500 px-2">✕</button>
            </div>
          ))}
          {dests.length === 0 && <div className="text-xs text-gray-400">Aún no hay contactos.</div>}
        </div>
        <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-4">
          <div className="flex-1 min-w-[140px]"><label className={label}>Nombre</label><input className={input} value={nNombre} onChange={(e) => setNNombre(e.target.value)} /></div>
          <div className="flex-1 min-w-[140px]"><label className={label}>Función</label><input className={input} value={nFuncion} onChange={(e) => setNFuncion(e.target.value)} placeholder="Coordinador de Operaciones" /></div>
          <div className="w-32"><label className={label}>WhatsApp</label><input className={input} value={nTel} onChange={(e) => setNTel(e.target.value)} placeholder="987654321" /></div>
          <button onClick={agregarDest} className="text-sm font-semibold text-white bg-green-600 px-4 py-2 rounded-lg hover:bg-green-700">+ Agregar</button>
        </div>
      </div>

      {/* Configuración por tipo de mensaje */}
      <h2 className="text-sm font-bold text-gray-700 mb-3">Tipos de mensaje ({cfgs.length})</h2>
      <div className="space-y-3">
        {cfgs.map((c) => (
          <div key={c.clave} className="bg-white border border-gray-200 rounded-2xl p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <span className="font-semibold text-gray-800 text-sm">{c.nombre}</span>
                {c.descripcion && <p className="text-[12px] text-gray-500">{c.descripcion}</p>}
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold shrink-0">
                <input type="checkbox" checked={c.activo} onChange={(e) => setCfg(c.clave, { activo: e.target.checked })} />
                <span className={c.activo ? "text-green-600" : "text-gray-400"}>{c.activo ? "Activo" : "Inactivo"}</span>
              </label>
            </div>
            <div className="grid md:grid-cols-4 gap-3">
              <div>
                <label className={label}>Cuándo</label>
                <select className={input} value={c.modo_tiempo} onChange={(e) => setCfg(c.clave, { modo_tiempo: e.target.value as ModoTiempo })}>
                  <option value="evento">Al ocurrir (evento)</option>
                  <option value="anticipacion">Antes del servicio</option>
                  <option value="hora_fija">A una hora fija</option>
                </select>
              </div>
              {c.modo_tiempo === "anticipacion" && (
                <div><label className={label}>Minutos antes</label>
                  <input type="number" className={input} value={c.min_anticipacion ?? 90} onChange={(e) => setCfg(c.clave, { min_anticipacion: Number(e.target.value) })} /></div>
              )}
              {c.modo_tiempo === "hora_fija" && (
                <div><label className={label}>Hora (HH:MM)</label>
                  <input type="time" className={input} value={c.hora_fija ?? "08:00"} onChange={(e) => setCfg(c.clave, { hora_fija: e.target.value })} /></div>
              )}
              {UMBRAL_LABEL[c.clave] && (
                <div><label className={label}>{UMBRAL_LABEL[c.clave]}</label>
                  <input type="number" className={input} value={c.umbral ?? 0} onChange={(e) => setCfg(c.clave, { umbral: Number(e.target.value) })} /></div>
              )}
              <div className="flex items-end gap-3 text-xs text-gray-600">
                <label className="flex items-center gap-1"><input type="checkbox" checked={c.notifica_conductor} onChange={(e) => setCfg(c.clave, { notifica_conductor: e.target.checked })} /> Conductor</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={c.notifica_pasajero} onChange={(e) => setCfg(c.clave, { notifica_pasajero: e.target.checked })} /> Pasajero</label>
              </div>
            </div>
            {dests.length > 0 && (
              <div className="mt-3">
                <label className={label}>También avisar a (directorio):</label>
                <div className="flex flex-wrap gap-2">
                  {dests.filter((d) => d.activo).map((d) => (
                    <label key={d.id} className={`text-xs px-2.5 py-1 rounded-full border cursor-pointer ${c.destinatarios.includes(d.id) ? "bg-[#0b315f] text-white border-[#0b315f]" : "bg-gray-50 text-gray-600 border-gray-200"}`}>
                      <input type="checkbox" className="hidden" checked={c.destinatarios.includes(d.id)} onChange={() => toggleDest(c, d.id)} />
                      {d.nombre}{d.funcion ? ` · ${d.funcion}` : ""}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <button onClick={() => guardarCfg(c)} className="text-xs font-semibold text-white bg-[#0b315f] px-4 py-2 rounded-lg hover:bg-[#0a2a52]">Guardar</button>
            </div>
          </div>
        ))}
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl text-sm text-white shadow-lg ${toast.ok ? "bg-[#0b315f]" : "bg-red-600"}`}>{toast.msg}</div>
      )}
    </div>
  );
}
