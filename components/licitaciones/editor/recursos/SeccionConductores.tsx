"use client";
// components/licitaciones/editor/recursos/SeccionConductores.tsx — Los CONDUCTORES de la licitación.
//
// El doc guarda la clave del conductor (p:12 / t:5), su rol y el código de la unidad que maneja (D2).
// Licencia, categoría y documentos se DERIVAN con `resumenConductor` (lib/licitaciones/recursos), el
// motor de la revisión. Tri-estado: la ficha de un conductor tercerizado no tiene examen médico,
// antecedentes ni psicosomático; ahí se dice «no se registra en la ficha del tercero», nunca «vencido».

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import ComboBuscador, { Resaltado, type ArmadoCombo, type OpcionCombo } from "@/components/ComboBuscador";
import { borrarDocumentoConductor, buscarConductores, SQL_LICITACIONES, type OpcionConductor } from "@/lib/licitaciones/datos";
import { resumenConductor, vigencia, type DocConductorResumen, type RefsRecurso } from "@/lib/licitaciones/recursos";
import { unidadesPorCodigo } from "@/lib/licitaciones/tablas";
import { coincideBusqueda, terminosBusqueda } from "@/lib/busqueda-texto";
import { CODIGOS_DOC_CONDUCTOR, TOPES_DOC, type CodigoDocConductor, type ConductorERP, type ConductorElegido, type Hallazgo, type RolConductor } from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "../contrato-editor";
import { ArchivoOrigen, Boton, Chip, ChipVigencia, dmy, ListaHallazgos, Nota, Seccion } from "./comun";
import { deSujeto, generalesDe } from "./hallazgos";
import ModalDocConductor from "./ModalDocConductor";

type ResC = Awaited<ReturnType<typeof buscarConductores>>;
const LIMITE = 50;
const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
const textoOpcion = (o: OpcionConductor) =>
  [o.nombre, o.dni, o.licencia, o.categoria_licencia, o.empresa, o.flota === "p" ? "propio" : "tercerizado"].filter(Boolean).join(" ");

