// lib/licitaciones/documento.ts — Lo que IMPRIME la propuesta técnica. Módulo PURO.
//
// UN solo resolvedor para el PDF y la vista previa (D11): si la pantalla y el papel resolvieran por
// separado, la vista previa podría enseñar un texto y el PDF otro. Aquí se decide todo:
//  · las {variables} se resuelven (sin valor quedan visibles: la revisión las nombra);
//  · solo las secciones ACTIVAS, numeradas en orden (1, 2…; subtítulos 1.1, 1.1.1);
//  · los bloques automáticos se convierten en tablas armadas del ERP (las mismas de tablas.ts que usa el
//    expediente), con sus filas extra escritas a mano al final;
//  · un dato que falta se imprime «—», nunca un cero inventado.
// El motor de PDF (pdf/propuesta.ts) no decide nada: dibuja esto.

import { empresaConDefectos } from "../empresa-perfil";
import { describirRegla, ETIQUETA_REGLA } from "./reglas";
import { resolverExpediente } from "./expediente";
import { cabeceraDe, cuadroExperiencia, tablaConductores, tablaContactos, tablaExperiencia, tablaRelacionUnidades } from "./tablas";
import { fechaRef, representanteDe, resolverVariables, valoresVariables } from "./texto";
import type {
  Bloque, BloqueResuelto, ContextoLicitacion, DocumentoResuelto, EvaluacionRequisito, Licitacion, Revision,
  SeccionResuelta, TablaPlano, TipoAuto,
} from "./tipos";
import { fechaDMY, fechaLarga, fechaONull, fmtImporte, RAYA } from "./util";

const ESTADO_MATRIZ: Record<string, string> = { cumple: "Sí", no_cumple: "No", no_aplica: "No aplica", pendiente: RAYA, no_se_puede_juzgar: RAYA };
const ES_DE_RECURSOS = /^(unidad|unidades|conductor|conductores)_/;

/** Parte un texto largo en párrafos por líneas en blanco. */
const parrafos = (t: string) => t.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);

/** Rellena cada fila a `n` celdas (las filas extra de un bloque automático). */
const aAncho = (filas: string[][], n: number) => filas.map((f) => { const r = f.slice(0, n); while (r.length < n) r.push(""); return r; });

export type OpcionesDocumento = {
  /** Folios de cada bloque del expediente (por id), para la columna «Folios» de la relación de adjuntos. */
  folios?: Record<string, { desde: number; hasta: number }>;
};

