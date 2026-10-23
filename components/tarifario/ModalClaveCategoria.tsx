"use client";
// components/tarifario/ModalClaveCategoria.tsx — «✎ Cambiar la clave» de un vehículo de traslado
// (VAN_15 → VAN_17). Lo hace el servidor (POST /api/traslados/categorias/renombrar): mueve sus
// precios, sus fotos y las cotizaciones guardadas que la nombran. La pantalla enseña ANTES qué va a
// pasar (GET del mismo endpoint) y la revisión de la clave tecleada sale del MISMO motor que usa el
// servidor (`revisarRenombre`, lib/traslados/renombrar-categoria.ts).

import { useEffect, useState } from "react";
import { cabecerasErp } from "@/lib/fetch-erp";
import { frasesPlan, revisarRenombre, type PreviaRenombre } from "@/lib/traslados/renombrar-categoria";
import type { RenombrePendiente, ResultadoRenombre } from "@/lib/traslados/renombrar-categoria-datos";
import type { CategoriaFila } from "./traslados-pantalla";
import { normalizarCategoria } from "./traslados-datos";
import { AZUL, iCls, Modal, type Decir } from "./traslados-comun";

const URL_API = "/api/traslados/categorias/renombrar";

type EstadoPrevia = { tipo: "cargando" } | { tipo: "ok"; previa: PreviaRenombre; pendientes: RenombrePendiente[] } | { tipo: "error"; detalle: string };

