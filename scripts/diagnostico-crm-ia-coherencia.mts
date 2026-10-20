// npx tsx scripts/diagnostico-crm-ia-coherencia.mts <config.json> [--empresa="Nombre del perfil"] [--traslados=si|no]
//
// Audita la configuración de un agente IA del CRM con el MISMO motor que /crm/agente
// (lib/crm-ia-coherencia.ts) e imprime los choques agrupados: primero las alarmas (ámbar), después
// las frases que solo repiten un ajuste (gris). NO toca la base: lee un archivo.
//
// El JSON es la fila de crm_agentes_ia (o un subconjunto):
//   { "persona", "empresa_contexto", "conocimiento", "goals": [{ "titulo", "instrucciones" }],
//     "mensaje_derivacion", "escalar_si", "nombre", "pausa_humano_horas", "comportamiento": { … } }
// Para sacarla de Supabase (SQL Editor), y pegar el resultado en un archivo:
//   select to_jsonb(a) - 'id' from public.crm_agentes_ia a limit 1;
// --empresa es el nombre del perfil de la empresa (lo que reemplaza {empresa} en «Cómo se presenta»).
// --traslados=si audita también contra el cotizador de traslados (sin la bandera no se afirma nada).
import { readFileSync } from "node:fs";
import { auditarAgente, TEMAS_COHERENCIA, type ConfigAuditable, type Hallazgo } from "../lib/crm-ia-coherencia";

const args = process.argv.slice(2);
const ruta = args.find((a) => !a.startsWith("--"));
const opcion = (nombre: string) => args.find((a) => a.startsWith(`--${nombre}=`))?.slice(nombre.length + 3);
if (!ruta) {
  console.error("Uso: npx tsx scripts/diagnostico-crm-ia-coherencia.mts <config.json> [--empresa=\"…\"] [--traslados=si|no]");
  process.exit(2);
}

let cfg: ConfigAuditable;
try {
  const crudo = JSON.parse(readFileSync(ruta, "utf8"));
  // Acepta la fila suelta, un array con una fila (lo que devuelve el SQL Editor) o { to_jsonb: fila }.
  const fila = Array.isArray(crudo) ? crudo[0] : crudo;
  cfg = (fila && typeof fila === "object" && "?column?" in fila ? fila["?column?"] : fila?.to_jsonb ?? fila) as ConfigAuditable;
  if (typeof cfg?.comportamiento === "string") cfg = { ...cfg, comportamiento: JSON.parse(cfg.comportamiento as string) };
  if (typeof cfg?.goals === "string") cfg = { ...cfg, goals: JSON.parse(cfg.goals as string) };
} catch (e) {
  console.error(`No se pudo leer ${ruta}: ${(e as Error).message}`);
  process.exit(2);
}

const t = opcion("traslados");
const traslados = t == null ? null : /^(si|sí|true|1)$/i.test(t);
const r = auditarAgente(cfg, { trasladosActivos: traslados, empresa: opcion("empresa") ?? "" });

const linea = "─".repeat(90);
const imprimir = (h: Hallazgo) => {
  console.log(`\n  [${h.codigo}] ${h.titulo}`);
  console.log(`    ${h.etiquetaCampo}: «${h.cita}»`);
  if (h.otra) console.log(`    ${h.otra.etiquetaCampo}: «${h.otra.cita}»`);
  if (h.ajuste) console.log(`    Manda: ${h.ajuste.etiqueta} = ${h.ajuste.valorLegible}`);
  if (h.propuesta) console.log(`    Propuesta: poner el ajuste en «${h.propuesta.etiqueta}»`);
  console.log(`    Arreglo: ${h.arreglo}`);
};
const porGrupo = (hs: Hallazgo[]) => {
  for (const tema of TEMAS_COHERENCIA) {
    const del = hs.filter((h) => h.tema === tema);
    if (!del.length) continue;
    console.log(`\n▸ ${tema} (${del.length})`);
    del.forEach(imprimir);
  }
};

console.log(`Agente: ${cfg.nombre ?? "(sin nombre)"} · empresa: ${opcion("empresa") ?? "(sin perfil: «la empresa»)"} · traslados: ${traslados == null ? "no se sabe (no se audita)" : traslados ? "encendidos" : "apagados"}`);
console.log(`${r.alarmas} choque(s) en ámbar · ${r.grises} frase(s) que repiten un ajuste`);
const alarmas = r.hallazgos.filter((h) => h.alarma);
const grises = r.hallazgos.filter((h) => !h.alarma);
if (alarmas.length) {
  console.log(`\n${linea}\n⚠ ÁMBAR · la IA sigue el ajuste, pero el texto dice otra cosa (o pide algo imposible)\n${linea}`);
  porGrupo(alarmas);
}
if (grises.length) {
  console.log(`\n${linea}\n· GRIS · no hace falta cambiarlas; si cambias el ajuste, quedarán contradiciéndolo\n${linea}`);
  porGrupo(grises);
}
if (!r.hallazgos.length) console.log("\nSin choques: cada comportamiento está en un solo sitio.");
console.log(`\nAlarmas por campo: ${Object.entries(r.porCampo).map(([k, v]) => `${k} ${v}`).join(" · ") || "ninguna"}`);
