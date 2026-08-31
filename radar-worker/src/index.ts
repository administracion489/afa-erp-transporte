// radar-worker/src/index.ts — Worker del Radar IA. SOLO servidor (proceso Node aparte del ERP).
//
// Mantiene la sesión de WhatsApp Web con Baileys (protocolo multi-device por WebSocket,
// sin navegador). El QR se escanea UNA vez: las credenciales quedan en AUTH_DIR y el
// worker se reconecta solo mientras la sesión siga válida. Por cada mensaje de un grupo
// ACTIVO (radar_grupos.activo) inserta una fila cruda en radar_mensajes y le avisa al ERP
// (POST /api/radar/procesar) para que ELIA clasifique y actúe. Independiente del CRM/Meta.
//
// ADVERTENCIA: Baileys es un cliente NO oficial. Usar SIEMPRE un número dedicado
// (ver README.md) — nunca el número del CRM ni el 2do número de avisos.

import * as baileysMod from "baileys";
import pino from "pino";
import qrcode from "qrcode";
import { rm } from "node:fs/promises";
import { config } from "./config.js";
import {
  actualizarEstado,
  sincronizarGrupos,
  cargarMapaGruposActivos,
  insertarMensaje,
  subirMedia,
  debeRelinkear,
  limpiarSolicitudRelink,
  type FilaMensaje,
  type InfoGrupoActivo,
} from "./db.js";

// ── Interop CJS/ESM de Baileys ─────────────────────────────────────────────
// Según cómo Node exponga el paquete (CJS bajo ESM), las funciones pueden colgar
// del namespace o de .default. Este bloque resuelve ambos casos sin romperse.
const _b: any = baileysMod as any;
const _raiz: any = typeof _b.makeWASocket === "function" ? _b : (_b.default ?? _b);
const makeWASocket: any = _raiz.makeWASocket ?? _b.default;
const useMultiFileAuthState: any = _raiz.useMultiFileAuthState ?? _b.useMultiFileAuthState;
// (el enum DisconnectReason no se usa: los códigos de cierre van como literales en COD,
//  más abajo, para que el diagnóstico no dependa de esta interop)
const fetchLatestBaileysVersion: any = _raiz.fetchLatestBaileysVersion ?? _b.fetchLatestBaileysVersion;
const downloadMediaMessage: any = _raiz.downloadMediaMessage ?? _b.downloadMediaMessage;

// ── Estado global del proceso ──────────────────────────────────────────────

const logger = pino({ level: "warn" });
const ARRANQUE_MS = Date.now();
/** Mensajes anteriores a (arranque − 5 min) se ignoran: son histórico re-entregado.
 *  El dedupe definitivo lo da el UNIQUE de radar_mensajes.wa_message_id. */
const TS_MINIMO_MS = ARRANQUE_MS - 5 * 60_000;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

// ── Códigos de cierre de WhatsApp ──────────────────────────────────────────
// Van como números literales A PROPÓSITO: son códigos del protocolo (fijos) y así
// el diagnóstico no depende de que el enum DisconnectReason sobreviva la interop
// CJS/ESM de arriba. Si no la sobreviviera, todas las comparaciones darían
// `undefined` y NINGÚN código haría match — que es exactamente cómo una sesión
// muerta se queda dando vueltas sin llegar a pedir un QR.
const COD = {
  desvinculado: 401,        // loggedOut: cerraron la sesión desde el teléfono
  prohibido: 403,           // forbidden: WhatsApp bloqueó/baneó el número
  noAutorizado: 405,        // WhatsApp rechaza las credenciales al conectar
  perdida: 408,             // connectionLost / timedOut (también vence así un ciclo de QRs)
  desajusteMultidevice: 411,
  cerrada: 428,             // connectionClosed
  reemplazada: 440,         // connectionReplaced
  sesionMala: 500,          // badSession — OJO: en Baileys es el default de CUALQUIER error no mapeado
  servicioCaido: 503,
  reinicioRequerido: 515,
} as const;

