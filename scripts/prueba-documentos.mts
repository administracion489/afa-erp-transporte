// scripts/prueba-documentos.mts — el catálogo de documentos vehiculares y su motor.
//
// Cubre las dos cosas que se arreglaron el mismo día y que se rompen igual:
//
//   1. LA TARJETA DE PROPIEDAD (TIVE) NO CADUCA. La emite SUNARP y no trae fecha de
//      vencimiento, así que el ERP la sacaba como "Sin fecha" y la contaba como motivo de
//      REVISAR: un ámbar permanente por un dato que no existe y que nadie podía completar.
//      Lo que se fija aquí es que "cargado ⇒ conforme", CON fecha o sin ella, y que la
//      excepción NO se contagia a ningún otro documento.
//
//   2. RENOMBRAR UN DOCUMENTO NO PUEDE APAGAR SU CONTROL. "Habilitación SUTRAN" pasó a
//      "Tarjeta Única de Circulación (TUC)" y "Permiso Operación MTC" a "Habilitación
//      Vehicular (MTC/ATU)", pero en la base el tipo es TEXTO TECLEADO y hay filas escritas
//      con el nombre viejo. Si la lectura no deriva la clave por el mismo camino que la
//      escritura, esa fila cae a "Otro", pierde su marca de obligatoria y su SOAT vencido
//      deja de bloquear — en silencio. Es el patrón que CLAUDE.md llama "escribir con una
//      identidad y leer con otra", el que ya costó tres fallos en producción.
//
// Se prueba el CICLO (nombre viejo → veredicto correcto), no una mitad.
//
// Correr:  npx tsx scripts/prueba-documentos.mts
import {
  evaluarAptitud, docSinVencimiento, etiquetaTipoDoc, tipoCanonico, tiposObligatorios,
  ambitoTipoDoc, normalizarTipoDoc, TIPOS_DOC_UNIDAD, type DocFila, type AptitudServicio,
} from "../lib/documentos-estado";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

const FECHA = "2026-09-15";   // fecha del servicio, fija: el motor no debe mirar el reloj
const HOY   = "2026-09-05";

/** Documentos de una unidad tercerizada, todos vigentes salvo lo que se pise. */
const docsBase = (): DocFila[] => [
  { tipo: "SOAT", fecha_vencimiento: "2027-04-21" },
  { tipo: "Revisión Técnica (CITV)", fecha_vencimiento: "2026-11-18" },
  { tipo: "Tarjeta Única de Circulación (TUC)", fecha_vencimiento: "2034-02-20" },
  { tipo: "Habilitación Vehicular (MTC/ATU)", fecha_vencimiento: "2030-01-01" },
  { tipo: "SCTR Salud", fecha_vencimiento: "2027-01-01" },
  { tipo: "SCTR Pensión", fecha_vencimiento: "2027-01-01" },
  { tipo: "Vida Ley", fecha_vencimiento: "2027-01-01" },
];

function evaluar(docs: DocFila[]): AptitudServicio {
  return evaluarAptitud({
    fechaServicio: FECHA, hoy: HOY,
    unidad: { id: 7, placa: "BUI-272", tercerizada: true },
    docsUnidad: docs,
    conductor: { nombre: "Luis Q.", tercerizado: true, vencimiento_licencia: "2028-01-01" },
    empresa: { id: 3, razon_social: "GLOBAL BUS PERU", estado: "activo",
               venc_autorizacion: "2030-01-01", venc_habilitacion: "2030-01-01" },
  });
}

const hallazgosDe = (a: AptitudServicio) => [...a.bloqueantes, ...a.avisos];
const sobre = (a: AptitudServicio, tipo: string) => hallazgosDe(a).filter(h => h.tipo === tipo);

// ═══════════════════════════════════════════════════════════════════════════════
titulo("1 · El catálogo declara qué documento no caduca");

ok(docSinVencimiento("Tarjeta de Propiedad"), "la Tarjeta de Propiedad no caduca");
ok(docSinVencimiento("tarjeta de propiedad"), "…en minúsculas también");
ok(docSinVencimiento("TARJETA DE PROPIEDAD"), "…en mayúsculas también");
ok(docSinVencimiento("Tarjeta Propiedad"), "…sin la preposición");
ok(docSinVencimiento("TIVE"), "…por su nombre nuevo (TIVE)");
ok(docSinVencimiento("Tarjeta de Identificación Vehicular"), "…por el nombre impreso en la ficha");

