// Pruebas de LA LECTURA DEL ODÓMETRO: el dígito de más.
// NO tocan la base ni llaman a la IA: strings y funciones puras en memoria.
// Uso:  npx tsx scripts/prueba-odometro.mts     (sale con código 1 si algo falla)
//
// EL CASO REAL (CUP-435, 05/09/2026): el tablero marcaba `ODO 23980 km` (y `TRIP 388.0`) y la
// IA devolvió 239.980 — un dígito de más — DOS lecturas seguidas. Tres fallos encadenados, y
// cada sección de abajo fija uno:
//
//   1. El ERP sabe que el odómetro de esa unidad tiene 5 dígitos (sale de `kilometraje_actual`)
//      y NO se lo decía al modelo: la línea viajaba dentro del bloque de `guia_odometro`, que es
//      texto libre que alguien teclea a mano unidad por unidad. Sin guía escrita —o sea, en casi
//      toda la flota— el dato se calculaba y se tiraba. Es la causa.
//   2. `elegirOdometro` dejaba el techo en Infinity cuando la unidad no tenía ninguna lectura
//      VIVA, así que un número diez veces mayor salía "en banda" y la pantalla lo pre-llenaba
//      como bueno… para que `evaluarLectura`, al guardarlo, lo marcara "Salto ×10: posible
//      dígito de más". El mismo número, dos veredictos opuestos. Y como una lectura sospechosa
//      no queda viva, el agujero se realimenta: el segundo dígito de más entra tan liso como el
//      primero, que es exactamente lo que reportó el usuario ("los 2 últimos").
//   3. El aviso decía "imposible para esta unidad" y obligaba a deducir qué había pasado
//      mirando dos números grandes. Ahora lo NOMBRA, con las dos cantidades de dígitos.
//
// Lo que estas pruebas fijan del lado que NO se puede aflojar: nada de esto puede rechazar una
// lectura legítima (unidad nueva sin historial, salto grande tras una parada larga), y NADIE
// adivina qué dígito sobra — de 239.980 salen tres borrados posibles dentro de la banda.

import { elegirOdometro, digitosDe } from "../lib/odometro-seleccion";
import { evaluarLectura, RATIO_DIGITO_DE_MAS, PISO_RATIO_DIGITO } from "../lib/odometro";
import { promptOdometro } from "../lib/vision-ia";
import { promptExtraccionMedia, type ContextoPrompt } from "../lib/radar/prompts";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

/** Lectura de check-in normal: un día desde la anterior, tope de km/día por defecto. */
const leer = (e: Partial<Parameters<typeof elegirOdometro>[0]> & { kmIA: number | null; kmVigente: number }) =>
  elegirOdometro({
    tripIA: null, textoLeido: null, kmDiaMax: 1500, horasDesdeUltima: 24, hayHistorial: true, ...e,
  });

// ── 1. El caso CUP-435: 23.980 en el tablero, 239.980 en el JSON ─────────────
{
  const v = leer({ kmIA: 239980, tripIA: 388, kmVigente: 23980 });
  chk("CUP-435 · el dígito de más no se da por bueno", v.autoOk === false);
  chk("CUP-435 · el defecto se NOMBRA con su código", v.codigo === "digito_de_mas", String(v.codigo));
  chk("CUP-435 · el motivo dice las dos cantidades de dígitos",
    !!v.motivo && /6 d[ií]gitos/.test(v.motivo) && /tiene 5/.test(v.motivo), v.motivo ?? "");
  chk("CUP-435 · NO se inventa el número corregido (tres borrados caben en la banda)",
    v.km === 239980 && v.origen === "ia", `km=${v.km} origen=${v.origen}`);
  // El parcial (388.0) tampoco puede colarse como total: está por debajo del vigente.
  chk("CUP-435 · el trip no se promueve a total", v.km !== 388);
}

