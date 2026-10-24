"use client";
// components/licitaciones/editor/expediente/TarjetaBloque.tsx — Un bloque del expediente (un separador:
// «Sección II — Requisitos legales», «Anexo 3 — Experiencia»…): sus datos, la portada separadora tal como
// saldrá, los requisitos que mandan su documento aquí, sus documentos y lo que saldrá de cada uno.
//
// La portada y el «Contenido:» se pintan desde el SeparadorResuelto (resolverExpediente), no se rearman.
import { TOPES_DOC, type BloqueExpediente, type BloqueExpedienteResuelto, type EvaluacionRequisito, type Hallazgo, type ParteFuente } from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "../contrato-editor";
import { ETIQUETA_FINAL } from "../etiquetas";
import { adjuntosConArchivo, agregarItem, conBloque, duplicarBloque, ETIQUETA_FUENTE, moverPorId, conBloques, quitarBloque, TIPOS_FUENTE, type TipoFuente } from "./acciones";
import { contarPartes, frasesCuenta, TONO_CLASE } from "./partes";
import FilaItem from "./FilaItem";
import { HallazgosEnLinea } from "./HallazgosEnLinea";
import { BotonIcono, CampoTexto, Casilla, Chip, claseSelect, Nota, Rotulo } from "./ui";

type Props = {
  p: PasoProps;
  bloque: BloqueExpediente;
  k: number;
  total: number;
  editable: boolean;
  abierto: boolean;
  alternar: () => void;
  /** Lo que resolvió el motor para este bloque (undefined = inactivo o sin resolver). */
  resuelto: BloqueExpedienteResuelto | undefined;
  /** ¿Hay resolución? (false mientras no hay contexto o si el motor falló). */
  hayResolucion: boolean;
  partesDe: (itemId: string) => ParteFuente[] | undefined;
  hallazgosDe: (ancla: string) => Hallazgo[];
  evaluaciones: Map<string, EvaluacionRequisito>;
  todos: BloqueExpediente[];
  abrir: (id: string) => void;
};

