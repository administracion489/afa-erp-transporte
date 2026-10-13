"use client";
// app/monitoreo/page.tsx — EL MAPA DE LA FLOTA. Dónde está cada unidad y qué hay que hacer con ella.
//
// QUIÉN DECIDE QUÉ: el estado de cada unidad (color, etiqueta, detalle, si se dibuja, su orden) lo
// da `juzgarUnidad` de lib/monitoreo-estado.ts, el motor puro con su matriz. Esta pantalla solo
// junta la evidencia (catálogos, servicios del día, SOS y posiciones) y pinta lo que sale de ahí.
//
// DE DÓNDE SALEN LAS POSICIONES:
//   · GET /api/monitoreo/flota (service-role, módulo `monitoreo`): la ÚLTIMA posición de cada unidad
//     de los últimos 30 días, al montar y cada 60 s (en pausa con la pestaña oculta, y una al volver).
//     Antes la pantalla pedía 500 filas de los últimos 30 min y BORRABA el marcador de quien no
//     viniera: las unidades paradas parpadeaban y, pasada media hora, desaparecían. Ahora una unidad
//     que deja de transmitir sigue en el mapa, en GRIS, en su última posición y con su edad.
//   · Entre sondeos, el realtime INSERT de `ubicaciones_gps` mueve UNA unidad con `fusionarPosicion`
//     (el marcador se mueve al instante; la lista y los contadores se refrescan en lote, ≤ 1/s).
//   · Un sondeo que falla CONSERVA lo último y lo dice en ámbar; nunca vacía el mapa.
//
// UNA SOLA IDENTIDAD: la unidad, `claveUnidad` («p:ID» / «t:ID»), en lista, marcadores, contadores y
// «centrar». Antes los marcadores iban por conductor y la lista por vehículo: un relevo eran dos buses.
//
// LÍMITE DECLARADO: un conductor conectado SIN unidad solo se ve si transmite mientras la pantalla
// está abierta (sale del realtime, no del sondeo), y se quita a los 30 min sin puntos.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import { columnaFaltante } from "@/lib/columna-faltante";
import { fechaLima } from "@/lib/alertas-horario";
import { animarMarcador } from "@/lib/anim-marker";
import { coincideBusqueda, terminosBusqueda } from "@/lib/busqueda-texto";
import { claveConductor, claveUnidad } from "@/lib/flota/excesos";
import {
  COLOR_CLASE, DIAS_ULTIMA_POSICION, EN_LINEA_MIN, NO_INICIO_MIN_DEFECTO,
  fusionarPosicion, inicioServicioMs, juzgarUnidad, resumenFlota, rotuloEdad, rotuloMomento,
  unidadDeFila, unidadVigente,
  type ClaseMonitoreo, type FilaGpsMonitoreo, type PosicionUnidad, type RespuestaFlotaMonitoreo,
  type ServicioUnidad,
} from "@/lib/monitoreo-estado";
import { IconRefresh, IconCrosshair } from "@/app/_components/icons";
import {
  CAT_LABEL, Z_ALERTA_SOS, Z_SELECCIONADO, catKey, claseMarcador, htmlMarcadorPersona, htmlMarcadorUnidad,
  htmlPopupPersona, htmlPopupSos, htmlPopupUnidad, inyectarEstilosMonitoreo,
} from "@/components/monitoreo/marcadores";
import ChipsEstado from "@/components/monitoreo/ChipsEstado";
import ListaUnidades from "@/components/monitoreo/ListaUnidades";
import LeyendaMapa from "@/components/monitoreo/LeyendaMapa";
import { usePreferenciaBool } from "@/components/monitoreo/usePreferencia";
import type { FiltroFlota, FiltroServicio, UnidadVista } from "@/components/monitoreo/tipos";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

// ── Tiempos de la pantalla (operativos) ─────────────────────────────────────
const SONDEO_MS = 60_000;          // posiciones del servidor (con caché compartida de 30 s)
const RELOJ_MS = 30_000;           // re-juzga todo: así una unidad pasa de verde a gris sin recargar
const PUBLICAR_MS = 1_000;         // lote del realtime hacia la lista y los contadores
const PERSONA_VIDA_MS = 30 * 60_000;
const DIA_MS = 86_400_000;
const LIMA: [number, number] = [-77.0428, -12.0464];
/** Por debajo de este zoom, las placas de los grises se ocultan (con 90 grises son ruido). */
const ZOOM_PLACAS_GRISES = 13;

// Mismo criterio que /programacion, /seguimiento y /calendario (lib/liquidacion-clases.ts lo
// documenta): no solo «transporte_personal» es fijo, también los fijo_* de ModalGenerarPrograma.
const TIPOS_SERVICIO_FIJO = new Set(["transporte_personal", "fijo_solo_ida", "fijo_multiparada", "fijo_reten"]);

// SQL que agrega cada columna accesoria de `ubicaciones_gps` (lo nombra el aviso gris del panel).
const SQL_COLUMNA: Record<string, string> = {
  recibido_en: "supabase/gps-equipo-01.sql",
  fix_ts: "supabase/ubicaciones-gps-fix-ts.sql",
  simulado: "supabase/ubicaciones-gps-simulado.sql",
};

// ── Tipos de la base ────────────────────────────────────────────────────────
type AlertaSOS = {
  id: number; reserva_id: number | null;
  lat: number | null; lng: number | null;
  motivo: string | null; estado: string;
  atendida_por: number | null; atendida_at: string | null; created_at: string;
};
const esSosPendiente = (a: AlertaSOS) => a.estado === "pendiente";
type Vehiculo = { id: number; placa: string | null; categoria: string | null; marca: string | null; modelo: string | null; estado?: string | null };
type VehiculoTercero = Vehiculo & { empresa_id: number | null };
type Conductor = { id: number; nombre: string | null; telefono: string | null };
type EmpresaTercero = { id: number; razon_social: string | null };
type ReservaMon = {
  id: number; fecha_servicio: string | null; hora_servicio: string | null; estado: string | null;
  vehiculo_id: number | null; vehiculo_tercero_id: number | null; tipo_servicio_detalle: string | null;
};
type Catalogos = {
  vehiculos: Vehiculo[]; vehiculosTercero: VehiculoTercero[];
  conductores: Conductor[]; conductoresTercero: Conductor[]; empresas: EmpresaTercero[];
};
/** Conductor conectado sin unidad (solo del realtime). */
type Persona = { clave: string; lat: number; lng: number; ts: number };

type ErrorPosiciones = { tipo: "permiso" | "sesion" | "red" | "servidor"; texto: string } | null;
type EstadoCanal = "conectando" | "vivo" | "reconectando";

/** Lee una tabla con una columna accesoria (`estado`); si la base no la tiene, sin ella. */
async function leerConOpcional<T>(tabla: string, cols: string, opcional: string): Promise<{ data: T[]; error: string | null }> {
  let r = await supabase.from(tabla).select(`${cols},${opcional}`);
  if (r.error) {
    const c = columnaFaltante(r.error);
    if (c === opcional || c === "") r = await supabase.from(tabla).select(cols);
  }
  return { data: (r.data ?? []) as T[], error: r.error ? String(r.error.message ?? r.error) : null };
}

const num = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const v = typeof x === "number" ? x : Number(x);
  return Number.isFinite(v) ? v : null;
};
const tsDe = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const t = Date.parse(String(x).replace(" ", "T"));
  return Number.isFinite(t) ? t : null;
};

