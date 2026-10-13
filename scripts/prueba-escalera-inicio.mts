// Pruebas de LA ESCALERA DE INICIO (lib/escalera-inicio.ts): qué aviso le toca al conductor
// que todavía no pulsó «Iniciar», cuándo, y cómo se lee después si le llegó.
// NO toca la base: todo en memoria, con el reloj pasado por parámetro.
// Uso:  npx tsx scripts/prueba-escalera-inicio.mts   (sale con código 1 si algo falla)
//
// EL CASO REAL VA DENTRO (reserva #29812, servicio hecho sin abrir el app): la sección 1
// demuestra por qué el «5 min antes» no podía vivir en el tick de 10 min — con su ventana de
// 5 minutos, la mitad de los desfases del cron no la tocan nunca y el aviso no sale. Si eso
// deja de reproducirse, el escenario dejó de ser el que motivó el cron de 1 minuto.

import {
  CLAVES_ESCALERA, CLAVE_DEBIO_INICIAR, CLAVE_INICIA_AHORA, ETIQUETA_AVISO, VENTANA_DEBIO_MIN,
  estadoEntrega, inicioDe, juzgarDebioIniciar, juzgarIniciaAhora, pasosQueTocan,
  reclamosSinDetalle, resumenAvisosConductor, textoPushInicio, type CfgPaso, type FilaAviso,
} from "../lib/escalera-inicio";
import { VIA_DE_ALERTA, leeElModo } from "../lib/alertas-modo-tiempo";
import { detalleAlertaPrevia, listaEnUnaLinea, noInicioRepiteDebio } from "../lib/escalera-inicio";
import { estadosAOperaciones } from "../lib/entrega-whatsapp";
import { limaAUtcMs } from "../lib/alertas-horario";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const HOY = "2026-10-11";
const MANANA = "2026-10-12";
const reloj = (hhmm: string, fecha = HOY) => ({ ahoraMs: limaAUtcMs(fecha, hhmm)!, hoy: HOY, manana: MANANA });
const relojMs = (ms: number) => ({ ahoraMs: ms, hoy: HOY, manana: MANANA });

const CFG_AHORA: CfgPaso = { activo: true, modo_tiempo: "anticipacion", min_anticipacion: 5 };
const CFG_DEBIO: CfgPaso = { activo: true, modo_tiempo: "evento", umbral: 1 };
const SERV = { estado: "programada", fecha_servicio: HOY, hora_servicio: "06:30:00" };

// ── 1. Por qué hace falta el cron de 1 minuto ─────────────────────────────────
{
  console.log("\n— El «5 min antes» con el tick de 10 min (el defecto) y con el cron de 1 min —");
  const inicio = inicioDe(SERV)!;
  // Un cron cada N minutos que arranca con un desfase d: ¿algún disparo cae en la ventana?
  const alcanza = (cada: number, desfase: number) => {
    for (let t = inicio - 90 * 60_000 + desfase * 60_000; t < inicio + 30 * 60_000; t += cada * 60_000) {
      if (juzgarIniciaAhora(SERV, CFG_AHORA, relojMs(t)) === "toca") return true;
    }
    return false;
  };
  const con10 = Array.from({ length: 10 }, (_, d) => alcanza(10, d));
  const perdidos10 = con10.filter((x) => !x).length;
  chk("con el tick de 10 min, la mitad de los desfases NO tocan la ventana (el defecto)", perdidos10 === 5, `${perdidos10}/10 sin aviso`);
  chk("con el cron de 1 min, siempre la toca", alcanza(1, 0));
}

