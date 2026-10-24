"use client";
// components/licitaciones/editor/recursos/SeccionUnidades.tsx — Las UNIDADES de la licitación.
//
// El doc guarda solo la clave de cada unidad (p:12 / t:5), su código, rol, uso y la capacidad que exigen
// las bases (D2). Todo lo demás —placa, año, asientos, documentos, fotos— se DERIVA del contexto con
// `resumenUnidad`, el mismo motor que usan la revisión y el expediente: si aquí dice que el SOAT vence,
// la revisión dice lo mismo.
//
// La lista se pinta en ORDEN DE CÓDIGO (`unidadesPorCodigo`, el de la relación de unidades impresa).
// «Subir/bajar» intercambia el código con la vecina y los conductores asignados siguen a SU unidad.

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import ComboBuscador, { Resaltado, type ArmadoCombo, type OpcionCombo } from "@/components/ComboBuscador";
import { ImgPrivada } from "@/components/ArchivoPrivado";
import { buscarUnidades, guardarAnioTercero, SQL_LICITACIONES, type OpcionUnidad } from "@/lib/licitaciones/datos";
import { ETIQUETA_DOC_UNIDAD, resumenUnidad, type DocUnidadResumen, type RefsRecurso, type ResumenUnidad } from "@/lib/licitaciones/recursos";
import { unidadesPorCodigo } from "@/lib/licitaciones/tablas";
import { origenArchivo } from "@/lib/licitaciones/archivos";
import { anioDe } from "@/lib/licitaciones/util";
import { baseSupabase } from "@/lib/storage-privado";
import { coincideBusqueda, terminosBusqueda } from "@/lib/busqueda-texto";
import {
  DOCS_UNIDAD_LIC, TOPES_DOC,
  type DocLicitacion, type DocUnidadLic, type Hallazgo, type RolUnidad, type UnidadElegida, type UnidadERP,
} from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "../contrato-editor";
import { ArchivoOrigen, Boton, CampoEntero, CampoTexto, Chip, ChipVigencia, dmy, Etiqueta, hrefSeguro, ListaHallazgos, Nota, Seccion } from "./comun";
import { deSujeto, generalesDe } from "./hallazgos";
import ModalDocUnidad from "./ModalDocUnidad";

type ResU = Awaited<ReturnType<typeof buscarUnidades>>;

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
const LIMITE = 50;

/** El primer código libre del rol: U1, U2… para titulares; R1, R2… para retén. Solo una SUGERENCIA. */
export function siguienteCodigo(us: readonly UnidadElegida[], rol: RolUnidad, excepto?: string): string {
  const pref = rol === "reten" ? "R" : "U";
  const usados = new Set(us.filter((u) => u.id !== excepto).map((u) => norm(u.codigo)));
  let n = 1;
  while (usados.has(`${pref}${n}`)) n++;
  return `${pref}${n}`;
}

/**
 * Cambia códigos de unidades (id → código nuevo) y hace que los conductores asignados a un código que
 * era ÚNICO sigan a su unidad. Con un código repetido no se sabe de cuál de las dos era: no se toca.
 */
function aplicarCodigos(d: DocLicitacion, nuevos: Map<string, string>): DocLicitacion {
  const cuenta = new Map<string, number>();
  for (const u of d.unidades) { const k = norm(u.codigo); if (k) cuenta.set(k, (cuenta.get(k) ?? 0) + 1); }
  const traduce = new Map<string, string>();
  for (const u of d.unidades) {
    const nv = nuevos.get(u.id);
    if (nv === undefined) continue;
    const v = norm(u.codigo);
    if (v && cuenta.get(v) === 1 && v !== nv) traduce.set(v, nv);
  }
  return {
    ...d,
    unidades: d.unidades.map((u) => (nuevos.has(u.id) ? { ...u, codigo: nuevos.get(u.id) as string } : u)),
    conductores: traduce.size
      ? d.conductores.map((c) => { const k = norm(c.unidadCodigo); return k && traduce.has(k) ? { ...c, unidadCodigo: traduce.get(k) || null } : c; })
      : d.conductores,
  };
}

const textoOpcion = (o: OpcionUnidad) =>
  [o.placa, o.marca, o.modelo, o.categoria, o.empresa, o.capacidad ? `${o.capacidad} asientos` : null, o.anio, o.flota === "p" ? "propia" : "tercerizada"].filter(Boolean).join(" ");

