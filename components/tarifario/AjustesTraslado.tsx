"use client";
// components/tarifario/AjustesTraslado.tsx — Pestaña «Ajustes»: la fila única `traslados_config`
// (validez, espera gratis, consideraciones en soles y en dólares) y el tipo de cambio de SUNAT.
//
// EL TIPO DE CAMBIO NO SE ESCRIBE DESDE EL NAVEGADOR: «Actualizar ahora» llama a
// POST /api/tipo-cambio/sunat, que lo trae, lo controla y lo guarda. Aquí solo se lee, y se juzga
// con `tcParaCotizar` del motor — el mismo juicio que hace el cotizador: si aquí sale ámbar, las
// cotizaciones en dólares están pasando a un ejecutivo.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import { fechaLima } from "@/lib/alertas-horario";
import { TC_MAX_DIAS, tcParaCotizar } from "@/lib/traslados/motor";
import { fmtFecha, leerEntero, minutosQueNoCoinciden } from "./traslados-pantalla";
import { filasEscritas, leerUltimoTc, LIMITES, normalizarConfig, type ConfigFila, type LecturaTc } from "./traslados-datos";
import { AZUL, iCls, type Decir } from "./traslados-comun";

const hoyLimaIso = () => fechaLima(Date.now());

/** Lista editable de textos: editar, subir, bajar, quitar, agregar. */
function ListaTextos({ items, onCambiar, placeholder, etiqueta }: {
  items: string[]; onCambiar: (n: string[]) => void; placeholder: string; etiqueta: string;
}) {
  const [nuevo, setNuevo] = useState("");
  const mover = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const n = items.slice();
    [n[i], n[j]] = [n[j], n[i]];
    onCambiar(n);
  };
  const agregar = () => { const t = nuevo.trim(); if (!t) return; onCambiar([...items, t]); setNuevo(""); };
  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="text-xs text-gray-400 italic">Ninguna.</p>}
      {items.map((t, i) => (
        <div key={i} className="flex gap-1.5 items-start">
          <span className="text-xs text-gray-400 font-bold pt-2.5 w-4 text-right">{i + 1}.</span>
          <textarea value={t} rows={2} aria-label={`${etiqueta} ${i + 1}`}
            onChange={(e) => onCambiar(items.map((x, k) => (k === i ? e.target.value : x)))}
            className={iCls("flex-1 py-2 text-xs")} />
          <div className="flex flex-col gap-0.5">
            <button type="button" onClick={() => mover(i, -1)} disabled={i === 0} aria-label="Subir" className="w-8 h-7 rounded-lg border text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30">↑</button>
            <button type="button" onClick={() => mover(i, 1)} disabled={i === items.length - 1} aria-label="Bajar" className="w-8 h-7 rounded-lg border text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30">↓</button>
          </div>
          <button type="button" onClick={() => onCambiar(items.filter((_, k) => k !== i))} aria-label="Quitar"
            className="w-8 h-8 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 text-sm mt-1">✕</button>
        </div>
      ))}
      <div className="flex gap-2">
        <input value={nuevo} onChange={(e) => setNuevo(e.target.value)} placeholder={placeholder} aria-label={`Agregar ${etiqueta}`}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); agregar(); } }} className={iCls("flex-1 text-xs")} />
        <button type="button" onClick={agregar} disabled={!nuevo.trim()} className="px-3 py-2 rounded-xl text-xs font-bold border text-gray-600 hover:bg-gray-50 disabled:opacity-40 min-h-[40px]">＋ Agregar</button>
      </div>
      {nuevo.trim() && <p className="text-[10px] text-amber-700">Hay un texto escrito sin agregar: pulsa «＋ Agregar» (o Enter) antes de guardar.</p>}
    </div>
  );
}

