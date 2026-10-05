"use client";
// app/combustible/FacturasCorreo.tsx — Pestaña «📧 Facturas»: lo que llegó al correo y qué
// hizo el ERP con cada línea (lib/combustible/factura-lineas.ts declara los códigos).
// Lo que quedó en «Revisar» se confirma aquí con un clic, eligiendo placa y fecha.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import { ETIQUETA_LINEA, type LineaFactura, type PlanLinea } from "@/lib/combustible/factura-lineas";
import type { CodigoConexion } from "@/lib/combustible/correo-conexion";
import CorreoFacturas from "./CorreoFacturas";

const S = (n: number | null | undefined) =>
  n == null ? "—" : `S/ ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ESTADO: Record<string, [string, string]> = {
  conciliada:     ["Conciliada", "#15803d"],
  parcial:        ["Con pendientes", "#b45309"],
  procesada:      ["Leída", "#1d4ed8"],
  con_diferencia: ["Sin líneas legibles", "#b91c1c"],
  sin_adjunto:    ["Sin XML ni PDF", "#b91c1c"],
  error:          ["Error", "#b91c1c"],
  descartada:     ["Descartada", "#9ca3af"],
  pendiente:      ["Pendiente", "#6b7280"],
};

export default function FacturasCorreo() {
  const [filas, setFilas] = useState<any[] | null>(null);
  const [placas, setPlacas] = useState<string[]>([]);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [sync, setSync] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [elec, setElec] = useState<Record<string, { placa: string; fecha: string }>>({});
  // De qué buzón se lee (lo resuelve CorreoFacturas). Sin uno legible, «Leer correo ahora» no
  // tiene a quién preguntar: el botón se apaga y DICE por qué en vez de fallar al pulsarlo.
  const [codigoCorreo, setCodigoCorreo] = useState<CodigoConexion | null>(null);
  const sinCorreo = codigoCorreo === "ninguna" || codigoCorreo === "rota";

  const cargar = useCallback(async () => {
    const { data, error } = await supabase.from("radar_facturas").select("*")
      .not("lineas", "is", null).order("recibido_en", { ascending: false }).limit(80);
    const { data: otras } = await supabase.from("radar_facturas").select("*")
      .in("estado", ["sin_adjunto", "error"]).order("recibido_en", { ascending: false }).limit(20);
    if (error) { setFilas([]); setSync(/lineas/.test(error.message) ? "Falta correr supabase/combustible-03-saldo-cuenta-y-facturas.sql." : error.message); return; }
    const todas = [...((data as any[]) ?? []), ...((otras as any[]) ?? []).filter((o) => !((data as any[]) ?? []).some((d) => d.id === o.id))];
    todas.sort((a, b) => String(b.recibido_en).localeCompare(String(a.recibido_en)));
    setFilas(todas);
  }, []);

  useEffect(() => {
    cargar();
    Promise.all([supabase.from("vehiculos").select("placa"), supabase.from("vehiculos_tercero").select("placa")]).then(([a, b]) => {
      setPlacas([...((a.data as any[]) ?? []), ...((b.data as any[]) ?? [])].map((r) => String(r.placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean).sort());
    });
  }, [cargar]);

  async function sincronizar() {
    setCargando(true); setSync("Buscando facturas en el correo…");
    try {
      const r = await fetch("/api/combustible/facturas", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ accion: "sincronizar" }) });
      const j = await r.json();
      if (!j.ok) setSync(`No se pudo: ${j.error ?? r.status}`);
      else {
        const t = (j.resultados ?? []).reduce((a: any, x: any) => ({
          vistos: a.vistos + (x.correos_vistos || 0), nuevas: a.nuevas + (x.nuevas || 0),
          reg: a.reg + (x.registradas || 0), rev: a.rev + (x.por_revisar || 0),
        }), { vistos: 0, nuevas: 0, reg: 0, rev: 0 });
        const buzon = (j.resultados ?? []).map((x: any) => x.correo?.email).find(Boolean);
        setSync(`${buzon ? `${buzon}: ` : ""}${t.vistos} correo(s) coinciden con el filtro · ${t.nuevas} factura(s) nuevas · ${t.reg} carga(s) registradas desde la factura · ${t.rev} línea(s) para revisar.`);
      }
    } catch (e: any) { setSync(e.message); }
    setCargando(false);
    cargar();
  }

  async function confirmar(f: any, n: number, e: { placa: string; fecha: string }) {
    const r = await fetch("/api/combustible/facturas", {
      method: "POST", headers: await cabecerasErp(),
      body: JSON.stringify({ accion: "confirmar_linea", factura_id: f.id, n, placa: e.placa || null, fecha: e.fecha || null }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) alert(j.linea?.detalle ?? j.error ?? "No se pudo registrar");
    cargar();
  }

  async function descartar(f: any) {
    if (!confirm("¿Descartar este correo? No es una factura de combustible y no se volverá a mirar.")) return;
    await fetch("/api/combustible/facturas", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ accion: "descartar", factura_id: f.id }) });
    cargar();
  }

  const resumen = useMemo(() => {
    const planes = (filas ?? []).flatMap((f) => (Array.isArray(f.conciliacion) ? f.conciliacion : []) as PlanLinea[]);
    const c = (k: string) => planes.filter((p) => p.codigo === k).length;
    return { reg: c("registrar"), ya: c("ya_registrada"), rev: c("revisar"), radar: c("en_radar_pendiente"), esp: c("en_espera") };
  }, [filas]);

  return (
    <section className="space-y-3">
      <CorreoFacturas onCodigo={setCodigoCorreo} />

      <div className="rounded-xl border bg-white p-4 flex flex-wrap items-center gap-4">
        <div className="text-sm text-gray-700 flex-1 min-w-[260px]">
          <b>La factura del correo es el respaldo oficial del Radar IA.</b> Cada 3 horas el ERP lee las facturas del correo conectado arriba
          (XML de SUNAT; si no llega, el PDF) y compara línea por línea con las cargas registradas.
          Las que faltan se registran solas (sin odómetro); las dudosas quedan aquí.
        </div>
        <button onClick={sincronizar} disabled={cargando || sinCorreo}
          title={sinCorreo ? "Primero conecta el correo donde llegan las facturas (arriba)." : undefined}
          className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
          {cargando ? "Sincronizando…" : "📧 Leer correo ahora"}
        </button>
        {sinCorreo && <div className="basis-full text-xs text-amber-800">Primero conecta el correo donde llegan las facturas de Primax (bloque de arriba).</div>}
        {sync && <div className="basis-full text-xs text-gray-600">{sync}</div>}
        <div className="basis-full flex flex-wrap gap-3 text-xs">
          <span style={{ color: ETIQUETA_LINEA.ya_registrada.color }}>✓ {resumen.ya} ya registradas</span>
          <span style={{ color: ETIQUETA_LINEA.registrar.color }}>＋ {resumen.reg} registradas por factura</span>
          <span style={{ color: ETIQUETA_LINEA.en_radar_pendiente.color }}>⏳ {resumen.radar} en revisión del Radar</span>
          <span style={{ color: ETIQUETA_LINEA.en_espera.color }}>… {resumen.esp} esperando al Radar</span>
          <span style={{ color: ETIQUETA_LINEA.revisar.color }}>⚠ {resumen.rev} para revisar</span>
        </div>
      </div>

      {filas == null ? <div className="text-sm text-gray-400 p-4">Cargando…</div> :
       filas.length === 0 ? <div className="text-sm text-gray-500 p-6 text-center border rounded-xl bg-white">Todavía no hay facturas leídas. Conecta el correo arriba y pulsa «Leer correo ahora».</div> :
      <div className="rounded-xl border bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[11px] uppercase text-gray-500">
            <tr><th className="p-2 text-left">Recibido</th><th className="p-2 text-left">Emisor</th><th className="p-2 text-left">Comprobante</th><th className="p-2 text-right">Total</th><th className="p-2 text-left">Fuente</th><th className="p-2 text-left">Estado</th><th></th></tr>
          </thead>
          <tbody>
            {filas.map((f) => {
              const [et, col] = ESTADO[f.estado] ?? [f.estado, "#6b7280"];
              const plan: PlanLinea[] = Array.isArray(f.conciliacion) ? f.conciliacion : [];
              const lineas: LineaFactura[] = Array.isArray(f.lineas) ? f.lineas : [];
              return (
                <React.Fragment key={f.id}>
                  <tr className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => setAbierta(abierta === f.id ? null : f.id)}>
                    <td className="p-2 whitespace-nowrap">{f.recibido_en ? new Date(f.recibido_en).toLocaleDateString("es-PE") : "—"}</td>
                    <td className="p-2">{f.razon_social ?? f.remitente_email ?? "—"}<div className="text-[11px] text-gray-400">{f.asunto}</div></td>
                    <td className="p-2 font-mono text-xs">{f.serie && f.numero ? `${f.serie}-${f.numero}` : "—"}</td>
                    <td className="p-2 text-right font-bold">{S(f.total)}</td>
                    <td className="p-2 text-xs">{f.fuente_extraccion === "xml_ubl" ? "XML SUNAT" : f.fuente_extraccion === "vision_pdf" ? "PDF (IA)" : "—"}</td>
                    <td className="p-2"><span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: col + "1a", color: col }}>{et}</span></td>
                    <td className="p-2 text-xs text-gray-400">{abierta === f.id ? "▲" : "▼"}</td>
                  </tr>
                  {abierta === f.id && (
                    <tr className="bg-gray-50"><td colSpan={7} className="p-3 space-y-2">
                      {f.error && <div className="text-xs text-red-700">{f.error}</div>}
                      {f.diferencia_detalle && <div className="text-xs text-amber-800">{f.diferencia_detalle}</div>}
                      {f.gmail_message_id && <a href={`https://mail.google.com/mail/u/0/#all/${f.gmail_message_id}`} target="_blank" rel="noreferrer" className="text-xs text-[#1d4ed8] font-bold hover:underline">Abrir el correo en Gmail ↗</a>}
                      {lineas.map((l) => {
                        const p = plan.find((x) => x.n === l.n);
                        const et2 = p ? ETIQUETA_LINEA[p.codigo] : null;
                        const k = `${f.id}:${l.n}`;
                        const e = elec[k] ?? { placa: l.placa ?? "", fecha: l.fecha ?? "" };
                        const confirmable = p && (p.codigo === "revisar" || p.codigo === "en_espera") && p.motivo !== "no_cuadra" && p.motivo !== "ambigua" && p.motivo !== "nota_credito";
                        return (
                          <div key={l.n} className="rounded-lg border bg-white p-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="font-bold">#{l.n}</span>
                            <span className="min-w-[160px]">{l.descripcion || "—"}</span>
                            <span>{l.cantidad ?? "—"} {l.unidad_codigo ?? ""} × {l.precio_unitario ?? "—"} = <b>{S(l.total)}</b></span>
                            <span>🚌 {l.placa ?? "sin placa"}</span>
                            <span>📅 {l.fecha ?? "sin fecha"}</span>
                            {l.nota_despacho && <span className="font-mono">{l.nota_despacho}</span>}
                            {et2 && <span className="font-bold px-2 py-0.5 rounded-full" style={{ background: et2.color + "1a", color: et2.color }}>{et2.texto}</span>}
                            {p && <div className="basis-full text-gray-600">{p.detalle}{p.codigo === "en_radar_pendiente" && <> <Link href="/radar-ia?tab=combustible" className="text-[#1d4ed8] font-bold hover:underline">Ir a Radar IA →</Link></>}</div>}
                            {confirmable && (
                              <div className="basis-full flex flex-wrap items-center gap-2 pt-1">
                                <select value={e.placa} onChange={(ev) => setElec({ ...elec, [k]: { ...e, placa: ev.target.value } })} className="border rounded px-2 py-1">
                                  <option value="">— placa —</option>
                                  {placas.map((pl) => <option key={pl} value={pl}>{pl}</option>)}
                                </select>
                                <input type="date" value={e.fecha} onChange={(ev) => setElec({ ...elec, [k]: { ...e, fecha: ev.target.value } })} className="border rounded px-2 py-1" />
                                <button disabled={!e.placa || !e.fecha} onClick={() => confirmar(f, l.n, e)}
                                  className="px-3 py-1 rounded font-bold text-white disabled:opacity-50" style={{ background: "#1d4ed8" }}>Registrar esta carga</button>
                                <span className="text-gray-500">Se registra sin odómetro, enlazada a esta factura.</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {f.estado !== "descartada" && <button onClick={() => descartar(f)} className="text-xs text-gray-500 hover:underline">Descartar: no es una factura de combustible</button>}
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>}
    </section>
  );
}
