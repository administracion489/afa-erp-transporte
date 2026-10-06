// Pruebas de la SALUD del Radar IA (lib/radar/salud.ts, puro): ¿está leyendo los vouchers, y si no,
// por qué? NO tocan la base.
// Uso:  npx tsx scripts/prueba-salud-radar.mts   (sale con código 1 si algo falla)
//
// LO PLANTEÓ EL DUEÑO: «el Radar IA puede fallar —es Baileys, WhatsApp puede eliminar esa línea, o se
// queda sin saldo de API para leer—». Hasta ahora solo el chip de /radar-ia lo decía, y solo para la
// conexión: una API sin saldo dejaba el chip en verde mientras cada mensaje terminaba en «Error». Fija:
//
//   1. cada causa, con su código, su arreglo y desde cuándo;
//   2. el orden: la causa gana al síntoma (un servidor caído también deja la cola quieta);
//   3. «ahora» es lo reciente: fallos viejos con lecturas buenas después no alarman;
//   4. sin evidencia no se afirma nada: una lectura que falló no es «el Radar está caído»;
//   5. el aviso de la pestaña de facturas: qué significa para las cargas;
//   6. las piezas compartidas (latido, horario) se extrajeron sin cambiar lo que hacían;
//   7. invariantes por barrido.
import {
  saludRadar, avisoSaludEnFacturas, causaDeFallo, credencialesRechazadas, codigoCierre, workerVivo, cuandoTexto, haceTexto,
  LATIDO_VIVO_MS, RACHA_FALLANDO, COLA_ATASCADA_MS, CODIGOS_CONEXION,
  type EntradaSalud, type MensajeTerminado, type CodigoSalud,
} from "../lib/radar/salud";
import { dentroDeHorario, CONFIG_DEFECTO } from "../lib/radar/config";
import { ACCION_QUITADO_DEL_AVISO } from "../lib/radar/reproceso";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// 06/10/2026 15:00 Lima = 20:00 UTC.
const AHORA = Date.parse("2026-10-06T20:00:00Z");
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
const CONFIG = { activo: true, horario_activo: false, hora_inicio: "06:00", hora_fin: "22:00", limite_diario_usd: 5 };
const OK_MSG = (min: number): MensajeTerminado => ({ estado: "procesado", accion: "combustible_registrado", error: null, procesado_en: hace(min) });
const SIN_SALDO = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CXyz"}';
const CLAVE_MALA = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CAbc"}';
const FALLO = (min: number, error: string | null, extra: Partial<MensajeTerminado> = {}): MensajeTerminado => ({ estado: "error", accion: null, error, procesado_en: hace(min), ...extra });
const BASE = (o: Partial<EntradaSalud> = {}): EntradaSalud => ({
  ahora: AHORA,
  estado: { estado: "conectado", detalle: null, ultimo_latido: hace(1), numero: "+51997683199" },
  config: CONFIG,
  ultimos: [OK_MSG(5), OK_MSG(20), OK_MSG(60)],
  cola: { cuantos: 0, masViejo: null },
  gastoHoy: 0.4,
  gruposSinAcceso: 0,
  ...o,
});

