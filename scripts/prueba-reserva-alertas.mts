// npx tsx scripts/prueba-reserva-alertas.mts
// Las alertas de la reserva de traslados (lib/traslados/reserva-alertas.ts), sin base ni red. Fija:
//  · «sin confirmar»: aviso ⟺ (por confirmar | pago reportado) ∧ (plazo + umbral vencido ∨ urgente);
//    el escalón ⟺ el servicio a menos de la mitad del margen; nada en los otros estados; con el
//    tiempo una alerta nunca desaparece; a lo largo de un día simulado, un aviso por PLAZO y un
//    escalón por solicitud, nunca un aviso después del escalón; un plazo nuevo vuelve a avisar;
//  · «devolución pendiente»: la MISMA cuenta que `queFalta` (pendiente ∨ en espera ⟺ queFalta pide
//    registrar la devolución) sobre un barrido; sin poder leer los pagos no se afirma nada;
//  · el auto-vencimiento: solo «esperando pago», con un motivo, sin ningún pago ni comprobante y sin
//    reserva; una lectura fallida nunca cierra; y el corolario (el barrido sí cierra);
//  · los cuatro parámetros: una línea, nunca vacíos, con tope, sin datos de la empresa escritos.
import { readFileSync } from "node:fs";
import {
  CLAVE_DEVOLUCION, CLAVE_SIN_CONFIRMAR, DIAS_DEVOLUCION_LEIDOS, duracionLarga, enlaceTesoreria, fechaHoraServicio,
  fechaReclamo, inicioServicioMs, juzgarDevolucion, juzgarSinConfirmar, juzgarVencimiento, notaConCierre, notaVencida,
  paramsDevolucion, paramsSinConfirmar,
  type CotizacionAlerta, type HechosSolicitud, type SolicitudAlerta,
} from "../lib/traslados/reserva-alertas";
import { ESTADOS_SOLICITUD, queFalta, type EstadoSolicitud, type PagoSolicitud } from "../lib/traslados/reserva-pago";
import { limaAUtcMs } from "../lib/alertas-horario";
import { VIA_DE_ALERTA, leeElDirectorio } from "../lib/alertas-modo-tiempo";
import { TARJETAS, UMBRAL_DEFECTO } from "../lib/alertas-tarjeta";
import { cerrarSolicitudVencida, leerHechosAlertasReserva } from "../lib/traslados/reserva-alertas-datos";

let ok = 0, mal = 0;
const fallas: string[] = [];
const t = (n: string, c: boolean, extra = "") => { if (c) ok++; else { mal++; if (fallas.length < 40) fallas.push(extra ? `${n} — ${extra}` : n); } };

const MIN = 60_000, H = 60 * MIN;
// 22-10-2026 10:00 en Lima.
const AHORA = limaAUtcMs("2026-10-22", "10:00")!;
const HOY = "2026-10-22";

const cot = (x: Partial<CotizacionAlerta> = {}): CotizacionAlerta => ({
  id: 736, numero_cotizacion: "COT-2026-000736", fecha_servicio: "2026-10-23", hora_ida: "15:00", moneda: "PEN",
  validez_hasta: "2026-11-20", cliente: "Lucía Pérez", ...x,
});
const sol = (x: Partial<SolicitudAlerta> = {}): SolicitudAlerta => ({
  id: 41, estado: "por_confirmar", cotizacion_id: 736, crm_conversacion_id: "a1b2c3d4-0000-4000-8000-000000000001",
  crm_accion_id: null, confirmar_antes_de: null, urgente: false, devolucion_pct: null, reserva_id: null,
  cancelacion_pedida_en: null, cerrada_en: null, actualizada_en: "2026-10-21T15:00:00.000Z", creada_en: "2026-10-21T15:00:00.000Z",
  nota: null, ...x,
});
const hechos = (s: Partial<SolicitudAlerta> = {}, c: Partial<CotizacionAlerta> | null = {}, pagos: PagoSolicitud[] | null = [], comprobantes: number | null = 0): HechosSolicitud =>
  ({ solicitud: sol(s), cotizacion: c === null ? null : cot(c), pagos, comprobantes });
const iso = (ms: number) => new Date(ms).toISOString();

const paramMetaOk = (ps: string[]) => ps.length === 4 && ps.every((p) => p.trim() !== "" && !/[\n\r\t]/.test(p) && !/ {4}/.test(p));

