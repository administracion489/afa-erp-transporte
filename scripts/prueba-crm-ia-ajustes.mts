// npx tsx scripts/prueba-crm-ia-ajustes.mts
import { readFileSync } from "node:fs";
import {
  normalizarAjustes, AJUSTES_DEFECTO, saludoParaHora, presentacion, estiloDe, mensajeDerivacionDefecto,
  tituloResumen, cierreResumen, ponerNombre, horaHHMM, TEMAS_AJUSTE, MOTIVOS_DERIVACION_SISTEMA,
  TRATAMIENTOS, MODOS_PREGUNTAS,
} from "../lib/crm-ia-ajustes";
import {
  atencionDe, atencionValida, atencionEnUso, problemaAtencion, describirAtencion, describirDias,
  dentroDeAtencion, proximaAtencion, fraseFueraDeAtencion, PROBLEMA_ATENCION, type Atencion,
} from "../lib/crm-ia-atencion";
let fallos = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else console.log("✓", m); };
ok(JSON.stringify(normalizarAjustes(null)) === JSON.stringify(AJUSTES_DEFECTO), "null → defectos");
ok(JSON.stringify(normalizarAjustes("x")) === JSON.stringify(AJUSTES_DEFECTO), "basura → defectos");
ok(JSON.stringify(normalizarAjustes([1])) === JSON.stringify(AJUSTES_DEFECTO), "array → defectos");
const a = normalizarAjustes({ hora_tarde: 15, hora_noche: 10, silencio_seg: 2, silencio_completo_seg: 8, espera_max_seg: 3, intentos_pedir_datos: 9, etiqueta_derivacion: "  ", saludo_manana: "" });
ok(a.hora_noche > a.hora_tarde, "noche siempre después de tarde");
ok(a.silencio_seg >= a.silencio_completo_seg, "silencio ≥ silencio completo");
ok(a.espera_max_seg >= a.silencio_seg, "espera máx ≥ silencio");
ok(a.intentos_pedir_datos === 3, "intentos acotados");
ok(a.etiqueta_derivacion === "", "etiqueta vacía = ninguna");
ok(a.saludo_manana === "Buenos días", "saludo vacío → defecto");
ok(JSON.stringify(normalizarAjustes(a)) === JSON.stringify(a), "idempotente");
ok(normalizarAjustes({ saludo_activo: "no" }).saludo_activo === true, "bool no booleano → defecto");
ok(normalizarAjustes({ hora_tarde: "13" }).hora_tarde === 13, "número en texto se lee");
const d = AJUSTES_DEFECTO;
ok(saludoParaHora(d, 0) === "Buenos días" && saludoParaHora(d, 11) === "Buenos días", "mañana");
ok(saludoParaHora(d, 12) === "Buenas tardes" && saludoParaHora(d, 18) === "Buenas tardes", "tarde");
ok(saludoParaHora(d, 19) === "Buenas noches" && saludoParaHora(d, 23) === "Buenas noches", "noche");
ok(presentacion(d, "ACME") === "el asistente de ACME", "presentación con empresa");
ok(!presentacion(d, "").includes("{empresa}"), "sin empresa no queda la llave");
ok(normalizarAjustes({ mensajes_historial: 500 }).mensajes_historial === 60, "historial acotado a 60");
ok(normalizarAjustes({ mensajes_historial: 1 }).mensajes_historial === 10, "historial mínimo 10");
ok(normalizarAjustes({ lugares_conocidos: "" }).lugares_conocidos === "", "lugares vacíos = ninguno");
ok(normalizarAjustes({}).recordar_datos === true, "recordar datos nace encendido");
ok(normalizarAjustes({}).resumen_pedido === true, "resumen del pedido nace encendido");
// El resumen va UNA vez al final (la regla del dueño, 20-10-2026). Un ajuste guardado antes de
// existir el campo —con resumen_pedido: true— también: solo «cada_respuesta» escrito lo cambia.
ok(normalizarAjustes({}).resumen_cuando === "al_final", "el resumen nace «solo al final»");
ok(normalizarAjustes({ resumen_pedido: true }).resumen_cuando === "al_final", "ajuste guardado antes del campo → al final");
ok(normalizarAjustes({ resumen_cuando: "cada_respuesta" }).resumen_cuando === "cada_respuesta", "«cada respuesta» elegido a propósito se conserva");
for (const malo of ["", "siempre", null, 3, ["al_final"]])
  ok(normalizarAjustes({ resumen_cuando: malo }).resumen_cuando === "al_final", `valor desconocido → al final: ${JSON.stringify(malo)}`);
{ const c = normalizarAjustes({ resumen_cuando: "cada_respuesta" }); ok(JSON.stringify(normalizarAjustes(c)) === JSON.stringify(c), "idempotente con «cada respuesta»"); }
ok(normalizarAjustes({ campos_pedido: "  " }).campos_pedido === AJUSTES_DEFECTO.campos_pedido, "campos vacíos → defecto");

