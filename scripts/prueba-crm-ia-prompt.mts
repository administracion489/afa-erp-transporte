// ANTHROPIC_API_KEY=x npx tsx scripts/prueba-crm-ia-prompt.mts
// Las instrucciones de la IA: lo de la empresa va AL FINAL y con prioridad dicha; el resumen del
// pedido aparece solo si está encendido, y entonces la regla general no prohíbe el «Solo me falta».
// Desde el 20-10-2026 (una fuente por comportamiento): el bloque «## Ajustes del agente» va entre las
// reglas del negocio y la «## Prioridad» de tres niveles, que sigue cerrando las instrucciones; y el
// prompt no se contradice a sí mismo en ninguna combinación de trato × preguntas × resumen ×
// recordar × traslados.
import {
  construirSystem, BLOQUE_TRASLADOS, textoSinImportesAjenos, bloqueTraslados, bloqueAjustes, PRIORIDAD,
  mensajeDerivacion, horasPausaHumano, trasladosDeConfig,
} from "../lib/crm-ia";
import { MOTIVOS_DERIVACION_SISTEMA, tituloResumen, mensajeDerivacionDefecto, type Tratamiento, type ModoPreguntas } from "../lib/crm-ia-ajustes";
let fallos = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else console.log("✓", m); };
const agente = {
  persona: "Eres Afita.", empresa_contexto: "AFA",
  goals: [{ titulo: "Resumen", instrucciones: "Al final, resume los datos y pide solo lo que falta." }],
  conocimiento: "Tarifas…", escalar_si: "reclamo", comportamiento: { reglas_extra: "Nunca prometas una unidad." },
};
const contacto = { nombre: "Paola Huarachi", empresa: null, telefono: null };
const conv = { id: "x", canal: "whatsapp" };
const p = construirSystem(agente, contacto, conv, true, "AFA Transportes");
const i = (t: string) => p.indexOf(t);
ok(i("## Resumen del pedido") > 0, "resumen del pedido presente por defecto");
// Por defecto el resumen va UNA vez, cuando ya están todos los datos (regla del dueño, 20-10-2026:
// lo mandaba en cada respuesta y su regla decía «el resumen se hace únicamente al final»).
ok(i("UNA vez, cuando ya tienes todos los datos") > 0, "por defecto: el resumen solo al final");
ok(i("NO resumas, no repitas ni confirmes lo que el cliente ya dio") > 0, "mientras falten datos no resume");
ok(i("Con esto ya tengo todo lo necesario") > 0 && i("📋 *Resumen de su solicitud*") > 0, "con todo completo, el resumen con su formato");
ok(i("*Solo me falta:*") < 0 && i("SÍ va en cada respuesta") < 0, "por defecto ya no pide el resumen en cada respuesta");
ok(i("No repitas una pregunta que ya hiciste") > 0, "por defecto, la regla de no repetir preguntas");
// ADAPTADA (20-10-2026): antes la prioridad decía «“Sobre la empresa”, tus objetivos… MANDAN ELLOS»
// en una sola frase. Ahora es el nivel 3 de la «## Prioridad»: en lo que no tiene ajuste, lo de la
// empresa (incluida «Sobre la empresa») manda sobre las reglas generales.
ok(p.includes("3. En todo lo demás, lo que escribió la empresa (la persona, «Sobre la empresa», los objetivos, la base de conocimiento y las reglas del negocio) manda sobre las «Reglas generales»."), "lo escrito en «Sobre la empresa» también manda sobre las reglas generales");
const cada = construirSystem({ ...agente, comportamiento: { reglas_extra: "Nunca prometas una unidad.", resumen_cuando: "cada_respuesta" } }, contacto, conv, true, "AFA Transportes");
const c = (x: string) => cada.indexOf(x);
ok(c("## Resumen del pedido (al final de tu respuesta)") > 0, "«cada respuesta»: el resumen al final de cada respuesta");
ok(c("*Solo me falta:*") > 0, "«cada respuesta»: formato con «Solo me falta»");
ok(c("No insistas con una pregunta suelta") > 0 && c("No repitas una pregunta que ya hiciste") < 0, "«cada respuesta»: la regla general no prohíbe el «Solo me falta»");
ok(c("UNA vez, cuando ya tienes todos los datos") < 0, "«cada respuesta»: sin el bloque de «solo al final»");
ok(i("## Tus objetivos") > i("## Reglas generales"), "objetivos después de las reglas generales");
ok(i("## Base de conocimiento") > i("## Tus objetivos"), "conocimiento después de objetivos");
ok(i("## Reglas del negocio") > i("## Base de conocimiento"), "reglas del negocio después");
// ADAPTADA: la prioridad sigue cerrando, pero su última frase ya no es «…datos de otros clientes.»;
// ahora es la constante PRIORIDAD entera, y antes de ella van los «Ajustes del agente».
ok(i("## Ajustes del agente") > i("## Reglas del negocio") && i("## Prioridad") > i("## Ajustes del agente") && p.trimEnd().endsWith(PRIORIDAD), "la prioridad cierra las instrucciones, después de los ajustes");
ok(i("SALUDO OBLIGATORIO") > 0 && /(Buenos días|Buenas tardes|Buenas noches), Paola/.test(p), "saludo con el primer nombre");
ok(!p.includes("Mensajes cortos"), "ya no dice «Mensajes cortos» (chocaba con el resumen)");
const sin = construirSystem({ ...agente, comportamiento: { resumen_pedido: false } }, contacto, conv, false, "AFA");
ok(!sin.includes("## Resumen del pedido") && sin.includes("No repitas una pregunta que ya hiciste"), "apagado: sin resumen y vuelve la regla de no repetir");
ok(!sin.includes("SALUDO OBLIGATORIO") && sin.includes("NO vuelvas a saludar"), "segundo mensaje del día: no saluda");
// Traslados (lib/traslados/envio-ia.ts): el bloque va ANTES de los objetivos de la empresa, solo
// cuando se ofrece `cotizar_traslado`; sin él, las instrucciones son las de siempre, byte a byte.
const conT = construirSystem(agente, contacto, conv, true, "AFA Transportes", { traslados: true });
const sinT = construirSystem(agente, contacto, conv, true, "AFA Transportes", { traslados: false });
const p2 = construirSystem(agente, contacto, conv, true, "AFA Transportes");
const t = (x: string) => conT.indexOf(x);
ok(sinT === p2 && !sinT.includes("## Traslados simples"), "sin traslados: idéntico a no pasar la opción, sin el bloque");
ok(t("## Traslados simples") > t("## Reglas generales") && t("## Traslados simples") < t("## Tus objetivos"), "con traslados: el bloque va antes de «## Tus objetivos»");
ok(conT.replace(BLOQUE_TRASLADOS + "\n", "") === sinT, "el bloque es lo ÚNICO que cambia");
// ADAPTADA: «cierra en la prioridad» (antes: en «…datos de otros clientes.», su última frase de entonces).
ok(conT.trimEnd().endsWith(PRIORIDAD), "con traslados sigue cerrando en la prioridad");
ok(/cotizar_traslado/.test(BLOQUE_TRASLADOS) && /NUNCA calcules ni inventes un precio/.test(BLOQUE_TRASLADOS), "usa la herramienta y nunca inventa precios");
ok(/en un solo mensaje/.test(BLOQUE_TRASLADOS) && /mensaje de derivación/.test(BLOQUE_TRASLADOS), "pregunta todo junto; deriva con el mensaje de derivación");
ok(/NO menciones ningún importe/.test(BLOQUE_TRASLADOS) && /EXACTAMENTE como vienen/.test(BLOQUE_TRASLADOS), "en revisión sin importes; en automático tal cual");
ok(/proponer_reserva/.test(BLOQUE_TRASLADOS) && /disponibilidad/.test(BLOQUE_TRASLADOS), "nunca confirma disponibilidad ni reserva; si acepta, proponer_reserva");
ok(/cliente_pide_dolares/.test(BLOQUE_TRASLADOS) && /EXPRESAMENTE/.test(BLOQUE_TRASLADOS), "si el cliente pide dólares, marca cliente_pide_dolares");
ok(!/No cambies el precio ni la moneda/.test(BLOQUE_TRASLADOS) && /No cambies el precio/.test(BLOQUE_TRASLADOS), "la moneda pedida en dólares ya no se deriva; el precio sigue sin cambiarse");
ok(/no contradice «NUNCA confirmes/.test(BLOQUE_TRASLADOS) && conT.includes("NUNCA confirmes que ya cotizaste"), "aclara que no contradice «NUNCA confirmes…», que sigue");
// El texto del turno con traslados (auditoría): con cotización lo escribe el código; sin ella, el
// del modelo solo pasa si no habla de dinero. textoSinImportesAjenos delega en textoFinalTraslado.
{
  const ag = { mensaje_derivacion: "Hola {nombre}, un ejecutivo te escribe por este chat." };
  const ct = { nombre: "Paola Huarachi" };
  const auto = textoSinImportesAjenos("El total sería 150 (IGV incluido)", { respuestaModelo: "", accion: "cotizar", cotizacion: { cotizacionId: 1, numero: "00123", decision: "automatico", figuras: [283.2], total: "S/ 283.20", validez: "18/11/2026" } }, ag, ct);
  // ADAPTADA (21-10-2026): el mensaje de la cotización ya no saluda ni usa el nombre del perfil.
  ok(auto.startsWith("Le envío la cotización N° 00123") && !/Paola|hola/i.test(auto) && auto.includes("S/ 283.20") && !auto.includes("150"), "con cotización, el texto del código (sin la cifra del modelo, sin saludo)");
  const rev = textoSinImportesAjenos("Serán aprox 300", { respuestaModelo: "", accion: "cotizar", cotizacion: { cotizacionId: 1, numero: "00124", decision: "revision", figuras: [] } }, ag, ct);
  ok(rev.includes("00124") && !/\d{3}(?!\d)/.test(rev.replace("00124", "")), "en revisión, el del código sin importes");
  const preg = textoSinImportesAjenos("Te sale gratis el retorno, ¿cuántas maletas?", { respuestaModelo: "", accion: "preguntar", faltan: ["la cantidad de maletas"] }, ag, ct);
  // ADAPTADA: el agente sin `comportamiento.tratamiento` es de USTED (el defecto del ajuste), y el
  // «me falta» que escribe el código lee ese ajuste. El literal de antes es el de «tu», abajo.
  ok(preg === "Para cotizar su traslado me falta: la cantidad de maletas.", "preguntar con dinero → «me falta» (de usted, el defecto)");
  const preguntaTu = textoSinImportesAjenos("Te sale gratis el retorno", { respuestaModelo: "", accion: "preguntar", faltan: ["la cantidad de maletas"] }, { ...ag, comportamiento: { tratamiento: "tu" } }, ct);
  ok(preguntaTu === "Para cotizar tu traslado me falta: la cantidad de maletas.", "con trato de tú, el literal de siempre");
  const der = textoSinImportesAjenos("Son 150$", { respuestaModelo: "", accion: "derivar" }, ag, ct);
  ok(der === "Hola Paola, un ejecutivo te escribe por este chat.", "derivar con dinero → el mensaje de derivación");
  ok(textoSinImportesAjenos("¿Cuántas maletas llevan?", { respuestaModelo: "", accion: "preguntar", faltan: ["x"] }, ag, ct) === "¿Cuántas maletas llevan?", "sin dinero, el del modelo pasa");
  ok(textoSinImportesAjenos("Cuesta S/ 999", null, ag, ct) === "Cuesta S/ 999", "sin la herramienta, no se toca");
}

