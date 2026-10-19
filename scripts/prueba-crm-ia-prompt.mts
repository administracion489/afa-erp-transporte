// ANTHROPIC_API_KEY=x npx tsx scripts/prueba-crm-ia-prompt.mts
// Las instrucciones de la IA: lo de la empresa va AL FINAL y con prioridad dicha; el resumen del
// pedido aparece solo si está encendido, y entonces la regla general no prohíbe el «Solo me falta».
import { construirSystem, BLOQUE_TRASLADOS, textoSinImportesAjenos } from "../lib/crm-ia";
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
ok(i("*Solo me falta:*") > 0, "formato con «Solo me falta»");
ok(i("No insistas con una pregunta suelta") > 0 && i("No repitas una pregunta que ya hiciste") < 0, "la regla general no prohíbe el «Solo me falta»");
ok(i("## Tus objetivos") > i("## Reglas generales"), "objetivos después de las reglas generales");
ok(i("## Base de conocimiento") > i("## Tus objetivos"), "conocimiento después de objetivos");
ok(i("## Reglas del negocio") > i("## Base de conocimiento"), "reglas del negocio después");
ok(i("## Prioridad") > i("## Reglas del negocio") && p.trimEnd().endsWith("datos de otros clientes."), "la prioridad cierra las instrucciones");
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
ok(conT.trimEnd().endsWith("datos de otros clientes."), "con traslados sigue cerrando en «datos de otros clientes.»");
ok(/cotizar_traslado/.test(BLOQUE_TRASLADOS) && /NUNCA calcules ni inventes un precio/.test(BLOQUE_TRASLADOS), "usa la herramienta y nunca inventa precios");
ok(/en un solo mensaje/.test(BLOQUE_TRASLADOS) && /mensaje de derivación/.test(BLOQUE_TRASLADOS), "pregunta todo junto; deriva con el mensaje de derivación");
ok(/NO menciones ningún importe/.test(BLOQUE_TRASLADOS) && /EXACTAMENTE como vienen/.test(BLOQUE_TRASLADOS), "en revisión sin importes; en automático tal cual");
ok(/proponer_reserva/.test(BLOQUE_TRASLADOS) && /disponibilidad/.test(BLOQUE_TRASLADOS), "nunca confirma disponibilidad ni reserva; si acepta, proponer_reserva");
ok(/no contradice «NUNCA confirmes/.test(BLOQUE_TRASLADOS) && conT.includes("NUNCA confirmes que ya cotizaste"), "aclara que no contradice «NUNCA confirmes…», que sigue");
// El texto del turno con traslados (auditoría): con cotización lo escribe el código; sin ella, el
// del modelo solo pasa si no habla de dinero. textoSinImportesAjenos delega en textoFinalTraslado.
{
  const ag = { mensaje_derivacion: "Hola {nombre}, un ejecutivo te escribe por este chat." };
  const ct = { nombre: "Paola Huarachi" };
  const auto = textoSinImportesAjenos("El total sería 150 (IGV incluido)", { respuestaModelo: "", accion: "cotizar", cotizacion: { cotizacionId: 1, numero: "00123", decision: "automatico", figuras: [283.2], total: "S/ 283.20", validez: "18/11/2026" } }, ag, ct);
  ok(auto.startsWith("Hola Paola,") && auto.includes("S/ 283.20") && !auto.includes("150"), "con cotización, el texto del código (sin la cifra del modelo)");
  const rev = textoSinImportesAjenos("Serán aprox 300", { respuestaModelo: "", accion: "cotizar", cotizacion: { cotizacionId: 1, numero: "00124", decision: "revision", figuras: [] } }, ag, ct);
  ok(rev.includes("00124") && !/\d{3}(?!\d)/.test(rev.replace("00124", "")), "en revisión, el del código sin importes");
  const preg = textoSinImportesAjenos("Te sale gratis el retorno, ¿cuántas maletas?", { respuestaModelo: "", accion: "preguntar", faltan: ["la cantidad de maletas"] }, ag, ct);
  ok(preg === "Para cotizar tu traslado me falta: la cantidad de maletas.", "preguntar con dinero → «me falta»");
  const der = textoSinImportesAjenos("Son 150$", { respuestaModelo: "", accion: "derivar" }, ag, ct);
  ok(der === "Hola Paola, un ejecutivo te escribe por este chat.", "derivar con dinero → el mensaje de derivación");
  ok(textoSinImportesAjenos("¿Cuántas maletas llevan?", { respuestaModelo: "", accion: "preguntar", faltan: ["x"] }, ag, ct) === "¿Cuántas maletas llevan?", "sin dinero, el del modelo pasa");
  ok(textoSinImportesAjenos("Cuesta S/ 999", null, ag, ct) === "Cuesta S/ 999", "sin la herramienta, no se toca");
}
console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
