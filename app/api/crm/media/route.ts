import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { objetoPrivadoDe } from "@/lib/storage-privado";
import { rescatarUrlMeta, esUrlMediaMeta } from "@/lib/crm-media";

export const maxDuration = 60;

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

// Cuántos archivos viejos de Meta se intentan rescatar por petición, cuántos a la vez, y hasta
// cuándo se empiezan rescates nuevos. Operativos, no medidos: un rescate es una descarga de Meta
// que puede tardar segundos, y antes iban TODOS en fila — un chat con historial dejaba la
// petición entera (y cada archivo del chat) en «Cargando archivo…» hasta vencer.
const MAX_RESCATES = 6;
const RESCATES_A_LA_VEZ = 3;
const PLAZO_RESCATES_MS = 20_000;

// POST { mensaje_ids: string[] } → { urls: { [id]: url firmada | null }, pendientes: string[] }
// Firma la media de los mensajes del chat abierto (bucket privado crm-media), EN LOTE, y rescata
// unos pocos de los mensajes viejos que guardaron la URL de Meta (solo abre con token). Lo que no
// alcanzó a rescatarse vuelve en `pendientes` y el navegador lo pide otra vez: nunca se da por
// «no disponible» un archivo que solo faltó intentar.
export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const { mensaje_ids } = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(mensaje_ids) ? mensaje_ids.slice(0, 200).map(String) : [];
  if (!ids.length) return NextResponse.json({ ok: true, urls: {}, pendientes: [] });

  const sb = db();
  const { data, error } = await sb
    .from("crm_mensajes")
    .select("id, media_url, phone_number_id, conversacion_id, crm_conversaciones(phone_number_id)")
    .in("id", ids);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const urls: Record<string, string | null> = {};
  const pendientes: string[] = [];
  const aFirmar: { id: string; bucket: string; ruta: string }[] = [];
  const aRescatar: any[] = [];

  for (const m of (data ?? []) as any[]) {
    const ident: string | null = m.media_url ?? null;
    if (!ident) { urls[m.id] = null; continue; }
    const obj = objetoPrivadoDe(ident);
    if (obj) { aFirmar.push({ id: m.id, bucket: obj.bucket, ruta: obj.ruta }); continue; }
    // Solo un enlace de Meta (host exacto, ver esUrlMediaMeta) se intenta con el token.
    if (esUrlMediaMeta(ident)) { aRescatar.push(m); continue; }
    urls[m.id] = ident; // enlace público de otro origen: se usa tal cual
  }

  // Rescates de Meta: pocos, unos cuantos a la vez y con plazo. El resto queda pendiente.
  const inicio = Date.now();
  const cola = aRescatar.slice(0, MAX_RESCATES);
  for (const m of aRescatar.slice(MAX_RESCATES)) pendientes.push(m.id);
  let siguiente = 0;
  const trabajador = async () => {
    for (;;) {
      const m = cola[siguiente++];
      if (!m) return;
      if (Date.now() - inicio > PLAZO_RESCATES_MS) { pendientes.push(m.id); continue; }
      const phone = m.phone_number_id ?? m.crm_conversaciones?.phone_number_id ?? null;
      const nuevo = await rescatarUrlMeta(sb, m.media_url, phone, m.id);
      if (!nuevo) {
        // Ya no está en Meta (sus enlaces caducan): no disponible.
        urls[m.id] = null;
        continue;
      }
      await sb.from("crm_mensajes").update({ media_url: nuevo }).eq("id", m.id);
      const obj = objetoPrivadoDe(nuevo);
      if (obj) aFirmar.push({ id: m.id, bucket: obj.bucket, ruta: obj.ruta });
      else urls[m.id] = nuevo;
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESCATES_A_LA_VEZ, cola.length) }, trabajador));

  // Firmas EN LOTE, una llamada por bucket (antes, una por archivo y en fila).
  const porBucket = new Map<string, { id: string; ruta: string }[]>();
  for (const f of aFirmar) {
    const lista = porBucket.get(f.bucket) ?? [];
    lista.push({ id: f.id, ruta: f.ruta });
    porBucket.set(f.bucket, lista);
  }
  for (const [bucket, items] of porBucket) {
    const { data: firmadas, error: errFirma } = await sb.storage
      .from(bucket)
      .createSignedUrls([...new Set(items.map((i) => i.ruta))], 3600);
    if (errFirma || !firmadas) {
      // No se pudo firmar ahora: que el navegador lo vuelva a pedir.
      for (const it of items) pendientes.push(it.id);
      continue;
    }
    const porRuta = new Map<string, string | null>();
    for (const f of firmadas) if (f.path) porRuta.set(f.path, f.signedUrl ?? null);
    for (const it of items) urls[it.id] = porRuta.get(it.ruta) ?? null;
  }

  return NextResponse.json({ ok: true, urls, pendientes });
}
