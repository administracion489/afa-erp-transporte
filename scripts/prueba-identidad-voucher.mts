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

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
