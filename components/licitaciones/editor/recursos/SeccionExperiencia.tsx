"use client";
// components/licitaciones/editor/recursos/SeccionExperiencia.tsx — Qué contratos del catálogo
// (experiencia_empresa) se acreditan en esta licitación, en qué orden salen en el cuadro y cómo.
//
// El doc guarda solo los ids (D2). Los totales salen de `totalesExperiencia`, POR MONEDA: el ERP nunca
// suma soles con dólares. «Fuera de la ventana» lo decide la misma regla que usa la revisión
// (experiencia_ventana_anios de lib/licitaciones/reglas): la pantalla no tiene su propia cuenta de años.

import { useMemo, useState } from "react";
import Link from "next/link";
import { evaluarRegla } from "@/lib/licitaciones/reglas";
import { fechaRef, totalesExperiencia } from "@/lib/licitaciones/texto";
import { fmtImporte, mesAnio } from "@/lib/licitaciones/util";
import { coincideBusqueda, terminosBusqueda } from "@/lib/busqueda-texto";
import type { leerExperiencia } from "@/lib/licitaciones/datos";
import type { ContextoLicitacion, Experiencia, Hallazgo, SustentoTipo } from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "../contrato-editor";
import { AreaTexto, Boton, CampoEntero, Chip, Etiqueta, ListaHallazgos, Nota, Seccion } from "./comun";
import ExigenciasBases from "./ExigenciasBases";
import { deSujeto, generalesDe } from "./hallazgos";

type ResE = Awaited<ReturnType<typeof leerExperiencia>>;
const SUSTENTO: Record<SustentoTipo, string> = { oc: "OC", factura: "Factura", carta: "Carta", contrato: "Contrato", conformidad: "Conformidad", otro: "Otro" };

