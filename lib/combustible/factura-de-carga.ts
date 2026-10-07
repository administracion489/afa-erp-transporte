// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/factura-de-carga.ts — Motor PURO: QUÉ FACTURA DEL CORREO respalda una carga (o
// espera a una recarga del Radar), qué línea es la suya, qué adjunto del correo es el documento, y
// cómo se abre ese correo en Gmail. No lee la base.
//
// LO PIDIÓ EL DUEÑO sobre el recuadro de fusión del Radar (CWQ400, 18/09, carga #63 que registró una
// factura de COESTI): «aquí falta un link hacia el correo que se leyó, para poder revisar el
// documento». El recuadro decía QUÉ carga era y qué iba a cambiar, pero para verificarlo contra el
// papel había que ir a /combustible → Facturas, buscar esa factura entre cientos, desplegarla y abrir
// Gmail desde ahí.
//
// DOS PUERTAS, porque sirven a gente distinta:
//   • «📄 Ver la factura»: el ERP baja el PDF (o el XML) del correo con la MISMA credencial con que lo
//     lee (lib/combustible/facturas-correo.ts → documentoDeFactura) y lo enseña en la misma pantalla.
//     Funciona para cualquier operador: el buzón de facturas es de administración, y quien revisa el
//     Radar no tiene por qué tener esa cuenta abierta en su navegador.
//   • «✉ Abrir el correo en Gmail»: para quien sí la tiene. Se abre en la CUENTA del buzón conectado
//     (`/mail/u/<correo>/`), no en `u/0` —la primera cuenta abierta en el navegador—, que es como lo
//     abría la pestaña de Facturas: con dos cuentas abiertas, Gmail buscaba el correo en la
//     equivocada y contestaba que no existía.
//
// QUÉ FACTURA ES LA DE UNA CARGA se contesta con lo que la conciliación DEJÓ ESCRITO, del dato más
// fuerte al más débil: la línea cuyo plan nombra a esa carga (`registrar` → combustible_id,
// `ya_registrada` → casa_con: la misma regla que `origenesDeCargas`), y si ninguna la nombra, la del
// comprobante que la carga lleva escrito (sus columnas fiscales, o la marca de
// `observacionCargaDeFactura`). Nunca se BUSCA por placa, fecha o importe: eso sería adivinar qué
// papel respalda un gasto, y enseñar el de otra carga como si fuera el suyo es peor que no enseñar
// ninguno.
// ──────────────────────────────────────────────────────────────────────────────

import { referenciaEnObservacion, esNombreComprobante, elegirXmlComprobante, type LineaFactura, type PlanLinea } from "@/lib/combustible/factura-lineas";

/** El comprobante de una factura, como lo guarda `radar_facturas` (serie y número por separado). */
export type RefFactura = { serie: string; numero: string };

const limpio = (s: unknown): string => String(s ?? "").trim();

/**
 * El comprobante que respalda una carga, o null. Primero las columnas fiscales (las escribe la
 * conciliación al registrar la carga y al ENLAZAR una que ya existía); si no están —migración
 * accesoria sin correr—, la marca de `observacionCargaDeFactura`, partida en el primer guion: es
 * `${serie}-${numero}` tal como la conciliación los leyó, y la serie no lleva guion.
 */
export function referenciaFacturaDeCarga(c: {
  observaciones?: string | null;
  comprobante_serie?: string | null;
  comprobante_numero?: string | null;
}): RefFactura | null {
  const serie = limpio(c.comprobante_serie), numero = limpio(c.comprobante_numero);
  if (serie && numero) return { serie, numero };
  const ref = referenciaEnObservacion(c.observaciones);
  if (!ref) return null;
  const i = ref.indexOf("-");
  if (i <= 0 || i >= ref.length - 1) return null;
  return { serie: ref.slice(0, i), numero: ref.slice(i + 1) };
}