export default function TarjetaBloque(pr: Props) {
  const { p, bloque: b, k, total, editable, abierto, resuelto, hayResolucion } = pr;
  const dom = anclaDe("bloque_expediente", b.id);
  const nombre = [b.titulo, b.subtitulo].filter((x) => x.trim()).join(" — ") || "Bloque sin título";
  const cambiar = (fn: (x: BloqueExpediente) => BloqueExpediente) => p.cambiarDoc((d) => conBloque(d, b.id, fn));
  const reqs = p.doc.requisitos.filter((q) => q.bloqueExpedienteId === b.id);
  const lleno = b.items.length >= TOPES_DOC.maxItemsBloque;
  const cuenta = resuelto ? contarPartes(resuelto.partes) : null;
  const incluidos = b.items.filter((i) => i.incluido).length;

  const quitar = () => {
    const adj = adjuntosConArchivo([b]);
    const lineas = [`¿Quitar «${nombre}» y sus ${b.items.length} documento${b.items.length === 1 ? "" : "s"}?`];
    if (adj) lineas.push(`Tiene ${adj} archivo${adj === 1 ? "" : "s"} subido${adj === 1 ? "" : "s"}: siguen guardados en el ERP, pero dejan de estar en el expediente.`);
    if (reqs.length) lineas.push(`${reqs.length} requisito${reqs.length === 1 ? "" : "s"} manda${reqs.length === 1 ? "" : "n"} su documento a este bloque (${reqs.map((q) => q.numeral || q.texto.slice(0, 30)).join(", ")}) y quedará${reqs.length === 1 ? "" : "n"} sin bloque.`);
    if (!window.confirm(lineas.join("\n\n"))) return;
    p.cambiarDoc((d) => quitarBloque(d, b.id));
    p.aviso(`Se quitó «${nombre}».`);
  };

  // cambiarDoc aplica la función en el momento: el id nuevo se lee al volver.
  const duplicar = () => {
    const hecho: { id: string | null } = { id: null };
    p.cambiarDoc((d) => { const r = duplicarBloque(d, b.id, p.nuevoId); hecho.id = r.nuevo; return r.doc; });
    if (hecho.id) { pr.abrir(hecho.id); p.aviso(`Se duplicó «${nombre}» debajo.`); }
  };

  const agregar = (tipo: TipoFuente) => {
    const hecho: { id: string | null } = { id: null };
    p.cambiarDoc((d) => { const r = agregarItem(d, b.id, tipo, p.nuevoId); hecho.id = r.nuevo; return r.doc; });
    const id = hecho.id;
    if (id) requestAnimationFrame(() => document.getElementById(anclaDe("item", id))?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const otros = pr.todos.filter((x) => x.id !== b.id);
  const lleno30 = total >= TOPES_DOC.maxBloquesExpediente;

  return (
    <section id={dom} className={`scroll-mt-24 rounded-2xl border bg-white ${b.activo ? "border-gray-200" : "border-dashed border-gray-300"}`}>
      {/* ── Cabecera ── */}
      <div className="flex flex-wrap items-start gap-2 p-3 sm:p-4">
        <button type="button" onClick={pr.alternar} aria-expanded={abierto} className="flex min-w-0 flex-1 items-start gap-2 text-left">
          <span className="mt-0.5 w-4 shrink-0 text-gray-400" aria-hidden="true">{abierto ? "▾" : "▸"}</span>
          <span className="min-w-0">
            <span className={`block break-words text-sm font-bold ${b.activo ? "text-[#0b315f]" : "text-gray-500"}`}>{nombre}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1">
              {!b.activo ? <Chip tono="gris">Desactivado: no sale</Chip>
                : !hayResolucion ? <span className="text-[11px] text-gray-500">{p.ctxCargando ? "comprobando qué saldrá…" : "sin comprobar"}</span>
                : incluidos === 0 ? <Chip tono="ambar">Sin documentos incluidos</Chip>
                : cuenta && frasesCuenta(cuenta).map((f) => <Chip key={f.clase} tono={TONO_CLASE[f.clase]}>{f.texto}</Chip>)}
              {b.referencia.trim() && <span className="text-[11px] text-gray-500">· {b.referencia}</span>}
              {reqs.length > 0 && <span className="text-[11px] text-gray-500">· {reqs.length} requisito{reqs.length === 1 ? "" : "s"}</span>}
            </span>
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-1">
          <Casilla marcado={b.activo} disabled={!editable} cambiar={(v) => cambiar((x) => ({ ...x, activo: v }))} title="Si sale en el expediente">Activo</Casilla>
          {editable && (
            <>
              <BotonIcono title="Subir el bloque" disabled={k === 0} onClick={() => p.cambiarDoc((d) => conBloques(d, (bs) => moverPorId(bs, b.id, -1)))}>↑</BotonIcono>
              <BotonIcono title="Bajar el bloque" disabled={k === total - 1} onClick={() => p.cambiarDoc((d) => conBloques(d, (bs) => moverPorId(bs, b.id, 1)))}>↓</BotonIcono>
              <BotonIcono title={lleno30 ? `Tope de ${TOPES_DOC.maxBloquesExpediente} bloques` : "Duplicar el bloque"} disabled={lleno30} onClick={duplicar}>⧉</BotonIcono>
              <BotonIcono title="Quitar el bloque" peligro onClick={quitar}>✕</BotonIcono>
            </>
          )}
        </div>
      </div>

      {abierto && (
        <div className="space-y-4 border-t border-gray-100 p-3 sm:p-4">
          {/* ── Datos del separador ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Rotulo texto="Título" ayuda="«Sección II», «Anexo 3»…">
              <CampoTexto valor={b.titulo} maxLength={200} disabled={!editable} ariaLabel="Título del bloque" onCambio={(v) => cambiar((x) => ({ ...x, titulo: v }))} />
            </Rotulo>
            <Rotulo texto="Subtítulo" ayuda="Va en la banda de color: «Requisitos legales».">
              <CampoTexto valor={b.subtitulo} maxLength={200} disabled={!editable} ariaLabel="Subtítulo del bloque" onCambio={(v) => cambiar((x) => ({ ...x, subtitulo: v }))} />
            </Rotulo>
            <Rotulo texto="Referencia en las bases" ayuda="«Sección IV de las bases», «Numerales 5.1 y 5.2».">
              <CampoTexto valor={b.referencia} maxLength={300} disabled={!editable} ariaLabel="Referencia en las bases" onCambio={(v) => cambiar((x) => ({ ...x, referencia: v }))} />
            </Rotulo>
            <div className="flex items-end">
              <Casilla marcado={b.conPortada} disabled={!editable} cambiar={(v) => cambiar((x) => ({ ...x, conPortada: v }))}>
                Empieza con portada separadora
              </Casilla>
            </div>
          </div>

          {b.conPortada && <VistaSeparador p={p} resuelto={resuelto} activo={b.activo} hayResolucion={hayResolucion} />}

          {/* ── Requisitos que mandan su documento aquí ── */}
          {reqs.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Requisitos cuyo documento va en este bloque</p>
              <ul className="space-y-1">
                {reqs.map((q) => {
                  const ev = pr.evaluaciones.get(q.id);
                  const est = ev ? ETIQUETA_FINAL[ev.final] : null;
                  return (
                    <li key={q.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-700">
                      {q.numeral && <span className="font-semibold">{q.numeral}</span>}
                      <span className="min-w-0 flex-1 break-words">{q.texto.slice(0, 160)}{q.texto.length > 160 ? "…" : ""}</span>
                      {q.obligatorio && <Chip tono="gris">Obligatorio</Chip>}
                      {est && <span className="rounded border px-1.5 py-0.5 text-[11px] font-semibold" style={{ color: est.color, background: est.bg, borderColor: est.bd }}>{est.texto}</span>}
                      <button type="button" onClick={() => p.irA("bases", anclaDe("requisito", q.id))} className="text-[11px] font-semibold text-[#0b315f] underline">Ver en Bases</button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <HallazgosEnLinea hallazgos={pr.hallazgosDe(dom)} irA={p.irA} />

          {/* ── Documentos ── */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Documentos del bloque ({b.items.length})</p>
            {b.items.length === 0 ? (
              <Nota tono={b.activo ? "ambar" : "gris"}>Este bloque no tiene documentos{b.activo ? ": activo y vacío, saldría solo la portada." : "."}</Nota>
            ) : (
              <ol className="space-y-2">
                {b.items.map((i, n) => (
                  <FilaItem key={i.id} p={p} bloque={b} item={i} k={n} editable={editable} partes={pr.partesDe(i.id)}
                    resuelto={hayResolucion} hallazgos={pr.hallazgosDe(anclaDe("item", i.id))} otros={otros} />
                ))}
              </ol>
            )}
            {editable && (
              <div className="mt-2">
                <select aria-label="Agregar un documento al bloque" className={`${claseSelect} sm:w-auto`} value="" disabled={lleno}
                  onChange={(e) => { if (e.target.value) agregar(e.target.value as TipoFuente); }}>
                  <option value="">＋ Agregar un documento…</option>
                  {TIPOS_FUENTE.map((t) => <option key={t} value={t}>{ETIQUETA_FUENTE[t].titulo}</option>)}
                </select>
                {lleno && <p className="mt-1 text-xs text-amber-700">Este bloque llegó al tope de {TOPES_DOC.maxItemsBloque} documentos: pasa algunos a otro bloque o crea uno nuevo.</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** La portada separadora como saldrá (título, banda, referencia y «Contenido:»), desde el SeparadorResuelto. */
function VistaSeparador({ p, resuelto, activo, hayResolucion }: { p: PasoProps; resuelto: BloqueExpedienteResuelto | undefined; activo: boolean; hayResolucion: boolean }) {
  if (!activo) return null;
  if (!hayResolucion || !resuelto) return <p className="text-[11px] text-gray-500">{p.ctxCargando ? "Comprobando la portada separadora…" : "La portada separadora se enseña cuando se pueda leer el ERP."}</p>;
  const s = resuelto.separador;
  const color = /^#[0-9a-fA-F]{6}$/.test(p.doc.portada.color) ? p.doc.portada.color : "#0b315f";
  const titulo = s.titulo.trim(), sub = s.subtitulo.trim();
  const enBanda = sub || titulo, arriba = sub ? titulo : "";
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Así sale la portada separadora</p>
      <div className="mx-auto max-w-sm rounded-lg border border-gray-200 bg-white px-4 py-5 shadow-sm">
        {arriba && <p className="break-words text-center text-sm font-bold" style={{ color }}>{arriba}</p>}
        {enBanda
          ? <p className="mt-2 break-words rounded px-3 py-2 text-center text-sm font-bold text-white" style={{ background: color }}>{enBanda}</p>
          : <p className="mt-2 text-center text-xs text-amber-700">Sin título ni subtítulo: la portada saldrá sin banda.</p>}
        {s.referencia.trim() && <p className="mt-2 break-words text-center text-[11px] italic text-gray-500">{s.referencia}</p>}
        {s.contenido.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs font-bold" style={{ color }}>Contenido:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-gray-700">
              {s.contenido.map((c, n) => <li key={n} className="break-words">{c}</li>)}
            </ul>
          </div>
        ) : <p className="mt-3 text-[11px] text-gray-500">«Contenido:» vacío: no hay documentos incluidos.</p>}
      </div>
    </div>
  );
}