export default function AjustesTraslado({ config, configExiste, onConfig, decir }: {
  config: ConfigFila;
  configExiste: boolean;
  onConfig: (c: ConfigFila) => void;
  decir: Decir;
}) {
  const [validez, setValidez] = useState(String(config.validez_dias));
  const [espera, setEspera] = useState(String(config.espera_gratis_min));
  const [cons, setCons] = useState<string[]>(config.consideraciones);
  const [consUsd, setConsUsd] = useState<string[]>(config.consideraciones_usd);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lVal = leerEntero(validez, LIMITES.validez_dias[0], LIMITES.validez_dias[1]);
  const lEsp = leerEntero(espera, LIMITES.espera_gratis_min[0], LIMITES.espera_gratis_min[1]);
  const limpias = (l: string[]) => l.map((x) => x.trim()).filter(Boolean);
  const sucio = validez !== String(config.validez_dias) || espera !== String(config.espera_gratis_min)
    || JSON.stringify(limpias(cons)) !== JSON.stringify(config.consideraciones)
    || JSON.stringify(limpias(consUsd)) !== JSON.stringify(config.consideraciones_usd);
  const motivo = lVal.tipo !== "ok" ? `Validez: un número entero de días entre ${LIMITES.validez_dias[0]} y ${LIMITES.validez_dias[1]}.`
    : lEsp.tipo !== "ok" ? `Espera gratis: un número entero de minutos entre ${LIMITES.espera_gratis_min[0]} y ${LIMITES.espera_gratis_min[1]}.`
      : !sucio ? "No hay cambios." : null;
  const minutosDistintos = lEsp.tipo === "ok" ? minutosQueNoCoinciden([...cons, ...consUsd], lEsp.valor) : [];

  const descartar = () => {
    setValidez(String(config.validez_dias)); setEspera(String(config.espera_gratis_min));
    setCons(config.consideraciones); setConsUsd(config.consideraciones_usd); setError(null);
  };

  const guardar = async () => {
    if (motivo || guardando || lVal.tipo !== "ok" || lEsp.tipo !== "ok") return;
    setGuardando(true);
    setError(null);
    const fila = { id: 1, validez_dias: lVal.valor, espera_gratis_min: lEsp.valor, consideraciones: limpias(cons), consideraciones_usd: limpias(consUsd) };
    // Con RLS, el lado «update» de un upsert sin permiso no da error: vuelve sin filas.
    const r = filasEscritas<Record<string, unknown>>(
      await supabase.from("traslados_config").upsert(fila, { onConflict: "id" }).select("id, validez_dias, espera_gratis_min, consideraciones, consideraciones_usd"),
      "No se guardaron los ajustes");
    setGuardando(false);
    if (!r.ok) { setError(r.detalle); return; }
    const c = normalizarConfig(r.filas[0]);
    onConfig(c);
    setCons(c.consideraciones); setConsUsd(c.consideraciones_usd);
    decir("Ajustes guardados.");
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_22rem] gap-4 items-start">
      <section className="bg-white border rounded-2xl p-4 space-y-4">
        {!configExiste && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">La fila de ajustes no existe todavía: se usan los valores por defecto (30 días, 30 minutos, sin consideraciones). Al guardar se crea.</p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Validez de la cotización (días)</span>
            <input className={iCls("font-mono")} inputMode="numeric" value={validez} onChange={(e) => setValidez(e.target.value)} />
            <span className="block text-[10px] text-gray-400 mt-0.5">Vale esos días o hasta la fecha del servicio, lo que llegue primero ({LIMITES.validez_dias[0]}–{LIMITES.validez_dias[1]}).</span>
          </label>
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Espera gratis (minutos)</span>
            <input className={iCls("font-mono")} inputMode="numeric" value={espera} onChange={(e) => setEspera(e.target.value)} />
            <span className="block text-[10px] text-gray-400 mt-0.5">Minutos de espera incluidos en el traslado ({LIMITES.espera_gratis_min[0]}–{LIMITES.espera_gratis_min[1]}).</span>
          </label>
        </div>
        {minutosDistintos.length > 0 && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            Las consideraciones hablan de {minutosDistintos.map((m) => `${m} min`).join(", ")} y la espera gratis dice {espera} min: la cotización diría dos cosas distintas. Corrige el texto o el número.
          </p>
        )}
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Consideraciones (van en toda cotización de traslado)</p>
          <ListaTextos items={cons} onCambiar={setCons} etiqueta="Consideración" placeholder="Ej: Sujeto a disponibilidad: un ejecutivo confirma la reserva." />
        </div>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Consideraciones solo para dólares (se agregan cuando se cotiza en US$)</p>
          <ListaTextos items={consUsd} onCambiar={setConsUsd} etiqueta="Consideración en dólares" placeholder="Ej: El IGV se exonera solo con TAM y pasaporte." />
        </div>
        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={guardar} disabled={!!motivo || guardando}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 min-h-[44px]" style={{ background: AZUL }}>
            {guardando ? "Guardando…" : "Guardar ajustes"}
          </button>
          {sucio && <button type="button" onClick={descartar} disabled={guardando} className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50 min-h-[44px]">Descartar cambios</button>}
          {motivo && <span className="text-[11px] text-gray-500">{motivo}</span>}
        </div>
      </section>

      <TipoCambioSunat decir={decir} />
    </div>
  );
}

