"use client";
// components/licitaciones/editor/revision/ModalEmision.tsx — EMITIR la licitación: la propuesta técnica en
// PDF, un PDF por bloque del expediente y el expediente completo foliado, armados EN EL NAVEGADOR
// (emitirLicitacion de lib/licitaciones/emitir.ts), descargados en ZIP o sueltos, con copia inmutable en
// el bucket privado `licitaciones` y la emisión registrada (versión N, quién, cuándo, hallazgos).
//
// Lo que no se afloja:
//  · SE EMITE EXACTAMENTE LO GUARDADO: antes de nada se guarda lo pendiente (guardarAhora) y se comprueba
//    en la base que la versión en pantalla sea la última; si otra persona guardó, se dice y se recarga.
//  · LOS HALLAZGOS NO BLOQUEAN (D7): los abiertos se nombran, se pide confirmar que se emite con ellos y
//    quedan registrados en la emisión.
//  · UN ARCHIVO NUNCA TUMBA LA EMISIÓN (R11): lo que no se puede unir se omite y se nombra con su motivo.
//  · Un registro fallido NO pierde el trabajo: los archivos se entregan igual y el registro se reintenta.
//  · Memoria: los blobs y sus object URL se sueltan al cerrar. emitir.ts, documento.ts, expediente.ts y
//    pdf-lib se cargan al pulsar «Emitir», no con la pantalla.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { empresaConDefectos } from "@/lib/empresa-perfil";
import { CATALOGO_HALLAZGOS, MAX_BYTES_EXPEDIENTE, revisarLicitacion } from "@/lib/licitaciones/revision";
import type { ResultadoEmitir } from "@/lib/licitaciones/emitir";
import type {
  ContextoLicitacion, FaseEmision, FilaEmision, Licitacion, OpcionesEmision, ProgresoEmision, Revision,
} from "@/lib/licitaciones/tipos";
import { fechaDMY } from "@/lib/licitaciones/util";
import type { FaseGuardado } from "../contexto-editor";
import { ESTILO_GRAVEDAD, instanteLima, tamanoArchivo } from "../etiquetas";
import type { Comprobacion } from "./ComprobarArchivos";
import { versionEnBase } from "./consultas";
import { abiertosParaEmitir, resumenExpediente, type ResumenExpediente } from "./resumen";
import {
  BOTON_PRIMARIO, BOTON_SECUNDARIO, Barra, Chip, ETIQUETA_FASE, ETIQUETA_TIPO_ARCHIVO, Nota, ORDEN_FASES, plural,
} from "./ui";

/** Lo que el modal necesita leer DESPUÉS de guardar (las props de ese momento ya quedaron viejas). */
export type Instantanea = {
  lic: Licitacion; ctx: ContextoLicitacion | null; pendiente: boolean; fase: FaseGuardado; errorGuardado: string | null;
};

type Props = {
  lic: Licitacion;
  ctx: ContextoLicitacion;
  /** La revisión que se ve (con la comprobación de archivos, si se hizo). */
  revision: Revision;
  comprobacion: Comprobacion | null;
  /** La comprobación es anterior a cambios del expediente o de los recursos. */
  comprobacionVieja: boolean;
  pendiente: boolean;
  faseGuardado: FaseGuardado;
  leer: () => Instantanea;
  guardarAhora: () => Promise<boolean>;
  asegurarUltima: () => Promise<FilaEmision | null>;
  proximaVersion: number | null;
  onEmitida: (fila: FilaEmision) => void;
  onCerrar: () => void;
};

type ModEmitir = typeof import("@/lib/licitaciones/emitir");

type Estado =
  | { fase: "opciones" }
  | { fase: "preparando"; detalle: string }
  | { fase: "emitiendo"; progreso: ProgresoEmision | null; vistas: FaseEmision[]; cancelando: boolean }
  | { fase: "hecho"; r: ResultadoEmitir }
  | { fase: "fallo"; mensaje: string; recargar: boolean };

type Descarga = { nombre: string; url: string; bytes: number };
type Reintento = { fase: "inactivo" } | { fase: "reintentando" } | { fase: "ok"; fila: FilaEmision } | { fase: "error"; detalle: string };

