// lib/licitaciones/expediente.ts — El EXPEDIENTE de adjuntos: su estructura por defecto y lo que imprime
// cada bloque. Módulo PURO.
//
// `resolverExpediente` decide QUÉ va en cada bloque (D11); el motor de PDF (pdf/expediente.ts) solo lo
// dibuja y lo une. Cada ítem se convierte en una o varias `ParteFuente`, en orden:
//  · un archivo UNIBLE (Storage de este proyecto) es una parte `archivo`;
//  · lo que no tiene archivo unible (falta, sin PDF, un enlace de Drive, un Word…) es una parte
//    `faltante` CON SU CÓDIGO: se omite al unir y se nombra, nunca se inventa una hoja;
//  · los documentos de las unidades salen UNO POR UNIDAD, en orden de código (U1, U2, … R1);
//  · las hojas generadas (ficha de unidad, cuadro de experiencia, tablas) se arman aquí.
// El separador lleva «Contenido:» derivado de los ítems incluidos, con la antigüedad que piden las
// bases cuando una regla la declara («Copia literal (antigüedad no mayor a 30 días)»).

import { DOCS_UNIDAD_LIC } from "./tipos";
import { origenArchivo } from "./archivos";
import { archivosConductor, documentoVigente, tipoDocConductor, tipoLegajo } from "./legajo";
import { docsDeUnidad, ETIQUETA_DOC_UNIDAD } from "./recursos";
import { ETIQUETA_SEGURO_LIC, mejorSeguro } from "./reglas";
import { cabeceraDe, cuadroExperiencia, experienciasElegidas, tablaConductores, tablaContactos, tablaRelacionUnidades, unidadesPorCodigo } from "./tablas";
import { FOLIADO_DEFECTO } from "./normalizar";
import type {
  BloqueExpediente, BloqueExpedienteResuelto, CategoriaRequisito, CodigoHallazgo, CodigoLegajo, ContextoLicitacion,
  DocLicitacion, Expediente, ExpedienteResuelto, FichaUnidad, FuenteItem, ItemExpediente, Licitacion, ParteFuente,
  Regla, Revision, RolConductor, RolUnidad, TipoSeguroLic,
} from "./tipos";
import { baseSupabase } from "../storage-privado";
import { RAYA } from "./util";

// ══ Estructura por defecto ═════════════════════════════════════════════════════

type ClaveBloque = "legal" | "declaraciones" | "unidades" | "conductores" | "seguros" | "emergencias" | "sst" | "experiencia" | "complementarios";

const SUBTITULOS: Record<ClaveBloque, string> = {
  legal: "Requisitos del postor", declaraciones: "Declaraciones juradas", unidades: "Unidades", conductores: "Conductores",
  seguros: "Seguros y garantías", emergencias: "Emergencias", sst: "SST y políticas", experiencia: "Experiencia",
  complementarios: "Documentos complementarios",
};
const ORDEN: readonly ClaveBloque[] = ["legal", "declaraciones", "unidades", "conductores", "seguros", "emergencias", "sst", "experiencia", "complementarios"];
const DE_CATEGORIA: Partial<Record<CategoriaRequisito, ClaveBloque>> = {
  legal: "legal", declaracion: "declaraciones", unidad: "unidades", conductor: "conductores", seguro: "seguros", experiencia: "experiencia",
};
const GRUPO_LEGAJO_A_BLOQUE: Record<string, ClaveBloque> = {
  "Empresa y representación": "legal", "Autorizaciones": "legal", "SST y políticas": "sst", "Institucional": "complementarios",
};
const bloqueDeLegajo = (c: CodigoLegajo): ClaveBloque => (c === "plan_emergencias" ? "emergencias" : GRUPO_LEGAJO_A_BLOQUE[tipoLegajo(c).grupo] ?? "complementarios");