// ── UNA FUENTE POR COMPORTAMIENTO (20-10-2026): los ajustes nuevos ─────────────────────────────────
const igual = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
const NUEVOS = {
  tratamiento: "usted", preguntas: "todo_junto", resumen_titulo: "", resumen_cierre: "Con esto ya tengo todo lo necesario",
  menu_saludo: "", atencion_activa: false, atencion_dias: [1, 2, 3, 4, 5], atencion_desde: "09:00", atencion_hasta: "18:00",
};
for (const [k, v] of Object.entries(NUEVOS))
  ok(igual((AJUSTES_DEFECTO as Record<string, unknown>)[k], v), `defecto ${k} = ${JSON.stringify(v)}`);

// El jsonb REAL de producción (brief, 20-10-2026), guardado antes de existir los campos nuevos.
const VIEJO = {
  saludo_activo: true, saludo_manana: "Buenos días", saludo_tarde: "Buenas tardes", saludo_noche: "Buenas noches",
  hora_tarde: 12, hora_noche: 19, presentarse_como: "el asistente de {empresa}", ocultar_ia: true,
  no_decir_no_encontre: true, intentos_pedir_datos: 1, etiqueta_derivacion: "Para ejecutivo", nota_interna_derivacion: true,
  transcribir_audios: true, leer_archivos: true, max_archivos: 4, max_audios: 3, silencio_seg: 12, silencio_completo_seg: 4,
  espera_max_seg: 45, recordar_datos: true, lugares_conocidos: "el aeropuerto, los terminales terrestres", mensajes_historial: 40,
  resumen_pedido: true, campos_pedido: "ruta, fecha y hora, pasajeros, equipaje, tipo de servicio, nombre y empresa", reglas_extra: "",
};
{
  const n = normalizarAjustes(VIEJO);
  for (const [k, v] of Object.entries(NUEVOS)) ok(igual((n as Record<string, unknown>)[k], v), `jsonb viejo → ${k} por defecto`);
  for (const [k, v] of Object.entries(VIEJO)) ok(igual((n as Record<string, unknown>)[k], v), `jsonb viejo conserva ${k}`);
  ok(n.resumen_cuando === "al_final", "jsonb viejo → resumen al final");
  ok(igual(normalizarAjustes(n), n), "idempotente sobre el jsonb viejo");
}

// Inválidos → defecto
for (const malo of ["TU", "vos", "Usted", 1, null, true, ["tu"]])
  ok(normalizarAjustes({ tratamiento: malo }).tratamiento === "usted", `tratamiento inválido → usted: ${JSON.stringify(malo)}`);
ok(normalizarAjustes({ tratamiento: "tu" }).tratamiento === "tu", "«tu» elegido se conserva");
for (const malo of ["una", "uno_por_mensaje", 0, null, {}])
  ok(normalizarAjustes({ preguntas: malo }).preguntas === "todo_junto", `preguntas inválido → todo junto: ${JSON.stringify(malo)}`);
