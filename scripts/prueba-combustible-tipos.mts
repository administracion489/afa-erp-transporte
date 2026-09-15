// Pruebas del CATÁLOGO DE TIPOS DE COMBUSTIBLE y de cómo se lee el tipo de un voucher.
// NO tocan la base: datos en memoria contra lib/combustible-tipos.ts.
// Uso:  npx tsx scripts/prueba-combustible-tipos.mts   (sale con código 1 si algo falla)
//
// El caso que motivó el normalizador: la nota de COESTI imprime
//
//     040002019 UGL   8.799x     24.640
//       MAX-D DIESEL B5 S50 UV        216.81
//
// donde `UGL` es la UNIDAD (galones) de una venta de DIÉSEL. El prompt del Radar afirmaba que
// "UGL" significaba GLP, lo que convertía en GLP cada voucher de diésel de ese grifo. De ahí la
// regla dura que estas pruebas fijan: **el tipo sale de la descripción del PRODUCTO, nunca del
// código de unidad.**
import {
  COMBUSTIBLES,
  TIPOS_COMBUSTIBLE,
  TIPOS_PARA_ELEGIR,
  configCombustible,
  familiaCombustible,
  normalizarTipoCombustible,
  tipoDeEtiquetaPrecio,
  filaPrecioReferencial,
  precioReferencialDe,
  factorAUnidadCanonica,
  revisarPrecioUnitario,
  unidadDeCarga,
  LITROS_POR_GALON,
} from "../lib/combustible-tipos";
import { resolverTipoCombustible, revisarTipoContraPrecio, tiposEnTexto } from "../lib/radar/tipo-voucher";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── 1. LA UNIDAD NO ES EL PRODUCTO ──────────────────────────────────────────
{
  chk("la línea real de COESTI es DIÉSEL, no GLP",
    normalizarTipoCombustible("040002019 UGL 8.799x 24.640 MAX-D DIESEL B5 S50 UV") === "diesel",
    String(normalizarTipoCombustible("040002019 UGL 8.799x 24.640 MAX-D DIESEL B5 S50 UV")));
  chk('"UGL" a secas no dice nada del producto', normalizarTipoCombustible("UGL") === null,
    String(normalizarTipoCombustible("UGL")));
  chk('"GLN" tampoco', normalizarTipoCombustible("GLN") === null);
  chk("pero GLP escrito como producto sí", normalizarTipoCombustible("GLP VEHICULAR") === "glp");
}

// ── 2. Los grados de gasolina salen del OCTANAJE ────────────────────────────
{
  chk("Gasohol 90 → regular", normalizarTipoCombustible("GASOHOL 90 PLUS") === "gasolina_regular");
  chk("G-84 → regular", normalizarTipoCombustible("G-84") === "gasolina_regular");
  chk("Gasohol 95 → premium", normalizarTipoCombustible("GASOHOL 95") === "gasolina_premium");
  chk("Primax 97 → premium", normalizarTipoCombustible("PRIMAX GASOLINA 97") === "gasolina_premium");
  chk("98 → premium", normalizarTipoCombustible("GASOHOL 98 PLUS") === "gasolina_premium");
}
{
  // Sin número, la palabra comercial decide; y sin ninguna de las dos, no se inventa el grado.
  chk("gasolina premium sin número", normalizarTipoCombustible("GASOLINA PREMIUM") === "gasolina_premium");
  chk("gasolina regular sin número", normalizarTipoCombustible("GASOLINA REGULAR") === "gasolina_regular");
  chk("gasolina sin grado cae al legado, no inventa octanaje",
    normalizarTipoCombustible("GASOLINA") === "gasolina", String(normalizarTipoCombustible("GASOLINA")));
}

