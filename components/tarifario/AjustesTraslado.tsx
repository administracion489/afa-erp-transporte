"use client";
// components/tarifario/AjustesTraslado.tsx — Pestaña «Ajustes»: la fila única `traslados_config`
// (validez, espera gratis y, mientras no se corra supabase/cotizaciones-05, las cuatro listas de
// condiciones del PDF) y el tipo de cambio de SUNAT.
//
// LAS CONDICIONES DEL PDF DEL TRASLADO TIENEN UNA SOLA FUENTE (cotizaciones-05): la plantilla PDF
// que la regla «Traslado de la IA × segmento» asigna a cada tipo de cliente, que se edita en
// /cotizaciones/plantillas. CON las reglas, se ENSEÑA en solo lectura, por segmento, qué plantilla
// usa la IA y sus tres listas, con el enlace a editarla. Qué plantilla y qué listas lo deciden
// `plantillaParaUso` y `considDeTraslado` (la misma copia que hace `filaCotizacionTraslado`).
// LAS LISTAS DE AJUSTES SE EDITAN (Y SE GUARDAN) SOLO MIENTRAS LA IA LAS LEE (`listasDeAjustesEnUso`):
// sin reglas (falta el SQL) o sin poder comprobarlo, las cuatro, con una línea que dice el SQL que
// falta o el error (nunca se pintan unas listas vacías por una lectura que falló); con reglas, solo
// si algún segmento cae a ellas por no tener una plantilla que la IA pueda usar —y la línea ámbar
// dice cuáles—, y las de dólares solo si ese segmento es Extranjero. Si no cae ninguno, ninguna se
// ofrece ni se guarda: una lista editable que guarda en una columna que nadie lee es peor que no
// ofrecerla. Mientras se comprueba, no se ofrecen ni se guardan.
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
// «📅 Reserva y pago por la IA» (traslados-09): las seis columnas `reserva_*`. El interruptor se
// guarda AL INSTANTE con un confirm que nombra lo que va a pasar; los números, con su «Guardar». Se
// leen con `normalizarConfigReserva`, la MISMA lectura del servidor. Lo que la IA hace de verdad lo
// dice el servidor (`estadoReservaIA` por /api/crm/ia/estado, que exige el módulo CRM); aquí se
// cotejan además, mientras se escribe, la política de cada plantilla (`politicaContradiceConfig`),
// a quién va el correo (`destinatariosReserva`) y las cuentas sin moneda declarada del perfil. El
// correo de los comprobantes solo lo cambia un ADMINISTRADOR (supabase/seguridad-05-reserva-dinero.sql):
// a los demás se les enseña en solo lectura y «Guardar» nunca lo manda si no cambió.
//
// «🤖 Cotización automática por WhatsApp» (fase 2): los dos interruptores de traslados-05 se
// guardan AL INSTANTE (no con «Guardar ajustes»), y lo que la IA hace de verdad con ellos lo dice
// `estadoCotizadorIA` (lib/traslados/envio-ia.ts) leyendo además la fila del agente del CRM: un
// interruptor encendido con el agente en copiloto o sin WhatsApp no cotiza ni envía nada, y la
// pantalla no puede dar a entender lo contrario.

import { useEffect, useState, type ReactNode } from "react";
import { useEsAdmin } from "@/lib/usePuedeVer";
import { politicaContradiceConfig, type ConfigReserva } from "@/lib/traslados/reserva-pago";
import { destinatariosReserva, FUENTE_CORREO_RESERVA } from "@/lib/traslados/reserva-correo";
import { cuentasUtiles, monedaDeCuenta, type CuentaBancaria } from "@/lib/empresa-perfil";
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
  avisoListasAjustes, condicionesTrasladoIA, enlaceEditarPlantilla, esperaQueNoCoincideIA, listasDeAjustesEnUso,
  fmtFecha, leerEntero, mensajeEncenderEnvio, mensajeEncenderIA, minutosQueNoCoinciden, SQL_COTIZACION_IA, SQL_FOTOS_CATEGORIA,
  subzonasQueHeredan, zonasConEnvioPropio, type GrupoCondicionesIA, type ListaCondicion, type ZonaFila,
} from "./traslados-pantalla";
import { filasEscritas, leerUltimoTc, LIMITES, normalizarConfig, SOLO_ADMIN_CORREO_RESERVA, type ConfigFila, type LecturaTc } from "./traslados-datos";
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