// ── Los textos del código leen el trato y el modo de preguntar del agente ─────────────────────────
{
  const ct = { nombre: "Paola Huarachi" };
  const f2 = ["la cantidad de maletas", "la hora de recojo"];
  const preg = (comp: Record<string, unknown>) =>
    textoSinImportesAjenos("Te sale gratis", { respuestaModelo: "", accion: "preguntar", faltan: f2 }, { comportamiento: comp }, ct);
  ok(preg({ tratamiento: "tu", preguntas: "todo_junto" }) === "Para cotizar tu traslado me falta: la cantidad de maletas; la hora de recojo.", "tú + todo junto");
  ok(preg({ tratamiento: "tu", preguntas: "una_por_mensaje" }) === "Para cotizar tu traslado, ¿me indicas la cantidad de maletas?", "tú + uno por mensaje");
  ok(preg({ tratamiento: "usted", preguntas: "una_por_mensaje" }) === "Para cotizar su traslado, ¿me indica la cantidad de maletas?", "usted + uno por mensaje");
  const cot = { respuestaModelo: "", accion: "cotizar" as const, cotizacion: { cotizacionId: 1, numero: "7", decision: "revision" as const, figuras: [] } };
  ok(textoSinImportesAjenos("x", cot, { comportamiento: { tratamiento: "tu" } }, ct).startsWith("Registré tu pedido"), "cotización de tú");
  ok(textoSinImportesAjenos("x", cot, {}, ct).startsWith("Registré su pedido"), "cotización de usted (el defecto)");
  // La derivación por defecto (sin plantilla del dueño) también lee el trato.
  const der = (comp: Record<string, unknown>) => textoSinImportesAjenos("Son 150$", { respuestaModelo: "", accion: "derivar" }, { comportamiento: comp }, ct);
  ok(der({ tratamiento: "tu" }) === mensajeDerivacionDefecto("tu").replace("{nombre}", "Paola"), "derivación por defecto de tú");
  ok(der({}) === mensajeDerivacionDefecto("usted").replace("{nombre}", "Paola"), "derivación por defecto de usted");
}