function bloqueDeRegla(r: Regla): ClaveBloque | null {
  if (r.tipo === "doc_empresa") return bloqueDeLegajo(r.legajo);
  if (r.tipo === "prohibe_subcontratacion") return null;
  if (r.tipo === "seguro") return "seguros";
  if (r.tipo.startsWith("experiencia")) return "experiencia";
  if (r.tipo.startsWith("conductor")) return "conductores";
  return "unidades";
}

const ROMANOS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV"];
const ROLES_U: RolUnidad[] = ["titular", "reten"];
const ROLES_C: RolConductor[] = ["titular", "relevo"];

/**
 * El expediente por defecto, armado según las categorías (y reglas) de los requisitos que haya; sin
 * requisitos, la estructura completa de una propuesta (Sección I a VIII y documentos complementarios).
 * `vinculos` dice en qué bloque va el documento de cada requisito (para su `bloqueExpedienteId`).
 */
export function expedientePorDefectoConVinculos(doc: DocLicitacion, ctx: ContextoLicitacion | null, nuevoId: () => string): { expediente: Expediente; vinculos: Record<string, string> } {
  void ctx;
  const reqs = doc.requisitos;
  const presentes = new Set<ClaveBloque>();
  const deReq = new Map<string, ClaveBloque>();
  const legajos = new Map<ClaveBloque, CodigoLegajo[]>();
  const docsUnidad = new Set<string>(["tarjeta_propiedad", "soat", "citv"]);
  const docsCond = new Set<string>(["licencia_conducir", "record_conductor", "antecedentes_penales", "antecedentes_policiales", "examen_medico", "capacitacion"]);
  const seguros: TipoSeguroLic[] = [];
  for (const q of reqs) {
    const b = (q.regla ? bloqueDeRegla(q.regla) : null) ?? DE_CATEGORIA[q.categoria] ?? null;
    if (b) { presentes.add(b); deReq.set(q.id, b); }
    const r = q.regla;
    if (r?.tipo === "doc_empresa") { const k = bloqueDeLegajo(r.legajo); legajos.set(k, [...(legajos.get(k) ?? []), r.legajo]); }
    if (r?.tipo === "unidad_doc") docsUnidad.add(r.doc);
    if (r?.tipo === "conductor_doc") docsCond.add(r.doc);
    if (r?.tipo === "seguro" && !seguros.includes(r.seguro)) seguros.push(r.seguro);
  }
  const todos = reqs.length === 0;
  if (todos) for (const k of ORDEN) presentes.add(k);
  if (doc.contactos.length) presentes.add("emergencias");

  const item = (fuente: FuenteItem, incluido = true, titulo: string | null = null): ItemExpediente => ({ id: nuevoId(), incluido, titulo, fuente });
  const leg = (codigos: CodigoLegajo[]) => codigos.map((codigo) => item({ tipo: "legajo", codigo, documentoId: null }));
  const unicos = <X>(xs: X[]) => [...new Set(xs)];
  const itemsDe = (k: ClaveBloque): ItemExpediente[] => {
    const extra = legajos.get(k) ?? [];
    switch (k) {
      case "legal": return leg(unicos(["ficha_ruc", "copia_literal", "vigencia_poder", "dni_representante", "autorizacion_transporte", ...extra] as CodigoLegajo[]));
      case "declaraciones": {
        const dj = reqs.filter((q) => q.categoria === "declaracion");
        return dj.length ? dj.map((q) => item({ tipo: "adjunto", archivo: null }, true, q.texto.trim().slice(0, 120) || "Declaración jurada")) : [item({ tipo: "adjunto", archivo: null }, true, "Declaraciones juradas firmadas")];
      }
      case "unidades": return [
        item({ tipo: "tabla", tabla: "relacion_unidades" }),
        item({ tipo: "fotos_unidades", roles: ROLES_U }),
        item({ tipo: "fichas_unidades", roles: ROLES_U }, false),
        ...DOCS_UNIDAD_LIC.filter((d) => docsUnidad.has(d)).map((d) => item({ tipo: "docs_unidades", doc: d, roles: ROLES_U })),
      ];
      case "conductores": return [
        item({ tipo: "tabla", tabla: "relacion_conductores" }),
        ...(["licencia_conducir", "record_conductor", "antecedentes_penales", "antecedentes_policiales", "examen_medico", "psicosometrico", "capacitacion"] as const)
          .filter((d) => docsCond.has(d)).map((d) => item({ tipo: "docs_conductores", doc: d, roles: ROLES_C })),
      ];
      case "seguros": return (seguros.length ? seguros : (["responsabilidad_civil"] as TipoSeguroLic[])).map((s) => item({ tipo: "seguro", seguro: s }));
      case "emergencias": return [item({ tipo: "tabla", tabla: "contactos" }), ...leg(unicos(["plan_emergencias", ...extra] as CodigoLegajo[]))];
      case "sst": return leg(unicos([...(todos ? ["rit", "politica_alcohol_drogas", "plan_sst", "iperc"] : []), ...extra] as CodigoLegajo[]));
      case "experiencia": return [item({ tipo: "cuadro_experiencia" }), item({ tipo: "sustentos_experiencia", clase: "todos" })];
      case "complementarios": return leg(unicos([...(todos ? ["brochure"] : []), ...extra] as CodigoLegajo[]));
    }
  };
  if (legajos.get("sst")?.length) presentes.add("sst");
  if (legajos.get("complementarios")?.length) presentes.add("complementarios");

  const bloques: BloqueExpediente[] = [];
  const ids: Partial<Record<ClaveBloque, string>> = {};
  let n = 0;
  for (const k of ORDEN) {
    if (!presentes.has(k)) continue;
    const items = itemsDe(k);
    if (!items.length) continue;
    const id = nuevoId();
    ids[k] = id;
    const numerales = reqs.filter((q) => deReq.get(q.id) === k && q.numeral).map((q) => q.numeral as string);
    const nums = [...new Set(numerales)];
    bloques.push({
      id, activo: true,
      titulo: k === "complementarios" ? "Documentos complementarios" : `Sección ${ROMANOS[n++] ?? String(n)}`,
      subtitulo: k === "complementarios" ? "" : SUBTITULOS[k],
      referencia: nums.length ? `${nums.length === 1 ? "Numeral" : "Numerales"} ${nums.join(", ")}` : "",
      conPortada: true, items,
    });
  }
  const vinculos: Record<string, string> = {};
  for (const [qid, k] of deReq) if (ids[k]) vinculos[qid] = ids[k] as string;
  return { expediente: { bloques, foliado: { ...FOLIADO_DEFECTO }, propuestaEnCompleto: "primero" }, vinculos };
}

