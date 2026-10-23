// Matriz de lib/idioma-cliente.ts — npx tsx scripts/prueba-idioma-cliente.mts
//
// ¿En qué idioma escribe el cliente? Lo decide el CÓDIGO (mueve la moneda de un traslado: un cliente
// en inglés recibe la lista en dólares), así que se fija aquí, caso por caso, la tabla de casos borde
// del plan y lo que no se puede aflojar:
//   · un mensaje sin letras (horas, fechas, números, emojis, un enlace) NUNCA decide;
//   · un saludo suelto («Hi», «Thanks») no decide; un «Thank you» después de dos mensajes en
//     castellano no cambia el idioma (mayoría);
//   · los nombres de hoteles y lugares y el inglés que se usa en castellano («Hilton Garden Inn»,
//     «transfer», «full day», «ok») no cuentan para nadie;
//   · solo cuentan los mensajes de texto y las transcripciones de audio, de las últimas 48 h;
//   · las listas son exclusivas (una palabra, un idioma) y ninguna excluida está en una lista;
//   · corolario: el barrido sí decide inglés, castellano y otro idioma.
import * as I from "../lib/idioma-cliente";
import { PREFIJO_TRANSCRIPCION } from "../lib/crm-audio";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };
const J = (x: unknown) => JSON.stringify(x);

const AHORA = Date.parse("2026-10-23T15:00:00Z");
const hace = (h: number) => new Date(AHORA - h * 3_600_000).toISOString();
/** Mensajes de texto del cliente, del más reciente al más antiguo, uno por hora hacia atrás. */
const conv = (...textos: string[]) => textos.map((t, i) => ({ contenido: t, tipo: "texto", created_at: hace(i * 0.1) }));
const idiomaDe = (...textos: string[]) => I.idiomaDelCliente(conv(...textos), AHORA).idioma;
const msg = (t: string) => I.idiomaDeMensaje(t).idioma;

console.log("0. Las constantes y las listas");
{
  ok(I.VENTANA_IDIOMA_H === 48 && I.DECISIVOS_IDIOMA === 3 && I.MIN_PUNTOS_IDIOMA === 2, "los umbrales declarados (48 h, 3 mensajes, 2 puntos)");
  const vistas = new Map<string, string>();
  let repetidas = 0;
  for (const l of I.IDIOMAS_PALABRAS) for (const p of I.PALABRAS_IDIOMA[l]) {
    if (vistas.has(p) && vistas.get(p) !== l) { repetidas++; console.log(`    «${p}» en ${vistas.get(p)} y ${l}`); }
    vistas.set(p, l);
  }
  ok(repetidas === 0, "una palabra está en UNA sola lista");
  const enLista = I.PALABRAS_EXCLUIDAS.filter((p) => vistas.has(p));
  ok(enLista.length === 0, `ninguna excluida está en una lista (${enLista.join(", ")})`);
  const malas = [...vistas.keys()].filter((p) => !/^[a-z]+$/.test(p));
  ok(malas.length === 0, `las listas van sin tildes y en minúsculas (${malas.join(", ")})`);
  for (const p of ["hotel", "inn", "by", "garden", "plaza", "transfer", "tour", "city", "ok", "taxi", "van", "bus"]) {
    ok(I.PALABRAS_EXCLUIDAS.includes(p), `«${p}» está excluida (nombre de lugar o inglés usado en castellano)`);
  }
}