// ── mensajeDerivacion: el trato, el nombre y el horario de atención ───────────────────────────────
{
  const ct = { nombre: "paola huarachi" };
  const SAB_18 = { fecha: "2026-10-24", hora: "18:00" }; // sábado, fuera de un lun-sáb 09-17
  const LUN_10 = { fecha: "2026-10-19", hora: "10:00" }; // lunes, dentro
  // Copiado LITERAL de la versión anterior (MENSAJE_DERIVACION_DEFECTO): con «tu», byte a byte.
  const DE_ANTES = "Gracias, Paola. Ya registré tu solicitud y un ejecutivo de nuestro equipo la está revisando para enviarte la información por este mismo chat a la brevedad. 🙌";
  ok(mensajeDerivacion({ comportamiento: { tratamiento: "tu" } }, ct, SAB_18) === DE_ANTES, "tú, sin horario: el texto de antes, byte a byte");
  ok(mensajeDerivacion({ comportamiento: { tratamiento: "tu" } }, {}, SAB_18) === DE_ANTES.replace("Gracias, Paola.", "Gracias."), "sin nombre se quita la coma colgante, como antes");
  ok(mensajeDerivacion({}, ct, SAB_18) === "Gracias, Paola. Ya registré su solicitud y un ejecutivo de nuestro equipo la está revisando para enviarle la información por este mismo chat a la brevedad. 🙌", "usted (el defecto)");
  const atencion = { atencion_activa: true, atencion_dias: [1, 2, 3, 4, 5, 6], atencion_desde: "09:00", atencion_hasta: "17:00" };
  ok(mensajeDerivacion({ comportamiento: atencion }, ct, SAB_18).endsWith("a la brevedad. 🙌 Nuestro horario de atención es de lunes a sábado, de 09:00 a 17:00; un ejecutivo le responderá el lunes desde las 09:00."), "fuera del horario: la plantilla por defecto dice cuándo responde un ejecutivo");
  ok(mensajeDerivacion({ comportamiento: { ...atencion, tratamiento: "tu" } }, ct, SAB_18).endsWith("un ejecutivo te responderá el lunes desde las 09:00."), "fuera del horario, de tú");
  ok(!mensajeDerivacion({ comportamiento: atencion }, ct, LUN_10).includes("horario"), "dentro del horario: nada");
  ok(!mensajeDerivacion({ comportamiento: { ...atencion, atencion_activa: false } }, ct, SAB_18).includes("horario"), "horario apagado: nada");
  ok(!mensajeDerivacion({ comportamiento: { ...atencion, atencion_hasta: "08:00" } }, ct, SAB_18).includes("horario"), "horario inválido: nada");
  // La plantilla del dueño: su texto tal cual; la frase del horario solo donde escriba {atencion}.
  const propia = "Gracias {nombre}, ya te atiende un ejecutivo.";
  ok(mensajeDerivacion({ mensaje_derivacion: propia, comportamiento: atencion }, ct, SAB_18) === "Gracias Paola, ya te atiende un ejecutivo.", "plantilla propia sin {atencion}: no se le pega nada");
  const conLlave = "Gracias {nombre}, ya registré su solicitud.{atencion} 🙌";
  ok(mensajeDerivacion({ mensaje_derivacion: conLlave, comportamiento: atencion }, ct, SAB_18) === "Gracias Paola, ya registré su solicitud. Nuestro horario de atención es de lunes a sábado, de 09:00 a 17:00; un ejecutivo le responderá el lunes desde las 09:00. 🙌", "con {atencion}, fuera: ahí entra la frase");
  ok(mensajeDerivacion({ mensaje_derivacion: conLlave, comportamiento: atencion }, ct, LUN_10) === "Gracias Paola, ya registré su solicitud. 🙌", "con {atencion}, dentro: la llave se va limpia");
  ok(mensajeDerivacion({ mensaje_derivacion: "Hola {nombre}. {atencion}", comportamiento: atencion }, ct, LUN_10) === "Hola Paola.", "con {atencion} al final y dentro: sin espacio colgando");
  // ADAPTADA (auditoría 20-10): el nombre pasa por primerNombreSeguro, así que «$&x» ni se
  // reinterpreta ni se repite (no es un nombre).
  ok(mensajeDerivacion({ mensaje_derivacion: "Hola {nombre}." }, { nombre: "$&x" }, SAB_18) === "Hola.", "un nombre con «$&» no se reinterpreta ni se repite");
}

