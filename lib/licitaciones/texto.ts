// lib/licitaciones/texto.ts — Variables, negritas y el escaneo del texto de la propuesta. Módulo PURO.
//
// El texto admite tres cosas y nada más: **negrita**, {variables} del catálogo y la marca [COMPLETAR].
// Una variable sin valor NO se borra ni se rellena con un cero: queda visible tal cual («{ruc}») y la
// revisión la nombra. Un papel con «{ruc}» se corrige antes de salir; uno con «0» pasa por bueno.
//
// `escanearTexto` recorre SOLO lo que se imprime (secciones activas, la carta si está activa, los
// separadores de los bloques activos…) y devuelve la evidencia; qué es alarma lo decide revision.ts.

import { normalizarBusqueda } from "../busqueda-texto";
import { empresaConDefectos } from "../empresa-perfil";
import type { ContextoLicitacion, DocLicitacion, Licitacion, Moneda, PersonaERP } from "./tipos";
import { aniosCumplidos, fechaDMY, fechaONull, fmtImporte } from "./util";

export type NombreVariable =
  | "empresa" | "razon_social" | "ruc" | "direccion" | "telefono" | "email" | "web" | "autorizacion"
  | "cliente" | "concurso" | "objeto" | "atencion" | "fecha_presentacion" | "fecha_inicio" | "plazo_meses"
  | "representante" | "dni_representante" | "cargo_representante"
  | "n_unidades" | "n_titulares" | "n_reten" | "n_conductores" | "n_relevo" | "asientos_ofertados"
  | "anios_experiencia" | "total_experiencia";

/** El catálogo CERRADO de variables, con lo que pone cada una (de dónde sale el dato). */
export const VARIABLES: readonly { nombre: NombreVariable; descripcion: string }[] = [
  { nombre: "empresa", descripcion: "Nombre de la empresa (perfil de la empresa)" },
  { nombre: "razon_social", descripcion: "Razón social (perfil de la empresa)" },
  { nombre: "ruc", descripcion: "RUC de la empresa (perfil)" },
  { nombre: "direccion", descripcion: "Dirección de la empresa (perfil)" },
  { nombre: "telefono", descripcion: "Teléfono de la empresa (perfil)" },
  { nombre: "email", descripcion: "Correo de la empresa (perfil)" },
  { nombre: "web", descripcion: "Sitio web de la empresa (perfil)" },
  { nombre: "autorizacion", descripcion: "Autorización de transporte del regulador (perfil)" },
  { nombre: "cliente", descripcion: "Nombre del cliente de esta licitación" },
  { nombre: "concurso", descripcion: "Código del concurso" },
  { nombre: "objeto", descripcion: "Objeto del servicio (datos del concurso)" },
  { nombre: "atencion", descripcion: "A la atención de (datos del concurso)" },
  { nombre: "fecha_presentacion", descripcion: "Fecha de presentación (dd/mm/aaaa)" },
  { nombre: "fecha_inicio", descripcion: "Fecha de inicio del servicio (dd/mm/aaaa)" },
  { nombre: "plazo_meses", descripcion: "Plazo del servicio en meses" },
  { nombre: "representante", descripcion: "Nombre del representante legal" },
  { nombre: "dni_representante", descripcion: "DNI del representante legal" },
  { nombre: "cargo_representante", descripcion: "Cargo del representante legal" },
  { nombre: "n_unidades", descripcion: "Unidades ofertadas (titulares + retén)" },
  { nombre: "n_titulares", descripcion: "Unidades titulares" },
  { nombre: "n_reten", descripcion: "Unidades de retén" },
  { nombre: "n_conductores", descripcion: "Conductores asignados (titulares + relevo)" },
  { nombre: "n_relevo", descripcion: "Conductores de relevo" },
  { nombre: "asientos_ofertados", descripcion: "Suma de asientos de las unidades titulares (de sus fichas)" },
  { nombre: "anios_experiencia", descripcion: "Años desde el primer contrato de la experiencia elegida" },
  { nombre: "total_experiencia", descripcion: "Importe total de la experiencia elegida, por moneda (nunca se suman monedas)" },
];
const NOMBRES = new Set<string>(VARIABLES.map((v) => v.nombre));
export const esVariable = (x: string): x is NombreVariable => NOMBRES.has(x);

export type ValoresVariables = Record<NombreVariable, string | null>;

const v = (x: unknown): string => (typeof x === "string" ? x.trim() : "");
const oNull = (x: unknown): string | null => v(x) || null;