// ── 2. La ventana de cada peldaño ─────────────────────────────────────────────
{
  console.log("\n— «Inicia ahora»: de 5 min antes hasta la hora —");
  chk("06:24 → aún no", juzgarIniciaAhora(SERV, CFG_AHORA, reloj("06:24")) === "aun_no");
  chk("06:25 → toca", juzgarIniciaAhora(SERV, CFG_AHORA, reloj("06:25")) === "toca");
  chk("06:29 → toca", juzgarIniciaAhora(SERV, CFG_AHORA, reloj("06:29")) === "toca");
  chk("06:30 → pasó la ventana", juzgarIniciaAhora(SERV, CFG_AHORA, reloj("06:30")) === "paso_la_ventana");
  chk("sin minutos declarados usa 5", juzgarIniciaAhora(SERV, { activo: true, modo_tiempo: "anticipacion" }, reloj("06:25")) === "toca"
    && juzgarIniciaAhora(SERV, { activo: true, modo_tiempo: "anticipacion" }, reloj("06:24")) === "aun_no");

  console.log("\n— «Ya debió iniciar»: desde la hora + 1 durante la ventana —");
  chk("06:30 → aún no", juzgarDebioIniciar(SERV, CFG_DEBIO, reloj("06:30")) === "aun_no");
  chk("06:31 → toca", juzgarDebioIniciar(SERV, CFG_DEBIO, reloj("06:31")) === "toca");
  chk(`06:${30 + VENTANA_DEBIO_MIN} → toca (último minuto)`, juzgarDebioIniciar(SERV, CFG_DEBIO, reloj(`06:${30 + VENTANA_DEBIO_MIN}`)) === "toca");
  chk(`06:${31 + VENTANA_DEBIO_MIN} → venció`, juzgarDebioIniciar(SERV, CFG_DEBIO, reloj(`06:${31 + VENTANA_DEBIO_MIN}`)) === "paso_la_ventana");
  chk("umbral 0 → desde la hora exacta", juzgarDebioIniciar(SERV, { activo: true, umbral: 0 }, reloj("06:30")) === "toca");
  chk("sin umbral usa 1", juzgarDebioIniciar(SERV, { activo: true }, reloj("06:30")) === "aun_no"
    && juzgarDebioIniciar(SERV, { activo: true }, reloj("06:31")) === "toca");
}

// ── 3. Lo que NO dispara ──────────────────────────────────────────────────────
{
  console.log("\n— Solo mientras el servicio siga sin iniciar, y con hora —");
  for (const estado of ["en_curso", "finalizada", "cancelada", "pendiente", null]) {
    const s = { ...SERV, estado };
    chk(`${estado ?? "sin estado"}: no dispara ninguno`,
      juzgarIniciaAhora(s, CFG_AHORA, reloj("06:27")) === "fuera_de_estado"
      && juzgarDebioIniciar(s, CFG_DEBIO, reloj("06:32")) === "fuera_de_estado");
  }
  chk("confirmada sí dispara", juzgarIniciaAhora({ ...SERV, estado: "confirmada" }, CFG_AHORA, reloj("06:27")) === "toca");
  // Sin hora, el tick ancla a las 00:00 y mandaría «inicia ahora» a las 23:55 de la víspera.
  for (const hora of [null, "", "25:00", "no"]) {
    chk(`hora ${JSON.stringify(hora)}: sin_hora, nunca a medianoche`,
      juzgarIniciaAhora({ ...SERV, hora_servicio: hora }, CFG_AHORA, reloj("23:57", "2026-10-10")) === "sin_hora"
      && juzgarDebioIniciar({ ...SERV, hora_servicio: hora }, CFG_DEBIO, reloj("00:02")) === "sin_hora");
  }
  chk("apagado: no dispara", juzgarIniciaAhora(SERV, { ...CFG_AHORA!, activo: false }, reloj("06:27")) === "apagado"
    && juzgarDebioIniciar(SERV, null, reloj("06:32")) === "apagado");
}

// ── 4. Cruce de medianoche ────────────────────────────────────────────────────
{
  console.log("\n— Un servicio de las 00:02 de mañana —");
  const s = { estado: "programada", fecha_servicio: MANANA, hora_servicio: "00:02" };
  chk("a las 23:58 de hoy toca «inicia ahora»", juzgarIniciaAhora(s, CFG_AHORA, reloj("23:58")) === "toca");
  chk("a las 00:03 de mañana toca «ya debió iniciar»",
    juzgarDebioIniciar(s, CFG_DEBIO, { ahoraMs: limaAUtcMs(MANANA, "00:03")!, hoy: MANANA, manana: "2026-10-13" }) === "toca");
}

