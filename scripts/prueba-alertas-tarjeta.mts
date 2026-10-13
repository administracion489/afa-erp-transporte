// Pruebas de LO QUE DICE Y OFRECE CADA TARJETA de /configuracion/operaciones (lib/alertas-tarjeta.ts).
// NO toca la base: todo en memoria.
// Uso:  npx tsx scripts/prueba-alertas-tarjeta.mts   (sale con código 1 si algo falla)
//
// EL CASO: las tarjetas enseñaban `alerta_config.descripcion` (un texto sembrado una vez por SQL)
// y los mismos controles en los veintiséis tipos. «No inició a tiempo» decía «El conductor no marcó
// inicio pasada la hora» con «Conductor» marcado, y el tick NO le escribe al conductor cuando «Ya
// debió iniciar» ya le mandó el mismo texto. LO QUE NO SE PUEDE AFLOJAR:
//   · los controles salen de lo que el motor LEE (oráculo escrito aparte, sección 2);
//   · ningún número de la configuración va escrito en un texto (sección 4);
//   · a quién le llega «No inició» es lo que hace el tick (modelo copiado literal, sección 5).

import { readFileSync } from "node:fs";
import {
  TARJETAS, UMBRAL_DEFECTO, controlesDe, cuandoBarrido, cuandoRecordatorio, descripcionDe, destinatariosHoy,
  escribeAlConductor, fichaDe, notasHoy, umbralEfectivo,
  type CfgTarjeta, type CtxTarjeta,
} from "../lib/alertas-tarjeta";
import {
  ANTICIPACION_DEFECTO_MIN, VIA_DE_ALERTA, enVentanaHoraFija, enViaRecordatorio, leeElDirectorio,
} from "../lib/alertas-modo-tiempo";
import {
  INICIA_AHORA_MIN_DEFECTO, VENTANA_DEBIO_MIN, minutosDebioIniciar, minutosIniciaAhora, noInicioRepiteDebio,
} from "../lib/escalera-inicio";
import { REINTENTO_MIN, minutosLlamada } from "../lib/llamadas-central";
import { ESCALAR_TRAS_RECORDATORIOS } from "../lib/alertas-checkout";
import { MAX_SERVICIOS_JORNADA } from "../lib/alertas-flota";
import { limaAUtcMs } from "../lib/alertas-horario";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra && !ok ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const CLAVES = Object.keys(VIA_DE_ALERTA);
const ctx2: CtxTarjeta = { contactos: () => 2, persistenciaPuntoMin: 10, cadenciaCheckoutMin: 60 };
const base = (clave: string, x: Partial<CfgTarjeta> = {}): CfgTarjeta => ({
  clave, activo: true, modo_tiempo: "anticipacion", min_anticipacion: 90, hora_fija: "08:00", umbral: null,
  notifica_conductor: true, notifica_conductor_tercero: false, plantilla: "tpl", plantilla_directorio: null, ...x,
});

// ── 1. Una ficha por cada clave del motor ─────────────────────────────────────
{
  console.log("\n— Biyección con VIA_DE_ALERTA —");
  const fichas = Object.keys(TARJETAS).sort().join(",");
  chk("las claves de TARJETAS son exactamente las de VIA_DE_ALERTA", fichas === [...CLAVES].sort().join(","), fichas);
  chk("fichaDe no inventa una para una clave desconocida", fichaDe("no_existe") === null && fichaDe("toString") === null);
}

