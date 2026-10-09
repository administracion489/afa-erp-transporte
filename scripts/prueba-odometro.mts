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

import { elegirOdometro, digitosDe, corregirDigitoRepetido, revisarKmTecleado, decimalComoEntero, CERCANIA_ANCLA_KM } from "../lib/odometro-seleccion";
import { evaluarLectura, RATIO_DIGITO_DE_MAS, PISO_RATIO_DIGITO } from "../lib/odometro";
import { promptOdometro } from "../lib/vision-ia";
import { sinCifrasCopiables, formaOdometro, UMBRAL_CAMBIO_DE_CIFRA } from "../lib/odometro-prompt";
import { kmDeRecarga } from "../lib/radar/km-recarga";
import { readFileSync } from "node:fs";
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
  chk("CUP-435 · el número inflado de la IA NUNCA es el que se registra", v.km !== 239980, `km=${v.km}`);
  chk("CUP-435 · el defecto se NOMBRA con su código", v.codigo === "digito_repetido", String(v.codigo));
  chk("CUP-435 · el motivo dice las dos cantidades de dígitos",
    !!v.motivo && /6 d[ií]gitos/.test(v.motivo) && /tiene 5/.test(v.motivo), v.motivo ?? "");
  // Aquí SÍ se propone un número, y es el de la foto — pero solo porque el dígito que sobraba
  // estaba repetido (sección 7). Lo que sigue prohibido es recortar por donde cuadre: 23.990 y
  // 23.998 también caben en la banda y no son la lectura.
  chk("CUP-435 · se propone 23,980, que es lo que dice la foto", v.km === 23980, `km=${v.km}`);
  chk("CUP-435 · y NO uno de los otros borrados que también caben", v.km !== 23990 && v.km !== 23998);
  // Con el vigente ya en 23,980, otra lectura dice lo mismo que el colapso: tiene testigo y no
  // pide a nadie (sección 15). Con la unidad en marcha desde la última lectura, sí.
  chk("CUP-435 · con el vigente en 23,980 el colapso tiene testigo", v.testigo === "vigente" && v.confirmar === false);
  const enMarcha = leer({ kmIA: 239980, tripIA: 388, kmVigente: 23900 });
  chk("CUP-435 · con avance desde la última lectura, lo confirma una persona",
    enMarcha.km === 23980 && enMarcha.confirmar === true && !enMarcha.testigo, `km=${enMarcha.km}`);
  // El parcial (388.0) tampoco puede colarse como total: está por debajo del vigente.
  chk("CUP-435 · el trip no se promueve a total", v.km !== 388);
}

// ── 2. EL AGUJERO QUE LO REPITIÓ: sin lecturas vivas, el techo era Infinity ──
{
  // `hayHistorial:false` no es solo "unidad nueva": es también la unidad cuyas lecturas van
  // TODAS a sospechosa. Por eso la segunda lectura mala entraba igual de lisa que la primera.
  const v = leer({ kmIA: 239980, tripIA: 388, kmVigente: 23980, hayHistorial: false });
  chk("sin historial vivo · el número inflado SIGUE sin registrarse", v.km !== 239980, `km=${v.km}`);
  chk("sin historial vivo · y sigue nombrándose", v.codigo === "digito_repetido", String(v.codigo));

  // La segunda lectura mala: mismo día siguiente, mismo error. Antes entraba idéntica.
  // Sin cifras repetidas útiles no hay nada que proponer: bloqueo limpio, como debe ser.
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
// El bug de fondo no era un umbral flojo, era que había DOS: elegirOdometro (que decide QUÉ
// número se pre-llena en la pantalla) no aplicaba el guard de orden de magnitud que
// evaluarLectura (que decide si se guarda) aplica desde siempre.
//
// El invariante se fija sobre el número que el lector DEVUELVE (`veredicto.km`), que es el que
// de verdad se registra — no sobre el que la IA propuso. Es la corrección de un error de la
// prueba anterior: comparaba el veredicto del número corregido contra el juicio del crudo.
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
        const registrado = lector.km ?? km;
        const escritor = evaluarLectura({ kmVigente: vig, kmNuevo: registrado, kmDiaMax: 1500, horasDesdeUltima: null });
        const escritorAcusaDigito = /d[ií]gito de m[aá]s/i.test(escritor.motivo ?? "");
        if (lector.autoOk && escritorAcusaDigito) {
          choques++;
          console.log(`      choque: vigente ${vig} · IA ${km} · registra ${registrado} · historial=${hayHistorial} → "${escritor.motivo}"`);
        }
      }
    }
  }
  chk("lo que el lector deja registrar nunca es 'dígito de más' para la base", choques === 0, `${choques} choque(s)`);
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

