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
  /** Solo se escribe cuando la lectura de grupos SALIÓ BIEN (no cuando se intentó). */
  grupos_sincronizados_en?: string | null;
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
  /**
   * Jid del autor, o `null` cuando WhatsApp no lo entrega. NUNCA `""`: un valor de relleno es
   * IGUAL para todas las personas, y el ERP agrupa las fotos de un reporte por remitente — con
   * un comodín compartido se fusionan en una sola recarga las fotos de varios celulares
   * (ver lib/radar/cluster-remitente.ts). Sin remitente, ese mensaje no agrupa con nadie.
   */
  remitente_wa: string | null;
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

/** Banderas que el dashboard prende con sus botones y el worker atiende. */
export type Solicitudes = { relink: boolean; syncGrupos: boolean };
export type CampoSolicitud = "solicitar_relink" | "solicitar_sync_grupos";

/**
 * Lee de una sola consulta todo lo que el ERP puede haber pedido (botones de /radar-ia).
 * Va junto a propósito: el poll corre cada 5 s y no tiene sentido pagar una consulta por
 * bandera. Si la columna aún no existe (falta correr el SQL incremental), devuelve false
 * en vez de romper el poll.
 */
export async function leerSolicitudes(): Promise<Solicitudes> {
  try {
    // select("*") y no la lista de columnas: si el SQL incremental todavía no se corrió,
    // nombrar una columna inexistente haría fallar la consulta entera y se llevaría por
    // delante el relink, que sí funciona desde antes.
    const { data, error } = await supabase
      .from("radar_estado")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) return { relink: false, syncGrupos: false };
    return {
      relink: !!(data as any)?.solicitar_relink,
      syncGrupos: !!(data as any)?.solicitar_sync_grupos,
    };
  } catch {
    return { relink: false, syncGrupos: false };
  }
}

/** Baja una bandera apenas se atiende, para no repetir la acción en el chequeo siguiente. */
export async function limpiarSolicitud(campo: CampoSolicitud): Promise<void> {
  try {
    const { error } = await supabase.from("radar_estado").update({ [campo]: false }).eq("id", 1);
    if (error) console.error(`[radar-worker][db] limpiarSolicitud(${campo}):`, error.message);
  } catch (e: any) {
    console.error(`[radar-worker][db] limpiarSolicitud(${campo}):`, e?.message ?? e);
  }
}

// ── radar_grupos ───────────────────────────────────────────────────────────

/**
 * ¿La BD ya tiene las columnas de vigencia (supabase/radar-ia-grupos-vigencia.sql)?
 * Se comprueba una sola vez por proceso: si el SQL incremental no se corrió, el worker
 * sigue sincronizando nombres y grupos nuevos como siempre, solo que sin poder marcar
 * los que el número dejó de ver. Degradar es mejor que romper la sincronización entera.
 */
let soportaVigencia: boolean | null = null;

async function detectarVigencia(): Promise<boolean> {
  if (soportaVigencia !== null) return soportaVigencia;
  const { error } = await supabase.from("radar_grupos").select("visible").limit(1);
  soportaVigencia = !error;
  if (!soportaVigencia) {
    console.warn(
      "[radar-worker][db] radar_grupos.visible no existe — corre supabase/radar-ia-grupos-vigencia.sql. " +
        "Mientras tanto no se puede marcar qué grupos quedaron del número anterior."
    );
  }
  return soportaVigencia;
}

/** Trocea una lista para no armar filtros `in(...)` de largo indefinido. */
function enLotes<T>(lista: T[], tamano: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < lista.length; i += tamano) lotes.push(lista.slice(i, i + tamano));
  return lotes;
}

/**
 * Sincroniza la lista de grupos vista por WhatsApp con radar_grupos.
 *
 * PRESERVA el flag `activo` (lo decide el usuario en /radar-ia > Grupos):
 *  - grupos nuevos → insert con activo: false (nadie se monitorea solo);
 *  - grupos que el número ve → update de nombre/participantes + marca de vigencia;
 *  - grupos que el número YA NO ve → `visible = false`. **Nunca se borran**: conservan el
 *    contexto escrito para ELIA, las categorías y los mensajes ya capturados. Sin esta
 *    marca, al cambiar de número la lista quedaba mezclada con los grupos del anterior,
 *    algunos en "Monitorear" y por lo tanto aparentando vigilancia que no existía.
 */
export async function sincronizarGrupos(grupos: GrupoDetectado[]): Promise<void> {
  // Una lista vacía NO se interpreta como "este número no está en ningún grupo": es
  // también lo que devuelve una sesión a medio inicializar. Marcar todo como no visible
  // por esa ambigüedad sería peor que no hacer nada.
  if (grupos.length === 0) {
    console.warn("[radar-worker][db] WhatsApp no devolvió ningún grupo — radar_grupos queda intacta.");
    return;
  }
  try {
    const vigencia = await detectarVigencia();
    // select("*") para no depender de columnas que quizá aún no existen.
    const { data: existentes, error: errSel } = await supabase.from("radar_grupos").select("*");
    if (errSel) {
      console.error("[radar-worker][db] sincronizarGrupos (select):", errSel.message);
      return;
    }
    const filasPrevias = (existentes ?? []) as { wa_group_id: string; visible?: boolean }[];
    const yaConocidos = new Set<string>(filasPrevias.map((f) => f.wa_group_id));
    const vistosAhora = new Set<string>(grupos.map((g) => g.wa_group_id));
    const ahora = new Date().toISOString();
    const marcaVigente = vigencia ? { visible: true, visto_en: ahora } : {};

    const nuevos = grupos.filter((g) => !yaConocidos.has(g.wa_group_id));
    if (nuevos.length > 0) {
      const { error: errIns } = await supabase.from("radar_grupos").insert(
        nuevos.map((g) => ({
          wa_group_id: g.wa_group_id,
          nombre: g.nombre,
          participantes: g.participantes,
          activo: false,
          updated_at: ahora,
          ...marcaVigente,
        }))
      );
      if (errIns) console.error("[radar-worker][db] sincronizarGrupos (insert):", errIns.message);
      else console.log(`[radar-worker] ${nuevos.length} grupo(s) nuevo(s) detectado(s) (inactivos hasta activarlos en /radar-ia).`);
    }

    for (const g of grupos.filter((x) => yaConocidos.has(x.wa_group_id))) {
      const { error: errUpd } = await supabase
        .from("radar_grupos")
        .update({ nombre: g.nombre, participantes: g.participantes, updated_at: ahora, ...marcaVigente })
        .eq("wa_group_id", g.wa_group_id);
      if (errUpd) console.error(`[radar-worker][db] sincronizarGrupos (update ${g.wa_group_id}):`, errUpd.message);
    }

    if (vigencia) {
      // Solo los que hoy figuran como visibles: así no se reescriben en cada barrido los
      // que ya estaban marcados desde el cambio de número.
      const perdidos = filasPrevias
        .filter((f) => !vistosAhora.has(f.wa_group_id) && f.visible !== false)
        .map((f) => f.wa_group_id);
      for (const lote of enLotes(perdidos, 100)) {
        const { error: errOculta } = await supabase
          .from("radar_grupos")
          .update({ visible: false, updated_at: ahora })
          .in("wa_group_id", lote);
        if (errOculta) console.error("[radar-worker][db] sincronizarGrupos (marcar perdidos):", errOculta.message);
      }
      if (perdidos.length > 0) {
        console.log(`[radar-worker] ${perdidos.length} grupo(s) ya no son visibles para este número (quedaron marcados, no se borraron).`);
      }
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
