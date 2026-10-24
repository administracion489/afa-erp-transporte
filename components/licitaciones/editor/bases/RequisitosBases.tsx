"use client";
// components/licitaciones/editor/bases/RequisitosBases.tsx — El checklist de requisitos (doc.requisitos).
// Cada requisito se edita aquí y, al lado, se ve lo que dice el MOTOR (revision.evaluaciones): el estado
// final, el detalle y los hallazgos que lleva ese requisito. La pantalla no decide nada: si la marca a
// mano contradice lo que comprueba la regla, lo DICE (no lo arregla). Mientras no hay revisión,
// «comprobando…»: nunca se pinta «pendiente» por no haber leído.
import { useMemo, useState } from "react";
import { LIMITES_TEXTO } from "@/lib/licitaciones/normalizar";
import { describirRegla } from "@/lib/licitaciones/reglas";
import {
  CATEGORIAS_REQUISITO, TOPES_DOC,
  type CategoriaRequisito, type DocLicitacion, type EstadoFinal, type EstadoManual, type EvaluacionRequisito,
  type Hallazgo, type Paso, type Requisito, type Revision,
} from "@/lib/licitaciones/tipos";
import { anclaDe, type TonoAviso } from "../contrato-editor";
import { apuntaA, useEditorExtra } from "../contexto-editor";
import { ETIQUETA_CATEGORIA, ETIQUETA_FINAL } from "../etiquetas";
import { ListaHallazgos } from "../HallazgosPaso";
import { TextoCita } from "../RevisarAnalisis";
import EditorRegla from "./EditorRegla";
import { BOTON, BOTON_PRIMARIO, Chip, INPUT, Tarjeta, claveTexto } from "./ui";

type Props = {
  doc: DocLicitacion;
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  revision: Revision | null;
  ctxCargando: boolean;
  irA: (p: Paso, ancla?: string | null) => void;
  soloLectura: boolean;
  nuevoId: () => string;
  aviso: (t: string, tono?: TonoAviso) => void;
};

const FINALES: EstadoFinal[] = ["no_cumple", "pendiente", "no_se_puede_juzgar", "cumple", "no_aplica"];
const ETIQ_MANUAL: Record<EstadoManual, string> = { cumple: "Cumple", no_cumple: "No cumple", no_aplica: "No aplica" };
const ETIQ_ORIGEN: Record<Requisito["origen"], string> = { manual: "a mano", ia: "IA", plantilla: "plantilla", copia: "copia" };

