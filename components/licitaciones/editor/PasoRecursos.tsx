"use client";
// components/licitaciones/editor/PasoRecursos.tsx — Paso 2 «Recursos» del editor de /licitaciones/[id]:
// unidades, conductores, experiencia, contactos del contrato y representante legal.
//
// Sigue el contrato de contrato-editor.ts: el editor es el dueño del estado y del guardado; este paso solo
// propone cambios con `cambiarDoc` (inmutable) y pide `recargarCtx()` tras elegir o quitar recursos o subir
// un documento a una ficha. El doc guarda REFERENCIAS (claves, ids); placas, años, vencimientos y
// archivos se DERIVAN del contexto con los motores de lib/licitaciones (recursos, texto, tablas, reglas),
// los mismos de la revisión y del PDF.
//
// Reglas de la pantalla:
//  · Una lectura fallida nunca acusa: «no se pudo leer», jamás «falta» ni «no existe».
//  · Lo recién elegido todavía no está en el contexto (el editor relee con antirrebote): mientras tanto se
//    dice «comprobando…» y se callan los «ya no existe» que la revisión daría por ese desfase.
//  · Los hallazgos los da la revisión (revisarLicitacion); aquí se reparten junto a su sujeto.

import { useEffect, useMemo, useState } from "react";
import type { PasoProps } from "./contrato-editor";
import { buscarConductores, buscarUnidades, leerExperiencia, leerPersonal } from "@/lib/licitaciones/datos";
import type { ContextoLicitacion } from "@/lib/licitaciones/tipos";
import type { RefsRecurso } from "@/lib/licitaciones/recursos";
import { fechaRef } from "@/lib/licitaciones/texto";
import { fechaDMY, fechaONull } from "@/lib/licitaciones/util";
import { AccionDonde, Chip, Nota, tonoDeGravedad } from "./recursos/comun";
import { anclaDeHallazgo, cuenta, GRUPOS_RECURSOS, grupoDe, hallazgosDelPaso, TITULO_GRUPO } from "./recursos/hallazgos";
import SeccionUnidades from "./recursos/SeccionUnidades";
import SeccionConductores from "./recursos/SeccionConductores";
import SeccionExperiencia from "./recursos/SeccionExperiencia";
import SeccionContactos from "./recursos/SeccionContactos";
import SeccionRepresentante from "./recursos/SeccionRepresentante";
import type { ResPersonal } from "./recursos/SelectorPersonal";

type ResU = Awaited<ReturnType<typeof buscarUnidades>>;
type ResC = Awaited<ReturnType<typeof buscarConductores>>;
type ResE = Awaited<ReturnType<typeof leerExperiencia>>;

const fallo = (e: unknown, que: string) => ({ ok: false as const, error: `No se pudo leer ${que}: ${e instanceof Error ? e.message : String(e)}. Revisa tu conexión y vuelve a intentarlo.` });

