// lib/plantilla-texto.ts — SOLO SERVIDOR.
// Reusa el TEXTO de las plantillas de WhatsApp (Meta) como cuerpo de los correos.
//
// Por qué: el usuario ya edita los textos de sus avisos en un solo lugar
// (/configuracion/operaciones → "Textos de los mensajes"). Redactar un segundo juego
// de textos para email obligaría a mantener dos versiones del mismo mensaje y a que
// se desincronicen. Aquí se toma el MISMO body aprobado y se interpola igual que
// hace Meta, así el correo dice exactamente lo mismo que el WhatsApp.
//
// Cascada de lectura (barata → cara), porque esto corre dentro del envío:
//   1. memo de proceso (6 h)
//   2. plantilla_texto_cache (Supabase)
//   3. Graph API de Meta  → y se cachea
// Si Meta falla pero hay caché vencido, se usa el caché vencido: un texto viejo es
// mejor que no mandar el aviso.
//
// REGLA DE ORO: si no hay body, NO se inventa texto — se devuelve null y el llamador
// registra `sin_canal`. Nunca mandar un correo con huecos o con texto improvisado.

import { createClient } from "@supabase/supabase-js";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const GRAPH = "https://graph.facebook.com/v25.0";
// WABA de AVISOS (+51 905438216) — de aquí salen las plantillas de conductor/pasajero.
// Se va a Graph directo (no vía /api/plantillas-meta) porque esa ruta exige sesión de
// usuario y esto corre desde un cron.
const WABA_AVISOS = "1336334522036982";

const TTL_MEMO_MS = 6 * 60 * 60 * 1000; // 6 h
const memo = new Map<string, { body: string; vars: number; at: number }>();

export type PlantillaTexto = { nombre: string; body: string; vars: number };

/** Variables {{n}} distintas presentes en el texto, ordenadas. */
export function extraerVars(texto: string): string[] {
  return [...new Set((texto.match(/\{\{\s*\d+\s*\}\}/g) ?? []).map((v) => v.replace(/\s/g, "")))].sort();
}

/**
 * Texto (body) de una plantilla aprobada. Devuelve null si no se pudo obtener —
 * el llamador NO debe inventar texto en ese caso.
 */