// ── 5. Barrido: los dos peldaños nunca se pisan y siempre caen en su lugar ────
{
  console.log("\n— Barrido de un día entero × horas de servicio × configuraciones —");
  let errores = 0, tocaAhora = 0, tocaDebio = 0, choques = 0;
  const horas = ["00:00", "00:04", "05:10", "06:30", "12:00", "18:45", "23:55", "23:59"];
  const cfgsAhora: CfgPaso[] = [CFG_AHORA, { activo: true, modo_tiempo: "anticipacion", min_anticipacion: 1 }, { activo: true, modo_tiempo: "anticipacion", min_anticipacion: 15 }];
  const cfgsDebio: CfgPaso[] = [CFG_DEBIO, { activo: true, umbral: 0 }, { activo: true, umbral: 3 }];
  for (const hora of horas) for (const ca of cfgsAhora) for (const cd of cfgsDebio) {
    const s = { estado: "programada", fecha_servicio: HOY, hora_servicio: hora };
    const inicio = inicioDe(s)!;
    for (let t = limaAUtcMs(HOY, "00:00")! - 60 * 60_000; t < limaAUtcMs(MANANA, "01:00")!; t += 60_000) {
      const r = relojMs(t);
      const pasos = pasosQueTocan(s, { iniciaAhora: ca, debioIniciar: cd }, r);
      const a = pasos.includes(CLAVE_INICIA_AHORA), d = pasos.includes(CLAVE_DEBIO_INICIAR);
      if (a) tocaAhora++;
      if (d) tocaDebio++;
      if (a && d) choques++;
      const mA = Number(ca!.min_anticipacion), mD = Number(cd!.umbral);
      if (a && !(t >= inicio - mA * 60_000 && t < inicio)) errores++;
      if (d && !(t >= inicio + mD * 60_000 && t < inicio + (mD + VENTANA_DEBIO_MIN) * 60_000)) errores++;
    }
  }
  chk("ningún disparo fuera de su ventana", errores === 0, `${errores} errores`);
  chk("los dos peldaños nunca tocan en el mismo minuto", choques === 0, `${choques}`);
  // Corolario: un motor que no disparara nunca cumpliría lo anterior de forma trivial.
  chk("y sí disparan (no es un motor mudo)", tocaAhora > 0 && tocaDebio > 0, `${tocaAhora} / ${tocaDebio}`);
}

