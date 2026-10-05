"use client";
// app/combustible/CorreoFacturas.tsx — El bloque «¿de qué correo se leen las facturas?» de la
// pestaña 📧 Facturas. Conecta el CORREO DE FACTURAS (el buzón donde llegan las de Primax),
// aparte del Gmail del CRM, con permiso de solo lectura. La regla de qué buzón se lee vive en
// lib/combustible/correo-conexion.ts; esta pantalla solo la enseña y ofrece los botones.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import type { CodigoConexion } from "@/lib/combustible/correo-conexion";

type Estado = {
  ok: boolean;
  error?: string;
  requisitos: { google: boolean; cifrado: boolean };
  conexion: { codigo: CodigoConexion; de: "facturas" | "crm" | null; email: string | null; detalle: string | null; fuente: string | null; conectado_en: string | null };
  descripcion: { titulo: string; detalle: string; tono: "ok" | "info" | "alerta" };
};

type Muestra = {
  ok: boolean;
  error?: string;
  consulta: string;
  estimado: number;
  correo?: { email: string | null };
  mensajes: { id: string; fecha: string | null; de: string; asunto: string; adjuntos: string[] }[];
};

const TONO = {
  ok:     { fondo: "#f0fdf4", borde: "#86efac", texto: "#166534" },
  info:   { fondo: "#eff6ff", borde: "#93c5fd", texto: "#1e3a8a" },
  alerta: { fondo: "#fffbeb", borde: "#fcd34d", texto: "#92400e" },
};

/** El error que devuelve Google al volver del consentimiento, dicho en castellano. */
function errorDeGoogle(e: string): string {
  if (e === "access_denied") {
    return "Google no dio el permiso: o se canceló, o esa cuenta no está autorizada para esta app. " +
      "Si Google mostró «Acceso bloqueado», hay que agregar ese correo como usuario de prueba en Google Cloud → " +
      "Pantalla de consentimiento de OAuth (o publicar la app).";
  }
  if (e === "sin_code") return "Google no devolvió el código de autorización. Vuelve a intentarlo.";
  return e;
}

