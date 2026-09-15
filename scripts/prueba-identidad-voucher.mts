// Pruebas de QUIÉN VENDE / QUIÉN COMPRA en la nota de grifo y del etiquetado de las
// discrepancias. NO tocan la base: datos en memoria contra lib/radar/identidad-voucher.ts.
// Uso:  npx tsx scripts/prueba-identidad-voucher.mts   (sale con código 1 si algo falla)
//
// Los dos casos que motivaron el módulo salieron de la misma pantalla, el 24-08-2026:
//
//   1. `BUI-272 · GLOBAL BUS PERÚ S.A.C. · 11.22 gal · S/ 24.23/gal · S/ 271.87` — leyó bien
//      los tres números y puso como GRIFO al transportista dueño del bus. El grifo era COESTI
//      (el encabezado de la nota); GLOBAL BUS PERÚ es el "RAZ.SOC", o sea el que compró. En
//      otra fila el "grifo" salió siendo AFA TOURS PERÚ S.A.C., la propia empresa.
//
//   2. Ese mismo reporte salió marcado `discrepancia_maquina_vs_nota` — "el surtidor no
//      coincide con la nota" — con dos fotos: la nota y el TABLERO. No había ninguna foto del
//      surtidor que pudiera discrepar de nada.
import {
  normEmpresa,
  esEmpresaConocida,
  esRucConocido,
  pareceGrifo,
  resolverIdentidadGrifo,
  normalizarDiscrepancias,
  esFalsaDiscrepancia,
  codigoDeDiscrepancia,
  detalleDeDiscrepancia,
  type EmpresasConocidas,
} from "../lib/radar/identidad-voucher";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// La flota real: la propia primero (así lo arma cargarEmpresasConocidas) y las tercerizadas.
const CONOCIDAS: EmpresasConocidas = {
  nombres: ["AFA TOURS PERU S.A.C.", "GLOBAL BUS PERU S.A.C.", "CLARIGO S.A.C."],
  rucs: ["20602117091", "20611105291"],
};

// ── 1. Normalización de razones sociales ────────────────────────────────────
{
  chk("la forma societaria no distingue", normEmpresa("GLOBAL BUS PERÚ S.A.C.") === normEmpresa("Global Bus Peru SAC"),
    `${normEmpresa("GLOBAL BUS PERÚ S.A.C.")} vs ${normEmpresa("Global Bus Peru SAC")}`);
  chk("ni las tildes ni la puntuación", normEmpresa("AFA TOURS PERÚ S.A.C.") === "AFA TOURS PERU");
  chk("E.I.R.L. también se suelta", normEmpresa("SERVICIOS X E.I.R.L.") === "SERVICIOS X");
  chk("un nombre vacío no matchea nada", esEmpresaConocida("", CONOCIDAS) === null);
}

// ── 2. El caso real: el transportista puesto como grifo ─────────────────────
{
  const r = resolverIdentidadGrifo(
    {
      grifo: "GLOBAL BUS PERÚ S.A.C.",
      proveedor: "GLOBAL BUS PERÚ S.A.C.",
      ruc: "20611105291",
      direccionGrifo: "PJ. SANTA ISABEL NRO. 380",
      clienteEnNota: null,
    },
    CONOCIDAS
  );
  chk("se detecta al comprador puesto como grifo", r.anomalia?.codigo === "cliente_como_grifo", r.anomalia?.codigo ?? "—");
  chk("el grifo queda en blanco, no con el comprador", r.grifo === null && r.proveedor === null);
  chk("y se sueltan el RUC y la dirección del cliente", r.ruc === null && r.direccionGrifo === null);
  chk("bloquea: hay que completarlo mirando la foto", r.anomalia?.bloquea === true);
  chk("el detalle dice que es una tercerizada", (r.anomalia?.detalle ?? "").includes("tercerizada"));
  console.log(`        ${r.anomalia?.detalle}`);
}