console.log("1. La tabla de casos borde (un mensaje)");
{
  for (const t of ["ok", "👍", "2", "25/12 15:00", "Av. Larco 345", "https://maps.google.com/?q=-12.1,-77.0", "", "   "]) {
    ok(msg(t) === null, `«${t}» no decide`);
  }
  ok(msg("Hi") === null && msg("Thanks") === null && msg("Hola") === null, "un saludo suelto (1 punto) no decide");
  ok(msg("Hello, I need a transfer from the airport tomorrow") === "en", "«Hello, I need a transfer from the airport tomorrow» → inglés");
  ok(msg("Hola, I need a taxi to Miraflores") === "en", "«Hola, I need a taxi to Miraflores» (mezcla) → inglés");
  ok(msg("Quiero ir al Hilton Garden Inn") === "es", "«Quiero ir al Hilton Garden Inn» → castellano");
  ok(msg("The Westin Lima") === null, "«The Westin Lima» suelto no decide");
  ok(msg("Olá, preciso de um transfer do aeroporto amanhã") === "otro", "portugués → otro");
  ok(msg("¿Cuánto cuesta?") === "es", "«¿Cuánto cuesta?» → castellano");
  ok(msg("Bonjour, je voudrais un transfert de l'aéroport demain") === "otro", "francés → otro");
  ok(msg("Hallo, ich brauche einen Transfer vom Flughafen") === "otro", "alemán → otro");
  ok(msg("Ciao, vorrei un transfer dall'aeroporto domani") === "otro", "italiano → otro");
  ok(msg("Quiero un full day a Paracas") !== "en" && msg("Quiero un full day a Paracas para el sábado") === "es", "«full day» no vuelve inglés a un castellano");
  ok(msg("ok transfer full day city tour") === null, "solo inglés usado en castellano: no decide");
  ok(msg("Necesito movilidad para mañana, somos 4 personas") === "es", "castellano largo → castellano");
  ok(msg("We are 4 people with 3 bags, what is the price?") === "en", "inglés con números → inglés");
  ok(msg("Thank you") === "en", "«Thank you» decide inglés (2 puntos), pero solo cuenta como un mensaje");
}

console.log("2. La conversación (mayoría de los 3 últimos decisivos de las últimas 48 h)");
{
  ok(idiomaDe() === null && I.idiomaDelCliente([], AHORA).codigo === "sin_evidencia", "sin mensajes: sin evidencia (castellano, lo de siempre)");
  ok(idiomaDe("ok", "👍", "25/12 15:00") === null, "solo mensajes que no deciden: sin evidencia");
  ok(idiomaDe("Thank you", "Perfecto, gracias por la información", "Hola, necesito un traslado al aeropuerto") === "es",
    "un «Thank you» después de dos mensajes en castellano → castellano (mayoría)");
  ok(idiomaDe("Can you send me the quote please?", "I need a transfer to the airport tomorrow", "Hola, necesito un traslado al aeropuerto") === "en",
    "el cliente cambia y escribe dos mensajes en inglés tras el castellano → inglés");
  ok(idiomaDe("Av. Larco 345", "25/12 15:00", "4", "Hello, I need a transfer from the airport tomorrow") === "en",
    "primer mensaje en inglés, después solo direcciones y horas → inglés");
  ok(idiomaDe("Olá, preciso de um transfer do aeroporto amanhã") === "otro", "portugués → otro (se le contesta en inglés)");
  // Empate: el más reciente.
  ok(idiomaDe("I need a ride please", "Necesito un traslado por favor") === "en", "empate 1-1 → el más reciente (inglés)");
  ok(idiomaDe("Necesito un traslado por favor", "I need a ride please") === "es", "empate 1-1 → el más reciente (castellano)");
  // La ventana: inglés hace una semana, hoy castellano.
  const vieja = [
    { contenido: "Necesito un traslado para mañana por favor", tipo: "texto", created_at: hace(1) },
    { contenido: "Hello, I need a transfer from the airport tomorrow", tipo: "texto", created_at: hace(24 * 7) },
    { contenido: "Can you send me the price please?", tipo: "texto", created_at: hace(24 * 7 + 1) },
  ];
  ok(I.idiomaDelCliente(vieja, AHORA).idioma === "es", "inglés hace una semana, hoy castellano → castellano (la ventana deja fuera el viejo)");
  ok(I.idiomaDelCliente(vieja.slice(1), AHORA).idioma === null, "solo mensajes de hace una semana: sin evidencia");
  // Un mensaje sin fecha (o con una que no se entiende) cuenta como reciente.
  ok(I.idiomaDelCliente([{ contenido: "I need a transfer from the airport", tipo: "texto", created_at: null }], AHORA).idioma === "en"
    && I.idiomaDelCliente([{ contenido: "I need a transfer from the airport", tipo: "texto", created_at: "ayer" }], AHORA).idioma === "en",
    "sin fecha (o ilegible) cuenta como reciente");
  // Solo los 3 últimos decisivos.
  ok(idiomaDe("Necesito un traslado", "Quiero ir al aeropuerto", "Somos dos personas", "I need a transfer", "Please send the price", "Thank you so much") === "es",
    "solo cuentan los 3 últimos decisivos");
}

