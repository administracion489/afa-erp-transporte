"use client";

// ══════════════════════════════════════════════════════════════════════════════
// Descarga masiva de documentos por RUTA.
// Agrupa los servicios de un rango de fechas por huella de ruta (mismos paraderos +
// hora por parada + hora de salida) y baja los Manifiestos MTC / Reportes de Servicio
// de los servicios seleccionados en UN solo PDF (un servicio por página + carátula).
//
// El roster nominal (PII) solo se carga al pulsar "descargar", y solo de lo seleccionado.
// La ventana se abre en el mismo click (gesto de usuario) para no morir en el bloqueador
// de pop-ups; luego se escribe el HTML ya generado.
// ══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  cargarServiciosRango, agruparPorRuta,
  construirManifiestosLoteHTML, construirReportesLoteHTML,
  type ServicioLote, type GrupoRuta, type EmpresaPerfilLite,
} from "@/lib/descarga-masiva";

type IP = { size?: number; color?: string; className?: string; strokeWidth?: number };
const I = {
  X:        (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
  Search:   (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
  Chevron:  (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="6 9 12 15 18 9" /></svg>,
  File:     (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>,
  Pin:      (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>,
  Clock:    (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>,
  Down:     (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
  Spin:     (p: IP) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.color ?? "currentColor"} strokeWidth={p.strokeWidth ?? 2} strokeLinecap="round" className={`animate-spin ${p.className ?? ""}`}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>,
};

function fmtFechaCorta(f: string | null): string {
  return f ? new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—";
}
function fmtRango(min: string | null, max: string | null): string {
  if (!min) return "—";
  return min === max ? fmtFechaCorta(min) : `${fmtFechaCorta(min)} → ${fmtFechaCorta(max)}`;
}

export default function DescargaMasivaModal({ fechaInicial, onClose }: { fechaInicial: string; onClose: () => void }) {
  const [desde, setDesde] = useState(fechaInicial);
  const [hasta, setHasta] = useState(fechaInicial);
  const [busqueda, setBusqueda] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [servicios, setServicios] = useState<ServicioLote[]>([]);
  const [empresa, setEmpresa] = useState<EmpresaPerfilLite | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const [generando, setGenerando] = useState<"manifiesto" | "reporte" | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const cargar = useCallback(async () => {
    if (desde > hasta) { setError("La fecha 'desde' no puede ser mayor que 'hasta'."); return; }
    setLoading(true); setError(null);
    try {
      const { servicios, empresa } = await cargarServiciosRango(desde, hasta);
      setServicios(servicios); setEmpresa(empresa);
      setSel(new Set());
      // Abrir por defecto la ruta con más servicios (la primera del agrupado).
      const g = agruparPorRuta(servicios);
      setAbiertos(g.length ? new Set([g[0].firma]) : new Set());
    } catch (e: any) {
      setError(e?.message || "No se pudieron cargar los servicios.");
      setServicios([]);
    } finally { setLoading(false); }
  }, [desde, hasta]);

  useEffect(() => { cargar(); }, [cargar]);

  const grupos: GrupoRuta[] = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const base = q
      ? servicios.filter(s =>
          s.cliente_nombre.toLowerCase().includes(q) ||
          (s.vehiculo_placa || "").toLowerCase().includes(q) ||
          s.origen.toLowerCase().includes(q) || s.destino.toLowerCase().includes(q))
      : servicios;
    return agruparPorRuta(base);
  }, [servicios, busqueda]);

  const idsVisibles = useMemo(() => new Set(grupos.flatMap(g => g.servicios.map(s => s.id))), [grupos]);
  const nManifiesto = useMemo(() => servicios.filter(s => sel.has(s.id) && idsVisibles.has(s.id) && s.puede_manifiesto).length, [servicios, sel, idsVisibles]);
  const nReporte = useMemo(() => servicios.filter(s => sel.has(s.id) && idsVisibles.has(s.id) && s.puede_reporte).length, [servicios, sel, idsVisibles]);
  const nSel = useMemo(() => [...sel].filter(id => idsVisibles.has(id)).length, [sel, idsVisibles]);

  const toggleServicio = (id: number) => setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleGrupo = (g: GrupoRuta) => setSel(prev => {
    const n = new Set(prev);
    const todos = g.servicios.every(s => n.has(s.id));
    g.servicios.forEach(s => (todos ? n.delete(s.id) : n.add(s.id)));
    return n;
  });
  const toggleAbierto = (firma: string) => setAbiertos(prev => { const n = new Set(prev); n.has(firma) ? n.delete(firma) : n.add(firma); return n; });

  function descargar(tipo: "manifiesto" | "reporte") {
    if (!empresa) return;
    const elegibles = servicios.filter(s => sel.has(s.id) && idsVisibles.has(s.id) && (tipo === "manifiesto" ? s.puede_manifiesto : s.puede_reporte));
    if (!elegibles.length) return;
    // Abrir la ventana YA (mismo gesto) para esquivar el bloqueador de pop-ups.
    const win = window.open("", "_blank");
    if (!win) { alert("Permite las ventanas emergentes para poder descargar el paquete de documentos."); return; }
    const etiqueta = tipo === "manifiesto" ? "Manifiestos MTC" : "Reportes de Servicio";
    win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Generando…</title></head><body style="font-family:Arial,sans-serif;padding:48px;color:#0b315f"><h2 style="margin:0 0 8px">Generando ${elegibles.length} ${etiqueta}…</h2><p style="color:#64748b;margin:0">No cierres esta pestaña. La impresión se abrirá automáticamente.</p></body></html>`);
    setGenerando(tipo);
    const fn = tipo === "manifiesto" ? construirManifiestosLoteHTML : construirReportesLoteHTML;
    fn(elegibles, empresa)
      .then(html => { win.document.open(); win.document.write(html); win.document.close(); })
      .catch(err => { try { win.document.body.innerHTML = `<p style="color:#b91c1c;font-family:Arial;padding:48px">Error al generar los documentos: ${String(err?.message || err)}</p>`; } catch {} })
      .finally(() => setGenerando(null));
  }

  const totalServicios = servicios.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-[#eef3f8] rounded-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">

        {/* Encabezado */}
        <div className="flex items-center justify-between px-5 py-4 bg-white border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] flex items-center justify-center flex-shrink-0"><I.Down size={17} color="#0b315f" /></div>
            <div className="min-w-0">
              <h2 className="font-black text-[#0b315f] text-base leading-none truncate">Descarga masiva por ruta</h2>
              <p className="text-[11px] text-gray-400 mt-1 leading-tight">Servicios con los mismos paraderos y horarios se agrupan · un PDF por tipo, un servicio por página</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center flex-shrink-0"><I.X size={15} /></button>
        </div>

        {/* Filtros */}
        <div className="px-5 py-3 bg-white border-b border-gray-100 flex-shrink-0 flex flex-col sm:flex-row gap-2.5">
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-bold text-gray-500">Desde</label>
            <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)}
              className="border border-gray-200 rounded-xl px-2.5 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f]" />
            <label className="text-[11px] font-bold text-gray-500">Hasta</label>
            <input type="date" value={hasta} min={desde} onChange={e => setHasta(e.target.value)}
              className="border border-gray-200 rounded-xl px-2.5 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f]" />
          </div>
          <div className="relative flex-1">
            <I.Search size={14} color="#cbd5e1" className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#0b315f]"
              placeholder="Filtrar por cliente, placa o paradero…" value={busqueda} onChange={e => setBusqueda(e.target.value)} />
          </div>
        </div>

        {/* Cuerpo */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
              <div className="w-8 h-8 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-3" />
              <p className="font-bold text-gray-500 text-sm">Cargando servicios y agrupando rutas…</p>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-6 text-center">
              <p className="font-bold text-red-700 text-sm">{error}</p>
            </div>
          ) : grupos.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
              <p className="text-3xl mb-2">📭</p>
              <p className="font-bold text-gray-600 text-sm">Sin servicios en este rango</p>
              <p className="text-xs text-gray-400 mt-1">Ajusta las fechas o el filtro de búsqueda.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between px-1">
                <span className="text-xs text-gray-500 font-semibold">{grupos.length} ruta{grupos.length !== 1 ? "s" : ""} · {totalServicios} servicio{totalServicios !== 1 ? "s" : ""}</span>
                {nSel > 0 && <span className="text-xs text-[#0b315f] font-bold">{nSel} seleccionado{nSel !== 1 ? "s" : ""}</span>}
              </div>

              {grupos.map(g => {
                const abierto = abiertos.has(g.firma);
                const selN = g.servicios.filter(s => sel.has(s.id)).length;
                const todos = selN === g.servicios.length && selN > 0;
                return (
                  <div key={g.firma} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                    {/* Cabecera de ruta */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <button onClick={() => toggleGrupo(g)} title={todos ? "Quitar toda la ruta" : "Seleccionar toda la ruta"}
                        className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${todos ? "bg-[#0b315f] border-[#0b315f]" : selN > 0 ? "bg-[#0b315f]/20 border-[#0b315f]" : "border-gray-300 hover:border-[#0b315f]"}`}>
                        {todos && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
                        {!todos && selN > 0 && <div className="w-2 h-2 bg-[#0b315f] rounded-sm" />}
                      </button>
                      <button onClick={() => toggleAbierto(g.firma)} className="flex-1 min-w-0 text-left">
                        <div className="flex items-center gap-1.5 text-sm font-black text-[#0b315f] truncate">
                          <I.Pin size={13} color="#0b315f" className="flex-shrink-0" /><span className="truncate">{g.titulo}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className="text-[10px] font-bold text-gray-500 bg-gray-100 rounded-md px-1.5 py-0.5">{g.paraderos} paradero{g.paraderos !== 1 ? "s" : ""}</span>
                          <span className="text-[10px] font-bold text-gray-500 bg-gray-100 rounded-md px-1.5 py-0.5 flex items-center gap-1"><I.Clock size={9} /> {g.horaSalida}</span>
                          <span className="text-[10px] font-bold text-[#0b315f] bg-[#EFF6FF] rounded-md px-1.5 py-0.5">{g.servicios.length} servicio{g.servicios.length !== 1 ? "s" : ""}</span>
                          <span className="text-[10px] text-gray-400 font-mono">{fmtRango(g.fechaMin, g.fechaMax)}</span>
                        </div>
                      </button>
                      <button onClick={() => toggleAbierto(g.firma)} className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <I.Chevron size={16} color="#94a3b8" className={`transition-transform ${abierto ? "rotate-180" : ""}`} />
                      </button>
                    </div>

                    {/* Servicios de la ruta */}
                    {abierto && (
                      <div className="border-t border-gray-50 divide-y divide-gray-50">
                        {g.servicios.map(s => {
                          const marcado = sel.has(s.id);
                          return (
                            <div key={s.id} className={`flex items-center gap-3 px-4 py-2.5 ${marcado ? "bg-[#EFF6FF]/40" : ""}`}>
                              <button onClick={() => toggleServicio(s.id)}
                                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${marcado ? "bg-[#0b315f] border-[#0b315f]" : "border-gray-300 hover:border-[#0b315f]"}`}>
                                {marcado && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
                              </button>
                              <button onClick={() => toggleServicio(s.id)} className="flex-1 min-w-0 text-left">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="text-sm font-bold text-gray-800 font-mono flex-shrink-0">{fmtFechaCorta(s.reserva.fecha_servicio)}</span>
                                  <span className="text-sm text-gray-600 truncate">· {s.cliente_nombre}</span>
                                </div>
                                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                  <span className="text-[10px] text-gray-400 font-mono">{s.vehiculo_placa || "sin placa"}</span>
                                  <span className="text-[10px] text-gray-400">· {s.pax_total} pax</span>
                                  {s.es_ter && <span className="text-[9px] font-bold text-amber-700 bg-amber-50 rounded px-1 py-0.5">Tercerizado</span>}
                                  {/* Elegibilidad por documento */}
                                  <span className={`text-[9px] font-bold rounded px-1 py-0.5 ${s.puede_manifiesto ? "text-green-700 bg-green-50" : "text-gray-400 bg-gray-100"}`}
                                    title={s.puede_manifiesto ? "Manifiesto MTC disponible" : `Manifiesto no disponible: ${s.motivo_manifiesto}`}>
                                    MTC {s.puede_manifiesto ? "✓" : "✗"}
                                  </span>
                                  <span className={`text-[9px] font-bold rounded px-1 py-0.5 ${s.puede_reporte ? "text-blue-700 bg-blue-50" : "text-gray-400 bg-gray-100"}`}
                                    title={s.puede_reporte ? "Reporte de servicio disponible" : `Reporte no disponible: ${s.motivo_reporte}`}>
                                    Reporte {s.puede_reporte ? "✓" : "✗"}
                                  </span>
                                </div>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Pie: acciones */}
        <div className="px-5 py-3.5 bg-white border-t border-gray-100 flex-shrink-0 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          <p className="text-[11px] text-gray-400 flex-1 leading-tight">
            Solo se incluyen los servicios elegibles de tu selección. El resto se omite (verás el motivo en cada uno).
          </p>
          <button onClick={() => descargar("manifiesto")} disabled={!!generando || nManifiesto === 0}
            className="flex items-center justify-center gap-2 bg-[#15803d] hover:bg-[#136c34] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold px-4 py-2.5 rounded-xl transition-colors">
            {generando === "manifiesto" ? <I.Spin size={15} color="#fff" /> : <I.File size={15} color="#fff" />}
            Manifiestos MTC {nManifiesto > 0 && `(${nManifiesto})`}
          </button>
          <button onClick={() => descargar("reporte")} disabled={!!generando || nReporte === 0}
            className="flex items-center justify-center gap-2 bg-[#0b315f] hover:bg-[#0d3a70] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold px-4 py-2.5 rounded-xl transition-colors">
            {generando === "reporte" ? <I.Spin size={15} color="#fff" /> : <I.File size={15} color="#fff" />}
            Reportes {nReporte > 0 && `(${nReporte})`}
          </button>
        </div>
      </div>
    </div>
  );
}