// ── 2. Controles ⟺ campos que el motor lee (oráculo de la Tabla A, escrito aparte) ──
{
  console.log("\n— Controles contra el oráculo —");
  // Copiado de la Tabla A del encargo (verificada contra el tick, /api/alertas-flota/inicio,
  // lib/notificaciones.ts y lib/proximidad.ts). Si el motor cambia, cambia esto a mano.
  const LEE_CASILLA = ["inicia_ahora", "debio_iniciar", "no_inicio", "llamada_inicio", "en_punto_sin_iniciar", "gps_silencio", "recordar_checkout"];
  const SIEMPRE = ["recordatorio_conductor", "proximo_inicio", "recuerda_iniciar", "asignacion", "desasignacion", "cambio", "cancelacion", "doc_vence"];
  const TERCERO_CON_CONDUCTOR = ["recordatorio_conductor", "proximo_inicio", "recuerda_iniciar", "inicia_ahora", "debio_iniciar", "no_inicio",
    "llamada_inicio", "en_punto_sin_iniciar", "recordar_checkout", "asignacion", "desasignacion", "cambio", "cancelacion"];
  const TERCERO_SERVICIOS = ["alerta_no_inicio_previa"];
  const HORARIO = ["asignacion", "desasignacion", "cambio", "cancelacion"];
  const UMBRAL = ["debio_iniciar", "no_inicio", "llamada_inicio", "riesgo_retraso", "retraso_en_ruta", "sin_rastreo_previo",
    "gps_silencio", "recordar_checkout", "doc_vence", "jornada", "servicio_abandonado"];
  const PASAJERO: Record<string, string> = {
    recordatorio_pasajero: "push,email,whatsapp", confirmacion_pasajero: "push,email,whatsapp", llegada_pasajero: "whatsapp",
  };
  const LO_DISPARA_OTRO = ["confirmacion_pasajero", "llegada_pasajero"];
  const UMBRAL_DEF: Record<string, number> = {
    no_inicio: 10, debio_iniciar: 1, llamada_inicio: 3, riesgo_retraso: 8, retraso_en_ruta: 10, sin_rastreo_previo: 30,
    gps_silencio: 8, recordar_checkout: 60, doc_vence: 15, jornada: 13, servicio_abandonado: 30,
  };

  const malos: string[] = [];
  for (const clave of CLAVES) {
    for (const nc of [true, false]) {
      const c = controlesDe(base(clave, { notifica_conductor: nc }));
      const esperaCond = LEE_CASILLA.includes(clave) ? "casilla" : SIEMPRE.includes(clave) ? "fijo" : "oculto";
      if (c.conductor !== esperaCond) malos.push(`${clave}: conductor ${c.conductor} ≠ ${esperaCond}`);
      const esperaTer = TERCERO_CON_CONDUCTOR.includes(clave) || TERCERO_SERVICIOS.includes(clave);
      if (!!c.tercerizados !== esperaTer) malos.push(`${clave}: tercerizados`);
      if (c.tercerizados && TERCERO_SERVICIOS.includes(clave) && !c.tercerizados.independienteDeConductor) malos.push(`${clave}: casilla de servicios atada a Conductor`);
      if (c.tercerizados && SIEMPRE.includes(clave) && !c.tercerizados.independienteDeConductor) malos.push(`${clave}: sin casilla Conductor y tercerizados atado a ella`);
      if (c.tercerizados && LEE_CASILLA.includes(clave) && c.tercerizados.independienteDeConductor) malos.push(`${clave}: tercerizados suelto de Conductor`);
      if (c.horario !== HORARIO.includes(clave)) malos.push(`${clave}: horario`);
      if (!!c.umbral !== UMBRAL.includes(clave)) malos.push(`${clave}: umbral`);
      if (c.umbral && c.umbral.defecto !== UMBRAL_DEF[clave]) malos.push(`${clave}: defecto ${c.umbral.defecto} ≠ ${UMBRAL_DEF[clave]}`);
      const pas = c.canalesPasajero ? (["push", "email", "whatsapp"] as const).filter((k) => c.canalesPasajero![k]).join(",") : "";
      if (pas !== (PASAJERO[clave] ?? "")) malos.push(`${clave}: pasajero «${pas}»`);
      if ((c.activo === "lo_dispara_otro") !== LO_DISPARA_OTRO.includes(clave)) malos.push(`${clave}: activo`);
      if ("pasajero" in c) malos.push(`${clave}: ofrece una casilla «Pasajero»`);
      if (c.canalesConductor !== (esperaCond !== "oculto" && clave !== "llamada_inicio")) malos.push(`${clave}: canales del conductor`);
      if ((c.minAnticipacionDefecto != null) !== (VIA_DE_ALERTA[clave] === "recordatorio")) malos.push(`${clave}: minutos antes`);
    }
  }
  chk("conductor / tercerizados / horario / umbral / pasajero / activo coinciden con el oráculo en las 26 claves", malos.length === 0, malos.join(" | "));
  chk("UMBRAL_DEFECTO son exactamente los que leen umbral, con los números del motor",
    Object.keys(UMBRAL_DEFECTO).sort().join(",") === [...UMBRAL].sort().join(",")
    && UMBRAL.every((k) => (UMBRAL_DEFECTO as Record<string, number>)[k] === UMBRAL_DEF[k]));
  chk("«Inicia ahora» propone 5 min sin dato; los demás pre-inicio, los 90 de enViaRecordatorio",
    controlesDe(base("inicia_ahora")).minAnticipacionDefecto === INICIA_AHORA_MIN_DEFECTO
    && controlesDe(base("proximo_inicio")).minAnticipacionDefecto === ANTICIPACION_DEFECTO_MIN);
  // Un aviso que no le escribe ni al conductor ni al pasajero tiene que escribirle al directorio:
  // si no, no le llegaría a nadie nunca.
  const huerfanas = CLAVES.filter((k) => TARJETAS[k].alConductor === "nunca" && !TARJETAS[k].alPasajero && leeElDirectorio(k) !== true);
  chk("toda tarjeta sin conductor ni pasajero le escribe al directorio", huerfanas.length === 0, huerfanas.join(","));
}