console.log("3. Qué mensajes cuentan");
{
  const base = { contenido: "Hello, I need a transfer from the airport tomorrow", created_at: hace(1) };
  for (const tipo of ["texto", "text", "", null, undefined]) {
    ok(I.idiomaDelCliente([{ ...base, tipo }], AHORA).idioma === "en", `tipo ${J(tipo)} cuenta`);
  }
  for (const tipo of ["location", "image", "document", "video", "sticker", "reaction", "imagen", "documento"]) {
    ok(I.idiomaDelCliente([{ ...base, tipo }], AHORA).idioma === null, `tipo «${tipo}» no cuenta`);
  }
  ok(I.idiomaDelCliente([{ contenido: `${PREFIJO_TRANSCRIPCION}Hello, I need a transfer from the airport tomorrow`, tipo: "audio", created_at: hace(1) }], AHORA).idioma === "en",
    "la transcripción de una nota de voz cuenta (sin su «🎤 »)");
  ok(I.idiomaDelCliente([{ contenido: "Hello, I need a transfer from the airport tomorrow", tipo: "audio", created_at: hace(1) }], AHORA).idioma === null,
    "un audio sin transcripción no cuenta");
  ok(I.idiomaDelCliente([{ contenido: "[El cliente envió una imagen] Hello, I need a transfer from the airport tomorrow", tipo: "texto", created_at: hace(1) }], AHORA).idioma === "en",
    "la etiqueta inicial «[…]» se quita y el resto cuenta");
  ok(I.idiomaDelCliente([{ contenido: "[Location shared by the client, I need the price]", tipo: "texto", created_at: hace(1) }], AHORA).idioma === null,
    "un mensaje que es solo la etiqueta no cuenta");
  ok(I.idiomaDelCliente([{ contenido: null, tipo: "texto", created_at: hace(1) }, { contenido: 5 as unknown as string, tipo: "texto" }], AHORA).idioma === null,
    "contenido nulo o que no es texto no cuenta (ni lanza)");
  const r = I.idiomaDelCliente(conv("Hello, I need a transfer from the airport tomorrow", "Can you send the price please?"), AHORA);
  ok(r.codigo === "ingles" && r.decisivos === 2 && r.detalle.includes("inglés") && r.detalle.includes("48 h"), `el detalle lo dice en castellano («${r.detalle}»)`);
  ok(I.idiomaDelCliente(conv("Olá, preciso de um transfer do aeroporto amanhã"), AHORA).codigo === "otro_idioma"
    && I.idiomaDelCliente(conv("Necesito un traslado por favor"), AHORA).codigo === "castellano", "los códigos de otro idioma y castellano");
}

console.log("4. Barrido: un mensaje sin letras NUNCA decide; corolario: el barrido sí decide");
{
  let s = 12345;
  const azar = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const piezas = ["0", "1", "25", "15:00", "25/12", "2026-10-25", " ", ".", ",", "-", "/", "👍", "🙏", "✈️", "😊", "+51 987 654 321", "S/ 150", "US$ 80", "%", "#", "@", "(", ")", "\n"];
  let n = 0, decide = 0;
  for (let i = 0; i < 20000; i++) {
    const largo = 1 + Math.floor(azar() * 8);
    let t = "";
    for (let k = 0; k < largo; k++) t += piezas[Math.floor(azar() * piezas.length)];
    n++;
    // «S/» y «US$» llevan letras: se quitan para el barrido de «sin letras» (s y us no están en ninguna lista).
    if (msg(t) !== null) { decide++; if (decide <= 3) console.log(`    decidió con «${t}»`); }
  }
  ok(decide === 0, `${n} mensajes sin palabras: ninguno decide`);
  // Corolario: los tres idiomas salen.
  const frases = {
    en: ["I need a transfer", "please send me the price", "we are arriving tomorrow at night", "how much is it for two people", "thank you so much for your help"],
    es: ["necesito un traslado", "cuánto cuesta para dos personas", "llegamos mañana en la noche", "por favor el precio", "muchas gracias por la información"],
    pt: ["preciso de um transfer", "quanto custa para duas pessoas", "chegamos amanhã à noite", "obrigado pela ajuda", "quero ir ao aeroporto"],
  };
  const vistos = new Set<string>();
  for (const l of ["en", "es", "pt"] as const) for (const f of frases[l]) { const d = msg(f); if (d) vistos.add(d); }
  ok(vistos.has("en") && vistos.has("es") && vistos.has("otro"), `corolario: el barrido decide inglés, castellano y otro idioma (${[...vistos].join(", ")})`);
}

console.log(fallos ? `\n${fallos} FALLAN (${oks} ok)` : `\nTODO OK (${oks} comprobaciones)`);
process.exit(fallos ? 1 : 0);
