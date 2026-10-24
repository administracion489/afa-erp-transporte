// components/licitaciones/editor/expediente/partes.ts — Cómo se LEE en pantalla lo que resolverExpediente
// dice que sale. PURO. No decide qué sale ni por qué falta: el motivo es el `codigo` que puso el motor, y
// aquí solo se elige la palabra, el color y el sitio donde se arregla.
//
//  · Tri-estado: una parte `faltante` con `fuente_no_leida` NO es una falta — es «no se pudo leer» (gris).
//  · Un enlace externo (Drive u otra web) existe pero no se puede UNIR: ámbar, distinto de «falta» (rojo).
import { CATALOGO_HALLAZGOS } from "@/lib/licitaciones/revision";
import type { BloqueExpedienteResuelto, CodigoHallazgo, FuenteItem, ParteFuente, Paso } from "@/lib/licitaciones/tipos";

export type ClaseParte = "archivo" | "generada" | "propuesta" | "falta" | "externo" | "no_leido";

const EXTERNOS: readonly CodigoHallazgo[] = ["expediente_item_archivo_externo", "unidad_doc_archivo_externo"];

export function claseParte(p: ParteFuente): ClaseParte {
  switch (p.tipo) {
    case "archivo": return "archivo";
    case "ficha_unidad": case "cuadro_experiencia": case "tabla": return "generada";
    case "propuesta": return "propuesta";
    case "faltante":
      if (p.codigo === "fuente_no_leida") return "no_leido";
      return EXTERNOS.includes(p.codigo) ? "externo" : "falta";
  }
}

export type Cuenta = Record<ClaseParte, number>;
export const cuentaVacia = (): Cuenta => ({ archivo: 0, generada: 0, propuesta: 0, falta: 0, externo: 0, no_leido: 0 });

export function contarPartes(partes: readonly ParteFuente[]): Cuenta {
  const c = cuentaVacia();
  for (const p of partes) c[claseParte(p)]++;
  return c;
}

export function sumarCuentas(cs: readonly Cuenta[]): Cuenta {
  const t = cuentaVacia();
  for (const c of cs) for (const k of Object.keys(t) as ClaseParte[]) t[k] += c[k];
  return t;
}

const pl = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** «12 documentos · 2 hojas del ERP · 2 faltan · 1 enlace externo · 1 no se pudo leer» (solo lo que hay). */
export function frasesCuenta(c: Cuenta): { texto: string; clase: ClaseParte }[] {
  const out: { texto: string; clase: ClaseParte }[] = [];
  if (c.archivo) out.push({ clase: "archivo", texto: pl(c.archivo, "documento", "documentos") });
  if (c.generada) out.push({ clase: "generada", texto: pl(c.generada, "hoja del ERP", "hojas del ERP") });
  if (c.propuesta) out.push({ clase: "propuesta", texto: "la propuesta técnica" });
  if (c.falta) out.push({ clase: "falta", texto: c.falta === 1 ? "1 falta" : `${c.falta} faltan` });
  if (c.externo) out.push({ clase: "externo", texto: c.externo === 1 ? "1 es un enlace externo (no se puede unir)" : `${c.externo} son enlaces externos (no se pueden unir)` });
  if (c.no_leido) out.push({ clase: "no_leido", texto: c.no_leido === 1 ? "1 no se pudo leer" : `${c.no_leido} no se pudieron leer` });
  return out;
}

/** Las partes de cada ítem, por id (un ítem de unidades da una por unidad; fotos, dos). */
export function partesPorItem(bloques: readonly BloqueExpedienteResuelto[]): Map<string, ParteFuente[]> {
  const m = new Map<string, ParteFuente[]>();
  for (const b of bloques) for (const p of b.partes) {
    const xs = m.get(p.itemId);
    if (xs) xs.push(p); else m.set(p.itemId, [p]);
  }
  return m;
}

/** El motivo de una parte que no sale, en una frase (el título del catálogo de la revisión). */
export function motivoFaltante(codigo: CodigoHallazgo): string {
  if (codigo === "fuente_no_leida") return "No se pudo leer del ERP: no se afirma que falte.";
  if (EXTERNOS.includes(codigo)) return "Es un enlace externo (Drive u otra web): no se puede unir al PDF. Sube el PDF en su ficha.";
  return CATALOGO_HALLAZGOS[codigo]?.titulo ?? "No se puede adjuntar.";
}

export type Arreglo =
  | { tipo: "paso"; paso: Paso; ancla: string; etiqueta: string }
  | { tipo: "ruta"; ruta: string; etiqueta: string }
  | { tipo: "aqui"; etiqueta: string }
  | { tipo: "releer"; etiqueta: string };

/**
 * Dónde se arregla una parte que no sale. Lo decide la FUENTE del ítem (de dónde viene el archivo), no el
 * código solo: un enlace de Drive en el legajo se arregla en el legajo y uno de una unidad en su ficha.
 */
export function arregloDe(f: FuenteItem, codigo: CodigoHallazgo): Arreglo | null {
  if (codigo === "fuente_no_leida") return { tipo: "releer", etiqueta: "Volver a leer del ERP" };
  switch (f.tipo) {
    case "legajo": return { tipo: "ruta", ruta: "/licitaciones?tab=legajo", etiqueta: "Legajo de la empresa" };
    case "docs_unidades": case "fotos_unidades": case "fichas_unidades":
      return { tipo: "paso", paso: "recursos", ancla: "unidades", etiqueta: codigo === "unidad_sin_fotos" ? "Recursos → Unidades (fotos)" : "Recursos → Unidades (subir el PDF)" };
    case "docs_conductores": return { tipo: "paso", paso: "recursos", ancla: "conductores", etiqueta: "Recursos → Conductores (subir el archivo)" };
    case "cuadro_experiencia": return { tipo: "paso", paso: "recursos", ancla: "experiencia", etiqueta: "Recursos → Experiencia" };
    case "sustentos_experiencia": return { tipo: "ruta", ruta: "/licitaciones?tab=experiencia", etiqueta: "Catálogo de experiencia" };
    case "seguro": return { tipo: "ruta", ruta: "/seguros", etiqueta: "Seguros" };
    case "adjunto": return { tipo: "aqui", etiqueta: "Sube el archivo en este ítem" };
    default: return null;
  }
}

export const TONO_CLASE: Record<ClaseParte, "verde" | "azul" | "rojo" | "ambar" | "gris"> = {
  archivo: "verde", generada: "azul", propuesta: "azul", falta: "rojo", externo: "ambar", no_leido: "gris",
};
