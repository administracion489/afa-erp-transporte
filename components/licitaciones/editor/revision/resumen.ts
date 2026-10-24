// components/licitaciones/editor/revision/resumen.ts — Cálculos de PANTALLA del paso «Revisión y
// emisión» (PUROS: sin base, sin red, sin window). No deciden nada del negocio: los hallazgos los da
// lib/licitaciones/revision.ts y lo que se imprime lo dan los resolvedores; aquí solo se agrupa, se
// filtra y se rotula para enseñarlo.
import type {
  DocLicitacion, DocumentoResuelto, ExpedienteResuelto, Gravedad, Hallazgo, Paso, Revision, RevisionArchivo,
} from "@/lib/licitaciones/tipos";
import { PASOS } from "@/lib/licitaciones/tipos";

// ══ Grupos de hallazgos ═════════════════════════════════════════════════════════

/** Dónde se corrige: un paso del editor, o «fuera» (otra pantalla del ERP: Docs. Vehiculares, Legajo…). */
export type GrupoHallazgo = Paso | "fuera";
export const GRUPOS: readonly GrupoHallazgo[] = [...PASOS, "fuera"];
export const grupoDe = (h: Hallazgo): GrupoHallazgo => ("paso" in h.donde ? h.donde.paso : "fuera");

/** `fuente_no_leida` va aparte y arriba: sin esos datos el resto de la revisión no es de fiar. */
export const esFuenteNoLeida = (h: Hallazgo) => h.codigo === "fuente_no_leida";

/** Se acepta con nota todo hallazgo del contenido. `fuente_no_leida` no: es una lectura que falló (D8),
 *  no algo que se presente; se arregla volviendo a leer. */
export const aceptable = (h: Hallazgo) => !esFuenteNoLeida(h);

export type FiltroHallazgos = { gravedad: Record<Gravedad, boolean>; grupo: GrupoHallazgo | "todos"; verAceptados: boolean };
export const FILTRO_INICIAL: FiltroHallazgos = { gravedad: { alarma: true, aviso: true, info: true }, grupo: "todos", verAceptados: true };

/** Los hallazgos que se listan (sin `fuente_no_leida`, que va aparte), agrupados por dónde se corrigen,
 *  conservando el orden del motor (gravedad → paso → aparición). */
export function agrupar(rev: Revision, f: FiltroHallazgos): { grupo: GrupoHallazgo; hallazgos: Hallazgo[] }[] {
  const out = new Map<GrupoHallazgo, Hallazgo[]>();
  for (const h of rev.hallazgos) {
    if (esFuenteNoLeida(h)) continue;
    if (!f.gravedad[h.gravedad]) continue;
    if (h.aceptado && !f.verAceptados) continue;
    const g = grupoDe(h);
    if (f.grupo !== "todos" && f.grupo !== g) continue;
    out.set(g, [...(out.get(g) ?? []), h]);
  }
  return GRUPOS.filter((g) => out.has(g)).map((g) => ({ grupo: g, hallazgos: out.get(g)! }));
}

export type Conteo = { abiertos: Record<Gravedad, number>; aceptados: number; fuentes: number };
export function contar(rev: Revision): Conteo {
  const abiertos: Record<Gravedad, number> = { alarma: 0, aviso: 0, info: 0 };
  let aceptados = 0, fuentes = 0;
  for (const h of rev.hallazgos) {
    if (esFuenteNoLeida(h)) { fuentes++; continue; }
    if (h.aceptado) aceptados++; else abiertos[h.gravedad]++;
  }
  return { abiertos, aceptados, fuentes };
}

/** Cuántos de cada grupo (con los filtros de gravedad y aceptados, sin el de grupo): para el desplegable. */
export function cuentaPorGrupo(rev: Revision, f: FiltroHallazgos): Record<GrupoHallazgo, number> {
  const o = Object.fromEntries(GRUPOS.map((g) => [g, 0])) as Record<GrupoHallazgo, number>;
  for (const h of rev.hallazgos) {
    if (esFuenteNoLeida(h) || !f.gravedad[h.gravedad] || (h.aceptado && !f.verAceptados)) continue;
    o[grupoDe(h)]++;
  }
  return o;
}

/** Aceptaciones guardadas cuyo hallazgo la revisión ya no da (se resolvió, o su fuente no se leyó). */
export function aceptacionesSinHallazgo(doc: DocLicitacion, rev: Revision): DocLicitacion["aceptados"] {
  const vivas = new Set(rev.hallazgos.map((h) => h.clave));
  return doc.aceptados.filter((a) => !vivas.has(a.clave));
}

/** Los abiertos que una emisión registra como NO aceptados (los que el resumen pide confirmar). */
export function abiertosParaEmitir(rev: Revision): Hallazgo[] {
  return rev.hallazgos.filter((h) => !h.aceptado && (h.gravedad === "alarma" || h.gravedad === "aviso"));
}

// ══ Comprobación de archivos: qué es cada URL ════════════════════════════════════

export type UsoArchivo = { titulo: string; donde: string; usos: number };

