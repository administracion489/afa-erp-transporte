// Pruebas de la conexión del CORREO DE FACTURAS: qué buzón se lee y a qué buzón va cada
// conexión de Google. NO tocan la base ni llaman a Google: lib/combustible/correo-conexion.ts
// (puro) y las funciones puras de lib/crm-gmail.ts (el `state` firmado y la URL de consentimiento).
// Uso:  npx tsx scripts/prueba-correo-facturas.mts   (sale con código 1 si algo falla)
//
// Lo que defienden, y la mitad de los casos existen para el lado que no se puede aflojar:
//   · una conexión de facturas ROTA no cae al Gmail del CRM (leería otro buzón en silencio);
//   · el destino de la conexión viaja FIRMADO: cambiar la URL no convierte una conexión del CRM
//     en la del correo de facturas ni al revés;
//   · la conexión del CRM queda exactamente como estaba (mismo permiso, mismo prompt).
import { createHash, createHmac } from "crypto";
import { elegirConexion, sePuedeLeer, describirConexion, type EstadoConexion } from "../lib/combustible/correo-conexion";
import { firmarStateGmail, leerStateGmail, verificarStateGmail, getAuthUrl, SCOPES_CRM, SCOPE_SOLO_LECTURA } from "../lib/crm-gmail";
import { consultaGmail, LECTURA_HISTORIAL, falloGmailTransitorio, ggetGmail } from "../lib/combustible/facturas-correo";
import { DIAS_REGISTRO_AUTOMATICO } from "../lib/combustible/factura-lineas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── 1. Qué buzón se lee ──────────────────────────────────────────────────────
console.log("\n1. Cascada de buzones");
const F = (guardada: boolean, utilizable: boolean, email: string | null = "administracion@empresa.pe") =>
  ({ guardada, utilizable, email, error: utilizable ? null : "Google ya no acepta este permiso." });
{
  const e = elegirConexion({ facturas: F(true, true), crm: { guardada: true } });
  chk("con correo de facturas conectado se lee ESE, aunque el CRM también esté", e.codigo === "facturas" && e.email === "administracion@empresa.pe");
}
{
  const e = elegirConexion({ facturas: F(true, false), crm: { guardada: true } });
  chk("una conexión de facturas ROTA no cae al Gmail del CRM", e.codigo === "rota", e.codigo);
  chk("…y dice por qué", !!e.detalle && /permiso/.test(e.detalle));
  chk("…y no se puede leer nada", !sePuedeLeer(e));
}
chk("sin correo de facturas, el Gmail del CRM es el respaldo (lo de siempre)",
  elegirConexion({ facturas: F(false, false, null), crm: { guardada: true } }).codigo === "crm");
chk("sin ninguno de los dos: ninguna",
  elegirConexion({ facturas: F(false, false, null), crm: { guardada: false } }).codigo === "ninguna");
// Barrido: con una conexión de facturas guardada, el resultado NUNCA es el CRM.
{
  let ok = true, leibles = 0;
  for (const g of [false, true]) for (const u of [false, true]) for (const c of [false, true]) {
    const e = elegirConexion({ facturas: F(g, u), crm: { guardada: c } });
    if (g && e.codigo === "crm") ok = false;
    if (sePuedeLeer(e) !== ((g && u) || (!g && c))) ok = false;
    if (sePuedeLeer(e)) leibles++;
  }
  chk("barrido: con correo de facturas guardado jamás se lee el del CRM", ok);
  chk("corolario: hay combinaciones que sí se leen", leibles > 0, `${leibles}`);
}
{
  const codigos: EstadoConexion["codigo"][] = ["facturas", "crm", "rota", "ninguna"];
  const ok = codigos.every((c) => {
    const d = describirConexion({ codigo: c, email: "x@y.pe", detalle: "motivo" });
    return d.titulo.length > 0 && d.detalle.length > 0;
  });
  chk("cada estado tiene título y detalle", ok);
  chk("el de «rota» dice que NO se pasa al CRM",
    /no se pasa al Gmail del CRM/i.test(describirConexion({ codigo: "rota", email: null, detalle: "x" }).detalle));
  const rotaCrm = describirConexion({ codigo: "rota", de: "crm", email: null, detalle: "Google respondió: invalid_grant." });
  chk("si lo que falla es el Gmail del CRM, se dice ESO (y no «vuelve a conectar este»)",
    /CRM no responde/.test(rotaCrm.titulo) && !/no se pasa al Gmail del CRM/i.test(rotaCrm.detalle));
  chk("una rota de facturas declara que es de facturas", elegirConexion({ facturas: F(true, false), crm: { guardada: false } }).de === "facturas");
  chk("solo «facturas» es verde",
    describirConexion({ codigo: "facturas", email: null, detalle: null }).tono === "ok" &&
    codigos.filter((c) => describirConexion({ codigo: c, email: null, detalle: null }).tono === "ok").length === 1);
}

