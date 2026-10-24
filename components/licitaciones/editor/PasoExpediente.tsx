"use client";
// components/licitaciones/editor/PasoExpediente.tsx — Paso 4 «Expediente» del editor de /licitaciones/[id]:
// la estructura de ADJUNTOS que acompaña a la propuesta técnica (bloques separadores «Sección II —
// Requisitos legales», «Anexo 3 — Experiencia»… con sus documentos) y las opciones de FOLIADO.
//
// Sigue el contrato de contrato-editor.ts: el editor es el dueño del estado y del guardado; este paso solo
// propone cambios con `cambiarDoc` (inmutable, por id: ./expediente/acciones.ts) y nunca guarda.
//
// Qué SALE de cada bloque no se decide aquí: lo dice resolverExpediente (lib/licitaciones/expediente), el
// MISMO resolvedor que usa la emisión, y la pantalla solo lo lee (./expediente/partes.ts). Reglas:
//  · Tri-estado: sin contexto se dice «comprobando…»; una fuente que no se pudo leer es «no se pudo
//    leer», nunca «falta».
//  · Un enlace de Drive existe pero no se puede UNIR: ámbar, con el sitio donde se sube el PDF.
//  · Rehacer la estructura reemplaza los bloques (confirm que nombra cuántos) y no pierde lo SUBIDO.
import { useDeferredValue, useMemo, useState } from "react";
import { resolverExpediente } from "@/lib/licitaciones/expediente";
import { fechaRef } from "@/lib/licitaciones/texto";
import { TOPES_DOC, type BloqueExpedienteResuelto, type EvaluacionRequisito, type Hallazgo, type ParteFuente } from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "./contrato-editor";
import { useEditorExtra } from "./contexto-editor";
import HallazgosPaso from "./HallazgosPaso";
import { adjuntosConArchivo, aplicarSugerida, bloqueNuevo, conBloques, empezarEnBlanco, type ResumenSugerida } from "./expediente/acciones";
import { contarPartes, frasesCuenta, partesPorItem, sumarCuentas, TONO_CLASE } from "./expediente/partes";
import TarjetaBloque from "./expediente/TarjetaBloque";
import PanelFoliado from "./expediente/PanelFoliado";
import { Boton, Chip, claseSelect, Nota } from "./expediente/ui";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? "error inesperado"));
const CODIGOS_SIN_LUGAR = new Set(["requisito_sin_documento_en_expediente", "expediente_falta_obligatorio"]);

function fraseResumen(r: ResumenSugerida): string {
  const partes = [`${r.bloques} bloque${r.bloques === 1 ? "" : "s"} con ${r.items} documento${r.items === 1 ? "" : "s"}`];
  if (r.enlazados) partes.push(`${r.enlazados} requisito${r.enlazados === 1 ? "" : "s"} enlazado${r.enlazados === 1 ? "" : "s"} a su bloque`);
  if (r.adjuntosReubicados) partes.push(`${r.adjuntosReubicados} archivo${r.adjuntosReubicados === 1 ? "" : "s"} subido${r.adjuntosReubicados === 1 ? "" : "s"} en su ítem del mismo nombre`);
  if (r.adjuntosConservados) partes.push(`${r.adjuntosConservados} en «Adjuntos conservados»`);
  if (r.adjuntosSinSitio) partes.push(`${r.adjuntosSinSitio} archivo${r.adjuntosSinSitio === 1 ? "" : "s"} no cupo${r.adjuntosSinSitio === 1 ? "" : "ieron"} (siguen guardados en el ERP)`);
  return `Estructura armada: ${partes.join(" · ")}.`;
}