type LecturaCatalogos = {
  catalogos: { [K in keyof Catalogos]: Catalogos[K] | null };
  error: string | null;
};

/** Flota, conductores y proveedores. Lo que falle viaja en null (se conserva lo anterior). */
async function leerCatalogos(): Promise<LecturaCatalogos> {
  const [v, vt, c, ct, e] = await Promise.all([
    leerConOpcional<Vehiculo>("vehiculos", "id,placa,categoria,marca,modelo", "estado"),
    leerConOpcional<VehiculoTercero>("vehiculos_tercero", "id,placa,categoria,marca,modelo,empresa_id", "estado"),
    supabase.from("conductores").select("id,nombre,telefono"),
    supabase.from("conductores_tercero").select("id,nombre,telefono"),
    supabase.from("empresas_tercerizadas").select("id,razon_social"),
  ]);
  const error = v.error && vt.error
    ? "No se pudo leer la flota (vehículos propios y tercerizados). Pulsa actualizar para reintentar."
    : v.error || vt.error
      ? `No se pudo leer la flota ${v.error ? "propia" : "tercerizada"}: la lista está incompleta.`
      : null;
  return {
    error,
    catalogos: {
      vehiculos: v.error ? null : v.data,
      vehiculosTercero: vt.error ? null : vt.data,
      conductores: c.error ? null : (c.data ?? []) as Conductor[],
      conductoresTercero: ct.error ? null : (ct.data ?? []) as Conductor[],
      empresas: e.error ? null : (e.data ?? []) as EmpresaTercero[],
    },
  };
}

/** Servicios de HOY y de AYER sin cerrar (el motor acota la ventana del «no inició»). «Hoy» en hora
 *  de Lima: con toISOString(), desde las 19:00 ya es mañana en UTC. null = no se pudo leer. */
async function leerReservas(): Promise<ReservaMon[] | null> {
  const t = Date.now();
  const { data, error } = await supabase
    .from("reservas")
    .select("id,fecha_servicio,hora_servicio,estado,vehiculo_id,vehiculo_tercero_id,tipo_servicio_detalle")
    .in("fecha_servicio", [fechaLima(t - DIA_MS), fechaLima(t)])
    .in("estado", ["programada", "confirmada", "en_curso"]);
  return error ? null : (data ?? []) as ReservaMon[];
}

/** Las SOS pendientes SIN límite ni corte por antigüedad (una pendiente vieja no puede quedar tapada
 *  por atendidas más recientes: pasó con 4 alertas de un mes) y las 20 últimas atendidas. */
async function leerSOS(): Promise<AlertaSOS[] | null> {
  const [p, h] = await Promise.all([
    supabase.from("alertas_sos").select("*").eq("estado", "pendiente").order("created_at", { ascending: false }),
    supabase.from("alertas_sos").select("*").eq("estado", "atendida").order("created_at", { ascending: false }).limit(20),
  ]);
  if (p.error) return null;
  return [...((p.data ?? []) as AlertaSOS[]), ...((h.data ?? []) as AlertaSOS[])]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** El pitido del SOS: dos tonos en dos osciladores (un oscilador solo puede arrancar UNA vez). */
function pitarSOS() {
  try {
    const ctx = new AudioContext();
    const tono = (frecuencia: number, desde: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = frecuencia;
      gain.gain.value = 0.3;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + desde);
      osc.stop(ctx.currentTime + desde + 0.5);
    };
    tono(880, 0);
    tono(660, 0.6);
    setTimeout(() => { void ctx.close().catch(() => {}); }, 1600);
  } catch { /* sin audio (navegador sin permiso de sonido): el panel SOS se abre igual */ }
}