// ── 3. El resto de productos ────────────────────────────────────────────────
{
  chk("urea/AdBlue", normalizarTipoCombustible("UREA AUTOMOTRIZ ADBLUE") === "urea");
  chk("GNV", normalizarTipoCombustible("GAS NATURAL VEHICULAR") === "gnv");
  chk("biodiésel", normalizarTipoCombustible("BIODIESEL B100") === "biodiesel");
  chk("diésel con tildes y minúsculas", normalizarTipoCombustible("Diésel B5 S-50") === "diesel");
  chk("un texto sin señal devuelve null", normalizarTipoCombustible("TURNO 3 CAJERO CABANA") === null);
  chk("vacío devuelve null", normalizarTipoCombustible("") === null && normalizarTipoCombustible(null) === null);
}
{
  // La urea aparece junto al diésel en la misma boleta: el aditivo manda porque es la línea
  // que se está clasificando (si no, "UREA ... DIESEL" saldría diésel y sumaría a otro tanque).
  chk("urea gana cuando aparece con el nombre del diésel",
    normalizarTipoCombustible("UREA PARA MAX-D DIESEL") === "urea");
}

// ── 4. El catálogo: familia, legado y respaldo ──────────────────────────────
{
  chk("los dos grados comparten familia gasolina",
    familiaCombustible("gasolina_premium") === "gasolina" && familiaCombustible("gasolina_regular") === "gasolina");
  chk("el legado también", familiaCombustible("gasolina") === "gasolina");
  chk("un tipo desconocido cae a diésel", configCombustible("marciano").familia === "diesel");
  chk("y null también", configCombustible(null).label === "Diésel");
  chk("el tipo se lee sin importar mayúsculas", configCombustible("GLP").label === "GLP");
}
{
  chk("el legado se sigue pintando", TIPOS_COMBUSTIBLE.includes("gasolina"));
  chk("pero no se ofrece al elegir", TIPOS_PARA_ELEGIR.includes("gasolina") === false);
  chk("los grados sí se ofrecen",
    TIPOS_PARA_ELEGIR.includes("gasolina_premium") && TIPOS_PARA_ELEGIR.includes("gasolina_regular"));
  chk("todos los que se ofrecen tienen etiqueta y color",
    TIPOS_PARA_ELEGIR.every((t) => COMBUSTIBLES[t].label && COMBUSTIBLES[t].labelCorto && COMBUSTIBLES[t].color));
}
{
  // Todo lo que el normalizador puede devolver tiene que existir en el catálogo, o la pantalla
  // pintaría un tipo que no sabe dibujar.
  const salidas = [
    "MAX-D DIESEL", "GLP", "GNV", "BIODIESEL", "UREA", "GASOHOL 90", "GASOHOL 95", "GASOLINA",
  ].map((s) => normalizarTipoCombustible(s));
  chk("todo lo que devuelve el normalizador está en el catálogo",
    salidas.every((s) => s != null && TIPOS_COMBUSTIBLE.includes(s)), salidas.join(","));
}

// ── 6. LA CONCLUSIÓN DE LA IA CONTRA EL PAPEL (lib/radar/tipo-voucher.ts) ───
//
// El caso real: nota V97T-00001413 de COESTI (07/09/2026, CWQ400) que imprime
//
//     040002072 UGL   9.417x      7.550
//       GLP-G                       71.10
//
// y entró al ERP como DIÉSEL. Los tres números cuadraban; lo que falló fue el `??` de
// acciones.ts, que dejaba la transcripción del producto como respaldo de la conclusión de la IA
// en vez de cotejarlas. El escenario se conserva como prueba de regresión.
{
  const real = resolverTipoCombustible({ declarado: "diesel", producto: "GLP-G" });
  chk("el caso CWQ400: el papel dice GLP-G y manda sobre el 'diesel' de la IA",
    real.tipo === "glp" && real.fuente === "producto", `${real.tipo}/${real.fuente}`);
  chk("…y lo dice con su código, no con un rojo genérico",
    real.anomalia?.codigo === "tipo_corregido_por_producto" && real.anomalia.bloquea === true,
    String(real.anomalia?.codigo));
  chk("…y deja escrito lo que la IA había leído, para no enseñarle un error que no cometió",
    real.anomalia?.correccion?.campo === "tipo_combustible" &&
      real.anomalia.correccion.leido === "diesel" && real.anomalia.correccion.corregido === "glp");
  chk("la línea entera del voucher también se resuelve",
    resolverTipoCombustible({ declarado: "diesel", producto: "040002072 UGL 9.417x 7.550 GLP-G" }).tipo === "glp");
}

