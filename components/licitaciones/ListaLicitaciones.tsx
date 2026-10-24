"use client";
// components/licitaciones/ListaLicitaciones.tsx — Pestaña «Licitaciones» de /licitaciones.
//
// Lee con leerLicitaciones (lib/licitaciones/datos.ts): la lista liviana, sin el doc, con la última
// emisión de cada una. Tres reglas de la pantalla:
//  · Si las emisiones no se pudieron leer, la columna dice «no se pudo leer», NUNCA «sin emitir»:
//    afirmar que una licitación no se presentó por un error de lectura es exactamente lo que no se
//    puede hacer.
//  · Mientras lee dice «Leyendo…»: un vacío solo se afirma con la lectura hecha.
//  · Crear y duplicar pasan por crearLicitacion / duplicarLicitacion y llevan al editor
//    (/licitaciones/<id>). Archivar pide confirmación nombrando la licitación.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  archivarLicitacion, crearLicitacion, duplicarLicitacion, leerLicitacion, leerLicitaciones, nuevoUuid,
  type FalloDatos, type FilaListaLicitacion,
} from "@/lib/licitaciones/datos";
import { docVacio, duplicarDoc } from "@/lib/licitaciones/normalizar";
import { diasISO, fechaDMY } from "@/lib/licitaciones/util";
import { ESTADOS_LICITACION, type EstadoLectura, type EstadoLicitacion } from "@/lib/licitaciones/tipos";
import { fechaLima } from "@/lib/documentos-estado";
import { rotuloCliente, type ClienteBuscable } from "@/lib/clientes-buscador";
import CampoClienteErp from "./CampoClienteErp";
import { ESTADO_LIC, fmtInstante, juicioPresentacion } from "./etiquetas";
import {
  AvisoFallo, AZUL, Cargando, Chip, claseBotonChico, claseBotonPrimario, claseBotonSecundario, claseCampo, claseEtiqueta,
  ErrorFijo, Modal, useAviso,
} from "./ui";

type Lectura =
  | { estado: "cargando" }
  | { estado: "fallo"; fallo: FalloDatos }
  | { estado: "ok"; filas: FilaListaLicitacion[]; emisiones: EstadoLectura; avisos: string[] };

