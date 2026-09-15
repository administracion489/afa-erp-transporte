"use client";

// Renombrado EN LOTE del nombre de ruta, desde la torre de control.
//
// El manifiesto ya tenia un "Aplicar a rango de fechas" (Configurar ruta) y este parte de el,
// pero arregla las cuatro cosas por las que daba miedo usarlo:
//
//   1. ERA CIEGO. Decia "se actualizaran 143 servicio(s)" y nada mas: ni cuales, ni como se
//      llaman hoy. Se aplicaba a fe. Aqui se ve la LISTA, con el nombre actual de cada uno.
//   2. PISABA EN SILENCIO. Un servicio con OTRO nombre se sobrescribia igual que uno vacio.
//      Aqui se distinguen tres cosas —se completa / se reemplaza / ya lo tiene— y las que se
//      reemplazan van en ambar, que es lo unico que de verdad hay que mirar antes de aplicar.
//   3. EXIGIA COTIZACION. El boton ni aparecia sin ella, asi que un servicio suelto no se
//      podia renombrar en lote. Aqui hay un segundo criterio —"los que hoy se llaman igual"—
//      que no necesita cotizacion y ademas es como se piensa un renombrado de verdad.
//   4. NO TENIA VUELTA ATRAS. Tras aplicar a 143 servicios, el nombre anterior ya no existia
//      en ningun sitio. Aqui se guardan los valores previos y queda un boton Deshacer.
//
// Lo que NO cambia respecto al manifiesto, a proposito: los servicios finalizados y cancelados
// se quedan fuera. Su nombre ya viajo a la liquidacion (lib/liquidacion-agrupacion.ts lo
// parsea para sacar etiqueta de ruta, turno y sentido) y reescribirlo hacia atras cambiaria un
// papel ya emitido. La diferencia es que aqui, ademas, se dice cuantos se dejaron fuera.

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  buscarEquivalentes, aplicarNombreEnLote, deshacerNombres, normalizarNombre,
  type CriterioEquivalencia, type ServicioEquivalente,
} from "@/lib/ruta-equivalente";

type Ref = {
  id: number;
  fecha_servicio: string | null;
  cotizacion_id?: number | null;
  direccion_servicio?: string | null;
  paradas_json?: unknown;
  ruta_nombre?: string | null;
};

type Props = {
  reserva: Ref;
  /** Nombre tecleado en la fila; llega ya como propuesta para el lote. */
  nombreInicial: string;
  clientes: Array<{ id: number; nombre: string; empresa?: string | null }>;
  vehiculos: Array<{ id: number; placa: string }>;
  vehsTer: Array<{ id: number; placa: string }>;
  onClose: () => void;
  /** Se llama tras aplicar o deshacer, para que la torre recargue. */
  onAplicado: () => void;
};

const FIN_ABIERTO = "2099-12-31";

function sumarDias(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

/** Qué le pasaría a este servicio si se aplica el nombre. */
type Efecto = "completa" | "reemplaza" | "igual";
function efectoDe(actual: string | null, nuevo: string): Efecto {
  const a = normalizarNombre(actual), n = normalizarNombre(nuevo);
  if (a === n) return "igual";
  return a === "" ? "completa" : "reemplaza";
}

/** Concordancia: el lote puede ser de uno solo y "1 se reemplazan" se lee como un error. */
const pl = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);

const META_EFECTO: Record<Efecto, { label: string; color: string; bg: string }> = {
  completa:  { label: "Se completa",  color: "#1d4ed8", bg: "#EFF6FF" },
  reemplaza: { label: "Se reemplaza", color: "#b45309", bg: "#fef3c7" },
  igual:     { label: "Ya lo tiene",  color: "#64748b", bg: "#f1f5f9" },
};