// ── 2. EL AGUJERO QUE LO REPITIÓ: sin lecturas vivas, el techo era Infinity ──
{
  // `hayHistorial:false` no es solo "unidad nueva": es también la unidad cuyas lecturas van
  // TODAS a sospechosa. Por eso la segunda lectura mala entraba igual de lisa que la primera.
  const v = leer({ kmIA: 239980, tripIA: 388, kmVigente: 23980, hayHistorial: false });
  chk("sin historial vivo · el dígito de más SIGUE sin darse por bueno", v.autoOk === false);
  chk("sin historial vivo · y sigue nombrándose", v.codigo === "digito_de_mas", String(v.codigo));

  // La segunda lectura mala: mismo día siguiente, mismo error. Antes entraba idéntica.
  const v2 = leer({ kmIA: 240310, kmVigente: 23980, hayHistorial: false, horasDesdeUltima: null });
  chk("sin historial vivo · la SEGUNDA lectura inflada tampoco pasa", v2.autoOk === false, String(v2.codigo));
}
{
  // Sin ancla no hay nada contra qué comparar: el comportamiento tiene que ser el de siempre.
  const v = leer({ kmIA: 239980, kmVigente: 0 });
  chk("sin km vigente · no se juzga (comportamiento de siempre)", v.autoOk === true && v.codigo === null);
  const nada = leer({ kmIA: null, kmVigente: 23980 });
  chk("la abstención del modelo manda: no se fabrica un número", nada.km === null);
}

// ── 3. EL LADO QUE NO SE PUEDE AFLOJAR: lo legítimo sigue pasando ────────────
{
  const v = leer({ kmIA: 24300, kmVigente: 23980 });
  chk("un avance normal se acepta sin ruido", v.autoOk === true && v.codigo === null, `km=${v.km}`);
}
{
  // Unidad nueva: por debajo del piso del ratio, un ×8 legítimo existe (800 → 7.000 km).
  chk(`el piso del ratio protege al odómetro bajo (< ${PISO_RATIO_DIGITO.toLocaleString("es-PE")})`,
    leer({ kmIA: 7000, kmVigente: 800, hayHistorial: false }).autoOk === true);
}
{
  // Parada larga y sin saber cuánto tiempo pasó: el fallback de 30 días tiene que seguir cabiendo.
  const v = leer({ kmIA: 60000, kmVigente: 23980, horasDesdeUltima: null });
  chk("un salto grande tras un hueco largo sigue cabiendo", v.autoOk === true, `km=${v.km}`);
}
{
  // El caso que dio origen al selector (BUI-272): la IA cruzó parcial y total de campo.
  const v = leer({ kmIA: 1803, tripIA: 174159, kmVigente: 174000 });
  chk("BUI-272 · el total que viajaba en `trip_km` se rescata",
    v.km === 174159 && v.origen === "corregido" && v.codigo === "parcial", `km=${v.km} codigo=${v.codigo}`);
}
{
  // Anti-eco: un candidato que CLAVA el vigente huele a número copiado, no leído.
  const v = leer({ kmIA: 1803, tripIA: 174001, kmVigente: 174000 });
  chk("el eco del km vigente no se registra como lectura", v.codigo === "eco" && v.km === 1803);
}

// ── 4. LA CONSISTENCIA QUE ESTABA ROTA: quien lee y quien escribe dicen lo mismo ──
// El bug de fondo no era un umbral flojo, era que había DOS: elegirOdometro (que decide si el
// número se pre-llena en la pantalla) no aplicaba el guard de orden de magnitud que
// evaluarLectura (que decide si se guarda) aplica desde siempre. Un número no puede ser bueno
// para la pantalla y "posible dígito de más" para la base.
{
  const vigentes = [6000, 23980, 174000, 568287];
  const factores = [1.01, 1.2, 2, 5, 7.9, 8, 10, 100];
  let choques = 0;
  for (const vig of vigentes) {
    for (const f of factores) {
      const km = Math.round(vig * f);
      for (const hayHistorial of [true, false]) {
        const lector = elegirOdometro({
          kmIA: km, tripIA: null, textoLeido: null, kmVigente: vig,
          kmDiaMax: 1500, horasDesdeUltima: null, hayHistorial,
        });
        const escritor = evaluarLectura({ kmVigente: vig, kmNuevo: km, kmDiaMax: 1500, horasDesdeUltima: null });
        const escritorAcusaDigito = /d[ií]gito de m[aá]s/i.test(escritor.motivo ?? "");
        if (lector.autoOk && escritorAcusaDigito) {
          choques++;
          console.log(`      choque: vigente ${vig} · lectura ${km} · historial=${hayHistorial} → "${escritor.motivo}"`);
        }
      }
    }
  }
  chk("ningún número es bueno para la pantalla y 'dígito de más' para la base", choques === 0, `${choques} choque(s)`);
}
{
  // Y el ratio se lee del mismo sitio en los dos módulos (una constante, no dos literales).
  const vig = 23980;
  const justoDebajo = Math.round(vig * RATIO_DIGITO_DE_MAS) - 1;
  chk("justo por debajo del ratio, el escritor no acusa dígito de más",
    !/d[ií]gito de m[aá]s/i.test(evaluarLectura({ kmVigente: vig, kmNuevo: justoDebajo, horasDesdeUltima: null }).motivo ?? ""));
  chk("en el ratio exacto, sí lo acusa",
    /d[ií]gito de m[aá]s/i.test(evaluarLectura({ kmVigente: vig, kmNuevo: vig * RATIO_DIGITO_DE_MAS, horasDesdeUltima: null }).motivo ?? ""));
}
{
  chk("digitosDe cuenta cifras, no valores", digitosDe(23980) === 5 && digitosDe(239980) === 6 && digitosDe(0) === 1);
}

