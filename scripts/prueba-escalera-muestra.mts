// Pruebas de «PROBAR LOS AVISOS» (lib/escalera-muestra.ts): la lista de mensajes que se le
// manda a un número para ver cómo le llegan al conductor que no pulsa INICIAR (y al coordinador).
// NO toca la base ni envía nada.
// Uso:  npx tsx scripts/prueba-escalera-muestra.mts   (sale con código 1 si algo falla)
//
// LO QUE NO SE PUEDE AFLOJAR: cada mensaje de prueba lleva la MISMA plantilla y los MISMOS
// parámetros que su bloque del motor. Los armados del tick y del cron de un minuto están
// copiados LITERAL abajo (`delMotor`): si el motor cambia uno y la muestra no, esta prueba falla.

import {
  IDS_MUESTRA, SQL_ESCALERA, SQL_LLAMADAS, datosDeMuestra, planDeMuestra, telefonoDeMuestra, textoPushPrueba,
  type CfgMuestra, type DatosMuestra, type MensajeMuestra,
} from "../lib/escalera-muestra";
import { LARGO_EVIDENCIA_COORDINADOR } from "../lib/escalera-inicio";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const HOY = "2026-10-11";
const D: DatosMuestra = datosDeMuestra({ nombreUsuario: "Antonio José Pérez García", fecha: HOY, telContingencia: "+51 912 569 005" });

/** La configuración de AFA tal como queda con la escalera de inicio corrida. */
function cfgsAfa(cambios: Partial<Record<string, Partial<CfgMuestra> | null>> = {}): CfgMuestra[] {
  const base: CfgMuestra[] = [
    { clave: "proximo_inicio", activo: true, modo_tiempo: "anticipacion", min_anticipacion: 90, plantilla: "conductor_proximo_inicio", notifica_conductor: true, canal_conductor_whatsapp: true },
    { clave: "recuerda_iniciar", activo: true, modo_tiempo: "anticipacion", min_anticipacion: 30, plantilla: "conductor_recuerda_iniciar", notifica_conductor: true, canal_conductor_whatsapp: true },
    { clave: "alerta_no_inicio_previa", activo: true, modo_tiempo: "anticipacion", min_anticipacion: 25, plantilla: null, plantilla_directorio: null, notifica_conductor: false, contactos: 2, usa_directorio: true },
    { clave: "inicia_ahora", activo: true, modo_tiempo: "anticipacion", min_anticipacion: 5, plantilla: "conductor_recuerda_iniciar", notifica_conductor: true, canal_conductor_whatsapp: true },
    { clave: "en_punto_sin_iniciar", activo: true, modo_tiempo: "evento", umbral: 10, plantilla: "conductor_recuerda_iniciar", plantilla_directorio: "coordinador_alerta", notifica_conductor: true, canal_conductor_whatsapp: true, contactos: 2 },
    { clave: "debio_iniciar", activo: true, modo_tiempo: "evento", umbral: 1, plantilla: "conductor_no_inicio", notifica_conductor: true, canal_conductor_whatsapp: true },
    { clave: "no_inicio", activo: true, modo_tiempo: "evento", umbral: 10, plantilla: "conductor_no_inicio", plantilla_directorio: "coordinador_alerta", notifica_conductor: true, canal_conductor_whatsapp: true, contactos: 2, usa_directorio: true },
    // La llamada de la central propia, como la deja supabase/llamadas-01-central.sql: APAGADA.
    { clave: "llamada_inicio", activo: false, modo_tiempo: "evento", umbral: 3, plantilla: null, notifica_conductor: true, canal_conductor_whatsapp: false, canal_conductor_push: false, contactos: 1, usa_directorio: true } as CfgMuestra,
  ];
  const out: CfgMuestra[] = [];
  for (const c of base) {
    if (c.clave in cambios) {
      const ch = cambios[c.clave];
      if (ch === null) continue;             // la fila no existe
      out.push({ ...c, ...ch });
    } else out.push(c);
  }
  return out;
}

