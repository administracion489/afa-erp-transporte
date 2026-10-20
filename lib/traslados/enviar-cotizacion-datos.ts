// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/enviar-cotizacion-datos.ts — Arma el PDF de una cotización de traslado desde SU
// FILA y lo envía por WhatsApp a quien la pidió. SOLO SERVIDOR (service-role). No crea clientes
// al importarse: el cliente de Supabase llega por parámetro.
//
// LO ENVÍAN DOS: la IA del CRM, justo después de su mensaje (`por: "automatico"`), y un ejecutivo
// desde la tarjeta del inbox (`por: "ejecutivo"`). Los dos pasan por aquí y por el MISMO reclamo:
//  · RECLAMO CONDICIONAL. La acción pasa de `pendiente` a `enviando` con un UPDATE que exige el
//    estado (y el plazo) que se acaba de leer: dos envíos a la vez no pueden ganar los dos, y el
//    cliente no recibe el PDF dos veces. `resuelta_at` guarda el plazo del reclamo (5 min): un
//    envío que muere a mitad se puede reintentar pasado ese plazo.
//  · SOLO AL `wa_id` DE LA CONVERSACIÓN. Nunca a `contacto.telefono`, que el modelo puede escribir
//    con `actualizar_contacto`.
//  · QUIEN LLAMA DICE DE QUÉ CONVERSACIÓN Y DE QUÉ COTIZACIÓN ES (`esperado`): la IA pasa las de su
//    turno y la tarjeta del inbox la conversación que tiene abierta. Si la acción es de otra, no se
//    reclama ni se toca (`cotizacion_ajena`): un id de acción equivocado no puede mandar el PDF de
//    otro cliente.
//  · LA URL QUE SE LE PASA A META ES FIRMADA, y si no se puede firmar NO se envía: `firmarUrl`
//    devuelve la original cuando falla, y en un bucket privado esa no se puede descargar.
//  · SI FALLA, LA ACCIÓN VUELVE A `pendiente` con el error escrito y una nota interna: el
//    ejecutivo la ve en la tarjeta y puede reintentar. Nada se da por enviado sin `meta_message_id`.
//  · EL PDF SE DERIVA DE LA FILA CADA VEZ: si un ejecutivo la corrigió en /cotizaciones, sale
//    corregida. La copia enviada queda en `crm-media` como constancia, referenciada por el mensaje.
//
// EL PDF ES EL DISEÑO CORPORATIVO de /cotizaciones (lib/cotizacion-corporativo.ts +
// lib/pdf-corporativo.ts). Para armarlo se leen el perfil (con sus cuentas), el cliente del ERP
// vinculado, el wa_id de la conversación, la plantilla de la cotización (`plantilla_pdf`, solo sus
// CUENTAS: las condiciones ya están copiadas en la fila; si no existe, no se puede leer o no dibuja
// el diseño corporativo, `corporativo` como antes) y la categoría con sus fotos (traslados-07).
// Cada columna de una migración accesoria se SUELTA solo si el error la nombra
// (lib/columna-faltante.ts): sin traslados-07 el PDF sale sin fotos y lo avisa; sin `plantilla_pdf`,
// las cuentas son las de `corporativo`.
// Las imágenes se bajan con LISTA BLANCA (el logo, solo del bucket `empresa` del propio Supabase,
// donde lo sube /configuracion/perfil; las fotos, solo del bucket `traslados-fotos`), sin
// redirecciones, 4 s y con tope de bytes. Un PNG se recorre ENTERO antes de dárselo a pdf-lib: sin
// animación (APNG), y su IDAT se infla AQUÍ con tope de salida — la «bomba» PNG. Los datos del
// cliente del ERP solo se imprimen si `clienteParaPdf` los verifica. Lo que falta (foto, logo,
// cuenta en la moneda, cliente sin verificar) se AVISA y no bloquea: `planEnvio` no cambia.
// ──────────────────────────────────────────────────────────────────────────────

import { BUCKET_CRM_MEDIA, asegurarBucket as asegurarBucketCrm } from "../crm-media";
import { enviarWhatsAppMedia, explicarErrorEnvioWhatsApp } from "../crm-meta";
import { phonePara as phoneParaUso } from "../whatsapp-numeros";
import { inflateSync } from "node:zlib";
import { faltaAlguna } from "../columna-faltante";
import { empresaConDefectos, type EmpresaResuelta, type PerfilEmpresa } from "../empresa-perfil";
import { docCorporativo, numeroCotizacion } from "../cotizacion-corporativo";
import type { PlantillaPdfCfg } from "../cotizacion-pdf";
import { disenoDe } from "../cotizacion-plantillas";
import { dibujarPdfCorporativo, type ImagenPdf } from "../pdf-corporativo";
import { fechaLima } from "../alertas-horario";
import {
  captionDocumento, clienteParaPdf, entradaCorporativaTraslado, nombreArchivoPdf, rutaPdf,
  type CategoriaPdf, type ClienteErp, type FilaCotizacionLeida,
} from "./cotizacion-traslado";
import { FOTO_MAX_BYTES, hostDe, revisarJpeg, revisarPng, urlFotoPermitida } from "./fotos-categoria";
import { accionReclamable, planAccionTraslado, plazoEnvio, type PlanAccion } from "./envio-ia";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/** Las columnas de la cotización que necesitan el PDF y el envío. */
export const COLS_COTIZACION_TRASLADO =
  "id, cliente_id, numero_cotizacion, created_at, estado, origen, destino, fecha_servicio, hora_ida, fecha_retorno, hora_retorno, " +
  "tipo_servicio, tipo_vehiculo, items_json, incluye_igv, precio_cliente, moneda, tipo_cambio, atencion, consideraciones_json, " +
  "crm_conversacion_id, traslado_json";