export default function SeccionExperiencia({ p, catalogo, recargarCatalogo, hallazgos }: {
  p: PasoProps; catalogo: ResE | null; recargarCatalogo: () => void; hallazgos: Hallazgo[];
}) {
  const { lic, doc, ctx, soloLectura } = p;
  const sel = doc.experiencia;
  const [busqueda, setBusqueda] = useState("");
  const [verFuera, setVerFuera] = useState(false);
  const [verInactivas, setVerInactivas] = useState(false);

  const porId = useMemo(() => new Map((catalogo?.ok ? catalogo.filas : []).map((e) => [e.id, e])), [catalogo]);
  /** El contexto con el catálogo encima: un contrato recién marcado todavía no está en ctx.experiencia. */
  const ctxExp = useMemo<ContextoLicitacion | null>(() => {
    if (!ctx) return null;
    if (!catalogo?.ok) return ctx;
    return { ...ctx, experiencia: { ...ctx.experiencia, ...Object.fromEntries(porId) }, lecturas: { ...ctx.lecturas, experiencia: "ok" } };
  }, [ctx, catalogo, porId]);
  const expDe = (id: number): Experiencia | undefined => porId.get(id) ?? ctx?.experiencia[id];

  /** ¿Fuera de la ventana de N años? La responde la regla del motor sobre ese solo contrato. null = no se juzga. */
  const fuera = useMemo(() => {
    const m = new Map<number, boolean>();
    if (!ctxExp || !sel.ventanaAnios) return m;
    const ref = fechaRef(lic, ctxExp);
    const todas = new Map<number, Experiencia>([...Object.values(ctxExp.experiencia).map((e) => [e.id, e] as [number, Experiencia])]);
    for (const e of todas.values()) {
      const sub = { ...lic, doc: { ...doc, experiencia: { ...sel, ids: [e.id] } } };
      const r = evaluarRegla({ tipo: "experiencia_ventana_anios", anios: sel.ventanaAnios }, sub, { ...ctxExp, experiencia: { [e.id]: e } }, ref);
      m.set(e.id, r.estado === "no_cumple");
    }
    return m;
  }, [ctxExp, sel, lic, doc]);

  const totales = ctxExp ? totalesExperiencia(doc, ctxExp) : [];
  const elegidos = sel.ids;
  const sinImporte = elegidos.filter((id) => { const e = expDe(id); return e && e.importe == null; }).length;

  const cambiarSel = (cambio: Partial<typeof sel>) => p.cambiarDoc((d) => ({ ...d, experiencia: { ...d.experiencia, ...cambio } }));
  const alternar = (id: number) => {
    p.cambiarDoc((d) => {
      const ids = d.experiencia.ids.includes(id) ? d.experiencia.ids.filter((x) => x !== id) : [...d.experiencia.ids, id];
      return { ...d, experiencia: { ...d.experiencia, ids } };
    });
    p.recargarCtx();
  };
  const mover = (k: number, dir: -1 | 1) => p.cambiarDoc((d) => {
    const ids = [...d.experiencia.ids];
    const j = k + dir;
    if (j < 0 || j >= ids.length) return d;
    [ids[k], ids[j]] = [ids[j], ids[k]];
    return { ...d, experiencia: { ...d.experiencia, ids } };
  });

  const terminos = terminosBusqueda(busqueda);
  const visibles = (catalogo?.ok ? catalogo.filas : []).filter((e) => {
    if (elegidos.includes(e.id)) return false;
    if (!e.activo && !verInactivas) return false;
    if (sel.ventanaAnios && fuera.get(e.id) && !verFuera) return false;
    return coincideBusqueda([e.cliente_nombre, e.objeto, e.zona, e.sector, e.cliente_ruc].filter(Boolean).join(" "), terminos);
  });
  const ocultosFuera = sel.ventanaAnios ? (catalogo?.ok ? catalogo.filas : []).filter((e) => !elegidos.includes(e.id) && (e.activo || verInactivas) && fuera.get(e.id)).length : 0;
  const ocultosInactivos = (catalogo?.ok ? catalogo.filas : []).filter((e) => !elegidos.includes(e.id) && !e.activo).length;

  const periodo = (e: Experiencia) => `${mesAnio(e.inicio)} – ${e.vigente ? "vigente" : mesAnio(e.fin)}`;
  const chips = (e: Experiencia) => (
    <>
      {!e.activo && <Chip tono="gris">Desactivada en el catálogo</Chip>}
      {sel.ventanaAnios && fuera.get(e.id) && <Chip tono="ambar">Fuera de los últimos {sel.ventanaAnios} años</Chip>}
      {e.importe == null && <Chip tono="gris">Sin importe</Chip>}
      {!e.sustentos.length && <Chip tono="gris">Sin archivo de sustento</Chip>}
    </>
  );

  return (
    <Seccion id="experiencia" titulo="Experiencia"
      subtitulo="Los contratos que se acreditan, en el orden en que salen en el cuadro de experiencia."
      acciones={<>
        <Link href="/licitaciones?tab=experiencia" target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-[#0b315f] underline">Gestionar experiencia ↗</Link>
        <Boton chico onClick={recargarCatalogo} disabled={!catalogo}>↻ Volver a leer el catálogo</Boton>
      </>}>
      <ListaHallazgos hallazgos={generalesDe(hallazgos, "experiencia")} irA={p.irA} />
      <ExigenciasBases requisitos={doc.requisitos} revision={p.revision} tipos={(t) => t.startsWith("experiencia")} irA={p.irA} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Etiqueta texto="Solo los de los últimos N años" ayuda={sel.ventanaAnios ? "Los contratos que terminaron antes se ocultan del catálogo; si alguno está elegido, la revisión lo avisa." : "Vacío = todos los contratos."}>
          <CampoEntero valor={sel.ventanaAnios} onCambio={(v) => cambiarSel({ ventanaAnios: v })} min={1} max={100} disabled={soloLectura} placeholder="Todos" />
        </Etiqueta>
        <label className="flex items-start gap-2 pt-5 text-sm text-gray-700 sm:col-span-2">
          <input type="checkbox" className="mt-1 h-4 w-4" disabled={soloLectura} checked={sel.conContacto} onChange={(e) => cambiarSel({ conContacto: e.target.checked })} />
          <span>El cuadro lleva la columna «Datos de contacto» (nombre y teléfono del contacto de cada cliente).</span>
        </label>
      </div>
      <Etiqueta texto="Introducción del cuadro" ayuda="Admite **negrita** y variables como {empresa} o {cliente}.">
        <AreaTexto valor={sel.introduccion} onCambio={(v) => cambiarSel({ introduccion: v })} disabled={soloLectura} filas={3}
          placeholder="Por medio del presente detallamos la experiencia de nuestra empresa…" />
      </Etiqueta>

      {/* Elegidos, en el orden del cuadro */}
      <div>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs font-semibold text-gray-600">Contratos elegidos ({elegidos.length})</p>
          <p className="text-xs text-gray-700">
            {!ctxExp ? <span className="text-gray-400">calculando…</span>
              : totales.length ? <>Total acreditado: {totales.map((t) => <b key={t.moneda} className="ml-1">{fmtImporte(t.importe, t.moneda)} <span className="font-normal text-gray-500">({t.n} contrato{t.n === 1 ? "" : "s"})</span></b>)}</>
              : elegidos.length ? <span className="text-gray-500">Sin importes registrados</span> : null}
            {sinImporte > 0 && <span className="ml-2 text-gray-500">· {sinImporte} sin importe</span>}
          </p>
        </div>
        {totales.length > 1 && <Nota tono="gris">Hay contratos en soles y en dólares: se totalizan por separado (el ERP no convierte monedas).</Nota>}
        {!elegidos.length ? (
          <p className="text-sm text-gray-500">Todavía no hay contratos elegidos.</p>
        ) : (
          <ol className="mt-1 space-y-2">
            {elegidos.map((id, k) => {
              const e = expDe(id);
              const hs = deSujeto(hallazgos, "experiencia", String(id));
              return (
                <li key={id} id={anclaDe("experiencia", id)} className="scroll-mt-24 rounded-xl border border-gray-200 p-2.5">
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="mt-0.5 w-6 text-center text-xs font-bold text-gray-500">{k + 1}</span>
                    <div className="min-w-0 flex-1">
                      {e ? (
                        <>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-bold text-gray-900">{e.cliente_nombre}</span>
                            {chips(e)}
                          </div>
                          <p className="text-xs text-gray-600">{e.objeto} · {periodo(e)}{e.zona ? ` · ${e.zona}` : ""}</p>
                          <p className="text-xs text-gray-600">
                            {e.importe != null ? <b>{fmtImporte(e.importe, e.moneda)}</b> : "—"}
                            {e.sustento_tipo ? ` · ${SUSTENTO[e.sustento_tipo]}${e.sustento_ref ? ` ${e.sustento_ref}` : ""}` : ""}
                            {sel.conContacto && ` · contacto: ${[e.contacto_nombre, e.contacto_telefono].filter(Boolean).join(" – ") || "—"}`}
                          </p>
                        </>
                      ) : !catalogo || !ctx || p.ctxCargando ? (
                        <p className="text-xs text-gray-500">Comprobando el contrato #{id}…</p>
                      ) : !catalogo.ok ? (
                        <p className="text-xs text-amber-800">No se pudo leer el catálogo: no se sabe si el contrato #{id} sigue registrado.</p>
                      ) : (
                        <p className="text-xs text-red-700">El contrato #{id} ya no está en el catálogo de experiencia.</p>
                      )}
                    </div>
                    {!soloLectura && (
                      <div className="flex flex-shrink-0 items-center gap-1">
                        <Boton chico tono="suave" onClick={() => mover(k, -1)} disabled={k === 0} title="Subir en el cuadro">↑</Boton>
                        <Boton chico tono="suave" onClick={() => mover(k, 1)} disabled={k === elegidos.length - 1} title="Bajar en el cuadro">↓</Boton>
                        <Boton chico tono="peligro" onClick={() => alternar(id)}>Quitar</Boton>
                      </div>
                    )}
                  </div>
                  {hs.length > 0 && <div className="mt-2"><ListaHallazgos hallazgos={hs} irA={p.irA} /></div>}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Catálogo */}
      {!soloLectura && (
        <div className="rounded-xl border border-dashed border-gray-300 p-3">
          <p className="mb-2 text-xs font-semibold text-gray-600">Agregar del catálogo</p>
          {!catalogo ? (
            <p className="text-xs text-gray-500">Cargando el catálogo de experiencia…</p>
          ) : !catalogo.ok ? (
            <Nota tono={catalogo.sinMigracion ? "ambar" : "rojo"}>{catalogo.error} <button type="button" className="font-semibold underline" onClick={recargarCatalogo}>Reintentar</button></Nota>
          ) : !catalogo.filas.length ? (
            <p className="text-xs text-gray-500">El catálogo está vacío: registra los contratos en <Link href="/licitaciones?tab=experiencia" target="_blank" rel="noopener noreferrer" className="font-semibold text-[#0b315f] underline">Licitaciones → Experiencia ↗</Link> y vuelve a leerlo.</p>
          ) : (
            <>
              <input type="search" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Busca por cliente, objeto, zona o RUC…"
                aria-label="Buscar en el catálogo de experiencia" className="mb-2 w-full rounded-lg border border-gray-300 px-2.5 py-2 text-sm" />
              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                {sel.ventanaAnios != null && ocultosFuera > 0 && (
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={verFuera} onChange={(e) => setVerFuera(e.target.checked)} /> Ver también los {ocultosFuera} de fuera de los últimos {sel.ventanaAnios} años</label>
                )}
                {ocultosInactivos > 0 && (
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={verInactivas} onChange={(e) => setVerInactivas(e.target.checked)} /> Ver los {ocultosInactivos} desactivados</label>
                )}
              </div>
              {!visibles.length ? (
                <p className="text-xs text-gray-500">{busqueda.trim() ? `Ningún contrato coincide con «${busqueda.trim()}».` : "No queda ningún contrato por elegir con estos filtros."}</p>
              ) : (
                <ul className="max-h-80 space-y-1 overflow-y-auto">
                  {visibles.map((e) => (
                    <li key={e.id}>
                      <label className="flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50">
                        <input type="checkbox" className="mt-1 h-4 w-4" checked={false} onChange={() => alternar(e.id)} />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5"><span className="text-sm font-semibold text-gray-800">{e.cliente_nombre}</span>{chips(e)}</span>
                          <span className="block text-xs text-gray-500">{e.objeto} · {periodo(e)} · {e.importe != null ? fmtImporte(e.importe, e.moneda) : "sin importe"}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Seccion>
  );
}