/**
 * Códigos que significan "estas credenciales ya no sirven": la única salida es
 * borrar auth/ y escanear un QR nuevo.
 *
 * Baileys solo emite el evento `qr` cuando NO hay credenciales guardadas. Así que
 * reconectar con credenciales muertas es un bucle infinito Y SIN QR: el worker
 * reintenta para siempre y en /radar-ia nunca aparece el código para vincular.
 * Ese era el agujero del 403 (número bloqueado por usar un cliente no oficial),
 * que caía en el backoff genérico y dejaba el Radar sin forma de cambiar de número.
 */
const CODIGOS_SESION_MUERTA: Record<number, string> = {
  [COD.desvinculado]: "Sesión cerrada desde el teléfono — escanea el QR para vincular un número",
  [COD.prohibido]:
    "WhatsApp BLOQUEÓ este número (403). No va a volver a conectar: escanea el QR con OTRO número dedicado",
  [COD.noAutorizado]:
    "WhatsApp rechazó las credenciales guardadas (405) — escanea el QR para vincular un número",
  [COD.desajusteMultidevice]:
    "El teléfono no tiene multi-dispositivo (411) — actualiza WhatsApp y escanea el QR de nuevo",
};

let sock: any = null;
/** Sube en cada conectar()/descarte. Los eventos de un socket viejo se ignoran si no coincide. */
let generacion = 0;
let gruposActivos: Map<string, InfoGrupoActivo> = new Map();
let intentosReconexion = 0;
/** 515s seguidos sin lograr un "open": tope para no caer en bucle caliente de reconexión. */
let reinicios515Seguidos = 0;
let timerReconexion: NodeJS.Timeout | null = null;
let timerProcesar: NodeJS.Timeout | null = null;
let cerrando = false;
/** Por qué estamos pidiendo un QR. Viaja con el código hasta que alguien lo escanea:
 *  si el número quedó bloqueado, eso es justo lo que hay que leer ANTES de escanear. */
let motivoQrPendiente: string | null = null;

// ── Utilitarios ────────────────────────────────────────────────────────────

function ahoraIso(): string {
  return new Date().toISOString();
}

/** Convierte number | bigint | Long (protobuf) | string a number seguro. */
function aNumero(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof v.toNumber === "function") return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Deja el texto apto para usarlo como segmento de ruta en Storage. */
function sanitizar(texto: string): string {
  return texto.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Extensión de archivo según el mimetype (para el path en radar-media). */
function extPorMime(mime: string): string {
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  switch (base) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "application/pdf": return "pdf";
    case "audio/ogg": return "ogg";
    case "audio/mpeg": return "mp3";
    default: return "bin";
  }
}

/** Desenvuelve wrappers de WhatsApp (efímeros, ver-una-vez, documento con caption). */
function desenvolver(mensaje: any): any {
  let contenido: any = mensaje;
  for (let i = 0; i < 5 && contenido; i++) {
    if (contenido.ephemeralMessage?.message) contenido = contenido.ephemeralMessage.message;
    else if (contenido.viewOnceMessage?.message) contenido = contenido.viewOnceMessage.message;
    else if (contenido.viewOnceMessageV2?.message) contenido = contenido.viewOnceMessageV2.message;
    else if (contenido.documentWithCaptionMessage?.message) contenido = contenido.documentWithCaptionMessage.message;
    else break;
  }
  return contenido;
}

// ── Grupos: sincronización con radar_grupos y cache de activos ─────────────

/** Refresca en memoria el mapa wa_group_id → { uuid, nombre } de grupos activos. */
async function refrescarCacheGrupos(): Promise<void> {
  gruposActivos = await cargarMapaGruposActivos();
}