// ── 4b. EL MISMO AVISO EN EL CAMPO DONDE SE TECLEA (revisarKmTecleado) ───────
// El panel de revisión de /radar-ia?tab=combustible pre-llena el odómetro que la IA leyó del
// tablero y deja corregirlo. Ese campo tiene que decir lo mismo que dirá la base al guardar,
// así que comparte las constantes con evaluarLectura en vez de traer un umbral propio.
{
  const v = revisarKmTecleado({ km: 239980, kmVigente: 23980 });
  chk("CUP-435 · el campo avisa del dígito de más antes de guardar", v?.codigo === "digito_de_mas");
  chk("…y nombra las dos cantidades de dígitos", !!v && /6 d[ií]gitos/.test(v.aviso) && /tiene 5/.test(v.aviso), v?.aviso ?? "");

  chk("un avance normal no levanta ningún ámbar", revisarKmTecleado({ km: 24300, kmVigente: 23980 }) === null);
  chk("el campo vacío no se juzga", revisarKmTecleado({ km: null, kmVigente: 23980 }) === null);
  chk("sin km vigente no se juzga", revisarKmTecleado({ km: 239980, kmVigente: 0 }) === null);
  chk(`bajo el piso del ratio (< ${PISO_RATIO_DIGITO.toLocaleString("es-PE")}) tampoco`,
    revisarKmTecleado({ km: 7000, kmVigente: 800 }) === null);

  // LO QUE NO SE AVISA A PROPÓSITO: un km MENOR al vigente puede ser legítimo (un voucher de
  // hace tres días que se procesa hoy). Ese lado lo juzga registrarLectura con las lecturas
  // vecinas en la mano; un ámbar aquí saldría en filas correctas y enseñaría a ignorarlos.
  chk("un retroceso NO se pinta en el campo (lo juzga quien escribe)",
    revisarKmTecleado({ km: 23000, kmVigente: 23980 }) === null);
}
{
  // Y el cruce que importa: lo que el campo deja pasar en silencio, el escritor no puede
  // marcarlo como dígito de más. Mismo invariante que la sección 4, del otro lado.
  let choques = 0;
  for (const vig of [6000, 23980, 174000, 568287]) {
    for (const f of [1.01, 1.2, 2, 5, 7.9, 8, 10, 100]) {
      const km = Math.round(vig * f);
      const enPantalla = revisarKmTecleado({ km, kmVigente: vig });
      const escritor = evaluarLectura({ kmVigente: vig, kmNuevo: km, kmDiaMax: 1500, horasDesdeUltima: null });
      if (!enPantalla && /d[ií]gito de m[aá]s/i.test(escritor.motivo ?? "")) {
        choques++;
        console.log(`      choque: vigente ${vig} · tecleado ${km} → "${escritor.motivo}"`);
      }
    }
  }
  chk("ningún número pasa liso por el campo y sale 'dígito de más' al guardarlo", choques === 0, `${choques} choque(s)`);
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

  // Sin unidades que declarar no se pinta el bloque POR UNIDAD (la regla general de contar las
  // cifras vive en CASO_ODOMETRO y sí va siempre: no afirma nada de ninguna placa).
  const sinFlota = promptExtraccionMedia({ ...base, guiasOdometro: [] });
  chk("Radar · sin unidades que declarar, no se inventa el bloque",
    !sinFlota.includes("Cómo se lee el odómetro de cada unidad"));
}

// ── 7. EL DÍGITO QUE SOBRA ESTÁ DUPLICADO, y eso sí se puede deshacer ───────
// Los cuatro casos reales de la flota (capturas del 06/09 y del 11/09). El modelo no inserta
// una cifra cualquiera: REPITE una que ya estaba. Colapsar esa repetición da UN solo valor
// dentro de la banda, mientras que borrar un dígito cualquiera da 3, 3, 0 y 4 — que es por lo
// que lo segundo no se hace y lo primero sí.
{
  const casos = [
    { placa: "CUP-435", ia: 239980,  ant: 23980,  horas: 24, espera: 23980,  foto: 23980 },  // verificado contra la foto
    { placa: "CUP-435", ia: 233379,  ant: 23272,  horas: 15, espera: 23379,  foto: null  },
    { placa: "B4N-968", ia: 5600473, ant: 559997, horas: 24, espera: 560473, foto: null  },
    { placa: "CUP-435", ia: 2320206, ant: 23206,  horas: 24, espera: null,   foto: 23206 },  // sin cifras repetidas
  ];
  for (const c of casos) {
    const v = leer({ kmIA: c.ia, kmVigente: c.ant, horasDesdeUltima: c.horas });
    if (c.espera == null) {
      chk(`${c.placa} · ${c.ia.toLocaleString("es-PE")} no tiene cifras repetidas → NO se toca`,
        v.origen === "ia" && v.codigo === "digito_de_mas" && v.km === c.ia, `codigo=${v.codigo} km=${v.km}`);
      continue;
    }
    chk(`${c.placa} · ${c.ia.toLocaleString("es-PE")} → ${c.espera.toLocaleString("es-PE")} colapsando la repetición`,
      v.km === c.espera && v.origen === "corregido" && v.codigo === "digito_repetido", `km=${v.km} codigo=${v.codigo}`);
    // Sin testigo lo confirma una persona; el primero colapsa justo sobre su anterior (sección 15).
    const conTestigo = c.espera - c.ant >= 0 && c.espera - c.ant <= CERCANIA_ANCLA_KM;
    chk(`${c.placa} · …${conTestigo ? "coincide con la anterior: no pide confirmación" : "y se marca para que lo CONFIRME una persona"}`,
      conTestigo ? v.confirmar === false && v.testigo === "vigente" : v.confirmar === true && !v.testigo);
    if (c.foto != null) {
      chk(`${c.placa} · …y coincide con lo que dice la foto (${c.foto.toLocaleString("es-PE")})`, v.km === c.foto);
    }
  }
}
{
  // La condición dura: con DOS colapsos posibles dentro de la banda no se elige ninguno.
  // 1123 → "11" da 123 y "22" no existe; se fabrica un caso con dos corridas que ambas caben.
  const dos = corregirDigitoRepetido(115500, 11500, 15600); // "11"→15500, "55"→11500, "00"→11550
  chk("con varios colapsos posibles dentro de la banda, no se elige ninguno", dos === null, String(dos));
  // Y un colapso que se sale de la banda tampoco cuenta como candidato.
  chk("un colapso fuera de la banda no vale", corregirDigitoRepetido(239980, 23956, 25480) === 23980);
  chk("sin cifras repetidas no hay candidato", corregirDigitoRepetido(2320206, 23183, 24706) === null);
}
{
  // El lado que NO se puede aflojar: una lectura legítima no puede convertirse en "corregida"
  // solo porque tenga dos cifras iguales seguidas. Si el número de la IA cabe en la banda,
  // manda tal cual — el colapso vive DESPUÉS de descartarlo por imposible.
  const legitimo = leer({ kmIA: 23990, kmVigente: 23980 });
  chk("un km legítimo CON cifras repetidas se acepta tal cual",
    legitimo.km === 23990 && legitimo.origen === "ia" && legitimo.codigo === null, `km=${legitimo.km}`);
  // Y sin ancla no se deduce nada (regla 2 del módulo).
  chk("sin km vigente no se colapsa nada", leer({ kmIA: 239980, kmVigente: 0 }).origen === "ia");
}

