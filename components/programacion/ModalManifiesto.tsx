"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { parsearManifiesto, descargarPlantilla } from "@/lib/manifiesto-csv";
import SelectorGrupos from "./SelectorGrupos";
import TimelineParadasEditable, { ParadaEditable } from "./TimelineParadasEditable";
import GestorParadas from "./GestorParadas";
import CargadorUnificado from "./CargadorUnificado";

export type ParadaItin = {
  id: number;
  reserva_id: number;
  orden: number;
  nombre: string;
  direccion: string | null;
  hora_estimada: string | null;
};

export type PasajeroManifiesto = {
  id: number;
  reserva_id: number | null;
  cliente_id: number | null;
  nombre: string;
  dni: string;
  telefono: string | null;
  empresa: string | null;
};

export type AsignacionParada = {
  pasajero_id: number;
  parada_id: number;
  estado_abordaje: "Pendiente" | "Abordado" | "No Show" | "Cancelado";
  hora_abordaje: string | null;
  asiento: string | null;
};

type Props = {
  reservaId: number;
  clienteId: number | null;
  capacidad: number | null;
  sincronizadoApp: boolean;
  fechaSincronizacion: string | null;
  origen?: string | null;
  destino?: string | null;
  puntoRetorno?: string | null;
  paradasJson?: any[] | null;
  onClose: () => void;
  onChange?: () => void;
};

const ESTADO_PAX: Record<string, { bg: string; color: string }> = {
  "Pendiente": { bg: "#fef9c3", color: "#854d0e" },
  "Abordado": { bg: "#dcfce7", color: "#166534" },
  "No Show": { bg: "#fee2e2", color: "#991b1b" },
  "Cancelado": { bg: "#f1f5f9", color: "#475569" },
};

type Tab = "pasajeros" | "paradas";

async function geocodearDireccion(
  direccion: string,
  apiKey: string,
): Promise<{ lat: number; lng: number; formatted_address?: string } | null> {
  try {
    const url =
      "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(direccion) +
      "&region=PE&language=es&key=" +
      apiKey;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === "OK" && data.results[0]) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng, formatted_address: data.results[0].formatted_address };
    }
    return null;
  } catch {
    return null;
  }
}

