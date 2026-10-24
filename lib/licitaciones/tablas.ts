// lib/licitaciones/tablas.ts — Las tablas que salen del ERP, armadas UNA vez para la propuesta y para el
// expediente. Módulo PURO.
//
// La relación de unidades de la sección 7 y la del bloque III del expediente son la MISMA tabla: si se
// armaran en dos sitios, el día que una cambie el cliente vería dos placas distintas para U1. Todo dato
// que falta se imprime «—», nunca un cero.

import { empresaConDefectos } from "../empresa-perfil";
import { resumenUnidad } from "./recursos";
import { contactoDe, fechaRef, representanteDe, resolverVariables, totalesExperiencia, valoresVariables } from "./texto";
import type {
  ContextoLicitacion, CuadroExperiencia, Experiencia, Licitacion, SustentoTipo, TablaPlano, UnidadElegida,
} from "./tipos";
import { compararCodigo, fechaLarga, fechaONull, fmtImporte, mesAnio, RAYA } from "./util";

const t = (x: unknown): string => (typeof x === "string" && x.trim() ? x.trim() : RAYA);

/** Las unidades en orden de código (U2 antes que U10; sin código al final), estable. */
export function unidadesPorCodigo(lic: Licitacion): UnidadElegida[] {
  return lic.doc.unidades.map((u, k) => ({ u, k })).sort((a, b) => compararCodigo(a.u.codigo, b.u.codigo) || a.k - b.k).map((x) => x.u);
}

/** Relación de unidades: «Código | Uso | Tipo | Marca / modelo | Placa | Año», como la propuesta real. */
export function tablaRelacionUnidades(lic: Licitacion, ctx: ContextoLicitacion): TablaPlano {
  const ref = fechaRef(lic, ctx);
  return {
    columnas: ["Código", "Uso", "Tipo", "Marca / modelo", "Placa", "Año"],
    filas: unidadesPorCodigo(lic).map((el) => {
      const u = ctx.unidades?.[el.clave];
      const r = u ? resumenUnidad(u, { presentacion: ref, inicio: null }) : null;
      const uso = el.uso.trim() || (el.rol === "reten" ? "Retén" : RAYA);
      return [t(el.codigo), uso, t(r?.tipo), t(r?.marcaModelo), t(u?.placa), u?.anio ? String(u.anio) : RAYA];
    }),
    pie: null,
  };
}

/** Relación de conductores: rol, nombre, licencia, categoría, vencimiento y unidad. */
export function tablaConductores(lic: Licitacion, ctx: ContextoLicitacion): TablaPlano {
  const orden = [...lic.doc.conductores].sort((a, b) => (a.rol === b.rol ? 0 : a.rol === "titular" ? -1 : 1));
  return {
    columnas: ["Rol", "Conductor", "Licencia", "Categoría", "Vence la licencia", "Unidad"],
    filas: orden.map((el) => {
      const c = ctx.conductores?.[el.clave];
      return [
        el.rol === "relevo" ? "Relevo" : "Titular", t(c?.nombre), t(c?.licencia), t(c?.categoria_licencia),
        c?.vencimiento_licencia ? fechaDMYcorto(c.vencimiento_licencia) : RAYA, t(el.unidadCodigo),
      ];
    }),
    pie: null,
  };
}

const fechaDMYcorto = (f: string) => { const s = fechaONull(f); if (!s) return RAYA; const [a, m, d] = s.split("-"); return `${d}/${m}/${a}`; };

/** Contactos del contrato (datos derivados del personal cuando están enlazados). */
export function tablaContactos(lic: Licitacion, ctx: ContextoLicitacion): TablaPlano {
  return {
    columnas: ["Rol", "Nombre", "Teléfono", "Correo"],
    filas: lic.doc.contactos.map((c) => { const d = contactoDe(c, ctx); return [t(d.rol), t(d.nombre), t(d.telefono), t(d.email)]; }),
    pie: null,
  };
}

const SUSTENTO_ETIQUETA: Record<SustentoTipo, string> = { oc: "OC", factura: "Factura", carta: "Carta", contrato: "Contrato", conformidad: "Conformidad", otro: "Otro" };