// ── 8. Y un número DEDUCIDO no se acepta solo ───────────────────────────────
// El Radar graba sin nadie mirando la foto. `forzarRevision` es lo que hace que la lectura
// exista en la bandeja (con su foto y el número ya corregido) sin mover el km vigente.
{
  const conRevision = evaluarLectura({ kmVigente: 23980, kmNuevo: 23980 + 60, horasDesdeUltima: 24 });
  chk("el caso base de esa lectura sería 'aceptada'", conRevision.estado === "aceptada", conRevision.estado);
  // La bajada a sospechosa la hace registrarLectura (toca BD); aquí se fija el contrato que usa:
  // un veredicto con confirmar=true es el que la dispara.
  // Con avance desde la última lectura (23,900 → 23,980): nadie más dice ese número.
  const v = leer({ kmIA: 239980, kmVigente: 23900 });
  chk("el veredicto del dígito repetido es el que pide revisión", v.confirmar === true && v.origen === "corregido");
  const parcial = leer({ kmIA: 1803, tripIA: 174159, kmVigente: 174000 });
  chk("el rescate del trip NO pide revisión (ese número sí lo transcribió el modelo)",
    parcial.origen === "corregido" && !parcial.confirmar, `confirmar=${parcial.confirmar}`);
}

// ── 9. El prompt nombra el patrón real, no uno genérico ─────────────────────
// …pero con LETRAS. Hasta el 08/10 citaba los casos con sus cifras (23980→239980), y 23980 es el
// odómetro de la CUP-435: la CTV-370, que iba por 29,8xx, registró dos veces 23,980 (sección 11).
{
  const p = promptOdometro({ digitos: 5, placa: "CUP-435" });
  chk("el prompt prohíbe REPETIR un dígito", /NO REPITAS UN D[IÍ]GITO/.test(p));
  chk("…con la FORMA del caso medido (letras, no cifras)", p.includes("«ABCCDE»") && p.includes("«ABCDDEF»"));
  const radar = promptExtraccionMedia({ fechaHoy: "2026-09-11", horaAhora: "00:15" });
  chk("Radar · también lo prohíbe", /NO REPITAS NINGUNA/.test(radar));
  chk("Radar · con la misma forma", radar.includes("«ABCCDE»"));
}

// ── 10. EL NÚMERO SE JUZGA CONTRA LAS LECTURAS DE SU FECHA, NO CONTRA EL VIGENTE DE HOY ──
// El Radar procesa y REPROCESA fotos de días atrás, y `elegirOdometro` armaba la banda con el km
// vigente — el máximo de HOY —, mientras que `evaluarLectura` (quien guarda) ya usaba la lectura
// anterior a la foto. Con la CUP-435 en 24,618 hoy, el tablero del 07/09 (240,035, repetición
// «00» → 24,035) quedaba «por debajo de lo posible»: sin propuesta, «dígito de más» a secas. El
// del 15/09 (248,871 → 24,871) sí cabía y sí se corregía. Mismo error, dos resultados.
{
  const hoy = 24618;
  const viejo = leer({ kmIA: 240035, kmVigente: hoy, horasDesdeUltima: 48 });
  chk("bug reproducido · contra el vigente de hoy, el 07/09 no se puede colapsar",
    viejo.codigo === "digito_de_mas" && viejo.km === 240035, `codigo=${viejo.codigo} km=${viejo.km}`);

  const v = leer({ kmIA: 240035, kmVigente: hoy, horasDesdeUltima: 48, vecinas: { anterior: 23980, posterior: hoy } });
  chk("CUP-435 07/09 · con las lecturas de su fecha, 240,035 → 24,035 (repetición «00»)",
    v.km === 24035 && v.codigo === "digito_repetido", `codigo=${v.codigo} km=${v.km}`);
  chk("CUP-435 07/09 · …y lo confirma una persona", v.confirmar === true);
  chk("CUP-435 07/09 · el motivo nombra la lectura anterior, no el vigente de hoy",
    !!v.motivo && v.motivo.includes("lectura anterior 23,980") && !v.motivo.includes("vigente"), v.motivo ?? "");

  const v8 = leer({ kmIA: 242241, kmVigente: hoy, horasDesdeUltima: 24, vecinas: { anterior: 24035, posterior: hoy } });
  chk("CUP-435 08/09 · 242,241 → 24,241 (repetición «22»)", v8.km === 24241 && v8.confirmar === true, `km=${v8.km}`);

  // El lado que no se puede aflojar: un número BUENO de esa fecha no es «imposible» porque hoy
  // la unidad vaya más adelante.
  const bueno = leer({ kmIA: 24100, kmVigente: hoy, horasDesdeUltima: 24, vecinas: { anterior: 23980, posterior: hoy } });
  chk("un km correcto de días atrás pasa tal cual", bueno.km === 24100 && bueno.autoOk && bueno.codigo === null,
    `codigo=${bueno.codigo} autoOk=${bueno.autoOk}`);
  chk("…y antes del arreglo salía «imposible»",
    leer({ kmIA: 24100, kmVigente: hoy, horasDesdeUltima: 24 }).codigo === "fuera_de_banda");

  // Y la lectura que vino DESPUÉS pone techo: nada puede superarla.
  const sobrePost = leer({ kmIA: 24700, kmVigente: hoy, horasDesdeUltima: 24, vecinas: { anterior: 23980, posterior: hoy } });
  chk("un km por encima de la lectura posterior no está en banda", !sobrePost.autoOk && sobrePost.codigo === "fuera_de_banda",
    `codigo=${sobrePost.codigo}`);
  // …y el techo de la posterior es lo que deja UN solo colapso posible donde antes había varios.
  chk("sin anterior (la más antigua de la serie), la posterior acota igual",
    leer({ kmIA: 240035, kmVigente: hoy, horasDesdeUltima: null, hayHistorial: true, vecinas: { anterior: null, posterior: hoy } }).km === 24035);
}
{
  // SIN vecinas, o con la anterior igual al vigente (una foto de AHORA), el resultado es el de
  // siempre: km, código, origen, autoOk y confirmar idénticos sobre toda la rejilla.
  let distintos = 0;
  for (const vig of [6000, 23980, 174000, 568287]) {
    for (const f of [0.99, 1, 1.01, 1.2, 2, 5, 7.9, 8, 10, 100]) {
      for (const horas of [null, 6, 24, 240]) {
        for (const hayHistorial of [true, false]) {
          const base = { kmIA: Math.round(vig * f), tripIA: null, textoLeido: null, kmVigente: vig, kmDiaMax: 1500, horasDesdeUltima: horas, hayHistorial };
          const a = elegirOdometro(base);
          const b = elegirOdometro({ ...base, vecinas: { anterior: vig, posterior: null } });
          const c = elegirOdometro({ ...base, vecinas: { anterior: null, posterior: null } });
          const firma = (x: typeof a) => `${x.km}|${x.codigo}|${x.origen}|${x.autoOk}|${x.confirmar ?? false}`;
          if (firma(a) !== firma(b) || firma(a) !== firma(c) || a.motivo !== c.motivo) distintos++;
        }
      }
    }
  }
  chk("una foto de ahora (anterior = vigente) se juzga exactamente igual que antes", distintos === 0, `${distintos} distinto(s)`);
}
{
  // EL CRUCE: lo que el lector deja pasar con las vecinas, el escritor —con las MISMAS vecinas—
  // no lo puede acusar de dígito de más, salto imposible, retroceso o incoherencia con la posterior.
  // Antes eran dos bases distintas (el vigente de hoy y la lectura anterior) para el mismo número.
  let choques = 0, juzgados = 0;
  const ref = (km: number, ts: number) => ({ km, ts, horaExacta: true });
  for (const ant of [6000, 23980, 174000]) {
    for (const post of [null, ant + 300, ant + 3000]) {
      for (const f of [0.99, 1, 1.005, 1.02, 1.2, 2, 8, 10]) {
        for (const horas of [12, 24, 72]) {
          const hoy = ant + 9000; // la unidad sigue avanzando: el vigente de HOY es otro número
          const lector = elegirOdometro({
            kmIA: Math.round(ant * f), tripIA: null, textoLeido: null, kmVigente: hoy,
            kmDiaMax: 1500, horasDesdeUltima: horas, hayHistorial: true, vecinas: { anterior: ant, posterior: post },
          });
          if (!lector.autoOk || lector.km == null) continue;
          juzgados++;
          const t0 = Date.parse("2026-09-07T10:00:00-05:00");
          const escritor = evaluarLectura({
            kmVigente: hoy, kmNuevo: lector.km, kmDiaMax: 1500, horasDesdeUltima: horas,
            refAnterior: ref(ant, t0 - horas * 3600_000),
            refPosterior: post != null ? ref(post, t0 + 3600_000) : null,
          });
          if (/d[ií]gito de m[aá]s|Salto improbable|Retrocede \d|Incoherente/.test(escritor.motivo ?? "")) {
            choques++;
            console.log(`      choque: anterior ${ant} · posterior ${post} · IA ${Math.round(ant * f)} → registra ${lector.km} → "${escritor.motivo}"`);
          }
        }
      }
    }
  }
  chk(`con las mismas vecinas, lector y escritor no se contradicen (${juzgados} casos)`, choques === 0 && juzgados > 0, `${choques} choque(s)`);
}

