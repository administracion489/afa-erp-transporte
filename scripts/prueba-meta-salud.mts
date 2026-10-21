// npx tsx scripts/prueba-meta-salud.mts
//
// Matriz del diagnóstico de envío de WhatsApp (lib/meta-salud.ts): qué dice Meta de
// un número que no puede enviar, y si es un pago, un bloqueo o un permiso.

import { readFileSync } from "node:fs";
import {
  leerSalud,
  leerPermisos,
  veredictoSalud,
  esDePago,
  MARCA_META_DICE,
  type LecturaToken,
} from "../lib/meta-salud";
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

const WABA = "428943170988671";

// ── 1. leerSalud ──────────────────────────────────────────────────────────────
const SANO = {
  health_status: {
    can_send_message: "AVAILABLE",
    entities: [
      { entity_type: "PHONE_NUMBER", id: "2588335447883921", can_send_message: "AVAILABLE" },
      { entity_type: "WABA", id: WABA, can_send_message: "AVAILABLE" },
      { entity_type: "BUSINESS", id: "1", can_send_message: "AVAILABLE" },
      { entity_type: "APP", id: "2", can_send_message: "AVAILABLE" },
    ],
  },
  id: "2588335447883921",
};
const s0 = leerSalud(200, SANO);
check("sano: AVAILABLE sin bloqueos", s0.nivel === "AVAILABLE" && s0.bloqueos.length === 0 && s0.error === null, s0);

const PAGO = {
  health_status: {
    can_send_message: "BLOCKED",
    entities: [
      { entity_type: "PHONE_NUMBER", id: "2588335447883921", can_send_message: "AVAILABLE" },
      {
        entity_type: "WABA",
        id: WABA,
        can_send_message: "BLOCKED",
        errors: [
          {
            error_code: 141006,
            error_description: "There is an error with the payment method of the WhatsApp Business Account.",
            possible_solution: "Add a valid payment method in WhatsApp Manager.",
          },
        ],
      },
    ],
  },
};
const s1 = leerSalud(200, PAGO);
check("pago: BLOCKED con un bloqueo de la WABA", s1.nivel === "BLOCKED" && s1.bloqueos.length === 1 && s1.bloqueos[0].entidad === "WABA" && s1.bloqueos[0].codigo === 141006, s1);
check("pago: esDePago", esDePago(s1.bloqueos[0]));

const VERIF = {
  health_status: {
    can_send_message: "BLOCKED",
    entities: [
      {
        entity_type: "BUSINESS",
        id: "99",
        can_send_message: "BLOCKED",
        errors: [{ error_code: 141010, error_description: "The Business has not passed business verification.", possible_solution: "Start business verification." }],
      },
    ],
  },
};
const s2 = leerSalud(200, VERIF);
check("verificación: no es de pago", s2.bloqueos.length === 1 && !esDePago(s2.bloqueos[0]), s2);

const SIN_DETALLE = { health_status: { can_send_message: "LIMITED", entities: [{ entity_type: "APP", id: "2", can_send_message: "LIMITED", additional_info: ["App is in development mode"] }] } };
const s3 = leerSalud(200, SIN_DETALLE);
check("limitada sin errors: se nombra con additional_info", s3.nivel === "LIMITED" && s3.bloqueos.length === 1 && /development/.test(s3.bloqueos[0].descripcion), s3);

const ERR = { error: { message: "(#131005) Access denied", code: 131005 } };
const s4 = leerSalud(403, ERR);
check("error de Meta: nivel null y el error", s4.nivel === null && /131005/.test(s4.error ?? ""), s4);
check("sin health_status: no se afirma nada", leerSalud(200, { id: "x" }).nivel === null);
check("respuesta vacía con 500", leerSalud(500, {}).error === "HTTP 500");
check("valor raro de can_send_message → null", leerSalud(200, { health_status: { can_send_message: "maybe", entities: [] } }).nivel === null);

// ── 2. leerPermisos ───────────────────────────────────────────────────────────
const dbg = (granular: any[], extra: any = {}) => ({ data: { is_valid: true, scopes: granular.map((g) => g.scope), granular_scopes: granular, ...extra } });
check(
  "permiso: mensajería sobre la WABA",
  leerPermisos(200, dbg([{ scope: "whatsapp_business_messaging", target_ids: [WABA, "1336334522036982"] }]), WABA).mensajeria === true,
);
check(
  "permiso: mensajería pero sobre OTRA cuenta → false",
  leerPermisos(200, dbg([{ scope: "whatsapp_business_messaging", target_ids: ["1336334522036982"] }]), WABA).mensajeria === false,
);
check("permiso: sin target_ids vale para todas", leerPermisos(200, dbg([{ scope: "whatsapp_business_messaging" }]), WABA).mensajeria === true);
check(
  "permiso: sin el scope de mensajería → false",
  leerPermisos(200, dbg([{ scope: "whatsapp_business_management", target_ids: [WABA] }]), WABA).mensajeria === false,
);
check("permiso: sin WABA conocida y con target_ids → null", leerPermisos(200, dbg([{ scope: "whatsapp_business_messaging", target_ids: ["9"] }]), null).mensajeria === null);
const inv = leerPermisos(200, { data: { is_valid: false, error: { message: "Session has expired" }, scopes: [] } }, WABA);
check("token inválido", inv.valido === false && /expired/.test(inv.error ?? ""), inv);
const sinDatos = leerPermisos(400, { error: { message: "Invalid OAuth access token", code: 190 } }, WABA);
check("debug_token falla → todo null con error", sinDatos.valido === null && sinDatos.mensajeria === null && /190/.test(sinDatos.error ?? ""), sinDatos);

