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
} from "../lib/combustible-tipos";

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

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