// ── bloqueTraslados: con «todo junto», BYTE A BYTE el bloque de antes ─────────────────────────────
{
  // Copiado LITERAL del BLOQUE_TRASLADOS anterior al ajuste.
  const ANTES = [
    "## Traslados simples (cotización con el tarifario)",
    "- Un traslado simple es UN punto de recojo → UN destino (por ejemplo aeropuerto ↔ hotel o domicilio), solo ida o ida y retorno, en una sola fecha y con un solo vehículo. Para eso usa cotizar_traslado: el vehículo, el precio, la moneda y la validez los pone el sistema con el tarifario. NUNCA calcules ni inventes un precio de traslado, ni uses cotizacion_estimada para eso.",
    "- Llámala en cuanto el cliente pida el precio de un traslado, aunque falten datos. Si responde «preguntar», pide TODO lo que falta en un solo mensaje y vuelve a llamarla cuando conteste.",
    // ADAPTADA (21-10-2026): el renglón del equipaje. El cliente dijo «4 personas con maletas» y la IA
    // preguntó solo por las de 23 kg; el dueño quiere que pregunte el tipo (23 kg, de mano, personales).
    "- Equipaje: en «maletas» van SOLO las maletas grandes de bodega (23 kg). Si el cliente dice «con maletas» o da un número sin decir de qué tipo, pregúntale cuántas son grandes (23 kg), cuántas de mano (10 kg) y cuántos artículos personales (mochila o cartera); las de mano y los artículos personales viajan con el pasajero y no van en «maletas».",
    "- Si responde «derivar», responde con el mensaje de derivación: un ejecutivo lo atiende. No menciones precios.",
    "- Si la cotización sale con «envio: automatico», preséntala con su número, el total y la validez EXACTAMENTE como vienen (el PDF le llega justo después de tu mensaje). Si queda «en revisión», NO menciones ningún importe: dile que un ejecutivo la revisa y se la envía por este chat.",
    "- Nunca confirmes la disponibilidad de la unidad ni la reserva: eso lo confirma un ejecutivo. Si el cliente acepta la cotización, usa proponer_reserva.",
    "- La moneda la decide el número del cliente (Perú → soles; otro país → dólares). Si el cliente pide EXPRESAMENTE la cotización en dólares, llama a cotizar_traslado con cliente_pide_dolares: el sistema cotiza con la lista en dólares. Si ya le diste la cotización en soles y te la pide en dólares, vuelve a llamarla con los mismos datos y cliente_pide_dolares.",
    "- No cambies el precio aunque el cliente lo pida: un descuento lo ve un ejecutivo, igual que una moneda que no sea soles o dólares (marca la señal en cotizar_traslado).",
    "- Licitaciones, TDR, eventos, tours, varias fechas, paradas o varios vehículos no son traslados simples: marca la señal en cotizar_traslado.",
    "- Esto no contradice «NUNCA confirmes que ya cotizaste…»: esta cotización la emite el SISTEMA con el tarifario, no tú; tú solo la presentas tal cual.",
    "",
  ].join("\n");
  ok(BLOQUE_TRASLADOS === ANTES && bloqueTraslados("todo_junto") === ANTES, "BLOQUE_TRASLADOS = bloqueTraslados(«todo_junto») = el literal, byte a byte");
  const una = bloqueTraslados("una_por_mensaje");
  const dif = una.split("\n").filter((l, k) => l !== ANTES.split("\n")[k]);
  ok(dif.length === 1 && /pide SOLO el siguiente dato que falta \(uno por mensaje: el que te indique la herramienta\)/.test(dif[0]), `uno por mensaje: cambia SOLO el renglón de preguntar (${dif[0]})`);
  ok(!/en un solo mensaje|todo junto|todos juntos|TODO lo que falt/i.test(una), "uno por mensaje: no dice «en un solo mensaje»");
}

