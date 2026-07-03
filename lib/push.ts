// lib/push.ts — SOLO SERVIDOR. Envío de notificaciones push nativas al pasajero.
//
// Un backend, dos transportes:
//   • webpush (VAPID): navegador Android, PWA instalada, iOS 16.4+ instalada en inicio.
//   • fcm (HTTP v1):   app Capacitor de Play Store (com.transportesafa.pasajero) con el
//     plugin @capacitor/push-notifications (APK v14+). Token OAuth vía google-auth-library
//     (NO firebase-admin: arrastra decenas de MB para un simple POST).
//
// Las suscripciones viven en push_suscripciones keyed por pasajero_id — el envío nunca
// depende del token de sesión de 24h del pasajero. Poda: 404/410/UNREGISTERED desactivan
// la suscripción; otros errores suman `fallos` y a los 5 consecutivos se desactiva.
//
// El dedupe anti-spam de eventos de viaje es la UNICIDAD de push_eventos_viaje:
// emitirEventoViaje intenta INSERT y un 23505 significa "ya se envió" (race-safe entre
// lambdas concurrentes — mismo patrón que el walk-on de embarcar_qr).

import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { JWT } from "google-auth-library";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ─── TIPOS ────────────────────────────────────────────────────────────────────

export type PushPayload = {
  title: string;
  body: string;
  tag: string;                 // mismo tag = colapsan en la bandeja
  url: string;                 // deep-link del notificationclick
  renotify?: boolean;
  requireInteraction?: boolean;
};

export type EventoViaje = "salio" | "quedan_paradas" | "aproximandose" | "llego" | "embarcado";

type OpcionesEnvio = { ttl?: number; urgencia?: "high" | "normal" };

// ─── CONFIG PEREZOSA (no romper el build si faltan env vars) ──────────────────

let vapidListo: boolean | null = null;
function vapidOk(): boolean {
  if (vapidListo !== null) return vapidListo;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { vapidListo = false; return false; }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:administracion@afatoursperu.com",
    pub, priv,
  );
  vapidListo = true;
  return true;
}

// Cliente OAuth para FCM v1; cachea el access token en memoria de módulo (el cold
// start solo re-pide el token, costo trivial).
let fcmJwt: JWT | null | undefined;
function fcmCliente(): JWT | null {
  if (fcmJwt !== undefined) return fcmJwt;
  const email = process.env.FIREBASE_CLIENT_EMAIL;
  const key = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !key || !process.env.FIREBASE_PROJECT_ID) { fcmJwt = null; return null; }
  fcmJwt = new JWT({ email, key, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  return fcmJwt;
}

// ─── ENVÍO ────────────────────────────────────────────────────────────────────

type Suscripcion = {
  id: number; pasajero_id: number; tipo: "webpush" | "fcm";
  endpoint: string | null; p256dh: string | null; auth: string | null;
  fcm_token: string | null; fallos: number;
};

async function podar(id: number) {
  await supabaseAdmin.from("push_suscripciones").update({ activo: false, updated_at: new Date().toISOString() }).eq("id", id);
}
async function sumarFallo(s: Suscripcion) {
  const fallos = (s.fallos ?? 0) + 1;
  await supabaseAdmin.from("push_suscripciones")
    .update({ fallos, activo: fallos < 5, updated_at: new Date().toISOString() })
    .eq("id", s.id);
}
async function marcarSana(s: Suscripcion) {
  if ((s.fallos ?? 0) > 0) {
    await supabaseAdmin.from("push_suscripciones").update({ fallos: 0, updated_at: new Date().toISOString() }).eq("id", s.id);
  }
}

async function enviarWebPush(s: Suscripcion, payload: PushPayload, op: OpcionesEnvio): Promise<boolean> {
  if (!vapidOk() || !s.endpoint || !s.p256dh || !s.auth) return false;
  try {
    await webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify(payload),
      { TTL: op.ttl ?? 900, urgency: op.urgencia ?? "normal" },
    );
    await marcarSana(s);
    return true;
  } catch (e: any) {
    const code = e?.statusCode;
    if (code === 404 || code === 410) await podar(s.id);   // suscripción muerta
    else await sumarFallo(s);
    console.warn("[push] webpush falló:", code, e?.message);
    return false;
  }
}

