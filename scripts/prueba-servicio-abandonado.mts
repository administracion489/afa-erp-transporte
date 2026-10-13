// Pruebas del aviso «SERVICIO SIN CERRAR» y su horario (lib/servicio-abandonado.ts +
// `planDeEnvioAviso` en lib/alertas-horario.ts). NO toca la base: todo en memoria.
// Uso:  npx tsx scripts/prueba-servicio-abandonado.mts   (sale con código 1 si algo falla)
//
// EL CASO (dueño, 13-10-2026): «aquí falta respetar la hora de sueño del coordinador». El bloque 7
// del tick cerraba el servicio abandonado y en el MISMO tick le escribía a los contactos, a la hora
// que fuera. LO QUE NO SE PUEDE AFLOJAR:
//   · el horario es el MISMO que el del conductor, sin la urgencia (sección 1, cruzado minuto a minuto);
//   · con horario, ningún aviso sale fuera de él; y ninguno se pierde (sección 3, simulación del tick);
//   · al abrir sale UN mensaje con todo lo de la noche (sección 4);
//   · sin la casilla, el comportamiento es el de antes: sale al cerrar (sección 3).

import { readFileSync } from "node:fs";
import {
  dentroDeVentana, describirHorario, fechaLima, hhmmAMinutos, horarioDe, limaAUtcMs, minutoDelDiaLima,
  planDeEnvioAviso, planDeEnvioConductor, ventanaPorDefecto, type Horario,
} from "../lib/alertas-horario";
import {
  CLAVE_ESPERA_ABANDONADO, DIAS_ESPERA_MAX, LARGO_LISTA, paramsAvisoAbandonados, planDePendientes,
  type Pendiente, type ServicioCerrado,
} from "../lib/servicio-abandonado";
import { controlesDe, descripcionDe, type CfgTarjeta } from "../lib/alertas-tarjeta";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra && !ok ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const lima = (fecha: string, hora: string) => limaAUtcMs(fecha, hora)!;
const H = (desde: string | null, hasta: string | null, respeta = true, margen = 90): Horario =>
  horarioDe({ respeta_horario: respeta, horario_desde: desde, horario_hasta: hasta, horario_margen_min: margen });

const VENTANAS: [string | null, string | null, boolean][] = [
  ["07:00", "21:00", true], ["12:00", "22:00", true], ["21:00", "07:00", true], ["06:30", "06:45", true],
  ["08:00", "08:00", true], [null, "21:00", true], ["07:00", "21:00", false],
];

// ── 1. La ventana del aviso es la del conductor, sin urgencia ─────────────────
{
  console.log("\n— planDeEnvioAviso contra planDeEnvioConductor —");
  const malos: string[] = [];
  let n = 0;
  for (const [d, h, r] of VENTANAS) {
    for (const margen of [0, 90, 600]) {
      const horario = H(d, h, r, margen);
      for (let m = 0; m < 1440; m += 5) {
        const ahoraMs = lima("2026-10-13", "00:00") + m * 60_000;
        for (const [fs, hs] of [["2026-10-13", "05:00"], ["2026-10-14", "15:00"], [null, null]] as const) {
          n++;
          const a = planDeEnvioAviso({ ahoraMs, horario });
          const c = planDeEnvioConductor({ ahoraMs, fechaServicio: fs, horaServicio: hs, horario });
          if (["no_difiere", "sin_ventana", "en_ventana"].includes(c.codigo)) {
            if (a.codigo !== c.codigo || !a.enviar) malos.push(`${d}-${h}/${m}: ${a.codigo} ≠ ${c.codigo}`);
          } else {
            // urgente, sin_fecha o fuera_de_horario en el conductor → el aviso, fuera del horario, espera
            if (a.enviar || a.codigo !== "fuera_de_horario") malos.push(`${d}-${h}/${m}: el aviso no espera (${c.codigo})`);
            if (c.codigo === "fuera_de_horario" && !a.enviar && !c.enviar && a.abreMs !== c.abreMs) malos.push(`${d}-${h}/${m}: abre distinto`);
          }
        }
      }
    }
  }
  chk(`${n} combinaciones: mismas reglas 1-3; donde el conductor espera, sería urgente o no sabe la fecha, el aviso espera`, malos.length === 0, malos.slice(0, 3).join(" | "));
  // Corolario: espera de verdad, y solo fuera de la ventana.
  const h = H("07:00", "21:00");
  const p04 = planDeEnvioAviso({ ahoraMs: lima("2026-10-13", "04:00"), horario: h });
  chk("con 07:00–21:00, a las 04:00 espera hasta las 07:00 del mismo día",
    !p04.enviar && p04.codigo === "fuera_de_horario" && p04.abreMs === lima("2026-10-13", "07:00"));
  chk("a las 22:30 espera hasta las 07:00 del día siguiente",
    (() => { const p = planDeEnvioAviso({ ahoraMs: lima("2026-10-13", "22:30"), horario: h }); return !p.enviar && p.abreMs === lima("2026-10-14", "07:00"); })());
  chk("a las 07:00 sale (la apertura es inclusiva) y a las 21:00 ya no (exclusiva)",
    planDeEnvioAviso({ ahoraMs: lima("2026-10-13", "07:00"), horario: h }).enviar
    && !planDeEnvioAviso({ ahoraMs: lima("2026-10-13", "21:00"), horario: h }).enviar);
  chk("sin la casilla sale siempre (el comportamiento de antes)",
    planDeEnvioAviso({ ahoraMs: lima("2026-10-13", "03:00"), horario: H("07:00", "21:00", false) }).enviar);
}