/** Fecha de referencia de la licitación: la de presentación o, si falta, hoy. */
export const fechaRef = (lic: Licitacion, ctx: ContextoLicitacion) => fechaONull(lic.fecha_presentacion) ?? ctx.hoy;

/** El representante con sus datos DERIVADOS (personalId → personal_administrativo). */
export function representanteDe(doc: DocLicitacion, ctx: ContextoLicitacion): {
  nombre: string; dni: string; cargo: string; firmaUrl: string | null; desdePersonal: boolean; personalNoEncontrado: boolean;
} {
  const r = doc.representante;
  const firmaUrl = r.firma?.url ?? null;
  if (r.personalId != null) {
    const p: PersonaERP | undefined = ctx.personal?.[r.personalId];
    return { nombre: v(p?.nombre), dni: v(p?.dni), cargo: v(p?.cargo), firmaUrl, desdePersonal: true, personalNoEncontrado: !p };
  }
  return { nombre: v(r.nombre), dni: v(r.dni), cargo: v(r.cargo), firmaUrl, desdePersonal: false, personalNoEncontrado: false };
}

/** Un contacto con sus datos derivados. */
export function contactoDe(c: DocLicitacion["contactos"][number], ctx: ContextoLicitacion): { rol: string; nombre: string; cargo: string; telefono: string; email: string; personalNoEncontrado: boolean } {
  if (c.personalId != null) {
    const p = ctx.personal?.[c.personalId];
    return { rol: c.rol, nombre: v(p?.nombre), cargo: v(p?.cargo), telefono: v(p?.telefono), email: v(p?.email), personalNoEncontrado: !p };
  }
  return { rol: c.rol, nombre: c.nombre, cargo: c.cargo, telefono: c.telefono, email: c.email, personalNoEncontrado: false };
}

/** Totales de la experiencia elegida POR MONEDA (nunca se suman PEN y USD), en orden PEN, USD. */
export function totalesExperiencia(doc: DocLicitacion, ctx: ContextoLicitacion): { moneda: Moneda; importe: number; n: number }[] {
  const acc: Record<Moneda, { importe: number; n: number }> = { PEN: { importe: 0, n: 0 }, USD: { importe: 0, n: 0 } };
  for (const id of doc.experiencia.ids) {
    const e = ctx.experiencia?.[id];
    if (!e || e.importe == null || !Number.isFinite(e.importe)) continue;
    const m: Moneda = e.moneda === "USD" ? "USD" : "PEN";
    acc[m].importe += e.importe; acc[m].n++;
  }
  return (["PEN", "USD"] as Moneda[]).filter((m) => acc[m].n > 0).map((m) => ({ moneda: m, importe: Math.round(acc[m].importe * 100) / 100, n: acc[m].n }));
}

/** El valor de cada variable para esta licitación; null = no hay dato (la variable queda visible). */
export function valoresVariables(lic: Licitacion, ctx: ContextoLicitacion): ValoresVariables {
  const doc = lic.doc;
  const p = ctx.perfil;
  const emp = empresaConDefectos(p);
  const rep = representanteDe(doc, ctx);
  const cuenta = (n: number) => (n > 0 ? String(n) : null);
  const titulares = doc.unidades.filter((u) => u.rol === "titular");
  let asientos: number | null = titulares.length ? 0 : null;
  for (const u of titulares) {
    const cap = ctx.unidades?.[u.clave]?.capacidad;
    if (asientos === null || !cap || cap <= 0) { asientos = null; break; }
    asientos += cap;
  }
  const inicios = doc.experiencia.ids.map((id) => fechaONull(ctx.experiencia?.[id]?.inicio)).filter((f): f is string => !!f).sort();
  const ref = fechaRef(lic, ctx);
  const anios = inicios.length ? aniosCumplidos(inicios[0], ref) : null;
  const totales = totalesExperiencia(doc, ctx);
  return {
    empresa: emp.sinConfigurar ? null : emp.nombre,
    razon_social: oNull(p?.razon_social) ?? (emp.sinConfigurar ? null : emp.nombre),
    ruc: oNull(p?.ruc), direccion: oNull(p?.direccion), telefono: oNull(p?.telefono),
    email: oNull(p?.email), web: oNull(p?.web), autorizacion: oNull(p?.autorizacion_mtc),
    cliente: oNull(lic.cliente_nombre), concurso: oNull(lic.codigo), objeto: oNull(lic.objeto), atencion: oNull(lic.atencion),
    fecha_presentacion: fechaONull(lic.fecha_presentacion) ? fechaDMY(lic.fecha_presentacion) : null,
    fecha_inicio: fechaONull(lic.fecha_inicio_servicio) ? fechaDMY(lic.fecha_inicio_servicio) : null,
    plazo_meses: lic.plazo_meses ? String(lic.plazo_meses) : null,
    representante: rep.nombre || null, dni_representante: rep.dni || null, cargo_representante: rep.cargo || null,
    n_unidades: cuenta(doc.unidades.length), n_titulares: cuenta(titulares.length),
    n_reten: cuenta(doc.unidades.filter((u) => u.rol === "reten").length),
    n_conductores: cuenta(doc.conductores.length), n_relevo: cuenta(doc.conductores.filter((c) => c.rol === "relevo").length),
    asientos_ofertados: asientos ? String(asientos) : null,
    anios_experiencia: anios !== null && anios > 0 ? String(anios) : null,
    total_experiencia: totales.length ? totales.map((t) => fmtImporte(t.importe, t.moneda)).join(" · ") : null,
  };
}