export function expedientePorDefecto(doc: DocLicitacion, ctx: ContextoLicitacion | null, nuevoId: () => string): Expediente {
  return expedientePorDefectoConVinculos(doc, ctx, nuevoId).expediente;
}

// ══ Resolución ═════════════════════════════════════════════════════════════════

const ETIQ_TABLA = { relacion_unidades: "Relación de unidades", relacion_conductores: "Relación de conductores", contactos: "Personas de contacto para emergencias" } as const;
const UNIBLES = ["application/pdf", "image/png", "image/jpeg"];

const deRoles = (roles: string[], todos: string[], tit: string, ret: string) =>
  roles.length === todos.length ? "" : roles[0] === todos[0] ? ` ${tit}` : ` ${ret}`;

/** La antigüedad máxima que una regla declara para ese documento del legajo (la menor si hay varias). */
function antiguedadPedida(lic: Licitacion, codigo: CodigoLegajo): number | null {
  const ds = lic.doc.requisitos.map((q) => q.regla).filter((r): r is Extract<Regla, { tipo: "doc_empresa" }> => r?.tipo === "doc_empresa" && r.legajo === codigo && r.antiguedadMaxDias != null).map((r) => r.antiguedadMaxDias as number);
  return ds.length ? Math.min(...ds) : null;
}