/** Una fila de `radar_facturas`, con lo que hace falta para enseñarla junto a su carga. */
export type FacturaGuardada = {
  id: number;
  gmail_message_id?: string | null;
  serie?: string | null;
  numero?: string | null;
  razon_social?: string | null;
  ruc_emisor?: string | null;
  fecha_emision?: string | null;
  recibido_en?: string | null;
  total?: number | null;
  fuente_extraccion?: string | null;
  estado?: string | null;
  lineas?: LineaFactura[] | null;
  conciliacion?: (PlanLinea & { combustible_id?: number | string | null })[] | null;
};

export type FacturaYLinea = {
  factura: FacturaGuardada;
  /** La línea de ESA carga (o de esa recarga), si la conciliación la nombra. */
  linea: LineaFactura | null;
  plan: PlanLinea | null;
  /** Cómo se la encontró: la conciliación nombra a la carga, o solo coincide el comprobante. */
  por: "conciliacion" | "comprobante";
};

const reciente = (a: FacturaGuardada, b: FacturaGuardada) =>
  String(b.recibido_en ?? "").localeCompare(String(a.recibido_en ?? "")) || b.id - a.id;

/** ¿Este plan de línea nombra a esa carga? La misma regla que `origenesDeCargas`. */
const nombraCarga = (p: PlanLinea & { combustible_id?: number | string | null }, cargaId: number): boolean =>
  (p.codigo === "registrar" && Number(p.combustible_id) === cargaId) ||
  (p.codigo === "ya_registrada" && (Number(p.casa_con) === cargaId || Number(p.combustible_id) === cargaId));

function conLinea(f: FacturaGuardada, p: PlanLinea | null, por: FacturaYLinea["por"]): FacturaYLinea {
  const lineas = Array.isArray(f.lineas) ? f.lineas : [];
  return { factura: f, plan: p, linea: p ? lineas.find((l) => l.n === p.n) ?? null : null, por };
}

/**
 * La factura de una carga entre las filas que la base devolvió (por su comprobante, o porque su
 * conciliación la nombra). Gana la que NOMBRA a la carga —con su línea—; si ninguna la nombra, la
 * del mismo comprobante, la más reciente (el mismo correo reenviado deja dos filas). null = no hay
 * ninguna que la respalde: no se enseña otra.
 */
export function elegirFacturaDeCarga(
  carga: { id: number } & Parameters<typeof referenciaFacturaDeCarga>[0],
  filas: readonly FacturaGuardada[],
): FacturaYLinea | null {
  const lista = [...(filas ?? [])].filter((f) => f && Number.isFinite(Number(f.id))).sort(reciente);
  for (const f of lista) {
    const p = (Array.isArray(f.conciliacion) ? f.conciliacion : []).find((x) => nombraCarga(x, Number(carga.id)));
    if (p) return conLinea(f, p, "conciliacion");
  }
  const ref = referenciaFacturaDeCarga(carga);
  if (!ref) return null;
  const mismo = lista.find((f) => limpio(f.serie) === ref.serie && limpio(f.numero) === ref.numero);
  return mismo ? conLinea(mismo, null, "comprobante") : null;
}

/** La factura que ESPERA a una recarga del Radar por revisar (`en_radar_pendiente` → casa_con). */
export function elegirFacturaQueEspera(radarId: string, filas: readonly FacturaGuardada[]): FacturaYLinea | null {
  for (const f of [...(filas ?? [])].sort(reciente)) {
    const p = (Array.isArray(f.conciliacion) ? f.conciliacion : [])
      .find((x) => x?.codigo === "en_radar_pendiente" && x.casa_con != null && String(x.casa_con) === String(radarId));
    if (p) return conLinea(f, p, "conciliacion");
  }
  return null;
}

/**
 * Cómo se pide a la base la factura que espera a esa recarga: el MISMO texto JSON para quien escribe
 * el plan y quien lo busca (la trampa de `.contains()` con arrays que documenta FILTRO_HISTORICO).
 */
export const filtroFacturaQueEspera = (radarId: string): string =>
  JSON.stringify([{ codigo: "en_radar_pendiente", casa_con: radarId }]);

// ── El documento ─────────────────────────────────────────────────────────────

export type DocumentoElegido = { indice: number; tipo: "pdf" | "xml" };