/** Lo que imprime la propuesta (PDF y vista previa). `rev` = revisarLicitacion(lic, ctx). */
export function resolverDocumento(lic: Licitacion, ctx: ContextoLicitacion, rev: Revision, opts: OpcionesDocumento = {}): DocumentoResuelto {
  const doc = lic.doc;
  const vals = valoresVariables(lic, ctx);
  const res = (t: string | null | undefined) => resolverVariables(t ?? "", vals).texto;
  const emp = empresaConDefectos(ctx.perfil);
  const rep = representanteDe(doc, ctx);
  const evalDe = new Map<string, EvaluacionRequisito>(rev.evaluaciones.map((e) => [e.requisitoId, e]));
  const presentacion = fechaONull(lic.fecha_presentacion);

  // ── Portada
  const portada: DocumentoResuelto["portada"] = {
    modo: doc.portada.modo === "imagen" && doc.portada.imagen ? "imagen" : "generada",
    imagenUrl: doc.portada.imagen?.url ?? null,
    titulo: res(doc.portada.titulo).trim() || "Propuesta Técnica",
    subtitulo: res(doc.portada.subtitulo).trim(),
    lineas: [
      lic.cliente_nombre.trim() ? `Cliente: ${lic.cliente_nombre.trim()}` : null,
      lic.codigo ? `Concurso ${lic.codigo}` : null,
      lic.objeto?.trim() ? lic.objeto.trim() : null,
      emp.sinConfigurar ? null : `Postor: ${emp.razonSocial}${emp.ruc ? ` · RUC ${emp.ruc}` : ""}`,
      presentacion ? `Fecha de presentación: ${fechaDMY(presentacion)}` : null,
    ].filter((x): x is string => !!x),
  };

  // ── Control del documento
  const c = doc.control;
  const control: DocumentoResuelto["control"] = c.activo
    ? ([
        ["Documento", res(c.documento).trim() || portada.titulo],
        ["Cliente", [lic.cliente_nombre.trim(), lic.codigo ? `(${lic.codigo})` : ""].filter(Boolean).join(" ") || RAYA],
        ["Postor", emp.sinConfigurar ? RAYA : `${emp.razonSocial}${emp.ruc ? ` — RUC ${emp.ruc}` : ""}`],
        ["Versión", res(c.version).trim() || RAYA],
        ...(c.codigo.trim() ? [["Código", res(c.codigo).trim()] as [string, string]] : []),
        ["Elaborado por", res(c.elaboradoPor).trim() || RAYA],
        ["Revisado por", res(c.revisadoPor).trim() || RAYA],
        ["Aprobado por", res(c.aprobadoPor).trim() || RAYA],
        ["Fecha", c.fecha ? fechaDMY(c.fecha) : presentacion ? fechaDMY(presentacion) : RAYA],
        ["Confidencialidad", res(c.confidencialidad).trim() || RAYA],
      ] as [string, string][])
    : null;

  // ── Carta de presentación
  const k = doc.carta;
  let carta: DocumentoResuelto["carta"] = null;
  if (k.activa) {
    const dest = res(k.destinatario).split(/\n/).map((s) => s.trim()).filter(Boolean);
    const atencion = res(k.atencion).trim() || (lic.atencion ?? "").trim();
    carta = {
      lugarFecha: res(k.lugarFecha).trim() || fechaLarga(fechaRef(lic, ctx)),
      destinatario: [
        ...(dest.length ? dest : ["Señores", ...(lic.cliente_nombre.trim() ? [`**${lic.cliente_nombre.trim().toUpperCase()}**`] : [])]),
        ...(atencion ? [`**Atención: ${atencion}**`] : []),
      ],
      referencia: res(k.referencia).trim() || [lic.codigo ? `Concurso ${lic.codigo}` : null, lic.nombre.trim() || null].filter(Boolean).join(" — "),
      cuerpo: parrafos(res(k.cuerpo)),
      despedida: res(k.despedida).trim(),
      conFirma: k.conFirma,
    };
  }

  // ── Glosario e índice
  const glosario: DocumentoResuelto["glosario"] = doc.glosario.activo && doc.glosario.entradas.length
    ? doc.glosario.entradas.filter((e) => e.termino.trim() || e.definicion.trim()).map((e) => [res(e.termino).trim(), res(e.definicion).trim()] as [string, string])
    : null;
  const indice = doc.indice.activo ? { niveles: doc.indice.niveles } : null;

  // ── Secciones
  const exp = resolverExpediente(lic, ctx, rev);
  const secciones: SeccionResuelta[] = [];
  let ns = 0;
  for (const s of doc.secciones) {
    if (!s.activa) continue;
    const numero = s.numerada ? String(++ns) : null;
    let n2 = 0, n3 = 0;
    const bloques: BloqueResuelto[] = [];
    for (const b of s.bloques) {
      if (b.tipo === "subtitulo") {
        let num: string | null = null;
        if (b.numerado && numero) {
          if (b.nivel === 2) { n2++; n3 = 0; num = `${numero}.${n2}`; }
          else { n3++; num = `${numero}.${Math.max(n2, 1)}.${n3}`; }
        }
        bloques.push({ id: b.id, tipo: "subtitulo", texto: res(b.texto).trim(), nivel: b.nivel, numero: num });
        continue;
      }
      bloques.push(...resolverBloque(b, { lic, ctx, rev, res, evalDe, exp, opts, empresa: emp.sinConfigurar ? null : emp.nombre }));
    }
    secciones.push({ id: s.id, numero, titulo: res(s.titulo).trim(), bloques });
  }

  const cierre = doc.cierre.activo ? { texto: res(doc.cierre.texto), conFirma: doc.cierre.conFirma } : null;
  return {
    cabecera: cabeceraDe(lic, ctx), color: doc.portada.color, portada, control, carta, glosario, indice, secciones, cierre,
    firmante: rep.nombre ? { nombre: rep.nombre, dni: rep.dni, cargo: rep.cargo, firmaUrl: rep.firmaUrl } : null,
    pie: { izquierda: emp.sinConfigurar ? "" : `${emp.razonSocial}${emp.ruc ? ` · RUC ${emp.ruc}` : ""}`, derecha: "Página {pagina} de {total}" },
  };
}