export async function textoPlantilla(nombre: string): Promise<PlantillaTexto | null> {
  if (!nombre?.trim()) return null;
  const clave = nombre.trim();

  // 1) Memo de proceso
  const m = memo.get(clave);
  if (m && Date.now() - m.at < TTL_MEMO_MS) {
    return { nombre: clave, body: m.body, vars: m.vars };
  }

  // 2) Caché en BD
  let cacheado: PlantillaTexto | null = null;
  try {
    const { data } = await db
      .from("plantilla_texto_cache")
      .select("nombre, body, vars")
      .eq("nombre", clave)
      .maybeSingle();
    if (data?.body) {
      cacheado = { nombre: clave, body: data.body, vars: data.vars ?? extraerVars(data.body).length };
      memo.set(clave, { body: cacheado.body, vars: cacheado.vars, at: Date.now() });
      return cacheado;
    }
  } catch { /* tabla sin migrar → sigue a Meta */ }

  // 3) Meta (Graph) — y cachear
  try {
    const token = process.env.META_WA_TOKEN;
    if (!token) return cacheado;
    const res = await fetch(
      `${GRAPH}/${WABA_AVISOS}/message_templates?fields=name,status,language,components&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    if (!res.ok) return cacheado;

    const filas: { nombre: string; idioma: string; body: string; estado: string; vars: number }[] = [];
    for (const t of data.data ?? []) {
      const body = (t.components ?? []).find((c: any) => c.type === "BODY")?.text ?? "";
      if (!body) continue;
      filas.push({
        nombre: t.name, idioma: t.language ?? "es", body,
        estado: t.status ?? "", vars: extraerVars(body).length,
      });
    }
    if (filas.length) {
      // Se cachean TODAS de una: la llamada a Meta ya se pagó.
      await refrescarCache(filas);
    }
    const mia = filas.find((f) => f.nombre === clave);
    if (mia) {
      memo.set(clave, { body: mia.body, vars: mia.vars, at: Date.now() });
      return { nombre: clave, body: mia.body, vars: mia.vars };
    }
  } catch { /* red caída → cae al caché vencido si lo hay */ }

  return cacheado;
}

/** Guarda/actualiza el texto de varias plantillas en el caché de BD. */
export async function refrescarCache(
  filas: { nombre: string; idioma?: string; body: string; estado?: string; vars?: number }[],
): Promise<void> {
  if (!filas.length) return;
  try {
    await db.from("plantilla_texto_cache").upsert(
      filas.map((f) => ({
        nombre: f.nombre,
        idioma: f.idioma ?? "es",
        body: f.body,
        estado: f.estado ?? null,
        vars: f.vars ?? extraerVars(f.body).length,
        actualizado_at: new Date().toISOString(),
      })),
      { onConflict: "nombre" },
    );
    for (const f of filas) {
      memo.set(f.nombre, { body: f.body, vars: f.vars ?? extraerVars(f.body).length, at: Date.now() });
    }
  } catch { /* caché es best-effort: nunca romper el flujo por esto */ }
}

/**
 * Sustituye {{1}}, {{2}}… por los parámetros, EN ORDEN (igual que Meta).
 * Devuelve null si la cantidad de variables no coincide: eso significa que alguien
 * editó la plantilla en Meta y el correo saldría con huecos o con los datos corridos.
 * Ante la duda, no enviar.
 */
export function interpolar(body: string, params: string[]): string | null {
  const vars = extraerVars(body);
  if (vars.length !== params.length) return null;
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] ?? "");
}

function escaparHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Convierte el marcado de WhatsApp a HTML. Escapa PRIMERO (los datos interpolados
 * vienen de la BD y podrían traer < o &).
 *   *negrita*  _cursiva_  ~tachado~  ```mono```   y saltos de línea → <br>
 */
export function waAHtml(texto: string): string {
  let h = escaparHtml(texto);
  h = h.replace(/```([\s\S]+?)```/g, '<code style="background:#f1f5f9;padding:1px 4px;border-radius:4px">$1</code>');
  h = h.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1<strong>$2</strong>");
  h = h.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
  h = h.replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?]|$)/g, "$1<del>$2</del>");
  return h.replace(/\n/g, "<br>");
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.transportesafa.com";

/**
 * Envoltura HTML del correo de aviso, con la misma identidad visual que los correos
 * que ya salen del ERP. `botones` son enlaces opcionales (los botones de la plantilla
 * de WhatsApp no vienen en el body, hay que reconstruirlos aquí).
 */
export function htmlEmailAviso(opts: {
  titulo: string;
  cuerpoHtml: string;
  botones?: { texto: string; url: string }[];
}): string {
  const botones = (opts.botones ?? [])
    .filter((b) => b.url)
    .map((b) =>
      `<a href="${b.url}" style="display:inline-block;background:#0b315f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:10px;margin:6px 8px 0 0">${escaparHtml(b.texto)}</a>`)
    .join("");

  return `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:0;background:#eef3f8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f8;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
      <tr><td style="background:#0b315f;padding:18px 24px">
        <img src="${APP_URL}/logoafacotizacion-removebg-preview.png" alt="AFA Transportes" height="34" style="height:34px;display:block;border:0" />
      </td></tr>
      <tr><td style="padding:24px">
        <h1 style="margin:0 0 14px;font-size:17px;color:#0b315f">${escaparHtml(opts.titulo)}</h1>
        <div style="font-size:14px;color:#1f2937;line-height:1.6">${opts.cuerpoHtml}</div>
        ${botones ? `<div style="margin-top:18px">${botones}</div>` : ""}
      </td></tr>
      <tr><td style="padding:14px 24px;background:#f8fafc;font-size:11px;color:#94a3b8">
        Mensaje automático de AFA Transportes. Si tienes dudas, responde a este correo.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * Atajo completo: nombre de plantilla + params → HTML listo para enviar.
 * Devuelve null si no hay texto o si las variables no cuadran (no inventar nada).
 */
export async function emailDesdePlantilla(
  plantilla: string,
  params: string[],
  opts: { titulo: string; botones?: { texto: string; url: string }[] },
): Promise<{ html: string; texto: string } | null> {
  const tpl = await textoPlantilla(plantilla);
  if (!tpl) return null;
  const texto = interpolar(tpl.body, params);
  if (texto === null) return null;
  return { html: htmlEmailAviso({ titulo: opts.titulo, cuerpoHtml: waAHtml(texto), botones: opts.botones }), texto };
}