// ── 11. AL PROMPT NO VA NINGÚN KILOMETRAJE, NI SIQUIERA DE EJEMPLO ──────────
// La CTV-370 iba por 29,8xx y registró DOS veces exactamente 23,980 (12/09 y 17/09): el número del
// ejemplo del prompt, que es el odómetro de la CUP-435 del 05/09. Un número en el prompt es un
// número que el modelo copia cuando no logra leer la foto.
{
  // 99999 / 100000: el texto viejo de la forma decía «de 99999 a 100000 km», también copiable.
  const KM_DE_EJEMPLO = ["23980", "239980", "23379", "233379", "560473", "5600473", "175445", "82300", "99999", "100000"];
  const conSeparadores = (n: string) => [n, Number(n).toLocaleString("es-PE"), Number(n).toLocaleString("de-DE")];
  const enTexto = (t: string) => KM_DE_EJEMPLO.filter((n) => conSeparadores(n).some((v) => t.includes(v)));

  const vision = promptOdometro({ digitos: 5, placa: "CUP-435", guia: "el total está abajo, junto a ODO", lecciones: "- [CUP-435] Añadiste o perdiste un dígito." });
  chk("app/mantenimiento · el prompt no lleva ningún kilometraje de ejemplo", enTexto(vision).length === 0, enTexto(vision).join(", "));
  chk("app/mantenimiento · y dice que el número sale solo de la foto", /sale SOLO de la foto/.test(vision));

  const radar = promptExtraccionMedia({
    fechaHoy: "2026-09-17", horaAhora: "20:56",
    guiasOdometro: [{ placa: "CTV-370", guia: null, digitos: 5 }, { placa: "CUP-435", guia: null, digitos: 5 }],
  });
  chk("Radar · el prompt no lleva ningún kilometraje de ejemplo", enTexto(radar).length === 0, enTexto(radar).join(", "));
  chk("Radar · y dice que el número sale solo de la foto", /sale SOLO de la foto/.test(radar));
  chk("Radar · la coma de miles se sigue enseñando (con letras)", radar.includes("ABC,DEF"));

  // Lo que teclea una persona (la nota de una corrección, la guía del tablero) entra con sus cifras
  // largas tapadas: la forma enseña lo mismo y no deja un número copiable.
  chk("la nota del operador pierde sus kilometrajes y conserva su forma",
    sinCifrasCopiables("el tablero dice 23980, no 239,980") === "el tablero dice #####, no ###,###",
    sinCifrasCopiables("el tablero dice 23980, no 239,980"));
  chk("…el trip con decimal también se tapa", sinCifrasCopiables("el 1803.6 es el trip") === "el ####.# es el trip");
  chk("…y lo corto sigue legible (placa, dígitos, hora)",
    sinCifrasCopiables("CUP-435: 5 dígitos, foto de las 20:25") === "CUP-435: 5 dígitos, foto de las 20:25");
  const conGuiaNumerica = promptOdometro({ digitos: 5, placa: "CUP-435", guia: "el ODO de abajo, marcaba 24618" });
  chk("app/mantenimiento · la guía con un km lo lleva tapado", conGuiaNumerica.includes("marcaba #####") && !conGuiaNumerica.includes("24618"));
  const radarGuia = promptExtraccionMedia({ fechaHoy: "2026-09-17", horaAhora: "20:56", guiasOdometro: [{ placa: "CUP-435", guia: "abajo, marcaba 24618", digitos: 5 }] });
  chk("Radar · la guía con un km lo lleva tapado", radarGuia.includes("marcaba #####") && !radarGuia.includes("24618"));
}