ok(normalizarAjustes({ preguntas: "una_por_mensaje" }).preguntas === "una_por_mensaje", "«una por mensaje» elegido se conserva");
for (const malo of [5, null, "   ", ["x"]]) ok(normalizarAjustes({ resumen_titulo: malo }).resumen_titulo === "", `título inválido → automático: ${JSON.stringify(malo)}`);
for (const malo of ["", "   ", null, 3]) ok(normalizarAjustes({ resumen_cierre: malo }).resumen_cierre === "Con esto ya tengo todo lo necesario", `cierre vacío/inválido → defecto: ${JSON.stringify(malo)}`);
for (const malo of [null, 7, "  "]) ok(normalizarAjustes({ menu_saludo: malo }).menu_saludo === "", `menú inválido → sin menú: ${JSON.stringify(malo)}`);
for (const malo of ["true", 1, null]) ok(normalizarAjustes({ atencion_activa: malo }).atencion_activa === false, `atención activa no booleana → apagada: ${JSON.stringify(malo)}`);
ok(normalizarAjustes({ atencion_activa: true }).atencion_activa === true, "atención encendida se conserva");
for (const malo of ["1,2", 3, null, [7], [-1], [1.5], [1, "x"], [1, null], { 0: 1 }])
  ok(igual(normalizarAjustes({ atencion_dias: malo }).atencion_dias, [1, 2, 3, 4, 5]), `días inválidos → lun-vie: ${JSON.stringify(malo)}`);
ok(igual(normalizarAjustes({ atencion_dias: [3, 1, 1, 2, 6, 0] }).atencion_dias, [0, 1, 2, 3, 6]), "días únicos y ordenados");
ok(igual(normalizarAjustes({ atencion_dias: ["1", "2"] }).atencion_dias, [1, 2]), "días en texto se leen");
ok(igual(normalizarAjustes({ atencion_dias: [] }).atencion_dias, []), "días vacíos se CONSERVAN (no se inventa un horario)");
for (const malo of ["25:00", "9", "abc", "", null, 900, "09:60", "9h"])
  ok(normalizarAjustes({ atencion_desde: malo }).atencion_desde === "09:00", `desde inválido → 09:00: ${JSON.stringify(malo)}`);
for (const malo of ["24:00", "x", null]) ok(normalizarAjustes({ atencion_hasta: malo }).atencion_hasta === "18:00", `hasta inválido → 18:00: ${JSON.stringify(malo)}`);
ok(normalizarAjustes({ atencion_desde: "9:30" }).atencion_desde === "09:30", "«9:30» → «09:30»");
ok(normalizarAjustes({ atencion_hasta: "17:00:00" }).atencion_hasta === "17:00", "«17:00:00» → «17:00»");
ok(horaHHMM(" 7:05 ") === "07:05" && horaHHMM("23:59") === "23:59" && horaHHMM("24:00") === null, "horaHHMM");
{
  const n = normalizarAjustes({ atencion_desde: "17:00", atencion_hasta: "09:00" });
  ok(n.atencion_desde === "17:00" && n.atencion_hasta === "09:00", "hasta ≤ desde se CONSERVA tal cual");
}
// Largos: una línea, cortados por caracteres e idempotentes aunque el corte caiga en un espacio.
{
  const t = normalizarAjustes({ resumen_titulo: "📋 *RESUMEN*\n\n  DE   SOLICITUD" });
  ok(t.resumen_titulo === "📋 *RESUMEN* DE SOLICITUD", "título en UNA línea");
  const largo = "a".repeat(79) + " " + "b".repeat(40);
  const n = normalizarAjustes({ resumen_titulo: largo, resumen_cierre: "x".repeat(159) + " y".repeat(30), menu_saludo: "m".repeat(599) + " " + "z".repeat(50), reglas_extra: "r".repeat(3999) + " s" });
  ok(Array.from(n.resumen_titulo).length <= 80 && !/\s$/.test(n.resumen_titulo), "título ≤ 80, sin espacio colgando");
  ok(Array.from(n.resumen_cierre).length <= 160 && Array.from(n.menu_saludo).length <= 600, "cierre ≤ 160 y menú ≤ 600");
  ok(igual(normalizarAjustes(n), n), "idempotente con el corte en un espacio");
  const emoji = normalizarAjustes({ resumen_titulo: "x".repeat(79) + "📋📋" });
  ok(!/[\uD800-\uDBFF]$/.test(emoji.resumen_titulo) && Array.from(emoji.resumen_titulo).length === 80, "un emoji no se parte por la mitad");
  ok(normalizarAjustes({ menu_saludo: "1️⃣ Cotizar\n2️⃣ Mis servicios" }).menu_saludo === "1️⃣ Cotizar\n2️⃣ Mis servicios", "el menú conserva sus líneas");
}
{
  const completo = normalizarAjustes({
    ...VIEJO, tratamiento: "tu", preguntas: "una_por_mensaje", resumen_titulo: "📋 *RESUMEN DE SOLICITUD*",
    resumen_cierre: "¿Todo está correcto, {nombre}?", menu_saludo: "1. Cotizar\n2. Mis servicios", atencion_activa: true,
    atencion_dias: [6, 1, 2, 3, 4, 5], atencion_desde: "9:00", atencion_hasta: "17:00",
  });
  ok(igual(normalizarAjustes(completo), completo), "idempotente con todos los campos nuevos");
  ok(igual(normalizarAjustes(JSON.parse(JSON.stringify(completo))), completo), "ida y vuelta por jsonb");
  ok(igual(completo.atencion_dias, [1, 2, 3, 4, 5, 6]) && completo.atencion_desde === "09:00", "horario canónico");
}
ok(Object.keys(normalizarAjustes(null)).join() === Object.keys(AJUSTES_DEFECTO).join(), "normalizar devuelve los campos en el orden del defecto");