export default function ModalClaveCategoria({ categoria, claves, onCerrar, onRenombrada, decir }: {
  categoria: CategoriaFila;
  /** Las claves que existen hoy (para avisar antes de enviar si la nueva ya está tomada). */
  claves: readonly string[];
  onCerrar: () => void;
  /** El cambio entró: `de` es la clave vieja y `fila` la categoría con la nueva. */
  onRenombrada: (de: string, fila: CategoriaFila) => void;
  decir: Decir;
}) {
  const de = categoria.clave;
  const [texto, setTexto] = useState("");
  const [previa, setPrevia] = useState<EstadoPrevia>({ tipo: "cargando" });
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Quedó hecho pero con cotizaciones pendientes: el botón pasa a «Reintentar». */
  const [pendiente, setPendiente] = useState<{ de: string; a: string; detalle: string } | null>(null);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const res = await fetch(`${URL_API}?clave=${encodeURIComponent(de)}`, { headers: await cabecerasErp() });
        const j = await res.json().catch(() => null);
        if (!vivo) return;
        if (!res.ok || !j?.ok) { setPrevia({ tipo: "error", detalle: j?.detalle || `No se pudo comprobar ${de} (${res.status}).` }); return; }
        const pendientes = (Array.isArray(j.pendientes) ? j.pendientes : []) as RenombrePendiente[];
        setPrevia({ tipo: "ok", previa: { tarifas: j.tarifas ?? null, fotos: Number(j.fotos) || 0, cotizaciones: j.cotizaciones ?? null }, pendientes });
        // Un cambio anterior hacia esta clave dejó cotizaciones con la vieja: se ofrece terminarlo.
        if (pendientes[0]) setPendiente({ de: pendientes[0].de, a: de, detalle: `Un cambio de clave anterior (${pendientes[0].de} → ${de}) dejó ${pendientes[0].cotizaciones === 1 ? "1 cotización guardada" : `${pendientes[0].cotizaciones} cotizaciones guardadas`} con ${pendientes[0].de}: su PDF saldría sin las fotos del vehículo. Pulsa «Terminar» para pasarlas a ${de}.` });
      } catch {
        if (vivo) setPrevia({ tipo: "error", detalle: "No se pudo contactar al servidor para comprobar la categoría." });
      }
    })();
    return () => { vivo = false; };
  }, [de]);

  const rev = revisarRenombre(de, texto, claves);
  const plan = rev.ok && previa.tipo === "ok" ? frasesPlan(de, rev.a, previa.previa) : null;

  const enviar = async (cuerpo: Record<string, unknown>): Promise<ResultadoRenombre | null> => {
    setEnviando(true);
    setError(null);
    try {
      const res = await fetch(URL_API, { method: "POST", headers: await cabecerasErp(), body: JSON.stringify(cuerpo) });
      const j = (await res.json().catch(() => null)) as (ResultadoRenombre & { detalle?: string }) | null;
      if (!res.ok || !j?.ok) {
        setError(j?.detalle || (res.status === 404 ? "El cambio de clave todavía no está desplegado en el servidor." : `No se pudo cambiar la clave (${res.status}).`));
        return null;
      }
      return j;
    } catch {
      setError("No se pudo contactar al servidor: recarga la pantalla (↻ Recargar) para ver cómo quedó antes de repetirlo.");
      return null;
    } finally {
      setEnviando(false);
    }
  };

  const cambiar = async () => {
    if (!rev.ok || enviando) return;
    const lineas = plan ?? ["Sus precios, sus fotos y las cotizaciones guardadas que la usan pasan a la clave nueva."];
    if (!confirm(`¿Cambiar la clave ${de} por ${rev.a}?\n\n• ${lineas.join("\n• ")}`)) return;
    const r = await enviar({ de, a: texto });
    if (!r) return;
    if (r.categoria) onRenombrada(de, normalizarCategoria(r.categoria));
    const partes = [`Clave cambiada: ${de} → ${r.a}.`];
    if (r.tarifas != null) partes.push(`${r.tarifas} precio(s) con ${r.a}.`);
    if (r.fotos_movidas) partes.push(`${r.fotos_movidas} foto(s) movida(s).`);
    if (r.cotizaciones) partes.push(`${r.cotizaciones} cotización(es) actualizada(s).`);
    if (r.codigo === "parcial") { setPendiente({ de, a: r.a, detalle: r.detalle }); decir(partes.join(" "), "info"); return; }
    decir(partes.join(" "));
    onCerrar();
  };

  const reintentar = async () => {
    if (!pendiente || enviando) return;
    const r = await enviar({ de: pendiente.de, a: pendiente.a, completar: true });
    if (!r) return;
    if (r.codigo === "parcial") { setPendiente({ ...pendiente, detalle: r.detalle }); return; }
    decir(`Listo: ${r.cotizaciones} cotización(es) más pasaron de ${pendiente.de} a ${pendiente.a}.`);
    onCerrar();
  };

  return (
    <Modal titulo={<>Cambiar la clave de <span className="font-mono">{de}</span></>} onCerrar={onCerrar} bloqueado={enviando} ancho="max-w-lg">
      <p className="text-xs text-gray-600">
        La clave es <b>interna</b>: el cliente nunca la ve. El PDF de la cotización, el mensaje de la IA y el simulador usan el <b>nombre</b> («{categoria.nombre}»), que se cambia directamente en la tabla.
      </p>

      {pendiente ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-2">
          <p>{pendiente.detalle}</p>
          <button type="button" onClick={reintentar} disabled={enviando}
            className="px-4 py-2 rounded-xl text-xs font-bold border border-amber-400 hover:bg-amber-100 disabled:opacity-50 min-h-[40px]">
            {enviando ? "Terminando…" : pendiente.a === de ? "↻ Terminar" : "↻ Reintentar"}
          </button>
        </div>
      ) : (
        <>
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Clave nueva</span>
            <input autoFocus className={iCls("font-mono uppercase")} value={texto} onChange={(e) => { setTexto(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void cambiar(); }} placeholder="VAN_17" disabled={enviando} />
            {texto && rev.a !== texto && rev.a && <span className="block text-[10px] text-gray-400 mt-0.5">se guarda como {rev.a}</span>}
            {texto && !rev.ok && <span className="block text-[11px] text-gray-500 mt-1">{rev.detalle}</span>}
          </label>

          <div className="rounded-xl border bg-gray-50 px-4 py-3 text-xs text-gray-700 space-y-1">
            <p className="font-bold text-gray-500 uppercase text-[10px] tracking-wide">Qué pasa al cambiarla</p>
            {previa.tipo === "cargando" && <p className="text-gray-400">Comprobando precios, fotos y cotizaciones de {de}…</p>}
            {previa.tipo === "error" && <p className="text-amber-800">{previa.detalle} El cambio se puede hacer igual: sus precios, fotos y cotizaciones guardadas se mueven con la clave.</p>}
            {previa.tipo === "ok" && (plan
              ? <ul className="list-disc pl-4 space-y-0.5">{plan.map((l) => <li key={l}>{l}</li>)}</ul>
              : <ul className="list-disc pl-4 space-y-0.5">{frasesPlan(de, "la clave nueva", previa.previa).map((l) => <li key={l}>{l}</li>)}</ul>)}
          </div>

          {error && <p className="text-sm text-red-700">{error}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={cambiar} disabled={!rev.ok || enviando || previa.tipo === "cargando"}
              className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 min-h-[44px]" style={{ background: AZUL }}>
              {enviando ? "Cambiando…" : rev.ok ? `Cambiar a ${rev.a}` : "Cambiar la clave"}
            </button>
            <button type="button" onClick={onCerrar} disabled={enviando} className="px-4 py-2.5 rounded-xl text-sm font-bold text-gray-500 hover:bg-gray-100 min-h-[44px]">Cancelar</button>
          </div>
        </>
      )}
    </Modal>
  );
}
