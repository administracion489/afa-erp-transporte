// components/licitaciones/editor/expediente/acciones.ts — Los cambios del paso «Expediente» sobre el doc,
// INMUTABLES (cada función devuelve un doc nuevo o el mismo si no hay nada que cambiar). PURO: sin React,
// sin base. No decide qué SALE en el expediente: eso lo dice resolverExpediente (lib/licitaciones/expediente).
//
// Tres reglas que se repiten aquí y por eso no viven en el TSX:
//  · Los cambios se buscan por ID, nunca por índice: entre el clic y el cambio pudo reordenarse la lista
//    (una subida que termina tarde, por ejemplo).
//  · Quitar un bloque suelta el enlace de los requisitos que apuntaban a él: un `bloqueExpedienteId` que
//    no existe es un dato que miente.
//  · Rehacer la estructura no pierde lo que alguien SUBIÓ: los adjuntos con archivo pasan al ítem nuevo
//    del mismo título o, si no hay, a un bloque «Adjuntos conservados» que se ve y se puede quitar.
import { expedientePorDefectoConVinculos } from "@/lib/licitaciones/expediente";
import { TIPOS_LEGAJO } from "@/lib/licitaciones/legajo";
import {
  CODIGOS_DOC_CONDUCTOR, DOCS_UNIDAD_LIC, TOPES_DOC,
  type BloqueExpediente, type CodigoDocConductor, type DocLicitacion, type DocUnidadLic, type Expediente,
  type FuenteItem, type ItemExpediente, type RolConductor, type RolUnidad, type TipoSeguroLic,
} from "@/lib/licitaciones/tipos";

export type TipoFuente = FuenteItem["tipo"];

export const ROLES_UNIDAD: readonly RolUnidad[] = ["titular", "reten"];
export const ROLES_CONDUCTOR: readonly RolConductor[] = ["titular", "relevo"];
export const TIPOS_SEGURO_LISTA: readonly TipoSeguroLic[] = ["responsabilidad_civil", "deshonestidad", "todo_riesgo", "sctr_salud", "sctr_pension", "vida_ley"];

/** El orden del menú «Agregar documento». */
export const TIPOS_FUENTE: readonly TipoFuente[] = [
  "legajo", "adjunto", "docs_unidades", "fotos_unidades", "fichas_unidades", "tabla",
  "docs_conductores", "cuadro_experiencia", "sustentos_experiencia", "seguro", "propuesta",
];

/** Rótulos de pantalla de cada fuente. `generada` = la hoja la arma el ERP (no es un archivo subido). */
export const ETIQUETA_FUENTE: Record<TipoFuente, { titulo: string; ayuda: string; generada: boolean }> = {
  legajo: { titulo: "Documento del legajo", ayuda: "Ficha RUC, copia literal, vigencia de poder, plan SST… del Legajo de la empresa.", generada: false },
  adjunto: { titulo: "Archivo subido aquí", ayuda: "Un anexo firmado, una declaración jurada, la carta fianza… (PDF, PNG o JPG).", generada: false },
  docs_unidades: { titulo: "Documentos de las unidades", ayuda: "Uno por unidad elegida en Recursos, en orden de código (U1, U2… R1).", generada: false },
  fotos_unidades: { titulo: "Fotos de las unidades", ayuda: "Exterior e interior de cada unidad elegida.", generada: false },
  fichas_unidades: { titulo: "Fichas técnicas de las unidades", ayuda: "Hoja que arma el ERP: una por unidad, con fotos y tabla de documentos.", generada: true },
  tabla: { titulo: "Tabla del ERP", ayuda: "Relación de unidades, de conductores o contactos de emergencia, armada con lo elegido en Recursos.", generada: true },
  docs_conductores: { titulo: "Documentos de los conductores", ayuda: "Uno por conductor elegido en Recursos.", generada: false },
  cuadro_experiencia: { titulo: "Cuadro de experiencia", ayuda: "Hoja que arma el ERP con los contratos elegidos en Recursos, firmada por el representante legal.", generada: true },
  sustentos_experiencia: { titulo: "Sustentos de la experiencia", ayuda: "Órdenes, comprobantes, cartas o conformidades de los contratos elegidos.", generada: false },
  seguro: { titulo: "Póliza de seguro", ayuda: "La póliza registrada en Seguros.", generada: false },
  propuesta: { titulo: "Propuesta técnica", ayuda: "La propuesta del paso 3, dentro de este bloque.", generada: true },
};

const ROMANOS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV",
  "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "XXII", "XXIII", "XXIV", "XXV", "XXVI", "XXVII", "XXVIII", "XXIX", "XXX"];
