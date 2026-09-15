// Lo que el AFA-FL-07 IMPRIME, comprobado sobre el HTML de verdad.
//
// `buildLiquidacionHtml` no tenía ninguna prueba, y es lo único que el cliente ve. El día
// que se escribió esta, un helper colocado DESPUÉS de su uso dentro de un `.map()` pasó el
// typecheck y reventó al renderizar con "Cannot access 'paxCelda' before initialization":
// el documento entero no se habría podido imprimir, y no había nada que lo detectara antes
// de que alguien pulsara "Ver PDF".
//
// Se comprueba el TEXTO renderizado, no la forma de los datos: lo que importa es lo que
// queda impreso en el papel que se manda al cliente.
//
// Correr:  npx tsx scripts/prueba-documento.mts
import { buildLiquidacionHtml, type DocLiquidacion, type FilaAnexo } from "../lib/liquidacion-doc";
import { empresaConDefectos } from "../lib/empresa-perfil";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

const fila = (o: Partial<FilaAnexo>): FilaAnexo => ({
  ref: "A-01", fecha: "03/08", codigo: "OS-2026-005198",
  ruta: "RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF (Ida)", turno: "06:30",
  placa: "ABC-123", conductor: "JUAN PEREZ",
  paxContratado: 25, estado: "Conforme", importe: 550, ...o,
});

/** El documento mínimo, con el perfil de empresa VACÍO — que es como está hoy en la base. */
function doc(anexo1: FilaAnexo[], perfil: any = {}, firmaUrl: string | null = null): DocLiquidacion {
  const e = empresaConDefectos(perfil);
  return {
    lado: "cliente", codigo: "LQC-2026-000004", estado: "BORRADOR",
    moneda: "PEN",
    empresa: { nombre: e.nombre, ruc: e.ruc, logo: e.logo, direccion: e.direccion,
               telefono: e.telefono, email: e.email, web: e.web },
    control: { codigo: "AFA-FL-07", version: "03", vigencia: "01/01/2025", emitido: "03/09/2026",
               macro: "Gestión Logística", proceso: "Venta de bienes y servicios",
               subproceso: "No aplica", titulo: "Formato de Liquidación y Conformidad del Servicio" },
    servicio: { ubicacion: "PUNTA HERMOSA", fechaValorizacion: "03/09/2026",
                contratado: "TRANSPORTE DE PERSONAL", periodo: "01/08/2026 AL 31/08/2026",
                moneda: "PEN", ordenCompra: null, inicio: "01/08/2026", fin: "31/08/2026" },
    contraparte: { nombre: "Compañía Hard Discount S.A.C.", ruc: "20608280333",
                   area: "GESTION HUMANA", usuario: "SHARON VASQUEZ", cargo: "ASISTENTE" },
    lineas: [{ item: 1, tipo: "servicio", descripcion: "TRANSPORTE DE PERSONAL",
               unidad_medida: "SERV.", cantidad: 3, precio_unitario: 550, total_linea: 1650 }],
    totales: { servicios: 1650, adicionales: 0, descuentos: 0, subtotal: 1650, igv: 297, total: 1947 },
    anexo1,
    firmas: [
      { rol: "Gerente General", entidad: "AFA TOURS PERU S.A.C.", firmaUrl },
      { rol: "Usuario", entidad: "COMPAÑÍA HARD DISCOUNT S.A.C." },
      { rol: "Área solicitante", entidad: "GESTION HUMANA" },
    ],
    documentacion: [], conformidad: {},
    qr: null, urlVerificacion: "", aviso: null, anexo2: null,
  } as unknown as DocLiquidacion;
}

const texto = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

/**
 * La tabla del Anexo 1, recortada del documento.
 *
 * Hace falta recortar: el cuerpo entero del documento va dentro de una tabla de una celda
 * con el pie colgado de un `<tfoot>` (así el navegador lo repite en cada hoja
 * RESERVÁNDOLE el alto), de modo que el primer `<tbody>` y el primer `<tfoot>` del HTML
 * son los del envoltorio. Buscarlos a secas devuelve la hoja de estilos.
 */
const anexo = (html: string) => {
  const desde = html.indexOf("ANEXO 1 —");
  const tabla = html.indexOf('<table class="anx">', desde);
  return html.slice(tabla, html.indexOf("</table>", tabla));
};

// ── 1 · Que el documento se pueda construir ────────────────────────────────
titulo("1 · El documento se renderiza");
{
  let html = "";
  let error: unknown = null;
  try { html = buildLiquidacionHtml(doc([fila({})])); } catch (e) { error = e; }
  ok(!error, "buildLiquidacionHtml no lanza", error ? String(error) : "");
  ok(html.length > 2000, "y produce un documento completo", `${html.length} caracteres`);
}

