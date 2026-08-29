"use client";
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Destinatario = { id: number; nombre: string; funcion: string | null; telefono: string; activo: boolean; es_contingencia?: boolean };
type ModoTiempo = "evento" | "anticipacion" | "hora_fija";
type AlertaCfg = {
  clave: string; nombre: string; descripcion: string | null; activo: boolean;
  modo_tiempo: ModoTiempo; min_anticipacion: number | null; hora_fija: string | null; umbral: number | null;
  notifica_conductor: boolean; notifica_pasajero: boolean; notifica_conductor_tercero: boolean;
  destinatarios: number[]; plantilla: string | null;
  // Canales por tipo (supabase/canales-por-tipo.sql)
  canal_conductor_whatsapp: boolean; canal_conductor_email: boolean; canal_conductor_push: boolean;
  canal_pasajero_push: boolean;
  canal_pasajero_email: boolean; canal_pasajero_email_solo_sin_app: boolean;
  canal_pasajero_whatsapp: boolean; canal_pasajero_whatsapp_solo_sin_app: boolean;
  tiempo_editable: boolean;
};

// Columnas de canal que DEBEN viajar en el update. Si se olvida alguna, la casilla se
// marca en pantalla, el toast dice "Guardado" y no se guarda nada (fallo silencioso).
const COLS_CANAL = [
  "canal_conductor_whatsapp", "canal_conductor_email", "canal_conductor_push",
  "canal_pasajero_push", "canal_pasajero_email", "canal_pasajero_email_solo_sin_app",
  "canal_pasajero_whatsapp", "canal_pasajero_whatsapp_solo_sin_app",
] as const;

const input = "w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-[11px] font-semibold text-gray-500 mb-1";

// Etiqueta contextual del campo "umbral" según el tipo de alerta.
const UMBRAL_LABEL: Record<string, string> = {
  no_inicio: "Min. de gracia tras la hora",
  gps_silencio: "Min. sin señal",
  doc_vence: "Días de anticipación",
  jornada: "Horas máx. de jornada",
};