export default function AjustesTraslado({ config, configExiste, onConfig, decir, zonas, sinMigracionIA, sinMigracionListas, sinMigracionReserva, colsConfig, onIrAZonas }: {
  config: ConfigFila;
  configExiste: boolean;
  onConfig: (c: ConfigFila) => void;
  decir: Decir;
  zonas: readonly ZonaFila[];
  sinMigracionIA: boolean;
  /** Faltan las columnas `incluye` / `no_incluye` (traslados-07): no se ofrecen ni se guardan. */
  sinMigracionListas: boolean;
  /** Faltan las columnas `reserva_*` (traslados-09): el bloque de la reserva no se ofrece. */
  sinMigracionReserva: boolean;
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

  // CON reglas: qué copia la IA en cada segmento (con el borrador de Ajustes donde cae a ellas, así
  // los minutos se cotejan mientras se escribe). SIN reglas o con la lectura fallida: null.
  const grupos: GrupoCondicionesIA[] | null = plantillas && plantillas.ok && plantillas.reglas
    ? condicionesTrasladoIA(plantillas.plantillas, plantillas.reglas, { consideraciones: cons, consideraciones_usd: consUsd, incluye: incl, no_incluye: noIncl })
    : null;
  // Qué listas de Ajustes lee hoy la IA: esas, y solo esas, se ofrecen y se guardan. Mientras se comprueba, ninguna.
  const enUso = plantillas == null ? null : listasDeAjustesEnUso(grupos);
  const edita = { gen: !!enUso?.enUso, usd: !!enUso?.usd, listas: !!enUso?.enUso && !sinMigracionListas };

  const lVal = leerEntero(validez, LIMITES.validez_dias[0], LIMITES.validez_dias[1]);
  const lEsp = leerEntero(espera, LIMITES.espera_gratis_min[0], LIMITES.espera_gratis_min[1]);
  const limpias = (l: string[]) => l.map((x) => x.trim()).filter(Boolean);
  const cambio = (a: string[], b: string[]) => JSON.stringify(limpias(a)) !== JSON.stringify(b);
  const sucio = validez !== String(config.validez_dias) || espera !== String(config.espera_gratis_min)
    || (edita.gen && cambio(cons, config.consideraciones))
    || (edita.usd && cambio(consUsd, config.consideraciones_usd))
    || (edita.listas && (cambio(incl, config.incluye) || cambio(noIncl, config.no_incluye)));
  const motivo = lVal.tipo !== "ok" ? `Validez: un número entero de días entre ${LIMITES.validez_dias[0]} y ${LIMITES.validez_dias[1]}.`
    : lEsp.tipo !== "ok" ? `Espera gratis: un número entero de minutos entre ${LIMITES.espera_gratis_min[0]} y ${LIMITES.espera_gratis_min[1]}.`
      : !sucio ? "No hay cambios." : null;
  // La espera gratis se coteja con las consideraciones que el PDF imprime DE VERDAD: con reglas, las
  // de la plantilla de cada segmento (y se nombra cuál corregir) y las de aquí donde caen a ellas;
  // sin reglas, las de aquí.
  const minutosDistintos = lEsp.tipo === "ok" && !grupos && edita.gen ? minutosQueNoCoinciden([...cons, ...consUsd], lEsp.valor) : [];
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
    // Solo las listas que la IA lee hoy (`edita`): escribir una que nadie lee sería guardar un texto
    // que no sale en ningún PDF. Sin traslados-07, `edita.listas` es false: mandarlas haría fallar el
    // guardado entero.
    const e = edita;
    if (e.gen) fila.consideraciones = limpias(cons);
    if (e.usd) fila.consideraciones_usd = limpias(consUsd);
    if (e.listas) { fila.incluye = limpias(incl); fila.no_incluye = limpias(noIncl); }
    // Con RLS, el lado «update» de un upsert sin permiso no da error: vuelve sin filas.
    const r = filasEscritas<Record<string, unknown>>(
      await supabase.from("traslados_config").upsert(fila, { onConflict: "id" }).select(colsConfig),
      "No se guardaron los ajustes");
    setGuardando(false);
    if (!r.ok) { setError(r.detalle); return; }
    const c = normalizarConfig(r.filas[0]);
    onConfig(c);
    if (e.gen) setCons(c.consideraciones);
    if (e.usd) setConsUsd(c.consideraciones_usd);
    if (e.listas) { setIncl(c.incluye); setNoIncl(c.no_incluye); }
    decir("Ajustes guardados.");
  };

  return (
    <div className="space-y-4">
      <CotizacionIA config={config} onConfig={onConfig} decir={decir} zonas={zonas}
        sinMigracionIA={sinMigracionIA} colsConfig={colsConfig} onIrAZonas={onIrAZonas} />
      <ReservaIA config={config} onConfig={onConfig} decir={decir} colsConfig={colsConfig} sinMigracion={sinMigracionReserva}
        grupos={grupos} plantillas={plantillas} onReleerPlantillas={releerPlantillas} />
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_22rem] gap-4 items-start">
        <section className="bg-white border rounded-2xl p-4 space-y-4">
          {!configExiste && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">La fila de ajustes no existe todavía: se usan los valores por defecto (30 días, 30 minutos{edita.gen ? ", sin consideraciones" : ""}). Al guardar se crea.</p>
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
            <p key={d.clave} className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              {d.texto}
              {d.plantilla && (
                <>{" "}<Link href={enlaceEditarPlantilla(d.plantilla.id)} className="font-bold underline break-words">{`Editar «${d.plantilla.nombre || d.plantilla.id}» →`}</Link></>
              )}
            </p>
          ))}
          {plantillas == null ? (
            <p className="text-xs text-gray-400">Comprobando de dónde salen las condiciones del PDF del traslado (Ajustes o una plantilla PDF)…</p>
          ) : (
            <>
              {grupos && <CondicionesDePlantillas grupos={grupos} onReleer={releerPlantillas} />}
              {edita.gen && (
                <>
                  {grupos ? (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                      {enUso ? avisoListasAjustes(enUso) : null}{" "}
                      <Link href="/cotizaciones/plantillas" className="font-bold underline">Ir a Plantillas PDF →</Link>
                    </p>
                  ) : plantillas.ok ? (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                      Falta correr <span className="font-mono">{SQL_PLANTILLAS_USO}</span> en Supabase → SQL Editor (pegar entero → Run). Hasta entonces las condiciones del PDF del traslado se editan aquí y son las que la IA copia. Al correrlo, pasan a las plantillas «Traslados (IA)» de <Link href="/cotizaciones/plantillas" className="font-bold underline">Plantillas PDF</Link> y se editan allí.
                    </p>
                  ) : (
                    <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                      No se pudo comprobar si el traslado de la IA usa una plantilla PDF ({plantillas.error}). Mientras tanto aquí se editan las listas de Ajustes, que la IA solo usa si falta <span className="font-mono">{SQL_PLANTILLAS_USO}</span> o si ninguna plantilla le sirve.{" "}
                      <button type="button" onClick={releerPlantillas} className="font-bold underline">Reintentar</button>
                    </p>
                  )}
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Consideraciones ({grupos ? "van en el PDF de los tipos de cliente de arriba" : "van en toda cotización de traslado"})</p>
                    <ListaTextos items={cons} onCambiar={setCons} etiqueta="Consideración" placeholder="Ej: Sujeto a disponibilidad: un ejecutivo confirma la reserva." />
                  </div>
                  {edita.usd && (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Consideraciones solo para dólares (se agregan cuando se cotiza en US$)</p>
                      <ListaTextos items={consUsd} onCambiar={setConsUsd} etiqueta="Consideración en dólares" placeholder="Ej: El IGV se exonera solo con TAM y pasaporte." />
                    </div>
                  )}
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

function ListaSoloLectura({ titulo, lista, sinLista }: { titulo: string; lista: ListaCondicion; sinLista?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{titulo}</p>
      {!lista.propia ? (
        <p className="text-[11px] text-gray-500 italic">{sinLista ?? "La plantilla no tiene esta lista propia: el PDF del traslado sale sin ella."}</p>
      ) : lista.items.length === 0 ? (
        <p className="text-[11px] text-gray-500 italic">Vacía en la plantilla: el PDF no la imprime.</p>
      ) : (
        <ol className="list-decimal pl-5 space-y-0.5 text-xs text-gray-700 break-words">{lista.items.map((t, i) => <li key={i}>{t}</li>)}</ol>
      )}
    </div>
  );
}

/**
 * Las condiciones que la IA copia a cada traslado, por segmento. Las de una plantilla, en SOLO
 * LECTURA (se editan en Plantillas PDF); las de los segmentos que caen a Ajustes no se repiten aquí:
 * se editan en las listas de abajo. Lo que se pinta sale de `condicionesTrasladoIA`, que usa la
 * misma copia que la fila de la IA (`considDeTraslado`).
 */
function CondicionesDePlantillas({ grupos, onReleer }: { grupos: readonly GrupoCondicionesIA[]; onReleer: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 flex-1">Condiciones del PDF del traslado</p>
        <button type="button" onClick={onReleer} className="text-[11px] font-bold text-gray-500 hover:text-gray-700 underline min-h-[32px]">↻ Volver a leer las plantillas</button>
      </div>
      <p className="text-xs text-gray-500">
        Las consideraciones, <b>Incluye</b>, <b>No incluye</b> y la política de <b>Reserva, cambios y cancelación</b> del PDF del traslado salen de la plantilla PDF que la regla «Traslado de la IA» asigna a cada tipo de cliente, y se editan en <Link href="/cotizaciones/plantillas" className="font-bold text-[#0b315f] underline">Plantillas PDF</Link>. Las de una plantilla se enseñan aquí en solo lectura: es lo que la IA copia a cada cotización nueva (las ya creadas no cambian). Donde no hay una plantilla que la IA pueda usar, copia las listas de Ajustes, que se editan aquí abajo. En dólares el tipo de cliente es siempre «Extranjero».
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
                    : <>Las listas de Ajustes de traslados{g.fuente.usd ? " (con las líneas solo para dólares)" : ""}, que se editan aquí abajo</>}
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
            {esPlantilla && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 pt-1">
                <ListaSoloLectura titulo="Consideraciones" lista={g.generales} />
                <ListaSoloLectura titulo="Incluye" lista={g.incluye} />
                <ListaSoloLectura titulo="No incluye" lista={g.no_incluye} />
                <div className="lg:col-span-3">
                  <ListaSoloLectura titulo="Reserva, cambios y cancelación" lista={g.reserva}
                    sinLista="La plantilla no tiene política de reserva: el PDF del traslado sale sin ella y la IA no tiene una política que enviar al cliente." />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 📅 Reserva y pago por la IA ──────────────────────────────────────────────

const SQL_RESERVA_IA = "supabase/traslados-09-reserva-ia.sql";
/** Los límites de los CHECK de traslados-09 (y de `normalizarConfigReserva`). */
const LIM_RESERVA = { plazo: [15, 1440], margen: [0, 4320], devolucion: [1, 720] } as const;

/** «50», «12,5» → número (0 < x ≤ 100, hasta dos decimales). Vacío = sin adelanto. */
function leerPctAdelanto(t: string): { tipo: "vacio" } | { tipo: "ok"; valor: number } | { tipo: "error"; detalle: string } {
  const s = t.trim().replace("%", "").trim();
  if (!s) return { tipo: "vacio" };
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(s)) return { tipo: "error", detalle: `«${s}» no es un porcentaje (hasta dos decimales).` };
  const v = Number(s.replace(",", "."));
  if (!(v > 0 && v <= 100)) return { tipo: "error", detalle: "Tiene que ser mayor que 0 y como mucho 100." };
  return { tipo: "ok", valor: v };
}

/** La lista de correos escrita: vacía = el del perfil. Cada pedazo tiene que ser un correo. */
function leerCorreos(t: string): { tipo: "vacio" } | { tipo: "ok"; valor: string } | { tipo: "error"; detalle: string } {
  const s = t.trim();
  if (!s) return { tipo: "vacio" };
  if (s.length > 500) return { tipo: "error", detalle: "Como mucho 500 caracteres." };
  const malo = s.split(/[,;\s]+/).filter(Boolean).find((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  if (malo) return { tipo: "error", detalle: `«${malo}» no es un correo (sepáralos con comas).` };
  return { tipo: "ok", valor: s };
}

type EstadoReservaServidor =
  | { tipo: "ok"; activa: boolean | null; lineas: string[] | null; ambar: boolean | null }
  | { tipo: "sin_crm" }
  | { tipo: "error"; detalle: string };

async function leerEstadoReserva(): Promise<EstadoReservaServidor> {
  try {
    const res = await fetch("/api/crm/ia/estado", { headers: await cabecerasErp() });
    if (res.status === 403) return { tipo: "sin_crm" };
    const d = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; reserva?: boolean | null; reserva_lineas?: string[] | null; reserva_ambar?: boolean | null } | null;
    if (res.status === 401) return { tipo: "error", detalle: "Tu sesión venció o no se pudo verificar: vuelve a ingresar." };
    if (!d?.ok) return { tipo: "error", detalle: d?.error || `El servidor respondió ${res.status}.` };
    return { tipo: "ok", activa: d.reserva ?? null, lineas: Array.isArray(d.reserva_lineas) ? d.reserva_lineas : null, ambar: d.reserva_ambar ?? null };
  } catch (e) {
    return { tipo: "error", detalle: `No se pudo llamar al servidor: ${(e as Error)?.message ?? "sin conexión"}.` };
  }
}

type LecturaPerfil = { tipo: "ok"; email: string | null; cuentas: CuentaBancaria[] } | { tipo: "error"; detalle: string };

async function leerPerfilReserva(): Promise<LecturaPerfil> {
  try {
    const { data, error } = await supabase.from("empresa_perfil").select("email, cuentas_bancarias").eq("id", 1).maybeSingle();
    if (error) return { tipo: "error", detalle: error.message };
    const d = (data ?? {}) as { email?: string | null; cuentas_bancarias?: unknown };
    return { tipo: "ok", email: typeof d.email === "string" && d.email.trim() ? d.email.trim() : null, cuentas: cuentasUtiles(d.cuentas_bancarias) };
  } catch (e) {
    return { tipo: "error", detalle: (e as Error)?.message ?? "sin conexión" };
  }
}

function CampoReserva({ titulo, ayuda, children }: { titulo: string; ayuda: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{titulo}</span>
      {children}
      <span className="block text-[10px] text-gray-400 mt-0.5">{ayuda}</span>
    </label>
  );
}

function ReservaIA({ config, onConfig, decir, colsConfig, sinMigracion, grupos, plantillas, onReleerPlantillas }: {
  config: ConfigFila;
  onConfig: (c: ConfigFila) => void;
  decir: Decir;
  colsConfig: string;
  sinMigracion: boolean;
  /** Las condiciones que copia la IA por segmento (con reglas); null sin reglas o mientras se comprueba. */
  grupos: GrupoCondicionesIA[] | null;
  plantillas: LecturaPlantillas | null;
  onReleerPlantillas: () => void;
}) {
  const r0: ConfigReserva = config.reserva;
  const esAdmin = useEsAdmin();
  const [pct, setPct] = useState(r0.adelantoPct == null ? "" : String(r0.adelantoPct));
  const [correo, setCorreo] = useState(r0.correo ?? "");
  const [plazo, setPlazo] = useState(String(r0.plazoConfirmacionMin));
  const [margen, setMargen] = useState(String(r0.margenMin));
  const [devol, setDevol] = useState(r0.devolucionPlazoH == null ? "" : String(r0.devolucionPlazoH));
  const [guardando, setGuardando] = useState<"activa" | "campos" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [estado, setEstado] = useState<EstadoReservaServidor | null>(null);
  const [nE, setNE] = useState(0);
  const [perfil, setPerfil] = useState<LecturaPerfil | null>(null);

  useEffect(() => {
    if (sinMigracion) return;
    let vivo = true;
    void leerEstadoReserva().then((r) => { if (vivo) setEstado(r); });
    return () => { vivo = false; };
  }, [nE, sinMigracion]);
  useEffect(() => {
    if (sinMigracion) return;
    let vivo = true;
    void leerPerfilReserva().then((r) => { if (vivo) setPerfil(r); });
    return () => { vivo = false; };
  }, [sinMigracion]);

  if (sinMigracion) {
    return (
      <section className="border rounded-2xl p-4 space-y-2 bg-amber-50 border-amber-200">
        <h3 className="text-sm font-bold text-gray-700">📅 Reserva y pago por la IA</h3>
        <p className="text-xs text-amber-900">
          Todavía no existe en la base: falta correr <span className="font-mono">{SQL_RESERVA_IA}</span> (y antes <span className="font-mono">supabase/reservas-09a-solicitudes.sql</span>, <span className="font-mono">reservas-09b-comprobantes.sql</span>, <span className="font-mono">reservas-09c-pagos-solicitud.sql</span> y <span className="font-mono">cotizaciones-06-politica-reserva.sql</span>) en Supabase → SQL Editor (pegar entero → Run). Hasta entonces la IA cotiza, pero no reserva ni pide pagos.
        </p>
      </section>
    );
  }

  const lPct = leerPctAdelanto(pct);
  const lCorreo = leerCorreos(correo);
  const lPlazo = leerEntero(plazo, LIM_RESERVA.plazo[0], LIM_RESERVA.plazo[1]);
  const lMargen = leerEntero(margen, LIM_RESERVA.margen[0], LIM_RESERVA.margen[1]);
  const lDevol = leerEntero(devol, LIM_RESERVA.devolucion[0], LIM_RESERVA.devolucion[1]);
  const pctNuevo = lPct.tipo === "ok" ? Math.round(lPct.valor * 100) / 100 : null;
  const correoNuevo = lCorreo.tipo === "ok" ? lCorreo.valor : null;
  const devolNuevo = lDevol.tipo === "ok" ? lDevol.valor : null;
  const correoCambio = (correoNuevo ?? null) !== (r0.correo ?? null);
  const sucio = pctNuevo !== r0.adelantoPct || correoCambio
    || plazo.trim() !== String(r0.plazoConfirmacionMin) || margen.trim() !== String(r0.margenMin) || devolNuevo !== r0.devolucionPlazoH;
  const motivo = lPct.tipo === "error" ? `Adelanto: ${lPct.detalle}`
    : lCorreo.tipo === "error" ? `Correo: ${lCorreo.detalle}`
      : lPlazo.tipo !== "ok" ? `Plazo para confirmar: un número entero de minutos entre ${LIM_RESERVA.plazo[0]} y ${LIM_RESERVA.plazo[1]}.`
        : lMargen.tipo !== "ok" ? `Margen antes del servicio: un número entero de minutos entre ${LIM_RESERVA.margen[0]} y ${LIM_RESERVA.margen[1]}.`
          : lDevol.tipo === "error" ? `Plazo para devolver: un número entero de horas entre ${LIM_RESERVA.devolucion[0]} y ${LIM_RESERVA.devolucion[1]}, o vacío.`
            : correoCambio && esAdmin !== true ? "El correo solo lo cambia un administrador: deja el que estaba."
              : !sucio ? "No hay cambios." : null;

  // A quién iría el correo del pago reportado: con lo escrito (o lo guardado) y el correo del perfil.
  const emailPerfil = perfil?.tipo === "ok" ? perfil.email : null;
  const dest = destinatariosReserva({ correoConfig: lCorreo.tipo === "error" ? r0.correo : correoNuevo, emailEmpresa: emailPerfil });
  const sinMoneda = perfil?.tipo === "ok" ? perfil.cuentas.filter((c) => monedaDeCuenta(c.moneda) == null) : [];
  // La política de cada plantilla contra lo que se está escribiendo (el % y el plazo de devolución).
  const cfgBorrador = { adelantoPct: pctNuevo, devolucionPlazoH: devolNuevo };

  const guardarActiva = async (v: boolean) => {
    if (guardando) return;
    const pctTxt = r0.adelantoPct != null ? `un adelanto del ${r0.adelantoPct} % del total` : "ningún adelanto (no hay porcentaje guardado: cada reserva va «disponibilidad primero» y el ejecutivo pide el pago)";
    const msg = v
      ? `¿Encender la reserva por la IA?\n\nCuando un cliente acepte por WhatsApp una cotización de traslado, la IA registra su pedido de reserva y, según el horario del equipo y la zona, le pide ${pctTxt} con las cuentas de la plantilla, o le dice que un ejecutivo confirma la unidad.\n\nLos comprobantes que mande van a ${dest.correos.length ? dest.correos.join(", ") : "nadie (no hay correo de reservas ni correo del perfil)"} y a la tarjeta de su chat en el CRM. El adelanto lo registra Tesorería al verlo en el banco.\n\nSolo funciona con «La IA cotiza traslados» encendida y el agente autónomo en WhatsApp.`
      : "¿Apagar la reserva por la IA?\n\nLa IA deja de ofrecer reservar. Las solicitudes que ya existen siguen en la bandeja del CRM y en Tesorería.";
    if (!window.confirm(msg)) return;
    setGuardando("activa"); setError(null);
    const r = filasEscritas<Record<string, unknown>>(
      await supabase.from("traslados_config").upsert({ id: 1, reserva_ia: v }, { onConflict: "id" }).select(colsConfig),
      v ? "No se encendió la reserva por la IA" : "No se apagó la reserva por la IA");
    setGuardando(null);
    if (!r.ok) { setError(r.detalle); return; }
    onConfig(normalizarConfig(r.filas[0]));
    decir(v ? "Reserva por la IA encendida." : "Reserva por la IA apagada.");
    setNE((x) => x + 1);
  };

  const guardarCampos = async () => {
    if (motivo || guardando || lPlazo.tipo !== "ok" || lMargen.tipo !== "ok") return;
    setGuardando("campos"); setError(null);
    const fila: Record<string, unknown> = {
      id: 1, reserva_adelanto_pct: pctNuevo, reserva_plazo_confirmacion_min: lPlazo.valor,
      reserva_margen_min: lMargen.valor, reserva_devolucion_plazo_h: devolNuevo,
    };
    // El correo SOLO si cambió: así guardar lo demás nunca choca con la regla de seguridad-05.
    if (correoCambio) fila.reserva_correo = correoNuevo;
    const r = filasEscritas<Record<string, unknown>>(
      await supabase.from("traslados_config").upsert(fila, { onConflict: "id" }).select(colsConfig), "No se guardó la reserva por la IA");
    setGuardando(null);
    if (!r.ok) { setError(r.detalle); return; }
    const c = normalizarConfig(r.filas[0]);
    onConfig(c);
    setPct(c.reserva.adelantoPct == null ? "" : String(c.reserva.adelantoPct));
    setCorreo(c.reserva.correo ?? "");
    setPlazo(String(c.reserva.plazoConfirmacionMin)); setMargen(String(c.reserva.margenMin));
    setDevol(c.reserva.devolucionPlazoH == null ? "" : String(c.reserva.devolucionPlazoH));
    decir("Reserva por la IA guardada.");
    setNE((x) => x + 1);
  };
  const descartar = () => {
    setPct(r0.adelantoPct == null ? "" : String(r0.adelantoPct)); setCorreo(r0.correo ?? "");
    setPlazo(String(r0.plazoConfirmacionMin)); setMargen(String(r0.margenMin));
    setDevol(r0.devolucionPlazoH == null ? "" : String(r0.devolucionPlazoH)); setError(null);
  };

  const ambarServidor = estado?.tipo === "ok" && estado.ambar === true;
  return (
    <section className={`border rounded-2xl p-4 space-y-3 ${ambarServidor ? "bg-amber-50 border-amber-200" : "bg-white"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="text-sm font-bold text-gray-700 flex-1">📅 Reserva y pago por la IA</h3>
        <Link href="/tesoreria?tab=adelantos" className="text-[11px] font-bold text-[#0b315f] underline">Tesorería → Adelantos de reservas →</Link>
      </div>
      <p className="text-xs text-gray-500">
        Cuando el cliente acepta por WhatsApp una cotización de traslado, la IA registra su pedido de reserva: o le pide el adelanto con las cuentas del PDF (si el equipo alcanza a confirmar a tiempo y la zona tiene envío automático), o le dice que un ejecutivo confirma la unidad. La unidad la confirma siempre una persona desde la tarjeta del chat en el CRM, y el adelanto lo registra Tesorería al verlo en el banco: la foto del cliente no es un cobro.
      </p>

      <Casilla marcada={r0.activa} ocupada={guardando === "activa"} bloqueada={guardando === "campos"}
        onCambiar={(v) => void guardarActiva(v)} titulo="La IA reserva traslados y pide el adelanto"
        detalle="Apagada, la IA cotiza pero no ofrece reservar: el cliente que acepta la cotización lo atiende un ejecutivo." />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <CampoReserva titulo="Adelanto (% del total)" ayuda="Vacío = no se pide pago: cada reserva va «disponibilidad primero». Cambiarlo no cambia lo que ya se le pidió a un cliente.">
          <input className={iCls("font-mono")} inputMode="decimal" value={pct} placeholder="Ej.: 50" onChange={(e) => setPct(e.target.value)} />
        </CampoReserva>
        <CampoReserva titulo="Plazo para confirmar la unidad (minutos de atención)" ayuda={`Minutos dentro del horario del equipo para verificar el pago y confirmar (${LIM_RESERVA.plazo[0]}–${LIM_RESERVA.plazo[1]}).`}>
          <input className={iCls("font-mono")} inputMode="numeric" value={plazo} onChange={(e) => setPlazo(e.target.value)} />
        </CampoReserva>
        <CampoReserva titulo="Margen antes del servicio (minutos)" ayuda={`Minutos reales entre esa confirmación y el inicio del servicio (${LIM_RESERVA.margen[0]}–${LIM_RESERVA.margen[1]}). Si no alcanza, primero se confirma la unidad.`}>
          <input className={iCls("font-mono")} inputMode="numeric" value={margen} onChange={(e) => setMargen(e.target.value)} />
        </CampoReserva>
        <CampoReserva titulo="Plazo para devolver (horas)" ayuda={`Lo que se le promete al cliente al devolver (${LIM_RESERVA.devolucion[0]}–${LIM_RESERVA.devolucion[1]}). Vacío = el mensaje no promete un plazo.`}>
          <input className={iCls("font-mono")} inputMode="numeric" value={devol} onChange={(e) => setDevol(e.target.value)} />
        </CampoReserva>
        <div className="sm:col-span-2">
          <CampoReserva titulo="Correo que recibe los comprobantes de pago"
            ayuda={esAdmin === false ? "" : "Varios separados por coma. Vacío = el correo del perfil de la empresa. Llevan datos del cliente y la foto del comprobante."}>
            <input className={iCls()} value={correo} onChange={(e) => setCorreo(e.target.value)} readOnly={esAdmin !== true}
              aria-readonly={esAdmin !== true} placeholder={esAdmin === true ? "tesoreria@empresa.com, operaciones@empresa.com" : ""} />
          </CampoReserva>
          {esAdmin === false && (
            <p className="text-[11px] text-gray-500 mt-0.5">Solo lectura: {SOLO_ADMIN_CORREO_RESERVA.replace(" Pídeselo a un administrador; lo demás se guarda sin tocar el correo.", "")} Pídeselo a un administrador.</p>
          )}
          {esAdmin == null && <p className="text-[11px] text-gray-400 mt-0.5">Comprobando si puedes cambiar el correo…</p>}
          <p className="text-[11px] text-gray-600 mt-1">
            {dest.correos.length
              ? <>Los comprobantes van a <b>{dest.correos.join(", ")}</b> ({FUENTE_CORREO_RESERVA[dest.fuente!]}).</>
              : perfil == null ? "Comprobando a quién iría el correo…"
                : <span className="text-amber-900">No hay correo de reservas ni correo en el perfil de la empresa: el aviso de pago reportado no le llega a nadie (sí a la tarjeta del CRM).</span>}
          </p>
        </div>
      </div>

      {perfil?.tipo === "error" && <p className="text-xs text-red-700">No se pudieron leer las cuentas del perfil de la empresa: {perfil.detalle}</p>}
      {sinMoneda.length > 0 && (
        <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          {sinMoneda.length === 1 ? "Una cuenta bancaria del perfil no declara" : `${sinMoneda.length} cuentas bancarias del perfil no declaran`} su moneda ({sinMoneda.map((c) => c.banco).join(", ")}): se le envían al cliente tanto si paga en soles como en dólares. Márcala en <Link href="/configuracion/perfil" className="font-bold underline">Configuración → Perfil de la empresa</Link>.
        </p>
      )}

      <div className="space-y-1.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Política de reserva, cambios y cancelación que envía la IA</p>
        {plantillas == null ? (
          <p className="text-xs text-gray-400">Comprobando las plantillas del PDF del traslado…</p>
        ) : !plantillas.ok ? (
          <p className="text-xs text-red-700">No se pudieron leer las plantillas ({plantillas.error}).{" "}<button type="button" onClick={onReleerPlantillas} className="font-bold underline">Reintentar</button></p>
        ) : !grupos ? (
          <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">Falta correr <span className="font-mono">{SQL_PLANTILLAS_USO}</span>: la política sale de la plantilla PDF del traslado, y sin ese SQL la IA no tiene una política que enviar.</p>
        ) : grupos.map((g) => {
          const choques = g.reserva.propia ? politicaContradiceConfig(g.reserva.items, cfgBorrador) : [];
          const sinPolitica = !g.reserva.propia || g.reserva.items.length === 0;
          return (
            <div key={g.clave} className={`rounded-xl border px-3 py-2 text-xs space-y-1 ${sinPolitica || choques.length ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-200 text-gray-700"}`}>
              <p>
                <b>{g.segmentos.map((x) => ETIQUETA_SEGMENTO[x.segmento]).join(" · ")}:</b>{" "}
                {g.fuente.tipo === "plantilla"
                  ? <>plantilla «{g.fuente.plantilla.nombre || g.fuente.plantilla.id}» · {sinPolitica ? "sin política: la IA no tiene qué enviar" : `${g.reserva.items.length} ${g.reserva.items.length === 1 ? "línea" : "líneas"}`}{" "}
                    <Link href={enlaceEditarPlantilla(g.fuente.plantilla.id)} className="font-bold underline">Editar →</Link></>
                  : <>sin una plantilla que la IA pueda usar: no hay política que enviar. <Link href="/cotizaciones/plantillas" className="font-bold underline">Asignar una plantilla →</Link></>}
              </p>
              {choques.map((c, i) => (
                <p key={i} className="break-words">⚠ «{c.linea}» dice {c.leido}{c.codigo === "adelanto_pct" ? " % de adelanto" : " h para devolver"} y aquí dice {c.config}{c.codigo === "adelanto_pct" ? " %" : " h"}: el cliente leería dos cosas distintas. Corrige la plantilla o el número.</p>
              ))}
            </div>
          );
        })}
      </div>

      <div className={`rounded-xl border px-3 py-2 text-xs space-y-1 ${ambarServidor ? "border-amber-300 text-amber-900 bg-white/60" : "border-gray-200 text-gray-700 bg-gray-50"}`}>
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wide opacity-70 flex-1">Lo que hace hoy (con lo guardado)</p>
          <button type="button" onClick={() => { setEstado(null); setNE((x) => x + 1); }} className="text-[11px] underline opacity-70">↻</button>
        </div>
        {estado == null ? (
          <p className="text-gray-400">Comprobando con el servidor…</p>
        ) : estado.tipo === "sin_crm" ? (
          <p className="text-gray-500">Lo que hace la IA de verdad (agente autónomo, horario del equipo, cuentas) lo comprueba /crm/agente, y para verlo desde aquí hace falta el módulo CRM.</p>
        ) : estado.tipo === "error" ? (
          <p className="text-red-700">No se pudo comprobar: {estado.detalle}</p>
        ) : estado.lineas?.length ? (
          estado.lineas.map((l, i) => <p key={i} className={ambarServidor && i === 0 ? "font-bold" : ""}>{l}</p>)
        ) : (
          <p className="text-gray-500">El servidor no pudo leer la configuración de la reserva.</p>
        )}
      </div>

      {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void guardarCampos()} disabled={!!motivo || !!guardando}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 min-h-[44px]" style={{ background: AZUL }}>
          {guardando === "campos" ? "Guardando…" : "Guardar la reserva"}
        </button>
        {sucio && <button type="button" onClick={descartar} disabled={!!guardando} className="px-4 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50 min-h-[44px]">Descartar cambios</button>}
        {motivo && <span className="text-[11px] text-gray-500">{motivo}</span>}
      </div>
    </section>
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