// ── 3. Regresión: la casilla inalcanzable de la alerta previa ─────────────────
{
  console.log("\n— «Alerta previa al coordinador» ofrece sus tercerizados sin «Conductor» —");
  const c = controlesDe(base("alerta_no_inicio_previa", { notifica_conductor: false }));
  chk("con «Conductor» desmarcado (como nace) la casilla de tercerizados se ve", !!c.tercerizados && c.tercerizados.independienteDeConductor, JSON.stringify(c.tercerizados));
  chk("y dice que extiende los SERVICIOS, no el mensaje al conductor", /servicios/i.test(c.tercerizados?.etiqueta ?? ""));
  chk("y no ofrece «Conductor»", c.conductor === "oculto");
}

// ── 4. Ningún número de la configuración escrito en un texto ──────────────────
{
  console.log("\n— Los textos interpolan; no traen números de configuración —");
  const S = { umbral: 97, min: 83, hora: "23:41", persist: 71, cadencia: 59 };
  const ctxS: CtxTarjeta = { contactos: () => 2, persistenciaPuntoMin: S.persist, cadenciaCheckoutMin: S.cadencia };
  // Constantes del CÓDIGO que un texto sí puede decir (no son de la fila).
  const PERMITIDAS = new Set([VENTANA_DEBIO_MIN, REINTENTO_MIN, ESCALAR_TRAS_RECORDATORIOS, MAX_SERVICIOS_JORNADA,
    2 /* la tecla «marca 2» de la llamada (Opcion de lib/llamadas-central.ts) */].map(String));
  const SENTINELAS = new Set([S.umbral, S.min, S.persist, S.cadencia, S.umbral + VENTANA_DEBIO_MIN].map(String));
  const MODOS = ["anticipacion", "hora_fija", "evento", null];
  const conDigitos: string[] = [];
  for (const clave of CLAVES) {
    for (const modo of MODOS) {
      const t = descripcionDe(base(clave, { modo_tiempo: modo, umbral: S.umbral, min_anticipacion: S.min, hora_fija: S.hora }), ctxS);
      const limpio = t.split(S.hora).join(" ").replace(/\d+/g, (d) => (SENTINELAS.has(d) || PERMITIDAS.has(d) ? " " : d));
      if (/\d/.test(limpio)) conDigitos.push(`${clave}/${modo}: «${t}»`);
      if (!t.trim()) conDigitos.push(`${clave}/${modo}: vacío`);
    }
  }
  chk("26 claves × 4 modos: quitados los valores de la fila, no queda ningún dígito", conDigitos.length === 0, conDigitos.slice(0, 3).join(" | "));

  // Cada campo de `usa` cambia el texto (en el modo que lo lee); los que no están en `usa`, no.
  const modoQueLee = (campo: string, clave: string) =>
    campo === "hora_fija" ? "hora_fija" : campo === "min_anticipacion" ? "anticipacion"
      : VIA_DE_ALERTA[clave] === "hora_fija" ? "hora_fija" : "anticipacion";
  const variar: Record<string, [Partial<CfgTarjeta>, Partial<CfgTarjeta>]> = {
    umbral: [{ umbral: S.umbral }, { umbral: S.umbral + 1 }],
    min_anticipacion: [{ min_anticipacion: S.min }, { min_anticipacion: S.min + 1 }],
    hora_fija: [{ hora_fija: S.hora }, { hora_fija: "22:17" }],
  };
  const mudos: string[] = [];
  const inventados: string[] = [];
  for (const clave of CLAVES) {
    const f = TARJETAS[clave];
    for (const campo of Object.keys(variar)) {
      for (const modo of (f.usa.includes(campo as never) ? [modoQueLee(campo, clave)] : ["anticipacion", "hora_fija", "evento"])) {
        const a = descripcionDe(base(clave, { modo_tiempo: modo, ...variar[campo][0] }), ctxS);
        const b = descripcionDe(base(clave, { modo_tiempo: modo, ...variar[campo][1] }), ctxS);
        if (f.usa.includes(campo as never) && a === b) mudos.push(`${clave}.${campo}`);
        if (!f.usa.includes(campo as never) && a !== b) inventados.push(`${clave}.${campo}/${modo}`);
      }
    }
  }
  chk("todo campo declarado en `usa` mueve el texto", mudos.length === 0, mudos.join(","));
  chk("un campo que no está en `usa` no lo mueve (no se describe lo que no se lee)", inventados.length === 0, inventados.join(","));

  // Sin umbral, el texto dice el MISMO default que usa el motor.
  const malDefecto: string[] = [];
  for (const clave of CLAVES) {
    if (!TARJETAS[clave].usa.includes("umbral")) continue;
    const cfg = base(clave, { umbral: null, modo_tiempo: "hora_fija", hora_fija: S.hora });
    const def = (UMBRAL_DEFECTO as Record<string, number>)[clave];
    const motor = clave === "debio_iniciar" ? minutosDebioIniciar(cfg) : clave === "llamada_inicio" ? minutosLlamada(cfg) : def;
    if (umbralEfectivo(cfg) !== motor || motor !== def) malDefecto.push(`${clave}: ${umbralEfectivo(cfg)} vs ${motor}`);
    if (!new RegExp(`(^|\\D)${def}(\\D|$)`).test(descripcionDe(cfg, ctxS))) malDefecto.push(`${clave}: el texto no dice ${def}`);
  }
  chk("con umbral vacío el texto dice el default del motor (UMBRAL_DEFECTO / minutos*)", malDefecto.length === 0, malDefecto.join(" | "));
  const sinMin = descripcionDe(base("alerta_no_inicio_previa", { min_anticipacion: null }), ctxS);
  chk("sin minutos, la alerta previa dice los 90 de enViaRecordatorio (no los 25 de la semilla)", sinMin.includes(`${ANTICIPACION_DEFECTO_MIN} min antes`), sinMin);
  chk("…e «Inicia ahora», los 5 de su módulo", descripcionDe(base("inicia_ahora", { min_anticipacion: null }), ctxS).includes(`${minutosIniciaAhora(null)} min antes`));
  chk("«Servicio sin cerrar» apagado: dice las horas que usa el motor apagado (no las de la fila)",
    descripcionDe(base("servicio_abandonado", { activo: false, umbral: S.umbral }), ctxS).includes(`${UMBRAL_DEFECTO.servicio_abandonado} h`));
  chk("sin persistencia ni cadencia en el contexto, se dice de dónde salen",
    /persiste pasada la hora/.test(descripcionDe(base("en_punto_sin_iniciar"), { contactos: () => 0 }))
    && /Auditoría de jornada/.test(descripcionDe(base("recordar_checkout"), { contactos: () => 0 })));
  chk("«No inició» ya no dice «El conductor no marcó inicio» (dice a quién le escribe)",
    /contactos marcados/.test(descripcionDe(base("no_inicio"), ctx2)) && /Ya debió iniciar/.test(descripcionDe(base("no_inicio"), ctx2)));
}