export default function ModalManifiesto(props: Props) {
  const { reservaId, clienteId, capacidad, sincronizadoApp, fechaSincronizacion,
    origen, destino, puntoRetorno, paradasJson, onClose, onChange } = props;

  const [tab, setTab] = useState<Tab>("pasajeros");
  const [pasajeros, setPasajeros] = useState<PasajeroManifiesto[]>([]);
  const [paradas, setParadas] = useState<ParadaEditable[]>([]);
  const [asignaciones, setAsignaciones] = useState<Record<number, AsignacionParada>>({});
  const [loading, setLoading] = useState(true);
  const [busqueda, setBusqueda] = useState("");
  const [importando, setImportando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [mensaje, setMensaje] = useState<{ tipo: "ok" | "err" | "warn"; texto: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const autoCreacionRef = useRef(false);

  // ── Agregar pasajero individual ──────────────────────────────────────────
  const [mostrarFormAdd, setMostrarFormAdd] = useState(false);
  const [formAdd, setFormAdd] = useState({ nombre: "", dni: "", empresa: "", telefono: "", parada_id: "" });
  const [savingAdd, setSavingAdd] = useState(false);

  const autoCrearParadasIniciales = async (): Promise<number> => {
    // Prioridad 1: paradas_json de la cotización (ya trae coordenadas de Google Maps)
    if (paradasJson && paradasJson.length >= 2) {
      const ordenadas = [
        ...paradasJson.filter((p: any) => p.tipo === "inicio"),
        ...paradasJson.filter((p: any) => p.tipo === "intermedia"),
        ...paradasJson.filter((p: any) => p.tipo === "destino"),
      ];
      if (ordenadas.length === 0) return 0;

      const filas = ordenadas.map((p: any, i: number) => ({
        reserva_id: reservaId,
        orden: i + 1,
        nombre: p.nombre || (i === 0 ? "Origen" : i === ordenadas.length - 1 ? "Destino" : "Parada " + i),
        direccion: p.direccion || null,
        lat: p.lat !== undefined && p.lat !== "" ? Number(p.lat) : null,
        lng: p.lng !== undefined && p.lng !== "" ? Number(p.lng) : null,
        hora_estimada: p.hora || null,
        estado: "pendiente",
      }));

      const { error } = await supabase.from("paradas").insert(filas);
      if (!error) {
        const conCoords = filas.filter((f) => f.lat !== null).length;
        setMensaje({
          tipo: conCoords === filas.length ? "ok" : "warn",
          texto:
            filas.length +
            " parada(s) generadas automáticamente desde la cotización" +
            (conCoords < filas.length
              ? " (" + conCoords + "/" + filas.length + " con coordenadas GPS)"
              : " · coordenadas GPS incluidas"),
        });
        return filas.length;
      }
      return 0;
    }

    // Prioridad 2: geocodificar origen / destino / punto de retorno con Google Maps
    const puntosTexto: Array<{ nombre: string; texto: string }> = [];
    if (origen) puntosTexto.push({ nombre: "Origen", texto: origen });
    if (destino) puntosTexto.push({ nombre: "Destino", texto: destino });
    if (puntoRetorno) puntosTexto.push({ nombre: "Retorno", texto: puntoRetorno });

    if (puntosTexto.length < 2) return 0;

    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "";
    if (!apiKey) {
      const filas = puntosTexto.map((p, i) => ({
        reserva_id: reservaId,
        orden: i + 1,
        nombre: p.nombre,
        direccion: p.texto,
        lat: null,
        lng: null,
        estado: "pendiente",
      }));
      const { error } = await supabase.from("paradas").insert(filas);
      if (!error) {
        setMensaje({ tipo: "warn", texto: filas.length + " parada(s) generadas sin coordenadas GPS (falta NEXT_PUBLIC_GOOGLE_MAPS_API_KEY)" });
        return filas.length;
      }
      return 0;
    }

    setMensaje({ tipo: "warn", texto: "Geocodificando paradas con Google Maps..." });

    const filas: any[] = [];
    for (let i = 0; i < puntosTexto.length; i++) {
      const punto = puntosTexto[i];
      const coords = await geocodearDireccion(punto.texto, apiKey);
      filas.push({
        reserva_id: reservaId,
        orden: i + 1,
        nombre: punto.nombre,
        direccion: coords?.formatted_address || punto.texto,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        estado: "pendiente",
      });
    }

    const { error } = await supabase.from("paradas").insert(filas);
    if (!error) {
      const conCoords = filas.filter((f) => f.lat !== null).length;
      setMensaje({
        tipo: conCoords === filas.length ? "ok" : "warn",
        texto:
          filas.length +
          " parada(s) generadas · " +
          conCoords +
          "/" +
          filas.length +
          " con coordenadas GPS de Google Maps",
      });
      return filas.length;
    }
    return 0;
  };

  const cargar = async () => {
    setLoading(true);

    const parResp = await supabase
      .from("paradas")
      .select("id, reserva_id, orden, nombre, direccion, hora_estimada, lat, lng, estado, notas, place_id")
      .eq("reserva_id", reservaId)
      .order("orden");
    let par = (parResp.data || []) as ParadaEditable[];

    // Auto-generar paradas solo en la primera carga si no hay ninguna
    if (!autoCreacionRef.current) {
      autoCreacionRef.current = true;
      if (par.length === 0) {
        const generadas = await autoCrearParadasIniciales();
        if (generadas > 0) {
          const parResp2 = await supabase
            .from("paradas")
            .select("id, reserva_id, orden, nombre, direccion, hora_estimada, lat, lng, estado, notas, place_id")
            .eq("reserva_id", reservaId)
            .order("orden");
          par = (parResp2.data || []) as ParadaEditable[];
          setTab("paradas");
        }
      }
    }

    setParadas(par);

    // Geocodificar en background las paradas que ya existen pero no tienen coordenadas
    const apiKeyGeo = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "";
    if (apiKeyGeo) {
      const sinCoords = par.filter(p => !p.lat || !p.lng);
      for (const parada of sinCoords) {
        const textoBusqueda = (parada.nombre || parada.direccion || "").trim();
        if (!textoBusqueda) continue;
        geocodearDireccion(textoBusqueda, apiKeyGeo).then(coords => {
          if (!coords) return;
          supabase.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
          setParadas(prev => prev.map(p =>
            p.id === parada.id ? { ...p, lat: coords.lat, lng: coords.lng } : p
          ));
        });
      }
    }

    const paradaIds = par.map((p) => p.id);

    let pasajerosCliente: PasajeroManifiesto[] = [];
    let pasajerosReserva: PasajeroManifiesto[] = [];

    if (clienteId) {
      const resp = await supabase
        .from("pasajeros")
        .select("id, reserva_id, cliente_id, nombre, dni, telefono, empresa")
        .eq("cliente_id", clienteId);
      pasajerosCliente = (resp.data || []) as PasajeroManifiesto[];
    }

    const respAdhoc = await supabase
      .from("pasajeros")
      .select("id, reserva_id, cliente_id, nombre, dni, telefono, empresa")
      .eq("reserva_id", reservaId);
    pasajerosReserva = (respAdhoc.data || []) as PasajeroManifiesto[];

    const asig: Record<number, AsignacionParada> = {};
    if (paradaIds.length > 0) {
      const ppResp = await supabase
        .from("pasajeros_parada")
        .select("pasajero_id, parada_id, estado_abordaje, hora_abordaje, asiento")
        .in("parada_id", paradaIds);
      (ppResp.data || []).forEach((row: any) => {
        asig[row.pasajero_id] = {
          pasajero_id: row.pasajero_id,
          parada_id: row.parada_id,
          estado_abordaje: row.estado_abordaje || "Pendiente",
          hora_abordaje: row.hora_abordaje,
          asiento: row.asiento,
        };
      });
    }

    const idsReserva = new Set(pasajerosReserva.map((p) => p.id));
    const merged: PasajeroManifiesto[] = [
      ...pasajerosReserva,
      ...pasajerosCliente.filter((p) => !idsReserva.has(p.id)),
    ];

    setPasajeros(merged);
    setAsignaciones(asig);
    setLoading(false);
  };

  useEffect(() => { cargar(); /* eslint-disable-next-line */ }, [reservaId]);

  const total = pasajeros.length;
  const abordados = useMemo(() => Object.values(asignaciones).filter((a) => a.estado_abordaje === "Abordado").length, [asignaciones]);
  const pendientes = useMemo(() => Object.values(asignaciones).filter((a) => a.estado_abordaje === "Pendiente").length, [asignaciones]);
  const sobrecupo = capacidad !== null && total > capacidad;

  const filtrados = useMemo(() => {
    const q = busqueda.toLowerCase().trim();
    if (!q) return pasajeros;
    return pasajeros.filter((p) =>
      p.nombre.toLowerCase().includes(q) ||
      p.dni.toLowerCase().includes(q) ||
      (p.empresa || "").toLowerCase().includes(q)
    );
  }, [pasajeros, busqueda]);

  const handleArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportando(true);
    setMensaje(null);

    try {
      const resultado = await parsearManifiesto(file);

      if (resultado.ok.length === 0) {
        setMensaje({
          tipo: "err",
          texto: "Sin filas validas. " + resultado.errores.length + " error(es). Primer error: " + (resultado.errores[0]?.motivo || "n/d"),
        });
        setImportando(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      const dnisExistentes = new Set(pasajeros.map((p) => p.dni));
      const nuevos = resultado.ok.filter((p) => !dnisExistentes.has(p.dni));
      const duplicados = resultado.ok.length - nuevos.length;

      if (nuevos.length === 0) {
        setMensaje({ tipo: "warn", texto: "Todos los " + resultado.ok.length + " pasajeros ya estan en esta reserva." });
        setImportando(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      const insResp = await supabase
        .from("pasajeros")
        .insert(nuevos.map((p) => ({
          reserva_id: reservaId,
          cliente_id: clienteId,
          nombre: p.nombre,
          dni: p.dni,
          telefono: p.telefono,
          empresa: p.empresa,
        })))
        .select();

      if (insResp.error) {
        setMensaje({ tipo: "err", texto: "Error al guardar: " + insResp.error.message });
        setImportando(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      const cuantos = insResp.data?.length || 0;
      const partes = [
        cuantos + " pasajero(s) cargado(s)",
        duplicados > 0 ? duplicados + " duplicado(s) omitido(s)" : "",
        resultado.errores.length > 0 ? resultado.errores.length + " fila(s) con error" : "",
      ].filter(Boolean);
      setMensaje({ tipo: "ok", texto: partes.join(" - ") });

      await cargar();
      if (onChange) onChange();
    } catch (err: any) {
      setMensaje({ tipo: "err", texto: "Error al procesar archivo: " + (err?.message || err) });
    } finally {
      setImportando(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const asignarParada = async (pasajeroId: number, paradaId: number | null) => {
    const paradaIds = paradas.map((p) => p.id);
    if (paradaIds.length > 0) {
      await supabase.from("pasajeros_parada")
        .delete()
        .eq("pasajero_id", pasajeroId)
        .in("parada_id", paradaIds);
    }

    if (paradaId) {
      const resp = await supabase.from("pasajeros_parada").insert({
        pasajero_id: pasajeroId,
        parada_id: paradaId,
        estado: "esperando",
        estado_abordaje: "Pendiente",
      });
      if (resp.error) {
        setMensaje({ tipo: "err", texto: resp.error.message });
        return;
      }
      setAsignaciones((prev) => ({
        ...prev,
        [pasajeroId]: {
          pasajero_id: pasajeroId,
          parada_id: paradaId,
          estado_abordaje: "Pendiente",
          hora_abordaje: null,
          asiento: prev[pasajeroId]?.asiento || null,
        },
      }));
    } else {
      setAsignaciones((prev) => {
        const cp = { ...prev };
        delete cp[pasajeroId];
        return cp;
      });
    }
    if (onChange) onChange();
  };

  const cambiarEstado = async (pasajeroId: number, estado: AsignacionParada["estado_abordaje"]) => {
    const a = asignaciones[pasajeroId];
    if (!a) {
      setMensaje({ tipo: "warn", texto: "Asigna primero una parada antes de cambiar el estado." });
      return;
    }
    const hora = estado === "Abordado" ? new Date().toISOString() : null;
    const resp = await supabase.from("pasajeros_parada")
      .update({ estado_abordaje: estado, hora_abordaje: hora })
      .eq("pasajero_id", pasajeroId)
      .eq("parada_id", a.parada_id);
    if (resp.error) {
      setMensaje({ tipo: "err", texto: resp.error.message });
      return;
    }
    setAsignaciones((prev) => ({
      ...prev,
      [pasajeroId]: { ...prev[pasajeroId], estado_abordaje: estado, hora_abordaje: hora },
    }));
    if (onChange) onChange();
  };

  const eliminarPasajero = async (pasajeroId: number) => {
    if (!confirm("Quitar este pasajero del manifiesto?")) return;
    const p = pasajeros.find((x) => x.id === pasajeroId);
    if (p?.reserva_id === reservaId) {
      await supabase.from("pasajeros").delete().eq("id", pasajeroId);
    } else {
      await asignarParada(pasajeroId, null);
    }
    await cargar();
    if (onChange) onChange();
  };

  // ─── Agregar 1 pasajero manualmente ──────────────────────────────────────
  const agregarPasajeroManual = async () => {
    if (!formAdd.nombre.trim() || !formAdd.dni.trim()) {
      setMensaje({ tipo: "err", texto: "Nombre y DNI son requeridos" });
      return;
    }
    if (dnisExistentes.has(formAdd.dni.trim())) {
      setMensaje({ tipo: "warn", texto: `Ya existe un pasajero con DNI ${formAdd.dni.trim()} en este servicio` });
      return;
    }
    setSavingAdd(true);
    setMensaje(null);
    try {
      const { data: nuevo, error: insErr } = await supabase
        .from("pasajeros")
        .insert({
          reserva_id: reservaId,
          cliente_id: clienteId,
          nombre:     formAdd.nombre.trim(),
          dni:        formAdd.dni.trim(),
          empresa:    formAdd.empresa.trim() || null,
          telefono:   formAdd.telefono.trim() || null,
          activo:     true,
        })
        .select("id")
        .single();

      if (insErr || !nuevo) {
        setMensaje({ tipo: "err", texto: insErr?.message || "Error al agregar pasajero" });
        return;
      }

      if (formAdd.parada_id) {
        await supabase.from("pasajeros_parada").insert({
          pasajero_id:    nuevo.id,
          parada_id:      Number(formAdd.parada_id),
          estado_abordaje: "Pendiente",
        });
      }

      setMensaje({ tipo: "ok", texto: `${formAdd.nombre.trim()} agregado al manifiesto ✓` });
      setFormAdd({ nombre: "", dni: "", empresa: "", telefono: "", parada_id: "" });
      setMostrarFormAdd(false);
      await cargar();
      if (onChange) onChange();
    } finally {
      setSavingAdd(false);
    }
  };

  // ─── SINCRONIZAR + NOTIFICAR ───────────────────────────────────────────────
  const sincronizar = async () => {
    if (paradas.length === 0) {
      setMensaje({ tipo: "warn", texto: "El itinerario no tiene paradas. Agrega paradas antes de sincronizar." });
      return;
    }
    if (total === 0) {
      setMensaje({ tipo: "warn", texto: "El manifiesto esta vacio." });
      return;
    }
    if (sobrecupo) {
      const ok = confirm("SOBRECUPO: " + total + " pasajeros vs capacidad " + capacidad + ". Sincronizar de todas formas?");
      if (!ok) return;
    }

    const sinCoords = paradas.filter((p) => p.lat === null || p.lng === null);
    if (sinCoords.length > 0) {
      const ok = confirm(sinCoords.length + " parada(s) sin coordenadas GPS no funcionaran en la app movil. Continuar de todas formas?");
      if (!ok) return;
    }

    setSincronizando(true);
    setMensaje(null);

    // 1. Actualizar sincronizado_app en Supabase (igual que antes)
    const payload = JSON.stringify({
      paradas: paradas.map((p) => ({ id: p.id, orden: p.orden, nombre: p.nombre, lat: p.lat, lng: p.lng })),
      pasajeros: pasajeros.map((p) => ({ id: p.id, dni: p.dni, parada: asignaciones[p.id]?.parada_id || null })),
    });
    let hash = 0;
    for (let i = 0; i < payload.length; i++) hash = (((hash << 5) - hash) + payload.charCodeAt(i)) | 0;

    const respSync = await supabase.from("reservas")
      .update({
        sincronizado_app: true,
        fecha_sincronizacion: new Date().toISOString(),
        sync_payload_hash: String(hash),
      })
      .eq("id", reservaId);

    if (respSync.error) {
      setMensaje({ tipo: "err", texto: respSync.error.message });
      setSincronizando(false);
      return;
    }

    // 2. Enviar notificaciones a los pasajeros via API
    try {
      const respNotif = await fetch("/api/notificaciones/sincronizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reserva_id: reservaId }),
      });
      const datosNotif = await respNotif.json();

      if (!respNotif.ok) {
        // Sincronizacion OK, pero notificaciones fallaron — avisar sin bloquear
        setMensaje({
          tipo: "warn",
          texto: "Manifiesto sincronizado. Advertencia en notificaciones: " + (datosNotif.error || "error desconocido"),
        });
      } else {
        const { enviados, sinCanal, total: totalPax } = datosNotif.resumen;
        const partes = ["Manifiesto sincronizado"];
        if (enviados > 0)    partes.push(enviados + " notificacion(es) enviadas");
        if (sinCanal > 0)    partes.push(sinCanal + " pasajero(s) sin email ni telefono");
        if (totalPax === 0)  partes.push("(sin pasajeros con contacto registrado)");
        setMensaje({ tipo: "ok", texto: partes.join(" · ") });
      }
    } catch {
      // Si la API de notificaciones no está configurada aún, no romper el flujo
      setMensaje({ tipo: "ok", texto: "Manifiesto sincronizado. (Notificaciones: API no disponible aun)" });
    }

    setSincronizando(false);
    if (onChange) onChange();
  };

  const ocupBg = sobrecupo ? "#fee2e2" : "#dcfce7";
  const ocupBd = sobrecupo ? "#fecaca" : "#bbf7d0";
  const ocupColor = sobrecupo ? "#991b1b" : "#166534";
  const syncBg = sincronizadoApp ? "#ecfdf5" : "#fff7ed";
  const syncBd = sincronizadoApp ? "#a7f3d0" : "#fed7aa";
  const syncColor = sincronizadoApp ? "#065f46" : "#9a3412";

  const dnisExistentes = new Set(pasajeros.map((p) => p.dni).filter(Boolean));

  const paradasGestion = paradas.map((p) => ({
    id: p.id,
    reserva_id: p.reserva_id,
    orden: p.orden,
    nombre: p.nombre,
    direccion: p.direccion,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
    hora_estimada: p.hora_estimada,
    notas: (p as any).notas ?? null,
    place_id: (p as any).place_id ?? null,
  }));

  const paradasParaCargador = paradas.map((p) => ({
    id: p.id,
    nombre: p.nombre,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
  }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15, 23, 42, 0.55)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-6 py-4 border-b flex items-start justify-between gap-4" style={{ borderColor: "#e2e8f0" }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-xl" style={{ background: "#0b315f" }}>P</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Manifiesto - Reserva #{reservaId}</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {capacidad === null ? "Sin capacidad del vehiculo definida" : "Capacidad " + capacidad + " pax - " + total + " en manifiesto"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-2xl text-gray-300 hover:text-gray-600 leading-none">X</button>
        </div>

        {/* KPIs */}
        <div className="px-6 py-3 grid grid-cols-2 md:grid-cols-5 gap-2 border-b" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
          <div className="rounded-xl p-2.5 border" style={{ background: ocupBg, borderColor: ocupBd }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: ocupColor }}>Ocupacion</p>
            <p className="text-xl font-black" style={{ color: ocupColor }}>{total}{capacidad !== null ? " / " + capacidad : ""}</p>
            {sobrecupo ? <p className="text-[9px] font-bold text-red-700">SOBRECUPO</p> : null}
          </div>
          <div className="rounded-xl p-2.5 border" style={{ background: "#fef9c3", borderColor: "#fef08a" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide text-yellow-800">Pendientes</p>
            <p className="text-xl font-black text-yellow-900">{pendientes}</p>
          </div>
          <div className="rounded-xl p-2.5 border" style={{ background: "#dbeafe", borderColor: "#bfdbfe" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide text-blue-800">Abordados</p>
            <p className="text-xl font-black text-blue-900">{abordados}</p>
          </div>
          <div className="rounded-xl p-2.5 border" style={{ background: "#ede9fe", borderColor: "#ddd6fe" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide text-purple-800">Paradas</p>
            <p className="text-xl font-black text-purple-900">{paradas.length}</p>
          </div>
          <div className="rounded-xl p-2.5 border flex flex-col justify-between" style={{ background: syncBg, borderColor: syncBd }}>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: syncColor }}>{sincronizadoApp ? "Sincronizado" : "Pendiente sync"}</p>
              {fechaSincronizacion ? <p className="text-[9px] text-gray-500">{new Date(fechaSincronizacion).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</p> : null}
            </div>
            <button
              onClick={sincronizar}
              disabled={sincronizando || total === 0}
              className="mt-1 text-[10px] font-bold px-2 py-1 rounded-lg text-white disabled:opacity-50"
              style={{ background: sincronizando ? "#6b7280" : sincronizadoApp ? "#0b315f" : "#16a34a" }}
            >
              {sincronizando ? "Enviando..." : sincronizadoApp ? "Re-sincronizar" : "Sincronizar"}
            </button>
          </div>
        </div>

        {/* TABS */}
        <div className="px-6 pt-3 border-b flex gap-1" style={{ borderColor: "#e2e8f0" }}>
          <button
            onClick={() => setTab("pasajeros")}
            className="px-4 py-2 text-xs font-bold transition-all border-b-2 -mb-px"
            style={{
              borderColor: tab === "pasajeros" ? "#0b315f" : "transparent",
              color: tab === "pasajeros" ? "#0b315f" : "#9ca3af",
            }}
          >
            Pasajeros ({total})
          </button>
          <button
            onClick={() => setTab("paradas")}
            className="px-4 py-2 text-xs font-bold transition-all border-b-2 -mb-px"
            style={{
              borderColor: tab === "paradas" ? "#0b315f" : "transparent",
              color: tab === "pasajeros" ? "#0b315f" : "#9ca3af",
            }}
          >
            Paradas ({paradas.length})
          </button>
        </div>

        {/* CONTENIDO TAB PASAJEROS */}
        {tab === "pasajeros" ? (
          <>
            <div className="px-6 py-3 flex items-center gap-2 flex-wrap border-b" style={{ borderColor: "#f1f5f9" }}>
              <div className="relative flex-1 min-w-[180px]">
                <input className="w-full border rounded-xl pl-3 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20" placeholder="Buscar por nombre, DNI o empresa..." value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
              </div>

              {/* Agregar 1 pasajero */}
              <button
                onClick={() => { setMostrarFormAdd(v => !v); setMensaje(null); }}
                className="px-3 py-2 rounded-xl font-bold text-xs border transition-colors"
                style={{
                  borderColor: mostrarFormAdd ? "#0b315f" : "#e2e8f0",
                  background:  mostrarFormAdd ? "#eaeff6"  : "white",
                  color:       mostrarFormAdd ? "#0b315f"  : "#374151",
                }}
              >
                {mostrarFormAdd ? "✕ Cancelar" : "+ Agregar 1 pasajero"}
              </button>

              <CargadorUnificado
                reservaId={reservaId}
                clienteId={clienteId}
                paradasExistentes={paradasParaCargador}
                dnisExistentes={dnisExistentes}
                onAplicado={() => { cargar(); if (onChange) onChange(); }}
              />

              <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={handleArchivo} />
              <button onClick={() => fileRef.current?.click()} disabled={importando} className="px-4 py-2 rounded-xl font-bold text-xs text-white disabled:opacity-50" style={{ background: "#0b315f" }}>{importando ? "Procesando..." : "Solo Pasajeros (Excel)"}</button>

              <SelectorGrupos
                reservaId={reservaId}
                clienteId={clienteId}
                paradas={paradas.map((p) => ({ id: p.id, nombre: p.nombre, orden: p.orden }))}
                dnisExistentes={dnisExistentes}
                onAplicado={() => cargar()}
              />

              <button onClick={descargarPlantilla} className="px-3 py-2 rounded-xl font-bold text-xs border hover:bg-gray-50 text-gray-600">Plantilla pax</button>
            </div>

            {/* Formulario agregar 1 pasajero */}
            {mostrarFormAdd && (
              <div className="mx-6 mt-3 rounded-xl border p-4" style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Nuevo pasajero</p>
                <div className="flex gap-2 flex-wrap items-end">
                  {/* Nombre */}
                  <div className="flex-[2_1_170px]">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Nombre completo *</p>
                    <input
                      value={formAdd.nombre}
                      onChange={e => setFormAdd(f => ({ ...f, nombre: e.target.value }))}
                      onKeyDown={e => e.key === "Enter" && agregarPasajeroManual()}
                      placeholder="Ej. Juan Pérez López"
                      className="w-full border rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                    />
                  </div>
                  {/* DNI */}
                  <div className="flex-[0_1_120px]">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">DNI *</p>
                    <input
                      value={formAdd.dni}
                      onChange={e => setFormAdd(f => ({ ...f, dni: e.target.value }))}
                      onKeyDown={e => e.key === "Enter" && agregarPasajeroManual()}
                      placeholder="12345678"
                      maxLength={12}
                      className="w-full border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                    />
                  </div>
                  {/* Empresa */}
                  <div className="flex-[1_1_140px]">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Empresa</p>
                    <input
                      value={formAdd.empresa}
                      onChange={e => setFormAdd(f => ({ ...f, empresa: e.target.value }))}
                      placeholder="Opcional"
                      className="w-full border rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                    />
                  </div>
                  {/* Teléfono */}
                  <div className="flex-[0_1_130px]">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Teléfono</p>
                    <input
                      value={formAdd.telefono}
                      onChange={e => setFormAdd(f => ({ ...f, telefono: e.target.value }))}
                      placeholder="999111222"
                      className="w-full border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                    />
                  </div>
                  {/* Parada */}
                  {paradas.length > 0 && (
                    <div className="flex-[1_1_170px]">
                      <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Parada de abordaje</p>
                      <select
                        value={formAdd.parada_id}
                        onChange={e => setFormAdd(f => ({ ...f, parada_id: e.target.value }))}
                        className="w-full border rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 bg-white"
                      >
                        <option value="">– Sin asignar –</option>
                        {paradas.map(p => (
                          <option key={p.id} value={p.id}>{p.orden}. {p.nombre}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {/* Botón */}
                  <button
                    onClick={agregarPasajeroManual}
                    disabled={savingAdd || !formAdd.nombre.trim() || !formAdd.dni.trim()}
                    className="px-5 py-2 rounded-xl font-bold text-xs text-white disabled:opacity-50 whitespace-nowrap"
                    style={{ background: formAdd.nombre.trim() && formAdd.dni.trim() ? "#0b315f" : "#9ca3af" }}
                  >
                    {savingAdd ? "Guardando..." : "Agregar"}
                  </button>
                </div>
              </div>
            )}

            {mensaje ? (
              <div className="mx-6 mt-3 rounded-xl px-4 py-2.5 text-xs font-medium flex items-start justify-between gap-2" style={{
                background: mensaje.tipo === "ok" ? "#dcfce7" : mensaje.tipo === "warn" ? "#fef9c3" : "#fee2e2",
                color: mensaje.tipo === "ok" ? "#166534" : mensaje.tipo === "warn" ? "#854d0e" : "#991b1b",
              }}>
                <span>{mensaje.texto}</span>
                <button onClick={() => setMensaje(null)} className="opacity-60 hover:opacity-100">X</button>
              </div>
            ) : null}

            <div className="flex-1 overflow-y-auto px-6 py-3">
              {loading ? (
                <div className="text-center py-10 text-gray-400 text-sm">Cargando manifiesto...</div>
              ) : filtrados.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed rounded-2xl" style={{ borderColor: "#e2e8f0" }}>
                  <p className="text-sm font-medium text-gray-600">{pasajeros.length === 0 ? "Manifiesto vacio" : "Sin resultados para tu busqueda"}</p>
                  {pasajeros.length === 0 ? <p className="text-xs text-gray-400 mt-1">Usa el boton morado para cargar todo en un solo Excel, o carga pasajeros y paradas por separado.</p> : null}
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0" style={{ background: "#f8fafc" }}>
                    <tr className="border-b" style={{ borderColor: "#e2e8f0" }}>
                      {["Pasajero", "DNI", "Parada asignada", "Estado abordaje", "Hora", "Asiento", ""].map((h) => (
                        <th key={h} className="p-2 text-left font-bold uppercase tracking-wide text-[10px] text-gray-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtrados.map((p) => {
                      const a = asignaciones[p.id];
                      const estado = a?.estado_abordaje || "Pendiente";
                      const cfg = ESTADO_PAX[estado] || ESTADO_PAX["Pendiente"];
                      const esAdhoc = p.reserva_id === reservaId;
                      return (
                        <tr key={p.id} className="border-b hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                          <td className="p-2">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-lg flex items-center justify-center font-black text-[11px] text-white" style={{ background: "#0b315f" }}>{p.nombre.charAt(0)}</div>
                              <div className="min-w-0">
                                <p className="font-bold text-gray-800 truncate">{p.nombre}</p>
                                <p className="text-gray-400 text-[10px] truncate">{p.empresa || "Sin empresa"}{esAdhoc ? " - Manifiesto" : ""}</p>
                              </div>
                            </div>
                          </td>
                          <td className="p-2 font-mono text-gray-700">{p.dni}</td>
                          <td className="p-2">
                            <select value={a?.parada_id || ""} onChange={(e) => asignarParada(p.id, e.target.value ? Number(e.target.value) : null)} className="border rounded-lg px-2 py-1 text-[11px] max-w-[180px]" style={{ borderColor: "#e2e8f0" }}>
                              <option value="">- Sin asignar -</option>
                              {paradas.map((par) => (<option key={par.id} value={par.id}>{par.orden}. {par.nombre}</option>))}
                            </select>
                          </td>
                          <td className="p-2">
                            <select disabled={!a} value={estado} onChange={(e) => cambiarEstado(p.id, e.target.value as AsignacionParada["estado_abordaje"])} className="font-bold px-2 py-1 rounded-lg border-0 cursor-pointer text-[11px] disabled:opacity-40" style={{ background: cfg.bg, color: cfg.color }}>
                              {Object.keys(ESTADO_PAX).map((k) => (<option key={k} value={k}>{k}</option>))}
                            </select>
                          </td>
                          <td className="p-2 text-gray-500 text-[10px]">{a?.hora_abordaje ? new Date(a.hora_abordaje).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                          <td className="p-2 font-mono text-gray-700">{a?.asiento || "-"}</td>
                          <td className="p-2 text-right">
                            <button onClick={() => eliminarPasajero(p.id)} className="text-red-500 hover:bg-red-50 px-2 py-1 rounded-lg font-bold">X</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : null}

        {/* CONTENIDO TAB PARADAS */}
        {tab === "paradas" ? (
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            <div>
              <h3 className="text-sm font-bold text-gray-900 mb-2">Gestionar paradas</h3>
              <GestorParadas
                reservaId={reservaId}
                paradas={paradasGestion}
                onChange={() => { cargar(); if (onChange) onChange(); }}
              />
            </div>

            {paradas.length > 0 ? (
              <div className="pt-4 border-t" style={{ borderColor: "#e2e8f0" }}>
                <div className="mb-2">
                  <h3 className="text-sm font-bold text-gray-900">Reordenar itinerario</h3>
                  <p className="text-xs text-gray-400 mt-0.5">Arrastra para cambiar el orden. Los cambios se guardan automaticamente.</p>
                </div>
                <TimelineParadasEditable
                  reservaId={reservaId}
                  paradas={paradas}
                  onChange={() => { cargar(); if (onChange) onChange(); }}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Footer */}
        <div className="px-6 py-3 border-t flex items-center justify-between gap-3" style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
          <p className="text-[11px] text-gray-400">{pasajeros.length} pasajero(s) · {paradas.length} parada(s) en itinerario</p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl font-bold text-sm border text-gray-500 hover:bg-gray-100 transition-colors"
              style={{ borderColor: "#e2e8f0" }}
            >
              Cerrar sin sincronizar
            </button>
            <button
              onClick={async () => { await sincronizar(); onClose(); }}
              disabled={sincronizando || total === 0}
              className="px-5 py-2 rounded-xl font-bold text-sm text-white flex items-center gap-2 disabled:opacity-50 transition-colors"
              style={{ background: sincronizando ? "#6b7280" : "#16a34a" }}
            >
              {sincronizando
                ? <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Sincronizando...</>
                : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Sincronizar y Cerrar</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}