// ── 6. ¿Le llegó? ─────────────────────────────────────────────────────────────
{
  console.log("\n— Estado de entrega: nunca se afirma «lo ignoró» —");
  const base: FilaAviso = { tipo: "whatsapp", estado: "enviado", created_at: "2026-10-11T11:25:00Z" };
  chk("leído", estadoEntrega({ ...base, entregado_en: "2026-10-11T11:25:03Z", leido_en: "2026-10-11T11:26:00Z" }).codigo === "leido");
  chk("leído lleva su hora Lima", estadoEntrega({ ...base, leido_en: "2026-10-11T11:26:00Z" }).texto === "Leído 06:26");
  const ent = estadoEntrega({ ...base, entregado_en: "2026-10-11T11:25:03Z" });
  chk("entregado: dice que falta confirmación, no que lo ignoró", ent.codigo === "entregado" && /sin confirmación de lectura/.test(ent.texto) && !/ignor/i.test(ent.texto), ent.texto);
  chk("fallo de entrega de Meta", estadoEntrega({ ...base, fallo_entrega: "131026: Message undeliverable" }).codigo === "fallo");
  chk("error al enviar", estadoEntrega({ ...base, estado: "error", error_detalle: "token" }).codigo === "error");
  chk("sin datos de entrega: enviado", estadoEntrega(base).codigo === "enviado");
  chk("push: enviado al app", estadoEntrega({ tipo: "push", estado: "enviado" }).texto === "Notificación enviada al app");
  chk("sin canal no se presenta como enviado", estadoEntrega({ tipo: "whatsapp", estado: "sin_canal" }).codigo === "sin_canal");

  console.log("\n— Resumen para el coordinador —");
  const ahora = Date.parse("2026-10-11T11:40:00Z");
  const filas: FilaAviso[] = [
    { tipo: "push", estado: "enviado", alerta_clave: "inicia_ahora", created_at: "2026-10-11T11:25:01Z", entregado_en: null, leido_en: null },
    { tipo: "whatsapp", estado: "enviado", alerta_clave: "inicia_ahora", created_at: "2026-10-11T11:25:00Z", entregado_en: "2026-10-11T11:25:04Z", leido_en: null },
    { tipo: "whatsapp", estado: "enviado", alerta_clave: "recuerda_iniciar", created_at: "2026-10-11T11:00:00Z", entregado_en: "2026-10-11T11:00:02Z", leido_en: "2026-10-11T11:02:00Z" },
    { tipo: "whatsapp", estado: "enviado", alerta_clave: "recordatorio_conductor", created_at: "2026-10-10T23:30:00Z" },
  ];
  const r = resumenAvisosConductor(filas, ahora);
  chk("en orden de envío, uno por aviso", r.texto.indexOf("Recuerda iniciar") < r.texto.indexOf("Inicia ahora") && (r.texto.match(/Inicia ahora/g) ?? []).length === 1, r.texto);
  chk("el WhatsApp manda sobre el push del mismo aviso", /Inicia ahora 06:25 WhatsApp entregado sin leer/.test(r.texto), r.texto);
  chk("lo leído lleva su hora", /Recuerda iniciar 06:00 WhatsApp leído 06:02/.test(r.texto), r.texto);
  chk("solo la escalera (no el recordatorio de la víspera)", !/recordatorio/i.test(r.texto));
  chk("una sola línea", !/[\r\n\t]/.test(r.texto));
  chk("con algo entregado, no dice que no le llega", !r.sinEntregar);

  const nada = resumenAvisosConductor([
    { tipo: "whatsapp", estado: "enviado", alerta_clave: "recuerda_iniciar", created_at: "2026-10-11T11:00:00Z", entregado_en: null, leido_en: null },
    { tipo: "whatsapp", estado: "enviado", alerta_clave: "inicia_ahora", created_at: "2026-10-11T11:25:00Z", entregado_en: null, leido_en: null },
  ], ahora);
  chk("ningún WhatsApp entregado → «teléfono sin datos o apagado, llámalo»", nada.sinEntregar && /llámalo/.test(nada.texto), nada.texto);
  const reciente = resumenAvisosConductor([
    { tipo: "whatsapp", estado: "enviado", alerta_clave: "inicia_ahora", created_at: "2026-10-11T11:39:30Z", entregado_en: null, leido_en: null },
  ], ahora);
  chk("un WhatsApp de hace 30 s todavía no se juzga", !reciente.sinEntregar);
  const sinColumnas = resumenAvisosConductor([
    { tipo: "whatsapp", estado: "enviado", alerta_clave: "inicia_ahora", created_at: "2026-10-11T11:25:00Z" },
  ], ahora);
  chk("sin las columnas de la migración no se afirma que no le llega", !sinColumnas.conEstados && !sinColumnas.sinEntregar);
  chk("sin avisos: texto vacío", resumenAvisosConductor([], ahora).texto === "");
  const largo = resumenAvisosConductor(Array.from({ length: 30 }, (_, i) => ({
    tipo: "whatsapp", estado: "enviado", alerta_clave: CLAVES_ESCALERA[i % CLAVES_ESCALERA.length],
    created_at: `2026-10-11T1${i % 10}:00:00Z`, entregado_en: null, leido_en: null,
  })), ahora, 120);
  chk("se recorta al largo pedido", largo.texto.length <= 120, `${largo.texto.length}`);

  // EL DEFECTO QUE ENCONTRÓ LA PRUEBA DE AVISOS: recortar por el final se comía la conclusión
  // «ningún WhatsApp le llegó… llámalo», que aparece justo cuando la escalera es LARGA. Ahora se
  // quitan los avisos más antiguos (diciendo cuántos) y la conclusión y el último quedan enteros.
  const escalera = ["proximo_inicio", "recuerda_iniciar", "inicia_ahora", "debio_iniciar", "no_inicio"];
  const horas = ["10:00", "11:00", "11:25", "11:31", "11:40"];
  const sinDatos = resumenAvisosConductor(escalera.map((k, i) => ({
    tipo: "whatsapp", estado: "enviado", alerta_clave: k,
    created_at: `2026-10-11T${horas[i]}:00Z`, entregado_en: null, leido_en: null,
  })), Date.parse("2026-10-11T11:45:00Z"), 260);
  chk("escalera larga sin entregar: la conclusión «llámalo» SIEMPRE llega entera", sinDatos.sinEntregar
    && sinDatos.texto.endsWith("Ningún WhatsApp le llegó: teléfono sin datos o apagado, llámalo."), sinDatos.texto);
  chk("…con el último aviso completo", /No inició 06:40 WhatsApp sin confirmar entrega\. Ningún/.test(sinDatos.texto), sinDatos.texto);
  chk("…y lo que se quitó, contado (los más antiguos)", /^Avisos al conductor: \d+ anteriores? · /.test(sinDatos.texto)
    && !sinDatos.texto.includes("Próximo a iniciar"), sinDatos.texto);
  chk("…dentro del largo", sinDatos.texto.length <= 260, `${sinDatos.texto.length}`);
  const corto = resumenAvisosConductor(escalera.slice(0, 2).map((k, i) => ({
    tipo: "whatsapp", estado: "enviado", alerta_clave: k,
    created_at: `2026-10-11T${horas[i]}:00Z`, entregado_en: `2026-10-11T${horas[i]}:05Z`, leido_en: null,
  })), Date.parse("2026-10-11T11:45:00Z"), 260);
  chk("si cabe, no se quita nada", corto.texto.startsWith("Avisos al conductor: Próximo a iniciar"), corto.texto);
}

