// radar-worker/src/db.ts — Acceso a Supabase (service-role) del worker del Radar IA. SOLO servidor.
//
// Helpers sobre las tablas del módulo (supabase/radar-ia.sql):
//   radar_estado    → estado de la sesión WhatsApp (fila única id=1, QR, latido)
//   radar_grupos    → grupos detectados (el flag `activo` lo maneja el usuario en /radar-ia, NUNCA pisarlo)
//   radar_mensajes  → mensajes crudos capturados (dedupe por wa_message_id)
//   storage radar-media → fotos de vouchers, PDFs y audios
// Ninguno de estos helpers lanza por errores de red/BD: registran en consola y siguen,
// porque el worker debe sobrevivir a caídas momentáneas de Supabase.

import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Tipos locales (espejo mínimo de lib/radar/tipos.ts; el worker es un proyecto aparte) ──

export type EstadoConexion = "desconectado" | "esperando_qr" | "conectado";

export type PatchEstado = {
  estado?: EstadoConexion;
  qr_data_url?: string | null;
  numero?: string | null;
  detalle?: string | null;
  version_worker?: string | null;
  conectado_desde?: string | null;
  ultimo_latido?: string | null;
};

export type GrupoDetectado = {
  wa_group_id: string;
  nombre: string;
  participantes: number;
};

/** Info de un grupo activo cacheada en memoria (uuid interno + nombre para denormalizar). */
export type InfoGrupoActivo = { id: string; nombre: string };

export type FilaMensaje = {
  wa_message_id: string;
  grupo_id: string | null;
  wa_group_id: string | null;
  grupo_nombre: string | null;
  remitente_wa: string;
  remitente_nombre: string | null;
  tipo: "texto" | "imagen" | "documento" | "audio" | "video" | "otro";
  texto: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_nombre: string | null;
  ts_mensaje: string;
  estado: "pendiente";
};

// ── radar_estado ───────────────────────────────────────────────────────────

/** Upsert de la fila única (id=1) de radar_estado con updated_at fresco. */
export async function actualizarEstado(patch: PatchEstado): Promise<void> {
  try {
    const { error } = await supabase
      .from("radar_estado")
      .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) console.error("[radar-worker][db] actualizarEstado:", error.message);
  } catch (e: any) {
    console.error("[radar-worker][db] actualizarEstado:", e?.message ?? e);
  }
}

// ── radar_grupos ───────────────────────────────────────────────────────────

/**
 * Sincroniza la lista de grupos vista por WhatsApp con radar_grupos.
 * PRESERVA el flag `activo` (lo decide el usuario en /radar-ia > Grupos):
 *  - grupos nuevos → insert con activo: false (nadie se monitorea solo);
 *  - grupos existentes → solo update de nombre/participantes/updated_at.
 */
export async function sincronizarGrupos(grupos: GrupoDetectado[]): Promise<void> {
  if (grupos.length === 0) return;
  try {
    const { data: existentes, error: errSel } = await supabase
      .from("radar_grupos")
      .select("wa_group_id");
    if (errSel) {
      console.error("[radar-worker][db] sincronizarGrupos (select):", errSel.message);
      return;
    }
    const yaConocidos = new Set<string>((existentes ?? []).map((f: any) => f.wa_group_id));
    const ahora = new Date().toISOString();

    const nuevos = grupos.filter((g) => !yaConocidos.has(g.wa_group_id));
    if (nuevos.length > 0) {
      const { error: errIns } = await supabase.from("radar_grupos").insert(
        nuevos.map((g) => ({
          wa_group_id: g.wa_group_id,
          nombre: g.nombre,
          participantes: g.participantes,
          activo: false,
          updated_at: ahora,
        }))
      );
      if (errIns) console.error("[radar-worker][db] sincronizarGrupos (insert):", errIns.message);
      else console.log(`[radar-worker] ${nuevos.length} grupo(s) nuevo(s) detectado(s) (inactivos hasta activarlos en /radar-ia).`);
    }

    for (const g of grupos.filter((x) => yaConocidos.has(x.wa_group_id))) {
      const { error: errUpd } = await supabase
        .from("radar_grupos")
        .update({ nombre: g.nombre, participantes: g.participantes, updated_at: ahora })
        .eq("wa_group_id", g.wa_group_id);
      if (errUpd) console.error(`[radar-worker][db] sincronizarGrupos (update ${g.wa_group_id}):`, errUpd.message);
    }
  } catch (e: any) {
    console.error("[radar-worker][db] sincronizarGrupos:", e?.message ?? e);
  }
}

/** wa_group_ids de los grupos con activo=true (contrato mínimo del módulo). */
export async function cargarGruposActivos(): Promise<Set<string>> {
  const mapa = await cargarMapaGruposActivos();
  return new Set(mapa.keys());
}

/**
 * Mapa wa_group_id → { id (uuid interno), nombre } de los grupos activos.
 * Es lo que cachea el loop de mensajes: sirve a la vez de filtro de membresía
 * y de fuente para denormalizar grupo_id/grupo_nombre en radar_mensajes.
 */
export async function cargarMapaGruposActivos(): Promise<Map<string, InfoGrupoActivo>> {
  const mapa = new Map<string, InfoGrupoActivo>();
  try {
    const { data, error } = await supabase
      .from("radar_grupos")
      .select("id, wa_group_id, nombre")
      .eq("activo", true);
    if (error) {
      console.error("[radar-worker][db] cargarMapaGruposActivos:", error.message);
      return mapa;
    }
    for (const f of (data ?? []) as any[]) {
      mapa.set(f.wa_group_id, { id: f.id, nombre: f.nombre });
    }
  } catch (e: any) {
    console.error("[radar-worker][db] cargarMapaGruposActivos:", e?.message ?? e);
  }
  return mapa;
}

// ── radar_mensajes ─────────────────────────────────────────────────────────

/**
 * Inserta un mensaje crudo. Dedupe por wa_message_id (las reconexiones re-entregan):
 * upsert con ignoreDuplicates deja la fila original intacta si ya existía.
 * Devuelve true si no hubo error (haya insertado o sido duplicado).
 */
export async function insertarMensaje(fila: FilaMensaje): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("radar_mensajes")
      .upsert(fila, { onConflict: "wa_message_id", ignoreDuplicates: true });
    if (error) {
      console.error("[radar-worker][db] insertarMensaje:", error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error("[radar-worker][db] insertarMensaje:", e?.message ?? e);
    return false;
  }
}

// ── Storage radar-media ────────────────────────────────────────────────────

/**
 * Sube un archivo al bucket público radar-media y devuelve su URL pública,
 * o null si falló (el mensaje se guarda igual, solo que sin media).
 */
export async function subirMedia(
  path: string,
  buffer: Buffer,
  contentType: string
): Promise<string | null> {
  try {
    const { error } = await supabase.storage
      .from("radar-media")
      .upload(path, buffer, { contentType, upsert: true });
    if (error) {
      console.warn("[radar-worker][db] subirMedia:", error.message);
      return null;
    }
    const { data } = supabase.storage.from("radar-media").getPublicUrl(path);
    return data?.publicUrl ?? null;
  } catch (e: any) {
    console.warn("[radar-worker][db] subirMedia:", e?.message ?? e);
    return null;
  }
}