// EL LADO QUE NO SE PUEDE AFLOJAR: corregir el GLP no puede deshacer el arreglo del "UGL",
// que es el bug espejo (cada voucher de diésel de ese grifo registrado como GLP).
{
  const dsl = resolverTipoCombustible({ declarado: "diesel", producto: "MAX-D DIESEL B5 S50 UV" });
  chk("el diésel de COESTI sigue pasando limpio", dsl.tipo === "diesel" && dsl.anomalia === null);
  const acuerdo = resolverTipoCombustible({ declarado: "glp", producto: "GLP-G" });
  chk("cuando los dos coinciden no se levanta nada", acuerdo.tipo === "glp" && acuerdo.anomalia === null);
  const sinProd = resolverTipoCombustible({ declarado: "diesel", producto: null });
  chk("sin producto transcrito manda lo que la IA concluyó",
    sinProd.tipo === "diesel" && sinProd.fuente === "declarado" && sinProd.anomalia === null);
  const soloProd = resolverTipoCombustible({ declarado: null, producto: "GASOHOL 95" });
  chk("sin conclusión, el producto la reemplaza (lo único que el `??` sí hacía bien)",
    soloProd.tipo === "gasolina_premium" && soloProd.anomalia === null);
  const nada = resolverTipoCombustible({ declarado: null, producto: null });
  chk("sin ninguno de los dos la columna sale vacía, nunca un diésel inventado",
    nada.tipo === null && nada.fuente === "sin_dato" && nada.anomalia === null);
}

// NADIE ADIVINA con dos productos en el papel: un comprobante con diésel + urea normaliza a
// `urea` por el orden del catálogo, y "corregir" ahí un diésel bien leído sería inventar.
{
  chk("el papel con dos líneas nombra los dos productos",
    tiposEnTexto("MAX-D DIESEL B5 S50 UV / UREA").join(",") === "diesel,urea",
    tiposEnTexto("MAX-D DIESEL B5 S50 UV / UREA").join(","));
  chk("un solo producto de varias palabras sigue siendo uno",
    tiposEnTexto("MAX-D DIESEL B5 S50 UV").join(",") === "diesel");
  const dos = resolverTipoCombustible({ declarado: "diesel", producto: "MAX-D DIESEL B5 S50 UV / UREA" });
  chk("con varios productos, el que la IA eligió se respeta: es la línea principal",
    dos.tipo === "diesel" && dos.anomalia === null, `${dos.tipo}/${dos.anomalia?.codigo}`);
  const fuera = resolverTipoCombustible({ declarado: "glp", producto: "MAX-D DIESEL B5 S50 UV / UREA" });
  chk("y si no es ninguno de ellos se NOMBRA sin reescribir nada",
    fuera.anomalia?.codigo === "tipo_no_coincide_con_producto" && fuera.tipo === "glp",
    `${fuera.tipo}/${fuera.anomalia?.codigo}`);
}

