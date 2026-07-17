"use client";

// components/programacion/SelectorGrupos.tsx
// =============================================================================
// AFA Transportes · Selector de grupos para el modal de manifiesto
// - Lista grupos disponibles del cliente (más usados primero)
// - Preview de cuántos pasajeros se van a agregar
// - Aplicar grupo: inserta pasajeros nuevos + autoasigna paradas habituales
//   si la reserva las tiene
// =============================================================================

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { normalizarEmpresa } from "@/lib/empresa";

type Grupo = {
  id: number; cliente_id: number | null; nombre: string;
  descripcion: string | null; color: string; icono: string;
  veces_usado: number; total_miembros: number; miembros_con_parada: number;
};

type Miembro = {
  pasajero_id: number;
  parada_habitual_nom: string | null;
  asiento_habitual: string | null;
};

type ParadaReserva = { id: number; nombre: string; orden: number; };

type Props = {
  reservaId: number;
  clienteId: number | null;
  paradas: ParadaReserva[];
  dnisExistentes: Set<string>;  // para no duplicar
  onAplicado: (cantidad: number) => void;  // refresca el modal
};

export default function SelectorGrupos({ reservaId, clienteId, paradas, dnisExistentes, onAplicado }: Props) {
  const [grupos,    setGrupos]    = useState<Grupo[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [aplicando, setAplicando] = useState<number | null>(null);
  const [preview,   setPreview]   = useState<{ grupo: Grupo; miembros: any[] } | null>(null);
  const [abierto,   setAbierto]   = useState(false);

  // ── Carga ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!abierto) return;
    setLoading(true);
    let q = supabase.from("grupos_con_stats").select("*").eq("activo", true);
    // Grupos del cliente + grupos universales (sin cliente)
    if (clienteId) {
      q = q.or(`cliente_id.eq.${clienteId},cliente_id.is.null`);
    }
    q.order("ultimo_uso", { ascending: false, nullsFirst: false })
     .then(({ data }) => {
       setGrupos((data || []) as Grupo[]);
       setLoading(false);
     });
  }, [abierto, clienteId]);

  // ── Preview ──────────────────────────────────────────────────────────────
  const cargarPreview = async (g: Grupo) => {
    const { data } = await supabase
      .from("grupo_pasajeros")
      .select("pasajero_id, parada_habitual_nom, asiento_habitual, pasajeros(id, nombre, dni, telefono, email, empresa)")
      .eq("grupo_id", g.id)
      .order("orden_lista");
    setPreview({ grupo: g, miembros: data || [] });
  };

  // ── Aplicar grupo ────────────────────────────────────────────────────────
  const aplicarGrupo = async () => {
    if (!preview) return;
    const { grupo, miembros } = preview;
    setAplicando(grupo.id);

    let agregados = 0;
    let paradasAsignadas = 0;

    // Filtrar: solo agregar pasajeros que no estén ya en el manifiesto (por DNI)
    const aAgregar = miembros.filter((m: any) => {
      const dni = m.pasajeros?.dni;
      return dni && !dnisExistentes.has(dni);
    });

    if (aAgregar.length === 0) {
      alert(`⚠️ Todos los miembros de "${grupo.nombre}" ya están en el manifiesto`);
      setAplicando(null);
      return;
    }

    // 1) Insertar pasajeros nuevos como ad-hoc de la reserva
    //    (clonamos los datos para no romper el vínculo del cliente original)
    const { data: insertados, error } = await supabase
      .from("pasajeros")
      .insert(aAgregar.map((m: any) => ({
        nombre:     m.pasajeros.nombre,
        dni:        m.pasajeros.dni,
        telefono:   m.pasajeros.telefono,
        email:      m.pasajeros.email,
        empresa:    normalizarEmpresa(m.pasajeros.empresa),
        cliente_id: clienteId,
        reserva_id: reservaId,
        activo:     true,
      })))
      .select();

    if (error) {
      alert(`Error al aplicar grupo: ${error.message}`);
      setAplicando(null);
      return;
    }

    agregados = insertados?.length || 0;

    // 2) Auto-asignación de parada habitual (matchea por nombre de parada)
    if (insertados && paradas.length > 0) {
      const asignaciones: any[] = [];
      insertados.forEach((nuevoPas: any, idx: number) => {
        const miembroOrig = aAgregar[idx];
        const paradaHab = miembroOrig.parada_habitual_nom;
        if (paradaHab) {
          // Buscar parada cuyo nombre matchee (case-insensitive, substring)
          const paradaMatch = paradas.find(p =>
            p.nombre.toLowerCase().includes(paradaHab.toLowerCase()) ||
            paradaHab.toLowerCase().includes(p.nombre.toLowerCase())
          );
          if (paradaMatch) {
            asignaciones.push({
              pasajero_id:     nuevoPas.id,
              parada_id:       paradaMatch.id,
              estado:          "esperando",
              estado_abordaje: "Pendiente",
              asiento:         miembroOrig.asiento_habitual,
            });
            paradasAsignadas++;
          }
        }
      });
      if (asignaciones.length > 0) {
        await supabase.from("pasajeros_parada").insert(asignaciones);
      }
    }

    // 3) Registrar la aplicación (incrementa veces_usado vía trigger)
    await supabase.from("grupo_aplicado_reserva").insert({
      grupo_id: grupo.id, reserva_id: reservaId,
      pasajeros_agregados: agregados, paradas_asignadas: paradasAsignadas,
    });

    setAplicando(null);
    setPreview(null);
    setAbierto(false);
    onAplicado(agregados);

    const msg = paradasAsignadas > 0
      ? `✅ ${agregados} pasajeros agregados · ${paradasAsignadas} auto-asignados a paradas habituales`
      : `✅ ${agregados} pasajeros agregados al manifiesto`;
    alert(msg);
  };

  // ─── RENDER ────────────────────────────────────────────────────────────

  if (!abierto) {
    return (
      <button onClick={() => setAbierto(true)}
        className="px-4 py-2 rounded-xl font-bold text-xs text-white"
        style={{ background: "#6d28d9" }}>
        📦 Cargar grupo
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.6)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-start justify-between" style={{ borderColor: "#e2e8f0" }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl text-white" style={{ background: "#6d28d9" }}>📦</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Aplicar grupo al manifiesto</h2>
              <p className="text-xs text-gray-400">
                {preview ? "Revisa qué se va a agregar antes de confirmar" : "Selecciona un grupo reutilizable"}
              </p>
            </div>
          </div>
          <button onClick={() => { setAbierto(false); setPreview(null); }} className="text-2xl text-gray-300 hover:text-gray-600 leading-none">✕</button>
        </div>

        {/* CONTENIDO */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* Vista de preview */}
          {preview ? (
            <div>
              <div className="rounded-xl p-4 mb-4 flex items-center gap-3 border-2"
                style={{ background: preview.grupo.color + "11", borderColor: preview.grupo.color }}>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl text-white"
                  style={{ background: preview.grupo.color }}>{preview.grupo.icono}</div>
                <div className="flex-1">
                  <p className="font-bold text-gray-900">{preview.grupo.nombre}</p>
                  <p className="text-xs text-gray-500">{preview.grupo.descripcion || "Sin descripción"}</p>
                  <div className="flex gap-3 mt-1 text-[11px]">
                    <span className="font-bold" style={{ color: preview.grupo.color }}>👥 {preview.miembros.length} miembros</span>
                    <span className="text-gray-400">📊 Usado {preview.grupo.veces_usado} veces</span>
                  </div>
                </div>
              </div>

              {/* Análisis de impacto */}
              {(() => {
                const conDni = preview.miembros.filter((m: any) => m.pasajeros?.dni);
                const yaEnManifiesto = conDni.filter((m: any) => dnisExistentes.has(m.pasajeros.dni));
                const nuevos = conDni.length - yaEnManifiesto.length;
                const conParadaHab = preview.miembros.filter((m: any) => m.parada_habitual_nom).length;
                const paradasMatcheables = preview.miembros.filter((m: any) => {
                  if (!m.parada_habitual_nom) return false;
                  return paradas.some(p =>
                    p.nombre.toLowerCase().includes(m.parada_habitual_nom.toLowerCase()) ||
                    m.parada_habitual_nom.toLowerCase().includes(p.nombre.toLowerCase())
                  );
                }).length;

                return (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <div className="rounded-xl p-2.5 bg-green-50 border border-green-100">
                      <p className="text-[10px] font-bold uppercase text-green-700">Se agregarán</p>
                      <p className="text-2xl font-black text-green-700">{nuevos}</p>
                    </div>
                    <div className="rounded-xl p-2.5 bg-yellow-50 border border-yellow-100">
                      <p className="text-[10px] font-bold uppercase text-yellow-700">Ya en manifiesto</p>
                      <p className="text-2xl font-black text-yellow-700">{yaEnManifiesto.length}</p>
                    </div>
                    <div className="rounded-xl p-2.5 bg-blue-50 border border-blue-100">
                      <p className="text-[10px] font-bold uppercase text-blue-700">Con parada habitual</p>
                      <p className="text-2xl font-black text-blue-700">{conParadaHab}</p>
                    </div>
                    <div className="rounded-xl p-2.5 bg-purple-50 border border-purple-100">
                      <p className="text-[10px] font-bold uppercase text-purple-700">Auto-asignables</p>
                      <p className="text-2xl font-black text-purple-700">{paradasMatcheables}</p>
                    </div>
                  </div>
                );
              })()}

              {/* Lista de miembros */}
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="border-b" style={{ borderColor: "#e2e8f0" }}>
                    {["Pasajero", "DNI", "Parada habitual", "Asiento", "Estado"].map(h => (
                      <th key={h} className="p-2 text-left font-bold uppercase text-[10px] text-gray-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.miembros.map((m: any) => {
                    const yaExiste = m.pasajeros?.dni && dnisExistentes.has(m.pasajeros.dni);
                    const paradaMatch = m.parada_habitual_nom && paradas.find(p =>
                      p.nombre.toLowerCase().includes(m.parada_habitual_nom.toLowerCase()) ||
                      m.parada_habitual_nom.toLowerCase().includes(p.nombre.toLowerCase())
                    );
                    return (
                      <tr key={m.pasajero_id} className="border-b hover:bg-gray-50"
                        style={{ borderColor: "#f1f5f9", opacity: yaExiste ? 0.5 : 1 }}>
                        <td className="p-2 font-bold text-gray-800">{m.pasajeros?.nombre || "—"}</td>
                        <td className="p-2 font-mono text-gray-600">{m.pasajeros?.dni || "—"}</td>
                        <td className="p-2">
                          {m.parada_habitual_nom ? (
                            <div className="flex items-center gap-1">
                              <span className="text-gray-700">{m.parada_habitual_nom}</span>
                              {paradaMatch ? <span className="text-green-600 text-[10px] font-bold">✓</span> : <span className="text-amber-500 text-[10px] font-bold" title="No coincide con paradas de esta reserva">⚠</span>}
                            </div>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="p-2 font-mono text-gray-700">{m.asiento_habitual || "—"}</td>
                        <td className="p-2">
                          {yaExiste ? (
                            <span className="text-[10px] font-bold text-yellow-700">Ya existe</span>
                          ) : (
                            <span className="text-[10px] font-bold text-green-700">+ Nuevo</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            // Lista de grupos
            <>
              {loading ? (
                <div className="text-center py-10 text-gray-400 text-sm">
                  <div className="w-6 h-6 border-2 border-gray-200 border-t-[#6d28d9] rounded-full animate-spin mx-auto mb-2" />
                  Cargando grupos disponibles...
                </div>
              ) : grupos.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed rounded-2xl" style={{ borderColor: "#e2e8f0" }}>
                  <p className="text-4xl mb-2">📦</p>
                  <p className="text-sm font-bold text-gray-700 mb-1">No hay grupos disponibles</p>
                  <p className="text-xs text-gray-400 mb-3">
                    {clienteId
                      ? "Crea grupos en /pasajeros → pestaña Grupos para este cliente"
                      : "Esta reserva no tiene cliente asignado y no hay grupos universales"}
                  </p>
                  <a href="/pasajeros" target="_blank" className="inline-block px-4 py-2 rounded-xl font-bold text-xs text-white"
                    style={{ background: "#6d28d9" }}>
                    Ir a Grupos →
                  </a>
                </div>
              ) : (
                <div className="space-y-2">
                  {grupos.map(g => (
                    <button key={g.id} onClick={() => cargarPreview(g)}
                      className="w-full flex items-center gap-3 p-3 rounded-xl border hover:shadow-md text-left transition-all"
                      style={{ borderColor: g.color + "44" }}>
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl text-white flex-shrink-0"
                        style={{ background: g.color }}>{g.icono}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-gray-900">{g.nombre}</p>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                            style={{ background: g.color + "22", color: g.color }}>
                            {g.total_miembros} pax
                          </span>
                          {g.miembros_con_parada > 0 && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-50 text-green-700">
                              📍 {g.miembros_con_parada}
                            </span>
                          )}
                          {!g.cliente_id && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                              Universal
                            </span>
                          )}
                        </div>
                        {g.descripcion && <p className="text-xs text-gray-500 mt-0.5 truncate">{g.descripcion}</p>}
                        <p className="text-[10px] text-gray-400 mt-0.5">📊 Usado {g.veces_usado} veces</p>
                      </div>
                      <span className="text-gray-300 text-lg flex-shrink-0">›</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* FOOTER */}
        <div className="px-6 py-3 border-t flex items-center justify-between gap-3"
          style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
          {preview ? (
            <>
              <button onClick={() => setPreview(null)}
                className="px-4 py-2 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
                ← Volver a la lista
              </button>
              <button onClick={aplicarGrupo} disabled={aplicando !== null}
                className="px-5 py-2 rounded-xl font-bold text-sm text-white disabled:opacity-60"
                style={{ background: preview.grupo.color }}>
                {aplicando ? "Aplicando..." : "✅ Aplicar al manifiesto"}
              </button>
            </>
          ) : (
            <>
              <span className="text-xs text-gray-400">
                {grupos.length} grupo(s) disponible(s) {clienteId ? "para este cliente" : ""}
              </span>
              <button onClick={() => setAbierto(false)}
                className="px-4 py-2 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
                Cerrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}