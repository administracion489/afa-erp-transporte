// ANTHROPIC_API_KEY=x npx tsx scripts/prueba-crm-ia-mensaje.mts
//
// Cómo empieza y cómo se limpia el mensaje del agente IA (lib/crm-ia-mensaje.ts). El caso, la
// conversación de prueba del dueño del 21-10-2026: «Hola quiero una minivan para mañana» y la IA
// contestó sin saludar (contaba como «ya conversamos hoy» seis envíos que Meta había rechazado y la
// charla de la tarde con una persona del equipo), y una respuesta salió con «</s>» al final.
import {
  abreConSaludo, saludoDelTurno, saludoDeBooleano, textosSinContestar, textoDeContenido, limpiarTextoModelo,
} from "../lib/crm-ia-mensaje";
import { construirSystem } from "../lib/crm-ia";

let fallos = 0;
let bien = 0;
const ok = (c: boolean, m: string) => { if (!c) { fallos++; console.log("✗", m); } else bien++; };

// ── 1. ¿El cliente abre saludando? ────────────────────────────────────────────
const SI = [
  "Hola quiero una minivan para mañana", "hola", "Hola!", "¡Hola, buenas tardes!", "HOLA", "Holaaa", "holi",
  "Ola, una consulta", "Buenas", "Buenas noches", "buenas tardes, quisiera cotizar", "Buenos días", "Buenos dias",
  "Buen día", "Buen dia", "Saludos", "Qué tal", "que tal, una consulta", "Aló", "👋 Hola", "  hola  ", "Hello",
  "Hi, I need a transfer", "Hey", "Good morning", "Good evening!", "[El cliente envió esta imagen] Hola, esto es lo que necesito",
  "[Nota de voz del cliente, transcrita] Buenas tardes, quería saber",
];
const NO = [
  "Quiero una minivan para mañana", "1:15 pm, mi vuelo es LA2030", "4 maletas de 23 kg", "Hilton Miraflores",
  "Holanda es mi destino", "Bueno, entonces mañana", "bueno", "Alojamiento en Miraflores", "Hiace para 10",
  "Gracias", "Ok", "", "   ", "Quiero saludar a mi jefe", "¿Cuánto cuesta?", "Saludable", "Buenísimo",
];
for (const t of SI) ok(abreConSaludo(t), `saluda: «${t}»`);
for (const t of NO) ok(!abreConSaludo(t), `no saluda: «${t}»`);
ok(!abreConSaludo(null) && !abreConSaludo(undefined) && !abreConSaludo(42 as any), "sin texto: no saluda");

// ── 2. Lo que este turno contesta ─────────────────────────────────────────────
const hist = [
  { role: "user", content: "Hola" },
  { role: "assistant", content: "Buenas noches" },
  { role: "user", content: "Hola de nuevo" },
  { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "[El cliente envió esta imagen] mi vuelo" }] },
];
ok(JSON.stringify(textosSinContestar(hist)) === JSON.stringify(["Hola de nuevo", "[El cliente envió esta imagen] mi vuelo"]), "solo lo posterior a nuestra última respuesta, en orden");
ok(textosSinContestar([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]).length === 0, "con nuestra respuesta al final: nada sin contestar");
ok(JSON.stringify(textosSinContestar([{ role: "user", content: "a" }, { role: "user", content: "b" }])) === '["a","b"]', "sin respuesta nuestra: todo");
ok(textoDeContenido(42) === "" && textoDeContenido([{ type: "image" }]) === "", "un contenido sin texto es vacío");