// ── 5. LA CAUSA: la forma del número tiene que llegar al modelo SIEMPRE ──────
// Estaba anidada dentro del bloque de la guía del operador, así que una unidad sin guía escrita
// a mano se leía sin ninguna referencia de cuántas cifras esperar. Es la línea que hace evidente
// un 239.980 sobre un odómetro de 5 dígitos.
{
  const soloDigitos = promptOdometro({ digitos: 5, placa: "CUP-435" });
  chk("SIN guía escrita, el prompt lleva igual los dígitos de la unidad",
    /5 d[ií]gitos/.test(soloDigitos), soloDigitos.includes("5 dígitos") ? "" : soloDigitos.slice(0, 160));
  chk("…y nombra la placa a la que se refiere", soloDigitos.includes("CUP-435"));
  chk("…y ordena contar las cifras antes de responder", /CUENTA/i.test(soloDigitos));

  const conGuia = promptOdometro({ digitos: 5, placa: "CUP-435", guia: "el total está abajo, junto a ODO" });
  chk("CON guía, van las dos cosas", /5 d[ií]gitos/.test(conGuia) && conGuia.includes("junto a ODO"));

  // Sin km vigente no hay forma que declarar: no se inventa una (el bloque no aparece; la
  // regla general de "cuenta las cifras" del prompt base sí, que no afirma nada de la unidad).
  const sinNada = promptOdometro({ placa: "XYZ-999" });
  chk("sin km vigente no se inventa una forma", !sinNada.includes("FORMA DEL NÚMERO EN ESTA UNIDAD"));

  const conLecciones = promptOdometro({ digitos: 5, lecciones: "- [CUP-435] Añadiste o perdiste un dígito." });
  chk("las lecciones del operador siguen entrando", conLecciones.includes("Añadiste o perdiste"));

  // Regla dura del módulo: al prompt va la FORMA, nunca el km exacto (sería copiable, y ese eco
  // es indistinguible de una lectura buena).
  chk("nunca se filtra el km vigente al prompt", !promptOdometro({ digitos: 5, placa: "CUP-435" }).includes("23.980"));
}

// ── 6. Mismo agujero en el otro carril de lectura: el Radar ─────────────────
{
  const base: ContextoPrompt = { fechaHoy: "2026-09-06", horaAhora: "06:35" };
  const conFlota = promptExtraccionMedia({
    ...base,
    guiasOdometro: [
      { placa: "CUP-435", guia: null, digitos: 5 },            // sin guía escrita: antes ni se cargaba
      { placa: "BUI-272", guia: "el total va abajo", digitos: 6 },
      { placa: "SIN-DAT", guia: null, digitos: null },          // nada que decir de esta
    ],
  });
  chk("Radar · la unidad SIN guía llega al prompt con sus dígitos",
    conFlota.includes("CUP-435") && /CUP-435:[^\n]*5 d[ií]gitos/.test(conFlota));
  chk("Radar · la unidad con guía conserva las dos cosas",
    /BUI-272:[^\n]*6 d[ií]gitos[^\n]*el total va abajo/.test(conFlota));
  chk("Radar · la unidad sin guía NI dígitos no ocupa una línea vacía", !conFlota.includes("SIN-DAT"));
  chk("Radar · también manda contar las cifras", /CUENTA LAS CIFRAS/.test(conFlota));

  const sinFlota = promptExtraccionMedia({ ...base, guiasOdometro: [] });
  chk("Radar · sin unidades que declarar, no se inventa el bloque", !/CUENTA LAS CIFRAS/.test(sinFlota));
}

console.log(fallos ? `\n${fallos} prueba(s) fallaron` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