/** Lee de WhatsApp todos los grupos donde participa el número y los upsertea en radar_grupos. */
async function sincronizarListaGrupos(): Promise<void> {
  if (!sock) return;
  try {
    const grupos = await sock.groupFetchAllParticipating();
    const lista = Object.entries(grupos ?? {}).map(([jid, meta]: [string, any]) => ({
      wa_group_id: jid,
      nombre: String(meta?.subject ?? ""),
      participantes: Array.isArray(meta?.participants) ? meta.participants.length : 0,
    }));
    await sincronizarGrupos(lista);
  } catch (e: any) {
    console.warn("[radar-worker] No se pudo sincronizar la lista de grupos:", e?.message ?? e);
  }
}

// ── Aviso al ERP (debounce 2 s tras insertar mensajes) ─────────────────────

function programarProcesamiento(): void {
  if (timerProcesar) clearTimeout(timerProcesar);
  timerProcesar = setTimeout(() => void notificarErp(), 2_000);
}

async function notificarErp(): Promise<void> {
  try {
    const res = await fetch(`${config.erpUrl}/api/radar/procesar`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.workerSecret}`,
      },
      body: JSON.stringify({ limite: 30 }),
    });
    const cuerpo = (await res.text()).slice(0, 300);
    if (res.ok) console.log(`[radar-worker] ERP notificado (/api/radar/procesar): ${cuerpo}`);
    else console.warn(`[radar-worker] El ERP respondió ${res.status} al procesar: ${cuerpo}`);
  } catch (e: any) {
    // Nunca tumbar el worker por esto: el cron del ERP barre lo que quede pendiente.
    console.warn("[radar-worker] No se pudo avisar al ERP (el cron barrerá los pendientes):", e?.message ?? e);
  }
}

// ── Procesamiento de un mensaje entrante ───────────────────────────────────

/** Extrae, sube media si corresponde e inserta la fila en radar_mensajes. Devuelve true si insertó. */
async function procesarMensaje(msg: any): Promise<boolean> {
  if (!msg?.message || !msg.key?.id) return false;

  const jid: string = String(msg.key.remoteJid ?? "");
  if (!jid.endsWith("@g.us")) return false; // solo grupos

  // Sin grupos activos configurados no hay nada que monitorear: salir en silencio.
  if (gruposActivos.size === 0) return false;
  const grupo = gruposActivos.get(jid);
  if (!grupo) return false;

  // Guardia de antigüedad: las reconexiones re-entregan histórico.
  const tsMs = aNumero(msg.messageTimestamp) * 1000;
  if (tsMs > 0 && tsMs < TS_MINIMO_MS) return false;

  const contenido: any = desenvolver(msg.message);
  if (!contenido) return false;
  // Ruido de protocolo: reacciones, encuestas, borrados, cambios de ajustes del chat.
  if (contenido.protocolMessage || contenido.reactionMessage || contenido.pollUpdateMessage) return false;

  let tipo: FilaMensaje["tipo"];
  let texto: string | null = null;
  let mediaNombre: string | null = null;
  let medio: any = null; // nodo con mimetype/fileLength si hay algo descargable

  if (typeof contenido.conversation === "string" && contenido.conversation.length > 0) {
    tipo = "texto";
    texto = contenido.conversation;
  } else if (contenido.extendedTextMessage?.text) {
    tipo = "texto";
    texto = String(contenido.extendedTextMessage.text);
  } else if (contenido.imageMessage) {
    tipo = "imagen";
    texto = contenido.imageMessage.caption ? String(contenido.imageMessage.caption) : null;
    medio = contenido.imageMessage;
  } else if (contenido.documentMessage) {
    tipo = "documento";
    texto = contenido.documentMessage.caption ? String(contenido.documentMessage.caption) : null;
    mediaNombre = contenido.documentMessage.fileName ? String(contenido.documentMessage.fileName) : null;
    medio = contenido.documentMessage;
  } else if (contenido.audioMessage) {
    tipo = "audio";
    medio = contenido.audioMessage;
  } else if (contenido.videoMessage) {
    // Video: solo el caption interesa (no se descarga, pesa demasiado para lo que aporta).
    tipo = "video";
    texto = contenido.videoMessage.caption ? String(contenido.videoMessage.caption) : null;
  } else {
    return false; // stickers, ubicaciones, contactos, etc.: sin valor para el Radar
  }

  // Descarga y subida de media (imagen/documento/audio) hasta 15 MB.
  let mediaUrl: string | null = null;
  let mediaMime: string | null = null;
  if (medio) {
    const mime = String(medio.mimetype ?? "application/octet-stream");
    const bytes = aNumero(medio.fileLength);
    if (bytes <= MAX_MEDIA_BYTES) {
      try {
        const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
        const mimeBase = (mime.split(";")[0] ?? "application/octet-stream").trim();
        const path = `${sanitizar(jid)}/${sanitizar(String(msg.key.id))}.${extPorMime(mime)}`;
        const url = await subirMedia(path, buffer, mimeBase);
        if (url) {
          mediaUrl = url;
          mediaMime = mimeBase;
        }
      } catch (e: any) {
        // Sin media el mensaje igual sirve (caption/contexto): seguir sin tumbar nada.
        console.warn(`[radar-worker] No se pudo descargar/subir media de ${msg.key.id}:`, e?.message ?? e);
      }
    } else {
      console.warn(`[radar-worker] Media de ${msg.key.id} supera 15 MB (${bytes} bytes) — se guarda sin adjunto.`);
    }
  }

  const fila: FilaMensaje = {
    wa_message_id: String(msg.key.id),
    grupo_id: grupo.id,
    wa_group_id: jid,
    grupo_nombre: grupo.nombre,
    remitente_wa: String(msg.key.participant ?? ""),
    remitente_nombre: msg.pushName ? String(msg.pushName) : null,
    tipo,
    texto,
    media_url: mediaUrl,
    media_mime: mediaMime,
    media_nombre: mediaNombre,
    ts_mensaje: new Date(aNumero(msg.messageTimestamp) * 1000).toISOString(),
    estado: "pendiente",
  };
  return insertarMensaje(fila);
}

// ── Conexión a WhatsApp (Baileys) con reconexión y backoff ─────────────────

function programarReconexion(ms: number): void {
  if (cerrando) return;
  if (timerReconexion) clearTimeout(timerReconexion);
  timerReconexion = setTimeout(() => {
    void conectar().catch((e: any) => {
      console.error("[radar-worker] Error al reconectar:", e?.message ?? e);
      programarReconexion(Math.min(60_000, 5_000 * 2 ** intentosReconexion++));
    });
  }, ms);
}

/**
 * Jubila el socket vigente: sube la generación (sus eventos dejan de aplicarse,
 * incluido el `creds.update` que si no volvería a escribir las credenciales que
 * estamos por borrar) y cierra el WebSocket.
 */
function descartarSocket(): void {
  generacion++;
  try {
    sock?.end?.(undefined);
  } catch {
    /* el socket puede ya estar cerrado */
  }
  sock = null;
}

/**
 * Deja al worker pidiendo un QR, pase lo que pase: descarta el socket, BORRA las
 * credenciales y reconecta. Es el ÚNICO camino posible cuando las credenciales ya
 * no sirven (número bloqueado, desvinculado) o cuando se quiere vincular otro
 * número desde el ERP, porque Baileys solo emite `qr` con auth/ vacío.
 */
async function forzarQrNuevo(detalle: string): Promise<void> {
  if (cerrando) return;
  motivoQrPendiente = detalle;
  descartarSocket();
  try {
    await rm(config.authDir, { recursive: true, force: true });
    console.log(`[radar-worker] Credenciales borradas (${config.authDir}) — se pedirá un QR nuevo.`);
  } catch (e: any) {
    // Sin poder borrar auth/ no hay QR posible: hay que verlo en los logs.
    console.error(`[radar-worker] NO se pudo borrar ${config.authDir}:`, e?.message ?? e);
  }
  await actualizarEstado({
    estado: "esperando_qr",
    qr_data_url: null,
    numero: null,
    conectado_desde: null,
    detalle,
  });
  intentosReconexion = 0;
  reinicios515Seguidos = 0; // vinculación fresca: el 515 que sigue al QR debe reconectar rápido
  programarReconexion(1_000);
}

async function conectar(): Promise<void> {
  if (cerrando) return;

  const miGeneracion = ++generacion;
  /** Este socket sigue siendo el bueno (nadie lo jubiló mientras se armaba). */
  const vigente = () => !cerrando && miGeneracion === generacion;

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  // Versión del protocolo: si no se puede consultar (sin internet), Baileys usa la suya.
  let version: any = undefined;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    console.warn("[radar-worker] No se pudo consultar la última versión de WhatsApp Web — usando la por defecto.");
  }

  // Entre el ++generacion y este punto hubo awaits: si mientras tanto alguien pidió
  // un QR nuevo (relink) o se jubiló esta conexión, no se abre un socket zombi —
  // el reintento ya quedó programado por quien la jubiló.
  if (!vigente()) return;

  const socket = makeWASocket({
    version,
    auth: state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ["Windows", "Chrome", "125.0.6422.142"],
  });
  sock = socket;

  // Guardar credenciales SOLO si este socket sigue siendo el vigente: si no, un
  // socket viejo volvería a crear auth/ justo después de que forzarQrNuevo lo borró.
  socket.ev.on("creds.update", () => {
    if (vigente()) void saveCreds();
  });

  socket.ev.on("connection.update", async (u: any) => {
    try {
      if (!vigente()) return;
      const { connection, lastDisconnect, qr } = u ?? {};

      if (qr) {
        // QR nuevo: publicarlo al ERP (/radar-ia lo muestra) y también en consola como respaldo.
        // Estamos esperando un escaneo: resetear el backoff para que, cuando este ciclo de
        // QRs caduque (408), se reconecte rápido y siempre haya un QR fresco en el ERP.
        intentosReconexion = 0;
        try {
          const dataUrl = await qrcode.toDataURL(qr);
          // El motivo viaja CON el QR (no se limpia hasta conectar): si el número anterior
          // fue bloqueado, quien va a escanear tiene que enterarse antes de usar el mismo.
          await actualizarEstado({
            estado: "esperando_qr",
            qr_data_url: dataUrl,
            numero: null,
            detalle: motivoQrPendiente,
          });
          const ascii = await qrcode.toString(qr, { type: "terminal", small: true });
          console.log("\n[radar-worker] Escanea este QR con el NÚMERO DEDICADO del Radar");
          console.log("(WhatsApp > Dispositivos vinculados > Vincular un dispositivo):\n");
          console.log(ascii);
          console.log("[radar-worker] El mismo QR está disponible en el ERP, en /radar-ia.\n");
        } catch (e: any) {
          console.error("[radar-worker] No se pudo generar el QR:", e?.message ?? e);
        }
      }

      if (connection === "open") {
        intentosReconexion = 0;
        reinicios515Seguidos = 0;
        motivoQrPendiente = null; // ya hay número vinculado: el motivo del QR dejó de aplicar
        const numero: string | null = socket?.user?.id ? String(socket.user.id).split(":")[0] ?? null : null;
        console.log(`[radar-worker] Conectado a WhatsApp como ${numero ?? "(número desconocido)"}.`);
        await actualizarEstado({
          estado: "conectado",
          numero,
          qr_data_url: null,
          conectado_desde: ahoraIso(),
          detalle: null,
          version_worker: config.version,
        });
        await sincronizarListaGrupos();
        await refrescarCacheGrupos();
      }

      if (connection === "close") {
        if (cerrando) return;
        const codigo = aNumero((lastDisconnect?.error as any)?.output?.statusCode);
        const sesionMuerta = CODIGOS_SESION_MUERTA[codigo];

        if (sesionMuerta) {
          // Credenciales inservibles (desvinculado / bloqueado / rechazado): borrarlas y
          // pedir QR. Reintentar con ellas no reconecta NUNCA y encima no emite QR.
          // OJO: el 500 (badSession) NO entra acá — en Baileys es el código por defecto de
          // cualquier error no mapeado, así que borrar auth/ ante un 500 destruiría una
          // sesión sana por un error transitorio.
          console.warn(`[radar-worker] ${sesionMuerta} (código ${codigo}).`);
          await forzarQrNuevo(sesionMuerta);
        } else if (codigo === COD.reinicioRequerido && reinicios515Seguidos < 3) {
          // 515: WhatsApp SIEMPRE lo envía justo después de emparejar (escanear el QR),
          // pidiendo reiniciar el socket para completar la vinculación. Hay que reconectar
          // YA: si se aplica backoff, el emparejamiento caduca y el teléfono descarta la
          // sesión recién creada (el worker quedaba en un bucle infinito de QRs).
          // Tope de 3 seguidos (se resetea al conectar): si el 515 se repite por otra
          // causa, cae al backoff normal en vez de reconectar en bucle caliente.
          reinicios515Seguidos++;
          console.log("[radar-worker] Reinicio requerido (515) — reconectando de inmediato para completar la vinculación.");
          intentosReconexion = 0;
          programarReconexion(500);
        } else {
          const espera = Math.min(60_000, 5_000 * 2 ** intentosReconexion);
          intentosReconexion++;
          // Corte de internet y "WhatsApp no quiere estas credenciales" se ven igual desde
          // acá (428/408 secos, sin código que los distinga). Tras ~10 intentos seguidos ya
          // no parece un corte: decirlo en el detalle para que en /radar-ia se sepa que la
          // salida es el botón "Generar QR nuevo", en vez de esperar para siempre.
          const insistente = intentosReconexion >= 10
            ? " · lleva muchos intentos: si el número fue bloqueado, usa \"Generar QR nuevo\" y vincula otro"
            : "";
          const detalle = `Conexión cerrada (código ${codigo || "desconocido"}) — reintentando en ${Math.round(espera / 1000)} s${insistente}`;
          console.warn(`[radar-worker] ${detalle}`);
          await actualizarEstado({ estado: "desconectado", qr_data_url: null, detalle });
          programarReconexion(espera);
        }
      }
    } catch (e: any) {
      console.error("[radar-worker] Error en connection.update:", e?.message ?? e);
    }
  });

  socket.ev.on("messages.upsert", async (evento: any) => {
    try {
      if (!vigente()) return; // eco de un socket ya jubilado
      if (evento?.type !== "notify") return; // solo mensajes nuevos en vivo, no histórico
      let insertados = 0;
      for (const msg of evento.messages ?? []) {
        try {
          if (await procesarMensaje(msg)) insertados++;
        } catch (e: any) {
          // Un mensaje malformado jamás debe tumbar el worker.
          console.warn(`[radar-worker] Error procesando mensaje ${msg?.key?.id ?? "?"}:`, e?.message ?? e);
        }
      }
      if (insertados > 0) {
        console.log(`[radar-worker] ${insertados} mensaje(s) nuevo(s) en radar_mensajes.`);
        programarProcesamiento();
      }
    } catch (e: any) {
      console.error("[radar-worker] Error en messages.upsert:", e?.message ?? e);
    }
  });
}

// ── Latido + refresco periódico ────────────────────────────────────────────

let ticksLatido = 0;

function iniciarLatido(): void {
  setInterval(async () => {
    try {
      ticksLatido++;
      await actualizarEstado({ ultimo_latido: ahoraIso() });
      await refrescarCacheGrupos();
      // Cada 30 min, re-sincronizar la lista completa de grupos (nombres, miembros, grupos nuevos).
      if (ticksLatido % 30 === 0) await sincronizarListaGrupos();
      // Barrido de cortesía: el ERP retiene un rato los reportes multi-mensaje (p.ej.
      // combustible: texto+foto odómetro+foto voucher) esperando a que lleguen todas sus
      // partes. Si no llega tráfico nuevo en NINGÚN grupo, nada más dispara el reproceso —
      // este latido asegura que igual se barran dentro del minuto siguiente a que venza esa espera.
      void notificarErp();
    } catch (e: any) {
      console.warn("[radar-worker] Error en el latido:", e?.message ?? e);
    }
  }, 60_000);
}

/**
 * Revisa cada pocos segundos si el ERP pidió un QR nuevo (botón "Generar QR nuevo"
 * en /radar-ia) y, si sí, deja al worker esperando un escaneo.
 *
 * El logout() es solo cortesía (desvincular el dispositivo en el teléfono cuando la
 * sesión todavía vive) y va con tope de tiempo: si el socket está caído — número
 * bloqueado, WhatsApp rechazando las credenciales — logout() no responde nunca, y
 * ESE es justo el caso en que más falta hace el QR. Antes todo el relink colgaba de
 * que ese logout funcionara, así que el botón no hacía nada y no quedaba más salida
 * que entrar al servidor a borrar auth/ a mano. Ahora el QR se fuerza igual.
 */
function iniciarPollRelink(): void {
  setInterval(async () => {
    try {
      if (!(await debeRelinkear())) return;
      console.log("[radar-worker] Se pidió un QR nuevo desde el ERP — cerrando la sesión actual...");
      await limpiarSolicitudRelink(); // primero baja la bandera, para no repetirlo en el próximo chequeo
      if (sock) {
        try {
          await Promise.race([
            sock.logout(),
            new Promise((_, rechazar) =>
              setTimeout(() => rechazar(new Error("logout sin respuesta en 5 s")), 5_000)
            ),
          ]);
        } catch (e: any) {
          console.warn("[radar-worker] No se pudo cerrar sesión limpiamente (se fuerza igual):", e?.message ?? e);
        }
      }
      await forzarQrNuevo("QR nuevo pedido desde el ERP — escanea el código para vincular el número");
    } catch (e: any) {
      console.warn("[radar-worker] Error revisando solicitud de relink:", e?.message ?? e);
    }
  }, 5_000);
}

// ── Apagado ordenado y blindaje global ─────────────────────────────────────

async function apagar(senal: string): Promise<void> {
  if (cerrando) return;
  cerrando = true;
  console.log(`[radar-worker] ${senal} recibida — deteniendo el worker...`);
  if (timerReconexion) clearTimeout(timerReconexion);
  if (timerProcesar) clearTimeout(timerProcesar);
  try {
    await actualizarEstado({ estado: "desconectado", qr_data_url: null, detalle: "Worker detenido" });
  } catch {
    /* mejor salir igual */
  }
  try {
    sock?.end?.(undefined);
  } catch {
    /* el socket puede ya estar cerrado */
  }
  process.exit(0);
}

process.on("SIGINT", () => void apagar("SIGINT"));
process.on("SIGTERM", () => void apagar("SIGTERM"));
// Blindaje: un error suelto (de red, de un mensaje raro) no debe matar el proceso.
process.on("uncaughtException", (e) => console.error("[radar-worker] Excepción no capturada:", e));
process.on("unhandledRejection", (e) => console.error("[radar-worker] Promesa rechazada sin capturar:", e));

// ── Arranque ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[radar-worker] AFA Radar IA — worker v${config.version} (Node ${process.version})`);
  console.log(`[radar-worker] ERP: ${config.erpUrl} — sesión en ${config.authDir}`);
  await actualizarEstado({
    estado: "desconectado",
    detalle: "Worker arrancando…",
    version_worker: config.version,
    ultimo_latido: ahoraIso(),
  });
  await refrescarCacheGrupos();
  if (gruposActivos.size === 0) {
    console.log("[radar-worker] Aún no hay grupos activos — actívalos en el ERP: /radar-ia > Grupos.");
  }
  iniciarLatido();
  iniciarPollRelink();
  await conectar();
}

void main().catch((e: any) => {
  console.error("[radar-worker] Error fatal al arrancar:", e?.message ?? e);
  process.exit(1);
});