// ── Textos que arma el código ─────────────────────────────────────────────────────────────────────
// Copiado LITERAL de lib/crm-ia.ts (MENSAJE_DERIVACION_DEFECTO, antes de este cambio): con «tu» la
// derivación por defecto tiene que salir byte a byte igual.
const DERIVACION_DE_HOY =
  "Gracias, {nombre}. Ya registré tu solicitud y un ejecutivo de nuestro equipo la está revisando para enviarte la información por este mismo chat a la brevedad. 🙌";
ok(mensajeDerivacionDefecto("tu") === DERIVACION_DE_HOY, "derivación con tú = la de hoy, byte a byte");
ok(
  mensajeDerivacionDefecto("usted") ===
    "Gracias, {nombre}. Ya registré su solicitud y un ejecutivo de nuestro equipo la está revisando para enviarle la información por este mismo chat a la brevedad. 🙌",
  "derivación con usted",
);
ok(!/\b(tu|te|enviarte)\b/.test(mensajeDerivacionDefecto("usted").replace("{nombre}", "")), "la de usted no tutea");
ok(igual(estiloDe(AJUSTES_DEFECTO), { tratamiento: "usted", preguntas: "todo_junto" }), "estilo por defecto");
ok(igual(estiloDe({ tratamiento: "tu", preguntas: "una_por_mensaje" }), { tratamiento: "tu", preguntas: "una_por_mensaje" }), "estilo elegido");
ok(igual(estiloDe({ tratamiento: "x" as never, preguntas: undefined as never }), { tratamiento: "usted", preguntas: "todo_junto" }), "estilo con basura → defecto");
ok(TRATAMIENTOS.map((o) => o.valor).join() === "usted,tu" && MODOS_PREGUNTAS.map((o) => o.valor).join() === "todo_junto,una_por_mensaje", "listas de opciones");

ok(tituloResumen(AJUSTES_DEFECTO) === "📋 *Resumen de su solicitud*", "título automático con usted (el de hoy)");
ok(tituloResumen({ ...AJUSTES_DEFECTO, tratamiento: "tu" }) === "📋 *Resumen de tu solicitud*", "título automático con tú");
ok(tituloResumen({ ...AJUSTES_DEFECTO, resumen_titulo: "📋 *RESUMEN DE SOLICITUD*" }) === "📋 *RESUMEN DE SOLICITUD*", "título propio");
ok(cierreResumen(AJUSTES_DEFECTO, "Paola") === "Con esto ya tengo todo lo necesario", "cierre por defecto (el de hoy)");
const cierre = (c: string, n: string) => cierreResumen({ resumen_cierre: c }, n);
ok(cierre("¿Todo está correcto, {nombre}?", "Paola") === "¿Todo está correcto, Paola?", "cierre con nombre");
ok(cierre("¿Todo está correcto, {nombre}?", "") === "¿Todo está correcto?", "cierre sin nombre: sin coma colgando");
ok(cierre("{nombre}, ¿todo bien?", "") === "¿todo bien?", "nombre al inicio, sin nombre");
ok(cierre("Gracias {nombre}!", "") === "Gracias!", "sin espacio antes del signo");
ok(cierre("Hola {nombre}, ya tengo todo.", "") === "Hola, ya tengo todo.", "sin espacio antes de la coma");
ok(cierre("¿{nombre}, todo bien?", " ") === "¿todo bien?", "nombre en blanco = sin nombre");
ok(cierre("Listo, {nombre}", "") === "Listo", "coma final colgando");
ok(cierreResumen({ resumen_cierre: "" }, "x") === "Con esto ya tengo todo lo necesario", "cierre vacío → defecto");
ok(ponerNombre("Gracias, {nombre}. Ya registré", "") === "Gracias. Ya registré", "ponerNombre deja la derivación de hoy igual sin nombre");
ok(ponerNombre("Gracias, {nombre}. Ya", "$& Ana") === "Gracias, $& Ana. Ya", "un nombre con $& no se reinterpreta");
ok(ponerNombre("Sin llave ,  aquí", "") === "Sin llave ,  aquí", "sin {nombre} el texto no se toca");