// La excepción NO se contagia: todo lo demás sigue teniendo que traer su fecha.
for (const t of ["SOAT", "Revisión Técnica (CITV)", "Tarjeta Única de Circulación (TUC)",
                 "Habilitación Vehicular (MTC/ATU)", "Tarjeta de Circulación",
                 "SCTR Salud", "SCTR Pensión", "CAT", "Seguro Todo Riesgo"]) {
  ok(!docSinVencimiento(t), `${t} SÍ caduca`);
}
ok(!docSinVencimiento(""), "un tipo vacío no se da por permanente");
ok(!docSinVencimiento("Cualquier cosa"), "un tipo desconocido no se da por permanente");
// "Tarjeta" a secas es ambiguo entre propiedad y circulación: adivinar sería peor que callar.
ok(!docSinVencimiento("Tarjeta"), "«Tarjeta» a secas no resuelve (ambiguo, no se adivina)");

// Solo UN tipo del catálogo puede no caducar hoy. Si alguien marca otro sin pensarlo, que
// esta prueba se lo diga: es una excepción legal, no una comodidad de UI.
const permanentes = TIPOS_DOC_UNIDAD.filter(t => t.sinVencimiento).map(t => t.canonico);
ok(permanentes.length === 1 && permanentes[0] === "Tarjeta de Propiedad",
   "solo la Tarjeta de Propiedad está marcada como permanente", permanentes.join(", ") || "ninguna");

// ═══════════════════════════════════════════════════════════════════════════════
titulo("2 · Cargada y sin fecha = CONFORME, no «sin cargar»");

{
  const docs = [...docsBase(), { tipo: "Tarjeta de Propiedad", fecha_vencimiento: null }];
  const a = evaluar(docs);
  ok(a.apto, "la unidad sale APTA");
  ok(sobre(a, "Tarjeta de Propiedad").length === 0,
     "la Tarjeta de Propiedad no genera NINGÚN hallazgo", JSON.stringify(sobre(a, "Tarjeta de Propiedad")));
  ok(a.avisos.length === 0, "no queda ni un aviso", a.avisos.map(h => h.texto).join(" · "));
  // 11 = 8 exigencias del proveedor (SOAT/CAT cuentan como una) + 2 de la empresa
  // (Autorización MTC y Habilitación SUTRAN, que son suyas y sí vencen) + la licencia.
  // Se fija el número entero y no solo "la TIVE suma": si mañana desaparece una exigencia
  // sin que nadie lo pida, este renglón lo dice.
  ok(a.conformes === 11, "cuenta como conforme (11 exigencias verificadas)", a.conformes);
  ok(!/sin cargar|sin fecha/i.test(a.resumen), "el resumen no habla de datos que faltan", a.resumen);
}

{
  // Y con una fecha vieja tecleada por error: tampoco vence. No se puede vencer lo que no
  // caduca, y un rojo imposible de arreglar enseña a ignorar los rojos de verdad.
  const docs = [...docsBase(), { tipo: "Tarjeta de Propiedad", fecha_vencimiento: "2019-01-01" }];
  const a = evaluar(docs);
  ok(a.apto, "con una fecha vieja tecleada por error, la unidad sigue APTA");
  ok(sobre(a, "Tarjeta de Propiedad").length === 0, "y sigue sin generar hallazgo");
}

{
  // Que no caduque NO la hace opcional: si no está cargada, sigue faltando.
  const a = evaluar(docsBase());
  ok(a.apto, "sin la Tarjeta de Propiedad la unidad NO se bloquea (decisión del dueño)");
  const h = sobre(a, "Tarjeta de Propiedad");
  ok(h.length === 1 && h[0].veredicto === "sin_registro",
     "…pero se avisa que falta cargarla", h.map(x => x.veredicto).join());
  ok(h[0]?.texto.includes("sin cargar"), "el texto dice «sin cargar»", h[0]?.texto);
}

// ═══════════════════════════════════════════════════════════════════════════════
titulo("3 · La excepción no se filtra al resto");

{
  const docs = docsBase().map(d => d.tipo === "SOAT" ? { ...d, fecha_vencimiento: null } : d);
  const a = evaluar([...docs, { tipo: "Tarjeta de Propiedad", fecha_vencimiento: null }]);
  const h = sobre(a, "SOAT");
  ok(h.length === 1 && h[0].veredicto === "sin_registro",
     "un SOAT sin fecha sigue siendo «sin registro»", h.map(x => x.veredicto).join());
}

{
  const docs = docsBase().map(d => d.tipo === "SOAT" ? { ...d, fecha_vencimiento: "2026-08-01" } : d);
  const a = evaluar([...docs, { tipo: "Tarjeta de Propiedad", fecha_vencimiento: null }]);
  ok(!a.apto, "un SOAT vencido sigue bloqueando");
  ok(a.bloqueantes.some(h => h.tipo === "SOAT"), "y el bloqueo lo firma el SOAT",
     a.bloqueantes.map(h => h.tipo).join());
}

