"use client";
// ──────────────────────────────────────────────────────────────────────────────
// app/rrhh/page.tsx — Pantalla de Recursos Humanos (módulo `rrhh`): asistencia del equipo
// por día, aprobación de ausencias, marca manual por un empleado y el puente conductor↔usuario.
//
// Las ESCRITURAS (aprobar/rechazar, marca manual, vincular) van por /api/rrhh/* con la sesión
// del ERP. Las LECTURAS de equipo se derivan con el lector `jornadasDelRango` ya committeado:
// corre con la sesión y la RLS de rrhh_marca deja ver TODO a quien tiene el permiso `rrhh`
// (fn_es_rrhh). El JUICIO de la jornada sigue en el motor puro `calcularJornada`.
// ──────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePermiso } from "@/lib/usePermiso";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import { cargarConfigRrhh } from "@/lib/rrhh/marcacion-datos";
import { jornadasDelRango, marcasPorRango, type JornadaDeDia, type MarcaConUsuario } from "@/lib/rrhh/jornada-datos";
import { faltaColumna, tablaFaltante } from "@/lib/columna-faltante";
import { fechaLima, minutoDelDiaLima, minutosAHhmm } from "@/lib/alertas-horario";
import type { ConfigRrhh } from "@/lib/rrhh/tipos";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";
const SQL_HORARIO = "supabase/rrhh-04-horario-por-empleado.sql";

type Ausencia = {
  id: number; usuario_id: string; tipo: string; desde: string; hasta: string;
  goce: boolean | null; motivo: string | null; estado: string;
};

// ── Helpers de fecha/hora Lima (como funciones ⇒ lazy initializers: no se llama una función
//    impura en el render, igual que el resto del ERP no usa `toISOString()` para "hoy"). ──────
/** Hoy en Lima (YYYY-MM-DD). */
function hoyLima(): string { return fechaLima(Date.now()); }
/** El 1.º del mes en curso (Lima), rango por defecto de Tardanzas. */
function primeroDeMesLima(): string { return `${hoyLima().slice(0, 8)}01`; }
/** Un instante ISO → "HH:MM" en hora Lima; null si no es una hora usable (no se inventa una). */
function horaLimaDe(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? minutosAHhmm(minutoDelDiaLima(t)) : null;
}

// ── ¿Quién está? (presencia en vivo) ─────────────────────────────────────────────────────────
/** Un empleado del panel "¿Quién está?", con SOLO los campos no sensibles del contrato del endpoint. */
type EmpleadoPresencia = {
  usuario_id: string; nombre: string | null; clase: string | null;
  estado: string; codigo: string; llego_tarde: boolean; entrada_en: string | null;
};
const CLASE_TXT: Record<string, string> = { conductor: "Conductor", administrativo: "Administrativo" };
/** Orden de lectura de los estados en la fila de conteos (de "más presente" a "sin dato"). */
const ORDEN_PRESENCIA: readonly string[] = [
  "presente", "en_servicio", "en_campo", "en_almuerzo", "sin_marca_aun", "salio", "ausente", "sin_dato",
];
/** Etiqueta y color de cada estado de presencia. Rojo = actuar (ausente); ámbar = almuerzo;
 *  azul = en campo/servicio; verde = presente; gris/neutro = salió/sin marca/sin dato. */
