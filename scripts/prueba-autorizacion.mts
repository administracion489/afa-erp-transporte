// scripts/prueba-autorizacion.mts — hasta dónde puede llegar legalmente un transportista.
//
// La ficha de la empresa pedía "N° Autorización MTC" y "N° Habilitación SUTRAN" como si todo
// operador tuviera las dos. Ninguno las tiene: lo autoriza UNA autoridad, y esa autoridad
// decide su ÁMBITO. Lo que faltaba no era un campo menos, era el dato con el que se puede
// avisar de lo único que ninguna fecha de vencimiento detecta — que el viaje se sale del
// territorio autorizado. Un operador con autorización de la ATU, con todos sus papeles
// vigentes, que hace un paseo a Ica está prestando servicio sin autorización.
//
// Lo que se fija aquí:
//   · el ámbito se DERIVA de la autoridad y nunca se guarda (no existe "ATU + nacional");
//   · el ámbito MAYOR cubre al menor y no al revés (nacional ⊃ regional ⊃ provincial);
//   · el ámbito menor está atado a SU territorio, así que sin emisor no se afirma nada;
//   · lo que no se sabe sale INDETERMINADO, nunca "permitido".
//
// Correr:  npx tsx scripts/prueba-autorizacion.mts
import {
  AUTORIDADES, REGIONES_PERU, ambitoDeAutoridad, avisosAutorizacion, configAutoridad,
  cubreAmbito, etiquetaAutorizacion, territorioDe, verificarAlcance,
  type Ambito, type Autoridad,
} from "../lib/autorizacion-transporte";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ═══════════════════════════════════════════════════════════════════════════════
titulo("1 · El ámbito se DERIVA de la autoridad");

ok(ambitoDeAutoridad("mtc") === "nacional", "MTC → nacional");
ok(ambitoDeAutoridad("regional") === "regional", "Gobierno Regional → regional");
ok(ambitoDeAutoridad("atu") === "provincial", "ATU → provincial (Lima y Callao)");
ok(ambitoDeAutoridad("provincial") === "provincial", "Municipalidad Provincial → provincial");
ok(ambitoDeAutoridad(null) === null, "sin autoridad no hay ámbito que inventar");

// Solo las autoridades que tienen territorio VARIABLE piden emisor. Pedírselo a la ATU sería
// ofrecer un campo para escribir mal algo que la Ley 30900 ya fija.
ok(configAutoridad("regional")?.pideEmisor === true, "la regional pide QUÉ región");
ok(configAutoridad("provincial")?.pideEmisor === true, "la provincial pide QUÉ provincia");
ok(configAutoridad("atu")?.pideEmisor === false, "la ATU NO pide emisor: es Lima y Callao por ley");
ok(configAutoridad("mtc")?.pideEmisor === false, "el MTC tampoco: es todo el país");
ok(AUTORIDADES.length === 4, "son cuatro autoridades", AUTORIDADES.length);
ok(REGIONES_PERU.length === 25, "los 25 gobiernos regionales", REGIONES_PERU.length);

// ═══════════════════════════════════════════════════════════════════════════════
titulo("2 · El ámbito mayor cubre al menor, y NO al revés");

// El RNAT: la autorización de ámbito nacional habilita el servicio de trabajadores en los
// ámbitos nacional, regional y provincial. Exigir coincidencia exacta habría bloqueado al
// operador nacional para un servicio dentro de Lima — que sí puede hacer.
const ambitos: Ambito[] = ["nacional", "regional", "provincial"];
for (const a of ambitos) ok(cubreAmbito("nacional", a), `nacional cubre ${a}`);
ok(cubreAmbito("regional", "regional"), "regional cubre regional");
ok(cubreAmbito("regional", "provincial"), "regional cubre provincial");
ok(!cubreAmbito("regional", "nacional"), "regional NO cubre nacional");
ok(cubreAmbito("provincial", "provincial"), "provincial cubre provincial");
ok(!cubreAmbito("provincial", "regional"), "provincial NO cubre regional");
ok(!cubreAmbito("provincial", "nacional"), "provincial NO cubre nacional");
ok(!cubreAmbito(null, "provincial"), "sin ámbito no se cubre nada");

// ═══════════════════════════════════════════════════════════════════════════════
titulo("3 · El territorio, y cómo se rotula");

ok(territorioDe({ autoridad: "mtc" }) === "Todo el país", "MTC → todo el país");
ok(territorioDe({ autoridad: "atu" }) === "Lima Metropolitana y Callao",
   "ATU → Lima y Callao, sin depender de ningún campo tecleado");
ok(territorioDe({ autoridad: "regional", emisor: "Ica" }) === "Región Ica", "regional → su región");
ok(territorioDe({ autoridad: "provincial", emisor: "Cañete" }) === "Provincia de Cañete", "provincial → su provincia");
ok(territorioDe({ autoridad: "regional" }) === null,
   "regional SIN emisor no afirma territorio (no se adivina)");
ok(etiquetaAutorizacion({ autoridad: "atu" }) === "ATU · Lima Metropolitana y Callao",
   "la etiqueta del chip", etiquetaAutorizacion({ autoridad: "atu" }));