// ── 12. EL ODÓMETRO SUBE DE CIFRA: la frase lo admite cuando está cerca, y solo entonces ──
// Decirle al modelo «5 cifras» a secas es lo que frena el dígito de más, pero el día que la unidad
// pasa de 99,950 a 100,020 (70 km) la única lectura correcta tiene 6. El texto viejo decía que eso
// «exige un salto enorme desde la última lectura», que es falso.
{
  chk("lejos de la cifra siguiente: 5 cifras y no puede subir",
    JSON.stringify(formaOdometro(23980)) === JSON.stringify({ cifras: 5, puedeSubir: false }));
  chk("justo antes del umbral, todavía no", formaOdometro(Math.pow(10, 5) * UMBRAL_CAMBIO_DE_CIFRA - 1)?.puedeSubir === false);
  chk("en el umbral (90 % de la cifra siguiente) ya puede subir", formaOdometro(90000)?.puedeSubir === true);
  chk("99,950 puede subir a 6", JSON.stringify(formaOdometro(99950)) === JSON.stringify({ cifras: 5, puedeSubir: true }));
  chk("…y lo mismo en el paso de 6 a 7 cifras", JSON.stringify(formaOdometro(999900)) === JSON.stringify({ cifras: 6, puedeSubir: true }));
  chk("sin km no hay forma", formaOdometro(0) === null && formaOdometro(null) === null);
  // Barrido: puedeSubir ⟺ km ≥ 90 % de la cifra siguiente, en las tres formas de la flota.
  let malas = 0;
  for (const cifras of [5, 6, 7]) {
    for (let k = Math.pow(10, cifras - 1); k < Math.pow(10, cifras); k += Math.pow(10, cifras - 3)) {
      const f = formaOdometro(k);
      if (!f || f.cifras !== cifras || f.puedeSubir !== (k >= Math.pow(10, cifras) * UMBRAL_CAMBIO_DE_CIFRA)) malas++;
    }
  }
  chk("barrido · puedeSubir ⟺ km ≥ 90 % de la cifra siguiente", malas === 0, `${malas} mala(s)`);

  const lejos = promptOdometro({ digitos: 5, placa: "CUP-435", puedeSubir: false });
  const cerca = promptOdometro({ digitos: 5, placa: "ABC-123", puedeSubir: true });
  chk("app · lejos del cambio, la frase dice 5 y no ofrece 6", /5 d[ií]gitos/.test(lejos) && !lejos.includes("«10»"));
  chk("app · ya no afirma que el cambio exige un salto enorme", !/salto enorme/.test(lejos) && !/salto enorme/.test(cerca));
  chk("app · cerca del cambio, admite 6 solo si empieza por «10»", /pasar a 6/.test(cerca) && cerca.includes("«10»"));
  const radar = promptExtraccionMedia({
    fechaHoy: "2026-10-08", horaAhora: "10:00",
    guiasOdometro: [{ placa: "CUP-435", guia: null, digitos: 5, puedeSubir: false }, { placa: "ABC-123", guia: null, digitos: 5, puedeSubir: true }],
  });
  chk("Radar · la unidad lejos del cambio conserva su línea de siempre",
    /CUP-435: el odómetro TOTAL es un número de 5 dígitos \(sin contar el tambor de décimas, si lo tiene\)\n/.test(radar));
  chk("Radar · la unidad cerca del cambio admite 6 si empieza por «10»", /ABC-123:[^\n]*pasar a 6[^\n]*«10»/.test(radar));
  chk("Radar · sin `puedeSubir` (filas viejas) se comporta como lejos",
    !promptExtraccionMedia({ fechaHoy: "2026-10-08", horaAhora: "10:00", guiasOdometro: [{ placa: "XYZ-999", guia: null, digitos: 5 }] }).includes("«10»"));

  // Y la validación del ERP nunca dependió de la cantidad de cifras: juzga el VALOR.
  for (const [ant, nuevo] of [[99950, 100020], [999900, 1000040]]) {
    const v = leer({ kmIA: nuevo, kmVigente: ant, vecinas: { anterior: ant, posterior: null } });
    const w = evaluarLectura({ kmVigente: ant, kmNuevo: nuevo, horasDesdeUltima: 24 });
    chk(`el cambio de cifra ${ant.toLocaleString("es-PE")} → ${nuevo.toLocaleString("es-PE")} pasa limpio`,
      v.km === nuevo && v.codigo === null && w.estado === "aceptada", `selector=${v.codigo} base=${w.estado}`);
  }
  // …y un dígito de más cerca del cambio se sigue atrapando (no empieza por 10, y se colapsa).
  const cercaMal = leer({ kmIA: 959950, kmVigente: 95950, vecinas: { anterior: 95950, posterior: null } });
  chk("cerca del cambio, 959,950 sobre 95,950 sigue siendo un dígito de más",
    cercaMal.km !== 959950 && cercaMal.codigo === "digito_repetido", `km=${cercaMal.km} codigo=${cercaMal.codigo}`);
}

