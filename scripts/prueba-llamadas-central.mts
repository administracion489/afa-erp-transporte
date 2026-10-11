// Pruebas de LA LLAMADA AL CONDUCTOR QUE NO INICIA (lib/llamadas-central.ts): cuándo se pone en
// cola, qué dice, cómo se lee lo que informa la central y cómo se cuenta después.
// NO toca la base ni llama a nadie: todo en memoria, con el reloj pasado por parámetro.
// Uso:  npx tsx scripts/prueba-llamadas-central.mts   (sale con código 1 si algo falla)
//
// LO QUE NO SE PUEDE AFLOJAR: a un conductor que ya inició NO se le llama (ni se reintenta), una
// llamada vieja no sale, y un resultado que la central no supo explicar se RECHAZA en vez de
// guardarse — el coordinador lee esas frases como hechos.

import {
  ESTADOS_LLAMADA, LARGO_FRASE_LLAMADA, LATIDO_VIVO_MIN, MAX_INTENTOS, MAX_MENSAJE_VOZ, MAX_NOMBRE_VOZ, MAX_ORIGEN_VOZ,
  REINTENTO_MIN, VENTANA_LLAMADA_MIN, textoParaVoz,
  estadoCentral, fraseLlamadaCoordinador, horaHablada, juzgarLlamada, lecturaLlamada, leerResultado,
  minutosLlamada, numeroEnPalabras, planTrasResultado, telefonoParaLlamar, textoLlamada, venceLlamadaMs,
  type EstadoLlamada, type ResultadoCentral,
} from "../lib/llamadas-central";
import { inicioDe } from "../lib/escalera-inicio";
import { limaAUtcMs } from "../lib/alertas-horario";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const HOY = "2026-10-11";
const MANANA = "2026-10-12";
const reloj = (hhmm: string) => ({ ahoraMs: limaAUtcMs(HOY, hhmm)!, hoy: HOY, manana: MANANA });
const SERV = { estado: "programada", fecha_servicio: HOY, hora_servicio: "06:30:00" };
const CFG = { activo: true, modo_tiempo: "evento", umbral: 3 };

// ── 1. Cuándo se pone en cola ─────────────────────────────────────────────────
{
  console.log("\n— La ventana de la llamada (3 min después de la hora, durante 12) —");
  chk("06:32 → aún no", juzgarLlamada(SERV, CFG, reloj("06:32")) === "aun_no");
  chk("06:33 → toca (2 min después del «ya debió iniciar»)", juzgarLlamada(SERV, CFG, reloj("06:33")) === "toca");
  chk("06:44 → toca", juzgarLlamada(SERV, CFG, reloj("06:44")) === "toca");
  chk("06:45 → pasó la ventana (una llamada vieja no sale)", juzgarLlamada(SERV, CFG, reloj("06:45")) === "paso_la_ventana");
  chk("apagada → no", juzgarLlamada(SERV, { ...CFG, activo: false }, reloj("06:35")) === "apagado");
  chk("sin fila → no", juzgarLlamada(SERV, null, reloj("06:35")) === "apagado");
  chk("ya inició → NO se llama", juzgarLlamada({ ...SERV, estado: "en_curso" }, CFG, reloj("06:35")) === "fuera_de_estado");
  chk("cancelado → no", juzgarLlamada({ ...SERV, estado: "cancelada" }, CFG, reloj("06:35")) === "fuera_de_estado");
  chk("sin hora no hay a qué anclarla", juzgarLlamada({ ...SERV, hora_servicio: null }, CFG, reloj("06:35")) === "sin_hora");
  chk("sin umbral usa 3", minutosLlamada({ activo: true }) === 3 && minutosLlamada({ activo: true, umbral: -1 }) === 3);
  chk("el umbral manda", juzgarLlamada(SERV, { ...CFG, umbral: 5 }, reloj("06:34")) === "aun_no"
    && juzgarLlamada(SERV, { ...CFG, umbral: 5 }, reloj("06:35")) === "toca");
  chk("vence a la hora + umbral + ventana", venceLlamadaMs(SERV, CFG) === inicioDe(SERV)! + (3 + VENTANA_LLAMADA_MIN) * 60_000);
  // Con el cron de un minuto, cualquier desfase cae dentro de la ventana.
  const inicio = inicioDe(SERV)!;
  let alcanza = 0;
  for (let d = 0; d < 60; d++) {
    for (let t = inicio - 30 * 60_000 + d * 1000; t < inicio + 40 * 60_000; t += 60_000) {
      if (juzgarLlamada(SERV, CFG, { ahoraMs: t, hoy: HOY, manana: MANANA }) === "toca") { alcanza++; break; }
    }
  }
  chk("el cron de un minuto siempre la alcanza, sea cual sea su segundo", alcanza === 60, `${alcanza}/60`);
}

