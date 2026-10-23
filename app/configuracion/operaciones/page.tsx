"use client";
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
// Módulo PURO (no lee la base): la frase y el aviso salen de los MISMOS números que usa
// el motor del tick, para que la pantalla no pueda describir la ventana al revés.
import { MARGEN_URGENTE_MIN, describirHorario, hhmmAMinutos, ventanaCubreMadrugada, ventanaPorDefecto } from "@/lib/alertas-horario";
// La MISMA tabla que usa el tick para decidir qué modo aplica a qué aviso: el motor importa
// de ahí sus dos predicados. Sin eso, el guard que existe para que la pantalla no mienta
// tendría su propia copia y sería el primero en quedarse atrás.
import { cotejarModoTiempo, leeElDirectorio, leeElModo, type ModoTiempo } from "@/lib/alertas-modo-tiempo";
import PruebaAvisos from "./PruebaAvisos";
import { TEXTO_ESTADO, plantillasQueUsa, revisarPlantillas } from "@/lib/plantillas-usadas";
// La llamada de la central propia: su tarjeta no tiene canales de mensaje, tiene una central.
import { CLAVE_LLAMADA, estadoCentral } from "@/lib/llamadas-central";
// Las plantillas que las alertas usan y que hay que crear en Meta: el texto y sus variables en el
// orden en que el motor las manda.
import { SUGERIDA_COORDINADOR_ALERTA, SUGERIDA_NO_INICIO, SUGERIDA_RECUERDA_INICIAR } from "@/lib/plantillas-sugeridas";
// QUÉ DICE Y QUÉ OFRECE CADA TARJETA, derivado de lo que el motor hace (13-10-2026): la descripción
// sembrada por SQL y los mismos controles en los 26 tipos ya no describían el sistema — «No inició»
// decía «el conductor…» con «Conductor» ✓ mientras el tick lo callaba. Módulo PURO.
import { controlesDe, descripcionDe, notasHoy, type CtxTarjeta } from "@/lib/alertas-tarjeta";

