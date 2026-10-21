// npx tsx scripts/prueba-meta-token-respaldo.mts
//
// Matriz del respaldo de token de WhatsApp (lib/meta-token-respaldo.ts).
// El caso: el 20-10-2026 el token propio del número del CRM perdió el permiso de envío
// («(#131005) Access denied») y el número quedó mudo, aunque el token general de la
// empresa podía enviar por él.

import { readFileSync } from "node:fs";
import {
  esErrorDePermiso,
  tokensEnOrden,
  enviarConRespaldo,
  unirMensajes,
  type IntentoMeta,
} from "../lib/meta-token-respaldo";
import { explicarErrorEnvioWhatsApp } from "../lib/crm-meta";

let ok = 0;
let mal = 0;
function check(nombre: string, cond: boolean, detalle?: unknown) {
  if (cond) ok++;
  else {
    mal++;
    console.log("✗", nombre, detalle !== undefined ? JSON.stringify(detalle) : "");
  }
}

const err = (code: number | string | undefined, message: string) => ({ error: { code, message } });
const ACCESO_DENEGADO = "(#131005) Access denied";

// ── 1. Qué es un error de permiso ─────────────────────────────────────────────
for (const c of [131005, 190, 10, 200, 230, 299, 0, 3, "131005"]) {
  check(`permiso: código ${c}`, esErrorDePermiso(400, err(c, "x").error));
}
for (const c of [131047, 132001, 100, 131026, 2, 1, 368, 130429, 131042, 131031, 133010, 300]) {
  check(`no permiso: código ${c}`, !esErrorDePermiso(400, err(c, "x").error));
}
check("sin código y 401 → permiso", esErrorDePermiso(401, undefined));
check("sin código y 403 → permiso", esErrorDePermiso(403, { message: "x" }));
check("sin código y 500 → no", !esErrorDePermiso(500, undefined));
check("sin código y 400 → no", !esErrorDePermiso(400, {}));
check("código vacío y 403 → permiso", esErrorDePermiso(403, { code: "" }));
check("código 131047 con 403 → no (manda el código)", !esErrorDePermiso(403, { code: 131047 }));

// ── 2. Orden de los tokens ────────────────────────────────────────────────────
const igual = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
check("propio y general", igual(tokensEnOrden("P", "G", false), ["P", "G"]));
check("propio vetado → general primero", igual(tokensEnOrden("P", "G", true), ["G", "P"]));
check("el mismo token una sola vez", igual(tokensEnOrden("T", "T", false), ["T"]));
check("con espacios es el mismo", igual(tokensEnOrden(" T ", "T", false), ["T"]));
check("sin propio → solo general", igual(tokensEnOrden(undefined, "G", false), ["G"]));
check("sin propio y 'vetado' → solo general", igual(tokensEnOrden(null, "G", true), ["G"]));
check("sin general → solo propio", igual(tokensEnOrden("P", undefined, false), ["P"]));
check("propio en blanco no cuenta", igual(tokensEnOrden("  ", "G", false), ["G"]));
check("ninguno → vacío", igual(tokensEnOrden(undefined, "", false), []));

// ── 3. Escenarios ─────────────────────────────────────────────────────────────
type Guion = Record<string, IntentoMeta>;
function falso(guion: Guion) {
  const llamadas: string[] = [];
  const intentar = async (t: string) => {
    llamadas.push(t);
    return guion[t] ?? { ok: false, status: 500, data: err(1, "sin guion") };
  };
  return { llamadas, intentar };
}
const OK: IntentoMeta = { ok: true, status: 200, data: { messages: [{ id: "wamid.1" }] } };
const DENEGADO: IntentoMeta = { ok: false, status: 403, data: err(131005, ACCESO_DENEGADO) };