// ── 2. planDePendientes: disjunto, exhaustivo, y lo apagado o viejo se descarta ──
{
  console.log("\n— Qué se hace con cada marcador —");
  const ahoraMs = lima("2026-10-13", "08:00");
  const pend: Pendiente[] = [
    { ref: "1", fecha: "2026-10-13" }, { ref: "2", fecha: "2026-10-12" }, { ref: "3", fecha: "2026-10-11" },
    { ref: "4", fecha: "2026-10-10" }, { ref: "", fecha: "2026-10-13" }, { ref: "6", fecha: "no-es-fecha" },
  ];
  const malos: string[] = [];
  for (const [d, h, r] of VENTANAS) for (const activa of [true, false]) for (let m = 0; m < 1440; m += 30) {
    const t = lima("2026-10-13", "00:00") + m * 60_000;
    const p = planDePendientes({ ahoraMs: t, activa, horario: H(d, h, r), pendientes: pend });
    const todos = [...p.enviar, ...p.esperan, ...p.descartar.map((x) => x.p)];
    if (todos.length !== pend.length || new Set(todos).size !== pend.length) malos.push(`${d}-${h}/${activa}/${m}: no particiona`);
    if (p.enviar.length && p.esperan.length) malos.push(`${d}-${h}/${m}: envía y espera a la vez`);
    if (!activa && (p.enviar.length || p.esperan.length)) malos.push(`${d}-${h}/${m}: apagada y no descarta`);
  }
  chk("7 ventanas × encendida/apagada × 48 horas: cada marcador cae en exactamente un conjunto", malos.length === 0, malos.slice(0, 3).join(" | "));
  const p = planDePendientes({ ahoraMs, activa: true, horario: H("07:00", "21:00"), pendientes: pend });
  chk(`hoy, ayer y anteayer salen; hace ${DIAS_ESPERA_MAX + 1} días vence; sin ref o sin fecha, inválido`,
    p.enviar.map((x) => x.ref).join(",") === "1,2,3"
    && p.descartar.map((x) => `${x.p.ref}:${x.codigo}`).join(",") === "4:vencido,:invalido,6:invalido",
    JSON.stringify(p));
  const apagada = planDePendientes({ ahoraMs, activa: false, horario: H("07:00", "21:00"), pendientes: pend.slice(0, 2) });
  chk("con la tarjeta apagada no sale ni espera nada: «solo deja de avisar»",
    apagada.descartar.every((x) => x.codigo === "tarjeta_apagada") && apagada.descartar.length === 2 && apagada.plan === null);
  const noche = planDePendientes({ ahoraMs: lima("2026-10-13", "03:00"), activa: true, horario: H("07:00", "21:00"), pendientes: pend.slice(0, 2) });
  chk("de madrugada, con horario, esperan", noche.esperan.length === 2 && noche.enviar.length === 0);
}