// ── 3. El otro caso de la misma pantalla: la PROPIA empresa como grifo ──────
{
  const r = resolverIdentidadGrifo(
    { grifo: "AFA TOURS PERÚ S.A.C.", proveedor: null, ruc: null, direccionGrifo: null, clienteEnNota: null },
    CONOCIDAS
  );
  chk("la propia empresa tampoco puede ser el grifo", r.anomalia?.codigo === "cliente_como_grifo", r.anomalia?.codigo ?? "—");
  chk("y el detalle la nombra como propia", (r.anomalia?.detalle ?? "").includes("la propia empresa"),
    r.anomalia?.detalle?.slice(0, 60) ?? "—");
}

// ── 4. Las dos invertidas: se intercambian, no se borran ────────────────────
{
  const r = resolverIdentidadGrifo(
    {
      grifo: "GLOBAL BUS PERU SAC",
      proveedor: "GLOBAL BUS PERU SAC",
      ruc: "20611105291",
      direccionGrifo: "PJ. SANTA ISABEL NRO. 380",
      clienteEnNota: "COESTI S.A.",
    },
    CONOCIDAS
  );
  chk("con el grifo real del otro lado, se intercambian", r.grifo === "COESTI S.A.", r.grifo ?? "—");
  chk("y el RUC del cliente igual se suelta", r.ruc === null && r.direccionGrifo === null);
  chk("sigue bloqueando para que alguien lo confirme", r.anomalia?.bloquea === true);
}

// ── 5. Un grifo de verdad no se toca ────────────────────────────────────────
{
  const r = resolverIdentidadGrifo(
    {
      grifo: "COESTI S.A.",
      proveedor: "COESTI S.A.",
      ruc: "20127765279",
      direccionGrifo: "Z.I. ZONA INDUSTRIAL Mz 251",
      clienteEnNota: "GLOBAL BUS PERU S.A.C.",
    },
    CONOCIDAS
  );
  chk("COESTI queda intacto", r.grifo === "COESTI S.A." && r.anomalia === null, r.anomalia?.codigo ?? "sin anomalía");
  chk("con su RUC y su dirección", r.ruc === "20127765279" && r.direccionGrifo != null);
}

// ── 6. Nombre bien, RUC del comprador → se suelta solo el RUC ───────────────
{
  const r = resolverIdentidadGrifo(
    { grifo: "COESTI S.A.", proveedor: null, ruc: "20611105291", direccionGrifo: "PJ. SANTA ISABEL 380", clienteEnNota: null },
    CONOCIDAS
  );
  chk("el RUC del cliente se detecta solo", r.anomalia?.codigo === "ruc_del_cliente", r.anomalia?.codigo ?? "—");
  chk("el nombre del grifo se conserva", r.grifo === "COESTI S.A.");
  chk("y NO bloquea: el gasto está bien imputado", r.anomalia?.bloquea === false);
}

// ── 7. Sin empresas conocidas cargadas, no se corrige nada ─────────────────
{
  const r = resolverIdentidadGrifo(
    { grifo: "GLOBAL BUS PERU SAC", proveedor: null, ruc: null, direccionGrifo: null, clienteEnNota: null },
    { nombres: [], rucs: [] }
  );
  chk("sin catálogo, el guard se abstiene", r.anomalia === null && r.grifo === "GLOBAL BUS PERU SAC");
}

// ── 8. La contención no borra grifos buenos ────────────────────────────────
{
  const conocidas: EmpresasConocidas = { nombres: ["BUS SAC"], rucs: [] };
  chk('"BUS" no convierte a cualquier grifo en conocido', esEmpresaConocida("ESTACION BUSTAMANTE", conocidas) === null);
  const largas: EmpresasConocidas = { nombres: ["GLOBAL BUS PERU"], rucs: [] };
  chk("el mismo nombre con el giro adelante sí matchea", esEmpresaConocida("TRANSPORTES GLOBAL BUS PERU S.A.C.", largas) !== null);
  // El falso positivo que costaría una revisión por un dato correcto: una tercerizada cuyo
  // nombre aparece EN MEDIO del de un grifo real. Prefijo/sufijo lo descarta; "contiene" no.
  const enMedio: EmpresasConocidas = { nombres: ["SERVICIOS GENERALES S.A.C."], rucs: [] };
  chk("un nombre contenido POR EL MEDIO no borra el grifo",
    esEmpresaConocida("ESTACION DE SERVICIOS GENERALES DEL NORTE", enMedio) === null,
    String(esEmpresaConocida("ESTACION DE SERVICIOS GENERALES DEL NORTE", enMedio)));
  chk("y tampoco a media palabra", esEmpresaConocida("GLOBAL BUS PERUANA", largas) === null,
    String(esEmpresaConocida("GLOBAL BUS PERUANA", largas)));
}

