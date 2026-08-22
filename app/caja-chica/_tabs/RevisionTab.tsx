"use client";

// Bandeja de revisión: solo lo que el responsable ya cerró y envió.
// El orden es por antigüedad de envío (FIFO): quien mandó primero se revisa primero,
// porque hasta que no se liquida su rendición no puede recibir más dinero.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { configRendicion, cuadra, type RendicionCajaChica } from "@/lib/finanzas/caja-chica";
import ModalRendicion from "../ModalRendicion";

type Props = { onCambio: () => void };

const CABECERAS = ["Código", "Responsable", "Enviada", "Espera", "Asignado", "Rendido", "Saldo", "Por revisar", "Compr.", "Acciones"];

function fmtFechaHora(f: string | null | undefined): string {
  if (!f) return "—";
  return new Date(f).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Días transcurridos desde el envío (para priorizar la cola). */
function diasEspera(f: string | null | undefined): number {
  if (!f) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(f).getTime()) / 86400000));
}

export default function RevisionTab({ onCambio }: Props) {
  const [rendiciones, setRendiciones] = useState<RendicionCajaChica[]>([]);
  const [loading, setLoading] = useState(true);
  const [seleccionada, setSeleccionada] = useState<number | null>(null);
  const [puedeAprobar, setPuedeAprobar] = useState(false);
  const [usuarioNombre, setUsuarioNombre] = useState("");

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("v_caja_chica_rendiciones")
      .select("*")
      .eq("estado", "por_revisar")
      .order("enviada_at", { ascending: true });
    setRendiciones((data ?? []) as RendicionCajaChica[]);
    setLoading(false);
  }, []);

  // Carga inicial (patrón de todo el ERP). La regla del linter apunta a otro caso
  // —setState síncrono en el cuerpo del efecto—; aquí se escribe tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  // Rol del usuario: no se usa usePermiso porque no contempla admin y expulsaría a un
  // admin que no tenga fila propia en permisos_usuario.
  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user?.id) return;
      const { data } = await supabase.from("usuarios").select("nombre, rol").eq("id", session.user.id).maybeSingle();
      setUsuarioNombre(String(data?.nombre ?? ""));
      setPuedeAprobar(data?.rol === "admin" || data?.rol === "gerente");
    })();
  }, []);

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Por revisar</h1>
          <p className="text-gray-400 text-sm mt-1">
            Rendiciones cerradas por el responsable · Se revisan comprobante por comprobante · Orden por antigüedad
          </p>
        </div>
      </div>

      {!puedeAprobar && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          <span className="text-lg leading-none">🔒</span>
          Solo gerencia puede aprobar rendiciones. Puedes abrirlas y revisar los comprobantes, pero no liquidarlas.
        </div>
      )}

      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {CABECERAS.map((h) => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                      Cargando…
                    </div>
                  </td>
                </tr>
              )}

              {!loading && rendiciones.length === 0 && (
                <tr>
                  <td colSpan={CABECERAS.length} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">✅</p>
                    <p>No hay rendiciones esperando revisión</p>
                  </td>
                </tr>
              )}

              {!loading &&
                rendiciones.map((r) => {
                  const cfg = configRendicion(r.estado);
                  const espera = diasEspera(r.enviada_at);
                  const ok = cuadra(r);
                  return (
                    <tr
                      key={r.id}
                      className="border-t hover:bg-gray-50 cursor-pointer"
                      style={{ borderColor: "#f1f5f9" }}
                      onClick={() => setSeleccionada(r.id)}
                    >
                      <td className="p-3 font-mono font-black text-xs text-[#0b315f]">{r.codigo ?? "—"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium">
                        {r.responsable_nombre}
                        <span className="block text-[10px] text-gray-400">{r.fondo_nombre}</span>
                      </td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFechaHora(r.enviada_at)}</td>
                      <td className="p-3 whitespace-nowrap">
                        <span
                          className="text-xs font-bold px-2.5 py-1 rounded-lg"
                          style={
                            espera >= 3
                              ? { background: "#fee2e2", color: "#991b1b" }
                              : { background: "#f3f4f6", color: "#4b5563" }
                          }
                        >
                          {espera} día{espera === 1 ? "" : "s"}
                        </span>
                      </td>
                      <td className="p-3 font-black text-xs text-[#0b315f]">{fmtMoneda(Number(r.monto_asignado), r.moneda)}</td>
                      <td className="p-3 font-black text-xs text-red-700">{fmtMoneda(Number(r.monto_rendido), r.moneda)}</td>
                      <td className={`p-3 font-black text-xs ${ok ? "text-emerald-700" : Number(r.saldo_pendiente) > 0 ? "text-amber-700" : "text-red-700"}`}>
                        {fmtMoneda(Number(r.saldo_pendiente), r.moneda)}
                      </td>
                      <td className="p-3 font-black text-xs text-amber-700">{fmtMoneda(Number(r.monto_por_revisar ?? 0), r.moneda)}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium">{Number(r.comprobantes ?? 0)}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: cfg.bg, color: cfg.color }}>
                            {cfg.label}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSeleccionada(r.id);
                            }}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700"
                          >
                            Revisar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>{rendiciones.length} rendición{rendiciones.length === 1 ? "" : "es"} en cola</span>
          <span>
            Por revisar:{" "}
            {fmtMoneda(rendiciones.reduce((s, r) => s + Number(r.monto_por_revisar ?? 0), 0))}
          </span>
        </div>
      </section>

      {seleccionada !== null && (
        <ModalRendicion
          rendicionId={seleccionada}
          puedeAprobar={puedeAprobar}
          usuarioNombre={usuarioNombre}
          onCerrar={() => {
            setSeleccionada(null);
            cargar();
            onCambio();
          }}
          onListo={(msg) => {
            setSeleccionada(null);
            showToast(msg);
            cargar();
            onCambio();
          }}
        />
      )}

      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white ${
            toast.ok ? "bg-[#0b315f]" : "bg-red-600"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </main>
  );
}