type Destinatario = { id: number; nombre: string; funcion: string | null; telefono: string; activo: boolean; es_contingencia?: boolean };
type AlertaCfg = {
  clave: string; nombre: string; descripcion: string | null; activo: boolean;
  modo_tiempo: ModoTiempo; min_anticipacion: number | null; hora_fija: string | null; umbral: number | null;
  notifica_conductor: boolean; notifica_pasajero: boolean; notifica_conductor_tercero: boolean;
  destinatarios: number[]; plantilla: string | null;
  /** Plantilla de lo que va al directorio; sin valor, el motor usa `coordinador_alerta`. */
  plantilla_directorio?: string | null;
  // Canales por tipo (supabase/canales-por-tipo.sql)
  canal_conductor_whatsapp: boolean; canal_conductor_email: boolean; canal_conductor_push: boolean;
  canal_pasajero_push: boolean;
  canal_pasajero_email: boolean; canal_pasajero_email_solo_sin_app: boolean;
  canal_pasajero_whatsapp: boolean; canal_pasajero_whatsapp_solo_sin_app: boolean;
  tiempo_editable: boolean;
  // Horario de envío al conductor (supabase/alertas-horario-conductor.sql)
  respeta_horario: boolean; horario_desde: string | null; horario_hasta: string | null;
  /** Antelación por debajo de la cual el aviso es URGENTE y rompe el horario. */
  horario_margen_min: number | null;
  /** false = este aviso NO le escribe al directorio → la tarjeta oculta el selector, en vez
   *  de ofrecer contactos a los que el motor nunca les va a mandar nada. Gemela de
   *  `tiempo_editable` (supabase/alertas-controles-que-no-aplican.sql). */
  usa_directorio: boolean;
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

/** Un campo numérico que se puede vaciar: vacío es «sin dato» (el motor usa su número por defecto), nunca 0. */
const numeroOVacio = (v: string): number | null => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

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
  // Buscador de «Tipos de mensaje»: con 26 tarjetas, encontrar la de una plantilla era recorrerlas todas.
  const [buscarTipo, setBuscarTipo] = useState("");

  // Alta de destinatario
  const [nNombre, setNNombre] = useState("");
  const [nFuncion, setNFuncion] = useState("");
  const [nTel, setNTel] = useState("");

  // Los canales ya NO son un bloque global: viven dentro de cada tipo de mensaje.
  // Si falta la migración, `faltaCanales` avisa en vez de fingir que se guarda.
  const [faltaCanales, setFaltaCanales] = useState(false);
  // Ídem para el horario de envío al conductor. Sin la columna, el motor envía al
  // instante (comportamiento de siempre) y estos campos no se mandan en el update:
  // PostgREST rechaza la fila ENTERA si una columna no existe, así que incluirlos
  // dejaría sin guardar también los canales y el resto de la tarjeta.
  const [faltaHorario, setFaltaHorario] = useState(false);
  // Último contacto de la central de llamadas (supabase/llamadas-01-central.sql). `undefined` =
  // todavía no se sabe; `null` = no hay tabla o nunca se conectó.
  const [central, setCentral] = useState<{ ultimo_latido: string | null; equipo: string | null } | null | undefined>(undefined);
  const [ahoraCentral, setAhoraCentral] = useState(0);
  // Dos números que viven fuera de alerta_config y que la tarjeta necesita para describirse: cuándo
  // escala «En el punto, sin iniciar» y cada cuánto se repite el recordatorio de check-out. Si no se
  // pueden leer, la frase va sin el número (no se inventa uno).
  const [ctxExtra, setCtxExtra] = useState<{ persistenciaPuntoMin: number | null; cadenciaCheckoutMin: number | null }>(
    { persistenciaPuntoMin: null, cadenciaCheckoutMin: null });

  const showToast = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  const cargar = useCallback(async () => {
    const [c, d, cen, rc, jc] = await Promise.all([
      supabase.from("alerta_config").select("*").order("clave"),
      supabase.from("alerta_destinatarios").select("*").order("id"),
      supabase.from("central_llamadas_estado").select("ultimo_latido, equipo").eq("id", 1).maybeSingle(),
      supabase.from("retraso_config").select("persistencia_punto_min").eq("id", 1).maybeSingle(),
      supabase.from("jornada_config").select("recordar_checkout_cada_min").eq("id", 1).maybeSingle(),
    ]);
    setCtxExtra({
      persistenciaPuntoMin: rc.error ? null : (rc.data?.persistencia_punto_min ?? null),
      cadenciaCheckoutMin: jc.error ? null : (jc.data?.recordar_checkout_cada_min ?? null),
    });
    // Error = no hay tabla (falta el SQL); sin fila = la central nunca se conectó. No son lo mismo.
    setCentral(cen.error ? null : ((cen.data ?? { ultimo_latido: null, equipo: null }) as { ultimo_latido: string | null; equipo: string | null }));
    setAhoraCentral(Date.now());
    if (c.error || d.error) { setFaltaTabla(true); setCargando(false); return; }
    const filas = (c.data ?? []) as any[];
    // ¿La migración de canales ya corrió? (columna presente en la primera fila)
    setFaltaCanales(filas.length > 0 && filas[0].canal_conductor_whatsapp === undefined);
    setFaltaHorario(filas.length > 0 && filas[0].respeta_horario === undefined);
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
      // Default = comportamiento de siempre: sin horario, se envía al instante.
      respeta_horario:                      x.respeta_horario                      ?? false,
      horario_desde:                        x.horario_desde                        ?? null,
      horario_hasta:                        x.horario_hasta                        ?? null,
      horario_margen_min:                   x.horario_margen_min                   ?? MARGEN_URGENTE_MIN,
      // Sin la columna, se muestra: ocultar el selector por una migración que falta
      // escondería contactos que sí están configurados y funcionando.
      usa_directorio:                       x.usa_directorio                       ?? true,
    })));
    setDests(d.data ?? []);
    setCargando(false);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const setCfg = (clave: string, patch: Partial<AlertaCfg>) =>
    setCfgs((prev) => prev.map((c) => (c.clave === clave ? { ...c, ...patch } : c)));

  const guardarCfg = async (c: AlertaCfg) => {
    const canales = Object.fromEntries(COLS_CANAL.map((k) => [k, (c as any)[k] ?? false]));
    // Si la migración del horario no corrió, estas tres NO viajan (ver `faltaHorario`).
    // Con la casilla marcada y sin horas se guarda la ventana que la pantalla mostraba
    // (`ventanaPorDefecto`: 12:00–22:00 al conductor, 07:00–21:00 a los contactos):
    // dejarlas en null sería una espera que nunca abre, y el motor lo leería como
    // "sin ventana" — o sea, la casilla diría una cosa y el sistema haría otra.
    const def = ventanaPorDefecto(controlesDe(c).horario === "contactos" ? "contactos" : "conductor");
    const horario = faltaHorario ? {} : {
      respeta_horario: c.respeta_horario,
      horario_desde: c.respeta_horario ? (c.horario_desde || def.desde) : c.horario_desde,
      horario_hasta: c.respeta_horario ? (c.horario_hasta || def.hasta) : c.horario_hasta,
      horario_margen_min: c.horario_margen_min ?? MARGEN_URGENTE_MIN,
    };
    const { error } = await supabase.from("alerta_config").update({
      activo: c.activo, modo_tiempo: c.modo_tiempo,
      // Sin número se guarda el que el motor usa por defecto PARA ESTE TIPO (5 en «Inicia ahora», no 90).
      min_anticipacion: c.modo_tiempo === "anticipacion" ? (c.min_anticipacion ?? controlesDe(c).minAnticipacionDefecto ?? 90) : c.min_anticipacion,
      hora_fija: c.modo_tiempo === "hora_fija" ? (c.hora_fija ?? "08:00") : c.hora_fija,
      umbral: c.umbral, notifica_conductor: c.notifica_conductor, notifica_pasajero: c.notifica_pasajero,
      notifica_conductor_tercero: c.notifica_conductor_tercero ?? false,
      destinatarios: c.destinatarios, ...canales, ...horario, updated_at: new Date().toISOString(),
    }).eq("clave", c.clave);
    if (!error && !faltaHorario) {
      // Reflejar en pantalla lo que de verdad quedó escrito: si no, la casilla queda
      // marcada con los campos de hora vacíos y el operador cree que no se guardó nada.
      setCfg(c.clave, { horario_desde: (horario as any).horario_desde, horario_hasta: (horario as any).horario_hasta });
    }
    showToast(error ? `Error al guardar: ${error.message}` : `Guardado: ${c.nombre}`, !error);
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
  // Las tres de la escalera de inicio (y de toda alerta al coordinador) viven en un módulo PURO:
  // la matriz scripts/prueba-plantilla-idioma.mts comprueba que su número de variables es el que el
  // motor manda, y que Meta no las rechazaría.

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
    // El mensaje de Supabase se MUESTRA, no se traga: un "Error al guardar" pelado deja
    // al usuario sin saber si falta una migración, si es RLS o si el dato es inválido.
    showToast(error ? `Error al guardar: ${error.message}` : "Contacto actualizado", !error);
  };
  const borrarDest = async (id: number) => {
    if (!confirm("¿Eliminar este contacto de las alertas?")) return;
    await supabase.from("alerta_destinatarios").delete().eq("id", id);
    cargar();
  };
  const setDest = (id: number, patch: Partial<Destinatario>) => setDests((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  // Las tarjetas por NOMBRE (la base las trae por clave interna, que no es lo que se lee) y
  // filtradas por el buscador: nombre, descripción, clave o plantilla, sin tildes ni mayúsculas.
  const claveBusqueda = (s: string | null | undefined) =>
    String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const qTipo = claveBusqueda(buscarTipo).trim();
  // ¿La tarjeta le escribe de verdad al directorio? La columna (si dice false) y la tabla del motor.
  const usaDirectorio = (c: AlertaCfg) => c.usa_directorio !== false && leeElDirectorio(c.clave) !== false;
  // Lo que la tarjeta necesita para describirse: TODAS las configs (no_inicio depende de «Ya debió
  // iniciar») y los contactos que de verdad recibirían el aviso — activos, con teléfono y marcados,
  // lo mismo que cuenta `directorioDe` en el tick.
  const vivos = new Set(dests.filter((d) => d.activo && String(d.telefono ?? "").trim()).map((d) => d.id));
  const cfgPorClave = new Map<string, AlertaCfg>(cfgs.map((c) => [c.clave, c]));
  const ctxTarjeta: CtxTarjeta = {
    contactos: (clave) => cfgPorClave.get(clave)?.destinatarios.filter((id) => vivos.has(id)).length ?? 0,
    persistenciaPuntoMin: ctxExtra.persistenciaPuntoMin,
    cadenciaCheckoutMin: ctxExtra.cadenciaCheckoutMin,
  };
  const tiposVisibles = [...cfgs]
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
    .filter((c) => !qTipo || claveBusqueda([
      c.nombre, descripcionDe(c, ctxTarjeta), c.clave, c.plantilla,
      // La del directorio solo cuenta si de verdad le escribe a alguien (la misma condición del chip).
      usaDirectorio(c) && c.destinatarios.length > 0 ? (c.plantilla_directorio || "coordinador_alerta") : "",
    ].join(" ")).includes(qTipo));

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

      {faltaHorario && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-sm text-amber-800">
          El <strong>horario de envío al conductor</strong> aún no está activo en la base de datos, así que los
          avisos de servicio asignado siguen saliendo en cuanto el sistema los detecta — que en un programa fijo
          es a las <strong>00:00</strong>, cuando el conductor duerme. Ejecuta{" "}
          <code className="font-mono">supabase/alertas-horario-conductor.sql</code> en el SQL Editor de Supabase
          y recarga.
        </div>
      )}

      {/* Probar la escalera de inicio: los mismos WhatsApp, a un número, como llegan. */}
      <PruebaAvisos cfgs={cfgs} dests={dests} />

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
      <input
        value={buscarTipo}
        onChange={(e) => setBuscarTipo(e.target.value)}
        placeholder="Buscar por nombre o plantilla (ej. no_inicio, coordinador_alerta, Inicia ahora)…"
        className={input + " mb-3"}
      />
      <div className="space-y-3">
        {tiposVisibles.length === 0 && (
          <p className="text-xs text-gray-500">Ningún tipo de mensaje coincide con «{buscarTipo}».</p>
        )}
        {tiposVisibles.map((c) => {
          // Los controles los decide el catálogo (lib/alertas-tarjeta.ts), espejo del motor: no se ofrece
          // lo que el sistema no lee, y lo que lee y antes no se podía tocar aparece.
          const ctl = controlesDe(c);
          const notas = notasHoy(c.clave, cfgPorClave, ctxTarjeta);
          const descripcion = descripcionDe(c, ctxTarjeta);
          // ¿Hay mensaje al conductor que configurar? «fijo» le escribe aunque no haya casilla.
          const alConductor = ctl.conductor === "fijo" || (ctl.conductor === "casilla" && c.notifica_conductor);
          return (
          <div key={c.clave} className="bg-white border border-gray-200 rounded-2xl p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <span className="font-semibold text-gray-800 text-sm">{c.nombre}</span>
                {descripcion && <p className="text-[12px] text-gray-500">{descripcion}</p>}
                {/* Lo que cambia HOY por esta y las demás tarjetas (p. ej. «No inició» callado por
                    «Ya debió iniciar»). Solo el ámbar pide atención; el resto informa. */}
                {notas.map((nt, i) => (
                  <p key={i} className={`text-[11px] mt-0.5 ${nt.alarma ? "text-amber-800 font-semibold" : "text-gray-500 italic"}`}>
                    {nt.alarma ? "⚠️ " : "→ "}{nt.texto}
                  </p>
                ))}
                {ctl.textoActivo && <p className="text-[11px] text-gray-400 mt-0.5">{ctl.textoActivo}</p>}
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {c.plantilla && (
                    <span className="font-mono text-[10px] text-gray-500 bg-gray-100 rounded px-1.5 py-0.5" title="Plantilla de WhatsApp que usa este aviso">
                      📄 {c.plantilla}
                    </span>
                  )}
                  {usaDirectorio(c) && c.destinatarios.length > 0 && (
                    <span className="font-mono text-[10px] text-purple-700 bg-purple-50 rounded px-1.5 py-0.5" title="Plantilla de lo que reciben los contactos del directorio">
                      👥 {c.plantilla_directorio || "coordinador_alerta"}
                    </span>
                  )}
                </div>
              </div>
              {ctl.activo === "lo_dispara_otro" ? (
                // El interruptor no lo apaga: ofrecerlo sería un control que el sistema no lee.
                <span className="text-[11px] font-semibold text-gray-500 shrink-0" title={ctl.textoActivo}>⚙ Automático</span>
              ) : (
                <label className="flex items-center gap-2 text-xs font-semibold shrink-0">
                  <input type="checkbox" checked={c.activo} onChange={(e) => setCfg(c.clave, { activo: e.target.checked })} />
                  <span className={c.activo ? "text-green-600" : "text-gray-400"}>{c.activo ? "Activo" : "Inactivo"}</span>
                </label>
              )}
            </div>
            {/* ¿El bloque de este aviso lee siquiera el selector "Cuándo"? Se DERIVA de la
                tabla del motor en vez de depender de que alguien mantenga a mano la columna
                `tiempo_editable` — que sigue mandando cuando dice false (es un AND), pero ya
                no hace falta correr un SQL para que un control inerte deje de ofrecerse.
                Dieciocho de los veintiocho tipos no lo leen (VIA_DE_ALERTA, lib/alertas-modo-tiempo.ts):
                ciclo de vida, semáforo de puntualidad, GPS, checkout, abandono, «ya debió iniciar»,
                la llamada, los dos avisos al pasajero que despacha `lib/notificaciones.ts` y los dos
                de las reservas de traslado de la IA tienen su propio disparador. */}
            {(() => { const modoVisible = c.tiempo_editable && leeElModo(c.clave); return (
            <div className="grid md:grid-cols-4 gap-3">
              {modoVisible && (
                <div>
                  <label className={label}>Cuándo</label>
                  <select className={input} value={c.modo_tiempo} onChange={(e) => setCfg(c.clave, { modo_tiempo: e.target.value as ModoTiempo })}>
                    <option value="evento">Al ocurrir (evento)</option>
                    <option value="anticipacion">Antes del servicio</option>
                    <option value="hora_fija">A una hora fija</option>
                  </select>
                </div>
              )}
              {modoVisible && c.modo_tiempo === "anticipacion" && (
                <div><label className={label}>Minutos antes</label>
                  {/* Vacío = el número que el motor usa por defecto para este tipo (el placeholder). */}
                  <input type="number" className={input} value={c.min_anticipacion ?? ""}
                    placeholder={ctl.minAnticipacionDefecto != null ? String(ctl.minAnticipacionDefecto) : undefined}
                    onChange={(e) => setCfg(c.clave, { min_anticipacion: numeroOVacio(e.target.value) })} /></div>
              )}
              {modoVisible && c.modo_tiempo === "hora_fija" && (
                <div><label className={label}>Hora (HH:MM)</label>
                  <input type="time" className={input} value={c.hora_fija ?? "08:00"} onChange={(e) => setCfg(c.clave, { hora_fija: e.target.value })} /></div>
              )}
              {ctl.umbral && (
                <div><label className={label}>{ctl.umbral.etiqueta}</label>
                  {/* Vacío = el número que usa el motor (el placeholder), nunca un 0 que el motor no usa. */}
                  <input type="number" className={input} value={c.umbral ?? ""} placeholder={String(ctl.umbral.defecto)}
                    onChange={(e) => setCfg(c.clave, { umbral: numeroOVacio(e.target.value) })} /></div>
              )}
              {/* «Conductor»: casilla solo si el motor la lee; «fijo» = le escribe al propio siempre;
                  oculto = este aviso no le escribe al conductor. «Pasajero» no lo lee ningún motor
                  (al pasajero lo deciden sus canales, abajo) y ya no se ofrece. */}
              {ctl.conductor !== "oculto" && (
                <div className="flex items-end gap-3 text-xs text-gray-600">
                  {ctl.conductor === "casilla" ? (
                    <label className="flex items-center gap-1"><input type="checkbox" checked={c.notifica_conductor} onChange={(e) => setCfg(c.clave, { notifica_conductor: e.target.checked })} /> Conductor</label>
                  ) : (
                    <span className="flex items-center gap-1 text-gray-600" title="Este aviso le escribe siempre al conductor de flota propia: el motor no tiene casilla para apagarlo (se apaga con «Activo»).">
                      👤 Al conductor · siempre
                    </span>
                  )}
                </div>
              )}
              {ctl.tercerizados && (ctl.tercerizados.independienteDeConductor || c.notifica_conductor) && (
                <label className="flex items-end gap-1 text-xs text-gray-600"
                  title={ctl.tercerizados.etiqueta === "Incluir tercerizados"
                    ? "Los conductores tercerizados son personal de otra empresa: este aviso solo les llega si lo activas aquí."
                    : "La alerta también mira los servicios hechos con unidades tercerizadas."}>
                  <input type="checkbox" checked={c.notifica_conductor_tercero}
                    onChange={(e) => setCfg(c.clave, { notifica_conductor_tercero: e.target.checked })} /> {ctl.tercerizados.etiqueta}
                </label>
              )}
            </div>
            ); })()}

            {/* EL MODO ELEGIDO CONTRA EL QUE SU BLOQUE SABE EJECUTAR.
                Cuatro alertas salieron a las 00:00 (o no salieron nunca) por esto y la
                pantalla no tenía forma de decirlo: basta con tocar el desplegable para que
                un barrido diario se quede sin ventana —`guardarCfg` conserva el `hora_fija`
                viejo— o para que un recordatorio quede activo y MUDO. No se arregla en el
                motor: un `hora_fija` que quedó de antes no es una intención, es un resto, y
                deducir de ahí es lo que `montoDe` rechaza con el falso flete. Se DICE, como
                la ventana invertida del horario.
                Solo pintan ámbar los dos códigos que cambian lo que hace el sistema; el
                resto no pinta nada, porque un aviso que sale siempre se vuelve paisaje. */}
            {(() => {
              const m = cotejarModoTiempo(c);
              if (!m.alarma) return null;
              return (
                <div className="mt-3 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
                  ⚠️ <strong>{m.codigo === "evento_mudo" ? "Este aviso no se envía nunca." : "Este aviso sale de madrugada."}</strong>{" "}
                  {m.detalle} <span className="font-semibold">{m.arreglo}</span>
                </div>
              );
            })()}

            {/* Canales de ESTE tipo de mensaje: los del conductor si hay mensaje al conductor; los del
                pasajero, solo los que su motor lee. */}
            {(alConductor || ctl.canalesPasajero) && (
              <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
                <label className={label}>¿Por dónde se envía?</label>

                {alConductor && c.clave === CLAVE_LLAMADA && (() => {
                  // No es un mensaje: la hace la central propia (docs/central-llamadas.md). Lo que
                  // importa aquí es si esa central está conectada — con la tarjeta encendida y la
                  // central caída, las llamadas se quedan en cola y vencen sin salir.
                  const ec = central === undefined ? null : estadoCentral(central?.ultimo_latido ?? null, ahoraCentral);
                  return (
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-gray-500 w-20 shrink-0">Conductor</span>
                        <span className="text-xs text-gray-700">📞 Llamada telefónica desde la central propia</span>
                        {ec && (
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${ec.conectada ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                            {ec.conectada ? `● Conectada${central?.equipo ? ` · ${central.equipo}` : ""}` : "○ Sin conectar"}
                          </span>
                        )}
                      </div>
                      {central === null && (
                        <p className="pl-20 text-[11px] text-amber-800">
                          Falta correr <code className="font-mono">supabase/llamadas-01-central.sql</code>: sin él no hay cola de llamadas.
                        </p>
                      )}
                      {ec && !ec.conectada && (
                        <p className={`pl-20 text-[11px] ${c.activo ? "text-amber-800" : "text-gray-500"}`}>
                          {ec.texto}{" "}
                          {c.activo
                            ? "Con la tarjeta encendida, las llamadas se quedan en cola y vencen sin salir."
                            : "Enciende la tarjeta cuando la central esté instalada (docs/central-llamadas.md)."}
                        </p>
                      )}
                    </div>
                  );
                })()}

                {alConductor && ctl.canalesConductor && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-500 w-20 shrink-0">Conductor</span>
                    <Canal on={c.canal_conductor_whatsapp} set={(v) => setCfg(c.clave, { canal_conductor_whatsapp: v })}>💬 WhatsApp</Canal>
                    <Canal on={c.canal_conductor_email} set={(v) => setCfg(c.clave, { canal_conductor_email: v })}>📧 Correo</Canal>
                    <Canal on={c.canal_conductor_push} set={(v) => setCfg(c.clave, { canal_conductor_push: v })}>📲 Push</Canal>
                  </div>
                )}

                {/* HORARIO DE ENVÍO AL CONDUCTOR ("no molestar").
                    Los avisos de ciclo de vida son 'evento': salen cuando el motor
                    DETECTA el cambio, y como solo mira hoy/mañana, un programa fijo
                    hecho con antelación se detecta a MEDIANOCHE — que es exactamente
                    por qué llegaban a las 00:00. Aquí se elige a qué hora sale. */}
                {/* Solo el bloque de ciclo de vida (asignación, cambio, cancelación, desasignación) lee
                    el horario: en las demás tarjetas la casilla no hacía nada. */}
                {alConductor && ctl.horario === "conductor" && !faltaHorario && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-xs text-gray-500 w-20 shrink-0">Horario</span>
                    <label className="flex items-center gap-1 text-xs text-gray-600"
                      title="Detectado fuera de este horario, el aviso espera a que abra la ventana en vez de llegarle al conductor de madrugada.">
                      <input type="checkbox" checked={c.respeta_horario}
                        onChange={(e) => setCfg(c.clave, { respeta_horario: e.target.checked })} />
                      🕐 Enviar solo dentro de un horario
                    </label>
                    {c.respeta_horario && (
                      <>
                        {/* "Enviar de X a Y", NUNCA "no escribir de X a Y": la etiqueta anterior
                            nombraba las horas de SILENCIO mientras los campos son las de ENVÍO, y
                            con eso se configuró 21:00–07:00 — o sea "escríbele solo de noche",
                            justo el defecto que este módulo vino a arreglar. */}
                        <span className="text-[11px] font-semibold text-gray-600">Enviar de</span>
                        <input type="time" className={input + " w-28"} value={c.horario_desde ?? "12:00"}
                          onChange={(e) => setCfg(c.clave, { horario_desde: e.target.value })} />
                        <span className="text-[11px] font-semibold text-gray-600">a</span>
                        <input type="time" className={input + " w-28"} value={c.horario_hasta ?? "22:00"}
                          onChange={(e) => setCfg(c.clave, { horario_hasta: e.target.value })} />
                        <div className="basis-full text-[11px] text-gray-500 pl-20">
                          {describirHorario(hhmmAMinutos(c.horario_desde ?? "12:00"), hhmmAMinutos(c.horario_hasta ?? "22:00"), c.horario_margen_min)}{" "}
                        </div>
                        <div className="basis-full flex flex-wrap items-center gap-2 pl-20">
                          <span className="text-[11px] font-semibold text-gray-600">Es urgente si faltan menos de</span>
                          <input type="number" min={0} step={15} className={input + " w-24"}
                            value={c.horario_margen_min ?? MARGEN_URGENTE_MIN}
                            onChange={(e) => setCfg(c.clave, { horario_margen_min: Number(e.target.value) })} />
                          <span className="text-[11px] font-semibold text-gray-600">minutos para el servicio</span>
                        </div>
                        {ventanaCubreMadrugada(hhmmAMinutos(c.horario_desde ?? "12:00"), hhmmAMinutos(c.horario_hasta ?? "22:00")) && (
                          <div className="basis-full ml-20 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                            ⚠️ Este horario <strong>permite</strong> escribirle al conductor de madrugada. Si lo que
                            quieres es lo contrario, el rango es el de <strong>envío</strong>: prueba <strong>07:00 a 21:00</strong>.
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {ctl.canalesPasajero && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-500 w-20 shrink-0">Pasajero</span>
                    {ctl.canalesPasajero.push && <Canal on={c.canal_pasajero_push} set={(v) => setCfg(c.clave, { canal_pasajero_push: v })}>📲 Push</Canal>}
                    {!ctl.canalesPasajero.push && <span className="text-[11px] text-gray-500">📲 La notificación del app sale siempre ·</span>}
                    {ctl.canalesPasajero.email && <Canal on={c.canal_pasajero_email} set={(v) => setCfg(c.clave, { canal_pasajero_email: v })}>📧 Correo</Canal>}
                    {ctl.canalesPasajero.email && c.canal_pasajero_email && (
                      <label className="flex items-center gap-1 text-[11px] text-gray-500">
                        <input type="checkbox" checked={c.canal_pasajero_email_solo_sin_app}
                          onChange={(e) => setCfg(c.clave, { canal_pasajero_email_solo_sin_app: e.target.checked })} />
                        solo sin app
                      </label>
                    )}
                    {ctl.canalesPasajero.whatsapp && <Canal on={c.canal_pasajero_whatsapp} set={(v) => setCfg(c.clave, { canal_pasajero_whatsapp: v })}>💬 WhatsApp</Canal>}
                    {ctl.canalesPasajero.whatsapp && c.canal_pasajero_whatsapp && (
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
            {/* Los avisos de ciclo de vida (asignación, cambio, cancelación, desasignación)
                solo le escriben al CONDUCTOR: el motor nunca llama al directorio desde ese
                bloque. Ofrecer ahí los contactos es prometer envíos que no ocurren — se
                marcaron a mano una vez y nadie recibió nada. Mismo criterio que
                `tiempo_editable` con el selector "Cuándo". */}
            {dests.length > 0 && usaDirectorio(c) && (
              <div className="mt-3">
                <label className={label}>
                  {c.clave === CLAVE_LLAMADA ? "Si el conductor marca 2 («hablar con el coordinador»), avisar a:" : "También avisar a (directorio):"}
                </label>
                <div className="flex flex-wrap gap-2">
                  {dests.filter((d) => d.activo).map((d) => (
                    <label key={d.id} className={`text-xs px-2.5 py-1 rounded-full border cursor-pointer ${c.destinatarios.includes(d.id) ? "bg-[#0b315f] text-white border-[#0b315f]" : "bg-gray-50 text-gray-600 border-gray-200"}`}>
                      <input type="checkbox" className="hidden" checked={c.destinatarios.includes(d.id)} onChange={() => toggleDest(c, d.id)} />
                      {d.nombre}{d.funcion ? ` · ${d.funcion}` : ""}
                    </label>
                  ))}
                </div>
                {/* HORARIO DEL AVISO A LOS CONTACTOS («Servicio sin cerrar»). Cuenta algo que YA
                    pasó, así que no tiene urgencia ni margen: fuera del horario espera siempre y
                    sale en un solo mensaje al abrir (lib/servicio-abandonado.ts). Lo pidió el dueño
                    el 13-10-2026: «falta respetar la hora de sueño del coordinador». */}
                {ctl.horario === "contactos" && !faltaHorario && (() => {
                  const def = ventanaPorDefecto("contactos");
                  const d = hhmmAMinutos(c.horario_desde ?? def.desde), h = hhmmAMinutos(c.horario_hasta ?? def.hasta);
                  return (
                    <div className="flex flex-wrap items-center gap-2 pt-2">
                      <label className="flex items-center gap-1 text-xs text-gray-600"
                        title="Fuera de este horario el aviso espera a que abra la ventana en vez de despertar a los contactos.">
                        <input type="checkbox" checked={c.respeta_horario}
                          onChange={(e) => setCfg(c.clave, { respeta_horario: e.target.checked })} />
                        🕐 Enviar solo dentro de un horario
                      </label>
                      {c.respeta_horario && (
                        <>
                          <span className="text-[11px] font-semibold text-gray-600">Enviar de</span>
                          <input type="time" className={input + " w-28"} value={c.horario_desde ?? def.desde}
                            onChange={(e) => setCfg(c.clave, { horario_desde: e.target.value })} />
                          <span className="text-[11px] font-semibold text-gray-600">a</span>
                          <input type="time" className={input + " w-28"} value={c.horario_hasta ?? def.hasta}
                            onChange={(e) => setCfg(c.clave, { horario_hasta: e.target.value })} />
                          <div className="basis-full text-[11px] text-gray-500">
                            {describirHorario(d, h, null, { sinUrgencia: true })}
                          </div>
                          {ventanaCubreMadrugada(d, h) && (
                            <div className="basis-full text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                              ⚠️ Este horario <strong>permite</strong> escribirles de madrugada. Si lo que quieres es lo
                              contrario, el rango es el de <strong>envío</strong>: prueba <strong>{def.desde} a {def.hasta}</strong>.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <button onClick={() => guardarCfg(c)} className="text-xs font-semibold text-white bg-[#0b315f] px-4 py-2 rounded-lg hover:bg-[#0a2a52]">Guardar</button>
            </div>
          </div>
          );
        })}
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
        ) : (
          <>
          {/* ¿Están en Meta todas las plantillas que el ERP manda? Una tarjeta «Activo» con su plantilla
              ausente no manda nada (#132001), y un aviso que sale una vez al mes no se prueba solo. */}
          {(() => {
            const revision = revisarPlantillas(plantillasQueUsa(cfgs.map((c) => ({
              clave: c.clave, nombre: c.nombre, activo: c.activo, plantilla: c.plantilla,
              plantilla_directorio: c.plantilla_directorio, destinatarios: c.destinatarios,
              escribeAlDirectorio: usaDirectorio(c),
            }))), plantillas);
            const faltan = revision.filter((r) => r.estado !== "aprobada" && r.activa).length;
            const color = { aprobada: "bg-green-50 text-green-700", en_revision: "bg-amber-50 text-amber-700",
              rechazada: "bg-red-50 text-red-700", no_existe: "bg-red-50 text-red-700" } as const;
            return (
              <div className={`rounded-xl border p-3 mb-4 ${faltan ? "border-amber-200 bg-amber-50/40" : "border-green-200 bg-green-50/40"}`}>
                <p className="text-xs font-bold text-gray-700 mb-1">
                  {faltan
                    ? `⚠ ${faltan} plantilla(s) que el ERP usa no están aprobadas en Meta: esos avisos no salen.`
                    : "✓ Todas las plantillas que usan los avisos encendidos están aprobadas en Meta."}
                </p>
                <p className="text-[11px] text-gray-500 mb-2">
                  Se crean abajo, en «Crear plantilla nueva» (con el mismo nombre). Las de tarjetas apagadas salen en gris.
                </p>
                <div className="space-y-1">
                  {revision.map((r) => (
                    <div key={r.nombre} className={`flex flex-wrap items-baseline gap-2 text-[11px] ${r.activa ? "" : "opacity-50"}`}>
                      <span className="font-mono font-bold text-[#0b315f]">{r.nombre}</span>
                      <span className={`px-1.5 py-0.5 rounded ${color[r.estado]}`}>{TEXTO_ESTADO[r.estado]}</span>
                      <span className="text-gray-500">{r.usos.join(" · ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
          {plantillas.length === 0 ? (
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
          </>
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
              <button onClick={() => setNuevaTpl({ ...SUGERIDA_RECUERDA_INICIAR })} className="text-xs font-semibold text-[#0b315f] hover:underline">
                Prellenar: inicia ahora (conductor_recuerda_iniciar)
              </button>
              <button onClick={() => setNuevaTpl({ ...SUGERIDA_NO_INICIO })} className="text-xs font-semibold text-[#0b315f] hover:underline">
                Prellenar: ya debió iniciar (conductor_no_inicio)
              </button>
              <button onClick={() => setNuevaTpl({ ...SUGERIDA_COORDINADOR_ALERTA })} className="text-xs font-semibold text-[#0b315f] hover:underline">
                Prellenar: alerta al coordinador (coordinador_alerta)
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
                <input className={input + " w-auto flex-1 min-w-[220px]"} placeholder="https://tudominio.com/conductor"
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

      {/* Arriba, NO abajo: en bottom-right viven los botones flotantes de ELIA y de la
          ayuda (ver app/layout.tsx), que tapaban el aviso — y justo los errores, que son
          los que hay que leer. z-50 para quedar por encima de ambos. */}
      {toast && (
        <div className={`fixed top-6 right-6 z-50 max-w-md px-4 py-3 rounded-xl text-sm text-white shadow-lg ${toast.ok ? "bg-[#0b315f]" : "bg-red-600"}`}>{toast.msg}</div>
      )}
    </div>
  );
}
