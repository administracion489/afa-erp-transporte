// Matriz de la FICHA DE UN TIPO DE VEHÍCULO (nombre · capacidad · grupo · ícono).
// Uso:  npx tsx scripts/prueba-ficha-tipo.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ CADA COSA
//
// 1 · QUE SE PUEDA CORREGIR EL NOMBRE. Es lo que faltaba: los quince campos de dinero de la
//     tabla eran editables y los cuatro que identifican al tipo en pantalla, no. Un
//     «SUV 6 pax GLP» mal escrito se lee en el cotizador, en el comparativo y en el tarifario.
//
// 2 · QUE EL PATCH LLEVE SOLO LO QUE CAMBIÓ. Mandar las cuatro columnas siempre dejaría cuatro
//     actas por cada corrección de una letra, y el historial es lo único que dice quién movió
//     qué. Un nombre que solo ganó un espacio al final NO es un cambio (se compara limpio en
//     los dos lados), y el ícono SÍ se puede vaciar: `null` es un dato, y sin eso un ícono
//     puesto por error no se podría retirar — el mismo agujero que tuvo `capacidad_tanque`.
//
// 3 · QUE LA CAPACIDAD NO ADMITA UN NÚMERO QUE NO ES DE ASIENTOS. Cero, negativo, decimal o
//     vacío bloquean el guardado en vez de escribir un tipo que el cotizador ofrecería como
//     "0 pax". Y cuando cambia, el acta lleva sus DOS números: es lo que lee la columna
//     "Variación" del historial.
//
// 4 · LA INVARIANTE DURA, comprobada por barrido: `guardable` implica patch no vacío Y cero
//     errores Y un acta por cada cambio. Un plan guardable sin actas sería una edición que no
//     deja rastro; uno con actas y sin patch, un historial que miente.
//
// 5 · EL LADO QUE NO SE PUEDE AFLOJAR: la CLAVE (`tipo_vehiculo`) no aparece NUNCA en el patch,
//     por mucho que se toquetee el formulario. Es texto sin FK y es el puente con las placas de
//     la flota, con el historial y con lo ya cotizado; moverla desde aquí sería dejar todo eso
//     apuntando a una clave que no existe.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const F = requerir("../lib/costos/ficha-tipo") as typeof import("../lib/costos/ficha-tipo");
const { planDeFicha, fichaAForm, parsearCapacidad, GRUPOS_VEHICULO, ETIQUETA_FICHA } = F;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

/** El caso que abrió esto: el tipo que el dueño no podía renombrar. */
const SUV: import("../lib/costos/ficha-tipo").FichaTipo = {
  tipo_vehiculo: "SUV_6_GLP",
  nombre: "SUV 6 pax GLP",
  capacidad: 6,
  icono: "🚙",
  grupo_vehiculo: "Ligeros",
};
const form = (p: Partial<import("../lib/costos/ficha-tipo").FormFicha> = {}) => ({ ...fichaAForm(SUV), ...p });

console.log("\n── 1 · SE PUEDE CORREGIR EL NOMBRE ──────────────────────────────────");
{
  const p = planDeFicha(SUV, form({ nombre: "SUV 6 pax GLP Euro III" }));
  chk("renombrar es guardable", p.guardable);
  chk("el patch lleva solo `nombre`", JSON.stringify(Object.keys(p.patch)) === '["nombre"]', Object.keys(p.patch).join(","));
  chk("deja UN acta, del campo nombre", p.actas.length === 1 && p.actas[0].campo_modificado === "nombre");
  chk("el acta de un texto no inventa números",
    p.actas[0].valor_anterior === null && p.actas[0].valor_nuevo === null);
  chk("el acta nombra el antes y el después",
    p.actas[0].motivo.includes("SUV 6 pax GLP") && p.actas[0].motivo.includes("Euro III"), p.actas[0].motivo);
  chk("el cambio se puede enseñar antes del botón",
    p.cambios.length === 1 && p.cambios[0].etiqueta === ETIQUETA_FICHA.nombre &&
    p.cambios[0].antes === "SUV 6 pax GLP" && p.cambios[0].despues === "SUV 6 pax GLP Euro III");

  const conNota = planDeFicha(SUV, form({ nombre: "SUV 6 pax GLP Euro III" }), "corrige ficha mal tecleada");
  chk("el motivo de la barra se ANEXA al acta", conNota.actas[0].motivo.endsWith("| corrige ficha mal tecleada"));

  const vacio = planDeFicha(SUV, form({ nombre: "   " }));
  chk("el nombre vacío BLOQUEA", !vacio.guardable && vacio.errores.length === 1);
  chk("y no escribe nada", Object.keys(vacio.patch).length === 0);
}