// ── 4b. El «cuándo» dice lo que hacen los dos predicados del motor ─────────────
{
  console.log("\n— «Cuándo» contra enViaRecordatorio / enVentanaHoraFija —");
  const fecha = "2026-10-14", hoy = "2026-10-13", manana = fecha;
  const inicio = limaAUtcMs(fecha, "06:30")!;
  let casos = 0;
  const malos: string[] = [];
  for (const clave of ["proximo_inicio", "inicia_ahora"]) {
    for (const modo of ["anticipacion", "hora_fija", "evento", null]) {
      for (const min of [null, 0, 5, 83, -3, 150]) {
        for (const hf of [null, "23:41", "25:99", "x", "7"]) {
          const cfg = base(clave, { modo_tiempo: modo, min_anticipacion: min, hora_fija: hf });
          const texto = cuandoRecordatorio(cfg);
          // Lo que el motor le pasa a enViaRecordatorio (tick: tal cual; cron de 1 min: juzgarIniciaAhora).
          const ia = clave === "inicia_ahora";
          let primero: number | null = null;
          for (let t = inicio - 30 * 3_600_000; t < inicio; t += 60_000) {
            const ahoraMin = Math.floor(((t - 5 * 3_600_000) % 86_400_000 + 86_400_000) % 86_400_000 / 60_000);
            const dia = new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);
            const sale = enViaRecordatorio({
              modo_tiempo: ia ? (modo ?? "anticipacion") : modo, hora_fija: hf,
              min_anticipacion: ia ? minutosIniciaAhora(cfg) : min,
              fechaServicio: fecha, horaServicio: "06:30",
              hoy: dia, manana: dia === hoy ? manana : "2099-01-01", ahoraMin, ahoraMs: t,
            });
            if (sale) { primero = t; break; }
          }
          casos++;
          const nunca = texto.startsWith("nunca");
          if (nunca !== (primero == null)) { malos.push(`${clave}/${modo}/${min}/${hf}: «${texto}» vs ${primero}`); continue; }
          if (primero == null) continue;
          const hhmm = new Date(primero - 5 * 3_600_000).toISOString().slice(11, 16);
          const antes = Math.round((inicio - primero) / 60_000);
          const cuadra = /antes de la hora/.test(texto)
            ? (antes < 120 ? texto.startsWith(`${antes} min`) : texto.startsWith(`${Math.floor(antes / 60)} h`))
            : texto === `a las ${hhmm} del día anterior`;
          if (!cuadra) malos.push(`${clave}/${modo}/${min}/${hf}: «${texto}» y sale ${hhmm} (${antes} min antes)`);
        }
      }
    }
  }
  chk(`${casos} configuraciones: «nunca» ⟺ el motor no lo manda; si no, el texto dice su primer minuto`, malos.length === 0, malos.slice(0, 3).join(" | "));

  const malB: string[] = [];
  for (const modo of ["anticipacion", "hora_fija", "evento", null]) {
    for (const hf of [null, "23:41", "07:00", "25:99", "x"]) {
      const texto = cuandoBarrido(base("doc_vence", { modo_tiempo: modo, hora_fija: hf }));
      const minutos = Array.from({ length: 1440 }, (_, m) => enVentanaHoraFija({ modo_tiempo: modo, hora_fija: hf, ahoraMin: m }));
      const primero = minutos.indexOf(true);
      const hhmm = primero < 0 ? null : `${String(Math.floor(primero / 60)).padStart(2, "0")}:${String(primero % 60).padStart(2, "0")}`;
      const ok = primero < 0 ? /no existe/.test(texto)
        : minutos.every(Boolean) ? /sin hora fija/.test(texto)
        : texto === `todos los días a las ${hhmm}`;
      if (!ok) malB.push(`${modo}/${hf}: «${texto}» vs ${hhmm}`);
    }
  }
  chk("barridos: «sin hora fija» ⟺ sin ventana; «a las HH:MM» ⟺ su ventana abre a esa hora", malB.length === 0, malB.join(" | "));
}

