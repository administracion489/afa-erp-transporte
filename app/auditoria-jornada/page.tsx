"use client";

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Fila = {
  unidad: string; flota: "propia" | "tercero";
  km_inicio: number | null; km_fin: number | null;
  km_jornada: number | null; km_operativos: number;
  km_no_justificados: number | null; servicios: number;
  medido_pct: number | null; tiene_checkin: boolean; tiene_checkout: boolean;
  clasificacion: "sin_datos" | "normal" | "advertencia" | "revision" | "alto";
  // Verificación por GPS: mira el desplazamiento de la unidad, no solo sus servicios, así que
  // también ve el recorrido que no cuelga de ninguna reserva.
  gps_veredicto: "sin_gps" | "sin_odometro" | "detenida" | "coherente" | "supera";
  gps_km_probado: number | null; gps_excede_km: number | null;
  gps_radio_km: number | null; gps_cobertura_pct: number | null;
  gps_puntos: number; gps_detalle: string | null;
};
type Config = { umbral_advertencia: number; umbral_revision: number; umbral_alto: number; recordar_checkout_cada_min: number };

const CLASE: Record<string, { label: string; color: string; bg: string }> = {
  sin_datos:   { label: "Sin datos",    color: "#6b7280", bg: "#f3f4f6" },
  normal:      { label: "Normal",       color: "#166534", bg: "#dcfce7" },
  advertencia: { label: "Advertencia",  color: "#92400e", bg: "#fef3c7" },
  revision:    { label: "Revisión",     color: "#9a3412", bg: "#ffedd5" },
  alto:        { label: "Alta difer.",  color: "#991b1b", bg: "#fee2e2" },
};

/**
 * Verificación por GPS. `supera` es el único que pide acción: el desplazamiento demuestra un
 * recorrido mayor que el que registró el odómetro. La redacción evita acusar a nadie — puede
 * faltar la lectura de cierre o el odómetro pudo leerse de una foto anterior.
 */
const GPS_CLASE: Record<Fila["gps_veredicto"], { label: string; color: string; bg: string }> = {
  sin_gps:      { label: "Sin GPS",       color: "#9ca3af", bg: "#f9fafb" },
  sin_odometro: { label: "Sin cierre",    color: "#92400e", bg: "#fef3c7" },
  detenida:     { label: "0 km confirm.", color: "#166534", bg: "#dcfce7" },
  coherente:    { label: "Coincide",      color: "#166534", bg: "#dcfce7" },
  supera:       { label: "GPS > odóm.",   color: "#991b1b", bg: "#fee2e2" },
};

const hoyLima = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const fmt = (n: number | null, dec = 0) =>
  n == null ? "—" : n.toLocaleString("es-PE", { minimumFractionDigits: dec, maximumFractionDigits: dec });