const RE_VARIABLE = /\{([a-z][a-z0-9_]{0,40})\}/g;

/**
 * Pone el valor de cada variable conocida que lo tenga. Sin valor (o desconocida) queda visible TAL CUAL:
 * `faltan` nombra las conocidas sin valor y `desconocidas` las que no son del catálogo.
 */
export function resolverVariables(t: string, valores: Partial<Record<string, string | null>>): { texto: string; faltan: string[]; desconocidas: string[] } {
  const faltan = new Set<string>(), desconocidas = new Set<string>();
  const texto = (t ?? "").replace(RE_VARIABLE, (todo, nombre: string) => {
    if (!esVariable(nombre)) { desconocidas.add(nombre); return todo; }
    const val = valores[nombre];
    if (val == null || val === "") { faltan.add(nombre); return todo; }
    return val;
  });
  return { texto, faltan: [...faltan], desconocidas: [...desconocidas] };
}

/** Trozos de texto con o sin negrita. Solo `**…**` (cerrado) es negrita; lo demás es literal. */
export function trozosDe(t: string): { texto: string; negrita: boolean }[] {
  const out: { texto: string; negrita: boolean }[] = [];
  const s = t ?? "";
  const re = /\*\*([\s\S]+?)\*\*/g;
  let i = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > i) out.push({ texto: s.slice(i, m.index), negrita: false });
    out.push({ texto: m[1], negrita: true });
    i = re.lastIndex;
  }
  if (i < s.length) out.push({ texto: s.slice(i), negrita: false });
  return out;
}

// ══ Autorización del regulador ═════════════════════════════════════════════════

const RE_RD = /(?:\bR\.\s?D\.?|\bRD\b|\bResoluci[oó]n\s+Directoral)\s*(?:N\s*[°º]\.?|Nro\.?|No\.|N\.)?\s*(\d[\w\-/.]*\w)/g;

/** Los números de resolución directoral que trae un texto («R.D. N° 0450-2020-MTC/17.02» → «0450-2020-MTC/17.02»). */
export function tokensAutorizacion(t: string): string[] {
  return [...(t ?? "").matchAll(RE_RD)].map((m) => m[1]);
}

const normalAut = (t: string) => t.toUpperCase().replace(/[^0-9A-Z]/g, "");
const nucleoAut = (t: string) => { const m = t.match(/^(\d+)\D+?(\d{4})(?!\d)/); return m ? `${Number(m[1])}-${m[2]}` : null; };

/**
 * ¿Es la MISMA resolución? Por su núcleo «número-año» si los dos lo tienen (así «R.D. 0450-2020» y
 * «0450-2020-MTC/17.02» son la misma); si no, por el texto sin signos. Nunca decide cuál es la correcta.
 */
export function mismaAutorizacion(a: string, b: string): boolean {
  const na = nucleoAut(a), nb = nucleoAut(b);
  if (na && nb) return na === nb;
  return normalAut(a) === normalAut(b);
}

/** El número de la autorización del perfil (con o sin el «R.D. N°» delante). */
export function autorizacionDelPerfil(valor: string | null | undefined): string | null {
  const s = v(valor);
  if (!s) return null;
  return tokensAutorizacion(s)[0] ?? s.replace(/[.\s]+$/, "");
}

// ══ Escaneo ════════════════════════════════════════════════════════════════════

