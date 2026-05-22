"use client";

// PanelMensajesPasajeros.tsx
// Panel en tiempo real para el operador — recibe mensajes de pasajeros
// Colocar en: components/seguimiento/PanelMensajesPasajeros.tsx

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type MensajePasajero = {
  id: number;
  pasajero_id: number | null;
  reserva_id: number | null;
  parada_id: number | null;
  tipo: string;
  mensaje: string;
  leido: boolean;
  leido_por: string | null;
  leido_at: string | null;
  created_at: string;
  // joins
  pasajero?: { nombre: string; empresa: string | null } | null;
  parada?: { nombre: string } | null;
  reserva?: { origen: string; destino: string } | null;
};

const TIPO_CFG: Record<string, { ico: string; color: string; bg: string; label: string }> = {
  tardanza:    { ico: "⏰", color: "#92400E", bg: "#FEF3C7", label: "Tardanza" },
  cancelacion: { ico: "❌", color: "#991B1B", bg: "#FEF2F2", label: "Cancelación" },
  incidencia:  { ico: "🚨", color: "#991B1B", bg: "#FEF2F2", label: "Incidencia" },
  novedad:     { ico: "💬", color: "#1E40AF", bg: "#EFF6FF", label: "Novedad" },
  otro:        { ico: "✏️", color: "#374151", bg: "#F3F4F6", label: "Otro" },
};

function fmtTime(s: string) {
  const d = new Date(s);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)  return "Ahora";
  if (diff < 3600) return `Hace ${Math.floor(diff / 60)} min`;
  return d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
}

