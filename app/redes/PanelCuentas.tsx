"use client";
// app/redes/PanelCuentas.tsx — Conectar las cuentas.
//
// LA PANTALLA NO VE NINGÚN TOKEN, NI SIQUIERA TRUNCADO. `redes_cuentas` tiene RLS
// activo y sin política permisiva, así que la clave anónima no lee ni una fila; todo
// pasa por /api/redes/cuentas, que devuelve nombre y estado. Enseñar los últimos cuatro
// caracteres «para reconocerlo» sería filtrar parte de una credencial a cambio de nada.
//
// Y DICE LO QUE HACE FALTA DE VERDAD, incluidos los trámites que no dependen del ERP.
// Un formulario que pide un token sin explicar de dónde sale, y sin avisar de que TikTok
// necesita una auditoría o de que YouTube subirá en privado hasta que Google verifique
// la app, deja a alguien esperando publicaciones que no pueden salir.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { CAPACIDADES, ETIQUETA_RED, REDES, type Red } from "@/lib/redes/tipos";

const input =
  "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-xs font-semibold text-gray-500 mb-1.5";
const btn = "px-4 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-40";

type CuentaPublica = {
  id: number;
  red: Red;
  nombre_cuenta: string | null;
  cuenta_externa_id: string | null;
  vigente: boolean;
  ultimo_error: string | null;
  destino_telefono: string | null;
};

/** Qué hay que pegar en cada red y de dónde sale. */
const INSTRUCCIONES: Record<Red, { id?: string; credencial?: string; donde: string }> = {
  facebook: {
    id: "ID de la Página",
    credencial: "Token de Página de larga duración",
    donde:
      "Meta → Herramientas → Explorador de la API Graph: elige la app, pide un token de usuario con " +
      "pages_manage_posts y pages_read_engagement, cámbialo por uno de Página y conviértelo a larga duración.",
  },
  instagram: {
    id: "ID de la cuenta de Instagram (IG User ID)",
    credencial: "El mismo token de Página de Facebook",
    donde:
      "La cuenta debe ser Profesional y estar vinculada a la Página. El IG User ID sale de " +
      "GET /{page-id}?fields=instagram_business_account. Permisos: instagram_basic e instagram_content_publish.",
  },
  tiktok: {
    id: "open_id de la cuenta (opcional)",
    credencial: "Refresh token de TikTok",
    donde:
      "TikTok for Developers → tu app → OAuth con scope video.upload. Guarda el refresh_token (dura 365 días). " +
      "Variables del entorno: TIKTOK_CLIENT_KEY y TIKTOK_CLIENT_SECRET.",
  },
  youtube: {
    id: "ID del canal (opcional)",
    credencial: "Refresh token de Google",
    donde:
      "Google Cloud → OAuth con scope youtube.upload, sobre el mismo proyecto del Gmail del CRM " +
      "(reutiliza GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET). Guarda el refresh_token.",
  },
  whatsapp_estado: {
    donde:
      "Aquí no hay token porque no hay API de estados. Pon el número de quien tiene el celular con " +
      "WhatsApp Business: ahí llegará cada día la pieza lista para publicar como estado.",
  },
};