// ═══════════════════════════════════════════════════════════════════════════════
titulo("4 · Los nombres nuevos, y los viejos que siguen en la base");

ok(etiquetaTipoDoc("Habilitación SUTRAN") === "Tarjeta Única de Circulación (TUC)",
   "«Habilitación SUTRAN» se lee como TUC", etiquetaTipoDoc("Habilitación SUTRAN"));
ok(etiquetaTipoDoc("habilitacion sutran") === "Tarjeta Única de Circulación (TUC)",
   "…sin tildes también", etiquetaTipoDoc("habilitacion sutran"));
ok(etiquetaTipoDoc("SUTRAN") === "Tarjeta Única de Circulación (TUC)", "…abreviado también");
ok(etiquetaTipoDoc("TUC") === "Tarjeta Única de Circulación (TUC)", "…y por su sigla");

ok(etiquetaTipoDoc("Permiso Operación MTC") === "Habilitación Vehicular (MTC/ATU)",
   "«Permiso Operación MTC» se lee como Habilitación Vehicular", etiquetaTipoDoc("Permiso Operación MTC"));
ok(etiquetaTipoDoc("permiso operacion mtc") === "Habilitación Vehicular (MTC/ATU)", "…sin tildes también");
ok(etiquetaTipoDoc("Permiso MTC") === "Habilitación Vehicular (MTC/ATU)", "…abreviado también");

// La Tarjeta de Circulación municipal NO es la TUC: son dos exigencias distintas y el
// normalizador no puede fundirlas.
ok(etiquetaTipoDoc("Tarjeta de Circulación") === "Tarjeta de Circulación",
   "la Tarjeta de Circulación municipal se queda como está", etiquetaTipoDoc("Tarjeta de Circulación"));
ok(tipoCanonico("Tarjeta de Circulación") !== tipoCanonico("Tarjeta Única de Circulación (TUC)"),
   "…y no colapsa con la TUC");

// Un tipo desconocido se devuelve tal cual: inventarle un nombre sería peor.
ok(etiquetaTipoDoc("Constancia rara") === "Constancia rara", "un tipo sin catalogar se muestra tal cual");
ok(etiquetaTipoDoc(null) === "", "null no revienta");

// ── EL CICLO: una fila escrita con el nombre VIEJO tiene que seguir controlándose ────────
{
  const docs = docsBase()
    .filter(d => d.tipo !== "Tarjeta Única de Circulación (TUC)")
    .concat([{ tipo: "Habilitación SUTRAN", fecha_vencimiento: "2034-02-20" },
             { tipo: "Tarjeta de Propiedad", fecha_vencimiento: null }]);
  const a = evaluar(docs);
  ok(a.apto && a.avisos.length === 0,
     "la fila vieja «Habilitación SUTRAN» cubre la exigencia de la TUC",
     a.avisos.map(h => h.texto).join(" · "));
}

{
  const docs = docsBase()
    .filter(d => d.tipo !== "Tarjeta Única de Circulación (TUC)")
    .concat([{ tipo: "Habilitación SUTRAN", fecha_vencimiento: "2026-08-01" },
             { tipo: "Tarjeta de Propiedad", fecha_vencimiento: null }]);
  const a = evaluar(docs);
  ok(!a.apto, "…y si esa fila vieja está VENCIDA, sigue bloqueando");
  ok(a.bloqueantes[0]?.tipo === "Tarjeta Única de Circulación (TUC)",
     "…reportada con el nombre de hoy", a.bloqueantes[0]?.tipo);
}

{
  const docs = docsBase()
    .filter(d => d.tipo !== "Habilitación Vehicular (MTC/ATU)")
    .concat([{ tipo: "Permiso Operación MTC", fecha_vencimiento: "2026-08-01" },
             { tipo: "Tarjeta de Propiedad", fecha_vencimiento: null }]);
  const a = evaluar(docs);
  ok(!a.apto && a.bloqueantes[0]?.tipo === "Habilitación Vehicular (MTC/ATU)",
     "lo mismo con el «Permiso Operación MTC» vencido", a.bloqueantes[0]?.tipo);
}

// ═══════════════════════════════════════════════════════════════════════════════
titulo("5 · La lista de obligatorios que consume el cron de proveedores");

