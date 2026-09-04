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
  paxContratado: 25, pax: 18, estado: "Conforme", importe: 550, ...o,
});

/** El documento mínimo, con el perfil de empresa VACÍO — que es como está hoy en la base. */
function doc(anexo1: FilaAnexo[], perfil: any = {}): DocLiquidacion {
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
    anexo1, firmas: [], documentacion: [], conformidad: {},
    qr: null, urlVerificacion: "", aviso: null, anexo2: null,
  } as unknown as DocLiquidacion;
}

const texto = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

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

// ── 3 · La columna PAX: contratados / embarcados ───────────────────────────
titulo("3 · La columna PAX imprime contratados / embarcados");
{
  const html = buildLiquidacionHtml(doc([
    fila({ paxContratado: 25, pax: 18 }),
    fila({ paxContratado: 25, pax: null, estado: "Incluido", importe: 0 }),
    fila({ paxContratado: null, pax: 20 }),
  ]));
  const celdas = [...html.matchAll(/<td class="c">(\d+|—) \/ (\d+|—)<\/td>/g)].map((m) => `${m[1]}/${m[2]}`);
  ok(celdas.includes("25/18"), "contratado y embarcado", celdas.join(" · "));
  ok(celdas.includes("25/—"), "sin manifiesto imprime — y NO cero (cero sería afirmar que no viajó nadie)");
  ok(celdas.includes("—/20"), "sin capacidad fichada imprime — en su mitad");
  ok(texto(html).includes("contr./emb."), "la cabecera dice de qué son los dos números");
}

// ── 4 · El total solo suma embarques ───────────────────────────────────────
titulo("4 · Al pie solo se totalizan los embarques");
{
  const html = buildLiquidacionHtml(doc([
    fila({ paxContratado: 25, pax: 18 }),
    fila({ paxContratado: 25, pax: 12 }),
  ]));
  ok(html.includes("30 emb."), "suma 18 + 12 embarques", texto(html).match(/\d+ emb\./)?.[0]);
  ok(!html.includes("50 / 30"),
    "y NO suma los contratados: son los mismos asientos cada día, sumarlos no diría nada");
}

// ── 5 · La nota explica lo que la columna es ahora ─────────────────────────
titulo("5 · «Cómo leer este anexo» describe la columna de verdad");
{
  const t = texto(buildLiquidacionHtml(doc([fila({})])));
  ok(t.includes("contratados / embarcados"), "nombra las dos mitades");
  ok(/guion significa que ese dato no está registrado/.test(t), "explica el guion");
  ok(/solo se totalizan los embarques/.test(t), "y por qué el total no suma contratados");
  ok(!/Los pasajeros son los efectivamente embarcados según el manifiesto digital\. Cualquier/.test(t),
    "y ya no queda el texto viejo, que describía una columna que ya no existe");
}

console.log(fallos ? `\n${fallos} FALLA(S)\n` : "\nTODO OK\n");
process.exit(fallos ? 1 : 0);