console.log("\n── 2 · SOLO VIAJA LO QUE CAMBIÓ ─────────────────────────────────────");
{
  const igual = planDeFicha(SUV, form());
  chk("sin tocar nada no hay patch ni actas", !igual.guardable && !igual.actas.length && !Object.keys(igual.patch).length);
  chk("y tampoco hay errores que asusten", igual.errores.length === 0);

  const espacios = planDeFicha(SUV, form({ nombre: "  SUV 6   pax GLP " }));
  chk("un nombre que solo ganó espacios NO es un cambio", !espacios.guardable && !espacios.actas.length);

  const tres = planDeFicha(SUV, form({ nombre: "SUV 6 pax GLP", capacidad: "7", grupo_vehiculo: "Vans", icono: "🚐" }));
  chk("tres campos a la vez → tres actas", tres.actas.length === 3, tres.actas.map(a => a.campo_modificado).join(","));
  chk("una acta por campo, sin repetir", new Set(tres.actas.map(a => a.campo_modificado)).size === 3);
  chk("el patch lleva exactamente esos tres",
    JSON.stringify(Object.keys(tres.patch).sort()) === '["capacidad","grupo_vehiculo","icono"]', Object.keys(tres.patch).join(","));

  const sinIcono = planDeFicha(SUV, form({ icono: "" }));
  chk("el ícono SE PUEDE VACIAR (null viaja)", sinIcono.guardable && "icono" in sinIcono.patch && sinIcono.patch.icono === null);
  const iconoNuevo = planDeFicha({ ...SUV, icono: null }, form({ icono: "🚌" }));
  chk("y se puede poner uno donde no había", iconoNuevo.patch.icono === "🚌" && iconoNuevo.cambios[0].antes === "—");
}

console.log("\n── 3 · LA CAPACIDAD SON ASIENTOS ────────────────────────────────────");
{
  for (const malo of ["", "  ", "0", "-3", "6.5", "seis", "6 pax", "1e3"]) {
    const p = planDeFicha(SUV, form({ capacidad: malo }));
    chk(`capacidad «${malo}» bloquea`, !p.guardable && p.errores.some(e => e.includes("capacidad")), p.errores.join(" "));
  }
  const ok = planDeFicha(SUV, form({ capacidad: "7" }));
  chk("capacidad 7 es guardable", ok.guardable && ok.patch.capacidad === 7);
  chk("el acta de la capacidad lleva sus DOS números",
    ok.actas[0].valor_anterior === 6 && ok.actas[0].valor_nuevo === 7);
  chk("y avisa de lo que NO toca (placas ni PAX contratado)",
    ok.avisos.some(a => a.includes("placa") && a.includes("contratado")), ok.avisos.join(" | "));
  chk("parsearCapacidad devuelve null en lo que no es un conteo",
    parsearCapacidad("0") === null && parsearCapacidad("6.5") === null && parsearCapacidad("6") === 6);
}

