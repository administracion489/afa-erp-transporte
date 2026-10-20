"use client";
// components/tarifario/AjustesTraslado.tsx — Pestaña «Ajustes»: la fila única `traslados_config`
// (validez, espera gratis y, mientras no se corra supabase/cotizaciones-05, las cuatro listas de
// condiciones del PDF) y el tipo de cambio de SUNAT.
//
// LAS CONDICIONES DEL PDF DEL TRASLADO TIENEN UNA SOLA FUENTE (cotizaciones-05): la plantilla PDF
// que la regla «Traslado de la IA × segmento» asigna a cada tipo de cliente, que se edita en
// /cotizaciones/plantillas. CON las reglas, las cuatro listas de Ajustes (consideraciones, las de
// dólares, Incluye, No incluye) se ENSEÑAN en solo lectura por segmento —qué plantilla usa la IA y
// sus tres listas, con el enlace a editarla— y «Guardar ajustes» ya NO escribe esas cuatro
// columnas: una lista editable que guarda en una columna que nadie lee es peor que no ofrecerla. Qué
// plantilla y qué listas lo deciden `plantillaParaUso` y la misma copia que hace
// `filaCotizacionTraslado` (`condicionesTrasladoIA`, cruzada en la matriz). SIN las reglas (falta el
// SQL) o con la lectura fallida, las listas se editan aquí como antes y una línea lo dice: el SQL que
// falta, o el error (nunca se pintan unas listas vacías por una lectura que falló). Mientras se
// comprueba, no se ofrecen ni se guardan.
//
// Las listas que la IA copia, las copia cada cotización AL CREARSE: cambiarlas no reescribe lo que
// ya se le envió a un cliente. Una lista vacía no se imprime en el PDF. Sin traslados-07 las de
// Incluye / No incluye de Ajustes no existen: se dice en ámbar y no se ofrecen.
//
// EL TIPO DE CAMBIO NO SE ESCRIBE DESDE EL NAVEGADOR: «Actualizar ahora» llama a
// POST /api/tipo-cambio/sunat, que lo trae, lo controla y lo guarda. Aquí solo se lee, y se juzga
// con `tcParaCotizar` del motor — el mismo juicio que hace el cotizador: si aquí sale ámbar, las
// cotizaciones en dólares están pasando a un ejecutivo.
//
// «🤖 Cotización automática por WhatsApp» (fase 2): los dos interruptores de traslados-05 se
// guardan AL INSTANTE (no con «Guardar ajustes»), y lo que la IA hace de verdad con ellos lo dice
// `estadoCotizadorIA` (lib/traslados/envio-ia.ts) leyendo además la fila del agente del CRM: un
// interruptor encendido con el agente en copiloto o sin WhatsApp no cotiza ni envía nada, y la
// pantalla no puede dar a entender lo contrario.

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import { fechaLima } from "@/lib/alertas-horario";
import { tablaQueFalta } from "@/lib/columna-faltante";
import { TC_MAX_DIAS, tcParaCotizar } from "@/lib/traslados/motor";
import { estadoCotizadorIA } from "@/lib/traslados/envio-ia";
import { LINEA_DISPONIBILIDAD } from "@/lib/traslados/cotizacion-traslado";
import { leerPlantillasYReglas, type LecturaPlantillas } from "@/lib/cotizacion-plantillas-datos";
import { ETIQUETA_SEGMENTO, SQL_PLANTILLAS_USO } from "@/lib/cotizacion-plantillas";
import {
  condicionesTrasladoIA, enlaceEditarPlantilla, esperaQueNoCoincideIA,
  fmtFecha, leerEntero, mensajeEncenderEnvio, mensajeEncenderIA, minutosQueNoCoinciden, SQL_COTIZACION_IA, SQL_FOTOS_CATEGORIA,
  subzonasQueHeredan, zonasConEnvioPropio, type GrupoCondicionesIA, type ListaCondicion, type ZonaFila,
} from "./traslados-pantalla";
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