/** Cómo se nombra un ítem en «Contenido:» del separador (su título si se escribió uno). */
export function etiquetaItem(i: ItemExpediente, lic: Licitacion): string {
  if (i.titulo && i.titulo.trim()) return i.titulo.trim();
  const f = i.fuente;
  switch (f.tipo) {
    case "legajo": { const a = antiguedadPedida(lic, f.codigo); return `${tipoLegajo(f.codigo).etiqueta}${a ? ` (antigüedad no mayor a ${a} días)` : ""}`; }
    case "docs_unidades": return `${ETIQUETA_DOC_UNIDAD[f.doc]} de las unidades${deRoles(f.roles, ROLES_U, "titulares", "de retén")}`;
    case "fotos_unidades": return `Fotografías de las unidades${deRoles(f.roles, ROLES_U, "titulares", "de retén")}, por dentro y por fuera`;
    case "fichas_unidades": return `Fichas técnicas de las unidades${deRoles(f.roles, ROLES_U, "titulares", "de retén")}`;
    case "docs_conductores": return `${tipoDocConductor(f.doc).etiqueta} de los conductores${deRoles(f.roles, ROLES_C, "titulares", "de relevo")}`;
    case "cuadro_experiencia": return "Cuadro de experiencia";
    case "sustentos_experiencia": return f.clase === "todos" ? "Sustentos de la experiencia (órdenes, comprobantes, cartas o conformidades)" : f.clase === "carta" ? "Cartas de recomendación de clientes" : f.clase === "conformidad" ? "Cartas de conformidad de clientes" : "Órdenes de servicio y/o comprobantes de pago";
    case "seguro": return `Póliza de ${ETIQUETA_SEGURO_LIC[f.seguro]}`;
    case "adjunto": return f.archivo?.nombre ?? "Documento adjunto";
    case "tabla": return ETIQ_TABLA[f.tabla];
    case "propuesta": return "Propuesta técnica";
  }
}