const norm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Mensaje de un error lanzado (nuevoUuid lanza ErrorLicitaciones en un navegador sin crypto). */
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ListaLicitaciones() {
  const router = useRouter();
  const { mostrar, nodo: nodoAviso } = useAviso();
  const [verArchivadas, setVerArchivadas] = useState(false);
  const [lectura, setLectura] = useState<Lectura>({ estado: "cargando" });
  const [intento, setIntento] = useState(0);
  const [texto, setTexto] = useState("");
  const [filtroEstado, setFiltroEstado] = useState<"todos" | EstadoLicitacion>("todos");
  const [nueva, setNueva] = useState(false);
  const [aDuplicar, setADuplicar] = useState<FilaListaLicitacion | null>(null);
  const [archivando, setArchivando] = useState<number | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    leerLicitaciones({ archivadas: verArchivadas }).then((r) => {
      if (!vivo) return;
      setLectura(r.ok ? { estado: "ok", filas: r.filas, emisiones: r.emisiones, avisos: r.avisos } : { estado: "fallo", fallo: r });
    }).catch((e: unknown) => {
      if (vivo) setLectura({ estado: "fallo", fallo: { ok: false, error: `No se pudieron leer las licitaciones (${mensaje(e)}).` } });
    });
    return () => { vivo = false; };
  }, [verArchivadas, intento]);

  const recargar = useCallback(() => { setLectura({ estado: "cargando" }); setIntento((n) => n + 1); }, []);
  const cambiarArchivadas = (v: boolean) => { setVerArchivadas(v); setLectura({ estado: "cargando" }); };

  const hoy = fechaLima();
  const filas = useMemo(() => (lectura.estado === "ok" ? lectura.filas : []), [lectura]);
  const filtradas = useMemo(() => {
    const q = norm(texto);
    return filas.filter((f) => {
      if (filtroEstado !== "todos" && f.estado !== filtroEstado) return false;
      if (!q) return true;
      return norm(`${f.nombre} ${f.cliente_nombre} ${f.codigo ?? ""} ${f.objeto ?? ""}`).includes(q);
    });
  }, [filas, texto, filtroEstado]);

  const conteoEstado = useMemo(() => {
    const m = new Map<EstadoLicitacion, number>();
    for (const f of filas) m.set(f.estado, (m.get(f.estado) ?? 0) + 1);
    return m;
  }, [filas]);

  async function archivar(f: FilaListaLicitacion) {
    const archivar = !f.archivada;
    const cliente = f.cliente_nombre ? ` de ${f.cliente_nombre}` : "";
    const ok = window.confirm(archivar
      ? `¿Archivar «${f.nombre}»${cliente}?\n\nSale de la lista de vigentes y queda en «Ver archivadas». No se borra nada: sus emisiones y su contenido se conservan, y se puede desarchivar.`
      : `¿Desarchivar «${f.nombre}»${cliente}?\n\nVuelve a la lista de licitaciones vigentes.`);
    if (!ok) return;
    setArchivando(f.id);
    setErrorAccion(null);
    const r = await archivarLicitacion(f.id, archivar);
    setArchivando(null);
    if (!r.ok) { setErrorAccion(r.error); return; }
    // Sale de la vista actual (vigentes ↔ archivadas).
    setLectura((l) => (l.estado === "ok" ? { ...l, filas: l.filas.filter((x) => x.id !== f.id) } : l));
    mostrar(archivar ? `«${f.nombre}» quedó archivada.` : `«${f.nombre}» volvió a la lista de vigentes.`);
  }

  return (
    <section className="space-y-4">
      {nodoAviso}

      <div className="flex items-start justify-between flex-wrap gap-3">
        <p className="text-sm text-gray-500 max-w-2xl">
          Cada licitación tiene su propuesta técnica y su expediente. Ábrela para trabajar sus cinco pasos; las unidades, documentos y vigencias se leen del ERP al abrirla.
        </p>
        <button type="button" onClick={() => setNueva(true)} className={claseBotonPrimario} style={{ background: AZUL }}>
          + Nueva licitación
        </button>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-2xl border shadow-sm p-3 sm:p-4 grid grid-cols-1 md:grid-cols-[1fr_220px_auto] gap-3 items-center">
        <input className={claseCampo} placeholder="Buscar por nombre, cliente, código u objeto…" value={texto}
          onChange={(e) => setTexto(e.target.value)} aria-label="Buscar licitación" />
        <select className={claseCampo} value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value as "todos" | EstadoLicitacion)} aria-label="Filtrar por estado">
          <option value="todos">Todos los estados</option>
          {ESTADOS_LICITACION.map((e) => (
            <option key={e} value={e}>{ESTADO_LIC[e].etiqueta}{lectura.estado === "ok" ? ` (${conteoEstado.get(e) ?? 0})` : ""}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-700 min-h-[44px] cursor-pointer select-none">
          <input type="checkbox" className="w-4 h-4" checked={verArchivadas} onChange={(e) => cambiarArchivadas(e.target.checked)} />
          Ver archivadas
        </label>
      </div>

      {errorAccion && <ErrorFijo texto={errorAccion} />}

      {lectura.estado === "fallo" && <AvisoFallo fallo={lectura.fallo} onReintentar={recargar} que="las licitaciones" />}
      {lectura.estado === "ok" && lectura.avisos.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 space-y-1">
          {lectura.avisos.map((a, i) => <p key={i}>⚠️ {a}</p>)}
        </div>
      )}

      {lectura.estado !== "fallo" && (
        <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          {lectura.estado === "cargando" ? (
            <Cargando texto={verArchivadas ? "Leyendo las licitaciones archivadas…" : "Leyendo las licitaciones…"} />
          ) : filtradas.length === 0 ? (
            <div className="p-10 text-center text-gray-500">
              <p className="text-3xl mb-2">📑</p>
              <p className="font-medium">
                {filas.length === 0
                  ? (verArchivadas ? "No hay licitaciones archivadas." : "Todavía no hay licitaciones. Crea la primera con «+ Nueva licitación».")
                  : `Ninguna de las ${filas.length} licitaciones coincide con los filtros.`}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[980px]">
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                    {["Licitación", "Cliente", "Código", "Presentación", "Estado", "Última emisión", "Guardado por última vez", ""].map((h, i) => (
                      <th key={i} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtradas.map((f) => {
                    const dias = f.fecha_presentacion ? diasISO(hoy, f.fecha_presentacion) : null;
                    const juicio = juicioPresentacion(f.estado, dias);
                    const est = ESTADO_LIC[f.estado];
                    const em = f.ultimaEmision;
                    return (
                      <tr key={f.id} className="border-t hover:bg-gray-50 cursor-pointer" style={{ borderColor: "#f1f5f9" }}
                        onClick={() => router.push(`/licitaciones/${f.id}`)}>
                        <td className="p-3 align-top">
                          <Link href={`/licitaciones/${f.id}`} onClick={(e) => e.stopPropagation()}
                            className="font-bold hover:underline" style={{ color: AZUL }}>{f.nombre}</Link>
                          {f.objeto && <div className="text-xs text-gray-500 line-clamp-2 max-w-[320px]">{f.objeto}</div>}
                          {f.archivada && <div className="mt-0.5"><Chip tono="gris">Archivada</Chip></div>}
                        </td>
                        <td className="p-3 align-top text-gray-800">
                          {f.cliente_nombre || "—"}
                          {f.cliente_id != null && <div className="text-[10px] font-bold uppercase text-gray-400">Cliente del ERP</div>}
                        </td>
                        <td className="p-3 align-top font-mono text-xs text-gray-600 whitespace-nowrap">{f.codigo || "—"}</td>
                        <td className="p-3 align-top whitespace-nowrap">
                          {f.fecha_presentacion ? (
                            <>
                              <div className="font-bold text-gray-800">{fechaDMY(f.fecha_presentacion)}{f.hora_presentacion ? ` · ${f.hora_presentacion}` : ""}</div>
                              {juicio && <div className="mt-0.5"><Chip tono={juicio.tono}>{juicio.texto}</Chip></div>}
                            </>
                          ) : (
                            <span className="text-xs text-gray-400">Sin fecha</span>
                          )}
                        </td>
                        <td className="p-3 align-top"><Chip tono={est.tono}>{est.etiqueta}</Chip></td>
                        <td className="p-3 align-top text-xs">
                          {lectura.emisiones !== "ok" ? (
                            <span className="text-amber-800" title="Las emisiones no se pudieron leer: no se sabe si se emitió.">no se pudo leer</span>
                          ) : em ? (
                            <>
                              <div className="font-bold text-gray-800">Versión {em.version}</div>
                              <div className="text-gray-500">{em.emitido_por_nombre ?? "usuario sin nombre"} · {fmtInstante(em.emitido_en)}</div>
                            </>
                          ) : (
                            <span className="text-gray-400">Sin emitir</span>
                          )}
                        </td>
                        <td className="p-3 align-top text-xs text-gray-500">
                          <div className="text-gray-700">{f.actualizado_por_nombre ?? (f.actualizado_por ? "usuario sin nombre" : "—")}</div>
                          <div>{fmtInstante(f.actualizado_en)}</div>
                        </td>
                        <td className="p-3 align-top" onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-1.5 justify-end">
                            <button type="button" className={claseBotonChico} onClick={() => setADuplicar(f)}>Duplicar</button>
                            <button type="button" className={claseBotonChico} disabled={archivando === f.id} onClick={() => archivar(f)}>
                              {archivando === f.id ? "…" : f.archivada ? "Desarchivar" : "Archivar"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {lectura.estado === "ok" && filtradas.length > 0 && (
            <div className="px-4 py-2 border-t text-xs text-gray-400">
              {filtradas.length === filas.length ? `${filas.length} licitación${filas.length === 1 ? "" : "es"}` : `${filtradas.length} de ${filas.length}`}
              {verArchivadas ? " archivada" + (filas.length === 1 ? "" : "s") : ""}
            </div>
          )}
        </div>
      )}

      {nueva && <ModalNueva onCerrar={() => setNueva(false)} onCreada={(id) => router.push(`/licitaciones/${id}`)} />}
      {aDuplicar && <ModalDuplicar origen={aDuplicar} onCerrar={() => setADuplicar(null)} onCreada={(id) => router.push(`/licitaciones/${id}`)} />}
    </section>
  );
}

// ─── Nueva licitación ─────────────────────────────────────────────────────────

function ModalNueva({ onCerrar, onCreada }: { onCerrar: () => void; onCreada: (id: number) => void }) {
  const [nombre, setNombre] = useState("");
  const [clienteId, setClienteId] = useState<number | null>(null);
  const [clienteNombre, setClienteNombre] = useState("");
  const [autoNombre, setAutoNombre] = useState<string | null>(null);
  const [codigo, setCodigo] = useState("");
  const [objeto, setObjeto] = useState("");
  const [fechaPres, setFechaPres] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // El nombre que se imprime: si se eligió un cliente del ERP y el campo estaba vacío (o tenía el
  // nombre que puso el ERP), se llena con su nombre; lo escrito por la persona no se pisa, y quitar
  // el cliente no borra lo escrito.
  const elegirCliente = (c: ClienteBuscable | null) => {
    setClienteId(c ? c.id : null);
    if (!c) return;
    const r = rotuloCliente(c);
    if (!clienteNombre.trim() || clienteNombre === autoNombre) { setClienteNombre(r); setAutoNombre(r); }
  };

  const falta = !nombre.trim() ? "Escribe el nombre de la licitación."
    : !clienteNombre.trim() ? "Elige el cliente del ERP o escribe el nombre de la entidad que convoca."
    : null;

  async function crear() {
    if (falta) return;
    setGuardando(true);
    setError(null);
    try {
      const r = await crearLicitacion({
        nombre: nombre.trim(), cliente_id: clienteId, cliente_nombre: clienteNombre.trim(),
        codigo: codigo.trim() || null, objeto: objeto.trim() || null, fecha_presentacion: fechaPres || null,
      }, docVacio(nuevoUuid));
      if (!r.ok) { setError(r.error); setGuardando(false); return; }
      onCreada(r.lic.id);
    } catch (e) {
      setError(mensaje(e));
      setGuardando(false);
    }
  }

  return (
    <Modal titulo="Nueva licitación" subtitulo="Lo demás (fechas de consultas e inicio, plazo, bases y requisitos) se completa en el primer paso." onCerrar={onCerrar} ocupado={guardando}
      pie={
        <div className="space-y-2">
          <ErrorFijo texto={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={claseBotonSecundario} onClick={onCerrar} disabled={guardando}>Cancelar</button>
            <button type="button" className={claseBotonPrimario} style={{ background: AZUL }} disabled={!!falta || guardando} onClick={crear}>
              {guardando ? "Creando…" : "Crear y abrir"}
            </button>
          </div>
          {falta && <p className="text-xs text-gray-500 sm:text-right">{falta}</p>}
        </div>
      }>
      <div className="space-y-4">
        <div>
          <label className={claseEtiqueta} htmlFor="lic-nombre">Nombre de la licitación *</label>
          <input id="lic-nombre" className={claseCampo} value={nombre} maxLength={200} onChange={(e) => setNombre(e.target.value)}
            placeholder="Ej.: Transporte de personal planta Lurín 2027" autoFocus />
          <p className="text-[11px] text-gray-400 mt-1">Es el nombre con que la encuentras en esta lista; no se imprime en la propuesta.</p>
        </div>
        <div>
          <span className={claseEtiqueta}>Cliente del ERP (opcional)</span>
          <CampoClienteErp valor={clienteId} onElegir={elegirCliente} deshabilitado={guardando} />
        </div>
        <div>
          <label className={claseEtiqueta} htmlFor="lic-cliente">Entidad que convoca *</label>
          <input id="lic-cliente" className={claseCampo} value={clienteNombre} maxLength={200}
            onChange={(e) => setClienteNombre(e.target.value)} placeholder="Como figura en las bases" />
          <p className="text-[11px] text-gray-400 mt-1">Se escribe solo al elegir un cliente del ERP; si el concurso lo convoca alguien que no es cliente, escríbelo aquí.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={claseEtiqueta} htmlFor="lic-codigo">Código del concurso</label>
            <input id="lic-codigo" className={claseCampo} value={codigo} maxLength={80} onChange={(e) => setCodigo(e.target.value)} placeholder="Ej.: CP-012-2026" />
          </div>
          <div>
            <label className={claseEtiqueta} htmlFor="lic-fecha">Fecha de presentación</label>
            <input id="lic-fecha" type="date" className={claseCampo} value={fechaPres} onChange={(e) => setFechaPres(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={claseEtiqueta} htmlFor="lic-objeto">Objeto del servicio</label>
          <textarea id="lic-objeto" className={claseCampo} rows={3} value={objeto} maxLength={2000} onChange={(e) => setObjeto(e.target.value)}
            placeholder="Ej.: Servicio de transporte de personal en rutas fijas…" />
        </div>
      </div>
    </Modal>
  );
}

// ─── Duplicar ─────────────────────────────────────────────────────────────────

function ModalDuplicar({ origen, onCerrar, onCreada }: { origen: FilaListaLicitacion; onCerrar: () => void; onCreada: (id: number) => void }) {
  const [nombre, setNombre] = useState(`${origen.nombre} (copia)`.slice(0, 200));
  const [conRecursos, setConRecursos] = useState(true);
  const [conRequisitos, setConRequisitos] = useState(false);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const falta = !nombre.trim() ? "Escribe el nombre de la licitación nueva." : null;

  async function duplicar() {
    if (falta) return;
    setError(null);
    try {
      setTrabajando("Leyendo la licitación de origen…");
      const r = await leerLicitacion(origen.id);
      if (!r.ok) { setError(r.error); setTrabajando(null); return; }
      setTrabajando("Creando la copia…");
      const doc = duplicarDoc(r.lic, { nuevoId: nuevoUuid, conRecursos, conRequisitos });
      const c = await duplicarLicitacion(r.lic, nombre.trim(), doc);
      if (!c.ok) { setError(c.error); setTrabajando(null); return; }
      onCreada(c.lic.id);
    } catch (e) {
      setError(mensaje(e));
      setTrabajando(null);
    }
  }

  return (
    <Modal titulo="Duplicar licitación" subtitulo={<>Copia de <b>{origen.nombre}</b>{origen.cliente_nombre ? ` · ${origen.cliente_nombre}` : ""}</>}
      onCerrar={onCerrar} ocupado={!!trabajando}
      pie={
        <div className="space-y-2">
          <ErrorFijo texto={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={claseBotonSecundario} onClick={onCerrar} disabled={!!trabajando}>Cancelar</button>
            <button type="button" className={claseBotonPrimario} style={{ background: AZUL }} disabled={!!falta || !!trabajando} onClick={duplicar}>
              {trabajando ?? "Duplicar y abrir"}
            </button>
          </div>
          {falta && <p className="text-xs text-gray-500 sm:text-right">{falta}</p>}
        </div>
      }>
      <div className="space-y-4">
        <div>
          <label className={claseEtiqueta} htmlFor="dup-nombre">Nombre de la licitación nueva *</label>
          <input id="dup-nombre" className={claseCampo} value={nombre} maxLength={200} onChange={(e) => setNombre(e.target.value)} autoFocus />
        </div>
        <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-3 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 mt-0.5" checked={conRecursos} onChange={(e) => setConRecursos(e.target.checked)} />
          <span className="text-sm">
            <b>Copiar unidades, conductores, experiencia y contactos</b>
            <span className="block text-xs text-gray-500">Se copia a quién se eligió, no sus datos: placas, años y vencimientos se vuelven a leer del ERP al abrir la copia.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-3 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 mt-0.5" checked={conRequisitos} onChange={(e) => setConRequisitos(e.target.checked)} />
          <span className="text-sm">
            <b>Copiar los requisitos</b>
            <span className="block text-xs text-gray-500">Útil si es el mismo cliente con las mismas bases. Se copian sin su marca manual (cumple / no cumple) ni su cita: las dos hablaban de las bases del otro concurso.</span>
          </span>
        </label>
        <div className="rounded-xl bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600 space-y-1">
          <p><b>Siempre se copian</b> el contenido de la propuesta (portada, control, carta, secciones), la estructura del expediente, el representante legal, el cliente, el objeto, «Atención» y el plazo. De la carta no se copian el destinatario ni la referencia.</p>
          <p><b>No se copian</b> el código del concurso, sus fechas, las bases, las consultas absueltas, los anexos subidos ni los hallazgos aceptados: son del concurso anterior. La revisión de la copia avisa si el texto todavía nombra al cliente o al código de esta.</p>
        </div>
      </div>
    </Modal>
  );
}
