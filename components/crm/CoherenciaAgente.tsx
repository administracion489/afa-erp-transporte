"use client";
// /crm/agente → el panel de choques de la configuración del agente IA (y sus avisos en línea).
//
// LA PANTALLA NO DECIDE NADA: qué choca, con qué gravedad, qué ajuste manda y cómo se arregla lo
// dice el motor PURO lib/crm-ia-coherencia.ts (`auditarAgente`). Aquí solo se pinta y se navega:
//  · «Ver la frase» lleva a la pestaña del texto, enfoca el campo y selecciona la cita.
//  · «Ir al ajuste» lleva a Ajustes y resalta el control (su `id` es el `ancla` del motor).
//  · La propuesta («Poner el ajuste en …») solo cambia el FORMULARIO; guardar sigue siendo del dueño.
// NUNCA hay un botón que edite el texto del dueño: la frase la corrige él, o cambia el ajuste.
//
// Los avisos en línea (bajo cada texto y en cada ajuste contradicho) leen el MISMO resultado por un
// contexto, para que el panel, las pestañas y los campos cuenten lo mismo.
import React, { createContext, useContext, useState } from "react";
import { TEMAS_AJUSTE, type TemaAjusteConAjuste } from "@/lib/crm-ia-ajustes";
import {
  TEMAS_COHERENCIA, claveHallazgo,
  type CampoTexto, type Hallazgo, type ResultadoAuditoria, type TemaAjuste,
} from "@/lib/crm-ia-coherencia";

export type AccionesCoherencia = {
  /** Va a la pestaña del campo, lo enfoca y selecciona la cita (si no la encuentra, solo enfoca). */
  verFrase: (campo: CampoTexto, cita: string, indice?: number) => void;
  /** Va a Ajustes, lleva el control a la vista y lo resalta. */
  irAjuste: (ancla: string) => void;
  /** Pone el ajuste en el valor que propone el motor (solo el formulario: no guarda). */
  aplicarPropuesta: (h: Hallazgo) => void;
};

type Ctx = AccionesCoherencia & { hallazgos: Hallazgo[] };
const Contexto = createContext<Ctx | null>(null);