/** Las experiencias elegidas que existen, en el orden en que se eligieron. */
export function experienciasElegidas(lic: Licitacion, ctx: ContextoLicitacion): Experiencia[] {
  return lic.doc.experiencia.ids.map((id) => ctx.experiencia?.[id]).filter((e): e is Experiencia => !!e);
}

/** Filas del cuadro de experiencia (el importe va en la ÚLTIMA columna). */
export function tablaExperiencia(lic: Licitacion, ctx: ContextoLicitacion, conContacto: boolean): TablaPlano {
  const columnas = ["N.º", "Cliente", ...(conContacto ? ["Datos de contacto"] : []), "Objeto", "Inicio", "Fin", "OC / Comprob.", "Fecha", "Ruta / Zona", "Importe"];
  const filas = experienciasElegidas(lic, ctx).map((e, k) => {
    const contacto = [e.contacto_nombre, e.contacto_telefono].filter((x) => x && x.trim()).join(" – ");
    return [
      String(k + 1), t(e.cliente_nombre), ...(conContacto ? [contacto || RAYA] : []), t(e.objeto),
      mesAnio(e.inicio), e.vigente ? "Vigente" : mesAnio(e.fin),
      e.sustento_tipo ? [SUSTENTO_ETIQUETA[e.sustento_tipo], e.sustento_ref].filter(Boolean).join(" ") : RAYA,
      e.sustento_fecha ? fechaDMYcorto(e.sustento_fecha) : RAYA, t(e.zona),
      e.importe == null ? RAYA : fmtImporte(e.importe, e.moneda === "USD" ? "USD" : "PEN"),
    ];
  });
  return { columnas, filas, pie: null };
}

/**
 * El cuadro de experiencia del expediente (anexo firmado). `encabezado[0]` es el título y el resto el
 * destinatario; `tabla.pie` va null para que el PDF arme el «TOTAL:» con un importe POR MONEDA.
 * `lugarFecha`: el de la carta de presentación si existe; si no, la fecha (presentación u hoy) en letras.
 */
export function cuadroExperiencia(lic: Licitacion, ctx: ContextoLicitacion, titulo?: string | null): CuadroExperiencia {
  const doc = lic.doc;
  const vals = valoresVariables(lic, ctx);
  const rep = representanteDe(doc, ctx);
  const res = (s: string) => resolverVariables(s, vals).texto;
  const destino = [lic.nombre && lic.nombre !== lic.cliente_nombre ? lic.nombre : null, lic.codigo ? `Concurso ${lic.codigo}` : null].filter(Boolean).join(" · ");
  const lugarCarta = doc.carta.activa ? res(doc.carta.lugarFecha).trim() : "";
  return {
    encabezado: [
      (titulo && titulo.trim()) || "Experiencia de la empresa concursante",
      "Señores",
      ...(lic.cliente_nombre.trim() ? [`**${lic.cliente_nombre.trim().toUpperCase()}**`] : []),
      ...(destino ? [destino] : []),
      "Presente.-",
    ],
    introduccion: res(doc.experiencia.introduccion).trim(),
    tabla: tablaExperiencia(lic, ctx, doc.experiencia.conContacto),
    totales: totalesExperiencia(doc, ctx).map(({ moneda, importe }) => ({ moneda, importe })),
    firmante: rep.nombre ? { nombre: rep.nombre, dni: rep.dni, cargo: rep.cargo, firmaUrl: rep.firmaUrl } : null,
    lugarFecha: lugarCarta || fechaLarga(fechaRef(lic, ctx)),
  };
}

/** La cabecera de cada hoja: la de la portada o «empresa · concurso». */
export function cabeceraDe(lic: Licitacion, ctx: ContextoLicitacion): string {
  const vals = valoresVariables(lic, ctx);
  const propia = resolverVariables(lic.doc.portada.cabecera, vals).texto.trim();
  if (propia) return propia;
  const emp = empresaConDefectos(ctx.perfil);
  return ["Propuesta Técnica", lic.cliente_nombre.trim() || null, lic.codigo, emp.sinConfigurar ? null : emp.nombre].filter(Boolean).join(" · ");
}
