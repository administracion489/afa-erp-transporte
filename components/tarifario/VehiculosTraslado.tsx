"use client";
// components/tarifario/VehiculosTraslado.tsx — Pestaña «Vehículos»: las categorías de traslado
// (traslado_categorias) con su capacidad, su bodega y su ficha de costeo, y un mini calculador.
//
// QUÉ VEHÍCULO SALE NO SE DECIDE AQUÍ: el calculador llama a `elegirVehiculo` del motor (sin
// precios), la misma función que usa el cotizador automático. La CLAVE de una categoría no se edita
// en la celda: es una identidad que llevan sus precios, sus fotos y las cotizaciones guardadas, y la
// cambia el servidor con «✎» (ModalClaveCategoria → /api/traslados/categorias/renombrar), que mueve
// todo junto.
//
// Debajo de la tabla, «📷 Fotos y descripción para la cotización» (FotosCategorias.tsx): lo que el
// cliente ve de cada vehículo en el PDF de la cotización de traslado (traslados-07).

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { elegirVehiculo } from "@/lib/traslados/motor";
import { leerEntero, normalizarClaveCategoria, type CategoriaFila } from "./traslados-pantalla";
import { filasEscritas, leerFichasCosteo, LIMITES, motivoCeroFilas, normalizarCategoria, type FichaCosteo } from "./traslados-datos";
import { AZUL, iCls, InterruptorActivo, type Decir } from "./traslados-comun";
import FotosCategorias from "./FotosCategorias";
import ModalClaveCategoria from "./ModalClaveCategoria";

const REGLA = "Se elige el vehículo más chico donde caben. Sin bodega, cada maleta de 23 kg ocupa un asiento (10 pax con maletas = 20 asientos → Sprinter 20). Con bodega, las maletas van primero ahí y solo las que sobran ocupan asiento.";

type EstadoFichas = { tipo: "cargando" } | { tipo: "ok"; fichas: FichaCosteo[] } | { tipo: "error"; detalle: string };

/** Un campo que se guarda al salir. Vuelve al valor de la base si la escritura falla. */
function Campo({ valor, onGuardar, tipo = "texto", min = 0, max = 100000, ancho = "w-full", etiqueta, ocupado }: {
  valor: string | number | null;
  onGuardar: (v: string | number | null) => Promise<boolean>;
  tipo?: "texto" | "entero";
  min?: number; max?: number;
  ancho?: string;
  etiqueta: string;
  ocupado?: boolean;
}) {
  const inicial = valor == null ? "" : String(valor);
  const [texto, setTexto] = useState(inicial);
  const [error, setError] = useState<string | null>(null);
  const salir = async () => {
    if (texto.trim() === inicial.trim()) { setTexto(inicial); setError(null); return; }
    let v: string | number | null;
    if (tipo === "entero") {
      const r = leerEntero(texto, min, max);
      if (r.tipo === "error") { setError(r.detalle); setTexto(inicial); return; }
      if (r.tipo === "vacio") { setError("Este dato es obligatorio."); setTexto(inicial); return; }
      v = r.valor;
    } else {
      v = texto.trim();
      if (!v) { setError("El nombre es obligatorio."); setTexto(inicial); return; }
    }
    setError(null);
    if (!(await onGuardar(v))) setTexto(inicial);
  };
  return (
    <div>
      <input value={texto} aria-label={etiqueta} disabled={ocupado} inputMode={tipo === "entero" ? "numeric" : undefined}
        onChange={(e) => setTexto(e.target.value)} onBlur={() => void salir()}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setTexto(inicial); (e.target as HTMLInputElement).blur(); } }}
        className={`${ancho} border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[#0b315f] ${tipo === "entero" ? "text-right font-mono" : ""}`} />
      {error && <p className="text-[10px] text-red-600 mt-0.5">{error}</p>}
    </div>
  );
}