export default function PanelCuentas({ onCambio }: { onCambio?: () => void }) {
  const [cuentas, setCuentas] = useState<CuentaPublica[]>([]);
  const [cargando, setCargando] = useState(true);
  const [abierta, setAbierta] = useState<Red | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data: s } = await supabase.auth.getSession();
    try {
      const res = await fetch("/api/redes/cuentas", {
        headers: { Authorization: `Bearer ${s.session?.access_token ?? ""}` },
      });
      const j = await res.json();
      setCuentas(j?.cuentas ?? []);
    } catch {
      setCuentas([]);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function guardar(red: Red) {
    setGuardando(true);
    const { data: s } = await supabase.auth.getSession();
    const res = await fetch("/api/redes/cuentas", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` },
      body: JSON.stringify({ red, ...form }),
    });
    const j = await res.json();
    setGuardando(false);
    if (j?.ok) {
      setMsg({ t: `${ETIQUETA_RED[red]} conectada.`, ok: true });
      setAbierta(null);
      setForm({});
      cargar();
      onCambio?.();
    } else {
      setMsg({ t: j?.aviso ?? j?.error ?? "No se pudo conectar.", ok: false });
    }
    setTimeout(() => setMsg(null), 6000);
  }

  return (
    <div className="space-y-3 max-w-3xl">
      {msg && (
        <div
          className={`rounded-xl px-4 py-3 text-sm ${
            msg.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {msg.t}
        </div>
      )}

      {cargando && <div className="text-sm text-gray-400 py-6">Cargando cuentas…</div>}

      {!cargando &&
        REDES.map((red) => {
          const c = cuentas.find((x) => x.red === red && x.vigente);
          const cap = CAPACIDADES[red];
          const ins = INSTRUCCIONES[red];
          const esWa = red === "whatsapp_estado";
          return (
            <div key={red} className="rounded-2xl border border-gray-200 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-800">{cap.etiqueta}</span>
                    {c ? (
                      <span className="text-xs px-2 py-0.5 rounded-lg bg-green-100 text-green-700">conectada</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-lg bg-gray-100 text-gray-500">sin conectar</span>
                    )}
                  </div>
                  {c && (
                    <div className="mt-1 text-xs text-gray-500">
                      {c.nombre_cuenta || "(sin nombre)"}
                      {c.cuenta_externa_id ? ` · ${c.cuenta_externa_id}` : ""}
                      {c.destino_telefono ? ` · ${c.destino_telefono}` : ""}
                    </div>
                  )}
                  {/* Las cuentas caducadas se ven aquí: es la pantalla donde se arregla. */}
                  {cuentas.some((x) => x.red === red && !x.vigente && x.ultimo_error) && !c && (
                    <div className="mt-1 text-xs text-amber-700">
                      La conexión anterior dejó de funcionar:{" "}
                      {cuentas.find((x) => x.red === red && !x.vigente && x.ultimo_error)?.ultimo_error}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    setAbierta(abierta === red ? null : red);
                    setForm({});
                  }}
                  className={`${btn} bg-gray-100 text-gray-700 shrink-0`}
                >
                  {c ? "Reconectar" : "Conectar"}
                </button>
              </div>

              {/* La advertencia del catálogo, no una redactada aquí: si cambia el trámite
                  se corrige en un sitio y lo dicen todas las pantallas. */}
              {cap.advertencia && (
                <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                  {cap.advertencia}
                </div>
              )}

              {abierta === red && (
                <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                  <p className="text-xs text-gray-500 leading-relaxed">{ins.donde}</p>

                  <div>
                    <label className={label}>Nombre (para reconocerla en esta pantalla)</label>
                    <input
                      className={input}
                      value={form.nombre_cuenta ?? ""}
                      onChange={(e) => setForm({ ...form, nombre_cuenta: e.target.value })}
                      placeholder={esWa ? "Ej. Celular de atención al cliente" : "Ej. AFA Transportes"}
                    />
                  </div>

                  {esWa ? (
                    <div>
                      <label className={label}>Número al que se manda la pieza (con código de país)</label>
                      <input
                        className={input}
                        value={form.destino_telefono ?? ""}
                        onChange={(e) => setForm({ ...form, destino_telefono: e.target.value })}
                        placeholder="51966707225"
                      />
                    </div>
                  ) : (
                    <>
                      {ins.id && (
                        <div>
                          <label className={label}>{ins.id}</label>
                          <input
                            className={input}
                            value={form.cuenta_externa_id ?? ""}
                            onChange={(e) => setForm({ ...form, cuenta_externa_id: e.target.value })}
                          />
                        </div>
                      )}
                      <div>
                        <label className={label}>{ins.credencial}</label>
                        <input
                          className={input}
                          type="password"
                          autoComplete="off"
                          value={(red === "facebook" || red === "instagram" ? form.token : form.refresh) ?? ""}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              ...(red === "facebook" || red === "instagram"
                                ? { token: e.target.value }
                                : { refresh: e.target.value }),
                            })
                          }
                        />
                        <p className="mt-1 text-xs text-gray-400">
                          Se guarda cifrado (AES-256-GCM) y no vuelve a salir de esta pantalla ni del servidor.
                        </p>
                      </div>
                    </>
                  )}

                  <button
                    onClick={() => guardar(red)}
                    disabled={guardando}
                    className={`${btn} bg-[#0b315f] text-white`}
                  >
                    {guardando ? "Guardando…" : "Guardar conexión"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
