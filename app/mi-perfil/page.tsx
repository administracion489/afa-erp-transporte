"use client";
// ──────────────────────────────────────────────────────────────────────────────
// app/mi-perfil/page.tsx — Autoservicio del empleado (módulo `mi-perfil`, lo tiene todo
// usuario). Tres secciones: MI PERFIL (ficha autoeditable + consentimientos + saldo de
// vacaciones), MARCAR ASISTENCIA (gate de cámara facial) y MIS ASISTENCIAS (jornadas).
//
// Las ESCRITURAS van por /api/rrhh/* (el servidor fuerza la identidad del token y valida).
// "Mis datos" se arma con GET /api/rrhh/perfil. Las jornadas de "mis asistencias" se derivan
// con el lector `jornadasDelRango` ya committeado, que corre con la sesión del ERP (la RLS de
// rrhh_marca ya filtra a MIS filas) y reusa el motor puro `calcularJornada`.
// ──────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { usePermiso } from "@/lib/usePermiso";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import { ImgPrivada } from "@/components/ArchivoPrivado";
import MarcarAsistencia from "@/components/rrhh/MarcarAsistencia";
import { cargarConfigRrhh } from "@/lib/rrhh/marcacion-datos";
import { jornadasDelRango, type JornadaDeDia } from "@/lib/rrhh/jornada-datos";
import { fechaLima } from "@/lib/alertas-horario";
import type { ConfigRrhh } from "@/lib/rrhh/tipos";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

/** Re-encodea una imagen de archivo por <canvas> a JPEG, descartando EXIF/GPS, y reduciéndola a
 *  como mucho 1024 px en el lado mayor (un rostro de perfil no necesita más). Rechaza si no es una
 *  imagen que el navegador sepa decodificar; el llamador cae entonces al archivo crudo. */
function reencodearFotoCanvas(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) { reject(new Error("no es imagen")); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 1024;
        const escala = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight) || 1);
        const w = Math.max(1, Math.round(img.naturalWidth * escala));
        const h = Math.max(1, Math.round(img.naturalHeight * escala));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("sin canvas")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      } catch (e) {
        reject(e as Error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("no se pudo decodificar")); };
    img.src = url;
  });
}

type PerfilResp = {
  ok: boolean;
  sin_migracion?: string;
  usuario: { id: string; nombre: string | null; rol?: string | null };
  perfil: {
    foto_url_firmada: string | null;
    fecha_nacimiento: string | null;
    telefono_personal: string | null;
    direccion: string | null;
    contacto_emergencia_nombre: string | null;
    contacto_emergencia_telefono: string | null;
    contacto_emergencia_parentesco: string | null;
    marca_asistencia: boolean;
  } | null;
  ficha: { clase: "conductor" | "administrativo" | null; datos: { cargo?: string | null; departamento?: string | null; [k: string]: unknown } | null; fecha_ingreso: string | null };
  saldo_vacaciones:
    | { saldo: { anios_completos: number; dias_ganados: number; dias_gozados: number; saldo: number }; fecha_ingreso?: string }
    | { saldo: null; motivo: string };
  consentimientos: Record<"biometrico" | "monitoreo", { otorgado: boolean; en: string | null; version: string | null; vigente_version: string }>;
};

export default function MiPerfilPage() {
  const { validando, permitido } = usePermiso("mi-perfil");
  if (validando || !permitido) {
    return <p className="p-6 text-sm text-gray-500">Validando el permiso del módulo Mi Perfil…</p>;
  }
  return <MiPerfil />;
}