// ── 2. A qué número ───────────────────────────────────────────────────────────
{
  console.log("\n— El número —");
  chk("9 dígitos", telefonoParaLlamar("987654321") === "+51987654321");
  chk("con +51 y espacios", telefonoParaLlamar("+51 987 654 321") === "+51987654321");
  for (const malo of [null, "", "12345", "087654321", "+1 415 555 0100", "98765432"]) {
    chk(`no se marca «${malo}»`, telefonoParaLlamar(malo) === null);
  }
}

// ── 3. Lo que dice ────────────────────────────────────────────────────────────
{
  console.log("\n— La voz —");
  const casos: [string, string][] = [
    ["06:30", "las seis y treinta de la mañana"],
    ["06:00", "las seis en punto de la mañana"],
    ["01:05", "la una y cinco de la madrugada"],
    ["00:45", "las doce y cuarenta y cinco de la madrugada"],
    ["12:15", "las doce y quince de la tarde"],
    ["13:00", "la una en punto de la tarde"],
    ["19:21", "las siete y veintiuno de la noche"],
    ["05:59", "las cinco y cincuenta y nueve de la madrugada"],
  ];
  for (const [h, esp] of casos) chk(`${h} → «${esp}»`, horaHablada(h) === esp, String(horaHablada(h)));
  chk("con segundos también", horaHablada("06:30:00") === "las seis y treinta de la mañana");
  chk("lo que no es hora → null", horaHablada("abc") === null && horaHablada(null) === null && horaHablada("25:00") === null);
  const palabras = Array.from({ length: 60 }, (_, i) => numeroEnPalabras(i));
  chk("0..59 en palabras, sin cifras y todos distintos", palabras.every((p) => !/\d/.test(p)) && new Set(palabras).size === 60);

  const t = textoLlamada({ nombre: "Sergio Alexander Pérez", hora: "06:30", origen: "Puente Santa Anita", empresa: "AFA Transportes" });
  chk("saluda por el primer nombre", t.mensaje.startsWith("Hola Sergio. "), t.mensaje);
  chk("dice quién llama, la hora en palabras y el punto", t.mensaje.includes("Te llama la central de AFA Transportes")
    && t.mensaje.includes("de las seis y treinta de la mañana") && t.mensaje.includes("desde Puente Santa Anita"), t.mensaje);
  chk("y UNA orden: pulsa INICIAR", /Abre el app del conductor y pulsa INICIAR\.$/.test(t.mensaje), t.mensaje);
  chk("el menú de teclas va aparte", /marca uno/.test(t.menu) && /marca dos/.test(t.menu) && !t.mensaje.includes("marca"));
  const sinNada = textoLlamada({});
  chk("sin empresa: «la central de operaciones», sin hora ni punto inventados",
    sinNada.mensaje === "Hola. Te llama la central de operaciones. Tu servicio ya debió iniciar. Abre el app del conductor y pulsa INICIAR.", sinNada.mensaje);
  chk("sin espacios dobles", !/ {2,}/.test(t.mensaje) && !/ {2,}/.test(sinNada.mensaje));

  // REVISIÓN DE SEGURIDAD: el nombre y el origen los teclea cualquiera en el ERP y la llamada los
  // lee en voz alta. Sin tope, un origen de 2 600 caracteres ocupaba la línea leyendo cualquier cosa.
  const largo = textoLlamada({
    nombre: "Pedro" + "x".repeat(200), hora: "06:30", empresa: "AFA " + "y".repeat(200),
    origen: "Av. Siempre Viva 123. ATENCION: su cuenta fue bloqueada " + "llame ya ".repeat(300),
  });
  chk(`el mensaje entero tiene tope (≤ ${MAX_MENSAJE_VOZ})`, Array.from(largo.mensaje).length <= MAX_MENSAJE_VOZ, String(largo.mensaje.length));
  const o = textoParaVoz("Av. Siempre Viva 123. ATENCION: su cuenta fue bloqueada " + "llame ya ".repeat(300), MAX_ORIGEN_VOZ);
  chk(`el origen se corta (≤ ${MAX_ORIGEN_VOZ}) y en palabra`, Array.from(o).length <= MAX_ORIGEN_VOZ && !/\s$/.test(o) && !o.endsWith("ll"), o);
  chk(`el nombre se corta (≤ ${MAX_NOMBRE_VOZ})`, Array.from(textoParaVoz("x".repeat(100), MAX_NOMBRE_VOZ)).length <= MAX_NOMBRE_VOZ);
  const raro = textoParaVoz(`Paradero "1"; $(rm -rf /) \`id\` | cat (x) 'y' <b>`, 200);
  chk("sin comillas, ; $ | paréntesis, comillas invertidas ni etiquetas", !/["';$|()`<>]/.test(raro), raro);
  chk("se conservan las letras con tilde, la ñ y la puntuación de una dirección",
    textoParaVoz("Av. Ñaña-Chosica Km 25/ #3 °N, ñandú", 200) === "Av. Ñaña-Chosica Km 25/ #3 °N, ñandú");
  chk("sin caracteres de control", !/[\u0000-\u001f]/.test(textoParaVoz("a\u0000b\nc\td", 50)));
}

// ── 4. Lo que informa la central ──────────────────────────────────────────────
{
  console.log("\n— El resultado de la central se valida —");
  const ok = (b: unknown) => { const r = leerResultado(b); return r.ok ? r.resultado : null; };
  chk("contestada con duración y opción", JSON.stringify(ok({ intento: 1, estado: "contestada", duracion_seg: 14.4, opcion: "1" }))
    === JSON.stringify({ intento: 1, estado: "contestada", duracion_seg: 14, opcion: "1", detalle: null }));
  chk("no contestó sin más datos", ok({ intento: 2, estado: "no_contesto" })?.estado === "no_contesto");
  chk("la opción puede venir como número", ok({ intento: 1, estado: "contestada", opcion: 2 })?.opcion === "2");
  for (const [nombre, b] of [
    ["estado desconocido", { intento: 1, estado: "colgo" }],
    ["sin estado", { intento: 1 }],
    ["sin intento (un resultado atrasado no se puede distinguir)", { estado: "no_contesto" }],
    ["intento 0", { intento: 0, estado: "no_contesto" }],
    ["intento con decimales", { intento: 1.5, estado: "no_contesto" }],
    ["duración negativa", { intento: 1, estado: "contestada", duracion_seg: -1 }],
    ["duración absurda", { intento: 1, estado: "contestada", duracion_seg: 99999 }],
    ["opción 3", { intento: 1, estado: "contestada", opcion: "3" }],
    ["opción en una llamada no contestada", { intento: 1, estado: "no_contesto", opcion: "1" }],
    ["cuerpo nulo", null],
  ] as [string, unknown][]) {
    chk(`se rechaza: ${nombre}`, !leerResultado(b).ok);
  }
  const d = ok({ intento: 1, estado: "fallida", detalle: "sin\nseñal\t\u0000" + "x".repeat(400) });
  chk("el detalle va en una línea, sin caracteres de control y recortado",
    !!d?.detalle && !/[\u0000-\u001f]/.test(d.detalle) && Array.from(d.detalle).length <= 200);
}

// ── 5. Qué queda después de cada intento ──────────────────────────────────────
{
  console.log("\n— Reintentos —");
  const ahora = limaAUtcMs(HOY, "06:33")!;
  const vence = new Date(limaAUtcMs(HOY, "06:45")!).toISOString();
  const p1 = planTrasResultado({ intentos: 1, max_intentos: 2, vence_en: vence }, "no_contesto", ahora, true);
  chk("no contestó el 1.º → vuelve a la cola en 2 min", p1.estado === "pendiente" && p1.proximoIntentoMs === ahora + REINTENTO_MIN * 60_000);
  chk("no contestó el 2.º → queda «no contestó»", planTrasResultado({ intentos: 2, max_intentos: 2, vence_en: vence }, "no_contesto", ahora, true).estado === "no_contesto");
  chk("contestó → listo, sin reintento", planTrasResultado({ intentos: 1, max_intentos: 2, vence_en: vence }, "contestada", ahora, true).proximoIntentoMs === null);
  chk("si ya inició, NO se reintenta", planTrasResultado({ intentos: 1, max_intentos: 2, vence_en: vence }, "ocupado", ahora, false).estado === "ocupado");
  chk("si el reintento cae después de que venza, no se reintenta",
    planTrasResultado({ intentos: 1, max_intentos: 2, vence_en: new Date(ahora + 60_000).toISOString() }, "no_contesto", ahora, true).estado === "no_contesto");
  chk("sin máximo declarado usa MAX_INTENTOS", planTrasResultado({ intentos: MAX_INTENTOS, vence_en: vence }, "fallida", ahora, true).estado === "fallida");

  // Barrido: nunca se reintenta a quien ya inició, nunca después de vencer, nunca de más.
  let malos = 0, reintentos = 0;
  for (const r of ["contestada", "no_contesto", "ocupado", "fallida"] as ResultadoCentral[]) {
    for (const intentos of [0, 1, 2, 3, 5]) for (const max of [null, 1, 2, 3]) for (const sigue of [true, false])
      for (const venceMin of [-5, 0, 1, 2, 3, 10, 60]) {
        const v = new Date(ahora + venceMin * 60_000).toISOString();
        const p = planTrasResultado({ intentos, max_intentos: max, vence_en: v }, r, ahora, sigue);
        const maxEf = max && max > 0 ? max : MAX_INTENTOS;
        if (p.estado === "pendiente") {
          reintentos++;
          if (!sigue || intentos >= maxEf || p.proximoIntentoMs == null || p.proximoIntentoMs >= Date.parse(v) || r === "contestada") malos++;
        } else if (p.estado !== r || p.proximoIntentoMs !== null) malos++;
      }
  }
  chk("barrido: nunca se reintenta a quien inició, después de vencer, de más, ni una contestada", malos === 0, `${malos} mal`);
  chk("…y sí reintenta cuando corresponde (no es trivial)", reintentos > 0, String(reintentos));
}

// ── 6. ¿Está conectada la central? ────────────────────────────────────────────
{
  console.log("\n— La central —");
  const ahora = Date.parse("2026-10-11T11:00:00Z");
  chk("nunca se conectó", estadoCentral(null, ahora).codigo === "nunca" && !estadoCentral(null, ahora).conectada);
  chk("hace 30 s → conectada", estadoCentral(new Date(ahora - 30_000).toISOString(), ahora).conectada);
  chk(`hace ${LATIDO_VIVO_MIN} min justos → conectada`, estadoCentral(new Date(ahora - LATIDO_VIVO_MIN * 60_000).toISOString(), ahora).conectada);
  const tres = estadoCentral(new Date(ahora - 3 * 60_000).toISOString(), ahora);
  chk("hace 3 min → desconectada, y lo dice", !tres.conectada && tres.codigo === "sin_conexion" && tres.texto.includes("3 min"), tres.texto);
  chk("hace 5 h", estadoCentral(new Date(ahora - 5 * 3_600_000).toISOString(), ahora).texto.includes("5 h"));
}

// ── 7. Cómo se cuenta después ─────────────────────────────────────────────────
{
  console.log("\n— La lectura (ficha del servicio y coordinador) —");
  const base = { created_at: "2026-10-11T11:33:00Z", tomada_en: "2026-10-11T11:33:05Z", terminada_en: "2026-10-11T11:33:30Z" };
  chk("contestó, con su duración", lecturaLlamada({ ...base, estado: "contestada", duracion_seg: 14 }).texto === "Contestó (0:14)");
  chk("marcó 1", lecturaLlamada({ ...base, estado: "contestada", duracion_seg: 75, opcion: "1" }).texto === "Contestó (1:15) y marcó 1: ya está en ruta");
  chk("marcó 2", /pide hablar con el coordinador/.test(lecturaLlamada({ ...base, estado: "contestada", opcion: "2" }).texto));
  chk("no contestó, con los intentos", lecturaLlamada({ ...base, estado: "no_contesto", intentos: 2 }).texto === "No contestó (2 intentos)");
  chk("en cola", lecturaLlamada({ estado: "pendiente", intentos: 0 }).texto === "En cola, esperando a la central");
  chk("reintento programado, con su hora", lecturaLlamada({ estado: "pendiente", intentos: 1, proximo_intento_en: "2026-10-11T11:35:00Z" }).texto
    === "No contestó; se vuelve a llamar a las 06:35");
  chk("vencida dice que la central no la tomó", /central no la tomó/.test(lecturaLlamada({ estado: "vencida" }).texto));
  chk("cancelada dice por qué", lecturaLlamada({ estado: "cancelada", detalle: "el servicio ya se inició" }).texto === "No se llamó: el servicio ya se inició");
  chk("fallida sin detalle", lecturaLlamada({ estado: "fallida" }).texto === "No salió: la central no pudo marcar");
  chk("la hora es la de Lima", lecturaLlamada({ ...base, estado: "contestada" }).hora === "06:33");
  chk("todos los estados tienen lectura", ESTADOS_LLAMADA.every((e: EstadoLlamada) => lecturaLlamada({ estado: e }).codigo === e));
  chk("un estado raro no se inventa", lecturaLlamada({ estado: "xyz" }).codigo === "desconocido");

  const frase = fraseLlamadaCoordinador([
    { ...base, estado: "no_contesto", intentos: 2, motivo: "llamada_inicio" },
    { created_at: "2026-10-11T10:00:00Z", estado: "contestada", motivo: "prueba" },
  ]);
  chk("al coordinador: la llamada en una frase", frase === "Llamada 06:33: no contestó (2 intentos).", frase);
  chk("…sin las de prueba", !fraseLlamadaCoordinador([{ estado: "contestada", motivo: "prueba" }]));
  chk("sin llamada, nada", fraseLlamadaCoordinador([]) === "");
  const larga = fraseLlamadaCoordinador([{ ...base, estado: "fallida", detalle: "x".repeat(200), motivo: "llamada_inicio" }]);
  chk(`un detalle largo de la central no se come la evidencia (≤ ${LARGO_FRASE_LLAMADA})`, Array.from(larga).length <= LARGO_FRASE_LLAMADA && larga.endsWith("…"), String(larga.length));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