export default function RequisitosBases({ doc, cambiarDoc, revision, ctxCargando, irA, soloLectura, nuevoId, aviso }: Props) {
  const { ancla } = useEditorExtra();
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const [cerradoAncla, setCerradoAncla] = useState<number | null>(null);
  const [fCat, setFCat] = useState<CategoriaRequisito | "">("");
  const [fEst, setFEst] = useState<EstadoFinal | "">("");
  const [busca, setBusca] = useState("");

  const evals = useMemo(() => new Map((revision?.evaluaciones ?? []).map((e) => [e.requisitoId, e])), [revision]);
  const hallazgosDe = useMemo(() => {
    const m = new Map<string, Hallazgo[]>();
    for (const h of revision?.hallazgos ?? []) {
      if (!h.requisitoId) continue;
      const xs = m.get(h.requisitoId) ?? [];
      xs.push(h);
      m.set(h.requisitoId, xs);
    }
    return m;
  }, [revision]);

  const reqs = doc.requisitos;
  const objetivo = reqs.find((q) => apuntaA(ancla, anclaDe("requisito", q.id)))?.id ?? null;
  const visibles = reqs.filter((q) => {
    if (q.id === objetivo) return true;   // el destino de una navegación se ve aunque el filtro lo esconda
    if (fCat && q.categoria !== fCat) return false;
    if (fEst && evals.get(q.id)?.final !== fEst) return false;
    if (busca.trim() && !claveTexto(`${q.numeral ?? ""} ${q.texto}`).includes(claveTexto(busca))) return false;
    return true;
  });
  const cuentaCat = (c: CategoriaRequisito) => reqs.filter((q) => q.categoria === c).length;
  const cuentaEst = (e: EstadoFinal) => reqs.filter((q) => evals.get(q.id)?.final === e).length;

  const estaAbierto = (id: string) => abiertos.has(id) || (id === objetivo && cerradoAncla !== ancla?.n);
  const alternar = (id: string) => {
    if (estaAbierto(id)) {
      const s = new Set(abiertos); s.delete(id); setAbiertos(s);
      if (id === objetivo && ancla) setCerradoAncla(ancla.n);
    } else {
      setAbiertos(new Set([...abiertos, id]));
    }
  };

  const actualizar = (id: string, patch: Partial<Requisito>) =>
    cambiarDoc((d) => ({ ...d, requisitos: d.requisitos.map((q) => (q.id === id ? { ...q, ...patch } : q)) }));
  const mover = (id: string, dir: -1 | 1) => {
    const iv = visibles.findIndex((q) => q.id === id);
    const vecino = visibles[iv + dir];
    if (!vecino) return;
    cambiarDoc((d) => {
      const xs = [...d.requisitos];
      const i = xs.findIndex((q) => q.id === id);
      const [q] = xs.splice(i, 1);
      const j = xs.findIndex((x) => x.id === vecino.id);
      xs.splice(dir < 0 ? j : j + 1, 0, q);
      return { ...d, requisitos: xs };
    });
  };
  const agregar = () => {
    if (reqs.length >= TOPES_DOC.maxRequisitos) { aviso(`La lista ya tiene ${TOPES_DOC.maxRequisitos} requisitos (el tope).`, "error"); return; }
    const id = nuevoId();
    const q: Requisito = {
      id, numeral: null, texto: "", categoria: fCat || "otro", obligatorio: true, regla: null, manual: null,
      cumpleTexto: null, sustento: "", bloqueExpedienteId: null, enMatriz: true, origen: "manual", cita: null,
    };
    cambiarDoc((d) => ({ ...d, requisitos: [...d.requisitos, q] }));
    setAbiertos(new Set([...abiertos, id]));
    setFEst(""); setBusca("");
    setTimeout(() => document.getElementById(anclaDe("requisito", id))?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  };
  const duplicar = (q: Requisito) => {
    if (reqs.length >= TOPES_DOC.maxRequisitos) { aviso(`La lista ya tiene ${TOPES_DOC.maxRequisitos} requisitos (el tope).`, "error"); return; }
    const id = nuevoId();
    cambiarDoc((d) => {
      const i = d.requisitos.findIndex((x) => x.id === q.id);
      const xs = [...d.requisitos];
      xs.splice(i + 1, 0, { ...q, id, origen: "manual", regla: q.regla ? (JSON.parse(JSON.stringify(q.regla)) as Requisito["regla"]) : null });
      return { ...d, requisitos: xs };
    });
    setAbiertos(new Set([...abiertos, id]));
  };
  const quitar = (q: Requisito) => {
    const rot = `${q.numeral ? `${q.numeral} · ` : ""}${Array.from(q.texto).slice(0, 80).join("") || "(sin texto)"}`;
    const nh = (hallazgosDe.get(q.id) ?? []).filter((h) => h.aceptado).length;
    if (!window.confirm(`¿Quitar el requisito «${rot}»?${nh ? `\n\nTiene ${nh} hallazgo(s) aceptado(s) con nota: la nota se pierde.` : ""}`)) return;
    cambiarDoc((d) => ({ ...d, requisitos: d.requisitos.filter((x) => x.id !== q.id) }));
  };

  return (
    <Tarjeta id="requisitos" titulo={`✅ Requisitos (${reqs.length})`}
      subtitulo="Lo que piden las bases. Con una REGLA, el ERP lo comprueba solo con los datos de la empresa; sin regla, lo marca una persona. Lo marcado «en la matriz» sale en la matriz de cumplimiento de la propuesta."
      acciones={!soloLectura ? <button type="button" className={BOTON_PRIMARIO} onClick={agregar}>+ Agregar requisito</button> : undefined}>
      {reqs.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input className={INPUT} placeholder="Buscar por numeral o texto…" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar requisito" />
          <select className={INPUT} value={fCat} onChange={(e) => setFCat(e.target.value as CategoriaRequisito | "")} aria-label="Filtrar por categoría">
            <option value="">Todas las categorías</option>
            {CATEGORIAS_REQUISITO.filter((c) => cuentaCat(c) > 0).map((c) => <option key={c} value={c}>{ETIQUETA_CATEGORIA[c]} ({cuentaCat(c)})</option>)}
          </select>
          <select className={INPUT} value={fEst} disabled={!revision} onChange={(e) => setFEst(e.target.value as EstadoFinal | "")} aria-label="Filtrar por estado">
            <option value="">{revision ? "Todos los estados" : ctxCargando ? "Comprobando estados…" : "Estados no disponibles"}</option>
            {revision && FINALES.map((e) => <option key={e} value={e}>{ETIQUETA_FINAL[e].texto} ({cuentaEst(e)})</option>)}
          </select>
        </div>
      )}
      {reqs.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-gray-500">
          <span>{visibles.length === reqs.length ? `${reqs.length} requisito(s)` : `Mostrando ${visibles.length} de ${reqs.length}`}</span>
          <span className="flex gap-2">
            <button type="button" className="underline" onClick={() => setAbiertos(new Set(visibles.map((q) => q.id)))}>Abrir todos</button>
            <button type="button" className="underline" onClick={() => { setAbiertos(new Set()); if (ancla) setCerradoAncla(ancla.n); }}>Cerrar todos</button>
          </span>
        </div>
      )}

      {reqs.length === 0 ? (
        <p className="text-sm text-gray-500">Todavía no hay requisitos. Léelos de las bases con IA (arriba) o agrégalos a mano.</p>
      ) : visibles.length === 0 ? (
        <p className="text-sm text-gray-500">Ningún requisito coincide con el filtro.</p>
      ) : (
        <ul className="space-y-2">
          {visibles.map((q, i) => (
            <TarjetaRequisito
              key={q.id} q={q} n={reqs.indexOf(q) + 1} doc={doc} ev={evals.get(q.id) ?? null} hallazgos={hallazgosDe.get(q.id) ?? []}
              revisando={!revision} ctxCargando={ctxCargando} abierto={estaAbierto(q.id)} onAlternar={() => alternar(q.id)}
              actualizar={(p) => actualizar(q.id, p)} onSubir={i > 0 ? () => mover(q.id, -1) : null} onBajar={i < visibles.length - 1 ? () => mover(q.id, 1) : null}
              onDuplicar={() => duplicar(q)} onQuitar={() => quitar(q)} irA={irA} soloLectura={soloLectura}
            />
          ))}
        </ul>
      )}
    </Tarjeta>
  );
}