export default function ModalRutaMasiva({ reserva, nombreInicial, clientes, vehiculos, vehsTer, onClose, onAplicado }: Props) {
  const hoyRef = reserva.fecha_servicio || new Date().toISOString().slice(0, 10);

  const [nombre,   setNombre]   = useState(nombreInicial);
  const [criterio, setCriterio] = useState<CriterioEquivalencia>(reserva.cotizacion_id ? "ruta" : "nombre");
  const [desde,    setDesde]    = useState(hoyRef);
  const [hasta,    setHasta]    = useState(FIN_ABIERTO);

  const [cargando, setCargando] = useState(false);
  const [fallo,    setFallo]    = useState<string | null>(null);
  const [imposible,setImposible]= useState<string | null>(null);
  const [filas,    setFilas]    = useState<ServicioEquivalente[]>([]);
  const [cerrados, setCerrados] = useState(0);
  // La selección NO se guarda: se DERIVA (va marcado todo lo que cambiaría) y aquí solo viven
  // las decisiones EXPLÍCITAS del operador. Guardarla obligaba a resincronizarla por efecto
  // cada vez que cambiaba la lista o el nombre tecleado — y un efecto que hace setState en
  // cascada es justo lo que pinta la lista un frame con la selección del rango anterior.
  const [decidido, setDecidido] = useState<Map<number, boolean>>(new Map());

  const [aplicando, setAplicando] = useState(false);
  // Valores previos de lo ya aplicado en esta sesion del modal → habilita Deshacer.
  const [hecho, setHecho] = useState<{ n: number; previos: Array<{ id: number; ruta_nombre: string | null }> } | null>(null);

  const placaDe = useCallback((r: ServicioEquivalente) =>
    (r.vehiculo_id ? vehiculos.find(v => v.id === r.vehiculo_id)?.placa : null)
    ?? (r.vehiculo_tercero_id ? vehsTer.find(v => v.id === r.vehiculo_tercero_id)?.placa : null)
    ?? "—", [vehiculos, vehsTer]);

  const clienteDe = useCallback((r: ServicioEquivalente) => {
    const c = clientes.find(x => x.id === r.cliente_id);
    return c?.empresa || c?.nombre || "Sin cliente";
  }, [clientes]);

  // ── Búsqueda de equivalentes ────────────────────────────────────────────────
  // Solo la corrida vigente toca el estado: cambiar el rango dos veces seguidas no puede
  // dejar en pantalla el resultado de la primera (que ya no corresponde a lo que se ve).
  useEffect(() => {
    let vivo = true;
    (async () => {
      setCargando(true); setFallo(null); setImposible(null);
      try {
        const r = await buscarEquivalentes({ criterio, referencia: reserva, desde, hasta });
        if (!vivo) return;
        // Otro conjunto de servicios ⇒ las decisiones del operador ya no aplican a nadie.
        setFilas(r.servicios); setCerrados(r.cerrados); setImposible(r.imposible ?? null); setDecidido(new Map());
      } catch (e) {
        const msg = e instanceof Error ? e.message : "No se pudo consultar los servicios.";
        if (vivo) { setFilas([]); setCerrados(0); setFallo(msg); }
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [criterio, desde, hasta, reserva]);

  // Lo que ya tiene el nombre no se puede marcar (no hay nada que hacerle) ni cuenta como
  // trabajo pendiente. Si el operador reescribe el nombre arriba, los efectos se recalculan
  // solos y la preselección le sigue: no hace falta resincronizar nada a mano.
  const efectos = useMemo(() => {
    const m = new Map<number, Efecto>();
    filas.forEach(f => m.set(f.id, efectoDe(f.ruta_nombre, nombre)));
    return m;
  }, [filas, nombre]);

  const cambiables = filas.filter(f => efectos.get(f.id) !== "igual");
  /** Por defecto va marcado todo lo que cambiaría; el operador puede desmarcar lo que sea. */
  const marcado = (id: number) => decidido.get(id) ?? true;
  const seleccionados = cambiables.filter(f => marcado(f.id));
  const nReemplazo = seleccionados.filter(f => efectos.get(f.id) === "reemplaza").length;
  const nIguales = filas.length - cambiables.length;

  const alternar = (id: number) => setDecidido(prev => new Map(prev).set(id, !marcado(id)));
  /** Fija una decisión explícita para TODOS los cambiables (los atajos de arriba). */
  const decidirTodos = (quiere: (f: ServicioEquivalente) => boolean) =>
    setDecidido(new Map(cambiables.map(f => [f.id, quiere(f)])));

  const aplicar = async () => {
    if (!seleccionados.length) return;
    setAplicando(true);
    const previos = seleccionados.map(f => ({ id: f.id, ruta_nombre: f.ruta_nombre }));
    const valor = nombre.trim() || null;
    const r = await aplicarNombreEnLote(seleccionados.map(f => f.id), valor);
    setAplicando(false);
    if (r.error) { setFallo(`Se aplicó a ${r.ok} de ${previos.length} y se detuvo: ${r.error}`); }
    // Aunque falle a medias, lo que SÍ entró tiene que poder deshacerse.
    setHecho({ n: r.ok, previos: previos.slice(0, r.ok) });
    const aplicados = new Set(previos.slice(0, r.ok).map(p => p.id));
    setFilas(prev => prev.map(f => aplicados.has(f.id) ? { ...f, ruta_nombre: valor } : f));
    onAplicado();
  };

  const deshacer = async () => {
    if (!hecho) return;
    setAplicando(true);
    const r = await deshacerNombres(hecho.previos);
    setAplicando(false);
    if (r.error) { setFallo(`Se deshizo ${r.ok} de ${hecho.previos.length}: ${r.error}`); return; }
    const porId = new Map(hecho.previos.map(p => [p.id, p.ruta_nombre]));
    setFilas(prev => prev.map(f => porId.has(f.id) ? { ...f, ruta_nombre: porId.get(f.id) ?? null } : f));
    setHecho(null);
    onAplicado();
  };

  const presets: Array<{ label: string; desde: string; hasta: string }> = [
    { label: "De este servicio en adelante", desde: hoyRef, hasta: FIN_ABIERTO },
    { label: "Próximas 2 semanas",           desde: hoyRef, hasta: sumarDias(hoyRef, 14) },
    { label: "Este mes",                     desde: `${hoyRef.slice(0, 7)}-01`, hasta: `${hoyRef.slice(0, 7)}-31` },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>

        {/* ── Cabecera ── */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-black text-[#0b315f] text-base leading-none">Poner este nombre de ruta a varios servicios</h3>
            <p className="text-[11px] text-gray-400 mt-1.5">
              Es el nombre que el pasajero lee al elegir su bus. Revisa la lista antes de aplicar.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-500 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto">

          {/* ── Nombre a aplicar ── */}
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Nombre de ruta</p>
            <input
              value={nombre}
              onChange={e => setNombre(e.target.value)}
              placeholder="Ej. RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA"
              className="w-full border rounded-xl px-3 py-2.5 text-sm font-semibold text-[#0b315f] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              style={{ borderColor: "#bfdbfe" }}
            />
            <p className="text-[10px] text-gray-400 mt-1">
              Respeta el formato de la operación: la liquidación saca de este texto la etiqueta de ruta, el turno y si es ida o retorno.
            </p>
          </div>

          {/* ── Criterio ── */}
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">¿A cuáles?</p>
            <div className="flex flex-wrap gap-2">
              {([
                { k: "ruta"   as const, label: "La misma ruta",             sub: "Mismos paraderos, mismo sentido, misma cotización" },
                { k: "nombre" as const, label: "Los que hoy se llaman igual", sub: "Renombra una ruta ya bautizada" },
              ]).map(o => {
                const activo = criterio === o.k;
                return (
                  <button key={o.k} onClick={() => setCriterio(o.k)}
                    className="text-left px-3 py-2 rounded-xl border transition-colors flex-1 min-w-[210px]"
                    style={{ borderColor: activo ? "#0b315f" : "#e2e8f0", background: activo ? "#eaeff6" : "white" }}>
                    <p className="text-xs font-bold" style={{ color: activo ? "#0b315f" : "#374151" }}>{o.label}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{o.sub}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Rango ── */}
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Rango de fechas</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {presets.map(p => {
                const activo = desde === p.desde && hasta === p.hasta;
                return (
                  <button key={p.label} onClick={() => { setDesde(p.desde); setHasta(p.hasta); }}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors"
                    style={{ borderColor: activo ? "#0b315f" : "#e2e8f0", background: activo ? "#eaeff6" : "white", color: activo ? "#0b315f" : "#6b7280" }}>
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input type="date" value={desde} onChange={e => setDesde(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]" />
              <input type="date" value={hasta} onChange={e => setHasta(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]" />
            </div>
          </div>

          {/* ── Resultado ── */}
          {imposible ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 font-semibold">{imposible}</div>
          ) : fallo ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 font-semibold">{fallo}</div>
          ) : null}

          {cargando ? (
            <div className="py-8 text-center">
              <div className="w-6 h-6 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-2" />
              <p className="text-xs font-bold text-gray-400">Buscando servicios…</p>
            </div>
          ) : !imposible && (
            <div>
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <p className="text-[11px] font-bold text-gray-500">
                  {filas.length === 0 ? "Ningún servicio coincide en ese rango"
                    : `${cambiables.length} por cambiar${nIguales ? ` · ${nIguales} ya lo ${pl(nIguales, "tiene", "tienen")}` : ""}${nReemplazo ? ` · ${nReemplazo} se ${pl(nReemplazo, "reemplaza", "reemplazan")}` : ""}`}
                </p>
                {cambiables.length > 0 && (
                  <div className="flex gap-2">
                    <button onClick={() => decidirTodos(() => true)}
                      className="text-[10px] font-bold text-[#0b315f] hover:underline">Todos</button>
                    <button onClick={() => decidirTodos(f => efectos.get(f.id) === "completa")}
                      className="text-[10px] font-bold text-[#0b315f] hover:underline">Solo los que están en blanco</button>
                    <button onClick={() => decidirTodos(() => false)}
                      className="text-[10px] font-bold text-gray-400 hover:underline">Ninguno</button>
                  </div>
                )}
              </div>

              {filas.length > 0 && (
                <div className="border border-gray-100 rounded-xl overflow-hidden max-h-[34vh] overflow-y-auto">
                  {filas.map(f => {
                    const ef = efectos.get(f.id) || "igual";
                    const meta = META_EFECTO[ef];
                    const marcable = ef !== "igual";
                    const tildado = marcable && marcado(f.id);
                    return (
                      <label key={f.id}
                        className={`flex items-center gap-3 px-3 py-2 border-b border-gray-50 last:border-0 text-xs ${marcable ? "cursor-pointer hover:bg-[#f6f9fd]" : "opacity-60"}`}>
                        <input type="checkbox" disabled={!marcable} checked={tildado}
                          onChange={() => alternar(f.id)} className="flex-shrink-0" />
                        <span className="font-mono font-bold text-[#0b315f] w-16 flex-shrink-0">{fechaCorta(f.fecha_servicio)}</span>
                        <span className="font-mono text-gray-400 w-10 flex-shrink-0">{(f.hora_servicio || "").slice(0, 5)}</span>
                        <span className="font-mono text-gray-400 w-16 flex-shrink-0 truncate">{placaDe(f)}</span>
                        <span className="flex-1 min-w-0 truncate text-gray-600">{clienteDe(f)}</span>
                        <span className="flex-1 min-w-0 truncate text-gray-400 italic">{f.ruta_nombre || "sin nombre"}</span>
                        <span className="text-[9px] font-black px-1.5 py-1 rounded-md whitespace-nowrap flex-shrink-0"
                          style={{ color: meta.color, background: meta.bg }}>{meta.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}

              {cerrados > 0 && (
                <p className="text-[10px] text-gray-400 mt-2 leading-snug">
                  <b>{cerrados}</b> {pl(cerrados, "servicio finalizado o cancelado queda", "servicios finalizados o cancelados quedan")} fuera a propósito: su nombre ya viajó a la liquidación y reescribirlo cambiaría un papel ya emitido.
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Pie ── */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[11px] font-bold">
            {hecho ? (
              <span className="text-green-700">
Aplicado a {hecho.n} {pl(hecho.n, "servicio", "servicios")} ✓{" "}
                <button onClick={deshacer} disabled={aplicando}
                  className="ml-1 underline text-[#0b315f] hover:text-[#1262bd] disabled:opacity-50">Deshacer</button>
              </span>
            ) : nReemplazo > 0 ? (
              <span className="text-amber-700">
                Ojo: {nReemplazo} ya {pl(nReemplazo, "tiene", "tienen")} otro nombre y se {pl(nReemplazo, "reemplazará", "reemplazarán")}.
              </span>
            ) : <span className="text-gray-400">Nada se guarda hasta que pulses Aplicar.</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-500 hover:bg-gray-50">Cerrar</button>
            <button onClick={aplicar} disabled={aplicando || cargando || seleccionados.length === 0}
              className="px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-40"
              style={{ background: "#0b315f" }}>
              {aplicando ? "Aplicando…" : `Aplicar a ${seleccionados.length} ${pl(seleccionados.length, "servicio", "servicios")}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