// ── 1. Cada causa ────────────────────────────────────────────────────────────
console.log("\n1. Cada causa, con su arreglo");
{
  const ok = saludRadar(BASE());
  chk("todo en orden: lee, en verde", ok.codigo === "ok" && ok.lee === true && ok.tono === "ok", ok.detalle);

  const caido = saludRadar(BASE({ estado: { estado: "conectado", detalle: null, ultimo_latido: hace(45), numero: null } }));
  chk("sin latido hace 45 min: el SERVIDOR está caído, aunque la fila diga «conectado»", caido.codigo === "servidor_caido" && caido.lee === false && caido.tono === "grave");
  chk("…dice desde cuándo y cómo se revive", caido.desde === hace(45) && /hace 45 min/.test(caido.detalle) && /pm2 restart radar-worker/.test(caido.detalle), caido.detalle);

  const qr = saludRadar(BASE({ estado: { estado: "esperando_qr", detalle: null, ultimo_latido: hace(1) } }));
  chk("esperando QR: no entra ningún mensaje", qr.codigo === "esperando_qr" && qr.lee === false);
  const bloq = saludRadar(BASE({ estado: { estado: "desconectado", detalle: "Conexión cerrada (código 403)", ultimo_latido: hace(1) } }));
  chk("403: WhatsApp BLOQUEÓ el número (hay que vincular otro)", bloq.codigo === "whatsapp_bloqueado" && /OTRO número/.test(bloq.detalle));
  const desv = saludRadar(BASE({ estado: { estado: "desconectado", detalle: "Conexión cerrada (código 401)", ultimo_latido: hace(1) } }));
  chk("401: la sesión se cerró desde el teléfono", desv.codigo === "whatsapp_desvinculado" && /401/.test(desv.detalle));
  const desc = saludRadar(BASE({ estado: { estado: "desconectado", detalle: "Reconectando (código 500)", ultimo_latido: hace(1) } }));
  chk("cualquier otra desconexión: «desconectado», con el detalle del worker", desc.codigo === "desconectado" && /Reconectando/.test(desc.detalle));

  const pausa = saludRadar(BASE({ config: { ...CONFIG, activo: false } }));
  chk("en pausa: los mensajes llegan y no se leen", pausa.codigo === "pausado" && pausa.lee === false);

  const saldo = saludRadar(BASE({ ultimos: [FALLO(3, SIN_SALDO), OK_MSG(30)] }));
  chk("SIN SALDO en la API: basta UN fallo (fallan todos, no es azar)", saldo.codigo === "sin_credito" && saldo.lee === false && saldo.tono === "grave");
  chk("…dice dónde se recarga y que hay que reprocesar lo que falló", /Plans & Billing/.test(saldo.detalle) && /Reprocesar los que fallaron/.test(saldo.detalle), saldo.detalle);
  const saldo3 = saludRadar(BASE({ ultimos: [FALLO(3, SIN_SALDO), FALLO(40, SIN_SALDO), FALLO(95, SIN_SALDO), OK_MSG(200)] }));
  chk("…y desde cuándo: el PRIMER fallo de la racha", saldo3.desde === hace(95) && /fallaron 3 mensajes seguidos/.test(saldo3.detalle), saldo3.detalle);

  const clave = saludRadar(BASE({ ultimos: [FALLO(3, CLAVE_MALA)] }));
  chk("la clave de la API rechazada: su propio código (se arregla en Vercel, no en la facturación)", clave.codigo === "clave_invalida" && /ANTHROPIC_API_KEY/.test(clave.detalle));

  const accion = (min: number) => FALLO(min, null, { estado: "error", accion: "error_accion", resultado: { accion: { detalle: "Could not find the 'nivel_tanque' column" } } });
  const tres = saludRadar(BASE({ ultimos: [accion(2), accion(10), accion(20), OK_MSG(50)] }));
  chk(`${RACHA_FALLANDO} fallos seguidos de otra causa: «fallando», con el último motivo`, tres.codigo === "fallando" && /nivel_tanque/.test(tres.detalle), tres.detalle);
  const dos = saludRadar(BASE({ ultimos: [accion(2), accion(10), OK_MSG(20)] }));
  chk("dos fallos sueltos de otra causa no alarman", dos.codigo === "ok");
  const sobre = saludRadar(BASE({ ultimos: [FALLO(1, "529 overloaded_error"), FALLO(2, "429 rate_limit_error"), OK_MSG(5)] }));
  chk("la sobrecarga pasajera (429/529) no es una causa propia", sobre.codigo === "ok");

  const limite = saludRadar(BASE({ gastoHoy: 5.2, cola: { cuantos: 3, masViejo: hace(10) } }));
  chk("límite diario alcanzado con mensajes esperando: esperan a mañana", limite.codigo === "limite_diario" && limite.lee === false && /3 mensaje/.test(limite.detalle));
  chk("…sin nada esperando no hay nada que decir", saludRadar(BASE({ gastoHoy: 5.2 })).codigo === "ok");

  const atasc = saludRadar(BASE({ cola: { cuantos: 4, masViejo: hace(90) } }));
  chk("la cola quieta más de una hora: atascada (aviso)", atasc.codigo === "atascado" && atasc.tono === "aviso" && atasc.desde === hace(90));
  chk("…media hora no es atasco (el cron pasa cada 15 min)", saludRadar(BASE({ cola: { cuantos: 4, masViejo: hace(30) } })).codigo === "ok");
  const noche = Date.parse("2026-10-07T04:30:00Z"); // 23:30 Lima
  const fuera = saludRadar(BASE({ ahora: noche, estado: { estado: "conectado", detalle: null, ultimo_latido: new Date(noche - 60_000).toISOString() },
    config: { ...CONFIG, horario_activo: true }, ultimos: [], cola: { cuantos: 4, masViejo: new Date(noche - 120 * 60_000).toISOString() } }));
  chk("fuera del horario de monitoreo, esperar es lo que el motor hace a propósito: no es atasco", fuera.codigo === "ok", fuera.codigo);

  const grupos = saludRadar(BASE({ gruposSinAcceso: 2 }));
  chk("grupos activos que el número ya no ve: lee, pero a medias (aviso)", grupos.codigo === "grupos_sin_acceso" && grupos.lee === true && grupos.tono === "aviso");
}