// ── El armado del MOTOR, copiado literal de /api/alertas-flota/tick y /inicio ─────────────
function rutaDe(r: { origen?: string | null; destino?: string | null }): string {
  return [r.origen, r.destino].filter(Boolean).join(" → ") || "Servicio";
}
function delMotor(m: MensajeMuestra, cfg: CfgMuestra, evidencia: string): string[] {
  const r = { origen: D.origen, destino: D.destino };
  const nombre = D.nombre, hora = D.hora, telConting = D.telContingencia;
  switch (m.id) {
    case "proximo_inicio":
    case "recuerda_iniciar": {
      // tick · avisoPreInicio
      const origenTexto = r.origen || rutaDe(r);
      return [nombre, hora, origenTexto];
    }
    case "alerta_no_inicio_previa": {
      const ruta = rutaDe(r);
      return ["Falta iniciar recorrido", nombre, `${ruta} ${hora}`,
        `Faltan ~25 min y el conductor aún no confirma salida (sin GPS) en la app.${evidencia ? ` ${evidencia}` : ""}`];
    }
    case "inicia_ahora":
    case "debio_iniciar": {
      // cron de un minuto
      const origen = r.origen || rutaDe(r);
      return m.id === "inicia_ahora" ? [nombre, hora, origen] : [nombre, hora, rutaDe(r), telConting];
    }
    case "en_punto_sin_iniciar":
      return [nombre, hora, r.origen || rutaDe(r)];
    case "no_inicio": {
      const ruta = rutaDe(r);
      return [nombre, hora, ruta, telConting];
    }
    case "no_inicio:coordinador": {
      const gracia = cfg.umbral ?? 10;
      const ruta = rutaDe(r);
      return ["No inició a tiempo", nombre, `${ruta} ${hora}`,
        `Pasaron ${gracia}+ min de la hora y no marcó inicio.${evidencia ? ` ${evidencia}` : ""}`];
    }
  }
  return [];
}
/** La evidencia que va dentro del último parámetro (o "" si no lleva). */
function evidenciaDe(m: MensajeMuestra): string {
  const ult = m.parametros[m.parametros.length - 1] ?? "";
  const i = ult.indexOf("Avisos al conductor:");
  return i >= 0 ? ult.slice(i) : "";
}

// ── 1. La configuración de AFA ────────────────────────────────────────────────
{
  console.log("\n— La escalera completa, en el orden en que llega —");
  const cfgs = cfgsAfa();
  const plan = planDeMuestra(cfgs, D);
  chk("salen todos los ids, una vez cada uno", plan.length === IDS_MUESTRA.length
    && new Set(plan.map((m) => m.id)).size === IDS_MUESTRA.length && IDS_MUESTRA.every((id) => plan.some((m) => m.id === id)));
  chk("en el orden en que llegan", plan.map((m) => m.id).join(",") ===
    "proximo_inicio,recuerda_iniciar,alerta_no_inicio_previa,inicia_ahora,en_punto_sin_iniciar,debio_iniciar,llamada_inicio,no_inicio,no_inicio:coordinador",
    plan.map((m) => m.id).join(","));
  chk("cuándo llega cada uno", plan.map((m) => m.cuando).join(" | ") ===
    "90 min antes | 30 min antes | 25 min antes | 5 min antes | si el GPS lo ve en el paradero | 1 min después | 3 min después | 10 min después | 10 min después",
    plan.map((m) => m.cuando).join(" | "));
  for (const m of plan.filter((x) => x.canal === "whatsapp")) {
    const cfg = cfgs.find((c) => c.clave === m.clave)!;
    const esperado = delMotor(m, cfg, evidenciaDe(m));
    chk(`${m.id}: los MISMOS parámetros que el motor`, JSON.stringify(m.parametros) === JSON.stringify(esperado),
      JSON.stringify(m.parametros));
    const plantilla = m.para === "conductor" ? cfg.plantilla : (cfg.plantilla_directorio || "coordinador_alerta");
    chk(`${m.id}: la MISMA plantilla`, m.plantilla === plantilla, String(m.plantilla));
  }
  chk("todos los WhatsApp salen hoy menos el de GPS", plan.filter((m) => m.canal === "whatsapp").every((m) => (m.id === "en_punto_sin_iniciar") === (m.codigo !== "sale")));
  const ll = plan.find((m) => m.id === "llamada_inicio")!;
  chk("la llamada nace apagada (como la deja su SQL), sin plantilla, y se puede pedir de prueba",
    ll.canal === "llamada" && ll.codigo === "apagado" && !ll.marcado && ll.enviable && ll.plantilla === null && ll.parametros.length === 0);
  chk("el de GPS se lista pero sale desmarcado", plan.find((m) => m.id === "en_punto_sin_iniciar")!.codigo === "solo_si_gps"
    && !plan.find((m) => m.id === "en_punto_sin_iniciar")!.marcado);

  const coord = plan.find((m) => m.id === "no_inicio:coordinador")!;
  const ev = evidenciaDe(coord);
  chk("al coordinador le llega la evidencia de lo que ya se le mandó", ev.startsWith("Avisos al conductor:")
    && ["Recuerda iniciar", "Inicia ahora", "Ya debió iniciar", "No inició"].every((t) => ev.includes(t)), ev);
  chk("…con el aviso de este mismo peldaño recién enviado, completo (sin confirmar entrega)",
    /No inició 06:40 WhatsApp sin confirmar entrega\.$/.test(ev), ev);
  chk("…y los anteriores entregados", /Inicia ahora 06:25 WhatsApp entregado sin leer/.test(ev), ev);
  chk("con los cinco peldaños no cabe: se quita el MÁS ANTIGUO y se dice cuántos", /^Avisos al conductor: 1 anterior · Recuerda iniciar/.test(ev), ev);
  chk("la evidencia respeta el largo del motor", ev.length <= LARGO_EVIDENCIA_COORDINADOR, String(ev.length));
  const previa = plan.find((m) => m.id === "alerta_no_inicio_previa")!;
  const evPrevia = evidenciaDe(previa);
  chk("la alerta previa (25 min antes) solo cuenta lo que ya salió a esa hora", evPrevia.includes("Próximo a iniciar")
    && evPrevia.includes("Recuerda iniciar") && !evPrevia.includes("Inicia ahora"), evPrevia);
}