/**
 * Qué adjunto del correo se enseña como «la factura». Del más legible al menos:
 *   1. el PDF con nombre de comprobante electrónico (lo que imprime el grifo);
 *   2. el XML del comprobante (`elegirXmlComprobante`: nunca la CDR de SUNAT, que no es la factura);
 *   3. cualquier otro PDF — se enseña con su nombre, que dice lo que es.
 * `texto` solo hace falta en los XML (el comprobante se reconoce por su contenido). `inicio` son los
 * primeros bytes del archivo: un «.pdf» que no empieza por `%PDF-` NO es un PDF —el correo lo manda
 * cualquiera, y lo que se enseña como PDF se abre como PDF— y no se elige. Sin `inicio` se juzga por
 * el nombre.
 */
export function elegirDocumentoFactura(
  adjuntos: readonly { nombre: string; texto?: string | null; inicio?: string | null }[],
): DocumentoElegido | null {
  const lista = (adjuntos ?? []).map((a, indice) => ({ ...a, indice, nombre: String(a?.nombre ?? "") }));
  const esPdf = (a: { nombre: string; inicio?: string | null }) =>
    /\.pdf$/i.test(a.nombre) && (a.inicio == null || a.inicio.startsWith("%PDF-"));
  const pdfComprobante = lista.find((a) => esPdf(a) && esNombreComprobante(a.nombre));
  if (pdfComprobante) return { indice: pdfComprobante.indice, tipo: "pdf" };
  const xml = elegirXmlComprobante(
    lista.filter((a) => /\.xml$/i.test(a.nombre) && typeof a.texto === "string").map((a) => ({ ...a, texto: a.texto as string })),
  );
  if (xml) return { indice: xml.indice, tipo: "xml" };
  const pdf = lista.find((a) => esPdf(a));
  return pdf ? { indice: pdf.indice, tipo: "pdf" } : null;
}

/**
 * Con qué tipo se ENSEÑA cada documento, pase lo que pase con su nombre: un PDF como PDF (lo abre el
 * visor del navegador, aislado de la página) y un XML como TEXTO. Un XML abierto como documento corre
 * el código que traiga dentro, y ese correo lo puede mandar cualquiera: enseñado como texto, es texto.
 */
export const tipoParaMostrar = (tipo: DocumentoElegido["tipo"]): string =>
  tipo === "pdf" ? "application/pdf" : "text/plain; charset=utf-8";

// ── El correo en Gmail ───────────────────────────────────────────────────────

const ID_GMAIL = /^[0-9a-f]{6,32}$/i;
// Solo una dirección limpia va dentro de la ruta: nada que pueda cortarla (/ # ? espacios).
const CORREO = /^[^\s@/#?\\]+@[^\s@/#?\\]+\.[^\s@/#?\\]+$/;

/**
 * El enlace que abre ESE correo en Gmail. Con la dirección del buzón conectado se abre en esa cuenta
 * (`/mail/u/<correo>/`); sin ella, en la primera abierta (`u/0`), que es lo único que se puede decir.
 * null = el id no es de Gmail (una fila sin correo de origen): no se arma un enlace que no lleva a nada.
 */
export function enlaceGmail(messageId: string | null | undefined, correo?: string | null): string | null {
  const id = limpio(messageId);
  if (!ID_GMAIL.test(id)) return null;
  const c = limpio(correo).toLowerCase();
  return `https://mail.google.com/mail/u/${CORREO.test(c) ? c : "0"}/#all/${id}`;
}

/** Qué es esa factura PARA esa carga (o recarga), en palabras: cada caso se lee distinto. */
export function rotuloFactura(f: FacturaYLinea): string {
  switch (f.plan?.codigo) {
    case "registrar": return "La registró la factura";
    case "ya_registrada": return "La respalda la factura";
    case "en_radar_pendiente": return "La espera la factura";
    default: return "Lleva el comprobante de la factura";
  }
}

/** De dónde salieron los números de la factura, en palabras. */
export function fuenteDeLectura(fuente: string | null | undefined): string | null {
  return fuente === "xml_ubl" ? "leída del XML de SUNAT" : fuente === "vision_pdf" ? "leída del PDF con IA" : null;
}