// ── 2. El `state` firmado lleva el destino ───────────────────────────────────
console.log("\n2. State firmado");
{
  const s = firmarStateGmail("u-1", "facturas");
  const l = leerStateGmail(s);
  chk("un state de facturas vuelve como facturas", l?.destino === "facturas" && l?.uid === "u-1");
  chk("el state por defecto es del CRM (lo de siempre)", leerStateGmail(firmarStateGmail("u-2"))?.destino === "crm");
  chk("verificarStateGmail sigue devolviendo el usuario", verificarStateGmail(s) === "u-1");

  // Cambiar el destino dentro del payload sin volver a firmar → inválido.
  const [payload, firma] = firmarStateGmail("u-3", "crm").split(".");
  const obj = JSON.parse(Buffer.from(payload, "base64url").toString());
  const trucado = Buffer.from(JSON.stringify({ ...obj, d: "facturas" })).toString("base64url");
  chk("cambiar el destino sin la firma lo invalida", leerStateGmail(`${trucado}.${firma}`) === null);
  chk("basura no es un state", leerStateGmail("hola") === null && leerStateGmail(undefined) === null);

  // Vencido (10 min) → inválido.
  const ahora = Date.now;
  Date.now = () => ahora() + 11 * 60 * 1000;
  chk("un state vencido no vale", leerStateGmail(s) === null);
  Date.now = ahora;

  // Un state firmado ANTES de este cambio (sin `d`) sigue siendo del CRM.
  const secreto = createHash("sha256")
    .update("crm-gmail-state-v1:" + (process.env.GMAIL_OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ""))
    .digest();
  const viejo = Buffer.from(JSON.stringify({ uid: "u-4", exp: Date.now() + 60000, n: "ab" })).toString("base64url");
  const fViejo = createHmac("sha256", secreto).update(viejo).digest("base64url");
  chk("un state viejo (sin destino) es del CRM", leerStateGmail(`${viejo}.${fViejo}`)?.destino === "crm");
}

// ── 3. La URL de consentimiento ──────────────────────────────────────────────
console.log("\n3. Permisos pedidos a Google");
{
  const crm = new URL(getAuthUrl("st")).searchParams;
  chk("el CRM pide lo mismo de siempre (leer y enviar)", crm.get("scope") === SCOPES_CRM && crm.get("prompt") === "consent");
  const fac = new URL(getAuthUrl("st", { scope: SCOPE_SOLO_LECTURA, elegirCuenta: true })).searchParams;
  chk("el correo de facturas pide SOLO lectura", fac.get("scope") === SCOPE_SOLO_LECTURA && !/send|modify/.test(fac.get("scope") ?? ""));
  chk("…y obliga a elegir la cuenta", /select_account/.test(fac.get("prompt") ?? ""));
  chk("las dos piden acceso duradero (refresh token)", crm.get("access_type") === "offline" && fac.get("access_type") === "offline");
}

// ── 4. La consulta que se corre ──────────────────────────────────────────────
console.log("\n4. Consulta de Gmail");
chk("filtro + ventana", consultaGmail("from:primax has:attachment") === "from:primax has:attachment newer_than:45d");
chk("sin filtro: al menos con adjunto", consultaGmail("  ") === "has:attachment newer_than:45d");
chk("ventana configurable", consultaGmail("x", 7).endsWith("newer_than:7d"));
// Las facturas de COESTI no las manda Primax: las manda factura.peru@cen.biz. Lo que sí llevan
// siempre es el RUC del emisor en el nombre del archivo (20127765279-01-F882-0132184.xml).
const FILTRO = "from:(primax OR coesti OR primaxsolutions) has:attachment";
chk("el RUC de la cuenta se SUMA al filtro (OR), no lo reemplaza",
  consultaGmail(FILTRO, 45, ["20127765279"]) === `((${FILTRO}) OR (20127765279 has:attachment)) newer_than:45d`,
  consultaGmail(FILTRO, 45, ["20127765279"]));
chk("dos RUC, dos alternativas", consultaGmail("x", 45, ["20127765279", "20100128056"]) === "((x) OR (20127765279 has:attachment) OR (20100128056 has:attachment)) newer_than:45d");
chk("un RUC repetido o con espacios cuenta una vez", consultaGmail("x", 45, ["20127765279", " 20127765279 "]).split("20127765279").length === 2);
chk("lo que no es un RUC (11 dígitos) no entra a la consulta", consultaGmail("x", 45, ["123", "abc", "", "2012776527X"]) === "x newer_than:45d");
chk("sin filtro y con RUC: igual con adjunto", consultaGmail("", 45, ["20127765279"]) === "((has:attachment) OR (20127765279 has:attachment)) newer_than:45d");
chk("si el filtro ya busca ese RUC (la pantalla lo sugería), no se repite",
  consultaGmail("20127765279 has:attachment", 45, ["20127765279"]) === "20127765279 has:attachment newer_than:45d");
