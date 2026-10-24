"use client";
// components/licitaciones/editor/revision/ui.tsx — Piezas de pantalla del paso «Revisión y emisión».
// No deciden nada: rótulos, cajas y la barra de progreso.
import type { ReactNode } from "react";
import type { FaseEmision, Gravedad, RevisionArchivo, TipoArchivoEmitido } from "@/lib/licitaciones/tipos";

export type Tono = "rojo" | "ambar" | "verde" | "gris" | "azul";
const TONO: Record<Tono, string> = {
  rojo: "bg-red-50 text-red-800 border-red-200",
  ambar: "bg-amber-50 text-amber-900 border-amber-200",
  verde: "bg-emerald-50 text-emerald-800 border-emerald-200",
  gris: "bg-gray-50 text-gray-600 border-gray-200",
  azul: "bg-[#eef3f8] text-[#0b315f] border-[#d5e0ec]",
};
export const tonoDeGravedad = (g: Gravedad): Tono => (g === "alarma" ? "rojo" : g === "aviso" ? "ambar" : "azul");

export function Chip({ tono, children, title }: { tono: Tono; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONO[tono]}`}>
      {children}
    </span>
  );
}

/** Caja fija (no un toast): rojo = hay que actuar; ámbar = cambia lo que hace el sistema; gris/azul = informa. */
export function Nota({ tono, children }: { tono: Tono; children: ReactNode }) {
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${TONO[tono]}`}>{children}</div>;
}

export function Seccion({ id, titulo, subtitulo, acciones, children }: {
  id?: string; titulo: string; subtitulo?: ReactNode; acciones?: ReactNode; children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 rounded-2xl border border-gray-200 bg-white p-3 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-[#0b315f]">{titulo}</h2>
          {subtitulo && <div className="mt-0.5 text-xs text-gray-500">{subtitulo}</div>}
        </div>
        {acciones && <div className="flex flex-wrap items-center gap-2">{acciones}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Barra de avance. Con total 0 (todavía no se sabe cuánto), una barra indeterminada. */
export function Barra({ hecho, total }: { hecho: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((hecho / total) * 100)) : null;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      {pct == null
        ? <div className="h-full w-1/3 animate-pulse rounded-full bg-[#0b315f]/60" />
        : <div className="h-full rounded-full bg-[#0b315f] transition-[width] duration-300" style={{ width: `${pct}%` }} />}
    </div>
  );
}

export const BOTON = "inline-flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed";
export const BOTON_PRIMARIO = `${BOTON} bg-[#0b315f] text-white hover:opacity-90`;
export const BOTON_SECUNDARIO = `${BOTON} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`;

export const ETIQUETA_FASE: Record<FaseEmision, string> = {
  comprobando: "Preparando y comprobando",
  bajando: "Bajando los archivos",
  armando_propuesta: "Armando la propuesta técnica",
  armando_bloques: "Armando los bloques del expediente",
  foliando: "Foliando",
  empacando: "Empacando",
  subiendo: "Subiendo las copias al ERP",
  registrando: "Registrando la emisión",
  listo: "Listo",
};
/** El orden en que se enseñan (la propuesta se vuelve a armar con los folios: puede reaparecer). */
export const ORDEN_FASES: readonly FaseEmision[] = ["comprobando", "bajando", "armando_propuesta", "armando_bloques", "foliando", "empacando", "subiendo", "registrando", "listo"];

export const ETIQUETA_TIPO_ARCHIVO: Record<TipoArchivoEmitido, string> = {
  propuesta: "Propuesta técnica", bloque: "Bloque del expediente", expediente_completo: "Expediente completo", zip: "ZIP",
};

export const ETIQUETA_PROBLEMA_ARCHIVO: Record<Extract<RevisionArchivo, { ok: false }>["codigo"], string> = {
  pdf_protegido: "PDF protegido con contraseña",
  pdf_ilegible: "PDF dañado o ilegible",
  archivo_formato_no_soportado: "Formato que el expediente no une",
  archivo_no_descargable: "No se pudo descargar",
  archivo_demasiado_grande: "Demasiado grande",
  archivo_externo: "Enlace externo (Drive u otro sitio)",
};

export const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