type PropsTarjeta = {
  q: Requisito; n: number; doc: DocLicitacion; ev: EvaluacionRequisito | null; hallazgos: Hallazgo[];
  revisando: boolean; ctxCargando: boolean; abierto: boolean; onAlternar: () => void;
  actualizar: (p: Partial<Requisito>) => void; onSubir: (() => void) | null; onBajar: (() => void) | null;
  onDuplicar: () => void; onQuitar: () => void; irA: (p: Paso, ancla?: string | null) => void; soloLectura: boolean;
};

function TarjetaRequisito({ q, n, doc, ev, hallazgos, revisando, ctxCargando, abierto, onAlternar, actualizar, onSubir, onBajar, onDuplicar, onQuitar, irA, soloLectura }: PropsTarjeta) {
  const fin = ev ? ETIQUETA_FINAL[ev.final] : null;
  const abiertosH = hallazgos.filter((h) => !h.aceptado);
  const nAlarmas = abiertosH.filter((h) => h.gravedad === "alarma").length;
  const nombres = useMemo(() => new Map(doc.bases.map((b, i) => [b.id, `${i + 1}. ${b.nombre}`])), [doc.bases]);
  const bloqueExiste = !q.bloqueExpedienteId || doc.expediente.bloques.some((b) => b.id === q.bloqueExpedienteId);
  const contradice = ev?.auto && q.manual && (q.manual === "cumple" || q.manual === "no_cumple") && (ev.auto.estado === "cumple" || ev.auto.estado === "no_cumple") && ev.auto.estado !== q.manual;
  const ro = soloLectura;

  return (
    <li id={anclaDe("requisito", q.id)} className="rounded-xl border bg-white scroll-mt-4 transition-shadow">
      <button type="button" onClick={onAlternar} aria-expanded={abierto} className="w-full text-left px-3 py-2 flex items-start gap-2">
        <span className="text-gray-400 text-xs pt-0.5 w-4 shrink-0">{abierto ? "▾" : "▸"}</span>
        <span className="text-[11px] text-gray-400 pt-0.5 w-6 shrink-0">{n}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-gray-900 line-clamp-2 break-words">
            {q.numeral && <b className="mr-1">{q.numeral}</b>}
            {q.texto || <span className="text-gray-400">(sin texto)</span>}
          </span>
          <span className="flex flex-wrap gap-1 mt-1">
            <Chip texto={ETIQUETA_CATEGORIA[q.categoria]} color="#0b315f" bg="#e0e7ef" />
            {q.obligatorio ? <Chip texto="Obligatorio" color="#991b1b" bg="#fee2e2" /> : <Chip texto="Deseable" color="#4b5563" bg="#f3f4f6" />}
            {q.regla && <Chip texto="⚙ regla" color="#1e3a8a" bg="#dbeafe" title={describirRegla(q.regla)} />}
            {!q.enMatriz && <Chip texto="fuera de la matriz" color="#6b7280" bg="#f3f4f6" />}
            {fin ? <Chip texto={fin.texto} color={fin.color} bg={fin.bg} /> : <Chip texto={ctxCargando || revisando ? "comprobando…" : "—"} color="#6b7280" bg="#f3f4f6" />}
            {nAlarmas > 0 && <Chip texto={`⛔ ${nAlarmas}`} color="#fff" bg="#dc2626" title={`${nAlarmas} alarma(s)`} />}
          </span>
        </span>
      </button>

      {abierto && (
        <div className="border-t px-3 py-3 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] gap-4">
          {/* Edición */}
          <div className="space-y-2 min-w-0">
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
              <label className="block">
                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Numeral</span>
                <input className={`${INPUT} py-1.5`} value={q.numeral ?? ""} maxLength={LIMITES_TEXTO.numeral} disabled={ro} placeholder="5.2"
                  onChange={(e) => actualizar({ numeral: e.target.value.trim() ? e.target.value : null })} />
              </label>
              <label className="block min-w-0">
                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Categoría</span>
                <select className={`${INPUT} py-1.5`} value={q.categoria} disabled={ro} onChange={(e) => actualizar({ categoria: e.target.value as CategoriaRequisito })}>
                  {CATEGORIAS_REQUISITO.map((c) => <option key={c} value={c}>{ETIQUETA_CATEGORIA[c]}</option>)}
                </select>
              </label>
            </div>
            <label className="block">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Requisito</span>
              <textarea className={`${INPUT} min-h-[64px]`} value={q.texto} maxLength={LIMITES_TEXTO.requisito} disabled={ro}
                placeholder="La exigencia, como la piden las bases" onChange={(e) => actualizar({ texto: e.target.value })} />
              {!q.texto.trim() && <span className="block text-[11px] text-amber-700 mt-0.5">Sin texto, la matriz de cumplimiento tendría un renglón vacío.</span>}
            </label>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={q.obligatorio} disabled={ro} onChange={(e) => actualizar({ obligatorio: e.target.checked })} /> Obligatorio (descalifica si falta)</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={q.enMatriz} disabled={ro} onChange={(e) => actualizar({ enMatriz: e.target.checked })} /> Sale en la matriz de cumplimiento</label>
            </div>

            <div className="rounded-lg border border-gray-200 p-2">
              <EditorRegla regla={q.regla} soloLectura={ro} idBase={`regla-${q.id}`} onCambio={(r) => actualizar({ regla: r })} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block min-w-0">
                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Estado a mano</span>
                <select className={`${INPUT} py-1.5`} value={q.manual ?? ""} disabled={ro} onChange={(e) => actualizar({ manual: (e.target.value || null) as EstadoManual | null })}>
                  <option value="">{q.regla ? "— lo decide la regla" : "— pendiente (sin marcar)"}</option>
                  {(Object.keys(ETIQ_MANUAL) as EstadoManual[]).map((m) => <option key={m} value={m}>{ETIQ_MANUAL[m]}</option>)}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Columna «Cumple» (opcional)</span>
                <input className={`${INPUT} py-1.5`} value={q.cumpleTexto ?? ""} maxLength={LIMITES_TEXTO.corto} disabled={ro} placeholder="Vacío = «Sí». P. ej. «Sí (9+ años)»"
                  onChange={(e) => actualizar({ cumpleTexto: e.target.value.trim() ? e.target.value : null })} />
              </label>
            </div>
            <label className="block">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Sustento adjunto (columna de la matriz)</span>
              <textarea className={`${INPUT} min-h-[48px] text-xs`} value={q.sustento} maxLength={LIMITES_TEXTO.sustento} disabled={ro}
                placeholder="P. ej. «Anexo 3 · Sección II, folios 12–15»" onChange={(e) => actualizar({ sustento: e.target.value })} />
              {!q.sustento.trim() && ev?.auto?.sustento && <span className="block text-[11px] text-gray-500 mt-0.5">Si lo dejas vacío, la matriz usará el que arma el ERP: «{ev.auto.sustento}».</span>}
            </label>
            <label className="block">
              <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Bloque del expediente donde va su documento</span>
              <select className={`${INPUT} py-1.5`} value={q.bloqueExpedienteId ?? ""} disabled={ro} onChange={(e) => actualizar({ bloqueExpedienteId: e.target.value || null })}>
                <option value="">— ninguno</option>
                {!bloqueExiste && <option value={q.bloqueExpedienteId ?? ""}>(un bloque que ya no existe)</option>}
                {doc.expediente.bloques.map((b) => <option key={b.id} value={b.id}>{b.titulo || "(sin título)"}{b.subtitulo ? ` · ${b.subtitulo}` : ""}{b.activo ? "" : " (desactivado)"}</option>)}
              </select>
              {doc.expediente.bloques.length === 0 && <span className="block text-[11px] text-gray-400 mt-0.5">El expediente todavía no tiene bloques: se arman en el paso Expediente.</span>}
            </label>
            {q.cita && (
              <div className="flex items-start justify-between gap-2">
                <TextoCita cita={q.cita} nombres={nombres} />
                {!ro && <button type="button" className="text-[11px] text-gray-500 underline shrink-0" onClick={() => actualizar({ cita: null })}>Quitar cita</button>}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <span className="text-[11px] text-gray-400 self-center mr-auto">Origen: {ETIQ_ORIGEN[q.origen]}</span>
              {!ro && <>
                <button type="button" className={BOTON} disabled={!onSubir} onClick={() => onSubir?.()} aria-label="Subir">↑</button>
                <button type="button" className={BOTON} disabled={!onBajar} onClick={() => onBajar?.()} aria-label="Bajar">↓</button>
                <button type="button" className={BOTON} onClick={onDuplicar}>Duplicar</button>
                <button type="button" className={`${BOTON} text-red-700 border-red-200`} onClick={onQuitar}>Quitar</button>
              </>}
            </div>
          </div>

          {/* Lo que dice el motor */}
          <div className="space-y-2 min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Lo que comprueba el ERP</p>
            {!ev ? (
              <p className="text-xs text-gray-500">{ctxCargando || revisando ? "Comprobando…" : "La revisión no está disponible: no se afirma nada."}</p>
            ) : (
              <>
                <div className="rounded-lg border px-3 py-2 text-xs" style={{ background: fin!.bg, borderColor: fin!.bd, color: fin!.color }}>
                  <p className="font-bold">{fin!.texto}
                    <span className="font-normal"> · {ev.fuente === "manual" ? "marcado a mano" : ev.fuente === "regla" ? "según la regla" : "sin regla ni marca"}</span>
                  </p>
                  {ev.auto?.detalle && <p className="mt-0.5">{ev.auto.detalle}</p>}
                  {!ev.auto && ev.final === "pendiente" && <p className="mt-0.5">Sin regla: márcalo a mano cuando sepas si cumple.</p>}
                </div>
                {contradice && (
                  <p className="text-xs rounded-lg border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2">
                    Lo marcaste «{ETIQ_MANUAL[q.manual!]}», pero la regla comprueba que <b>{ev.auto!.estado === "cumple" ? "sí cumple" : "no cumple"}</b>. Vale tu marca; revisa cuál es la correcta.
                  </p>
                )}
                {q.manual && ev.auto?.estado === "no_se_puede_juzgar" && (
                  <p className="text-[11px] text-gray-500">La regla no puede comprobarlo con lo que hay en el ERP; vale tu marca.</p>
                )}
              </>
            )}
            {hallazgos.length > 0 && <ListaHallazgos hallazgos={[...abiertosH, ...hallazgos.filter((h) => h.aceptado)]} irA={irA} pasoActual="bases" />}
          </div>
        </div>
      )}
    </li>
  );
}