/** Lo que imprime el expediente. `rev` aporta la fecha de referencia (presentación u hoy). */
export function resolverExpediente(lic: Licitacion, ctx: ContextoLicitacion, rev: Pick<Revision, "fechaReferencia">, base: string | null = baseSupabase()): ExpedienteResuelto {
  const doc = lic.doc;
  const ref = rev.fechaReferencia;
  const leida = (f: keyof ContextoLicitacion["lecturas"]) => ctx.lecturas?.[f] === "ok";
  const bloques: BloqueExpedienteResuelto[] = [];

  for (const b of doc.expediente.bloques) {
    if (!b.activo) continue;
    const partes: ParteFuente[] = [];
    const contenido: string[] = [];
    for (const i of b.items) {
      if (!i.incluido) continue;
      const etiqueta = etiquetaItem(i, lic);
      if (!contenido.includes(etiqueta)) contenido.push(etiqueta);
      const faltante = (titulo: string, codigo: CodigoHallazgo) => partes.push({ tipo: "faltante", itemId: i.id, titulo, codigo });
      const archivo = (titulo: string, url: string, nombre: string, etiquetaFuente: string, codigoExterno: CodigoHallazgo = "expediente_item_archivo_externo") => {
        const origen = origenArchivo(url, base);
        if (origen === "vacio") faltante(titulo, "expediente_item_sin_archivo");
        else if (origen === "externo") faltante(titulo, codigoExterno);
        else partes.push({ tipo: "archivo", itemId: i.id, titulo, url, nombre: nombre || titulo, origen, etiquetaFuente });
      };
      const f = i.fuente;
      switch (f.tipo) {
        case "legajo": {
          if (!leida("legajo")) { faltante(etiqueta, "fuente_no_leida"); break; }
          const fila = documentoVigente(f.codigo, ctx.legajo ?? [], f.documentoId);
          if (!fila) faltante(etiqueta, "legajo_falta");
          else if (!fila.archivo_url?.trim()) faltante(etiqueta, "legajo_sin_archivo");
          else archivo(etiqueta, fila.archivo_url, fila.archivo_nombre ?? fila.titulo, "Legajo de la empresa");
          break;
        }
        case "docs_unidades":
        case "fotos_unidades":
        case "fichas_unidades": {
          if (!leida("unidades")) { faltante(etiqueta, "fuente_no_leida"); break; }
          for (const el of unidadesPorCodigo(lic).filter((u) => f.roles.includes(u.rol))) {
            const u = ctx.unidades?.[el.clave];
            const rot = `${el.codigo || "Unidad"}${u ? ` · ${u.placa}` : ""}`;
            if (!u) { faltante(`${etiquetaCorta(f)} · ${rot}`, "unidad_no_existe"); continue; }
            const fuenteU = u.flota === "t" ? "Tercerizadas" : "Docs. Vehiculares";
            if (f.tipo === "docs_unidades") {
              const d = docsDeUnidad(u, f.doc, ref, base);
              const tit = `${ETIQUETA_DOC_UNIDAD[f.doc]} · ${rot}`;
              if (!d.fila) faltante(tit, "unidad_doc_falta");
              else if (d.origen === "vacio") faltante(tit, "unidad_doc_sin_archivo");
              else archivo(tit, d.fila.archivo_url as string, `${ETIQUETA_DOC_UNIDAD[f.doc]} ${u.placa}`, fuenteU, "unidad_doc_archivo_externo");
            } else if (f.tipo === "fotos_unidades") {
              for (const [lado, url] of [["exterior", u.foto_externa_url], ["interior", u.foto_interna_url]] as const) {
                const tit = `Foto ${lado} · ${rot}`;
                if (!url?.trim()) faltante(tit, "unidad_sin_fotos");
                else archivo(tit, url, `Foto ${lado} ${u.placa}`, u.flota === "t" ? "Tercerizadas" : "Vehículos");
              }
            } else {
              partes.push({ tipo: "ficha_unidad", itemId: i.id, ficha: fichaUnidad(el, u, ref, base) });
            }
          }
          break;
        }
        case "docs_conductores": {
          if (!leida("conductores")) { faltante(etiqueta, "fuente_no_leida"); break; }
          const nombreDoc = tipoDocConductor(f.doc).etiqueta;
          for (const el of lic.doc.conductores.filter((c) => f.roles.includes(c.rol))) {
            const c = ctx.conductores?.[el.clave];
            if (!c) { faltante(`${nombreDoc} · conductor que ya no existe`, "conductor_no_existe"); continue; }
            const tit = `${nombreDoc} · ${c.nombre}`;
            const fila = documentoVigente(f.doc, archivosConductor(c, f.doc), null);
            if (!fila) faltante(tit, "conductor_doc_no_registrado");
            else if (!fila.archivo_url?.trim()) faltante(tit, "conductor_doc_sin_archivo");
            else archivo(tit, fila.archivo_url, fila.archivo_nombre ?? tit, "Documentos del conductor");
          }
          break;
        }
        case "cuadro_experiencia":
          if (!leida("experiencia")) { faltante(etiqueta, "fuente_no_leida"); break; }
          partes.push({ tipo: "cuadro_experiencia", itemId: i.id, cuadro: cuadroExperiencia(lic, ctx, i.titulo) });
          break;
        case "sustentos_experiencia": {
          if (!leida("experiencia")) { faltante(etiqueta, "fuente_no_leida"); break; }
          for (const e of experienciasElegidas(lic, ctx).filter((x) => f.clase === "todos" || x.sustento_tipo === f.clase)) {
            const arch = (e.sustentos ?? []).filter((a) => !!a?.url);
            if (!arch.length) { faltante(`Sustento · ${e.cliente_nombre}`, "experiencia_sin_sustento"); continue; }
            for (const a of arch) {
              if (!UNIBLES.includes(a.mime)) { faltante(`${a.nombre} · ${e.cliente_nombre}`, "adjunto_no_unible"); continue; }
              archivo(`Sustento · ${e.cliente_nombre}`, a.url, a.nombre, "Catálogo de experiencia");
            }
          }
          break;
        }
        case "seguro": {
          if (!leida("seguros")) { faltante(etiqueta, "fuente_no_leida"); break; }
          const fila = mejorSeguro(ctx.seguros ?? [], f.seguro);
          if (!fila) faltante(etiqueta, "seguro_falta");
          else if (!fila.archivo?.trim()) faltante(etiqueta, "seguro_sin_archivo");
          else archivo(etiqueta, fila.archivo, `${etiqueta}${fila.numero ? ` ${fila.numero}` : ""}`, "Seguros");
          break;
        }
        case "adjunto":
          if (!f.archivo) faltante(etiqueta, "expediente_item_sin_archivo");
          else if (!UNIBLES.includes(f.archivo.mime)) faltante(etiqueta, "adjunto_no_unible");
          else archivo(etiqueta, f.archivo.url, f.archivo.nombre, "Adjuntos de la licitación");
          break;
        case "tabla": {
          const tabla = f.tabla === "relacion_unidades" ? tablaRelacionUnidades(lic, ctx) : f.tabla === "relacion_conductores" ? tablaConductores(lic, ctx) : tablaContactos(lic, ctx);
          partes.push({ tipo: "tabla", itemId: i.id, titulo: i.titulo?.trim() || ETIQ_TABLA[f.tabla], tabla });
          break;
        }
        case "propuesta":
          partes.push({ tipo: "propuesta", itemId: i.id });
          break;
      }
    }
    bloques.push({ id: b.id, separador: { titulo: b.titulo, subtitulo: b.subtitulo, referencia: b.referencia, contenido }, conPortada: b.conPortada, partes });
  }
  return { bloques, cabecera: cabeceraDe(lic, ctx), color: doc.portada.color };
}

