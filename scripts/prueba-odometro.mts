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

import { elegirOdometro, digitosDe, corregirDigitoRepetido, revisarKmTecleado } from "../lib/odometro-seleccion";
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
  chk("CUP-435 · el número inflado de la IA NUNCA es el que se registra", v.km !== 239980, `km=${v.km}`);
  chk("CUP-435 · el defecto se NOMBRA con su código", v.codigo === "digito_repetido", String(v.codigo));
  chk("CUP-435 · el motivo dice las dos cantidades de dígitos",
    !!v.motivo && /6 d[ií]gitos/.test(v.motivo) && /tiene 5/.test(v.motivo), v.motivo ?? "");
  // Aquí SÍ se propone un número, y es el de la foto — pero solo porque el dígito que sobraba
  // estaba repetido (sección 7). Lo que sigue prohibido es recortar por donde cuadre: 23.990 y
  // 23.998 también caben en la banda y no son la lectura.
  chk("CUP-435 · se propone 23,980, que es lo que dice la foto", v.km === 23980, `km=${v.km}`);
  chk("CUP-435 · y NO uno de los otros borrados que también caben", v.km !== 23990 && v.km !== 23998);
  chk("CUP-435 · marcado para que lo confirme una persona", v.confirmar === true);
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
    chk(`${c.placa} · …y se marca para que lo CONFIRME una persona`, v.confirmar === true);
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
  const v = leer({ kmIA: 239980, kmVigente: 23980 });
  chk("el veredicto del dígito repetido es el que pide revisión", v.confirmar === true && v.origen === "corregido");
  const parcial = leer({ kmIA: 1803, tripIA: 174159, kmVigente: 174000 });
  chk("el rescate del trip NO pide revisión (ese número sí lo transcribió el modelo)",
    parcial.origen === "corregido" && !parcial.confirmar, `confirmar=${parcial.confirmar}`);
}

// ── 9. El prompt nombra el patrón real, no uno genérico ─────────────────────
{
  const p = promptOdometro({ digitos: 5, placa: "CUP-435" });
  chk("el prompt prohíbe REPETIR un dígito", /NO REPITAS UN D[IÍ]GITO/.test(p));
  chk("…con los casos medidos de esta flota", p.includes("23980→239980") && p.includes("560473→5600473"));
  const radar = promptExtraccionMedia({ fechaHoy: "2026-09-11", horaAhora: "00:15" });
  chk("Radar · también lo prohíbe", /NO REPITAS NINGUNA/.test(radar));
}

console.log(fallos ? `\n${fallos} prueba(s) fallaron` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