// ── 13. EL KM DE UNA RECARGA PASA POR EL MISMO SELECTOR ─────────────────────
// La ruta de combustible del Radar escribía el km del tablero tal cual —en la carga, en la fila del
// Radar y en lecturas_odometro—, sin colapsar el dígito repetido ni avisar que sobra uno.
{
  const v = leer({ kmIA: 240035, kmVigente: 24618, horasDesdeUltima: 48, vecinas: { anterior: 23980, posterior: 24618 } });
  const r = kmDeRecarga(240035, v);
  chk("recarga · 240,035 → 24,035, como en la foto de odómetro suelta", r.km === 24035, `km=${r.km}`);
  chk("recarga · el colapsado BLOQUEA el auto-registro (lo confirma una persona)",
    r.anomalia?.codigo === "km_corregido" && r.anomalia.bloquea === true);
  chk("recarga · lo que leyó la IA viaja en la anomalía, no en la fila",
    r.anomalia?.correccion?.campo === "kilometraje" && r.anomalia.correccion.leido === 240035 && r.anomalia.correccion.corregido === 24035);

  const sinRep = kmDeRecarga(247368, leer({ kmIA: 247368, kmVigente: 24618, horasDesdeUltima: 24, vecinas: { anterior: 24618, posterior: null } }));
  chk("recarga · sin cifra repetida no se adivina: queda lo leído y BLOQUEA",
    sinRep.km === 247368 && sinRep.anomalia?.codigo === "km_digito_de_mas" && sinRep.anomalia.bloquea === true,
    `${sinRep.km} ${sinRep.anomalia?.codigo}`);

  const trip = kmDeRecarga(1803, leer({ kmIA: 1803, tripIA: 174159, kmVigente: 174000 }));
  chk("recarga · trip y total intercambiados: se usa el total y NO bloquea (el modelo sí lo transcribió)",
    trip.km === 174159 && trip.anomalia?.codigo === "km_corregido" && trip.anomalia.bloquea === false);

  // El lado que no se puede aflojar: lo que estaba bien sigue igual, sin anomalía nueva.
  const bueno = kmDeRecarga(24100, leer({ kmIA: 24100, kmVigente: 24618, horasDesdeUltima: 24, vecinas: { anterior: 23980, posterior: 24618 } }));
  chk("recarga · un km correcto queda tal cual y sin anomalía", bueno.km === 24100 && bueno.anomalia === null);
  chk("recarga · sin unidad o sin contexto (veredicto null) es exactamente lo de antes",
    kmDeRecarga(239980, null).km === 239980 && kmDeRecarga(239980, null).anomalia === null);
  chk("recarga · sin km leído no se fabrica uno", kmDeRecarga(null, null).km === null);
  // Lo fuera de banda que no es de cifras (un retroceso, un salto) lo siguen juzgando los
  // controles de siempre: aquí no se levanta nada nuevo.
  const fuera = kmDeRecarga(23000, leer({ kmIA: 23000, kmVigente: 24618, horasDesdeUltima: 24, vecinas: { anterior: 24618, posterior: null } }));
  chk("recarga · un retroceso no levanta una anomalía de cifras", fuera.km === 23000 && fuera.anomalia === null);

  // Un código sin etiqueta en /radar-ia imprime el código crudo.
  const pagina = readFileSync(new URL("../app/radar-ia/page.tsx", import.meta.url), "utf8");
  chk("las dos anomalías nuevas tienen etiqueta en /radar-ia",
    /\bkm_corregido:\s*"/.test(pagina) && /\bkm_digito_de_mas:\s*"/.test(pagina));
}