export const romano = (n: number): string => ROMANOS[n - 1] ?? String(n);

// ══ Navegar el doc ════════════════════════════════════════════════════════════════

export function conExpediente(d: DocLicitacion, fn: (e: Expediente) => Expediente): DocLicitacion {
  const e = fn(d.expediente);
  return e === d.expediente ? d : { ...d, expediente: e };
}

export function conBloques(d: DocLicitacion, fn: (bs: BloqueExpediente[]) => BloqueExpediente[]): DocLicitacion {
  return conExpediente(d, (e) => {
    const bs = fn(e.bloques);
    return bs === e.bloques ? e : { ...e, bloques: bs };
  });
}

/** Cambia UN bloque por su id (si ya no existe, no cambia nada). */
export function conBloque(d: DocLicitacion, bloqueId: string, fn: (b: BloqueExpediente) => BloqueExpediente): DocLicitacion {
  return conBloques(d, (bs) => {
    const k = bs.findIndex((b) => b.id === bloqueId);
    if (k < 0) return bs;
    const nb = fn(bs[k]);
    if (nb === bs[k]) return bs;
    const out = [...bs];
    out[k] = nb;
    return out;
  });
}

/** Cambia UN ítem por su id, esté en el bloque que esté. */
export function conItem(d: DocLicitacion, itemId: string, fn: (i: ItemExpediente) => ItemExpediente): DocLicitacion {
  const b = d.expediente.bloques.find((x) => x.items.some((i) => i.id === itemId));
  if (!b) return d;
  return conBloque(d, b.id, (bl) => {
    const k = bl.items.findIndex((i) => i.id === itemId);
    if (k < 0) return bl;
    const ni = fn(bl.items[k]);
    if (ni === bl.items[k]) return bl;
    const items = [...bl.items];
    items[k] = ni;
    return { ...bl, items };
  });
}

export const existeItem = (d: DocLicitacion, itemId: string) => d.expediente.bloques.some((b) => b.items.some((i) => i.id === itemId));

/** Mueve el elemento `id` un puesto arriba (-1) o abajo (+1). */
export function moverPorId<X extends { id: string }>(xs: X[], id: string, delta: -1 | 1): X[] {
  const k = xs.findIndex((x) => x.id === id);
  const j = k + delta;
  if (k < 0 || j < 0 || j >= xs.length) return xs;
  const out = [...xs];
  [out[k], out[j]] = [out[j], out[k]];
  return out;
}

// ══ Bloques ═══════════════════════════════════════════════════════════════════════

export function bloqueNuevo(nuevoId: () => string, n: number): BloqueExpediente {
  return { id: nuevoId(), activo: true, titulo: `Sección ${romano(n)}`, subtitulo: "", referencia: "", conPortada: true, items: [] };
}

/** Copia con ids nuevos (bloque, ítems y archivos), justo debajo del original. */
export function duplicarBloque(d: DocLicitacion, bloqueId: string, nuevoId: () => string): { doc: DocLicitacion; nuevo: string | null } {
  const bs = d.expediente.bloques;
  const k = bs.findIndex((b) => b.id === bloqueId);
  if (k < 0 || bs.length >= TOPES_DOC.maxBloquesExpediente) return { doc: d, nuevo: null };
  const b = bs[k];
  const copia: BloqueExpediente = {
    ...b, id: nuevoId(), titulo: `${b.titulo} (copia)`.slice(0, 200),
    items: b.items.map((i) => ({ ...i, id: nuevoId(), fuente: copiarFuente(i.fuente, nuevoId) })),
  };
  const out = [...bs.slice(0, k + 1), copia, ...bs.slice(k + 1)];
  return { doc: conBloques(d, () => out), nuevo: copia.id };
}

function copiarFuente(f: FuenteItem, nuevoId: () => string): FuenteItem {
  switch (f.tipo) {
    case "adjunto": return { tipo: "adjunto", archivo: f.archivo ? { ...f.archivo, id: nuevoId() } : null };
    case "docs_unidades": case "fotos_unidades": case "fichas_unidades": case "docs_conductores":
      return { ...f, roles: [...f.roles] } as FuenteItem;
    default: return { ...f };
  }
}

/** Quita el bloque y suelta el enlace de los requisitos que apuntaban a él. */
export function quitarBloque(d: DocLicitacion, bloqueId: string): DocLicitacion {
  if (!d.expediente.bloques.some((b) => b.id === bloqueId)) return d;
  const sinBloque = conBloques(d, (bs) => bs.filter((b) => b.id !== bloqueId));
  const tocados = d.requisitos.some((q) => q.bloqueExpedienteId === bloqueId);
  if (!tocados) return sinBloque;
  return { ...sinBloque, requisitos: d.requisitos.map((q) => (q.bloqueExpedienteId === bloqueId ? { ...q, bloqueExpedienteId: null } : q)) };
}