export default function SeccionConductores({ p, opciones, recargarOpciones, refs, hallazgos, pendiente, prohibe }: {
  p: PasoProps; opciones: ResC | null; recargarOpciones: () => void; refs: RefsRecurso | null;
  hallazgos: Hallazgo[]; pendiente: (clave: string) => boolean; prohibe: boolean;
}) {
  const { lic, doc, ctx, soloLectura } = p;
  const [flota, setFlota] = useState<"todas" | "p" | "t">("todas");
  const [modal, setModal] = useState<{ c: ConductorERP; codigo: CodigoDocConductor; resumen: DocConductorResumen; modo: "subir" | "fechas" } | null>(null);
  const elegidos = useMemo(() => new Map(doc.conductores.map((c) => [c.clave as string, c])), [doc.conductores]);
  const opPorClave = useMemo(() => new Map((opciones?.ok ? opciones.opciones : []).map((o) => [o.clave as string, o])), [opciones]);
  const unidades = useMemo(() => unidadesPorCodigo(lic), [lic]);
  // El orden en que se imprimen: titulares primero, relevo después, cada grupo en el orden del doc.
  const orden = useMemo(() => [...doc.conductores].map((c, k) => ({ c, k })).sort((a, b) => (a.c.rol === b.c.rol ? a.k - b.k : a.c.rol === "titular" ? -1 : 1)).map((x) => x.c), [doc.conductores]);
  const lleno = doc.conductores.length >= TOPES_DOC.maxConductores;

  const armar = useCallback((q: string): ArmadoCombo<OpcionConductor> => {
    if (!opciones?.ok) return { opciones: [], pies: [] };
    const terminos = terminosBusqueda(q);
    const lista = opciones.opciones.filter((o) => (flota === "todas" || o.flota === flota) && coincideBusqueda(textoOpcion(o), terminos));
    const seccion = (o: OpcionConductor) => (!o.activo ? "Inactivos" : o.flota === "p" ? "Propios" : "Tercerizados");
    const rango: Record<string, number> = { Propios: 0, Tercerizados: 1, Inactivos: 2 };
    const ordenada = [...lista].sort((a, b) => rango[seccion(a)] - rango[seccion(b)]);
    const ops: OpcionCombo<OpcionConductor>[] = ordenada.slice(0, LIMITE).map((o) => ({ tipo: "item", clave: o.clave, dato: o, seccion: seccion(o) }));
    return { opciones: ops, pies: ordenada.length > LIMITE ? [`y ${ordenada.length - LIMITE} más: ${q ? "afina la búsqueda" : "escribe nombre, DNI o licencia para buscar"}`] : [] };
  }, [opciones, flota]);

  const agregar = (o: OpcionConductor) => {
    const ya = elegidos.get(o.clave);
    if (ya) { p.aviso(`${o.nombre} ya está en la lista.`, "aviso"); p.irA("recursos", anclaDe("conductor", ya.id)); return; }
    if (lleno) { p.aviso(`El tope es de ${TOPES_DOC.maxConductores} conductores por licitación.`, "aviso"); return; }
    const id = p.nuevoId();
    p.cambiarDoc((d) => (d.conductores.some((c) => c.clave === o.clave) ? d : { ...d, conductores: [...d.conductores, { id, clave: o.clave, rol: "titular", unidadCodigo: null }] }));
    p.recargarCtx();
  };
  const cambiar = (id: string, cambio: Partial<ConductorElegido>) =>
    p.cambiarDoc((d) => ({ ...d, conductores: d.conductores.map((c) => (c.id === id ? { ...c, ...cambio } : c)) }));
  /** Intercambia de lugar en el doc dos conductores vecinos en el orden impreso (mismo rol). */
  const mover = (k: number, dir: -1 | 1) => {
    const a = orden[k], b = orden[k + dir];
    if (!a || !b || a.rol !== b.rol) return;
    p.cambiarDoc((d) => {
      const ia = d.conductores.findIndex((c) => c.id === a.id), ib = d.conductores.findIndex((c) => c.id === b.id);
      if (ia < 0 || ib < 0) return d;
      const arr = [...d.conductores];
      [arr[ia], arr[ib]] = [arr[ib], arr[ia]];
      return { ...d, conductores: arr };
    });
  };
  const quitar = (el: ConductorElegido) => {
    const nombre = ctx?.conductores[el.clave]?.nombre ?? opPorClave.get(el.clave)?.nombre ?? el.clave;
    if (!window.confirm(`¿Quitar a ${nombre} de esta licitación? Sigue registrado en el ERP con sus documentos.`)) return;
    p.cambiarDoc((d) => ({ ...d, conductores: d.conductores.filter((c) => c.id !== el.id) }));
    p.recargarCtx();
  };
  const borrar = async (c: ConductorERP, d: DocConductorResumen) => {
    if (!d.fila) return;
    const cuando = d.fila.fecha_emision ? ` emitido el ${dmy(d.fila.fecha_emision)}` : "";
    if (!window.confirm(`¿Borrar el archivo «${d.fila.titulo || d.etiqueta}»${cuando} de ${c.nombre}? Se elimina el registro del ERP (también deja de verse en Documentos).`)) return;
    try {
      const r = await borrarDocumentoConductor(d.fila.id);
      if (!r.ok) { p.aviso(r.error, "error"); return; }
      p.aviso(`Se borró ${d.etiqueta.toLowerCase()} de ${c.nombre}.`, "ok");
      p.recargarCtx();
    } catch (e) { p.aviso(`No se pudo borrar: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  };

  const terceroSinMigracion = ctx?.migraciones.conductorTercero === false && doc.conductores.some((c) => c.clave.startsWith("t:"));
  const relevo = doc.conductores.filter((c) => c.rol === "relevo").length;

  return (
    <Seccion id="conductores" titulo="Conductores"
      subtitulo={doc.conductores.length ? `${doc.conductores.length - relevo} titular${doc.conductores.length - relevo === 1 ? "" : "es"} · ${relevo} de relevo` : "Elige los conductores, propios o tercerizados, y la unidad que maneja cada uno."}>
      <ListaHallazgos hallazgos={generalesDe(hallazgos, "conductores")} irA={p.irA} />
      {terceroSinMigracion && (
        <Nota tono="ambar">Los documentos de los conductores tercerizados todavía no se pueden guardar ni leer: corre {SQL_LICITACIONES.accesorias} en Supabase → SQL Editor. Mientras tanto no se afirma que les falte nada.</Nota>
      )}

      {!soloLectura && (
        <div className="space-y-2 rounded-xl border border-dashed border-gray-300 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-gray-600">Agregar conductor</span>
            {(["todas", "p", "t"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFlota(f)}
                className={`min-h-[32px] rounded-full border px-3 text-xs font-semibold ${flota === f ? "border-[#0b315f] bg-[#0b315f] text-white" : "border-gray-300 bg-white text-gray-600"}`}>
                {f === "todas" ? "Todos" : f === "p" ? "Propios" : "Tercerizados"}
              </button>
            ))}
          </div>
          {opciones && !opciones.ok ? (
            <Nota tono="rojo">{opciones.error} <button type="button" className="font-semibold underline" onClick={recargarOpciones}>Reintentar</button></Nota>
          ) : (
            <ComboBuscador<OpcionConductor>
              valor="" rotuloElegido={null} armar={armar} onElegir={agregar} onLimpiar={() => {}}
              cargando={!opciones} textoCargando="Cargando conductores…" anuncioCargando="Cargando conductores"
              ariaLabel="Buscar conductor para agregar" ariaLista="Conductores" etiquetaLimpiar="Limpiar"
              placeholder="Busca por nombre, DNI, licencia o empresa…"
              vacio={(q) => q ? `Ningún conductor coincide con «${q}».` : "No hay conductores registrados."}
              renderItem={(o, texto) => {
                const ya = elegidos.get(o.clave);
                return (
                  <div className={ya ? "opacity-60" : ""}>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="text-sm font-bold text-gray-800"><Resaltado texto={o.nombre} q={texto} /></span>
                      <Chip tono={o.flota === "p" ? "azul" : "gris"}>{o.flota === "p" ? "Propio" : "Tercerizado"}</Chip>
                      {!o.activo && <Chip tono="gris">Inactivo</Chip>}
                      {ya && <Chip tono="gris">Ya elegido</Chip>}
                      {prohibe && o.flota === "t" && !ya && <Chip tono="rojo">Las bases prohíben subcontratar</Chip>}
                    </div>
                    <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                      {o.dni && <span>DNI <Resaltado texto={o.dni} q={texto} /></span>}
                      <span>{o.licencia ? <>Lic. <Resaltado texto={o.licencia} q={texto} /></> : "sin licencia"}{o.categoria_licencia ? ` · ${o.categoria_licencia}` : ""}</span>
                      {o.vencimiento_licencia && <span>vence {dmy(o.vencimiento_licencia)}</span>}
                      {o.empresa && <span className="font-semibold text-gray-600"><Resaltado texto={o.empresa} q={texto} /></span>}
                    </div>
                  </div>
                );
              }}
            />
          )}
          {opciones?.ok && opciones.avisos.map((a) => <Nota key={a} tono="ambar">{a}</Nota>)}
          {lleno && <p className="text-[11px] text-gray-600">No se pueden agregar más: el tope es de {TOPES_DOC.maxConductores} conductores por licitación.</p>}
          {prohibe && <p className="text-[11px] text-red-700">Un requisito de las bases prohíbe subcontratar: un conductor tercerizado se marcará como alarma.</p>}
        </div>
      )}

      {!doc.conductores.length ? (
        <p className="text-sm text-gray-500">Todavía no hay conductores elegidos.</p>
      ) : (
        <ol className="space-y-3">
          {orden.map((el, k) => (
            <TarjetaConductor key={el.id} p={p} el={el} k={k} orden={orden} refs={refs}
              c={ctx?.conductores[el.clave]} op={opPorClave.get(el.clave)} pendiente={pendiente(el.clave)}
              hallazgos={deSujeto(hallazgos, "conductor", el.clave)}
              opcionesUnidad={unidades.map((u) => ({ codigo: norm(u.codigo), rotulo: `${u.codigo || "sin código"}${ctx?.unidades[u.clave]?.placa ? ` · ${ctx.unidades[u.clave].placa}` : ""}` })).filter((x) => x.codigo)}
              onCambiar={(c) => cambiar(el.id, c)} onMover={(dir) => mover(k, dir)} onQuitar={() => quitar(el)}
              onDoc={(c, codigo, resumen, modo) => setModal({ c, codigo, resumen, modo })} onBorrar={borrar} />
          ))}
        </ol>
      )}

      {modal && (
        <ModalDocConductor c={modal.c} codigo={modal.codigo} resumen={modal.resumen} modo={modal.modo}
          onCerrar={() => setModal(null)} onListo={(m) => { setModal(null); p.aviso(m, "ok"); p.recargarCtx(); }} />
      )}
    </Seccion>
  );
}

// ══ Un conductor ═══════════════════════════════════════════════════════════════════
function TarjetaConductor({ p, el, k, orden, refs, c, op, pendiente, hallazgos, opcionesUnidad, onCambiar, onMover, onQuitar, onDoc, onBorrar }: {
  p: PasoProps; el: ConductorElegido; k: number; orden: ConductorElegido[]; refs: RefsRecurso | null;
  c: ConductorERP | undefined; op: OpcionConductor | undefined; pendiente: boolean; hallazgos: Hallazgo[];
  opcionesUnidad: { codigo: string; rotulo: string }[];
  onCambiar: (c: Partial<ConductorElegido>) => void; onMover: (dir: -1 | 1) => void; onQuitar: () => void;
  onDoc: (c: ConductorERP, codigo: CodigoDocConductor, resumen: DocConductorResumen, modo: "subir" | "fechas") => void;
  onBorrar: (c: ConductorERP, d: DocConductorResumen) => void;
}) {
  const { ctx, soloLectura } = p;
  const leida = ctx?.lecturas.conductores === "ok";
  const r = c && refs ? resumenConductor(c, refs) : null;
  const prohibido = hallazgos.some((h) => h.codigo === "conductor_tercerizado_prohibido" && !h.aceptado);
  const nombre = c?.nombre ?? op?.nombre ?? el.clave;
  const flota = c?.flota ?? op?.flota ?? (el.clave.startsWith("t:") ? "t" : "p");
  const sinDondeGuardar = flota === "t" && ctx?.migraciones.conductorTercero === false;
  const codigoAct = norm(el.unidadCodigo);
  const huerfano = !!codigoAct && !opcionesUnidad.some((o) => o.codigo === codigoAct);

  let estado: "ok" | "cargando" | "no_leida" | "comprobando" | "no_existe" = "ok";
  if (!ctx) estado = "cargando";
  else if (!leida) estado = "no_leida";
  else if (!c) estado = pendiente ? "comprobando" : "no_existe";

  const vencLic = c?.vencimiento_licencia ?? null;
  const licPres = refs ? vigencia(vencLic, refs.presentacion) : null;
  const licIni = refs?.inicio ? vigencia(vencLic, refs.inicio) : null;

  return (
    <li id={anclaDe("conductor", el.id)} className={`scroll-mt-24 rounded-xl border p-3 ${prohibido ? "border-red-300 bg-red-50/60" : "border-gray-200 bg-white"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-28 flex-shrink-0">
          <select aria-label="Rol del conductor" disabled={soloLectura} value={el.rol} onChange={(e) => onCambiar({ rol: e.target.value as RolConductor })}
            className="w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm disabled:bg-gray-50">
            <option value="titular">Titular</option>
            <option value="relevo">Relevo</option>
          </select>
        </div>
        <div className="min-w-0 flex-1 pt-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-bold text-gray-900">{nombre}</span>
            <Chip tono={flota === "p" ? "azul" : prohibido ? "rojo" : "gris"}>{flota === "p" ? "Propio" : "Tercerizado"}</Chip>
            {r && !r.activo && <Chip tono="ambar">Inactivo{c?.estado ? ` · ${c.estado}` : ""}</Chip>}
          </div>
          <p className="text-xs text-gray-500">{[c?.dni ? `DNI ${c.dni}` : null, c?.empresa?.razon_social].filter(Boolean).join(" · ") || (c ? "Sin DNI en la ficha" : "")}</p>
        </div>
        <div className="w-full sm:w-48">
          <select aria-label="Unidad que maneja" disabled={soloLectura} value={codigoAct}
            onChange={(e) => onCambiar({ unidadCodigo: e.target.value || null })}
            className="w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm disabled:bg-gray-50">
            <option value="">— Sin unidad asignada —</option>
            {opcionesUnidad.map((o) => <option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}
            {huerfano && <option value={codigoAct}>{el.unidadCodigo} — ya no está en la lista</option>}
          </select>
          {huerfano && <p className="mt-1 text-[11px] text-amber-800">La unidad «{el.unidadCodigo}» ya no está entre las elegidas: elige otra o déjalo sin unidad.</p>}
        </div>
        {!soloLectura && (
          <div className="flex flex-shrink-0 items-center gap-1">
            <Boton chico tono="suave" onClick={() => onMover(-1)} disabled={k === 0 || orden[k - 1]?.rol !== el.rol} title="Subir un puesto">↑</Boton>
            <Boton chico tono="suave" onClick={() => onMover(1)} disabled={k === orden.length - 1 || orden[k + 1]?.rol !== el.rol} title="Bajar un puesto">↓</Boton>
            <Boton chico tono="peligro" onClick={onQuitar}>Quitar</Boton>
          </div>
        )}
      </div>

      {estado === "cargando" || estado === "comprobando" ? (
        <p className="mt-2 text-xs text-gray-500">Comprobando la ficha y los documentos del conductor…</p>
      ) : estado === "no_leida" ? (
        <div className="mt-2"><Nota tono="ambar">No se pudieron leer los conductores del ERP: no se muestran sus documentos (no es que falten). Recarga la página para reintentar.</Nota></div>
      ) : estado === "no_existe" ? (
        <div className="mt-2"><Nota tono="rojo">Este conductor no existe en el ERP ({el.clave}): pudo darse de baja o borrarse. Quítalo o elige otro.</Nota></div>
      ) : null}

      {hallazgos.length > 0 && <div className="mt-3"><ListaHallazgos hallazgos={hallazgos} irA={p.irA} /></div>}

      {r && c && refs && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-700">
            <span><span className="text-gray-500">Licencia:</span> <b>{r.licencia ?? "sin número"}</b></span>
            <span>
              <span className="text-gray-500">Categoría:</span> <b>{r.categoria ?? r.categoriaTexto ?? "sin categoría"}</b>
              {!r.categoria && r.categoriaTexto && <span className="ml-1 text-amber-800">(no se reconoce: corrígela en la ficha)</span>}
            </span>
            <span><span className="text-gray-500">Vence:</span> <b>{dmy(vencLic)}</b></span>
            {licPres && <span className="inline-flex items-center gap-1"><span className="text-gray-500">a la presentación</span><ChipVigencia estado={licPres.estado} dias={licPres.dias} /></span>}
            {licIni && <span className="inline-flex items-center gap-1"><span className="text-gray-500">al inicio</span><ChipVigencia estado={licIni.estado} dias={licIni.dias} /></span>}
            <Link href={c.flota === "t" ? "/tercerizadas" : "/conductores"} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#0b315f] underline">Ficha ↗</Link>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[680px] text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="py-1.5 pr-2 font-semibold">Documento</th>
                  <th className="py-1.5 pr-2 font-semibold">Vence</th>
                  <th className="py-1.5 pr-2 font-semibold">A la presentación</th>
                  <th className="py-1.5 pr-2 font-semibold">Al inicio</th>
                  <th className="py-1.5 pr-2 font-semibold">Archivo</th>
                  {!soloLectura && <th className="py-1.5 font-semibold" />}
                </tr>
              </thead>
              <tbody>
                {CODIGOS_DOC_CONDUCTOR.map((codigo) => {
                  const d = r.docs[codigo];
                  const noSeRegistra = d.columna === "no_existe" && !d.fila;
                  return (
                    <tr key={codigo} className="border-b border-gray-100 align-top">
                      <td className="py-1.5 pr-2 font-semibold text-gray-700">{d.etiqueta}</td>
                      <td className="py-1.5 pr-2 text-gray-600">
                        {noSeRegistra ? <span className="text-gray-500">No se registra en la ficha del tercero</span>
                          : d.venc ? <>{dmy(d.venc)} <span className="text-[10px] text-gray-400">({d.fuenteVenc === "ficha" ? "ficha" : "archivo"})</span></>
                          : d.columna === "vacia" ? <span className="text-gray-500">Ficha sin fecha</span>
                          : d.presentacion.estado === "no_vence" ? "No vence" : "—"}
                        {d.edad != null && <span className="block text-[10px] text-gray-400">emitido hace {d.edad} d</span>}
                        {d.fechasDistintas && <span className="mt-0.5 block"><Chip tono="ambar" title="Vale la fecha de la ficha">Ficha y archivo con fechas distintas</Chip></span>}
                      </td>
                      <td className="py-1.5 pr-2">{noSeRegistra ? <span className="text-gray-400">—</span> : <ChipVigencia estado={d.presentacion.estado} dias={d.presentacion.dias} />}</td>
                      <td className="py-1.5 pr-2">{noSeRegistra ? <span className="text-gray-400">—</span> : d.inicio ? <ChipVigencia estado={d.inicio.estado} dias={d.inicio.dias} /> : <span className="text-gray-400">sin fecha de inicio</span>}</td>
                      <td className="py-1.5 pr-2">{d.fila ? <ArchivoOrigen url={d.fila.archivo_url} origen={d.origen} compacto /> : <span className="text-gray-500">Sin archivo</span>}</td>
                      {!soloLectura && (
                        <td className="py-1 text-right">
                          {sinDondeGuardar ? (
                            <span className="text-[10px] text-amber-800" title={`Falta correr ${SQL_LICITACIONES.accesorias}`}>Falta la migración</span>
                          ) : (
                            <span className="inline-flex flex-wrap justify-end gap-1">
                              <Boton chico onClick={() => onDoc(c, codigo, d, "subir")}>{d.fila ? "Subir otro" : "Subir"}</Boton>
                              {d.fila && <Boton chico tono="suave" onClick={() => onDoc(c, codigo, d, "fechas")}>Fechas</Boton>}
                              {d.fila && <Boton chico tono="peligro" onClick={() => onBorrar(c, d)}>Borrar</Boton>}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </li>
  );
}