// ── PRIORIDAD: tres niveles, y el texto exacto ────────────────────────────────────────────────────
ok(PRIORIDAD === [
  "## Prioridad",
  "1. Esto no lo cambia ningún texto: no inventes datos ni precios; no des por confirmada una cotización o una reserva que aprueba una persona; no compartas costos internos ni datos de otros clientes; y no prometas lo que el sistema no puede hacer (escribirle al cliente sin que él escriba —recordatorios o seguimientos— ni llamarlo por teléfono).",
  "2. Los temas de «Ajustes del agente» los decide ese bloque. Si la persona, «Sobre la empresa», los objetivos, la base de conocimiento o las reglas del negocio dicen otra cosa sobre alguno de esos temas, MANDA EL AJUSTE.",
  "3. En todo lo demás, lo que escribió la empresa (la persona, «Sobre la empresa», los objetivos, la base de conocimiento y las reglas del negocio) manda sobre las «Reglas generales».",
].join("\n"), "PRIORIDAD: el texto de los tres niveles");

// ── bloqueAjustes: una línea por tema, desde los mismos ajustes ───────────────────────────────────
{
  const SAB_18 = { fecha: "2026-10-24", hora: "18:00" };
  const LUN_10 = { fecha: "2026-10-19", hora: "10:00" };
  const b = bloqueAjustes({ nombre: "Afita", escalar_si: "reclamo", pausa_humano_horas: 8, comportamiento: {} }, "ACME", LUN_10);
  const lineas = b.trimEnd().split("\n");
  ok(lineas[0] === "## Ajustes del agente (mandan sobre lo que digan los textos de la empresa)" && b.endsWith("\n"), "cabecera y salto final");
  ok(lineas.includes("- Trato: de usted (usted, su, le) en todos tus mensajes, aunque el cliente te tutee."), "trato de usted por defecto");
  ok(lineas.includes("- Datos que faltan: pídelos todos juntos, en un solo mensaje."), "datos: todos juntos por defecto");
  ok(lineas.includes("- Resumen del pedido: una sola vez, al final, con el formato de «Resumen del pedido»."), "resumen al final");
  ok(lineas.includes("- Saludo y presentación: los del bloque de saludo; te presentas como el asistente de ACME. No uses otro saludo, otra presentación ni otro menú."), "saludo y presentación");
  ok(!b.includes("ofrécele estas opciones"), "sin menú, ninguna línea de menú");
  ok(lineas.includes("- Que eres una IA: no lo digas salvo que te lo pregunten."), "ocultar la IA");
  ok(lineas.includes("- Fotos y documentos: los lees tú y usas sus datos; no digas que un asesor los revisará."), "archivos");
  ok(lineas.includes("- Notas de voz: llegan transcritas y las respondes tú; no digas que no puedes escucharlas."), "audios");
  ok(lineas.some((l) => l.startsWith("- Dirección exacta: no la pidas para el aeropuerto")), "dirección exacta");
  ok(lineas.includes(`- Pasar a una persona (escalar_a_humano y el mensaje de derivación): ${MOTIVOS_DERIVACION_SISTEMA}, y si el mensaje menciona: reclamo. Al derivar, el sistema pausa la IA en ese chat.`), "derivar: los motivos del sistema y escalar_si");
  ok(lineas.includes("- Si una persona del equipo contesta en el chat, el sistema te aparta 8 h: no tienes que hacer nada."), "pausa humana");
  ok(!b.includes("Horario de atención"), "sin horario declarado, sin línea de horario");
  const otro = bloqueAjustes({ comportamiento: {
    tratamiento: "tu", preguntas: "una_por_mensaje", resumen_pedido: false, saludo_activo: false, ocultar_ia: false,
    leer_archivos: false, transcribir_audios: false, lugares_conocidos: "", campos_pedido: "ruta, fecha",
  }, pausa_humano_horas: 0 }, "", LUN_10);
  ok(otro.includes("- Trato: de tú (tú, tu, te) en todos tus mensajes.") && !/de usted/i.test(otro), "trato de tú");
  ok(otro.includes("- Datos que faltan: pide UNO por mensaje, en el orden de los datos del pedido; cuando conteste, el siguiente. No adelantes las otras preguntas. Datos del pedido, en orden: ruta, fecha."), "uno por mensaje, con los datos nombrados (sin resumen no están en otro lado)");
  ok(!/Resumen del pedido|Saludo y presentación|Que eres una IA|Dirección exacta|te aparta/.test(otro), "un booleano apagado no tiene línea (resumen, saludo, IA, pausa en 0, sin lugares)");
  ok(otro.includes("- Fotos y documentos: no los ves; di que un ejecutivo los revisará.") && otro.includes("- Notas de voz: no las escuchas; deriva con escalar_a_humano y di que un ejecutivo las escuchará."), "archivos y audios apagados también se dicen");
  ok(otro.includes(`- Pasar a una persona (escalar_a_humano y el mensaje de derivación): ${MOTIVOS_DERIVACION_SISTEMA}. Al derivar`), "sin escalar_si, solo los motivos del sistema");
  const cadaB = bloqueAjustes({ comportamiento: { resumen_cuando: "cada_respuesta" } }, "", LUN_10);
  ok(cadaB.includes("- Resumen del pedido: al final de cada respuesta mientras falten datos, con el formato de «Resumen del pedido»."), "resumen en cada respuesta");
  // Menú: tal cual, y solo con el saludo encendido.
  const menu = "1️⃣ Cotizar\n2️⃣ Consultar un servicio";
  ok(bloqueAjustes({ comportamiento: { menu_saludo: menu } }, "", LUN_10).includes(`- Si el cliente solo saluda o no dice qué necesita, después del saludo ofrécele estas opciones, tal cual:\n${menu}`), "menú tal cual");
  ok(bloqueAjustes({ comportamiento: { menu_saludo: "Cotizar o consultar" } }, "", LUN_10).includes("tal cual: Cotizar o consultar"), "menú de una línea, en la misma línea");
  ok(!bloqueAjustes({ comportamiento: { menu_saludo: menu, saludo_activo: false } }, "", LUN_10).includes("ofrécele"), "sin saludo, sin menú");
  // {agente} en la presentación.
  const pres = { comportamiento: { presentarse_como: "{agente}, la asistente virtual de {empresa}" }, nombre: "AFITA" };
  ok(bloqueAjustes(pres, "AFA Transportes", LUN_10).includes("te presentas como AFITA, la asistente virtual de AFA Transportes."), "{agente} en el bloque");
  ok(construirSystem(pres, contacto, conv, true, "AFA Transportes").includes("preséntate como AFITA, la asistente virtual de AFA Transportes."), "{agente} en las reglas generales");
  ok(bloqueAjustes({ ...pres, nombre: null }, "AFA Transportes", LUN_10).includes("te presentas como la asistente virtual de AFA Transportes."), "sin nombre de agente, sin la llave ni la coma");
  // Pausa: la MISMA lectura que el motor (12 si no hay número; null es 0, como Number(null)).
  ok(horasPausaHumano({}) === 12 && horasPausaHumano({ pausa_humano_horas: null }) === 0 && horasPausaHumano({ pausa_humano_horas: "6" }) === 6 && horasPausaHumano({ pausa_humano_horas: "x" }) === 12, "horasPausaHumano");
  ok(bloqueAjustes({}, "", LUN_10).includes("te aparta 12 h"), "sin el campo: 12 h, como el motor");
  // Horario de atención del equipo: solo declarado y válido; dentro / fuera con la próxima apertura.
  const at = { atencion_activa: true, atencion_dias: [1, 2, 3, 4, 5, 6], atencion_desde: "09:00", atencion_hasta: "17:00" };
  ok(bloqueAjustes({ comportamiento: at }, "", LUN_10).includes("- Horario de atención del equipo: de lunes a sábado, de 09:00 a 17:00. Ahora estás dentro de ese horario."), "horario: dentro");
  ok(bloqueAjustes({ comportamiento: at }, "", SAB_18).includes("- Horario de atención del equipo: de lunes a sábado, de 09:00 a 17:00. Ahora estás FUERA de ese horario: al derivar, avísale al cliente que un ejecutivo responderá el lunes desde las 09:00; no prometas una respuesta inmediata."), "horario: fuera, con la próxima apertura");
  ok(!bloqueAjustes({ comportamiento: { ...at, atencion_hasta: "08:00" } }, "", SAB_18).includes("Horario de atención"), "horario inválido: no entra");
  ok(!bloqueAjustes({ comportamiento: { ...at, atencion_activa: false } }, "", SAB_18).includes("Horario de atención"), "horario apagado: no entra");
  ok(!bloqueAjustes({ comportamiento: at, hora_inicio: "08:00", hora_fin: "20:00", horario_activo: true }, "", SAB_18).includes("08:00"), "el horario de la IA (hora_inicio/hora_fin) no es el de atención");
}