export default function PasoRecursos(p: PasoProps) {
  const { lic, doc, ctx, revision } = p;
  const [opU, setOpU] = useState<ResU | null>(null);
  const [opC, setOpC] = useState<ResC | null>(null);
  const [cat, setCat] = useState<ResE | null>(null);
  const [pers, setPers] = useState<ResPersonal | null>(null);
  const [vezP, setVezP] = useState(0);
  const [vezU, setVezU] = useState(0);
  const [vezC, setVezC] = useState(0);
  const [vezE, setVezE] = useState(0);

  useEffect(() => {
    let vivo = true;
    buscarUnidades().then((r) => { if (vivo) setOpU(r); }, (e) => { if (vivo) setOpU(fallo(e, "la flota")); });
    return () => { vivo = false; };
  }, [vezU]);
  useEffect(() => {
    let vivo = true;
    buscarConductores().then((r) => { if (vivo) setOpC(r); }, (e) => { if (vivo) setOpC(fallo(e, "los conductores")); });
    return () => { vivo = false; };
  }, [vezC]);
  useEffect(() => {
    let vivo = true;
    leerExperiencia({ incluirInactivas: true }).then((r) => { if (vivo) setCat(r); }, (e) => { if (vivo) setCat(fallo(e, "el catálogo de experiencia")); });
    return () => { vivo = false; };
  }, [vezE]);
  useEffect(() => {
    let vivo = true;
    leerPersonal().then((r) => { if (vivo) setPers(r); }, (e) => { if (vivo) setPers(fallo(e, "el personal")); });
    return () => { vivo = false; };
  }, [vezP]);
  const recargarPersonal = () => { setPers(null); setVezP((n) => n + 1); };

  /**
   * El contexto con el personal activo encima, para Contactos y Representante: una persona recién elegida
   * todavía no está en ctx.personal (el editor relee con antirrebote) y la pantalla diría «ya no está».
   */
  const ctxPersonal = useMemo<ContextoLicitacion | null>(() => {
    if (!ctx || !pers?.ok) return ctx;
    return { ...ctx, personal: { ...Object.fromEntries(pers.filas.map((x) => [x.id, x])), ...ctx.personal } };
  }, [ctx, pers]);

  const refs = useMemo<RefsRecurso | null>(
    () => (ctx ? { presentacion: fechaRef(lic, ctx), inicio: fechaONull(lic.fecha_inicio_servicio) } : null),
    [ctx, lic]);

  // ── Lo que todavía se está comprobando (elegido hace un momento, aún no está en el contexto) ──
  const pendientes = useMemo(() => {
    const s = new Set<string>();
    const enLista = (op: ResU | ResC | null, clave: string): boolean => {
      if (!op) return true;                                         // la lista aún carga: no se sabe
      if (!op.ok || op.lecturas[clave[0] as "p" | "t"] !== "ok") return false; // sin lista se cree al contexto
      return (op.opciones as { clave: string }[]).some((o) => o.clave === clave);
    };
    for (const u of doc.unidades) {
      if (!ctx) { s.add(`unidad:${u.clave}`); continue; }
      if (ctx.lecturas.unidades !== "ok" || ctx.unidades[u.clave]) continue;
      if (p.ctxCargando || enLista(opU, u.clave)) s.add(`unidad:${u.clave}`);
    }
    for (const c of doc.conductores) {
      if (!ctx) { s.add(`conductor:${c.clave}`); continue; }
      if (ctx.lecturas.conductores !== "ok" || ctx.conductores[c.clave]) continue;
      if (p.ctxCargando || enLista(opC, c.clave)) s.add(`conductor:${c.clave}`);
    }
    for (const id of doc.experiencia.ids) {
      if (!ctx || ctx.experiencia[id]) continue;
      if (p.ctxCargando || !cat || (cat.ok && cat.filas.some((e) => e.id === id))) s.add(`experiencia:${id}`);
    }
    return s;
  }, [doc.unidades, doc.conductores, doc.experiencia.ids, ctx, p.ctxCargando, opU, opC, cat]);

  // El representante recién elegido del personal aún no está en el contexto: su «ya no está» es desfase.
  const repId = doc.representante.personalId;
  const repPendiente = repId != null && !!ctx && !ctx.personal[repId] && (p.ctxCargando || !pers || (pers.ok && pers.filas.some((x) => x.id === repId)));
  const hallazgos = useMemo(() => hallazgosDelPaso(revision?.hallazgos, pendientes)
    .filter((h) => !(repPendiente && h.codigo === "representante_incompleto")), [revision, pendientes, repPendiente]);
  const total = cuenta(hallazgos);
  const prohibe = doc.requisitos.some((q) => q.regla?.tipo === "prohibe_subcontratacion");
  const presentacion = fechaONull(lic.fecha_presentacion);

  return (
    <div className="space-y-4">
      {/* Fechas de referencia y resumen de hallazgos del paso */}
      <div className="space-y-2 rounded-2xl border border-gray-200 bg-white p-3 sm:p-4">
        <p className="text-xs text-gray-700">
          Las vigencias se miden {presentacion
            ? <>a la <b>fecha de presentación ({fechaDMY(presentacion)})</b></>
            : <>contra <b>hoy{ctx ? ` (${fechaDMY(ctx.hoy)})` : ""}</b>, porque falta la fecha de presentación</>}
          {" "}y {lic.fecha_inicio_servicio ? <>al <b>inicio del servicio ({fechaDMY(lic.fecha_inicio_servicio)})</b></> : <>no al inicio del servicio (sin fecha de inicio)</>}.
          {(!presentacion || !lic.fecha_inicio_servicio) && (
            <button type="button" onClick={() => p.irA("bases", "datos")} className="ml-1 font-semibold text-[#0b315f] underline">Completar fechas en Bases</button>
          )}
        </p>
        {!ctx ? (
          <p className="text-xs text-gray-500">Leyendo del ERP las unidades, conductores y contratos elegidos…</p>
        ) : !revision ? (
          <p className="text-xs text-gray-500">Revisando…</p>
        ) : hallazgos.length === 0 ? (
          <p className="text-xs text-emerald-700">La revisión no encuentra nada que corregir en los recursos{pendientes.size ? " (todavía se comprueba lo recién elegido)" : ""}.</p>
        ) : (
          <details className="group">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 text-xs font-semibold text-gray-700">
              <span>Revisión de los recursos:</span>
              {total.alarma > 0 && <Chip tono="rojo">{total.alarma} alarma{total.alarma === 1 ? "" : "s"}</Chip>}
              {total.aviso > 0 && <Chip tono="ambar">{total.aviso} aviso{total.aviso === 1 ? "" : "s"}</Chip>}
              {total.info > 0 && <Chip tono="gris">{total.info} nota{total.info === 1 ? "" : "s"}</Chip>}
              {total.alarma + total.aviso + total.info === 0 && <Chip tono="gris">todo aceptado</Chip>}
              <span className="text-[#0b315f] underline group-open:hidden">ver la lista</span>
              <span className="hidden text-[#0b315f] underline group-open:inline">ocultar</span>
            </summary>
            <div className="mt-2 space-y-3">
              {GRUPOS_RECURSOS.map((g) => {
                const hs = hallazgos.filter((h) => grupoDe(h) === g);
                if (!hs.length) return null;
                return (
                  <div key={g}>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{TITULO_GRUPO[g]}</p>
                    <ul className="space-y-1">
                      {hs.map((h) => (
                        <li key={h.clave} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${h.aceptado ? "text-gray-400" : ""}`}>
                          <Chip tono={h.aceptado ? "gris" : tonoDeGravedad(h.gravedad)}>{h.aceptado ? "aceptado" : h.gravedad}</Chip>
                          <span className="font-semibold">{h.sujeto.rotulo}:</span>
                          <span>{h.texto}</span>
                          <AccionDonde donde={h.donde} irA={p.irA} anclaLocal={anclaDeHallazgo(h)} />
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </details>
        )}
        {ctx && Object.entries(ctx.lecturas).some(([f, e]) => ["unidades", "conductores", "experiencia", "personal"].includes(f) && e !== "ok") && (
          <Nota tono="ambar">Una parte del ERP no se pudo leer (lo dice cada sección): de esa parte no se afirma que falte nada. Recarga la página para reintentar.</Nota>
        )}
      </div>

      <SeccionUnidades p={p} opciones={opU} recargarOpciones={() => { setOpU(null); setVezU((n) => n + 1); }}
        refs={refs} hallazgos={hallazgos} pendiente={(clave) => pendientes.has(`unidad:${clave}`)} prohibe={prohibe} />
      <SeccionConductores p={p} opciones={opC} recargarOpciones={() => { setOpC(null); setVezC((n) => n + 1); }}
        refs={refs} hallazgos={hallazgos} pendiente={(clave) => pendientes.has(`conductor:${clave}`)} prohibe={prohibe} />
      <SeccionExperiencia p={p} catalogo={cat} recargarCatalogo={() => { setCat(null); setVezE((n) => n + 1); p.recargarCtx(); }} hallazgos={hallazgos} />
      <SeccionContactos p={{ ...p, ctx: ctxPersonal }} hallazgos={hallazgos} personal={pers} recargarPersonal={recargarPersonal} />
      <SeccionRepresentante p={{ ...p, ctx: ctxPersonal }} hallazgos={hallazgos} personal={pers} recargarPersonal={recargarPersonal} />
    </div>
  );
}