// ── 5. «No inició»: a quién le llega, contra el tick copiado literal ──────────
{
  console.log("\n— «No inició a tiempo» contra el modelo del tick —");
  // /api/alertas-flota/inicio:122-124 — cuándo «Ya debió iniciar» le escribe a un conductor.
  const debioEscribe = (cfg: CfgTarjeta | undefined, esTercero: boolean): boolean => {
    if (!cfg || !cfg.activo) return false;                                   // pasosQueTocan: apagado
    if (!cfg.notifica_conductor || !cfg.plantilla) return false;
    if (esTercero && cfg.notifica_conductor_tercero !== true) return false;
    return true;
  };
  // tick:626 (`cfg.notifica_conductor && ref && !noInicioRepiteDebio(...)`) + aConductor/avisaA
  // (`!cfg.plantilla` → sin canal; tercerizado solo con `notifica_conductor_tercero === true`).
  const modelo = (no: CfgTarjeta, debio: CfgTarjeta | undefined, contactos: number) => {
    if (!no.activo) return { propio: false, tercero: false, dir: 0 };
    const propio = !!no.notifica_conductor && !debioEscribe(debio, false) && !!no.plantilla;
    const tercero = !!no.notifica_conductor && !debioEscribe(debio, true) && !!no.plantilla && no.notifica_conductor_tercero === true;
    return { propio, tercero, dir: contactos };
  };

  let casos = 0, conConductor = 0, calladoPorDebio = 0;
  const malos: string[] = [];
  const B = [true, false];
  for (const nAct of B) for (const nCond of B) for (const nTer of B)
  for (const dExiste of B) for (const dAct of B) for (const dCond of [true, false, null]) for (const dTer of B) for (const dPl of ["conductor_no_inicio", null])
  for (const contactos of [0, 2]) for (const enPunto of B) {
    if (!dExiste && (!dAct || dCond !== true || !dTer || !dPl)) continue;   // sin fila: una sola combinación
    const no = base("no_inicio", { activo: nAct, notifica_conductor: nCond, notifica_conductor_tercero: nTer, plantilla: "conductor_no_inicio" });
    const debio = dExiste ? base("debio_iniciar", { activo: dAct, notifica_conductor: dCond, notifica_conductor_tercero: dTer, plantilla: dPl }) : undefined;
    const cfgs = new Map<string, CfgTarjeta>([["no_inicio", no], ["en_punto_sin_iniciar", base("en_punto_sin_iniciar", { activo: enPunto })]]);
    if (debio) cfgs.set("debio_iniciar", debio);
    const ctx: CtxTarjeta = { contactos: () => contactos };
    const d = destinatariosHoy("no_inicio", cfgs, ctx);
    const m = modelo(no, debio, contactos);
    casos++;
    if (d.conductorPropio !== m.propio || d.conductorTercero !== m.tercero || d.directorio !== m.dir || d.pasajero || d.proveedor) {
      malos.push(`${JSON.stringify({ nAct, nCond, nTer, dExiste, dAct, dCond, dTer, dPl, contactos })}: ${JSON.stringify(d)} vs ${JSON.stringify(m)}`);
    }
    // El módulo del motor dice lo mismo que el cron de un minuto.
    if (noInicioRepiteDebio(debio, false) !== debioEscribe(debio, false) || noInicioRepiteDebio(debio, true) !== debioEscribe(debio, true)) {
      malos.push(`noInicioRepiteDebio ≠ cron de un minuto: ${JSON.stringify({ dExiste, dAct, dCond, dTer, dPl })}`);
    }
    const notas = notasHoy("no_inicio", cfgs, ctx);
    const repite = notas.some((x) => x.codigo === "repite_debio");
    if (repite !== (!!nCond && noInicioRepiteDebio(debio, false))) malos.push(`repite_debio ${repite}: ${JSON.stringify({ nCond, dAct, dCond, dPl })}`);
    if (notas.some((x) => x.codigo === "lo_atiende_en_punto") !== enPunto) malos.push(`lo_atiende_en_punto ≠ en_punto ${enPunto}`);
    const nadie = !m.propio && !m.tercero && m.dir === 0;
    if (notas.some((x) => x.codigo === "sin_destinatarios") !== (nAct && nadie)) malos.push(`sin_destinatarios: ${JSON.stringify({ nAct, nCond, contactos, dAct })}`);
    // Espejo en «Ya debió iniciar».
    if (debio) {
      const espejo = notasHoy("debio_iniciar", cfgs, ctx).some((x) => x.codigo === "silencia_no_inicio");
      if (espejo !== (nAct && nCond && noInicioRepiteDebio(debio, false))) malos.push(`silencia_no_inicio: ${JSON.stringify({ nAct, nCond, dAct, dCond, dPl })}`);
    }
    if (nAct && nCond) { conConductor++; if (!m.propio) calladoPorDebio++; }
  }
  chk(`${casos} combinaciones: destinatarios = tick, notas repite_debio / lo_atiende_en_punto / sin_destinatarios / espejo`, malos.length === 0, malos.slice(0, 3).join(" | "));
  chk("corolario: con «Conductor» marcado hay casos en que le llega y casos en que «Ya debió iniciar» lo calla",
    conConductor > calladoPorDebio && calladoPorDebio > 0, `${conConductor}/${calladoPorDebio}`);

  const sinPlantilla = new Map<string, CfgTarjeta>([
    ["no_inicio", base("no_inicio")], ["debio_iniciar", base("debio_iniciar", { plantilla: null })],
  ]);
  chk("«Ya debió iniciar» sin plantilla no calla al conductor (no sale)", destinatariosHoy("no_inicio", sinPlantilla, ctx2).conductorPropio);
  const nota = notasHoy("no_inicio", new Map([["no_inicio", base("no_inicio")], ["debio_iniciar", base("debio_iniciar", { umbral: 4 })]]), ctx2)
    .find((x) => x.codigo === "repite_debio");
  chk("la nota dice los minutos de «Ya debió iniciar» y que va solo a los contactos", !!nota && /a los 4 min/.test(nota.texto) && /solo a los contactos/.test(nota.texto), nota?.texto);
}