function MiPerfil() {
  const [tab, setTab] = useState<"perfil" | "marcar" | "asistencias">("perfil");
  const [data, setData] = useState<PerfilResp | null>(null);
  const [cargando, setCargando] = useState(true);
  const [correo, setCorreo] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch("/api/rrhh/perfil", { headers: await cabecerasErp() });
      const d = (await res.json().catch(() => null)) as PerfilResp | null;
      if (d) setData(d);
      const { data: ses } = await supabase.auth.getSession();
      setCorreo(ses.session?.user.email ?? null);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  const biometrico = data?.consentimientos?.biometrico?.otorgado ?? false;

  async function otorgarBiometrico() {
    const res = await fetch("/api/rrhh/consentimiento", {
      method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ biometrico: true }),
    });
    if (res.ok) await cargar();
  }

  return (
    <main className="p-6 space-y-5 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Mi Perfil</h1>
        <p className="text-gray-400 text-sm mt-1">Tu ficha, tus consentimientos, tu asistencia y tus vacaciones</p>
      </div>

      {data?.sin_migracion && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          El módulo de personal aún no está activo: falta correr <code className="font-mono">{SQL}</code> en Supabase. Mientras tanto,
          la pantalla muestra lo que haya y la marcación no está disponible. (También hay que crear el bucket privado <code className="font-mono">rrhh</code>.)
        </div>
      )}

      {/* Pestañas */}
      <div className="flex gap-1 border-b border-gray-200">
        {([["perfil", "Mi perfil"], ["marcar", "Marcar asistencia"], ["asistencias", "Mis asistencias"]] as const).map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-bold rounded-t-lg ${tab === k ? "text-indigo-700 border-b-2 border-indigo-600" : "text-gray-500 hover:text-gray-700"}`}
          >
            {l}
          </button>
        ))}
      </div>

      {cargando ? (
        <p className="text-sm text-gray-500">Cargando tu información…</p>
      ) : tab === "perfil" ? (
        <SeccionPerfil data={data} correo={correo} onGuardado={cargar} />
      ) : tab === "marcar" ? (
        <MarcarAsistencia biometrico={biometrico} onPedirConsentimiento={otorgarBiometrico} onMarcada={() => { /* refresca al entrar a Mis asistencias */ }} />
      ) : (
        <MisAsistencias />
      )}
    </main>
  );
}

// ── MI PERFIL ───────────────────────────────────────────────────────────────────────────
function SeccionPerfil({ data, correo, onGuardado }: { data: PerfilResp | null; correo: string | null; onGuardado: () => Promise<void> }) {
  const p = data?.perfil;
  const [form, setForm] = useState({
    fecha_nacimiento: p?.fecha_nacimiento ?? "",
    telefono_personal: p?.telefono_personal ?? "",
    direccion: p?.direccion ?? "",
    contacto_emergencia_nombre: p?.contacto_emergencia_nombre ?? "",
    contacto_emergencia_telefono: p?.contacto_emergencia_telefono ?? "",
    contacto_emergencia_parentesco: p?.contacto_emergencia_parentesco ?? "",
  });
  const [fotoDataUrl, setFotoDataUrl] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setForm({
      fecha_nacimiento: p?.fecha_nacimiento ?? "",
      telefono_personal: p?.telefono_personal ?? "",
      direccion: p?.direccion ?? "",
      contacto_emergencia_nombre: p?.contacto_emergencia_nombre ?? "",
      contacto_emergencia_telefono: p?.contacto_emergencia_telefono ?? "",
      contacto_emergencia_parentesco: p?.contacto_emergencia_parentesco ?? "",
    });
  }, [p]);

  async function elegirFoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Defensa en profundidad: re-encodeamos la foto por <canvas> antes de mandarla, igual que la
    // marcación facial. Eso descarta EXIF/GPS en el cliente (la foto de un celular trae ubicación).
    // El servidor la vuelve a re-encodear sin metadatos, así que si el canvas falla no pasa nada.
    const url = await reencodearFotoCanvas(file).catch(() => null);
    if (url) { setFotoDataUrl(url); return; }
    const r = new FileReader();
    r.onload = () => setFotoDataUrl(typeof r.result === "string" ? r.result : null);
    r.readAsDataURL(file);
  }

  async function guardar() {
    setGuardando(true); setMsg(null);
    try {
      // Un campo vaciado manda "" → el servidor lo convierte a null (se puede borrar un dato).
      const body: Record<string, unknown> = { ...form };
      if (fotoDataUrl) body.foto = fotoDataUrl;
      const res = await fetch("/api/rrhh/perfil", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (d?.sin_migracion) { setMsg("No se pudo guardar: falta correr la migración."); return; }
      if (!res.ok || !d?.ok) { setMsg(d?.error ?? "No se pudo guardar."); return; }
      setFotoDataUrl(null);
      setMsg(d?.foto_omitida ? "Guardado (la foto no se pudo subir — falta el bucket privado rrhh)." : "Guardado.");
      await onGuardado();
    } catch {
      setMsg("Error de red al guardar.");
    } finally {
      setGuardando(false);
    }
  }

  const ficha = data?.ficha;
  const sal = data?.saldo_vacaciones;

  return (
    <div className="space-y-5">
      {/* Cabecera: foto + nombre + ficha */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 flex flex-wrap items-center gap-4">
        <div className="w-24 h-24 rounded-full overflow-hidden bg-gray-100 border flex items-center justify-center shrink-0">
          {fotoDataUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={fotoDataUrl} alt="" className="w-full h-full object-cover" />
            : p?.foto_url_firmada
            ? <ImgPrivada src={p.foto_url_firmada} alt="" className="w-full h-full object-cover" />
            : <span className="text-3xl text-gray-300">👤</span>}
        </div>
        <div className="flex-1 min-w-[180px]">
          <p className="text-xl font-black text-gray-900">{data?.usuario?.nombre ?? "—"}</p>
          <p className="text-xs text-gray-500">
            {ficha?.clase === "conductor" ? "Conductor" : ficha?.clase === "administrativo" ? "Personal administrativo" : "Usuario del ERP"}
            {ficha?.datos?.cargo ? ` · ${ficha.datos.cargo}` : ""}
            {ficha?.datos?.departamento ? ` · ${ficha.datos.departamento}` : ""}
          </p>
          {ficha?.fecha_ingreso && <p className="text-[11px] text-gray-400 mt-0.5">Ingreso: {ficha.fecha_ingreso}</p>}
        </div>
        <label className="px-3 py-2 rounded-lg border text-xs font-bold text-gray-600 hover:bg-gray-50 cursor-pointer">
          Cambiar foto
          <input type="file" accept="image/*" className="hidden" onChange={elegirFoto} />
        </label>
      </div>

      {/* Datos editables */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
        <p className="text-[11px] font-black uppercase tracking-widest text-gray-400">Mis datos</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Campo label="Fecha de nacimiento" tipo="date" valor={form.fecha_nacimiento} onChange={(v) => setForm((f) => ({ ...f, fecha_nacimiento: v }))} />
          <Campo label="Teléfono personal" valor={form.telefono_personal} onChange={(v) => setForm((f) => ({ ...f, telefono_personal: v }))} />
          <Campo label="Dirección" valor={form.direccion} onChange={(v) => setForm((f) => ({ ...f, direccion: v }))} span2 />
          <Campo label="Contacto de emergencia — nombre" valor={form.contacto_emergencia_nombre} onChange={(v) => setForm((f) => ({ ...f, contacto_emergencia_nombre: v }))} />
          <Campo label="Contacto de emergencia — teléfono" valor={form.contacto_emergencia_telefono} onChange={(v) => setForm((f) => ({ ...f, contacto_emergencia_telefono: v }))} />
          <Campo label="Parentesco" valor={form.contacto_emergencia_parentesco} onChange={(v) => setForm((f) => ({ ...f, contacto_emergencia_parentesco: v }))} />

          {/* Solo-lectura: el correo y el sueldo NO se editan aquí */}
          <CampoGris label="Correo (no editable)" valor={correo ?? "—"} />
          <CampoGris label="Sueldo (no editable)" valor="Lo gestiona Recursos Humanos" />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button onClick={guardar} disabled={guardando} className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:opacity-90 disabled:opacity-50">
            {guardando ? "Guardando…" : "Guardar cambios"}
          </button>
          {msg && <span className="text-xs text-gray-500">{msg}</span>}
        </div>
      </div>

      {/* Vacaciones */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <p className="text-[11px] font-black uppercase tracking-widest text-gray-400 mb-2">Saldo de vacaciones</p>
        {sal && sal.saldo ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kpi label="Años completos" valor={String(sal.saldo.anios_completos)} />
            <Kpi label="Días ganados" valor={String(sal.saldo.dias_ganados)} />
            <Kpi label="Días gozados" valor={String(sal.saldo.dias_gozados)} />
            <Kpi label="Saldo" valor={String(sal.saldo.saldo)} resalta={sal.saldo.saldo < 0 ? "deuda" : "ok"} />
          </div>
        ) : (
          <p className="text-xs text-gray-500">{(sal as { motivo?: string } | null)?.motivo ?? "No se pudo calcular el saldo de vacaciones."}</p>
        )}
      </div>

      {/* Consentimientos */}
      <Consentimientos data={data} onCambio={onGuardado} />
    </div>
  );
}

function Consentimientos({ data, onCambio }: { data: PerfilResp | null; onCambio: () => Promise<void> }) {
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const cons = data?.consentimientos;

  async function cambiar(tipo: "biometrico" | "monitoreo", otorgar: boolean) {
    setTrabajando(tipo);
    try {
      const res = await fetch("/api/rrhh/consentimiento", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ [tipo]: otorgar }) });
      if (res.ok) await onCambio();
    } finally {
      setTrabajando(null);
    }
  }

  const fila = (tipo: "biometrico" | "monitoreo", titulo: string, texto: string) => {
    const c = cons?.[tipo];
    const otorgado = !!c?.otorgado;
    return (
      <div className="flex items-start justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-800">{titulo}</p>
          <p className="text-[11px] text-gray-500 leading-relaxed">{texto}</p>
          {otorgado && c?.en && <p className="text-[11px] text-emerald-600 mt-0.5">Otorgado el {new Date(c.en).toLocaleDateString("es-PE")}</p>}
        </div>
        <button
          onClick={() => cambiar(tipo, !otorgado)}
          disabled={trabajando === tipo}
          className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold ${otorgado ? "border text-red-600 hover:bg-red-50" : "bg-indigo-600 text-white hover:opacity-90"} disabled:opacity-50`}
        >
          {trabajando === tipo ? "…" : otorgado ? "Revocar" : "Otorgar"}
        </button>
      </div>
    );
  };

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 divide-y divide-gray-100">
      <p className="text-[11px] font-black uppercase tracking-widest text-gray-400 pb-1">Consentimientos (Ley N.º 29733)</p>
      {fila("biometrico", "Foto del rostro al marcar asistencia",
        "Autorizo que al marcar se detecte un rostro y se guarde mi foto (dato sensible) como evidencia para que RRHH verifique la marca. Sin reconocimiento facial automático. Revocable.")}
      {fila("monitoreo", "Registro de ubicación y asistencia en jornada",
        "Autorizo el registro de mi ubicación y asistencia durante mi jornada con fines laborales. Revocable.")}
    </div>
  );
}