// ── 3. La decisión del saludo ─────────────────────────────────────────────────
const d = (alcanzadosHoy: number, iaHoy: number, textos: string[]) => saludoDelTurno({ alcanzadosHoy, iaHoy, textosCliente: textos });
// EL CASO: hubo charla con una persona del equipo (y la IA no habló hoy), y el cliente dice «Hola».
ok(JSON.stringify(d(9, 0, ["Hola quiero una minivan para mañana"])) === '{"modo":"devolver","presentarse":true}', "el caso del 21-10: devuelve el saludo y se presenta");
ok(JSON.stringify(d(9, 2, ["Hola quiero una minivan"])) === '{"modo":"devolver","presentarse":false}', "la IA ya habló hoy: devuelve el saludo sin presentarse");
ok(d(9, 2, ["4 maletas de 23 kg"]).modo === "no", "ya conversaron y no saluda: no vuelve a saludar");
ok(d(0, 0, ["4 maletas"]).modo === "primero" && d(0, 0, ["Hola"]).modo === "primero", "nada le llegó hoy: el saludo obligatorio, salude o no");
ok(d(3, 0, ["ok", "Buenas tardes"]).modo === "devolver", "un saludo en cualquier mensaje de la ráfaga cuenta");
ok(d(NaN, 0, ["x"]).modo === "primero" && d(-1, 0, ["x"]).modo === "primero", "un conteo inválido no inventa una conversación");
ok(JSON.stringify(saludoDeBooleano(true)) === '{"modo":"primero","presentarse":true}' && saludoDeBooleano(false).modo === "no", "el booleano de antes");
// Barrido: «primero» ⟺ nada llegó; «devolver» ⟺ algo llegó y el cliente saluda; presentarse en
// «devolver» ⟺ la IA no habló hoy.
let n = 0;
for (const a of [0, 1, 5]) for (const ia of [0, 1, 3]) for (const textos of [[], ["ok"], ["Hola"], ["ok", "Buenas"], ["Bueno"]]) {
  if (ia > a) continue;
  n++;
  const r = d(a, ia, textos);
  const saluda = textos.some((t) => abreConSaludo(t));
  ok((r.modo === "primero") === (a === 0), `barrido ${a}/${ia}/${textos}: primero ⟺ nada llegó`);
  ok((r.modo === "devolver") === (a > 0 && saluda), `barrido ${a}/${ia}/${textos}: devolver ⟺ llegó algo y saluda`);
  if (r.modo === "devolver") ok(r.presentarse === (ia === 0), `barrido ${a}/${ia}/${textos}: se presenta ⟺ la IA no habló hoy`);
  if (r.modo === "no") ok(!r.presentarse, `barrido ${a}/${ia}/${textos}: sin saludo no hay presentación`);
}
ok(n === 30, `el barrido corrió (${n})`);

// ── 4. Lo que dice el prompt en cada caso ─────────────────────────────────────
const agente = { persona: "Eres Afita.", empresa_contexto: "AFA", comportamiento: {} };
const contacto = { nombre: "Atencion al Cliente", empresa: null, telefono: null };
const conv = { id: "x", canal: "whatsapp" };
const P = (s: any) => construirSystem(agente, contacto, conv, s, "AFA Transportes");
const prim = P({ modo: "primero", presentarse: true });
const dev = P({ modo: "devolver", presentarse: true });
const devSin = P({ modo: "devolver", presentarse: false });
const no = P({ modo: "no", presentarse: false });
ok(prim === P(true) && no === P(false), "el booleano de antes da el mismo prompt");
ok(prim.includes("## SALUDO OBLIGATORIO") && /(Buenos días|Buenas tardes|Buenas noches), Atencion/.test(prim), "primero: el saludo obligatorio de siempre");
ok(dev.includes("el cliente te acaba de saludar") && /DEBE empezar devolviéndole el saludo/.test(dev) && /presentación breve/.test(dev), "devolver: le devuelve el saludo y se presenta");
ok(devSin.includes("el cliente te acaba de saludar") && devSin.includes("No te vuelvas a presentar") && !/presentación breve/.test(devSin), "devolver sin presentarse");
ok(!dev.includes("NO vuelvas a saludar") && !dev.includes("SALUDO OBLIGATORIO"), "devolver: ni «no vuelvas a saludar» ni el obligatorio");
ok(no.includes("NO vuelvas a saludar") && !no.includes("te acaba de saludar"), "no: no vuelve a saludar");
for (const [nom, t] of [["primero", prim], ["devolver", dev]] as const)
  ok(t.includes("Si en este chat el cliente ya te dijo su nombre, usa ese en el saludo."), `${nom}: el nombre que dio en el chat manda sobre el del perfil`);
const apagado = construirSystem({ ...agente, comportamiento: { saludo_activo: false } }, contacto, conv, { modo: "devolver", presentarse: true }, "AFA");
ok(!/SALUDO|## Saludo/.test(apagado), "con el saludo apagado en Ajustes no hay bloque de saludo");

// ── 5. Limpieza del texto del modelo ──────────────────────────────────────────
ok(limpiarTextoModelo("Recibido, José Luis. ¿Cuántas maletas grandes (de 23 kg) llevan en total?\n</s>") === "Recibido, José Luis. ¿Cuántas maletas grandes (de 23 kg) llevan en total?", "el caso del 21-10: se va el «</s>» y el salto");
ok(limpiarTextoModelo("Hola<|im_end|>") === "Hola" && limpiarTextoModelo("<s>Hola</s>") === "Hola" && limpiarTextoModelo("Listo <eos>") === "Listo", "otras marcas de fin");
ok(limpiarTextoModelo("Precio < 100 y > 50") === "Precio < 100 y > 50", "un «<» del texto se queda");
ok(limpiarTextoModelo("*Resumen*\n• Fecha: 22/10  \n• Pax: 4") === "*Resumen*\n• Fecha: 22/10\n• Pax: 4", "el formato de WhatsApp se queda (solo se van los espacios del final de línea)");
ok(limpiarTextoModelo("  </s>  ") === "", "solo la marca: vacío (no se envía)");

console.log(`\n${bien} bien · ${fallos} mal`);
if (fallos) process.exit(1);