function etiquetaCorta(f: Extract<FuenteItem, { tipo: "docs_unidades" | "fotos_unidades" | "fichas_unidades" }>): string {
  return f.tipo === "docs_unidades" ? ETIQUETA_DOC_UNIDAD[f.doc] : f.tipo === "fotos_unidades" ? "Fotos" : "Ficha técnica";
}

const ESTADO_DOC: Record<string, string> = { falta: "Falta", vigente: "Vigente", por_vencer: "Por vencer", vencido: "Vencido", sin_fecha: "Sin fecha", no_vence: "No vence" };

function fichaUnidad(el: Licitacion["doc"]["unidades"][number], u: NonNullable<ContextoLicitacion["unidades"][string]>, ref: string, base: string | null): FichaUnidad {
  const documentos = DOCS_UNIDAD_LIC.map((d) => {
    const r = docsDeUnidad(u, d, ref, base);
    return { tipo: ETIQUETA_DOC_UNIDAD[d], numero: r.fila?.numero ?? null, vence: r.vence, estado: ESTADO_DOC[r.estado] ?? r.estado, adjunto: r.origen === "storage_privado" || r.origen === "storage_publico" };
  });
  const marcaModelo = [u.marca, u.modelo].filter((x) => x && x.trim()).join(" ") || RAYA;
  const foto = (url: string | null) => { const o = origenArchivo(url, base); return o === "storage_privado" || o === "storage_publico" ? url : null; };
  return {
    codigo: el.codigo, rol: el.rol, uso: el.uso, placa: u.placa, marcaModelo, anio: u.anio, capacidad: u.capacidad,
    flota: u.flota === "t" ? (u.empresa?.razon_social ?? "Tercerizada") : "Propia",
    fotoExternaUrl: foto(u.foto_externa_url), fotoInternaUrl: foto(u.foto_interna_url), documentos,
  };
}