export default function SeccionUnidades({ p, opciones, recargarOpciones, refs, hallazgos, pendiente, prohibe }: {
  p: PasoProps; opciones: ResU | null; recargarOpciones: () => void; refs: RefsRecurso | null;
  hallazgos: Hallazgo[]; pendiente: (clave: string) => boolean; prohibe: boolean;
}) {
  const { lic, doc, ctx, soloLectura } = p;
  const [flota, setFlota] = useState<"todas" | "p" | "t">("todas");
  const [modal, setModal] = useState<{ u: UnidadERP; doc: DocUnidadLic; resumen: DocUnidadResumen } | null>(null);
  const orden = useMemo(() => unidadesPorCodigo(lic), [lic]);
  const elegidas = useMemo(() => new Map(doc.unidades.map((u) => [u.clave as string, u])), [doc.unidades]);
  const opPorClave = useMemo(() => new Map((opciones?.ok ? opciones.opciones : []).map((o) => [o.clave as string, o])), [opciones]);
  const lleno = doc.unidades.length >= TOPES_DOC.maxUnidades;

  const armar = useCallback((q: string): ArmadoCombo<OpcionUnidad> => {
    if (!opciones?.ok) return { opciones: [], pies: [] };
    const terminos = terminosBusqueda(q);
    const lista = opciones.opciones.filter((o) => (flota === "todas" || o.flota === flota) && coincideBusqueda(textoOpcion(o), terminos));
    const seccion = (o: OpcionUnidad) => (!o.activo ? "Inactivas" : o.flota === "p" ? "Flota propia" : "Tercerizadas");
    const rango: Record<string, number> = { "Flota propia": 0, Tercerizadas: 1, Inactivas: 2 };
    const ordenada = [...lista].sort((a, b) => rango[seccion(a)] - rango[seccion(b)]);
    const ops: OpcionCombo<OpcionUnidad>[] = ordenada.slice(0, LIMITE).map((o) => ({ tipo: "item", clave: o.clave, dato: o, seccion: seccion(o) }));
    const pies: string[] = [];
    if (ordenada.length > LIMITE) pies.push(`y ${ordenada.length - LIMITE} más: ${q ? "afina la búsqueda" : "escribe placa, marca o empresa para buscar"}`);
    return { opciones: ops, pies };
  }, [opciones, flota]);

  const agregar = (o: OpcionUnidad) => {
    const ya = elegidas.get(o.clave);
    if (ya) { p.aviso(`${o.placa} ya está en la lista como ${ya.codigo || "unidad sin código"}.`, "aviso"); p.irA("recursos", anclaDe("unidad", ya.id)); return; }
    if (lleno) { p.aviso(`El tope es de ${TOPES_DOC.maxUnidades} unidades por licitación.`, "aviso"); return; }
    const id = p.nuevoId();
    p.cambiarDoc((d) => (d.unidades.some((u) => u.clave === o.clave) ? d : {
      ...d, unidades: [...d.unidades, { id, clave: o.clave, codigo: siguienteCodigo(d.unidades, "titular"), rol: "titular", uso: "", capacidadExigida: null }],
    }));
    p.recargarCtx();
  };

  const renombrar = (id: string, nuevo: string) =>
    p.cambiarDoc((d) => aplicarCodigos(d, new Map([[id, norm(nuevo).slice(0, 20)]])));

  const cambiarRol = (el: UnidadElegida, rol: RolUnidad) => p.cambiarDoc((d) => {
    const actual = d.unidades.find((u) => u.id === el.id);
    if (!actual || actual.rol === rol) return d;
    const c = norm(actual.codigo);
    const automatico = rol === "reten" ? /^U\d+$/.test(c) : /^R\d+$/.test(c);
    const d2 = { ...d, unidades: d.unidades.map((u) => (u.id === el.id ? { ...u, rol } : u)) };
    return automatico ? aplicarCodigos(d2, new Map([[el.id, siguienteCodigo(d2.unidades, rol, el.id)]])) : d2;
  });

  const cambiar = (id: string, cambio: Partial<UnidadElegida>) =>
    p.cambiarDoc((d) => ({ ...d, unidades: d.unidades.map((u) => (u.id === id ? { ...u, ...cambio } : u)) }));

  const mover = (k: number, dir: -1 | 1) => {
    const a = orden[k], b = orden[k + dir];
    if (!a || !b) return;
    p.cambiarDoc((d) => aplicarCodigos(d, new Map([[a.id, norm(b.codigo)], [b.id, norm(a.codigo)]])));
  };

  const renumerar = () => {
    const t = doc.unidades.filter((u) => u.rol === "titular").length, r = doc.unidades.length - t;
    const que = [t ? `titulares U1${t > 1 ? `…U${t}` : ""}` : null, r ? `retén R1${r > 1 ? `…R${r}` : ""}` : null].filter(Boolean).join(" y ");
    if (!window.confirm(`¿Renumerar las ${doc.unidades.length} unidades en el orden actual (${que})? Los conductores asignados siguen a su unidad.`)) return;
    p.cambiarDoc((d) => {
      const ord = unidadesPorCodigo({ ...lic, doc: d });
      let iu = 0, ir = 0;
      return aplicarCodigos(d, new Map(ord.map((u) => [u.id, u.rol === "reten" ? `R${++ir}` : `U${++iu}`])));
    });
  };

  const quitar = (el: UnidadElegida) => {
    const placa = ctx?.unidades[el.clave]?.placa ?? opPorClave.get(el.clave)?.placa ?? el.clave;
    const c = norm(el.codigo);
    const unico = !!c && doc.unidades.filter((u) => norm(u.codigo) === c).length === 1;
    const afectados = unico ? doc.conductores.filter((x) => norm(x.unidadCodigo) === c) : [];
    const nombres = afectados.slice(0, 3).map((x) => ctx?.conductores[x.clave]?.nombre ?? x.clave).join(", ");
    const extra = afectados.length ? ` ${afectados.length === 1 ? "El conductor asignado" : `Los ${afectados.length} conductores asignados`} a ${el.codigo} (${nombres}${afectados.length > 3 ? "…" : ""}) quedará${afectados.length === 1 ? "" : "n"} sin unidad.` : "";
    if (!window.confirm(`¿Quitar ${el.codigo || "la unidad"} (${placa}) de esta licitación?${extra} La unidad sigue en la flota del ERP.`)) return;
    p.cambiarDoc((d) => ({
      ...d,
      unidades: d.unidades.filter((u) => u.id !== el.id),
      conductores: unico ? d.conductores.map((x) => (norm(x.unidadCodigo) === c ? { ...x, unidadCodigo: null } : x)) : d.conductores,
    }));
    p.recargarCtx();
  };

  const titulares = doc.unidades.filter((u) => u.rol === "titular").length;
  const generales = generalesDe(hallazgos, "unidades");

  return (
    <Seccion id="unidades" titulo="Unidades"
      subtitulo={<>{doc.unidades.length ? `${titulares} titular${titulares === 1 ? "" : "es"} · ${doc.unidades.length - titulares} de retén` : "Elige las unidades que se ofertan, de la flota propia o tercerizada."}</>}
      acciones={!soloLectura && doc.unidades.length > 1 ? <Boton chico onClick={renumerar}>Renumerar U1… / R1…</Boton> : null}>
      <ListaHallazgos hallazgos={generales} irA={p.irA} />

      {!soloLectura && (
        <div className="space-y-2 rounded-xl border border-dashed border-gray-300 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-gray-600">Agregar unidad</span>
            {(["todas", "p", "t"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFlota(f)}
                className={`min-h-[32px] rounded-full border px-3 text-xs font-semibold ${flota === f ? "border-[#0b315f] bg-[#0b315f] text-white" : "border-gray-300 bg-white text-gray-600"}`}>
                {f === "todas" ? "Todas" : f === "p" ? "Propias" : "Tercerizadas"}
              </button>
            ))}
          </div>
          {opciones && !opciones.ok ? (
            <Nota tono="rojo">{opciones.error} <button type="button" className="font-semibold underline" onClick={recargarOpciones}>Reintentar</button></Nota>
          ) : (
            <ComboBuscador<OpcionUnidad>
              valor="" rotuloElegido={null} armar={armar} onElegir={agregar} onLimpiar={() => {}}
              cargando={!opciones} textoCargando="Cargando la flota…" anuncioCargando="Cargando la flota"
              ariaLabel="Buscar unidad para agregar" ariaLista="Unidades de la flota" etiquetaLimpiar="Limpiar"
              placeholder="Busca por placa, marca, capacidad o empresa…"
              vacio={(q) => q ? `Ninguna unidad coincide con «${q}».` : "No hay unidades registradas en esta flota."}
              renderItem={(o, texto) => {
                const ya = elegidas.get(o.clave);
                return (
                  <div className={ya ? "opacity-60" : ""}>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-bold text-gray-800"><Resaltado texto={o.placa} q={texto} /></span>
                      <Chip tono={o.flota === "p" ? "azul" : "gris"}>{o.flota === "p" ? "Propia" : "Tercerizada"}</Chip>
                      {!o.activo && <Chip tono="gris">Inactiva</Chip>}
                      {ya && <Chip tono="gris">Ya elegida · {ya.codigo || "sin código"}</Chip>}
                      {prohibe && o.flota === "t" && !ya && <Chip tono="rojo" title="Una de las bases prohíbe subcontratar">Las bases prohíben subcontratar</Chip>}
                    </div>
                    <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                      {[o.marca, o.modelo].filter(Boolean).length > 0 && <span><Resaltado texto={[o.marca, o.modelo].filter(Boolean).join(" ")} q={texto} /></span>}
                      <span>{o.capacidad ? `${o.capacidad} asientos` : "sin capacidad"}</span>
                      <span>{o.anio ? `año ${o.anio}` : "sin año"}</span>
                      {o.empresa && <span className="font-semibold text-gray-600"><Resaltado texto={o.empresa} q={texto} /></span>}
                    </div>
                  </div>
                );
              }}
            />
          )}
          {opciones?.ok && opciones.avisos.map((a) => <Nota key={a} tono="ambar">{a}</Nota>)}
          {lleno && <p className="text-[11px] text-gray-600">No se pueden agregar más: el tope es de {TOPES_DOC.maxUnidades} unidades por licitación.</p>}
          {prohibe && <p className="text-[11px] text-red-700">Un requisito de las bases prohíbe subcontratar: una unidad tercerizada se marcará como alarma.</p>}
        </div>
      )}

      {!doc.unidades.length ? (
        <p className="text-sm text-gray-500">Todavía no hay unidades elegidas.</p>
      ) : (
        <ol className="space-y-3">
          {orden.map((el, k) => (
            <TarjetaUnidad key={el.id} p={p} el={el} k={k} total={orden.length} refs={refs}
              u={ctx?.unidades[el.clave]} op={opPorClave.get(el.clave)}
              pendiente={pendiente(el.clave)} hallazgos={deSujeto(hallazgos, "unidad", el.clave)}
              vecinoArriba={orden[k - 1]} vecinoAbajo={orden[k + 1]}
              onRenombrar={(v) => renombrar(el.id, v)} onRol={(r) => cambiarRol(el, r)} onCambiar={(c) => cambiar(el.id, c)}
              onMover={(dir) => mover(k, dir)} onQuitar={() => quitar(el)}
              onSubir={(u, d, resumen) => setModal({ u, doc: d, resumen })} />
          ))}
        </ol>
      )}

      {modal && (
        <ModalDocUnidad u={modal.u} doc={modal.doc} resumen={modal.resumen} onCerrar={() => setModal(null)}
          onListo={(m) => { setModal(null); p.aviso(m, "ok"); p.recargarCtx(); }} />
      )}
    </Seccion>
  );
}