// ── 0. Las claves están dadas de alta donde viven las demás ──────────────────
{
  for (const k of [CLAVE_SIN_CONFIRMAR, CLAVE_DEVOLUCION]) {
    t(`${k}: vía ignora_modo`, VIA_DE_ALERTA[k] === "ignora_modo");
    t(`${k}: le escribe al directorio`, leeElDirectorio(k) === true);
    t(`${k}: tiene ficha de tarjeta`, !!TARJETAS[k]);
  }
  t("umbrales por defecto 0 min y 48 h", UMBRAL_DEFECTO.reserva_sin_confirmar === 0 && UMBRAL_DEFECTO.devolucion_pendiente === 48);
  const tick = readFileSync(new URL("../app/api/alertas-flota/tick/route.ts", import.meta.url), "utf8");
  t("el tick decide con el motor (no con una copia)", /juzgarSinConfirmar\(/.test(tick) && /juzgarDevolucion\(/.test(tick) && /juzgarVencimiento\(/.test(tick));
  t("el tick reclama con la fecha en que nació la solicitud", (tick.match(/fechaReclamo\(h\.solicitud, hoy\)/g) ?? []).length === 2);
  t("el tick lee el margen de Ajustes de traslados con plazosDe", /plazosDe\(normalizarConfigReserva\(/.test(tick));
}

// ── 1. Sin confirmar: los casos ──────────────────────────────────────────────
{
  const M = 360, U = 0;
  const j = (h: HechosSolicitud, x: Partial<{ ahoraMs: number; umbralMin: number; margenMin: number }> = {}) =>
    juzgarSinConfirmar(h, { ahoraMs: AHORA, umbralMin: U, margenMin: M, ...x });
  const plazo = AHORA - 35 * MIN; // venció hace 35 min (09:25)
  const d1 = j(hechos({ estado: "pago_reportado", confirmar_antes_de: iso(plazo) }));
  t("pago reportado con el plazo vencido → aviso", d1.codigo === "aviso" && d1.vencida && d1.ref === "sol:41:aviso:202610220925", JSON.stringify(d1));
  t("…con 30 min de tolerancia, todavía avisa (35 > 30)", j(hechos({ estado: "pago_reportado", confirmar_antes_de: iso(plazo) }), { umbralMin: 30 }).codigo === "aviso");
  t("…con 40 min de tolerancia, no (en plazo)", j(hechos({ estado: "pago_reportado", confirmar_antes_de: iso(plazo) }), { umbralMin: 40 }).codigo === "en_plazo");
  t("plazo futuro → en plazo, sin ref", (() => { const d = j(hechos({ confirmar_antes_de: iso(AHORA + H) })); return d.codigo === "en_plazo" && d.ref === null; })());
  t("urgente sin plazo → aviso con ref «sin_plazo»", j(hechos({ urgente: true })).ref === "sol:41:aviso:sin_plazo");
  const urg = j(hechos({ urgente: true, confirmar_antes_de: iso(AHORA + 20 * MIN) }));
  const urgDespues = j(hechos({ urgente: true, confirmar_antes_de: iso(AHORA + 20 * MIN) }), { ahoraMs: AHORA + 30 * MIN });
  t("urgente con plazo: la misma ref antes y después de vencer (no se repite)", urg.codigo === "aviso" && urg.ref === urgDespues.ref && urgDespues.vencida);
  t("un plazo NUEVO es otra ref (vuelve a avisar)",
    j(hechos({ confirmar_antes_de: iso(plazo) })).ref !== j(hechos({ confirmar_antes_de: iso(plazo - 2 * H) })).ref);
  // Servicio mañana 15:00 = a 29 h: lejos de M/2 = 3 h.
  const cerca = (h: number) => cot({ fecha_servicio: "2026-10-22", hora_ida: `${String(10 + h).padStart(2, "0")}:00` });
  const dm = juzgarSinConfirmar({ ...hechos({ confirmar_antes_de: iso(plazo) }), cotizacion: cerca(2) }, { ahoraMs: AHORA, umbralMin: 0, margenMin: M });
  t("servicio a 2 h (< M/2 = 3 h) → escalón del margen, que reclama también el aviso", dm.codigo === "margen" && dm.ref === "sol:41:margen" && dm.refsExtra.length === 1 && dm.refsExtra[0] === d1.ref, JSON.stringify(dm));
  const dm2 = juzgarSinConfirmar({ ...hechos({ confirmar_antes_de: null }), cotizacion: cerca(2) }, { ahoraMs: AHORA, umbralMin: 0, margenMin: M });
  t("sin plazo (sin horario) y servicio cerca → escalón, sin aviso extra", dm2.codigo === "margen" && dm2.refsExtra.length === 0);
  t("sin plazo y servicio lejos → nada que juzgar", j(hechos({})).codigo === "sin_plazo");
  t("servicio a 4 h (> M/2) → no hay escalón", juzgarSinConfirmar({ ...hechos({ confirmar_antes_de: iso(plazo) }), cotizacion: cerca(4) }, { ahoraMs: AHORA, umbralMin: 0, margenMin: M }).codigo === "aviso");
  t("con M = 0 el escalón es solo cuando el servicio ya empezó",
    juzgarSinConfirmar({ ...hechos({}), cotizacion: cerca(1) }, { ahoraMs: AHORA, umbralMin: 0, margenMin: 0 }).codigo === "sin_plazo"
    && juzgarSinConfirmar({ ...hechos({}), cotizacion: cerca(0) }, { ahoraMs: AHORA + MIN, umbralMin: 0, margenMin: 0 }).codigo === "margen");
  for (const e of ESTADOS_SOLICITUD.filter((x) => x !== "por_confirmar" && x !== "pago_reportado")) {
    t(`${e}: nunca avisa «sin confirmar»`, j(hechos({ estado: e, urgente: true, confirmar_antes_de: iso(plazo) })).codigo === "no_aplica");
  }
  // Los textos.
  const p = paramsSinConfirmar(hechos({ estado: "pago_reportado", confirmar_antes_de: iso(plazo) }), d1, { ahoraMs: AHORA, appUrl: "https://erp.ejemplo.pe/" });
  t("aviso: 4 parámetros válidos para Meta", paramMetaOk(p), JSON.stringify(p));
  t("aviso: título, cliente y cotización con su servicio", p[0] === "Reserva de traslado sin confirmar" && p[1] === "Lucía Pérez" && p[2] === "Cotización N° COT-2026-000736 · servicio 23/10/2026 15:00", p.join(" | "));
  t("aviso: dice el estado, cuánto venció, cuánto falta y el enlace a /crm",
    /reportó su pago/.test(p[3]) && /venció hace 35 min \(22\/10 09:25\)/.test(p[3]) && /Faltan 1 día y 5 h para el servicio/.test(p[3])
    && p[3].includes("https://erp.ejemplo.pe/crm?conv=a1b2c3d4-0000-4000-8000-000000000001"), p[3]);
  const sinUrl = paramsSinConfirmar(hechos({ confirmar_antes_de: iso(plazo) }), d1, { ahoraMs: AHORA, appUrl: "javascript:alert(1)" });
  t("sin una URL http(s) no hay enlace (y lo dice)", !/javascript|http/.test(sinUrl[3]) && /Atiéndela en el CRM/.test(sinUrl[3]), sinUrl[3]);
  t("por confirmar: dice que falta confirmar la unidad", /Falta confirmar si hay una unidad/.test(sinUrl[3]));
  const canc = paramsSinConfirmar(hechos({ estado: "pago_reportado", cancelacion_pedida_en: iso(AHORA - H) }), d1, { ahoraMs: AHORA });
  t("con cancelación pedida: dice que falta resolverla", /pidió cancelar/.test(canc[3]));
  const pu = paramsSinConfirmar(hechos({ urgente: true }), j(hechos({ urgente: true })), { ahoraMs: AHORA });
  t("urgente sin vencer: título «urgente»", pu[0] === "Reserva de traslado urgente" && /Urgente/.test(pu[3]));
  const pm = paramsSinConfirmar({ ...hechos({ confirmar_antes_de: iso(plazo) }), cotizacion: cerca(2) }, dm, { ahoraMs: AHORA });
  t("escalón: título «a poco del servicio» y faltan 2 h", pm[0] === "Reserva sin confirmar a poco del servicio" && /Faltan 2 h para el servicio/.test(pm[3]), pm.join(" | "));
  const pasado = juzgarSinConfirmar({ ...hechos({}), cotizacion: cerca(0) }, { ahoraMs: AHORA + 30 * MIN, umbralMin: 0, margenMin: M });
  const pp = paramsSinConfirmar({ ...hechos({}), cotizacion: cerca(0) }, pasado, { ahoraMs: AHORA + 30 * MIN });
  t("escalón con la hora ya pasada: lo dice", pp[0].includes("ya pasó") && /pasó hace 30 min/.test(pp[3]), pp.join(" | "));
  const raro = paramsSinConfirmar(hechos({}, { cliente: "Juan\n\tPérez     🚌" + "x".repeat(200), numero_cotizacion: null }), d1, { ahoraMs: AHORA });
  t("un nombre con saltos, tabulaciones, espacios y largo: una línea con tope", paramMetaOk(raro) && Array.from(raro[1]).length <= 60 && raro[1].startsWith("Juan Pérez 🚌"), raro[1]);
  t("sin número de cotización, su id", raro[2].startsWith("Cotización id 736"));
  t("sin cotización legible: «sin fecha» y «Cliente sin nombre»",
    (() => { const q = paramsSinConfirmar(hechos({}, null), d1, { ahoraMs: AHORA }); return paramMetaOk(q) && q[1] === "Cliente sin nombre" && /sin fecha/.test(q[2]); })());
}

// ── 2. Sin confirmar: el barrido ─────────────────────────────────────────────
{
  let casos = 0, avisos = 0, margenes = 0, enPlazo = 0;
  const malos: string[] = [];
  const PLAZOS = [null, -300, -61, -60, -59, -1, 0, 1, 30, 600];   // minutos respecto de ahora
  const INICIOS = [null, -120, -1, 0, 1, 89, 90, 91, 179, 180, 181, 600, 3000]; // minutos
  for (const estado of ESTADOS_SOLICITUD) for (const p of PLAZOS) for (const urgente of [true, false])
  for (const ini of INICIOS) for (const umbralMin of [0, 60]) for (const margenMin of [0, 180, 360]) {
    const c = ini == null ? cot({ hora_ida: null }) : (() => { const ms = AHORA + ini * MIN; const f = new Date(ms - 5 * H).toISOString(); return cot({ fecha_servicio: f.slice(0, 10), hora_ida: f.slice(11, 16) }); })();
    const h: HechosSolicitud = { solicitud: sol({ estado, urgente, confirmar_antes_de: p == null ? null : iso(AHORA + p * MIN) }), cotizacion: c, pagos: [], comprobantes: 0 };
    const d = juzgarSinConfirmar(h, { ahoraMs: AHORA, umbralMin, margenMin });
    casos++;
    const espera = estado === "por_confirmar" || estado === "pago_reportado";
    const vencida = p != null && AHORA >= AHORA + p * MIN + umbralMin * MIN;
    const cerca = ini != null && ini * MIN < (margenMin / 2) * MIN;
    const oraculo = !espera ? "no_aplica" : cerca ? "margen" : (vencida || urgente) ? "aviso" : p != null ? "en_plazo" : "sin_plazo";
    if (d.codigo !== oraculo) malos.push(`${estado}/${p}/${urgente}/${ini}/${umbralMin}/${margenMin}: ${d.codigo} ≠ ${oraculo}`);
    if ((d.ref != null) !== (d.codigo === "aviso" || d.codigo === "margen")) malos.push(`ref ⟺ aviso|margen: ${JSON.stringify(d)}`);
    if (d.codigo === "margen" && (d.refsExtra.length > 0) !== (vencida || urgente)) malos.push(`margen reclama el aviso ⟺ vencida ∨ urgente: ${JSON.stringify(d)}`);
    if (d.codigo !== "margen" && d.refsExtra.length) malos.push("refs extra fuera del escalón");
    if (d.ref) {
      const ps = paramsSinConfirmar(h, d, { ahoraMs: AHORA, appUrl: "https://erp.ejemplo.pe" });
      if (!paramMetaOk(ps) || ps[3].length > 520 || ps[0].length > 70) malos.push(`parámetros: ${JSON.stringify(ps)}`);
      // Monotonía: más tarde, la alerta no desaparece.
      const despues = juzgarSinConfirmar(h, { ahoraMs: AHORA + 45 * MIN, umbralMin, margenMin });
      if (!despues.ref) malos.push(`la alerta desaparece con el tiempo: ${estado}/${p}/${ini}`);
    }
    if (d.codigo === "aviso") avisos++;
    if (d.codigo === "margen") margenes++;
    if (d.codigo === "en_plazo") enPlazo++;
  }
  t(`${casos} combinaciones: el código es el del oráculo; ref ⟺ aviso ∨ escalón; el escalón reclama el aviso ⟺ vencida ∨ urgente; nunca desaparece`, malos.length === 0, malos.slice(0, 4).join(" | "));
  t("corolario: el barrido produce avisos, escalones y solicitudes en plazo", avisos > 0 && margenes > 0 && enPlazo > 0, `${avisos}/${margenes}/${enPlazo}`);
}

// ── 3. Sin confirmar: un día simulado con el protocolo del tick ──────────────
{
  // Lo que hace `avisarReserva` del tick: reclama la ref principal; si ya estaba, no envía; si no,
  // reclama además las extra. El conjunto simula `alerta_enviada` (clave + ref + fecha fija).
  const simular = (plazos: (number | null)[], urgente: boolean, iniMin: number) => {
    const reclamadas = new Set<string>();
    const enviados: string[] = [];
    const c = (() => { const ms = AHORA + iniMin * MIN; const f = new Date(ms - 5 * H).toISOString(); return cot({ fecha_servicio: f.slice(0, 10), hora_ida: f.slice(11, 16) }); })();
    for (let m = 0; m <= 24 * 60; m += 10) {
      const plazo = plazos[Math.min(plazos.length - 1, Math.floor(m / (24 * 60 / plazos.length)))];
      const h: HechosSolicitud = { solicitud: sol({ estado: "pago_reportado", urgente, confirmar_antes_de: plazo == null ? null : iso(AHORA + plazo * MIN) }), cotizacion: c, pagos: [], comprobantes: 0 };
      const d = juzgarSinConfirmar(h, { ahoraMs: AHORA + m * MIN, umbralMin: 0, margenMin: 360 });
      if (!d.ref || reclamadas.has(d.ref)) continue;
      reclamadas.add(d.ref);
      for (const r of d.refsExtra) reclamadas.add(r);
      enviados.push(d.codigo);
    }
    return enviados;
  };
  const a = simular([60], false, 20 * 60);   // plazo a la hora, servicio a 20 h
  t("un plazo que vence y el servicio que se acerca: aviso y después el escalón, una vez cada uno", a.join(",") === "aviso,margen", a.join(","));
  const b = simular([600], false, 8 * 60);  // plazo tras el escalón
  t("el escalón llega primero: no sale después un «venció hace…»", b.join(",") === "margen", b.join(","));
  const c = simular([30, 300], false, 22 * 60); // pidió otro comprobante: plazo nuevo
  t("un plazo nuevo (otro comprobante) vuelve a avisar", c.join(",") === "aviso,aviso,margen", c.join(","));
  const d = simular([null], true, 22 * 60);
  t("urgente sin plazo: un aviso y el escalón", d.join(",") === "aviso,margen", d.join(","));
  t("la fecha del reclamo es la del día en que nació la solicitud (Lima), no la de hoy",
    fechaReclamo({ creada_en: "2026-10-21T03:30:00.000Z" }, HOY) === "2026-10-20" && fechaReclamo({ creada_en: null }, HOY) === HOY);
}

// ── 4. Devolución pendiente ──────────────────────────────────────────────────
{
  const cobro = (monto: number, extra: Partial<PagoSolicitud> = {}): PagoSolicitud => ({ sentido: "cobro", monto, moneda: "PEN", anulado: false, ...extra });
  const devol = (monto: number, extra: Partial<PagoSolicitud> = {}): PagoSolicitud => ({ sentido: "pago", monto, moneda: "PEN", anulado: false, ...extra });
  const j = (h: HechosSolicitud, umbralH = 48, ahoraMs = AHORA) => juzgarDevolucion(h, { ahoraMs, umbralH });
  const cerrada = (horas: number) => iso(AHORA - horas * H);
  const su = (pagos: PagoSolicitud[] | null, horas = 49, x: Partial<SolicitudAlerta> = {}) => hechos({ estado: "sin_unidad", cerrada_en: cerrada(horas), ...x }, {}, pagos);
  const d = j(su([cobro(150)]));
  t("sin unidad, cobró 150, nada devuelto, 49 h → pendiente por S/ 150", d.codigo === "pendiente" && d.ref === "sol:41:devolucion" && d.falta === 150 && d.aDevolver === 150, JSON.stringify(d));
  t("…47 h → en espera", j(su([cobro(150)], 47)).codigo === "en_espera");
  t("…con umbral 24 h, a las 25 h ya avisa", j(su([cobro(150)], 25), 24).codigo === "pendiente");
  t("sin unidad es el 100 % aunque la fila diga otro %", j(su([cobro(150)], 49, { devolucion_pct: 30 })).aDevolver === 150);
  t("devuelto completo → saldada", j(su([cobro(150), devol(150)])).codigo === "saldada");
  t("medio céntimo de tolerancia (la de queFalta)", j(su([cobro(150), devol(149.996)])).codigo === "saldada" && j(su([cobro(150), devol(149.99)])).codigo === "pendiente");
  t("una devolución anulada no cuenta como devuelta", j(su([cobro(150), devol(150, { anulado: true })])).codigo === "pendiente");
  t("un cobro anulado no suma a lo cobrado", j(su([cobro(150, { anulado: true })])).codigo === "sin_devolucion");
  t("una devolución nunca suma como cobro", j(su([devol(80)])).codigo === "sin_devolucion");
  t("otra moneda no cuenta", j(su([cobro(150, { moneda: "USD" })])).codigo === "sin_devolucion");
  const can = (pct: number | null, pagos: PagoSolicitud[]) => hechos({ estado: "cancelada", devolucion_pct: pct, cerrada_en: cerrada(50) }, {}, pagos);
  t("cancelada con 90 %: pendiente por S/ 90 de 100", (() => { const x = j(can(90, [cobro(100)])); return x.codigo === "pendiente" && x.aDevolver === 90 && x.falta === 90; })());
  t("cancelada con 90 % y 90 devueltos: saldada", j(can(90, [cobro(100), devol(90)])).codigo === "saldada");
  t("cancelada sin % decidido: falta resolverla (no es de Tesorería)", j(can(null, [cobro(100)])).codigo === "sin_decidir");
  t("cancelada con 0 %: nada que devolver", j(can(0, [cobro(100)])).codigo === "sin_devolucion");
  t("sin poder leer los pagos no se afirma nada", j(su(null)).codigo === "sin_lectura");
  t("sin poder leer la cotización (la moneda), tampoco", juzgarDevolucion({ ...su([cobro(150)]), cotizacion: null }, { ahoraMs: AHORA, umbralH: 48 }).codigo === "sin_lectura");
  t("en dólares cuenta los dólares", juzgarDevolucion({ ...su([cobro(40, { moneda: "USD" }), cobro(150)]), cotizacion: cot({ moneda: "USD" }) }, { ahoraMs: AHORA, umbralH: 48 }).aDevolver === 40);
  t("sin cerrada_en, desde actualizada_en", j(hechos({ estado: "sin_unidad", cerrada_en: null, actualizada_en: cerrada(10) }, {}, [cobro(10)])).codigo === "en_espera");
  for (const e of ["esperando_pago", "por_confirmar", "pago_reportado", "confirmada", "completada"] as const) {
    t(`${e}: nunca «devolución pendiente»`, j(hechos({ estado: e, devolucion_pct: 100, cerrada_en: cerrada(100) }, {}, [cobro(100)])).codigo === "no_aplica");
  }
  // Textos.
  const pd = paramsDevolucion(su([cobro(150), devol(50)]), j(su([cobro(150), devol(50)])), { ahoraMs: AHORA, appUrl: "https://erp.ejemplo.pe" });
  t("devolución: 4 parámetros válidos", paramMetaOk(pd), JSON.stringify(pd));
  t("devolución: dice el acuerdo, lo devuelto, lo que falta, hace cuánto y el enlace a Tesorería",
    /No hubo unidad: se acordó devolver el 100 % de lo cobrado \(S\/ 150\.00\)/.test(pd[3]) && /Devuelto: S\/ 50\.00; falta S\/ 100\.00/.test(pd[3])
    && /hace 2 días y 1 h/.test(pd[3]) && pd[3].includes("https://erp.ejemplo.pe/tesoreria?tab=adelantos"), pd[3]);
  t("enlace a Tesorería solo con http(s)", enlaceTesoreria("ftp://x") === null && enlaceTesoreria(null) === null);
  const pc = paramsDevolucion(can(90, [cobro(100)]), j(can(90, [cobro(100)])), { ahoraMs: AHORA });
  t("cancelada: dice el % acordado", /Reserva cancelada: se acordó devolver el 90 %/.test(pc[3]) && /en Tesorería\.$/.test(pc[3]), pc[3]);
}

// ── 5. Devolución: la misma cuenta que queFalta (barrido) ────────────────────
{
  let casos = 0, pendientes = 0, saldadas = 0;
  const malos: string[] = [];
  const COBROS = [[], [100], [59.5], [100, 20], [100, 30]];
  const DEVS = [[], [50], [100], [119.995], [59.5], [30]];
  for (const estado of ["sin_unidad", "cancelada"] as EstadoSolicitud[]) for (const pct of [null, 0, 10, 50, 90, 100])
  for (const cs of COBROS) for (const ds of DEVS) for (const anuladoDev of [false, true]) {
    const pagos: PagoSolicitud[] = [
      ...cs.map((m) => ({ sentido: "cobro", monto: m, moneda: "PEN", anulado: false })),
      ...ds.map((m) => ({ sentido: "pago", monto: m, moneda: "PEN", anulado: anuladoDev })),
    ];
    const h = hechos({ estado, devolucion_pct: pct, cerrada_en: iso(AHORA - 100 * H) }, {}, pagos);
    const d = juzgarDevolucion(h, { ahoraMs: AHORA, umbralH: 48 });
    const cobrado = cs.reduce((a, b) => a + b, 0), devuelto = anuladoDev ? 0 : ds.reduce((a, b) => a + b, 0);
    const qf = queFalta({ estado, adelanto_pct: 50, devolucion_pct: pct }, { cobrado, devuelto, adelanto: 50, reserva: null, confirmacionEnviada: false, cargo: { id: 1, numero: "F001-1" } });
    const pideDevolver = qf.some((q) => q.codigo === "registrar_devolucion");
    const motorPide = d.codigo === "pendiente" || d.codigo === "en_espera";
    casos++;
    if (pideDevolver !== motorPide) malos.push(`${estado}/${pct}/${cs}/${ds}/${anuladoDev}: motor ${d.codigo} vs queFalta ${pideDevolver}`);
    if (d.codigo === "pendiente") {
      pendientes++;
      const det = qf.find((q) => q.codigo === "registrar_devolucion")!.detalle;
      if (!det.includes(`S/ ${d.falta.toFixed(2)}`)) malos.push(`la falta no es la de queFalta: ${d.falta} vs «${det}»`);
      if (!paramMetaOk(paramsDevolucion(h, d, { ahoraMs: AHORA }))) malos.push("parámetros");
    }
    if (d.codigo === "saldada") saldadas++;
  }
  t(`${casos} combinaciones: devolución pendiente ⟺ queFalta pide registrarla, y por el mismo monto`, malos.length === 0, malos.slice(0, 4).join(" | "));
  t("corolario: el barrido produce pendientes y saldadas", pendientes > 0 && saldadas > 0, `${pendientes}/${saldadas}`);
}

// ── 6. El auto-vencimiento ───────────────────────────────────────────────────
{
  const j = (h: HechosSolicitud, ahoraMs = AHORA) => juzgarVencimiento(h, { ahoraMs, hoy: HOY });
  const ep = (c: Partial<CotizacionAlerta> | null = {}, pagos: PagoSolicitud[] | null = [], comps: number | null = 0, x: Partial<SolicitudAlerta> = {}) =>
    hechos({ estado: "esperando_pago", ...x }, c, pagos, comps);
  t("vigente: nada", j(ep()).codigo === "vigente");
  const v1 = j(ep({ validez_hasta: "2026-10-21" }));
  t("la cotización venció ayer → se cierra", v1.codigo === "vencer" && v1.motivos.join() === "cotizacion_vencida", JSON.stringify(v1));
  t("vence HOY: todavía vale (la regla de elegibilidadDeReserva: validez < hoy)", j(ep({ validez_hasta: HOY })).codigo === "vigente");
  const v2 = j(ep({ fecha_servicio: HOY, hora_ida: "09:30" }));
  t("el servicio de hoy a las 09:30 ya pasó → se cierra", v2.codigo === "vencer" && v2.motivos.join() === "servicio_pasado");
  t("hoy a las 10:30, todavía no", j(ep({ fecha_servicio: HOY, hora_ida: "10:30" })).codigo === "vigente");
  t("sin hora: solo un día anterior cuenta como pasado",
    j(ep({ fecha_servicio: "2026-10-21", hora_ida: null })).codigo === "vencer" && j(ep({ fecha_servicio: HOY, hora_ida: null })).codigo === "vigente");
  t("los dos motivos a la vez", j(ep({ validez_hasta: "2026-10-01", fecha_servicio: "2026-10-05" })).motivos.join() === "cotizacion_vencida,servicio_pasado");
  const vencida = { validez_hasta: "2026-10-01" };
  t("con un cobro → no se toca (lo resuelve una persona)", j(ep(vencida, [{ sentido: "cobro", monto: 50, moneda: "PEN", anulado: false }])).codigo === "con_dinero");
  t("con un cobro anulado → se cierra", j(ep(vencida, [{ sentido: "cobro", monto: 50, moneda: "PEN", anulado: true }])).codigo === "vencer");
  t("con un comprobante reportado → no se toca", j(ep(vencida, [], 1)).codigo === "con_dinero");
  t("con un movimiento en otra moneda → no se toca", j(ep(vencida, [{ sentido: "cobro", monto: 5, moneda: "USD", anulado: false }])).codigo === "con_dinero");
  t("con una reserva creada → no se toca", j(ep(vencida, [], 0, { reserva_id: 9 })).codigo === "con_reserva");
  t("sin poder leer pagos, comprobantes o la cotización → no se cierra",
    j(ep(vencida, null)).codigo === "sin_lectura" && j(ep(vencida, [], null)).codigo === "sin_lectura" && j(ep(null)).codigo === "sin_lectura");
  for (const e of ESTADOS_SOLICITUD.filter((x) => x !== "esperando_pago")) {
    t(`${e}: el tick nunca la cierra`, j(hechos({ estado: e }, vencida)).codigo === "no_aplica");
  }
  const nota = notaVencida(ep(vencida), ["cotizacion_vencida"]);
  t("la nota dice por qué y que no se le escribió al cliente",
    /la cotización N° COT-2026-000736 venció el 01\/10\/2026/.test(nota) && /No se le escribió al cliente/.test(nota) && !/\n/.test(nota), nota);
  t("la nota del servicio pasado dice su fecha y hora", /la hora del servicio \(23\/10\/2026 15:00\) ya pasó/.test(notaVencida(ep(), ["servicio_pasado"])));
  t("la nota se agrega a la que ya había, sin pasar los 2000 caracteres",
    notaConCierre("previa", "cierre") === "previa\ncierre" && notaConCierre(null, "cierre") === "cierre"
    && Array.from(notaConCierre("x".repeat(3000), "cierre")).length === 2000 && notaConCierre("x".repeat(3000), "cierre").endsWith("cierre"));

  // Barrido: vencer ⇒ esperando pago ∧ con motivo ∧ sin dinero ∧ sin reserva; corolario.
  let casos = 0, cierres = 0;
  const malos: string[] = [];
  for (const estado of ESTADOS_SOLICITUD) for (const validez of [null, "2026-10-01", HOY, "2026-12-01"])
  for (const fecha of [null, "2026-10-21", HOY, "2026-10-23"]) for (const hora of [null, "09:00", "11:00"])
  for (const pagos of [null, [], [{ sentido: "cobro", monto: 1, moneda: "PEN", anulado: false }], [{ sentido: "pago", monto: 1, moneda: "PEN", anulado: true }]] as (PagoSolicitud[] | null)[])
  for (const comps of [null, 0, 2]) for (const reserva of [null, 5]) {
    const h = hechos({ estado, reserva_id: reserva }, { validez_hasta: validez, fecha_servicio: fecha, hora_ida: hora }, pagos, comps);
    const v = juzgarVencimiento(h, { ahoraMs: AHORA, hoy: HOY });
    casos++;
    if (v.codigo === "vencer") {
      cierres++;
      const sinDinero = pagos != null && pagos.every((p) => p.anulado === true) && comps === 0;
      if (estado !== "esperando_pago" || !v.motivos.length || !sinDinero || reserva != null) malos.push(`cierra de más: ${JSON.stringify({ estado, validez, fecha, hora, pagos, comps, reserva })}`);
    }
    // Lo vigente no se cierra nunca, falte lo que falte.
    const pasa = (validez != null && validez < HOY) || (fecha != null && (hora ? limaAUtcMs(fecha, hora)! <= AHORA : fecha < HOY));
    if (estado === "esperando_pago" && !pasa && v.codigo !== "vigente") malos.push(`no vigente sin motivo: ${JSON.stringify({ validez, fecha, hora, codigo: v.codigo })}`);
  }
  t(`${casos} combinaciones: solo se cierra «esperando pago» con un motivo, sin dinero ni reserva; lo vigente nunca`, malos.length === 0, malos.slice(0, 3).join(" | "));
  t("corolario: el barrido sí cierra", cierres > 0, String(cierres));
}

// ── 7. Utilidades y textos ───────────────────────────────────────────────────
{
  t("duraciones", duracionLarga(35) === "35 min" && duracionLarga(130) === "2 h 10 min" && duracionLarga(1440) === "1 día" && duracionLarga(3 * 1440 + 4 * 60 + 20) === "3 días y 4 h");
  t("fecha y hora del servicio", fechaHoraServicio(cot()) === "23/10/2026 15:00" && fechaHoraServicio(cot({ hora_ida: null })) === "23/10/2026" && fechaHoraServicio(null) === "sin fecha");
  t("inicio del servicio en hora de Lima", inicioServicioMs(cot()) === limaAUtcMs("2026-10-23", "15:00") && inicioServicioMs(cot({ hora_ida: "x" })) === null);
  t("lee 30 días de cerradas", DIAS_DEVOLUCION_LEIDOS === 30);
  // Sin datos de la empresa escritos en el módulo (este ERP se vende).
  const src = readFileSync(new URL("../lib/traslados/reserva-alertas.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  t("el módulo no escribe el nombre, el RUC ni el dominio de ninguna empresa", !/AFA|afatours|transportesafa|\b20\d{9}\b/i.test(src));
}

// ── 8. El lector y el cierre, contra una base falsa en memoria ───────────────
type Err = { code?: string; message: string } | null;
type Estado = { op: string; cols: string; filtros: ((r: Record<string, unknown>) => boolean)[]; rango: [number, number] | null; patch: unknown; devolver: boolean; uno: boolean };
/** Un PostgREST falso: select/in/eq/gte/order/range/update/insert/maybeSingle. `falla` decide un error por consulta. */
function baseFalsa(db: Record<string, Record<string, unknown>[]>, falla: (tabla: string, st: Estado) => Err = () => null) {
  const llamadas: string[] = [];
  return {
    llamadas,
    from(tabla: string) {
      const st: Estado = { op: "select", cols: "*", filtros: [], rango: null, patch: null, devolver: false, uno: false };
      const correr = () => {
        llamadas.push(`${st.op}:${tabla}`);
        const e = falla(tabla, st);
        if (e) return { data: null, error: e };
        const filas = db[tabla] ?? (db[tabla] = []);
        if (st.op === "insert") { filas.push({ ...(st.patch as object) }); return { data: null, error: null }; }
        let hit = filas.filter((r) => st.filtros.every((f) => f(r)));
        if (st.op === "update") { for (const r of hit) Object.assign(r, st.patch); return { data: st.devolver ? hit.map((r) => ({ id: r.id })) : null, error: null }; }
        hit = [...hit].sort((a, b) => Number(a.id) - Number(b.id));
        if (st.rango) hit = hit.slice(st.rango[0], st.rango[1] + 1);
        // Proyecta las columnas pedidas, como PostgREST (una columna soltada no vuelve).
        const cols = st.cols === "*" ? null : st.cols.split(",").map((c) => c.trim());
        const proy = (r: Record<string, unknown>) => (cols ? Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])) : { ...r });
        if (st.uno) return { data: hit[0] ? proy(hit[0]) : null, error: null };
        return { data: hit.map(proy), error: null };
      };
      const b: Record<string, unknown> = {
        select(cols?: string) { if (st.op === "select") st.cols = cols ?? "*"; else st.devolver = true; return b; },
        in(c: string, vs: unknown[]) { st.filtros.push((r) => vs.map(String).includes(String(r[c]))); return b; },
        eq(c: string, v: unknown) { st.filtros.push((r) => String(r[c]) === String(v)); return b; },
        gte(c: string, v: unknown) { st.filtros.push((r) => String(r[c]) >= String(v)); return b; },
        order() { return b; },
        range(a: number, z: number) { st.rango = [a, z]; return b; },
        update(p: unknown) { st.op = "update"; st.patch = p; return b; },
        insert(p: unknown) { st.op = "insert"; st.patch = p; return b; },
        maybeSingle() { st.uno = true; return b; },
        then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve(correr()).then(ok, ko); },
      };
      return b;
    },
  };
}
const filaSol = (id: number, x: Partial<SolicitudAlerta> = {}) => ({ ...sol({ id, ...x }) }) as unknown as Record<string, unknown>;
const filaCot = (id: number, x: Record<string, unknown> = {}) => ({
  id, numero_cotizacion: `COT-${id}`, fecha_servicio: "2026-10-23", hora_ida: "15:00", moneda: "PEN", cliente_id: null,
  atencion: "Atención Web", traslado_json: { validez_hasta: "2026-11-20" }, ...x,
});
{
  const SIN_TABLA: Err = { code: "PGRST205", message: "Could not find the table 'public.reserva_solicitudes' in the schema cache" };
  const opts = { ahoraMs: AHORA, sinConfirmar: true, devolucion: true };
  const r0 = await leerHechosAlertasReserva(baseFalsa({}, (t) => (t === "reserva_solicitudes" ? SIN_TABLA : null)), opts);
  t("sin la tabla (reservas-09a no corrida): sinTabla y nada más", r0.sinTabla && r0.hechos.length === 0);
  let lanza = false;
  try { await leerHechosAlertasReserva(baseFalsa({}, (t) => (t === "reserva_solicitudes" ? { code: "57014", message: "statement timeout" } : null)), opts); } catch { lanza = true; }
  t("otro error de la lista de solicitudes LANZA (no es «no hay ninguna»)", lanza);

  const db = (): Record<string, Record<string, unknown>[]> => ({
    reserva_solicitudes: [
      filaSol(1, { estado: "esperando_pago", cotizacion_id: 10, crm_accion_id: "acc-1", crm_conversacion_id: "conv-1", nota: "Nota del ejecutivo" }),
      filaSol(2, { estado: "pago_reportado", cotizacion_id: 11, confirmar_antes_de: iso(AHORA - H) }),
      filaSol(3, { estado: "cancelada", cotizacion_id: 12, devolucion_pct: 50, cerrada_en: iso(AHORA - 60 * H), actualizada_en: iso(AHORA - 60 * H) }),
      filaSol(4, { estado: "cancelada", cotizacion_id: 12, devolucion_pct: 50, actualizada_en: iso(AHORA - 40 * 86_400_000) }), // más vieja que 30 días
      filaSol(5, { estado: "completada", cotizacion_id: 12 }),
    ],
    cotizaciones: [
      filaCot(10, { traslado_json: { validez_hasta: "2026-10-01" } }),
      filaCot(11, { cliente_id: 77 }),
      filaCot(12),
    ],
    clientes: [{ id: 77, nombre: "Rosa Díaz", empresa: "Minera Andina SAC" }],
    pagos: [
      { id: 1, reserva_solicitud_id: 3, sentido: "cobro", monto: 200, moneda: "PEN", anulado: false },
      { id: 2, reserva_solicitud_id: 3, sentido: "pago", monto: 40, moneda: "PEN", anulado: false },
    ],
    reserva_solicitud_comprobantes: [{ id: 1, solicitud_id: 2 }],
    crm_acciones_ia: [{ id: "acc-1", estado: "pendiente", payload: { cotizacion_id: 10, resumen: "x" } }],
    crm_notas: [],
  });
  const d1 = db();
  const r1 = await leerHechosAlertasReserva(baseFalsa(d1), opts);
  const por = new Map(r1.hechos.map((h) => [h.solicitud.id, h]));
  t("lee las abiertas y las cerradas recientes; no las viejas ni las completadas", [...por.keys()].sort().join() === "1,2,3", [...por.keys()].join());
  t("el cliente del ERP manda sobre la atención", por.get(2)?.cotizacion?.cliente === "Minera Andina SAC" && por.get(1)?.cotizacion?.cliente === "Atención Web");
  t("la validez sale de traslado_json", por.get(1)?.cotizacion?.validez_hasta === "2026-10-01");
  t("pagos y comprobantes de cada una", por.get(3)?.pagos?.length === 2 && por.get(2)?.comprobantes === 1 && por.get(1)?.comprobantes === 0 && por.get(1)?.pagos?.length === 0);
  t("con la devolución apagada no se leen las cerradas", (await leerHechosAlertasReserva(baseFalsa(db()), { ...opts, devolucion: false })).hechos.every((h) => h.solicitud.estado !== "cancelada"));
  t("con «sin confirmar» apagada solo las que esperan el pago (el auto-vencimiento)",
    (await leerHechosAlertasReserva(baseFalsa(db()), { ...opts, sinConfirmar: false, devolucion: false })).hechos.map((h) => h.solicitud.estado).join() === "esperando_pago");
  // La devolución de la #3: 50 % de 200 = 100; devuelto 40 → falta 60, a las 60 h.
  const dv = juzgarDevolucion(por.get(3)!, { ahoraMs: AHORA, umbralH: 48 });
  t("la #3: falta devolver S/ 60 (de 100)", dv.codigo === "pendiente" && dv.falta === 60 && dv.aDevolver === 100, JSON.stringify(dv));
  t("la #2 avisa «sin confirmar»", juzgarSinConfirmar(por.get(2)!, { ahoraMs: AHORA, umbralMin: 0, margenMin: 360 }).codigo === "aviso");

  // Lecturas que fallan.
  const PAGOS_CAIDOS: Err = { code: "08006", message: "connection failure" };
  const r2 = await leerHechosAlertasReserva(baseFalsa(db(), (tb) => (tb === "pagos" ? PAGOS_CAIDOS : null)), opts);
  t("pagos que no se pudieron leer → null (y el auto-vencimiento no cierra)", r2.hechos.every((h) => h.pagos === null)
    && juzgarVencimiento(r2.hechos.find((h) => h.solicitud.id === 1)!, { ahoraMs: AHORA, hoy: HOY }).codigo === "sin_lectura" && r2.avisos.length > 0);
  const SIN_COL: Err = { code: "42703", message: "column pagos.reserva_solicitud_id does not exist" };
  const r3 = await leerHechosAlertasReserva(baseFalsa(db(), (tb) => (tb === "pagos" ? SIN_COL : null)), opts);
  t("sin la columna de reservas-09c → ningún pago atado (un hecho, no un error)", r3.hechos.every((h) => Array.isArray(h.pagos) && h.pagos.length === 0));
  const SIN_COMPS: Err = { code: "PGRST205", message: "Could not find the table 'public.reserva_solicitud_comprobantes' in the schema cache" };
  const r4 = await leerHechosAlertasReserva(baseFalsa(db(), (tb) => (tb === "reserva_solicitud_comprobantes" ? SIN_COMPS : null)), opts);
  t("sin la tabla de reservas-09b → 0 comprobantes", r4.hechos.every((h) => h.comprobantes === 0));
  const r5 = await leerHechosAlertasReserva(baseFalsa(db(), (tb) => (tb === "reserva_solicitud_comprobantes" ? PAGOS_CAIDOS : null)), opts);
  t("comprobantes que no se pudieron leer → null", r5.hechos.every((h) => h.comprobantes === null));
  const SIN_TJ: Err = { code: "42703", message: "column cotizaciones.traslado_json does not exist" };
  const r6 = await leerHechosAlertasReserva(baseFalsa(db(), (tb, st) => (tb === "cotizaciones" && st.cols.includes("traslado_json") ? SIN_TJ : null)), opts);
  t("sin traslado_json se suelta SOLO esa columna y se dice", r6.hechos.find((h) => h.solicitud.id === 2)?.cotizacion?.numero_cotizacion === "COT-11"
    && r6.hechos.every((h) => h.cotizacion?.validez_hasta == null) && r6.avisos.some((a) => a.includes("traslado_json")));
  const r7 = await leerHechosAlertasReserva(baseFalsa(db(), (tb) => (tb === "cotizaciones" ? PAGOS_CAIDOS : null)), opts);
  t("cotizaciones caídas → sin cotización (nada se cierra ni se afirma «saldada»)", r7.hechos.every((h) => h.cotizacion === null)
    && juzgarDevolucion(r7.hechos.find((h) => h.solicitud.id === 3)!, { ahoraMs: AHORA, umbralH: 48 }).codigo === "sin_lectura");

  // Paginación: 1205 solicitudes esperando el pago se leen todas, y sus pagos por lotes.
  const muchas = { ...db(), reserva_solicitudes: Array.from({ length: 1205 }, (_, i) => filaSol(100 + i, { estado: "esperando_pago", cotizacion_id: 10 })) };
  const r8 = await leerHechosAlertasReserva(baseFalsa(muchas), opts);
  t("pagina: las 1205 se leen (PostgREST corta en 1000)", r8.hechos.length === 1205 && new Set(r8.hechos.map((h) => h.solicitud.id)).size === 1205);

  // El cierre: UPDATE condicional, la tarjeta del CRM y la nota interna.
  const d9 = db();
  const sb9 = baseFalsa(d9);
  const h1 = por.get(1)!;
  const v = juzgarVencimiento(h1, { ahoraMs: AHORA, hoy: HOY });
  t("la #1 (esperando pago, cotización vencida, sin dinero) se cierra", v.codigo === "vencer");
  const nota = notaVencida(h1, v.motivos);
  const cerro = await cerrarSolicitudVencida(sb9, { solicitud: h1.solicitud, nota, notaSolicitud: notaConCierre(h1.solicitud.nota, nota), ahoraIso: iso(AHORA) });
  const s1 = d9.reserva_solicitudes.find((r) => r.id === 1)!;
  t("cancelada, motivo «vencida», con la hora y la nota agregada a la del ejecutivo",
    cerro && s1.estado === "cancelada" && s1.cierre_motivo === "vencida" && s1.cerrada_en === iso(AHORA)
    && String(s1.nota).startsWith("Nota del ejecutivo\n⏰"), JSON.stringify(s1));
  const a1 = d9.crm_acciones_ia[0] as { estado: string; payload: Record<string, unknown>; resuelta_at: string };
  t("su tarjeta del CRM pasa a «rechazada» con la nota, sin perder su payload",
    a1.estado === "rechazada" && a1.resuelta_at === iso(AHORA) && (a1.payload.cierre as { motivo: string }).motivo === "vencida" && a1.payload.cotizacion_id === 10);
  t("y deja una nota interna en el chat (no un mensaje al cliente)", d9.crm_notas.length === 1 && d9.crm_notas[0].conversacion_id === "conv-1"
    && !sb9.llamadas.some((l) => l.includes("crm_mensajes")));
  const otra = await cerrarSolicitudVencida(sb9, { solicitud: h1.solicitud, nota, notaSolicitud: "x", ahoraIso: iso(AHORA + MIN) });
  t("dos veces: la segunda no cierra nada (UPDATE condicional) ni escribe otra nota", !otra && d9.crm_notas.length === 1);
  // Entre la lectura y el cierre llegó el comprobante: la solicitud ya es «pago reportado».
  const d10 = db();
  d10.reserva_solicitudes.find((r) => r.id === 1)!.estado = "pago_reportado";
  const sb10 = baseFalsa(d10);
  const no = await cerrarSolicitudVencida(sb10, { solicitud: h1.solicitud, nota, notaSolicitud: "x", ahoraIso: iso(AHORA) });
  t("si la solicitud cambió de estado, no se toca ni ella ni su tarjeta", !no && d10.reserva_solicitudes.find((r) => r.id === 1)!.estado === "pago_reportado"
    && (d10.crm_acciones_ia[0] as { estado: string }).estado === "pendiente" && d10.crm_notas.length === 0);
  // Una tarjeta que ya no está pendiente no se toca.
  const d11 = db();
  (d11.crm_acciones_ia[0] as { estado: string }).estado = "aprobada";
  await cerrarSolicitudVencida(baseFalsa(d11), { solicitud: h1.solicitud, nota, notaSolicitud: "x", ahoraIso: iso(AHORA) });
  t("una tarjeta que ya no estaba pendiente no se toca", (d11.crm_acciones_ia[0] as { estado: string }).estado === "aprobada");
}

console.log(`\n${ok} ok · ${mal} fallas`);
for (const f of fallas) console.log(`  FALLA ${f}`);
console.log(mal ? `\n${mal} FALLO(S)` : "\nTODO OK");
process.exit(mal ? 1 : 0);
