"use client";

// /seguridad-vial — los EXCESOS DE VELOCIDAD sostenidos y corroborados de la flota.
//
// Lo que esta pantalla NO hace es decidir: qué es un exceso, por qué se descarta un pico, si un
// conductor se puede juzgar y qué se dice cuando no hay total, lo decide lib/flota/excesos.ts y
// llega en la respuesta de /api/flota/excesos (módulo `monitoreo`). Aquí se pide, se une y se pinta.
//
//   · Un mes se pide en tandas de MAX_DIAS_CONSULTA días (`tandasDeRango`), de a una, y se une con
//     `unirRespuestasExcesos`, que vuelve a calcular el ranking con la exposición de todo el rango.
//   · «Incluir fuera de servicio» viaja como fuera=0|1: con la casilla apagada el servidor no manda
//     esos episodios (ni a quien solo tuvo esos). El servidor tiene la medición en caché, así que
//     cambiarla no vuelve a leer posiciones. `vistaRespuesta` se aplica igual sobre la unión.
//   · El filtro de flota vuelve a pedirle el ranking al motor (`vistaPorFlota`), no cuenta por su cuenta.
//   · Mientras mide dice «Midiendo…» y NO enseña el resultado del rango anterior; sin la migración, o
//     si la medición falló, no se pinta ningún número: unas listas vacías no son «0 excesos».
//
// Sin efectos que pongan estado de forma síncrona (regla react-hooks/set-state-in-effect): la URL se
// lee con useSyncExternalStore y el resultado se guarda CON la clave de la consulta que lo produjo,
// así «está midiendo» se deriva en el render (el resultado no es de la consulta actual).

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cabecerasErp } from "@/lib/fetch-erp";
import { usePuedeVer } from "@/lib/usePuedeVer";
import { fechaLima } from "@/lib/alertas-horario";
import {
  CONSTANTES_EXCESOS, MAX_DIAS_CONSULTA, TEXTO_SIN_TOTAL, TEXTO_VELOCIMETRO, TOPE_PUNTOS_LLAMADA,
  UMBRAL_DEFECTO_KMH, sumarDias, tandasDeRango, textoDuracion, unirRespuestasExcesos, vistaRespuesta,
  type RespuestaExcesos,
} from "@/lib/flota/excesos";
import { ETIQUETA_RECORRIDO, ETIQUETA_RUTA, SIN_NOMBRE_RUTA, SIN_RECORRIDO } from "@/lib/ruta-identidad";
import { urlRecorrido } from "@/lib/flota/recorrido-url";
import {
  ETIQUETA_FLOTA, MAX_DIAS_RANGO, esTercero, fechaCorta, horaLima, leerParametros, minimoDesde, opcionesUmbral, problemaDeRango,
  vistaPorFlota, type FiltroFlota,
} from "./excesos-vista";
import {
  ComoSeMide, SeccionConductores, SeccionDescartados, SeccionEpisodios, SeccionUnidades,
  type Directorio,
} from "./ExcesosSecciones";

const AZUL = "#0b315f";
/** Con la cola del servidor llena (503 `reintentar`) se espera esto y se reintenta UNA vez. */
const ESPERA_REINTENTO_MS = 5000;

// ── La URL, sin efectos ───────────────────────────────────────────────────────

const sinSuscripcion = () => () => {};
/** `window.location.search` en el cliente; null en el servidor y durante la hidratación. */
function useBusqueda(): string | null {
  return useSyncExternalStore(sinSuscripcion, () => window.location.search, () => null);
}

// ── Pedir una tanda ───────────────────────────────────────────────────────────

type TipoFallo = "permiso" | "ocupado" | "otro";
class FalloMedicion extends Error {
  constructor(mensaje: string, public tipo: TipoFallo) { super(mensaje); this.name = "FalloMedicion"; }
}

function esperar(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((ok, mal) => {
    const t = setTimeout(ok, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); mal(new DOMException("abortado", "AbortError")); }, { once: true });
  });
}