// Presentación con {agente}, compatible con las llamadas de hoy.
const pres = (p: string, e: string, a?: string | null) => presentacion({ presentarse_como: p }, e, a);
ok(pres("{agente}, la asistente virtual de {empresa}", "AFA TRANSPORTES", "AFITA") === "AFITA, la asistente virtual de AFA TRANSPORTES", "presentación con {agente}");
ok(pres("{agente}, la asistente virtual de {empresa}", "ACME", "") === "la asistente virtual de ACME", "sin nombre: sin coma inicial");
ok(pres("{agente}, la asistente virtual de {empresa}", "ACME", null) === "la asistente virtual de ACME", "agente null");
ok(pres("{agente}, la asistente virtual de {empresa}", "ACME") === "la asistente virtual de ACME", "sin pasar agente");
ok(pres("Soy {agente} de {empresa}", "ACME", "  Luz  María ") === "Soy Luz María de ACME", "nombre limpio");
ok(pres("el asistente de {empresa}", "ACME", "AFITA") === "el asistente de ACME", "sin {agente} el nombre no se cuela");
ok(presentacion(AJUSTES_DEFECTO, "ACME") === "el asistente de ACME", "llamada de hoy, igual que antes");
ok(pres("el asistente de {empresa}", "") === "el asistente de la empresa", "sin empresa: «la empresa»");
ok(pres("{empresa} y {agente}", "A$&B", "{empresa}") === "A$&B y {empresa}", "una sola pasada: nada se reinterpreta");
ok(pres("{agente} - {empresa} , {agente}", "ACME", "") === "ACME", "sin nombre: sin restos de puntuación");

// ── Temas con ajuste ─────────────────────────────────────────────────────────────────────────────
{
  const columnas = ["pausa_humano_horas", "escalar_si", "mensaje_derivacion"];
  const anclas = new Set(Object.values(TEMAS_AJUSTE).map((t) => t.ancla));
  const esperadas = ["ajuste-tratamiento", "ajuste-preguntas", "ajuste-resumen", "ajuste-saludo", "ajuste-presentacion", "ajuste-archivos",
    "ajuste-audios", "ajuste-lugares", "ajuste-escalar", "ajuste-pausa-humano", "ajuste-atencion"];
  ok(igual([...anclas].sort(), [...esperadas].sort()), "las anclas son exactamente las del plan");
  for (const [tema, t] of Object.entries(TEMAS_AJUSTE)) {
    ok(t.etiqueta.trim().length > 0 && /^[A-ZÁÉÍÓÚÑ¿]/.test(t.etiqueta), `etiqueta legible: ${tema}`);
    ok(t.clave in AJUSTES_DEFECTO || columnas.includes(t.clave), `clave existe: ${tema} → ${t.clave}`);
  }
  ok(TEMAS_AJUSTE.identidad_ia.ancla === TEMAS_AJUSTE.presentacion.ancla, "identidad comparte el bloque de la presentación");
}
// Los motivos son las MISMAS palabras de escalar_a_humano: o el literal (antes de conectarlo) o la constante.
{
  const fuente = readFileSync(new URL("../lib/crm-ia.ts", import.meta.url), "utf8");
  ok(fuente.includes(`Úsala ${MOTIVOS_DERIVACION_SISTEMA}.`) || /Úsala \$\{MOTIVOS_DERIVACION_SISTEMA\}\./.test(fuente), "motivos = descripción de escalar_a_humano");
  ok(/^si /.test(MOTIVOS_DERIVACION_SISTEMA) && !/\.$/.test(MOTIVOS_DERIVACION_SISTEMA), "motivos en minúscula y sin punto final");
}