// ── 1b. La llamada encendida ──────────────────────────────────────────────────
{
  console.log("\n— Con la llamada de la central encendida —");
  const plan = planDeMuestra(cfgsAfa({ recuerda_iniciar: { activo: false }, llamada_inicio: { activo: true } }), D);
  const ll = plan.find((m) => m.id === "llamada_inicio")!;
  chk("sale y va marcada, con su nota (depende de la central)", ll.codigo === "sale" && ll.marcado && /central/.test(ll.nota), ll.nota);
  const ev = evidenciaDe(plan.find((m) => m.id === "no_inicio:coordinador")!);
  chk("al coordinador le llega también la llamada, al final y entera", ev.endsWith("Llamada 06:36: no contestó (2 intentos)."), ev);
  chk("…con lo que se le mandó por WhatsApp delante", /Avisos al conductor: .*Ya debió iniciar 06:31/.test(ev), ev);
  chk("…dentro del largo del motor", ev.length <= LARGO_EVIDENCIA_COORDINADOR, String(ev.length));
  const previa = evidenciaDe(plan.find((m) => m.id === "alerta_no_inicio_previa")!);
  chk("la alerta previa (antes de la llamada) no la menciona", !previa.includes("Llamada"), previa);
  const sinTabla = planDeMuestra(cfgsAfa({ llamada_inicio: null }), D).find((m) => m.id === "llamada_inicio")!;
  chk("sin su SQL se nombra y no se puede pedir", sinTabla.codigo === "sin_config" && !sinTabla.enviable && sinTabla.nota.includes(SQL_LLAMADAS));
  const sinCond = planDeMuestra(cfgsAfa({ llamada_inicio: { activo: true, notifica_conductor: false } }), D).find((m) => m.id === "llamada_inicio")!;
  chk("con «Conductor» desmarcado no le sale", sinCond.codigo === "no_al_conductor");
}

// ── 2. «Como está»: lo apagado se ve apagado ──────────────────────────────────
{
  console.log("\n— El aviso de 30 min apagado (decisión del dueño, 11-10-2026) —");
  const plan = planDeMuestra(cfgsAfa({ recuerda_iniciar: { activo: false } }), D);
  const r30 = plan.find((m) => m.id === "recuerda_iniciar")!;
  chk("se lista APAGADO y desmarcado", r30.codigo === "apagado" && !r30.marcado);
  chk("…pero se puede mandar como vista previa de su texto", r30.enviable && r30.parametros.length === 3);
  const ev = evidenciaDe(plan.find((m) => m.id === "no_inicio:coordinador")!);
  chk("y no aparece en la evidencia del coordinador (no se le mandó)", !ev.includes("Recuerda iniciar") && ev.includes("Inicia ahora"), ev);
  chk("con cuatro peldaños la evidencia cabe ENTERA (el primero, leído)", ev.startsWith("Avisos al conductor: Próximo a iniciar 05:00 WhatsApp leído 05:02")
    && ev.endsWith("No inició 06:40 WhatsApp sin confirmar entrega."), ev);
}

