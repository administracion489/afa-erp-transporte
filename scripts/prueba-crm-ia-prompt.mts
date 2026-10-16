// ANTHROPIC_API_KEY=x npx tsx scripts/prueba-crm-ia-prompt.mts
// Las instrucciones de la IA: lo de la empresa va AL FINAL y con prioridad dicha; el resumen del
// pedido aparece solo si está encendido, y entonces la regla general no prohíbe el «Solo me falta».
import { construirSystem } from "../lib/crm-ia";
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
console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