// ── 2. La causa gana al síntoma ──────────────────────────────────────────────
console.log("\n2. El orden: la causa antes que el síntoma");
{
  const viejo = { estado: "conectado", detalle: null, ultimo_latido: hace(60) };
  chk("servidor caído + sin saldo + cola quieta → servidor caído",
    saludRadar(BASE({ estado: viejo, ultimos: [FALLO(70, SIN_SALDO)], cola: { cuantos: 9, masViejo: hace(120) } })).codigo === "servidor_caido");
  chk("esperando QR con el worker caído → servidor caído (ese QR no sirve)",
    saludRadar(BASE({ estado: { ...viejo, estado: "esperando_qr" } })).codigo === "servidor_caido");
  chk("en pausa + sin saldo → en pausa (reactivarlo es lo primero)",
    saludRadar(BASE({ config: { ...CONFIG, activo: false }, ultimos: [FALLO(3, SIN_SALDO)] })).codigo === "pausado");
  chk("sin saldo + límite + cola quieta → sin saldo",
    saludRadar(BASE({ ultimos: [FALLO(3, SIN_SALDO)], gastoHoy: 9, cola: { cuantos: 9, masViejo: hace(120) } })).codigo === "sin_credito");
  chk("límite + cola quieta → límite (la cola espera por él)",
    saludRadar(BASE({ gastoHoy: 9, cola: { cuantos: 9, masViejo: hace(120) } })).codigo === "limite_diario");
}

// ── 3. «Ahora» es lo reciente ────────────────────────────────────────────────
console.log("\n3. Fallos viejos con lecturas buenas después no alarman");
{
  chk("un mensaje leído bien DESPUÉS de los fallos de saldo: ya se recargó → ok",
    saludRadar(BASE({ ultimos: [OK_MSG(2), FALLO(60, SIN_SALDO), FALLO(70, SIN_SALDO), FALLO(80, SIN_SALDO)] })).codigo === "ok");
  chk("un descartado (la IA lo leyó y no era nada) también corta la racha",
    saludRadar(BASE({ ultimos: [{ estado: "descartado", accion: null, error: null, procesado_en: hace(2) }, FALLO(60, SIN_SALDO)] })).codigo === "ok");
  chk("pero un fallo que alguien «quitó del aviso» sigue siendo un fallo: no esconde que no hay saldo",
    saludRadar(BASE({ ultimos: [{ estado: "descartado", accion: ACCION_QUITADO_DEL_AVISO, error: SIN_SALDO, procesado_en: hace(2) }, OK_MSG(60)] })).codigo === "sin_credito");
}

// ── 4. Sin evidencia no se afirma nada ───────────────────────────────────────
console.log("\n4. Una lectura que falló no es «el Radar está caído»");
{
  const nada = saludRadar(BASE({ estado: null, config: null, ultimos: null, cola: null, gastoHoy: null, gruposSinAcceso: null }));
  chk("sin poder leer nada: «no se sabe» (lee null), sin alarma", nada.codigo === "sin_datos" && nada.lee === null && nada.tono === "ok");
  chk("…y la pestaña de facturas no dice nada", avisoSaludEnFacturas(nada) === null);
  chk("sin el estado pero CON evidencia de que la API no tiene saldo: esa evidencia manda",
    saludRadar(BASE({ estado: null, ultimos: [FALLO(3, SIN_SALDO)] })).codigo === "sin_credito");
  chk("con el resto ilegible (cola, gasto, grupos, mensajes en null) y la conexión bien: ok",
    saludRadar(BASE({ ultimos: null, cola: null, gastoHoy: null, gruposSinAcceso: null })).codigo === "ok");
  chk("sin grupos que mirar (columna sin migrar): no se dice nada de los grupos", saludRadar(BASE({ gruposSinAcceso: null })).codigo === "ok");
}