// ══ Una unidad ═══════════════════════════════════════════════════════════════════
function TarjetaUnidad({ p, el, k, total, refs, u, op, pendiente, hallazgos, vecinoArriba, vecinoAbajo, onRenombrar, onRol, onCambiar, onMover, onQuitar, onSubir }: {
  p: PasoProps; el: UnidadElegida; k: number; total: number; refs: RefsRecurso | null;
  u: UnidadERP | undefined; op: OpcionUnidad | undefined; pendiente: boolean;
  hallazgos: Hallazgo[]; vecinoArriba?: UnidadElegida; vecinoAbajo?: UnidadElegida;
  onRenombrar: (v: string) => void; onRol: (r: RolUnidad) => void; onCambiar: (c: Partial<UnidadElegida>) => void;
  onMover: (dir: -1 | 1) => void; onQuitar: () => void;
  onSubir: (u: UnidadERP, d: DocUnidadLic, r: DocUnidadResumen) => void;
}) {
  const { ctx, soloLectura } = p;
  const leida = ctx?.lecturas.unidades === "ok";
  const r = u && refs ? resumenUnidad(u, refs) : null;
  const prohibida = hallazgos.some((h) => h.codigo === "unidad_tercerizada_prohibida" && !h.aceptado);
  const placa = u?.placa ?? op?.placa ?? null;
  const mismoCodigo = (x?: UnidadElegida) => !!x && norm(x.codigo) === norm(el.codigo);

  // Qué se puede afirmar de esta unidad (de la evidencia al juicio; un fallo de lectura nunca acusa).
  let estado: "ok" | "cargando" | "no_leida" | "comprobando" | "no_existe" = "ok";
  if (!ctx) estado = "cargando";
  else if (!leida) estado = "no_leida";
  else if (!u) estado = pendiente ? "comprobando" : "no_existe";

  return (
    <li id={anclaDe("unidad", el.id)} className={`scroll-mt-24 rounded-xl border p-3 ${prohibida ? "border-red-300 bg-red-50/60" : "border-gray-200 bg-white"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-20 flex-shrink-0">
          <CampoTexto valor={el.codigo} onCambio={onRenombrar} alSalir mayusculas maxLength={20} ariaLabel="Código de la unidad" disabled={soloLectura} placeholder="U1" className="font-mono font-bold" />
        </div>
        <div className="w-28 flex-shrink-0">
          <select aria-label="Rol de la unidad" disabled={soloLectura} value={el.rol} onChange={(e) => onRol(e.target.value as RolUnidad)}
            className="w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm disabled:bg-gray-50">
            <option value="titular">Titular</option>
            <option value="reten">Retén</option>
          </select>
        </div>
        <div className="min-w-0 flex-1 pt-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-base font-bold text-gray-900">{placa ?? el.clave}</span>
            {(u ?? op) && <Chip tono={(u?.flota ?? op?.flota) === "p" ? "azul" : prohibida ? "rojo" : "gris"}>{(u?.flota ?? op?.flota) === "p" ? "Propia" : "Tercerizada"}</Chip>}
            {r && !r.activa && <Chip tono="ambar">Inactiva{u?.estado ? ` · ${u.estado}` : ""}</Chip>}
            {r?.empresa && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-600">
                {r.empresa.razonSocial}
                {r.empresa.autorizacion === "vigente" ? <Chip tono="verde">Autorización vigente</Chip>
                  : r.empresa.autorizacion === "vencida" ? <Chip tono="rojo">Autorización vencida</Chip>
                  : <Chip tono="ambar">Sin autorización registrada</Chip>}
              </span>
            )}
          </div>
          {r && <p className="text-xs text-gray-500">{[r.marcaModelo, r.tipo].filter(Boolean).join(" · ") || "Sin marca ni tipo en la ficha"}</p>}
        </div>
        {!soloLectura && (
          <div className="flex flex-shrink-0 items-center gap-1">
            <Boton chico tono="suave" onClick={() => onMover(-1)} disabled={k === 0 || mismoCodigo(vecinoArriba)} title="Subir un puesto (intercambia el código con la anterior)">↑</Boton>
            <Boton chico tono="suave" onClick={() => onMover(1)} disabled={k === total - 1 || mismoCodigo(vecinoAbajo)} title="Bajar un puesto (intercambia el código con la siguiente)">↓</Boton>
            <Boton chico tono="peligro" onClick={onQuitar}>Quitar</Boton>
          </div>
        )}
      </div>

      {estado === "cargando" || estado === "comprobando" ? (
        <p className="mt-2 text-xs text-gray-500">Comprobando la ficha y los documentos de la unidad…</p>
      ) : estado === "no_leida" ? (
        <div className="mt-2"><Nota tono="ambar">No se pudo leer la flota del ERP: no se muestran sus documentos (no es que falten). Recarga la página para reintentar.</Nota></div>
      ) : estado === "no_existe" ? (
        <div className="mt-2"><Nota tono="rojo">Esta unidad no existe en el ERP ({el.clave}): pudo darse de baja o borrarse. Quítala o elige otra.</Nota></div>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Etiqueta texto="Uso / ruta">
          <CampoTexto valor={el.uso} onCambio={(v) => onCambiar({ uso: v })} maxLength={200} disabled={soloLectura} placeholder={el.rol === "reten" ? "Retén" : "p. ej. Ruta 1 · turno mañana"} />
        </Etiqueta>
        <Etiqueta texto="Capacidad exigida por las bases" ayuda={<>Asientos de la ficha: <b>{r?.capacidad ?? u?.capacidad ?? op?.capacidad ?? "sin registrar"}</b></>}>
          <CampoEntero valor={el.capacidadExigida} onCambio={(v) => onCambiar({ capacidadExigida: v })} min={1} max={120} disabled={soloLectura} placeholder="Opcional" />
        </Etiqueta>
        <AnioUnidad p={p} u={u} r={r} anioRef={refs ? anioDe(refs.presentacion) : null} />
      </div>

      {hallazgos.length > 0 && <div className="mt-3"><ListaHallazgos hallazgos={hallazgos} irA={p.irA} /></div>}

      {r && refs && u && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[680px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1.5 pr-2 font-semibold">Documento</th>
                  <th className="py-1.5 pr-2 font-semibold">N°</th>
                  <th className="py-1.5 pr-2 font-semibold">Vence</th>
                  <th className="py-1.5 pr-2 font-semibold">A la presentación ({dmy(refs.presentacion)})</th>
                  <th className="py-1.5 pr-2 font-semibold">Al inicio{refs.inicio ? ` (${dmy(refs.inicio)})` : ""}</th>
                  <th className="py-1.5 pr-2 font-semibold">Archivo</th>
                  {!soloLectura && <th className="py-1.5 font-semibold" />}
                </tr>
              </thead>
              <tbody>
                {DOCS_UNIDAD_LIC.map((d) => {
                  const pr = r.docs[d].presentacion, ini = r.docs[d].inicio;
                  return (
                    <tr key={d} className="border-b border-gray-100 align-top">
                      <td className="py-1.5 pr-2 font-semibold text-gray-700">
                        {ETIQUETA_DOC_UNIDAD[d]}
                        {pr.deEmpresa && <span className="block text-[10px] font-normal text-gray-500">de la empresa</span>}
                      </td>
                      <td className="py-1.5 pr-2 text-gray-600">{pr.fila?.numero ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-gray-600">{pr.estado === "no_vence" ? "No vence" : dmy(pr.vence)}</td>
                      <td className="py-1.5 pr-2"><ChipVigencia estado={pr.estado} dias={pr.dias} /></td>
                      <td className="py-1.5 pr-2">{ini ? <ChipVigencia estado={ini.estado} dias={ini.dias} /> : <span className="text-gray-400">sin fecha de inicio</span>}</td>
                      <td className="py-1.5 pr-2">{pr.fila ? <ArchivoOrigen url={pr.fila.archivo_url} origen={pr.origen} compacto /> : <span className="text-gray-400">—</span>}</td>
                      {!soloLectura && (
                        <td className="py-1 text-right">
                          {u && <Boton chico tono={pr.origen === "storage_privado" || pr.origen === "storage_publico" ? "suave" : "normal"} onClick={() => onSubir(u, d, pr)}>
                            {pr.origen === "storage_privado" || pr.origen === "storage_publico" ? "Reemplazar" : "Subir PDF"}
                          </Boton>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!refs.inicio && (
            <p className="mt-1 text-[11px] text-gray-500">Sin fecha de inicio del servicio no se comprueba qué vence antes de empezar. <button type="button" className="font-semibold text-[#0b315f] underline" onClick={() => p.irA("bases", "datos")}>Escríbela en Bases y requisitos</button></p>
          )}
          <FotosUnidad u={u} />
        </>
      )}
    </li>
  );
}

// ══ Año ═══════════════════════════════════════════════════════════════════════════
function AnioUnidad({ p, u, r, anioRef }: { p: PasoProps; u: UnidadERP | undefined; r: ResumenUnidad | null; anioRef: number | null }) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!u || !p.ctx) return <Etiqueta texto="Año de fabricación"><p className="py-2 text-sm text-gray-400">—</p></Etiqueta>;
  const tercero = u.flota === "t";
  const migrada = p.ctx.migraciones.anioTercero;

  const guardar = async () => {
    const t = valor.trim();
    const n = t ? Number(t) : null;
    if (n !== null && (!Number.isInteger(n) || n < 1950 || n > 2100)) { setError("El año debe ser un número entre 1950 y 2100."); return; }
    setGuardando(true); setError(null);
    try {
      const r = await guardarAnioTercero(u.id, n);
      if (!r.ok) { setError(r.error); return; }
      setEditando(false);
      p.aviso(n === null ? `Se borró el año de ${u.placa}.` : `Año de ${u.placa} guardado en su ficha: ${n}.`, "ok");
      p.recargarCtx();
    } catch (e) {
      setError(`No se pudo guardar: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setGuardando(false); }
  };

  if (editando) {
    return (
      <Etiqueta texto="Año de fabricación" ayuda="Se guarda en la ficha de la unidad tercerizada. Vacío borra el año.">
        <div className="flex gap-1.5">
          <input type="text" inputMode="numeric" maxLength={4} value={valor} onChange={(e) => setValor(e.target.value.replace(/[^\d]/g, ""))}
            aria-label="Año de fabricación" className="w-24 rounded-lg border border-gray-300 px-2.5 py-2 text-sm" />
          <Boton chico tono="primario" onClick={guardar} disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</Boton>
          <Boton chico onClick={() => { setEditando(false); setError(null); }} disabled={guardando}>Cancelar</Boton>
        </div>
        {error && <span className="mt-1 block text-[11px] text-red-600">{error}</span>}
      </Etiqueta>
    );
  }
  return (
    <Etiqueta texto="Año de fabricación">
      {u.anio ? (
        <p className="py-2 text-sm text-gray-800">
          <b>{u.anio}</b>{r?.antiguedad != null && anioRef != null && <span className="text-xs text-gray-500"> · {r.antiguedad} años en {anioRef}</span>}
          {tercero && migrada && !p.soloLectura && <button type="button" className="ml-2 text-xs font-semibold text-[#0b315f] underline" onClick={() => { setValor(String(u.anio)); setEditando(true); }}>corregir</button>}
        </p>
      ) : !tercero ? (
        <p className="py-2 text-xs text-amber-800">Sin año en la ficha: sin él no se comprueba la antigüedad. <Link href="/vehiculos" target="_blank" rel="noopener noreferrer" className="font-semibold underline">Escríbelo en Vehículos ↗</Link></p>
      ) : migrada ? (
        p.soloLectura ? <p className="py-2 text-xs text-amber-800">Sin año en la ficha.</p>
          : <p className="py-2 text-xs text-amber-800">Sin año en la ficha. <button type="button" className="font-semibold underline" onClick={() => { setValor(""); setEditando(true); }}>Escribir el año</button></p>
      ) : (
        <p className="py-2 text-xs text-amber-800">Las unidades tercerizadas aún no tienen dónde guardar el año: corre {SQL_LICITACIONES.accesorias} en Supabase → SQL Editor.</p>
      )}
    </Etiqueta>
  );
}