// ── 14. El tambor de DÉCIMAS leído como una cifra más (B4N-968, octubre 2026) ──
// Tablero mecánico «5 6 1 2 9 [2]», el último tambor en otro color: 56,129.2 km. La IA devolvía
// 561,292. Y como venía pasando desde antes, el historial de la unidad quedó en esa escala.
console.log("\n14. Tambor de décimas");
{
  chk("decimalComoEntero · «56129.2» con km 561292 → 56129", decimalComoEntero(561292, "56129.2") === 56129);
  chk("…también con separador de miles («56,129.2»)", decimalComoEntero(561292, "ODO 56,129.2 km") === 56129);
  chk("…con coma decimal («56129,2»)", decimalComoEntero(561292, "56129,2") === 56129);
  chk("«174,159» son MILES, no una décima", decimalComoEntero(174159, "174,159") === null);
  chk("sin punto en el texto no se deduce nada", decimalComoEntero(561292, "561292") === null);
  chk("una décima de OTRO número (el trip) no toca el km", decimalComoEntero(174159, "1803.6 y 174159") === null);
  chk("sin texto, nada", decimalComoEntero(561292, null) === null);

  // Con el historial ya corregido (en kilómetros): se registra la parte entera, sin pedir confirmación.
  const ok = leer({ kmIA: 561292, textoLeido: "56129.2", kmVigente: 56050, vecinas: { anterior: 56050, posterior: null } });
  chk("B4N-968 · se registra 56,129, no 561,292", ok.km === 56129 && ok.codigo === "decimal_como_entero", `km=${ok.km} codigo=${ok.codigo}`);
  chk("…cuadra con la unidad: sigue el curso normal", ok.autoOk === true && ok.origen === "corregido");
  chk("…no lleva `confirmar`: lo transcribió el modelo, no lo dedujo el ERP", ok.confirmar !== true);
  chk("…el motivo dice que el último tambor son décimas", /D[ÉE]CIMAS/i.test(ok.motivo ?? ""));

  // Con el historial CONTAMINADO (las décimas como kilómetros): el número malo cae «en banda».
  // Antes se aceptaba tal cual y seguía alimentando la escala equivocada.
  const sucio = leer({ kmIA: 561292, textoLeido: "56129.2", kmVigente: 560287, vecinas: { anterior: 560287, posterior: null } });
  const antes = leer({ kmIA: 561292, kmVigente: 560287, vecinas: { anterior: 560287, posterior: null } });
  chk("regresión · sin la transcripción, el ×10 se acepta como bueno (el defecto)", antes.km === 561292 && antes.autoOk === true);
  chk("historial ×10 · con la transcripción se registra 56,129 igual", sucio.km === 56129 && sucio.codigo === "decimal_como_entero");
  chk("…pero NO pasa de largo: hay que mirarlo", sucio.autoOk === false);
  chk("…y el motivo nombra el historial en la escala de las décimas", /historial/.test(sucio.motivo ?? "") && /décimas/.test(sucio.motivo ?? ""));

  // Sin ancla: la parte entera, con el curso normal.
  const nuevo = leer({ kmIA: 561292, textoLeido: "56129.2", kmVigente: 0, hayHistorial: false });
  chk("unidad sin km · se registra la parte entera", nuevo.km === 56129 && nuevo.autoOk === true);

  // Lo que NO se toca.
  const bien = leer({ kmIA: 56129, textoLeido: "56129.2", kmVigente: 56050, vecinas: { anterior: 56050, posterior: null } });
  chk("la IA ya dejó fuera la décima → nada que corregir", bien.km === 56129 && bien.codigo === null && bien.origen === "ia");
  const trip = leer({ kmIA: 18036, tripIA: 174159, textoLeido: "1803.6 · 174159", kmVigente: 174100, vecinas: { anterior: 174100, posterior: null } });
  chk("el punto era del TRIP y el total cuadra → el rescate de siempre", trip.km === 174159 && trip.codigo === "parcial", `km=${trip.km} codigo=${trip.codigo}`);
  const cup = leer({ kmIA: 239980, tripIA: 388, kmVigente: 23980 });
  chk("CUP-435 sigue siendo el dígito repetido", cup.km === 23980 && cup.codigo === "digito_repetido");

  // La recarga usa el mismo veredicto.
  const rOk = kmDeRecarga(561292, ok);
  chk("recarga · km 56,129 sin bloquear", rOk.km === 56129 && rOk.anomalia?.codigo === "km_corregido" && rOk.anomalia?.bloquea === false);
  const rSucio = kmDeRecarga(561292, sucio);
  chk("recarga · con el historial ×10, corrige y BLOQUEA", rSucio.km === 56129 && rSucio.anomalia?.bloquea === true);

  // La regla está en los dos carriles, y la forma no cuenta el tambor.
  const app = promptOdometro({ digitos: 5, placa: "B4N-968" });
  chk("app · el prompt explica el tambor de décimas", /TAMBORES/.test(app) && /DÉCIMAS/.test(app) && /«ABCDE\.F»/.test(app));
  chk("app · la forma de 5 cifras no cuenta el tambor", /5 dígitos \(sin contar el tambor de décimas/.test(app));
  const radar = promptExtraccionMedia({ fechaHoy: "2026-10-09", horaAhora: "10:00" });
  chk("Radar · la lectura del tablero explica el tambor de décimas", /TAMBORES/.test(radar) && /texto_kilometraje/.test(radar));
  chk("app · sin cifras copiables en la regla", !/\d{4,}/.test(app.match(/ODÓMETRO DE TAMBORES[^\n]*/)?.[0] ?? "x1234"));
}

// ── 15. UN NÚMERO DEDUCIDO QUE OTRA LECTURA ATESTIGUA YA NO PIDE A UNA PERSONA ──
// CTV-370, 09/10/2026 06:42: la IA leyó 314,482, el colapso dio 31,482 y la lectura de las 16:03
// del día anterior (otra foto) decía 31,482 — la unidad durmió en la cochera. Igual quedó en
// «Lecturas por revisar» y alguien tuvo que abrir la foto para confirmar lo que dos tableros ya
// decían. Lo que esta sección fija del lado que NO se afloja: sin testigo sigue pidiendo a una
// persona, y con testigo el número no puede mover el km vigente más de CERCANIA_ANCLA_KM.
console.log("\n15. Dígito repetido con testigo");
{
  const ctv = leer({ kmIA: 314482, kmVigente: 31482, horasDesdeUltima: 14.65, vecinas: { anterior: 31482, posterior: null } });
  chk("CTV-370 · 314,482 → 31,482", ctv.km === 31482 && ctv.codigo === "digito_repetido", `km=${ctv.km} codigo=${ctv.codigo}`);
  chk("CTV-370 · la lectura anterior es el testigo", ctv.testigo === "anterior", String(ctv.testigo));
  chk("CTV-370 · …y ya NO pide confirmación", ctv.confirmar === false);
  chk("CTV-370 · el motivo dice con quién coincide", /coincide con la lectura anterior 31,482/.test(ctv.motivo ?? ""), ctv.motivo ?? "");
  // Lo que hará registrarLectura con ese número: el mismo km que la anterior, otra foto → aceptada.
  const t0 = Date.parse("2026-10-09T06:42:00-05:00");
  const escrito = evaluarLectura({
    kmVigente: 31482, kmNuevo: ctv.km!, origenIA: true, horasDesdeUltima: 14.65,
    refAnterior: { km: 31482, ts: Date.parse("2026-10-08T16:03:00-05:00"), horaExacta: true, fuente: "whatsapp_foto" },
    ahora: new Date(t0),
  });
  chk("CTV-370 · quien escribe la acepta («Sin avance»)", escrito.estado === "aceptada" && /Sin avance/.test(escrito.motivo ?? ""), `${escrito.estado} · ${escrito.motivo}`);
  // El contrato con el Radar: `forzarRevision` sale de `confirmar`, no del código.
  const acciones = readFileSync(new URL("../lib/radar/acciones.ts", import.meta.url), "utf8");
  chk("Radar · forzarRevision se lee de `confirmar`", /forzarRevision:\s*veredicto\.confirmar === true/.test(acciones));

  // El sentido en que avanza el odómetro: hasta 2 km POR ENCIMA de la anterior.
  const mas2 = leer({ kmIA: 314482, kmVigente: 31480, vecinas: { anterior: 31480, posterior: null } });
  chk("+2 km sobre la anterior → testigo", mas2.km === 31482 && mas2.testigo === "anterior" && mas2.confirmar === false);
  const mas3 = leer({ kmIA: 314482, kmVigente: 31479, vecinas: { anterior: 31479, posterior: null } });
  chk("+3 km → sin testigo: lo confirma una persona", mas3.km === 31482 && !mas3.testigo && mas3.confirmar === true);
  const menos1 = leer({ kmIA: 314482, kmVigente: 31483, vecinas: { anterior: 31483, posterior: null } });
  chk("1 km POR DEBAJO de la anterior no es un testigo (es un retroceso)", menos1.km === 31482 && !menos1.testigo && menos1.confirmar === true,
    `km=${menos1.km} testigo=${menos1.testigo}`);

  // La lectura POSTERIOR (un reproceso de una foto vieja) también atestigua, hasta 2 km por debajo.
  const post = leer({ kmIA: 314482, kmVigente: 31600, horasDesdeUltima: 24, vecinas: { anterior: 31300, posterior: 31483 } });
  chk("posterior a 1 km → testigo", post.km === 31482 && post.testigo === "posterior" && post.confirmar === false, `testigo=${post.testigo}`);
  const postLejos = leer({ kmIA: 314482, kmVigente: 31600, horasDesdeUltima: 24, vecinas: { anterior: 31300, posterior: 31490 } });
  chk("posterior a 8 km → sin testigo", postLejos.km === 31482 && !postLejos.testigo && postLejos.confirmar === true);

  // Sin vecinas (una foto de ahora, en pantalla) el ancla es el vigente, igual que para la banda.
  const ahora = leer({ kmIA: 314482, kmVigente: 31482 });
  chk("sin vecinas · el km vigente es el testigo", ahora.testigo === "vigente" && ahora.confirmar === false);

  // Los casos reales con avance (sección 7): la unidad se movió, nadie más lo dice → una persona.
  for (const c of [
    { ia: 239980, ant: 23900, horas: 24, espera: 23980 },
    { ia: 233379, ant: 23272, horas: 15, espera: 23379 },
    { ia: 5600473, ant: 559997, horas: 24, espera: 560473 },
  ]) {
    const v = leer({ kmIA: c.ia, kmVigente: c.ant, horasDesdeUltima: c.horas, vecinas: { anterior: c.ant, posterior: null } });
    chk(`${c.ia.toLocaleString("es-PE")} → ${c.espera.toLocaleString("es-PE")} con avance · sigue pidiendo confirmación`,
      v.km === c.espera && v.confirmar === true && !v.testigo, `km=${v.km} testigo=${v.testigo}`);
  }

  // La recarga lee la misma bandera: con testigo usa el número sin bloquear.
  const rec = kmDeRecarga(314482, ctv);
  chk("recarga · con testigo: 31,482 y NO bloquea", rec.km === 31482 && rec.anomalia?.codigo === "km_corregido" && rec.anomalia.bloquea === false);
  chk("recarga · sin testigo: sigue bloqueando", kmDeRecarga(314482, mas3).anomalia?.bloquea === true);

  // EL BARRIDO. Dos hipótesis de cómo llegó el número de la IA: (a) repitió una cifra del km real
  // —la que el colapso deshace—; (b) el tambor de décimas entró como cifra y no hubo transcripción
  // que lo delatara —la hipótesis en la que el colapso PUEDE equivocarse—. En las dos, lo que se
  // exige es lo que hace seguro aceptarlo: con testigo, el número queda a ≤ 2 km sobre la anterior
  // o por debajo de la posterior, así que no puede subir el km vigente más de 2 km.
  let juzgados = 0, conTestigo = 0, testigoMal = 0, rompeVigente = 0, bandera = 0, sinTestigoConAvance = 0, avanceJuzgado = 0;
  for (const ant of [6000, 23980, 31482, 174000, 559997]) {
    for (const delta of [0, 1, 2, 3, 5, 40, 300]) {
      const V = ant + delta;
      for (const post of [null, V, V + 2, V + 3, V + 400]) {
        const entradas: { kmIA: number; hipotesis: "repite" | "decima" }[] = [];
        const s = String(V);
        for (let i = 0; i < s.length; i++) entradas.push({ kmIA: Number(s.slice(0, i + 1) + s.slice(i)), hipotesis: "repite" });
        for (let d = 0; d <= 9; d++) entradas.push({ kmIA: V * 10 + d, hipotesis: "decima" });
        for (const e of entradas) {
          const v = leer({ kmIA: e.kmIA, kmVigente: post ?? V, horasDesdeUltima: 24, vecinas: { anterior: ant, posterior: post } });
          if (v.codigo !== "digito_repetido" || v.km == null) continue;
          juzgados++;
          if ((v.confirmar === true) === !!v.testigo) bandera++;          // exactamente una de las dos
          if (!v.testigo) continue;
          conTestigo++;
          // El vigente es el máximo de las lecturas vivas, y aquí las vivas son la anterior y la posterior.
          if (v.km > Math.max(ant, post ?? ant) + CERCANIA_ANCLA_KM) rompeVigente++;
          if (e.hipotesis === "repite" && v.km !== V) testigoMal++;
        }
        // El lado que no se afloja: con avance (≥ 3 km) y sin una posterior pegada, nadie atestigua.
        if (delta >= 3 && (post == null || post - V >= 3)) {
          for (let i = 0; i < s.length; i++) {
            const v = leer({ kmIA: Number(s.slice(0, i + 1) + s.slice(i)), kmVigente: post ?? V, horasDesdeUltima: 24, vecinas: { anterior: ant, posterior: post } });
            if (v.codigo !== "digito_repetido" || v.km !== V) continue;
            avanceJuzgado++;
            if (v.testigo) sinTestigoConAvance++;
          }
        }
      }
    }
  }
  chk(`barrido · confirmar ⟺ sin testigo (${juzgados} colapsos)`, bandera === 0 && juzgados > 0, `${bandera} contradicción(es)`);
  chk("barrido · con testigo, el número nunca sube el vigente más de 2 km", rompeVigente === 0, `${rompeVigente}`);
  chk("barrido · si la IA repitió una cifra, el testigo nunca confirma un número equivocado", testigoMal === 0, `${testigoMal}`);
  chk(`barrido · con avance y sin posterior pegada, nadie atestigua (${avanceJuzgado} casos)`, sinTestigoConAvance === 0 && avanceJuzgado > 0, `${sinTestigoConAvance}`);
  // Corolario: un motor que nunca diera testigo cumpliría todo lo anterior de forma trivial.
  chk(`barrido · y el testigo SÍ aparece (${conTestigo} veces)`, conTestigo > 0);
}

console.log(fallos ? `\n${fallos} prueba(s) fallaron` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