// ── 3. Simulación del tick: ninguno sale fuera del horario, ninguno se pierde ni se repite ──
{
  console.log("\n— Tres días de ticks cada 10 min —");
  // Cierres a horas que cruzan el día entero, varios por noche (el caso real: servicios de la noche
  // anterior que pasan las 30 h de madrugada).
  const cierres: { ref: string; ms: number }[] = [];
  let k = 0;
  for (const dia of ["2026-10-13", "2026-10-14"]) for (const hh of ["00:05", "01:17", "03:40", "04:00", "06:59", "07:00", "11:23", "20:59", "21:00", "23:55"]) {
    cierres.push({ ref: String(++k), ms: lima(dia, hh) });
  }
  const malos: string[] = [];
  for (const [d, h, r] of VENTANAS) {
    const horario = H(d, h, r);
    const ventanaReal = r && d != null && h != null && d !== h;
    const marcas = new Map<string, string>();      // ref → fecha (alerta_enviada)
    const enviados = new Map<string, number>();    // ref → instante
    let mensajes = 0;
    for (let t = lima("2026-10-13", "00:00"); t <= lima("2026-10-16", "00:00"); t += 10 * 60_000) {
      // el cierre: deja su marcador
      for (const c of cierres) if (c.ms <= t && c.ms > t - 10 * 60_000) marcas.set(c.ref, fechaLima(t));
      const plan = planDePendientes({ ahoraMs: t, activa: true, horario, pendientes: [...marcas].map(([ref, fecha]) => ({ ref, fecha })) });
      if (plan.enviar.length) mensajes++;
      for (const p of plan.enviar) {
        if (enviados.has(p.ref)) malos.push(`${d}-${h}: ${p.ref} dos veces`);
        enviados.set(p.ref, t);
        marcas.delete(p.ref);
        if (ventanaReal && !dentroDeVentana(minutoDelDiaLima(t), hhmmAMinutos(d)!, hhmmAMinutos(h)!)) malos.push(`${d}-${h}: ${p.ref} fuera del horario`);
      }
      for (const x of plan.descartar) malos.push(`${d}-${h}: ${x.p.ref} descartado (${x.codigo})`);
    }
    for (const c of cierres) {
      const e = enviados.get(c.ref);
      if (e == null) { malos.push(`${d}-${h}: ${c.ref} nunca salió`); continue; }
      if (e < c.ms) malos.push(`${d}-${h}: ${c.ref} antes de cerrarse`);
      if (e - c.ms > 24 * 3600_000) malos.push(`${d}-${h}: ${c.ref} esperó más de 24 h`);
      if (!ventanaReal && e - c.ms > 10 * 60_000) malos.push(`${d}-${h}: sin horario, ${c.ref} esperó`);
    }
    if (ventanaReal && mensajes >= cierres.length) malos.push(`${d}-${h}: no agrupó (${mensajes} mensajes)`);
  }
  chk("7 ventanas: con horario nada sale fuera de él; sin horario sale en el tick del cierre; todos salen una vez y en < 24 h",
    malos.length === 0, malos.slice(0, 4).join(" | "));
  // El caso reportado, dicho como se vivió.
  const h = H("07:00", "21:00");
  const cierre = lima("2026-10-13", "04:00");
  const marcas = [{ ref: "29812", fecha: fechaLima(cierre) }];
  chk("cerrado a las 04:00: a las 04:00 no le escribe a nadie; a las 07:00 sí",
    planDePendientes({ ahoraMs: cierre, activa: true, horario: h, pendientes: marcas }).enviar.length === 0
    && planDePendientes({ ahoraMs: lima("2026-10-13", "07:00"), activa: true, horario: h, pendientes: marcas }).enviar.length === 1);
}

// ── 4. El mensaje: el de siempre con uno, UNO solo con varios ─────────────────
{
  console.log("\n— Los parámetros de la plantilla —");
  const ahoraMs = lima("2026-10-13", "07:00");
  const s = (x: Partial<ServicioCerrado> = {}): ServicioCerrado => ({
    fecha: "2026-10-11", hora: "22:00", conductor: "Juan Pérez", ruta: "Planta → Ate", cerradoMs: ahoraMs, ...x,
  });
  const uno = paramsAvisoAbandonados([s()], ahoraMs);
  chk("enviado al cerrar: el texto de antes, byte a byte",
    JSON.stringify(uno) === JSON.stringify(["Servicio sin cerrar", "Juan Pérez", "Planta → Ate", 'Quedó "en curso" desde el 2026-10-11. Se cerró automáticamente.']),
    JSON.stringify(uno));
  const esperado = paramsAvisoAbandonados([s({ cerradoMs: lima("2026-10-13", "04:00") })], ahoraMs);
  chk("si esperó, dice a qué hora se cerró", esperado[3].endsWith("Se cerró automáticamente hoy a las 04:00."), esperado[3]);
  const ayer = paramsAvisoAbandonados([s({ cerradoMs: lima("2026-10-12", "22:30") })], ahoraMs);
  chk("…y el día, si fue ayer", ayer[3].endsWith("el 2026-10-12 a las 22:30."), ayer[3]);
  const varios = paramsAvisoAbandonados([
    s({ fecha: "2026-10-11", hora: "22:00", conductor: "B" }), s({ fecha: "2026-10-11", hora: "05:00", conductor: "A" }),
    s({ fecha: "2026-10-10", hora: null, conductor: "C" }),
  ], ahoraMs);
  chk("con tres, UN mensaje que dice cuántos y los lista por fecha y hora",
    varios.length === 4 && varios[1] === "3 servicios" && /: 2026-10-10 C .*· 2026-10-11 05:00 A .*· 2026-10-11 22:00 B /.test(varios[3]), varios[3]);
  const muchos = paramsAvisoAbandonados(Array.from({ length: 80 }, (_, i) => s({ conductor: `Conductor ${i}`, ruta: "Origen largo de prueba → Destino largo de prueba" })), ahoraMs);
  chk(`con 80, la lista no pasa de ${LARGO_LISTA} y dice cuántos más`, muchos[3].length <= LARGO_LISTA && /y \d+ más$/.test(muchos[3]), String(muchos[3].length));
  const raros = paramsAvisoAbandonados([s({ conductor: "  ", ruta: "Ate\n→\tLima    Centro" })], ahoraMs);
  const todos = [uno, esperado, ayer, varios, muchos, raros].flat();
  chk("todo parámetro cumple las reglas de Meta (no vacío, sin saltos ni tabulaciones, sin 4 espacios)",
    todos.every((p) => p.trim() !== "" && !/[\n\t]/.test(p) && !/ {4}/.test(p)), JSON.stringify(raros));
}

