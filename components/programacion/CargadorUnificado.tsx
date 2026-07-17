"use client";

import React, { useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { normalizarEmpresa } from "@/lib/empresa";
import {
  parsearManifiestoUnificado,
  descargarPlantillaUnificada,
  ParadaAgrupada,
} from "@/lib/manifiesto-unificado-csv";

type ParadaExistente = {
  id: number;
  nombre: string;
  lat: number | null;
  lng: number | null;
};

type Props = {
  reservaId: number;
  clienteId: number | null;
  paradasExistentes: ParadaExistente[];
  dnisExistentes: Set<string>;
  onAplicado: () => void;
};

// Determina si dos paradas son la misma (mismo nombre + coords cercanas)
function esLaMismaParada(
  a: { nombre: string; lat: number; lng: number },
  b: { nombre: string; lat: number | null; lng: number | null }
): boolean {
  if (b.lat === null || b.lng === null) return false;
  if (a.nombre.toLowerCase().trim() !== b.nombre.toLowerCase().trim()) return false;
  const dLat = Math.abs(a.lat - b.lat);
  const dLng = Math.abs(a.lng - b.lng);
  return dLat < 0.0005 && dLng < 0.0005; // ~50m de tolerancia
}

export default function CargadorUnificado(props: Props) {
  const { reservaId, clienteId, paradasExistentes, dnisExistentes, onAplicado } = props;

  const [abierto, setAbierto] = useState(false);
  const [procesando, setProcesando] = useState(false);
  const [preview, setPreview] = useState<{
    paradas: ParadaAgrupada[];
    errores: { fila: number; motivo: string }[];
    totalPasajeros: number;
  } | null>(null);
  const [mensaje, setMensaje] = useState<{ tipo: "ok" | "err"; texto: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcesando(true);
    setMensaje(null);

    try {
      const resultado = await parsearManifiestoUnificado(file);

      if (resultado.paradas.length === 0) {
        setMensaje({
          tipo: "err",
          texto: "Sin datos validos. " + (resultado.errores[0]?.motivo || "Archivo vacio"),
        });
        setProcesando(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      setPreview({
        paradas: resultado.paradas,
        errores: resultado.errores.map((e) => ({ fila: e.fila, motivo: e.motivo })),
        totalPasajeros: resultado.totalPasajeros,
      });
    } catch (err: any) {
      setMensaje({ tipo: "err", texto: "Error al procesar archivo: " + (err?.message || err) });
    } finally {
      setProcesando(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const aplicar = async () => {
    if (!preview) return;
    setProcesando(true);
    setMensaje(null);

    try {
      let paradasCreadas = 0;
      let paradasReutilizadas = 0;
      let pasajerosCreados = 0;
      let pasajerosReutilizados = 0;
      let asignacionesCreadas = 0;
      let errores = 0;

      // Calcular siguiente orden disponible
      let siguienteOrden = paradasExistentes.length > 0
        ? Math.max(...paradasExistentes.map((p) => 0)) + 1
        : 1;
      // Buscar el max orden real de paradas existentes
      const ordenRespuesta = await supabase
        .from("paradas")
        .select("orden")
        .eq("reserva_id", reservaId)
        .order("orden", { ascending: false })
        .limit(1);
      if (ordenRespuesta.data && ordenRespuesta.data.length > 0) {
        siguienteOrden = (ordenRespuesta.data[0].orden || 0) + 1;
      } else {
        siguienteOrden = 1;
      }

      // Para cada parada del Excel
      for (const parada of preview.paradas) {
        // 1) Buscar si ya existe (reutilizar)
        const existente = paradasExistentes.find((pe) =>
          esLaMismaParada({ nombre: parada.nombre, lat: parada.lat, lng: parada.lng }, pe)
        );

        let paradaId: number;

        if (existente) {
          paradaId = existente.id;
          paradasReutilizadas++;
        } else {
          // Crear nueva parada
          const ins = await supabase
            .from("paradas")
            .insert({
              reserva_id: reservaId,
              orden: siguienteOrden,
              nombre: parada.nombre,
              direccion: parada.direccion,
              lat: parada.lat,
              lng: parada.lng,
              hora_estimada: parada.hora,
            })
            .select("id")
            .single();

          if (ins.error || !ins.data) {
            errores++;
            continue;
          }
          paradaId = ins.data.id;
          paradasCreadas++;
          siguienteOrden++;
        }

        // 2) Para cada pasajero de esa parada
        for (const pax of parada.pasajeros) {
          // ¿Ya existe el pasajero por DNI?
          let pasajeroId: number;
          const buscaPax = await supabase
            .from("pasajeros")
            .select("id")
            .eq("dni", pax.dni)
            .maybeSingle();

          if (buscaPax.data) {
            pasajeroId = buscaPax.data.id;
            pasajerosReutilizados++;
            // Actualizar datos básicos por si cambiaron. `empresa` solo se pisa si
            // el Excel trae un valor: no borramos una empresa ya cargada cuando la
            // columna viene vacía.
            const empresaNorm = normalizarEmpresa(pax.empresa);
            const camposPax: Record<string, any> = {
              nombre: pax.nombre,
              telefono: pax.telefono,
              email: pax.email,
              cliente_id: clienteId,
            };
            if (empresaNorm) camposPax.empresa = empresaNorm;
            await supabase
              .from("pasajeros")
              .update(camposPax)
              .eq("id", pasajeroId);
          } else {
            // Crear pasajero nuevo
            const insPax = await supabase
              .from("pasajeros")
              .insert({
                dni: pax.dni,
                nombre: pax.nombre,
                telefono: pax.telefono,
                email: pax.email,
                empresa: normalizarEmpresa(pax.empresa),
                cliente_id: clienteId,
                reserva_id: reservaId,
                activo: true,
              })
              .select("id")
              .single();
            if (insPax.error || !insPax.data) {
              errores++;
              continue;
            }
            pasajeroId = insPax.data.id;
            pasajerosCreados++;
          }

          // 3) Crear la asignación pasajero → parada
          // Primero eliminar cualquier asignación previa de este pasajero en CUALQUIER parada de esta reserva
          const paradaIdsReserva = await supabase
            .from("paradas")
            .select("id")
            .eq("reserva_id", reservaId);
          const ids = (paradaIdsReserva.data || []).map((x: any) => x.id);
          if (ids.length > 0) {
            await supabase
              .from("pasajeros_parada")
              .delete()
              .eq("pasajero_id", pasajeroId)
              .in("parada_id", ids);
          }

          const insAsig = await supabase
            .from("pasajeros_parada")
            .insert({
              pasajero_id: pasajeroId,
              parada_id: paradaId,
              estado: "esperando",
              estado_abordaje: "Pendiente",
              asiento: pax.asiento,
              notas: pax.notas,
            });

          if (insAsig.error) {
            errores++;
          } else {
            asignacionesCreadas++;
          }
        }
      }

      // Reporte final
      const partes = [
        paradasCreadas + " parada(s) creada(s)",
        paradasReutilizadas > 0 ? paradasReutilizadas + " parada(s) reutilizada(s)" : "",
        pasajerosCreados + " pasajero(s) nuevo(s)",
        pasajerosReutilizados > 0 ? pasajerosReutilizados + " pasajero(s) actualizado(s)" : "",
        asignacionesCreadas + " asignacion(es) creada(s)",
        errores > 0 ? errores + " error(es)" : "",
      ].filter(Boolean);

      setMensaje({ tipo: "ok", texto: partes.join(" - ") });
      setPreview(null);
      setAbierto(false);
      onAplicado();
    } catch (err: any) {
      setMensaje({ tipo: "err", texto: "Error al aplicar: " + (err?.message || err) });
    } finally {
      setProcesando(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setAbierto(true)}
        className="px-4 py-2 rounded-xl font-bold text-xs text-white hover:opacity-90"
        style={{ background: "#7c3aed" }}
      >
        Manifiesto Completo (Paradas + Pasajeros)
      </button>

      {mensaje ? (
        <div
          className="fixed bottom-4 right-4 max-w-md rounded-xl px-4 py-3 text-xs font-medium shadow-lg flex items-start justify-between gap-2 z-50"
          style={{
            background: mensaje.tipo === "ok" ? "#dcfce7" : "#fee2e2",
            color: mensaje.tipo === "ok" ? "#166534" : "#991b1b",
            border: "1px solid " + (mensaje.tipo === "ok" ? "#86efac" : "#fca5a5"),
          }}
        >
          <span>{mensaje.texto}</span>
          <button onClick={() => setMensaje(null)} className="opacity-60 hover:opacity-100 font-bold">X</button>
        </div>
      ) : null}

      {abierto ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ background: "rgba(15, 23, 42, 0.55)" }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">

            {/* Header */}
            <div className="px-6 py-4 border-b flex items-start justify-between" style={{ borderColor: "#e2e8f0" }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-xl" style={{ background: "#7c3aed" }}>M</div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Cargar manifiesto completo</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Paradas + pasajeros + asignaciones en un solo Excel</p>
                </div>
              </div>
              <button
                onClick={() => { setAbierto(false); setPreview(null); }}
                className="text-2xl text-gray-300 hover:text-gray-600 leading-none"
              >
                X
              </button>
            </div>

            {/* PASO 1: subir archivo */}
            {!preview ? (
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                <div className="rounded-xl border-2 border-dashed p-6 text-center" style={{ borderColor: "#c4b5fd", background: "#faf5ff" }}>
                  <p className="text-sm font-bold text-gray-800 mb-2">Sube tu Excel con paradas y pasajeros</p>
                  <p className="text-xs text-gray-500 mb-4">El sistema detecta paradas duplicadas, crea pasajeros nuevos, y asigna cada uno a su parada automaticamente.</p>

                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,.xls,.xlsx"
                    className="hidden"
                    onChange={handleArchivo}
                  />
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={procesando}
                      className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50"
                      style={{ background: "#7c3aed" }}
                    >
                      {procesando ? "Procesando..." : "Seleccionar archivo Excel/CSV"}
                    </button>
                    <button
                      onClick={descargarPlantillaUnificada}
                      className="px-5 py-2 rounded-xl font-bold text-xs border text-gray-600 hover:bg-white"
                    >
                      Descargar plantilla con ejemplos
                    </button>
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-900 space-y-1">
                  <p className="font-bold">Columnas que debe tener el Excel:</p>
                  <p><strong>Requeridas:</strong> Parada, Lat, Lng, DNI, Nombre Pasajero</p>
                  <p><strong>Opcionales:</strong> Orden, Direccion, Hora, Telefono, Email, Empresa, Asiento, Notas</p>
                  <p className="mt-2 pt-2 border-t border-blue-200">
                    <strong>Tip:</strong> Una fila por pasajero. Si 10 personas suben en la misma parada, repite las columnas de la parada en 10 filas. El sistema agrupa automaticamente.
                  </p>
                </div>
              </div>
            ) : null}

            {/* PASO 2: preview antes de aplicar */}
            {preview ? (
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

                {/* Resumen */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-xl p-3 border" style={{ background: "#f3e8ff", borderColor: "#d8b4fe" }}>
                    <p className="text-[10px] font-bold uppercase text-purple-700">Paradas</p>
                    <p className="text-2xl font-black text-purple-900">{preview.paradas.length}</p>
                  </div>
                  <div className="rounded-xl p-3 border" style={{ background: "#dbeafe", borderColor: "#93c5fd" }}>
                    <p className="text-[10px] font-bold uppercase text-blue-700">Pasajeros</p>
                    <p className="text-2xl font-black text-blue-900">{preview.totalPasajeros}</p>
                  </div>
                  <div className="rounded-xl p-3 border" style={{ background: preview.errores.length > 0 ? "#fee2e2" : "#dcfce7", borderColor: preview.errores.length > 0 ? "#fca5a5" : "#86efac" }}>
                    <p className="text-[10px] font-bold uppercase" style={{ color: preview.errores.length > 0 ? "#991b1b" : "#166534" }}>Errores</p>
                    <p className="text-2xl font-black" style={{ color: preview.errores.length > 0 ? "#991b1b" : "#166534" }}>{preview.errores.length}</p>
                  </div>
                </div>

                {/* Lista de paradas con sus pasajeros */}
                <div className="space-y-2">
                  <p className="text-xs font-bold text-gray-700">Detalle de lo que se va a cargar:</p>
                  {preview.paradas.map((p, i) => {
                    const yaExiste = paradasExistentes.find((pe) =>
                      esLaMismaParada({ nombre: p.nombre, lat: p.lat, lng: p.lng }, pe)
                    );
                    return (
                      <div key={i} className="rounded-xl border bg-white p-3" style={{ borderColor: "#e2e8f0" }}>
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <div
                              className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-black flex-shrink-0"
                              style={{ background: yaExiste ? "#16a34a" : "#7c3aed" }}
                            >
                              {p.orden}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-gray-900 truncate">{p.nombre}</p>
                              <p className="text-[10px] text-gray-500 font-mono">{p.lat.toFixed(4)}, {p.lng.toFixed(4)} {p.hora ? "- " + p.hora : ""}</p>
                            </div>
                          </div>
                          <span
                            className="flex-shrink-0 text-[10px] font-black px-2 py-0.5 rounded-full"
                            style={{
                              background: yaExiste ? "#dcfce7" : "#ede9fe",
                              color: yaExiste ? "#166534" : "#6d28d9",
                            }}
                          >
                            {yaExiste ? "REUTILIZAR" : "CREAR"}
                          </span>
                        </div>
                        <div className="text-[11px] text-gray-600 ml-8">
                          {p.pasajeros.length} pasajero(s):{" "}
                          {p.pasajeros.slice(0, 3).map((px) => px.nombre.split(" ")[0]).join(", ")}
                          {p.pasajeros.length > 3 ? " y " + (p.pasajeros.length - 3) + " mas..." : ""}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Errores */}
                {preview.errores.length > 0 ? (
                  <div className="rounded-xl border bg-red-50 p-3" style={{ borderColor: "#fca5a5" }}>
                    <p className="text-xs font-bold text-red-900 mb-1">Filas con errores ({preview.errores.length}):</p>
                    <div className="max-h-32 overflow-y-auto space-y-0.5">
                      {preview.errores.slice(0, 10).map((e, i) => (
                        <p key={i} className="text-[10px] text-red-800">Fila {e.fila}: {e.motivo}</p>
                      ))}
                      {preview.errores.length > 10 ? <p className="text-[10px] text-red-600 italic">... y {preview.errores.length - 10} mas</p> : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Footer */}
            <div className="px-6 py-3 border-t flex items-center justify-between gap-3" style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
              <button
                onClick={() => { setAbierto(false); setPreview(null); }}
                className="px-4 py-2 rounded-xl font-bold text-xs border text-gray-600 hover:bg-white"
              >
                Cancelar
              </button>
              {preview ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => setPreview(null)}
                    className="px-4 py-2 rounded-xl font-bold text-xs border text-gray-600 hover:bg-white"
                  >
                    Cambiar archivo
                  </button>
                  <button
                    onClick={aplicar}
                    disabled={procesando || preview.paradas.length === 0}
                    className="px-5 py-2 rounded-xl font-bold text-xs text-white disabled:opacity-50"
                    style={{ background: "#7c3aed" }}
                  >
                    {procesando ? "Aplicando..." : "Aplicar al manifiesto"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}