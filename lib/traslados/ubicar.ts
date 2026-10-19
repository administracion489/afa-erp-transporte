// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/ubicar.ts — Texto o coordenadas → PuntoUbicado (con los nombres de distrito y
// barrio que da Google). SOLO SERVIDOR.
//
// Usa la misma tabla `geocode_cache` que el resto del ERP, con claves propias («zon:» y
// «zoninv:»), porque la caché general guarda solo lat/lng y aquí hacen falta los NOMBRES. El
// valor va en la columna `texto` como JSON. Mismo TTL (30 días: lo que permiten los términos de
// Google) y la misma LISTA BLANCA: solo ZERO_RESULTS se memoriza como «no existe»; un error de
// cuota o de facturación habla de NUESTRA cuenta, no de la dirección, y memorizarlo dejaría
// direcciones buenas sin ubicar durante un mes.
//
// Si la dirección solo dice «Lima» (Google la usa para varios distritos), se pregunta también por
// las coordenadas del punto: la geocodificación inversa suele dar el distrito exacto.
// ──────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CodigoUbicar, LugarEntrada, LugarUbicado } from "./api";
import { localidadUtil, nombresDeResultados, puntoDeResultados, unirNombres, type ResultadoGoogle } from "./geocodigo";
import type { PuntoUbicado } from "./motor";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

let admin: SupabaseClient | null | undefined;
function sbAdmin(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  admin = url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
  return admin;
}

type Memo = { encontrado: boolean; lat: number | null; lng: number | null; d?: string | null; l?: string[]; b?: string[] };

async function leer(clave: string): Promise<Memo | null> {
  const sb = sbAdmin();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from("geocode_cache").select("lat, lng, texto, encontrado, creado_at").eq("consulta", clave).maybeSingle();
    if (error || !data) return null;
    if (Date.now() - new Date(data.creado_at).getTime() > TTL_MS) return null;
    let j: { d?: string; l?: string[]; b?: string[] } = {};
    try { j = data.texto ? JSON.parse(data.texto) : {}; } catch { return null; }
    return { encontrado: !!data.encontrado, lat: data.lat == null ? null : Number(data.lat), lng: data.lng == null ? null : Number(data.lng), d: j.d ?? null, l: j.l ?? [], b: j.b ?? [] };
  } catch {
    return null;
  }
}

async function guardar(clave: string, m: Memo): Promise<void> {
  const sb = sbAdmin();
  if (!sb) return;
  try {
    await sb.from("geocode_cache").upsert({
      consulta: clave, encontrado: m.encontrado, lat: m.lat, lng: m.lng,
      texto: m.encontrado ? JSON.stringify({ d: m.d ?? null, l: m.l ?? [], b: m.b ?? [] }) : null,
      creado_at: new Date().toISOString(),
    }, { onConflict: "consulta" });
  } catch { /* best-effort */ }
}

const claveTexto = (t: string) => `zon:${t.trim().toLowerCase().replace(/\s+/g, " ")}`;
const claveCoords = (lat: number, lng: number) => `zoninv:${lat.toFixed(4)},${lng.toFixed(4)}`;

type Llamada = { codigo: CodigoUbicar; detalle: string; resultados: ResultadoGoogle[] };