export default function AjustesTraslado({ config, configExiste, onConfig, decir, zonas, sinMigracionIA, sinMigracionListas, colsConfig, onIrAZonas }: {
  config: ConfigFila;
  configExiste: boolean;
  onConfig: (c: ConfigFila) => void;
  decir: Decir;
  zonas: readonly ZonaFila[];
  sinMigracionIA: boolean;
  /** Faltan las columnas `incluye` / `no_incluye` (traslados-07): no se ofrecen ni se guardan. */
  sinMigracionListas: boolean;
  /** Las columnas que se piden de vuelta al guardar (sin las de traslados-05 si falta la migración). */
  colsConfig: string;
  onIrAZonas: () => void;
}) {
  const [validez, setValidez] = useState(String(config.validez_dias));
  const [espera, setEspera] = useState(String(config.espera_gratis_min));
  const [cons, setCons] = useState<string[]>(config.consideraciones);
  const [consUsd, setConsUsd] = useState<string[]>(config.consideraciones_usd);
  const [incl, setIncl] = useState<string[]>(config.incluye);
  const [noIncl, setNoIncl] = useState<string[]>(config.no_incluye);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // De dónde salen las condiciones del PDF (cotizaciones-05). null = comprobando.
  const [plantillas, setPlantillas] = useState<LecturaPlantillas | null>(null);
  const [nPl, setNPl] = useState(0);

  useEffect(() => {
    let vivo = true;
    void leerPlantillasYReglas(supabase)
      .catch((e: unknown): LecturaPlantillas => ({ ok: false, plantillas: [], reglas: null, sinDiseno: false, error: `No se pudieron leer las plantillas del PDF: ${(e as Error)?.message ?? "sin conexión"}` }))
      .then((r) => { if (vivo) setPlantillas(r); });
    return () => { vivo = false; };
  }, [nPl]);
  const releerPlantillas = () => { setPlantillas(null); setNPl((x) => x + 1); };

  // CON reglas: las condiciones son las de las plantillas (solo lectura). SIN reglas o con la lectura
  // fallida: las de Ajustes, editables como antes. Mientras se comprueba, ni se ofrecen ni se guardan.
  const grupos: GrupoCondicionesIA[] | null = plantillas && plantillas.ok && plantillas.reglas
    ? condicionesTrasladoIA(plantillas.plantillas, plantillas.reglas, config)
    : null;
  const listasEditables = plantillas != null && grupos == null;

  const lVal = leerEntero(validez, LIMITES.validez_dias[0], LIMITES.validez_dias[1]);
  const lEsp = leerEntero(espera, LIMITES.espera_gratis_min[0], LIMITES.espera_gratis_min[1]);
  const limpias = (l: string[]) => l.map((x) => x.trim()).filter(Boolean);
  const sucio = validez !== String(config.validez_dias) || espera !== String(config.espera_gratis_min)
    || (listasEditables && (JSON.stringify(limpias(cons)) !== JSON.stringify(config.consideraciones)
      || JSON.stringify(limpias(consUsd)) !== JSON.stringify(config.consideraciones_usd)
      || (!sinMigracionListas && (JSON.stringify(limpias(incl)) !== JSON.stringify(config.incluye)
        || JSON.stringify(limpias(noIncl)) !== JSON.stringify(config.no_incluye)))));
  const motivo = lVal.tipo !== "ok" ? `Validez: un número entero de días entre ${LIMITES.validez_dias[0]} y ${LIMITES.validez_dias[1]}.`
    : lEsp.tipo !== "ok" ? `Espera gratis: un número entero de minutos entre ${LIMITES.espera_gratis_min[0]} y ${LIMITES.espera_gratis_min[1]}.`
      : !sucio ? "No hay cambios." : null;
  // La espera gratis se coteja con las consideraciones que el PDF imprime DE VERDAD: con reglas, las
  // de la plantilla de cada segmento (y se nombra cuál corregir); sin ellas, las de aquí.
  const minutosDistintos = lEsp.tipo === "ok" && listasEditables ? minutosQueNoCoinciden([...cons, ...consUsd], lEsp.valor) : [];
  const esperaDistinta = lEsp.tipo === "ok" && grupos ? esperaQueNoCoincideIA(grupos, lEsp.valor) : [];

  const descartar = () => {
    setValidez(String(config.validez_dias)); setEspera(String(config.espera_gratis_min));
    setCons(config.consideraciones); setConsUsd(config.consideraciones_usd);
    setIncl(config.incluye); setNoIncl(config.no_incluye); setError(null);
  };

  const guardar = async () => {
    if (motivo || guardando || lVal.tipo !== "ok" || lEsp.tipo !== "ok") return;
    setGuardando(true);
    setError(null);
    const fila: Record<string, unknown> = { id: 1, validez_dias: lVal.valor, espera_gratis_min: lEsp.valor };
    // Las cuatro listas solo mientras son las que la IA copia (sin cotizaciones-05, o sin poder
    // comprobarlo). Con reglas, nadie las lee: escribirlas sería guardar un texto que no sale en ningún PDF.
    const conListas = listasEditables;
    if (conListas) {
      fila.consideraciones = limpias(cons);
      fila.consideraciones_usd = limpias(consUsd);
      // Sin traslados-07 las de Incluye / No incluye no existen: mandarlas haría fallar el guardado entero.
      if (!sinMigracionListas) { fila.incluye = limpias(incl); fila.no_incluye = limpias(noIncl); }
    }
    // Con RLS, el lado «update» de un upsert sin permiso no da error: vuelve sin filas.
    const r = filasEscritas<Record<string, unknown>>(
      await supabase.from("traslados_config").upsert(fila, { onConflict: "id" }).select(colsConfig),
      "No se guardaron los ajustes");
    setGuardando(false);
    if (!r.ok) { setError(r.detalle); return; }
    const c = normalizarConfig(r.filas[0]);
    onConfig(c);
    if (conListas) {
      setCons(c.consideraciones); setConsUsd(c.consideraciones_usd);
      if (!sinMigracionListas) { setIncl(c.incluye); setNoIncl(c.no_incluye); }
    }
    decir("Ajustes guardados.");
  };

  return (
    <div className="space-y-4">
      <CotizacionIA config={config} onConfig={onConfig} decir={decir} zonas={zonas}
        sinMigracionIA={sinMigracionIA} colsConfig={colsConfig} onIrAZonas={onIrAZonas} />
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_22rem] gap-4 items-start">
        <section className="bg-white border rounded-2xl p-4 space-y-4">
          {!configExiste && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">La fila de ajustes no existe todavía: se usan los valores por defecto (30 días, 30 minutos{listasEditables ? ", sin consideraciones" : ""}). Al guardar se crea.</p>
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
          {esperaDistinta.map((d) => (
            <p key={d.grupo.clave} className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              {d.texto}{" "}
              <Link href={d.grupo.fuente.tipo === "plantilla" ? enlaceEditarPlantilla(d.grupo.fuente.plantilla.id) : "/cotizaciones/plantillas"} className="font-bold underline break-words">
                {d.grupo.fuente.tipo === "plantilla" ? `Editar «${d.grupo.fuente.plantilla.nombre || d.grupo.fuente.plantilla.id}» →` : "Ir a Plantillas PDF →"}
              </Link>
            </p>
          ))}
          {plantillas == null ? (
            <p className="text-xs text-gray-400">Comprobando de dónde salen las condiciones del PDF del traslado (Ajustes o una plantilla PDF)…</p>
          ) : grupos ? (
            <CondicionesDePlantillas grupos={grupos} onReleer={releerPlantillas} />
          ) : (
            <>
              {plantillas.ok ? (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  Falta correr <span className="font-mono">{SQL_PLANTILLAS_USO}</span> en Supabase → SQL Editor (pegar entero → Run). Hasta entonces las condiciones del PDF del traslado se editan aquí y son las que la IA copia. Al correrlo, pasan a las plantillas «Traslados (IA)» de <Link href="/cotizaciones/plantillas" className="font-bold underline">Plantillas PDF</Link>, se editan allí y aquí solo se enseñan.
                </p>
              ) : (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                  No se pudo comprobar si el traslado de la IA usa una plantilla PDF ({plantillas.error}). Mientras tanto aquí se editan las listas de Ajustes, que la IA solo usa si falta <span className="font-mono">{SQL_PLANTILLAS_USO}</span> o si ninguna plantilla le sirve.{" "}
                  <button type="button" onClick={releerPlantillas} className="font-bold underline">Reintentar</button>
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
              {sinMigracionListas ? (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  Las listas <b>Incluye</b> y <b>No incluye</b> del PDF todavía no existen: falta correr <span className="font-mono">{SQL_FOTOS_CATEGORIA}</span> en Supabase → SQL Editor (pegar entero → Run). Hasta entonces la cotización de traslado sale sin esas dos listas.
                </p>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Incluye (va en el PDF de cada traslado)</p>
                    <ListaTextos items={incl} onCambiar={setIncl} etiqueta="Incluye" placeholder="Ej: Conductor y unidad con SOAT vigente." />
                  </div>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">No incluye (va en el PDF de cada traslado)</p>
                    <ListaTextos items={noIncl} onCambiar={setNoIncl} etiqueta="No incluye" placeholder="Ej: Estacionamiento por retraso del vuelo." />
                  </div>
                  <p className="lg:col-span-2 text-[10px] text-gray-400">Cada cotización copia estas listas al crearse: cambiarlas aquí no cambia las que ya se enviaron. Una lista vacía no se imprime.</p>
                </div>
              )}
            </>
          )}
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
    </div>
  );
}

// ── Las condiciones del PDF, de las plantillas (cotizaciones-05) ─────────────

function ListaSoloLectura({ titulo, lista, plantilla }: { titulo: string; lista: ListaCondicion; plantilla: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{titulo}</p>
      {!lista.propia ? (
        <p className="text-[11px] text-gray-500 italic">La plantilla no tiene esta lista propia: el PDF del traslado sale sin ella.</p>
      ) : lista.items.length === 0 ? (
        <p className="text-[11px] text-gray-500 italic">Vacía{plantilla ? " en la plantilla" : ""}: el PDF no la imprime.</p>
      ) : (
        <ol className="list-decimal pl-5 space-y-0.5 text-xs text-gray-700 break-words">{lista.items.map((t, i) => <li key={i}>{t}</li>)}</ol>
      )}
    </div>
  );
}

/**
 * Las condiciones que la IA copia a cada traslado, por segmento, en SOLO LECTURA: se editan en la
 * plantilla (Plantillas PDF). Lo que se pinta sale de `condicionesTrasladoIA`, que la matriz cruza
 * con la fila que arma la IA.
 */
function CondicionesDePlantillas({ grupos, onReleer }: { grupos: readonly GrupoCondicionesIA[]; onReleer: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 flex-1">Condiciones del PDF del traslado</p>
        <button type="button" onClick={onReleer} className="text-[11px] font-bold text-gray-500 hover:text-gray-700 underline min-h-[32px]">↻ Volver a leer las plantillas</button>
      </div>
      <p className="text-xs text-gray-500">
        Las consideraciones, <b>Incluye</b> y <b>No incluye</b> del PDF del traslado salen de la plantilla PDF que la regla «Traslado de la IA» asigna a cada tipo de cliente, y se editan en <Link href="/cotizaciones/plantillas" className="font-bold text-[#0b315f] underline">Plantillas PDF</Link>. Aquí solo se enseñan: es lo que la IA copia a cada cotización nueva (las ya creadas no cambian). En dólares el tipo de cliente es siempre «Extranjero».
      </p>
      {grupos.map((g) => {
        const ambar = g.segmentos.some((s) => s.ambar);
        const esPlantilla = g.fuente.tipo === "plantilla";
        return (
          <div key={g.clave} className={`border rounded-xl p-3 space-y-2 ${ambar ? "border-amber-300 bg-amber-50" : "border-gray-200"}`}>
            <div className="flex flex-wrap items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-gray-800">{g.segmentos.map((s) => ETIQUETA_SEGMENTO[s.segmento]).join(" · ")}</p>
                <p className="text-xs text-gray-600 break-words">
                  {g.fuente.tipo === "plantilla"
                    ? <>Plantilla <b>«{g.fuente.plantilla.nombre || g.fuente.plantilla.id}»</b></>
                    : <>Las listas de Ajustes de traslados{g.fuente.usd ? " (con las de dólares)" : ""}, que ya no se editan aquí</>}
                </p>
              </div>
              {g.fuente.tipo === "plantilla" ? (
                <Link href={enlaceEditarPlantilla(g.fuente.plantilla.id)} className="text-[11px] font-bold text-[#0b315f] underline whitespace-nowrap min-h-[32px] inline-flex items-center">Editar en Plantillas PDF →</Link>
              ) : (
                <Link href="/cotizaciones/plantillas" className="text-[11px] font-bold text-amber-900 underline whitespace-nowrap min-h-[32px] inline-flex items-center">Asignar una plantilla →</Link>
              )}
            </div>
            <div className="space-y-0.5">
              {g.segmentos.map((s) => (
                <p key={s.segmento} className={`text-[11px] ${s.ambar ? "text-amber-900" : "text-gray-500"}`}>
                  <b>{ETIQUETA_SEGMENTO[s.segmento]}:</b> {s.porque}
                </p>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 pt-1">
              <ListaSoloLectura titulo="Consideraciones" lista={g.generales} plantilla={esPlantilla} />
              <ListaSoloLectura titulo="Incluye" lista={g.incluye} plantilla={esPlantilla} />
              <ListaSoloLectura titulo="No incluye" lista={g.no_incluye} plantilla={esPlantilla} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 🤖 Cotización automática por WhatsApp ────────────────────────────────────

type AgenteIA = { activo: boolean; canales: string[]; canales_autonomos: string[]; horario_activo: boolean; hora_inicio?: string; hora_fin?: string };

type LecturaAgente =
  | { tipo: "ok"; agente: AgenteIA | null }
  | { tipo: "error"; detalle: string };

const textos = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const hhmm = (v: unknown): string | undefined => (typeof v === "string" && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : undefined);

/**
 * La MISMA fila que lee el agente en el servidor (lib/crm-ia.ts: la primera por `created_at`).
 * Sin la tabla no hay agente; un fallo de lectura NO se lee como «agente apagado».
 */
async function leerAgente(): Promise<LecturaAgente> {
  try {
    const { data, error } = await supabase.from("crm_agentes_ia").select("*").order("created_at").limit(1);
    if (error) return tablaQueFalta(error) != null ? { tipo: "ok", agente: null } : { tipo: "error", detalle: error.message };
    const a = ((data ?? []) as Record<string, unknown>[])[0];
    if (!a) return { tipo: "ok", agente: null };
    return {
      tipo: "ok",
      agente: {
        activo: a.activo === true, canales: textos(a.canales), canales_autonomos: textos(a.canales_autonomos),
        horario_activo: a.horario_activo === true, hora_inicio: hhmm(a.hora_inicio), hora_fin: hhmm(a.hora_fin),
      },
    };
  } catch (e) {
    return { tipo: "error", detalle: (e as Error)?.message ?? "sin conexión" };
  }
}

function Casilla({ marcada, ocupada, bloqueada, onCambiar, titulo, detalle }: {
  marcada: boolean; ocupada: boolean; bloqueada: boolean; onCambiar: (v: boolean) => void; titulo: string; detalle: string;
}) {
  return (
    <label className={`flex items-start gap-3 rounded-xl border px-3 py-3 min-h-[44px] ${bloqueada ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-gray-50"} ${marcada ? "border-[#0b315f]/40 bg-[#eef3f8]/50" : "border-gray-200"}`}>
      <input type="checkbox" className="w-5 h-5 mt-0.5 accent-[#0b315f] flex-shrink-0" checked={marcada} disabled={bloqueada || ocupada}
        onChange={(e) => onCambiar(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm font-bold text-gray-800">{titulo}{ocupada ? " · guardando…" : ""}</span>
        <span className="block text-[11px] text-gray-500 mt-0.5">{detalle}</span>
      </span>
    </label>
  );
}

function CotizacionIA({ config, onConfig, decir, zonas, sinMigracionIA, colsConfig, onIrAZonas }: {
  config: ConfigFila;
  onConfig: (c: ConfigFila) => void;
  decir: Decir;
  zonas: readonly ZonaFila[];
  sinMigracionIA: boolean;
  colsConfig: string;
  onIrAZonas: () => void;
}) {
  const [lectura, setLectura] = useState<LecturaAgente | null>(null);
  const [n, setN] = useState(0);
  const [guardando, setGuardando] = useState<"ia_cotiza" | "envio_automatico" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void leerAgente().then((r) => { if (vivo) setLectura(r); });
    return () => { vivo = false; };
  }, [n]);

  const conEnvio = zonasConEnvioPropio(zonas);
  const nombres = conEnvio.map((z) => z.nombre);
  const heredan = subzonasQueHeredan(zonas);
  // Sin la migración `estadoCotizadorIA` contesta antes de mirar al agente; con ella, solo se
  // juzga cuando el agente se pudo leer (un fallo de lectura no es «el agente está apagado»).
  const estado = sinMigracionIA || lectura?.tipo === "ok"
    ? estadoCotizadorIA({
      iaCotiza: config.ia_cotiza, envioMaestro: config.envio_automatico, zonasConEnvio: nombres,
      agente: lectura?.tipo === "ok" ? lectura.agente : null, sinMigracion: sinMigracionIA,
    })
    : null;

  const cambiar = async (campo: "ia_cotiza" | "envio_automatico", v: boolean) => {
    if (guardando || sinMigracionIA) return;
    if (v) {
      const msg = campo === "ia_cotiza"
        ? mensajeEncenderIA({ envioMaestro: config.envio_automatico, zonas: nombres })
        : mensajeEncenderEnvio({ zonas: nombres, iaCotiza: config.ia_cotiza });
      if (!window.confirm(msg)) return;
    }
    setGuardando(campo);
    setError(null);
    // Solo la columna que cambió: el upsert actualiza las columnas que lleva y no toca las demás
    // (ni lo que esté escrito sin guardar en el formulario de abajo). Con RLS, sin permiso vuelve sin filas.
    const que = campo === "ia_cotiza" ? "No se guardó «La IA cotiza traslados»" : "No se guardó el envío automático";
    const r = filasEscritas<Record<string, unknown>>(
      await supabase.from("traslados_config").upsert({ id: 1, [campo]: v }, { onConflict: "id" }).select(colsConfig), que);
    setGuardando(null);
    if (!r.ok) { setError(r.detalle); return; }
    onConfig(normalizarConfig(r.filas[0]));
    decir(campo === "ia_cotiza"
      ? (v ? "La IA del CRM ya puede cotizar traslados." : "La IA del CRM dejó de cotizar traslados.")
      : (v ? "Envío automático encendido en las zonas marcadas." : "Envío automático apagado: todo queda en revisión."));
  };

  const ambar = !!estado?.ambar;
  return (
    <section className={`border rounded-2xl p-4 space-y-3 ${ambar ? "bg-amber-50 border-amber-200" : "bg-white"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="text-sm font-bold text-gray-700 flex-1">🤖 Cotización automática por WhatsApp</h3>
        <Link href="/crm/agente" className="text-[11px] font-bold text-[#0b315f] underline">Agente IA del CRM →</Link>
      </div>
      <p className="text-xs text-gray-500">
        La IA del CRM cotiza por WhatsApp solo los <b>traslados simples</b> (un recojo y un destino, solo ida o ida y retorno) con los precios de este tarifario, y deja la cotización en /cotizaciones. Lo demás —TDR, licitaciones, eventos, varios servicios, descuentos— lo pasa a un ejecutivo. {LINEA_DISPONIBILIDAD}
      </p>

      {sinMigracionIA && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          Falta correr <span className="font-mono">{SQL_COTIZACION_IA}</span> en Supabase → SQL Editor (antes, <span className="font-mono">supabase/traslados-04-tipo-cambio-solo-servidor.sql</span>). Hasta entonces la IA del CRM no cotiza traslados y estas casillas no se pueden guardar.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <Casilla marcada={config.ia_cotiza} ocupada={guardando === "ia_cotiza"} bloqueada={sinMigracionIA || (!!guardando && guardando !== "ia_cotiza")}
          onCambiar={(v) => void cambiar("ia_cotiza", v)} titulo="La IA cotiza traslados"
          detalle="Apagada, la IA ni siquiera tiene la herramienta: los pedidos de traslado los atiende un ejecutivo." />
        <Casilla marcada={config.envio_automatico} ocupada={guardando === "envio_automatico"} bloqueada={sinMigracionIA || (!!guardando && guardando !== "envio_automatico")}
          onCambiar={(v) => void cambiar("envio_automatico", v)} titulo="Enviar sola la cotización en las zonas marcadas"
          detalle="Encendida, el PDF sale solo al cliente cuando el recojo o el destino está en una zona marcada. Apagada, cada cotización queda en el inbox del CRM y la envía un ejecutivo con un clic." />
      </div>

      <div className="text-xs text-gray-600 space-y-1">
        <p className="font-bold text-gray-500 uppercase tracking-wide text-[11px]">Zonas con envío automático</p>
        {conEnvio.length === 0 ? (
          <p className="text-gray-500">Ninguna zona marcada{sinMigracionIA ? " (sin la migración no se pueden marcar)" : ""}: todo lo que cotice la IA queda en revisión.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {conEnvio.map((z) => (
              <span key={z.id} className="px-2 py-1 rounded-lg bg-green-50 border border-green-200 text-green-800 text-[11px] font-bold">📄 {z.nombre}</span>
            ))}
          </div>
        )}
        {heredan.length > 0 && (
          <p className="text-[11px] text-gray-500">También {heredan.length} subzona{heredan.length === 1 ? "" : "s"} que lo hereda{heredan.length === 1 ? "" : "n"} de su distrito: {heredan.map((z) => z.nombre).join(", ")}.</p>
        )}
        <button type="button" onClick={onIrAZonas} className="text-[11px] font-bold text-[#0b315f] underline">Marcar o desmarcar zonas en la pestaña Zonas →</button>
      </div>

      <div className={`rounded-xl border px-3 py-2 text-xs space-y-1 ${ambar ? "border-amber-300 text-amber-900 bg-white/60" : "border-gray-200 text-gray-700 bg-gray-50"}`}>
        <p className="text-[11px] font-bold uppercase tracking-wide opacity-70">Lo que hace hoy</p>
        {estado ? (
          estado.lineas.map((l, i) => <p key={i} className={ambar && i === 0 ? "font-bold" : ""}>{l}</p>)
        ) : lectura?.tipo === "error" ? (
          <p className="text-red-700">No se pudo leer la configuración del agente IA del CRM ({lectura.detalle}): no se puede decir si hoy cotiza.{" "}
            <button type="button" onClick={() => { setLectura(null); setN((x) => x + 1); }} className="underline font-bold">Reintentar</button>
          </p>
        ) : (
          <p className="text-gray-400">Comprobando el agente IA del CRM…</p>
        )}
      </div>

      {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</p>}
    </section>
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
