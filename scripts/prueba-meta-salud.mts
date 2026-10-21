// npx tsx scripts/prueba-meta-salud.mts
//
// Matriz del diagnóstico de envío de WhatsApp (lib/meta-salud.ts): qué dice Meta de
// un número que no puede enviar, y si es un pago, un bloqueo o un permiso.

import { readFileSync } from "node:fs";
import {
  leerSalud,
  leerPermisos,
  leerNumero,
  leerCuenta,
  problemaNumero,
  veredictoSalud,
  esDePago,
  esDeLlamadas,
  esDeVerificacion,
  MARCA_META_DICE,
  type LecturaToken,
  type NumeroLeido,
  type CuentaLeida,
  cuentaSoloParaBsp,
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
check("veredicto: la verificación del negocio tiene su código", v2.codigo === "verificacion" && /portafolio/.test(v2.texto) && /verificación de negocio/.test(v2.texto), v2);
check("veredicto verificación: sin la cuenta leída no afirma que no es pago, dice dónde mirarlo", !/no es un tema de pago/.test(v2.texto) && /Falta un método de pago/.test(v2.texto) && /siguen válidos/.test(v2.texto), v2);
const v2b = veredictoSalud([L("propio", s3, permOk)], WABA);
check("veredicto: otro bloqueo de Meta (app en desarrollo) es bloqueo_meta", v2b.codigo === "bloqueo_meta" && /development/.test(v2b.texto), v2b);

const v3 = veredictoSalud([L("propio", s4, permNo), L("general", s4, permNo)], WABA);
check("veredicto: ninguno con permiso sobre la WABA", v3.codigo === "sin_permiso" && v3.texto.includes(WABA), v3);

const v4 = veredictoSalud([L("propio", s4, permNo), L("general", s0, permOk)], WABA);
check("veredicto: uno con permiso y sano → disponible, y manda a mirar las alertas", v4.codigo === "disponible" && /Alertas/.test(v4.texto) && !/no es un tema de pago/.test(v4.texto), v4);

const v5 = veredictoSalud([L("propio", s4, inv), L("general", s4, inv)], WABA);
check("veredicto: los dos tokens inválidos", v5.codigo === "token_invalido", v5);

const v6 = veredictoSalud([L("propio", s4, null), L("general", s4, null)], WABA);
check("veredicto: sin nada leído → no se sabe, con el error", v6.codigo === "no_se_sabe" && /131005/.test(v6.texto), v6);
check("veredicto: lista vacía → no se sabe", veredictoSalud([], WABA).codigo === "no_se_sabe");

// El pago manda sobre cualquier otra cosa: es lo que se arregla en otro sitio.
const v7 = veredictoSalud([L("propio", s2, permNo), L("general", s1, permNo)], WABA);
check("veredicto: pago gana sobre bloqueo y sobre permiso", v7.codigo === "pago", v7);

// ── 3b. EL CASO REAL (20-10-2026, 22:52): lo que contestó Meta, sin los tokens ──
// El número salía LIMITED por dos motivos de LLAMADAS (SIP sin configurar) y por la
// verificación del negocio. El veredicto viejo ponía los tres en el titular como
// «Meta bloquea el envío» y mandaba a configurar un SIP.
const REAL = {
  health_status: {
    can_send_message: "LIMITED",
    entities: [
      {
        entity_type: "PHONE_NUMBER",
        id: "2588335447883921",
        can_send_message: "LIMITED",
        errors: [{ error_code: 138024, error_description: "WhatsApp Business calling cannot use SIP because it is not enabled", possible_solution: "Configure SIP using {PHONE_NUMBER_ID}/settings API" }],
      },
      { entity_type: "WABA", id: WABA, can_send_message: "AVAILABLE" },
      {
        entity_type: "BUSINESS",
        id: "287525502109554",
        can_send_message: "LIMITED",
        errors: [{ error_code: 141010, error_description: "The Business has not passed business verification.", possible_solution: "Visit business settings and start or resolve the business verification request." }],
      },
      {
        entity_type: "APP",
        id: "1776032736701552",
        can_send_message: "AVAILABLE",
        errors: [{ error_code: 138025, error_description: "This app cannot use SIP for WhatsApp Business calling because it has not configured a SIP server for this business phone number", possible_solution: "Configure SIP server using {PHONE_NUMBER_ID}/settings API" }],
      },
    ],
  },
};
const sReal = leerSalud(200, REAL);
check("real: se leen los tres motivos", sReal.nivel === "LIMITED" && sReal.bloqueos.length === 3, sReal);
check("real: 138024 y 138025 son de llamadas", sReal.bloqueos.filter(esDeLlamadas).map((b) => b.codigo).join() === "138024,138025", sReal.bloqueos);
check("real: 141010 es la verificación", sReal.bloqueos.filter(esDeVerificacion).map((b) => b.codigo).join() === "141010");
check("real: nada es de pago", !sReal.bloqueos.some(esDePago));
const vReal = veredictoSalud([L("propio", sReal, permOk), L("general", sReal, permOk)], WABA);
check("real: el veredicto es la verificación", vReal.codigo === "verificacion", vReal);
check("real: no habla de SIP ni de llamadas", !/SIP|calling|138024|138025/.test(vReal.texto), vReal);
check("real: sin la cuenta leída NO afirma que no es pago (el 21-10 sí lo era)", !/no es un tema de pago|ningún problema de pago/.test(vReal.texto) && /Falta un método de pago/.test(vReal.texto), vReal);
check("real: nombra el portafolio y el arreglo en castellano", vReal.texto.includes("287525502109554") && /Centro de seguridad/.test(vReal.texto), vReal);
check("real: la verificación aparece una sola vez aunque la lean los dos tokens", (vReal.texto.match(/141010/g) ?? []).length === 1, vReal);
check("real: manda al soporte de Meta con el fbtrace_id si sigue", /fbtrace_id/.test(vReal.texto), vReal);

// Un LIMITED que solo explican las llamadas no es un bloqueo de mensajes.
const SOLO_LLAMADAS = {
  health_status: {
    can_send_message: "LIMITED",
    entities: [REAL.health_status.entities[0], REAL.health_status.entities[3]],
  },
};
const sLl = leerSalud(200, SOLO_LLAMADAS);
const vLl = veredictoSalud([L("propio", sLl, permOk)], WABA);
check("solo llamadas: disponible y lo dice", vLl.codigo === "disponible" && /LLAMADAS/.test(vLl.texto) && /Alertas/.test(vLl.texto), vLl);

// ── 3c. El estado del número y la cuenta a la que pertenece ──────────────────
const PHONE = "2588335447883921";
const listaCon = { status: 200, data: { data: [{ id: PHONE }, { id: "9" }] } };
const listaSin = { status: 200, data: { data: [{ id: "9" }] } };
const listaSinMas = { status: 200, data: { data: [{ id: "9" }], paging: { next: "https://x" } } };
const nOk = leerNumero(200, { status: "CONNECTED", name_status: "APPROVED", platform_type: "CLOUD_API", account_mode: "LIVE", quality_rating: "GREEN" }, PHONE, listaCon);
check("número: conectado y en la cuenta", nOk.status === "CONNECTED" && nOk.enWaba === true && problemaNumero(nOk) === null, nOk);
check("número: fuera de la lista → enWaba false", leerNumero(200, { status: "CONNECTED" }, PHONE, listaSin).enWaba === false);
check("número: fuera de esta página y hay más → no se sabe", leerNumero(200, { status: "CONNECTED" }, PHONE, listaSinMas).enWaba === null);
check("número: lista con error → no se sabe", leerNumero(200, {}, PHONE, { status: 403, data: { error: { message: "x", code: 200 } } }).enWaba === null);
check("número: sin lista → no se sabe", leerNumero(200, {}, PHONE, null).enWaba === null);
const nErr = leerNumero(400, { error: { message: "(#100) Tried accessing nonexisting field", code: 100 } }, PHONE, listaCon);
check("número: error de Meta → nada juzgado, la lista sí", nErr.error !== null && problemaNumero(nErr) === null && nErr.enWaba === true, nErr);
check("número: estado FLAGGED se nombra", /FLAGGED/.test(problemaNumero(leerNumero(200, { status: "FLAGGED" }, PHONE, null)) ?? ""));
check("número: estado desconocido no se juzga", problemaNumero(leerNumero(200, { status: "PENDING" }, PHONE, null)) === null);
check("número: fuera de la Cloud API se nombra", /Cloud API/.test(problemaNumero(leerNumero(200, { platform_type: "NOT_APPLICABLE" }, PHONE, null)) ?? ""));
check("número: nombre rechazado se nombra", /rechazó/.test(problemaNumero(leerNumero(200, { name_status: "DECLINED" }, PHONE, null)) ?? ""));

const LN = (cual: "propio" | "general", salud: any, permisos: any, numero: NumeroLeido | null): LecturaToken => ({ cual, salud, permisos, numero });
const nFuera = leerNumero(200, { status: "CONNECTED" }, PHONE, listaSin);
const vFuera = veredictoSalud([LN("propio", sReal, permOk, nFuera), LN("general", sReal, permOk, nFuera)], WABA);
check("otra cuenta: gana sobre la verificación y la menciona", vFuera.codigo === "otra_cuenta" && /141010/.test(vFuera.texto) && /Conectar WhatsApp/.test(vFuera.texto), vFuera);
const vMixto = veredictoSalud([LN("propio", sReal, permOk, nFuera), LN("general", sReal, permOk, nOk)], WABA);
check("otra cuenta: si un token lo ve en la cuenta, no se afirma", vMixto.codigo === "verificacion", vMixto);
const nFlag = leerNumero(200, { status: "RESTRICTED" }, PHONE, listaCon);
const vFlag = veredictoSalud([LN("propio", s0, permOk, nFlag)], WABA);
check("número restringido: numero_estado", vFlag.codigo === "numero_estado" && /RESTRICTED/.test(vFlag.texto), vFlag);


// ── 3e. EL MÉTODO DE PAGO (21-10-2026): health_status no lo dice, la cuenta sí ──
// WhatsApp Manager: «Falta un método de pago válido… No podrás enviar mensajes a los
// clientes hasta que agregues un método de pago». health_status era el de arriba
// (LIMITED por llamadas y verificación) y el veredicto decía «no hay problema de pago».
const cSin = leerCuenta(200, { id: WABA, currency: "INR", account_review_status: "APPROVED" });
check("cuenta: sin primary_funding_id → no hay método de pago", cSin.metodoPago === false && cSin.moneda === "INR" && cSin.error === null, cSin);
const cCon = leerCuenta(200, { id: WABA, currency: "USD", primary_funding_id: "123456789" });
check("cuenta: con primary_funding_id → sí hay", cCon.metodoPago === true && cCon.moneda === "USD", cCon);
check("cuenta: primary_funding_id vacío no cuenta", leerCuenta(200, { id: WABA, primary_funding_id: "  " }).metodoPago === false);
const cErr = leerCuenta(400, { error: { message: "(#100) Tried accessing nonexisting field (primary_funding_id)", code: 100 } });
check("cuenta: error de Meta → nada afirmado", cErr.metodoPago === null && /100/.test(cErr.error ?? ""), cErr);
check("cuenta: respuesta sin id → nada afirmado", leerCuenta(200, {}).metodoPago === null && leerCuenta(200, null).error !== null);

const LC = (cual: "propio" | "general", salud: any, permisos: any, cuenta: CuentaLeida | null): LecturaToken => ({ cual, salud, permisos, numero: nOk, cuenta });
const vPagoReal = veredictoSalud([LC("propio", sReal, permOk, cSin), LC("general", sReal, permOk, cSin)], WABA);
check("pago real: el veredicto es pago", vPagoReal.codigo === "pago", vPagoReal);
check("pago real: dice que falta el método y dónde se agrega", /ningún método de pago/.test(vPagoReal.texto) && /Agregar método de pago/.test(vPagoReal.texto) && vPagoReal.texto.includes(WABA), vPagoReal);
check("pago real: nombra la moneda de la cuenta", /factura en INR/.test(vPagoReal.texto), vPagoReal);
check("pago real: la verificación no se calla", /141010/.test(vPagoReal.texto) && (vPagoReal.texto.match(/141010/g) ?? []).length === 1, vPagoReal);
check("pago real: no habla de SIP", !/SIP|138024|138025/.test(vPagoReal.texto), vPagoReal);
const vConMetodo = veredictoSalud([LC("propio", sReal, permOk, cCon)], WABA);
check("con método de pago: el veredicto es la verificación y dice que no es pago", vConMetodo.codigo === "verificacion" && /no es un tema de pago/.test(vConMetodo.texto), vConMetodo);
const vDisCon = veredictoSalud([LC("propio", s0, permOk, cCon)], WABA);
check("disponible con método: no es pago", vDisCon.codigo === "disponible" && /no es un tema de pago/.test(vDisCon.texto), vDisCon);
const vCuentaErr = veredictoSalud([LC("propio", sReal, permOk, cErr)], WABA);
check("cuenta ilegible: no se afirma nada del pago", vCuentaErr.codigo === "verificacion" && !/no es un tema de pago|ningún método de pago/.test(vCuentaErr.texto), vCuentaErr);
const vDesacuerdo = veredictoSalud([LC("propio", sReal, permOk, cSin), LC("general", sReal, permOk, cCon)], WABA);
check("un token ve el método y otro no: no se afirma que falte", vDesacuerdo.codigo === "verificacion" && /no es un tema de pago/.test(vDesacuerdo.texto), vDesacuerdo);
check("sin método gana sobre un token inválido y sobre otra cuenta",
  veredictoSalud([{ cual: "propio", salud: s4, permisos: inv, numero: nFuera, cuenta: cSin }], WABA).codigo === "pago");
const vPago141 = veredictoSalud([LC("propio", s1, permOk, cSin)], WABA);
check("sin método y además el 141006: un solo veredicto que nombra los dos", vPago141.codigo === "pago" && /141006/.test(vPago141.texto) && /ningún método de pago/.test(vPago141.texto), vPago141);

// 3f. Lo que contestó Meta el 20-10-2026 a las 23:34, con el método de pago recién
// agregado: la cuenta NO se deja leer a un Tech Provider. El ERP no puede saberlo y
// tiene que decirlo, sin afirmar ni que falta ni que está.
const cBsp = leerCuenta(400, { error: { message: "You do not have permission to perform this action. This action requires that the Business that owns this App is a Business Solution Provider for WhatsApp.", code: 10 } });
check("cuenta solo para BSP: se reconoce", cuentaSoloParaBsp(cBsp) && cBsp.metodoPago === null, cBsp);
check("cuenta solo para BSP: otro error no lo es", !cuentaSoloParaBsp(cErr) && !cuentaSoloParaBsp(cSin) && !cuentaSoloParaBsp(null));
const vBsp = veredictoSalud([LC("propio", sLl, permOk, cBsp), LC("general", sLl, permOk, cBsp)], WABA);
check("caso real 23:34: disponible, dice que el ERP no puede comprobar el pago", vBsp.codigo === "disponible" && /no puede comprobar el método de pago/.test(vBsp.texto) && /proveedor BSP/.test(vBsp.texto), vBsp);
check("caso real 23:34: no afirma que falte ni que esté", !/ningún método de pago|no es un tema de pago/.test(vBsp.texto), vBsp);
check("caso real 23:34: sigue mandando al soporte con el fbtrace", /fbtrace_id/.test(vBsp.texto), vBsp);
const vBspCon = veredictoSalud([LC("propio", sLl, permOk, cBsp), LC("general", sLl, permOk, cCon)], WABA);
check("un token lee la cuenta con método: manda esa lectura", /no es un tema de pago/.test(vBspCon.texto) && !/proveedor BSP/.test(vBspCon.texto), vBspCon);

// ── 3d. Barrido ───────────────────────────────────────────────────────────────
const saludes = [s0, s1, s2, s3, s4, sReal, sLl, null];
const permisos = [permOk, permNo, inv, sinDatos, null];
const numeros: (NumeroLeido | null)[] = [nOk, nFuera, nFlag, nErr, null];
const cuentasB: (CuentaLeida | null)[] = [cSin, cCon, cErr, cBsp, null];
let combinaciones = 0;
for (const a of saludes) for (const b of saludes) for (const pa of permisos) for (const pb of permisos) for (const na of numeros) for (const ca of cuentasB) {
  combinaciones++;
  const v = veredictoSalud([{ cual: "propio", salud: a, permisos: pa, numero: na, cuenta: ca }, LN("general", b, pb, nOk)], WABA);
  if (/no es un tema de pago/.test(v.texto)) check("barrido: «no es un tema de pago» solo con la cuenta leída CON método", ca?.metodoPago === true, { ca, v });
  if (ca?.metodoPago === false) check("barrido: la cuenta sin método de pago siempre es el veredicto pago", v.codigo === "pago" && /ningún método de pago/.test(v.texto), { ca, v });
  check("barrido: nunca se dice que no hay problema de pago sin la cuenta", !/ningún problema de pago/.test(v.texto), v);
  if (/proveedor BSP/.test(v.texto)) check("barrido: «solo BSP» solo con esa respuesta de Meta y sin otra cuenta leída", cuentaSoloParaBsp(ca), { ca, v });
  const relevantes = [...(a?.bloqueos ?? []), ...(b?.bloqueos ?? [])].filter((x) => !esDeLlamadas(x));
  const leyoAvailable = a?.nivel === "AVAILABLE" || b?.nivel === "AVAILABLE";
  const limitadoPorLlamadas = [a, b].some((x) => x?.nivel === "LIMITED" && x.bloqueos.length > 0 && x.bloqueos.every(esDeLlamadas));
  if (v.codigo === "disponible")
    check("barrido: disponible solo con AVAILABLE o con un LIMITED de llamadas", (leyoAvailable || limitadoPorLlamadas) && relevantes.length === 0, { a, b, v });
  for (const x of relevantes)
    if (x.codigo != null) check("barrido: todo lo que Meta marca (salvo llamadas) se nombra", v.texto.includes(String(x.codigo)), { x, v });
  check("barrido: nunca se habla de SIP en el veredicto", !/\bSIP\b|138024|138025/.test(v.texto), v);
  check("barrido: con un bloqueo relevante nunca es disponible ni no_se_sabe", !relevantes.length || (v.codigo !== "disponible" && v.codigo !== "no_se_sabe"), { a, b, v });
  check("barrido: el texto nunca está vacío", v.texto.length > 10);
}
check("barrido: corrió", combinaciones === 40000);

// ── 4. Lo que ve el operador ──────────────────────────────────────────────────
const bruto = `(#131005) Access denied (también con el token general)${MARCA_META_DICE}${v1.texto}`;
const e = explicarErrorEnvioWhatsApp(bruto);
check("explicar: el diagnóstico va delante", e.startsWith("Meta rechazó el envío por este número. Meta bloquea el envío por un tema de PAGO"), e);
check("explicar: conserva el código de Meta", e.includes("(#131005) Access denied"), e);
check("explicar sin diagnóstico: el texto de siempre", /permisos/.test(explicarErrorEnvioWhatsApp("(#131005) Access denied")));
const conTraza = explicarErrorEnvioWhatsApp(`(#131005) Access denied (también con el token general) [fbtrace_id AbC123]${MARCA_META_DICE}${vReal.texto}`);
check("explicar: el fbtrace_id queda con el código de Meta", conTraza.endsWith("[fbtrace_id AbC123])") && conTraza.startsWith("Meta rechazó el envío por este número. Lo único que Meta marca"), conTraza);

// ── 5. Ningún token sale del servidor ─────────────────────────────────────────
const datos = readFileSync(new URL("../lib/meta-salud-datos.ts", import.meta.url), "utf8");
check("datos: lo guardado no lleva tokens", /lecturas\s*\}/.test(datos) && !/valor: JSON\.stringify\([^)]*token/.test(datos));
check("datos: las lecturas no incluyen el token", !/return \{\s*cual,\s*token/.test(datos));
const meta = readFileSync(new URL("../lib/crm-meta.ts", import.meta.url), "utf8");
check("crm-meta: diagnostica solo ante un rechazo por permisos", /if \(r\.porPermiso\)\s*\{[\s\S]*diagnosticarEnvio/.test(meta));
check("crm-meta: el fbtrace_id va antes de la marca", /\$\{r\.mensaje\}\$\{traza\}\$\{MARCA_META_DICE\}/.test(meta));
check("datos: el estado del número va en una petición aparte de health_status", /fields=health_status`/.test(datos) && /fields=status,name_status/.test(datos));
check("datos: se lee el método de pago de la cuenta, en su propia petición", /\$\{encodeURIComponent\(wabaId\)\}\?fields=id,currency,primary_funding_id/.test(datos) && /cuenta: w \? leerCuenta/.test(datos));

console.log(`\n${ok} bien · ${mal} mal`);
if (mal) process.exit(1);