// ══ Fotos ═════════════════════════════════════════════════════════════════════════
function FotosUnidad({ u }: { u: UnidadERP }) {
  const base = baseSupabase();
  const ficha = u.flota === "t" ? { ruta: "/tercerizadas", etiqueta: "Tercerizadas" } : { ruta: "/vehiculos", etiqueta: "Vehículos" };
  const foto = (url: string | null, rotulo: string) => {
    const o = origenArchivo(url, base);
    return (
      <div className="w-32 flex-shrink-0">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">{rotulo}</p>
        {o === "vacio" || !url ? (
          <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-gray-300 text-[11px] text-gray-400">Sin foto</div>
        ) : o === "externo" ? (
          <div className="flex h-20 flex-col items-center justify-center rounded-lg border border-amber-200 bg-amber-50 px-1 text-center text-[10px] text-amber-800">
            Enlace externo: no se une al expediente
            {hrefSeguro(url) && <a href={hrefSeguro(url)!} target="_blank" rel="noopener noreferrer" className="font-semibold underline">abrir</a>}
          </div>
        ) : (
          <ImgPrivada src={url} alt={`${rotulo} de ${u.placa}`} className="h-20 w-32 rounded-lg border border-gray-200 object-cover" />
        )}
      </div>
    );
  };
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3">
      {foto(u.foto_externa_url, "Exterior")}
      {foto(u.foto_interna_url, "Interior")}
      <Link href={ficha.ruta} target="_blank" rel="noopener noreferrer" className="pb-1 text-xs font-semibold text-[#0b315f] underline">Las fotos se cambian en {ficha.etiqueta} ↗</Link>
    </div>
  );
}