// ── 7. Ámbar ⟺ sin_destinatarios ∨ conductor_apaga_todo; nunca en una tarjeta apagada ──
{
  console.log("\n— Solo dos notas alarman, y nunca en una tarjeta apagada —");
  let s = 20261013;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const uno = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  let casos = 0, alarmas = 0, apagaTodo = 0, nadie = 0;
  const malos: string[] = [];
  for (let i = 0; i < 3000; i++) {
    const cfgs = new Map<string, CfgTarjeta>();
    for (const clave of CLAVES) {
      if (rnd() < 0.05) continue;
      cfgs.set(clave, base(clave, {
        activo: uno([true, false]), notifica_conductor: uno([true, false, null]), notifica_conductor_tercero: uno([true, false]),
        plantilla: uno(["tpl", null]), modo_tiempo: uno(["anticipacion", "hora_fija", "evento"]), umbral: uno([null, 0, 5]),
        canal_conductor_whatsapp: uno([true, false, null]), canal_conductor_email: uno([false, null]), canal_conductor_push: uno([true, false, null]),
        canal_pasajero_push: uno([true, false, null]), canal_pasajero_email: uno([true, false]), canal_pasajero_whatsapp: uno([true, false]),
      }));
    }
    const contactos = uno([0, 1]);
    const ctx: CtxTarjeta = { contactos: () => contactos };
    for (const [clave, cfg] of cfgs) {
      const f = TARJETAS[clave];
      const notas = notasHoy(clave, cfgs, ctx);
      casos++;
      const encendida = f.activoApaga ? cfg.activo : true;
      for (const x of notas) {
        if (x.alarma !== (x.codigo === "sin_destinatarios" || x.codigo === "conductor_apaga_todo")) malos.push(`${clave}: ${x.codigo} alarma=${x.alarma}`);
        if (x.alarma && !encendida) malos.push(`${clave}: alarma en una tarjeta apagada (${x.codigo})`);
        if (!x.texto.trim()) malos.push(`${clave}: nota vacía`);
        if (x.alarma) alarmas++;
        if (x.codigo === "conductor_apaga_todo") apagaTodo++;
      }
      const d = destinatariosHoy(clave, cfgs, ctx);
      const vacia = !d.conductorPropio && !d.conductorTercero && !d.pasajero && d.directorio === 0 && !d.proveedor;
      const tieneApaga = notas.some((x) => x.codigo === "conductor_apaga_todo");
      const tieneNadie = notas.some((x) => x.codigo === "sin_destinatarios");
      if (tieneNadie !== (encendida && vacia && !tieneApaga)) malos.push(`${clave}: sin_destinatarios ${tieneNadie} con encendida=${encendida} vacía=${vacia}`);
      if (tieneNadie) nadie++;
      if (tieneApaga !== (clave === "recordar_checkout" && encendida && !cfg.notifica_conductor)) malos.push(`${clave}: conductor_apaga_todo`);
      // Un aviso que no lee la casilla «Conductor» no cambia con ella.
      if (f.alConductor === "siempre" && !escribeAlConductor(clave, { notifica_conductor: false })) malos.push(`${clave}: «siempre» leyendo la casilla`);
    }
  }
  chk(`${casos} tarjetas: ámbar ⟺ sin_destinatarios ∨ conductor_apaga_todo, nunca apagada; sin_destinatarios ⟺ encendida y vacía`, malos.length === 0, malos.slice(0, 3).join(" | "));
  chk("corolario: el barrido sí produce las dos alarmas", nadie > 0 && apagaTodo > 0 && alarmas >= nadie + apagaTodo, `${nadie}/${apagaTodo}`);

  // La configuración buena de AFA no alarma.
  const afa = new Map<string, CfgTarjeta>(CLAVES.map((k) => [k, base(k, {
    notifica_conductor: TARJETAS[k].alConductor !== "nunca", plantilla: "tpl",
  })]));
  const conAlarma = CLAVES.filter((k) => notasHoy(k, afa, ctx2).some((x) => x.alarma));
  chk("con plantillas, canales y contactos, ninguna tarjeta encendida alarma", conAlarma.length === 0, conAlarma.join(","));
  const dirSolo = notasHoy("riesgo_retraso", afa, { contactos: () => 0 }).find((x) => x.codigo === "sin_destinatarios");
  chk("una tarjeta solo de contactos, sin contactos → ámbar que dice por qué", !!dirSolo && /contacto/.test(dirSolo.texto), dirSolo?.texto);
  const apagada = new Map(afa); apagada.set("riesgo_retraso", base("riesgo_retraso", { activo: false }));
  chk("…y apagada no alarma", !notasHoy("riesgo_retraso", apagada, { contactos: () => 0 }).some((x) => x.alarma));
  const pasajeroMudo = new Map(afa);
  pasajeroMudo.set("confirmacion_pasajero", base("confirmacion_pasajero", { activo: false, canal_pasajero_push: false, canal_pasajero_email: false, canal_pasajero_whatsapp: false }));
  chk("«lo dispara otro» con los canales apagados alarma aunque su interruptor diga apagado",
    notasHoy("confirmacion_pasajero", pasajeroMudo, ctx2).some((x) => x.codigo === "sin_destinatarios"));
  const llegada = new Map(afa);
  llegada.set("llegada_pasajero", base("llegada_pasajero", { activo: false, canal_pasajero_push: false, canal_pasajero_email: false, canal_pasajero_whatsapp: false }));
  chk("«El bus llegó» siempre le llega (la notificación del app no depende del canal)", destinatariosHoy("llegada_pasajero", llegada, ctx2).pasajero);
  const rp = new Map(afa); rp.set("recordatorio_pasajero", base("recordatorio_pasajero", { activo: false }));
  // Desde el 13-10-2026 el cron de las 08:00 no manda nada mientras exista la fila: la tarjeta decide.
  chk("recordatorio al pasajero apagado: no le llega (el cron de las 08:00 ya no manda con la tarjeta)",
    !destinatariosHoy("recordatorio_pasajero", rp, ctx2).pasajero && notasHoy("recordatorio_pasajero", rp, ctx2).length === 0);
  chk("…y encendido sí", destinatariosHoy("recordatorio_pasajero", new Map(afa), ctx2).pasajero);
  const gps = destinatariosHoy("gps_silencio", new Map([["gps_silencio", base("gps_silencio", { notifica_conductor_tercero: true })]]), ctx2);
  chk("«GPS sin señal» nunca le escribe al conductor tercerizado (el tick mira `r.conductor_id`)", gps.conductorPropio && !gps.conductorTercero);
  chk("«Recordatorio al conductor» no exige plantilla (usa la fija del código)",
    destinatariosHoy("recordatorio_conductor", new Map([["recordatorio_conductor", base("recordatorio_conductor", { plantilla: null, notifica_conductor: false })]]), ctx2).conductorPropio);
  chk("la desasignación avisa que manda el horario de «Servicio asignado» mientras esté activo",
    notasHoy("desasignacion", afa, ctx2).some((x) => x.codigo === "horario_de_asignacion")
    && !notasHoy("desasignacion", new Map([...afa, ["asignacion", base("asignacion", { activo: false })]]), ctx2).some((x) => x.codigo === "horario_de_asignacion"));
}