const horaLima = (ms: number) =>
  new Date(ms).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function MonitoreoPage() {
  // ── Mapa ──────────────────────────────────────────────────────────────────
  const contenedorMapa = useRef<HTMLDivElement>(null);
  const mapa = useRef<mapboxgl.Map | null>(null);
  const [mapListo, setMapListo] = useState(false);
  const [mapaBaseFallo, setMapaBaseFallo] = useState(false);
  type Registro = { m: mapboxgl.Marker; clase: string; html: string; z: string; destino: string };
  const marcadores = useRef(new Map<string, Registro>());
  const contenidoPopup = useRef(new Map<string, () => string>());
  const htmlPopupAbierto = useRef(new Map<string, string>());
  const ajustado = useRef(false);
  const abrirPendiente = useRef<string | null>(null);

  // ── Datos ─────────────────────────────────────────────────────────────────
  const [catalogos, setCatalogos] = useState<Catalogos | null>(null);
  const [errorCatalogos, setErrorCatalogos] = useState<string | null>(null);
  const [reservas, setReservas] = useState<ReservaMon[]>([]);
  const [alertasSOS, setAlertasSOS] = useState<AlertaSOS[]>([]);
  /** La verdad del cliente: lo último del sondeo más lo que trajo el realtime. Se escribe en
   *  manejadores; el render lee `posiciones`, su copia publicada. */
  const vivo = useRef(new Map<string, PosicionUnidad>());
  const personasVivo = useRef(new Map<string, Persona>());
  const [posiciones, setPosiciones] = useState<ReadonlyMap<string, PosicionUnidad>>(() => new Map());
  const [personas, setPersonas] = useState<ReadonlyMap<string, Persona>>(() => new Map());
  const [estadoPos, setEstadoPos] = useState<"cargando" | "listo" | "fallo">("cargando");
  /** De la última respuesta buena: qué unidades se LEYERON (`unidades`), cuáles fallaron (`sinLeer`)
   *  y cuándo calculó el servidor (`generadoMs`, para saber si el realtime trajo algo más nuevo). */
  const [meta, setMeta] = useState<{
    leidas: Set<string>; sinLeer: Set<string>; parcial: boolean; columnas: string[]; noInicioMin: number; generadoMs: number;
  }>(() => ({ leidas: new Set(), sinLeer: new Set(), parcial: false, columnas: [], noInicioMin: NO_INICIO_MIN_DEFECTO, generadoMs: 0 }));
  /** Cuándo movió el realtime cada unidad por última vez (evidencia más nueva que el sondeo). */
  const realtimeVivo = useRef(new Map<string, number>());
  const [realtime, setRealtime] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [errorPos, setErrorPos] = useState<ErrorPosiciones>(null);
  const [ultimaOk, setUltimaOk] = useState<number | null>(null);
  const [actualizando, setActualizando] = useState(false);
  const [canal, setCanal] = useState<EstadoCanal>("conectando");
  const [ahora, setAhora] = useState<number>(() => Date.now());
  const enVuelo = useRef(false);
  const temporizadorPublicar = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Interfaz ──────────────────────────────────────────────────────────────
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [filtroClase, setFiltroClase] = useState<ClaseMonitoreo | null>(null);
  const [filtroFlota, setFiltroFlota] = useState<FiltroFlota>("todos");
  const [filtroServicio, setFiltroServicio] = useState<FiltroServicio>("todos");
  const [busqueda, setBusqueda] = useState("");
  const [mostrarEstacionadas, setMostrarEstacionadas] = usePreferenciaBool("afa_monitoreo_estacionadas", true);
  const [vistaMovil, setVistaMovil] = useState<"mapa" | "lista">("mapa");
  const [leyenda, setLeyenda] = useState<boolean | null>(null);
  const [panelSOS, setPanelSOS] = useState(false);

  // ══ PUBLICAR (de los refs al estado, en lote) ═════════════════════════════
  const publicar = useCallback(() => {
    const t = Date.now();
    for (const [k, p] of personasVivo.current) if (t - p.ts > PERSONA_VIDA_MS) personasVivo.current.delete(k);
    setPosiciones(new Map(vivo.current));
    setPersonas(new Map(personasVivo.current));
    setRealtime(new Map(realtimeVivo.current));
    setAhora(t);
  }, []);
  const programarPublicacion = useCallback(() => {
    if (temporizadorPublicar.current) return;
    temporizadorPublicar.current = setTimeout(() => {
      temporizadorPublicar.current = null;
      publicar();
    }, PUBLICAR_MS);
  }, [publicar]);

  // ══ MAPA: crear una vez ═══════════════════════════════════════════════════
  useEffect(() => {
    const cont = contenedorMapa.current;
    if (!cont || mapa.current) return;
    inyectarEstilosMonitoreo();
    // Celular: sin botones de zoom ni pantalla completa (se usan los dedos, y tapan el mapa).
    const celular = window.matchMedia("(max-width: 767px)").matches;
    const m = new mapboxgl.Map({
      container: cont,
      style: "mapbox://styles/mapbox/streets-v12",
      center: LIMA,
      zoom: 11,
    });
    mapa.current = m;
    if (!celular) {
      m.addControl(new mapboxgl.NavigationControl(), "top-right");
      m.addControl(new mapboxgl.FullscreenControl(), "top-right");
    }
    // Los marcadores son DOM: no necesitan el estilo. Se ponen al cargar, o a los 2.5 s aunque el
    // mapa base no haya llegado (red lenta, token caído): las unidades se ubican igual.
    const listo = () => setMapListo(true);
    m.on("load", () => { setMapaBaseFallo(false); listo(); });
    const respaldo = setTimeout(listo, 2500);
    m.on("error", (e: { error?: { status?: number; message?: string } }) => {
      console.error("[monitoreo] mapa:", e?.error?.message ?? e);
      if (!m.isStyleLoaded()) setMapaBaseFallo(true);
    });
    // Placas de los grises solo de cerca.
    const zoomPlacas = () => cont.classList.toggle("afa-lejos", m.getZoom() < ZOOM_PLACAS_GRISES);
    m.on("zoomend", zoomPlacas);
    zoomPlacas();
    // Mapbox solo escucha window.resize: al colapsar el menú o rotar el panel el canvas no se
    // redimensiona solo y queda con el ancho viejo.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => m.resize()) : null;
    ro?.observe(cont);
    const registro = marcadores.current;
    return () => {
      clearTimeout(respaldo);
      ro?.disconnect();
      registro.clear();
      m.remove();
      mapa.current = null;
    };
  }, []);

  // ══ CATÁLOGOS, SERVICIOS Y SOS (los lectores viven fuera del componente) ═══
  const aplicarCatalogos = useCallback((r: LecturaCatalogos) => {
    if (r.error && !r.catalogos.vehiculos && !r.catalogos.vehiculosTercero) {
      setErrorCatalogos(r.error);
      return;
    }
    setErrorCatalogos(r.error);
    // Lo que no se pudo leer conserva lo último que se tenía.
    setCatalogos((prev) => ({
      vehiculos: r.catalogos.vehiculos ?? prev?.vehiculos ?? [],
      vehiculosTercero: r.catalogos.vehiculosTercero ?? prev?.vehiculosTercero ?? [],
      conductores: r.catalogos.conductores ?? prev?.conductores ?? [],
      conductoresTercero: r.catalogos.conductoresTercero ?? prev?.conductoresTercero ?? [],
      empresas: r.catalogos.empresas ?? prev?.empresas ?? [],
    }));
  }, []);

  // ══ POSICIONES: sondeo a /api/monitoreo/flota ═════════════════════════════
  const actualizarPosiciones = useCallback(async () => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    try {
      const headers = await cabecerasErp();
      setActualizando(true);
      let res: Response;
      try {
        res = await fetch("/api/monitoreo/flota", { headers, cache: "no-store" });
      } catch {
        setErrorPos({ tipo: "red", texto: "Sin conexión con el servidor" });
        setEstadoPos((e) => (e === "cargando" ? "fallo" : e));
        return;
      }
      if (res.status === 401 || res.status === 403) {
        setErrorPos(res.status === 401
          ? { tipo: "sesion", texto: "Tu sesión venció: vuelve a ingresar para ver las posiciones." }
          : { tipo: "permiso", texto: "Te falta el permiso del módulo Monitoreo para ver las posiciones de la flota (lo da un administrador en Usuarios)." });
        setEstadoPos((e) => (e === "cargando" ? "fallo" : e));
        return;
      }
      if (!res.ok) {
        setErrorPos({ tipo: "servidor", texto: `El servidor no pudo leer las posiciones (error ${res.status})` });
        setEstadoPos((e) => (e === "cargando" ? "fallo" : e));
        return;
      }
      const datos = (await res.json()) as RespuestaFlotaMonitoreo;
      const t = Date.now();
      const vigencia = t - DIAS_ULTIMA_POSICION * DIA_MS;
      // Se FUSIONA, no se reemplaza: lo que trajo el realtime después de la caché del servidor no
      // se pierde. Gana la fila más reciente (el mismo orden total del motor).
      for (const p of datos.posiciones ?? []) {
        const actual = vivo.current.get(p.unidad);
        if (!actual || p.ultimo.orden >= actual.ultimo.orden) {
          vivo.current.set(p.unidad, actual ? { ...p, enlaceTs: Math.max(p.enlaceTs, actual.enlaceTs) } : p);
        } else if (p.enlaceTs > actual.enlaceTs) {
          vivo.current.set(p.unidad, { ...actual, enlaceTs: p.enlaceTs });
        }
      }
      const generadoMs = Date.parse(datos.generado_en) || t;
      const conPosicion = new Set((datos.posiciones ?? []).map((p) => p.unidad));
      const sinLeer = new Set(datos.sin_leer ?? []);
      const leidas = new Set(datos.unidades ?? []);
      for (const [k, p] of vivo.current) {
        if (p.posicionTs < vigencia) { vivo.current.delete(k); continue; }
        // Leída y SIN posición según el servidor: lo que se tenía ya no vale, salvo que el realtime
        // la haya movido después de que el servidor calculara.
        const leidaSinPosicion = !conPosicion.has(k) && !sinLeer.has(k) && leidas.has(k);
        if (leidaSinPosicion && (realtimeVivo.current.get(k) ?? 0) <= generadoMs) vivo.current.delete(k);
      }
      for (const [k, ts] of realtimeVivo.current) if (ts < generadoMs - 5 * 60_000) realtimeVivo.current.delete(k);
      setMeta({
        leidas,
        generadoMs,
        sinLeer,
        parcial: datos.parcial === true,
        columnas: datos.columnas_faltantes ?? [],
        noInicioMin: Number.isFinite(datos.no_inicio_min) ? datos.no_inicio_min : NO_INICIO_MIN_DEFECTO,
      });
      setErrorPos(null);
      setUltimaOk(t);
      setEstadoPos("listo");
      publicar();
    } finally {
      enVuelo.current = false;
      setActualizando(false);
    }
  }, [publicar]);

  /** Botón «Actualizar»: todo de nuevo. */
  const actualizarTodo = async () => {
    void actualizarPosiciones();
    const [c, r, a] = await Promise.all([leerCatalogos(), leerReservas(), leerSOS()]);
    aplicarCatalogos(c);
    if (r) setReservas(r);
    if (a) setAlertasSOS(a);
  };

  // Al montar: todo. Cada 60 s (solo con la pestaña visible): posiciones y servicios. Al volver a
  // la pestaña, uno inmediato. El estado se escribe en los `then` (react-hooks/set-state-in-effect).
  useEffect(() => {
    let montado = true;
    void actualizarPosiciones();
    void Promise.all([leerCatalogos(), leerReservas(), leerSOS()]).then(([c, r, a]) => {
      if (!montado) return;
      aplicarCatalogos(c);
      if (r) setReservas(r);
      if (a) setAlertasSOS(a);
    });
    const sondeo = () => {
      if (document.visibilityState !== "visible") return;
      void actualizarPosiciones();
      void leerReservas().then((r) => { if (montado && r) setReservas(r); });
    };
    const iv = setInterval(sondeo, SONDEO_MS);
    document.addEventListener("visibilitychange", sondeo);
    return () => {
      montado = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", sondeo);
    };
  }, [actualizarPosiciones, aplicarCatalogos]);

  // El reloj re-juzga todo sin recargar nada.
  useEffect(() => {
    const iv = setInterval(() => setAhora(Date.now()), RELOJ_MS);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => () => { if (temporizadorPublicar.current) clearTimeout(temporizadorPublicar.current); }, []);

  // ══ REALTIME: posiciones nuevas ═══════════════════════════════════════════
  useEffect(() => {
    const ch = supabase.channel("monitoreo-gps")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps" },
        (payload: { new: FilaGpsMonitoreo }) => {
          const fila = payload.new;
          if (!fila) return;
          const t = Date.now();
          const unidad = unidadDeFila(fila);
          const conductor = claveConductor(fila.conductor_id, fila.conductor_tercero_id);
          if (unidad) {
            const antes = vivo.current.get(unidad) ?? null;
            const despues = fusionarPosicion(antes, fila, t);
            if (despues && despues !== antes) {
              vivo.current.set(unidad, despues);
              realtimeVivo.current.set(unidad, t);
              // El marcador se mueve YA; color, lista y contadores llegan en el lote.
              const reg = marcadores.current.get("u:" + unidad);
              const destino = `${despues.lng},${despues.lat}`;
              if (reg && reg.destino !== destino) {
                reg.destino = destino;
                animarMarcador(reg.m, [despues.lng, despues.lat]);
              }
            }
            if (conductor) personasVivo.current.delete(conductor);   // ya maneja una unidad
          } else if (conductor && fila.simulado !== true) {
            const lat = num(fila.lat), lng = num(fila.lng);
            const creado = tsDe(fila.created_at), recibido = tsDe(fila.recibido_en);
            if (lat != null && lng != null && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
              const ts = Math.min(creado ?? recibido ?? t, recibido ?? Infinity, t);
              const prev = personasVivo.current.get(conductor);
              if (!prev || ts >= prev.ts) personasVivo.current.set(conductor, { clave: conductor, lat, lng, ts });
            }
          }
          programarPublicacion();
        })
      .subscribe((estado: string) => {
        setCanal(estado === "SUBSCRIBED" ? "vivo" : "reconectando");
      });
    return () => { void supabase.removeChannel(ch); };
  }, [programarPublicacion]);

  // ══ REALTIME: alertas SOS (nuevas, y atendidas por otro operador) ══════════
  useEffect(() => {
    const ch = supabase.channel("monitoreo-sos")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alertas_sos" },
        (payload: { new: AlertaSOS }) => {
          const nueva = payload.new;
          if (!nueva) return;
          setAlertasSOS((prev) => [nueva, ...prev.filter((a) => a.id !== nueva.id)]);
          if (esSosPendiente(nueva)) {
            setPanelSOS(true);
            pitarSOS();
          }
        })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "alertas_sos" },
        (payload: { new: AlertaSOS }) => {
          const cambiada = payload.new;
          if (!cambiada) return;
          setAlertasSOS((prev) => prev.some((a) => a.id === cambiada.id)
            ? prev.map((a) => (a.id === cambiada.id ? { ...a, ...cambiada } : a))
            : [cambiada, ...prev]);
        })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, []);

  const atenderSOS = async (id: number) => {
    // El UPDATE directo lo bloquea RLS: se persiste por la API con service-role.
    try {
      const res = await fetch("/api/monitoreo/atender-sos", {
        method: "POST",
        headers: await cabecerasErp(),
        body: JSON.stringify({ id }),
      });
      if (res.status === 401) { alert("Tu sesión venció: vuelve a ingresar para marcar el SOS como atendido."); return; }
      if (res.status === 403) { alert("Te falta el permiso del módulo Monitoreo (o Seguimiento) para marcar el SOS como atendido."); return; }
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: null }));
        alert("No se pudo marcar como atendido: " + (error || `error ${res.status}`));
        return;
      }
      setAlertasSOS((prev) => prev.map((a) => (a.id === id ? { ...a, estado: "atendida", atendida_at: new Date().toISOString() } : a)));
    } catch {
      alert("No se pudo marcar como atendido (sin conexión).");
    }
  };

  // ══ LA FLOTA, JUZGADA ═════════════════════════════════════════════════════
  const indices = useMemo(() => {
    const condP = new Map<number, Conductor>(), condT = new Map<number, Conductor>(), emp = new Map<number, string | null>();
    for (const c of catalogos?.conductores ?? []) condP.set(c.id, c);
    for (const c of catalogos?.conductoresTercero ?? []) condT.set(c.id, c);
    for (const e of catalogos?.empresas ?? []) emp.set(e.id, e.razon_social);
    return { condP, condT, emp };
  }, [catalogos]);

  const conductorDe = useCallback((clave: string | null) => {
    if (!clave) return null;
    const id = Number(clave.slice(2));
    const c = clave.startsWith("t:") ? indices.condT.get(id) : indices.condP.get(id);
    return c ? { nombre: c.nombre, telefono: c.telefono } : { nombre: null, telefono: null };
  }, [indices]);

  /** Servicios por unidad y la unidad de cada reserva (para atar el SOS a su unidad). */
  const servicios = useMemo(() => {
    const porUnidad = new Map<string, (ServicioUnidad & { tipo: string | null; fecha: string | null })[]>();
    const unidadDeReserva = new Map<number, string>();
    for (const r of reservas) {
      const u = claveUnidad(r.vehiculo_id, r.vehiculo_tercero_id);
      if (!u) continue;
      unidadDeReserva.set(r.id, u);
      const lista = porUnidad.get(u) ?? [];
      lista.push({
        reservaId: r.id, estado: String(r.estado ?? ""), inicioMs: inicioServicioMs(r.fecha_servicio, r.hora_servicio),
        tipo: r.tipo_servicio_detalle, fecha: r.fecha_servicio,
      });
      porUnidad.set(u, lista);
    }
    return { porUnidad, unidadDeReserva };
  }, [reservas]);

  const sosPorUnidad = useMemo(() => {
    const s = new Set<string>();
    for (const a of alertasSOS) {
      if (!esSosPendiente(a) || a.reserva_id == null) continue;
      const u = servicios.unidadDeReserva.get(a.reserva_id);
      if (u) s.add(u);
    }
    return s;
  }, [alertasSOS, servicios]);

  const unidades: UnidadVista[] = useMemo(() => {
    if (!catalogos) return [];
    const hoy = fechaLima(ahora);
    const base: Omit<UnidadVista, "posicion" | "veredicto" | "conductor" | "tipoServicio">[] = [
      ...catalogos.vehiculos.filter((v) => unidadVigente(v.estado)).map((v) => ({
        clave: `p:${v.id}`, placa: v.placa || `#${v.id}`, categoria: v.categoria, marca: v.marca, modelo: v.modelo,
        esTercero: false, proveedor: null,
      })),
      ...catalogos.vehiculosTercero.filter((v) => unidadVigente(v.estado)).map((v) => ({
        clave: `t:${v.id}`, placa: v.placa || `#${v.id}`, categoria: v.categoria, marca: v.marca, modelo: v.modelo,
        esTercero: true, proveedor: v.empresa_id != null ? indices.emp.get(v.empresa_id) ?? null : null,
      })),
    ];
    return base.map((u) => {
      const posicion = posiciones.get(u.clave) ?? null;
      const servs = servicios.porUnidad.get(u.clave) ?? [];
      // Contrato de /api/monitoreo/flota: en `sin_leer`, o una unidad que el servidor no quiso leer
      // (no está en `unidades`: alta reciente, otra vigencia), NO se leyó — nunca es «sin posición».
      // La única evidencia que la rescata es el realtime: un punto que llegó DESPUÉS del cálculo.
      const leida = estadoPos === "listo" && meta.leidas.has(u.clave) && !meta.sinLeer.has(u.clave);
      const lecturaOk = leida || (realtime.get(u.clave) ?? 0) > meta.generadoMs;
      const veredicto = estadoPos === "cargando" ? null : juzgarUnidad({
        posicion, lecturaOk, servicios: servs, sosPendiente: sosPorUnidad.has(u.clave), ahoraMs: ahora, noInicioMin: meta.noInicioMin,
      });
      // El tipo del servicio que manda: el en curso; si no, el próximo de hoy.
      const manda = [...servs].sort((a, b) =>
        Number(b.estado === "en_curso") - Number(a.estado === "en_curso")
        || Number(b.fecha === hoy) - Number(a.fecha === hoy)
        || (a.inicioMs ?? Infinity) - (b.inicioMs ?? Infinity))[0];
      return {
        ...u,
        posicion,
        veredicto,
        conductor: conductorDe(posicion?.conductor ?? null),
        tipoServicio: manda ? (TIPOS_SERVICIO_FIJO.has(manda.tipo ?? "") ? "fijo" : "eventual") : null,
      };
    });
  }, [catalogos, posiciones, realtime, servicios, sosPorUnidad, estadoPos, meta, ahora, indices, conductorDe]);

  // Filtros que NO son la clase (los chips se cuentan con ellos puestos y sin el suyo).
  const terminos = useMemo(() => terminosBusqueda(busqueda), [busqueda]);
  const pasaOtros = useCallback((u: UnidadVista) => {
    if (filtroFlota === "propia" && u.esTercero) return false;
    if (filtroFlota === "tercero" && !u.esTercero) return false;
    if (filtroServicio !== "todos" && u.tipoServicio !== filtroServicio) return false;
    if (terminos.length) {
      const texto = [u.placa, u.marca, u.modelo, u.proveedor, u.conductor?.nombre, CAT_LABEL[catKey(u.categoria)]].filter(Boolean).join(" ");
      if (!coincideBusqueda(texto, terminos)) return false;
    }
    return true;
  }, [filtroFlota, filtroServicio, terminos]);

  const sinClase = useMemo(() => unidades.filter(pasaOtros), [unidades, pasaOtros]);
  const resumen = useMemo(
    () => (estadoPos === "cargando" ? null : resumenFlota(sinClase.flatMap((u) => (u.veredicto ? [u.veredicto] : [])))),
    [sinClase, estadoPos]);
  const lista = useMemo(() => {
    const l = filtroClase ? sinClase.filter((u) => u.veredicto?.clase === filtroClase) : sinClase;
    return [...l].sort((a, b) =>
      (b.veredicto?.prioridad ?? 0) - (a.veredicto?.prioridad ?? 0) || a.placa.localeCompare(b.placa, "es"));
  }, [sinClase, filtroClase]);

  const estacionadasVisibles = useMemo(() => lista.filter((u) => u.veredicto?.dibujar && u.veredicto.atenuado).length, [lista]);
  const conPosicion = useMemo(() => unidades.filter((u) => u.veredicto?.dibujar).length, [unidades]);

  /** Lo que se dibuja: la lista filtrada con posición, sin las grises si el interruptor está apagado
   *  (la seleccionada se ve siempre). */
  const enMapa = useMemo(() => lista.filter((u) =>
    u.veredicto?.dibujar && u.posicion && (mostrarEstacionadas || !u.veredicto.atenuado || u.clave === seleccion)),
  [lista, mostrarEstacionadas, seleccion]);

  const personasEnMapa = useMemo(() => {
    if (filtroClase || filtroServicio !== "todos") return [];
    return [...personas.values()].filter((p) => {
      if (ahora - p.ts > PERSONA_VIDA_MS) return false;
      if (filtroFlota === "propia" && p.clave.startsWith("t:")) return false;
      if (filtroFlota === "tercero" && p.clave.startsWith("p:")) return false;
      if (terminos.length && !coincideBusqueda(conductorDe(p.clave)?.nombre ?? "", terminos)) return false;
      return true;
    });
  }, [personas, ahora, filtroClase, filtroServicio, filtroFlota, terminos, conductorDe]);

  const sosPendientes = useMemo(() => alertasSOS.filter(esSosPendiente), [alertasSOS]);

  const placaDeUnidad = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of unidades) m.set(u.clave, u.placa);
    return m;
  }, [unidades]);

  // ══ MARCADORES: crear / actualizar solo lo que cambió ═════════════════════
  const asegurarMarcador = useCallback((clave: string, lngLat: [number, number], clase: string, html: string, z: string,
    popup: () => string, alAbrir?: () => void, alCerrar?: () => void) => {
    const m = mapa.current;
    if (!m) return;
    contenidoPopup.current.set(clave, popup);
    const reg = marcadores.current.get(clave);
    const destino = `${lngLat[0]},${lngLat[1]}`;
    if (!reg) {
      const el = document.createElement("div");
      el.className = clase;
      el.innerHTML = html;
      el.style.zIndex = z;
      const pop = new mapboxgl.Popup({ offset: 56, closeButton: true, maxWidth: "min(85vw, 280px)", focusAfterOpen: false });
      pop.on("open", () => {
        const h = contenidoPopup.current.get(clave)?.() ?? "";
        htmlPopupAbierto.current.set(clave, h);
        pop.setHTML(h);
        alAbrir?.();
      });
      pop.on("close", () => { htmlPopupAbierto.current.delete(clave); alCerrar?.(); });
      const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" }).setLngLat(lngLat).setPopup(pop).addTo(m);
      marcadores.current.set(clave, { m: marker, clase, html, z, destino });
      return;
    }
    const el = reg.m.getElement();
    if (reg.clase !== clase) { el.className = clase; reg.clase = clase; }
    if (reg.html !== html) { el.innerHTML = html; reg.html = html; }
    if (reg.z !== z) { el.style.zIndex = z; reg.z = z; }
    if (reg.destino !== destino) { reg.destino = destino; animarMarcador(reg.m, lngLat); }
    const pop = reg.m.getPopup();
    if (pop?.isOpen()) {
      const h = popup();
      if (htmlPopupAbierto.current.get(clave) !== h) { htmlPopupAbierto.current.set(clave, h); pop.setHTML(h); }
    }
  }, []);

  useEffect(() => {
    const m = mapa.current;
    if (!mapListo || !m) return;
    const quedan = new Set<string>();

    for (const u of enMapa) {
      const v = u.veredicto!, p = u.posicion!;
      const k = "u:" + u.clave;
      quedan.add(k);
      const sel = seleccion === u.clave;
      const edad = rotuloEdad(p.posicionTs, ahora);
      const momento = rotuloMomento(p.posicionTs, ahora);
      const html = htmlMarcadorUnidad({
        placa: u.placa, categoria: u.categoria, color: v.color, atenuado: v.atenuado,
        sos: v.codigo === "sos", tercero: u.esTercero, edad: v.atenuado ? edad : null,
      });
      const popup = () => htmlPopupUnidad({
        placa: u.placa,
        tipo: CAT_LABEL[catKey(u.categoria)],
        marcaModelo: [u.marca, u.modelo].filter(Boolean).join(" ") || null,
        proveedor: u.proveedor, tercero: u.esTercero,
        conductor: u.conductor?.nombre ?? null, telefono: u.conductor?.telefono ?? null,
        etiqueta: v.etiqueta, color: v.color, detalle: v.detalle,
        ultimaPosicion: (momento === edad ? edad : `${momento} · ${edad}`) + (p.aproximada ? " (aproximada)" : ""),
        velocidadKmh: v.codigo === "en_linea" ? p.velocidadKmh : null,
        sos: v.codigo === "sos",
      });
      asegurarMarcador(k, [p.lng, p.lat], claseMarcador(v.atenuado, sel), html, String(sel ? Z_SELECCIONADO : v.prioridad), popup,
        () => setSeleccion(u.clave),
        () => setSeleccion((s) => (s === u.clave ? null : s)));
    }

    for (const p of personasEnMapa) {
      const k = "c:" + p.clave;
      quedan.add(k);
      const enLinea = ahora - p.ts <= EN_LINEA_MIN * 60_000;
      const color = enLinea ? COLOR_CLASE.vivo : COLOR_CLASE.reposo;
      const c = conductorDe(p.clave);
      const nombre = (c?.nombre || "Conductor").trim();
      const edad = rotuloEdad(p.ts, ahora);
      const html = htmlMarcadorPersona(nombre.split(/\s+/)[0], color, !enLinea, edad);
      const popup = () => htmlPopupPersona({
        nombre, color, telefono: c?.telefono ?? null,
        estado: enLinea ? "En línea" : "Sin posición nueva",
        ultimaPosicion: `${rotuloMomento(p.ts, ahora)} · ${edad}`,
      });
      asegurarMarcador(k, [p.lng, p.lat], claseMarcador(!enLinea, false), html, String(enLinea ? 30_000_000 : 10_000_000), popup);
    }

    for (const a of sosPendientes) {
      const lat = num(a.lat), lng = num(a.lng);
      if (lat == null || lng == null || (lat === 0 && lng === 0)) continue;
      const k = "s:" + a.id;
      quedan.add(k);
      const placa = a.reserva_id != null ? placaDeUnidad.get(servicios.unidadDeReserva.get(a.reserva_id) ?? "") ?? null : null;
      const popup = () => htmlPopupSos({
        motivo: a.motivo, reservaId: a.reserva_id, placa,
        hora: rotuloMomento(Date.parse(a.created_at), ahora),
      });
      asegurarMarcador(k, [lng, lat], "afa-mk", `<div class="afa-sos-pin">⚠</div>`, String(Z_ALERTA_SOS), popup);
    }

    for (const [k, reg] of marcadores.current) {
      if (quedan.has(k)) continue;
      reg.m.remove();
      marcadores.current.delete(k);
      contenidoPopup.current.delete(k);
      htmlPopupAbierto.current.delete(k);
    }

    // Centrar lo que se eligió en la lista (ahora que su marcador seguro existe).
    const pendiente = abrirPendiente.current;
    if (pendiente) {
      abrirPendiente.current = null;
      const reg = marcadores.current.get(pendiente);
      if (reg) {
        for (const [k, r] of marcadores.current) if (k !== pendiente && r.m.getPopup()?.isOpen()) r.m.getPopup()?.remove();
        m.flyTo({ center: reg.m.getLngLat(), zoom: Math.max(m.getZoom(), 15), duration: 900 });
        if (!reg.m.getPopup()?.isOpen()) reg.m.togglePopup();
      }
    }
  }, [mapListo, enMapa, personasEnMapa, sosPendientes, seleccion, ahora, asegurarMarcador, conductorDe, placaDeUnidad, servicios]);

  // Primera vez que hay posiciones: encuadrar la flota (sin ninguna, se queda en Lima).
  useEffect(() => {
    const m = mapa.current;
    if (!mapListo || !m || ajustado.current || estadoPos !== "listo" || !catalogos) return;
    ajustado.current = true;
    const puntos = unidades.filter((u) => u.veredicto?.dibujar && u.posicion).map((u) => [u.posicion!.lng, u.posicion!.lat] as [number, number]);
    if (!puntos.length) return;
    if (puntos.length === 1) { m.jumpTo({ center: puntos[0], zoom: 14 }); return; }
    const b = new mapboxgl.LngLatBounds(puntos[0], puntos[0]);
    for (const p of puntos) b.extend(p);
    const celular = window.matchMedia("(max-width: 767px)").matches;
    m.fitBounds(b, { padding: celular ? 48 : 80, maxZoom: 14, duration: 0 });
  }, [mapListo, estadoPos, unidades, catalogos]);

  // ══ ELEGIR una unidad (lista → mapa) ══════════════════════════════════════
  const elegir = (clave: string) => {
    abrirPendiente.current = "u:" + clave;
    setSeleccion(clave);
    setVistaMovil("mapa");
  };
  const verAlertaEnMapa = (a: AlertaSOS) => {
    const reg = marcadores.current.get("s:" + a.id);
    const m = mapa.current;
    if (!reg || !m) return;
    setVistaMovil("mapa");
    setPanelSOS(false);
    m.flyTo({ center: reg.m.getLngLat(), zoom: Math.max(m.getZoom(), 15), duration: 900 });
    if (!reg.m.getPopup()?.isOpen()) reg.m.togglePopup();
  };
  // Con el panel abierto en escritorio, una selección hecha en el MAPA lleva la lista a su tarjeta.
  useEffect(() => {
    if (!seleccion) return;
    const tarjeta = document.querySelector(`[data-unidad="${CSS.escape(seleccion)}"]`);
    tarjeta?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [seleccion]);

  // ══ TEXTOS DE ESTADO ══════════════════════════════════════════════════════
  const otrosFiltros = filtroClase != null || filtroFlota !== "todos" || filtroServicio !== "todos";
  const vacioLista = !catalogos
    ? (errorCatalogos ?? "Cargando la flota…")
    : busqueda.trim()
      ? `Ninguna unidad coincide con «${busqueda.trim()}»${otrosFiltros ? " con los filtros puestos" : ""}`
      : otrosFiltros ? "Ninguna unidad con estos filtros" : "No hay unidades vigentes en la flota";
  // Unidades de la lista que no se pudieron leer (en `sin_leer` o fuera de lo que el servidor leyó).
  const noLeidas = useMemo(() => unidades.filter((u) => u.veredicto?.codigo === "no_se_pudo_leer").length, [unidades]);
  const avisosLectura: string[] = [];
  if (estadoPos === "listo" && noLeidas > 0) {
    avisosLectura.push(
      `${noLeidas} unidad${noLeidas === 1 ? "" : "es"} no se ${noLeidas === 1 ? "pudo" : "pudieron"} leer en la última actualización` +
      (meta.parcial ? " (se acabó el tiempo de lectura)" : "") +
      ": figura" + (noLeidas === 1 ? "" : "n") + " como «No se pudo leer» y se reintenta en el próximo minuto.");
  } else if (estadoPos === "listo" && meta.parcial) {
    avisosLectura.push("La lectura de posiciones quedó a medias (se acabó el tiempo). Se reintenta en el próximo minuto.");
  }
  const columnasGps = meta.columnas.filter((c) => !c.includes("."));
  const columnasFlota = meta.columnas.filter((c) => c.includes("."));
  const textoCanal = canal === "vivo" ? "En vivo" : canal === "reconectando" ? "Reconectando…" : "Conectando…";
  const colorCanal = canal === "vivo" ? "#22c55e" : "#f59e0b";
  const ningunaConPosicion = estadoPos === "listo" && conPosicion === 0 && personas.size === 0;
  const nadaVisible = estadoPos === "listo" && !ningunaConPosicion && enMapa.length === 0 && personasEnMapa.length === 0;

  const segmentado = <T extends string>(valor: T, opciones: readonly [T, string][], cambiar: (v: T) => void, etiqueta: string) => (
    <div role="group" aria-label={etiqueta} className="flex gap-1 rounded-xl p-1 bg-slate-800">
      {opciones.map(([v, texto]) => (
        <button key={v} type="button" aria-pressed={valor === v} onClick={() => cambiar(v)}
          className="flex-1 min-h-11 md:min-h-8 px-2 rounded-lg text-xs md:text-[11px] font-bold transition-colors"
          style={{ background: valor === v ? "#0b315f" : "transparent", color: valor === v ? "white" : "#94a3b8" }}>
          {texto}
        </button>
      ))}
    </div>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#0f172a]">

      {/* ── CABECERA ─────────────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-center justify-between gap-2 px-3 md:px-4 py-2 md:py-3 border-b bg-[#0b315f] border-[#1e3a5f]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="hidden sm:flex w-9 h-9 rounded-xl items-center justify-center shrink-0 bg-[#0c2647]">
            <IconCrosshair size={20} color="#7dd3fc" />
          </div>
          <div className="min-w-0">
            <h1 className="text-white font-black leading-tight text-[15px] md:text-base truncate">Monitoreo GPS</h1>
            <p className="text-blue-200 text-[11px] md:text-xs flex items-center gap-1.5 min-w-0">
              <span className="inline-flex items-center gap-1 shrink-0" title="Conexión en tiempo real con las posiciones">
                <span className={"w-2 h-2 rounded-full" + (canal === "vivo" ? " animate-pulse" : "")} style={{ background: colorCanal }} />
                {textoCanal}
              </span>
              <span className="truncate">
                {ultimaOk ? `· Actualizado ${horaLima(ultimaOk)}` : estadoPos === "cargando" ? "· Cargando posiciones…" : ""}
              </span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
          {sosPendientes.length > 0 && (
            <button type="button" onClick={() => setPanelSOS((v) => !v)}
              className="min-h-11 md:min-h-9 px-3 rounded-lg font-black text-xs bg-red-600 text-white animate-pulse">
              ⚠ SOS {sosPendientes.length}
            </button>
          )}
          <button type="button" onClick={() => void actualizarTodo()} title="Actualizar ahora" aria-label="Actualizar ahora"
            className="w-11 h-11 md:w-9 md:h-9 flex items-center justify-center rounded-lg border border-blue-400/60 hover:bg-blue-500/20 transition-colors">
            <span className={actualizando ? "animate-spin" : ""} style={{ display: "inline-flex" }}><IconRefresh size={16} color="#dbeafe" /></span>
          </button>
          <a href="/conductor" target="_blank" rel="noopener"
            className="hidden sm:inline-flex items-center min-h-9 px-3 rounded-lg text-xs font-bold bg-green-600 text-white">
            App
          </a>
        </div>
      </header>

      {/* ── CELULAR: Mapa | Lista y chips (en escritorio los chips van en el panel) ── */}
      <div className="md:hidden shrink-0 bg-[#0f172a] border-b border-slate-800">
        <div className="px-3 pt-2">
          {segmentado(vistaMovil, [["mapa", "Mapa"], ["lista", `Lista (${lista.length})`]] as const, setVistaMovil, "Ver mapa o lista")}
        </div>
        <ChipsEstado resumen={resumen} filtro={filtroClase} onFiltro={setFiltroClase} variante="fila" />
      </div>

      {/* ── AVISOS DE LECTURA (todas las vistas) ─────────────────────────── */}
      {(errorPos || avisosLectura.length > 0 || errorCatalogos) && (
        <div className="shrink-0 px-3 py-1.5 space-y-1 border-b border-slate-800 bg-[#111827] text-[11.5px] leading-snug">
          {errorPos && (errorPos.tipo === "permiso" || errorPos.tipo === "sesion") && (
            <p className="text-red-300 font-semibold">⛔ {errorPos.texto}</p>
          )}
          {errorPos && (errorPos.tipo === "red" || errorPos.tipo === "servidor") && (
            <p className="text-amber-300 font-semibold">
              ⚠ No se pudo actualizar ({errorPos.texto.toLowerCase()})
              {ultimaOk ? ` · mostrando datos de ${rotuloEdad(ultimaOk, ahora)}` : " · todavía no hay posiciones para mostrar"}. Se reintenta cada minuto.
            </p>
          )}
          {errorCatalogos && <p className="text-amber-300">⚠ {errorCatalogos}</p>}
          {avisosLectura.map((t) => <p key={t} className="text-amber-200/80">{t}</p>)}
        </div>
      )}

      {/* ── CUERPO: panel + mapa ─────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative md:flex">

        {/* PANEL: en escritorio, columna fija con scroll propio; en celular, capa SOBRE el mapa
            (el mapa nunca se oculta con display:none: Mapbox se iniciaría en 0×0). */}
        <section
          aria-label="Unidades de la flota"
          className={(vistaMovil === "lista" ? "flex" : "hidden") +
            " md:flex flex-col absolute inset-0 z-20 md:static md:z-auto md:w-80 md:shrink-0 md:border-r border-slate-800 bg-[#0f172a]"}
        >
          <div className="hidden md:block px-3 pt-3 pb-2 border-b border-slate-800">
            <ChipsEstado resumen={resumen} filtro={filtroClase} onFiltro={setFiltroClase} variante="panel" />
          </div>

          <div className="shrink-0 px-3 pt-3 space-y-2">
            <label className="flex items-center gap-2 rounded-xl px-3 min-h-11 md:min-h-9 bg-slate-800">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#64748b" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Placa, marca, proveedor o conductor…"
                aria-label="Buscar unidad"
                className="bg-transparent outline-none text-[16px] md:text-xs text-white placeholder-slate-500 flex-1 min-w-0"
              />
              {busqueda && (
                <button type="button" onClick={() => setBusqueda("")} className="w-8 h-8 -mr-1 text-slate-400 text-sm" aria-label="Borrar búsqueda">✕</button>
              )}
            </label>
            {segmentado(filtroFlota, [["todos", "Toda la flota"], ["propia", "Propia"], ["tercero", "Tercerizada"]] as const, setFiltroFlota, "Flota")}
            {segmentado(filtroServicio, [["todos", "Todos"], ["fijo", "Fijos"], ["eventual", "Eventuales"]] as const, setFiltroServicio, "Tipo de servicio")}
            <button
              type="button"
              role="switch"
              aria-checked={mostrarEstacionadas}
              onClick={() => setMostrarEstacionadas(!mostrarEstacionadas)}
              className="w-full flex items-center justify-between gap-2 min-h-11 md:min-h-9 px-3 rounded-xl bg-slate-800 text-left"
              title="Muestra u oculta en el MAPA las unidades grises (sin servicio en curso). La lista las sigue mostrando."
            >
              <span className="text-xs font-bold text-slate-300">
                Estacionadas en el mapa <span className="text-slate-500 font-semibold">({resumen ? estacionadasVisibles : "…"})</span>
              </span>
              <span className={"relative w-9 h-5 rounded-full transition-colors shrink-0 " + (mostrarEstacionadas ? "bg-slate-400" : "bg-slate-600")}>
                <span className={"absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all " + (mostrarEstacionadas ? "left-[18px]" : "left-0.5")} />
              </span>
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-2 pt-2 pb-28 md:pb-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 px-2 py-1">
              {catalogos
                ? `${lista.length} unidad${lista.length === 1 ? "" : "es"}` + (resumen ? ` · ${lista.filter((u) => u.veredicto?.dibujar).length} con posición` : " · comprobando posiciones…")
                : "Cargando la flota…"}
            </p>
            {catalogos && (
              <ListaUnidades unidades={lista} seleccion={seleccion} onElegir={elegir} vacio={vacioLista} />
            )}
            {personasEnMapa.length > 0 && (
              <p className="text-[10.5px] text-slate-500 px-2 pt-2">
                Además, {personasEnMapa.length} conductor{personasEnMapa.length === 1 ? "" : "es"} conectado{personasEnMapa.length === 1 ? "" : "s"} sin unidad asignada (solo en el mapa).
              </p>
            )}
            {columnasGps.length > 0 && (
              <p className="text-[10.5px] text-slate-500 px-2 pt-2 leading-snug">
                La base no tiene {columnasGps.join(", ")} en ubicaciones_gps: la edad de la posición se mide con menos datos
                {columnasGps.some((c) => SQL_COLUMNA[c]) ? ` (falta correr ${columnasGps.filter((c) => SQL_COLUMNA[c]).map((c) => SQL_COLUMNA[c]).join(", ")})` : ""}.
              </p>
            )}
            {columnasFlota.length > 0 && (
              <p className="text-[10.5px] text-slate-500 px-2 pt-2 leading-snug">
                La base no tiene {columnasFlota.join(", ")}: todas esas unidades cuentan como vigentes.
              </p>
            )}
          </div>
        </section>

        {/* MAPA */}
        <div className="absolute inset-0 md:relative md:inset-auto md:flex-1 md:min-w-0">
          {/* isolate: los marcadores llevan z-index de millones (su prioridad) y no pueden tapar
              la leyenda, los avisos ni el panel, que viven fuera de este contexto de apilamiento. */}
          <div ref={contenedorMapa} className="afa-mon w-full h-full isolate" />

          <LeyendaMapa abierta={leyenda} onAbierta={setLeyenda} />

          {mapaBaseFallo && (
            <div className="absolute top-2 left-2 z-10 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-amber-200 bg-slate-900/90 border border-amber-700/60 max-w-[80%]">
              No cargó el mapa base: las unidades se ubican igual sobre el fondo vacío.
            </div>
          )}

          {estadoPos === "cargando" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
              <div className="rounded-2xl px-5 py-4 text-center bg-slate-900/90">
                <p className="text-white font-bold text-sm">Cargando posiciones…</p>
              </div>
            </div>
          )}
          {ningunaConPosicion && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none px-6">
              <div className="rounded-2xl px-6 py-5 text-center bg-slate-900/90 max-w-sm">
                <p className="text-white font-bold">Ninguna unidad tiene posición GPS en los últimos {DIAS_ULTIMA_POSICION} días</p>
                <p className="text-slate-400 text-sm mt-1">La posición la manda la app del conductor mientras tiene un servicio iniciado.</p>
              </div>
            </div>
          )}
          {nadaVisible && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 rounded-full px-3 py-1.5 text-[11.5px] font-semibold text-slate-200 bg-slate-900/90 whitespace-nowrap">
              {!mostrarEstacionadas && estacionadasVisibles > 0 ? "Solo hay estacionadas y están ocultas" : "Ninguna unidad con posición pasa los filtros"}
            </div>
          )}
        </div>

        {/* PANEL SOS (encima de todo, en las dos vistas) */}
        {panelSOS && alertasSOS.length > 0 && (
          <div className="absolute top-2 right-2 left-2 md:left-auto md:w-96 z-30 max-h-[75%] flex flex-col rounded-xl overflow-hidden border border-red-900 shadow-2xl bg-[#111827]">
            <div className="px-3 py-2 flex items-center justify-between bg-[#1c0202]">
              <p className="text-red-400 font-black text-xs uppercase tracking-widest">Alertas SOS</p>
              <button type="button" onClick={() => setPanelSOS(false)} className="w-9 h-9 -mr-1 text-slate-400 text-sm" aria-label="Cerrar alertas SOS">✕</button>
            </div>
            <div className="overflow-y-auto">
              {alertasSOS.map((a) => {
                const pendiente = esSosPendiente(a);
                const placa = a.reserva_id != null ? placaDeUnidad.get(servicios.unidadDeReserva.get(a.reserva_id) ?? "") : null;
                const conPos = num(a.lat) != null && num(a.lng) != null;
                return (
                  <div key={a.id} className="px-3 py-2.5 border-b border-slate-800" style={{ background: pendiente ? "#1c0202" : "#111827" }}>
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-black" style={{ color: pendiente ? "#f87171" : "#64748b" }}>
                          {pendiente ? "PENDIENTE" : "Atendido"}{placa ? ` · ${placa}` : ""}
                        </p>
                        <p className="text-[11.5px] text-slate-300 mt-0.5 break-words">{a.motivo || "Alerta SOS"}</p>
                        <p className="text-[10.5px] text-slate-500">
                          {a.reserva_id ? `Reserva #${a.reserva_id} · ` : ""}{rotuloMomento(Date.parse(a.created_at), ahora)}
                        </p>
                      </div>
                      {pendiente && (
                        <div className="flex flex-col gap-1 shrink-0">
                          <button type="button" onClick={() => atenderSOS(a.id)} className="min-h-11 md:min-h-8 px-2.5 rounded-lg text-[11px] font-bold text-white bg-green-800">
                            Atendido
                          </button>
                          {conPos && (
                            <button type="button" onClick={() => verAlertaEnMapa(a)} className="min-h-11 md:min-h-8 px-2.5 rounded-lg text-[11px] font-bold text-red-200 border border-red-800">
                              Ver en mapa
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
