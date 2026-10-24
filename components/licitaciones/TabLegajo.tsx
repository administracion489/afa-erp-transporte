"use client";
// components/licitaciones/TabLegajo.tsx — Pestaña «Legajo de la empresa» de /licitaciones.
//
// El legajo ES documentos_empresa (alcance 'empresa', categoría = código del legajo): los mismos
// documentos que se ven en /documentos, cargados una vez para todas las licitaciones. Esta pantalla:
//  · deriva el estado de cada tipo con estadoLegajo (lib/licitaciones/legajo.ts) contra HOY en Lima —
//    nunca lee la columna `estado` que /documentos guarda al insertar (se queda vieja al día siguiente);
//  · juzga la antigüedad con el valor SUGERIDO del tipo (≤ 30 días para la ficha RUC, la copia literal
//    y la vigencia de poder). Cada licitación juzga con lo que digan SUS bases: aquí solo se avisa;
//  · si la lectura falla, NO dice «falta»: enseña el error y «Reintentar».
//
// Subir crea una fila NUEVA (las anteriores quedan como versiones: manda la más reciente con archivo).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { EnlacePrivado } from "@/components/ArchivoPrivado";
import {
  actualizarFechasLegajo, borrarDocumentoLegajo, leerLegajo, subirDocumentoLegajo, type FalloDatos,
} from "@/lib/licitaciones/datos";
import { estadoLegajo, TIPOS_LEGAJO, type EstadoLegajo, type ResultadoLegajo, type TipoLegajo } from "@/lib/licitaciones/legajo";
import { fechaDMY } from "@/lib/licitaciones/util";
import type { FechaISO, FilaDocEmpresa } from "@/lib/licitaciones/tipos";
import { fechaLima } from "@/lib/documentos-estado";
import { ACCEPT_UNIBLE, fmtBytes, fmtInstante, textoDias } from "./etiquetas";
import {
  AvisoFallo, AZUL, Cargando, Chip, claseBotonChico, claseBotonPrimario, claseBotonSecundario, claseCampo, claseEtiqueta,
  ErrorFijo, Modal, useAviso, type TonoChip,
} from "./ui";

type Lectura = { estado: "cargando" } | { estado: "fallo"; fallo: FalloDatos } | { estado: "ok"; filas: FilaDocEmpresa[] };

/** Rótulo y color de cada estado. Rojo solo lo vencido; ámbar lo que hay que arreglar antes de licitar. */
const ESTADO: Record<EstadoLegajo, { etiqueta: string; tono: TonoChip }> = {
  falta: { etiqueta: "Sin cargar", tono: "gris" },
  sin_archivo: { etiqueta: "Sin archivo", tono: "ambar" },
  vencido: { etiqueta: "Vencido", tono: "rojo" },
  antiguo: { etiqueta: "Antiguo para licitar", tono: "ambar" },
  sin_fecha_emision: { etiqueta: "Sin fecha de emisión", tono: "ambar" },
  por_vencer: { etiqueta: "Por vencer", tono: "ambar" },
  vigente: { etiqueta: "Vigente", tono: "verde" },
};
const ORDEN_RESUMEN: EstadoLegajo[] = ["vencido", "sin_archivo", "antiguo", "sin_fecha_emision", "por_vencer", "vigente", "falta"];