export default function CorreoFacturas({ onCodigo }: { onCodigo?: (c: CodigoConexion | null) => void }) {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [aviso, setAviso] = useState<{ tono: "ok" | "alerta"; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [cuenta, setCuenta] = useState<{ id: number; correo_filtro: string } | null>(null);
  const [filtro, setFiltro] = useState("");
  const [muestra, setMuestra] = useState<Muestra | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await fetch("/api/combustible/correo", { headers: await cabecerasErp() });
      const j = await r.json();
      if (!j.ok) { setEstado(null); setAviso({ tono: "alerta", texto: j.error ?? `Error ${r.status}` }); onCodigo?.(null); return; }
      setEstado(j);
      onCodigo?.(j.conexion.codigo);
    } catch (e: any) {
      setAviso({ tono: "alerta", texto: e.message });
      onCodigo?.(null);
    }
  }, [onCodigo]);

  useEffect(() => {
    // Lo que Google devolvió al terminar el consentimiento llega en la URL: se dice y se limpia,
    // para que recargar la página no repita el aviso.
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.get("correo") === "ok") {
        const em = p.get("correo_email");
        setAviso({ tono: "ok", texto: `Correo conectado${em ? `: ${em}` : ""}. Pulsa «Probar filtro» para ver qué facturas encuentra, y luego «Leer correo ahora».` });
      }
      const err = p.get("correo_error");
      if (err) setAviso({ tono: "alerta", texto: `No se conectó el correo. ${errorDeGoogle(err)}` });
      if (p.has("correo") || p.has("correo_error")) {
        ["correo", "correo_error", "correo_email"].forEach((k) => p.delete(k));
        const q = p.toString();
        window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
      }
    } catch { /* sin URL legible no hay aviso que mostrar */ }
    cargar();
    supabase.from("combustible_cuentas").select("id, correo_filtro, activo").order("id").then(({ data }: any) => {
      const c = ((data as any[]) ?? []).find((x) => x.activo) ?? ((data as any[]) ?? [])[0];
      if (c) { setCuenta({ id: Number(c.id), correo_filtro: c.correo_filtro ?? "" }); setFiltro(c.correo_filtro ?? ""); }
    });
  }, [cargar]);

  async function post(accion: string, extra: Record<string, unknown> = {}) {
    const r = await fetch("/api/combustible/correo", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ accion, ...extra }) });
    return r.json().catch(() => ({ ok: false, error: `Error ${r.status}` }));
  }

  async function conectar() {
    setOcupado("conectar"); setAviso(null);
    const j = await post("conectar");
    if (j.ok && j.url) { window.location.href = j.url; return; }
    setAviso({ tono: "alerta", texto: j.error ?? "No se pudo iniciar la conexión." });
    setOcupado(null);
  }

  async function desconectar() {
    const em = estado?.conexion.email ?? "este correo";
    if (!confirm(
      `¿Desconectar ${em}?\n\nEl ERP deja de leer ese correo (si el CRM tiene un Gmail conectado, pasará a leer ese).\n` +
      "El permiso dentro de tu cuenta de Google NO se quita desde aquí: si quieres retirarlo, ve a myaccount.google.com → Seguridad → Apps con acceso a tu cuenta.",
    )) return;
    setOcupado("desconectar");
    const j = await post("desconectar");
    if (j.ok) { setEstado(j); onCodigo?.(j.conexion.codigo); setMuestra(null); setAviso({ tono: "ok", texto: "Correo desconectado." }); }
    else setAviso({ tono: "alerta", texto: j.error ?? "No se pudo desconectar." });
    setOcupado(null);
  }

  async function probar() {
    setOcupado("probar"); setMuestra(null);
    const j = await post("probar_filtro", { filtro });
    setMuestra(j);
    setOcupado(null);
  }

  async function guardarFiltro() {
    if (!cuenta) return;
    setOcupado("guardar");
    const { error } = await supabase.from("combustible_cuentas")
      .update({ correo_filtro: filtro.trim() || "has:attachment", updated_at: new Date().toISOString() })
      .eq("id", cuenta.id);
    setOcupado(null);
    if (error) { setAviso({ tono: "alerta", texto: error.message }); return; }
    setCuenta({ ...cuenta, correo_filtro: filtro.trim() });
    setAviso({ tono: "ok", texto: "Filtro guardado: la próxima lectura (o «Leer correo ahora») usa este." });
  }

  if (!estado) {
    return (
      <div className="rounded-xl border bg-white p-4 text-sm text-gray-500">
        {aviso ? <span className={aviso.tono === "ok" ? "text-green-700" : "text-amber-800"}>{aviso.texto}</span> : "Comprobando el correo conectado…"}
      </div>
    );
  }

  const { conexion, descripcion, requisitos } = estado;
  const t = TONO[descripcion.tono];
  const puedeConectar = requisitos.google && requisitos.cifrado;
  const etiquetaConectar =
    conexion.codigo === "facturas" ? "Cambiar de correo" :
    conexion.codigo === "rota" && conexion.de === "facturas" ? "🔄 Volver a conectar" :
    conexion.codigo === "crm" ? "📧 Conectar el correo de facturas" : "📧 Conectar correo de facturas";
  const sePuedeLeer = conexion.codigo === "facturas" || conexion.codigo === "crm";
  const filtroCambiado = !!cuenta && filtro.trim() !== (cuenta.correo_filtro ?? "").trim();

  return (
    <div className="rounded-xl border p-4 space-y-3" style={{ background: t.fondo, borderColor: t.borde }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px]">
          <div className="font-black text-sm" style={{ color: t.texto }}>📧 {descripcion.titulo}</div>
          <div className="text-xs text-gray-700">
            {descripcion.detalle}
            {conexion.codigo === "facturas" && conexion.conectado_en && <> · conectado el {new Date(conexion.conectado_en).toLocaleDateString("es-PE")}</>}
          </div>
        </div>
        <button onClick={conectar} disabled={!puedeConectar || !!ocupado}
          className={`px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-50 ${conexion.codigo === "facturas" ? "border bg-white text-gray-700" : "text-white"}`}
          style={conexion.codigo === "facturas" ? undefined : { background: "#1d4ed8" }}>
          {ocupado === "conectar" ? "Abriendo Google…" : etiquetaConectar}
        </button>
        {conexion.codigo === "facturas" && (
          <button onClick={desconectar} disabled={!!ocupado} className="px-3 py-2 rounded-lg text-xs font-bold border bg-white text-gray-600 disabled:opacity-50">
            {ocupado === "desconectar" ? "Desconectando…" : "Desconectar"}
          </button>
        )}
      </div>

      {!requisitos.cifrado && (
        <div className="text-xs text-amber-900 bg-amber-100 rounded-lg p-2">
          <b>Antes de conectar falta un paso en Vercel:</b> Settings → Environment Variables → agrega <code>TOKEN_ENCRYPTION_KEY</code> con una frase larga cualquiera (por ejemplo, 40 letras al azar) → <b>Redeploy</b>. Es la llave con la que el ERP guarda cifrada la credencial del correo; sin ella no la guarda.
        </div>
      )}
      {!requisitos.google && (
        <div className="text-xs text-amber-900 bg-amber-100 rounded-lg p-2">
          <b>Falta configurar Google en Vercel</b> (<code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_REDIRECT_URI</code>): son las mismas que usa el Gmail del CRM.
        </div>
      )}
      {conexion.codigo !== "facturas" && puedeConectar && (
        <div className="text-[11px] text-gray-600">
          Se abre Google: <b>elige la cuenta donde llegan las facturas de Primax</b> (Gmail o Google Workspace) y acepta. El permiso es de solo lectura. Si ese correo no es de Google, crea en él un reenvío automático de las facturas hacia uno que sí lo sea.
        </div>
      )}
      {aviso && <div className={`text-xs font-bold ${aviso.tono === "ok" ? "text-green-700" : "text-red-700"}`}>{aviso.texto}</div>}

      {sePuedeLeer && (
        <div className="space-y-2 border-t pt-3" style={{ borderColor: t.borde }}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[260px] text-[11px] font-bold text-gray-600">Filtro de Gmail (qué correos son facturas de combustible)
              <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="from:(primax OR coesti) has:attachment"
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal text-gray-900 bg-white" />
            </label>
            <button onClick={probar} disabled={!!ocupado} className="px-3 py-2 rounded-lg text-xs font-bold border bg-white disabled:opacity-50">
              {ocupado === "probar" ? "Buscando…" : "🔎 Probar filtro"}
            </button>
            {filtroCambiado && (
              <button onClick={guardarFiltro} disabled={!!ocupado} className="px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50" style={{ background: "#0b315f" }}>
                Guardar este filtro
              </button>
            )}
          </div>
          {muestra && (
            !muestra.ok ? <div className="text-xs text-red-700">{muestra.error}</div> :
            muestra.mensajes.length === 0 ? (
              <div className="text-xs text-amber-900">
                Ningún correo de los últimos 45 días coincide con <code>{muestra.consulta}</code>{muestra.correo?.email ? <> en {muestra.correo.email}</> : null}.
                {" "}Abre una factura de Primax en ese correo y mira el remitente: ajusta el filtro con esa dirección. También funciona buscar el RUC de COESTI, que va en toda factura de Primax: <code>20127765279 has:attachment</code>.
              </div>
            ) : (
              <div className="text-xs space-y-1">
                <div className="text-gray-700">≈ <b>{muestra.estimado}</b> correo(s) coinciden{muestra.correo?.email ? <> en <b>{muestra.correo.email}</b></> : null}. Los más recientes (nada se procesó todavía):</div>
                {muestra.mensajes.map((m) => (
                  <div key={m.id} className="rounded-lg bg-white border px-2 py-1 flex flex-wrap gap-x-3">
                    <span className="text-gray-500">{m.fecha ? new Date(m.fecha).toLocaleDateString("es-PE") : "—"}</span>
                    <span className="font-bold truncate max-w-[260px]">{m.de}</span>
                    <span className="truncate max-w-[360px]">{m.asunto}</span>
                    <span className={m.adjuntos.some((a) => /\.(xml|zip)$/i.test(a)) ? "text-green-700" : m.adjuntos.length ? "text-amber-700" : "text-red-700"}>
                      {m.adjuntos.length ? m.adjuntos.join(", ") : "sin adjuntos"}
                    </span>
                  </div>
                ))}
                <div className="text-[11px] text-gray-500">Verde: trae el XML de SUNAT (se registra solo). Ámbar: solo PDF (la IA lo lee y queda para confirmar). Rojo: sin adjunto (no hay factura que leer).</div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