/** Accesorias: si el error nombra una, se suelta SOLO esa (sin `plantilla_pdf`, las cuentas son las de `corporativo`). */
export const COLS_COTIZACION_TRASLADO_ACCESORIAS = ["plantilla_pdf"] as const;

/** La plantilla cuyas CUENTAS imprime el PDF cuando la cotización no dice otra (o la suya no sirve). */
export const PLANTILLA_CUENTAS_DEFECTO = "corporativo";

/** Lo que vale el enlace firmado que descarga Meta (s). Meta lo baja al momento; una hora sobra. */
const TTL_URL_META = 3600;

// ── 1. Lecturas que sueltan la columna accesoria que el error nombra ─────────

/**
 * Una consulta con columnas ACCESORIAS: si el error nombra una de ellas, se repite sin ESA (solo la
 * que el error nombra) y se apunta en `faltan`. Cualquier otro error se devuelve tal cual.
 */
async function conAccesorias<R extends { error: unknown }>(
  consulta: (cols: string) => PromiseLike<R>, base: string, accesorias: readonly string[],
): Promise<R & { faltan: string[] }> {
  let quedan = [...accesorias];
  const faltan: string[] = [];
  for (;;) {
    const r = await consulta(quedan.length ? `${base}, ${quedan.join(", ")}` : base);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = r.error ? faltaAlguna(r.error as any, quedan) : null;
    if (!col) return { ...r, faltan };
    faltan.push(col);
    quedan = quedan.filter((c) => c !== col);
  }
}

// ── 2. El perfil, el logo y las fotos ────────────────────────────────────────

export type PerfilPdf = { perfil: PerfilEmpresa | null };

const COLS_PERFIL = "nombre, razon_social, ruc, logo_url, telefono, email, direccion, web";
/** `cuentas_bancarias` es de empresa-02: sin ella el PDF sale sin cuentas (y lo avisa). */
const COLS_PERFIL_ACCESORIAS = ["cuentas_bancarias"] as const;

