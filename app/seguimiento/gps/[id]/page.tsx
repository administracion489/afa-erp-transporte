"use client";
// app/seguimiento/gps/[id]/page.tsx — «Ver recorrido» de UN servicio: la traza GPS REAL sobre Mapbox,
// con los excesos de velocidad en ROJO y el panel que los lista. La abren /seguridad-vial (cada fila
// de exceso, enfocando el suyo con ?inicio=) y /uso-flota → Servicios.
//
// Lo que había antes: Google Maps con la RUTA PLANEADA entre paraderos y «TERMINA EN N MIN con
// tráfico actual · EN VIVO» aunque el servicio hubiera terminado días atrás. No dibujaba ni una
// posición GPS, así que no podía marcar dónde fue el exceso, y cada apertura costaba una carga de
// Maps JavaScript y una consulta de Directions con tráfico. Ahora no se le consulta nada a Google: la
// traza y los episodios salen de /api/seguimiento/recorrido (lib/flota/recorrido.ts), con el mismo
// motor que la columna «Excesos» de /uso-flota.
//
// La segunda corrección (reportada por el dueño): el mapa pintaba la traza de un solo azul y los
// huecos como rectas grises que cruzaban manzanas. Ahora dibuja lo mismo que el modal GPS de
// /seguimiento —la huella por velocidad, los tramos estimados sobre la ruta prevista ya guardada y
// los datos por punto— y el «sin señal» es EXACTAMENTE el de la celda RASTREO, marcado solo en sus
// dos extremos. El bloque RASTREO pinta el veredicto de la torre con su chip, su banda y su frase.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { idAfa } from "@/lib/folio";
import { etiquetaEstado, normalizaEstado } from "@/lib/estados";
import { cabecerasErp } from "@/lib/fetch-erp";
import { leerUmbral, UMBRALES_ACEPTADOS, UMBRAL_DEFECTO_KMH } from "@/lib/flota/excesos";
import { episodioEnfocado, leerInicio, urlRecorrido } from "@/lib/flota/recorrido-url";
import type { RecorridoServicio, EpisodioMapa, TramoSinSenal, CodigoRutaPrevista } from "@/lib/flota/recorrido";
import { bandaCobertura, type CodigoRastreo } from "@/lib/gps-cobertura";
import MapaRecorrido, { horaLima, duracionTramo, movimientoTramo, COLOR_EXCESO, COLOR_SIN_SENAL, type FocoSinSenal } from "@/components/seguimiento/MapaRecorrido";
import { TIPO_TRAMO } from "@/components/seguimiento/ModalDiagnosticoRastreo";

// ── TIPOS ──────────────────────────────────────────────────────────────────────

type Parada = {
  id: number; orden: number; nombre: string; direccion: string | null;
  lat: number | null; lng: number | null; hora_estimada: string | null; estado: string;
};

type DatosServicio = {
  id: number;
  codigo?: string | null;
  cliente_nombre: string;
  vehiculo_placa: string;
  vehiculo_tipo: string;
  conductor_nombre: string;
  conductor_tel: string;
  hora_servicio: string | null;
  fecha_servicio: string | null;
  origen: string | null;
  destino: string | null;
  estado: string;
  paradas: Parada[];
};

type EstadoRecorrido = { cargando: boolean; error: string | null; data: RecorridoServicio | null };

// Las bandas medidas del veredicto: con ellas se pinta además el rótulo de la banda, como en el
// diagnóstico del rastreo (ModalDiagnosticoRastreo). La celda de la torre no lo lleva por espacio.
const CODIGOS_BANDA: CodigoRastreo[] = ["completo", "aceptable", "con_cortes", "incompleto"];
// Códigos sin %: la torre los pinta en gris, sin chip.
const SIN_CHIP: CodigoRastreo[] = ["no_aplica", "recien_iniciado", "sin_medir"];

/** La línea del estado de la ruta prevista: por CÓDIGO, nunca olfateando el detalle. */
function textoRutaPrevista(codigo: CodigoRutaPrevista, detalle: string): string {
  if (codigo === "guardada") return "Tramos estimados sobre la ruta prevista guardada.";
  if (codigo === "no_guardada") return "La ruta prevista no está guardada: ábrela una vez en el modal GPS para guardarla.";
  return detalle;
}

const metrosTxt = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const plural = (n: number, uno: string, varios: string) => `${n.toLocaleString("es-PE")} ${n === 1 ? uno : varios}`;