// ── 7. Intentos viejos sin detalle ────────────────────────────────────────────
{
  console.log("\n— Los reclamos de alerta_enviada sin fila de registro se muestran, no se callan —");
  const reclamos = [
    { clave: "recuerda_iniciar", created_at: "2026-10-11T11:00:00Z" },
    { clave: "proximo_inicio", created_at: "2026-10-11T10:00:00Z" },
    { clave: "riesgo_retraso", created_at: "2026-10-11T11:10:00Z" },
    { clave: "inicia_ahora", created_at: "2026-10-11T11:25:00Z" },
  ];
  const sin = reclamosSinDetalle(reclamos, [{ alerta_clave: "inicia_ahora", tipo: "whatsapp" }]);
  chk("salen los de la escalera sin registro, en orden", sin.map((x) => x.clave).join(",") === "proximo_inicio,recuerda_iniciar", sin.map((x) => x.clave).join(","));
  chk("los que no son de la escalera no", !sin.some((x) => x.clave === "riesgo_retraso"));
}

// ── 8. Notificación del app ───────────────────────────────────────────────────
{
  console.log("\n— Push: cada peldaño dice la hora, el punto y la orden —");
  for (const clave of CLAVES_ESCALERA) {
    const t = textoPushInicio(clave, { hora: "06:30:00", origen: "CD OSLO", minutos: 5 });
    chk(`${clave}: con hora y orden`, /06:30/.test(t.titulo + t.cuerpo) && /INICIA/.test(t.titulo + t.cuerpo) && t.ttl > 0, `${t.titulo} | ${t.cuerpo}`);
  }
  chk("«inicia ahora» se queda en pantalla", textoPushInicio(CLAVE_INICIA_AHORA, { hora: "06:30" }).requireInteraction);
  chk("«ya debió iniciar» se queda en pantalla", textoPushInicio(CLAVE_DEBIO_INICIAR, { hora: "06:30" }).requireInteraction);
  chk("«inicia ahora» dice los minutos", /en 5 min/.test(textoPushInicio(CLAVE_INICIA_AHORA, { hora: "06:30", minutos: 5 }).titulo));
}

// ── 9. Coherencia con la tabla del panel ──────────────────────────────────────
{
  console.log("\n— Las claves nuevas existen para /configuracion/operaciones —");
  chk("toda la escalera está en la tabla de modos", CLAVES_ESCALERA.every((k) => !!VIA_DE_ALERTA[k]));
  chk("y tiene etiqueta", CLAVES_ESCALERA.every((k) => !!ETIQUETA_AVISO[k]));
  chk("«inicia ahora» ofrece el selector de minutos", leeElModo(CLAVE_INICIA_AHORA));
  chk("«ya debió iniciar» no (su reloj es la hora del servicio)", !leeElModo(CLAVE_DEBIO_INICIAR));
}