// ── El idioma por defecto lee crm_agentes_ia.idioma ───────────────────────────────────────────────
ok(construirSystem({ ...agente, idioma: "es" }, contacto, conv).includes("(por defecto español peruano)"), "idioma es → español peruano (como antes)");
ok(construirSystem(agente, contacto, conv).includes("(por defecto español peruano)"), "sin idioma → español peruano");
ok(construirSystem({ ...agente, idioma: "en" }, contacto, conv).includes("(por defecto inglés)"), "idioma en → inglés");

// ── escalar_a_humano: la descripción es la de antes, con los motivos de la constante ──────────────
ok(
  `Pasa la conversación a un ejecutivo y pausa tu intervención. Úsala ${MOTIVOS_DERIVACION_SISTEMA}. Una solicitud de COTIZACIÓN no es motivo para derivar: para eso están cotizacion_estimada y proponer_cotizacion. Tras llamarla responde con el mensaje de derivación: un ejecutivo revisará y le enviará la información por este chat.` ===
    "Pasa la conversación a un ejecutivo y pausa tu intervención. Úsala si el cliente lo pide, está molesto, hay un reclamo, contrato/licitación, si no encuentras en el sistema lo que pide (servicios, choferes, placas, documentos), si no puedes escuchar una nota de voz, o algo fuera de tu alcance. Una solicitud de COTIZACIÓN no es motivo para derivar: para eso están cotizacion_estimada y proponer_cotizacion. Tras llamarla responde con el mensaje de derivación: un ejecutivo revisará y le enviará la información por este chat.",
  "la descripción de escalar_a_humano no cambia (byte a byte)",
);