function metaPresencia(estado: string): { t: string; chip: string; dot: string } {
  const m: Record<string, { t: string; chip: string; dot: string }> = {
    presente:      { t: "Presente",       chip: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
    en_servicio:   { t: "En servicio",    chip: "bg-blue-50 text-blue-700 border-blue-200",          dot: "bg-blue-500" },
    en_campo:      { t: "En campo",       chip: "bg-blue-50 text-blue-700 border-blue-200",          dot: "bg-blue-500" },
    en_almuerzo:   { t: "En almuerzo",    chip: "bg-amber-50 text-amber-700 border-amber-200",       dot: "bg-amber-500" },
    sin_marca_aun: { t: "Sin marcar aún", chip: "bg-slate-50 text-slate-600 border-slate-200",       dot: "bg-slate-400" },
    salio:         { t: "Salió",          chip: "bg-gray-100 text-gray-600 border-gray-200",         dot: "bg-gray-400" },
    ausente:       { t: "Ausente",        chip: "bg-red-50 text-red-600 border-red-200",             dot: "bg-red-400" },
    sin_dato:      { t: "Sin dato",       chip: "bg-gray-50 text-gray-400 border-gray-100",          dot: "bg-gray-300" },
  };
  return m[estado] ?? { t: estado, chip: "bg-gray-50 text-gray-500 border-gray-200", dot: "bg-gray-300" };
}

// ── Tardanzas ────────────────────────────────────────────────────────────────────────────────
/** Por (usuario|día de Lima), la HORA ("HH:MM" Lima) de la entrada MÁS TEMPRANA. Es la misma
 *  'entrada' (mínima por timestamp) con la que `calcularJornada` juzga la tardanza, así que la
 *  hora que se muestra concuerda con los minutos tarde. */
function horasEntradaPorDia(marcas: ReadonlyArray<MarcaConUsuario>): Map<string, string> {
  const min = new Map<string, number>();
  for (const m of marcas) {
    if (m?.tipo !== "entrada" || !m?.marcado_en) continue;
    const t = Date.parse(String(m.marcado_en));
    if (!Number.isFinite(t)) continue;
    const clave = `${m.usuario_id}|${fechaLima(t)}`;
    const prev = min.get(clave);
    if (prev == null || t < prev) min.set(clave, t);
  }
  const out = new Map<string, string>();
  for (const [clave, t] of min) out.set(clave, minutosAHhmm(minutoDelDiaLima(t)));
  return out;
}

// ── Horario por empleado ───────────────────────────────────────────────────────────────────────
/** Los 4 campos editables del horario por empleado, como STRINGS de input ("" = heredar global). */
type FilaHorario = { hora_entrada: string; hora_salida: string; tolerancia_min: string; almuerzo_min: string };
const VACIA_HORARIO: FilaHorario = { hora_entrada: "", hora_salida: "", tolerancia_min: "", almuerzo_min: "" };
const CAMPOS_HORARIO: readonly (keyof FilaHorario)[] = ["hora_entrada", "hora_salida", "tolerancia_min", "almuerzo_min"];
/** El `time` de Postgres llega como "HH:MM:SS"; el input quiere "HH:MM". "" si es null/vacío. */
function soloHoraMin(v: unknown): string {
  if (v == null) return "";
  const p = String(v).split(":");
  return p.length >= 2 ? `${p[0]}:${p[1]}` : String(v);
}

export default function RrhhPage() {
  const { validando, permitido } = usePermiso("rrhh");
  if (validando || !permitido) {
    return <p className="p-6 text-sm text-gray-500">Validando el permiso del módulo RRHH…</p>;
  }
  return <Rrhh />;
}

function Rrhh() {
  const [tab, setTab] = useState<"asistencia" | "presencia" | "tardanzas" | "ausencias" | "manual" | "vincular" | "fichaje" | "horarios">("asistencia");
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [cfg, setCfg] = useState<ConfigRrhh | null>(null);
  const [sinMigracion, setSinMigracion] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("usuarios").select("id,nombre").order("nombre");
      const m: Record<string, string> = {};
      for (const u of data ?? []) m[u.id] = u.nombre ?? u.id;
      setNombres(m);
      const { cfg, sinMigracion } = await cargarConfigRrhh(supabase);
      setCfg(cfg);
      if (sinMigracion) setSinMigracion(true);
    })();
  }, []);

  return (
    <main className="p-6 space-y-5 max-w-6xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Recursos Humanos</h1>
        <p className="text-gray-400 text-sm mt-1">Asistencia del equipo · ausencias · marca manual · vínculo conductor↔usuario</p>
      </div>

      {sinMigracion && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          El módulo de personal aún no está activo: falta correr <code className="font-mono">{SQL}</code> en Supabase. Además, para que las
          fotos de marcación carguen hay que crear a mano el bucket privado <code className="font-mono">rrhh</code> (Storage → Public = OFF).
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200 flex-wrap">
        {([["asistencia", "Asistencia del día"], ["presencia", "¿Quién está?"], ["tardanzas", "Tardanzas"], ["ausencias", "Ausencias"], ["manual", "Marca manual"], ["vincular", "Vincular conductor"], ["fichaje", "¿Quién ficha?"], ["horarios", "Horarios"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-4 py-2 text-sm font-bold rounded-t-lg ${tab === k ? "text-indigo-700 border-b-2 border-indigo-600" : "text-gray-500 hover:text-gray-700"}`}>
            {l}
          </button>
        ))}
      </div>

      {tab === "asistencia" ? (
        <Asistencia cfg={cfg} nombres={nombres} onSinMigracion={() => setSinMigracion(true)} />
      ) : tab === "presencia" ? (
        <Presencia nombres={nombres} onSinMigracion={() => setSinMigracion(true)} />
      ) : tab === "tardanzas" ? (
        <Tardanzas cfg={cfg} nombres={nombres} onSinMigracion={() => setSinMigracion(true)} />
      ) : tab === "ausencias" ? (
        <Ausencias nombres={nombres} onSinMigracion={() => setSinMigracion(true)} />
      ) : tab === "manual" ? (
        <MarcaManual nombres={nombres} />
      ) : tab === "vincular" ? (
        <Vincular nombres={nombres} />
      ) : tab === "fichaje" ? (
        <QuienFicha nombres={nombres} onSinMigracion={() => setSinMigracion(true)} />
      ) : (
        <Horarios cfg={cfg} nombres={nombres} onSinMigracion={() => setSinMigracion(true)} />
      )}
    </main>
  );
}

// ── ASISTENCIA DEL DÍA ──────────────────────────────────────────────────────────────────
function Asistencia({ cfg, nombres, onSinMigracion }: { cfg: ConfigRrhh | null; nombres: Record<string, string>; onSinMigracion: () => void }) {
  const [fecha, setFecha] = useState(fechaLima(Date.now()));
  const [jornadas, setJornadas] = useState<JornadaDeDia[]>([]);
  const [estado, setEstado] = useState<"cargando" | "ok" | "sin_config">("cargando");

  const cargar = useCallback(async () => {
    setEstado("cargando");
    if (!cfg) { setEstado("sin_config"); return; }
    const r = await jornadasDelRango(supabase, { desde: fecha, hasta: fecha }, cfg);
    if (r.sinMigracion) { onSinMigracion(); setEstado("ok"); setJornadas([]); return; }
    setJornadas(r.jornadas.slice().sort((a, b) => (nombres[a.usuario_id] ?? "").localeCompare(nombres[b.usuario_id] ?? "", "es")));
    setEstado("ok");
  }, [cfg, fecha, nombres, onSinMigracion]);

  useEffect(() => { void cargar(); }, [cargar]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="text-xs font-bold text-gray-500">Día:</label>
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
      </div>

      {estado === "cargando" ? (
        <p className="text-sm text-gray-500">Midiendo las jornadas del día…</p>
      ) : estado === "sin_config" ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">Aún no hay configuración de sede/horario; configúrala para medir jornadas.</div>
      ) : jornadas.length === 0 ? (
        <p className="text-sm text-gray-500">Nadie marcó asistencia ese día.</p>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-400 border-b">
                <th className="text-left px-4 py-2">Empleado</th>
                <th className="text-right px-4 py-2">Horas</th>
                <th className="text-right px-4 py-2">Almuerzo</th>
                <th className="text-right px-4 py-2">Tardanza</th>
                <th className="text-right px-4 py-2">Salida temprana</th>
                <th className="text-left px-4 py-2">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {jornadas.map((j) => (
                <tr key={j.usuario_id}>
                  <td className="px-4 py-2 font-semibold text-gray-800">{nombres[j.usuario_id] ?? j.usuario_id.slice(0, 8)}</td>
                  <td className="px-4 py-2 text-right font-semibold">{j.estado === "completa" ? `${j.horas_trabajadas} h` : "—"}</td>
                  <td className="px-4 py-2 text-right text-xs text-gray-500">{j.horas_almuerzo > 0 ? `${j.horas_almuerzo} h${j.almuerzo_estimado ? "*" : ""}` : "—"}</td>
                  <td className="px-4 py-2 text-right">{j.tardanza_min > 0 ? <span className="text-amber-700 font-semibold">{j.tardanza_min} min</span> : <span className="text-gray-300">0</span>}</td>
                  <td className="px-4 py-2 text-right">{j.salida_temprana_min > 0 ? <span className="text-amber-700 font-semibold">{j.salida_temprana_min} min</span> : <span className="text-gray-300">0</span>}</td>
                  <td className="px-4 py-2"><EstadoJornada estado={j.estado} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-400 px-4 py-2">* almuerzo estimado (no se marcó el par completo).</p>
        </div>
      )}
    </div>
  );
}

// ── AUSENCIAS ───────────────────────────────────────────────────────────────────────────
function Ausencias({ nombres, onSinMigracion }: { nombres: Record<string, string>; onSinMigracion: () => void }) {
  const [filtro, setFiltro] = useState<"solicitada" | "aprobada" | "rechazada">("solicitada");
  const [lista, setLista] = useState<Ausencia[]>([]);
  const [cargando, setCargando] = useState(true);
  const [trabajando, setTrabajando] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await supabase.from("rrhh_ausencia").select("*").eq("estado", filtro).order("desde", { ascending: false });
    if (error) { if (tablaFaltante(error, "rrhh_ausencia")) onSinMigracion(); setLista([]); setCargando(false); return; }
    setLista((data ?? []) as Ausencia[]);
    setCargando(false);
  }, [filtro, onSinMigracion]);

  useEffect(() => { void cargar(); }, [cargar]);

  async function resolver(id: number, accion: "aprobar" | "rechazar") {
    setTrabajando(id); setMsg(null);
    try {
      const res = await fetch("/api/rrhh/ausencia", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ accion, id }) });
      const d = await res.json().catch(() => ({}));
      if (d?.sin_migracion) { onSinMigracion(); return; }
      if (!res.ok || !d?.ok) { setMsg(d?.error ?? "No se pudo actualizar."); return; }
      await cargar();
    } finally {
      setTrabajando(null);
    }
  }

  const TIPO: Record<string, string> = { vacaciones: "Vacaciones", permiso: "Permiso", descanso_medico: "Descanso médico", licencia: "Licencia", falta: "Falta", suspension: "Suspensión" };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["solicitada", "aprobada", "rechazada"] as const).map((f) => (
          <button key={f} onClick={() => setFiltro(f)} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${filtro === f ? "bg-indigo-600 text-white" : "border text-gray-600 hover:bg-gray-50"}`}>
            {f === "solicitada" ? "Pendientes" : f === "aprobada" ? "Aprobadas" : "Rechazadas"}
          </button>
        ))}
      </div>
      {msg && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{msg}</div>}

      {cargando ? (
        <p className="text-sm text-gray-500">Cargando ausencias…</p>
      ) : lista.length === 0 ? (
        <p className="text-sm text-gray-500">No hay ausencias {filtro === "solicitada" ? "pendientes" : filtro === "aprobada" ? "aprobadas" : "rechazadas"}.</p>
      ) : (
        <div className="space-y-2">
          {lista.map((a) => (
            <div key={a.id} className="rounded-xl border border-gray-200 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-800">{nombres[a.usuario_id] ?? a.usuario_id.slice(0, 8)} · {TIPO[a.tipo] ?? a.tipo}</p>
                <p className="text-xs text-gray-500">
                  Del {a.desde} al {a.hasta} · {a.goce === false ? "sin goce" : a.goce === true ? "con goce" : "goce no indicado"}
                  {a.motivo ? ` · ${a.motivo}` : ""}
                </p>
              </div>
              {filtro === "solicitada" && (
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => resolver(a.id, "aprobar")} disabled={trabajando === a.id} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:opacity-90 disabled:opacity-50">Aprobar</button>
                  <button onClick={() => resolver(a.id, "rechazar")} disabled={trabajando === a.id} className="px-3 py-1.5 rounded-lg border text-red-600 text-xs font-bold hover:bg-red-50 disabled:opacity-50">Rechazar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── MARCA MANUAL ────────────────────────────────────────────────────────────────────────
function MarcaManual({ nombres }: { nombres: Record<string, string> }) {
  const usuarios = useMemo(() => Object.entries(nombres).sort((a, b) => a[1].localeCompare(b[1], "es")), [nombres]);
  const [usuarioId, setUsuarioId] = useState("");
  const [tipo, setTipo] = useState("");
  const [metodo, setMetodo] = useState<"manual_rrhh" | "pin">("manual_rrhh");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function registrar() {
    if (!usuarioId) { setMsg({ ok: false, t: "Elige al empleado." }); return; }
    setEnviando(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { usuario_id: usuarioId, metodo };
      if (tipo) body.tipo = tipo;
      const res = await fetch("/api/rrhh/marca-manual", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (d?.sin_migracion) { setMsg({ ok: false, t: `Falta correr ${SQL}.` }); return; }
      if (!res.ok || !d?.ok) { setMsg({ ok: false, t: d?.error ?? "No se pudo registrar." }); return; }
      setMsg({ ok: true, t: `Marca "${d.tipo}" registrada por ${metodo === "pin" ? "PIN" : "RRHH"}.` });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 max-w-xl">
      <p className="text-xs text-gray-500">Registra una marca por un empleado cuando no pudo usar la cámara (sin consentimiento biométrico, sin cámara). No es facial: no exige consentimiento.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Empleado</label>
          <select value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
            <option value="">— Elegir —</option>
            {usuarios.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Tipo</label>
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
            <option value="">Automático (el que toca)</option>
            <option value="entrada">Entrada</option>
            <option value="salida_almuerzo">Salida a almuerzo</option>
            <option value="regreso_almuerzo">Regreso de almuerzo</option>
            <option value="salida">Salida</option>
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Método</label>
          <select value={metodo} onChange={(e) => setMetodo(e.target.value as "manual_rrhh" | "pin")} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
            <option value="manual_rrhh">Manual (RRHH)</option>
            <option value="pin">PIN</option>
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={registrar} disabled={enviando} className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:opacity-90 disabled:opacity-50">{enviando ? "Registrando…" : "Registrar marca"}</button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.t}</span>}
      </div>
    </div>
  );
}

// ── VINCULAR CONDUCTOR ↔ USUARIO ─────────────────────────────────────────────────────────
function Vincular({ nombres }: { nombres: Record<string, string> }) {
  const usuarios = useMemo(() => Object.entries(nombres).sort((a, b) => a[1].localeCompare(b[1], "es")), [nombres]);
  const [conductores, setConductores] = useState<{ id: number; nombre: string }[]>([]);
  const [conductorId, setConductorId] = useState("");
  const [usuarioId, setUsuarioId] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("conductores").select("id,nombre").order("nombre");
      setConductores((data ?? []) as { id: number; nombre: string }[]);
    })();
  }, []);

  async function vincular() {
    if (!conductorId || !usuarioId) { setMsg({ ok: false, t: "Elige el conductor y el usuario." }); return; }
    setEnviando(true); setMsg(null);
    try {
      const res = await fetch("/api/rrhh/vincular-conductor", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ conductor_id: Number(conductorId), usuario_id: usuarioId }) });
      const d = await res.json().catch(() => ({}));
      if (d?.sin_migracion) { setMsg({ ok: false, t: `Falta correr ${SQL}.` }); return; }
      if (!res.ok || !d?.ok) { setMsg({ ok: false, t: d?.error ?? "No se pudo vincular." }); return; }
      setMsg({ ok: true, t: d.sin_cambio ? "Ya estaba vinculado a ese usuario." : "Vinculado. Ese conductor ya puede ver su perfil al entrar al ERP." });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 max-w-xl">
      <p className="text-xs text-gray-500">Ata un conductor de la flota propia a su cuenta de usuario del ERP, para que al entrar vea su propio perfil y marque asistencia.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Conductor</label>
          <select value={conductorId} onChange={(e) => setConductorId(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
            <option value="">— Elegir —</option>
            {conductores.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Usuario del ERP</label>
          <select value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
            <option value="">— Elegir —</option>
            {usuarios.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={vincular} disabled={enviando} className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:opacity-90 disabled:opacity-50">{enviando ? "Vinculando…" : "Vincular"}</button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.t}</span>}
      </div>
    </div>
  );
}

// ── ¿QUIÉN FICHA? — RRHH enciende/apaga, por empleado, la marcación con cámara ────────────
function QuienFicha({ nombres, onSinMigracion }: { nombres: Record<string, string>; onSinMigracion: () => void }) {
  const usuarios = useMemo(() => Object.entries(nombres).sort((a, b) => a[1].localeCompare(b[1], "es")), [nombres]);
  const [marca, setMarca] = useState<Record<string, boolean>>({});
  const [estado, setEstado] = useState<"cargando" | "ok" | "sin_migracion" | "error">("cargando");
  const [guardando, setGuardando] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  // El estado actual de `marca_asistencia` se LEE directo con la sesión del ERP: la RLS de
  // empleado_perfil (rrhh-01) deja ver TODO a quien tiene el permiso `rrhh` (fn_es_rrhh), el
  // mismo que gatea esta pantalla. El endpoint configurar-empleado es SOLO para ESCRIBIR.
  const cargar = useCallback(async () => {
    setEstado("cargando"); setMsg(null);
    const { data, error } = await supabase.from("empleado_perfil").select("usuario_id, marca_asistencia");
    if (error) {
      if (tablaFaltante(error, "empleado_perfil")) { onSinMigracion(); setEstado("sin_migracion"); return; }
      setEstado("error"); return;
    }
    const m: Record<string, boolean> = {};
    for (const r of (data ?? []) as { usuario_id: string; marca_asistencia?: boolean }[]) m[r.usuario_id] = !!r.marca_asistencia;
    setMarca(m);
    setEstado("ok");
  }, [onSinMigracion]);

  useEffect(() => { void cargar(); }, [cargar]);

  // Pesimista a propósito: el interruptor solo refleja lo que el servidor CONFIRMÓ. Un fallo de red,
  // un error o un `sin_migracion` NO mueven `marca[id]`, así que nunca se ve un estado que no se guardó.
  async function alternar(id: string, nuevo: boolean) {
    setGuardando(id); setMsg(null);
    try {
      const res = await fetch("/api/rrhh/configurar-empleado", {
        method: "POST",
        headers: await cabecerasErp(),
        body: JSON.stringify({ usuario_id: id, marca_asistencia: nuevo }),
      });
      const d = await res.json().catch(() => ({}));
      if (d?.sin_migracion) { onSinMigracion(); setEstado("sin_migracion"); return; }
      if (!res.ok || !d?.ok) { setMsg({ ok: false, t: d?.error ?? "No se pudo guardar." }); return; }
      // marca_asistencia es de rrhh-01; si el servidor la SOLTÓ, no se persistió → no muevas el switch.
      if (((d.columnas_omitidas ?? []) as string[]).includes("marca_asistencia")) {
        setMsg({ ok: false, t: `No se guardó: falta correr ${SQL}.` }); return;
      }
      const aplicado = (d.aplicado ?? {}) as { marca_asistencia?: unknown };
      const guardado = typeof aplicado.marca_asistencia === "boolean" ? aplicado.marca_asistencia : nuevo;
      setMarca((m) => ({ ...m, [id]: guardado }));
      setMsg({ ok: true, t: `${nombres[id] ?? "El empleado"}: ${guardado ? "ahora ficha con cámara." : "ya no ficha con cámara."}` });
    } catch {
      setMsg({ ok: false, t: "No se guardó (fallo de red): el interruptor no cambió. Vuelve a intentar." });
    } finally {
      setGuardando(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 px-4 py-3 text-xs text-indigo-900/80 space-y-1">
        <p>Quien está <b>encendido</b> marca su asistencia <b>con cámara</b> al entrar; al encenderlo, la próxima vez que marque se registra su <b>rostro de referencia</b>.</p>
        <p className="text-indigo-900/60">Los conductores derivan su asistencia de los servicios del día: no hace falta encenderlos aquí.</p>
      </div>

      {msg && <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>{msg.t}</div>}

      {estado === "cargando" ? (
        <p className="text-sm text-gray-500">Cargando la configuración de fichaje…</p>
      ) : estado === "sin_migracion" ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          El módulo de personal aún no está activo: falta correr <code className="font-mono">{SQL}</code> en Supabase.
        </div>
      ) : estado === "error" ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-center gap-3">
          <span>No se pudo leer la configuración de fichaje.</span>
          <button onClick={() => void cargar()} className="px-3 py-1 rounded-lg border border-red-300 text-red-700 font-bold hover:bg-red-100">Reintentar</button>
        </div>
      ) : usuarios.length === 0 ? (
        <p className="text-sm text-gray-500">No hay usuarios del ERP para configurar.</p>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-400 border-b">
                <th className="text-left px-4 py-2">Empleado</th>
                <th className="text-right px-4 py-2">¿Ficha con cámara?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {usuarios.map(([id, n]) => {
                const on = !!marca[id];
                const ocupado = guardando === id;
                return (
                  <tr key={id}>
                    <td className="px-4 py-2 font-semibold text-gray-800">{n}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <span className={`text-xs ${ocupado ? "text-gray-400" : on ? "text-indigo-700 font-semibold" : "text-gray-400"}`}>
                          {ocupado ? "Guardando…" : on ? "Ficha" : "No ficha"}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${n}: ${on ? "ficha" : "no ficha"} con cámara`}
                          disabled={ocupado}
                          onClick={() => void alternar(id, !on)}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-indigo-600" : "bg-gray-300"}`}
                        >
                          <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── ¿QUIÉN ESTÁ? — presencia en vivo (deriva del panel /api/rrhh/presencia-hoy) ──────────────
function Presencia({ nombres, onSinMigracion }: { nombres: Record<string, string>; onSinMigracion: () => void }) {
  const [empleados, setEmpleados] = useState<EmpleadoPresencia[]>([]);
  const [resumen, setResumen] = useState<Record<string, number>>({});
  const [campoSinMig, setCampoSinMig] = useState<string | null>(null);
  const [estado, setEstado] = useState<"cargando" | "ok" | "sin_migracion" | "error">("cargando");
  const [refrescando, setRefrescando] = useState(false);
  const [avisoRefresco, setAvisoRefresco] = useState<string | null>(null);

  // `silencioso` (auto-refresco y botón Actualizar): NO vacía la lista ni pone "Cargando…" — se
  // conserva lo último visible y un fallo solo deja un aviso, sin tirar los datos. La PRIMERA
  // carga (el efecto) sí declara "Cargando…" y surte el error en banda.
  const cargar = useCallback(async (silencioso = false) => {
    if (silencioso) setRefrescando(true); else setEstado("cargando");
    try {
      const res = await fetch("/api/rrhh/presencia-hoy", { headers: await cabecerasErp() });
      const d = await res.json().catch(() => ({}));
      if (d?.sin_migracion) { onSinMigracion(); setEstado("sin_migracion"); return; }
      if (!res.ok || !d?.ok) {
        if (silencioso) setAvisoRefresco("No se pudo actualizar; se muestra lo último leído.");
        else setEstado("error");
        return;
      }
      setEmpleados((d.empleados ?? []) as EmpleadoPresencia[]);
      setResumen((d.resumen ?? {}) as Record<string, number>);
      setCampoSinMig(typeof d.campo_sin_migracion === "string" ? d.campo_sin_migracion : null);
      setAvisoRefresco(null);
      setEstado("ok");
    } catch {
      if (silencioso) setAvisoRefresco("No se pudo actualizar; se muestra lo último leído.");
      else setEstado("error");
    } finally {
      if (silencioso) setRefrescando(false);
    }
  }, [onSinMigracion]);

  useEffect(() => { void cargar(); }, [cargar]);
  // Auto-refresco cada 60 s, silencioso (no agresivo). El cuerpo del efecto solo arma el intervalo
  // —no sincroniza estado—, así que no es un set-state-in-effect.
  useEffect(() => {
    const t = setInterval(() => { void cargar(true); }, 60_000);
    return () => clearInterval(t);
  }, [cargar]);

  const nombreDe = (e: EmpleadoPresencia) => e.nombre ?? nombres[e.usuario_id] ?? e.usuario_id.slice(0, 8);
  const resumenOrdenado = useMemo(
    () => Object.entries(resumen).filter(([, n]) => n > 0).sort((a, b) => {
      const ia = ORDEN_PRESENCIA.indexOf(a[0]); const ib = ORDEN_PRESENCIA.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }),
    [resumen],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-bold text-gray-500">Hoy · en vivo</span>
        <button onClick={() => void cargar(true)} disabled={estado === "cargando"} className="px-3 py-1.5 rounded-lg border text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50">Actualizar</button>
        {refrescando && <span className="text-[11px] text-gray-400">actualizando…</span>}
        {avisoRefresco && <span className="text-[11px] text-amber-600">{avisoRefresco}</span>}
      </div>

      {estado === "cargando" ? (
        <p className="text-sm text-gray-500">Cargando la presencia de hoy…</p>
      ) : estado === "sin_migracion" ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          El módulo de personal aún no está activo: falta correr <code className="font-mono">{SQL}</code> en Supabase.
        </div>
      ) : estado === "error" ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-center gap-3">
          <span>No se pudo leer la presencia de hoy.</span>
          <button onClick={() => void cargar()} className="px-3 py-1 rounded-lg border border-red-300 text-red-700 font-bold hover:bg-red-100">Reintentar</button>
        </div>
      ) : (
        <>
          {campoSinMig && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
              Las ventanas de trabajo en campo no están activas: falta correr <code className="font-mono">{campoSinMig}</code>. El resto del panel funciona igual.
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {resumenOrdenado.length === 0 ? (
              <span className="text-xs text-gray-400">Sin conteos.</span>
            ) : resumenOrdenado.map(([e, n]) => {
              const m = metaPresencia(e);
              return (
                <span key={e} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold ${m.chip}`}>
                  <span className={`inline-block h-2 w-2 rounded-full ${m.dot}`} />
                  {m.t} · {n}
                </span>
              );
            })}
          </div>

          {empleados.length === 0 ? (
            <p className="text-sm text-gray-500">Nadie relevante hoy todavía: ningún fichaje, servicio ni marca.</p>
          ) : (
            <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-gray-400 border-b">
                    <th className="text-left px-4 py-2">Empleado</th>
                    <th className="text-left px-4 py-2">Estado</th>
                    <th className="text-right px-4 py-2">Entrada</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {empleados.map((e) => {
                    const m = metaPresencia(e.estado);
                    return (
                      <tr key={e.usuario_id}>
                        <td className="px-4 py-2">
                          <span className="font-semibold text-gray-800">{nombreDe(e)}</span>
                          {e.clase && <span className="ml-2 text-[11px] text-gray-400">{CLASE_TXT[e.clase] ?? e.clase}</span>}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-bold ${m.chip}`}>
                            <span className={`inline-block h-2 w-2 rounded-full ${m.dot}`} />
                            {m.t}
                          </span>
                          {e.llego_tarde && <span className="ml-2 inline-block px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[11px] font-bold">tarde</span>}
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-gray-600">{horaLimaDe(e.entrada_en) ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── TARDANZAS — llegadas tarde en un rango, medidas con el horario POR EMPLEADO ──────────────
function Tardanzas({ cfg, nombres, onSinMigracion }: { cfg: ConfigRrhh | null; nombres: Record<string, string>; onSinMigracion: () => void }) {
  const [desde, setDesde] = useState(primeroDeMesLima);
  const [hasta, setHasta] = useState(hoyLima);
  const [filas, setFilas] = useState<{ j: JornadaDeDia; hora: string }[]>([]);
  const [estado, setEstado] = useState<"cargando" | "ok" | "sin_config" | "rango" | "error">("cargando");

  const cargar = useCallback(async () => {
    if (!desde || !hasta || desde > hasta) { setEstado("rango"); return; }
    setEstado("cargando");
    if (!cfg) { setEstado("sin_config"); return; }
    try {
      // La tardanza se juzga con el horario POR EMPLEADO (porEmpleado:true): el override de cada uno
      // y, sin rrhh-04, el global. Las marcas crudas dan la HORA REAL de entrada (misma 'entrada'
      // mínima por día que usó calcularJornada), así que hora y minutos-tarde concuerdan.
      const [rJ, rM] = await Promise.all([
        jornadasDelRango(supabase, { desde, hasta }, cfg, { porEmpleado: true }),
        marcasPorRango(supabase, { desde, hasta }),
      ]);
      if (rJ.sinMigracion || rM.sinMigracion) { onSinMigracion(); setFilas([]); setEstado("ok"); return; }
      const horas = horasEntradaPorDia(rM.marcas);
      const tardes = rJ.jornadas
        .filter((j) => j.tardanza_min > 0)
        .map((j) => ({ j, hora: horas.get(`${j.usuario_id}|${j.fecha}`) ?? "—" }))
        .sort((a, b) => a.j.fecha !== b.j.fecha
          ? (a.j.fecha < b.j.fecha ? 1 : -1) // la más reciente primero
          : (nombres[a.j.usuario_id] ?? "").localeCompare(nombres[b.j.usuario_id] ?? "", "es"));
      setFilas(tardes);
      setEstado("ok");
    } catch {
      setEstado("error");
    }
  }, [cfg, desde, hasta, nombres, onSinMigracion]);

  useEffect(() => { void cargar(); }, [cargar]);

  const totalMin = useMemo(() => filas.reduce((s, f) => s + f.j.tardanza_min, 0), [filas]);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Desde</label>
          <input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Hasta</label>
          <input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
        </div>
        <p className="text-[11px] text-gray-400 pb-2">La tardanza se mide con el horario de cada empleado.</p>
      </div>

      {estado === "cargando" ? (
        <p className="text-sm text-gray-500">Midiendo las tardanzas del rango…</p>
      ) : estado === "rango" ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">El rango no es válido: «Desde» no puede ser posterior a «Hasta».</div>
      ) : estado === "sin_config" ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">Aún no hay configuración de sede/horario; configúrala para medir tardanzas.</div>
      ) : estado === "error" ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-center gap-3">
          <span>No se pudieron medir las tardanzas.</span>
          <button onClick={() => void cargar()} className="px-3 py-1 rounded-lg border border-red-300 text-red-700 font-bold hover:bg-red-100">Reintentar</button>
        </div>
      ) : filas.length === 0 ? (
        <p className="text-sm text-gray-500">Nadie llegó tarde en el rango elegido.</p>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-400 border-b">
                <th className="text-left px-4 py-2">Empleado</th>
                <th className="text-left px-4 py-2">Fecha</th>
                <th className="text-right px-4 py-2">Entrada</th>
                <th className="text-right px-4 py-2">Minutos tarde</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filas.map((f) => (
                <tr key={`${f.j.usuario_id}|${f.j.fecha}`}>
                  <td className="px-4 py-2 font-semibold text-gray-800">{nombres[f.j.usuario_id] ?? f.j.usuario_id.slice(0, 8)}</td>
                  <td className="px-4 py-2 text-gray-600">{f.j.fecha}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{f.hora}</td>
                  <td className="px-4 py-2 text-right"><span className="text-amber-700 font-semibold">{f.j.tardanza_min} min</span></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t text-[11px] text-gray-500">
                <td className="px-4 py-2 font-bold" colSpan={3}>{filas.length} tardanza(s)</td>
                <td className="px-4 py-2 text-right font-bold">{totalMin} min</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ── HORARIOS POR EMPLEADO — override editable del horario global (vacío = hereda) ─────────────
function Horarios({ cfg, nombres, onSinMigracion }: { cfg: ConfigRrhh | null; nombres: Record<string, string>; onSinMigracion: () => void }) {
  const usuarios = useMemo(() => Object.entries(nombres).sort((a, b) => a[1].localeCompare(b[1], "es")), [nombres]);
  // `guardado`: lo persistido (de la base o de un guardado OK). `borrador`: lo que se está editando.
  // Un fallo de guardado/red revierte el borrador a `guardado` → el input nunca queda mostrando un
  // valor que no se persistió.
  const [guardado, setGuardado] = useState<Record<string, FilaHorario>>({});
  const [borrador, setBorrador] = useState<Record<string, FilaHorario>>({});
  const [estado, setEstado] = useState<"cargando" | "ok" | "sin_migracion" | "error">("cargando");
  const [rrhh04Falta, setRrhh04Falta] = useState(false);
  const [guardandoId, setGuardandoId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  // Los overrides se LEEN directo con la sesión del ERP (la RLS de empleado_perfil deja ver TODO a
  // quien tiene el permiso `rrhh`). El endpoint configurar-empleado es SOLO para ESCRIBIR.
  const cargar = useCallback(async () => {
    setEstado("cargando"); setMsg(null); setRrhh04Falta(false);
    const { data, error } = await supabase
      .from("empleado_perfil")
      .select("usuario_id, hora_entrada, hora_salida, tolerancia_min, almuerzo_min");
    if (error) {
      if (tablaFaltante(error, "empleado_perfil")) { onSinMigracion(); setEstado("sin_migracion"); return; }
      // Falta una de las 4 columnas de horario (rrhh-04 sin correr): no hay overrides que leer. Se
      // dice en ámbar y todos quedan heredando el global (los placeholders siguen mostrándolo).
      if (faltaColumna(error)) { setRrhh04Falta(true); setGuardado({}); setBorrador({}); setEstado("ok"); return; }
      setEstado("error"); return;
    }
    const g: Record<string, FilaHorario> = {};
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const id = String(r.usuario_id);
      g[id] = {
        hora_entrada: soloHoraMin(r.hora_entrada),
        hora_salida: soloHoraMin(r.hora_salida),
        tolerancia_min: r.tolerancia_min == null ? "" : String(r.tolerancia_min),
        almuerzo_min: r.almuerzo_min == null ? "" : String(r.almuerzo_min),
      };
    }
    setGuardado(g);
    setBorrador(g);
    setEstado("ok");
  }, [onSinMigracion]);

  useEffect(() => { void cargar(); }, [cargar]);

  const filaDe = (id: string): FilaHorario => borrador[id] ?? guardado[id] ?? VACIA_HORARIO;
  const editar = (id: string, campo: keyof FilaHorario, valor: string) =>
    setBorrador((b) => ({ ...b, [id]: { ...filaDe(id), [campo]: valor } }));
  const sucia = (id: string) => {
    const b = borrador[id] ?? guardado[id] ?? VACIA_HORARIO;
    const s = guardado[id] ?? VACIA_HORARIO;
    return CAMPOS_HORARIO.some((c) => b[c] !== s[c]);
  };

  async function guardar(id: string) {
    const fila = filaDe(id);
    const previo = guardado[id] ?? VACIA_HORARIO;
    setGuardandoId(id); setMsg(null);
    // Se mandan los 4 campos: vacío → null (borra el override → hereda el global); así vaciar un
    // campo de verdad lo borra en la base, en vez de quedar «ausente» y no tocarse.
    const body: Record<string, unknown> = { usuario_id: id };
    for (const c of CAMPOS_HORARIO) body[c] = fila[c].trim() === "" ? null : fila[c].trim();
    try {
      const res = await fetch("/api/rrhh/configurar-empleado", {
        method: "POST", headers: await cabecerasErp(), body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (d?.sin_migracion) { onSinMigracion(); setEstado("sin_migracion"); return; }
      if (!res.ok || !d?.ok) {
        setBorrador((b) => ({ ...b, [id]: previo })); // no se guardó: no dejes un valor sin persistir
        setMsg({ ok: false, t: d?.error ?? "No se pudo guardar el horario." });
        return;
      }
      // Si el servidor SOLTÓ columnas (rrhh-04 sin correr), esos campos no se persistieron: se
      // revierten al valor guardado y se avisa nombrando el SQL que falta.
      const omitidas = new Set((d.columnas_omitidas ?? []) as string[]);
      const aplicado = (d.aplicado ?? {}) as Record<string, unknown>;
      const nueva: FilaHorario = { ...fila };
      for (const c of CAMPOS_HORARIO) {
        if (omitidas.has(c)) nueva[c] = previo[c];
        else nueva[c] = c === "tolerancia_min" || c === "almuerzo_min"
          ? (aplicado[c] == null ? "" : String(aplicado[c]))
          : soloHoraMin(aplicado[c]);
      }
      setGuardado((s) => ({ ...s, [id]: nueva }));
      setBorrador((b) => ({ ...b, [id]: nueva }));
      if (CAMPOS_HORARIO.some((c) => omitidas.has(c))) {
        setRrhh04Falta(true);
        setMsg({ ok: false, t: `No se guardó el horario: falta correr ${SQL_HORARIO}.` });
      } else {
        setMsg({ ok: true, t: `Horario de ${nombres[id] ?? "el empleado"} guardado.` });
      }
    } catch {
      setBorrador((b) => ({ ...b, [id]: previo })); // fallo de red: el input vuelve a lo persistido
      setMsg({ ok: false, t: "No se guardó (fallo de red): el horario no cambió. Vuelve a intentar." });
    } finally {
      setGuardandoId(null);
    }
  }

  // Placeholders = el valor GLOBAL (la pista de lo que se hereda al dejar un campo vacío).
  const gEntrada = cfg?.hora_entrada ?? "";
  const gSalida = cfg?.hora_salida ?? "";
  const gTol = cfg != null && Number.isFinite(cfg.tolerancia_min) ? String(cfg.tolerancia_min) : "";
  const gAlm = cfg != null && Number.isFinite(cfg.almuerzo_min) ? String(cfg.almuerzo_min) : "";

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 px-4 py-3 text-xs text-indigo-900/80 space-y-1">
        <p>Fija el horario de UN empleado (entrada, salida, tolerancia, almuerzo). Lo que dejes <b>vacío</b> hereda el horario <b>global</b> de la sede; la pista gris es ese valor global.</p>
        {cfg == null && <p className="text-amber-700">Aún no hay horario global configurado; sin él, la pista no muestra valores.</p>}
      </div>

      {rrhh04Falta && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          El horario por empleado aún no está activo: falta correr <code className="font-mono">{SQL_HORARIO}</code> en Supabase. Hasta entonces todos usan el horario global.
        </div>
      )}

      {msg && <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>{msg.t}</div>}

      {estado === "cargando" ? (
        <p className="text-sm text-gray-500">Cargando los horarios…</p>
      ) : estado === "sin_migracion" ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          El módulo de personal aún no está activo: falta correr <code className="font-mono">{SQL}</code> en Supabase.
        </div>
      ) : estado === "error" ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-center gap-3">
          <span>No se pudieron leer los horarios.</span>
          <button onClick={() => void cargar()} className="px-3 py-1 rounded-lg border border-red-300 text-red-700 font-bold hover:bg-red-100">Reintentar</button>
        </div>
      ) : usuarios.length === 0 ? (
        <p className="text-sm text-gray-500">No hay usuarios del ERP para configurar.</p>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-400 border-b">
                <th className="text-left px-4 py-2">Empleado</th>
                <th className="text-left px-3 py-2">Entrada</th>
                <th className="text-left px-3 py-2">Salida</th>
                <th className="text-left px-3 py-2">Tolerancia (min)</th>
                <th className="text-left px-3 py-2">Almuerzo (min)</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {usuarios.map(([id, n]) => {
                const f = filaDe(id);
                const ocupado = guardandoId === id;
                return (
                  <tr key={id}>
                    <td className="px-4 py-2 font-semibold text-gray-800">{n}</td>
                    <td className="px-3 py-2">
                      <input type="text" inputMode="numeric" value={f.hora_entrada} disabled={ocupado} placeholder={gEntrada || "—"} onChange={(e) => editar(id, "hora_entrada", e.target.value)} className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm disabled:opacity-50" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="text" inputMode="numeric" value={f.hora_salida} disabled={ocupado} placeholder={gSalida || "—"} onChange={(e) => editar(id, "hora_salida", e.target.value)} className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm disabled:opacity-50" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" min={0} value={f.tolerancia_min} disabled={ocupado} placeholder={gTol || "—"} onChange={(e) => editar(id, "tolerancia_min", e.target.value)} className="w-20 rounded-lg border border-gray-200 px-2 py-1 text-sm disabled:opacity-50" />
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" min={0} value={f.almuerzo_min} disabled={ocupado} placeholder={gAlm || "—"} onChange={(e) => editar(id, "almuerzo_min", e.target.value)} className="w-20 rounded-lg border border-gray-200 px-2 py-1 text-sm disabled:opacity-50" />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" disabled={ocupado || !sucia(id)} onClick={() => void guardar(id)} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:opacity-90 disabled:opacity-40">{ocupado ? "Guardando…" : "Guardar"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-400 px-4 py-2">Entrada/salida en «HH:MM» (24 h). Vacío = hereda el horario global de la sede.</p>
        </div>
      )}
    </div>
  );
}

function EstadoJornada({ estado }: { estado: string }) {
  const map: Record<string, { t: string; c: string }> = {
    completa: { t: "Completa", c: "bg-emerald-50 text-emerald-700" },
    en_curso: { t: "En curso", c: "bg-indigo-50 text-indigo-700" },
    incompleta: { t: "Falta entrada", c: "bg-amber-50 text-amber-700" },
    sin_marcas: { t: "Sin marcas", c: "bg-gray-50 text-gray-500" },
  };
  const e = map[estado] ?? { t: estado, c: "bg-gray-50 text-gray-500" };
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold ${e.c}`}>{e.t}</span>;
}