export default function PasoExpediente(p: PasoProps) {
  const { lic, doc, ctx, revision, soloLectura } = p;
  const editable = !soloLectura;
  const bloques = doc.expediente.bloques;
  const { ancla } = useEditorExtra();

  // ── Lo que saldrá: el MISMO resolvedor de la emisión, sobre una copia diferida (no frena la escritura) ──
  const licDif = useDeferredValue(lic);
  const res = useMemo<{ bloques: BloqueExpedienteResuelto[] | null; error: string | null }>(() => {
    if (!ctx) return { bloques: null, error: null };
    try {
      // fechaRef = presentación, o hoy si falta: la misma fecha de referencia que usa la revisión.
      return { bloques: resolverExpediente(licDif, ctx, { fechaReferencia: fechaRef(licDif, ctx) }).bloques, error: null };
    } catch (e) { return { bloques: null, error: msg(e) }; }
  }, [licDif, ctx]);
  const hayResolucion = !!res.bloques;
  const porItem = useMemo(() => partesPorItem(res.bloques ?? []), [res.bloques]);
  const porBloque = useMemo(() => new Map((res.bloques ?? []).map((b) => [b.id, b])), [res.bloques]);
  const cuentaTotal = useMemo(() => sumarCuentas((res.bloques ?? []).map((b) => contarPartes(b.partes))), [res.bloques]);

  // ── Hallazgos de este paso, por ancla (bloque o ítem) ──
  const porAncla = useMemo(() => {
    const m = new Map<string, Hallazgo[]>();
    for (const h of revision?.hallazgos ?? []) {
      if (!("paso" in h.donde) || h.donde.paso !== "expediente" || !h.donde.ancla) continue;
      const xs = m.get(h.donde.ancla);
      if (xs) xs.push(h); else m.set(h.donde.ancla, [h]);
    }
    return m;
  }, [revision]);
  const evaluaciones = useMemo(() => new Map<string, EvaluacionRequisito>((revision?.evaluaciones ?? []).map((e) => [e.requisitoId, e])), [revision]);
  const sinLugar = useMemo(() => {
    const vistos = new Set<string>();
    const out: { id: string; numeral: string | null; texto: string; obligatorio: boolean; motivo: string; bloqueId: string | null }[] = [];
    for (const h of revision?.hallazgos ?? []) {
      if (h.aceptado || !CODIGOS_SIN_LUGAR.has(h.codigo) || !h.requisitoId || vistos.has(h.requisitoId)) continue;
      const q = doc.requisitos.find((x) => x.id === h.requisitoId);
      if (!q) continue;
      vistos.add(q.id);
      out.push({ id: q.id, numeral: q.numeral, texto: q.texto, obligatorio: q.obligatorio, motivo: h.texto, bloqueId: q.bloqueExpedienteId });
    }
    return out;
  }, [revision, doc.requisitos]);

  // ── Bloques abiertos (con pocos, todos; una navegación a un bloque o a un ítem lo abre) ──
  const [abiertos, setAbiertos] = useState<Set<string>>(() => new Set(bloques.length <= 3 ? bloques.map((b) => b.id) : []));
  const [anclaVista, setAnclaVista] = useState<number | null>(null);
  if (ancla && ancla.n !== anclaVista) {
    setAnclaVista(ancla.n);
    const destino = bloques.find((b) => ancla.ids.includes(anclaDe("bloque_expediente", b.id)) || b.items.some((i) => ancla.ids.includes(anclaDe("item", i.id))));
    if (destino && !abiertos.has(destino.id)) setAbiertos((s) => new Set(s).add(destino.id));
  }
  const alternar = (id: string) => setAbiertos((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const abrir = (id: string) => setAbiertos((s) => new Set(s).add(id));

  // ── Acciones de estructura ──
  const armar = (rehacer: boolean) => {
    if (rehacer) {
      const items = bloques.reduce((a, b) => a + b.items.length, 0);
      const adj = adjuntosConArchivo(bloques);
      const nq = doc.requisitos.length;
      const segun = nq === 0 ? "la estructura completa de una propuesta (no hay requisitos cargados)" : `la estructura sugerida según ${nq === 1 ? "el requisito" : `los ${nq} requisitos`} de las bases`;
      const lineas = [
        `Se reemplazan ${bloques.length === 1 ? "el bloque actual" : `los ${bloques.length} bloques actuales`} (${items} documento${items === 1 ? "" : "s"}) por ${segun}.`,
        "Los requisitos se vuelven a enlazar a los bloques nuevos. El foliado no cambia.",
      ];
      if (adj) lineas.push(`Los ${adj} archivo${adj === 1 ? "" : "s"} que subiste no se pierden: van al ítem nuevo del mismo nombre o a un bloque «Adjuntos conservados».`);
      if (!window.confirm(`¿Rehacer la estructura del expediente?\n\n${lineas.join("\n\n")}`)) return;
    }
    const hecho: { r: ResumenSugerida | null; ids: string[] } = { r: null, ids: [] };
    p.cambiarDoc((d) => { const x = aplicarSugerida(d, p.nuevoId); hecho.r = x.resumen; hecho.ids = x.doc.expediente.bloques.map((b) => b.id); return x.doc; });
    setAbiertos(new Set(hecho.ids.length <= 3 ? hecho.ids : []));
    if (hecho.r?.bloques === 0) p.aviso("La estructura sugerida salió vacía: ningún requisito pide documentos que adjuntar (legales, unidades, conductores, seguros, experiencia o declaraciones). Usa «Empezar en blanco».", "aviso");
    else if (hecho.r) p.aviso(fraseResumen(hecho.r));
  };
  const enBlanco = () => {
    const hecho: { id: string | null } = { id: null };
    p.cambiarDoc((d) => { const x = empezarEnBlanco(d, p.nuevoId); hecho.id = x.expediente.bloques[0]?.id ?? null; return x; });
    if (hecho.id) abrir(hecho.id);
  };
  const agregarBloque = () => {
    const hecho: { id: string | null } = { id: null };
    p.cambiarDoc((d) => {
      if (d.expediente.bloques.length >= TOPES_DOC.maxBloquesExpediente) return d;
      const b = bloqueNuevo(p.nuevoId, d.expediente.bloques.length + 1);
      hecho.id = b.id;
      return conBloques(d, (bs) => [...bs, b]);
    });
    const id = hecho.id;
    if (id) {
      abrir(id);
      requestAnimationFrame(() => document.getElementById(anclaDe("bloque_expediente", id))?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };
  const enlazar = (requisitoId: string, bloqueId: string) => {
    p.cambiarDoc((d) => ({ ...d, requisitos: d.requisitos.map((q) => (q.id === requisitoId ? { ...q, bloqueExpedienteId: bloqueId || null } : q)) }));
  };

  const partesDe = (itemId: string): ParteFuente[] | undefined => (hayResolucion ? porItem.get(itemId) ?? [] : undefined);
  const hallazgosDe = (a: string) => porAncla.get(a) ?? [];
  const activos = bloques.filter((b) => b.activo).length;
  const tope = bloques.length >= TOPES_DOC.maxBloquesExpediente;
  const lecturasCaidas = cuentaTotal.no_leido > 0;

  return (
    <div className="space-y-4">
      {/* ── Qué es y qué saldrá ── */}
      <div className="space-y-2 rounded-2xl border border-gray-200 bg-white p-3 sm:p-4">
        <p className="text-xs text-gray-700">
          Los <b>adjuntos</b> que acompañan a la propuesta técnica. Cada bloque es un PDF que empieza con su <b>portada separadora</b>
          («Sección II — Requisitos legales», «Anexo 3 — Experiencia»…) y sigue con sus documentos. El expediente se arma al emitir, en el paso 5, desde una computadora.
        </p>
        {bloques.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-700">{activos} de {bloques.length} bloque{bloques.length === 1 ? "" : "s"} activo{activos === 1 ? "" : "s"} · saldrá:</span>
            {!ctx ? <span className="text-xs text-gray-500">{p.ctxCargando ? "comprobando…" : "sin comprobar"}</span>
              : res.error ? <Chip tono="ambar">no se pudo calcular</Chip>
              : frasesCuenta(cuentaTotal).length === 0 ? <Chip tono="ambar">nada todavía</Chip>
              : frasesCuenta(cuentaTotal).map((f) => <Chip key={f.clase} tono={TONO_CLASE[f.clase]}>{f.texto}</Chip>)}
            <Boton chico tono="suave" onClick={p.recargarCtx} disabled={p.ctxCargando} title="Tras subir un documento en otra pestaña (legajo, unidades, seguros…)">
              {p.ctxCargando ? "Comprobando…" : "↻ Volver a leer del ERP"}
            </Boton>
          </div>
        )}
        {res.error && <Nota tono="ambar">No se pudo calcular qué saldrá en el expediente ({res.error}). Los bloques se pueden editar igual; avisa a soporte con este detalle.</Nota>}
        {cuentaTotal.externo > 0 && (
          <Nota tono="ambar">
            {cuentaTotal.externo === 1 ? "Un documento es un enlace" : `${cuentaTotal.externo} documentos son enlaces`} de Google Drive u otra web: no se {cuentaTotal.externo === 1 ? "puede" : "pueden"} unir al PDF y se omitirá{cuentaTotal.externo === 1 ? "" : "n"} al emitir.
            Sube el PDF en su ficha (Recursos → Unidades, Legajo, Seguros…); cada uno dice dónde.
          </Nota>
        )}
        {lecturasCaidas && <Nota tono="gris">Una parte del ERP no se pudo leer: de ella no se afirma que falte nada. Pulsa «Volver a leer del ERP» para reintentar.</Nota>}
      </div>

      {/* ── Requisitos cuyo documento no tiene dónde ir ── */}
      {sinLugar.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50/50 p-3 sm:p-4">
          <p className="text-sm font-bold text-amber-900">
            {sinLugar.length === 1 ? "1 requisito no tiene" : `${sinLugar.length} requisitos no tienen`} dónde ir en el expediente
          </p>
          <ul className="space-y-1.5">
            {sinLugar.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-white px-2.5 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-gray-800">
                    {q.numeral && <b>{q.numeral} · </b>}{q.texto.slice(0, 160)}{q.texto.length > 160 ? "…" : ""}
                    {q.obligatorio && <span className="ml-1"><Chip tono="rojo">Obligatorio</Chip></span>}
                  </p>
                  <p className="mt-0.5 text-amber-800">{q.motivo}</p>
                </div>
                {editable && bloques.length > 0 && (
                  <select aria-label="Bloque donde va su documento" className={`${claseSelect} sm:w-56`}
                    value={q.bloqueId && bloques.some((b) => b.id === q.bloqueId) ? q.bloqueId : ""}
                    onChange={(e) => enlazar(q.id, e.target.value)}>
                    <option value="">Elegir el bloque…</option>
                    {bloques.map((b) => <option key={b.id} value={b.id}>{[b.titulo, b.subtitulo].filter((x) => x.trim()).join(" — ") || "Bloque sin título"}{b.activo ? "" : " (desactivado)"}</option>)}
                  </select>
                )}
                <button type="button" onClick={() => p.irA("bases", anclaDe("requisito", q.id))} className="text-[11px] font-semibold text-[#0b315f] underline">Ver en Bases</button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-amber-800">Elegir el bloque enlaza el requisito; su documento hay que agregarlo dentro del bloque si todavía no está.</p>
        </div>
      )}

      <HallazgosPaso id="hallazgos-expediente" revision={revision} ctxCargando={p.ctxCargando} paso="expediente" irA={p.irA} />

      {/* ── Bloques ── */}
      <section id="expediente" className="scroll-mt-24 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-[#0b315f]">Bloques del expediente</h2>
          {bloques.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Boton chico tono="suave" onClick={() => setAbiertos(new Set(bloques.map((b) => b.id)))}>Abrir todos</Boton>
              <Boton chico tono="suave" onClick={() => setAbiertos(new Set())}>Cerrar todos</Boton>
              {editable && <Boton chico onClick={() => armar(true)} title="Reemplaza los bloques por la estructura sugerida según los requisitos">Rehacer la estructura sugerida</Boton>}
            </div>
          )}
        </div>

        {bloques.length === 0 ? (
          <div className="space-y-3 rounded-2xl border border-dashed border-gray-300 bg-white p-4 sm:p-6">
            {soloLectura ? (
              <p className="text-sm text-gray-600">Esta licitación no tiene estructura de expediente.</p>
            ) : (
              <>
                <p className="text-sm text-gray-700">
                  Todavía no hay bloques. La estructura sugerida se arma con las categorías y reglas de los{" "}
                  <b>{doc.requisitos.length} requisito{doc.requisitos.length === 1 ? "" : "s"}</b> de las bases
                  {doc.requisitos.length === 0 ? " (sin requisitos, la estructura completa de una propuesta: Sección I a VIII y documentos complementarios)" : ""},
                  y enlaza cada requisito con el bloque de su documento. Después se edita todo.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Boton tono="primario" onClick={() => armar(false)}>Armar la estructura sugerida</Boton>
                  <Boton onClick={enBlanco}>Empezar en blanco</Boton>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            {bloques.map((b, k) => (
              <TarjetaBloque key={b.id} p={p} bloque={b} k={k} total={bloques.length} editable={editable}
                abierto={abiertos.has(b.id)} alternar={() => alternar(b.id)} abrir={abrir}
                resuelto={porBloque.get(b.id)} hayResolucion={hayResolucion} partesDe={partesDe} hallazgosDe={hallazgosDe}
                evaluaciones={evaluaciones} todos={bloques} />
            ))}
            {editable && (
              <div>
                <Boton onClick={agregarBloque} disabled={tope}>＋ Agregar un bloque</Boton>
                {tope && <p className="mt-1 text-xs text-amber-700">El expediente llegó al tope de {TOPES_DOC.maxBloquesExpediente} bloques: junta documentos en un bloque existente o quita uno.</p>}
              </div>
            )}
          </>
        )}
      </section>

      <PanelFoliado p={p} />
    </div>
  );
}
