// scripts/prueba-licitaciones-modulo.mts — El módulo «licitaciones» está registrado en el ERP.
//   npx tsx scripts/prueba-licitaciones-modulo.mts
//
// Fija lo que ya costó una ruta sin control: una pantalla que no está en `menuGrupos` pasa el gate
// del layout SIN mirar el permiso (el gate busca el primer ítem cuyo href es prefijo de la ruta).
// Por eso «licitaciones» tiene que estar en las TRES listas (menuGrupos de app/layout.tsx, MODULOS
// de app/api/crear-usuario/route.ts, GRUPOS_MODULOS + nombresModulo de app/usuarios/page.tsx), el
// editor /licitaciones/7 tiene que caer bajo ese ítem por prefijo, y el botón «?» tiene su ficha
// (ayudaDeRuta) con conceptos que existen en el glosario.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// Sin extensión, como prueba-seguros.mts: con «.ts» tsc da TS5097 (no hay allowImportingTsExtensions).
import { ayudaDeRuta, conceptosDe, GLOSARIO } from "../lib/ayuda/index";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const leer = (ruta: string) => readFileSync(join(RAIZ, ruta), "utf8");
const MODULO = "licitaciones";

/** El texto entre `inicio` y el primer `fin` que le sigue (para no confundir una lista con otra). */
function tramo(texto: string, inicio: RegExp, fin: string): string | null {
  const m = inicio.exec(texto);
  if (!m) return null;
  const desde = m.index + m[0].length;
  const hasta = texto.indexOf(fin, desde);
  return hasta < 0 ? null : texto.slice(desde, hasta);
}

// ══ 1. menuGrupos (app/layout.tsx) ════════════════════════════════════════════
sec("1. menuGrupos de app/layout.tsx");
const layout = leer("app/layout.tsx");
const menu = tramo(layout, /const menuGrupos[^=]*=\s*\[/, "\n];");
check(menu !== null, "se encuentra el arreglo menuGrupos");
const items = [...(menu ?? "").matchAll(/\{\s*href:\s*"([^"]+)"[^}]*?modulo:\s*"([^"]+)"[^}]*\}/g)]
  .map((m) => ({ href: m[1], modulo: m[2], linea: m[0] }));