// ── 5. La tarjeta y la pantalla dicen lo mismo que el motor ───────────────────
{
  console.log("\n— Tarjeta —");
  const cfg = (x: Partial<CfgTarjeta> = {}): CfgTarjeta => ({ clave: "servicio_abandonado", activo: true, umbral: null, ...x });
  chk("la tarjeta ofrece el horario de CONTACTOS (no el del conductor, que tiene margen de urgencia)",
    controlesDe(cfg()).horario === "contactos" && controlesDe({ clave: "asignacion", activo: true }).horario === "conductor"
    && controlesDe({ clave: "jornada", activo: true }).horario === null);
  const con = descripcionDe(cfg({ respeta_horario: true, horario_desde: "06:41", horario_hasta: "20:13" }), { contactos: () => 1 });
  chk("con horario, la descripción dice SUS horas (no unas escritas)", con.includes("entre las 06:41 y las 20:13") && con.includes("espera a las 06:41"), con);
  const sin = descripcionDe(cfg({ respeta_horario: false, horario_desde: "06:41", horario_hasta: "20:13" }), { contactos: () => 1 });
  chk("sin la casilla, dice que sale al cerrar, también de madrugada", /también de madrugada/.test(sin) && !sin.includes("06:41"), sin);
  const cero = descripcionDe(cfg({ respeta_horario: true, horario_desde: "08:00", horario_hasta: "08:00" }), { contactos: () => 1 });
  chk("con una ventana de longitud cero dice lo que hace el motor: sale al cerrar", /también de madrugada/.test(cero), cero);
  chk("el cierre se dice «a cualquier hora», también apagada",
    /a cualquier hora/.test(sin) && /a cualquier hora/.test(descripcionDe(cfg({ activo: false }), { contactos: () => 1 })));
  const frase = describirHorario(hhmmAMinutos("07:00"), hhmmAMinutos("21:00"), null, { sinUrgencia: true });
  chk("la frase de la pantalla no habla de urgencia ni de «servicio»", !/urgente|servicio/i.test(frase) && frase.includes("07:00") && frase.includes("21:00"), frase);
  const def = ventanaPorDefecto("contactos");
  chk("la ventana propuesta a los contactos no deja escribir de madrugada",
    (() => { for (let m = 0; m <= 300; m++) if (dentroDeVentana(m, hhmmAMinutos(def.desde)!, hhmmAMinutos(def.hasta)!)) return false; return true; })());
}

// ── 6. El tick despacha desde los marcadores, no desde el cierre ──────────────
{
  console.log("\n— El tick —");
  const tick = readFileSync(new URL("../app/api/alertas-flota/tick/route.ts", import.meta.url), "utf8");
  const bloque = tick.slice(tick.indexOf("BLOQUE 7"));
  chk("el cierre deja el marcador y el aviso sale de planDePendientes",
    bloque.includes("CLAVE_ESPERA_ABANDONADO") && bloque.includes("planDePendientes(") && bloque.includes("paramsAvisoAbandonados("));
  chk("no queda el envío directo de antes («Servicio sin cerrar» escrito en el tick)", !bloque.includes('"Servicio sin cerrar"'));
  chk("el reclamo usa la fecha del CIERRE (idempotente aunque salga al día siguiente)",
    /reclamarEnvio\("servicio_abandonado", p\.ref, p\.fecha\)/.test(bloque) && /liberarEnvio\("servicio_abandonado", p\.ref, p\.fecha\)/.test(bloque));
  chk("la clave del marcador no choca con la del reclamo", (CLAVE_ESPERA_ABANDONADO as string) !== "servicio_abandonado");
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