// ── 9. RUC: solo con 11 dígitos y comparando dígitos ───────────────────────
{
  chk("el RUC matchea con guiones o espacios", esRucConocido("20611105291", CONOCIDAS));
  chk("un RUC ajeno no matchea", esRucConocido("20127765279", CONOCIDAS) === false);
  chk("un número corto no es un RUC", esRucConocido("2061110", CONOCIDAS) === false);
}

// ── 10. pareceGrifo solo desempata, no valida ──────────────────────────────
{
  chk("COESTI parece grifo", pareceGrifo("COESTI S.A."));
  chk("PRIMAX también", pareceGrifo("PRIMAX ESTACIONES"));
  chk("GLOBAL BUS PERÚ no", pareceGrifo("GLOBAL BUS PERU SAC") === false);
}

// ── 11. LA DISCREPANCIA DEL TABLERO NO ES "SURTIDOR ≠ NOTA" ────────────────
{
  // El reporte real: dos fotos (nota + tablero), ninguna del surtidor.
  const fotos = { vioSurtidor: false, vioNota: true, vioTablero: true };
  const ds = normalizarDiscrepancias([
    { campo: "kilometraje", entre: "tablero_vs_nota", detalle: "El tablero marca 175445 y la nota imprime 175698" },
  ]);
  chk("se etiqueta como tablero vs nota", codigoDeDiscrepancia(ds[0], fotos) === "discrepancia_km_tablero_vs_nota",
    codigoDeDiscrepancia(ds[0], fotos));
}
{
  // Y el caso que se veía en pantalla: la IA dice "surtidor vs nota" sin foto del surtidor.
  const fotos = { vioSurtidor: false, vioNota: true, vioTablero: true };
  const ds = normalizarDiscrepancias([{ entre: "surtidor_vs_nota", detalle: "El surtidor muestra 11.5 gal" }]);
  chk("sin foto del surtidor NO se acusa al surtidor", codigoDeDiscrepancia(ds[0], fotos) === "observacion_lectura",
    codigoDeDiscrepancia(ds[0], fotos));
  chk("y el detalle explica por qué se degradó", detalleDeDiscrepancia(ds[0], fotos).includes("no hay ninguna foto del surtidor"));
  console.log(`        ${detalleDeDiscrepancia(ds[0], fotos)}`);
}
{
  // Con la foto del surtidor SÍ presente, la etiqueta original es la correcta.
  const fotos = { vioSurtidor: true, vioNota: true, vioTablero: false };
  const ds = normalizarDiscrepancias([{ entre: "surtidor_vs_nota", detalle: "8.548 gal en el surtidor vs 8.55 en la nota" }]);
  chk("con las dos fotos, surtidor vs nota se mantiene", codigoDeDiscrepancia(ds[0], fotos) === "discrepancia_maquina_vs_nota");
  chk("y el detalle va limpio", detalleDeDiscrepancia(ds[0], fotos) === "8.548 gal en el surtidor vs 8.55 en la nota");
}

// ── 12. Los strings viejos siguen entrando, como observación ───────────────
{
  const fotos = { vioSurtidor: false, vioNota: true, vioTablero: true };
  const ds = normalizarDiscrepancias(["texto suelto de una fila vieja", "", null, { detalle: "  " }]);
  chk("un string suelto se acepta", ds.length === 1 && ds[0].detalle === "texto suelto de una fila vieja", String(ds.length));
  chk("sin declarar fuentes, es observación", codigoDeDiscrepancia(ds[0], fotos) === "observacion_lectura");
  chk("los vacíos y nulos se descartan", normalizarDiscrepancias([null, "", "   "]).length === 0);
  chk("un no-array da lista vacía", normalizarDiscrepancias("x").length === 0 && normalizarDiscrepancias(null).length === 0);
}