/** El perfil de la empresa (con sus cuentas). LANZA si no se puede leer. */
export async function leerPerfilPdf(sb: Sb): Promise<PerfilPdf> {
  const r = await conAccesorias((cols) => sb.from("empresa_perfil").select(cols).eq("id", 1).maybeSingle(), COLS_PERFIL, COLS_PERFIL_ACCESORIAS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const err = r.error as any;
  if (err) throw new Error(`No se pudo leer el perfil de la empresa: ${err.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { perfil: ((r as any).data ?? null) as PerfilEmpresa | null };
}

/** Topes del logo (no medidos: un logo de verdad pesa decenas de KB y mide cientos de px). */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_LADO = 4000;
export const LOGO_MAX_PIXELES = 4_000_000;
/** Lo que espera cada descarga (logo o foto). */
export const IMAGEN_TIMEOUT_MS = 4000;
/** @deprecated nombre anterior de `IMAGEN_TIMEOUT_MS`. */
export const LOGO_TIMEOUT_MS = IMAGEN_TIMEOUT_MS;

/** PNG o JPG por su firma, no por la extensión ni por lo que diga el servidor. */
export function tipoImagen(b: Uint8Array): "png" | "jpg" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  return null;
}

export type LogoPdf = ImagenPdf;

/** Dónde puede estar una imagen: el almacenamiento PÚBLICO del propio proyecto de Supabase. */
export const RUTA_LOGO_PERMITIDA = "/storage/v1/object/public/";
/** El bucket del logo: donde lo sube /configuracion/perfil (`supabase.storage.from("empresa")`). */
export const BUCKET_LOGO = "empresa";
/** Dónde se sube el logo (lo nombra el aviso). */
export const DONDE_LOGO = "/configuracion/perfil";

/**
 * El host del proyecto de Supabase (de `NEXT_PUBLIC_SUPABASE_URL`), o null si no está o no es
 * https. Sin él no se baja ninguna imagen.
 */
export function hostSupabase(base: string | null | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  return hostDe(base);
}

/**
 * ¿La URL del logo es del bucket `empresa` del propio proyecto? https, el host del proyecto, sin
 * usuario ni `..`. La consulta se tolera: /configuracion/perfil guarda la URL con `?t=<hora>` para
 * que el navegador no muestre el logo viejo.
 */
export function logoPermitido(url: string | null | undefined, base: string | null | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): boolean {
  let u: URL;
  try { u = new URL(String(url ?? "").trim()); } catch { return false; }
  const host = hostSupabase(base);
  if (!host || u.protocol !== "https:" || u.username || u.password || u.host !== host || u.hash) return false;
  if (String(url).includes("..") || /%2e|%2f|%5c/i.test(u.pathname) || String(url).includes("\\")) return false;
  return u.pathname.startsWith(`${RUTA_LOGO_PERMITIDA}${BUCKET_LOGO}/`) && u.pathname.length > `${RUTA_LOGO_PERMITIDA}${BUCKET_LOGO}/`.length;
}

/**
 * Infla el IDAT de un PNG con TOPE de salida (`maxOutputLength`): zlib se detiene al pasarse en vez
 * de producir cientos de MB, y LANZA. Es lo que `revisarPng` usa para comprobar que los datos son
 * exactamente los que declara la cabecera antes de dárselos a pdf-lib.
 */
export function inflarConTope(idat: Uint8Array, max: number): number {
  return inflateSync(idat, { maxOutputLength: Math.max(1, max) }).length;
}

/**
 * Una imagen del almacenamiento PÚBLICO del propio Supabase, best-effort. LISTA BLANCA: el logo solo
 * del bucket `empresa` (`logoPermitido`); las fotos, solo del bucket `traslados-fotos` con el nombre
 * exacto que les pone la subida (`urlFotoPermitida`); https, sin usuario, sin `..`, sin
 * redirecciones, 4 s, y con tope de bytes. Se comprueba por los BYTES:
 *  · logo: PNG recorrido entero — sin animación, IDAT inflado aquí con tope (`revisarPng` +
 *    `inflarConTope`) — o JPEG, ≤ 512 KB;
 *  · foto: SOLO JPEG, ≤ 600 KB y ≤ 1600 px por lado (marcador SOF), que pdf-lib incrusta tal cual.
 * Cualquier fallo devuelve null y el PDF sale sin esa imagen (nunca con la de otra empresa).
 */
export async function bajarImagenPublica(url: string | null | undefined, uso: "logo" | "foto", f: typeof fetch = fetch, base?: string | null): Promise<ImagenPdf | null> {
  const b = base === undefined ? process.env.NEXT_PUBLIC_SUPABASE_URL : base;
  let u: URL;
  try { u = new URL(String(url ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = hostSupabase(b);
  if (!host || u.host !== host || !u.pathname.startsWith(RUTA_LOGO_PERMITIDA) || u.pathname.includes("..") || String(url).includes("..")) return null;
  if (uso === "foto" && !urlFotoPermitida(u.toString(), b)) return null;
  if (uso === "logo" && !logoPermitido(u.toString(), b)) return null;
  const max = uso === "foto" ? FOTO_MAX_BYTES : LOGO_MAX_BYTES;
  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), IMAGEN_TIMEOUT_MS);
  try {
    const res = await f(u.toString(), { signal: ctrl.signal, redirect: "error" });
    if (!res.ok || !res.body) return null;
    const largo = Number(res.headers.get("content-length"));
    if (Number.isFinite(largo) && largo > max) return null;
    const lector = res.body.getReader();
    const partes: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { ctrl.abort(); return null; }
      partes.push(value);
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of partes) { bytes.set(p, o); o += p.byteLength; }
    if (uso === "foto") return revisarJpeg(bytes).ok ? { bytes, tipo: "jpg" } : null;
    const tipo = tipoImagen(bytes);
    if (tipo === "png") return revisarPng(bytes, { maxBytes: LOGO_MAX_BYTES, maxLado: LOGO_MAX_LADO, maxPixeles: LOGO_MAX_PIXELES, inflar: inflarConTope }).ok ? { bytes, tipo } : null;
    if (tipo === "jpg") return revisarJpeg(bytes, { maxBytes: LOGO_MAX_BYTES, maxLado: LOGO_MAX_LADO }).ok ? { bytes, tipo } : null;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

/** El logo del perfil (ver `bajarImagenPublica`). */
export function bajarLogo(url: string | null | undefined, f: typeof fetch = fetch, base?: string | null): Promise<LogoPdf | null> {
  return bajarImagenPublica(url, "logo", f, base);
}

/** Una foto de la categoría (ver `bajarImagenPublica`): sus bytes JPEG, o null. */
export async function bajarFoto(url: string | null | undefined, f: typeof fetch = fetch, base?: string | null): Promise<Uint8Array | null> {
  return (await bajarImagenPublica(url, "foto", f, base))?.bytes ?? null;
}

// ── 3. Los datos del PDF y el PDF ────────────────────────────────────────────

/** Las columnas del cliente del ERP que imprime el PDF. */
export const COLS_CLIENTE_PDF = ["nombre", "empresa", "tipo", "ruc", "dni", "direccion", "telefono", "operativo_nombre"] as const;
/** Las de la categoría: las de traslados-01 y, accesorias, las de traslados-07. */
export const COLS_CATEGORIA_PDF = "clave, nombre, capacidad, maletas_bodega, tipo_vehiculo";
export const COLS_CATEGORIA_FOTOS = ["foto_externa_url", "foto_interna_url", "descripcion_cliente"] as const;
/** El SQL que agrega las fotos (lo nombran los avisos y el endpoint de subida). */
export const SQL_FOTOS = "supabase/traslados-07-fotos-categoria.sql";
/** Dónde se ponen las fotos y la descripción de la categoría (components/tarifario/FotosCategorias.tsx). */
export const DONDE_FOTOS = "/tarifario → Zonas y traslados → Vehículos → «Fotos y descripción para la cotización» (debajo de la tabla de vehículos)";

export type CodigoAvisoTraslado =
  | "sin_foto" | "foto_no_descargada" | "sin_cuenta_en_moneda" | "sin_migracion_fotos" | "logo_no_usado" | "cliente_no_verificado";
/** Lo que el PDF no pudo poner y conviene decir. NINGUNO bloquea el envío. */
export type AvisoPdfTraslado = { codigo: CodigoAvisoTraslado; detalle: string };

export type DatosPdf = {
  perfil: PerfilEmpresa | null;
  cliente: ClienteErp | null;
  celular: string | null;
  /** El `cliente_id` del contacto del CRM (vinculado por una persona); null si no hay o no se pudo leer. */
  contactoClienteId: number | null;
  plantilla: PlantillaPdfCfg | null;
  categoria: CategoriaPdf | null;
  /** Faltan columnas de traslados-07 en `traslado_categorias`. */
  sinMigracionFotos: boolean;
};

/**
 * Lo que necesita el PDF además de la fila. El perfil LANZA si no se puede leer (sin él no hay
 * quién emita); lo demás es best-effort: un cliente, una conversación, una plantilla o una
 * categoría que no se pudo leer dejan el PDF con menos datos, no sin PDF.
 */
export async function leerDatosPdf(
  sb: Sb, fila: FilaCotizacionLeida,
  opts: { perfil?: PerfilPdf | null; celular?: string | null; contactoClienteId?: number | null } = {},
): Promise<DatosPdf> {
  const pp = opts.perfil ?? (await leerPerfilPdf(sb));
  const cliente = async (): Promise<ClienteErp | null> => {
    const id = Number(fila.cliente_id);
    if (!Number.isInteger(id) || id <= 0) return null;
    try {
      // Todas las columnas son accesorias aquí: se suelta la que falte y se imprime lo que haya.
      const r = await conAccesorias((cols) => sb.from("clientes").select(cols).eq("id", id).maybeSingle(), "id", COLS_CLIENTE_PDF);
      return r.error ? null : (((r as { data?: unknown }).data ?? null) as ClienteErp | null);
    } catch { return null; }
  };
  // El wa_id y el cliente vinculado del contacto de la conversación (lo que no vino en `opts`).
  const conversacion = async (): Promise<{ celular: string | null; contactoClienteId: number | null }> => {
    const dado = { celular: opts.celular ?? null, contactoClienteId: opts.contactoClienteId ?? null };
    if ((opts.celular !== undefined && opts.contactoClienteId !== undefined) || !fila.crm_conversacion_id) return dado;
    try {
      const { data, error } = await sb.from("crm_conversaciones").select("id, crm_contactos(wa_id, cliente_id)").eq("id", fila.crm_conversacion_id).maybeSingle();
      if (error || !data) return dado;
      const c = (Array.isArray(data.crm_contactos) ? data.crm_contactos[0] : data.crm_contactos) as { wa_id?: string | null; cliente_id?: number | string | null } | null;
      const vinc = Number(c?.cliente_id);
      return {
        celular: opts.celular !== undefined ? opts.celular : (c?.wa_id ?? null),
        contactoClienteId: opts.contactoClienteId !== undefined ? opts.contactoClienteId : (Number.isInteger(vinc) && vinc > 0 ? vinc : null),
      };
    } catch { return dado; }
  };
  // La plantilla de la cotización (solo se usan sus CUENTAS: las condiciones van en la fila). Si no
  // existe, no se puede leer o no dibuja el diseño corporativo, la `corporativo` de siempre.
  const plantilla = async (): Promise<PlantillaPdfCfg | null> => {
    const leer = async (id: string): Promise<(PlantillaPdfCfg & { id?: string; diseno?: string | null }) | null> => {
      try {
        const { data, error } = await sb.from("cotizacion_plantillas").select("*").eq("id", id).maybeSingle();
        return error ? null : ((data ?? null) as (PlantillaPdfCfg & { id?: string; diseno?: string | null }) | null);
      } catch { return null; }
    };
    const id = typeof fila.plantilla_pdf === "string" ? fila.plantilla_pdf.trim() : "";
    if (id && id !== PLANTILLA_CUENTAS_DEFECTO) {
      const p = await leer(id);
      if (p && disenoDe({ id: typeof p.id === "string" ? p.id : id, diseno: p.diseno }) === "corporativo") return p;
    }
    return leer(PLANTILLA_CUENTAS_DEFECTO);
  };
  const categoria = async (): Promise<{ cat: CategoriaPdf | null; faltan: string[] }> => {
    const clave = fila.traslado_json?.categoria?.clave;
    if (!clave) return { cat: null, faltan: [] };
    try {
      const r = await conAccesorias((cols) => sb.from("traslado_categorias").select(cols).eq("clave", clave).maybeSingle(), COLS_CATEGORIA_PDF, COLS_CATEGORIA_FOTOS);
      return { cat: r.error ? null : (((r as { data?: unknown }).data ?? null) as CategoriaPdf | null), faltan: r.faltan };
    } catch { return { cat: null, faltan: [] }; }
  };
  const [cl, conv, pl, ca] = await Promise.all([cliente(), conversacion(), plantilla(), categoria()]);
  return {
    perfil: pp.perfil, cliente: cl, celular: conv.celular, contactoClienteId: conv.contactoClienteId,
    plantilla: pl, categoria: ca.cat, sinMigracionFotos: ca.faltan.length > 0,
  };
}

export type PdfArmado = { bytes: Uint8Array; nombre: string; caption: string; empresa: EmpresaResuelta; avisos: AvisoPdfTraslado[] };

/** El texto de un aviso, con dónde se arregla. */
function aviso(codigo: CodigoAvisoTraslado, extra = ""): AvisoPdfTraslado {
  const detalle: Record<CodigoAvisoTraslado, string> = {
    sin_foto: `La categoría del vehículo no tiene fotos: el PDF sale solo con su descripción. Se suben en ${DONDE_FOTOS}.`,
    foto_no_descargada: `Una foto de la categoría no se pudo bajar (o no es del almacenamiento de fotos de traslados): el PDF sale sin ella. Vuelve a subirla en ${DONDE_FOTOS}.`,
    sin_cuenta_en_moneda: "El PDF sale sin el bloque de cuentas bancarias.",
    sin_migracion_fotos: `Falta correr ${SQL_FOTOS}: el PDF sale sin las fotos ni la descripción de la categoría.`,
    logo_no_usado: `El logo del perfil no se pudo usar: el PDF sale con el nombre de la empresa en su lugar. Súbelo en ${DONDE_LOGO} (PNG o JPG, sin animación, hasta ${Math.floor(LOGO_MAX_BYTES / 1024)} KB).`,
    cliente_no_verificado: "El cliente del ERP de la cotización no está vinculado a este contacto del CRM y su teléfono no es el número de WhatsApp: el PDF sale con la atención y el celular, sin sus datos. Si es el mismo cliente, vincúlalo en el panel del cliente del CRM.",
  };
  return { codigo, detalle: extra ? `${detalle[codigo]} ${extra}`.trim() : detalle[codigo] };
}

/**
 * El PDF de una fila (guardada, o armada en memoria para el ejemplo del simulador). LANZA si los
 * importes no se pueden imprimir (dólares sin tipo de cambio, sin ítems) o el perfil no se puede
 * leer: el llamador lo trata como «PDF no generado».
 */
export async function armarPdfDeFila(
  sb: Sb,
  fila: FilaCotizacionLeida,
  opts: {
    ejemplo?: boolean; perfil?: PerfilPdf | null; celular?: string | null; contactoClienteId?: number | null;
    bajarLogo?: (url: string | null) => Promise<LogoPdf | null>;
    bajarFoto?: (url: string) => Promise<Uint8Array | null>;
    ahoraMs?: number;
  } = {},
): Promise<PdfArmado> {
  const datos = await leerDatosPdf(sb, fila, { perfil: opts.perfil, celular: opts.celular, contactoClienteId: opts.contactoClienteId });
  const empresa = empresaConDefectos(datos.perfil);
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
  const entrada = entradaCorporativaTraslado(fila, {
    empresa: datos.perfil, cliente: datos.cliente, celular: datos.celular, contactoClienteId: datos.contactoClienteId,
    plantilla: datos.plantilla, categoria: datos.categoria, ejemplo: opts.ejemplo, supabaseUrl: base, ahoraMs: opts.ahoraMs,
  });
  const doc = docCorporativo(entrada);

  const avisos: AvisoPdfTraslado[] = [];
  if (clienteParaPdf(fila.cliente_id, datos.cliente, { contactoClienteId: datos.contactoClienteId, waId: datos.celular }).vinculo === "no_verificado") {
    avisos.push(aviso("cliente_no_verificado"));
  }
  for (const a of doc.avisos) if (a.codigo === "sin_cuenta_en_moneda") avisos.push(aviso("sin_cuenta_en_moneda", a.detalle));
  if (datos.sinMigracionFotos) avisos.push(aviso("sin_migracion_fotos"));

  const logoUrl = String(doc.logoUrl ?? "").trim() || null;
  const fotosPedidas = [datos.categoria?.foto_externa_url, datos.categoria?.foto_interna_url].map((u) => String(u ?? "").trim()).filter(Boolean);
  const urls = (doc.pagina2.caracteristicas?.vehiculos ?? []).flatMap((v) => [v.fotoExterior, v.fotoInterior]).filter((u): u is string => !!u);
  const bajar = opts.bajarFoto ?? ((u: string) => bajarFoto(u));
  const [logo, ...bytesFotos] = await Promise.all([
    (opts.bajarLogo ?? ((u: string | null) => bajarLogo(u)))(logoUrl),
    ...urls.map((u) => bajar(u).catch(() => null)),
  ]);
  if (logoUrl && !logo) avisos.push(aviso("logo_no_usado", logoPermitido(logoUrl, base) ? "" : "(no está en el almacenamiento del perfil de la empresa)"));
  const fotos: Record<string, Uint8Array> = {};
  urls.forEach((u, i) => { const b = bytesFotos[i]; if (b?.length) fotos[u] = b; });
  if (!datos.sinMigracionFotos && datos.categoria && !fotosPedidas.length) avisos.push(aviso("sin_foto"));
  const faltantes = fotosPedidas.filter((u) => !fotos[u]).length;
  if (faltantes) avisos.push(aviso("foto_no_descargada", faltantes > 1 ? `(${faltantes} fotos)` : ""));

  const bytes = await dibujarPdfCorporativo(doc, { logo, fotos }, { marcaAgua: opts.ejemplo ? "EJEMPLO · SIN VALIDEZ" : null });
  return { bytes, nombre: nombreArchivoPdf(numeroCotizacion(entrada.cot)), caption: captionDocumento(fila, empresa), empresa, avisos };
}

/**
 * La fila de la cotización, o null si no existe. LANZA si no se puede leer. `plantilla_pdf` es
 * accesoria: si el error la nombra, se lee sin ella (el PDF toma las cuentas de `corporativo`).
 */
export async function leerCotizacionTraslado(sb: Sb, id: number): Promise<FilaCotizacionLeida | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const r = await conAccesorias((cols) => sb.from("cotizaciones").select(cols).eq("id", id).maybeSingle(), COLS_COTIZACION_TRASLADO, COLS_COTIZACION_TRASLADO_ACCESORIAS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const error = r.error as any;
  if (error) throw new Error(`No se pudo leer la cotización ${id}: ${error.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((r as any).data ?? null) as FilaCotizacionLeida | null;
}

/** El PDF de una cotización guardada, leído de su fila. LANZA si no existe o no se puede imprimir. */
export async function pdfDeCotizacion(sb: Sb, cotId: number, opts: { bajarLogo?: (url: string | null) => Promise<LogoPdf | null>; bajarFoto?: (url: string) => Promise<Uint8Array | null> } = {}): Promise<PdfArmado> {
  const fila = await leerCotizacionTraslado(sb, cotId);
  if (!fila) throw new Error("La cotización ya no existe.");
  return armarPdfDeFila(sb, fila, opts);
}

// ── 3. El envío ──────────────────────────────────────────────────────────────

export type CodigoEnvio = PlanAccion | "reclamo_perdido" | "error_lectura" | "pdf_no_generado" | "sin_url" | "envio_fallido";

export type ResultadoEnvio = { ok: boolean; codigo: CodigoEnvio; detalle: string; metaId?: string | null };

/** Lo que el envío necesita de fuera; la matriz lo reemplaza para correr sin red. */
export type DepsEnvio = {
  enviarMedia?: typeof enviarWhatsAppMedia;
  phonePara?: (uso: "crm") => Promise<string | undefined>;
  asegurarBucket?: (sb: Sb) => Promise<void>;
  bajarLogo?: (url: string | null) => Promise<LogoPdf | null>;
  bajarFoto?: (url: string) => Promise<Uint8Array | null>;
  ahoraMs?: () => number;
  uuid?: () => string;
};

type AccionFila = {
  id: string; tipo: string | null; estado: string | null; conversacion_id: string | null; contacto_id: string | null;
  resuelta_at: string | null; resultado_id: number | null; payload: Record<string, unknown> | null;
};

const COLS_ACCION = "id, tipo, estado, conversacion_id, contacto_id, resuelta_at, resultado_id, payload";

/**
 * Por qué la acción NO es la que espera quien llama, o null si lo es (o si no espera nada). Una
 * conversación o cotización esperada que llega vacía o rara cuenta como «no coincide»: quien la
 * pasa es porque quiere comprobarla.
 */
export function accionAjena(
  acc: { conversacion_id?: string | null; resultado_id?: number | null; payload?: Record<string, unknown> | null },
  esperado: { conversacionId?: string; cotizacionId?: number } | null | undefined,
): string | null {
  if (!esperado) return null;
  if (esperado.conversacionId !== undefined) {
    const e = typeof esperado.conversacionId === "string" ? esperado.conversacionId.trim() : "";
    if (!e || !acc.conversacion_id || acc.conversacion_id !== e) return "La acción no es de esta conversación.";
  }
  if (esperado.cotizacionId !== undefined) {
    const e = Number(esperado.cotizacionId);
    const p = acc.payload && typeof acc.payload === "object" ? (acc.payload as { cotizacion_id?: unknown }).cotizacion_id : undefined;
    const propia = Number(acc.resultado_id ?? p);
    if (!Number.isInteger(e) || e <= 0 || !Number.isFinite(propia) || propia !== e) return "La acción no es de esta cotización.";
  }
  return null;
}

export async function enviarCotizacionTraslado(
  sb: Sb,
  x: {
    accionId: string; por: "automatico" | "ejecutivo"; usuarioId?: string | null; bytes?: Uint8Array | null; nombre?: string; caption?: string;
    /** De qué conversación y cotización TIENE que ser la acción. Si no coincide, no se reclama ni se envía. */
    esperado?: { conversacionId?: string; cotizacionId?: number };
  },
  deps: DepsEnvio = {},
): Promise<ResultadoEnvio> {
  const ahora = deps.ahoraMs?.() ?? Date.now();

  // 1) La acción, antes de reclamarla.
  const { data: accData, error: eAcc } = await sb.from("crm_acciones_ia").select(COLS_ACCION).eq("id", x.accionId).maybeSingle();
  if (eAcc) return { ok: false, codigo: "error_lectura", detalle: `No se pudo leer la acción: ${eAcc.message}` };
  const acc = accData as AccionFila | null;
  if (!acc || acc.tipo !== "cotizacion_traslado") return { ok: false, codigo: "cotizacion_no_existe", detalle: "La acción no es una cotización de traslado." };
  // Antes de reclamar nada: la acción tiene que ser de la conversación y la cotización que dice quien llama.
  const ajena = accionAjena(acc, x.esperado);
  if (ajena) return { ok: false, codigo: "cotizacion_ajena", detalle: ajena };
  if (!accionReclamable(acc, ahora)) {
    return {
      ok: false, codigo: "no_pendiente",
      detalle: acc.estado === "enviando" ? "Se está enviando en este momento: espera unos minutos." : `La cotización ya fue ${acc.estado ?? "resuelta"}.`,
    };
  }

  // 2) El reclamo: un UPDATE que exige el estado (y el plazo) que se acaba de leer.
  const plazo = plazoEnvio(ahora);
  let q = sb.from("crm_acciones_ia").update({ estado: "enviando", resuelta_at: plazo }).eq("id", acc.id).eq("estado", acc.estado);
  if (acc.estado === "enviando") q = acc.resuelta_at ? q.eq("resuelta_at", acc.resuelta_at) : q.is("resuelta_at", null);
  const { data: rec, error: eRec } = await q.select("id");
  if (eRec) return { ok: false, codigo: "error_lectura", detalle: `No se pudo reclamar el envío: ${eRec.message}` };
  if (!rec || rec.length === 0) return { ok: false, codigo: "reclamo_perdido", detalle: "Otro envío de esta cotización está en curso." };

  const payload = (acc.payload && typeof acc.payload === "object" ? acc.payload : {}) as Record<string, unknown>;
  const cotId = Number(acc.resultado_id ?? payload.cotizacion_id);

  /** Suelta el reclamo: la acción vuelve a `pendiente` con el error escrito, y una nota interna. */
  const soltar = async (codigo: CodigoEnvio, detalle: string): Promise<ResultadoEnvio> => {
    try {
      await sb.from("crm_acciones_ia")
        // `ultimo_error` es TEXTO: es lo que pinta la tarjeta del inbox. Cuándo, quién y el código van aparte.
        .update({
          estado: "pendiente", resuelta_at: null,
          payload: { ...payload, ultimo_error: detalle.slice(0, 500), ultimo_error_codigo: codigo, ultimo_error_at: new Date(ahora).toISOString(), ultimo_error_por: x.por },
        })
        .eq("id", acc.id).eq("estado", "enviando").eq("resuelta_at", plazo);
    } catch { /* si ni esto se puede escribir, el plazo vence solo y se puede reintentar */ }
    try {
      if (acc.conversacion_id) {
        await sb.from("crm_notas").insert({
          conversacion_id: acc.conversacion_id,
          texto: `📄 No se pudo enviar la cotización de traslado${Number.isFinite(cotId) ? ` (id ${cotId})` : ""} por WhatsApp.\n${detalle.slice(0, 500)}`,
          autor_nombre: x.por === "automatico" ? "Asistente IA" : "Sistema",
        });
      }
    } catch { /* sin crm_notas: el error queda en la acción */ }
    return { ok: false, codigo, detalle };
  };

  // 3) La cotización y la conversación, y si esta acción se puede enviar (con el estado de ANTES del reclamo).
  let cot: FilaCotizacionLeida | null;
  let conv: { id: string; canal: string | null; phone_number_id?: string | null; wa_id: string | null } | null = null;
  try {
    cot = await leerCotizacionTraslado(sb, cotId);
    const { data: c, error: eConv } = await sb.from("crm_conversaciones")
      .select("id, canal, phone_number_id, crm_contactos(wa_id)").eq("id", acc.conversacion_id ?? "").maybeSingle();
    if (eConv) throw new Error(`No se pudo leer la conversación: ${eConv.message}`);
    if (c) {
      const contacto = Array.isArray(c.crm_contactos) ? c.crm_contactos[0] : c.crm_contactos;
      conv = { id: c.id, canal: c.canal ?? null, phone_number_id: c.phone_number_id ?? null, wa_id: contacto?.wa_id ?? null };
    }
  } catch (e) {
    return soltar("error_lectura", (e as Error).message);
  }
  const plan = planAccionTraslado(acc, cot, conv, ahora);
  if (plan.codigo !== "ok") return soltar(plan.codigo, plan.detalle);
  const fila = cot!;
  const destino = conv!.wa_id!.trim();

  // 4) El PDF (el que ya armó la IA, o uno nuevo desde la fila).
  let bytes = x.bytes ?? null;
  let nombre = x.nombre ?? nombreArchivoPdf(numeroCotizacion(fila));
  let caption = x.caption ?? "";
  try {
    if (!bytes || !caption) {
      const pdf = await armarPdfDeFila(sb, fila, { bajarLogo: deps.bajarLogo, bajarFoto: deps.bajarFoto, celular: conv!.wa_id, ahoraMs: ahora });
      if (!bytes) { bytes = pdf.bytes; nombre = pdf.nombre; }
      if (!caption) caption = pdf.caption;
    }
  } catch (e) {
    return soltar("pdf_no_generado", `No se pudo armar el PDF: ${(e as Error).message}`);
  }

  // 5) La copia en el bucket privado y el enlace firmado para Meta (sin él, no se envía).
  let ruta: string;
  try {
    await (deps.asegurarBucket ?? asegurarBucketCrm)(sb);
    ruta = rutaPdf(fila.id, fechaLima(ahora).slice(0, 7), deps.uuid?.() ?? crypto.randomUUID());
    const up = await sb.storage.from(BUCKET_CRM_MEDIA).upload(ruta, bytes, { contentType: "application/pdf", upsert: false });
    if (up.error) throw new Error(`No se pudo guardar el PDF: ${up.error.message}`);
  } catch (e) {
    return soltar("pdf_no_generado", (e as Error).message);
  }
  const firmada = await sb.storage.from(BUCKET_CRM_MEDIA).createSignedUrl(ruta, TTL_URL_META);
  const url = firmada?.data?.signedUrl as string | undefined;
  if (!url) return soltar("sin_url", `No se pudo firmar el enlace del PDF${firmada?.error?.message ? `: ${firmada.error.message}` : ""}.`);

  // 6) WhatsApp, por el número del hilo, al wa_id de la conversación.
  let metaId: string | null = null;
  let errorEnvio: string | null = null;
  try {
    const phoneId = conv!.phone_number_id ?? (await (deps.phonePara ?? phoneParaUso)("crm"));
    metaId = await (deps.enviarMedia ?? enviarWhatsAppMedia)(destino, "document", url, caption || undefined, { phoneId, filename: nombre });
    if (!metaId) errorEnvio = "Meta no devolvió el id del mensaje.";
  } catch (e) {
    errorEnvio = explicarErrorEnvioWhatsApp(String((e as Error)?.message ?? e));
  }

  // 7) El mensaje en el hilo (también si falló: el error se ve donde se mira).
  const media_url = sb.storage.from(BUCKET_CRM_MEDIA).getPublicUrl(ruta).data.publicUrl;
  try {
    await sb.from("crm_mensajes").insert({
      conversacion_id: conv!.id,
      direccion: "saliente",
      tipo: "document",
      contenido: caption ? `${nombre}\n${caption}` : nombre,
      media_url,
      meta_message_id: metaId,
      generado_por_ia: x.por === "automatico",
      error: errorEnvio,
    });
    await sb.from("crm_conversaciones")
      .update(x.por === "ejecutivo" ? { ultimo_mensaje_at: new Date(ahora).toISOString(), estado: "en_progreso" } : { ultimo_mensaje_at: new Date(ahora).toISOString() })
      .eq("id", conv!.id);
  } catch { /* el mensaje del hilo es constancia; el envío ya ocurrió (o falló) */ }

  if (errorEnvio) return soltar("envio_fallido", errorEnvio);

  // 8) Enviada: la cotización pasa a «enviado» y la acción a «aprobada», con quién y cuándo.
  try {
    await sb.from("cotizaciones").update({ estado: "enviado", medio_envio: "WhatsApp" }).eq("id", fila.id).in("estado", ["borrador", "pendiente"]);
  } catch { /* la acción dice que se envió; el estado de la cotización se corrige en /cotizaciones */ }
  const at = new Date(ahora).toISOString();
  await sb.from("crm_acciones_ia")
    .update({
      estado: "aprobada", resuelta_at: at, resuelta_por: x.por === "ejecutivo" ? x.usuarioId ?? null : null,
      payload: { ...payload, ultimo_error: null, envio: { por: x.por, at, meta_message_id: metaId } },
    })
    .eq("id", acc.id).eq("estado", "enviando");
  return { ok: true, codigo: "ok", detalle: "", metaId };
}
