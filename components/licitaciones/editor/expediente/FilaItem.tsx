"use client";
// components/licitaciones/editor/expediente/FilaItem.tsx — Un ítem de un bloque del expediente: si se
// incluye, su título en el «Contenido» de la portada separadora, su fuente, lo que saldrá y sus hallazgos.
//
// El título es opcional: vacío, el separador usa etiquetaItem (la misma función del motor), y eso es lo
// que se enseña de marcador para que se vea qué dirá sin escribir nada.
import { etiquetaItem } from "@/lib/licitaciones/expediente";
import { LIMITES_TEXTO } from "@/lib/licitaciones/normalizar";
import { TOPES_DOC, type BloqueExpediente, type FuenteItem, type Hallazgo, type ItemExpediente, type ParteFuente } from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "../contrato-editor";
import { conItem, ETIQUETA_FUENTE, moverItemABloque, moverPorId, conBloque, quitarItem } from "./acciones";
import EditorFuente from "./EditorFuente";
import PartesItem from "./PartesItem";
import { BotonIcono, CampoTexto, Casilla, Chip, claseSelectChico } from "./ui";
import { HallazgosEnLinea } from "./HallazgosEnLinea";

type Props = {
  p: PasoProps;
  bloque: BloqueExpediente;
  item: ItemExpediente;
  k: number;
  editable: boolean;
  partes: ParteFuente[] | undefined;
  resuelto: boolean;
  hallazgos: Hallazgo[];
  /** Los demás bloques, para «Mover a…». */
  otros: BloqueExpediente[];
};

export default function FilaItem({ p, bloque, item, k, editable, partes, resuelto, hallazgos, otros }: Props) {
  const tituloBloque = [bloque.titulo, bloque.subtitulo].filter((x) => x.trim()).join(" — ") || "Bloque sin título";
  const sugerido = etiquetaItem({ ...item, titulo: null }, p.lic);
  const e = ETIQUETA_FUENTE[item.fuente.tipo];
  const cambiar = (fn: (i: ItemExpediente) => ItemExpediente) => p.cambiarDoc((d) => conItem(d, item.id, fn));
  const cambiarFuente = (f: FuenteItem) => cambiar((i) => ({ ...i, fuente: f }));

  const quitar = () => {
    const f = item.fuente;
    const nombre = item.titulo?.trim() || sugerido;
    if (f.tipo === "adjunto" && f.archivo
      && !window.confirm(`¿Quitar «${nombre}» de «${tituloBloque}»?\n\nTiene subido «${f.archivo.nombre}»: el archivo sigue guardado en el ERP, pero deja de estar en el expediente.`)) return;
    p.cambiarDoc((d) => quitarItem(d, item.id));
  };

  const mover = (destinoId: string) => {
    const destino = otros.find((b) => b.id === destinoId);
    if (!destino) return;
    p.cambiarDoc((d) => moverItemABloque(d, item.id, destinoId));
    p.aviso(`«${item.titulo?.trim() || sugerido}» pasó a «${[destino.titulo, destino.subtitulo].filter((x) => x.trim()).join(" — ") || "otro bloque"}».`);
  };

  // Los hallazgos del ítem que NO repiten lo que ya dice la lista de lo que no sale.
  const codigosFaltantes = new Set((partes ?? []).filter((x) => x.tipo === "faltante").map((x) => (x as Extract<ParteFuente, { tipo: "faltante" }>).codigo));
  const propios = hallazgos.filter((h) => !codigosFaltantes.has(h.codigo));

  return (
    <li id={anclaDe("item", item.id)} className={`scroll-mt-24 rounded-xl border p-2.5 sm:p-3 ${item.incluido ? "border-gray-200 bg-white" : "border-dashed border-gray-300 bg-gray-50"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <Casilla marcado={item.incluido} disabled={!editable} cambiar={(v) => cambiar((i) => ({ ...i, incluido: v }))}
            title={item.incluido ? "Se incluye en el expediente" : "No se incluye"}>
            <span className="font-semibold text-gray-800">{k + 1}.</span>
          </Casilla>
          <Chip tono={e.generada ? "azul" : "gris"} title={e.ayuda}>{e.titulo}</Chip>
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-1">
            <BotonIcono title="Subir un puesto" disabled={k === 0} onClick={() => p.cambiarDoc((d) => conBloque(d, bloque.id, (b) => ({ ...b, items: moverPorId(b.items, item.id, -1) })))}>↑</BotonIcono>
            <BotonIcono title="Bajar un puesto" disabled={k === bloque.items.length - 1} onClick={() => p.cambiarDoc((d) => conBloque(d, bloque.id, (b) => ({ ...b, items: moverPorId(b.items, item.id, 1) })))}>↓</BotonIcono>
            {otros.length > 0 && (
              <select aria-label="Mover a otro bloque" className={claseSelectChico} value=""
                onChange={(ev) => { if (ev.target.value) mover(ev.target.value); }}>
                <option value="">Mover a…</option>
                {otros.map((b) => {
                  const lleno = b.items.length >= TOPES_DOC.maxItemsBloque;
                  return <option key={b.id} value={b.id} disabled={lleno}>{[b.titulo, b.subtitulo].filter((x) => x.trim()).join(" — ") || "Bloque sin título"}{lleno ? " (lleno)" : ""}</option>;
                })}
              </select>
            )}
            <BotonIcono title="Quitar del bloque" peligro onClick={quitar}>✕</BotonIcono>
          </div>
        )}
      </div>

      <div className="mt-2 space-y-2">
        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">Cómo se nombra en la portada separadora</span>
          {editable ? (
            <CampoTexto valor={item.titulo ?? ""} placeholder={sugerido} maxLength={LIMITES_TEXTO.titulo} ariaLabel="Título del documento en la portada separadora"
              onCambio={(v) => cambiar((i) => ({ ...i, titulo: v === "" ? null : v }))} />
          ) : (
            <p className="text-sm text-gray-800">{item.titulo?.trim() || sugerido}</p>
          )}
          {editable && !item.titulo?.trim() && <p className="mt-0.5 text-[11px] text-gray-400">Vacío: dice «{sugerido}».</p>}
        </div>
        <EditorFuente p={p} item={item} bloqueTitulo={tituloBloque} editable={editable} cambiarFuente={cambiarFuente} />
        <PartesItem p={p} item={item} partes={partes} bloqueActivo={bloque.activo} resuelto={resuelto} />
        {propios.length > 0 && <HallazgosEnLinea hallazgos={propios} irA={p.irA} />}
      </div>
    </li>
  );
}
