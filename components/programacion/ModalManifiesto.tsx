"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { paginarFilas } from "@/lib/huella";
import { normalizarEmpresa } from "@/lib/empresa";
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
  cotizacionId?: number | null;
  vehiculoId?: number | null;
  vehiculoTerceroId?: number | null;
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

// Huella de ruta = secuencia ORDENADA de paraderos "nombre@lat,lng".
// Es sensible al orden ⇒ una ruta en sentido inverso produce una huella distinta.
// Sirve para decidir si dos servicios comparten exactamente la misma ruta
// (mismos paraderos: nombre + coordenadas, en el mismo orden).
function huellaRuta(lista: Array<{ orden?: number | null; nombre?: string | null; lat?: number | null; lng?: number | null }> | undefined | null): string {
  if (!lista || lista.length === 0) return "";
  return [...lista]
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
    .map((p) => {
      const nom = (p.nombre || "").trim().toLowerCase().replace(/\s+/g, " ");
      const lat = p.lat == null ? "" : Number(p.lat).toFixed(4);
      const lng = p.lng == null ? "" : Number(p.lng).toFixed(4);
      return `${nom}@${lat},${lng}`;
    })
    .join(" › ");
}

export default function ModalManifiesto(props: Props) {
  const { reservaId, clienteId, capacidad, sincronizadoApp, fechaSincronizacion,
    origen, destino, puntoRetorno, paradasJson, cotizacionId, vehiculoId, vehiculoTerceroId, onClose, onChange } = props;

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

  // ── Panel "Agregar desde nómina" ─────────────────────────────────────────
  const [mostrarNomina,  setMostrarNomina]  = useState(false);
  const [nominaBusq,     setNominaBusq]     = useState("");
  const [nomina,         setNomina]         = useState<PasajeroManifiesto[]>([]);
  const [loadingNomina,  setLoadingNomina]  = useState(false);
  const [agregandoPaxId, setAgregandoPaxId] = useState<number | null>(null);

  // ── Mover pasajero a otro servicio ──────────────────────────────────────
  const [moverPaxId,       setMoverPaxId]       = useState<number | null>(null);
  const [serviciosDestino, setServiciosDestino] = useState<any[]>([]);
  const [cargandoDestinos, setCargandoDestinos] = useState(false);
  const [moviendoPax,      setMoviendoPax]      = useState(false);

  // ── Copiar paraderos a días futuros ─────────────────────────────────────
  const [modalCopiar, setModalCopiar] = useState(false);
  const [copiarDesde, setCopiarDesde] = useState("");
  const [copiarHasta, setCopiarHasta] = useState("");
  const [copiando, setCopiando] = useState(false);

  // ── Config de ruta ───────────────────────────────────────────────────────
  const [mostrarConfigRuta,     setMostrarConfigRuta]     = useState(false);
  const [rutaNombre,            setRutaNombre]            = useState("");
  const [permiteAutoseleccion,  setPermiteAutoseleccion]  = useState(false);
  const [permiteCambioParadero, setPermiteCambioParadero] = useState(false);
  const [configGuardando,       setConfigGuardando]       = useState(false);
  const [fechaServicio,         setFechaServicio]         = useState("");

  // ── Aplicar config a rango de fechas ────────────────────────────────────
  const [modalConfigRango, setModalConfigRango] = useState(false);
  const [configDesde,      setConfigDesde]      = useState("");
  const [configHasta,      setConfigHasta]      = useState("");
  const [incluirActual,    setIncluirActual]    = useState(true);
  const [aplicandoConfig,  setAplicandoConfig]  = useState(false);
  const [previewIds,       setPreviewIds]       = useState<number[]>([]);
  // Candidatos totales en el rango (mismo vehículo + mismo tramo) — para distinguir
  // cuántos se descartaron por tener una ruta distinta a la del servicio actual.
  const [previewTotal,     setPreviewTotal]     = useState(0);
  // true mientras la corrida async (paginación + huellas) recalcula el preview.
  // Deshabilita el botón Aplicar para que un clic no aplique sobre ids obsoletos.
  const [previewCargando,  setPreviewCargando]  = useState(false);
  // Resultado crudo de la coincidencia (sin aplicar el filtro de incluirActual):
  // `ids` = servicios que coinciden con la ruta (incluye el actual si está en rango),
  // `universo` = candidatos del MISMO tramo (denominador de "omitidos"). Se deriva
  // previewIds/previewTotal desde aquí para que togglear "Incluir este servicio" NO
  // vuelva a paginar ni a re-descargar los paradas_json (es un filtro puro).
  const [matchRaw,         setMatchRaw]         = useState<{ ids: number[]; universo: number[] } | null>(null);
  // true si la corrida async falló (red/consulta): para NO mostrar "no hay servicios"
  // (un negativo rotundo) cuando en realidad no se pudo calcular.
  const [previewError,     setPreviewError]     = useState(false);

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

    // 1. Pasajeros ad-hoc de esta reserva específica
    const respAdhoc = await supabase
      .from("pasajeros")
      .select("id, reserva_id, cliente_id, nombre, dni, telefono, empresa")
      .eq("reserva_id", reservaId);
    const pasajerosReserva = (respAdhoc.data || []) as PasajeroManifiesto[];
    const idsReserva = new Set(pasajerosReserva.map((p) => p.id));

    // 2. Asignaciones parada ↔ pasajero para las paradas de esta reserva
    const asig: Record<number, AsignacionParada> = {};
    const globalPaxIds: number[] = [];

    if (paradaIds.length > 0) {
      const ppResp = await supabase
        .from("pasajeros_parada")
        .select("pasajero_id, parada_id, estado_abordaje, hora_abordaje, asiento")
        .in("parada_id", paradaIds);
      (ppResp.data || []).forEach((row: any) => {
        asig[row.pasajero_id] = {
          pasajero_id:     row.pasajero_id,
          parada_id:       row.parada_id,
          estado_abordaje: row.estado_abordaje || "Pendiente",
          hora_abordaje:   row.hora_abordaje,
          asiento:         row.asiento,
        };
        // Pasajeros globales (nómina) explícitamente asignados a una parada de este servicio
        if (!idsReserva.has(row.pasajero_id)) {
          globalPaxIds.push(row.pasajero_id);
        }
      });
    }

    // 3. Cargar datos de pasajeros globales asignados a paradas de este servicio
    let pasajerosGlobal: PasajeroManifiesto[] = [];
    const uniqueGlobalIds = [...new Set(globalPaxIds)];
    if (uniqueGlobalIds.length > 0) {
      const { data: paxGlobal } = await supabase
        .from("pasajeros")
        .select("id, reserva_id, cliente_id, nombre, dni, telefono, empresa")
        .in("id", uniqueGlobalIds);
      pasajerosGlobal = (paxGlobal || []) as PasajeroManifiesto[];
    }

    // 4. Merge: ad-hoc primero, luego globales explícitamente asignados a paradas
    setPasajeros([...pasajerosReserva, ...pasajerosGlobal]);
    setAsignaciones(asig);
    setLoading(false);
  };

  useEffect(() => { cargar(); /* eslint-disable-next-line */ }, [reservaId]);

  // Carga los 3 campos de config + fecha_servicio al abrir el modal
  useEffect(() => {
    supabase.from("reservas")
      .select("ruta_nombre,permite_autoseleccion,permite_cambio_paradero,fecha_servicio")
      .eq("id", reservaId).maybeSingle()
      .then((res: any) => {
        const cfg = res.data;
        if (!cfg) return;
        setRutaNombre(cfg.ruta_nombre || "");
        setPermiteAutoseleccion(!!cfg.permite_autoseleccion);
        setPermiteCambioParadero(!!cfg.permite_cambio_paradero);
        setFechaServicio(cfg.fecha_servicio || "");
      });
  }, [reservaId]);

  // Preview (parte pesada): calcula, al cambiar el rango/servicio, qué reservas
  // comparten la MISMA ruta que el actual (mismos paraderos + coordenadas, mismo
  // orden y mismo SENTIDO ida/retorno). NO depende de `incluirActual` (ese es un
  // filtro puro que se aplica abajo, sin re-paginar ni re-descargar).
  //
  // La huella se calcula desde el snapshot `paradas_json` de cada reserva (con
  // fallback a la cotización por tramo ida/retorno), NO desde la tabla `paradas`.
  // Motivo: la programación masiva (ModalGenerarPrograma) inserta cientos/miles
  // de reservas con paradas_json + direccion_servicio pero SIN materializar filas
  // en `paradas` hasta que cada servicio se abre. Comparar por `paradas` dejaba
  // fuera a TODOS los servicios masivos aún sin abrir (huella vacía) y solo
  // coincidía el servicio actual consigo mismo.
  useEffect(() => {
    const vidActivo = vehiculoId || vehiculoTerceroId;
    if (!modalConfigRango || !cotizacionId || !vidActivo || !configDesde || !configHasta) {
      setMatchRaw(null); setPreviewCargando(false); setPreviewError(false); return;
    }
    let cancelado = false;
    setPreviewCargando(true); setPreviewError(false); // botón Aplicar off hasta resolver
    const campo = vehiculoId ? "vehiculo_id" : "vehiculo_tercero_id";

    (async () => {
     try {
      // 1. Candidatos: misma cotización + vehículo + rango + estado activo.
      //    Se PAGINA: PostgREST corta CUALQUIER respuesta a 1000 filas y una
      //    programación masiva puede tener miles de servicios idénticos; sin
      //    paginar solo veíamos 1000 (de ahí el "999 omitidos").
      const cand = await paginarFilas(() =>
        supabase.from("reservas")
          .select("id, direccion_servicio, paradas_json")
          .eq("cotizacion_id", cotizacionId).eq(campo, vidActivo)
          .gte("fecha_servicio", configDesde).lte("fecha_servicio", configHasta)
          .not("estado", "in", "(cancelada,finalizada)")
          .order("fecha_servicio").order("id")); // orden estable para paginar
      const candIds = (cand as any[]).map((r: any) => r.id as number);
      const rowById = new Map<number, any>((cand as any[]).map((r: any) => [r.id, r]));

      // 2. Fuente de la huella: paradas_json de la reserva → cotización por tramo.
      const { data: cot } = await supabase.from("cotizaciones")
        .select("paradas_json, paradas_retorno_json").eq("id", cotizacionId).maybeSingle();
      // El servicio actual puede quedar fuera del rango → se trae aparte.
      const { data: refRow } = await supabase.from("reservas")
        .select("direccion_servicio, paradas_json").eq("id", reservaId).maybeSingle();

      // Ordena un paradas_json igual que resolverParadasJSON (inicio→intermedia→destino).
      const sortLeg = (arr: any[]) => [
        ...arr.filter((p: any) => p.tipo === "inicio"),
        ...arr.filter((p: any) => p.tipo === "intermedia"),
        ...arr.filter((p: any) => p.tipo === "destino"),
        ...arr.filter((p: any) => !["inicio", "intermedia", "destino"].includes(p.tipo)),
      ];
      // paradas_json propio de la reserva (por tramo) → fallback a la cotización.
      const fuenteJson = (r: any): any[] => {
        if (Array.isArray(r?.paradas_json) && r.paradas_json.length > 0) return sortLeg(r.paradas_json);
        const c: any = cot;
        if (r?.direccion_servicio === "retorno") {
          const ret = Array.isArray(c?.paradas_retorno_json) && c.paradas_retorno_json.length > 0
            ? c.paradas_retorno_json : c?.paradas_json;
          return Array.isArray(ret) ? sortLeg(ret) : [];
        }
        return Array.isArray(c?.paradas_json) ? sortLeg(c.paradas_json) : [];
      };

      // Sentido del servicio (ida/retorno). El RETORNO de una cotización SIN
      // paradas_retorno_json propio se guarda con el MISMO paradas_json de la ida
      // (mismos paraderos, sin invertir) → su huella coincidiría con la de la ida.
      // Se exige mismo tramo para no mezclar sentidos ni aplicar la config/nombre de
      // ruta de la ida sobre servicios de retorno (ni duplicar el conteo).
      const tramoDe = (r: any): string => (r?.direccion_servicio === "retorno" ? "retorno" : "ida");
      const refTramo = tramoDe(refRow);
      // Universo = candidatos del MISMO tramo que la referencia (denominador de "omitidos").
      const universo = candIds.filter((id) => id === reservaId || tramoDe(rowById.get(id)) === refTramo);

      const huellaRefJson = huellaRuta(fuenteJson(refRow));

      let ids: number[];
      if (huellaRefJson !== "") {
        // Ruta principal: comparar huellas del snapshot JSON. Funciona con los
        // servicios masivos aún sin `paradas` materializadas.
        ids = universo.filter((id) =>
          id === reservaId || huellaRuta(fuenteJson(rowById.get(id))) === huellaRefJson
        );
      } else {
        // Fallback legacy: cotización/reserva sin paradas_json → comparar las
        // filas `paradas` ya materializadas (comportamiento anterior). Se consulta
        // por lotes bajo el tope de 1000 filas de un solo .in(); LOTE conservador
        // para no truncar rutas con muchos paraderos.
        const idsParaParadas = Array.from(new Set([reservaId, ...universo]));
        const LOTE = 25; // ≤ ~1000 paradas por consulta aun con ~40 paraderos/servicio
        const porReserva = new Map<number, any[]>();
        for (let i = 0; i < idsParaParadas.length; i += LOTE) {
          const lote = idsParaParadas.slice(i, i + LOTE);
          const { data: pars } = await supabase.from("paradas")
            .select("reserva_id, orden, nombre, lat, lng")
            .in("reserva_id", lote);
          for (const p of ((pars || []) as any[])) {
            const arr = porReserva.get(p.reserva_id);
            if (arr) arr.push(p); else porReserva.set(p.reserva_id, [p]);
          }
        }
        const huellaRef = huellaRuta(porReserva.get(reservaId));
        ids = universo.filter((id) =>
          id === reservaId || (huellaRef !== "" && huellaRuta(porReserva.get(id)) === huellaRef)
        );
      }

      if (cancelado) return;
      setMatchRaw({ ids, universo });
     } catch {
      // Error inesperado de red/consulta: no dejamos el preview colgado ni con un
      // conteo obsoleto del rango anterior. Solo la corrida vigente toca el estado.
      if (!cancelado) { setMatchRaw(null); setPreviewError(true); }
     } finally {
      if (!cancelado) setPreviewCargando(false);
     }
    })();

    return () => { cancelado = true; };
  }, [modalConfigRango, cotizacionId, vehiculoId, vehiculoTerceroId, configDesde, configHasta, reservaId]);

  // Preview (parte barata): deriva previewIds/previewTotal desde el resultado crudo
  // aplicando el filtro de "Incluir este servicio". Togglear el checkbox solo re-corre
  // esto (un filtro en memoria), sin volver a paginar ni descargar paradas_json.
  useEffect(() => {
    if (!matchRaw) { setPreviewIds([]); setPreviewTotal(0); return; }
    const ids = incluirActual ? matchRaw.ids : matchRaw.ids.filter((id) => id !== reservaId);
    const universo = incluirActual ? matchRaw.universo : matchRaw.universo.filter((id) => id !== reservaId);
    setPreviewIds(ids);
    setPreviewTotal(universo.length);
  }, [matchRaw, incluirActual, reservaId]);

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
          empresa: normalizarEmpresa(p.empresa),
        })))
        .select();

      if (insResp.error) {
        setMensaje({ tipo: "err", texto: "Error al guardar: " + insResp.error.message });
        setImportando(false);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      const cuantos = insResp.data?.length || 0;

      // Auto-registrar en nómina los pasajeros nuevos que no estaban
      let registradosNomina = 0;
      if (clienteId && insResp.data && cuantos > 0) {
        const { data: nominaExiste } = await supabase
          .from("pasajeros").select("dni")
          .eq("cliente_id", clienteId).is("reserva_id", null);
        const dnisNomina = new Set((nominaExiste || []).map((p: any) => p.dni));
        const paraNomina = insResp.data.filter((p: any) => p.dni && !dnisNomina.has(p.dni));
        if (paraNomina.length > 0) {
          await supabase.from("pasajeros").insert(
            paraNomina.map((p: any) => ({
              cliente_id: clienteId, reserva_id: null,
              nombre: p.nombre, dni: p.dni,
              empresa: normalizarEmpresa(p.empresa), telefono: p.telefono || null, activo: true,
            }))
          );
          registradosNomina = paraNomina.length;
        }
      }

      const partes = [
        cuantos + " pasajero(s) cargado(s)",
        registradosNomina > 0 ? registradosNomina + " nuevo(s) en nómina" : "",
        duplicados > 0 ? duplicados + " duplicado(s) omitido(s)" : "",
        resultado.errores.length > 0 ? resultado.errores.length + " fila(s) con error" : "",
      ].filter(Boolean);
      setMensaje({ tipo: "ok", texto: partes.join(" · ") });

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
    // El trigger sync_estados_pasajero_parada de la BD sincroniza la columna `estado`
    // a partir de estado_abordaje (Abordado→abordado, etc.), así que no la escribimos aquí.
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

  const abrirMoverPax = async (pasajeroId: number) => {
    setMoverPaxId(pasajeroId);
    setCargandoDestinos(true);
    const { data } = await supabase
      .from("reservas")
      .select("id, hora_servicio, vehiculo_id, vehiculo_tercero_id, vehiculos(placa, modelo), vehiculos_tercero(placa, modelo)")
      .eq("fecha_servicio", fechaServicio)
      .eq("cliente_id", clienteId)
      .neq("id", reservaId)
      .neq("estado", "cancelada")
      .neq("estado", "finalizada")
      .order("hora_servicio");
    setServiciosDestino(data || []);
    setCargandoDestinos(false);
  };

  const confirmarMover = async (destinoId: number) => {
    if (!moverPaxId) return;
    setMoviendoPax(true);
    const pid = moverPaxId;
    const p = pasajeros.find((x) => x.id === pid)!;
    const a = asignaciones[pid];
    // Parada que tenía en el origen: la usamos para reproducir su paradero en el destino.
    const paradaOrigen = a ? paradas.find((x) => x.id === a.parada_id) ?? null : null;

    // 1. Quitar su anclaje al servicio origen.
    if (a) {
      await supabase.from("pasajeros_parada")
        .delete()
        .eq("pasajero_id", pid)
        .eq("parada_id", a.parada_id);
    }

    // 2. Buscar en el destino la parada equivalente: primero por place_id (ID de lugar de
    //    Google = mismo punto físico exacto); si no, por coordenadas con tolerancia ~5 m.
    let paradaDestinoId: number | null = null;
    if (paradaOrigen) {
      const { data: paradasDestino } = await supabase
        .from("paradas").select("id, lat, lng, place_id").eq("reserva_id", destinoId);
      const lista = (paradasDestino || []) as any[];

      const placeIdOrigen = (paradaOrigen as any).place_id || null;
      if (placeIdOrigen) {
        const m = lista.find((x) => x.place_id && x.place_id === placeIdOrigen);
        if (m) paradaDestinoId = m.id;
      }
      if (paradaDestinoId == null && paradaOrigen.lat != null && paradaOrigen.lng != null) {
        const TOL = 0.00005; // ~5 m: tolera diferencias de redondeo entre servicios
        const m = lista.find((x) =>
          x.lat != null && x.lng != null &&
          Math.abs(Number(x.lat) - Number(paradaOrigen.lat)) <= TOL &&
          Math.abs(Number(x.lng) - Number(paradaOrigen.lng)) <= TOL
        );
        if (m) paradaDestinoId = m.id;
      }
    }

    // 3. Anclar al destino. Con paradero si hubo equivalente; si no, sin asignar.
    let conservoParadero = false;
    if (paradaDestinoId != null) {
      await supabase.from("pasajeros_parada").insert({
        pasajero_id: pid, parada_id: paradaDestinoId,
        estado: "esperando", estado_abordaje: "Pendiente",
      });
      conservoParadero = true;
      // Si era ad-hoc del origen, mover su pertenencia para que no siga en el origen.
      if (p.reserva_id === reservaId) {
        await supabase.from("pasajeros").update({ reserva_id: destinoId }).eq("id", pid);
      }
    } else {
      // Sin parada equivalente → fijarlo al servicio destino para que aparezca "sin asignar".
      await supabase.from("pasajeros").update({ reserva_id: destinoId }).eq("id", pid);
    }

    setPasajeros((prev) => prev.filter((x) => x.id !== pid));
    setAsignaciones((prev) => { const n = { ...prev }; delete n[pid]; return n; });
    setMoverPaxId(null);
    setServiciosDestino([]);
    setMoviendoPax(false);
    setMensaje({
      tipo: conservoParadero ? "ok" : "warn",
      texto: conservoParadero
        ? "Pasajero movido al servicio destino conservando su paradero."
        : "Pasajero movido al servicio destino. Ese servicio no tiene su paradero: quedó sin asignar.",
    });
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
          empresa:    normalizarEmpresa(formAdd.empresa),
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

      // Auto-registrar en nómina si no existe aún (por DNI)
      let registradoEnNomina = false;
      if (clienteId) {
        const { data: existeNomina } = await supabase
          .from("pasajeros").select("id")
          .eq("cliente_id", clienteId).is("reserva_id", null)
          .eq("dni", formAdd.dni.trim()).maybeSingle();
        if (!existeNomina) {
          await supabase.from("pasajeros").insert({
            cliente_id: clienteId, reserva_id: null,
            nombre: formAdd.nombre.trim(), dni: formAdd.dni.trim(),
            empresa: normalizarEmpresa(formAdd.empresa),
            telefono: formAdd.telefono.trim() || null, activo: true,
          });
          registradoEnNomina = true;
        }
      }

      setMensaje({ tipo: "ok", texto: `${formAdd.nombre.trim()} agregado al manifiesto${registradoEnNomina ? " y a la nómina" : ""} ✓` });
      setFormAdd({ nombre: "", dni: "", empresa: "", telefono: "", parada_id: "" });
      setMostrarFormAdd(false);
      await cargar();
      if (onChange) onChange();
    } finally {
      setSavingAdd(false);
    }
  };

  // ── Panel nómina: carga y agrega ────────────────────────────────────────────
  const cargarNominaPanel = async () => {
    if (!clienteId) return;
    setLoadingNomina(true);
    const { data } = await supabase
      .from("pasajeros")
      .select("id, reserva_id, cliente_id, nombre, dni, telefono, empresa")
      .eq("cliente_id", clienteId)
      .is("reserva_id", null)
      .order("nombre");
    setNomina((data || []) as PasajeroManifiesto[]);
    setLoadingNomina(false);
  };

  const agregarDesdeNomina = async (pax: PasajeroManifiesto) => {
    if (paradas.length === 0) {
      setMensaje({ tipo: "warn", texto: "Agrega primero una parada al itinerario para poder asignar pasajeros." });
      return;
    }
    setAgregandoPaxId(pax.id);
    setMensaje(null);
    try {
      // Enlaza el pasajero de nómina existente a la primera parada (no duplica su fila
      // en `pasajeros`: eso choca con uq_pasajero_cliente_dni, único por dni+cliente).
      const { error } = await supabase.from("pasajeros_parada").insert({
        pasajero_id: pax.id,
        parada_id: paradas[0].id,
        estado: "esperando",
        estado_abordaje: "Pendiente",
      });
      if (error) { setMensaje({ tipo: "err", texto: error.message }); return; }
      setNomina(prev => prev.filter(p => p.id !== pax.id));
      await cargar();
      if (onChange) onChange();
    } finally {
      setAgregandoPaxId(null);
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

  const nominaFiltrada = useMemo(() => {
    const disponibles = nomina.filter(p => !dnisExistentes.has(p.dni));
    const q = nominaBusq.toLowerCase().trim();
    if (!q) return disponibles;
    return disponibles.filter(p =>
      p.nombre.toLowerCase().includes(q) ||
      p.dni.toLowerCase().includes(q) ||
      (p.empresa || "").toLowerCase().includes(q)
    );
  }, [nomina, dnisExistentes, nominaBusq]);

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

  const guardarConfig = async (patch: Partial<{ ruta_nombre: string | null; permite_autoseleccion: boolean; permite_cambio_paradero: boolean }>) => {
    setConfigGuardando(true);
    try { await supabase.from("reservas").update(patch).eq("id", reservaId); }
    finally { setConfigGuardando(false); }
  };

  const aplicarConfigRango = async () => {
    if (!previewIds.length) return;
    setAplicandoConfig(true);
    try {
      const { error } = await supabase.from("reservas").update({
        ruta_nombre:             rutaNombre.trim() || null,
        permite_autoseleccion:   permiteAutoseleccion,
        permite_cambio_paradero: permiteCambioParadero,
      }).in("id", previewIds);
      if (error) throw error;
      setMensaje({ tipo: "ok", texto: `Config aplicada a ${previewIds.length} servicio(s) ✓` });
      setModalConfigRango(false);
      setConfigDesde(""); setConfigHasta("");
    } catch (e: any) {
      setMensaje({ tipo: "err", texto: e?.message || "Error al aplicar" });
    } finally {
      setAplicandoConfig(false);
    }
  };

  const ejecutarCopiar = async () => {
    if (!cotizacionId || !vehiculoId || !copiarDesde || !copiarHasta) return;
    setCopiando(true);
    try {
      // 1. Load current paradas ordered by orden (con nombre/coords para la huella)
      const { data: paradasOrigen } = await supabase
        .from("paradas")
        .select("id, orden, nombre, lat, lng")
        .eq("reserva_id", reservaId)
        .order("orden");
      if (!paradasOrigen || paradasOrigen.length === 0) {
        setMensaje({ tipo: "warn", texto: "Esta reserva no tiene paradas configuradas." });
        return;
      }
      // Huella de la ruta de origen: solo copiaremos a servicios con la MISMA ruta
      // (mismos paraderos, mismo orden), porque las asignaciones se mapean por
      // `orden` y una ruta distinta o invertida mandaría pasajeros al paradero
      // equivocado.
      const huellaOrigen = huellaRuta(paradasOrigen as any[]);

      // 2. Load current pasajeros_parada for this reserva
      const paradaIds = paradasOrigen.map((p: any) => p.id);
      const { data: asigOrigen } = await supabase
        .from("pasajeros_parada")
        .select("pasajero_id, parada_id, asiento")
        .in("parada_id", paradaIds);
      if (!asigOrigen || asigOrigen.length === 0) {
        setMensaje({ tipo: "warn", texto: "No hay pasajeros asignados a paradas en este servicio." });
        return;
      }

      // Map: orden → parada_id (origen)
      const ordenAParadaOrigen = new Map<number, number>(
        paradasOrigen.map((p: any) => [p.orden, p.id])
      );
      const paradaOrigenAOrden = new Map<number, number>(
        paradasOrigen.map((p: any) => [p.id, p.orden])
      );

      // 3. Find target reservas: same cotizacion_id + vehiculo, in date range.
      //    Se PAGINA (PostgREST corta a 1000): con programación masiva el rango
      //    puede abarcar >1000 destinos y sin paginar se copiaba a solo 1000 en
      //    silencio, sin reportarlo como omitido.
      const campoVehiculo = vehiculoId ? "vehiculo_id" : "vehiculo_tercero_id";
      const vidCopiar = (vehiculoId || vehiculoTerceroId)!;
      const reservasDestino = await paginarFilas(() =>
        supabase
          .from("reservas")
          .select("id, fecha_servicio")
          .eq("cotizacion_id", cotizacionId)
          .eq(campoVehiculo, vidCopiar)
          .neq("id", reservaId)
          .gte("fecha_servicio", copiarDesde)
          .lte("fecha_servicio", copiarHasta)
          .not("estado", "in", "(cancelada,finalizada)")
          .order("fecha_servicio").order("id")); // orden estable para paginar
      if (!reservasDestino || reservasDestino.length === 0) {
        setMensaje({ tipo: "warn", texto: "No se encontraron servicios del mismo vehículo en ese rango de fechas." });
        return;
      }

      let totalInsertados = 0;
      let reservasFallidas = 0;
      let reservasOmitidas = 0;   // descartadas por tener una ruta distinta
      let reservasSinParadas = 0; // aún sin `paradas` materializadas (no se abrieron)
      let reservasCopiadas = 0;

      for (const rd of reservasDestino) {
        // Load paradas for this target reserva ordered by orden (con nombre/coords)
        const { data: paradasDest } = await supabase
          .from("paradas")
          .select("id, orden, nombre, lat, lng")
          .eq("reserva_id", rd.id)
          .order("orden");
        // Sin paradas materializadas: no hay parada_id destino donde enganchar las
        // asignaciones (típico de servicios masivos aún sin abrir). Se cuenta aparte
        // para no reportar un falso "Copiado a 0 ✓".
        if (!paradasDest || paradasDest.length === 0) { reservasSinParadas++; continue; }

        // Solo copiar si la ruta de destino es idéntica a la de origen
        // (mismos paraderos y mismo orden, no en inversa).
        if (huellaRuta(paradasDest as any[]) !== huellaOrigen) {
          reservasOmitidas++;
          continue;
        }

        const ordenAParadaDest = new Map<number, number>(
          paradasDest.map((p: any) => [p.orden, p.id])
        );

        // Delete existing pasajeros_parada for this reserva to avoid duplicates
        const destParadaIds = paradasDest.map((p: any) => p.id);
        await supabase.from("pasajeros_parada").delete().in("parada_id", destParadaIds);

        // Build rows mapping by orden
        const rows: any[] = [];
        for (const asig of asigOrigen) {
          const orden = paradaOrigenAOrden.get(asig.parada_id);
          if (orden === undefined) continue;
          const destParadaId = ordenAParadaDest.get(orden);
          if (!destParadaId) continue;
          rows.push({
            pasajero_id: asig.pasajero_id,
            parada_id: destParadaId,
            estado_abordaje: "Pendiente",
            asiento: asig.asiento ?? null,
            hora_abordaje: null,
          });
        }
        if (rows.length > 0) {
          const { error } = await supabase.from("pasajeros_parada").insert(rows);
          if (error) { reservasFallidas++; } else { totalInsertados += rows.length; reservasCopiadas++; }
        }
      }

      if (reservasCopiadas === 0 && (reservasOmitidas > 0 || reservasSinParadas > 0 || reservasFallidas > 0)) {
        const motivos = [
          reservasSinParadas ? `${reservasSinParadas} sin paraderos aún (ábrelos primero para generar sus paradas)` : "",
          reservasOmitidas ? `${reservasOmitidas} con paraderos distintos o en otro orden` : "",
          reservasFallidas ? `${reservasFallidas} con error de inserción` : "",
        ].filter(Boolean).join(" · ");
        setMensaje({ tipo: reservasFallidas > 0 ? "err" : "warn", texto: `No se copió a ningún servicio. ${motivos}.` });
      } else {
        const extras = [
          reservasFallidas ? `${reservasFallidas} con error` : "",
          reservasOmitidas ? `${reservasOmitidas} omitido(s) por ruta distinta` : "",
          reservasSinParadas ? `${reservasSinParadas} sin paraderos aún` : "",
        ].filter(Boolean).join(" · ");
        const msg = `Copiado a ${reservasCopiadas} servicio(s) · ${totalInsertados} asignaciones${extras ? ` · ${extras}` : ""} ✓`;
        setMensaje({ tipo: "ok", texto: msg });
      }
      setModalCopiar(false);
      setCopiarDesde(""); setCopiarHasta("");
    } catch (e: any) {
      setMensaje({ tipo: "err", texto: e?.message || "Error desconocido" });
    } finally {
      setCopiando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15, 23, 42, 0.55)" }}>
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden">

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
                onClick={() => { const v = !mostrarFormAdd; setMostrarFormAdd(v); if (v) setMostrarNomina(false); setMensaje(null); }}
                className="px-3 py-2 rounded-xl font-bold text-xs border transition-colors"
                style={{
                  borderColor: mostrarFormAdd ? "#0b315f" : "#e2e8f0",
                  background:  mostrarFormAdd ? "#eaeff6"  : "white",
                  color:       mostrarFormAdd ? "#0b315f"  : "#374151",
                }}
              >
                {mostrarFormAdd ? "✕ Cancelar" : "+ Agregar 1 pasajero"}
              </button>

              {/* Agregar desde nómina */}
              {clienteId && (
                <button
                  onClick={() => {
                    const v = !mostrarNomina;
                    setMostrarNomina(v);
                    if (v) { setMostrarFormAdd(false); cargarNominaPanel(); }
                    setMensaje(null);
                  }}
                  className="px-3 py-2 rounded-xl font-bold text-xs border transition-colors"
                  style={{
                    borderColor: mostrarNomina ? "#0b315f" : "#e2e8f0",
                    background:  mostrarNomina ? "#eaeff6" : "white",
                    color:       mostrarNomina ? "#0b315f" : "#374151",
                  }}
                >
                  {mostrarNomina ? "✕ Cerrar nómina" : "📋 Desde nómina"}
                </button>
              )}

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

              {cotizacionId && (vehiculoId || vehiculoTerceroId) && (
                <button
                  onClick={() => setModalCopiar(true)}
                  className="px-3 py-2 rounded-xl font-bold text-xs border transition-colors"
                  style={{ borderColor: "#0b315f", background: "white", color: "#0b315f" }}
                >
                  📋 Copiar a días futuros
                </button>
              )}

              <button
                onClick={() => { setMostrarConfigRuta(v => !v); setMensaje(null); }}
                className="px-3 py-2 rounded-xl font-bold text-xs border transition-colors"
                style={{
                  borderColor: mostrarConfigRuta ? "#0b315f" : "#e2e8f0",
                  background:  mostrarConfigRuta ? "#eaeff6" : "white",
                  color:       mostrarConfigRuta ? "#0b315f" : "#374151",
                }}
              >
                ⚙ Configurar ruta
              </button>
            </div>

            {/* Panel config de ruta */}
            {mostrarConfigRuta && (
              <div className="mx-6 mt-3 rounded-xl border p-4" style={{ borderColor: "#bfdbfe", background: "#eaeff6" }}>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: "#0b315f" }}>
                  Configuración de ruta
                  {configGuardando && <span className="ml-2 font-normal opacity-60">· guardando…</span>}
                </p>
                <div className="flex gap-4 flex-wrap items-start">

                  {/* Nombre de ruta */}
                  <div className="flex-[1_1_220px]">
                    <p className="text-[10px] font-bold text-gray-500 uppercase mb-1">Nombre de ruta</p>
                    <input
                      value={rutaNombre}
                      onChange={e => setRutaNombre(e.target.value)}
                      onBlur={e => guardarConfig({ ruta_nombre: e.target.value.trim() || null })}
                      placeholder="Ej. RUTA A CHORRILLOS - CALLAO"
                      className="w-full border rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 bg-white"
                      style={{ borderColor: "#bfdbfe" }}
                    />
                    <p className="text-[10px] text-gray-400 mt-1">Visible al pasajero al elegir su bus</p>
                  </div>

                  {/* Toggles */}
                  <div className="flex flex-col gap-3 flex-[1_1_200px]">
                    {/* Toggle autoselección */}
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <button
                        type="button"
                        onClick={() => { const v = !permiteAutoseleccion; setPermiteAutoseleccion(v); guardarConfig({ permite_autoseleccion: v }); }}
                        className="relative flex-shrink-0 transition-colors rounded-full"
                        style={{ width: 36, height: 20, background: permiteAutoseleccion ? "#0b315f" : "#cbd5e1" }}
                      >
                        <span className="absolute top-1 transition-all rounded-full bg-white"
                          style={{ width: 14, height: 14, left: permiteAutoseleccion ? 18 : 3, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                      </button>
                      <div>
                        <p className="text-xs font-bold text-gray-700">Permitir que pasajeros elijan su paradero</p>
                        <p className="text-[10px] text-gray-400">Pasajeros sin paradero asignado podrán seleccionar uno</p>
                      </div>
                    </label>

                    {/* Toggle cambio de paradero */}
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <button
                        type="button"
                        onClick={() => { const v = !permiteCambioParadero; setPermiteCambioParadero(v); guardarConfig({ permite_cambio_paradero: v }); }}
                        className="relative flex-shrink-0 transition-colors rounded-full"
                        style={{ width: 36, height: 20, background: permiteCambioParadero ? "#0b315f" : "#cbd5e1" }}
                      >
                        <span className="absolute top-1 transition-all rounded-full bg-white"
                          style={{ width: 14, height: 14, left: permiteCambioParadero ? 18 : 3, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                      </button>
                      <div>
                        <p className="text-xs font-bold text-gray-700">Permitir cambio de paradero</p>
                        <p className="text-[10px] text-gray-400">Pasajeros con paradero asignado podrán modificarlo</p>
                      </div>
                    </label>
                  </div>

                  {/* Aplicar a rango */}
                  {cotizacionId && (vehiculoId || vehiculoTerceroId) && (
                    <div className="flex-[0_0_auto] flex flex-col justify-end">
                      <p className="text-[10px] font-bold text-gray-500 uppercase mb-1">Aplicar en lote</p>
                      <button
                        onClick={() => setModalConfigRango(true)}
                        className="px-3 py-2 rounded-xl font-bold text-xs border transition-colors whitespace-nowrap"
                        style={{ borderColor: "#0b315f", background: "white", color: "#0b315f" }}
                      >
                        📅 Aplicar a rango de fechas
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

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
                {capacidad !== null && total >= capacidad && (
                  <p className="text-[10px] font-bold mt-2" style={{ color: "#991b1b" }}>
                    ⚠ Capacidad llena ({total}/{capacidad}). Este pasajero creará sobrecupo.
                  </p>
                )}
              </div>
            )}

            {/* Panel Agregar desde nómina */}
            {mostrarNomina && clienteId && (
              <div className="mx-6 mt-3 rounded-xl border p-4" style={{ borderColor: "#bfdbfe", background: "#eaeff6" }}>
                <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                  <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#0b315f" }}>
                    Agregar desde nómina
                    {capacidad !== null && (
                      <span className="ml-2 font-normal" style={{ color: capacidad - total > 0 ? "#065f46" : "#991b1b" }}>
                        · {capacidad - total > 0 ? `${capacidad - total} lugar(es) disponible(s)` : "LLENO"}
                      </span>
                    )}
                  </p>
                  <input
                    value={nominaBusq}
                    onChange={e => setNominaBusq(e.target.value)}
                    placeholder="Buscar en nómina…"
                    className="border rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 bg-white"
                    style={{ minWidth: 180 }}
                  />
                </div>
                {loadingNomina ? (
                  <p className="text-xs text-gray-400">Cargando nómina…</p>
                ) : nominaFiltrada.length === 0 ? (
                  <p className="text-xs text-gray-400">
                    {nomina.length === 0
                      ? "La nómina de este cliente está vacía."
                      : "Todos los pasajeros de la nómina ya están en este servicio."}
                  </p>
                ) : (
                  <div className="max-h-52 overflow-y-auto flex flex-col gap-1.5 pr-1">
                    {nominaFiltrada.map(p => (
                      <div key={p.id} className="flex items-center justify-between rounded-lg px-3 py-2 bg-white border" style={{ borderColor: "#e2e8f0" }}>
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style={{ background: "#0b315f" }}>
                            {p.nombre.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-gray-800 truncate">{p.nombre}</p>
                            <p className="text-[10px] text-gray-400 font-mono">{p.dni}{p.empresa ? ` · ${p.empresa}` : ""}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => agregarDesdeNomina(p)}
                          disabled={agregandoPaxId === p.id}
                          className="ml-3 px-3 py-1 rounded-lg font-bold text-[11px] text-white flex-shrink-0 disabled:opacity-50"
                          style={{ background: "#0b315f" }}
                        >
                          {agregandoPaxId === p.id ? "…" : "+ Agregar"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
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
                          <td className="p-2 text-right whitespace-nowrap">
                            <button
                              onClick={() => abrirMoverPax(p.id)}
                              disabled={estado === "Abordado" || !fechaServicio}
                              title="Mover a otro servicio"
                              className="text-blue-500 hover:bg-blue-50 px-2 py-1 rounded-lg mr-1 disabled:opacity-25 disabled:cursor-not-allowed"
                            >
                              ⇄
                            </button>
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

        {/* Modal aplicar config a rango de fechas */}
        {modalConfigRango && (
          <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: "rgba(15,23,42,0.5)" }}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
              <div className="px-6 py-4" style={{ background: "#0b315f" }}>
                <p className="text-white font-bold text-sm">Aplicar config a rango de fechas</p>
                <p className="text-blue-200 text-xs mt-0.5">
                  Aplica el nombre de ruta y los toggles al mismo vehículo en el rango seleccionado.
                </p>
              </div>
              <div className="px-6 py-5 flex flex-col gap-4">

                {/* Resumen de config a aplicar */}
                <div className="rounded-xl border p-3 text-xs" style={{ borderColor: "#bfdbfe", background: "#eaeff6" }}>
                  <p className="font-bold text-gray-600 mb-1">Config que se aplicará:</p>
                  <p className="text-gray-700">
                    <span className="font-bold">Ruta:</span> {rutaNombre.trim() || <span className="italic text-gray-400">sin nombre</span>}
                  </p>
                  <p className="text-gray-700">
                    <span className="font-bold">Autoselección:</span> {permiteAutoseleccion ? "Activo" : "Inactivo"}
                  </p>
                  <p className="text-gray-700">
                    <span className="font-bold">Cambio paradero:</span> {permiteCambioParadero ? "Activo" : "Inactivo"}
                  </p>
                </div>

                {/* Accesos rápidos */}
                <div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Selección rápida</p>
                  <div className="flex gap-2 flex-wrap">
                    {(() => {
                      const ref  = fechaServicio || (() => {
                        const hoy = new Date();
                        return `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,"0")}-${String(hoy.getDate()).padStart(2,"0")}`;
                      })();
                      const [yyyy, mm] = ref.split("-");
                      const lastDay = String(new Date(Number(yyyy), Number(mm), 0).getDate()).padStart(2, "0");
                      const refPlusFn = () => {
                        const d = new Date(ref + "T00:00:00");
                        d.setDate(d.getDate() + 14);
                        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
                      };
                      const options = [
                        { label: "Este servicio en adelante", desde: ref,               hasta: "2099-12-31",   incl: true },
                        { label: "Próximas 2 semanas",        desde: ref,               hasta: refPlusFn(),    incl: true },
                        { label: "Este mes",                  desde: `${yyyy}-${mm}-01`, hasta: `${yyyy}-${mm}-${lastDay}`, incl: true },
                      ];
                      return options.map(o => {
                        const activo = configDesde === o.desde && configHasta === o.hasta && incluirActual === o.incl;
                        return (
                          <button key={o.label} type="button"
                            onClick={() => { setConfigDesde(o.desde); setConfigHasta(o.hasta); setIncluirActual(o.incl); }}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors"
                            style={{
                              borderColor: activo ? "#0b315f" : "#e2e8f0",
                              background:  activo ? "#eaeff6" : "white",
                              color:       activo ? "#0b315f" : "#6b7280",
                            }}
                          >
                            {o.label}
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>

                {/* Rango de fechas personalizado */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Desde</p>
                    <input type="date" value={configDesde} onChange={e => setConfigDesde(e.target.value)}
                      className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Hasta</p>
                    <input type="date" value={configHasta} onChange={e => setConfigHasta(e.target.value)}
                      className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20" />
                  </div>
                </div>

                {/* Checkbox incluir actual */}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={incluirActual}
                    onChange={e => setIncluirActual(e.target.checked)}
                    className="w-4 h-4 rounded accent-[#0b315f]"
                  />
                  <span className="text-xs text-gray-600">Incluir este servicio (#{reservaId})</span>
                </label>

                {/* Preview count */}
                {configDesde && configHasta && (
                  <div>
                    <p className="text-xs font-bold rounded-xl px-3 py-2 text-center"
                      style={{
                        background: previewCargando ? "#e2e8f0" : previewError ? "#fee2e2" : previewIds.length ? "#dcfce7" : "#fef9c3",
                        color: previewCargando ? "#475569" : previewError ? "#991b1b" : previewIds.length ? "#166534" : "#854d0e",
                      }}>
                      {previewCargando
                        ? "Calculando servicios afectados…"
                        : previewError
                          ? "No se pudo calcular (error de conexión). Reintenta ajustando el rango."
                          : previewIds.length
                            ? `Se actualizarán ${previewIds.length} servicio(s) con la misma ruta`
                            : previewTotal > 0
                              ? "Ningún servicio del rango tiene la misma ruta que este"
                              : "No se encontraron servicios del mismo vehículo en ese rango"}
                    </p>
                    {!previewCargando && !previewError && previewTotal > previewIds.length && (
                      <p className="text-[11px] text-gray-500 text-center mt-1.5 leading-snug">
                        Se omitieron {previewTotal - previewIds.length} servicio(s) con paraderos
                        distintos o en otro orden. Solo se aplica a rutas con los mismos paraderos
                        (nombre y coordenadas) y en el mismo sentido.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="px-6 pb-5 flex gap-2 justify-end">
                <button
                  onClick={() => { setModalConfigRango(false); setConfigDesde(""); setConfigHasta(""); setPreviewIds([]); setPreviewTotal(0); }}
                  className="px-4 py-2 rounded-xl font-bold text-xs border text-gray-500 hover:bg-gray-50"
                  style={{ borderColor: "#e2e8f0" }}
                >
                  Cancelar
                </button>
                <button
                  onClick={aplicarConfigRango}
                  disabled={aplicandoConfig || previewCargando || !previewIds.length}
                  className="px-5 py-2 rounded-xl font-bold text-xs text-white disabled:opacity-50"
                  style={{ background: aplicandoConfig || previewCargando ? "#6b7280" : "#0b315f" }}
                >
                  {aplicandoConfig ? "Aplicando..." : previewCargando ? "Calculando…" : `Aplicar a ${previewIds.length || 0} servicio(s)`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal copiar a días futuros */}
        {modalCopiar && (
          <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: "rgba(15,23,42,0.5)" }}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
              <div className="px-6 py-4" style={{ background: "#0b315f" }}>
                <p className="text-white font-bold text-sm">Copiar paraderos a días futuros</p>
                <p className="text-blue-200 text-xs mt-0.5">Copia las asignaciones pasajero → parada al mismo vehículo en el rango de fechas.</p>
              </div>
              <div className="px-6 py-5 flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Desde</p>
                    <input type="date" value={copiarDesde} onChange={e => setCopiarDesde(e.target.value)}
                      className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Hasta</p>
                    <input type="date" value={copiarHasta} onChange={e => setCopiarHasta(e.target.value)}
                      className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20" />
                  </div>
                </div>
                <p className="text-xs text-gray-400">
                  Se reemplazarán las asignaciones existentes en cada día destino. Solo se copia a
                  servicios con la <span className="font-semibold text-gray-500">misma ruta</span>:
                  mismos paraderos (nombre y coordenadas) y en el mismo orden. Los días con una ruta
                  distinta o invertida se omiten.
                </p>
              </div>
              <div className="px-6 pb-5 flex gap-2 justify-end">
                <button onClick={() => { setModalCopiar(false); setCopiarDesde(""); setCopiarHasta(""); }}
                  className="px-4 py-2 rounded-xl font-bold text-xs border text-gray-500 hover:bg-gray-50"
                  style={{ borderColor: "#e2e8f0" }}>
                  Cancelar
                </button>
                <button onClick={ejecutarCopiar} disabled={copiando || !copiarDesde || !copiarHasta}
                  className="px-5 py-2 rounded-xl font-bold text-xs text-white disabled:opacity-50"
                  style={{ background: copiando ? "#6b7280" : "#0b315f" }}>
                  {copiando ? "Copiando..." : "Copiar"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Mini-modal: Mover pasajero a otro servicio ── */}
        {moverPaxId !== null && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 rounded-2xl">
            <div className="bg-white rounded-xl shadow-xl p-5 w-80 mx-4">
              <p className="font-bold text-sm text-gray-800 mb-1">Mover a otro servicio</p>
              <p className="text-[11px] text-gray-500 mb-3 truncate">
                {pasajeros.find((x) => x.id === moverPaxId)?.nombre}
              </p>
              {cargandoDestinos ? (
                <div className="text-xs text-gray-400 text-center py-6">Cargando servicios...</div>
              ) : serviciosDestino.length === 0 ? (
                <div className="text-xs text-gray-400 text-center py-6">
                  No hay otros servicios disponibles para este día y empresa.
                </div>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
                  {serviciosDestino.map((s: any) => {
                    const veh = s.vehiculos || s.vehiculos_tercero;
                    return (
                      <button
                        key={s.id}
                        disabled={moviendoPax}
                        onClick={() => confirmarMover(s.id)}
                        className="text-left border rounded-lg px-3 py-2 hover:bg-blue-50 text-xs disabled:opacity-50 transition-colors"
                        style={{ borderColor: "#e2e8f0" }}
                      >
                        <span className="font-bold text-gray-800">{s.hora_servicio || "Sin hora"}</span>
                        {veh && (
                          <span className="text-gray-500 ml-2">
                            {veh.placa}{veh.modelo ? ` · ${veh.modelo}` : ""}
                          </span>
                        )}
                        <span className="text-gray-400 ml-1 text-[10px]">#{s.id}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                onClick={() => { setMoverPaxId(null); setServiciosDestino([]); }}
                className="mt-3 w-full text-xs text-gray-500 hover:text-gray-700 py-1"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

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