/** Tope de la nota de la emisión (CHECK de licitacion_emisiones). */
const MAX_NOTA = 2000;
/** Espera a que el editor refleje lo guardado (la pantalla se repinta después de que guardarAhora resuelve). */
const ESPERA_REPINTADO_MS = 4000;
/** Entre una descarga automática y la siguiente (varias seguidas el navegador las bloquea o pregunta). */
const PAUSA_DESCARGAS_MS = 700;

const OPCIONES_INICIALES: OpcionesEmision = { propuesta: true, bloques: true, completo: true, empaque: "zip", subirCopias: true };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function motivoNoGuardado(s: Instantanea): string {
  switch (s.fase) {
    case "conflicto": return "Otra persona guardó esta licitación mientras editabas: el guardado está detenido. Decide qué hacer en el aviso de arriba (recargar o guardar como copia) y vuelve a emitir.";
    case "error": return `No se pudo guardar${s.errorGuardado ? ` (${s.errorGuardado})` : ""}. Se emite exactamente lo guardado, así que primero tiene que guardarse: reintenta.`;
    case "solo_lectura": return "La licitación está en solo lectura (archivada o sin permiso de escritura): no se puede emitir.";
    default: return "Quedan cambios sin guardar (se siguió editando mientras se guardaba). Vuelve a pulsar «Emitir».";
  }
}