// ── 2 · El pie con el perfil de empresa vacío ──────────────────────────────
//
// La fila de `empresa_perfil` tiene hoy la dirección, el teléfono y el correo en cadena
// vacía. El pie salía con tres rayas; ahora cae a los mismos valores que imprime el PDF de
// la cotización.
titulo("2 · El pie no sale con rayas cuando el perfil está vacío");
{
  const html = buildLiquidacionHtml(doc([fila({})], { telefono: "", email: "", direccion: "", web: "" }));
  const t = texto(html);
  ok(t.includes("Chacrasana"), "imprime la dirección");
  ok(t.includes("966 707 225"), "imprime el teléfono");
  ok(t.includes("transporte@afatoursperu.com"), "imprime el correo");
  ok(t.includes("www.afatoursperu.com"), "imprime la web");
  ok(!/Dir\.:\s*—/.test(t), "y ya no hay una raya donde va la dirección");

  // Y si el perfil SÍ tiene datos, mandan los suyos.
  const propio = texto(buildLiquidacionHtml(doc([fila({})], {
    telefono: "01 999 8888", email: "otro@afa.com", direccion: "AV. NUEVA 123", web: "afa.pe",
  })));
  ok(propio.includes("01 999 8888") && propio.includes("AV. NUEVA 123"),
    "el dato del perfil pisa al de respaldo, no al revés");
}

// ── 3 · La columna PAX: solo la capacidad contratada ───────────────────────
//
// La columna llegó a imprimir dos números —contratados / embarcados— y AFA decidió dejar
// solo el contratado: es el que sustenta el importe. El embarcado es cierto, pero no es lo
// que se valoriza, y en el papel invitaba a discutir la factura contra la ocupación.
titulo("3 · La columna PAX imprime SOLO los asientos contratados");
{
  const html = buildLiquidacionHtml(doc([
    fila({ paxContratado: 25 }),
    fila({ paxContratado: 12, estado: "Incluido", importe: 0 }),
    fila({ paxContratado: null }),
  ]));
  const cabecera = html.match(/<th[^>]*>PAX<br>.*?<\/th>/)?.[0] ?? "";
  ok(/contratado/.test(cabecera) && !/emb/.test(cabecera), "la cabecera nombra un solo dato", texto(cabecera));

  // La celda es el número a secas: si quedara la barra, quedaría media columna vacía en
  // cada una de las 141 filas de un mes.
  const cuerpo = anexo(html).split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  ok(/<td class="c">25<\/td>/.test(cuerpo), "imprime el contratado del servicio");
  ok(/<td class="c">12<\/td>/.test(cuerpo), "también en el tramo incluido");
  ok(/<td class="c">—<\/td>/.test(cuerpo), "sin capacidad fichada imprime — y NO cero");
  ok(!/\d+ \/ (\d+|—)/.test(texto(cuerpo)), "y no queda rastro del par contratado/embarcado", texto(cuerpo).slice(0, 90));
}

// ── 4 · El pie NO totaliza la columna PAX ──────────────────────────────────
titulo("4 · Al pie no se suman los asientos contratados");
{
  const html = buildLiquidacionHtml(doc([
    fila({ paxContratado: 25 }),
    fila({ paxContratado: 25 }),
  ]));
  const pie = anexo(html).split("<tfoot>")[1]?.split("</tfoot>")[0] ?? "";
  ok(/TOTALES DEL PERIODO/.test(pie), "el pie sigue ahí", texto(pie));
  ok(/<td class="c">—<\/td>/.test(pie), "con un guion en la columna PAX");
  ok(!/\b50\b/.test(pie),
    "y NO suma 25 + 25: son los mismos asientos cada día, y la ida con su retorno los contarían dos veces");
  ok(/2 serv\./.test(pie) && /1,100\.00/.test(pie), "los que sí se totalizan siguen igual", texto(pie));
}

