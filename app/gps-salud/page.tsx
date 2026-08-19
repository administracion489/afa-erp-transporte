"use client";

// Salud del rastreo GPS. Responde de un vistazo: ¿a qué conductores se les corta la
// ubicación durante el servicio? Hasta ahora no había forma de saberlo — el semáforo de la
// app del conductor solo dice si el rastreo arrancó, no si el sistema operativo lo mató
// después. Aquí manda el dato del servidor: si llegaron puntos, hubo rastreo.
//
// Casi siempre la causa NO es la app sino el teléfono: el permiso de ubicación puesto en
// "Solo mientras se usa la app" en vez de "Permitir siempre", o el ahorro de batería del
// fabricante matando el servicio. Por eso la ficha de cada conductor trae su teléfono: la
// solución es configurarle el equipo.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Conductor = {
  clave: string; nombre: string; telefono: string | null; tercero: boolean;
  servicios: number; sinTraza: number; medidos: number;
  cobertura: number | null; peor: number | null; cortes: number; kmACiegas: number;
  pctAntena: number;
};
type Servicio = {
  clave: string; nombre: string; tercero: boolean; reservaId: number;
  fecha: string; hora: string | null; puntos: number; puntosCrudos: number; pctAntena: number; durMin: number;
  cobertura: number | null; cortes: number; peorHuecoMin: number; kmACiegas: number;
  origen: string | null; destino: string | null;
};
type Respuesta = {
  desde: string; hasta: string; recortado: boolean; limite: number; aviso: string | null;
  totales: { servicios: number; sinTraza: number; sinConductor: number; conductores: number; malos: number; kmACiegas: number };
  conductores: Conductor[]; servicios: Servicio[];
};

const hoyLima = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const diasAntes = (f: string, n: number) => new Date(Date.parse(f) - n * 86400000).toISOString().slice(0, 10);

/** Semáforo de cobertura. Los cortes de la banda salen de la medición real de la flota:
 *  los equipos sanos dan 100% y los que tienen el permiso mal puesto rondan el 35-40%. */
const banda = (c: number | null) =>
  c === null ? { label: "Sin datos", color: "#6b7280", bg: "#f3f4f6" }
  : c >= 95   ? { label: "Bien",     color: "#166534", bg: "#dcfce7" }
  : c >= 90   ? { label: "Aceptable",color: "#3f6212", bg: "#ecfccb" }
  : c >= 70   ? { label: "Irregular",color: "#92400e", bg: "#fef3c7" }
  :             { label: "Mal",      color: "#991b1b", bg: "#fee2e2" };