export default function AuditoriaJornadaPage() {
  const [fecha, setFecha] = useState(hoyLima());
  const [filas, setFilas] = useState<Fila[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editConfig, setEditConfig] = useState(false);
  const [cfgForm, setCfgForm] = useState<Config | null>(null);

  const post = async (payload: any) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/api/jornada/auditoria", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
      body: JSON.stringify(payload),
    });
    const data = JSON.parse(await res.text()); // text()+parse: tolera 504/timeout sin "Unexpected token"
    if (!res.ok || !data.ok) throw new Error(data?.error || "Error");
    return data;
  };

  const cargar = useCallback(async (f: string) => {
    setLoading(true); setError("");
    try {
      const data = await post({ accion: "auditoria", fecha: f });
      setFilas(data.filas || []);
      setConfig(data.config || null);
    } catch (e: any) {
      setError(e?.message || "No se pudo cargar la auditoría");
      setFilas([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { cargar(fecha); }, [fecha, cargar]);

  const guardarConfig = async () => {
    if (!cfgForm) return;
    try {
      const data = await post({ accion: "guardar_config", ...cfgForm });
      setConfig(data.config); setEditConfig(false);
      cargar(fecha);
    } catch (e: any) { alert(e?.message || "No se pudo guardar"); }
  };

  const totNoJust = filas.reduce((s, f) => s + Math.abs(Number(f.km_no_justificados ?? 0)), 0);
  const enRevision = filas.filter(f => f.clasificacion === "revision" || f.clasificacion === "alto").length;
  const sinCheckout = filas.filter(f => !f.tiene_checkout && f.servicios > 0).length;

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Auditoría de jornada</h1>
          <p className="text-gray-400 text-sm mt-1">
            Km de jornada vs km de servicio (GPS) vs km no justificado (traslados en vacío / fantasma). Nunca acusa: muestra la diferencia objetiva para revisión.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm" />
          <button onClick={() => cargar(fecha)} className="px-4 py-2.5 rounded-xl font-bold text-sm text-white" style={{ background: "#0b315f" }}>
            {loading ? "Cargando…" : "Actualizar"}
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Unidades con actividad", valor: String(filas.length), color: "#0b315f", bg: "#eef3f8" },
          { label: "Km no justificado (total)", valor: `${fmt(totNoJust)} km`, color: "#991b1b", bg: "#fee2e2" },
          { label: "En revisión / alto", valor: String(enRevision), color: "#9a3412", bg: "#ffedd5" },
          { label: "Sin check-out", valor: String(sinCheckout), color: "#92400e", bg: "#fef3c7" },
        ].map(k => (
          <div key={k.label} className="rounded-2xl p-4" style={{ background: k.bg }}>
            <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: k.color, opacity: 0.75 }}>{k.label}</p>
            <p className="text-2xl font-black mt-1" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {config && (
        <div className="rounded-xl border bg-white px-4 py-3 flex items-center gap-3 flex-wrap text-sm">
          <span className="font-bold text-gray-700">Umbrales (km):</span>
          <span className="text-gray-600">Advertencia ≥ {config.umbral_advertencia} · Revisión ≥ {config.umbral_revision} · Alta ≥ {config.umbral_alto}</span>
          <button onClick={() => { setCfgForm(config); setEditConfig(v => !v); }} className="ml-auto text-xs font-bold text-[#0b315f] hover:underline">
            {editConfig ? "Cerrar" : "Editar"}
          </button>
        </div>
      )}
      {editConfig && cfgForm && (
        <div className="rounded-xl border bg-gray-50 px-4 py-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          {([
            ["umbral_advertencia", "Advertencia ≥"],
            ["umbral_revision", "Revisión ≥"],
            ["umbral_alto", "Alta ≥"],
            ["recordar_checkout_cada_min", "Recordar cada (min)"],
          ] as [keyof Config, string][]).map(([k, l]) => (
            <div key={k}>
              <label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">{l}</label>
              <input type="number" value={cfgForm[k]} onChange={e => setCfgForm(p => p ? { ...p, [k]: Number(e.target.value) } : p)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
          ))}
          <div className="col-span-2 md:col-span-4">
            <button onClick={guardarConfig} className="px-4 py-2 rounded-lg font-bold text-sm text-white" style={{ background: "#0b315f" }}>Guardar umbrales</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Unidad", "Check-in", "Check-out", "Km jornada", "Km servicio (GPS)", "Km no justificado", "Servicios", "Estado", "Verificación GPS"].map(h => (
                <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.length === 0 ? (
              <tr><td colSpan={9} className="p-10 text-center text-gray-400">{loading ? "Cargando…" : "Sin actividad registrada en la fecha"}</td></tr>
            ) : filas.map(f => {
              const c = CLASE[f.clasificacion];
              return (
                <tr key={f.unidad} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                  <td className="p-3 font-bold text-gray-800 whitespace-nowrap">
                    {f.unidad}{f.flota === "tercero" && <span className="ml-1 text-[10px] font-bold text-purple-600">(3ro)</span>}
                    {f.medido_pct != null && f.medido_pct < 70 && (
                      <span className="ml-1 text-[10px] text-amber-600" title="GPS con huecos: el km de servicio puede estar subestimado">⚠ GPS {f.medido_pct}%</span>
                    )}
                  </td>
                  <td className="p-3 text-gray-600 whitespace-nowrap">{f.tiene_checkin ? fmt(f.km_inicio) : <span className="text-amber-600">falta</span>}</td>
                  <td className="p-3 text-gray-600 whitespace-nowrap">{f.tiene_checkout ? fmt(f.km_fin) : <span className="text-amber-600">falta</span>}</td>
                  <td className="p-3 font-bold text-gray-800 whitespace-nowrap">{f.km_jornada != null ? `${fmt(f.km_jornada)} km` : "—"}</td>
                  <td className="p-3 text-gray-600 whitespace-nowrap">{fmt(f.km_operativos)} km</td>
                  <td className="p-3 font-bold whitespace-nowrap" style={{ color: c.color }}>
                    {f.km_no_justificados != null ? `${f.km_no_justificados > 0 ? "+" : ""}${fmt(f.km_no_justificados)} km` : "—"}
                  </td>
                  <td className="p-3 text-gray-600">{f.servicios}</td>
                  <td className="p-3"><span className="px-2 py-1 rounded-lg text-xs font-bold whitespace-nowrap" style={{ color: c.color, background: c.bg }}>{c.label}</span></td>
                  <td className="p-3">
                    {(() => {
                      const gc = GPS_CLASE[f.gps_veredicto] || GPS_CLASE.sin_gps;
                      return (
                        <div title={f.gps_detalle || undefined}>
                          <span className="px-2 py-1 rounded-lg text-xs font-bold whitespace-nowrap" style={{ color: gc.color, background: gc.bg }}>
                            {gc.label}
                          </span>
                          {f.gps_veredicto === "supera" && f.gps_excede_km != null && (
                            <span className="ml-1.5 text-xs font-bold text-red-700 whitespace-nowrap">faltan {fmt(f.gps_excede_km, 1)} km</span>
                          )}
                          {f.gps_radio_km != null && f.gps_radio_km > 0 && (
                            <p className="text-[10px] text-gray-400 mt-0.5 whitespace-nowrap">
                              se alejó {fmt(f.gps_radio_km, 1)} km · señal {f.gps_cobertura_pct ?? 0}%
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">
        <b>Km jornada</b> = check-out − check-in (odómetro). <b>Km servicio</b> = distancia GPS de los servicios finalizados.
        <b> Km no justificado</b> = jornada − servicio (traslados a cochera/taller/lavado o uso no registrado). Un valor negativo suele ser GPS inflado u odómetro mal leído.
        <b> ⚠ GPS</b> bajo = huella con huecos → el km de servicio puede estar subestimado.
      </p>
      <p className="text-xs text-gray-400 leading-relaxed">
        <b>Verificación GPS</b> mira el desplazamiento de la unidad, no solo sus servicios, así que también
        ve el recorrido que no cuelga de ninguna reserva. Del GPS solo se toma lo que puede demostrar:
        cuánto se alejó del punto de partida (y el doble si volvió), nunca la suma de tramos, que con señal
        de antena se dispara sola. <b>Coincide</b> = lo que el GPS prueba cabe en el km del odómetro.
        <b> 0 km confirmado</b> = la unidad no se movió de verdad. <b>Sin cierre</b> = se movió pero la
        jornada no tiene con qué medirla. <b>GPS &gt; odóm.</b> = el recorrido demostrable supera al
        registrado: revisar si falta una lectura o si el tablero se fotografió antes de tiempo.
      </p>
    </main>
  );
}