const pareceRespuesta = (j: unknown): j is RespuestaExcesos => {
  const r = j as Partial<RespuestaExcesos> | null;
  return !!r && typeof r === "object" && Array.isArray(r.episodios) && Array.isArray(r.servicios)
    && Array.isArray(r.conductores) && !!r.resumen && typeof r.resumen === "object" && Array.isArray(r.constantes);
};

async function pedirTanda(t: { desde: string; hasta: string }, umbral: number, fuera: boolean, signal: AbortSignal, intento = 0): Promise<RespuestaExcesos> {
  const qs = new URLSearchParams({ desde: t.desde, hasta: t.hasta, umbral: String(umbral), fuera: fuera ? "1" : "0" });
  const res = await fetch(`/api/flota/excesos?${qs}`, { headers: await cabecerasErp(), cache: "no-store", signal });
  // El texto primero: un corte de la plataforma llega como HTML y r.json() reventaría sin decir nada.
  const texto = await res.text();
  let j: unknown = null;
  try { j = JSON.parse(texto); } catch { /* no era JSON */ }
  const errorApi = j && typeof j === "object" && typeof (j as { error?: unknown }).error === "string" ? (j as { error: string }).error : null;
  if (res.status === 401) {
    throw new FalloMedicion("Tu sesión no es válida o te falta el permiso del módulo Monitoreo: vuelve a ingresar, o pídele el permiso a un administrador en Usuarios.", "permiso");
  }
  if (res.status === 403) {
    throw new FalloMedicion("Te falta el permiso del módulo Monitoreo para ver los excesos de velocidad. Pídeselo a un administrador en Usuarios.", "permiso");
  }
  if (res.status === 503) {
    if (intento === 0) { await esperar(ESPERA_REINTENTO_MS, signal); return pedirTanda(t, umbral, fuera, signal, 1); }
    throw new FalloMedicion(errorApi ?? "Hay demasiadas mediciones en curso en el servidor.", "ocupado");
  }
  if (res.status === 502 || res.status === 504) {
    throw new FalloMedicion(`La medición del ${fechaCorta(t.desde)} al ${fechaCorta(t.hasta)} superó el tiempo límite del servidor. Reintenta en unos minutos o prueba con un rango más corto.`, "otro");
  }
  if (!res.ok) throw new FalloMedicion(errorApi ?? `El servidor respondió con un error (${res.status}).`, "otro");
  if (!pareceRespuesta(j)) {
    throw new FalloMedicion("La respuesta del servidor vino con otra forma: recarga la página (puede haber un despliegue a medias).", "otro");
  }
  return j;
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function SeguridadVial() {
  const search = useBusqueda();
  if (search == null) {
    return (
      <div className="max-w-7xl mx-auto">
        <Encabezado />
        <p className="mt-6 text-sm text-gray-500">Midiendo…</p>
      </div>
    );
  }
  return <Cuerpo search={search} />;
}

function Encabezado({ medidoEn }: { medidoEn?: string | null }) {
  return (
    <div className="min-w-0">
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Seguridad vial</h1>
      <p className="text-gray-500 text-sm mt-1 max-w-3xl">
        Excesos de velocidad <strong>sostenidos</strong> y <strong>corroborados</strong> por las posiciones del GPS.
        Un pico suelto, la velocidad fantasma del GPS con el bus detenido o un teléfono sin velocímetro no se cuentan como exceso.
        {medidoEn ? <span className="text-gray-400"> · Medido a las {horaLima(Date.parse(medidoEn))}</span> : null}
      </p>
    </div>
  );
}

type Resultado =
  | { clave: string; ok: true; unida: RespuestaExcesos; conError: number; total: number }
  | { clave: string; ok: false; mensaje: string; tipo: TipoFallo };

/** El enlace a Uso de flota solo se ofrece con su módulo: sin él, el layout rebotaría al dashboard. */
const MODULOS_ENLACE = ["vehiculos"] as const;

function Cuerpo({ search }: { search: string }) {
  const puedeVer = usePuedeVer(MODULOS_ENLACE);
  // Se monta solo en el cliente (ver `SeguridadVial`): leer la hora y la URL aquí es seguro.
  const [inicial] = useState(() => {
    const hoy = fechaLima(Date.now());
    return { hoy, ...leerParametros(search, hoy) };
  });
  const { hoy, reserva } = inicial;
  const [desde, setDesde] = useState(inicial.desde);
  const [hasta, setHasta] = useState(inicial.hasta);
  const [umbral, setUmbral] = useState(inicial.umbral);
  const [flota, setFlota] = useState<FiltroFlota>("todas");
  const [incluirFuera, setIncluirFuera] = useState(false);
  const [intento, setIntento] = useState(0);
  const [progreso, setProgreso] = useState<{ clave: string; hechas: number } | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const problema = problemaDeRango(desde, hasta, hoy);
  const tandas = useMemo(() => (problema ? [] : tandasDeRango(desde, hasta, MAX_DIAS_CONSULTA)), [desde, hasta, problema]);
  const clave = problema ? null : `${desde}|${hasta}|${umbral}|${incluirFuera ? 1 : 0}|${intento}`;

  useEffect(() => {
    if (!clave || !tandas.length) return;
    const ctrl = new AbortController();
    const medir = async () => {
      const rs: RespuestaExcesos[] = [];
      for (let i = 0; i < tandas.length; i++) {
        rs.push(await pedirTanda(tandas[i], umbral, incluirFuera, ctrl.signal));
        if (ctrl.signal.aborted) return;
        setProgreso({ clave, hechas: i + 1 });
      }
      const unida = unirRespuestasExcesos(rs);
      setResultado({ clave, ok: true, unida, conError: rs.filter((r) => r.error).length, total: rs.length });
    };
    medir().catch((e: unknown) => {
      if (ctrl.signal.aborted) return;
      if (!(e instanceof FalloMedicion)) console.error("[seguridad-vial]", e);
      setResultado(e instanceof FalloMedicion
        ? { clave, ok: false, mensaje: e.message, tipo: e.tipo }
        : e instanceof TypeError
          ? { clave, ok: false, mensaje: "No hubo respuesta del servidor: revisa tu conexión.", tipo: "otro" }
          : { clave, ok: false, mensaje: `No se pudieron juntar las tandas del rango (${e instanceof Error ? e.message : String(e)}).`, tipo: "otro" });
    });
    return () => ctrl.abort();
  }, [clave, tandas, umbral, incluirFuera]);

  // El rango y el umbral quedan en la URL: el enlace que se copia mide lo mismo.
  useEffect(() => {
    if (problema) return;
    try {
      const sp = new URLSearchParams(window.location.search);
      sp.set("desde", desde); sp.set("hasta", hasta); sp.set("umbral", String(umbral));
      window.history.replaceState(window.history.state, "", `${window.location.pathname}?${sp.toString()}`);
    } catch { /* sin historial escribible, la pantalla funciona igual */ }
  }, [desde, hasta, umbral, problema]);

  const actual = resultado && resultado.clave === clave ? resultado : null;
  const midiendo = clave != null && !actual;
  const hechas = progreso && progreso.clave === clave ? progreso.hechas : 0;
  /** La tanda que se está midiendo ahora (1..N): «Midiendo 2/5». */
  const enCurso = Math.min(hechas + 1, Math.max(tandas.length, 1));
  const unida = actual?.ok ? actual.unida : null;
  const respuesta = useMemo(() => (unida ? vistaRespuesta(unida, incluirFuera) : null), [unida, incluirFuera]);
  const vista = useMemo(() => (respuesta ? vistaPorFlota(respuesta, flota) : null), [respuesta, flota]);

  const dir: Directorio = useMemo(() => {
    const conductores = new Map((unida?.conductores ?? []).map((c) => [c.clave, c] as const));
    const unidades = new Map((unida?.unidades ?? []).map((u) => [u.clave, u] as const));
    const servicios = new Map((unida?.servicios ?? []).map((s) => [s.reservaId, s] as const));
    const id = (k: string) => k.slice(2);
    return {
      conductor: (k) => {
        if (!k) return { nombre: "Sin conductor identificado", tercero: false, velocimetro: null };
        const c = conductores.get(k);
        return { nombre: c?.nombre ?? `Conductor sin nombre (#${id(k)})`, tercero: c?.tercero ?? esTercero(k), velocimetro: c?.velocimetro ?? null };
      },
      unidad: (k) => {
        if (!k) return { placa: "Sin unidad conocida", tercero: false };
        const u = unidades.get(k);
        return { placa: u?.placa ?? `Unidad sin placa (#${id(k)})`, tercero: u?.tercero ?? esTercero(k) };
      },
      servicio: (rid) => (rid == null ? null : servicios.get(rid) ?? null),
    };
  }, [unida]);

  // Lleva al servicio del enlace (?reserva=) una vez por medición.
  const desplazado = useRef<string | null>(null);
  useEffect(() => {
    if (reserva == null || !actual?.ok || desplazado.current === actual.clave) return;
    desplazado.current = actual.clave;
    const visible = (el: HTMLElement | null) => el && el.offsetParent !== null ? el : null;
    const el = visible(document.getElementById(`exceso-servicio-${reserva}`))
      ?? visible(document.getElementById(`exceso-servicio-${reserva}-m`))
      ?? document.getElementById("servicio-del-enlace");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [actual, reserva]);

  const notaUmbral = CONSTANTES_EXCESOS.find((c) => c.clave === "UMBRAL_DEFECTO_KMH")?.nota ?? "";
  const ponerUltimos = (n: number) => { setHasta(hoy); setDesde(sumarDias(hoy, -(n - 1))); };
  const sinMigracion = unida?.sin_migracion ?? null;
  const todoFallo = !!actual?.ok && actual.conError === actual.total;
  const hayDatos = !!vista && !sinMigracion && !todoFallo;

  return (
    <div className="max-w-7xl mx-auto space-y-5 min-w-0">
      <Encabezado medidoEn={hayDatos ? unida?.medidoEn : null} />

      {/* ── Filtros ─────────────────────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-bold uppercase text-gray-400">
              Desde
              <input type="date" value={desde} min={minimoDesde(hoy)} max={hasta || hoy} onChange={(e) => setDesde(e.target.value)}
                className="mt-1 block border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 font-normal normal-case" />
            </label>
            <label className="text-xs font-bold uppercase text-gray-400">
              Hasta
              <input type="date" value={hasta} min={desde || minimoDesde(hoy)} max={hoy} onChange={(e) => setHasta(e.target.value)}
                className="mt-1 block border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 font-normal normal-case" />
            </label>
            <div className="flex gap-1 pb-0.5">
              {[7, 15, MAX_DIAS_RANGO].map((n) => (
                <button key={n} type="button" onClick={() => ponerUltimos(n)}
                  className="rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-bold text-[#0b315f] hover:bg-blue-50">
                  {n} días
                </button>
              ))}
            </div>
          </div>
          <label className="text-xs font-bold uppercase text-gray-400">
            Umbral
            <select value={umbral} onChange={(e) => setUmbral(Number(e.target.value))}
              className="mt-1 block border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 font-normal normal-case bg-white">
              {opcionesUmbral(umbral).map((u) => (
                <option key={u} value={u}>{u} km/h{u === UMBRAL_DEFECTO_KMH ? " (por defecto)" : ""}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-bold uppercase text-gray-400">
            Flota
            <select value={flota} onChange={(e) => setFlota(e.target.value as FiltroFlota)}
              className="mt-1 block border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 font-normal normal-case bg-white">
              {(Object.keys(ETIQUETA_FLOTA) as FiltroFlota[]).map((f) => <option key={f} value={f}>{ETIQUETA_FLOTA[f]}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={incluirFuera} onChange={(e) => setIncluirFuera(e.target.checked)} className="h-4 w-4 accent-[#0b315f]" />
            Incluir fuera de servicio
          </label>
          <button type="button" onClick={() => setIntento((n) => n + 1)} disabled={midiendo || !!problema}
            className="ml-auto rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60" style={{ background: AZUL }}>
            {midiendo ? `Midiendo ${enCurso}/${tandas.length}…` : "Volver a medir"}
          </button>
        </div>
        {problema && <p className="text-sm font-semibold text-red-700">{problema}</p>}
        <p className="text-xs text-gray-500">
          <strong>Umbral por defecto: {UMBRAL_DEFECTO_KMH} km/h.</strong> {notaUmbral}
        </p>
        {inicial.avisos.map((a) => <p key={a} className="text-xs text-amber-800">{a}</p>)}
      </section>

      {reserva != null && (
        <BannerServicio reserva={reserva} unida={unida} midiendo={midiendo} umbral={umbral} dir={dir} sinMedida={!hayDatos} />
      )}

      {/* ── Estado de la medición ───────────────────────────────────────────── */}
      {midiendo && (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-6 text-center">
          <p className="font-bold text-[#0b315f]">Midiendo {enCurso}/{tandas.length}…</p>
          <p className="text-xs text-gray-500 mt-1">
            Se lee de a {MAX_DIAS_CONSULTA} días; un mes son {Math.ceil(MAX_DIAS_RANGO / MAX_DIAS_CONSULTA)} tandas. Puede tardar varios segundos cada una.
          </p>
        </div>
      )}

      {actual && !actual.ok && (
        <div className={`rounded-2xl border px-4 py-3 text-sm ${actual.tipo === "permiso" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
          <p className="font-semibold">{actual.tipo === "permiso" ? "Sin acceso" : "No se pudo medir"}</p>
          <p className="mt-0.5">{actual.mensaje} {actual.tipo !== "permiso" && "No se muestra ningún número: no hay medición que mostrar."}</p>
          {actual.tipo !== "permiso" && (
            <button type="button" onClick={() => setIntento((n) => n + 1)}
              className="mt-2 rounded-lg px-3 py-1.5 text-xs font-bold text-white" style={{ background: AZUL }}>
              Reintentar
            </button>
          )}
        </div>
      )}

      {sinMigracion && !midiendo && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Falta correr la migración <code className="font-mono text-xs">{sinMigracion}</code> en Supabase.</p>
          <p className="mt-0.5">
            Sin ella no se pueden leer las posiciones rápidas de toda la flota, así que aquí no se mide nada (y no se afirma «0 excesos»).
            Los excesos por servicio sí se ven en {puedeVer?.vehiculos
              ? <a href="/uso-flota?tab=servicios" className="font-bold underline">Uso de flota → Servicios</a>
              : <span className="font-bold">Uso de flota → Servicios</span>}, que lee la traza de cada servicio{puedeVer && !puedeVer.vehiculos ? " (necesita el módulo Vehículos)" : ""}.
          </p>
        </div>
      )}

      {unida && !sinMigracion && unida.error && !midiendo && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">{todoFallo ? "No se pudo medir el periodo." : "Parte del periodo no se pudo medir."}</p>
          <p className="mt-0.5">{unida.error}</p>
          <p className="mt-0.5">
            {todoFallo ? "No se muestra ningún número: unas listas vacías no son «0 excesos»." : "Los números de abajo NO incluyen esos días."}
          </p>
          <button type="button" onClick={() => setIntento((n) => n + 1)}
            className="mt-2 rounded-lg px-3 py-1.5 text-xs font-bold text-white" style={{ background: AZUL }}>
            Reintentar
          </button>
        </div>
      )}

      {hayDatos && vista && respuesta && unida && (
        <>
          <Avisos r={unida} />
          <Kpis vista={vista} r={respuesta} umbral={umbral} flota={flota} />
          <SeccionConductores filas={vista.resumen.porConductor} dir={dir} umbral={umbral} />
          <SeccionUnidades filas={vista.resumen.porUnidad} dir={dir} />
          <SeccionEpisodios
            titulo="Excesos en servicio"
            sub={<>Los que cuentan, con su porqué. «Posiciones» es la distancia en línea recta entre muestras sobre el tiempo: una cota inferior de lo recorrido.</>}
            episodios={vista.episodios}
            dir={dir}
            resaltar={reserva}
            umbral={umbral}
            vacio={vista.resumen.totales.excesos == null
              ? TEXTO_SIN_TOTAL[vista.resumen.totales.motivoSinTotal ?? "sin_juzgables"]
              : `Ningún exceso que cuente con ${umbral} km/h en el rango.`}
          />
          {respuesta.incluyeFueraDeServicio && (
            <SeccionEpisodios
              titulo="Excesos fuera de servicio"
              sub="Con la app abierta sin servicio: no prueban que el teléfono iba en el bus. No suman al ranking."
              episodios={vista.resumen.fueraDeServicio}
              dir={dir}
              resaltar={null}
              umbral={umbral}
              vacio="Ningún exceso fuera de servicio en el rango."
            />
          )}
          <SeccionDescartados enServicio={vista.resumen.descartados} fuera={vista.resumen.descartadosFuera} deTodas={vista.descartadosDeTodas} />
        </>
      )}

      <ComoSeMide constantes={unida?.constantes ?? CONSTANTES_EXCESOS} />
    </div>
  );
}

// ── Avisos de la medición ─────────────────────────────────────────────────────

function Avisos({ r }: { r: RespuestaExcesos }) {
  const dias = [...new Map(r.diasRecortados.map((d) => [`${d.fecha}|${d.extension}`, d] as const)).values()];
  if (!dias.length && !r.cortados && !r.avisos.length) return null;
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-1">
      {dias.length > 0 && (
        <p>
          <strong>Días leídos incompletos:</strong>{" "}
          {dias.map((d) => `${fechaCorta(d.fecha)}${d.extension ? " (continuación de un exceso)" : ""}`).join(", ")}.
          {" "}Se alcanzó el tope de {TOPE_PUNTOS_LLAMADA.toLocaleString("es-PE")} posiciones rápidas por lectura: sus excesos pueden faltar.
        </p>
      )}
      {r.cortados > 0 && (
        <p>
          <strong>{r.cortados} exceso{r.cortados === 1 ? "" : "s"}</strong> seguía{r.cortados === 1 ? "" : "n"} por encima del umbral cuando se terminó de leer:
          duraron al menos lo que se muestra (marcado con ≥).
        </p>
      )}
      {r.avisos.map((a) => <p key={a}>{a}</p>)}
    </div>
  );
}

// ── KPIs ──────────────────────────────────────────────────────────────────────

function Kpis({ vista, r, umbral, flota }: { vista: NonNullable<ReturnType<typeof vistaPorFlota>>; r: RespuestaExcesos; umbral: number; flota: FiltroFlota }) {
  const t = vista.resumen.totales;
  const pv = vista.resumen.porVelocimetro;
  const sinTotal = t.excesos == null;
  const tarjetas: { k: string; v: string; sub?: string; tono: "rojo" | "azul" | "gris" }[] = [
    {
      k: "Excesos que cuentan",
      v: sinTotal ? "—" : String(t.excesos),
      sub: sinTotal ? TEXTO_SIN_TOTAL[t.motivoSinTotal ?? "sin_juzgables"] : `en ${t.serviciosConExceso} de ${t.serviciosPrestados} servicios prestados · umbral ${umbral} km/h`,
      tono: sinTotal ? "gris" : (t.excesos ?? 0) > 0 ? "rojo" : "azul",
    },
    {
      k: "Conductores con exceso",
      // «X de Y» solo si X cabe en Y: un exceso de un conductor cuyo velocímetro no se pudo comprobar
      // cuenta en X sin estar en Y, y «4 de 3» se leería como un error de la pantalla.
      v: t.conductoresJuzgables > 0 && t.conductoresConExceso <= t.conductoresJuzgables
        ? `${t.conductoresConExceso} de ${t.conductoresJuzgables}` : t.conductoresJuzgables > 0 || t.conductoresConExceso > 0 ? String(t.conductoresConExceso) : "—",
      sub: t.conductoresJuzgables > 0
        ? (t.conductoresConExceso <= t.conductoresJuzgables ? "de los que se pueden juzgar" : `${t.conductoresJuzgables} se pueden juzgar`)
        : t.conductoresConExceso > 0 ? "ninguno con velocímetro comprobado" : "ningún conductor se puede juzgar",
      tono: t.conductoresConExceso > 0 ? "rojo" : t.conductoresJuzgables > 0 ? "azul" : "gris",
    },
    {
      k: "Tiempo en exceso",
      v: sinTotal ? "—" : t.segundos > 0 ? textoDuracion(t.segundos) : "0 s",
      sub: sinTotal ? undefined : "sumando todos los excesos que cuentan",
      tono: sinTotal ? "gris" : t.segundos > 0 ? "rojo" : "azul",
    },
    {
      k: "Máximo sostenido",
      v: t.velSostenida == null ? "—" : `${Math.round(t.velSostenida)} km/h`,
      sub: t.velPico == null ? (sinTotal ? undefined : "sin excesos que cuenten") : `pico del sensor: ${Math.round(t.velPico)} km/h`,
      tono: t.velSostenida == null ? "gris" : "rojo",
    },
  ];
  const TONO = {
    rojo: { bg: "#fef2f2", color: "#991b1b" },
    azul: { bg: "#eef3f8", color: AZUL },
    gris: { bg: "#f3f4f6", color: "#4b5563" },
  } as const;
  const noJuzgables = pv.sin_velocimetro;
  return (
    <section className="space-y-2 @container">
      {flota !== "todas" && (
        <p className="text-xs font-bold text-[#0b315f]">Mostrando: {ETIQUETA_FLOTA[flota]}</p>
      )}
      <div className="grid grid-cols-1 @min-[21rem]:grid-cols-2 @3xl:grid-cols-4 gap-3">
        {tarjetas.map((c) => (
          <div key={c.k} className="rounded-2xl p-4 min-w-0" style={{ background: TONO[c.tono].bg }}>
            <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: TONO[c.tono].color, opacity: 0.8 }}>{c.k}</p>
            <p className="text-2xl font-black mt-1" style={{ color: TONO[c.tono].color }}>{c.v}</p>
            {c.sub && <p className="text-xs mt-1 text-gray-600">{c.sub}</p>}
          </div>
        ))}
      </div>
      <div className="rounded-xl bg-gray-100 px-4 py-2.5 text-xs text-gray-600 space-y-1">
        {noJuzgables > 0 ? (
          <p>
            <strong>{noJuzgables} conductor{noJuzgables === 1 ? "" : "es"} sin velocímetro: no se pueden juzgar.</strong>{" "}
            {TEXTO_VELOCIMETRO.sin_velocimetro.detalle}{" "}
            <a href="/gps-salud" className="font-bold text-[#0b315f] underline">Ver Salud del GPS</a>
          </p>
        ) : pv.con_velocimetro > 0 && pv.no_se_sabe === 0 ? (
          <p>Todos los conductores del rango que mandaron GPS reportan la velocidad del sensor.</p>
        ) : null}
        {pv.no_se_sabe > 0 && <p><strong>{pv.no_se_sabe} conductor{pv.no_se_sabe === 1 ? "" : "es"} · {TEXTO_VELOCIMETRO.no_se_sabe.titulo}.</strong> {TEXTO_VELOCIMETRO.no_se_sabe.detalle}</p>}
        {pv.sin_gps > 0 && <p><strong>{pv.sin_gps} conductor{pv.sin_gps === 1 ? "" : "es"} · {TEXTO_VELOCIMETRO.sin_gps.titulo}.</strong> {TEXTO_VELOCIMETRO.sin_gps.detalle}</p>}
        <p>
          {vista.resumen.fueraDeServicioTotal} exceso{vista.resumen.fueraDeServicioTotal === 1 ? "" : "s"} fuera de servicio
          {vista.fueraDeTodas && flota !== "todas" ? " (de todas las flotas)" : ""}: no suman al ranking.
          {!r.incluyeFueraDeServicio && vista.resumen.fueraDeServicioTotal > 0 ? " Marca «Incluir fuera de servicio» para verlos." : ""}
        </p>
        {t.sinConductor > 0 && <p>{t.sinConductor} exceso{t.sinConductor === 1 ? "" : "s"} en servicio sin conductor identificable en sus posiciones: cuentan en el total, sin fila de conductor.</p>}
        {t.sinUnidad > 0 && <p>{t.sinUnidad} exceso{t.sinUnidad === 1 ? "" : "s"} en servicio sin unidad conocida: cuentan en el total, sin fila de unidad.</p>}
        {vista.sinFlota > 0 && <p>{vista.sinFlota} servicio{vista.sinFlota === 1 ? "" : "s"} o exceso{vista.sinFlota === 1 ? "" : "s"} sin unidad ni conductor que diga de qué flota son: solo se ven con «Todas las flotas».</p>}
      </div>
    </section>
  );
}

// ── El servicio del enlace (?reserva=) ────────────────────────────────────────

function BannerServicio({ reserva, unida, midiendo, umbral, dir, sinMedida }: {
  reserva: number; unida: RespuestaExcesos | null; midiendo: boolean; umbral: number; dir: Directorio; sinMedida: boolean;
}) {
  let cuerpo: React.ReactNode;
  const s = unida?.servicios.find((x) => x.reservaId === reserva) ?? null;
  if (midiendo || !unida) cuerpo = <p className="text-gray-500">Midiendo…</p>;
  else if (sinMedida) cuerpo = <p className="text-gray-600">No se puede decir nada de este servicio: el periodo no se pudo medir (ver el aviso).</p>;
  else {
    const fila = unida.resumen.porServicio.find((f) => f.reservaId === reserva);
    let veredicto: string;
    if (fila) {
      veredicto = `${fila.excesos} exceso${fila.excesos === 1 ? "" : "s"} que cuenta${fila.excesos === 1 ? "" : "n"} · ${textoDuracion(fila.segundos)} en total · sostenida hasta ${Math.round(fila.velSostenida)} km/h (pico ${Math.round(fila.velPico)} km/h). Están resaltados abajo.`;
    } else if (!s) {
      veredicto = "Este servicio no está entre los prestados del rango ni tuvo un exceso en él: revisa las fechas.";
    } else {
      const v = dir.conductor(s.conductor).velocimetro;
      veredicto = v === "con_velocimetro"
        ? `Ningún exceso que cuente con ${umbral} km/h.`
        : `${TEXTO_VELOCIMETRO[v ?? "no_se_sabe"].titulo}. ${TEXTO_VELOCIMETRO[v ?? "no_se_sabe"].detalle}`;
    }
    cuerpo = (
      <>
        {s && (
          <div className="text-xs text-gray-600 space-y-0.5">
            <p>{[s.codigo, s.fecha ? `${fechaCorta(s.fecha)}${s.hora ? ` ${s.hora}` : ""}` : null, s.cliente].filter(Boolean).join(" · ")}</p>
            <p><strong className="text-gray-500">{ETIQUETA_RUTA}:</strong> {s.ruta.nombre ?? <em className="text-gray-400">{SIN_NOMBRE_RUTA}</em>}</p>
            <p><strong className="text-gray-500">{ETIQUETA_RECORRIDO}:</strong> {s.ruta.recorrido ?? <em className="text-gray-400">{SIN_RECORRIDO}</em>}</p>
          </div>
        )}
        <p className="mt-1 text-sm font-semibold text-gray-800">{veredicto}</p>
      </>
    );
  }
  return (
    <section id="servicio-del-enlace" className="rounded-2xl border-2 border-[#0b315f] bg-blue-50 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-[#0b315f]">Servicio #{reserva}</p>
        <a href={urlRecorrido(reserva, { umbral })} target="_blank" rel="noopener noreferrer"
          className="rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-bold text-[#0b315f] hover:bg-blue-100">
          Ver recorrido ↗
        </a>
      </div>
      <div className="mt-1">{cuerpo}</div>
    </section>
  );
}