// ── Horario de atención ──────────────────────────────────────────────────────────────────────────
// 2026-10-17 sáb · 18 dom · 19 lun · 20 mar · 21 mié · 23 vie · 24 sáb
const AT = (dias: number[], desde = "09:00", hasta = "17:00", activa = true): Atencion => ({ activa, dias, desde, hasta });
const LUN_SAB = AT([1, 2, 3, 4, 5, 6]);
ok(igual(atencionDe(normalizarAjustes({ atencion_activa: true, atencion_dias: [1, 2, 3, 4, 5, 6], atencion_desde: "09:00", atencion_hasta: "17:00" })), LUN_SAB), "atencionDe");
ok(igual(atencionDe(AJUSTES_DEFECTO), AT([1, 2, 3, 4, 5], "09:00", "18:00", false)), "atencionDe del defecto: apagada");
ok(atencionValida(atencionDe(AJUSTES_DEFECTO)) && !atencionEnUso(atencionDe(AJUSTES_DEFECTO)), "el defecto es válido pero no está en uso");
ok(describirAtencion(LUN_SAB) === "de lunes a sábado, de 09:00 a 17:00", "describir lun-sáb");
ok(describirAtencion(AT([1, 3, 5])) === "lunes, miércoles y viernes, de 09:00 a 17:00", "describir días sueltos");
ok(describirDias([0, 1, 2, 3, 4, 5, 6]) === "todos los días", "todos los días");
ok(describirDias([1, 2, 3, 4, 5]) === "de lunes a viernes", "lun-vie");
ok(describirDias([0, 6]) === "sábado y domingo", "fin de semana");
ok(describirDias([6, 0, 1]) === "de sábado a lunes", "la semana da la vuelta");
ok(describirDias([0, 1, 3]) === "domingo, lunes y miércoles", "tramo con lunes primero");
ok(describirDias([1, 2, 3, 5]) === "de lunes a miércoles y viernes", "tramo y día suelto");
ok(describirDias([1, 2, 3, 5, 6]) === "de lunes a miércoles, viernes y sábado", "tramo y dos sueltos");
ok(describirDias([6]) === "los sábados" && describirDias([1]) === "los lunes", "un solo día");
ok(describirDias([]) === "ningún día", "sin días");

// sábado 18:00 → el lunes (el domingo no se atiende)
ok(!dentroDeAtencion(LUN_SAB, "2026-10-24", "18:00"), "sábado 18:00 fuera");
ok(proximaAtencion(LUN_SAB, "2026-10-24", "18:00") === "el lunes desde las 09:00", "sábado 18:00 → el lunes");
ok(
  fraseFueraDeAtencion(LUN_SAB, "2026-10-24", "18:00", "usted") ===
    " Nuestro horario de atención es de lunes a sábado, de 09:00 a 17:00; un ejecutivo le responderá el lunes desde las 09:00.",
  "frase fuera de horario con usted",
);
ok(
  fraseFueraDeAtencion(LUN_SAB, "2026-10-24", "18:00", "tu") ===
    " Nuestro horario de atención es de lunes a sábado, de 09:00 a 17:00; un ejecutivo te responderá el lunes desde las 09:00.",
  "frase fuera de horario con tú",
);
ok(proximaAtencion(LUN_SAB, "2026-10-18", "10:00") === "mañana lunes desde las 09:00", "domingo → mañana lunes");
ok(!dentroDeAtencion(LUN_SAB, "2026-10-18", "10:00"), "domingo a media mañana fuera (día sin atención)");
ok(proximaAtencion(LUN_SAB, "2026-10-19", "08:00") === "hoy desde las 09:00", "lunes 08:00 → hoy");
ok(dentroDeAtencion(LUN_SAB, "2026-10-19", "09:00") && dentroDeAtencion(LUN_SAB, "2026-10-19", "16:59"), "lunes 09:00 y 16:59 dentro");
ok(fraseFueraDeAtencion(LUN_SAB, "2026-10-19", "10:00", "usted") === "", "dentro del horario no se dice nada");
ok(proximaAtencion(LUN_SAB, "2026-10-19", "10:00") === "ahora", "dentro: «ahora»");
ok(!dentroDeAtencion(LUN_SAB, "2026-10-19", "17:00") && proximaAtencion(LUN_SAB, "2026-10-19", "17:00") === "mañana martes desde las 09:00", "a la hora de cierre ya cerró");
const LMV = AT([1, 3, 5]);
ok(!dentroDeAtencion(LMV, "2026-10-20", "10:00") && proximaAtencion(LMV, "2026-10-20", "10:00") === "mañana miércoles desde las 09:00", "martes sin atención → mañana miércoles");
ok(proximaAtencion(LMV, "2026-10-23", "18:00") === "el lunes desde las 09:00", "viernes noche → el lunes");
ok(proximaAtencion(AT([1]), "2026-10-19", "18:00") === "el próximo lunes desde las 09:00", "falta una semana entera");
ok(proximaAtencion(AT([1, 2], "01:00", "05:00"), "2026-10-19", "00:30") === "hoy desde la 01:00", "«la 01:00»");