// ── 5. El aviso de la pestaña de facturas ────────────────────────────────────
console.log("\n5. Qué significa para las facturas");
{
  chk("con el Radar leyendo: ningún aviso", avisoSaludEnFacturas(saludRadar(BASE())) === null && avisoSaludEnFacturas(null) === null);
  const a = avisoSaludEnFacturas(saludRadar(BASE({ ultimos: [FALLO(3, SIN_SALDO)] })))!;
  chk("sin saldo: grave, con la causa Y la consecuencia: entran sin odómetro → «Cargas por completar»",
    a.tono === "grave" && /sin saldo/.test(a.titulo) && /SIN odómetro/.test(a.detalle) && /Cargas por completar/.test(a.detalle), a.detalle);
  chk("…y la parte que la factura NO cubre: los otros grifos se registran a mano", /otros grifos/.test(a.detalle) && /a mano/.test(a.detalle));
  const g = avisoSaludEnFacturas(saludRadar(BASE({ gruposSinAcceso: 1 })))!;
  chk("grupos perdidos: aviso, y la consecuencia es parcial (solo esos grupos)", g.tono === "aviso" && /esos grupos/.test(g.detalle));
}

// ── 6. Las piezas compartidas se extrajeron sin cambiar ──────────────────────
console.log("\n6. El latido y el horario: los mismos que ya usaban el chip y el motor");
{
  chk(`latido: vivo antes de ${LATIDO_VIVO_MS / 60_000} min, muerto desde ahí (el mismo «<» del chip)`,
    workerVivo(new Date(AHORA - LATIDO_VIVO_MS + 1000).toISOString(), AHORA) && !workerVivo(new Date(AHORA - LATIDO_VIVO_MS).toISOString(), AHORA) && !workerVivo(null, AHORA));
  chk("el código de cierre se lee del detalle del worker", codigoCierre("Conexión cerrada (código 403)") === "403" && codigoCierre("sin código") === null && codigoCierre(null) === null);
  chk("credencialesRechazadas: 403/401/405/411 sí, 500 no",
    ["403", "401", "405", "411"].every((c) => !!credencialesRechazadas(`(código ${c})`)) && credencialesRechazadas("(código 500)") === null);
  // El horario: el algoritmo que vivía dentro de motor.ts, copiado literal, contra el extraído.
  const viejo = (cfg: { horario_activo: boolean; hora_inicio: string; hora_fin: string }, ahora: string) => {
    if (!cfg.horario_activo) return true;
    return cfg.hora_inicio <= cfg.hora_fin ? ahora >= cfg.hora_inicio && ahora <= cfg.hora_fin : ahora >= cfg.hora_inicio || ahora <= cfg.hora_fin;
  };
  const horas: string[] = [];
  for (let h = 0; h < 24; h++) for (const m of ["00", "15", "30", "59"]) horas.push(`${String(h).padStart(2, "0")}:${m}`);
  let dif = 0, n = 0;
  for (const activo of [true, false]) for (const ini of ["00:00", "06:00", "22:00", "23:59"]) for (const fin of ["00:00", "05:59", "22:00", "23:59"]) for (const h of horas) {
    n++;
    const cfg = { horario_activo: activo, hora_inicio: ini, hora_fin: fin };
    if (viejo(cfg, h) !== dentroDeHorario(cfg, h)) dif++;
  }
  chk(`dentroDeHorario es idéntico al algoritmo del motor (${n} combinaciones)`, dif === 0, String(dif));
  chk("el horario por defecto no restringe", dentroDeHorario(CONFIG_DEFECTO, "03:00"));
  chk("los textos de tiempo van en hora Lima", cuandoTexto(hace(5), AHORA) === "hoy 14:55" && /^ayer/.test(cuandoTexto(hace(60 * 20), AHORA)) && haceTexto(hace(5), AHORA) === "hace 5 min");
  chk("causaDeFallo", causaDeFallo(SIN_SALDO) === "sin_credito" && causaDeFallo(CLAVE_MALA) === "clave_invalida" &&
    causaDeFallo("529 overloaded_error") === "sobrecarga" && causaDeFallo("La IA no devolvió un JSON reconocible") === "otro" && causaDeFallo(null) === "otro");
}