/** Rótulo de cada URL que la emisión usaría (la MISMA lista que recorre comprobarArchivos). */
export function etiquetasDeArchivos(exp: ExpedienteResuelto, doc: DocumentoResuelto, logo: string | null): Record<string, UsoArchivo> {
  const out: Record<string, UsoArchivo> = {};
  const add = (url: string | null | undefined, titulo: string, donde: string) => {
    const u = String(url ?? "").trim();
    if (!u) return;
    const prev = out[u];
    if (prev) prev.usos++;
    else out[u] = { titulo, donde, usos: 1 };
  };
  if (doc.portada?.modo === "imagen") add(doc.portada.imagenUrl, "Imagen de la portada", "Propuesta técnica");
  for (const s of doc.secciones ?? []) {
    for (const b of s.bloques ?? []) if (b.tipo === "imagen") add(b.url, b.pie ? `Imagen · ${b.pie}` : "Imagen", `Propuesta · ${[s.numero, s.titulo].filter(Boolean).join(" ") || "sección"}`);
  }
  add(doc.firmante?.firmaUrl, "Firma del representante", "Propuesta técnica");
  for (const b of exp.bloques ?? []) {
    const nb = [b.separador?.titulo, b.separador?.subtitulo].filter((x) => String(x ?? "").trim()).join(" · ") || "Bloque";
    for (const p of b.partes ?? []) {
      if (p.tipo === "archivo") add(p.url, p.titulo, `${nb} · ${p.etiquetaFuente}`);
      else if (p.tipo === "ficha_unidad") {
        add(p.ficha.fotoExternaUrl, `Foto exterior · ${p.ficha.codigo || ""} ${p.ficha.placa}`.replace(/\s+/g, " ").trim(), `${nb} · ficha técnica`);
        add(p.ficha.fotoInternaUrl, `Foto interior · ${p.ficha.codigo || ""} ${p.ficha.placa}`.replace(/\s+/g, " ").trim(), `${nb} · ficha técnica`);
      } else if (p.tipo === "cuadro_experiencia") add(p.cuadro.firmante?.firmaUrl, "Firma (cuadro de experiencia)", nb);
    }
  }
  if (logo) add(logo, "Logo de la empresa", "Cabecera de los PDF");
  return out;
}

export type FilaComprobacion = { url: string; uso: UsoArchivo | null; r: RevisionArchivo };

/** Los resultados con su rótulo: primero los que tienen problema. */
export function filasComprobacion(rev: Record<string, RevisionArchivo>, usos: Record<string, UsoArchivo>): FilaComprobacion[] {
  return Object.values(rev)
    .map((r) => ({ url: r.url, uso: usos[r.url] ?? null, r }))
    .sort((a, b) => Number(a.r.ok) - Number(b.r.ok) || (a.uso?.donde ?? "").localeCompare(b.uso?.donde ?? "", "es") || (a.uso?.titulo ?? "").localeCompare(b.uso?.titulo ?? "", "es"));
}

/** Firma de lo que define QUÉ archivos usa la emisión (para decir si la comprobación quedó vieja). */
export function firmaArchivos(doc: DocLicitacion): string {
  const imagenes = doc.secciones.flatMap((s) => (s.activa ? s.bloques : []).flatMap((b) => (b.tipo === "imagen" && b.archivo ? [b.archivo.url] : [])));
  return JSON.stringify([
    doc.expediente.bloques, doc.unidades.map((u) => [u.clave, u.rol]), doc.conductores.map((c) => [c.clave, c.rol]),
    doc.experiencia.ids, doc.portada.modo, doc.portada.imagen?.url ?? null, doc.representante.firma?.url ?? null, imagenes,
  ]);
}

// ══ Resumen del expediente antes de emitir ══════════════════════════════════════

export type ResumenExpediente = {
  bloques: number;
  portadas: number;
  /** Hojas que arma el ERP (fichas de unidad, cuadros de experiencia, tablas): ~1 página cada una. */
  generadas: number;
  archivos: number;
  /** De los archivos, cuántos ya tienen su número de páginas conocido (por la comprobación). */
  archivosConPaginas: number;
  /** De los archivos, cuántos la comprobación ya dijo que no se pueden unir (cuentan también en `omitidas`). */
  archivosFallidos: number;
  paginasConocidas: number;
  /** Partes que se omitirán seguro (sin archivo unible): se nombran al emitir. */
  omitidas: number;
  /** Bloques que llevan la propuesta técnica dentro. */
  conPropuesta: number;
  /** Lo que suman los archivos ya comprobados (únicos). */
  bytesConocidos: number;
};

/** Cuántas partes y páginas, aproximado (la propuesta se cuenta al armarla; un archivo sin comprobar, al bajarlo). */
export function resumenExpediente(exp: ExpedienteResuelto, revisiones: Record<string, RevisionArchivo> | null): ResumenExpediente {
  const r: ResumenExpediente = { bloques: 0, portadas: 0, generadas: 0, archivos: 0, archivosConPaginas: 0, archivosFallidos: 0, paginasConocidas: 0, omitidas: 0, conPropuesta: 0, bytesConocidos: 0 };
  const vistos = new Set<string>();
  for (const b of exp.bloques ?? []) {
    r.bloques++;
    if (b.conPortada) { r.portadas++; r.paginasConocidas++; }
    if ((b.partes ?? []).some((p) => p.tipo === "propuesta")) r.conPropuesta++;
    for (const p of b.partes ?? []) {
      if (p.tipo === "faltante") { r.omitidas++; continue; }
      if (p.tipo === "ficha_unidad" || p.tipo === "cuadro_experiencia" || p.tipo === "tabla") { r.generadas++; r.paginasConocidas++; continue; }
      if (p.tipo !== "archivo") continue;
      r.archivos++;
      const rv = revisiones?.[p.url];
      if (rv && !rv.ok) { r.omitidas++; r.archivosFallidos++; continue; }
      if (rv?.ok) {
        r.archivosConPaginas++;
        r.paginasConocidas += rv.formato === "pdf" ? Math.max(1, rv.paginas ?? 1) : 1;
        if (!vistos.has(p.url)) { vistos.add(p.url); r.bytesConocidos += rv.bytes; }
      }
    }
  }
  return r;
}