console.log("\n── 4 · GRUPO Y NOMBRE REPETIDO ──────────────────────────────────────");
{
  const vacio = planDeFicha(SUV, form({ grupo_vehiculo: "" }));
  chk("el grupo vacío bloquea", !vacio.guardable && vacio.errores.some(e => e.includes("grupo")));

  const raro = planDeFicha(SUV, form({ grupo_vehiculo: "Camionetas" }));
  chk("un grupo fuera de la lista se GUARDA igual", raro.guardable && raro.patch.grupo_vehiculo === "Camionetas");
  chk("pero se avisa de que sale en su propio bloque", raro.avisos.some(a => a.includes("Camionetas")));

  // Un grupo antiguo tiene que poder conservarse sin que el plan lo declare cambio.
  const legado = planDeFicha({ ...SUV, grupo_vehiculo: "Camionetas" }, { ...fichaAForm({ ...SUV, grupo_vehiculo: "Camionetas" }) });
  chk("el grupo legado no se convierte en cambio al abrir el modal", !legado.guardable && !legado.actas.length);
  chk("los grupos habituales siguen siendo los cuatro de siempre",
    GRUPOS_VEHICULO.join(",") === "Ligeros,Vans,Buses,Otros");

  const choca = planDeFicha(SUV, form({ nombre: "Bus 50 pax Diésel" }), "", [
    { tipo_vehiculo: "BUS_50_D", nombre: "Bus 50 pax Diésel" },
    { tipo_vehiculo: "SUV_6_GLP", nombre: "SUV 6 pax GLP" },
  ]);
  chk("un nombre repetido AVISA y no bloquea", choca.guardable && choca.avisos.some(a => a.includes("BUS_50_D")));
  const mismo = planDeFicha(SUV, form({ nombre: "SUV 6 pax GLP Euro III" }), "", [
    { tipo_vehiculo: "SUV_6_GLP", nombre: "SUV 6 pax GLP" },
  ]);
  chk("un tipo no choca consigo mismo", mismo.guardable && mismo.avisos.length === 0);
}

console.log("\n── 5 · INVARIANTES POR BARRIDO ──────────────────────────────────────");
{
  const nombres = ["SUV 6 pax GLP", "  SUV 6 pax GLP  ", "", "   ", "Otro nombre", "SUV 6 pax GLP Euro III"];
  const caps = ["6", "7", "", "0", "-1", "6.5", "12"];
  const grupos = ["Ligeros", "Vans", "", "Camionetas"];
  const iconos = ["🚙", "", "🚌"];
  let malGuardable = 0, malActas = 0, malClave = 0, malPatchSinActa = 0, n = 0;
  for (const nombre of nombres) for (const capacidad of caps) for (const grupo_vehiculo of grupos) for (const icono of iconos) {
    const p = planDeFicha(SUV, { nombre, capacidad, grupo_vehiculo, icono });
    n++;
    const hayPatch = Object.keys(p.patch).length > 0;
    if (p.guardable !== (hayPatch && p.errores.length === 0)) malGuardable++;
    if (p.actas.length !== p.cambios.length || p.actas.length !== Object.keys(p.patch).length) malActas++;
    if ("tipo_vehiculo" in p.patch) malClave++;
    if (hayPatch && p.actas.length === 0) malPatchSinActa++;
  }
  chk(`guardable ≡ (hay patch && no hay errores) · ${n} combinaciones`, malGuardable === 0, `${malGuardable} desviaciones`);
  chk("hay exactamente un acta y un cambio por columna escrita", malActas === 0, `${malActas} desviaciones`);
  chk("NINGÚN plan escribe la clave `tipo_vehiculo`", malClave === 0, `${malClave} desviaciones`);
  chk("ninguna escritura queda sin acta", malPatchSinActa === 0);
  chk("`fichaAForm` sobre la ficha guardada no produce ningún cambio",
    !planDeFicha(SUV, fichaAForm(SUV)).guardable);
  chk("una ficha con ícono y grupo nulos se abre sin inventar valores", (() => {
    const p = planDeFicha({ ...SUV, icono: null, grupo_vehiculo: null }, fichaAForm({ ...SUV, icono: null, grupo_vehiculo: null }));
    // El grupo vacío es un error legítimo (hay que elegir uno), pero no escribe nada.
    return Object.keys(p.patch).length === 0 && !p.guardable;
  })());
}

console.log(`\n${fallos ? `❌ ${fallos} fallo(s)` : "✅ todo en verde"}\n`);
process.exit(fallos ? 1 : 0);
