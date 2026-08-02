"use client";

import React, { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { parsearParadasArchivo, descargarPlantillaParadas } from "@/lib/paradas-csv";

declare global {
  interface Window {
    google: any;
  }
}

export type ParadaGestion = {
  id: number;
  reserva_id: number;
  orden: number;
  nombre: string;
  direccion: string | null;
  lat: number | null;
  lng: number | null;
  hora_estimada: string | null;
  notas: string | null;
  place_id?: string | null;
};

type Props = {
  reservaId: number;
  paradas: ParadaGestion[];
  onChange: () => void;
};

type FormEdit = {
  nombre: string;
  direccion: string;
  lat: string;
  lng: string;
  hora_estimada: string;
};

function cargarGoogleMaps(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("No window"));
    if (window.google && window.google.maps && window.google.maps.places) { resolve(); return; }
    const existe = document.getElementById("google-maps-script");
    if (existe) {
      const wait = setInterval(() => {
        if (window.google && window.google.maps && window.google.maps.places) { clearInterval(wait); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(wait); reject(new Error("Timeout Google Maps")); }, 10000);
      return;
    }
    const s = document.createElement("script");
    s.id = "google-maps-script";
    s.src = "https://maps.googleapis.com/maps/api/js?key=" + apiKey + "&libraries=places&language=es&region=PE";
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Error cargando Google Maps"));
    document.head.appendChild(s);
  });
}

function BuscadorGooglePlaces(props: {
  onSeleccionar: (p: { nombre: string; direccion: string; lat: number; lng: number; place_id: string }) => void;
  apiKey: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inputRef.current) return;
    setCargando(true);
    cargarGoogleMaps(props.apiKey)
      .then(() => {
        if (!inputRef.current) return;
        const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
          types: ["geocode", "establishment"],
          componentRestrictions: { country: "pe" },
          // Solo los campos que se usan abajo (geometry.location, no geometry entero): menos datos facturados por sesion
          fields: ["name", "formatted_address", "geometry.location", "place_id"],
        });
        autocomplete.addListener("place_changed", () => {
          const place = autocomplete.getPlace();
          if (!place.geometry || !place.geometry.location) { setError("Selecciona una opcion de la lista"); return; }
          setError(null);
          const pName = place.name || "";
          const pAddr = place.formatted_address || "";
          const direccion = pName && pAddr && !pAddr.toLowerCase().includes(pName.toLowerCase())
            ? `${pName}, ${pAddr}` : pAddr || pName;
          props.onSeleccionar({
            nombre: pName || pAddr,
            direccion,
            lat: place.geometry.location.lat(),
            lng: place.geometry.location.lng(),
            place_id: place.place_id || "",
          });
          if (inputRef.current) inputRef.current.value = "";
        });
        setCargando(false);
      })
      .catch((e) => { setError("Error cargando Google Maps: " + e.message); setCargando(false); });
    // eslint-disable-next-line
  }, []);

  return (
    <div className="flex-1 min-w-[200px]">
      <input
        ref={inputRef}
        type="text"
        placeholder={cargando ? "Cargando Google Maps..." : "Buscar lugar o direccion en Lima..."}
        disabled={cargando}
        className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
      />
      {error ? <p className="text-[10px] text-red-600 mt-1">{error}</p> : null}
      <p className="text-[10px] text-gray-400 mt-0.5">Escribe para autocompletar - selecciona una opcion</p>
    </div>
  );
}

function inputCls() {
  return "w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]";
}