async function enviarFcm(s: Suscripcion, payload: PushPayload, op: OpcionesEnvio): Promise<boolean> {
  const jwt = fcmCliente();
  if (!jwt || !s.fcm_token) return false;
  try {
    const { token } = await jwt.getAccessToken();
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: s.fcm_token,
            notification: { title: payload.title, body: payload.body },
            android: {
              priority: op.urgencia === "high" ? "HIGH" : "NORMAL",
              ttl: `${op.ttl ?? 900}s`,
              notification: {
                channel_id: "afa_viaje",
                tag: payload.tag,
                notification_priority: op.urgencia === "high" ? "PRIORITY_MAX" : "PRIORITY_DEFAULT",
              },
            },
            data: { url: payload.url },
          },
        }),
      },
    );
    if (res.ok) { await marcarSana(s); return true; }
    const cuerpo = await res.text();
    // Token dado de baja (app desinstalada / datos borrados) → poda inmediata.
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(cuerpo)) await podar(s.id);
    else await sumarFallo(s);
    console.warn("[push] fcm falló:", res.status, cuerpo.slice(0, 200));
    return false;
  } catch (e: any) {
    await sumarFallo(s);
    console.warn("[push] fcm error:", e?.message);
    return false;
  }
}

/**
 * Envía un push a todas las suscripciones activas de los pasajeros dados.
 * Nunca lanza: devuelve conteos (un fallo de push jamás debe romper al llamador).
 */
export async function enviarPushAPasajeros(
  pasajeroIds: number[],
  payload: PushPayload,
  opciones: OpcionesEnvio = {},
): Promise<{ enviados: number; fallidos: number; sinSuscripcion: number }> {
  const ids = [...new Set(pasajeroIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return { enviados: 0, fallidos: 0, sinSuscripcion: 0 };
  try {
    const { data: subs, error } = await supabaseAdmin
      .from("push_suscripciones")
      .select("id, pasajero_id, tipo, endpoint, p256dh, auth, fcm_token, fallos")
      .in("pasajero_id", ids)
      .eq("activo", true);
    if (error) {
      console.warn("[push] no se pudieron leer suscripciones:", error.message);
      return { enviados: 0, fallidos: 0, sinSuscripcion: ids.length };
    }
    const lista = (subs || []) as Suscripcion[];
    const conSub = new Set(lista.map((s) => s.pasajero_id));
    const resultados = await Promise.allSettled(
      lista.map((s) => (s.tipo === "fcm" ? enviarFcm(s, payload, opciones) : enviarWebPush(s, payload, opciones))),
    );
    const enviados = resultados.filter((r) => r.status === "fulfilled" && r.value).length;
    return {
      enviados,
      fallidos: lista.length - enviados,
      sinSuscripcion: ids.length - conSub.size,
    };
  } catch (e: any) {
    console.warn("[push] envío falló:", e?.message);
    return { enviados: 0, fallidos: ids.length, sinSuscripcion: 0 };
  }
}

// ─── EVENTOS DE VIAJE (dedupe insert-once) ────────────────────────────────────

/**
 * Registra el evento en push_eventos_viaje y, si es la PRIMERA vez (insert OK),
 * envía el push. Un 23505 significa "ya se envió" → no reenvía (race-safe).
 * payload=null registra sin enviar (p.ej. consumir 'aproximandose' cuando ya
 * se emitió 'llego', para que nunca llegue "está llegando" DESPUÉS de "ya llegó").
 * Si el INSERT falla por otra razón (tabla ausente), NO envía: sin dedupe
 * garantizado, enviar arriesga spam en cada heartbeat.
 */
export async function emitirEventoViaje(args: {
  reservaId: number;
  evento: EventoViaje;
  paradaId?: number | null;
  pasajeroId?: number | null;
  destinatarios: number[];
  payload: PushPayload | null;
  ttl?: number;
  urgencia?: "high" | "normal";
}): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from("push_eventos_viaje").insert({
      reserva_id: args.reservaId,
      parada_id: args.paradaId ?? null,
      pasajero_id: args.pasajeroId ?? null,
      evento: args.evento,
    });
    if (error) {
      const dup = error.code === "23505" || /duplicate key value/i.test(error.message || "");
      if (!dup) console.warn("[push] evento no registrado:", args.evento, error.message);
      return false;
    }
    if (args.payload && args.destinatarios.length > 0) {
      await enviarPushAPasajeros(args.destinatarios, args.payload, { ttl: args.ttl, urgencia: args.urgencia });
    }
    return true;
  } catch (e: any) {
    console.warn("[push] emitirEventoViaje:", e?.message);
    return false;
  }
}

// ─── DESTINATARIOS ────────────────────────────────────────────────────────────