// ── 10. Estados de Meta → registro ────────────────────────────────────────────
{
  console.log("\n— Webhook: entregado / leído / falló —");
  const ops = estadosAOperaciones([
    { id: "wamid.A", status: "sent", timestamp: "1760181900" },
    { id: "wamid.A", status: "delivered", timestamp: "1760181905" },
    { id: "wamid.A", status: "read", timestamp: "1760182000" },
    { id: "wamid.B", status: "read", timestamp: "1760182100" },              // sin delivered
    { id: "wamid.C", status: "delivered", timestamp: "1760182300" },
    { id: "wamid.C", status: "delivered", timestamp: "1760182200" },          // reintento más viejo
    { id: "wamid.D", status: "failed", errors: [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable" }] },
    { id: "", status: "delivered" },
    { status: "read" },
  ], Date.parse("2026-10-11T12:00:00Z"));
  const de = (w: string, c: string) => ops.filter((o) => o.wamid === w && o.campo === c);
  chk("«sent» no escribe nada", !ops.some((o) => o.wamid === "wamid.A" && o.campo === "fallo_entrega"));
  chk("delivered + read → las dos fechas", de("wamid.A", "entregado_en").length === 1 && de("wamid.A", "leido_en").length === 1);
  chk("read sin delivered rellena el entregado", de("wamid.B", "entregado_en")[0]?.valor === de("wamid.B", "leido_en")[0]?.valor);
  chk("con dos delivered se queda el más temprano", de("wamid.C", "entregado_en").length === 1
    && de("wamid.C", "entregado_en")[0].valor === new Date(1760182200 * 1000).toISOString());
  chk("las fechas solo se escriben si estaban vacías", ops.filter((o) => o.campo !== "fallo_entrega").every((o) => o.soloSiVacio));
  chk("failed guarda código y motivo sin repetir", de("wamid.D", "fallo_entrega")[0]?.valor === "131026 · Message undeliverable",
    de("wamid.D", "fallo_entrega")[0]?.valor);
  chk("sin id no se escribe nada", ops.every((o) => !!o.wamid));
  let lanza = false, raro: ReturnType<typeof estadosAOperaciones> = [];
  try { raro = estadosAOperaciones([{ id: "w", status: "read", timestamp: "1e20" }], Date.parse("2026-10-11T12:00:00Z")); } catch { lanza = true; }
  chk("un timestamp absurdo no lanza: cae a «ahora»", !lanza && raro.length === 2 && raro.every((o) => o.valor === "2026-10-11T12:00:00.000Z"));
}

// ── Revisión del 13-10-2026 ───────────────────────────────────────────────────
{
  console.log("\n— «No inició» no le repite al conductor el «Ya debió iniciar» —");
  const debio = { activo: true, notifica_conductor: true, notifica_conductor_tercero: false };
  chk("propio con «Ya debió iniciar» encendido → no se le repite", noInicioRepiteDebio(debio, false));
  chk("tercerizado sin «Incluir tercerizados» en «Ya debió iniciar» → SÍ recibe «No inició»", !noInicioRepiteDebio(debio, true));
  chk("tercerizado con la casilla → no se le repite", noInicioRepiteDebio({ ...debio, notifica_conductor_tercero: true }, true));
  chk("«Ya debió iniciar» apagado → «No inició» sale", !noInicioRepiteDebio({ ...debio, activo: false }, false));
  chk("«Ya debió iniciar» sin «Conductor» → «No inició» sale", !noInicioRepiteDebio({ ...debio, notifica_conductor: false }, false));
  chk("sin fila de «Ya debió iniciar» → «No inició» sale", !noInicioRepiteDebio(null, false));

  console.log("\n— Alerta previa: los minutos de verdad, sin «(sin GPS)» —");
  const t = detalleAlertaPrevia(30, "");
  chk("dice los minutos que faltan", t.startsWith("Faltan 30 min"), t);
  chk("nombra el botón real", t.includes("INICIAR RECORRIDO") && !t.includes("sin GPS"), t);
  chk("nunca minutos negativos ni decimales", detalleAlertaPrevia(-3.4, "").startsWith("Faltan 0 min") && detalleAlertaPrevia(19.6, "").startsWith("Faltan 20 min"));
  chk("la evidencia va al final", detalleAlertaPrevia(25, "Avisos al conductor: x.").endsWith(" Avisos al conductor: x."));

  console.log("\n— Una sola línea para el coordinador —");
  chk("une con « · »", listaEnUnaLinea(["06:30 Juan (RUTA A)", "06:35 Pedro (RUTA B)"]) === "06:30 Juan (RUTA A) · 06:35 Pedro (RUTA B)");
  const muchas = Array.from({ length: 60 }, (_, i) => `06:${String(i).padStart(2, "0")} Conductor número ${i} (RUTA X)`);
  const l = listaEnUnaLinea(muchas, 300);
  chk("respeta el largo y dice cuántos faltan", l.length <= 300 && /y \d+ más$/.test(l), `${l.length}: ${l}`);
  const nTotal = (l.match(/ · /g) ?? []).length + Number(/y (\d+) más$/.exec(l)?.[1] ?? 0);
  chk("no se pierde ninguno en la cuenta", nTotal === 60, String(nTotal));
  chk("sin saltos de línea (los parámetros de Meta no los admiten)", !/\n/.test(listaEnUnaLinea(["a\nb", "c"])));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