type Ctx = {
  lic: Licitacion; ctx: ContextoLicitacion; rev: Revision; res: (t: string | null | undefined) => string;
  evalDe: Map<string, EvaluacionRequisito>; exp: ReturnType<typeof resolverExpediente>; opts: OpcionesDocumento;
  empresa: string | null;
};

function resolverBloque(b: Bloque, x: Ctx): BloqueResuelto[] {
  const { res } = x;
  switch (b.tipo) {
    case "parrafo": return [{ id: b.id, tipo: "parrafo", texto: res(b.texto) }];
    case "vinetas": return [{ id: b.id, tipo: "vinetas", items: b.items.map((i) => res(i)).filter((i) => i.trim()), ordenada: b.ordenada }];
    case "tabla": return [{ id: b.id, tipo: "tabla", titulo: b.titulo ? res(b.titulo) : null, columnas: b.columnas.map((c) => res(c)), filas: b.filas.map((f) => f.map((c) => res(c))), anchos: b.anchos, pie: null }];
    case "nota": return [{ id: b.id, tipo: "nota", texto: res(b.texto), tono: b.tono }];
    case "imagen": return b.archivo ? [{ id: b.id, tipo: "imagen", url: b.archivo.url, pie: b.pie ? res(b.pie) : null, anchoPct: b.anchoPct }] : [];
    case "salto_pagina": return [{ id: b.id, tipo: "salto_pagina" }];
    case "subtitulo": return [];
    case "auto": {
      const t = tablaAuto(b.auto, x, b.conContacto);
      const extra = aAncho(b.filasExtra.map((f) => f.map((c) => res(c))), t.tabla.columnas.length);
      const out: BloqueResuelto[] = [];
      if (t.intro) out.push({ id: `${b.id}:intro`, tipo: "parrafo", texto: t.intro });
      out.push({ id: b.id, tipo: "tabla", titulo: b.titulo ? res(b.titulo) : t.titulo, columnas: t.tabla.columnas, filas: [...t.tabla.filas, ...extra], anchos: t.anchos ?? null, pie: t.tabla.pie });
      return out;
    }
  }
}

