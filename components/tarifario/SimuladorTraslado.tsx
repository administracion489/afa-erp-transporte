"use client";
// components/tarifario/SimuladorTraslado.tsx — Pestaña «Simulador»: le pasa un pedido de traslado
// a POST /api/traslados/simular, que es el cotizador automático del CRM sin enviar nada, y enseña
// lo que decidiría: cotizar solo, preguntarle al cliente o pasarlo a un ejecutivo.
//
// LA PANTALLA NO DECIDE NADA: zona, vehículo, precio, IGV y validez salen del servidor (el mismo
// motor que usará la IA). Aquí solo se arma el pedido y se enseña la respuesta con su porqué.

import { useState } from "react";
import { cabecerasErp } from "@/lib/fetch-erp";
import { fechaLima } from "@/lib/alertas-horario";
import { SENALES, sumarDias, type AccionTraslado, type CodigoZona, type SenalComplejidad, type UbicacionZona } from "@/lib/traslados/motor";
import type { EntradaSimulador, LugarEntrada, LugarUbicado, RespuestaSimulador } from "@/lib/traslados/api";
import { fmtFecha, fmtMoneda, leerEntero } from "./traslados-pantalla";
import { AZUL, iCls } from "./traslados-comun";
import { LugarInput, LUGAR_VACIO, type LugarValor } from "./google-lugar";

const INSIGNIA: Record<AccionTraslado, { texto: string; clase: string }> = {
  cotizar: { texto: "✅ Se cotiza sola", clase: "bg-green-50 border-green-300 text-green-800" },
  preguntar: { texto: "❓ La IA le preguntará al cliente", clase: "bg-sky-50 border-sky-300 text-sky-900" },
  derivar: { texto: "👤 Pasa a un ejecutivo", clase: "bg-amber-50 border-amber-300 text-amber-900" },
};

const ZONA_TXT: Record<CodigoZona, string> = {
  punto: "geocerca",
  subzona_alias: "subzona, por el nombre del barrio",
  subzona_cercana: "subzona de centro más cercano",
  distrito: "distrito",
  distrito_por_barrio: "distrito deducido de un barrio",
  distrito_ambiguo: "Google solo dijo «Lima»",
  distrito_desconocido: "distrito no reconocido",
  sin_ubicacion: "no se ubicó",
};

const SENALES_LISTA = Object.entries(SENALES) as [SenalComplejidad, string][];
const TEL_EXTRANJERO = "+1 305 555 1234";
const TEL_PERUANO = "+51 987 654 321";

const manana = () => sumarDias(fechaLima(Date.now()), 1);

type Form = {
  origen: LugarValor;
  destino: LugarValor;
  fecha: string;
  sentido: "ida" | "ida_retorno";
  fechaRetorno: string;
  pax: string;
  maletas: string;
  telefono: string;
  paradas: string;
  senales: SenalComplejidad[];
};

const formVacio = (): Form => ({
  origen: LUGAR_VACIO, destino: LUGAR_VACIO, fecha: manana(), sentido: "ida", fechaRetorno: "",
  pax: "", maletas: "", telefono: "", paradas: "", senales: [],
});

type Estado =
  | { tipo: "nada" }
  | { tipo: "simulando" }
  | { tipo: "ok"; r: Extract<RespuestaSimulador, { ok: true }> }
  | { tipo: "error"; detalle: string; ambar?: boolean };

const lugarParaApi = (v: LugarValor): LugarEntrada =>
  v.lat != null && v.lng != null ? { lat: v.lat, lng: v.lng, texto: v.texto.trim() || undefined } : v.texto.trim();