// ── 8. Una clave desconocida: la descripción de la base y los controles de siempre ──
{
  console.log("\n— Clave desconocida —");
  const cfg: CfgTarjeta = { clave: "aviso_nuevo", activo: true, descripcion: "Texto de la base", notifica_conductor: true };
  chk("conserva la descripción de la base", descripcionDe(cfg, ctx2) === "Texto de la base");
  chk("sin descripción, vacío (no se inventa)", descripcionDe({ ...cfg, descripcion: null }, ctx2) === "");
  const c = controlesDe(cfg);
  chk("ofrece los controles de siempre (el lado seguro)",
    c.conductor === "casilla" && !!c.tercerizados && !c.tercerizados.independienteDeConductor && c.canalesConductor
    && c.horario && !!c.umbral && c.minAnticipacionDefecto === ANTICIPACION_DEFECTO_MIN && c.activo === "interruptor", JSON.stringify(c));
  chk("y no afirma nada en sus notas", notasHoy("aviso_nuevo", new Map([["aviso_nuevo", cfg]]), ctx2).length === 0);
}

// ── 9. El tick no tiene defaults de umbral propios ────────────────────────────
{
  console.log("\n— El tick lee los defaults de UMBRAL_DEFECTO —");
  const tick = readFileSync(new URL("../app/api/alertas-flota/tick/route.ts", import.meta.url), "utf8");
  const sueltos = tick.match(/umbral\s*\?\?\s*\d/g) ?? [];
  chk("ningún `umbral ?? <número>` en el tick", sueltos.length === 0, sueltos.join(","));
  chk("la jornada usa MAX_SERVICIOS_JORNADA (sin un 4 escrito)", /maxServicios:\s*MAX_SERVICIOS_JORNADA/.test(tick) && !/maxServicios:\s*\d/.test(tick));
  const usados = new Set([...tick.matchAll(/UMBRAL_DEFECTO\.(\w+)/g)].map((m) => m[1]));
  const tickLee = Object.keys(UMBRAL_DEFECTO).filter((k) => !["debio_iniciar", "llamada_inicio"].includes(k));
  chk("cada umbral del tick sale de UMBRAL_DEFECTO (los de 1 min salen de sus módulos)",
    tickLee.every((k) => usados.has(k)) && [...usados].every((k) => k in UMBRAL_DEFECTO), [...usados].join(","));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