/** La tabla de un bloque automático, armada del ERP. */
function tablaAuto(auto: TipoAuto, x: Ctx, conContacto: boolean): { titulo: string | null; tabla: TablaPlano; intro?: string; anchos?: number[] } {
  const { lic, ctx, res, evalDe } = x;
  const doc = lic.doc;
  switch (auto) {
    case "datos_postor": {
      const p = ctx.perfil;
      const emp = empresaConDefectos(p);
      const rep = representanteDe(doc, ctx);
      const v = (s: string | null | undefined) => (s && s.trim() ? s.trim() : RAYA);
      const fc = fechaONull(p?.fecha_constitucion);
      const contacto = [p?.telefono?.trim(), p?.email?.trim()].filter(Boolean).join(" · ");
      return {
        titulo: null, anchos: [30, 70],
        tabla: {
          columnas: ["Campo", "Información"], pie: null,
          filas: [
            ["Razón social", emp.sinConfigurar ? RAYA : emp.razonSocial],
            ["Nombre comercial", v(p?.nombre)],
            ["RUC", v(p?.ruc)],
            ["Domicilio", v(p?.direccion)],
            ["Representante legal", rep.nombre ? `${rep.nombre}${rep.dni ? ` — DNI ${rep.dni}` : ""}` : RAYA],
            ["Autorización de transporte", v(p?.autorizacion_mtc)],
            ["Contacto", contacto || RAYA],
            ["Sitio web", v(p?.web)],
            ...(fc ? [["Año de constitución", fc.slice(0, 4)]] : []),
          ],
        },
      };
    }
    case "relacion_unidades": return { titulo: "Relación de unidades", tabla: tablaRelacionUnidades(lic, ctx) };
    case "conductores": return { titulo: "Relación de conductores", tabla: tablaConductores(lic, ctx) };
    case "contactos": return { titulo: null, tabla: tablaContactos(lic, ctx) };
    case "exigido_ofertado": {
      const filas = doc.requisitos.filter((q) => q.regla && ES_DE_RECURSOS.test(q.regla.tipo)).map((q) => {
        const exigido = res(q.texto).trim() || describirRegla(q.regla!);
        return [ETIQUETA_REGLA[q.regla!.tipo], `${exigido}${q.numeral ? ` (${q.numeral})` : ""}`, evalDe.get(q.id)?.auto?.sustento ?? RAYA];
      });
      return { titulo: null, tabla: { columnas: ["Especificación", "Exigido por las bases", "Ofertado"], filas, pie: null } };
    }
    case "matriz_cumplimiento": {
      const filas = doc.requisitos.filter((q) => q.enMatriz).map((q) => {
        const e = evalDe.get(q.id);
        const cumple = q.cumpleTexto?.trim() || ESTADO_MATRIZ[e?.final ?? "pendiente"];
        const sustento = res(q.sustento).trim() || e?.auto?.sustento || RAYA;
        return [`${res(q.texto).trim() || RAYA}${q.numeral ? ` (${q.numeral})` : ""}`, cumple, sustento];
      });
      return { titulo: null, anchos: [44, 16, 40], tabla: { columnas: ["Requisito", "Cumple", "Sustento adjunto"], filas, pie: null } };
    }
    case "absolucion_consultas": {
      const cliente = lic.cliente_nombre.trim();
      return {
        titulo: null,
        tabla: {
          columnas: ["Consulta", cliente ? `Respuesta de ${cliente}` : "Respuesta del cliente", x.empresa ? `Cómo la incorpora ${x.empresa}` : "Cómo la incorpora el postor"],
          filas: doc.consultas.map((q) => [`${res(q.pregunta).trim() || RAYA}${q.numero ? ` (${q.numero})` : ""}`, res(q.respuesta).trim() || RAYA, res(q.incorporacion).trim() || RAYA]),
          pie: null,
        },
      };
    }
    case "cuadro_experiencia": {
      const cu = cuadroExperiencia(lic, ctx);
      const tabla = tablaExperiencia(lic, ctx, conContacto || doc.experiencia.conContacto, true);
      // Totales POR MONEDA en la última columna (la del importe); nunca se suman PEN y USD.
      const n = tabla.columnas.length;
      let pie: string[] | null = null;
      if (cu.totales.length && n >= 2) {
        pie = Array.from({ length: n }, () => "");
        pie[1] = "Total";
        pie[n - 1] = cu.totales.map((t) => fmtImporte(t.importe, t.moneda)).join(" · ");
      }
      return { titulo: null, intro: cu.introduccion || undefined, tabla: { ...tabla, pie } };
    }
    case "relacion_adjuntos": {
      const dig = Math.max(1, lic.doc.expediente.foliado.digitos);
      const pad = (k: number) => String(k).padStart(dig, "0");
      const conFolios = lic.doc.expediente.foliado.modo !== "ninguno";
      const filas = x.exp.bloques.map((b) => {
        const f = x.opts.folios?.[b.id];
        const sep = [b.separador.titulo, b.separador.subtitulo].filter((s) => s.trim()).join(" — ") || RAYA;
        const contenido = b.separador.contenido.length ? b.separador.contenido.join("; ") : RAYA;
        return [sep, contenido, b.separador.referencia.trim() || RAYA, ...(conFolios ? [f ? `${pad(Math.min(f.desde, f.hasta))}–${pad(Math.max(f.desde, f.hasta))}` : RAYA] : [])];
      });
      return { titulo: null, tabla: { columnas: ["Separador", "Contenido", "Referencia en las bases", ...(conFolios ? ["Folios"] : [])], filas, pie: null } };
    }
  }
}
