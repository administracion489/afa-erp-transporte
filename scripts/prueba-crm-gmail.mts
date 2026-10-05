// Pruebas de la LECTURA DEL GMAIL DEL CRM. No tocan la base ni Google: corre `syncGmailInbox`
// de verdad contra un Gmail y una base FALSOS en memoria, más las reglas puras de
// lib/crm-gmail-reglas.ts.
// Uso:  npx tsx scripts/prueba-crm-gmail.mts   (sale con código 1 si algo falla)
//
// El caso que la origina, reportado como «ni el CRM lee los correos»: con el marcador de Gmail
// (historyId) vencido, Google responde 404 y la lectura vieja se quedaba en 0 correos PARA
// SIEMPRE — y reconectar no lo arreglaba porque el marcador viejo no se borraba. La sección 1
// corre ese algoritmo copiado literal para exigir que reproduzca el defecto: si deja de hacerlo,
// el escenario dejó de ser el que se rompió.
import {
  diasRecuperacion, marcadorVencido, remitenteDe, esRemitentePropio, esDeLaBandeja, explicarErrorGoogle, haceCuanto,
  limpiarValorEnv, diagnosticarGoogle, VARIABLES_GOOGLE, RUTA_CALLBACK_GMAIL,
  cuerpoDeCorreo, textoDeHtml, pareceHtml, textoLegible, type ParteMime,
  DIAS_VENTANA_INICIAL, DIAS_VENTANA_MAX, MAX_MENSAJES_POR_LECTURA,
} from "../lib/crm-gmail-reglas";
import {
  syncGmailInbox, exchangeCode, canjearCode, getAuthUrl, googleOAuthConfigurado, diagnosticoGoogle, origenPublico,
} from "../lib/crm-gmail";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── Base falsa: lo justo del query builder de supabase-js que usa la lectura ─────────────────
type Fila = Record<string, any>;
const CLAVES: Record<string, string> = { crm_config: "clave" };
class Base {
  t: Record<string, Fila[]> = { crm_config: [], crm_mensajes: [], crm_contactos: [], crm_conversaciones: [] };
  n = 0;
  from(tabla: string) { return new Q(this, tabla); }
  cfg(clave: string) { return this.t.crm_config.find((r) => r.clave === clave)?.valor; }
}
class Q {
  op = "select"; filtros: [string, string, any][] = []; payload: any; ret = false; uno: "" | "single" | "maybe" = "";
  lim = Infinity; ignorar = false;
  constructor(private b: Base, private tabla: string) {}
  select() { if (this.op !== "select") this.ret = true; return this; }
  insert(p: any) { this.op = "insert"; this.payload = p; return this; }
  update(p: any) { this.op = "update"; this.payload = p; return this; }
  upsert(p: any, o?: any) { this.op = "upsert"; this.payload = p; this.ignorar = !!o?.ignoreDuplicates; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: any) { this.filtros.push([c, "eq", v]); return this; }
  in(c: string, v: any[]) { this.filtros.push([c, "in", v]); return this; }
  lt(c: string, v: any) { this.filtros.push([c, "lt", v]); return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.uno = "single"; return this; }
  maybeSingle() { this.uno = "maybe"; return this; }
  private pasa(r: Fila) {
    return this.filtros.every(([c, o, v]) => o === "eq" ? r[c] === v : o === "in" ? v.includes(r[c]) : r[c] < v);
  }
  private ejecutar() {
    const filas = this.b.t[this.tabla] ??= [];
    let data: any = null;
    if (this.op === "select") data = filas.filter((r) => this.pasa(r)).slice(0, this.lim);
    else if (this.op === "insert") {
      const nuevas = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p: Fila) => ({ id: `id${++this.b.n}`, ...p }));
      filas.push(...nuevas); data = nuevas;
    } else if (this.op === "update") {
      data = filas.filter((r) => this.pasa(r)); data.forEach((r: Fila) => Object.assign(r, this.payload));
    } else if (this.op === "upsert") {
      const k = CLAVES[this.tabla] ?? "id";
      for (const p of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        const ya = filas.find((r) => r[k] === p[k]);
        if (ya) { if (!this.ignorar) Object.assign(ya, p); } else filas.push({ ...p });
      }
    } else if (this.op === "delete") this.b.t[this.tabla] = filas.filter((r) => !this.pasa(r));
    if (this.uno) data = Array.isArray(data) ? data[0] ?? null : data;
    if (this.op !== "select" && !this.ret && !this.uno) data = null;
    return { data, error: null };
  }
  then(ok: (v: any) => any, mal?: (e: any) => any) { try { return Promise.resolve(this.ejecutar()).then(ok, mal); } catch (e) { return Promise.reject(e).then(ok, mal); } }
}

