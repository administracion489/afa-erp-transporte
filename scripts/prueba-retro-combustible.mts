// Pruebas del clasificador de la corrección retroactiva del tipo de combustible
// (lib/radar/retro-tipo-combustible.ts). NO tocan la base: datos en memoria.
// Uso:  npx tsx scripts/prueba-retro-combustible.mts   (sale con código 1 si algo falla)
//
// Esto decide si se le cambia el combustible a una carga YA registrada, así que lo que
// tiene que quedar fijado no es tanto lo que corrige como lo que **NO** toca. La flota de
// AFA es mayoritariamente de diésel: un clasificador demasiado suelto cambiaría de
// combustible cientos de cargas correctas, y el estropicio sería peor que el original.
// Por eso la mitad de los casos de abajo son cargas que deben salir intactas.
import { clasificarCarga, notaDeCorreccion, type CargaRetro } from "../lib/radar/retro-tipo-combustible";
import { referenciasDePrecio } from "../lib/combustibles";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// Referencias como las tendría AFA en /configuracion/costos.
const refs = referenciasDePrecio([
  { tipo: "Diésel", precio: 16.5 },
  { tipo: "Gasolina", precio: 18.0 },
  { tipo: "GLP", precio: 7.65 },
  { tipo: "GNV", precio: 1.78 },
  { tipo: "UREA", precio: 5.5 },
]);

const carga = (over: Partial<CargaRetro> = {}): CargaRetro => ({
  id: 1,
  tipo_combustible: "diesel",
  precio_galon: 16.4,
  galones: 20,
  unidad: "galones",
  fecha: "2026-08-31",
  placa: "CWQ-400",
  ligada_al_radar: true,
  radar_tipo_leido: null,
  ficha_tipo: "diesel",
  ...over,
});

// ── 1. El caso que motivó todo: GLP registrado como diésel ──────────────────
{
  const v = clasificarCarga(carga({ precio_galon: 7.55 }), refs);
  chk("una carga a S/ 7.55/gal con diésel por defecto se corrige a GLP",
      v.accion === "corregir" && v.tipo === "glp", `${v.accion} ${v.tipo ?? ""} · ${v.motivo}`);

  const gnv = clasificarCarga(carga({ precio_galon: 1.80 }), refs);
  chk("una carga a S/ 1.80 con diésel por defecto se corrige a GNV",
      gnv.accion === "corregir" && gnv.tipo === "gnv");

  // El GNV se despacha en m³: el tipo se corrige, pero la CANTIDAD no se reinterpreta.
  chk("al corregir a GNV se avisa que la unidad guardada ya no calza", !!gnv.nota, gnv.nota ?? "sin nota");

  const urea = clasificarCarga(carga({ precio_galon: 5.45 }), refs);
  chk("un AdBlue a S/ 5.45 registrado como diésel se corrige a urea",
      urea.accion === "corregir" && urea.tipo === "urea");
}

// ── 2. Lo que NO se toca (la mitad importante) ──────────────────────────────
{
  const ok = clasificarCarga(carga({ precio_galon: 16.4 }), refs);
  chk("un diésel a precio de diésel se deja como está", ok.accion === "dejar", ok.motivo);

  // Aunque el precio sea de GLP: si el voucher decía diésel, el dato está LEÍDO.
  const leido = clasificarCarga(carga({ precio_galon: 7.55, radar_tipo_leido: "PETROLEO D2" }), refs);
  chk("si el voucher decía el tipo, no se cuestiona aunque el precio extrañe",
      leido.accion === "dejar", leido.motivo);

  // Una carga tecleada en /combustible: el operador vio el selector y eligió.
  const manual = clasificarCarga(carga({ precio_galon: 7.55, ligada_al_radar: false }), refs);
  chk("una carga que no escribió el Radar no es asunto de esta corrección",
      manual.accion === "dejar", manual.motivo);

  // Un tipo distinto de diésel nunca vino del default.
  const glpYa = clasificarCarga(carga({ tipo_combustible: "glp", precio_galon: 7.55 }), refs);
  chk("una carga ya marcada como GLP se deja intacta", glpYa.accion === "dejar");

  // La gasolina está a 8 % del diésel: dentro de la banda, no se decide por precio.
  const gasolina = clasificarCarga(carga({ precio_galon: 17.9 }), refs);
  chk("un precio de gasolina NO convierte el diésel en gasolina (bandas solapadas)",
      gasolina.accion === "dejar", `${gasolina.accion} · ${gasolina.motivo}`);
}

// ── 3. Normalizar no es corregir: mismo combustible, otra grafía ────────────
{
  const v = clasificarCarga(carga({ tipo_combustible: "PETROLEO D2" }), refs);
  chk("\"PETROLEO D2\" se normaliza a diesel, sin cambiar de combustible",
      v.accion === "normalizar" && v.tipo === "diesel", `${v.accion} ${v.tipo ?? ""}`);

  const glp = clasificarCarga(carga({ tipo_combustible: "GLP-G", precio_galon: 7.55 }), refs);
  chk("\"GLP-G\" se normaliza a glp", glp.accion === "normalizar" && glp.tipo === "glp");

  const yaOk = clasificarCarga(carga({ tipo_combustible: "diesel" }), refs);
  chk("un valor ya canónico no se normaliza dos veces", yaOk.accion !== "normalizar");
}

// ── 4. Lo que necesita ojos humanos ─────────────────────────────────────────
{
  const raro = clasificarCarga(carga({ tipo_combustible: "SUPER XL" }), refs);
  chk("un texto que el catálogo no entiende va a revisión, no se adivina",
      raro.accion === "revisar", raro.motivo);

  const sinPrecio = clasificarCarga(carga({ precio_galon: null }), refs);
  chk("diésel por defecto y sin precio va a revisión", sinPrecio.accion === "revisar");

  const fuera = clasificarCarga(carga({ precio_galon: 22.35 }), refs);
  chk("un precio fuera de toda referencia va a revisión, no se le cambia el tipo",
      fuera.accion === "revisar", fuera.motivo);

  // El mismo caso, pero la ficha de la unidad dice otra cosa: el motivo lo menciona.
  const conFicha = clasificarCarga(carga({ precio_galon: 22.35, ficha_tipo: "glp" }), refs);
  chk("si la ficha de la unidad no es diésel, el motivo lo dice", /GLP/.test(conFicha.motivo), conFicha.motivo);

  const sinTipo = clasificarCarga(carga({ tipo_combustible: null, precio_galon: 7.55 }), refs);
  chk("una carga sin tipo con precio inequívoco se corrige", sinTipo.accion === "corregir" && sinTipo.tipo === "glp");

  const sinNada = clasificarCarga(carga({ tipo_combustible: null, precio_galon: 16.4 }), refs);
  chk("una carga sin tipo y con precio ambiguo va a revisión", sinNada.accion === "revisar");
}

// ── 5. La nota de auditoría deja el rastro completo ─────────────────────────
{
  const v = clasificarCarga(carga({ precio_galon: 7.55 }), refs);
  const nota = notaDeCorreccion(v, "diesel", "2026-09-04");
  chk("la nota nombra el antes, el después y el porqué",
      nota.includes("diesel → glp") && nota.includes("7.55") && nota.includes("retro-tipo 2026-09-04"), nota.trim());

  const sinAntes = notaDeCorreccion(v, null, "2026-09-04");
  chk("sin tipo anterior la nota lo dice en vez de dejar un hueco", sinAntes.includes("sin tipo → glp"));
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