chk("la lectura normal mira los mismos días hasta los que registra sola",
  consultaGmail("x").endsWith(`newer_than:${DIAS_REGISTRO_AUTOMATICO}d`));
chk("«Leer el último año» cubre los 12 meses anteriores", LECTURA_HISTORIAL.dias >= 365 && consultaGmail("x", LECTURA_HISTORIAL.dias).endsWith(`newer_than:${LECTURA_HISTORIAL.dias}d`));
chk("…sin el repaso de parciales (eso lo hace el cron) y por tandas", LECTURA_HISTORIAL.revisarParciales === false && LECTURA_HISTORIAL.presupuestoMs < 300_000);

// ── 5. Gmail falla a ratos: lo pasajero se reintenta, lo demás se dice ───────
console.log("\n5. Reintentos contra Gmail");
chk("429 (límite por usuario) → se reintenta", falloGmailTransitorio(429, "Too many requests"));
chk("500/503 (backend de Google) → se reintenta", falloGmailTransitorio(500, "Backend Error") && falloGmailTransitorio(503, "x"));
chk("403 por cuota → se reintenta", falloGmailTransitorio(403, "User-rate limit exceeded") && falloGmailTransitorio(403, "Quota exceeded for quota metric"));
chk("sin respuesta (red) → se reintenta", falloGmailTransitorio(null, "fetch failed"));
chk("404 (el correo ya no existe) → NO: esperar no lo arregla", !falloGmailTransitorio(404, "Requested entity was not found."));
chk("401/403 de permiso → NO", !falloGmailTransitorio(401, "Invalid Credentials") && !falloGmailTransitorio(403, "Insufficient Permission"));
chk("400 → NO", !falloGmailTransitorio(400, "Invalid id value"));
{
  const original = globalThis.fetch;
  const guion = (respuestas: (() => Response)[]) => {
    let n = 0;
    globalThis.fetch = (async () => {
      const r = respuestas[Math.min(n, respuestas.length - 1)];
      n++;
      return r();
    }) as any;
    return () => n;
  };
  const json = (status: number, cuerpo: unknown) => () => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
  const html = (status: number) => () => new Response("<html><body>502. That's an error.</body></html>", { status });
  const sinEspera = [0, 0, 0];
  try {
    let llamadas = guion([json(429, { error: { message: "Too many requests" } }), json(503, { error: { message: "Backend Error" } }), json(200, { id: "m1" })]);
    const j = await ggetGmail("tk", "/messages/m1", sinEspera);
    chk("dos fallos pasajeros y luego bien → devuelve el correo", j?.id === "m1" && llamadas() === 3, `llamadas ${llamadas()}`);

    llamadas = guion([json(404, { error: { message: "Requested entity was not found." } })]);
    const e404 = await ggetGmail("tk", "/x", sinEspera).then(() => null, (e) => e.message);
    chk("404 → se dice tal cual y NO se reintenta", e404 === "Requested entity was not found." && llamadas() === 1, `${e404} · ${llamadas()}`);

    llamadas = guion([html(502), json(200, { ok: 1 })]);
    const jh = await ggetGmail("tk", "/x", sinEspera);
    chk("una página de error sin JSON (502) se reintenta", jh?.ok === 1 && llamadas() === 2);

    llamadas = guion([() => { throw new TypeError("fetch failed"); }]);
    const ered = await ggetGmail("tk", "/x", sinEspera).then(() => null, (e) => e.message);
    chk("la red caída se reintenta y al final se nombra con los intentos", /no respondió/.test(ered ?? "") && /tras 4 intentos/.test(ered ?? "") && llamadas() === 4, `${ered}`);

    // Regresión: el gget anterior, copiado literal. Leía el JSON ANTES de mirar el estado, así que
    // una página de error de Google se convertía en un error de JSON que no dice nada, sin reintento.
    async function ggetViejo(token: string, ruta: string): Promise<any> {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? `Gmail ${r.status}`);
      return j;
    }
    llamadas = guion([html(502), json(200, { ok: 1 })]);
    const eViejo = await ggetViejo("tk", "/x").then(() => null, (e) => e.message);
    chk("regresión: el viejo, ante un 502 de Google, fallaba con un error de JSON y sin reintentar",
      !!eViejo && !/Gmail/.test(eViejo) && llamadas() === 1, `${eViejo}`);
  } finally {
    globalThis.fetch = original;
  }
}

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