// ── /api/crm/ia/estado → traslados: true / false / null ───────────────────────────────────────────
ok(trasladosDeConfig({ iaCotiza: true, sinMigracion: false, detalle: null }) === true, "traslados: encendido → true");
ok(trasladosDeConfig({ iaCotiza: false, sinMigracion: false, detalle: null }) === false, "traslados: apagado → false");
ok(trasladosDeConfig({ iaCotiza: false, sinMigracion: true, detalle: "Falta supabase/traslados-01-tablas.sql." }) === false, "traslados: sin migración → false");
ok(trasladosDeConfig({ iaCotiza: false, sinMigracion: false, detalle: "No se pudo leer traslados_config: x" }) === null, "traslados: no se pudo leer → null (no se afirma nada)");
ok(trasladosDeConfig(null) === null, "traslados: sin configuración → null");

// ── Barrido: trato × preguntas × resumen × recordar × traslados, SIN contradicciones internas ─────
{
  const base = { persona: "Eres el asistente.", empresa_contexto: "Transporte.", goals: [{ titulo: "Atender", instrucciones: "Ayuda al cliente." }], conocimiento: "Datos.", escalar_si: null };
  let n = 0;
  for (const trato of ["usted", "tu"] as Tratamiento[])
    for (const preguntas of ["todo_junto", "una_por_mensaje"] as ModoPreguntas[])
      for (const resumen of ["apagado", "al_final", "cada_respuesta"] as const)
        for (const recordar of [true, false])
          for (const traslados of [false, true]) {
            n++;
            const nom = `${trato}/${preguntas}/${resumen}/${recordar ? "recuerda" : "no recuerda"}/${traslados ? "traslados" : "sin traslados"}`;
            const comp = {
              tratamiento: trato, preguntas, recordar_datos: recordar, reglas_extra: "Regla del negocio.",
              resumen_pedido: resumen !== "apagado", resumen_cuando: resumen === "cada_respuesta" ? "cada_respuesta" : "al_final",
            };
            const ag = { ...base, comportamiento: comp };
            const P = construirSystem(ag, contacto, conv, true, "ACME", { traslados });
            const SIN = construirSystem(ag, contacto, conv, true, "ACME", { traslados: false });
            const k = (x: string) => P.indexOf(x);
            // Orden: … reglas del negocio → Ajustes del agente → Prioridad, que cierra.
            ok(k("## Reglas del negocio") > k("## Tus objetivos") && k("## Ajustes del agente") > k("## Reglas del negocio") && k("## Prioridad") > k("## Ajustes del agente") && P.trimEnd().endsWith(PRIORIDAD), `${nom}: orden y cierre`);
            ok(P.split("## Ajustes del agente").length === 2 && P.split("## Prioridad").length === 2, `${nom}: un solo bloque de ajustes y una sola prioridad`);
            // Traslados: el bloque del modo de preguntar es lo único que cambia.
            ok(traslados ? P.replace(bloqueTraslados(preguntas) + "\n", "") === SIN && k("## Traslados simples") < k("## Tus objetivos") : P === SIN, `${nom}: el bloque de traslados es lo único que cambia`);
            // Preguntas: con uno por mensaje, NINGUNA frase de pedir datos los pide todos juntos.
            if (preguntas === "una_por_mensaje") {
              ok(!/todo junto|todos juntos|en un solo mensaje|TODO lo que falt|en el mismo mensaje en que avanzas|juntos en una línea/i.test(P), `${nom}: nada pide los datos todos juntos`);
              ok(P.includes("- Datos que faltan: pide UNO por mensaje"), `${nom}: el ajuste lo dice`);
              if (recordar || resumen !== "apagado") ok(P.includes("pide SOLO el siguiente dato que falta (uno por mensaje"), `${nom}: «lo que el cliente ya dijo» / el resumen piden el siguiente`);
            } else {
              ok(P.includes("- Datos que faltan: pídelos todos juntos, en un solo mensaje.") && !/UNO por mensaje|SOLO el siguiente dato|Lo siguiente que necesito/.test(P), `${nom}: todo junto, sin «uno por mensaje»`);
            }
            // Trato: con usted no tutea ni dice «de tú»; con tú no dice «de usted».
            if (trato === "usted") ok(!/tutea|de tú/i.test(P) && P.includes("- Trato: de usted"), `${nom}: de usted, sin «tutea» ni «de tú»`);
            else ok(!/de usted/i.test(P) && P.includes("- Trato: de tú"), `${nom}: de tú, sin «de usted»`);
            // Los textos del código citados en el prompt, con el MISMO trato.
            ok(P.includes(`«${mensajeDerivacion(ag, contacto)}»`) && P.includes(trato === "tu" ? "Ya registré tu solicitud" : "Ya registré su solicitud"), `${nom}: la derivación citada es la del código, con su trato`);
            const titulo = tituloResumen({ resumen_titulo: "", tratamiento: trato });
            const otroTitulo = tituloResumen({ resumen_titulo: "", tratamiento: trato === "tu" ? "usted" : "tu" });
            ok(resumen === "apagado" ? !P.includes("## Resumen del pedido") && !P.includes("📋") : P.includes(titulo) && !P.includes(otroTitulo), `${nom}: título del resumen con el trato`);
            // Resumen en cada respuesta: la última línea depende del modo de preguntar.
            if (resumen === "cada_respuesta") {
              ok(preguntas === "una_por_mensaje"
                ? P.includes("*Lo siguiente que necesito:*") && !P.includes("Solo me falta")
                : P.includes("*Solo me falta:*") && !P.includes("Lo siguiente que necesito"), `${nom}: «Solo me falta» / «Lo siguiente que necesito»`);
            }
            // La regla general de no repetir no choca con el resumen.
            ok(resumen === "cada_respuesta" ? P.includes("No insistas con una pregunta suelta") && !P.includes("No repitas una pregunta que ya hiciste") : P.includes("No repitas una pregunta que ya hiciste"), `${nom}: regla de no repetir coherente con el resumen`);
          }
  console.log(`  barrido: ${n} combinaciones`);
  ok(n === 48, "corolario: el barrido recorrió las 48 combinaciones");
}
// «Datos del pedido» con emojis: el resumen usa esos emojis en lugar de «•» (pedido del dueño, 20-10-2026).
{
  const base = construirSystem({ ...agente, comportamiento: { reglas_extra: "x" } }, contacto, conv, true, "AFA Transportes");
  const conE = construirSystem({ ...agente, comportamiento: { reglas_extra: "x", campos_pedido: "📅 fecha del servicio, 🕐 hora de recojo, 👥 pasajeros" } }, contacto, conv, true, "AFA Transportes");
  ok(!base.includes("pon ese emoji en su renglón"), "sin emojis en los datos del pedido, el formato es el de siempre");
  ok(conE.includes("pon ese emoji en su renglón") && conE.includes("📅 fecha del servicio"), "con emojis en los datos del pedido, el resumen los usa");
  const cadaE = construirSystem({ ...agente, comportamiento: { reglas_extra: "x", resumen_cuando: "cada_respuesta", campos_pedido: "📅 fecha" } }, contacto, conv, true, "AFA Transportes");
  ok(cadaE.includes("pon ese emoji en su renglón"), "también con el resumen en cada respuesta");
}
// Auditoría 20-10: el nombre del perfil de WhatsApp lo elige el cliente; en la derivación pasa por primerNombreSeguro.
{
  const d = mensajeDerivacion({}, { nombre: "S/150" });
  ok(!/S\/150|150/.test(d) && d.length > 0, "derivación: un nombre «S/150» no se repite");
  ok(mensajeDerivacion({}, { nombre: "paola huarachi" }).includes("Paola"), "derivación: un nombre normal sigue saliendo");
}
// La reserva de traslados (22-10-2026): APAGADA el prompt es byte a byte el de antes; ENCENDIDA
// (solo con traslados) cambia la frase de proponer_reserva por reservar_traslado y añade «## Reserva
// y pago de traslados» justo después del bloque de traslados, y NADA más cambia.
{
  const { FRASE_PROPONER_RESERVA_TRASLADOS, FRASE_RESERVAR_TRASLADO, bloqueReservaTraslados } = await import("../lib/traslados/reserva-ia");
  const combos: [string, Record<string, unknown>][] = [
    ["por defecto", agente],
    ["de tú, uno por mensaje", { ...agente, comportamiento: { tratamiento: "tu", preguntas: "una_por_mensaje" } }],
    ["sin resumen", { ...agente, comportamiento: { resumen_pedido: false } }],
  ];
  for (const [nom, ag] of combos) {
    const conT = construirSystem(ag, contacto, conv, true, "AFA Transportes", { traslados: true });
    const conT0 = construirSystem(ag, contacto, conv, true, "AFA Transportes", { traslados: true, reserva: false });
    const sinT = construirSystem(ag, contacto, conv, true, "AFA Transportes", { traslados: false });
    const sinTR = construirSystem(ag, contacto, conv, true, "AFA Transportes", { traslados: false, reserva: true });
    const conR = construirSystem(ag, contacto, conv, true, "AFA Transportes", { traslados: true, reserva: true });
    ok(conT0 === conT, `reserva apagada (${nom}): el prompt con traslados es byte a byte el de antes`);
    ok(sinTR === sinT, `reserva sin traslados (${nom}): el prompt es byte a byte el de sin traslados`);
    ok(conR.includes(FRASE_RESERVAR_TRASLADO) && !conR.includes(FRASE_PROPONER_RESERVA_TRASLADOS), `reserva encendida (${nom}): reservar_traslado reemplaza a proponer_reserva en traslados`);
    ok(conR.includes("## Reserva y pago de traslados"), `reserva encendida (${nom}): está el bloque de reserva y pago`);
    ok(conR.indexOf("## Traslados simples") < conR.indexOf("## Reserva y pago de traslados") && conR.indexOf("## Reserva y pago de traslados") < conR.indexOf("## Tus objetivos"),
      `reserva encendida (${nom}): el bloque va después de traslados y antes de los objetivos`);
    ok(conR.replace(bloqueReservaTraslados() + "\n", "").replace(FRASE_RESERVAR_TRASLADO, FRASE_PROPONER_RESERVA_TRASLADOS) === conT,
      `reserva encendida (${nom}): fuera de la frase y del bloque, el prompt es el mismo`);
    ok(!/\d+\s*%|S\/\s*\d|cuenta\s*\d/.test(bloqueReservaTraslados()), `reserva encendida (${nom}): el bloque no lleva montos, porcentajes ni cuentas`);
  }
  ok(bloqueTraslados("todo_junto", {}) === BLOQUE_TRASLADOS && bloqueTraslados("una_por_mensaje", { reserva: false }) === bloqueTraslados("una_por_mensaje"), "bloqueTraslados sin reserva: el de siempre");
  ok(bloqueTraslados("todo_junto").includes(FRASE_PROPONER_RESERVA_TRASLADOS), "la frase que reemplaza la reserva sigue en el bloque de hoy");
}
console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