export type LugarTexto = {
  tipo: "portada" | "control" | "carta" | "glosario" | "seccion" | "bloque" | "cierre" | "requisito" | "consulta" | "experiencia" | "bloque_expediente";
  id: string; rotulo: string;
  /** El texto es de un bloque automático (su contenido lo arma el ERP). */
  auto: boolean;
};
export type EscaneoTexto = {
  completar: { lugar: LugarTexto; veces: number }[];
  variables: { lugar: LugarTexto; nombre: string; conocida: boolean }[];
  otraLicitacion: { lugar: LugarTexto; mencion: string; deQuien: string }[];
  flotaPropia: { lugar: LugarTexto; frase: string }[];
  autorizaciones: { lugar: LugarTexto; token: string }[];
};

const NOMBRE_BLOQUE: Record<string, string> = {
  parrafo: "párrafo", nota: "nota", subtitulo: "subtítulo", vinetas: "viñetas", tabla: "tabla", imagen: "pie de imagen", auto: "tabla automática", salto_pagina: "salto de página",
};

/** Los textos que se imprimen, con dónde están. */
export function textosImpresos(doc: DocLicitacion): { lugar: LugarTexto; texto: string }[] {
  const out: { lugar: LugarTexto; texto: string }[] = [];
  const add = (lugar: LugarTexto, ...ts: (string | null | undefined)[]) => {
    const t = ts.filter((x): x is string => typeof x === "string" && x.trim() !== "").join("\n");
    if (t) out.push({ lugar, texto: t });
  };
  const L = (tipo: LugarTexto["tipo"], id: string, rotulo: string, auto = false): LugarTexto => ({ tipo, id, rotulo, auto });
  add(L("portada", "portada", "Portada"), doc.portada.titulo, doc.portada.subtitulo, doc.portada.cabecera);
  const c = doc.control;
  if (c.activo) add(L("control", "control", "Control del documento"), c.documento, c.version, c.codigo, c.elaboradoPor, c.revisadoPor, c.aprobadoPor, c.confidencialidad);
  const k = doc.carta;
  if (k.activa) add(L("carta", "carta", "Carta de presentación"), k.lugarFecha, k.destinatario, k.atencion, k.referencia, k.cuerpo, k.despedida);
  if (doc.glosario.activo) for (const e of doc.glosario.entradas) add(L("glosario", e.id, `Glosario · ${e.termino || "término"}`), e.termino, e.definicion);
  let hayMatriz = false, hayAbsolucion = false, hayCuadro = false;
  let nSec = 0;
  for (const s of doc.secciones) {
    if (!s.activa) continue;
    nSec++;
    const rot = `Sección ${nSec} · ${s.titulo || "sin título"}`;
    add(L("seccion", s.id, rot), s.titulo);
    for (const [k, b] of s.bloques.entries()) {
      const lb = (auto = false) => L("bloque", b.id, `${rot} · ${NOMBRE_BLOQUE[b.tipo] ?? "bloque"} ${k + 1}`, auto);
      switch (b.tipo) {
        case "parrafo": case "nota": add(lb(), b.texto); break;
        case "subtitulo": add(lb(), b.texto); break;
        case "vinetas": add(lb(), ...b.items); break;
        case "tabla": add(lb(), b.titulo, ...b.columnas, ...b.filas.flat()); break;
        case "imagen": add(lb(), b.pie); break;
        case "auto":
          if (b.auto === "matriz_cumplimiento") hayMatriz = true;
          if (b.auto === "absolucion_consultas") hayAbsolucion = true;
          if (b.auto === "cuadro_experiencia") hayCuadro = true;
          add(lb(true), b.titulo, ...b.filasExtra.flat());
          break;
        default: break;
      }
    }
  }
  if (doc.cierre.activo) add(L("cierre", "cierre", "Cierre"), doc.cierre.texto);
  if (hayMatriz) for (const q of doc.requisitos) if (q.enMatriz) add(L("requisito", q.id, `Requisito ${q.numeral ?? ""}`.trim()), q.texto, q.cumpleTexto, q.sustento);
  if (hayAbsolucion) for (const q of doc.consultas) add(L("consulta", q.id, `Consulta ${q.numero ?? ""}`.trim()), q.pregunta, q.respuesta, q.incorporacion);
  if (hayCuadro || doc.expediente.bloques.some((b) => b.activo && b.items.some((i) => i.incluido && i.fuente.tipo === "cuadro_experiencia")))
    add(L("experiencia", "experiencia", "Introducción del cuadro de experiencia"), doc.experiencia.introduccion);
  for (const b of doc.expediente.bloques) if (b.activo) add(L("bloque_expediente", b.id, `Separador · ${b.titulo || b.subtitulo || "bloque"}`), b.titulo, b.subtitulo, b.referencia);
  return out;
}