function TipoCambioSunat({ decir }: { decir: Decir }) {
  const [hoy] = useState(hoyLimaIso);
  const [lectura, setLectura] = useState<LecturaTc | null>(null);
  const [n, setN] = useState(0);
  const [actualizando, setActualizando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void leerUltimoTc(hoy).then((r) => { if (vivo) setLectura(r); });
    return () => { vivo = false; };
  }, [hoy, n]);

  const actualizar = async () => {
    setActualizando(true);
    setError(null);
    try {
      const res = await fetch("/api/tipo-cambio/sunat", { method: "POST", headers: await cabecerasErp() });
      const d = (await res.json().catch(() => null)) as { ok?: boolean; detalle?: string; error?: string; fecha?: string; venta?: number } | null;
      if (res.status === 401) setError("Tu sesión venció o no se pudo verificar: vuelve a ingresar.");
      else if (res.status === 403) setError(/origen/i.test(d?.error ?? "") ? "El servidor rechazó la llamada (origen no permitido)." : "Te falta el permiso del módulo Tarifas (o Cotizaciones) para actualizar el tipo de cambio.");
      else if (res.status === 404) setError("La actualización todavía no está desplegada en el servidor (/api/tipo-cambio/sunat).");
      else if (!d?.ok) setError(d?.detalle || `SUNAT no respondió bien (error ${res.status}).`);
      else decir(`Tipo de cambio del ${fmtFecha(d.fecha)}: venta ${d.venta}.`);
    } catch (e) {
      setError(`No se pudo llamar al servidor: ${(e as Error)?.message ?? "sin conexión"}.`);
    }
    setActualizando(false);
    setLectura(null);
    setN((x) => x + 1);
  };

  const fila = lectura?.tipo === "ok" ? lectura.fila : null;
  const juicio = lectura?.tipo === "ok" ? tcParaCotizar(fila, hoy) : null;
  const ambar = !!juicio && juicio.codigo !== "ok";

  return (
    <section className={`border rounded-2xl p-4 space-y-3 ${ambar ? "bg-amber-50 border-amber-200" : "bg-white"}`}>
      <h3 className="text-sm font-bold text-gray-700">💱 Tipo de cambio SUNAT</h3>
      {lectura == null ? (
        <p className="text-xs text-gray-400">Comprobando el último tipo de cambio…</p>
      ) : lectura.tipo === "sin_tabla" ? (
        <p className="text-xs text-amber-800">No existe la tabla <span className="font-mono">tipo_cambio</span> en la base: sin tipo de cambio, las cotizaciones en dólares pasan al ejecutivo.</p>
      ) : lectura.tipo === "error" ? (
        <p className="text-xs text-red-700">No se pudo leer el tipo de cambio: {lectura.detalle}</p>
      ) : !fila ? (
        <p className="text-xs text-amber-800 font-bold">No hay ningún tipo de cambio cargado: sin tipo de cambio, las cotizaciones en dólares pasan al ejecutivo.</p>
      ) : (
        <div className="space-y-1">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-gray-500">Fecha</dt><dd className="font-bold">{fmtFecha(fila.fecha)}</dd>
            <dt className="text-gray-500">Compra</dt><dd className="font-mono">{fila.compra ?? "—"}</dd>
            <dt className="text-gray-500">Venta</dt><dd className="font-mono font-bold">{fila.venta ?? "—"}</dd>
            <dt className="text-gray-500">Fuente</dt><dd className="text-xs">{fila.fuente ?? "—"}</dd>
          </dl>
          {ambar && juicio && (
            <p className="text-xs text-amber-800 font-bold">{juicio.detalle} Sin tipo de cambio vigente (de los últimos {TC_MAX_DIAS} días), las cotizaciones en dólares pasan al ejecutivo.</p>
          )}
          {!ambar && <p className="text-[10px] text-gray-400">El cotizador usa la venta. Un tipo de cambio de más de {TC_MAX_DIAS} días no se usa.</p>}
        </div>
      )}
      {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
      <button type="button" onClick={actualizar} disabled={actualizando}
        className="px-4 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 min-h-[44px] w-full" style={{ background: AZUL }}>
        {actualizando ? "Consultando SUNAT…" : "↻ Actualizar ahora"}
      </button>
      <p className="text-[10px] text-gray-400">Lo trae el servidor de SUNAT; también se actualiza solo una vez al día.</p>
    </section>
  );
}