// ── 7. Invariantes por barrido ───────────────────────────────────────────────
console.log("\n7. Invariantes por barrido");
{
  const estados: EntradaSalud["estado"][] = [
    null,
    { estado: "conectado", detalle: null, ultimo_latido: hace(1) },
    { estado: "conectado", detalle: null, ultimo_latido: hace(30) },
    { estado: "esperando_qr", detalle: null, ultimo_latido: hace(1) },
    { estado: "desconectado", detalle: "(código 403)", ultimo_latido: hace(1) },
    { estado: "desconectado", detalle: "(código 401)", ultimo_latido: hace(1) },
    { estado: "desconectado", detalle: "x", ultimo_latido: hace(1) },
  ];
  const configs: EntradaSalud["config"][] = [null, CONFIG, { ...CONFIG, activo: false }, { ...CONFIG, horario_activo: true, hora_inicio: "16:00", hora_fin: "17:00" }];
  const ultimosOps: EntradaSalud["ultimos"][] = [null, [], [OK_MSG(1)], [FALLO(1, SIN_SALDO)], [FALLO(1, CLAVE_MALA)], [FALLO(1, "x"), FALLO(2, "x"), FALLO(3, "x")], [FALLO(1, "x"), OK_MSG(2)]];
  const colas: EntradaSalud["cola"][] = [null, { cuantos: 0, masViejo: null }, { cuantos: 2, masViejo: hace(5) }, { cuantos: 2, masViejo: hace(200) }];
  const gastos = [null, 0, 6];
  const grupos = [null, 0, 3];
  let n = 0, leeMal = 0, tonoMal = 0, vacio = 0, conexMal = 0, avisoMal = 0, alarmas = 0;
  const vistos = new Set<CodigoSalud>();
  for (const estado of estados) for (const config of configs) for (const ultimos of ultimosOps) for (const cola of colas) for (const gastoHoy of gastos) for (const g of grupos) {
    n++;
    const s = saludRadar({ ahora: AHORA, estado, config, ultimos, cola, gastoHoy, gruposSinAcceso: g });
    vistos.add(s.codigo);
    const noLee = !["ok", "sin_datos", "grupos_sin_acceso"].includes(s.codigo);
    if ((s.lee === false) !== noLee) leeMal++;
    if ((s.tono === "ok") !== (s.codigo === "ok" || s.codigo === "sin_datos")) tonoMal++;
    if (!s.titulo || !s.detalle) vacio++;
    if (CODIGOS_CONEXION.includes(s.codigo) && !estado) conexMal++;
    const a = avisoSaludEnFacturas(s);
    if ((a != null) !== (s.lee === false || s.codigo === "grupos_sin_acceso")) avisoMal++;
    if (a) alarmas++;
  }
  chk(`(${n} combinaciones) «no lee» ⟺ el código es un problema que impide leer`, leeMal === 0, String(leeMal));
  chk("verde ⟺ ok o sin datos", tonoMal === 0, String(tonoMal));
  chk("todo veredicto trae título y detalle", vacio === 0, String(vacio));
  chk("un problema de conexión solo se afirma con la fila de estado leída", conexMal === 0, String(conexMal));
  chk("la pestaña de facturas avisa ⟺ el Radar no lee (o pierde grupos)", avisoMal === 0, String(avisoMal));
  chk(`el barrido pasa por los ${vistos.size} códigos`, vistos.size === 14, [...vistos].join(","));
  chk("y no alarma siempre (un aviso que sale siempre se vuelve paisaje)", alarmas < n, `${alarmas} de ${n}`);
  chk(`umbrales declarados: racha ${RACHA_FALLANDO}, cola ${COLA_ATASCADA_MS / 60_000} min`, RACHA_FALLANDO === 3 && COLA_ATASCADA_MS === 3_600_000);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