export default function PanelMensajesPasajeros() {
  const [mensajes,    setMensajes]    = useState<MensajePasajero[]>([]);
  const [abierto,     setAbierto]     = useState(false);
  const [marcando,    setMarcando]    = useState<number | null>(null);

  const cargar = useCallback(async () => {
    const { data } = await supabase
      .from("mensajes_pasajero")
      .select(`
        *,
        pasajero:pasajeros(nombre, empresa),
        parada:paradas(nombre),
        reserva:reservas(origen, destino)
      `)
      .order("created_at", { ascending: false })
      .limit(50);
    setMensajes((data as MensajePasajero[]) || []);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Realtime — nuevo mensaje llega al instante
  useEffect(() => {
    const ch = supabase
      .channel("mensajes-pasajero-erp")
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "mensajes_pasajero",
      }, () => cargar())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [cargar]);

  async function marcarLeido(id: number) {
    setMarcando(id);
    await supabase.from("mensajes_pasajero").update({
      leido: true,
      leido_at: new Date().toISOString(),
    }).eq("id", id);
    setMensajes(prev => prev.map(m => m.id === id ? { ...m, leido: true } : m));
    setMarcando(null);
  }

  async function marcarTodosLeidos() {
    const ids = noLeidos.map(m => m.id);
    if (!ids.length) return;
    await supabase.from("mensajes_pasajero")
      .update({ leido: true, leido_at: new Date().toISOString() })
      .in("id", ids);
    setMensajes(prev => prev.map(m => ({ ...m, leido: true })));
  }

  const noLeidos = mensajes.filter(m => !m.leido);
  const hayNuevos = noLeidos.length > 0;

  return (
    <>
      {/* ── BOTÓN FLOTANTE ── */}
      <button
        onClick={() => setAbierto(v => !v)}
        className="relative flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm transition-all"
        style={{
          background: hayNuevos ? "#0b315f" : "#f1f5f9",
          color: hayNuevos ? "white" : "#475569",
          border: hayNuevos ? "none" : "1px solid #e2e8f0",
        }}>
        <span style={{ fontSize: 16 }}>💬</span>
        Mensajes pasajeros
        {hayNuevos && (
          <span style={{
            background: "#ef4444", color: "white",
            borderRadius: "50%", width: 20, height: 20,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 900,
          }}>
            {noLeidos.length > 9 ? "9+" : noLeidos.length}
          </span>
        )}
      </button>

      {/* ── PANEL LATERAL / MODAL ── */}
      {abierto && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          style={{ background: "rgba(15,23,42,0.5)" }}
          onClick={() => setAbierto(false)}>
          <div
            className="h-full bg-white flex flex-col shadow-2xl"
            style={{ width: "100%", maxWidth: 420 }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex-shrink-0 px-5 py-4 border-b flex items-center justify-between"
              style={{ background: "#0b315f" }}>
              <div>
                <p className="text-white font-black text-base">Mensajes de pasajeros</p>
                <p className="text-blue-200 text-xs mt-0.5">
                  {hayNuevos ? `${noLeidos.length} sin leer` : "Todos leídos"} · En tiempo real
                </p>
              </div>
              <div className="flex items-center gap-2">
                {hayNuevos && (
                  <button
                    onClick={marcarTodosLeidos}
                    className="text-xs font-bold text-blue-200 hover:text-white px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors">
                    Marcar todos leídos
                  </button>
                )}
                <button onClick={() => setAbierto(false)}
                  className="w-8 h-8 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors">
                  ✕
                </button>
              </div>
            </div>

            {/* Lista */}
            <div className="flex-1 overflow-y-auto">
              {mensajes.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-6">
                  <p style={{ fontSize: 48, marginBottom: 12 }}>💬</p>
                  <p className="font-bold text-gray-700">Sin mensajes aún</p>
                  <p className="text-sm text-gray-400 mt-2">Los reportes de pasajeros aparecerán aquí en tiempo real</p>
                </div>
              ) : (
                <div className="divide-y" style={{ borderColor: "#f1f5f9" }}>
                  {mensajes.map(m => {
                    const cfg = TIPO_CFG[m.tipo] || TIPO_CFG.novedad;
                    return (
                      <div key={m.id}
                        className="px-5 py-4 transition-colors"
                        style={{ background: m.leido ? "white" : "#f8fafc" }}>

                        {/* Cabecera del mensaje */}
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2">
                            {/* Pill tipo */}
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                              style={{ background: cfg.bg, color: cfg.color }}>
                              {cfg.ico} {cfg.label}
                            </span>
                            {!m.leido && (
                              <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                            )}
                          </div>
                          <span className="text-xs text-gray-400 flex-shrink-0">{fmtTime(m.created_at)}</span>
                        </div>

                        {/* Pasajero */}
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-7 h-7 rounded-lg bg-[#0b315f] flex items-center justify-center text-white text-xs font-black flex-shrink-0">
                            {m.pasajero?.nombre?.charAt(0).toUpperCase() || "?"}
                          </div>
                          <div>
                            <p className="text-sm font-bold text-gray-900 leading-tight">{m.pasajero?.nombre || "Pasajero"}</p>
                            {m.pasajero?.empresa && <p className="text-xs text-gray-400">{m.pasajero.empresa}</p>}
                          </div>
                        </div>

                        {/* Mensaje */}
                        <div className="rounded-xl px-3 py-2.5 mb-3"
                          style={{ background: cfg.bg, border: `1px solid ${cfg.color}22` }}>
                          <p className="text-sm font-medium" style={{ color: cfg.color }}>{m.mensaje}</p>
                        </div>

                        {/* Contexto ruta/parada */}
                        {(m.reserva || m.parada) && (
                          <div className="flex items-center gap-3 mb-3 text-xs text-gray-500">
                            {m.reserva && (
                              <span className="flex items-center gap-1">
                                🚌 {m.reserva.origen} → {m.reserva.destino}
                              </span>
                            )}
                            {m.parada && (
                              <span className="flex items-center gap-1">
                                📍 {m.parada.nombre}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Acción */}
                        {!m.leido ? (
                          <button
                            onClick={() => marcarLeido(m.id)}
                            disabled={marcando === m.id}
                            className="w-full py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                            style={{ background: "#0b315f", color: "white" }}>
                            {marcando === m.id ? "Marcando..." : "✓ Marcar como atendido"}
                          </button>
                        ) : (
                          <p className="text-xs text-gray-400 text-center">
                            ✓ Atendido {m.leido_at ? fmtTime(m.leido_at) : ""}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}