export default function GpsSaludPage() {
  const [hasta, setHasta] = useState(hoyLima());
  const [dias, setDias]   = useState(7);
  const [data, setData]   = useState<Respuesta | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [detalle, setDetalle] = useState<string | null>(null);  // clave del conductor abierto
  const peticionRef = React.useRef(0);

  const cargar = useCallback(async () => {
    // El <input type="date"> emite "" mientras se reescribe: no hay nada que medir aún.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta)) return;
    const mio = ++peticionRef.current;   // la medición tarda; si el usuario cambia el rango
    setCargando(true); setError(""); setDetalle(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const desde = diasAntes(hasta, dias - 1);
      const r = await fetch(`/api/gps-salud?desde=${desde}&hasta=${hasta}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
      });
      // El texto primero: si el rango es grande la plataforma puede cortar con una página
      // HTML de timeout, y r.json() estallaría con un "Unexpected token '<'" incomprensible.
      const cuerpo = await r.text();
      let j: any = null;
      try { j = JSON.parse(cuerpo); } catch { /* no era JSON */ }
      if (!r.ok || !j) {
        throw new Error(j?.error || (r.status === 504 || r.status === 502
          ? "El rango es muy grande y la medición superó el tiempo límite. Prueba con menos días."
          : `Error ${r.status}`));
      }
      if (mio !== peticionRef.current) return;   // llegó tarde: manda la petición más reciente
      setData(j);
    } catch (e: any) {
      if (mio !== peticionRef.current) return;
      setError(e?.message ?? "No se pudo cargar");
      setData(null);                              // no dejar la tabla del rango anterior
    } finally {
      if (mio === peticionRef.current) setCargando(false);
    }
  }, [hasta, dias]);

  // El acceso lo controla el layout: /gps-salud está en menuGrupos con módulo "monitoreo",
  // así que oculta el enlace y bloquea la ruta a quien no lo tenga — y a diferencia de
  // usePermiso trata bien al rol admin, que no tiene filas en permisos_usuario.
  useEffect(() => { void cargar(); }, [cargar]);

  const t = data?.totales;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: -0.5, color: "#111827" }}>Salud del rastreo GPS</h1>
          <p style={{ margin: "6px 0 0", color: "#6b7280", fontSize: 14, maxWidth: 620 }}>
            Cuánto del viaje se rastreó de verdad, por conductor. Un valor bajo casi siempre significa
            que el teléfono tiene la ubicación en <strong>“Solo mientras se usa la app”</strong> o el
            ahorro de batería activo — no que el conductor haga nada mal.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={dias} onChange={e => setDias(Number(e.target.value))}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14 }}>
            <option value={3}>Últimos 3 días</option>
            <option value={7}>Últimos 7 días</option>
            <option value={15}>Últimos 15 días</option>
          </select>
          <input type="date" value={hasta} onChange={e => setHasta(e.target.value)}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14 }} />
          <button onClick={() => void cargar()} disabled={cargando}
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#1f2433", color: "#fff", fontWeight: 600, fontSize: 14, cursor: cargando ? "default" : "pointer", opacity: cargando ? .6 : 1 }}>
            {cargando ? "Midiendo…" : "Actualizar"}
          </button>
        </div>
      </div>

      {data?.aviso && <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: "#fef3c7", color: "#92400e", fontSize: 14 }}>{data.aviso}</div>}

      {error && <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b", fontSize: 14 }}>{error}</div>}

      {cargando && !data && <div style={{ marginTop: 24, color: "#6b7280" }}>Analizando las trazas de cada servicio…</div>}

      {t && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 22 }}>
            {[
              { k: "Conductores medidos", v: t.conductores },
              { k: "Con rastreo deficiente", v: t.malos, alerta: t.malos > 0 },
              { k: "Servicios analizados", v: t.servicios },
              { k: "Sin un solo punto", v: t.sinTraza, alerta: t.sinTraza > 0 },
              { k: "Km sin rastrear", v: `${t.kmACiegas} km`, alerta: t.kmACiegas > 0 },
            ].map(c => (
              <div key={c.k} style={{ padding: "14px 16px", borderRadius: 12, background: c.alerta ? "#fef2f2" : "#f9fafb", border: `1px solid ${c.alerta ? "#fecaca" : "#e5e7eb"}` }}>
                <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: .3 }}>{c.k}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: c.alerta ? "#991b1b" : "#111827", marginTop: 2 }}>{c.v}</div>
              </div>
            ))}
          </div>

          {data!.recortado && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "#fef3c7", color: "#92400e", fontSize: 13 }}>
              El rango tiene más servicios de los que se analizan de una vez: se midieron los {data!.limite} más recientes. Acorta el rango para verlos todos.
            </div>
          )}

          <h2 style={{ fontSize: 15, fontWeight: 700, color: "#374151", margin: "26px 0 10px" }}>Por conductor</h2>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left" }}>
                  {["Conductor", "Cobertura", "Por antena", "Peor servicio", "Servicios", "Cortes", "Km a ciegas", ""].map((h, i) => (
                    <th key={h + i} style={{ padding: "10px 12px", fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: .3, borderBottom: "1px solid #e5e7eb" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data!.conductores.map(c => {
                  const b = banda(c.cobertura);
                  const abierto = detalle === c.clave;
                  return (
                    <React.Fragment key={c.clave}>
                      <tr style={{ borderBottom: "1px solid #f3f4f6" }}>
                        <td style={{ padding: "11px 12px" }}>
                          <div style={{ fontWeight: 600, color: "#111827" }}>{c.nombre}</div>
                          <div style={{ fontSize: 12, color: "#9ca3af" }}>
                            {c.tercero ? "Tercerizado" : "Flota propia"}{c.telefono ? ` · ${c.telefono}` : ""}
                          </div>
                        </td>
                        <td style={{ padding: "11px 12px" }}>
                          <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 999, background: b.bg, color: b.color, fontWeight: 700, fontSize: 13 }}>
                            {c.cobertura === null ? "sin traza" : `${c.cobertura}% · ${b.label}`}
                          </span>
                        </td>
                        <td style={{ padding: "11px 12px" }}>
                          {/* % de puntos con precisión peor a 150 m: el teléfono ubica por
                              antena/red, no por satélite. Es la firma del APK viejo (fix
                              6ec35db) o de la "Ubicación precisa" apagada: el mapa descarta
                              esos puntos y el pasajero ve tramos "estimados". */}
                          <span style={{ fontWeight: 700, color: c.pctAntena > 30 ? "#991b1b" : c.pctAntena > 10 ? "#92400e" : "#166534" }}>
                            {c.pctAntena}%
                          </span>
                        </td>
                        <td style={{ padding: "11px 12px", color: c.peor !== null && c.peor < 70 ? "#991b1b" : "#374151" }}>{c.peor === null ? "—" : `${c.peor}%`}</td>
                        <td style={{ padding: "11px 12px", color: "#374151" }}>
                          {c.servicios}
                          {c.sinTraza > 0 && <span style={{ color: "#991b1b", fontWeight: 700 }}> ({c.sinTraza} sin traza)</span>}
                        </td>
                        <td style={{ padding: "11px 12px", color: "#374151" }}>{c.cortes}</td>
                        <td style={{ padding: "11px 12px", fontWeight: c.kmACiegas > 0 ? 700 : 400, color: c.kmACiegas > 0 ? "#991b1b" : "#374151" }}>
                          {c.kmACiegas > 0 ? `${c.kmACiegas} km` : "—"}
                        </td>
                        <td style={{ padding: "11px 12px", textAlign: "right" }}>
                          <button onClick={() => setDetalle(abierto ? null : c.clave)}
                            style={{ padding: "5px 10px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, cursor: "pointer", color: "#374151" }}>
                            {abierto ? "Ocultar" : "Ver servicios"}
                          </button>
                        </td>
                      </tr>
                      {abierto && (
                        <tr>
                          <td colSpan={8} style={{ padding: 0, background: "#fafafa" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                              <tbody>
                                {data!.servicios.filter(s => s.clave === c.clave).map(s => {
                                  const sb = banda(s.cobertura);
                                  return (
                                    <tr key={s.reservaId} style={{ borderBottom: "1px solid #f3f4f6" }}>
                                      <td style={{ padding: "8px 12px 8px 26px", color: "#6b7280", width: 150 }}>
                                        {s.fecha} {s.hora?.slice(0, 5) ?? ""}
                                      </td>
                                      <td style={{ padding: "8px 12px", color: "#374151" }}>
                                        <span style={{ color: "#9ca3af" }}>#{s.reservaId}</span>{" "}
                                        {(s.origen ?? "").slice(0, 34)} → {(s.destino ?? "").slice(0, 34)}
                                      </td>
                                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                                        <span style={{ color: sb.color, fontWeight: 700 }}>{s.cobertura === null ? "sin traza" : `${s.cobertura}%`}</span>
                                      </td>
                                      <td style={{ padding: "8px 12px", color: "#6b7280", whiteSpace: "nowrap" }}>
                                        {s.durMin} min · {s.puntos} pts{s.pctAntena > 10 ? <span style={{ color: "#92400e" }}> · {s.pctAntena}% antena</span> : null}
                                      </td>
                                      <td style={{ padding: "8px 12px", color: s.kmACiegas > 0 ? "#991b1b" : "#9ca3af", whiteSpace: "nowrap" }}>
                                        {s.cortes > 0 ? `${s.cortes} cortes · ${s.kmACiegas} km sin rastrear · peor ${s.peorHuecoMin} min` : "sin cortes"}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {!data!.conductores.length && (
                  <tr><td colSpan={8} style={{ padding: 20, color: "#6b7280", textAlign: "center" }}>No hay servicios finalizados con traza en este rango.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 20, padding: "14px 16px", borderRadius: 10, background: "#f9fafb", border: "1px solid #e5e7eb", fontSize: 13, color: "#4b5563", lineHeight: 1.6 }}>
            <strong style={{ color: "#111827" }}>Cómo leerlo.</strong>{" "}
            <em>Cobertura</em> es el porcentaje del viaje con GPS llegando.{" "}
            <em>Cortes</em> son los tramos en que dejó de llegar ubicación <strong>mientras el bus seguía avanzando</strong> —
            esos son fallos de verdad, no paradas: durante ellos el pasajero ve el bus congelado.{" "}
            <em>Km a ciegas</em> es lo que recorrió sin registrarse.{" "}
            <em>Por antena</em> es el porcentaje de puntos con precisión peor a 150 m: el teléfono está
            ubicando por antena de celular en vez de satélite — esos puntos existen pero el mapa no puede
            dibujarlos y el viaje sale como "estimado". Se corrige con el APK 2.4 (obliga al satélite) y
            revisando que "Ubicación precisa" esté activada en el teléfono.
            <br />
            <strong style={{ color: "#111827" }}>Qué hacer con un conductor en rojo:</strong> en su teléfono, Ajustes → Aplicaciones → AFA →
            Permisos → Ubicación → <strong>“Permitir siempre”</strong>, y quitarle la optimización de batería a la app.
          </div>
        </>
      )}
    </div>
  );
}