// ── 7. EL PRECIO AVISA, NUNCA DECIDE ────────────────────────────────────────
{
  const refs = [{ tipo: "diesel", precio: 24.64 }, { tipo: "glp", precio: 7.65 }];
  const v = revisarTipoContraPrecio({ tipo: "diesel", precio: 7.55, referenciales: refs });
  chk("un 'diésel' a S/ 7.55 con el GLP a S/ 7.65 se delata solo",
    v.anomalia?.codigo === "tipo_no_coincide_con_precio", String(v.anomalia?.codigo));
  chk("…y el tipo NO se reescribe desde el precio (un precio no es un producto)",
    v.anomalia?.correccion === undefined);
  chk("…y apaga el 'precio fuera de rango', que ahí sería el síntoma", v.precioExplicado === true);
  chk("el mensaje no afirma 'se guardó como diésel' cuando la columna quedó vacía",
    revisarTipoContraPrecio({ tipo: "diesel", precio: 7.55, referenciales: refs, leido: false })
      .anomalia!.detalle.includes("por defecto"));

  chk("con el tipo correcto no dice nada",
    revisarTipoContraPrecio({ tipo: "glp", precio: 7.55, referenciales: refs }).anomalia === null);
  chk("sin referencial no se juzga",
    revisarTipoContraPrecio({ tipo: "diesel", precio: 7.55, referenciales: [] }).anomalia === null);
  // Lo que NO se puede aflojar: una carga simplemente cara sigue siendo "precio fuera de rango".
  const cara = revisarTipoContraPrecio({ tipo: "diesel", precio: 31.5, referenciales: refs });
  chk("un diésel caro no se convierte en 'otro combustible': ningún candidato lo explica",
    cara.anomalia === null && cara.precioExplicado === false);
  // Dos candidatas empatadas = adivinar. Mismo criterio que `cuadre_ambiguo`.
  const ambiguo = revisarTipoContraPrecio({
    tipo: "diesel", precio: 7.55,
    referenciales: [{ tipo: "diesel", precio: 24.64 }, { tipo: "glp", precio: 7.65 }, { tipo: "gnv", precio: 7.5 }],
  });
  chk("con dos combustibles que lo explicarían no se propone ninguno", ambiguo.anomalia === null);

  // EL CICLO: lo que la regla del papel corrige tiene que quedar en paz con la del precio, o la
  // fila saldría con dos rojos que se contradicen sobre el mismo número.
  const corregido = resolverTipoCombustible({ declarado: "diesel", producto: "GLP-G" });
  chk("corregido por el papel, el precio ya no protesta",
    revisarTipoContraPrecio({ tipo: corregido.tipo!, precio: 7.55, referenciales: refs }).anomalia === null);
}


// ── 6. EL PUENTE CON `precios_combustible` ──────────────────────────────────
//
// El bug que llevaba meses vivo: la tabla guarda `Diésel` CON TILDE y los dos consumidores
// comparaban con `.toLowerCase()`. `"diésel" !== "diesel"`, así que el referencial del diésel
// resolvía 0 y el control de precio ±20 % **nunca se aplicó a una carga de diésel**.
{
  // Tal como está cargada la tabla hoy.
  const filas = [
    { tipo: "Diésel", precio: 25.74 },
    { tipo: "Gasolina", precio: 17.9 },
    { tipo: "GLP", precio: 7.55 },
    { tipo: "GNV", precio: 1.78 },
    { tipo: "UREA", precio: 5.5 },
  ];

  chk("la etiqueta con tilde deriva a su código del catálogo",
    tipoDeEtiquetaPrecio("Diésel") === "diesel", String(tipoDeEtiquetaPrecio("Diésel")));
  chk("y `Biodiésel` también", tipoDeEtiquetaPrecio("Biodiésel") === "biodiesel");
  chk("EL BUG: el diésel ya encuentra su referencial",
    precioReferencialDe(filas, "diesel") === 25.74, String(precioReferencialDe(filas, "diesel")));
  chk("…y con `.toLowerCase()` a secas no lo encontraba (el algoritmo viejo)",
    filas.map((f) => f.tipo.toLowerCase()).find((t) => t === "diesel") === undefined);

  // Lo que el `MAPA_TIPO` escrito a mano se había dejado fuera: la gasolina por octanaje.
  chk("gasolina_premium cae a la fila de su FAMILIA",
    precioReferencialDe(filas, "gasolina_premium") === 17.9);
  const pr = filaPrecioReferencial(filas, "gasolina_premium");
  chk("…y declara que no fue coincidencia exacta", pr !== null && pr.exacto === false);
  chk("con fila propia por grado, gana la exacta",
    precioReferencialDe([...filas, { tipo: "Gasolina premium", precio: 19.2 }], "gasolina_premium") === 19.2);
  chk("el legado `gasolina` sigue casando", precioReferencialDe(filas, "gasolina") === 17.9);
  chk("un tipo sin fila devuelve 0, como antes", precioReferencialDe(filas, "biodiesel") === 0);
  chk("sin filas no se inventa nada", precioReferencialDe([], "diesel") === 0 && filaPrecioReferencial([], "diesel") === null);

  // Lo que NO se puede aflojar: los cuatro que YA funcionaban siguen igual.
  for (const [tipo, esperado] of [["glp", 7.55], ["gnv", 1.78], ["urea", 5.5]] as const) {
    chk(`${tipo} sigue resolviendo lo mismo que antes`, precioReferencialDe(filas, tipo) === esperado);
  }
}

