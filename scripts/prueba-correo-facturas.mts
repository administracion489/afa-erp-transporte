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
import { consultaGmail } from "../lib/combustible/facturas-correo";

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

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