// ── Gmail falso ──────────────────────────────────────────────────────────────────────────────
type Correo = { id: string; hilo: string; de: string; asunto: string; labels: string[]; fecha: number; estado?: number; payload?: any };
const DIA = 86_400_000;
const AHORA = Date.UTC(2026, 9, 5, 15, 0, 0);
class Gmail {
  correos: Correo[] = [];
  historialVencido = false;
  historial: string[] = [];         // ids que devuelve /history
  historyId = "900";
  token = "ok";                     // "ok" | "revocado"
  pedidos: string[] = [];
  cuerpoToken = "";                 // lo último que se mandó a /token (para ver qué redirect lleva)
}
let G = new Gmail();
const json = (status: number, data: any) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  G.pedidos.push(u);
  if (u.startsWith("https://oauth2.googleapis.com/token")) {
    const cuerpo = String(init?.body ?? "");
    G.cuerpoToken = cuerpo;
    if (/grant_type=authorization_code/.test(cuerpo)) return json(200, { refresh_token: "RT-nuevo", access_token: "AT" });
    return G.token === "ok" ? json(200, { access_token: "AT" }) : json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
  }
  const p = new URL(u);
  const ruta = p.pathname.replace("/gmail/v1/users/me", "");
  if (ruta === "/profile") return json(200, { emailAddress: "transporte@empresa.pe", historyId: G.historyId });
  if (ruta === "/history") {
    if (G.historialVencido) return json(404, { error: { code: 404, message: "Requested entity was not found." } });
    return json(200, { history: G.historial.length ? [{ messagesAdded: G.historial.map((id) => ({ message: { id } })) }] : undefined, historyId: G.historyId });
  }
  if (ruta === "/messages") {
    const dias = Number(/newer_than:(\d+)d/.exec(p.searchParams.get("q") ?? "")?.[1] ?? 9999);
    const max = Number(p.searchParams.get("maxResults") ?? 100);
    const desde = Number(p.searchParams.get("pageToken") ?? 0);
    const todos = G.correos.filter((c) => c.labels.includes("INBOX") && c.fecha >= AHORA - dias * DIA).sort((a, b) => b.fecha - a.fecha);
    const pagina = todos.slice(desde, desde + max);
    return json(200, { messages: pagina.map((c) => ({ id: c.id })), nextPageToken: desde + max < todos.length ? String(desde + max) : undefined });
  }
  const m = /^\/messages\/([^/?]+)$/.exec(ruta);
  if (m) {
    const c = G.correos.find((x) => x.id === m[1]);
    if (!c) return json(404, { error: { message: "Not Found" } });
    if (c.estado && c.estado !== 200) return json(c.estado, { error: { message: "falla de Google" } });
    return json(200, {
      id: c.id, threadId: c.hilo, labelIds: c.labels, internalDate: String(c.fecha),
      payload: {
        headers: [{ name: "From", value: c.de }, { name: "Subject", value: c.asunto }],
        ...(c.payload ?? { body: { data: Buffer.from("hola").toString("base64") } }),
      },
    });
  }
  return json(404, {});
}) as any;
const realNow = Date.now;
Date.now = () => AHORA;

const correo = (n: number, diasAtras: number, extra: Partial<Correo> = {}): Correo => ({
  id: `m${n}`, hilo: `h${n}`, de: `Cliente ${n} <cliente${n}@minera.pe>`, asunto: `Cotización ${n}`,
  labels: ["INBOX", "UNREAD"], fecha: AHORA - diasAtras * DIA, ...extra,
});
const conectada = (marcador?: string, ultimaSync?: string) => {
  const b = new Base();
  b.t.crm_config.push({ clave: "gmail_refresh_token", valor: "RT" });
  if (marcador) b.t.crm_config.push({ clave: "gmail_history_id", valor: marcador });
  if (ultimaSync) b.t.crm_config.push({ clave: "gmail_ultima_sync", valor: ultimaSync });
  return b;
};