// ── 13. UNA DISCREPANCIA CON LOS DOS VALORES IGUALES NO ES UNA DISCREPANCIA ──
// El caso real de la nota V71S-00031149 (BUI-272, 24-08): la IA comparó el odómetro de la
// nota con el del tablero, vio que era el MISMO, y lo archivó igual como discrepancia. Su
// propio texto lo decía: "El odómetro TOTAL del tablero (175445) es congruente con el de la
// nota". En pantalla salía un rojo sobre una recarga en la que todo cuadraba.
{
  const [d] = normalizarDiscrepancias([
    { campo: "kilometraje", entre: "tablero_vs_nota", valor_a: 175445, valor_b: 175445, detalle: "congruente" },
  ]);
  chk("dos valores idénticos no son discrepancia", esFalsaDiscrepancia(d));
}
{
  // La coma de MILES peruana leída como decimal: "175,445" en la nota es 175445 km. Ese es el
  // desacuerdo aparente que la IA escribió como "175.445 vs 175445".
  const [d] = normalizarDiscrepancias([
    { campo: "kilometraje", entre: "tablero_vs_nota", valor_a: 175445, valor_b: "175,445", detalle: "x" },
  ]);
  chk('"175,445" es la coma de miles, no un decimal', d.valorB === 175445, String(d.valorB));
  chk("y por lo tanto tampoco es discrepancia", esFalsaDiscrepancia(d));
}
{
  // Aunque la IA lo escriba con el punto corrido, en el ODÓMETRO son el mismo número.
  const [d] = normalizarDiscrepancias([
    { campo: "kilometraje", entre: "tablero_vs_nota", valor_a: 175.445, valor_b: 175445, detalle: "x" },
  ]);
  chk("el separador corrido en el km tampoco es discrepancia", esFalsaDiscrepancia(d));
}
{
  // Un km REALMENTE distinto sí pasa: el grifero teclea mal y eso hay que verlo.
  const [d] = normalizarDiscrepancias([
    { campo: "kilometraje", entre: "tablero_vs_nota", valor_a: 175445, valor_b: 175545, detalle: "x" },
  ]);
  chk("un km de verdad distinto SÍ se reporta", esFalsaDiscrepancia(d) === false);
  chk("y con su código propio", codigoDeDiscrepancia(d, { vioSurtidor: false, vioNota: true, vioTablero: true }) === "discrepancia_km_tablero_vs_nota");
}
{
  // Lo del punto corrido se acota a kilometraje: 1.22 y 12.2 galones son dos cantidades.
  const [d] = normalizarDiscrepancias([
    { campo: "cantidad", entre: "surtidor_vs_nota", valor_a: 1.22, valor_b: 12.2, detalle: "x" },
  ]);
  chk("en galones, mismos dígitos NO es lo mismo", esFalsaDiscrepancia(d) === false);
}
{
  // Sin los dos valores no se puede juzgar: se abstiene y la discrepancia entra como antes.
  const [viejo] = normalizarDiscrepancias(["texto de una fila vieja"]);
  chk("sin valores declarados, no se descarta", esFalsaDiscrepancia(viejo) === false);
  const [solo] = normalizarDiscrepancias([{ campo: "importe", valor_a: 271.87, detalle: "x" }]);
  chk("con un solo valor, tampoco", esFalsaDiscrepancia(solo) === false);
}
{
  // El importe con coma de miles: "S/ 1,234.56" son 1234.56, y coincide con 1234.56.
  const [d] = normalizarDiscrepancias([
    { campo: "importe", entre: "surtidor_vs_nota", valor_a: "S/ 1,234.56", valor_b: 1234.56, detalle: "x" },
  ]);
  chk('"S/ 1,234.56" se lee como 1234.56', d.valorA === 1234.56, String(d.valorA));
  chk("y coincide, así que no es discrepancia", esFalsaDiscrepancia(d));
}
{
  // Coma decimal sin grupo de tres detrás: "11,22" galones son 11.22, no 1122.
  const [d] = normalizarDiscrepancias([{ campo: "cantidad", valor_a: "11,22", valor_b: 11.22, detalle: "x" }]);
  chk('"11,22" es coma decimal', d.valorA === 11.22, String(d.valorA));
  chk("y coincide con 11.22", esFalsaDiscrepancia(d));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
