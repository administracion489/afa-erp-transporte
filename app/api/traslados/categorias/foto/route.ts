// app/api/traslados/categorias/foto/route.ts
// POST   — Sube la foto EXTERIOR o INTERIOR de una categoría de traslado (la que va en el PDF que la
//          IA del CRM manda por WhatsApp) y la deja puesta en `traslado_categorias`.
//          multipart/form-data: `clave` (la de la categoría), `lado` («externa» | «interna») y
//          `archivo` (JPEG ya achicado por el navegador: ≤ 600 KB y ≤ 1600 px por lado).
// DELETE — ?clave=…&lado=… — Quita esa foto (la columna vuelve a null y se borra el archivo).
//
// EL BUCKET `traslados-fotos` NO TIENE NINGUNA POLÍTICA DE ESCRITURA (supabase/traslados-07): solo
// escribe esta ruta, con la service-role, después de comprobar el módulo «tarifas». Lo que la IA
// manda a clientes sin revisión no puede salir de un sitio que cualquier sesión puede sobrescribir.
//
// NADA SE DECODIFICA AQUÍ: la foto se juzga por sus bytes (firma JPEG, marcador SOF con las
// dimensiones, final FF D9) con `revisarJpeg` (lib/traslados/fotos-categoria.ts), el mismo control
// que aplica el servidor antes de meterla en el PDF. Cada foto se guarda con NOMBRE NUEVO (uuid):
// nunca sobrescribe; la anterior se borra solo si es de este bucket y solo si el cambio entró.
// El cambio es CONDICIONAL (exige la foto que se leyó): si otra persona la cambió entretanto, se
// borra lo subido y se pide repetir, en vez de dejar un archivo huérfano o pisar el cambio ajeno.
//
// Sin la migración traslados-07 responde 409 nombrando el SQL. Ningún error de Postgres sale crudo.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { limitarTasa, mismoOrigen, segundosParaReintentar } from "@/lib/api-guard";
import { columnaFaltante, tablaQueFalta } from "@/lib/columna-faltante";
import { normalizarClaveCategoria } from "@/components/tarifario/traslados-pantalla";
import {
  BUCKET_FOTOS_TRASLADO, COLUMNA_FOTO, FOTO_MAX_BYTES, LADOS_FOTO, claveValida, revisarJpeg, rutaDeUrlFoto, rutaFoto,
  type LadoFoto,
} from "@/lib/traslados/fotos-categoria";

export const maxDuration = 30;

const SQL_FOTOS = "supabase/traslados-07-fotos-categoria.sql";
/** Subidas por usuario y minuto (en memoria de la instancia; no medido). */
const LIMITE_POR_MINUTO = 20;

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const responder = (status: number, codigo: string, detalle: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: status < 400, codigo, detalle, ...extra }, { status });

const sinMigracion = () =>
  responder(409, "sin_migracion", `Falta correr ${SQL_FOTOS} en Supabase (SQL Editor → pegar entero → Run): sin él no hay dónde guardar las fotos de la categoría.`);

type Previa = { ok: true; anterior: string | null } | { ok: false; res: NextResponse };

/** La foto que tiene hoy la categoría en ese lado (o la respuesta de error que corresponde). */
async function fotoActual(sb: ReturnType<typeof db>, clave: string, lado: LadoFoto): Promise<Previa> {
  const col = COLUMNA_FOTO[lado];
  const { data, error } = await sb.from("traslado_categorias").select(`clave, ${col}`).eq("clave", clave).maybeSingle();
  if (error) {
    if (columnaFaltante(error) != null) return { ok: false, res: sinMigracion() };
    if (tablaQueFalta(error) != null) return { ok: false, res: responder(409, "sin_migracion", "Falta correr supabase/traslados-01-tablas.sql: no existen las categorías de traslado.") };
    console.error("[traslados/categorias/foto] lectura", error.message);
    return { ok: false, res: responder(500, "error", "No se pudo leer la categoría del vehículo. Vuelve a intentarlo en un momento.") };
  }
  if (!data) return { ok: false, res: responder(404, "sin_categoria", `No existe la categoría ${clave}: créala en /tarifario → Zonas y traslados → Vehículos.`) };
  const v = (data as Record<string, unknown>)[col];
  return { ok: true, anterior: typeof v === "string" && v.trim() ? v.trim() : null };
}