/** La frase del estado, armada de los mismos números que usó estadoLegajo. */
function detalleEstado(t: TipoLegajo, r: ResultadoLegajo): string | null {
  switch (r.estado) {
    case "falta": return "No hay ningún documento de este tipo en el legajo.";
    case "sin_archivo": return "Hay un registro pero sin archivo: no se puede adjuntar a un expediente. Sube el PDF o la imagen.";
    case "vencido": return r.dias != null ? `Venció ${textoDias(r.dias)}. Sube el vigente.` : "Vencido.";
    case "antiguo": return `Emitido ${r.edad != null ? textoDias(-r.edad) : ""}; las bases suelen pedirlo con ${t.antiguedadSugeridaDias} días como máximo. Pide uno nuevo antes de licitar.`;
    case "sin_fecha_emision": return `Sin fecha de emisión no se puede saber si tiene menos de ${t.antiguedadSugeridaDias} días. Corrige sus fechas.`;
    case "por_vencer": return r.dias != null ? `Vence ${textoDias(r.dias)}.` : null;
    case "vigente": {
      const partes: string[] = [];
      if (r.dias != null) partes.push(`vence ${textoDias(r.dias)}`);
      else if (t.vence === "fecha") partes.push("sin fecha de vencimiento");
      if (r.edad != null) partes.push(`emitido ${textoDias(-r.edad)}`);
      return partes.length ? `${partes[0][0].toUpperCase()}${partes.join(" · ").slice(1)}.` : null;
    }
  }
}

/** Las filas de un tipo, la más reciente primero (solo para enseñar las versiones; cuál vale lo decide documentoVigente). */
function versionesDe(codigo: string, filas: readonly FilaDocEmpresa[]): FilaDocEmpresa[] {
  return filas.filter((f) => f.categoria === codigo).sort((a, b) => {
    const ea = a.fecha_emision ?? "", eb = b.fecha_emision ?? "";
    if (ea !== eb) return ea < eb ? 1 : -1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return b.id - a.id;
  });
}