check(items.length > 20, `menuGrupos tiene ítems legibles (${items.length})`);
const itemLic = items.find((i) => i.href === "/licitaciones");
check(!!itemLic, "hay un ítem con href /licitaciones");
check(itemLic?.modulo === MODULO, `su modulo es "${MODULO}" (es ${itemLic?.modulo})`);
check(/label:\s*"Licitaciones"/.test(itemLic?.linea ?? ""), "su etiqueta es «Licitaciones»");
const iconoLic = /icon:\s*Ic\.(\w+)/.exec(itemLic?.linea ?? "")?.[1] ?? null;
check(iconoLic !== null && new RegExp(`\\b${iconoLic}:\\s*\\(`).test(layout), `el ícono Ic.${iconoLic} existe en el layout`);
const grupoComercial = tramo(menu ?? "", /grupo:\s*"Comercial",\s*items:\s*\[/, "]");
check(grupoComercial?.includes('href: "/licitaciones"') ?? false, "va en el grupo Comercial");
const posPlantillas = grupoComercial?.indexOf('"/cotizaciones/plantillas"') ?? -1;
const posLic = grupoComercial?.indexOf('"/licitaciones"') ?? -1;
check(posPlantillas >= 0 && posLic > posPlantillas, "va después de «Plantillas PDF»");
check(items.filter((i) => i.href === "/licitaciones").length === 1, "/licitaciones está una sola vez");

// El gate del layout: el primer ítem cuyo href es la ruta o un prefijo con «/» (app/layout.tsx).
const gate = (pathname: string) => items.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
check(/menu\.find\(\s*\(item\)\s*=>\s*pathname === item\.href \|\| pathname\.startsWith\(`\$\{item\.href\}\/`\)/.test(layout),
  "el gate del layout sigue resolviendo por prefijo (si cambia, esta matriz hay que revisarla)");
for (const ruta of ["/licitaciones", "/licitaciones/7", "/licitaciones/123", "/licitaciones/7/emisiones"]) {
  check(gate(ruta)?.modulo === MODULO, `${ruta} queda bajo el módulo «${MODULO}» (cae en ${gate(ruta)?.href ?? "ninguno"})`);
}
check(gate("/licitacionesx")?.modulo !== MODULO, "/licitacionesx NO cae bajo licitaciones (prefijo con «/»)");

// ══ 2. MODULOS (app/api/crear-usuario/route.ts) ════════════════════════════════
sec("2. MODULOS de app/api/crear-usuario/route.ts");
const crear = leer("app/api/crear-usuario/route.ts");
const modulosCrear = tramo(crear, /const MODULOS\s*=\s*\[/, "];");
check(modulosCrear !== null, "se encuentra el arreglo MODULOS");
const listaCrear = [...(modulosCrear ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
check(listaCrear.includes(MODULO), `MODULOS incluye "${MODULO}"`);
check(listaCrear.filter((m) => m === MODULO).length === 1, "una sola vez");

// ══ 3. GRUPOS_MODULOS + nombresModulo (app/usuarios/page.tsx) ══════════════════
sec("3. GRUPOS_MODULOS y nombresModulo de app/usuarios/page.tsx");
const usuarios = leer("app/usuarios/page.tsx");
const grupos = tramo(usuarios, /const GRUPOS_MODULOS\s*=\s*\[/, "\n];");
check(grupos !== null, "se encuentra GRUPOS_MODULOS");
const filaComercial = /\{\s*label:\s*"Comercial"[^}]*modulos:\s*\[([^\]]*)\]/.exec(grupos ?? "");
const enComercial = [...(filaComercial?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
check(enComercial.includes(MODULO), `el grupo Comercial incluye "${MODULO}"`);
const todosLosGrupos = [...(grupos ?? "").matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
check(todosLosGrupos.filter((m) => m === MODULO).length === 1, "está en un solo grupo");
const nombres = tramo(usuarios, /const nombresModulo[^=]*=\s*\{/, "\n};");
check(nombres !== null, "se encuentra nombresModulo");
check(/\blicitaciones:\s*"Licitaciones"/.test(nombres ?? ""), "nombresModulo.licitaciones = «Licitaciones»");

// La pantalla de Configuración → Usuarios re-exporta la misma: no hay una cuarta lista que olvidar.
const confUsuarios = leer("app/configuracion/usuarios/page.tsx");
check(/export \{ default \} from "@\/app\/usuarios\/page"/.test(confUsuarios),
  "app/configuracion/usuarios re-exporta app/usuarios (si deja de hacerlo, tiene su propia lista)");

// Las tres listas dicen lo mismo de este módulo (cada módulo del menú está en las otras dos).
const modulosMenu = new Set(items.map((i) => i.modulo));
check(modulosMenu.has(MODULO) && listaCrear.includes(MODULO) && todosLosGrupos.includes(MODULO),
  "las tres listas lo tienen");

// ══ 4. Ficha de ayuda ═══════════════════════════════════════════════════════════
sec("4. Ficha de ayuda (lib/ayuda)");
for (const ruta of ["/licitaciones", "/licitaciones/7", "/licitaciones/7/", "/licitaciones?tab=legajo"]) {
  const f = ayudaDeRuta(ruta);
  check(f !== null, `ayudaDeRuta("${ruta}") no es null`);
  check(f?.clave === MODULO, `ayudaDeRuta("${ruta}") es la ficha «${MODULO}» (es ${f?.clave ?? "null"})`);
}
const ficha = ayudaDeRuta("/licitaciones");
check(ayudaDeRuta("/cotizaciones")?.clave !== MODULO, "no le roba la ruta a Cotizaciones");
const conceptos = ficha?.conceptos ?? [];
const ESPERADOS = ["tdr", "absolucion_consultas", "foliado", "unidad_reten", "legajo_licitacion"];
for (const c of ESPERADOS) {
  check(!!GLOSARIO[c], `el glosario define «${c}»`);
  check(conceptos.includes(c), `la ficha referencia «${c}»`);
  check(GLOSARIO[c]?.clave === c, `«${c}» tiene su misma clave dentro`);
}
check(ficha ? conceptosDe(ficha).length === conceptos.length : false, "ningún concepto de la ficha es una clave muerta");
for (const c of ESPERADOS) for (const v of GLOSARIO[c]?.verTambien ?? []) check(!!GLOSARIO[v], `«${c}» → verTambien «${v}» existe`);

// Los cinco pasos y las dos pestañas están explicados.
const textoFicha = ficha
  ? [ficha.resumen, ...ficha.paraQueSirve, ...ficha.faqs.flatMap((q) => [q.pregunta, q.respuesta]),
     ...(ficha.comoHacer ?? []).flatMap((c) => [c.titulo, ...c.pasos, c.advertencia ?? ""])].join("\n")
  : "";
for (const p of ["Bases y requisitos", "Recursos", "Contenido", "Expediente", "Revisión y emisión", "Legajo de la empresa", "Experiencia"]) {
  check(textoFicha.includes(p), `la ficha nombra «${p}»`);
}
check(/propone/i.test(textoFicha) && /acepta/i.test(textoFicha), "dice que la IA propone y la persona acepta");
check(/importar desde word/i.test(textoFicha), "explica la importación desde Word");
check(/foli/i.test(textoFicha) && /ZIP/.test(textoFicha), "explica el foliado y la emisión en ZIP");

// Solo **negrita** y saltos de línea: ni enlaces, ni código, ni encabezados, ni negrita sin cerrar.
const textosGlosario = ESPERADOS.flatMap((c) => {
  const g = GLOSARIO[c];
  return g ? [g.termino, g.definicion, g.ejemplo ?? "", g.ojo ?? ""] : [];
});
for (const t of [...textoFicha.split("\n"), ...textosGlosario]) {
  if (!t) continue;
  check(!/`|\]\(|^#{1,6}\s|<\/?[a-z]/i.test(t), `sin markdown extra: «${t.slice(0, 60)}»`);
  check((t.match(/\*\*/g) ?? []).length % 2 === 0, `negrita cerrada: «${t.slice(0, 60)}»`);
}

// Este ERP se vende: la ficha y sus términos no nombran a ninguna empresa.
const todo = textoFicha + "\n" + textosGlosario.join("\n");
for (const nombre of [/\bAFA\b/i, /AFA Tours/i, /\bMASS\b/, /AC Farma/i, /LATAM/i, /Makro/i, /COESTI/i, /\b\d{11}\b/]) {
  check(!nombre.test(todo), `no nombra «${nombre.source}»`);
}

console.log(`\n${ok} ok · ${fallos} fallos`);
if (fallos > 0) process.exit(1);