// ── 5 · La nota explica lo que la columna es ahora ─────────────────────────
//
// La nota dice QUÉ es el número y nada más. Llegó a explicar además el guion de las filas
// sin dato y por qué el pie no suma; AFA pidió quitar las dos cosas. Las reglas siguen en
// pie —los casos 3 y 4 las comprueban sobre la tabla, que es donde se ven— pero no se
// enuncian en el papel: la nota es para leer el anexo, no para justificarlo.
titulo("5 · «Cómo leer este anexo» describe la columna de verdad");
{
  const t = texto(buildLiquidacionHtml(doc([fila({})])));
  ok(/capacidad contratada/.test(t), "dice qué es el número");
  ok(/asientos pactados con el cliente/.test(t), "y de dónde sale");
  ok(!/embarcad|manifiesto|contr\.\/emb\./.test(t),
    "sin una palabra de los embarcados, que es la columna que se quitó");
  ok(!/guion|totaliza|suba menos gente|pactó nadie/.test(t),
    "y sin las dos explicaciones que AFA pidió quitar", t.match(/Cómo leer este anexo:.{0,340}/)?.[0]);
  // Lo que SÍ tiene que seguir saliendo. Va aquí explícito porque el recorte de arriba lo
  // dejó pegado al texto que se quitó, y es fácil llevárselo por delante en el siguiente.
  const conIncl = texto(buildLiquidacionHtml(doc([fila({}), fila({ estado: "Incluido", importe: 0 })])));
  ok(/una sola tarifa cubre ida y retorno, por eso comparten el número de ítem y el importe se cobra una vez/.test(conIncl),
    "explica el incl. del retorno — es lo que evita que el cliente lea un servicio gratis");
  ok(/Importes en soles, sin IGV\./.test(conIncl), "y dice en qué moneda están los importes");

  // Pero solo cuando hay algo marcado: explicar una marca que no aparece en la tabla es
  // ruido, y el anexo de un periodo sin retornos no la tiene.
  ok(!/una sola tarifa cubre ida y retorno/.test(t),
    "sin ninguna fila incl., esa frase no se imprime");
  ok(/Importes en soles, sin IGV\./.test(t), "la de la moneda sí sale siempre");

  // Se mira SOLO la nota: "sin IGV" también aparece en el bloque de totales, y buscarlo en
  // el documento entero daría un falso rojo.
  const base = doc([fila({})]);
  const usd = texto(buildLiquidacionHtml({ ...base, servicio: { ...base.servicio, moneda: "USD" } } as any)
    .split('<div class="nota">')[1] ?? "");
  ok(/Importes en dólares\./.test(usd) && !/sin IGV/.test(usd),
    "y cambia sola si la liquidación es en dólares", usd.slice(-60).trim());
}

// ── 6 · La firma del Gerente General ───────────────────────────────────────
//
// Es la misma imagen que ya rubrica el Reporte de Servicio. Va SOLO en la de AFA: las dos
// del cliente quedan en blanco a propósito, porque son las que él firma al dar la
// conformidad. Rubricarlas sería firmar por el cliente.
titulo("6 · La firma va en la del Gerente General, y solo en esa");
{
  const url = "https://www.transportesafa.com/firmaJLCA.png";
  const html = buildLiquidacionHtml(doc([fila({})], {}, url));
  const rubricas = [...html.matchAll(/<img class="rubrica"[^>]*>/g)];
  ok(rubricas.length === 1, "hay UNA sola firma rubricada", rubricas.length);
  ok(rubricas[0]?.[0].includes(url), "y es la del Reporte de Servicio", rubricas[0]?.[0].slice(0, 70));

  // Que esté en el bloque del Gerente General y no en otro.
  const bloques = html.split('<div class="firma">').slice(1);
  ok(bloques.length === 3, "siguen siendo tres firmas", bloques.length);
  const conRubrica = bloques.filter((b) => b.includes("rubrica"));
  ok(conRubrica.length === 1 && /Gerente General/.test(conRubrica[0]),
    "la rubricada es la del Gerente General");
  ok(bloques.filter((b) => /Usuario|Área solicitante/.test(b)).every((b) => !b.includes("rubrica")),
    "las del cliente quedan EN BLANCO para que las firme él");

  // Y la línea de la firma rubricada no reserva otra vez el hueco: si lo hiciera, la banda
  // crecería y en un documento de varias páginas empujaría el bloque a la siguiente.
  ok(/class="linea con-rubrica"/.test(conRubrica[0]), "la línea recorta su margen bajo la imagen");

  // Sin firma, todo sigue como antes.
  const sinFirma = buildLiquidacionHtml(doc([fila({})], {}, null));
  // Se busca la ETIQUETA, no la palabra: `rubrica` aparece siempre en la hoja de estilos.
  ok(!/<img class="rubrica"/.test(sinFirma), "sin firma configurada no se pinta ninguna imagen");
  ok(!/class="linea con-rubrica"/.test(sinFirma), "y la línea conserva el hueco de siempre para firmar a mano");
  ok(sinFirma.split('<div class="firma">').length - 1 === 3, "con sus tres recuadros");
}

console.log(fallos ? `\n${fallos} FALLA(S)\n` : "\nTODO OK\n");
process.exit(fallos ? 1 : 0);