export default function TabLegajo() {
  const { mostrar, nodo: nodoAviso } = useAviso();
  const [lectura, setLectura] = useState<Lectura>({ estado: "cargando" });
  const [intento, setIntento] = useState(0);
  const [subirTipo, setSubirTipo] = useState<TipoLegajo | null>(null);
  const [corregir, setCorregir] = useState<{ tipo: TipoLegajo; fila: FilaDocEmpresa } | null>(null);
  const [borrando, setBorrando] = useState<number | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    leerLegajo().then((r) => {
      if (vivo) setLectura(r.ok ? { estado: "ok", filas: r.filas } : { estado: "fallo", fallo: r });
    }).catch((e: unknown) => {
      if (vivo) setLectura({ estado: "fallo", fallo: { ok: false, error: `No se pudo leer el legajo (${e instanceof Error ? e.message : String(e)}).` } });
    });
    return () => { vivo = false; };
  }, [intento]);

  const recargar = useCallback(() => { setLectura({ estado: "cargando" }); setIntento((n) => n + 1); }, []);
  const hoy = fechaLima();
  const filas = useMemo(() => (lectura.estado === "ok" ? lectura.filas : []), [lectura]);

  const porTipo = useMemo(() => TIPOS_LEGAJO.map((t) => ({
    tipo: t, res: estadoLegajo(t.codigo, filas, hoy, t.antiguedadSugeridaDias), versiones: versionesDe(t.codigo, filas),
  })), [filas, hoy]);
  const grupos = useMemo(() => {
    const m = new Map<string, typeof porTipo>();
    for (const x of porTipo) m.set(x.tipo.grupo, [...(m.get(x.tipo.grupo) ?? []), x]);
    return [...m.entries()];
  }, [porTipo]);
  const resumen = useMemo(() => {
    const m = new Map<EstadoLegajo, number>();
    for (const x of porTipo) m.set(x.res.estado, (m.get(x.res.estado) ?? 0) + 1);
    return m;
  }, [porTipo]);

  async function borrar(t: TipoLegajo, f: FilaDocEmpresa) {
    const quien = `«${f.titulo || t.etiqueta}»${f.fecha_emision ? `, emitido el ${fechaDMY(f.fecha_emision)}` : ""}${f.archivo_nombre ? ` (archivo ${f.archivo_nombre})` : ""}`;
    const ok = window.confirm(`¿Eliminar ${quien} del legajo?\n\nSe borra el registro en Documentos. Si una licitación lo tenía elegido en su expediente, su revisión lo dirá.`);
    if (!ok) return;
    setBorrando(f.id);
    setErrorAccion(null);
    const r = await borrarDocumentoLegajo(f.id);
    setBorrando(null);
    if (!r.ok) { setErrorAccion(r.error); return; }
    setLectura((l) => (l.estado === "ok" ? { ...l, filas: l.filas.filter((x) => x.id !== f.id) } : l));
    mostrar(`${t.etiqueta}: registro eliminado.`);
  }

  const reemplazarFila = (fila: FilaDocEmpresa) =>
    setLectura((l) => (l.estado === "ok" ? { ...l, filas: [...l.filas.filter((x) => x.id !== fila.id), fila] } : l));

  return (
    <section className="space-y-4">
      {nodoAviso}
      <div className="text-sm text-gray-500 max-w-3xl space-y-1">
        <p>
          Los documentos de la empresa que casi toda licitación pide, cargados una sola vez. Son los mismos de{" "}
          <Link href="/documentos" className="underline font-bold" style={{ color: AZUL }}>Documentos</Link>: se guardan en un solo sitio. Las pólizas de seguro van en{" "}
          <Link href="/seguros" className="underline font-bold" style={{ color: AZUL }}>Seguros</Link>.
        </p>
        <p className="text-xs">
          <b>«Antiguo para licitar»</b>: la ficha RUC, la copia literal y la vigencia de poder no vencen, pero las bases suelen exigirlas emitidas hace 30 días como máximo. Aquí se avisa con ese valor sugerido; cada licitación juzga con lo que digan sus bases.
        </p>
      </div>

      {errorAccion && <ErrorFijo texto={errorAccion} />}
      {lectura.estado === "fallo" && <AvisoFallo fallo={lectura.fallo} onReintentar={recargar} que="el legajo de la empresa" />}
      {lectura.estado === "cargando" && <div className="bg-white rounded-2xl border shadow-sm"><Cargando texto="Leyendo el legajo de la empresa…" /></div>}

      {lectura.estado === "ok" && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {ORDEN_RESUMEN.map((e) => {
              const n = resumen.get(e) ?? 0;
              if (!n) return null;
              return <Chip key={e} tono={ESTADO[e].tono}>{ESTADO[e].etiqueta}: {n}</Chip>;
            })}
          </div>

          {grupos.map(([grupo, items]) => (
            <div key={grupo} className="bg-white rounded-2xl border shadow-sm overflow-hidden">
              <h3 className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-gray-500 border-b" style={{ background: "#f8fafc" }}>{grupo}</h3>
              <ul className="divide-y divide-gray-100">
                {items.map(({ tipo: t, res, versiones }) => {
                  const est = ESTADO[res.estado];
                  const vig = res.fila;
                  const anteriores = vig ? versiones.filter((v) => v.id !== vig.id) : [];
                  const detalle = detalleEstado(t, res);
                  return (
                    <li key={t.codigo} className="px-4 py-3">
                      <div className="flex flex-col md:flex-row md:items-start gap-2 md:gap-4">
                        <div className="md:w-56 flex-shrink-0">
                          <p className="font-bold text-gray-900 text-sm">{t.etiqueta}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Chip tono={est.tono}>{est.etiqueta}</Chip>
                            {t.antiguedadSugeridaDias != null && <Chip tono="gris" title="Antigüedad que suelen pedir las bases (valor sugerido)">≤ {t.antiguedadSugeridaDias} días</Chip>}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0 text-sm space-y-1">
                          {vig ? (
                            <>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                {vig.archivo_url ? (
                                  <EnlacePrivado href={vig.archivo_url} target="_blank" rel="noopener noreferrer"
                                    className="font-bold underline break-all" style={{ color: AZUL }}>
                                    📄 {vig.archivo_nombre || vig.titulo || "Ver archivo"}
                                  </EnlacePrivado>
                                ) : (
                                  <span className="text-gray-500">{vig.titulo || t.etiqueta} · sin archivo</span>
                                )}
                              </div>
                              <p className="text-xs text-gray-500">
                                Emisión: <b className="text-gray-700">{fechaDMY(vig.fecha_emision)}</b>
                                {t.vence === "fecha" && <> · Vencimiento: <b className="text-gray-700">{vig.fecha_vencimiento ? fechaDMY(vig.fecha_vencimiento) : "no vence / sin fecha"}</b></>}
                              </p>
                            </>
                          ) : null}
                          {detalle && <p className={`text-xs ${est.tono === "rojo" ? "text-red-700" : est.tono === "ambar" ? "text-amber-800" : "text-gray-500"}`}>{detalle}</p>}
                          {anteriores.length > 0 && (
                            <details className="text-xs">
                              <summary className="cursor-pointer text-gray-500 select-none">{anteriores.length} versión{anteriores.length === 1 ? "" : "es"} anterior{anteriores.length === 1 ? "" : "es"}</summary>
                              <ul className="mt-1 space-y-1.5 pl-3 border-l-2 border-gray-100">
                                {anteriores.map((v) => (
                                  <li key={v.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    {v.archivo_url ? (
                                      <EnlacePrivado href={v.archivo_url} target="_blank" rel="noopener noreferrer" className="underline break-all" style={{ color: AZUL }}>
                                        {v.archivo_nombre || v.titulo || "archivo"}
                                      </EnlacePrivado>
                                    ) : <span className="text-gray-500">{v.titulo || "sin archivo"}</span>}
                                    <span className="text-gray-400">emisión {fechaDMY(v.fecha_emision)}{t.vence === "fecha" && v.fecha_vencimiento ? ` · vence ${fechaDMY(v.fecha_vencimiento)}` : ""} · cargado {fmtInstante(v.created_at)}</span>
                                    <button type="button" className="underline text-gray-500" onClick={() => setCorregir({ tipo: t, fila: v })}>corregir fechas</button>
                                    <button type="button" className="underline text-red-700 disabled:opacity-40" disabled={borrando === v.id} onClick={() => borrar(t, v)}>
                                      {borrando === v.id ? "eliminando…" : "eliminar"}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5 md:justify-end md:w-64 flex-shrink-0">
                          <button type="button" className={claseBotonChico} style={{ borderColor: AZUL, color: AZUL }} onClick={() => setSubirTipo(t)}>
                            {vig ? "⬆ Subir nuevo" : "⬆ Subir"}
                          </button>
                          {vig && <button type="button" className={claseBotonChico} onClick={() => setCorregir({ tipo: t, fila: vig })}>Corregir fechas</button>}
                          {vig && (
                            <button type="button" className={`${claseBotonChico} text-red-700`} disabled={borrando === vig.id} onClick={() => borrar(t, vig)}>
                              {borrando === vig.id ? "…" : "Eliminar"}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}

      {subirTipo && (
        <ModalSubir tipo={subirTipo} hoy={hoy} onCerrar={() => setSubirTipo(null)}
          onSubido={(fila) => { reemplazarFila(fila); setSubirTipo(null); mostrar(`${subirTipo.etiqueta}: documento subido.`); }} />
      )}
      {corregir && (
        <ModalCorregir tipo={corregir.tipo} fila={corregir.fila} hoy={hoy} onCerrar={() => setCorregir(null)}
          onGuardado={(fila) => { reemplazarFila(fila); setCorregir(null); mostrar(`${corregir.tipo.etiqueta}: fechas corregidas.`); }} />
      )}
    </section>
  );
}

// ─── Validación compartida de las fechas del formulario ─────────────────────────
function faltaEnFechas(t: TipoLegajo, emision: string, venc: string, sinVenc: boolean, hoy: FechaISO): string | null {
  if (t.antiguedadSugeridaDias != null && !emision) return `Escribe la fecha de emisión: sin ella no se puede saber si tiene menos de ${t.antiguedadSugeridaDias} días.`;
  if (emision && emision > hoy) return "La fecha de emisión no puede ser posterior a hoy.";
  if (t.vence === "fecha" && !venc && !sinVenc) return "Escribe la fecha de vencimiento, o marca que no vence.";
  if (emision && venc && venc < emision) return "La fecha de vencimiento es anterior a la de emisión.";
  return null;
}

function CamposFechas({ t, emision, setEmision, venc, setVenc, sinVenc, setSinVenc, deshabilitado }: {
  t: TipoLegajo; emision: string; setEmision: (s: string) => void; venc: string; setVenc: (s: string) => void;
  sinVenc: boolean; setSinVenc: (b: boolean) => void; deshabilitado: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className={claseEtiqueta} htmlFor="leg-emision">Fecha de emisión{t.antiguedadSugeridaDias != null ? " *" : ""}</label>
        <input id="leg-emision" type="date" className={claseCampo} value={emision} disabled={deshabilitado} onChange={(e) => setEmision(e.target.value)} />
        {t.antiguedadSugeridaDias != null && <p className="text-[11px] text-gray-400 mt-1">La que figura en el documento. Las bases suelen pedirlo con ≤ {t.antiguedadSugeridaDias} días.</p>}
      </div>
      {t.vence === "fecha" && (
        <div>
          <label className={claseEtiqueta} htmlFor="leg-venc">Fecha de vencimiento *</label>
          <input id="leg-venc" type="date" className={claseCampo} value={sinVenc ? "" : venc} disabled={deshabilitado || sinVenc} onChange={(e) => setVenc(e.target.value)} />
          <label className="mt-1.5 flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={sinVenc} disabled={deshabilitado} onChange={(e) => { setSinVenc(e.target.checked); if (e.target.checked) setVenc(""); }} />
            No vence (indefinido)
          </label>
        </div>
      )}
    </div>
  );
}

function ModalSubir({ tipo: t, hoy, onCerrar, onSubido }: { tipo: TipoLegajo; hoy: FechaISO; onCerrar: () => void; onSubido: (f: FilaDocEmpresa) => void }) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [titulo, setTitulo] = useState("");
  const [emision, setEmision] = useState("");
  const [venc, setVenc] = useState("");
  const [sinVenc, setSinVenc] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const falta = !archivo ? "Elige el archivo (PDF, PNG o JPG)." : faltaEnFechas(t, emision, venc, sinVenc, hoy);

  async function subir() {
    if (falta || !archivo) return;
    setSubiendo(true);
    setError(null);
    const r = await subirDocumentoLegajo(t.codigo, archivo, {
      titulo: titulo.trim() || null,
      fecha_emision: emision || null,
      fecha_vencimiento: t.vence === "fecha" && !sinVenc ? (venc || null) : null,
    }).catch((e: unknown): FalloDatos => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    setSubiendo(false);
    if (!r.ok) { setError(r.error); return; }
    onSubido(r.fila);
  }

  return (
    <Modal titulo={`Subir · ${t.etiqueta}`} subtitulo="Se guarda como un documento nuevo del legajo; el anterior queda como versión anterior." onCerrar={onCerrar} ocupado={subiendo}
      pie={
        <div className="space-y-2">
          <ErrorFijo texto={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={claseBotonSecundario} onClick={onCerrar} disabled={subiendo}>Cancelar</button>
            <button type="button" className={claseBotonPrimario} style={{ background: AZUL }} disabled={!!falta || subiendo} onClick={subir}>
              {subiendo ? "Subiendo…" : "Subir al legajo"}
            </button>
          </div>
          {falta && <p className="text-xs text-gray-500 sm:text-right">{falta}</p>}
        </div>
      }>
      <div className="space-y-4">
        <div>
          <label className={claseEtiqueta} htmlFor="leg-archivo">Archivo *</label>
          <input id="leg-archivo" type="file" accept={ACCEPT_UNIBLE} disabled={subiendo}
            className="block w-full text-sm border border-gray-200 rounded-xl p-2.5 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-bold"
            onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} />
          <p className="text-[11px] text-gray-400 mt-1">
            {archivo ? `${archivo.name} · ${fmtBytes(archivo.size)}` : "PDF, PNG o JPG: son los que se pueden unir al expediente. Una foto del iPhone (HEIC) hay que exportarla como JPG."}
          </p>
        </div>
        <div>
          <label className={claseEtiqueta} htmlFor="leg-titulo">Título (opcional)</label>
          <input id="leg-titulo" className={claseCampo} value={titulo} maxLength={300} disabled={subiendo} onChange={(e) => setTitulo(e.target.value)} placeholder={t.etiqueta} />
        </div>
        <CamposFechas t={t} emision={emision} setEmision={setEmision} venc={venc} setVenc={setVenc} sinVenc={sinVenc} setSinVenc={setSinVenc} deshabilitado={subiendo} />
      </div>
    </Modal>
  );
}

function ModalCorregir({ tipo: t, fila, hoy, onCerrar, onGuardado }: {
  tipo: TipoLegajo; fila: FilaDocEmpresa; hoy: FechaISO; onCerrar: () => void; onGuardado: (f: FilaDocEmpresa) => void;
}) {
  const [titulo, setTitulo] = useState(fila.titulo ?? "");
  const [emision, setEmision] = useState(fila.fecha_emision ?? "");
  const [venc, setVenc] = useState(fila.fecha_vencimiento ?? "");
  const [sinVenc, setSinVenc] = useState(t.vence === "fecha" && !fila.fecha_vencimiento);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vencFinal = t.vence === "fecha" && !sinVenc ? venc : "";
  const cambios: { titulo?: string | null; fecha_emision?: FechaISO | null; fecha_vencimiento?: FechaISO | null } = {};
  if (titulo.trim() !== (fila.titulo ?? "").trim()) cambios.titulo = titulo.trim();
  if (emision !== (fila.fecha_emision ?? "")) cambios.fecha_emision = emision || null;
  if (t.vence === "fecha" && vencFinal !== (fila.fecha_vencimiento ?? "")) cambios.fecha_vencimiento = vencFinal || null;
  const hayCambios = Object.keys(cambios).length > 0;
  const falta = !titulo.trim() ? "El título no puede quedar vacío."
    : faltaEnFechas(t, emision, venc, sinVenc, hoy) ?? (!hayCambios ? "No cambiaste nada." : null);

  async function guardar() {
    if (falta) return;
    setGuardando(true);
    setError(null);
    const r = await actualizarFechasLegajo(fila.id, cambios)
      .catch((e: unknown): FalloDatos => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    setGuardando(false);
    if (!r.ok) { setError(r.error); return; }
    onGuardado(r.fila);
  }

  return (
    <Modal titulo={`Corregir fechas · ${t.etiqueta}`}
      subtitulo={fila.archivo_url ? <>Archivo: {fila.archivo_nombre || "sin nombre"} · cargado {fmtInstante(fila.created_at)}</> : "Este registro no tiene archivo."}
      onCerrar={onCerrar} ocupado={guardando}
      pie={
        <div className="space-y-2">
          <ErrorFijo texto={error} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className={claseBotonSecundario} onClick={onCerrar} disabled={guardando}>Cancelar</button>
            <button type="button" className={claseBotonPrimario} style={{ background: AZUL }} disabled={!!falta || guardando} onClick={guardar}>
              {guardando ? "Guardando…" : "Guardar"}
            </button>
          </div>
          {falta && <p className="text-xs text-gray-500 sm:text-right">{falta}</p>}
        </div>
      }>
      <div className="space-y-4">
        <div>
          <label className={claseEtiqueta} htmlFor="leg-titulo-c">Título *</label>
          <input id="leg-titulo-c" className={claseCampo} value={titulo} maxLength={300} disabled={guardando} onChange={(e) => setTitulo(e.target.value)} />
        </div>
        <CamposFechas t={t} emision={emision} setEmision={setEmision} venc={venc} setVenc={setVenc} sinVenc={sinVenc} setSinVenc={setSinVenc} deshabilitado={guardando} />
        <p className="text-[11px] text-gray-400">Vaciar la fecha de emisión la borra (para quitar una fecha mal puesta). El archivo no cambia: para reemplazarlo, sube uno nuevo.</p>
      </div>
    </Modal>
  );
}