const SEPARADORES = /\s+[-–—]+\s+|\(|,|\/|·/;

/** El nombre completo y su primer tramo («MASS – CD Villa El Salvador» → también «MASS»), normalizados, ≥ 4 caracteres. */
export function variantesNombre(nombre: string | null | undefined): string[] {
  const s = v(nombre);
  if (!s) return [];
  const out = new Set<string>();
  const full = normalizarBusqueda(s);
  if (full.length >= 4) out.add(full);
  const cabeza = normalizarBusqueda(s.split(SEPARADORES)[0] ?? "");
  if (cabeza.length >= 4) out.add(cabeza);
  return [...out];
}

const contienePalabras = (texto: string, frase: string) => ` ${texto} `.includes(` ${frase} `);

/** «flota y personal propios», «unidades propias», «con propia flota» (sobre el texto normalizado). */
const RE_FLOTA_PROPIA = [
  /\b(?:flotas?|unidades|vehiculos|buses|personal|conductores|choferes)\b(?: [a-z0-9]+){0,3}? (?:propias?|propios?)\b/,
  /\b(?:propias?|propios?) (?:flotas?|unidades|vehiculos|buses|personal|conductores|choferes)\b/,
];

/** La frase que afirma que la flota o el personal son propios, o null. */
export function fraseFlotaPropia(texto: string): string | null {
  const n = normalizarBusqueda(texto);
  for (const re of RE_FLOTA_PROPIA) { const m = n.match(re); if (m) return m[0]; }
  return null;
}

/** La evidencia que la revisión necesita sobre el texto impreso. */
export function escanearTexto(lic: Licitacion, ctx: ContextoLicitacion): EscaneoTexto {
  const doc = lic.doc;
  const valores = valoresVariables(lic, ctx);
  const res: EscaneoTexto = { completar: [], variables: [], otraLicitacion: [], flotaPropia: [], autorizaciones: [] };

  // Menciones de OTRA licitación: sus clientes y códigos (y los de la licitación de la que se copió),
  // menos el cliente actual y los clientes de la experiencia elegida (esos se nombran a propósito).
  const excluir = new Set<string>([
    ...variantesNombre(lic.cliente_nombre),
    ...(lic.codigo ? [normalizarBusqueda(lic.codigo)] : []),
    ...doc.experiencia.ids.flatMap((id) => variantesNombre(ctx.experiencia?.[id]?.cliente_nombre)),
  ].filter(Boolean));
  const excluido = (cand: string) => [...excluir].some((x) => x === cand || contienePalabras(x, cand) || contienePalabras(cand, x));
  const candidatos = new Map<string, string>();     // mención normalizada → de quién
  const fuentes = [
    ...(ctx.otras ?? []).filter((o) => o.id !== lic.id).map((o) => ({ nombres: [o.cliente_nombre, o.cliente_erp], codigo: o.codigo, quien: o.nombre || o.cliente_nombre })),
    ...(doc.copiaDe ? [{ nombres: [doc.copiaDe.cliente_nombre], codigo: doc.copiaDe.codigo, quien: `la licitación de la que se copió (${doc.copiaDe.cliente_nombre})` }] : []),
  ];
  for (const f of fuentes) {
    const cands = [...f.nombres.flatMap(variantesNombre), ...(f.codigo ? [normalizarBusqueda(f.codigo)].filter((c) => c.length >= 4) : [])];
    for (const c of cands) if (!excluido(c) && !candidatos.has(c)) candidatos.set(c, f.quien);
  }

  for (const { lugar, texto } of textosImpresos(doc)) {
    const veces = (texto.match(/\[\s*COMPLETAR\b[^\]]{0,200}\]/gi) ?? []).length;
    if (veces) res.completar.push({ lugar, veces });
    const vistas = new Set<string>();
    for (const m of texto.matchAll(RE_VARIABLE)) {
      const nombre = m[1];
      if (vistas.has(nombre)) continue;
      vistas.add(nombre);
      const conocida = esVariable(nombre);
      if (!conocida || !valores[nombre as NombreVariable]) res.variables.push({ lugar, nombre, conocida });
    }
    if (!lugar.auto && candidatos.size) {
      const n = normalizarBusqueda(texto);
      for (const [c, quien] of candidatos) if (contienePalabras(n, c)) res.otraLicitacion.push({ lugar, mencion: c, deQuien: quien });
    }
    const frase = fraseFlotaPropia(texto);
    if (frase) res.flotaPropia.push({ lugar, frase });
    for (const token of tokensAutorizacion(texto)) res.autorizaciones.push({ lugar, token });
  }
  return res;
}