// ══ Ítems ═════════════════════════════════════════════════════════════════════════

const primeroQueFalte = <X extends string>(todos: readonly X[], usados: Set<string>): X => todos.find((x) => !usados.has(x)) ?? todos[0];

/** La fuente con que nace un ítem del tipo elegido: lo primero que todavía no está en el expediente. */
export function fuentePorDefecto(tipo: TipoFuente, e: Expediente): FuenteItem {
  const fuentes = e.bloques.flatMap((b) => b.items.map((i) => i.fuente));
  const usados = (t: TipoFuente, clave: (f: FuenteItem) => string | null) => new Set(fuentes.filter((f) => f.tipo === t).map(clave).filter((x): x is string => !!x));
  switch (tipo) {
    case "legajo":
      return { tipo, codigo: primeroQueFalte(TIPOS_LEGAJO.map((t) => t.codigo), usados("legajo", (f) => (f.tipo === "legajo" ? f.codigo : null))), documentoId: null };
    case "docs_unidades":
      return { tipo, doc: primeroQueFalte<DocUnidadLic>(DOCS_UNIDAD_LIC, usados("docs_unidades", (f) => (f.tipo === "docs_unidades" ? f.doc : null))), roles: [...ROLES_UNIDAD] };
    case "fotos_unidades": return { tipo, roles: [...ROLES_UNIDAD] };
    case "fichas_unidades": return { tipo, roles: [...ROLES_UNIDAD] };
    case "docs_conductores":
      return { tipo, doc: primeroQueFalte<CodigoDocConductor>(CODIGOS_DOC_CONDUCTOR, usados("docs_conductores", (f) => (f.tipo === "docs_conductores" ? f.doc : null))), roles: [...ROLES_CONDUCTOR] };
    case "cuadro_experiencia": return { tipo };
    case "sustentos_experiencia": return { tipo, clase: "todos" };
    case "seguro": return { tipo, seguro: primeroQueFalte(TIPOS_SEGURO_LISTA, usados("seguro", (f) => (f.tipo === "seguro" ? f.seguro : null))) };
    case "adjunto": return { tipo, archivo: null };
    case "tabla": {
      const ya = usados("tabla", (f) => (f.tipo === "tabla" ? f.tabla : null));
      return { tipo, tabla: primeroQueFalte(["relacion_unidades", "relacion_conductores", "contactos"] as const, ya) };
    }
    case "propuesta": return { tipo };
  }
}

/** Agrega un ítem al final del bloque. null = el bloque no existe o está lleno. */
export function agregarItem(d: DocLicitacion, bloqueId: string, tipo: TipoFuente, nuevoId: () => string): { doc: DocLicitacion; nuevo: string | null } {
  const b = d.expediente.bloques.find((x) => x.id === bloqueId);
  if (!b || b.items.length >= TOPES_DOC.maxItemsBloque) return { doc: d, nuevo: null };
  const item: ItemExpediente = { id: nuevoId(), incluido: true, titulo: null, fuente: fuentePorDefecto(tipo, d.expediente) };
  return { doc: conBloque(d, bloqueId, (bl) => ({ ...bl, items: [...bl.items, item] })), nuevo: item.id };
}

export function quitarItem(d: DocLicitacion, itemId: string): DocLicitacion {
  const b = d.expediente.bloques.find((x) => x.items.some((i) => i.id === itemId));
  if (!b) return d;
  return conBloque(d, b.id, (bl) => ({ ...bl, items: bl.items.filter((i) => i.id !== itemId) }));
}

/** Pasa el ítem al final de otro bloque. No hace nada si el destino no existe o está lleno. */
export function moverItemABloque(d: DocLicitacion, itemId: string, destinoId: string): DocLicitacion {
  const origen = d.expediente.bloques.find((x) => x.items.some((i) => i.id === itemId));
  const destino = d.expediente.bloques.find((x) => x.id === destinoId);
  if (!origen || !destino || origen.id === destino.id || destino.items.length >= TOPES_DOC.maxItemsBloque) return d;
  const item = origen.items.find((i) => i.id === itemId) as ItemExpediente;
  return conBloques(d, (bs) => bs.map((b) => {
    if (b.id === origen.id) return { ...b, items: b.items.filter((i) => i.id !== itemId) };
    if (b.id === destino.id) return { ...b, items: [...b.items, item] };
    return b;
  }));
}