function Ubicacion({ titulo, zona, lugar, onIrAZonas }: { titulo: string; zona: UbicacionZona | null; lugar: LugarUbicado; onIrAZonas: () => void }) {
  const p = lugar.punto;
  const noReconocido = zona?.codigo === "distrito_desconocido" || zona?.codigo === "distrito_ambiguo";
  return (
    <div className="border border-gray-200 rounded-xl p-3 space-y-1">
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{titulo}</p>
      {zona?.zona
        ? <p className="text-sm font-bold text-gray-800">{zona.zona.nombre} <span className="text-[11px] font-normal text-gray-500">({ZONA_TXT[zona.codigo]})</span></p>
        : <p className={`text-sm font-bold ${noReconocido ? "text-amber-700" : "text-gray-500"}`}>{zona ? ZONA_TXT[zona.codigo] : "sin zona"}</p>}
      {zona?.detalle && <p className="text-[11px] text-gray-500">{zona.detalle}</p>}
      {lugar.codigo !== "ok" && lugar.detalle && <p className="text-[11px] text-amber-700">Google: {lugar.detalle}</p>}
      {p && (
        <div className="text-[10px] text-gray-400 space-y-0.5 pt-1">
          {p.texto && <p>Google entendió: {p.texto}</p>}
          <p>Localidades: {p.localidades.length ? p.localidades.join(" · ") : "ninguna"}</p>
          <p>Barrios: {p.barrios.length ? p.barrios.join(" · ") : "ninguno"}</p>
          {p.lat != null && p.lng != null && <p className="font-mono">{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</p>}
        </div>
      )}
      <p className={`text-[10px] ${noReconocido ? "text-amber-700 font-bold" : "text-gray-400"}`}>
        Si el distrito no se reconoció, agrégalo como alias en <button type="button" onClick={onIrAZonas} className="underline font-bold">Zonas</button>.
      </p>
    </div>
  );
}

export default function SimuladorTraslado({ onIrA }: { onIrA: (tab: "zonas") => void }) {
  const [f, setF] = useState<Form>(formVacio);
  const [estado, setEstado] = useState<Estado>({ tipo: "nada" });
  const poner = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const lPax = leerEntero(f.pax, 0, 500);
  const lMal = leerEntero(f.maletas, 0, 1000);
  const lPar = leerEntero(f.paradas, 0, 50);
  const motivo = !f.origen.texto.trim() && f.origen.lat == null ? "Escribe el punto de recojo."
    : !f.destino.texto.trim() && f.destino.lat == null ? "Escribe el destino."
      : lPax.tipo === "error" ? `Pasajeros: ${lPax.detalle}`
        : lMal.tipo === "error" ? `Maletas: ${lMal.detalle}`
          : lPar.tipo === "error" ? `Paradas intermedias: ${lPar.detalle}`
            : null;

  const simular = async () => {
    if (motivo || estado.tipo === "simulando") return;
    setEstado({ tipo: "simulando" });
    const entrada: EntradaSimulador = {
      origen: lugarParaApi(f.origen),
      destino: lugarParaApi(f.destino),
      fecha_servicio: f.fecha || null,
      sentido: f.sentido,
      fecha_retorno: f.sentido === "ida_retorno" ? f.fechaRetorno || null : null,
      pax: lPax.tipo === "ok" ? lPax.valor : null,
      maletas: lMal.tipo === "ok" ? lMal.valor : null,
      telefono: f.telefono.trim() || null,
      paradas_intermedias: lPar.tipo === "ok" ? lPar.valor : null,
      senales: f.senales,
    };
    try {
      const res = await fetch("/api/traslados/simular", { method: "POST", headers: await cabecerasErp({ "Content-Type": "application/json" }), body: JSON.stringify(entrada) });
      const d = (await res.json().catch(() => null)) as RespuestaSimulador | { detalle?: string; error?: string } | null;
      if (res.status === 401) { setEstado({ tipo: "error", detalle: "Tu sesión venció o no se pudo verificar: vuelve a ingresar." }); return; }
      if (res.status === 403) {
        const det = (d as { detalle?: string; error?: string } | null);
        setEstado({ tipo: "error", detalle: /origen/i.test(det?.error ?? "") ? "El servidor rechazó la llamada (origen no permitido). Abre el ERP desde su dirección oficial." : "Te falta el permiso del módulo «Tarifas» para usar el simulador. Lo da un administrador en Usuarios." });
        return;
      }
      if (res.status === 404) { setEstado({ tipo: "error", detalle: "El simulador todavía no está desplegado en el servidor (/api/traslados/simular)." }); return; }
      if (!d || !("ok" in d)) { setEstado({ tipo: "error", detalle: `El servidor respondió ${res.status} sin un resultado legible.` }); return; }
      if (!d.ok) { setEstado({ tipo: "error", detalle: d.detalle, ambar: d.codigo === "sin_migracion" }); return; }
      setEstado({ tipo: "ok", r: d });
    } catch (e) {
      setEstado({ tipo: "error", detalle: `No se pudo llamar al simulador: ${(e as Error)?.message ?? "sin conexión"}.` });
    }
  };

  const alternarSenal = (s: SenalComplejidad) =>
    poner("senales", f.senales.includes(s) ? f.senales.filter((x) => x !== s) : [...f.senales, s]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      <section className="bg-white border rounded-2xl p-4 space-y-3">
        <p className="text-xs text-gray-500">Es el mismo cotizador que usará la IA del CRM, sin enviar nada: lo que sale aquí es lo que la IA le contestaría al cliente.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Origen (recojo)</span>
            <LugarInput valor={f.origen} onCambio={(v) => poner("origen", v)} placeholder="Ej: Aeropuerto Jorge Chávez" ariaLabel="Origen" />
          </div>
          <div>
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Destino</span>
            <LugarInput valor={f.destino} onCambio={(v) => poner("destino", v)} placeholder="Ej: Av. Larco 123, Miraflores" ariaLabel="Destino" />
          </div>
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fecha del servicio</span>
            <input type="date" className={iCls()} value={f.fecha} onChange={(e) => poner("fecha", e.target.value)} />
          </label>
          <div>
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Recorrido</span>
            <div className="flex rounded-xl border overflow-hidden">
              {([["ida", "→ Solo ida"], ["ida_retorno", "⇄ Ida y retorno"]] as const).map(([v, t]) => (
                <button key={v} type="button" onClick={() => poner("sentido", v)}
                  className="flex-1 px-3 py-2.5 text-xs font-bold min-h-[44px]"
                  style={{ background: f.sentido === v ? AZUL : "white", color: f.sentido === v ? "white" : AZUL }}>{t}</button>
              ))}
            </div>
          </div>
          {f.sentido === "ida_retorno" && (
            <label className="block">
              <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fecha del retorno</span>
              <input type="date" className={iCls()} value={f.fechaRetorno} onChange={(e) => poner("fechaRetorno", e.target.value)} />
              {!f.fechaRetorno && <span className="block text-[10px] text-gray-400 mt-0.5">Vacía = el cliente no la dijo (la IA la pregunta).</span>}
            </label>
          )}
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Pasajeros</span>
            <input className={iCls("font-mono")} inputMode="numeric" value={f.pax} onChange={(e) => poner("pax", e.target.value)} placeholder="vacío = no lo dijo" />
          </label>
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Maletas de 23 kg</span>
            <input className={iCls("font-mono")} inputMode="numeric" value={f.maletas} onChange={(e) => poner("maletas", e.target.value)} placeholder="vacío = no lo dijo" />
            <span className="block text-[10px] text-gray-400 mt-0.5">0 = no llevan; vacío = no lo dijo (la IA lo pregunta).</span>
          </label>
          <div className="sm:col-span-2">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">WhatsApp del cliente</span>
            <div className="flex flex-wrap gap-2">
              <input className={iCls("font-mono flex-1 min-w-[10rem]")} value={f.telefono} onChange={(e) => poner("telefono", e.target.value)} placeholder="+51 9…" inputMode="tel" />
              <button type="button" onClick={() => poner("telefono", TEL_EXTRANJERO)} className="px-3 py-2 rounded-xl text-xs font-bold border text-gray-600 hover:bg-gray-50 min-h-[44px]">Probar como extranjero</button>
              <button type="button" onClick={() => poner("telefono", TEL_PERUANO)} className="px-3 py-2 rounded-xl text-xs font-bold border text-gray-600 hover:bg-gray-50 min-h-[44px]">Como peruano</button>
            </div>
            <span className="block text-[10px] text-gray-400 mt-0.5">El número decide la moneda: +51 → soles; otro país → dólares (precio turista). Vacío = no se sabe la moneda (pasa a un ejecutivo).</span>
          </div>
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Paradas intermedias</span>
            <input className={iCls("font-mono")} inputMode="numeric" value={f.paradas} onChange={(e) => poner("paradas", e.target.value)} placeholder="0" />
          </label>
        </div>
        <fieldset className="border border-gray-200 rounded-xl p-3">
          <legend className="px-1 text-[11px] font-bold uppercase tracking-wide text-gray-400">Lo que la IA leería en la conversación</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {SENALES_LISTA.map(([k, t]) => (
              <label key={k} className="flex items-center gap-2 text-xs text-gray-700 min-h-[36px] cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={f.senales.includes(k)} onChange={() => alternarSenal(k)} />{t}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={simular} disabled={!!motivo || estado.tipo === "simulando"}
            className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 min-h-[44px]" style={{ background: AZUL }}>
            {estado.tipo === "simulando" ? "Simulando…" : "Simular"}
          </button>
          <button type="button" onClick={() => { setF(formVacio()); setEstado({ tipo: "nada" }); }} className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50 min-h-[44px]">Vaciar</button>
        </div>
        {motivo && <p className="text-[11px] text-gray-500">{motivo}</p>}
      </section>

      <section className="space-y-3">
        {estado.tipo === "nada" && (
          <p className="bg-white border rounded-2xl p-6 text-center text-sm text-gray-400">Arma un pedido y pulsa «Simular».</p>
        )}
        {estado.tipo === "simulando" && (
          <p className="bg-white border rounded-2xl p-6 text-center text-sm text-gray-500">Ubicando las direcciones y calculando…</p>
        )}
        {estado.tipo === "error" && (
          <p className={`rounded-2xl border p-4 text-sm ${estado.ambar ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-red-50 border-red-200 text-red-800"}`}>{estado.detalle}</p>
        )}
        {estado.tipo === "ok" && <Resultado r={estado.r} onIrAZonas={() => onIrA("zonas")} />}
      </section>
    </div>
  );
}

function Resultado({ r: { resultado: r, lugares }, onIrAZonas }: { r: Extract<RespuestaSimulador, { ok: true }>; onIrAZonas: () => void }) {
  const ins = INSIGNIA[r.accion];
  const p = r.precio;
  const veh = r.vehiculo;
  return (
    <div className="bg-white border rounded-2xl p-4 space-y-4">
      <div className={`rounded-xl border-2 px-4 py-3 ${ins.clase}`}>
        <p className="text-lg font-black">{ins.texto}</p>
        <p className="text-sm mt-1">{r.motivo}</p>
        {r.accion === "preguntar" && r.faltan.length > 0 && (
          <ul className="list-disc pl-5 mt-1 text-sm">{r.faltan.map((x) => <li key={x}>{x}</li>)}</ul>
        )}
      </div>

      {veh?.categoria && (
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Vehículo</p>
          <p className="text-sm font-bold text-gray-800">{veh.categoria.nombre}{veh.codigo === "sin_precio" ? " (sin precio en este recorrido)" : ""}</p>
          <p className="text-xs text-gray-500">{veh.detalle}</p>
          {veh.alternativas.length > 0 && <p className="text-xs text-gray-500">También {veh.alternativas.map((a) => a.nombre).join(", ")} (misma capacidad).</p>}
        </div>
      )}

      {p && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="divide-y text-sm">
            <div className="flex justify-between px-3 py-2"><span className="text-gray-500">{fmtMoneda(p.precio_tramo, p.moneda)} por tramo × {p.tramos} tramo{p.tramos === 1 ? "" : "s"}</span><span className="font-mono">{fmtMoneda(p.subtotal, p.moneda)}</span></div>
            <div className="flex justify-between px-3 py-2"><span className="text-gray-500">IGV {p.igv_pct} %</span><span className="font-mono">{fmtMoneda(p.igv, p.moneda)}</span></div>
            <div className="flex justify-between px-3 py-2 bg-gray-50 font-bold"><span>Total</span><span className="font-mono">{fmtMoneda(p.total, p.moneda)}</span></div>
          </div>
          {p.moneda === "USD" && (
            <p className="px-3 py-2 text-[11px] text-gray-500 border-t">Se guarda como {fmtMoneda(p.subtotal_pen, "PEN")} + IGV ({fmtMoneda(p.total_pen, "PEN")} con IGV) al TC {p.tipo_cambio ?? "—"} del {fmtFecha(p.tipo_cambio_fecha) || "—"}.</p>
          )}
          {p.nivel === "por_distrito" && <p className="px-3 py-2 text-[11px] text-gray-500 border-t">Precio del distrito: la subzona no tiene uno propio.</p>}
        </div>
      )}
      {r.validez_hasta && <p className="text-xs text-gray-600">Válida hasta el <b>{fmtFecha(r.validez_hasta)}</b>.</p>}

      {r.explicacion.length > 0 && (
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Paso a paso</p>
          <ol className="list-decimal pl-5 space-y-0.5 text-xs text-gray-700">{r.explicacion.map((x, i) => <li key={i}>{x}</li>)}</ol>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Ubicacion titulo="Recojo" zona={r.origen} lugar={lugares.origen} onIrAZonas={onIrAZonas} />
        <Ubicacion titulo="Destino" zona={r.destino} lugar={lugares.destino} onIrAZonas={onIrAZonas} />
      </div>
    </div>
  );
}