// ── 3. Veredicto ──────────────────────────────────────────────────────────────
const L = (cual: "propio" | "general", salud: any, permisos: any): LecturaToken => ({ cual, salud, permisos });
const permOk = leerPermisos(200, dbg([{ scope: "whatsapp_business_messaging", target_ids: [WABA] }]), WABA);
const permNo = leerPermisos(200, dbg([{ scope: "whatsapp_business_messaging", target_ids: ["1336334522036982"] }]), WABA);

const v1 = veredictoSalud([L("propio", s1, permOk), L("general", s1, permOk)], WABA);
check("veredicto: pago, una sola vez aunque lo lean los dos tokens", v1.codigo === "pago" && (v1.texto.match(/141006/g) ?? []).length === 1, v1);
check("veredicto pago: nombra la cuenta y la solución", /cuenta de WhatsApp/.test(v1.texto) && /Solución de Meta/.test(v1.texto), v1);

const v2 = veredictoSalud([L("propio", s2, permOk)], WABA);
check("veredicto: bloqueo de Meta que no es pago", v2.codigo === "bloqueo_meta" && /portafolio/.test(v2.texto), v2);

const v3 = veredictoSalud([L("propio", s4, permNo), L("general", s4, permNo)], WABA);
check("veredicto: ninguno con permiso sobre la WABA", v3.codigo === "sin_permiso" && v3.texto.includes(WABA), v3);

const v4 = veredictoSalud([L("propio", s4, permNo), L("general", s0, permOk)], WABA);
check("veredicto: uno con permiso y sano → disponible, no es pago", v4.codigo === "disponible" && /no un pago/.test(v4.texto), v4);

const v5 = veredictoSalud([L("propio", s4, inv), L("general", s4, inv)], WABA);
check("veredicto: los dos tokens inválidos", v5.codigo === "token_invalido", v5);

const v6 = veredictoSalud([L("propio", s4, null), L("general", s4, null)], WABA);
check("veredicto: sin nada leído → no se sabe, con el error", v6.codigo === "no_se_sabe" && /131005/.test(v6.texto), v6);
check("veredicto: lista vacía → no se sabe", veredictoSalud([], WABA).codigo === "no_se_sabe");

// El pago manda sobre cualquier otra cosa: es lo que se arregla en otro sitio.
const v7 = veredictoSalud([L("propio", s2, permNo), L("general", s1, permNo)], WABA);
check("veredicto: pago gana sobre bloqueo y sobre permiso", v7.codigo === "pago", v7);

// Invariante: nunca se afirma «disponible» sin haber leído un AVAILABLE.
const saludes = [s0, s1, s2, s3, s4, null];
const permisos = [permOk, permNo, inv, sinDatos, null];
let combinaciones = 0;
for (const a of saludes) for (const b of saludes) for (const pa of permisos) for (const pb of permisos) {
  combinaciones++;
  const v = veredictoSalud([L("propio", a, pa), L("general", b, pb)], WABA);
  const leyoAvailable = a?.nivel === "AVAILABLE" || b?.nivel === "AVAILABLE";
  if (v.codigo === "disponible") check("barrido: disponible solo con un AVAILABLE leído", leyoAvailable, { a, b });
  const hayBloqueo = (a?.bloqueos.length ?? 0) + (b?.bloqueos.length ?? 0) > 0;
  check("barrido: con un bloqueo de Meta el veredicto lo nombra", !hayBloqueo || v.codigo === "pago" || v.codigo === "bloqueo_meta", { a, b, v });
  check("barrido: el texto nunca está vacío", v.texto.length > 10);
}
check("barrido: corrió", combinaciones === 900);

// ── 4. Lo que ve el operador ──────────────────────────────────────────────────
const bruto = `(#131005) Access denied (también con el token general)${MARCA_META_DICE}${v1.texto}`;
const e = explicarErrorEnvioWhatsApp(bruto);
check("explicar: el diagnóstico va delante", e.startsWith("Meta rechazó el envío por este número. Meta bloquea el envío por un tema de PAGO"), e);
check("explicar: conserva el código de Meta", e.includes("(#131005) Access denied"), e);
check("explicar sin diagnóstico: el texto de siempre", /permisos/.test(explicarErrorEnvioWhatsApp("(#131005) Access denied")));

// ── 5. Ningún token sale del servidor ─────────────────────────────────────────
const datos = readFileSync(new URL("../lib/meta-salud-datos.ts", import.meta.url), "utf8");
check("datos: lo guardado no lleva tokens", /lecturas\s*\}/.test(datos) && !/valor: JSON\.stringify\([^)]*token/.test(datos));
check("datos: las lecturas no incluyen el token", !/return \{\s*cual,\s*token/.test(datos));
const meta = readFileSync(new URL("../lib/crm-meta.ts", import.meta.url), "utf8");
check("crm-meta: diagnostica solo ante un rechazo por permisos", /if \(r\.porPermiso\)\s*\{[\s\S]*diagnosticarEnvio/.test(meta));

console.log(`\n${ok} bien · ${mal} mal`);
if (mal) process.exit(1);