// Etiqueta canónica única (lib/estados).
function fmtEstado(e: string) {
  return etiquetaEstado(normalizaEstado(e));
}

function fmtFecha(f: string | null): string {
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return f ?? "";
  const [a, m, d] = f.split("-");
  return `${d}/${m}/${a}`;
}

// ── COMPONENTE PRINCIPAL ───────────────────────────────────────────────────────

export default function GpsServicioPage() {
  const params  = useParams();
  const reservaId = Number(params.id);

  const [datos,          setDatos]          = useState<DatosServicio | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [ultimaActualiz, setUltimaActualiz] = useState(new Date());
  const [umbral,         setUmbral]         = useState<number | null>(null);
  const [inicioPedido,   setInicioPedido]   = useState<number | null>(null);
  const [enfocado,       setEnfocado]       = useState<number | null>(null);
  const [verDescartados, setVerDescartados] = useState(false);
  const [focoSinSenal,   setFocoSinSenal]   = useState<FocoSinSenal | null>(null);
  const [rec,            setRec]            = useState<EstadoRecorrido>({ cargando: true, error: null, data: null });
  const pedido = useRef(0);

  // El umbral y el episodio a enfocar llegan en la URL (lib/flota/recorrido-url.ts).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const u = leerUmbral((sp.get("umbral") ?? "").trim());
    setUmbral(u.ok ? u.umbral : UMBRAL_DEFECTO_KMH);
    setInicioPedido(leerInicio(sp.get("inicio")));
  }, []);

  // ── Datos del servicio ─────────────────────────────────────────────────────

  const cargarDatos = useCallback(async () => {
    const [rRes, parRes] = await Promise.all([
      supabase.from("reservas")
        .select("id,codigo,hora_servicio,fecha_servicio,estado,origen,destino,vehiculo_id,conductor_id,empresa_tercerizada_id,vehiculo_tercero_id,tipo,cliente_id")
        .eq("id", reservaId).single(),
      supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden"),
    ]);

    if (rRes.error || !rRes.data) { setLoading(false); return; }
    const r = rRes.data;
    const esTer = r.tipo === "tercerizada";

    const [clRes, vRes, cRes, etRes, vtRes] = await Promise.all([
      r.cliente_id            ? supabase.from("clientes").select("nombre,empresa").eq("id", r.cliente_id).single()                            : Promise.resolve({ data: null }),
      !esTer && r.vehiculo_id ? supabase.from("vehiculos").select("placa,categoria").eq("id", r.vehiculo_id).single()                         : Promise.resolve({ data: null }),
      !esTer && r.conductor_id? supabase.from("conductores").select("nombre,telefono").eq("id", r.conductor_id).single()                      : Promise.resolve({ data: null }),
      esTer && r.empresa_tercerizada_id ? supabase.from("empresas_tercerizadas").select("razon_social,telefono").eq("id", r.empresa_tercerizada_id).single() : Promise.resolve({ data: null }),
      esTer && r.vehiculo_tercero_id    ? supabase.from("vehiculos_tercero").select("placa,categoria").eq("id", r.vehiculo_tercero_id).single()             : Promise.resolve({ data: null }),
    ]);

    const cl = clRes.data as any;
    const v  = (esTer ? vtRes.data : vRes.data) as any;
    const c  = cRes.data as any;
    const et = etRes.data as any;

    setDatos({
      id:               r.id,
      codigo:           r.codigo,
      cliente_nombre:   cl?.empresa || cl?.nombre || "Sin cliente",
      vehiculo_placa:   v?.placa    || "—",
      vehiculo_tipo:    v?.categoria || "Bus",
      conductor_nombre: esTer ? (et?.razon_social || "Empresa tercera") : (c?.nombre || "—"),
      conductor_tel:    esTer ? (et?.telefono || "") : (c?.telefono || ""),
      hora_servicio:    r.hora_servicio,
      fecha_servicio:   r.fecha_servicio,
      origen:           r.origen,
      destino:          r.destino,
      estado:           r.estado,
      paradas:          (parRes.data as Parada[]) || [],
    });
    setLoading(false);
    setUltimaActualiz(new Date());
  }, [reservaId]);

  useEffect(() => { cargarDatos(); }, [cargarDatos]);

  // ── El recorrido (traza + excesos) ─────────────────────────────────────────

  const cargarRecorrido = useCallback(async (u: number, silencioso = false) => {
    const n = ++pedido.current;
    if (!silencioso) setRec((x) => ({ ...x, cargando: true, error: null }));
    try {
      const res = await fetch(`/api/seguimiento/recorrido?reserva=${reservaId}&umbral=${u}`, { headers: await cabecerasErp(), cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (n !== pedido.current) return;
      if (!res.ok) {
        const error = res.status === 401 || res.status === 403
          ? "Te falta el permiso de Seguimiento, Monitoreo o Vehículos para ver el recorrido."
          : (j && typeof j.error === "string" ? j.error : `No se pudo leer el recorrido (error ${res.status}).`);
        setRec((x) => ({ cargando: false, error, data: silencioso ? x.data : null }));
        return;
      }
      setRec({ cargando: false, error: null, data: j as RecorridoServicio });
    } catch {
      if (n !== pedido.current) return;
      setRec((x) => ({ cargando: false, error: "No se pudo conectar con el servidor. Revisa la conexión y reintenta.", data: silencioso ? x.data : null }));
    }
  }, [reservaId]);

  useEffect(() => { if (umbral != null) cargarRecorrido(umbral); }, [umbral, cargarRecorrido]);

  // Un servicio EN CURSO se refresca cada 60 s; uno terminado no cambia y no se vuelve a pedir.
  const enCurso = datos ? normalizaEstado(datos.estado) === "en_curso" : false;
  useEffect(() => {
    if (!enCurso || umbral == null) return;
    const id = setInterval(() => { cargarDatos(); cargarRecorrido(umbral, true); }, 60000);
    return () => clearInterval(id);
  }, [enCurso, umbral, cargarDatos, cargarRecorrido]);

  // El episodio pedido en la URL se enfoca una vez, cuando llega el recorrido.
  const focoAplicado = useRef(false);
  const eps = rec.data?.episodios ?? [];
  const pedidoNoEsta = inicioPedido != null && !!rec.data && !episodioEnfocado(eps, inicioPedido);
  useEffect(() => {
    if (focoAplicado.current || inicioPedido == null || !rec.data) return;
    focoAplicado.current = true;
    const ep = episodioEnfocado(rec.data.episodios, inicioPedido);
    if (ep) setEnfocado(ep.inicioTs);
  }, [inicioPedido, rec.data]);

  // Cambiar el umbral cambia los episodios: el foco viejo ya no apunta a nada.
  const cambiarUmbral = (u: number) => {
    setEnfocado(null);
    setFocoSinSenal(null);
    setUmbral(u);
    window.history.replaceState(null, "", urlRecorrido(reservaId, { umbral: u }));
  };

  const paradasMapa = useMemo(() => (datos?.paradas ?? []).map((p) => ({
    id: p.id, nombre: p.nombre, estado: p.estado,
    lat: p.lat == null ? null : Number(p.lat), lng: p.lng == null ? null : Number(p.lng),
  })), [datos?.paradas]);

  // ── RENDER ─────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="h-screen flex items-center justify-center bg-[#0b1a2e]">
      <div className="text-center">
        <div className="w-10 h-10 border-2 border-blue-800 border-t-blue-400 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-blue-300 font-bold">Cargando recorrido...</p>
      </div>
    </div>
  );

  if (!datos) return (
    <div className="h-screen flex items-center justify-center bg-[#0b1a2e]">
      <div className="text-center text-white">
        <p className="text-4xl mb-3">🔍</p>
        <p className="font-bold">Reserva #{reservaId} no encontrada</p>
        <Link href="/seguimiento" className="mt-4 inline-block text-blue-400 font-bold text-sm underline">← Volver a Seguimiento</Link>
      </div>
    </div>
  );

  const paradasComp = datos.paradas.filter(p => p.estado === "completada").length;
  const pct         = datos.paradas.length > 0 ? Math.round((paradasComp / datos.paradas.length) * 100) : 0;
  const r           = rec.data;
  const cuentan     = eps.filter((e) => e.cuenta);
  const descartados = eps.filter((e) => !e.cuenta);
  const sinSenal: TramoSinSenal[] = r?.sinSenal ?? [];
  const vered       = r?.rastreo ?? null;
  const epsDecimados = r?.episodiosCoordsDecimadas === true;
  const puntosVistos = r?.puntos?.length ?? 0;
  const notasDibujo: string[] = [];
  if (r) {
    if (r.medidoDecimado) notasDibujo.push("huella simplificada para dibujarla");
    if (r.medidoOmitidos > 0) notasDibujo.push(`${plural(r.medidoOmitidos, "tramo medido corto", "tramos medidos cortos")} sin dibujar`);
    if (r.estimadosDecimados) notasDibujo.push("tramos estimados simplificados");
    if (r.estimadosOmitidos > 0) notasDibujo.push(`${plural(r.estimadosOmitidos, "tramo estimado corto", "tramos estimados cortos")} sin dibujar`);
    // Los tramos «sin señal» omitidos se dicen junto a su lista (r.sinSenalTotal > sinSenal.length).
    if (r.puntosTotal > puntosVistos) notasDibujo.push(`datos por punto: se muestran ${puntosVistos.toLocaleString("es-PE")} de ${r.puntosTotal.toLocaleString("es-PE")}`);
    if (epsDecimados) notasDibujo.push("posiciones de los excesos muestreadas para dibujarlas");
    if ((r.episodiosDescartadosOmitidos ?? 0) > 0) notasDibujo.push(`${plural(r.episodiosDescartadosOmitidos, "exceso descartado no se lista", "excesos descartados no se listan")}`);
  }

  return (
    <div className="h-screen flex flex-col bg-[#0b1a2e] overflow-hidden">

      {/* ── HEADER ───────────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-[#0b315f] px-4 py-3 shadow-lg">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/seguimiento"
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors flex-shrink-0">
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </Link>
            <div className="min-w-0">
              <p className="text-white font-black text-sm truncate">{datos.cliente_nombre}</p>
              <p className="text-blue-200 text-[11px]">
                Reserva {idAfa(datos)} · {fmtFecha(datos.fecha_servicio)} {datos.hora_servicio?.slice(0,5)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {enCurso ? (
              <div className="flex items-center gap-1.5 bg-white/10 px-3 py-1.5 rounded-lg">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-white text-[11px] font-bold">EN VIVO · se actualiza cada 60 s</span>
              </div>
            ) : (
              <div className="bg-white/10 px-3 py-1.5 rounded-lg">
                <span className="text-white text-[11px] font-bold">Recorrido del {fmtFecha(datos.fecha_servicio)} · {fmtEstado(datos.estado)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── CUERPO ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">

        {/* MAPA */}
        <div className="flex-1 relative min-h-[50vh] md:min-h-0">
          <MapaRecorrido
            recorrido={r}
            paradas={paradasMapa}
            enfocado={enfocado}
            focoSinSenal={focoSinSenal}
            mostrarDescartados={verDescartados}
            onElegir={setEnfocado}
          />

          {rec.cargando && (
            <div className="absolute top-3 right-14 bg-white/95 rounded-xl shadow px-3 py-2 text-xs text-gray-600">Leyendo el recorrido…</div>
          )}
          {!rec.cargando && r && r.posiciones === 0 && r.excesos.codigo !== "no_aplica" && (
            <div className="absolute inset-x-4 bottom-4 md:bottom-auto md:top-16 mx-auto w-fit max-w-md bg-white/95 rounded-xl shadow px-4 py-2 text-xs text-gray-700">
              {/* Sin medir: la traza no se pudo leer, y eso NO es «no llegaron posiciones». */}
              {r.rastreo?.codigo === "sin_medir"
                ? (r.rastreo.detalle || "No se pudo leer el GPS de este servicio: no se afirma que no haya posiciones.")
                : "No llegaron posiciones GPS con coordenadas para este servicio."}
            </div>
          )}

          {/* Overlay itinerario sobre el mapa */}
          <div className="absolute bottom-4 left-4 w-72 hidden md:block">
            <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Itinerario</p>
                <p className="text-[10px] font-bold text-[#0b315f]">{paradasComp}/{datos.paradas.length} paradas</p>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-3">
                <div className="h-full rounded-full bg-[#0b315f] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {datos.paradas.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-2 text-xs">
                    <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black flex-shrink-0
                      ${p.estado === "completada" ? "bg-green-500 text-white"
                      : i === 0 ? "bg-[#0b315f] text-white"
                      : i === datos.paradas.length - 1 ? "bg-red-500 text-white"
                      : "bg-gray-100 text-gray-500"}`}>
                      {p.estado === "completada" ? "✓" : i + 1}
                    </div>
                    <span className={`flex-1 truncate font-medium
                      ${p.estado === "completada" ? "text-green-600 line-through" : "text-gray-700"}`}>
                      {p.nombre}
                    </span>
                    {p.hora_estimada && (
                      <span className="text-gray-400 font-mono text-[10px]">{p.hora_estimada.slice(0,5)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* PANEL DERECHO */}
        <div className="md:w-80 flex-shrink-0 bg-[#0d1f35] overflow-y-auto p-4 space-y-3">

          {/* Excesos de velocidad */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400">Excesos de velocidad</p>
              {umbral != null && (
                <label className="text-[10px] text-blue-300 flex items-center gap-1">
                  Umbral
                  <select value={umbral} onChange={(e) => cambiarUmbral(Number(e.target.value))}
                    className="bg-[#0b315f] text-white text-[11px] font-bold rounded-md px-1.5 py-0.5 border border-blue-800">
                    {UMBRALES_ACEPTADOS.map((u) => <option key={u} value={u}>{u} km/h</option>)}
                  </select>
                </label>
              )}
            </div>

            {rec.cargando && !r && <p className="text-blue-300 text-xs">Midiendo…</p>}
            {rec.error && (
              <div className="text-xs text-amber-300">
                <p>{rec.error}</p>
                {umbral != null && (
                  <button type="button" onClick={() => cargarRecorrido(umbral)}
                    className="mt-2 rounded-lg bg-[#0b315f] px-3 py-1.5 text-[11px] font-bold text-white">Reintentar</button>
                )}
              </div>
            )}

            {r && r.excesos.codigo === "medido" && (
              <>
                {cuentan.length === 0 ? (
                  <p className="text-green-400 text-xs font-semibold">Ningún exceso sostenido sobre {r.umbral} km/h.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {cuentan.map((ep) => (
                      <li key={ep.inicioTs}>
                        <button type="button" onClick={() => setEnfocado(ep.inicioTs)}
                          className={`w-full text-left rounded-xl px-3 py-2 transition-colors ${enfocado === ep.inicioTs ? "bg-red-600/30 ring-1 ring-red-400" : "bg-[#0b315f] hover:bg-[#13427a]"}`}>
                          <p className="text-white text-xs font-black">
                            <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: COLOR_EXCESO }} />
                            {horaLima(ep.inicioTs)} · {Math.round(ep.velMediaSensor)} km/h sostenidos
                          </p>
                          <p className="text-blue-200 text-[11px]">
                            {Math.round(ep.durS)} s · pico {Math.round(ep.velMaxSensor)} km/h
                            {ep.velGeom != null ? ` · posiciones ${Math.round(ep.velGeom)} km/h` : ""}
                          </p>
                          {/* Dónde ocurrió: informativo, no descuenta nada (el exceso cuenta igual). */}
                          {ep.contexto?.texto && (
                            <p className="mt-1 inline-block rounded-md bg-blue-950/60 px-1.5 py-0.5 text-[10px] font-bold text-blue-200" title={ep.contexto.motivo}>
                              {ep.contexto.texto}
                            </p>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {r.excesos.piso && (
                  <p className="text-amber-300 text-[11px] mt-2">El rastreo no cubrió todo el servicio: es un mínimo.</p>
                )}
                {descartados.length > 0 && (
                  <label className="mt-3 flex items-center gap-2 text-[11px] text-blue-300 cursor-pointer">
                    <input type="checkbox" checked={verDescartados} onChange={(e) => setVerDescartados(e.target.checked)} />
                    Ver en el mapa {descartados.length} episodio{descartados.length === 1 ? "" : "s"} descartado{descartados.length === 1 ? "" : "s"} (breves, imprecisos o sin corroborar)
                  </label>
                )}
                {verDescartados && descartados.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {descartados.map((ep: EpisodioMapa) => (
                      <li key={ep.inicioTs} className="text-[11px] text-amber-200/90" title={ep.detalle}>
                        {horaLima(ep.inicioTs)} · pico {Math.round(ep.velMaxSensor)} km/h · {ep.detalle}
                        {ep.contexto?.texto && <span className="text-blue-300" title={ep.contexto.motivo}> · {ep.contexto.texto}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {r && r.excesos.codigo !== "medido" && (
              <p className="text-blue-200 text-xs">{r.excesos.base}</p>
            )}
            {pedidoNoEsta && r && r.excesos.codigo === "medido" && (
              <p className="text-amber-300 text-[11px] mt-2">
                El exceso de la fila que abriste no aparece con el umbral de {r.umbral} km/h: prueba con el umbral de la pantalla de origen.
              </p>
            )}
            {r && r.posiciones > 0 && r.primeraTs != null && r.ultimaTs != null && (
              <p className="text-blue-500 text-[10px] mt-3">
                {r.posiciones.toLocaleString("es-PE")} posiciones GPS · {horaLima(r.primeraTs)} → {horaLima(r.ultimaTs)}
              </p>
            )}
          </div>

          {/* Rastreo GPS: el MISMO veredicto de la celda RASTREO de /seguimiento (chip, banda y frase
              del motor) y sus tramos «sin señal», que en el mapa se marcan solo en sus extremos. */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-2">Rastreo GPS</p>
            {rec.cargando && !r && <p className="text-blue-300 text-xs">Midiendo…</p>}
            {!rec.cargando && !r && !rec.error && <p className="text-blue-300 text-xs">—</p>}
            {vered && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  {!SIN_CHIP.includes(vered.codigo) ? (
                    <span className={`inline-block text-sm font-black px-2 py-0.5 rounded-lg whitespace-nowrap ${vered.problema === "urgente" ? "animate-pulse" : ""}`}
                      style={{ color: vered.color, background: vered.bg }}>{vered.celda}</span>
                  ) : (
                    <span className="text-sm font-black text-gray-300">{vered.celda || "—"}</span>
                  )}
                  {CODIGOS_BANDA.includes(vered.codigo) && vered.pct != null && (
                    <span className="text-xs font-bold text-blue-100">{bandaCobertura(vered.pct).label}</span>
                  )}
                </div>
                {vered.detalle && <p className="text-blue-200 text-[11px] leading-snug mt-1.5 break-words">{vered.detalle}</p>}
              </>
            )}

            {r && (
              <div className="mt-3 space-y-1 text-[11px] text-blue-200">
                <p>
                  <span className="text-blue-400">Sin señal: </span>
                  {r.sinSenalTotal == null
                    ? (vered?.codigo === "no_aplica" ? "no se mide (el servicio no corrió)" : "no se pudo medir")
                    : r.sinSenalTotal === 0 ? "ningún tramo" : plural(r.sinSenalTotal, "tramo", "tramos")}
                </p>
                {r.cortesEnMovimiento != null && (
                  <p>
                    <span className="text-blue-400">Cortes en movimiento: </span>{r.cortesEnMovimiento.toLocaleString("es-PE")}
                    {r.kmACiegas != null && r.cortesEnMovimiento > 0 ? ` · ${r.kmACiegas.toLocaleString("es-PE", { maximumFractionDigits: 1 })} km sin señal` : ""}
                  </p>
                )}
                {r.rutaPrevista && (
                  <p className="text-blue-300" title={r.rutaPrevista.detalle}>
                    <span className="text-blue-400">Ruta prevista: </span>{textoRutaPrevista(r.rutaPrevista.codigo, r.rutaPrevista.detalle)}
                  </p>
                )}
              </div>
            )}

            {sinSenal.length > 0 && (
              <ul className="mt-3 space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {sinSenal.map((t, i) => {
                  const ubicable = t.desde != null || t.hasta != null;
                  const avance = t.avanceM != null ? `avanzó ${metrosTxt(t.avanceM)} · ` : "";
                  return (
                    <li key={`${t.desdeTs}-${i}`}>
                      <button type="button" disabled={!ubicable}
                        onClick={() => setFocoSinSenal((f) => ({ i, n: (f?.n ?? 0) + 1 }))}
                        className={`w-full text-left rounded-xl px-3 py-2 transition-colors ${ubicable ? "bg-[#0b315f] hover:bg-[#13427a]" : "bg-[#0b315f]/60 cursor-not-allowed"} ${focoSinSenal?.i === i ? "ring-1 ring-slate-300" : ""}`}>
                        <p className="text-white text-xs font-black">
                          <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: COLOR_SIN_SENAL }} />
                          {TIPO_TRAMO[t.tipo] ?? t.tipo} · {horaLima(t.desdeTs)}–{horaLima(t.hastaTs)} · {duracionTramo(t.durS)}
                        </p>
                        <p className="text-blue-200 text-[11px]">
                          {avance}{movimientoTramo(t)}{t.estimado ? " · cubierto por un tramo estimado" : ""}
                        </p>
                        {!ubicable && <p className="text-blue-400 text-[10px]">Sin posición en sus bordes: no se puede ubicar en el mapa.</p>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {r && r.sinSenalTotal != null && r.sinSenalTotal > sinSenal.length && (
              <p className="text-blue-500 text-[10px] mt-1">
                Se listan y se marcan {sinSenal.length.toLocaleString("es-PE")} de {r.sinSenalTotal.toLocaleString("es-PE")} (los más largos); el total es el de la celda.
              </p>
            )}

            {notasDibujo.length > 0 && (
              <p className="text-blue-500 text-[10px] mt-3">
                Para dibujarlo: {notasDibujo.join(" · ")}. Los excesos y el rastreo se miden con todas las posiciones.
              </p>
            )}
            <p className="text-blue-500 text-[10px] mt-2">
              El trazo une las posiciones GPS; no se ajusta a la vía con un servicio de pago.
            </p>
          </div>

          {/* Conductor */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">Conductor</p>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-[#0b315f] flex items-center justify-center flex-shrink-0 text-white text-xl font-black shadow-inner">
                {datos.conductor_nombre.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-white font-black text-sm leading-tight truncate">{datos.conductor_nombre}</p>
                {datos.conductor_tel ? (
                  <a href={`tel:${datos.conductor_tel}`} className="text-green-400 text-xs font-bold mt-1 inline-block">{datos.conductor_tel}</a>
                ) : (
                  <p className="text-blue-400 text-xs mt-1">Sin teléfono</p>
                )}
              </div>
            </div>
            <p className="text-blue-500 text-[10px] mt-2">El asignado al servicio. El exceso lo cuenta quien llevaba el teléfono.</p>
          </div>

          {/* Vehículo */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-2">Vehículo</p>
            <p className="text-white font-black text-xl font-mono tracking-widest">{datos.vehiculo_placa}</p>
            <p className="text-blue-300 text-xs">{datos.vehiculo_tipo}</p>
          </div>

          {/* Info reserva */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">Info Servicio</p>
            <div className="space-y-2 text-xs">
              {[
                { label: "Cliente",   val: datos.cliente_nombre },
                { label: "Hora",      val: datos.hora_servicio?.slice(0,5) || "—" },
                { label: "Origen",    val: datos.origen || datos.paradas[0]?.nombre || "—" },
                { label: "Destino",   val: datos.destino || datos.paradas[datos.paradas.length - 1]?.nombre || "—" },
                { label: "Estado",    val: fmtEstado(datos.estado) },
              ].map(d => (
                <div key={d.label} className="flex justify-between gap-2">
                  <span className="text-blue-400 flex-shrink-0">{d.label}</span>
                  <span className="text-white font-semibold text-right truncate" title={d.val}>{d.val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Paradas (móvil) */}
          <div className="bg-[#1a2f4a] rounded-2xl p-4 md:hidden">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400 mb-3">
              Itinerario · {paradasComp}/{datos.paradas.length}
            </p>
            <div className="space-y-2">
              {datos.paradas.map((p, i) => (
                <div key={p.id} className="flex items-center gap-2 text-xs">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black flex-shrink-0
                    ${p.estado === "completada" ? "bg-green-500 text-white" : i === datos.paradas.length - 1 ? "bg-red-500 text-white" : "bg-blue-800 text-blue-300"}`}>
                    {p.estado === "completada" ? "✓" : i + 1}
                  </div>
                  <span className={`flex-1 truncate ${p.estado === "completada" ? "text-green-400 line-through" : "text-white"}`}>
                    {p.nombre}
                  </span>
                  {p.hora_estimada && <span className="text-blue-400 font-mono text-[10px]">{p.hora_estimada.slice(0,5)}</span>}
                </div>
              ))}
            </div>
          </div>

          <Link href="/seguimiento"
            className="block w-full bg-[#1a2f4a] hover:bg-[#243d5c] text-blue-300 text-xs font-bold py-3 rounded-xl text-center transition-colors">
            ← Volver a Seguimiento
          </Link>

          {enCurso && (
            <p className="text-[10px] text-blue-600 text-center">
              Actualizado {ultimaActualiz.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