// ── 1. El defecto reportado: marcador vencido ────────────────────────────────────────────────
console.log("\n1. Marcador vencido (lo que dejaba al CRM sin correos)");
{
  // El algoritmo VIEJO, copiado literal en lo que importa: no miraba la respuesta del historial.
  async function lecturaVieja(b: Base): Promise<number> {
    const historyId = b.cfg("gmail_history_id");
    let messageIds: string[] = [];
    if (historyId) {
      const hRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded&labelId=INBOX`);
      const hData: any = await hRes.json();
      for (const record of hData.history ?? []) for (const ma of record.messagesAdded ?? []) if (!messageIds.includes(ma.message.id)) messageIds.push(ma.message.id);
      if (hData.historyId) await b.from("crm_config").upsert({ clave: "gmail_history_id", valor: String(hData.historyId) });
    }
    return messageIds.length;
  }
  G = new Gmail();
  G.historialVencido = true;
  G.correos = [correo(1, 2), correo(2, 3), correo(3, 1, { de: "Ana <ana@empresa.pe>" })];
  const vieja = conectada("100", new Date(AHORA - 4 * DIA).toISOString());
  const n1 = await lecturaVieja(vieja), n2 = await lecturaVieja(vieja);
  chk("el algoritmo VIEJO reproduce el defecto: 0 correos y el marcador no se mueve, lectura tras lectura",
    n1 === 0 && n2 === 0 && vieja.cfg("gmail_history_id") === "100");

  const b = conectada("100", new Date(AHORA - 4 * DIA).toISOString());
  // Si el arreglo se perdiera, la lectura LANZARÍA el 404: se atrapa para que la falla tenga nombre.
  const r: any = await syncGmailInbox(b).catch((e: any) => ({ error: e.message }));
  chk("el NUEVO recupera por fecha", r.modo === "recuperacion" && r.nuevos === 2, JSON.stringify(r));
  chk("…y el correo de un compañero (mismo dominio del buzón) no entra como cliente",
    !b.t.crm_contactos.some((c) => c.gmail_email === "ana@empresa.pe"));
  chk("…y el marcador avanza al de ahora", b.cfg("gmail_history_id") === "900");
  chk("…y la ventana cubrió el hueco desde la última lectura completa",
    G.pedidos.some((u) => decodeURIComponent(u).includes("newer_than:5d")), "4 días + 1 de margen");
  chk("…y no quedó error escrito", b.cfg("gmail_ultimo_error") === "");

  // Siguiente lectura: ya por historial, sin nada nuevo.
  G.historialVencido = false; G.historial = [];
  const r2 = await syncGmailInbox(b);
  chk("la lectura siguiente vuelve al historial y no duplica nada", r2.modo === "historial" && r2.nuevos === 0 && b.t.crm_mensajes.length === 2);
}

// ── 2. Reconectar empieza limpio ─────────────────────────────────────────────────────────────
console.log("\n2. Reconectar");
{
  G = new Gmail();
  const b = conectada("100", new Date(AHORA - 40 * DIA).toISOString());
  b.t.crm_config.push({ clave: "gmail_ultimo_error", valor: "Google ya no acepta el permiso…" });
  await exchangeCode("CODE", b);
  chk("reconectar guarda el token nuevo", b.cfg("gmail_refresh_token") === "RT-nuevo");
  chk("…borra el marcador viejo (la causa de que ni reconectando se arreglara)", b.cfg("gmail_history_id") === undefined);
  chk("…y el error anterior", b.cfg("gmail_ultimo_error") === "");
  chk("…y anota qué cuenta quedó conectada", b.cfg("gmail_email") === "transporte@empresa.pe");
  G.correos = [correo(1, 2), correo(2, 6), correo(3, 9)];
  const r = await syncGmailInbox(b);
  chk("la primera lectura tras reconectar trae la última semana", r.modo === "inicial" && r.nuevos === 2, `ventana ${DIAS_VENTANA_INICIAL} días`);
}

// ── 3. Fallos y pendientes: el marcador NO avanza hasta completar ────────────────────────────
console.log("\n3. Reintentos");
{
  G = new Gmail();
  G.correos = [correo(1, 1), correo(2, 1, { estado: 500 }), correo(3, 1)];
  G.historial = ["m1", "m2", "m3"];
  const b = conectada("100", new Date(AHORA - DIA).toISOString());
  const r = await syncGmailInbox(b);
  chk("un correo que falla no tumba a los demás", r.nuevos === 2 && r.fallidos === 1);
  chk("…el marcador NO avanza (si avanzara, ese correo no volvería nunca)", b.cfg("gmail_history_id") === "100");
  chk("…y se avisa sin pintarlo como error de conexión", b.cfg("gmail_ultimo_error") === "" && /se reintentan/.test(b.cfg("gmail_ultimo_aviso") ?? ""));
  G.correos[1].estado = 200;
  const r2 = await syncGmailInbox(b);
  chk("en la siguiente entra el que faltaba, sin duplicar los otros", r2.nuevos === 1 && b.t.crm_mensajes.length === 3);
  chk("…y recién ahí avanza el marcador", b.cfg("gmail_history_id") === "900");
}
{
  G = new Gmail();
  G.correos = Array.from({ length: 150 }, (_, k) => correo(k + 1, 1 + (k % 5) / 10));
  const b = conectada();
  const r = await syncGmailInbox(b);
  chk(`más de ${MAX_MENSAJES_POR_LECTURA} pendientes: entra un lote y se dice cuántos faltan`, r.nuevos === MAX_MENSAJES_POR_LECTURA && r.pendientes === 50);
  chk("…sin dar la lectura por completa", b.cfg("gmail_history_id") === undefined);
  const r2 = await syncGmailInbox(b);
  chk("la siguiente trae los que faltaban (no repite los mismos 100)", r2.nuevos === 50 && r2.pendientes === 0 && b.t.crm_mensajes.length === 150);
  chk("…y ahí se completa", b.cfg("gmail_history_id") === "900");
  const fechas = b.t.crm_mensajes.map((m) => Date.parse(m.created_at));
  chk("cada mensaje lleva la fecha del correo, no la de la lectura", fechas.every((f) => f < AHORA));
}

// ── 4. Leídos, orden de la bandeja y candado ─────────────────────────────────────────────────
console.log("\n4. Bandeja");
{
  G = new Gmail();
  G.correos = [correo(1, 1, { hilo: "h", labels: ["INBOX"] }), correo(2, 3, { hilo: "h" }), correo(3, 2, { labels: ["INBOX", "SPAM"] })];
  const b = conectada();
  await syncGmailInbox(b);
  const conv = b.t.crm_conversaciones.find((c) => c.gmail_thread_id === "h")!;
  chk("lo ya leído en Gmail no suma a «no leídos»", conv.no_leidos === 1);
  chk("ultimo_mensaje_at queda en el correo MÁS NUEVO del hilo", conv.ultimo_mensaje_at === new Date(AHORA - DIA).toISOString());
  chk("el spam no entra", !b.t.crm_mensajes.some((m) => m.gmail_message_id === "m3"));
}
{
  G = new Gmail(); G.correos = [correo(1, 1)];
  const b = conectada();
  b.t.crm_config.push({ clave: "gmail_sync_candado", valor: new Date(AHORA - 60_000).toISOString() });
  const r = await syncGmailInbox(b);
  chk("con otra lectura en curso no se lee dos veces", r.ocupado === true && b.t.crm_mensajes.length === 0);
  b.t.crm_config.find((x) => x.clave === "gmail_sync_candado")!.valor = new Date(AHORA - 10 * 60_000).toISOString();
  const r2 = await syncGmailInbox(b);
  chk("un candado de una lectura muerta (>5 min) no bloquea para siempre", !r2.ocupado && r2.nuevos === 1);
  chk("…y al terminar se suelta", (b.cfg("gmail_sync_candado") ?? "") < new Date(AHORA - 5 * 60_000).toISOString());
}

// ── 5. El permiso caducado se DICE ───────────────────────────────────────────────────────────
console.log("\n5. Errores");
{
  G = new Gmail(); G.token = "revocado";
  const b = conectada("100");
  let msg = "";
  try { await syncGmailInbox(b); } catch (e: any) { msg = e.message; }
  chk("un permiso caducado da un error que dice qué hacer", /vuelve a conectar/i.test(msg) && /Prueba/.test(msg));
  chk("…queda escrito para la línea de estado del CRM", /vuelve a conectar/i.test(b.cfg("gmail_ultimo_error") ?? ""));
  chk("…y el candado se suelta igual", (b.cfg("gmail_sync_candado") ?? "") < "2000");
}

// ── 6. Reglas puras ──────────────────────────────────────────────────────────────────────────
console.log("\n6. Reglas");
chk("sin última lectura: la semana inicial", diasRecuperacion(null, AHORA) === DIAS_VENTANA_INICIAL);
chk("hueco de 2 días → 3 (con margen)", diasRecuperacion(new Date(AHORA - 2 * DIA).toISOString(), AHORA) === 3);
chk("nunca más de un mes", diasRecuperacion(new Date(AHORA - 400 * DIA).toISOString(), AHORA) === DIAS_VENTANA_MAX);
chk("fecha basura → la semana inicial", diasRecuperacion("ayer", AHORA) === DIAS_VENTANA_INICIAL);
chk("404 es marcador vencido", marcadorVencido(404) && marcadorVencido(400, "Invalid startHistoryId") && !marcadorVencido(500) && !marcadorVencido(400, "otra cosa"));
chk("remitente con nombre", remitenteDe('"Juan Pérez" <Juan@Minera.pe>').email === "juan@minera.pe" && remitenteDe('"Juan Pérez" <Juan@Minera.pe>').nombre === "Juan Pérez");
chk("remitente suelto", remitenteDe("juan@minera.pe").email === "juan@minera.pe");
chk("remitente vacío", remitenteDe("").email === "");
chk("compañero de la empresa = propio", esRemitentePropio("ana@empresa.pe", "transporte@empresa.pe"));
chk("con un buzón @gmail.com, otro @gmail.com es un CLIENTE", !esRemitentePropio("cliente@gmail.com", "transporte.afa@gmail.com"));
chk("…y el propio buzón sí es propio", esRemitentePropio("transporte.afa@gmail.com", "transporte.afa@gmail.com"));
chk("sin buzón conocido no se descarta a nadie", !esRemitentePropio("x@y.pe", null));
chk("bandeja: INBOX sí, SPAM/papelera/borrador no, enviado no",
  esDeLaBandeja(["INBOX", "UNREAD"]) && !esDeLaBandeja(["INBOX", "SPAM"]) && !esDeLaBandeja(["TRASH"]) && !esDeLaBandeja(["SENT"]));
chk("API apagada se nombra", /Gmail API/.test(explicarErrorGoogle("Gmail API has not been used in project 123")));
chk("un error desconocido pasa tal cual", explicarErrorGoogle("algo raro") === "algo raro");
chk("hace cuánto", haceCuanto(new Date(AHORA - 5 * 60_000).toISOString(), AHORA) === "hace 5 min" && haceCuanto(null, AHORA) === null);

// ── 7. La configuración de Google se DICE: qué falta y el valor exacto ───────────────────────
// Lo reportado con la pantalla delante: «falta configurar Google en Vercel (las tres)», sin decir
// cuál faltaba ni qué valor llevaba la de redirección, y el botón mandando igual a Google.
console.log("\n7. Configuración de Google");
{
  const ORIGEN = "https://transportesafa.com";
  const BIEN = `${ORIGEN}${RUTA_CALLBACK_GMAIL}`;
  const completo = { GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "GOCSPX-secreto", GOOGLE_REDIRECT_URI: BIEN };

  const nada = diagnosticarGoogle({}, ORIGEN);
  chk("sin ninguna: faltan las tres, en el orden en que se crean", nada.faltan.join() === VARIABLES_GOOGLE.join() && nada.bloquea);
  chk("…y la frase da el valor EXACTO del redirect para esta instalación", nada.texto!.includes(BIEN), nada.texto!);
  chk("…y recuerda el Redeploy", /Redeploy/.test(nada.texto!));

  const sinSecreto = diagnosticarGoogle({ ...completo, GOOGLE_CLIENT_SECRET: "" }, ORIGEN);
  chk("si falta UNA, se nombra esa y ninguna otra",
    sinSecreto.faltan.join() === "GOOGLE_CLIENT_SECRET" && /^Falta en Vercel GOOGLE_CLIENT_SECRET\./.test(sinSecreto.texto!), sinSecreto.texto!);
  chk("…y no se repite el redirect que ya está bien", !sinSecreto.texto!.includes(RUTA_CALLBACK_GMAIL));

  const ok = diagnosticarGoogle(completo, ORIGEN);
  chk("con las tres bien: nada que decir y se puede conectar", !ok.bloquea && ok.texto === null && ok.problema_redirect === null);
  chk("`www.` no es otro sitio (Vercel redirige el uno al otro)", diagnosticarGoogle(completo, "https://www.transportesafa.com").texto === null);
  chk("la barra final no rompe la ruta", diagnosticarGoogle({ ...completo, GOOGLE_REDIRECT_URI: BIEN + "/" }, ORIGEN).texto === null);

  const sinEsquema = diagnosticarGoogle({ ...completo, GOOGLE_REDIRECT_URI: "transportesafa.com" + RUTA_CALLBACK_GMAIL }, ORIGEN);
  chk("sin https:// no es una dirección: bloquea y da la buena", sinEsquema.problema_redirect === "invalido" && sinEsquema.bloquea && sinEsquema.texto!.includes(BIEN));
  const http = diagnosticarGoogle({ ...completo, GOOGLE_REDIRECT_URI: "http://transportesafa.com" + RUTA_CALLBACK_GMAIL }, ORIGEN);
  chk("http:// fuera de localhost: bloquea", http.problema_redirect === "no_https" && http.bloquea);
  chk("…pero localhost en desarrollo sí vale",
    diagnosticarGoogle({ ...completo, GOOGLE_REDIRECT_URI: "http://localhost:3000" + RUTA_CALLBACK_GMAIL }, "http://localhost:3000").texto === null);
  const ruta = diagnosticarGoogle({ ...completo, GOOGLE_REDIRECT_URI: ORIGEN + "/api/gmail/callback" }, ORIGEN);
  chk("otra ruta no llega al ERP: bloquea y da la buena", ruta.problema_redirect === "otra_ruta" && ruta.bloquea && ruta.texto!.includes(BIEN));
  const otro = diagnosticarGoogle({ ...completo, GOOGLE_REDIRECT_URI: "https://afa-erp-transporte.vercel.app" + RUTA_CALLBACK_GMAIL }, ORIGEN);
  chk("otro sitio AVISA sin bloquear (puede ser a propósito)",
    otro.problema_redirect === "otro_sitio" && !otro.bloquea && /vercel\.app/.test(otro.texto!) && otro.texto!.includes(BIEN));
  chk("detrás de un proxy que se ve como http, la sugerencia sigue siendo https", diagnosticarGoogle({}, "http://transportesafa.com").redirect_sugerido === BIEN);
  chk("…y un redirect https no pasa a ser «otro sitio» por eso", diagnosticarGoogle(completo, "http://transportesafa.com").texto === null);
  chk("sin origen se dice dónde va el dominio, sin inventarlo", diagnosticarGoogle({}).texto!.includes(`https://TU-DOMINIO${RUTA_CALLBACK_GMAIL}`));

  // El pegado: espacios, salto de línea y comillas (copiar desde el JSON de Google las trae).
  chk("limpia espacios, saltos y comillas",
    limpiarValorEnv('  "123-abc.apps.googleusercontent.com"\n') === "123-abc.apps.googleusercontent.com" && limpiarValorEnv("'x'") === "x" && limpiarValorEnv(undefined) === "");
  chk("un valor de solo espacios cuenta como faltante", diagnosticarGoogle({ ...completo, GOOGLE_CLIENT_ID: "   " }, ORIGEN).faltan.join() === "GOOGLE_CLIENT_ID");
  chk("un redirect pegado con comillas se lee bien", diagnosticarGoogle({ ...completo, GOOGLE_REDIRECT_URI: ` "${BIEN}" ` }, ORIGEN).texto === null);

  // Barrido: la frase nombra como faltante EXACTAMENTE lo que falta, y bloquea ⟺ (falta algo ∨ el
  // redirect no puede funcionar). Corolario: no bloquea siempre (eso cumpliría lo demás trivialmente).
  const valores = {
    id: ["", "  ", "id"], sec: ["", "GOCSPX-x"],
    red: ["", "basura", "http://transportesafa.com" + RUTA_CALLBACK_GMAIL, ORIGEN + "/otra", BIEN, "https://otro.pe" + RUTA_CALLBACK_GMAIL],
  };
  let bien = true, conectables = 0, n = 0;
  for (const id of valores.id) for (const sec of valores.sec) for (const red of valores.red) for (const org of [ORIGEN, null]) {
    n++;
    const d = diagnosticarGoogle({ GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: sec, GOOGLE_REDIRECT_URI: red }, org);
    const nombradas = /^Faltan? en Vercel ([^.]*)\./.exec(d.texto ?? "")?.[1] ?? "";
    for (const v of VARIABLES_GOOGLE) if (nombradas.includes(v) !== d.faltan.includes(v)) bien = false;
    const imposible = d.problema_redirect !== null && d.problema_redirect !== "otro_sitio";
    if (d.bloquea !== (d.faltan.length > 0 || imposible)) bien = false;
    if ((d.texto === null) !== (d.faltan.length === 0 && d.problema_redirect === null)) bien = false;
    if (!d.bloquea) conectables++;
  }
  chk("barrido: se nombra exactamente lo que falta y solo bloquea lo que no puede funcionar", bien, `${n} combinaciones`);
  chk("corolario: hay combinaciones que sí dejan conectar", conectables > 0, `${conectables}`);

  // El inicio y el canje leen el MISMO valor limpio: si uno limpiara y el otro no, Google
  // rechazaría el canje porque el redirect no coincide con el del inicio.
  const guardado = VARIABLES_GOOGLE.map((k) => [k, process.env[k]] as const);
  process.env.GOOGLE_CLIENT_ID = ' "123-abc.apps.googleusercontent.com" ';
  process.env.GOOGLE_CLIENT_SECRET = "GOCSPX-secreto\n";
  process.env.GOOGLE_REDIRECT_URI = `${BIEN}\n`;
  const p = new URL(getAuthUrl("st")).searchParams;
  chk("la URL de Google lleva los valores limpios", p.get("client_id") === "123-abc.apps.googleusercontent.com" && p.get("redirect_uri") === BIEN);
  G = new Gmail();
  await canjearCode("CODE");
  const cuerpo = new URLSearchParams(G.cuerpoToken);
  chk("…y el canje manda el MISMO redirect, y el secreto sin el salto de línea",
    cuerpo.get("redirect_uri") === p.get("redirect_uri") && cuerpo.get("client_secret") === "GOCSPX-secreto" && cuerpo.get("client_id") === p.get("client_id"));
  chk("con las tres puestas, el servidor se da por configurado", googleOAuthConfigurado() && diagnosticoGoogle(ORIGEN).texto === null);
  delete process.env.GOOGLE_CLIENT_SECRET;
  chk("…y sin el secreto no, nombrándolo", !googleOAuthConfigurado() && diagnosticoGoogle(ORIGEN).faltan.join() === "GOOGLE_CLIENT_SECRET");
  for (const [k, v] of guardado) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  // De dónde sale el origen: detrás del proxy de Vercel, el host público viene en x-forwarded-host.
  const req = (h: Record<string, string>) => ({ headers: { get: (k: string) => h[k] ?? null }, nextUrl: { protocol: "https:", host: "interno.vercel.app" } });
  chk("el origen público sale de x-forwarded-host", origenPublico(req({ "x-forwarded-host": "transportesafa.com" })) === ORIGEN);
  chk("…el primero si viene una lista", origenPublico(req({ "x-forwarded-host": "transportesafa.com, proxy.interno" })) === ORIGEN);
  chk("…y sin la cabecera, el de la petición", origenPublico(req({})) === "https://interno.vercel.app");
}

// ── 8. El cuerpo de un correo es TEXTO, no su maquetación ────────────────────────────────────
// Visto en producción el mismo día que se conectó el Gmail: la bandeja enseñaba de vista previa
// «<html> <body style="background-colo…» — el correo de un banco, que no trae parte de texto.
console.log("\n8. Cuerpo del correo");
{
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const dec = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  const HTML =
    `<html><head><style>body{background-color:#fff}</style><title>x</title></head>` +
    `<body style="background-color:#fff"><div>Estimado cliente:</div>` +
    `<p>Su estado de cuenta est&aacute; disponible.<br>Saludos,<br>Interbank</p><!-- pie -->` +
    `<script>track()</script><a href="https://x.pe/t?id=123">Ver aqu&iacute;</a></body></html>`;
  const soloHtml: ParteMime = { mimeType: "text/html", body: { data: b64(HTML) } };
  const altHtmlPrimero: ParteMime = { mimeType: "multipart/alternative", parts: [
    { mimeType: "text/html", body: { data: b64(HTML) } },
    { mimeType: "text/plain", body: { data: b64("Su estado de cuenta está disponible.") } },
  ] };

  // El algoritmo VIEJO, copiado literal: devolvía la PRIMERA parte de texto que encontraba.
  function extractBodyViejo(payload: any): string {
    if (payload.body?.data) return dec(payload.body.data);
    for (const part of payload.parts ?? []) {
      if (part.mimeType === "text/html" || part.mimeType === "text/plain") {
        if (part.body?.data) return dec(part.body.data);
      }
      if (part.parts) {
        const inner = extractBodyViejo(part);
        if (inner) return inner;
      }
    }
    return "";
  }
  chk("el algoritmo VIEJO reproduce el defecto: un correo solo-HTML entraba como etiquetas", /<html>|<body/.test(extractBodyViejo(soloHtml)));
  chk("…y con el HTML primero en un multipart, tampoco elegía el texto", /<html>/.test(extractBodyViejo(altHtmlPrimero)));

  const t = cuerpoDeCorreo(soloHtml, dec);
  chk("solo-HTML → texto, sin una sola etiqueta", !/<[a-z!/]/i.test(t) && /Estimado cliente:/.test(t), JSON.stringify(t));
  chk("…sin el CSS, el script, el título ni los comentarios", !/background|track\(|pie/.test(t) && !/^x$/m.test(t));
  chk("…con las tildes resueltas y los saltos de línea", /está disponible\.\nSaludos,\nInterbank/.test(t));
  chk("…y el texto del enlace sin su dirección de seguimiento", /Ver aquí/.test(t) && !/x\.pe/.test(t));
  chk("multipart con el HTML primero: gana el text/plain", cuerpoDeCorreo(altHtmlPrimero, dec) === "Su estado de cuenta está disponible.");
  const anidado: ParteMime = { mimeType: "multipart/mixed", parts: [
    { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64("Hola, adjunto la factura.") } },
      { mimeType: "text/html", body: { data: b64("<div>Hola, adjunto la factura.</div>") } },
    ] },
    { mimeType: "text/plain", filename: "notas.txt", body: { data: b64("NO SOY EL CUERPO") } },
  ] };
  chk("anidado: encuentra el texto en el segundo nivel", cuerpoDeCorreo(anidado, dec) === "Hola, adjunto la factura.");
  const adjuntoPrimero: ParteMime = { mimeType: "multipart/mixed", parts: [
    { mimeType: "text/plain", filename: "notas.txt", body: { data: b64("NO SOY EL CUERPO") } },
    { mimeType: "text/html", body: { data: b64("<p>El cuerpo</p>") } },
  ] };
  chk("un adjunto .txt no es el cuerpo", cuerpoDeCorreo(adjuntoPrimero, dec) === "El cuerpo");
  const planoVacio: ParteMime = { mimeType: "multipart/alternative", parts: [
    { mimeType: "text/plain", body: { data: b64("   \n ") } },
    { mimeType: "text/html", body: { data: b64("<p>Lo de verdad</p>") } },
  ] };
  chk("un text/plain vacío no tapa al HTML", cuerpoDeCorreo(planoVacio, dec) === "Lo de verdad");
  chk("un cuerpo simple sin tipo declarado sigue entrando (lo de siempre)", cuerpoDeCorreo({ body: { data: b64("hola") } }, dec) === "hola");
  chk("sin cuerpo: vacío, sin romper", cuerpoDeCorreo({ mimeType: "multipart/mixed", parts: [] }, dec) === "" && cuerpoDeCorreo(null, dec) === "");

  chk("entidades numéricas y con nombre", textoDeHtml("Cami&oacute;n &#243; &#xF3; &nbsp;&amp; &euro;") === "Camión ó ó & €");
  chk("un «&lt;b&gt;» escrito como texto no se borra como etiqueta", textoDeHtml("<p>usa &lt;b&gt; para negrita</p>") === "usa <b> para negrita");
  chk("una entidad desconocida se deja tal cual", textoDeHtml("a &foo; b") === "a &foo; b");
  const lista = textoDeHtml("<ul><li>uno</li><li>dos</li></ul><table><tr><td>A</td><td>B</td></tr></table>");
  chk("listas con viñeta y una línea por fila de tabla", lista === "• uno\n• dos\nA B", JSON.stringify(lista));
  chk("sin saltos de línea de más", !/\n{3,}/.test(textoDeHtml("<div><div><p>a</p></div></div><br><br><br><br><p>b</p>")));

  chk("documento HTML → sí", pareceHtml("<html><body>x</body></html>") && pareceHtml("  <!DOCTYPE html><html>") && pareceHtml('<html> <body style="background-colo'));
  chk("fragmento con etiqueta y cierre → sí", pareceHtml('<div dir="ltr">Hola<br></div>'));
  chk("un mensaje escrito por una persona → no",
    !pareceHtml("Hola, ¿cómo estás?") && !pareceHtml("precio < 100 y > 50") && !pareceHtml("<3 gracias") && !pareceHtml(""));
  chk("textoLegible deja intacto lo que no es HTML",
    textoLegible("Hola\n\n  mundo  ") === "Hola\n\n  mundo  " && textoLegible(null) === null && textoLegible(undefined) === undefined);
  const x = textoLegible(HTML) as string;
  chk("textoLegible es idempotente (se aplica al cargar y al llegar por tiempo real)", textoLegible(x) === x);

  // De punta a punta: la lectura guarda TEXTO.
  G = new Gmail();
  G.correos = [correo(1, 1, { payload: { mimeType: "text/html", body: { data: b64(HTML) } } })];
  const b = conectada();
  await syncGmailInbox(b);
  const guardado = String(b.t.crm_mensajes[0]?.contenido ?? "");
  chk("la lectura guarda el texto del correo, no su HTML", /Estimado cliente:/.test(guardado) && !/<[a-z!/]/i.test(guardado), guardado.slice(0, 80));
}

Date.now = realNow;
console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