// ── 3. Sin la migración de la escalera ────────────────────────────────────────
{
  console.log("\n— Sin las filas de supabase/alertas-escalera-inicio.sql —");
  const plan = planDeMuestra(cfgsAfa({ inicia_ahora: null, debio_iniciar: null }), D);
  for (const id of ["inicia_ahora", "debio_iniciar"]) {
    const m = plan.find((x) => x.id === id)!;
    chk(`${id}: se nombra el SQL que falta y no se puede mandar`, m.codigo === "sin_config" && !m.enviable && !m.marcado
      && m.nota.includes(SQL_ESCALERA) && m.parametros.length === 0, m.nota);
  }
  chk("el orden no se rompe (siguen en su minuto por defecto)", plan.findIndex((m) => m.id === "inicia_ahora") < plan.findIndex((m) => m.id === "debio_iniciar"));
}

// ── 4. Lo que hace que un aviso no salga ──────────────────────────────────────
{
  console.log("\n— Cada motivo, con su código —");
  const de = (cambios: Parameters<typeof cfgsAfa>[0], id: string) => planDeMuestra(cfgsAfa(cambios), D).find((m) => m.id === id)!;
  chk("modo «Al ocurrir» en un pre-inicio → mudo", de({ proximo_inicio: { modo_tiempo: "evento" } }, "proximo_inicio").codigo === "mudo");
  const hf = de({ proximo_inicio: { modo_tiempo: "hora_fija", hora_fija: "05:15" } }, "proximo_inicio");
  chk("a una hora fija → «a las HH:MM» y ordenado por esa hora", hf.cuando === "a las 05:15" && hf.minuto === -75, `${hf.cuando} ${hf.minuto}`);
  chk("sin WhatsApp al conductor → sin_whatsapp", de({ inicia_ahora: { canal_conductor_whatsapp: false } }, "inicia_ahora").codigo === "sin_whatsapp");
  chk("la tarjeta no le escribe al conductor → no_al_conductor", de({ debio_iniciar: { notifica_conductor: false } }, "debio_iniciar").codigo === "no_al_conductor");
  chk("al coordinador sin contactos → sin_contactos", de({ no_inicio: { contactos: 0 } }, "no_inicio:coordinador").codigo === "sin_contactos");
  chk("con «usa_directorio» apagado → sin_contactos", de({ no_inicio: { usa_directorio: false } }, "no_inicio:coordinador").codigo === "sin_contactos");
  chk("sin plantilla en el conductor → sin_plantilla y no se puede mandar", (() => {
    const m = de({ inicia_ahora: { plantilla: null } }, "inicia_ahora");
    return m.codigo === "sin_plantilla" && !m.enviable;
  })());
  chk("al coordinador sin plantilla propia usa coordinador_alerta, como el tick",
    de({ no_inicio: { plantilla_directorio: null } }, "no_inicio:coordinador").plantilla === "coordinador_alerta");
  chk("el umbral de «no inició» se cuenta en su texto", de({ no_inicio: { umbral: 15 } }, "no_inicio:coordinador").parametros[3].startsWith("Pasaron 15+ min"));
  const d3 = de({ debio_iniciar: { umbral: 3 } }, "debio_iniciar");
  chk("el «ya debió iniciar» lleva su umbral", d3.cuando === "3 min después" && d3.minuto === 3);
}