export function ProveedorCoherencia({
  resultado, acciones, children,
}: { resultado: ResultadoAuditoria | null; acciones: AccionesCoherencia; children: React.ReactNode }) {
  const valor: Ctx = { ...acciones, hallazgos: resultado?.hallazgos ?? [] };
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

// ── Piezas ────────────────────────────────────────────────────────────────────────────────────────

/** Los temas sin ajuste no están en TEMAS_AJUSTE: solo necesitan un nombre para agrupar. */
const NOMBRE_TEMA_SIN_AJUSTE: Record<Exclude<TemaAjuste, TemaAjusteConAjuste>, string> = {
  seguimiento: "Recordatorios y seguimientos",
  llamada: "Llamadas por teléfono",
  traslados: "Cotizador de traslados",
};
const nombreTema = (t: TemaAjuste): string =>
  t in TEMAS_AJUSTE ? TEMAS_AJUSTE[t as TemaAjusteConAjuste].etiqueta : NOMBRE_TEMA_SIN_AJUSTE[t as keyof typeof NOMBRE_TEMA_SIN_AJUSTE];

/** «Manda» solo cuando el ajuste decide de verdad; con el ajuste apagado o sin declarar, manda el
 *  texto (o nadie), y entonces el ajuste solo se nombra. La relación la declara el motor. */
const rotuloAjuste = (h: Hallazgo) =>
  h.relacion === "contradice" || h.relacion === "plantilla" || h.relacion === "duplica" ? "Manda" : "Ajuste";

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

const btnPrimario = "text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-[#0b315f] text-white hover:bg-[#1262bd] min-h-[32px]";
const btnSecundario = "text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 min-h-[32px]";

function Cita({ texto, etiqueta }: { texto: string; etiqueta: string }) {
  return (
    <p className="text-xs text-gray-700 mt-1 break-words">
      <span className="italic">«{texto}»</span>
      <span className="text-gray-400"> — {etiqueta}</span>
    </p>
  );
}

function Tarjeta({ h }: { h: Hallazgo }) {
  const acc = useContext(Contexto);
  if (!acc) return null;
  const otra = h.otra;
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${h.alarma ? "border-amber-200 bg-white" : "border-gray-200 bg-white"}`}>
      <p className={`text-sm font-semibold ${h.alarma ? "text-amber-900" : "text-gray-700"}`}>{h.titulo}</p>
      <Cita texto={h.cita} etiqueta={h.etiquetaCampo} />
      {otra && <Cita texto={otra.cita} etiqueta={otra.etiquetaCampo} />}
      {h.ajuste && (
        <p className="text-xs text-gray-700 mt-1">
          <b>{rotuloAjuste(h)}:</b> {h.ajuste.etiqueta} = {h.ajuste.valorLegible}
        </p>
      )}
      <p className="text-xs text-gray-500 mt-1">{h.arreglo}</p>
      <div className="flex flex-wrap gap-2 mt-2">
        {h.campo && (
          <button type="button" className={btnSecundario} onClick={() => acc.verFrase(h.campo!, h.cita, h.indice)}>
            Ver la frase
          </button>
        )}
        {otra && (
          <button type="button" className={btnSecundario} onClick={() => acc.verFrase(otra.campo, otra.cita, otra.indice)}>
            Ver la otra frase
          </button>
        )}
        {h.ajuste && (
          <button type="button" className={btnSecundario} onClick={() => acc.irAjuste(h.ajuste!.ancla)}>
            Ir al ajuste
          </button>
        )}
        {h.propuesta && (
          <button type="button" className={btnPrimario} onClick={() => acc.aplicarPropuesta(h)}>
            Poner el ajuste en «{h.propuesta.etiqueta}»
          </button>
        )}
      </div>
    </div>
  );
}

/** Agrupa por tema en el orden del motor (TEMAS_COHERENCIA), conservando el orden de los hallazgos. */
function porTema(lista: Hallazgo[]): [TemaAjuste, Hallazgo[]][] {
  return TEMAS_COHERENCIA
    .map((t) => [t, lista.filter((h) => h.tema === t)] as [TemaAjuste, Hallazgo[]])
    .filter(([, hs]) => hs.length > 0);
}

function Grupos({ lista }: { lista: Hallazgo[] }) {
  return (
    <div className="space-y-3">
      {porTema(lista).map(([tema, hs]) => (
        <div key={tema}>
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">{nombreTema(tema)}</p>
          <div className="space-y-2">
            {hs.map((h) => <Tarjeta key={claveHallazgo(h)} h={h} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

const CLAVE_ABIERTO = "crm_agente_coherencia_abierto";

// ── El panel (entre la cabecera y las pestañas) ───────────────────────────────────────────────────

export default function CoherenciaAgente({ resultado }: { resultado: ResultadoAuditoria | null }) {
  // Preferencia de quien mira (plegar el panel): solo en este navegador, y si no se puede leer, abierto.
  // La página solo pinta el panel después de cargar el agente, así que no hay hidratación que cuidar.
  const [abierto, setAbierto] = useState(() => {
    try { return window.localStorage.getItem(CLAVE_ABIERTO) !== "0"; } catch { return true; }
  });
  const alternar = () => {
    const nuevo = !abierto;
    setAbierto(nuevo);
    try { window.localStorage.setItem(CLAVE_ABIERTO, nuevo ? "1" : "0"); } catch { /* da igual */ }
  };

  const hallazgos = resultado?.hallazgos ?? [];
  if (hallazgos.length === 0) return null;
  const alarmas = hallazgos.filter((h) => h.alarma);
  const grises = hallazgos.filter((h) => !h.alarma);
  const repiten = grises.filter((h) => h.relacion === "duplica").length;
  const informan = grises.length - repiten;

  const partesGris = [
    repiten ? `${plural(repiten, "frase repite", "frases repiten")} un ajuste (no hace falta cambiarlas, pero si cambias el ajuste quedarán contradiciéndolo)` : "",
    informan ? `${plural(informan, "aviso informativo", "avisos informativos")} (no cambian lo que hace la IA)` : "",
  ].filter(Boolean);

  const bloqueGris = grises.length > 0 && (
    <details className="group rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
      <summary className="cursor-pointer text-xs text-gray-600 select-none">
        <span className="group-open:hidden">▸</span><span className="hidden group-open:inline">▾</span> {partesGris.join(" · ")}
      </summary>
      <div className="mt-2">
        <Grupos lista={grises} />
      </div>
    </details>
  );

  if (alarmas.length === 0) return <div className="mb-4">{bloqueGris}</div>;

  return (
    <div className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-amber-900">
            ⚠ {plural(alarmas.length, "choque", "choques")} en la configuración del agente: la IA sigue el ajuste
          </p>
          <p className="text-xs text-amber-800 mt-0.5">
            Puedes guardar igual. Corrige la frase de tu texto o cambia el ajuste para que digan lo mismo.
          </p>
        </div>
        <button type="button" onClick={alternar} className="text-xs font-semibold text-amber-900 underline min-h-[32px] shrink-0">
          {abierto ? "Ocultar" : "Ver los choques"}
        </button>
      </div>
      {abierto && (
        <div className="mt-3 max-h-[60vh] overflow-y-auto pr-1 space-y-3">
          <Grupos lista={alarmas} />
          {bloqueGris}
        </div>
      )}
    </div>
  );
}

// ── Avisos en línea ───────────────────────────────────────────────────────────────────────────────

/** Bajo un texto del dueño: «⚠ N frases chocan con los ajustes · ver». Cuenta las ALARMAS cuya frase
 *  (o la otra frase, en un choque entre dos textos) está en este campo — en un objetivo, en ese. */
export function AvisoCampo({ campo, indice }: { campo: CampoTexto; indice?: number }) {
  const ctx = useContext(Contexto);
  const [abierto, setAbierto] = useState(false);
  if (!ctx) return null;
  const esAqui = (c: CampoTexto | null | undefined, i: number | undefined) => c === campo && (indice == null || i === indice);
  const lista = ctx.hallazgos.filter((h) => h.alarma && (esAqui(h.campo, h.indice) || (h.otra != null && esAqui(h.otra.campo, h.otra.indice))));
  if (lista.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p className="text-xs text-amber-800">
        ⚠ {plural(lista.length, "frase choca", "frases chocan")} con los ajustes ·{" "}
        <button type="button" className="font-semibold underline" onClick={() => setAbierto((v) => !v)}>
          {abierto ? "ocultar" : "ver"}
        </button>
      </p>
      {abierto && (
        <div className="mt-2 space-y-2">
          {lista.map((h) => <Tarjeta key={claveHallazgo(h)} h={h} />)}
        </div>
      )}
    </div>
  );
}

/** En un ajuste contradicho: qué frase dice otra cosa y que manda el ajuste. Solo ALARMAS. */
export function AvisosAjuste({ ancla }: { ancla: string }) {
  const ctx = useContext(Contexto);
  if (!ctx) return null;
  const lista = ctx.hallazgos.filter((h) => h.alarma && h.ajuste?.ancla === ancla);
  if (lista.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {lista.map((h) => {
        const directo = h.campo != null && !h.otra && (h.relacion === "contradice" || h.relacion === "plantilla");
        return (
          <div key={claveHallazgo(h)} className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
            {directo ? (
              <p>
                ⚠ Tu texto dice otra cosa: <span className="italic">«{h.cita}»</span> ({h.etiquetaCampo}). Manda este ajuste.
              </p>
            ) : (
              <>
                <p>
                  ⚠ <b>{h.titulo}</b>: <span className="italic">«{h.cita}»</span> ({h.etiquetaCampo})
                  {h.otra && <> y <span className="italic">«{h.otra.cita}»</span> ({h.otra.etiquetaCampo})</>}.
                </p>
                <p className="text-amber-800 mt-0.5">{h.arreglo}</p>
              </>
            )}
            {(h.campo || h.otra || h.propuesta) && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                {h.campo && (
                  <button type="button" className="font-semibold underline min-h-[28px]" onClick={() => ctx.verFrase(h.campo!, h.cita, h.indice)}>
                    Ver la frase
                  </button>
                )}
                {h.otra && (
                  <button type="button" className="font-semibold underline min-h-[28px]" onClick={() => ctx.verFrase(h.otra!.campo, h.otra!.cita, h.otra!.indice)}>
                    Ver la otra frase
                  </button>
                )}
                {h.propuesta && (
                  <button type="button" className="font-semibold underline min-h-[28px]" onClick={() => ctx.aplicarPropuesta(h)}>
                    Poner el ajuste en «{h.propuesta.etiqueta}»
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Navegación: encontrar la frase y resaltar el ajuste (DOM, sin lógica de choques) ──────────────

/** El `id` de cada texto del dueño en la pantalla. En un objetivo, el título o las instrucciones. */
export function idCampo(campo: CampoTexto, indice?: number, parte: "titulo" | "instrucciones" = "instrucciones"): string {
  return campo === "goals" ? `campo-goals-${indice ?? 0}-${parte}` : `campo-${campo}`;
}

const escaparRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Dónde está la cita dentro del valor del campo. Una cita cortada («…») se busca por su comienzo y
 *  se extiende hasta el fin de esa oración o de la línea. Si no está tal cual, se busca ignorando
 *  cómo van los espacios. null si no aparece (el texto cambió desde la auditoría). */
export function rangoDeCita(valor: string, cita: string): [number, number] | null {
  const cortada = cita.endsWith("…");
  const base = (cortada ? cita.slice(0, -1) : cita).trim();
  if (!base) return null;
  let inicio = valor.indexOf(base);
  let fin = inicio + base.length;
  if (inicio < 0) {
    const m = new RegExp(base.split(/\s+/).map(escaparRe).join("\\s+")).exec(valor);
    if (!m) return null;
    inicio = m.index;
    fin = m.index + m[0].length;
  }
  if (cortada) {
    const resto = valor.slice(fin);
    const m = /^[^\n]*?[.!?…](?=\s|$)/.exec(resto) ?? /^[^\n]*/.exec(resto);
    fin += m ? m[0].length : 0;
  }
  return [inicio, fin];
}

type Campo = HTMLTextAreaElement | HTMLInputElement;

/** Enfoca el campo y selecciona la cita (si no la encuentra, solo enfoca el primero). */
export function enfocarFrase(campo: CampoTexto, cita: string, indice?: number): void {
  const ids = campo === "goals" ? [idCampo(campo, indice, "instrucciones"), idCampo(campo, indice, "titulo")] : [idCampo(campo)];
  const els = ids
    .map((id) => document.getElementById(id))
    .filter((e): e is Campo => e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement);
  if (els.length === 0) return;
  for (const el of els) {
    const r = rangoDeCita(el.value, cita);
    if (!r) continue;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
    // Una aproximación del scroll interno de un texto largo; el navegador termina de ajustarlo al
    // poner la selección.
    if (el instanceof HTMLTextAreaElement && el.scrollHeight > el.clientHeight) {
      el.scrollTop = Math.max(0, (r[0] / Math.max(1, el.value.length)) * el.scrollHeight - el.clientHeight / 3);
    }
    el.setSelectionRange(r[0], r[1]);
    return;
  }
  els[0].scrollIntoView({ block: "center", behavior: "smooth" });
  els[0].focus({ preventScroll: true });
}

const RESALTE = ["ring-4", "ring-amber-300", "ring-offset-2", "transition-shadow"];
const temporizadores = new WeakMap<HTMLElement, number>();

/** Lleva el control del ajuste a la vista y lo resalta 2 s. */
export function resaltarAjuste(ancla: string): void {
  const el = document.getElementById(ancla);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add(...RESALTE);
  const previo = temporizadores.get(el);
  if (previo) window.clearTimeout(previo);
  temporizadores.set(el, window.setTimeout(() => {
    el.classList.remove(...RESALTE);
    temporizadores.delete(el);
  }, 2000));
  el.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
}