async function llamarGoogle(params: string): Promise<Llamada> {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) return { codigo: "sin_clave", detalle: "Falta GOOGLE_MAPS_API_KEY en el servidor.", resultados: [] };
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}&key=${key}&region=pe&language=es`, {
      cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json();
    if (data.status === "OK" && Array.isArray(data.results) && data.results.length) return { codigo: "ok", detalle: "", resultados: data.results };
    if (data.status === "ZERO_RESULTS") return { codigo: "no_encontrado", detalle: "Google no encontró esa dirección.", resultados: [] };
    console.error(`[traslados/ubicar] Google → ${data.status ?? "sin status"} (no se memoriza)`);
    return { codigo: "error", detalle: `Google respondió ${data.status ?? "sin estado"}.`, resultados: [] };
  } catch (e) {
    console.error("[traslados/ubicar]", (e as Error)?.message);
    return { codigo: "error", detalle: "No se pudo consultar a Google.", resultados: [] };
  }
}

/** Coordenadas → nombres de distrito y barrio (geocodificación inversa, con caché). */
async function nombresDeCoords(lat: number, lng: number): Promise<{ codigo: CodigoUbicar; detalle: string; localidades: string[]; barrios: string[]; direccion: string | null }> {
  const clave = claveCoords(lat, lng);
  const memo = await leer(clave);
  if (memo) return { codigo: memo.encontrado ? "ok" : "no_encontrado", detalle: "", localidades: memo.l ?? [], barrios: memo.b ?? [], direccion: memo.d ?? null };
  const g = await llamarGoogle(`latlng=${lat},${lng}`);
  if (g.codigo === "no_encontrado") await guardar(clave, { encontrado: false, lat, lng });
  if (g.codigo !== "ok") return { codigo: g.codigo, detalle: g.detalle, localidades: [], barrios: [], direccion: null };
  const n = nombresDeResultados(g.resultados);
  const direccion = g.resultados[0]?.formatted_address ?? null;
  await guardar(clave, { encontrado: true, lat, lng, d: direccion, l: n.localidades, b: n.barrios });
  return { codigo: "ok", detalle: "", ...n, direccion };
}

async function ubicarTexto(texto: string): Promise<LugarUbicado> {
  const clave = claveTexto(texto);
  let punto: PuntoUbicado | null = null;
  const memo = await leer(clave);
  if (memo) {
    if (!memo.encontrado || memo.lat == null || memo.lng == null) return { codigo: "no_encontrado", detalle: `Google no encontró «${texto}».`, punto: null };
    punto = { texto: memo.d ?? texto, lat: memo.lat, lng: memo.lng, localidades: memo.l ?? [], barrios: memo.b ?? [] };
  } else {
    const g = await llamarGoogle(`address=${encodeURIComponent(texto)}&components=country:PE`);
    if (g.codigo === "no_encontrado") {
      await guardar(clave, { encontrado: false, lat: null, lng: null });
      return { codigo: "no_encontrado", detalle: `Google no encontró «${texto}».`, punto: null };
    }
    if (g.codigo !== "ok") return { codigo: g.codigo, detalle: g.detalle, punto: null };
    punto = puntoDeResultados(texto, g.resultados);
    if (!punto) return { codigo: "no_encontrado", detalle: `Google no dio coordenadas para «${texto}».`, punto: null };
    await guardar(clave, { encontrado: true, lat: punto.lat, lng: punto.lng, d: punto.texto, l: punto.localidades, b: punto.barrios });
  }
  if (!localidadUtil(punto) && punto.lat != null && punto.lng != null) {
    const inv = await nombresDeCoords(punto.lat, punto.lng);
    if (inv.codigo === "ok") punto = unirNombres(punto, inv);
  }
  return { codigo: "ok", detalle: "", punto };
}

async function ubicarCoords(lat: number, lng: number, texto?: string): Promise<LugarUbicado> {
  const inv = await nombresDeCoords(lat, lng);
  // Con las coordenadas ya se puede decidir la geocerca aunque Google no diga nombres.
  const punto: PuntoUbicado = { texto: texto || inv.direccion || `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng, localidades: inv.localidades, barrios: inv.barrios };
  return { codigo: "ok", detalle: inv.codigo === "ok" ? "" : inv.detalle, punto };
}

/** Un lugar de la entrada → PuntoUbicado. Un texto vacío es «no lo dijo» (lo pregunta el motor). */
export async function ubicarLugar(l: LugarEntrada): Promise<LugarUbicado> {
  if (typeof l === "string") {
    const t = l.trim();
    if (!t) return { codigo: "vacio", detalle: "", punto: null };
    return ubicarTexto(t);
  }
  return ubicarCoords(l.lat, l.lng, l.texto);
}