// ── 5. Invariantes, por barrido ────────────────────────────────────────────────
{
  console.log("\n— Barrido de configuraciones —");
  let s = 20261011;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const uno = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  let casos = 0, malos = 0, primero = "";
  for (let i = 0; i < 4000; i++) {
    const cambios: Record<string, Partial<CfgMuestra> | null> = {};
    for (const clave of ["proximo_inicio", "recuerda_iniciar", "alerta_no_inicio_previa", "inicia_ahora", "en_punto_sin_iniciar", "debio_iniciar", "no_inicio", "llamada_inicio"]) {
      if (rnd() < 0.1) { cambios[clave] = null; continue; }
      cambios[clave] = {
        activo: uno([true, false]),
        modo_tiempo: uno(["anticipacion", "evento", "hora_fija", null]),
        hora_fija: uno(["05:00", null, "25:99"]),
        min_anticipacion: uno([null, 0, 5, 90, -3]),
        umbral: uno([null, 0, 1, 10]),
        plantilla: uno(["tpl_x", null, ""]),
        plantilla_directorio: uno(["coordinador_alerta", null]),
        notifica_conductor: uno([true, false, null]),
        canal_conductor_whatsapp: uno([true, false, null]),
        usa_directorio: uno([true, false, null]),
        contactos: uno([0, 1, 3, null]),
      };
    }
    const plan = planDeMuestra(cfgsAfa(cambios), D);
    casos++;
    const problemas: string[] = [];
    if (new Set(plan.map((m) => m.id)).size !== IDS_MUESTRA.length) problemas.push("ids");
    for (const m of plan) {
      if (m.marcado !== (m.codigo === "sale")) problemas.push(`${m.id}: marcado ⟺ sale`);
      if (m.marcado && !m.enviable) problemas.push(`${m.id}: marcado sin poder mandarse`);
      if (m.canal === "whatsapp" && m.enviable !== !!m.plantilla) problemas.push(`${m.id}: enviable ⟺ plantilla`);
      if (m.canal === "llamada" && (m.plantilla !== null || m.parametros.length > 0 || m.enviable !== (m.codigo !== "sin_config"))) problemas.push(`${m.id}: la llamada no es una plantilla`);
      if (m.codigo === "sin_config" && (m.enviable || m.parametros.length)) problemas.push(`${m.id}: sin_config mandable`);
      if (m.enviable) {
        for (const p of m.parametros) {
          // Reglas de Meta para un parámetro de plantilla: no vacío, sin saltos ni tabulaciones,
          // sin 4 espacios seguidos.
          if (!p.trim() || /[\r\n\t]/.test(p) || / {4,}/.test(p) || p.length > 1024) problemas.push(`${m.id}: parámetro inválido «${p}»`);
        }
      }
      if (!Number.isFinite(m.minuto)) problemas.push(`${m.id}: minuto`);
    }
    for (let k = 1; k < plan.length; k++) if (plan[k].minuto < plan[k - 1].minuto) problemas.push("orden");
    if (problemas.length) { malos++; if (!primero) primero = problemas[0]; }
  }
  chk(`${casos} configuraciones: marcado ⟺ sale, enviable ⟺ plantilla (WhatsApp), parámetros válidos para Meta, orden por minuto`, malos === 0, primero);
}

// ── 6. El número de prueba ────────────────────────────────────────────────────
{
  console.log("\n— El número —");
  const ok = (raw: string, e164: string) => { const t = telefonoDeMuestra(raw); return t.ok && t.e164 === e164; };
  chk("9 dígitos", ok("997683199", "+51997683199"));
  chk("con espacios y +51", ok("+51 997 683 199", "+51997683199"));
  chk("51 sin +", ok("51997683199", "+51997683199"));
  chk("se enseña separado", (() => { const t = telefonoDeMuestra("997683199"); return t.ok && t.visible === "+51 997 683 199"; })());
  for (const malo of ["", "12345", "0997683199", "197683199", "+1 415 555 0100", "5199768319", "abc"]) {
    chk(`rechaza «${malo}»`, !telefonoDeMuestra(malo).ok);
  }
}

// ── 7. Los datos de ejemplo y la notificación de prueba ───────────────────────
{
  console.log("\n— Datos de ejemplo y notificación de prueba —");
  chk("el nombre es el de quien prueba, corto", D.nombre === "Antonio José", D.nombre);
  chk("sin nombre → «Conductor»", datosDeMuestra({ nombreUsuario: null, fecha: HOY, telContingencia: "x" }).nombre === "Conductor");
  chk("el punto de salida dice que es de prueba", /prueba/i.test(D.origen) && /prueba/i.test(D.destino));
  const t = textoPushPrueba();
  chk("la notificación de prueba dice que es prueba y pide INICIAR", /prueba/i.test(t.titulo) && /INICIAR/.test(t.cuerpo) && /prueba/i.test(t.cuerpo));
  chk("…sale urgente, se queda en pantalla y vive poco", t.requireInteraction && t.ttl > 0 && t.ttl <= 900);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