// ── MIS ASISTENCIAS ──────────────────────────────────────────────────────────────────────
function MisAsistencias() {
  const [jornadas, setJornadas] = useState<JornadaDeDia[]>([]);
  const [estado, setEstado] = useState<"cargando" | "ok" | "sin_migracion" | "sin_config">("cargando");

  useEffect(() => {
    (async () => {
      const { data: ses } = await supabase.auth.getSession();
      const uid = ses.session?.user.id;
      if (!uid) { setEstado("ok"); return; }
      const { cfg, sinMigracion } = await cargarConfigRrhh(supabase);
      if (sinMigracion) { setEstado("sin_migracion"); return; }
      if (!cfg) { setEstado("sin_config"); return; }
      const hasta = fechaLima(Date.now());
      const desde = fechaLima(Date.now() - 9 * 86_400_000);
      const r = await jornadasDelRango(supabase, { usuarioId: uid, desde, hasta }, cfg as ConfigRrhh);
      if (r.sinMigracion) { setEstado("sin_migracion"); return; }
      setJornadas(r.jornadas.slice().sort((a, b) => (a.fecha < b.fecha ? 1 : -1)));
      setEstado("ok");
    })();
  }, []);

  if (estado === "cargando") return <p className="text-sm text-gray-500">Cargando tus asistencias…</p>;
  if (estado === "sin_migracion")
    return <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">Falta correr <code className="font-mono">{SQL}</code>.</div>;
  if (estado === "sin_config")
    return <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">Recursos Humanos aún no configuró la sede ni el horario.</div>;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
      <p className="text-[11px] font-black uppercase tracking-widest text-gray-400 px-4 pt-4">Últimos 10 días</p>
      {jornadas.length === 0 ? (
        <p className="text-sm text-gray-500 p-4">No tienes marcas registradas en los últimos 10 días.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-400 border-b">
                <th className="text-left px-4 py-2">Día</th>
                <th className="text-right px-4 py-2">Horas</th>
                <th className="text-right px-4 py-2">Tardanza</th>
                <th className="text-left px-4 py-2">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {jornadas.map((j) => (
                <tr key={j.fecha}>
                  <td className="px-4 py-2 font-mono text-xs">{j.fecha}</td>
                  <td className="px-4 py-2 text-right font-semibold">{j.estado === "completa" ? `${j.horas_trabajadas} h` : "—"}</td>
                  <td className="px-4 py-2 text-right">{j.tardanza_min > 0 ? <span className="text-amber-700 font-semibold">{j.tardanza_min} min</span> : <span className="text-gray-300">0</span>}</td>
                  <td className="px-4 py-2"><EstadoJornada estado={j.estado} /></td>
                </tr>
              ))}
            </tbody>
          </table>
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

// ── átomos ──────────────────────────────────────────────────────────────────────────────
function Campo({ label, valor, onChange, tipo = "text", span2 }: { label: string; valor: string; onChange: (v: string) => void; tipo?: string; span2?: boolean }) {
  return (
    <div className={span2 ? "md:col-span-2" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      <input type={tipo} value={valor} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
    </div>
  );
}

function CampoGris({ label, valor }: { label: string; valor: string }) {
  return (
    <div>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      <div className="w-full rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm text-gray-400">{valor}</div>
    </div>
  );
}

function Kpi({ label, valor, resalta }: { label: string; valor: string; resalta?: "ok" | "deuda" }) {
  const c = resalta === "deuda" ? "text-red-600" : resalta === "ok" ? "text-emerald-600" : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</p>
      <p className={`text-2xl font-black ${c}`}>{valor}</p>
    </div>
  );
}