// Estados que EXCLUYEN a un pasajero de los avisos de llegada: ya abordó, canceló
// o quedó No Show. Mismo mapeo que la acción "ruta" de /api/pasajero.
function esperando(pp: { estado?: string | null; estado_abordaje?: string | null }): boolean {
  if (["Abordado", "Cancelado", "No Show"].includes(pp.estado_abordaje || "")) return false;
  if (["abordado", "embarcado"].includes(pp.estado || "")) return false;
  return true;
}

/** Pasajeros de una parada que AÚN ESPERAN el bus (para 'aproximandose'/'llego'/'quedan_paradas'). */
export async function pasajerosEsperandoDeParada(paradaId: number): Promise<number[]> {
  const { data } = await supabaseAdmin
    .from("pasajeros_parada")
    .select("pasajero_id, estado, estado_abordaje")
    .eq("parada_id", paradaId);
  return [...new Set((data || []).filter(esperando).map((pp: any) => Number(pp.pasajero_id)))];
}

/** Pasajeros de toda la reserva no cancelados/No Show (para 'salio'). */
export async function pasajerosDeReserva(reservaId: number): Promise<number[]> {
  const { data: paradas } = await supabaseAdmin.from("paradas").select("id").eq("reserva_id", reservaId);
  const ids = (paradas || []).map((p: any) => p.id);
  if (ids.length === 0) return [];
  const { data } = await supabaseAdmin
    .from("pasajeros_parada")
    .select("pasajero_id, estado_abordaje")
    .in("parada_id", ids);
  return [...new Set(
    (data || [])
      .filter((pp: any) => !["Cancelado", "No Show"].includes(pp.estado_abordaje || ""))
      .map((pp: any) => Number(pp.pasajero_id)),
  )];
}

// ─── PAYLOADS (textos en español, estilo de las plantillas existentes) ─────────

export const payloadsViaje = {
  salio: (reservaId: number, origen?: string | null, destino?: string | null): PushPayload => ({
    title: "🚌 ¡Tu bus ya salió!",
    body: origen && destino
      ? `Tu servicio ${origen} → ${destino} está en camino. Ábreme para seguirlo en vivo.`
      : "Tu servicio está en camino. Ábreme para seguirlo en vivo.",
    tag: `afa-salio-${reservaId}`,
    url: "/pasajero",
  }),
  quedanParadas: (paradaId: number, paradaNombre: string): PushPayload => ({
    title: "🚏 Quedan 2 paradas",
    body: `El bus está a 2 paraderos del tuyo (${paradaNombre}). Ve acercándote.`,
    tag: `afa-quedan-${paradaId}`,
    url: "/pasajero",
  }),
  aproximandose: (paradaId: number, paradaNombre: string, etaMin?: number | null): PushPayload => ({
    title: etaMin ? `⏱️ Tu bus llega en ~${etaMin} min` : "⏱️ Tu bus está llegando",
    body: `Acércate a tu paradero: ${paradaNombre}.`,
    tag: `afa-eta-${paradaId}`,
    url: "/pasajero",
  }),
  llego: (paradaId: number, paradaNombre: string): PushPayload => ({
    title: "📍 ¡TU BUS YA LLEGÓ!",
    body: `El bus está en tu paradero ${paradaNombre}. ¡Sube ahora!`,
    tag: `afa-llego-${paradaId}`,
    url: "/pasajero",
    renotify: true,
    requireInteraction: true,
  }),
  embarcado: (reservaId: number, nombre: string, horaHHmm: string): PushPayload => ({
    title: "✅ Embarque confirmado",
    body: `¡Buen viaje, ${nombre}! Tu abordaje quedó registrado a las ${horaHHmm}.`,
    tag: `afa-emb-${reservaId}`,
    url: "/pasajero",
  }),
  recordatorio: (reservaId: number, fecha: string, hora: string, paradaNombre: string): PushPayload => ({
    title: `⏰ Transporte mañana`,
    body: `${fecha} · Recojo ${hora} en ${paradaNombre}. Espera 5 min antes en tu paradero.`,
    tag: `afa-rec-${reservaId}`,
    url: "/pasajero",
  }),
  confirmacion: (reservaId: number, fecha: string, hora: string, paradaNombre: string): PushPayload => ({
    title: "🚌 Servicio confirmado",
    body: `${fecha} · Recojo ${hora} en ${paradaNombre}.`,
    tag: `afa-rec-${reservaId}`,
    url: "/pasajero",
  }),
};

/** Hora actual de Lima "HH:mm" (para el texto de embarque). */
export function horaLimaHHmm(): string {
  return new Date().toLocaleTimeString("es-PE", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Lima",
  });
}