/** UPDATE condicional: solo si la columna sigue diciendo lo que se leyó. Devuelve cuántas filas cambió. */
async function cambiarFoto(sb: ReturnType<typeof db>, clave: string, lado: LadoFoto, anterior: string | null, nueva: string | null) {
  const col = COLUMNA_FOTO[lado];
  let q = sb.from("traslado_categorias").update({ [col]: nueva }).eq("clave", clave);
  q = anterior == null ? q.is(col, null) : q.eq(col, anterior);
  return q.select("clave");
}

/** Borra un objeto del bucket solo si la URL es de ESTE bucket del propio proyecto. Best-effort. */
async function borrarObjeto(sb: ReturnType<typeof db>, url: string | null) {
  const ruta = rutaDeUrlFoto(url, process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!ruta) return;
  try { await sb.storage.from(BUCKET_FOTOS_TRASLADO).remove([ruta]); } catch { /* queda huérfano: no afecta a ningún PDF */ }
}

function leerLado(v: unknown): LadoFoto | null {
  const s = String(v ?? "").trim().toLowerCase();
  return (LADOS_FOTO as readonly string[]).includes(s) ? (s as LadoFoto) : null;
}

/** La clave tal como la guarda la pantalla; null si no es una clave. */
function leerClave(v: unknown): string | null {
  const k = normalizarClaveCategoria(String(v ?? ""));
  return claveValida(k) ? k : null;
}

async function guardias(req: NextRequest): Promise<{ ok: true; userId: string } | { ok: false; res: NextResponse }> {
  if (!mismoOrigen(req)) return { ok: false, res: responder(403, "origen", "Origen no permitido.") };
  const auth = await verificarUsuarioApi(req, "tarifas");
  if (!auth.ok) return { ok: false, res: responder(auth.status, "sin_permiso", auth.status === 403 ? `${auth.error}: las fotos de los vehículos de traslado las cambia quien tiene el módulo Tarifas.` : auth.error) };
  const clave = `traslados-foto:${auth.userId}`;
  if (!limitarTasa(clave, LIMITE_POR_MINUTO, 60_000)) {
    const s = segundosParaReintentar(clave);
    return { ok: false, res: NextResponse.json({ ok: false, codigo: "tope", detalle: `Demasiadas fotos seguidas: espera ${s} s.` }, { status: 429, headers: { "Retry-After": String(s) } }) };
  }
  return { ok: true, userId: auth.userId };
}