// ── 7. ¿ESTE NÚMERO PUEDE SER UN PRECIO DE ESTA UNIDAD? ─────────────────────
{
  const det = (t: string, precio: number, unidad?: string) =>
    revisarPrecioUnitario({ tipo: t, precio, unidad });

  // Los precios REALES de la flota no pueden levantar nada: un ámbar que sale siempre se
  // vuelve paisaje, y esta banda existe justo para no ser eso.
  for (const [t, p] of [["diesel", 24.7], ["diesel", 26.15], ["glp", 6.99], ["glp", 7.55],
                        ["gnv", 1.78], ["gasolina_regular", 17.9], ["urea", 5.5]] as const) {
    chk(`${t} a S/ ${p} es un precio normal`, det(t, p).estado === "ok", det(t, p).estado);
  }

  // EL CASO QUE JUSTIFICA LA BANDA: el mismo precio en la otra unidad.
  const litro = det("diesel", 26.15 / LITROS_POR_GALON);
  chk("un diésel a precio POR LITRO rotulado en galones se detecta",
    litro.estado === "parece_otra_unidad", litro.estado);
  chk("…y NOMBRA la unidad que encaja",
    litro.estado === "parece_otra_unidad" && litro.unidadProbable === "litros");
  const glpLitro = det("glp", 7.55 / LITROS_POR_GALON);
  chk("lo mismo con el GLP capturado en litros (el caso del Paso 3)",
    glpLitro.estado === "parece_otra_unidad");
  // Y al revés: un precio por galón en una fila que dice litros.
  const alReves = det("diesel", 26.15, "litros");
  chk("y el caso espejo: precio por galón con la fila en litros",
    alReves.estado === "parece_otra_unidad" && alReves.unidadProbable === "galones");

  // Órdenes de magnitud: aquí no hay otra unidad que lo explique, y se dice así.
  const gnvCaro = det("gnv", 25);
  chk("un precio de galón en una fila de GNV no cabe en ninguna banda",
    gnvCaro.estado === "fuera_de_banda", gnvCaro.estado);
  chk("…y el m³ NUNCA propone otra unidad (es otra magnitud, no una conversión)",
    gnvCaro.estado === "fuera_de_banda");

  // Tri-estado: sin precio no se afirma nada.
  chk("sin precio no se juzga", det("diesel", 0).estado === "sin_base");
  chk("una unidad que no se sabe convertir tampoco",
    det("diesel", 26, "m3").estado === "sin_base");

  // La conversión, que es de donde sale todo lo anterior.
  chk("litros → galones multiplica por 3.785",
    factorAUnidadCanonica("litros", "diesel") === LITROS_POR_GALON);
  chk("sin unidad declarada se asume la canónica", factorAUnidadCanonica(null, "diesel") === 1);
  chk("m³ no se convierte a galones", factorAUnidadCanonica("galones", "gnv") === null);
}

// ── 8. LA UNIDAD SE DERIVA DEL PRODUCTO ─────────────────────────────────────
//
// `registrarCombustible` del Radar escribía `esLitros ? "litros" : "galones"` para TODO, así que
// cada carga de GNV —el 70 % de la flota— quedaba rotulada en GALONES con un número que son m³.
{
  chk("EL BUG: una carga de GNV se guarda en m³, no en galones",
    unidadDeCarga("gnv", "galones") === "m3", unidadDeCarga("gnv", "galones"));
  chk("…y ni siquiera un 'litros' explícito la mueve (un gas no se vende por litro)",
    unidadDeCarga("gnv", "litros") === "m3");

  // Lo que NO se puede aflojar: las familias galoneras se comportan exactamente igual que antes.
  for (const t of ["diesel", "glp", "gasolina_regular", "gasolina_premium", "gasolina", "biodiesel"]) {
    chk(`${t} sin declarar sigue en galones`, unidadDeCarga(t, "galones") === "galones");
    chk(`${t} declarado en litros sigue en litros`, unidadDeCarga(t, "litros") === "litros");
  }
  chk("la urea declarada en litros queda en litros", unidadDeCarga("urea", "litros") === "litros");
  chk("y la abreviatura de pantalla también se entiende", unidadDeCarga("diesel", "lt") === "litros");
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