/** Chip on/off de un canal de envío. */
function Canal({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => set(!on)}
      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
        on ? "bg-[#0b315f] text-white border-[#0b315f]" : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100"
      }`}
    >
      {children}
    </button>
  );
}

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

  // Los canales ya NO son un bloque global: viven dentro de cada tipo de mensaje.
  // Si falta la migración, `faltaCanales` avisa en vez de fingir que se guarda.
  const [faltaCanales, setFaltaCanales] = useState(false);

  const showToast = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  const cargar = useCallback(async () => {
    const [c, d] = await Promise.all([
      supabase.from("alerta_config").select("*").order("clave"),
      supabase.from("alerta_destinatarios").select("*").order("id"),
    ]);
    if (c.error || d.error) { setFaltaTabla(true); setCargando(false); return; }
    const filas = (c.data ?? []) as any[];
    // ¿La migración de canales ya corrió? (columna presente en la primera fila)
    setFaltaCanales(filas.length > 0 && filas[0].canal_conductor_whatsapp === undefined);
    setCfgs(filas.map((x: any) => ({
      ...x,
      destinatarios: Array.isArray(x.destinatarios) ? x.destinatarios.map(Number) : [],
      // Defaults = comportamiento histórico, para que la UI no muestre todo apagado
      // si la migración aún no corrió.
      canal_conductor_whatsapp:             x.canal_conductor_whatsapp             ?? true,
      canal_conductor_email:                x.canal_conductor_email                ?? false,
      canal_conductor_push:                 x.canal_conductor_push                 ?? false,
      canal_pasajero_push:                  x.canal_pasajero_push                  ?? true,
      canal_pasajero_email:                 x.canal_pasajero_email                 ?? true,
      canal_pasajero_email_solo_sin_app:    x.canal_pasajero_email_solo_sin_app    ?? true,
      canal_pasajero_whatsapp:              x.canal_pasajero_whatsapp              ?? true,
      canal_pasajero_whatsapp_solo_sin_app: x.canal_pasajero_whatsapp_solo_sin_app ?? true,
      tiempo_editable:                      x.tiempo_editable                      ?? true,
      notifica_conductor_tercero:           x.notifica_conductor_tercero           ?? false,
    })));
    setDests(d.data ?? []);
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const setCfg = (clave: string, patch: Partial<AlertaCfg>) =>
    setCfgs((prev) => prev.map((c) => (c.clave === clave ? { ...c, ...patch } : c)));

  const guardarCfg = async (c: AlertaCfg) => {
    const canales = Object.fromEntries(COLS_CANAL.map((k) => [k, (c as any)[k] ?? false]));
    const { error } = await supabase.from("alerta_config").update({
      activo: c.activo, modo_tiempo: c.modo_tiempo,
      min_anticipacion: c.modo_tiempo === "anticipacion" ? (c.min_anticipacion ?? 90) : c.min_anticipacion,
      hora_fija: c.modo_tiempo === "hora_fija" ? (c.hora_fija ?? "08:00") : c.hora_fija,
      umbral: c.umbral, notifica_conductor: c.notifica_conductor, notifica_pasajero: c.notifica_pasajero,
      notifica_conductor_tercero: c.notifica_conductor_tercero ?? false,
      destinatarios: c.destinatarios, ...canales, updated_at: new Date().toISOString(),
    }).eq("clave", c.clave);
    showToast(error ? "Error al guardar" : `Guardado: ${c.nombre}`, !error);
  };


  // ── Editor de plantillas Meta (textos de los mensajes WhatsApp) ──
  type PlantillaMeta = { id: string; name: string; status: string; language: string; category: string; body: string; vars: number; botones: number };
  const [plantillas, setPlantillas] = useState<PlantillaMeta[] | null>(null);
  const [cargandoTpl, setCargandoTpl] = useState(false);
  const [guardandoTpl, setGuardandoTpl] = useState<string | null>(null);

  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
  };

  const cargarPlantillas = async () => {
    setCargandoTpl(true);
    try {
      const res = await fetch("/api/plantillas-meta?numero=avisos", { headers: await authHeaders() });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      setPlantillas(j.plantillas ?? []);
    } catch (e: any) {
      showToast("Error al cargar plantillas: " + e.message, false);
    } finally {
      setCargandoTpl(false);
    }
  };

  const setBodyTpl = (id: string, body: string) =>
    setPlantillas((prev) => (prev ?? []).map((t) => (t.id === id ? { ...t, body } : t)));

  const guardarPlantilla = async (t: PlantillaMeta) => {
    if (!confirm(`¿Enviar el nuevo texto de "${t.name}" a revisión de Meta?\nMientras esté en revisión, ese aviso no se enviará; al aprobarse vuelve a funcionar solo.`)) return;
    setGuardandoTpl(t.id);
    try {
      const res = await fetch("/api/plantillas-meta", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ id: t.id, body: t.body }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      showToast(j.mensaje ?? "Enviado a revisión");
      cargarPlantillas();
    } catch (e: any) {
      showToast(e.message, false);
    } finally {
      setGuardandoTpl(null);
    }
  };

  // ── Crear plantilla NUEVA (p.ej. el recordatorio de Check-out que aún no existe en Meta) ──
  type NuevaPlantilla = {
    name: string; category: "UTILITY" | "MARKETING"; body: string; ejemplos: string[];
    botonTexto: string; botonUrl: string; // botón de enlace ESTÁTICO (opcional; misma URL siempre)
  };
  const PLANTILLA_CHECKOUT: NuevaPlantilla = {
    name: "conductor_recuerda_checkout",
    category: "UTILITY",
    body: "Hola {{1}} 👋, ya terminaste tus servicios de hoy {{2}}. No olvides registrar tu *Check-out* en la app (kilometraje final y nivel de combustible) para cerrar tu jornada. Gracias por tu trabajo.",
    ejemplos: ["Carlos", "20/07"],
    botonTexto: "Abrir app conductor",
    botonUrl: "https://transportesafa.com/conductor",
  };
  // Asignación AGRUPADA: la usa el motor de alertas cuando a un mismo conductor se le
  // programan VARIOS servicios de una sentada (antes recibía un WhatsApp por cada uno).
  // Mientras no exista/esté aprobada, el motor cae solo a los mensajes de uno en uno,
  // así que crearla es opcional — sólo mejora el resultado.
  //
  // SIN botón: los de mapa son por servicio y aquí hay varios.
  // El teléfono NO puede ir en la última línea: Meta rechaza las plantillas cuyo cuerpo
  // TERMINA en variable. Por eso cierra la línea de la app, que es texto fijo.
  // {{4}} va en UNA línea con " • " de separador porque Meta rechaza los parámetros con
  // saltos de línea; los saltos que se ven en el mensaje son del texto fijo de abajo.
  const PLANTILLA_ASIGNACION_MULTIPLE: NuevaPlantilla = {
    name: "conductor_asignacion_multiple",
    category: "UTILITY",
    body: "Hola {{1}} 👋\n\n📋 *{{2}} servicios asignados* para el {{3}}\n\n{{4}}\n\n☎️ Coordinador de Operaciones: {{5}}\n📱 Ruta y detalle de cada servicio en la app AFA conductor.",
    ejemplos: [
      "Peter",
      "4",
      "viernes 28 de agosto",
      "1️⃣ 06:35 El Agustino → Punta Hermosa    2️⃣ 10:35 Primero de Mayo → Villa El Salvador",
      "+51 999 888 777",
    ],
    botonTexto: "",
    botonUrl: "",
  };

  const [nuevaTpl, setNuevaTpl] = useState<NuevaPlantilla | null>(null);
  const [creandoTpl, setCreandoTpl] = useState(false);
  const varsDe = (texto: string) => [...new Set((texto.match(/\{\{\s*\d+\s*\}\}/g) ?? []).map((v) => v.replace(/\s/g, "")))].sort();

  const crearPlantilla = async () => {
    if (!nuevaTpl) return;
    const vars = varsDe(nuevaTpl.body);
    const ejemplosOk = nuevaTpl.ejemplos.filter((e) => e.trim()).length;
    if (!nuevaTpl.name.trim()) { showToast("Falta el nombre de la plantilla", false); return; }
    if (vars.length !== ejemplosOk) { showToast(`Faltan ejemplos: la plantilla usa ${vars.length} variable(s)`, false); return; }
    if (nuevaTpl.botonUrl.trim() && !/^https?:\/\//i.test(nuevaTpl.botonUrl.trim())) {
      showToast("La URL del botón debe empezar con http:// o https://", false); return;
    }
    if (!confirm(`¿Crear la plantilla "${nuevaTpl.name}" en Meta?\nQuedará en revisión (minutos a horas) antes de poder enviarse.`)) return;
    setCreandoTpl(true);
    try {
      const res = await fetch("/api/plantillas-meta", {
        method: "POST", headers: await authHeaders(),
        body: JSON.stringify({
          accion: "crear", numero: "avisos", name: nuevaTpl.name, category: nuevaTpl.category, body: nuevaTpl.body, ejemplos: nuevaTpl.ejemplos,
          boton: nuevaTpl.botonTexto.trim() && nuevaTpl.botonUrl.trim() ? { texto: nuevaTpl.botonTexto.trim(), url: nuevaTpl.botonUrl.trim() } : null,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Error");
      showToast(j.mensaje ?? "Plantilla creada");
      setNuevaTpl(null);
      cargarPlantillas();
    } catch (e: any) {
      showToast(e.message, false);
    } finally {
      setCreandoTpl(false);
    }
  };

  const TPL_STATUS: Record<string, string> = {
    APPROVED: "bg-green-100 text-green-700", PENDING: "bg-amber-100 text-amber-700",
    IN_APPEAL: "bg-amber-100 text-amber-700", REJECTED: "bg-red-100 text-red-700",
    PAUSED: "bg-gray-200 text-gray-600",
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
    const { error } = await supabase.from("alerta_destinatarios").update({ nombre: d.nombre, funcion: d.funcion, telefono: d.telefono, activo: d.activo, es_contingencia: d.es_contingencia ?? false }).eq("id", d.id);
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

      {faltaCanales && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-sm text-amber-800">
          Los canales por tipo de mensaje aún no están activos en la base de datos. Ejecuta{" "}
          <code className="font-mono">supabase/canales-por-tipo.sql</code> en el SQL Editor de Supabase y recarga.
          Mientras tanto, los avisos siguen saliendo como hasta ahora.
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
              <label className="flex items-center gap-1 text-xs text-gray-600" title="Su número aparece en los mensajes al conductor como contacto de contingencia">
                <input type="checkbox" checked={d.es_contingencia ?? false} onChange={(e) => setDest(d.id, { es_contingencia: e.target.checked })} /> 🆘 Contingencia
              </label>
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
      <h2 className="text-sm font-bold text-gray-700 mb-1">Tipos de mensaje ({cfgs.length})</h2>
      <p className="text-xs text-gray-500 mb-3">
        Cada mensaje elige sus propios canales. <strong>“solo sin app”</strong> manda ese canal únicamente a quien
        no recibió la notificación push, para no avisarle tres veces a la misma persona. Al conductor, el correo
        y el push son <strong>aditivos</strong>: solo llegan a quien tenga correo registrado o la app con
        notificaciones activadas — el WhatsApp sigue siendo el canal que llega a todos.
      </p>
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
              {c.tiempo_editable && (
                <div>
                  <label className={label}>Cuándo</label>
                  <select className={input} value={c.modo_tiempo} onChange={(e) => setCfg(c.clave, { modo_tiempo: e.target.value as ModoTiempo })}>
                    <option value="evento">Al ocurrir (evento)</option>
                    <option value="anticipacion">Antes del servicio</option>
                    <option value="hora_fija">A una hora fija</option>
                  </select>
                </div>
              )}
              {c.tiempo_editable && c.modo_tiempo === "anticipacion" && (
                <div><label className={label}>Minutos antes</label>
                  <input type="number" className={input} value={c.min_anticipacion ?? 90} onChange={(e) => setCfg(c.clave, { min_anticipacion: Number(e.target.value) })} /></div>
              )}
              {c.tiempo_editable && c.modo_tiempo === "hora_fija" && (
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
              {c.notifica_conductor && (
                <label className="flex items-end gap-1 text-xs text-gray-600" title="Los conductores tercerizados son personal de otra empresa: este aviso solo les llega si lo activas aquí.">
                  <input type="checkbox" checked={c.notifica_conductor_tercero}
                    onChange={(e) => setCfg(c.clave, { notifica_conductor_tercero: e.target.checked })} /> Incluir tercerizados
                </label>
              )}
            </div>

            {/* Canales de ESTE tipo de mensaje */}
            {(c.notifica_conductor || c.notifica_pasajero) && (
              <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
                <label className={label}>¿Por dónde se envía?</label>

                {c.notifica_conductor && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-500 w-20 shrink-0">Conductor</span>
                    <Canal on={c.canal_conductor_whatsapp} set={(v) => setCfg(c.clave, { canal_conductor_whatsapp: v })}>💬 WhatsApp</Canal>
                    <Canal on={c.canal_conductor_email} set={(v) => setCfg(c.clave, { canal_conductor_email: v })}>📧 Correo</Canal>
                    <Canal on={c.canal_conductor_push} set={(v) => setCfg(c.clave, { canal_conductor_push: v })}>📲 Push</Canal>
                  </div>
                )}

                {c.notifica_pasajero && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-500 w-20 shrink-0">Pasajero</span>
                    <Canal on={c.canal_pasajero_push} set={(v) => setCfg(c.clave, { canal_pasajero_push: v })}>📲 Push</Canal>
                    <Canal on={c.canal_pasajero_email} set={(v) => setCfg(c.clave, { canal_pasajero_email: v })}>📧 Correo</Canal>
                    {c.canal_pasajero_email && (
                      <label className="flex items-center gap-1 text-[11px] text-gray-500">
                        <input type="checkbox" checked={c.canal_pasajero_email_solo_sin_app}
                          onChange={(e) => setCfg(c.clave, { canal_pasajero_email_solo_sin_app: e.target.checked })} />
                        solo sin app
                      </label>
                    )}
                    <Canal on={c.canal_pasajero_whatsapp} set={(v) => setCfg(c.clave, { canal_pasajero_whatsapp: v })}>💬 WhatsApp</Canal>
                    {c.canal_pasajero_whatsapp && (
                      <label className="flex items-center gap-1 text-[11px] text-gray-500">
                        <input type="checkbox" checked={c.canal_pasajero_whatsapp_solo_sin_app}
                          onChange={(e) => setCfg(c.clave, { canal_pasajero_whatsapp_solo_sin_app: e.target.checked })} />
                        solo sin app
                      </label>
                    )}
                  </div>
                )}
              </div>
            )}
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

      {/* Editor de textos de mensajes (plantillas Meta) */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 mt-6">
        <h2 className="text-sm font-bold text-gray-700 mb-1">Textos de los mensajes (WhatsApp)</h2>
        <p className="text-xs text-gray-500 mb-3">
          Edita aquí el texto de cada mensaje sin salir del ERP. <strong>Ojo:</strong> cada cambio pasa por la
          revisión de Meta (minutos a horas) y ese aviso <strong>no se envía mientras esté “PENDING”</strong>;
          al aprobarse vuelve a funcionar solo. Las variables <code className="font-mono">{"{{1}}"}, {"{{2}}"}…</code>{" "}
          no se pueden cambiar (el sistema pone los datos ahí): edita el texto alrededor de ellas.
        </p>
        {!plantillas ? (
          <button onClick={cargarPlantillas} disabled={cargandoTpl}
            className="text-sm font-semibold text-white bg-[#0b315f] px-4 py-2 rounded-lg disabled:opacity-50">
            {cargandoTpl ? "Consultando Meta…" : "Cargar plantillas desde Meta"}
          </button>
        ) : plantillas.length === 0 ? (
          <div className="text-xs text-gray-400">No hay plantillas en la cuenta de avisos todavía.</div>
        ) : (
          <div className="space-y-4">
            {plantillas.map((t) => (
              <div key={t.id} className="border border-gray-100 rounded-xl p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-mono text-xs font-bold text-[#0b315f]">{t.name}</span>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${TPL_STATUS[t.status] ?? "bg-gray-100 text-gray-600"}`}>{t.status}</span>
                  <span className="text-[10px] text-gray-400">{t.vars} variable(s){t.botones ? ` · ${t.botones} botón(es)` : ""}</span>
                </div>
                <textarea
                  className={input + " min-h-[110px] font-mono text-[13px]"}
                  value={t.body}
                  onChange={(e) => setBodyTpl(t.id, e.target.value)}
                />
                <div className="mt-2 flex justify-end">
                  <button onClick={() => guardarPlantilla(t)} disabled={guardandoTpl === t.id}
                    className="text-xs font-semibold text-white bg-[#0b315f] px-4 py-2 rounded-lg hover:bg-[#0a2a52] disabled:opacity-50">
                    {guardandoTpl === t.id ? "Enviando a Meta…" : "Guardar y enviar a revisión"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Crear plantilla NUEVA (no requiere entrar a Meta Business Manager) */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 mt-4">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <h2 className="text-sm font-bold text-gray-700">Crear plantilla nueva</h2>
          {!nuevaTpl && (
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => setNuevaTpl({ ...PLANTILLA_CHECKOUT })} className="text-xs font-semibold text-[#0b315f] hover:underline">
                Prellenar: recordatorio de Check-out
              </button>
              <button onClick={() => setNuevaTpl({ ...PLANTILLA_ASIGNACION_MULTIPLE })} className="text-xs font-semibold text-[#0b315f] hover:underline">
                Prellenar: varios servicios asignados
              </button>
            </div>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Crea una plantilla directamente en Meta sin salir del ERP. Queda en revisión (minutos a horas) antes de poder usarse.
        </p>
        {!nuevaTpl ? (
          <button onClick={() => setNuevaTpl({ name: "", category: "UTILITY", body: "", ejemplos: [], botonTexto: "", botonUrl: "" })}
            className="text-sm font-semibold text-white bg-[#0b315f] px-4 py-2 rounded-lg">
            + Nueva plantilla en blanco
          </button>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={label}>Nombre (minúsculas y guion bajo, sin espacios)</label>
              <input className={input + " font-mono"} value={nuevaTpl.name}
                onChange={(e) => setNuevaTpl((p) => p && { ...p, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
            </div>
            <div>
              <label className={label}>Categoría</label>
              <select className={input} value={nuevaTpl.category}
                onChange={(e) => setNuevaTpl((p) => p && { ...p, category: e.target.value as "UTILITY" | "MARKETING" })}>
                <option value="UTILITY">Utilidad (operativo, recomendado)</option>
                <option value="MARKETING">Marketing</option>
              </select>
            </div>
            <div>
              <label className={label}>Cuerpo del mensaje</label>
              <textarea className={input + " min-h-[110px] font-mono text-[13px]"} value={nuevaTpl.body}
                onChange={(e) => setNuevaTpl((p) => p && { ...p, body: e.target.value })} />
              <p className="text-[11px] text-gray-400 mt-1">Usa {"{{1}}"}, {"{{2}}"}… para los datos que pone el sistema (en el mismo orden en que los envía el código).</p>
            </div>
            {varsDe(nuevaTpl.body).length > 0 && (
              <div>
                <label className={label}>Ejemplos (uno por variable, en orden — Meta los pide para revisar)</label>
                <div className="flex gap-2 flex-wrap">
                  {varsDe(nuevaTpl.body).map((v, i) => (
                    <input key={v} className={input + " w-auto flex-1 min-w-[120px]"} placeholder={v}
                      value={nuevaTpl.ejemplos[i] ?? ""}
                      onChange={(e) => setNuevaTpl((p) => {
                        if (!p) return p;
                        const ej = [...p.ejemplos]; ej[i] = e.target.value;
                        return { ...p, ejemplos: ej };
                      })} />
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className={label}>Botón de enlace (opcional — mismo link para todos los envíos)</label>
              <div className="flex gap-2 flex-wrap">
                <input className={input + " w-auto flex-1 min-w-[160px]"} placeholder="Texto del botón (ej. Abrir app conductor)"
                  maxLength={25} value={nuevaTpl.botonTexto}
                  onChange={(e) => setNuevaTpl((p) => p && { ...p, botonTexto: e.target.value })} />
                <input className={input + " w-auto flex-1 min-w-[220px]"} placeholder="https://transportesafa.com/conductor"
                  value={nuevaTpl.botonUrl}
                  onChange={(e) => setNuevaTpl((p) => p && { ...p, botonUrl: e.target.value })} />
              </div>
              <p className="text-[11px] text-gray-400 mt-1">Deja ambos vacíos si no quieres botón. Máx. 25 caracteres en el texto (límite de Meta).</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setNuevaTpl(null)} className="text-xs font-semibold text-gray-500 px-4 py-2 rounded-lg hover:bg-gray-50">Cancelar</button>
              <button onClick={crearPlantilla} disabled={creandoTpl}
                className="text-xs font-semibold text-white bg-[#0b315f] px-4 py-2 rounded-lg hover:bg-[#0a2a52] disabled:opacity-50">
                {creandoTpl ? "Creando…" : "Crear y enviar a revisión"}
              </button>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl text-sm text-white shadow-lg ${toast.ok ? "bg-[#0b315f]" : "bg-red-600"}`}>{toast.msg}</div>
      )}
    </div>
  );
}