/** Los roles en su orden canónico (titular primero): etiquetaItem lee el primero para decir «titulares» o «de retén». */
export function alternarRol<R extends string>(roles: readonly R[], todos: readonly R[], rol: R, marcado: boolean): R[] {
  const s = new Set<R>(roles);
  if (marcado) s.add(rol); else s.delete(rol);
  const out = todos.filter((r) => s.has(r));
  return out.length ? out : [...roles];          // vacío = todos al normalizar: nunca se deja vacío
}

// ══ Estructura sugerida ═══════════════════════════════════════════════════════════

export type ResumenSugerida = { bloques: number; items: number; enlazados: number; adjuntosReubicados: number; adjuntosConservados: number; adjuntosSinSitio: number };

const claveTitulo = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Arma (o REHACE) la estructura sugerida con expedientePorDefectoConVinculos. Conserva el foliado y
 * «propuesta en el completo». Enlaza a su bloque nuevo los requisitos cuyo bloque no existe en la
 * estructura nueva (o no tenían ninguno); los que no tienen vínculo quedan sin bloque. Los adjuntos con
 * archivo de la estructura anterior no se pierden (ver cabecera).
 */
export function aplicarSugerida(d: DocLicitacion, nuevoId: () => string): { doc: DocLicitacion; resumen: ResumenSugerida } {
  const { expediente, vinculos } = expedientePorDefectoConVinculos(d, null, nuevoId);
  const max = TOPES_DOC.maxBloquesExpediente, maxI = TOPES_DOC.maxItemsBloque;
  const bloques: BloqueExpediente[] = expediente.bloques.slice(0, max).map((b) => ({ ...b, items: b.items.slice(0, maxI) }));

  // Adjuntos ya subidos: al ítem nuevo del mismo título (sin archivo), o a «Adjuntos conservados».
  const subidos = d.expediente.bloques.flatMap((b) => b.items).filter((i): i is ItemExpediente & { fuente: { tipo: "adjunto"; archivo: NonNullable<Extract<FuenteItem, { tipo: "adjunto" }>["archivo"]> } } =>
    i.fuente.tipo === "adjunto" && !!i.fuente.archivo);
  let reubicados = 0;
  const sinSitio: ItemExpediente[] = [];
  for (const v of subidos) {
    const t = claveTitulo(v.titulo);
    let puesto = false;
    if (t) {
      for (const b of bloques) {
        const k = b.items.findIndex((i) => i.fuente.tipo === "adjunto" && !i.fuente.archivo && claveTitulo(i.titulo) === t);
        if (k >= 0) { b.items[k] = { ...b.items[k], fuente: { tipo: "adjunto", archivo: v.fuente.archivo } }; puesto = true; break; }
      }
    }
    if (puesto) reubicados++;
    else sinSitio.push({ ...v, id: nuevoId() });
  }
  let conservados = 0;
  if (sinSitio.length && bloques.length < max) {
    const items = sinSitio.slice(0, maxI);
    conservados = items.length;
    bloques.push({ id: nuevoId(), activo: true, titulo: "Adjuntos conservados", subtitulo: "De la estructura anterior", referencia: "", conPortada: true, items });
  }

  const ids = new Set(bloques.map((b) => b.id));
  let enlazados = 0;
  const requisitos = d.requisitos.map((q) => {
    if (q.bloqueExpedienteId && ids.has(q.bloqueExpedienteId)) return q;
    const v = vinculos[q.id] && ids.has(vinculos[q.id]) ? vinculos[q.id] : null;
    if (v) enlazados++;
    return v === q.bloqueExpedienteId ? q : { ...q, bloqueExpedienteId: v };
  });

  const doc: DocLicitacion = { ...d, requisitos, expediente: { ...d.expediente, bloques } };
  return {
    doc,
    resumen: {
      bloques: bloques.length, items: bloques.reduce((a, b) => a + b.items.length, 0), enlazados,
      adjuntosReubicados: reubicados, adjuntosConservados: conservados, adjuntosSinSitio: sinSitio.length - conservados,
    },
  };
}

/** Empezar en blanco: un solo bloque vacío (el foliado se conserva). */
export function empezarEnBlanco(d: DocLicitacion, nuevoId: () => string): DocLicitacion {
  if (d.expediente.bloques.length) return d;
  return conBloques(d, () => [bloqueNuevo(nuevoId, 1)]);
}

/** Cuántos adjuntos con archivo hay en el expediente (y en un bloque). */
export const adjuntosConArchivo = (bs: readonly BloqueExpediente[]) =>
  bs.reduce((a, b) => a + b.items.filter((i) => i.fuente.tipo === "adjunto" && !!i.fuente.archivo).length, 0);