function clicDescarga(url: string, nombre: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function ModalEmision(p: Props) {
  const [opts, setOpts] = useState<OpcionesEmision>(OPCIONES_INICIALES);
  const [nota, setNota] = useState("");
  const [confirmo, setConfirmo] = useState(false);
  const [errorOpciones, setErrorOpciones] = useState<string | null>(null);
  const [estado, setEstado] = useState<Estado>({ fase: "opciones" });
  const [descargas, setDescargas] = useState<Descarga[]>([]);
  const [reintento, setReintento] = useState<Reintento>({ fase: "inactivo" });
  const [resumen, setResumen] = useState<{ ok: true; r: ResumenExpediente } | { ok: false; error: string } | null>(null);

  const ctrlRef = useRef<AbortController | null>(null);
  const enCurso = useRef(false);
  const modRef = useRef<ModEmitir | null>(null);
  const urlsRef = useRef<string[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ── Memoria: al cerrar se sueltan los object URL, se cancelan las descargas en cola y la emisión ──
  const liberar = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];
  }, []);
  useEffect(() => () => { ctrlRef.current?.abort(); liberar(); }, [liberar]);

  const ocupado = estado.fase === "preparando" || estado.fase === "emitiendo";

  // No salir de la página a media emisión.
  useEffect(() => {
    if (!ocupado) return;
    const antes = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", antes);
    return () => window.removeEventListener("beforeunload", antes);
  }, [ocupado]);

  // Esc cierra, salvo mientras se emite.
  const { onCerrar } = p;
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape" && !ocupado) onCerrar(); };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [ocupado, onCerrar]);

  // ── Resumen del expediente (resolverExpediente se carga al abrir el modal) ──
  const { lic, ctx, revision, comprobacion } = p;
  useEffect(() => {
    let vivo = true;
    import("@/lib/licitaciones/expediente").then(
      (m) => {
        if (!vivo) return;
        try { setResumen({ ok: true, r: resumenExpediente(m.resolverExpediente(lic, ctx, revision), comprobacion?.revisiones ?? null) }); }
        catch (e) { setResumen({ ok: false, error: msg(e) || "error inesperado" }); }
      },
      (e) => { if (vivo) setResumen({ ok: false, error: msg(e) || "no se pudo cargar" }); },
    );
    return () => { vivo = false; };
  }, [lic, ctx, revision, comprobacion]);

  const abiertos = useMemo(() => abiertosParaEmitir(p.revision), [p.revision]);
  const nAlarmas = abiertos.filter((h) => h.gravedad === "alarma").length;
  const nAvisos = abiertos.length - nAlarmas;
  const nInfo = p.revision.hallazgos.filter((h) => !h.aceptado && h.gravedad === "info").length;
  const foliado = p.lic.doc.expediente.foliado;
  const bloquesActivos = p.lic.doc.expediente.bloques.filter((b) => b.activo).length;

  // ── Entrega de archivos ──
  const entregar = useCallback((archivos: { nombre: string; blob: Blob }[], auto: boolean) => {
    liberar();
    const lista = archivos.map((a) => ({ nombre: a.nombre, bytes: a.blob.size, url: URL.createObjectURL(a.blob) }));
    urlsRef.current = lista.map((d) => d.url);
    setDescargas(lista);
    if (auto) lista.forEach((d, i) => { timersRef.current.push(setTimeout(() => clicDescarga(d.url, d.nombre), i * PAUSA_DESCARGAS_MS)); });
  }, [liberar]);

  const volverAOpciones = (error: string | null) => { setErrorOpciones(error); setEstado({ fase: "opciones" }); };

  // ── Emitir ──
  const emitir = async () => {
    if (enCurso.current) return;
    enCurso.current = true;
    setErrorOpciones(null);
    setReintento({ fase: "inactivo" });
    liberar();
    setDescargas([]);
    setEstado({ fase: "preparando", detalle: "Guardando los cambios pendientes…" });
    try {
      // 1 · Guardar lo pendiente: se emite exactamente lo guardado.
      const guardado = await p.guardarAhora();
      if (!guardado) { await dormir(80); volverAOpciones(motivoNoGuardado(p.leer())); return; }
      const limite = Date.now() + ESPERA_REPINTADO_MS;
      while (p.leer().pendiente && Date.now() < limite) await dormir(50);
      const s = p.leer();
      if (s.pendiente) { volverAOpciones("El guardado terminó pero la pantalla no se actualizó a tiempo. Vuelve a pulsar «Emitir»."); return; }
      if (!s.ctx) { volverAOpciones("Todavía no se leyó lo que el ERP sabe de la licitación: espera a que termine y vuelve a pulsar «Emitir»."); return; }

      // 2 · ¿Es la última versión guardada? (otra persona pudo guardar sin que aquí hubiera nada pendiente)
      setEstado({ fase: "preparando", detalle: "Comprobando que sea la última versión guardada…" });
      const vb = await versionEnBase(s.lic.id);
      if (!vb.ok) { volverAOpciones(`No se pudo comprobar en la base que esta sea la última versión guardada: ${vb.error} Vuelve a intentarlo.`); return; }
      if (vb.version !== s.lic.version) {
        setEstado({
          fase: "fallo", recargar: true,
          mensaje: `Otra persona guardó esta licitación (versión ${vb.version}${vb.en ? `, el ${instanteLima(vb.en)}` : ""}) y en pantalla tienes la versión ${s.lic.version}. Se emite exactamente lo guardado: recarga la página para traer la última versión, revísala y vuelve a emitir. No se emitió nada.`,
        });
        return;
      }

      // 3 · Cargar el armador (emitir.ts trae pdf-lib) y la última emisión (para «cambió desde la emisión»).
      setEstado({ fase: "preparando", detalle: "Cargando el armador de PDF…" });
      const [mE, mD, mX, ultima] = await Promise.all([
        import("@/lib/licitaciones/emitir"), import("@/lib/licitaciones/documento"), import("@/lib/licitaciones/expediente"),
        p.asegurarUltima(),
      ]);
      modRef.current = mE;
      const revisiones = p.comprobacion?.revisiones;
      const rev = revisarLicitacion(s.lic, s.ctx, revisiones, ultima);
      const deps = mE.depsNavegador(supabase, { resolverDocumento: mD.resolverDocumento, resolverExpediente: mX.resolverExpediente, revisarLicitacion });

      // 4 · Emitir.
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setEstado({ fase: "emitiendo", progreso: null, vistas: [], cancelando: false });
      const onProgreso = (pr: ProgresoEmision) => setEstado((x) => (x.fase === "emitiendo"
        ? { ...x, progreso: pr, vistas: x.vistas.includes(pr.fase) ? x.vistas : [...x.vistas, pr.fase] }
        : x));
      const r = await mE.emitirLicitacion(s.lic, s.ctx, rev, opts, deps, onProgreso, ctrl.signal, {
        versionGuardada: s.lic.version, hayCambiosSinGuardar: p.leer().pendiente,
        logo: empresaConDefectos(s.ctx.perfil).logo, nota: nota.trim() ? nota.trim().slice(0, MAX_NOTA) : null,
        revisiones, ultima,
      });
      ctrlRef.current = null;
      if (r.ok) {
        entregar(r.archivos, true);
        if (r.emision) p.onEmitida(r.emision);
      } else if (r.codigo === "registro_fallido" && r.archivos.length) {
        entregar(r.archivos, true);
      } else if (r.codigo === "cancelada" && r.archivos.length) {
        entregar(r.archivos, false);
      }
      setEstado({ fase: "hecho", r });
    } catch (e) {
      setEstado({
        fase: "fallo", recargar: false,
        mensaje: `La emisión se detuvo por un error inesperado (${msg(e) || "sin detalle"}). No se registró nada; si alcanzaron a subirse copias, quedan en su carpeta sin registro. Vuelve a intentarlo y, si se repite, avisa a soporte con este detalle.`,
      });
    } finally {
      enCurso.current = false;
      ctrlRef.current = null;
    }
  };

  const cancelar = () => {
    ctrlRef.current?.abort();
    setEstado((x) => (x.fase === "emitiendo" ? { ...x, cancelando: true } : x));
  };

  const reintentarRegistro = async () => {
    const mE = modRef.current;
    if (!mE || estado.fase !== "hecho" || estado.r.ok || !estado.r.registroPendiente) return;
    setReintento({ fase: "reintentando" });
    try {
      const x = await mE.registrarEmision(supabase, estado.r.registroPendiente);
      if (x.ok) { setReintento({ fase: "ok", fila: x.fila }); p.onEmitida(x.fila); }
      else setReintento({ fase: "error", detalle: x.detalle });
    } catch (e) {
      setReintento({ fase: "error", detalle: msg(e) || "error inesperado" });
    }
  };

  // ── Lo que falta para poder emitir (dicho fijo debajo del botón) ──
  const algo = opts.propuesta || opts.bloques || opts.completo;
  const faltaEmitir: string | null =
    p.faseGuardado === "conflicto" ? "Otra persona guardó esta licitación: resuelve el aviso de arriba antes de emitir."
    : p.faseGuardado === "solo_lectura" ? "La licitación está en solo lectura: no se puede emitir."
    : !algo ? "Marca al menos una pieza: la propuesta, los bloques o el expediente completo."
    : !opts.propuesta && bloquesActivos === 0 && !(opts.completo && p.lic.doc.expediente.propuestaEnCompleto === "primero")
      ? "El expediente no tiene bloques activos: marca la propuesta técnica o activa bloques en el paso Expediente."
    : abiertos.length > 0 && !confirmo ? "Confirma arriba que se emite con los hallazgos abiertos."
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="emision-titulo">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-3">
          <div className="min-w-0">
            <h2 id="emision-titulo" className="text-lg font-bold text-gray-900">
              Emitir la licitación{p.proximaVersion ? ` · será la versión ${p.proximaVersion}` : ""}
            </h2>
            <p className="truncate text-xs text-gray-500">{p.lic.nombre}{p.lic.codigo ? ` · ${p.lic.codigo}` : ""}</p>
          </div>
          {!ocupado && (
            <button type="button" onClick={p.onCerrar} className="text-sm text-gray-400 hover:text-gray-700" aria-label="Cerrar">✕</button>
          )}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          {estado.fase === "opciones" && (
            <>
              {errorOpciones && <Nota tono="rojo">{errorOpciones}</Nota>}
              {p.pendiente && p.faseGuardado !== "conflicto" && (
                <Nota tono="gris">Hay cambios sin guardar: se guardan antes de emitir (se emite exactamente lo guardado).</Nota>
              )}

              {/* Qué se emite */}
              <fieldset className="space-y-2">
                <legend className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-500">Qué se emite</legend>
                <Casilla checked={opts.propuesta} onChange={(v) => setOpts((o) => ({ ...o, propuesta: v }))}
                  titulo="Propuesta técnica en PDF"
                  detalle="Portada, control del documento, carta, índice con páginas reales, secciones y firma." />
                <Casilla checked={opts.bloques} onChange={(v) => setOpts((o) => ({ ...o, bloques: v }))}
                  titulo={`Un PDF por bloque del expediente (${plural(bloquesActivos, "bloque activo", "bloques activos")})`}
                  detalle={`Cada uno con su portada separadora y sus documentos unidos.${foliado.modo !== "ninguno" && foliado.foliarBloquesSueltos ? " Llevan el folio que tienen en el expediente completo." : ""}`} />
                <Casilla checked={opts.completo} onChange={(v) => setOpts((o) => ({ ...o, completo: v }))}
                  titulo={foliado.modo === "ninguno" ? "Expediente completo (sin foliar)" : `Expediente completo foliado (${foliado.modo})`}
                  detalle={foliado.modo === "ninguno"
                    ? "El foliado está apagado en el paso Expediente → Foliado: el completo sale sin números."
                    : `Todo en un solo PDF con «${foliado.formato.replace("{n}", "1".padStart(foliado.digitos, "0"))}» en cada hoja${p.lic.doc.expediente.propuestaEnCompleto === "primero" ? ", con la propuesta técnica al inicio" : ""}. Es el que más memoria usa.`} />
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-500">Cómo se descarga</legend>
                <div className="flex flex-wrap gap-2">
                  {(["zip", "sueltos"] as const).map((e) => (
                    <label key={e} className={`flex flex-1 cursor-pointer items-start gap-2 rounded-xl border-2 px-3 py-2 text-xs ${opts.empaque === e ? "border-[#0b315f] bg-[#eef3f8]" : "border-gray-200"}`}>
                      <input type="radio" name="empaque" checked={opts.empaque === e} onChange={() => setOpts((o) => ({ ...o, empaque: e }))} className="mt-0.5" />
                      <span>
                        <span className="block font-bold text-gray-900">{e === "zip" ? "Un ZIP" : "Archivos sueltos"}</span>
                        <span className="block text-gray-500">{e === "zip" ? "Un solo archivo con todos los PDF (sin compresión)." : "Un PDF por pieza: el navegador puede pedir permiso para descargar varios."}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <Casilla checked={opts.subirCopias} onChange={(v) => setOpts((o) => ({ ...o, subirCopias: v }))}
                  titulo="Guardar una copia de cada PDF en el ERP"
                  detalle="Es la constancia de lo presentado: no se puede borrar ni reescribir. Se abre después desde el historial." />
                {!opts.subirCopias && (
                  <Nota tono="ambar">Sin copias, la emisión queda registrada pero los PDF solo quedan en tu computadora: el historial no podrá abrirlos.</Nota>
                )}
              </fieldset>

              {/* Resumen */}
              <div className="space-y-1.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                <p className="font-bold text-gray-800">Antes de emitir</p>
                <p>Vigencias medidas al {fechaDMY(p.revision.fechaReferencia)} ({p.revision.referenciaEs === "presentacion" ? "fecha de presentación" : "hoy: falta la fecha de presentación"}).</p>
                {!resumen ? <p className="text-gray-500">Contando las partes del expediente…</p>
                  : !resumen.ok ? <p className="text-amber-800">No se pudo contar las partes del expediente ({resumen.error}); la emisión las cuenta igual.</p>
                  : <ResumenPartes r={resumen.r} conPropuesta={opts.propuesta || p.lic.doc.expediente.propuestaEnCompleto === "primero"} comprobado={!!p.comprobacion} />}
                {!p.comprobacion ? (
                  <p className="text-gray-500">No comprobaste los archivos: la emisión los revisa al bajarlos, y lo que no se pueda unir (PDF protegido, Drive…) se omitirá y se nombrará.</p>
                ) : p.comprobacionVieja ? (
                  <p className="text-gray-500">La comprobación de archivos es anterior a tus últimos cambios del expediente o de los recursos: lo nuevo se revisa al bajarlo.</p>
                ) : null}
              </div>

              {/* Hallazgos abiertos */}
              {abiertos.length > 0 ? (
                <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                  <p className="font-bold">
                    Se emite con {nAlarmas > 0 && <span className="text-red-800">{plural(nAlarmas, "alarma abierta", "alarmas abiertas")}</span>}
                    {nAlarmas > 0 && nAvisos > 0 && " y "}
                    {nAvisos > 0 && plural(nAvisos, "aviso abierto", "avisos abiertos")}
                    {nInfo > 0 && <span className="font-normal"> (además de {nInfo} info)</span>}
                  </p>
                  <p>No impiden emitir: quedan registrados en la emisión como abiertos. Si alguno se presenta así a propósito, acéptalo con una nota en la lista de hallazgos.</p>
                  <ul className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-amber-200 bg-white px-2 py-1.5">
                    {abiertos.map((h) => (
                      <li key={h.clave} style={{ color: ESTILO_GRAVEDAD[h.gravedad].color }}>
                        <span aria-hidden="true">{ESTILO_GRAVEDAD[h.gravedad].icono}</span> <b>{h.titulo}</b>{h.sujeto.rotulo ? ` · ${h.sujeto.rotulo}` : ""}
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-start gap-2 font-semibold">
                    <input type="checkbox" checked={confirmo} onChange={(e) => setConfirmo(e.target.checked)} className="mt-0.5" />
                    <span>Emito con {abiertos.length === 1 ? "este hallazgo abierto" : `estos ${abiertos.length} hallazgos abiertos`}: quedan registrados en la emisión.</span>
                  </label>
                </div>
              ) : (
                <Nota tono="verde">No hay alarmas ni avisos abiertos{p.revision.hallazgos.some((h) => h.aceptado) ? " (los aceptados quedan registrados con su nota)" : ""}.</Nota>
              )}

              <label className="block text-xs">
                <span className="font-bold text-gray-700">Nota de la emisión (opcional)</span>
                <span className="block text-gray-500">Por ejemplo: «Versión enviada por correo al comité» o «Corrige el SOAT de la U2».</span>
                <textarea value={nota} maxLength={MAX_NOTA} rows={2} onChange={(e) => setNota(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5" />
              </label>
            </>
          )}

          {estado.fase === "preparando" && (
            <div className="space-y-2">
              <Barra hecho={0} total={0} />
              <p className="text-xs text-gray-600">{estado.detalle}</p>
            </div>
          )}

          {estado.fase === "emitiendo" && <Progreso e={estado} />}

          {estado.fase === "fallo" && (
            <div className="space-y-2">
              <Nota tono="rojo">{estado.mensaje}</Nota>
              {estado.recargar && (
                <button type="button" onClick={() => window.location.reload()} className={BOTON_PRIMARIO}>Recargar la página</button>
              )}
            </div>
          )}

          {estado.fase === "hecho" && (
            <Resultado
              r={estado.r} descargas={descargas} reintento={reintento} onReintentar={() => void reintentarRegistro()}
              onVolver={(sinCompleto) => { if (sinCompleto) setOpts((o) => ({ ...o, completo: false })); liberar(); setDescargas([]); volverAOpciones(null); }}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 px-5 py-3">
          {estado.fase === "opciones" && (
            <>
              {faltaEmitir && <p className="mr-auto text-xs text-gray-600">{faltaEmitir}</p>}
              <button type="button" onClick={p.onCerrar} className={BOTON_SECUNDARIO}>Cerrar</button>
              <button type="button" onClick={() => void emitir()} disabled={!!faltaEmitir} className={BOTON_PRIMARIO}>Emitir</button>
            </>
          )}
          {estado.fase === "preparando" && <p className="text-xs text-gray-500">Preparando… no cierres esta pestaña.</p>}
          {estado.fase === "emitiendo" && (
            <>
              <p className="mr-auto text-xs text-gray-500">Se arma en tu navegador: no cierres esta pestaña.</p>
              <button type="button" onClick={cancelar} disabled={estado.cancelando} className={BOTON_SECUNDARIO}>
                {estado.cancelando ? "Cancelando…" : "Cancelar"}
              </button>
            </>
          )}
          {(estado.fase === "hecho" || estado.fase === "fallo") && (
            <button type="button" onClick={p.onCerrar} className={BOTON_PRIMARIO}>Cerrar</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Casilla({ checked, onChange, titulo, detalle }: { checked: boolean; onChange: (v: boolean) => void; titulo: string; detalle: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        <span className="block font-bold text-gray-900">{titulo}</span>
        <span className="block text-gray-500">{detalle}</span>
      </span>
    </label>
  );
}

function ResumenPartes({ r, conPropuesta, comprobado }: { r: ResumenExpediente; conPropuesta: boolean; comprobado: boolean }) {
  const sinComprobar = Math.max(0, r.archivos - r.archivosConPaginas - r.archivosFallidos);
  return (
    <>
      <p>
        Se arman {conPropuesta ? "la propuesta técnica (sus páginas se cuentan al dibujarla) y " : ""}
        {plural(r.bloques, "bloque", "bloques")}: {plural(r.portadas, "portada separadora", "portadas separadoras")}, {plural(r.generadas, "hoja generada", "hojas generadas")} (fichas, cuadros, tablas) y {plural(r.archivos, "documento", "documentos")}.
        {r.conPropuesta > 0 ? ` ${plural(r.conPropuesta, "bloque lleva", "bloques llevan")} la propuesta dentro.` : ""}
      </p>
      <p>
        Páginas ya conocidas del expediente: ≈ {r.paginasConocidas}
        {sinComprobar > 0 ? ` + las de ${plural(sinComprobar, "documento", "documentos")} que se cuentan al bajarlos${comprobado ? "" : " (comprueba los archivos para saberlo antes)"}` : ""}.
      </p>
      {r.omitidas > 0 && <p className="text-amber-800">{plural(r.omitidas, "parte se omitirá", "partes se omitirán")} por no tener un archivo que se pueda unir: se nombran al emitir.</p>}
      {r.bytesConocidos > MAX_BYTES_EXPEDIENTE && (
        <p className="text-amber-800">Los archivos comprobados suman {tamanoArchivo(r.bytesConocidos)}, más de lo que un navegador sostiene con holgura (~250 MB): si se queda sin memoria, desmarca el expediente completo o emite por partes.</p>
      )}
    </>
  );
}

function Progreso({ e }: { e: Extract<Estado, { fase: "emitiendo" }> }) {
  const pr = e.progreso;
  const actual = pr?.fase ?? "comprobando";
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="font-bold text-gray-800">{e.cancelando ? "Cancelando…" : ETIQUETA_FASE[actual]}</span>
          {pr && pr.total > 0 && <span className="text-gray-500">{pr.hecho} de {pr.total}</span>}
        </div>
        <Barra hecho={pr?.hecho ?? 0} total={pr?.total ?? 0} />
        {pr?.detalle && <p className="text-xs text-gray-600">{pr.detalle}</p>}
      </div>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-3">
        {ORDEN_FASES.filter((f) => f !== "listo").map((f) => {
          const vista = e.vistas.includes(f);
          const esActual = f === actual;
          return (
            <li key={f} className={esActual ? "font-bold text-[#0b315f]" : vista ? "text-emerald-700" : "text-gray-400"}>
              {esActual ? "▸" : vista ? "✓" : "·"} {ETIQUETA_FASE[f]}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Resultado({ r, descargas, reintento, onReintentar, onVolver }: {
  r: ResultadoEmitir; descargas: Descarga[]; reintento: Reintento; onReintentar: () => void; onVolver: (sinCompleto: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      {r.ok ? (
        <Nota tono="verde">
          <p className="font-bold">
            {r.emision ? `Emisión versión ${r.emision.version} registrada${r.emision.emitido_en ? ` el ${instanteLima(r.emision.emitido_en)}` : ""}.` : "Emisión armada."}
          </p>
          <p>{descargas.length ? "La descarga empezó sola. Si el navegador pidió permiso para descargar varios archivos, acéptalo, o descárgalos uno a uno aquí abajo." : "No hubo archivos que descargar."}</p>
        </Nota>
      ) : r.codigo === "registro_fallido" ? (
        <div className="space-y-2">
          <Nota tono={reintento.fase === "ok" ? "verde" : "rojo"}>
            {reintento.fase === "ok" ? (
              <p className="font-bold">Registrada como versión {reintento.fila.version}. Los archivos ya se descargaron.</p>
            ) : (
              <>
                <p className="font-bold">Los archivos están listos, pero no se pudo registrar la emisión.</p>
                <p>{r.detalle}</p>
                {reintento.fase === "error" && <p className="mt-1">El reintento también falló: {reintento.detalle}</p>}
              </>
            )}
          </Nota>
          {reintento.fase !== "ok" && (
            <button type="button" onClick={onReintentar} disabled={reintento.fase === "reintentando"} className={BOTON_PRIMARIO}>
              {reintento.fase === "reintentando" ? "Reintentando el registro…" : "Reintentar el registro"}
            </button>
          )}
        </div>
      ) : r.codigo === "cancelada" ? (
        <Nota tono="gris"><p className="font-bold">Se canceló la emisión.</p><p>{r.detalle}</p></Nota>
      ) : r.codigo === "conflicto_version" ? (
        <div className="space-y-2">
          <Nota tono="rojo"><p className="font-bold">No se emitió: la licitación cambió.</p><p>{r.detalle}</p></Nota>
          <button type="button" onClick={() => window.location.reload()} className={BOTON_PRIMARIO}>Recargar la página</button>
        </div>
      ) : r.codigo === "memoria" ? (
        <div className="space-y-2">
          <Nota tono="ambar"><p className="font-bold">El navegador se quedó sin memoria.</p><p>{r.detalle}</p></Nota>
          <button type="button" onClick={() => onVolver(true)} className={BOTON_PRIMARIO}>Volver a las opciones sin el expediente completo</button>
        </div>
      ) : (
        <div className="space-y-2">
          <Nota tono="gris"><p className="font-bold">No hubo nada que emitir.</p><p>{r.detalle}</p></Nota>
          <button type="button" onClick={() => onVolver(false)} className={BOTON_SECUNDARIO}>Volver a las opciones</button>
        </div>
      )}

      {descargas.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-500">Descargar</p>
          <ul className="space-y-1">
            {descargas.map((d) => (
              <li key={d.url} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 break-words font-semibold text-gray-800">{d.nombre}</span>
                <span className="text-gray-500">{tamanoArchivo(d.bytes)}</span>
                <a href={d.url} download={d.nombre} className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 font-bold text-[#0b315f] hover:bg-gray-50">Descargar</a>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-gray-500">Estos archivos viven solo en esta ventana: al cerrarla se sueltan de la memoria{r.ok || r.codigo === "registro_fallido" ? " (las copias subidas quedan en el historial)" : ""}.</p>
        </div>
      )}

      {r.emitidos.length > 0 && (r.ok || r.codigo === "registro_fallido") && (
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-500">Lo emitido</p>
          <ul className="space-y-1 text-xs">
            {r.emitidos.map((a, i) => (
              <li key={`${a.nombre}|${i}`} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 break-words font-semibold text-gray-800">{a.nombre}</span>
                  {a.url ? <Chip tono="verde">copia en el ERP</Chip> : <Chip tono="gris">sin copia</Chip>}
                </div>
                <p className="text-[11px] text-gray-500">
                  {ETIQUETA_TIPO_ARCHIVO[a.tipo]}{a.paginas != null ? ` · ${a.paginas} pág.` : ""} · {tamanoArchivo(a.bytes)}
                  {a.folios ? ` · folios ${a.folios.desde}–${a.folios.hasta}` : ""}
                </p>
                {!a.url && a.motivoNoSubido && <p className="text-[11px] text-gray-500">{a.motivoNoSubido}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.omitidos.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-amber-800">Se omitió al unir ({r.omitidos.length})</p>
          <ul className="space-y-0.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-950">
            {r.omitidos.map((o, i) => (
              <li key={`${o.itemId}|${i}`}>· <b>{o.titulo}</b> — {CATALOGO_HALLAZGOS[o.codigo]?.titulo ?? o.codigo}: {o.detalle}</li>
            ))}
          </ul>
        </div>
      )}

      {r.avisos.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-500">Avisos de la emisión</p>
          <ul className="space-y-0.5 text-xs text-gray-700">
            {r.avisos.map((a, i) => <li key={i}>· {a}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
