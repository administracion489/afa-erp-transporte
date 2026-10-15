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
import { jornadasDelRango, type JornadaDeDia } from "@/lib/rrhh/jornada-datos";
import { tablaFaltante } from "@/lib/columna-faltante";
import { fechaLima } from "@/lib/alertas-horario";
import type { ConfigRrhh } from "@/lib/rrhh/tipos";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

type Ausencia = {
  id: number; usuario_id: string; tipo: string; desde: string; hasta: string;
  goce: boolean | null; motivo: string | null; estado: string;
};

export default function RrhhPage() {
  const { validando, permitido } = usePermiso("rrhh");
  if (validando || !permitido) {
    return <p className="p-6 text-sm text-gray-500">Validando el permiso del módulo RRHH…</p>;
  }
  return <Rrhh />;
}

function Rrhh() {
  const [tab, setTab] = useState<"asistencia" | "ausencias" | "manual" | "vincular">("asistencia");
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
        {([["asistencia", "Asistencia del día"], ["ausencias", "Ausencias"], ["manual", "Marca manual"], ["vincular", "Vincular conductor"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-4 py-2 text-sm font-bold rounded-t-lg ${tab === k ? "text-indigo-700 border-b-2 border-indigo-600" : "text-gray-500 hover:text-gray-700"}`}>
            {l}
          </button>
        ))}
      </div>

      {tab === "asistencia" ? (
        <Asistencia cfg={cfg} nombres={nombres} onSinMigracion={() => setSinMigracion(true)} />
      ) : tab === "ausencias" ? (
        <Ausencias nombres={nombres} onSinMigracion={() => setSinMigracion(true)} />
      ) : tab === "manual" ? (
        <MarcaManual nombres={nombres} />
      ) : (
        <Vincular nombres={nombres} />
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