export async function POST(req: NextRequest) {
  const g = await guardias(req);
  if (!g.ok) return g.res;

  // El cuerpo no puede ser mucho mayor que la foto (más los separadores del multipart).
  const largo = Number(req.headers.get("content-length"));
  if (Number.isFinite(largo) && largo > FOTO_MAX_BYTES + 64 * 1024) {
    return responder(413, "muy_pesado", `La foto pesa más de ${Math.floor(FOTO_MAX_BYTES / 1024)} KB: la pantalla la achica antes de subirla; vuelve a elegirla.`);
  }
  const form = await req.formData().catch(() => null);
  if (!form) return responder(400, "entrada_invalida", "Envía la foto como multipart/form-data (clave, lado y archivo).");
  const clave = leerClave(form.get("clave"));
  if (!clave) return responder(400, "entrada_invalida", "Falta la clave de la categoría (MAYÚSCULAS, sin espacios; p. ej. VAN_12).");
  const lado = leerLado(form.get("lado"));
  if (!lado) return responder(400, "entrada_invalida", "El lado de la foto es «externa» o «interna».");
  const archivo = form.get("archivo");
  if (!(archivo instanceof File) || archivo.size === 0) return responder(400, "entrada_invalida", "Falta la foto.");
  if (archivo.size > FOTO_MAX_BYTES) return responder(413, "muy_pesado", `La foto pesa ${Math.ceil(archivo.size / 1024)} KB y el máximo es ${Math.floor(FOTO_MAX_BYTES / 1024)} KB: achícala antes de subirla.`);
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  const rev = revisarJpeg(bytes);
  if (!rev.ok) return responder(422, rev.codigo, rev.detalle);

  const sb = db();
  const previa = await fotoActual(sb, clave, lado);
  if (!previa.ok) return previa.res;

  const ruta = rutaFoto(clave, lado, crypto.randomUUID());
  const up = await sb.storage.from(BUCKET_FOTOS_TRASLADO).upload(ruta, bytes, { contentType: "image/jpeg", upsert: false, cacheControl: "31536000" });
  if (up.error) {
    if (/bucket not found/i.test(up.error.message ?? "")) return sinMigracion();
    console.error("[traslados/categorias/foto] subida", up.error.message);
    return responder(502, "error", "No se pudo guardar la foto en el almacenamiento. Vuelve a intentarlo en un momento.");
  }
  const url = sb.storage.from(BUCKET_FOTOS_TRASLADO).getPublicUrl(ruta).data.publicUrl;
  if (!rutaDeUrlFoto(url, process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    await borrarObjeto(sb, url);
    return responder(500, "error", "La dirección pública de la foto no es la esperada: revisa NEXT_PUBLIC_SUPABASE_URL en Vercel.");
  }

  const cambio = await cambiarFoto(sb, clave, lado, previa.anterior, url);
  if (cambio.error || !cambio.data?.length) {
    // Lo subido no quedó puesto: se borra (no deja un archivo huérfano).
    try { await sb.storage.from(BUCKET_FOTOS_TRASLADO).remove([ruta]); } catch { /* best-effort */ }
    if (cambio.error) {
      if (columnaFaltante(cambio.error) != null) return sinMigracion();
      console.error("[traslados/categorias/foto] update", cambio.error.message);
      return responder(500, "error", "La foto subió pero no se pudo poner en la categoría. Vuelve a intentarlo.");
    }
    return responder(409, "cambio_concurrente", "Otra persona cambió esta foto mientras subías la tuya: recarga la pantalla y vuelve a intentarlo.");
  }
  if (previa.anterior && previa.anterior !== url) await borrarObjeto(sb, previa.anterior);
  return responder(200, "ok", "", { clave, lado, url, ancho: rev.ancho, alto: rev.alto });
}

export async function DELETE(req: NextRequest) {
  const g = await guardias(req);
  if (!g.ok) return g.res;
  const clave = leerClave(req.nextUrl.searchParams.get("clave"));
  if (!clave) return responder(400, "entrada_invalida", "Falta la clave de la categoría.");
  const lado = leerLado(req.nextUrl.searchParams.get("lado"));
  if (!lado) return responder(400, "entrada_invalida", "El lado de la foto es «externa» o «interna».");

  const sb = db();
  const previa = await fotoActual(sb, clave, lado);
  if (!previa.ok) return previa.res;
  if (!previa.anterior) return responder(200, "sin_foto", "", { clave, lado });
  const cambio = await cambiarFoto(sb, clave, lado, previa.anterior, null);
  if (cambio.error) {
    console.error("[traslados/categorias/foto] quitar", cambio.error.message);
    return responder(500, "error", "No se pudo quitar la foto de la categoría. Vuelve a intentarlo.");
  }
  if (!cambio.data?.length) return responder(409, "cambio_concurrente", "Otra persona cambió esta foto: recarga la pantalla y vuelve a intentarlo.");
  await borrarObjeto(sb, previa.anterior);
  return responder(200, "ok", "", { clave, lado, url: null });
}