export default function VehiculosTraslado({ categorias, onCategoria, onRenombrada, decir, colsCategoria, sinMigracionFotos }: {
  categorias: CategoriaFila[];
  onCategoria: (c: CategoriaFila) => void;
  /** La clave cambió (el servidor movió precios, fotos y cotizaciones): `de` es la vieja. */
  onRenombrada: (de: string, c: CategoriaFila) => void;
  decir: Decir;
  /** Las columnas que se piden de vuelta al escribir (sin las de traslados-07 si falta la migración). */
  colsCategoria: string;
  /** Faltan las columnas de traslados-07: sin fotos ni descripción, y se dice en ámbar. */
  sinMigracionFotos: boolean;
}) {
  const [fichas, setFichas] = useState<EstadoFichas>({ tipo: "cargando" });
  const [ocupada, setOcupada] = useState<string | null>(null);
  const [renombrar, setRenombrar] = useState<CategoriaFila | null>(null);
  const [pax, setPax] = useState("10");
  const [maletas, setMaletas] = useState("10");

  useEffect(() => {
    let vivo = true;
    void leerFichasCosteo().then((r) => { if (vivo) setFichas(r); });
    return () => { vivo = false; };
  }, []);

  const lista = useMemo(() => categorias.slice().sort((a, b) =>
    (Number(a.orden) || 0) - (Number(b.orden) || 0) || a.capacidad - b.capacidad || a.clave.localeCompare(b.clave)), [categorias]);

  const actualizar = async (c: CategoriaFila, cambios: Partial<CategoriaFila>, que: string): Promise<boolean> => {
    setOcupada(c.clave);
    // Con RLS, un UPDATE sin permiso no da error: vuelve sin filas, y `filasEscritas` lo dice.
    const r = filasEscritas<Record<string, unknown>>(await supabase.from("traslado_categorias").update(cambios).eq("clave", c.clave).select(colsCategoria), que);
    setOcupada(null);
    if (!r.ok) { decir(r.cero ? await motivoCeroFilas("traslado_categorias", "clave", c.clave, que) : r.detalle, "error"); return false; }
    onCategoria(normalizarCategoria(r.filas[0]));
    return true;
  };

  // ── Mini calculador (el motor, sin precios) ─────────────────────────────────
  const lPax = leerEntero(pax, 1, 500);
  const lMal = leerEntero(maletas, 0, 1000);
  const calculo = lPax.tipo === "ok" && lMal.tipo !== "error"
    ? elegirVehiculo(lPax.valor, lMal.tipo === "ok" ? lMal.valor : 0, categorias)
    : null;

  const opcionesFicha = (actual: string | null | undefined) => {
    if (fichas.tipo !== "ok") return null;
    const existe = !actual || fichas.fichas.some((f) => f.tipo_vehiculo === actual);
    return (
      <>
        <option value="">— sin ficha —</option>
        {!existe && <option value={actual!}>{actual} (no existe o está inactiva)</option>}
        {fichas.fichas.map((f) => <option key={f.tipo_vehiculo} value={f.tipo_vehiculo}>{f.nombre} ({f.tipo_vehiculo})</option>)}
      </>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-sky-900 bg-sky-50 border border-sky-200 rounded-xl px-4 py-3"><b>Regla:</b> {REGLA}</p>

      <section className="bg-white border rounded-2xl p-4 space-y-3">
        <h3 className="text-sm font-bold text-gray-700">🧮 ¿Qué vehículo sale?</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="block w-32">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Pasajeros</span>
            <input className={iCls("font-mono")} inputMode="numeric" value={pax} onChange={(e) => setPax(e.target.value)} />
          </label>
          <label className="block w-40">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Maletas de 23 kg</span>
            <input className={iCls("font-mono")} inputMode="numeric" value={maletas} onChange={(e) => setMaletas(e.target.value)} placeholder="0" />
          </label>
        </div>
        {lPax.tipo !== "ok" ? (
          <p className="text-xs text-gray-500">{lPax.tipo === "error" ? `Pasajeros: ${lPax.detalle}` : "Escribe cuántos pasajeros."}</p>
        ) : lMal.tipo === "error" ? (
          <p className="text-xs text-red-600">Maletas: {lMal.detalle}</p>
        ) : calculo && (
          <div className={`rounded-xl px-4 py-3 text-sm ${calculo.codigo === "ok" ? "bg-green-50 border border-green-200 text-green-900" : "bg-amber-50 border border-amber-200 text-amber-900"}`}>
            <p className="font-bold">{calculo.codigo === "ok" && calculo.categoria ? `✅ ${calculo.categoria.nombre}` : calculo.codigo === "excede_capacidad" ? "👤 No cabe en un solo vehículo: pasa a un ejecutivo" : "Sin vehículos activos"}</p>
            <p className="text-xs mt-0.5">{calculo.detalle}{lMal.tipo === "vacio" ? " (maletas vacío = 0)" : ""}</p>
            {calculo.alternativas.length > 0 && <p className="text-xs mt-0.5">Misma capacidad: también {calculo.alternativas.map((a) => a.nombre).join(", ")}.</p>}
            <p className="text-[10px] mt-1 opacity-70">Sin precios: en una cotización real, si el que cabe no tiene precio en ese recorrido, el pedido pasa a un ejecutivo (no se ofrece uno más grande).</p>
          </div>
        )}
      </section>

      {fichas.tipo === "error" && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2">No se pudieron leer las fichas de costeo ({fichas.detalle}): la columna «Ficha de costeo» muestra lo guardado y no se puede cambiar hasta recargar.</p>
      )}

      <section className="bg-white border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[52rem]">
            <thead>
              <tr className="bg-gray-50 border-b text-[11px] font-bold text-gray-500 uppercase">
                <th className="p-2 text-left" title="Identificador interno (el cliente no lo ve). Se cambia con ✎: sus precios, fotos y cotizaciones guardadas se mueven con ella.">Clave</th>
                <th className="p-2 text-left">Nombre</th>
                <th className="p-2 text-right">Asientos</th>
                <th className="p-2 text-right" title="Maletas de 23 kg que van en bodega sin ocupar asiento.">Maletas en bodega</th>
                <th className="p-2 text-left" title="La ficha de Configuración → Costos que corresponde a este vehículo.">Ficha de costeo</th>
                <th className="p-2 text-right">Orden</th>
                <th className="p-2 text-left">Activo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lista.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-gray-500 text-sm">No hay vehículos de traslado. Crea el primero abajo (AFA: <span className="font-mono">supabase/traslados-03-precios-afa.sql</span> trae los suyos).</td></tr>
              )}
              {lista.map((c) => {
                const ocupado = ocupada === c.clave;
                return (
                  <tr key={c.clave} className={c.activo === false ? "bg-gray-50 text-gray-400" : ""}>
                    <td className="p-2 font-mono text-xs text-gray-400 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        {c.clave}
                        <button type="button" onClick={() => setRenombrar(c)} disabled={ocupado} aria-label={`Cambiar la clave ${c.clave}`}
                          title="Cambiar la clave (sus precios, fotos y cotizaciones guardadas se mueven con ella)"
                          className="w-7 h-7 rounded-lg text-gray-400 hover:text-[#0b315f] hover:bg-gray-100 disabled:opacity-40">✎</button>
                      </span>
                    </td>
                    <td className="p-2 min-w-[12rem]">
                      <Campo key={`n-${c.nombre}`} valor={c.nombre} etiqueta={`Nombre de ${c.clave}`} ocupado={ocupado}
                        onGuardar={(v) => actualizar(c, { nombre: String(v) }, `No se pudo cambiar el nombre de ${c.clave}`)} />
                    </td>
                    <td className="p-2 w-24">
                      <Campo key={`c-${c.capacidad}`} valor={c.capacidad} tipo="entero" min={LIMITES.capacidad[0]} max={LIMITES.capacidad[1]} etiqueta={`Asientos de ${c.clave}`} ocupado={ocupado}
                        onGuardar={(v) => actualizar(c, { capacidad: Number(v) }, `No se pudo cambiar la capacidad de ${c.clave}`)} />
                    </td>
                    <td className="p-2 w-28">
                      <Campo key={`b-${c.maletas_bodega}`} valor={c.maletas_bodega} tipo="entero" min={LIMITES.maletas_bodega[0]} max={LIMITES.maletas_bodega[1]} etiqueta={`Maletas en bodega de ${c.clave}`} ocupado={ocupado}
                        onGuardar={(v) => actualizar(c, { maletas_bodega: Number(v) }, `No se pudo cambiar la bodega de ${c.clave}`)} />
                    </td>
                    <td className="p-2 min-w-[14rem]">
                      {fichas.tipo === "ok" ? (
                        <select value={c.tipo_vehiculo ?? ""} disabled={ocupado} aria-label={`Ficha de costeo de ${c.clave}`}
                          onChange={(e) => void actualizar(c, { tipo_vehiculo: e.target.value || null }, `No se pudo cambiar la ficha de ${c.clave}`)}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-[#0b315f]">
                          {opcionesFicha(c.tipo_vehiculo)}
                        </select>
                      ) : (
                        <span className="text-xs font-mono text-gray-500">{fichas.tipo === "cargando" ? "cargando…" : c.tipo_vehiculo ?? "—"}</span>
                      )}
                    </td>
                    <td className="p-2 w-20">
                      <Campo key={`o-${c.orden}`} valor={c.orden ?? 0} tipo="entero" min={-100000} max={100000} etiqueta={`Orden de ${c.clave}`} ocupado={ocupado}
                        onGuardar={(v) => actualizar(c, { orden: Number(v) }, `No se pudo cambiar el orden de ${c.clave}`)} />
                    </td>
                    <td className="p-2">
                      <InterruptorActivo activo={c.activo !== false} ocupado={ocupado}
                        titulo={c.activo === false ? "Inactivo: el cotizador no lo ofrece y sus precios no se muestran." : "Activo. Clic para desactivarlo (sus precios se conservan)."}
                        onCambiar={(v) => void actualizar(c, { activo: v }, `No se pudo cambiar ${c.clave}`)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <AltaCategoria categorias={categorias} fichas={fichas} onCreada={onCategoria} decir={decir} colsCategoria={colsCategoria} />
      </section>

      <FotosCategorias categorias={lista} colsCategoria={colsCategoria} sinMigracion={sinMigracionFotos} onCategoria={onCategoria} decir={decir} />

      {renombrar && (
        <ModalClaveCategoria categoria={renombrar} claves={categorias.map((c) => c.clave)} decir={decir}
          onCerrar={() => setRenombrar(null)} onRenombrada={onRenombrada} />
      )}
    </div>
  );
}

function AltaCategoria({ categorias, fichas, onCreada, decir, colsCategoria }: {
  categorias: CategoriaFila[];
  fichas: EstadoFichas;
  onCreada: (c: CategoriaFila) => void;
  decir: Decir;
  colsCategoria: string;
}) {
  const [clave, setClave] = useState("");
  const [nombre, setNombre] = useState("");
  const [cap, setCap] = useState("");
  const [bodega, setBodega] = useState("0");
  const [ficha, setFicha] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const k = normalizarClaveCategoria(clave);
  const lCap = leerEntero(cap, LIMITES.capacidad[0], LIMITES.capacidad[1]);
  const lBod = leerEntero(bodega, LIMITES.maletas_bodega[0], LIMITES.maletas_bodega[1]);
  const motivo = !k ? "Falta la clave (MAYÚSCULAS, sin espacios; p. ej. VAN_12)."
    : categorias.some((c) => c.clave === k) ? `Ya existe la clave ${k}.`
      : !nombre.trim() ? "Falta el nombre."
        : lCap.tipo !== "ok" ? `Faltan los asientos (un entero entre ${LIMITES.capacidad[0]} y ${LIMITES.capacidad[1]}).`
          : lBod.tipo === "error" ? `Maletas en bodega: ${lBod.detalle}`
            : null;

  const crear = async () => {
    if (motivo || guardando || lCap.tipo !== "ok") return;
    setGuardando(true);
    setError(null);
    const orden = Math.max(0, ...categorias.map((c) => Number(c.orden) || 0)) + 10;
    const res = await supabase.from("traslado_categorias").insert({
      clave: k, nombre: nombre.trim(), capacidad: lCap.valor, maletas_bodega: lBod.tipo === "ok" ? lBod.valor : 0,
      tipo_vehiculo: ficha || null, orden, activo: true,
    }).select(colsCategoria);
    setGuardando(false);
    if (res.error?.code === "23505") { setError(`Ya existe la clave ${k}.`); return; }
    const r = filasEscritas<Record<string, unknown>>(res, "No se pudo crear el vehículo");
    if (!r.ok) { setError(r.detalle); return; }
    onCreada(normalizarCategoria(r.filas[0]));
    decir(`Vehículo ${k} creado.`);
    setClave(""); setNombre(""); setCap(""); setBodega("0"); setFicha("");
  };

  return (
    <div className="border-t bg-gray-50 p-4 space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">＋ Nuevo vehículo de traslado</p>
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
        <label className="block sm:col-span-1">
          <span className="block text-[10px] font-bold text-gray-400 mb-1">Clave</span>
          <input className={iCls("font-mono uppercase")} value={clave} onChange={(e) => setClave(e.target.value)} placeholder="VAN_12" />
          {clave && k !== clave && <span className="block text-[10px] text-gray-400 mt-0.5">se guarda como {k || "—"}</span>}
        </label>
        <label className="block col-span-2 sm:col-span-2">
          <span className="block text-[10px] font-bold text-gray-400 mb-1">Nombre</span>
          <input className={iCls()} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Van 12 pax" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-bold text-gray-400 mb-1">Asientos</span>
          <input className={iCls("font-mono")} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-[10px] font-bold text-gray-400 mb-1">Bodega (maletas)</span>
          <input className={iCls("font-mono")} inputMode="numeric" value={bodega} onChange={(e) => setBodega(e.target.value)} />
        </label>
        <label className="block col-span-2 sm:col-span-1">
          <span className="block text-[10px] font-bold text-gray-400 mb-1">Ficha de costeo</span>
          <select className={iCls()} value={ficha} onChange={(e) => setFicha(e.target.value)} disabled={fichas.tipo !== "ok"}>
            <option value="">— sin ficha —</option>
            {fichas.tipo === "ok" && fichas.fichas.map((f) => <option key={f.tipo_vehiculo} value={f.tipo_vehiculo}>{f.nombre} ({f.tipo_vehiculo})</option>)}
          </select>
        </label>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={crear} disabled={!!motivo || guardando}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 min-h-[44px]" style={{ background: AZUL }}>
          {guardando ? "Creando…" : "＋ Agregar vehículo"}
        </button>
        {motivo && <span className="text-[11px] text-gray-500">{motivo}</span>}
      </div>
      <p className="text-[10px] text-gray-400">La clave es interna (el cliente ve el nombre). Se puede cambiar después con ✎ en la tabla: sus precios, fotos y cotizaciones guardadas se mueven con ella.</p>
    </div>
  );
}