{
  const f = falso({ P: OK, G: OK });
  const r = await enviarConRespaldo(["P", "G"], f.intentar, "Error");
  check("a. propio funciona → una llamada con el propio", r.ok && r.token === "P" && f.llamadas.length === 1, { r, l: f.llamadas });
}
{
  // EL CASO DEL 20-10-2026
  const f = falso({ P: DENEGADO, G: OK });
  const r = await enviarConRespaldo(["P", "G"], f.intentar, "Error");
  check("b. 131005 con el propio → sale con el general", r.ok && r.token === "G" && f.llamadas.join() === "P,G", { r, l: f.llamadas });
  check("b. devuelve la respuesta del que funcionó", r.ok && r.data?.messages?.[0]?.id === "wamid.1");
}
{
  const f = falso({ P: { ok: false, status: 400, data: err(131047, "(#131047) Re-engagement message") }, G: OK });
  const r = await enviarConRespaldo(["P", "G"], f.intentar, "Error");
  check("c. fuera de 24 h no se reintenta", !r.ok && f.llamadas.length === 1, { r, l: f.llamadas });
  check("c. el mensaje conserva el 131047", !r.ok && /131047/.test(r.mensaje) && !r.porPermiso);
}
{
  const f = falso({ P: DENEGADO, G: DENEGADO });
  const r = await enviarConRespaldo(["P", "G"], f.intentar, "Error");
  check("d. los dos denegados → dos llamadas", !r.ok && f.llamadas.length === 2 && r.porPermiso, { r });
  check("d. el mensaje empieza por el del propio", !r.ok && r.mensaje.startsWith(ACCESO_DENEGADO), r);
  check("d. dice que el general tampoco", !r.ok && /también con el token general/.test(r.mensaje), r);
}
{
  const f = falso({ P: { ok: false, status: 401, data: err(190, "Error validating access token") }, G: { ok: false, status: 400, data: err(100, "Invalid parameter") } });
  const r = await enviarConRespaldo(["P", "G"], f.intentar, "Error");
  check("e. motivos distintos se juntan", !r.ok && r.mensaje === "Error validating access token · con el token general: Invalid parameter", r);
  check("e. el segundo no es de permiso", !r.ok && !r.porPermiso);
}
{
  const f = falso({ P: { ok: false, status: 500, data: err(2, "(#2) Service temporarily unavailable") }, G: OK });
  const r = await enviarConRespaldo(["P", "G"], f.intentar, "Error");
  check("f. un 5xx no se reintenta (pudo haber salido)", !r.ok && f.llamadas.length === 1, { r, l: f.llamadas });
}
{
  const f = falso({});
  const r = await enviarConRespaldo([], f.intentar, "Error");
  check("g. sin tokens → error sin llamadas", !r.ok && r.intentos === 0 && f.llamadas.length === 0 && /No hay token/.test(r.mensaje), r);
}
{
  const f = falso({ G: DENEGADO });
  const r = await enviarConRespaldo(["G"], f.intentar, "Error");
  check("h. un solo token denegado → su mensaje tal cual", !r.ok && r.mensaje === ACCESO_DENEGADO && f.llamadas.length === 1, r);
}
{
  const f = falso({ P: { ok: false, status: 400, data: {} } });
  const r = await enviarConRespaldo(["P", "G"], f.intentar, "Error WhatsApp");
  check("i. sin cuerpo de error → mensaje por defecto, sin reintento", !r.ok && r.mensaje === "Error WhatsApp" && f.llamadas.length === 1, r);
}
{
  // Vetado: el general va primero; si un día también falla, se vuelve a probar el propio.
  const f = falso({ G: DENEGADO, P: OK });
  const r = await enviarConRespaldo(tokensEnOrden("P", "G", true), f.intentar, "Error");
  check("j. vetado y el general rechazado → se prueba el propio", r.ok && r.token === "P" && f.llamadas.join() === "G,P", { r, l: f.llamadas });
}

// ── 4. Barrido ────────────────────────────────────────────────────────────────
const respuestas: IntentoMeta[] = [
  OK,
  DENEGADO,
  { ok: false, status: 401, data: err(190, "token") },
  { ok: false, status: 400, data: err(10, "perm") },
  { ok: false, status: 400, data: err(131047, "24h") },
  { ok: false, status: 404, data: err(132001, "tpl") },
  { ok: false, status: 500, data: err(1, "unknown") },
  { ok: false, status: 400, data: {} },
];
let combinaciones = 0;
for (const a of respuestas) for (const b of respuestas) for (const n of [1, 2]) {
  combinaciones++;
  const tokens = n === 2 ? ["P", "G"] : ["P"];
  const f = falso({ P: a, G: b });
  const r = await enviarConRespaldo(tokens, f.intentar, "D");
  const reintento = n === 2 && !a.ok && esErrorDePermiso(a.status, a.data?.error);
  check("barrido: llamadas = 1 + reintento", f.llamadas.length === (reintento ? 2 : 1), { a, b, n, l: f.llamadas });
  const esperaOk = a.ok || (reintento && b.ok);
  check("barrido: ok ⟺ alguno de los intentos hechos funcionó", r.ok === esperaOk, { a, b, n, r });
  if (!r.ok) {
    const primero = String(a.data?.error?.message ?? "D");
    check("barrido: el error empieza por el del primer intento", r.mensaje.startsWith(primero), { a, b, r });
  }
}
check("barrido: corrió", combinaciones === 128);

// ── 5. unirMensajes ───────────────────────────────────────────────────────────
check("unir: uno", unirMensajes(["a"]) === "a");
check("unir: iguales", unirMensajes(["a", "a"]) === "a (también con el token general)");
check("unir: distintos", unirMensajes(["a", "b"]) === "a · con el token general: b");
check("unir: vacío", unirMensajes([]) === "");

// ── 6. Lo que ve el operador ──────────────────────────────────────────────────
const e131005 = explicarErrorEnvioWhatsApp(`${ACCESO_DENEGADO} (también con el token general)`);
check("explicar 131005: dice permisos y el arreglo", /permisos/.test(e131005) && /Conectar WhatsApp/.test(e131005), e131005);
check("explicar 131005: conserva el texto de Meta", e131005.includes(ACCESO_DENEGADO), e131005);
check("explicar 131047: sigue siendo la ventana de 24 h", /24 h/.test(explicarErrorEnvioWhatsApp("(#131047) Re-engagement message")));
check("explicar otro: tal cual", explicarErrorEnvioWhatsApp("(#100) Invalid parameter") === "(#100) Invalid parameter");

// ── 7. Todos los envíos de WhatsApp pasan por el respaldo ─────────────────────
const fuente = readFileSync(new URL("../lib/crm-meta.ts", import.meta.url), "utf8");
const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const llamadasMessages = sinComentarios.match(/\/messages`/g) ?? [];
// Una para WhatsApp (dentro de postWA), una para Messenger y una para Instagram.
check("crm-meta: un solo POST a /messages de WhatsApp (postWA)", (sinComentarios.match(/\$\{GRAPH\}\/\$\{phoneId\}\/messages`/g) ?? []).length === 1 && llamadasMessages.length === 3, llamadasMessages.length);
check("crm-meta: ya no se usa tokenParaNumero para enviar", !/tokenParaNumero|waToken\(/.test(sinComentarios));
check("crm-meta: postWA usa el respaldo", /enviarConRespaldo\(/.test(sinComentarios) && /tokensEnOrden\(/.test(sinComentarios));

console.log(`\n${ok} bien · ${mal} mal`);
if (mal) process.exit(1);