export default function GestorParadas(props: Props) {
  const { reservaId, paradas, onChange } = props;

  const [importando,  setImportando]  = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [mensaje,     setMensaje]     = useState<{ tipo: "ok" | "err" | "warn"; texto: string } | null>(null);
  const [modoCarga,   setModoCarga]   = useState<"vista" | "excel" | "manual">("vista");
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [formEdit,    setFormEdit]    = useState<FormEdit>({ nombre: "", direccion: "", lat: "", lng: "", hora_estimada: "" });
  const fileRef = useRef<HTMLInputElement>(null);

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "";

  const abrirEdicion = (p: ParadaGestion) => {
    setEditandoId(p.id);
    setFormEdit({
      nombre:        p.nombre,
      direccion:     p.direccion || "",
      lat:           p.lat !== null ? String(p.lat) : "",
      lng:           p.lng !== null ? String(p.lng) : "",
      hora_estimada: p.hora_estimada || "",
    });
    setMensaje(null);
  };

  const cancelarEdicion = () => { setEditandoId(null); };

  const guardarEdicion = async () => {
    if (!editandoId) return;
    if (!formEdit.nombre.trim()) { setMensaje({ tipo: "err", texto: "El nombre es obligatorio" }); return; }

    const latNum = formEdit.lat ? parseFloat(formEdit.lat) : null;
    const lngNum = formEdit.lng ? parseFloat(formEdit.lng) : null;

    if (formEdit.lat && isNaN(latNum!)) { setMensaje({ tipo: "err", texto: "Latitud invalida (ej: -12.0219)" }); return; }
    if (formEdit.lng && isNaN(lngNum!)) { setMensaje({ tipo: "err", texto: "Longitud invalida (ej: -77.1143)" }); return; }

    setGuardando(true);
    const { error } = await supabase.from("paradas").update({
      nombre:        formEdit.nombre.trim(),
      direccion:     formEdit.direccion.trim() || null,
      lat:           latNum,
      lng:           lngNum,
      hora_estimada: formEdit.hora_estimada || null,
    }).eq("id", editandoId);

    setGuardando(false);

    if (error) { setMensaje({ tipo: "err", texto: "Error al guardar: " + error.message }); return; }

    setMensaje({ tipo: "ok", texto: "Parada actualizada" });
    setEditandoId(null);
    onChange();
  };

  const handleArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportando(true); setMensaje(null);
    try {
      const resultado = await parsearParadasArchivo(file);
      if (resultado.ok.length === 0) {
        setMensaje({ tipo: "err", texto: "Sin filas validas. Primer error: " + (resultado.errores[0]?.motivo || "n/d") });
        setImportando(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }
      const maxOrden = paradas.length > 0 ? Math.max(...paradas.map((p) => p.orden)) : 0;
      const filas = resultado.ok.map((p, i) => ({
        reserva_id: reservaId, orden: maxOrden + i + 1,
        nombre: p.nombre, direccion: p.direccion,
        lat: p.lat, lng: p.lng, hora_estimada: p.hora_estimada, notas: p.notas,
      }));
      const ins = await supabase.from("paradas").insert(filas);
      if (ins.error) {
        setMensaje({ tipo: "err", texto: "Error al guardar: " + ins.error.message });
        setImportando(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }
      setMensaje({ tipo: "ok", texto: resultado.ok.length + " parada(s) cargada(s)" + (resultado.errores.length > 0 ? " - " + resultado.errores.length + " con error" : "") });
      onChange(); setModoCarga("vista");
    } catch (err: any) {
      setMensaje({ tipo: "err", texto: "Error al procesar archivo: " + (err?.message || err) });
    } finally {
      setImportando(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const agregarParadaManual = async (p: { nombre: string; direccion: string; lat: number; lng: number; place_id: string }) => {
    const maxOrden = paradas.length > 0 ? Math.max(...paradas.map((x) => x.orden)) : 0;
    const ins = await supabase.from("paradas").insert({
      reserva_id: reservaId, orden: maxOrden + 1,
      nombre: p.nombre, direccion: p.direccion,
      lat: p.lat, lng: p.lng, place_id: p.place_id,
    });
    if (ins.error) { setMensaje({ tipo: "err", texto: "Error: " + ins.error.message }); return; }
    setMensaje({ tipo: "ok", texto: "Parada agregada: " + p.nombre });
    onChange();
  };

  const eliminarParada = async (id: number, nombre: string) => {
    if (!confirm("Eliminar la parada '" + nombre + "'?")) return;
    const del = await supabase.from("paradas").delete().eq("id", id);
    if (del.error) { setMensaje({ tipo: "err", texto: "Error al eliminar: " + del.error.message }); return; }
    setMensaje({ tipo: "ok", texto: "Parada eliminada" });
    onChange();
  };

  const btnTab = (modo: "vista" | "excel" | "manual", label: string) => (
    <button
      onClick={() => setModoCarga(modo)}
      className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
      style={{
        background: modoCarga === modo ? "white" : "transparent",
        color: modoCarga === modo ? "#0b315f" : "#64748b",
        boxShadow: modoCarga === modo ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
      }}
    >{label}</button>
  );

  return (
    <div className="space-y-3">

      {/* Barra de acciones */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 rounded-xl p-1" style={{ background: "#f1f5f9" }}>
          {btnTab("vista",  "Vista")}
          {btnTab("excel",  "Cargar Excel")}
          {btnTab("manual", "Buscar en Google Maps")}
        </div>
        <div className="text-xs text-gray-400 ml-auto">{paradas.length} parada(s) registrada(s)</div>
      </div>

      {/* Modo Excel */}
      {modoCarga === "excel" && (
        <div className="rounded-xl border-2 border-dashed p-4 space-y-3" style={{ borderColor: "#cbd5e1", background: "#f8fafc" }}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-bold text-gray-800">Cargar paradas desde Excel/CSV</p>
              <p className="text-xs text-gray-500 mt-0.5">Necesario: Nombre, Lat, Lng. Opcional: Orden, Direccion, Hora, Notas</p>
            </div>
            <button onClick={descargarPlantillaParadas} className="px-3 py-2 rounded-xl font-bold text-xs border hover:bg-white text-gray-600">Descargar plantilla</button>
          </div>
          <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={handleArchivo} />
          <button onClick={() => fileRef.current?.click()} disabled={importando} className="w-full py-3 rounded-xl font-bold text-sm text-white disabled:opacity-50" style={{ background: "#0b315f" }}>
            {importando ? "Procesando..." : "Seleccionar archivo Excel/CSV"}
          </button>
          <p className="text-[10px] text-gray-500"><strong>Tip:</strong> En Peru: Lat negativo (-12.xxxx), Lng negativo (-77.xxxx).</p>
        </div>
      )}

      {/* Modo Google Maps */}
      {modoCarga === "manual" && (
        <div className="rounded-xl border-2 p-4 space-y-3" style={{ borderColor: "#0b315f", background: "#f0f9ff" }}>
          <div>
            <p className="text-sm font-bold text-gray-800">Agregar parada con Google Maps</p>
            <p className="text-xs text-gray-500 mt-0.5">Tipea y selecciona la direccion — las coordenadas se capturan automaticamente</p>
          </div>
          {apiKey ? (
            <BuscadorGooglePlaces apiKey={apiKey} onSeleccionar={agregarParadaManual} />
          ) : (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-xs text-yellow-800">
              <p className="font-bold">Falta NEXT_PUBLIC_GOOGLE_MAPS_API_KEY en .env.local</p>
            </div>
          )}
        </div>
      )}

      {/* Mensaje */}
      {mensaje && (
        <div className="rounded-xl px-4 py-2.5 text-xs font-medium flex items-start justify-between gap-2"
          style={{
            background: mensaje.tipo === "ok" ? "#dcfce7" : mensaje.tipo === "warn" ? "#fef9c3" : "#fee2e2",
            color:      mensaje.tipo === "ok" ? "#166534" : mensaje.tipo === "warn" ? "#854d0e" : "#991b1b",
          }}
        >
          <span>{mensaje.texto}</span>
          <button onClick={() => setMensaje(null)} className="opacity-60 hover:opacity-100">X</button>
        </div>
      )}

      {/* Lista de paradas */}
      {paradas.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed p-8 text-center" style={{ borderColor: "#e2e8f0" }}>
          <p className="text-sm font-bold text-gray-600">Sin paradas configuradas</p>
          <p className="text-xs text-gray-400 mt-1">Carga un Excel o busca con Google Maps para agregar paradas</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {paradas.map((p, i) => {
            const esInicio   = i === 0;
            const esDestino  = i === paradas.length - 1;
            const tieneCoords = p.lat !== null && p.lng !== null;
            const editando   = editandoId === p.id;
            let colorPunto = "#0b315f";
            if (esInicio)  colorPunto = "#16a34a";
            if (esDestino) colorPunto = "#dc2626";

            return (
              <div key={p.id} className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: editando ? "#0b315f" : "#e2e8f0" }}>

                {/* Fila principal */}
                <div className="flex items-center gap-2 p-2.5">
                  <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black text-white" style={{ background: colorPunto }}>
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-900 truncate">{p.nombre}</p>
                    {p.direccion && <p className="text-[11px] text-gray-500 truncate">{p.direccion}</p>}
                    <div className="flex gap-3 mt-0.5 text-[10px] flex-wrap items-center">
                      {p.hora_estimada && <span className="text-gray-500">{p.hora_estimada}</span>}
                      {tieneCoords ? (
                        <>
                          <span className="font-mono text-gray-400">{Number(p.lat).toFixed(4)}, {Number(p.lng).toFixed(4)}</span>
                          <a href={"https://www.google.com/maps?q=" + p.lat + "," + p.lng} target="_blank" rel="noreferrer" className="text-blue-500 font-bold hover:underline">Ver mapa</a>
                        </>
                      ) : (
                        <span className="text-red-500 font-bold">Sin coordenadas - no funcionara en apps</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => editando ? cancelarEdicion() : abrirEdicion(p)}
                      className="px-2 py-1 rounded-lg text-xs font-bold transition-colors"
                      style={{
                        background: editando ? "#e0f2fe" : "#f1f5f9",
                        color:      editando ? "#0369a1" : "#475569",
                      }}
                      title="Editar parada"
                    >
                      {editando ? "✕" : "✏️"}
                    </button>
                    <button
                      onClick={() => eliminarParada(p.id, p.nombre)}
                      className="px-2 py-1 rounded-lg text-xs font-bold text-red-500 hover:bg-red-50"
                    >
                      X
                    </button>
                  </div>
                </div>

                {/* Formulario inline de edición */}
                {editando && (
                  <div className="border-t px-3 py-3 space-y-2.5" style={{ borderColor: "#e0f2fe", background: "#f0f9ff" }}>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-blue-600">Editar parada</p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div className="md:col-span-2">
                        <label className="block text-[10px] font-bold text-gray-500 mb-0.5">Nombre *</label>
                        <input
                          className={inputCls()}
                          value={formEdit.nombre}
                          onChange={e => setFormEdit(f => ({ ...f, nombre: e.target.value }))}
                          placeholder="Nombre de la parada"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-[10px] font-bold text-gray-500 mb-0.5">Dirección</label>
                        <input
                          className={inputCls()}
                          value={formEdit.direccion}
                          onChange={e => setFormEdit(f => ({ ...f, direccion: e.target.value }))}
                          placeholder="Av. Ejemplo 123, Lima"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-gray-500 mb-0.5">Latitud</label>
                        <input
                          className={inputCls()}
                          value={formEdit.lat}
                          onChange={e => setFormEdit(f => ({ ...f, lat: e.target.value }))}
                          placeholder="-12.0219"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-gray-500 mb-0.5">Longitud</label>
                        <input
                          className={inputCls()}
                          value={formEdit.lng}
                          onChange={e => setFormEdit(f => ({ ...f, lng: e.target.value }))}
                          placeholder="-77.1143"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-gray-500 mb-0.5">Hora estimada</label>
                        <input
                          type="time"
                          className={inputCls()}
                          value={formEdit.hora_estimada}
                          onChange={e => setFormEdit(f => ({ ...f, hora_estimada: e.target.value }))}
                        />
                      </div>
                      <div className="flex items-end">
                        <p className="text-[9px] text-gray-400">Tip: abre Google Maps → click derecho en el punto → copia las coordenadas</p>
                      </div>
                    </div>

                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={guardarEdicion}
                        disabled={guardando}
                        className="px-4 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50"
                        style={{ background: "#0b315f" }}
                      >
                        {guardando ? "Guardando..." : "Guardar cambios"}
                      </button>
                      <button
                        onClick={cancelarEdicion}
                        className="px-4 py-1.5 rounded-lg text-xs font-bold border text-gray-600 hover:bg-gray-50"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}