{
  const oblig = tiposObligatorios(true).map(t => t.canonico);
  const esperados = ["SOAT", "Revisión Técnica (CITV)", "Tarjeta de Propiedad",
                     "Tarjeta Única de Circulación (TUC)", "Habilitación Vehicular (MTC/ATU)",
                     "SCTR Salud", "SCTR Pensión", "Vida Ley"];
  ok(oblig.length === esperados.length, `son ${esperados.length} para un tercero`, oblig.length);
  for (const e of esperados) ok(oblig.includes(e), `incluye ${e}`);
  ok(!oblig.includes("CAT"), "el CAT no se le exige a un tercero");
  ok(!oblig.includes("Tarjeta de Circulación"), "la Tarjeta de Circulación municipal tampoco");
}

// ═══════════════════════════════════════════════════════════════════════════════
titulo("5b · A UNA PLACA no se le reclama el SCTR de nadie");

// El SCTR y la Vida Ley viven en `documentos_tercero` solo porque `conductores_tercero` no
// tiene columnas para ellos. Eso no los vuelve documentos del bus: filtrando por BUI-272, el
// ERP le exigía "SCTR Salud" y "SCTR Pensión" como obligatorios sin registrar DE ESA PLACA,
// y no hay forma de cumplirlo — la póliza es de las personas.
for (const t of ["SCTR Salud", "SCTR Pensión", "Vida Ley", "sctr pension", "seguro de vida ley"]) {
  ok(ambitoTipoDoc(t) === "personal", `${t} es del PERSONAL`, ambitoTipoDoc(t));
}
for (const t of ["SOAT", "Revisión Técnica (CITV)", "Tarjeta de Propiedad",
                 "Tarjeta Única de Circulación (TUC)", "Habilitación Vehicular (MTC/ATU)",
                 "Habilitación SUTRAN", "Tarjeta de Circulación", "CAT"]) {
  ok(ambitoTipoDoc(t) === "unidad", `${t} es de la UNIDAD`, ambitoTipoDoc(t));
}
ok(ambitoTipoDoc("Constancia rara") === "unidad", "lo no catalogado se trata como de la unidad");

{
  const soloUnidad = tiposObligatorios(true, "unidad").map(t => t.canonico);
  ok(soloUnidad.length === 5, "a una placa se le exigen 5 documentos", soloUnidad.join(", "));
  ok(!soloUnidad.some(t => ["SCTR Salud", "SCTR Pensión", "Vida Ley"].includes(t)),
     "…y ninguno es un seguro del trabajador");

  const soloPersonal = tiposObligatorios(true, "personal").map(t => t.canonico);
  ok(soloPersonal.length === 3 && soloPersonal.includes("Vida Ley"),
     "los del personal son SCTR Salud, SCTR Pensión y Vida Ley", soloPersonal.join(", "));

  ok(soloUnidad.length + soloPersonal.length === tiposObligatorios(true).length,
     "los dos ámbitos suman el total, sin solapes ni huecos");
}

{
  // El motor tampoco puede rotular un seguro del personal con la placa.
  const a = evaluar(docsBase().filter(d => !d.tipo.startsWith("SCTR") && d.tipo !== "Vida Ley"));
  const sctr = hallazgosDe(a).filter(h => h.tipo.startsWith("SCTR") || h.tipo === "Vida Ley");
  ok(sctr.length === 3, "faltando los tres seguros del personal, se reportan los tres", sctr.length);
  ok(sctr.every(h => h.sujeto === "empresa"), "…a nombre de la EMPRESA, no de la placa",
     sctr.map(h => `${h.tipo}:${h.sujeto}`).join(" "));
  ok(sctr.every(h => !h.texto.includes("BUI-272")), "…y el texto no nombra la unidad",
     sctr.map(h => h.texto).join(" · "));
}

// ═══════════════════════════════════════════════════════════════════════════════
titulo("6 · El normalizador SQL y el de TS tienen que coincidir");

// Espejo de fn_norm_tipo_doc en supabase/documentos-tive-y-nombres.sql. Si divergen, la
// migración renombra un juego de filas y la app reconoce otro.
const normSQL = (t: string) =>
  t.toLowerCase()
   .replace(/[áéíóúüñ]/g, c => ({ "á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ü": "u", "ñ": "n" }[c]!))
   .replace(/[^a-z0-9]+/g, " ")
   .trim();

for (const t of ["Habilitación SUTRAN", "Permiso Operación MTC", "Tarjeta de Propiedad",
                 "Revisión Técnica (CITV)", "Tarjeta Única de Circulación (TUC)",
                 "Habilitación Vehicular (MTC/ATU)", "SCTR Pensión"]) {
  ok(normalizarTipoDoc(t) === normSQL(t), `normalizan igual: "${t}"`,
     `${normalizarTipoDoc(t)} | ${normSQL(t)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? "✅ TODO OK" : `❌ ${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