ok((etiquetaAutorizacion({ autoridad: "regional" }) || "").includes("falta indicar"),
   "…y dice lo que falta cuando falta", etiquetaAutorizacion({ autoridad: "regional" }));
ok(etiquetaAutorizacion({}) === null, "sin autoridad no hay etiqueta");

// ═══════════════════════════════════════════════════════════════════════════════
titulo("4 · EL CASO DEL DUEÑO: ATU Lima no puede ir a Ica");

{
  const atu = { autoridad: "atu" as Autoridad };
  const v = verificarAlcance(atu, { region: "Ica", provincia: "Ica" });
  ok(!v.permitido && !v.indeterminado, "un paseo a Ica NO está cubierto por la ATU");
  ok(v.texto.includes("ATU") && v.texto.includes("Ica"), "…y el aviso nombra las dos cosas", v.texto);

  ok(verificarAlcance(atu, { region: "Lima", provincia: "Lima" }).permitido, "dentro de Lima sí");
  ok(verificarAlcance(atu, { region: "Callao", provincia: "Callao" }).permitido, "el Callao también");
  // Cañete es provincia de la región Lima pero NO es Lima Metropolitana: la ATU no llega.
  ok(!verificarAlcance(atu, { region: "Lima", provincia: "Cañete" }).permitido,
     "Cañete NO: es región Lima, pero no Lima Metropolitana");
  ok(verificarAlcance(atu, {}).indeterminado, "sin destino no se afirma nada, se dice que falta");
}

{
  // El nacional pasa siempre: es lo que evita que el aviso se vuelva paisaje.
  const mtc = { autoridad: "mtc" as Autoridad };
  for (const d of [{ region: "Ica" }, { region: "Lima", provincia: "Lima" }, {}]) {
    ok(verificarAlcance(mtc, d).permitido, `MTC cubre ${JSON.stringify(d)}`);
  }
}

{
  const gore = { autoridad: "regional" as Autoridad, emisor: "Ica" };
  ok(verificarAlcance(gore, { region: "Ica", provincia: "Pisco" }).permitido,
     "GORE Ica cubre Pisco (otra provincia de su región)");
  ok(!verificarAlcance(gore, { region: "Lima", provincia: "Lima" }).permitido,
     "GORE Ica NO cubre Lima");
  // Tildes y mayúsculas: el emisor sale de un desplegable y el destino de otro sitio.
  ok(verificarAlcance({ autoridad: "regional", emisor: "Áncash" }, { region: "ancash" }).permitido,
     "«Áncash» y «ancash» son la misma región");
  ok(verificarAlcance({ autoridad: "regional" }, { region: "Ica" }).indeterminado,
     "regional sin emisor: INDETERMINADO, nunca permitido");
}

{
  const muni = { autoridad: "provincial" as Autoridad, emisor: "Cañete" };
  ok(verificarAlcance(muni, { region: "Lima", provincia: "Cañete" }).permitido, "su propia provincia sí");
  ok(!verificarAlcance(muni, { region: "Lima", provincia: "Lima" }).permitido,
     "otra provincia de la misma región, no");
  ok(verificarAlcance(muni, { region: "Lima" }).indeterminado,
     "con la región pero sin la provincia: INDETERMINADO");
}

// Lo desconocido NUNCA sale permitido. Es la regla que sostiene todo lo demás: un
// "permitido" inventado hace que el despachador deje de mirar el aviso.
{
  const v = verificarAlcance({}, { region: "Ica" });
  ok(!v.permitido && v.indeterminado, "sin autoridad registrada: indeterminado, no permitido");
}

// ═══════════════════════════════════════════════════════════════════════════════
titulo("5 · Lo que la ficha reclama, por CÓDIGO y no por el texto");

const cods = (a: Parameters<typeof avisosAutorizacion>[0]) => avisosAutorizacion(a).map(v => v.codigo);

ok(cods({}).includes("sin_autoridad"), "ficha vacía → sin_autoridad");
ok(cods({}).length === 1, "…y no se apilan cinco avisos sobre lo mismo", cods({}).join());
ok(cods({ autoridad: "regional", numero: "R.D. 1", vencimiento: "2027-01-01" }).includes("sin_emisor"),
   "regional sin región → sin_emisor");
ok(!cods({ autoridad: "atu", numero: "R.D. 1", vencimiento: "2027-01-01" }).includes("sin_emisor"),
   "a la ATU nunca se le reclama emisor");
ok(cods({ autoridad: "mtc", vencimiento: "2027-01-01" }).includes("sin_numero"), "falta la resolución");
ok(cods({ autoridad: "mtc", numero: "R.D. 1" }).includes("sin_vencimiento"), "falta el vencimiento");
ok(cods({ autoridad: "mtc", numero: "R.D. 1", vencimiento: "2027-01-01" }).length === 0,
   "una ficha completa no reclama nada",
   cods({ autoridad: "mtc", numero: "R.D. 1", vencimiento: "2027-01-01" }).join());

// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? "✅ TODO OK" : `❌ ${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