// Inválidos: se conservan, no se usan, y se dice por qué.
const AL_REVES = AT([1, 2, 3, 4, 5, 6], "17:00", "09:00");
const IGUALES = AT([1, 2, 3], "09:00", "09:00");
const SIN_DIAS = AT([]);
for (const [nombre, at, prob] of [["hasta < desde", AL_REVES, "cierre_no_posterior"], ["hasta = desde", IGUALES, "cierre_no_posterior"], ["sin días", SIN_DIAS, "sin_dias"]] as const) {
  ok(!atencionValida(at) && !atencionEnUso(at), `${nombre}: inválido`);
  ok(problemaAtencion(at) === prob && PROBLEMA_ATENCION[prob].length > 0, `${nombre}: problema ${prob}`);
  ok(!dentroDeAtencion(at, "2026-10-19", "10:00") && proximaAtencion(at, "2026-10-19", "10:00") === null, `${nombre}: no se calcula`);
  ok(fraseFueraDeAtencion(at, "2026-10-24", "18:00", "usted") === "", `${nombre}: sin frase`);
}
ok(problemaAtencion(AT([1], "x", "17:00")) === "hora_invalida", "hora que no se entiende");
ok(fraseFueraDeAtencion(AT([1, 2, 3, 4, 5, 6], "09:00", "17:00", false), "2026-10-24", "18:00", "usted") === "", "apagado: sin frase aunque esté fuera");
ok(proximaAtencion(LUN_SAB, "24-10-2026", "18:00") === null && proximaAtencion(LUN_SAB, "2026-10-24", "tarde") === null, "fecha u hora que no se entiende → null");
ok(fraseFueraDeAtencion(LUN_SAB, "2026-13-45", "18:00", "usted") === "", "fecha imposible → sin frase");

// Barrido: 4 horarios × 7 días × 48 medias horas. Fuera ⟺ hay frase; la próxima cae en un día de
// atención y no antes de ese momento; dentro ⟺ «ahora».
{
  const horarios = [LUN_SAB, LMV, AT([0, 6], "08:00", "13:30"), AT([0, 1, 2, 3, 4, 5, 6], "00:00", "23:59")];
  const NOMBRES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  let fuera = 0, dentro = 0, malos = 0;
  for (const at of horarios)
    for (const fecha of ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"])
      for (let m = 0; m < 1440; m += 30) {
        const hh = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const den = dentroDeAtencion(at, fecha, hh);
        const prox = proximaAtencion(at, fecha, hh)!;
        const frase = fraseFueraDeAtencion(at, fecha, hh, "usted");
        if (den) { dentro++; if (prox !== "ahora" || frase !== "") malos++; continue; }
        fuera++;
        if (!frase.startsWith(" Nuestro horario de atención es ") || !frase.includes(prox) || !frase.endsWith(".")) malos++;
        if (prox.startsWith("hoy") && !at.dias.includes(new Date(`${fecha}T12:00:00Z`).getUTCDay())) malos++;
        const dia = NOMBRES.find((n) => prox.includes(` ${n} `));
        if (dia && !at.dias.includes(NOMBRES.indexOf(dia))) malos++;
      }
  ok(malos === 0, `barrido del horario sin contradicciones (${dentro} dentro · ${fuera} fuera)`);
  ok(dentro > 0 && fuera > 0, "corolario: el barrido encuentra momentos dentro Y fuera");
}
console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
