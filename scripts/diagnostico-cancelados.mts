// Mide, sobre los datos REALES, cuánto dinero hay parado en servicios CANCELADOS.
//
// Contesta las tres preguntas que hoy no se pueden contestar desde ninguna pantalla:
//
//   1. ¿Cuántos de los "costos faltantes" del cierre eran en realidad cancelaciones?
//      Ese número es el trabajo que el ERP estaba inventando: no había nada que cargar.
//   2. ¿Cuánto importe HUÉRFANO conservan esas cancelaciones? Ese dinero no se liquida,
//      pero `v_costo_servicio` y `v_egresos` lo leen sin preguntar si el servicio se
//      prestó — así que el margen del mes ya está mal por esa cifra.
//   3. ¿Cuántos falsos fletes hay acordados y cuánto suman? Antes de reservas-05 la
//      respuesta es siempre cero: no había forma de marcarlos, y el avance pactado con
//      el proveedor no lo pagaba ningún documento.
//
// Uso:  npx tsx scripts/diagnostico-cancelados.mts [desde] [hasta]
//   ej: npx tsx scripts/diagnostico-cancelados.mts 2026-08-01 2026-08-31
//
// Solo LEE. Sirve de antes y después: córrelo hoy, corre la migración, límpialos con el
// botón de la pantalla, y vuelve a correrlo.
import fs from "node:fs";
import path from "node:path";
import { fmtMoneda } from "../lib/finanzas/dinero";

const RAIZ = process.cwd();
const RUTA_ENV = path.join(RAIZ, ".env.local");
if (!fs.existsSync(RUTA_ENV)) {
  // Un diagnóstico que revienta con un stack de `fs` no dice qué falta. Este lee la base
  // real, así que se corre desde la máquina que tiene las credenciales.
  console.error(
    `\n❌ Falta ${RUTA_ENV}.\n\n   Necesita NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.` +
    `\n   Córrelo desde la máquina donde tienes el .env.local.\n`
  );
  process.exit(1);
}
const env = fs.readFileSync(RUTA_ENV, "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const DESDE = process.argv[2] ?? "2026-08-01";
const HASTA = process.argv[3] ?? "2026-08-31";

/** PostgREST corta en 1000 filas: un mes de operación pasa de eso. */
async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${URL}/rest/v1/${ruta}`, { headers: { ...H, Range: `${desde}-${desde + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out.push(...j);
    if (j.length < 1000) return out;
  }
}

const COLS =
  "id,codigo,fecha_servicio,estado,cliente_id,empresa_tercerizada_id,tipo_asignacion," +
  "precio_cliente,costo_proveedor,ruta_nombre,liquidacion_cliente_id,liquidacion_proveedor_id";

async function main() {
  console.log(`\nSERVICIOS CANCELADOS · ${DESDE} al ${HASTA}\n${"═".repeat(64)}`);

  // La columna es de reservas-05: si la migración no se corrió, se pide sin ella y se
  // dice. Un diagnóstico que revienta por la migración que viene a medir no sirve.
  let conMigracion = true;
  let filas = await traer(
    `reservas?select=${COLS},falso_flete,falso_flete_motivo&fecha_servicio=gte.${DESDE}&fecha_servicio=lte.${HASTA}`
  ).catch(() => null) as any[] | null;
  if (!filas) {
    conMigracion = false;
    filas = await traer(`reservas?select=${COLS}&fecha_servicio=gte.${DESDE}&fecha_servicio=lte.${HASTA}`);
  }

  const [clientes, empresas] = await Promise.all([
    traer("clientes?select=id,nombre,empresa"),
    traer("empresas_tercerizadas?select=id,razon_social"),
  ]);
  const nombreCliente = new Map(clientes.map((c: any) => [c.id, c.empresa || c.nombre || `Cliente ${c.id}`]));
  const nombreEmpresa = new Map(empresas.map((e: any) => [e.id, e.razon_social || `Empresa ${e.id}`]));

  if (!conMigracion)
    console.log(
      "⚠ supabase/reservas-05-falso-flete.sql todavía NO está corrido: no hay falsos\n" +
      "  fletes marcados (todo cancelado vale S/ 0.00, que es el lado seguro).\n"
    );

  const cancelados = filas.filter((r) => String(r.estado) === "cancelada");
  const sinCerrar = filas.filter((r) => !["finalizada", "cancelada"].includes(String(r.estado)));
  const tercerizado = (r: any) => r.tipo_asignacion === "tercerizado" || !!r.empresa_tercerizada_id;

  console.log(`Servicios en el periodo ....................... ${filas.length}`);
  console.log(`  cancelados .................................. ${cancelados.length}`);
  console.log(`  sin cerrar (programada/confirmada/en curso) .. ${sinCerrar.length}`);

  // ── 1. Lo que el cierre pedía y no existía ────────────────────────────────
  const pedianCosto = cancelados.filter((r) => tercerizado(r) && !Number(r.costo_proveedor ?? 0));
  const pedianPrecio = cancelados.filter((r) => !Number(r.precio_cliente ?? 0));
  console.log(`\n1) TRABAJO QUE EL ERP INVENTABA\n${"─".repeat(64)}`);
  console.log(`Cancelados que salían como "Sin costo de proveedor" .... ${pedianCosto.length}`);
  console.log(`Cancelados que salían como "Sin precio de venta" ....... ${pedianPrecio.length}`);
  console.log(`Sin cerrar que salían con ese mismo mensaje ............ ${sinCerrar.filter((r) => !Number(r.costo_proveedor ?? 0)).length}`);
  console.log(`  (estos últimos son los peligrosos: el mensaje mandaba a cargarle un`);
  console.log(`   costo a un viaje que quizá no ocurrió)`);

  // ── 2. El importe huérfano, que sí está pesando en el margen ──────────────
  const marcado = (r: any) => conMigracion && r.falso_flete === true;
  const huerfanosCosto = cancelados.filter((r) => !marcado(r) && Number(r.costo_proveedor ?? 0) > 0);
  const huerfanosPrecio = cancelados.filter((r) => !marcado(r) && Number(r.precio_cliente ?? 0) > 0);
  const sumaCosto = huerfanosCosto.reduce((a, r) => a + Number(r.costo_proveedor ?? 0), 0);
  const sumaPrecio = huerfanosPrecio.reduce((a, r) => a + Number(r.precio_cliente ?? 0), 0);

  console.log(`\n2) IMPORTE HUÉRFANO EN CANCELADOS (no se liquida, pero ensucia el margen)\n${"─".repeat(64)}`);
  console.log(`Costo de proveedor .... ${String(huerfanosCosto.length).padStart(4)} servicio(s)  ${fmtMoneda(sumaCosto).padStart(14)}`);
  console.log(`Precio de venta ....... ${String(huerfanosPrecio.length).padStart(4)} servicio(s)  ${fmtMoneda(sumaPrecio).padStart(14)}`);
  if (sumaCosto > 0)
    console.log(`\n  → El costo del periodo está inflado en ${fmtMoneda(sumaCosto)} por viajes que no salieron.`);

  // Por proveedor, que es como se va a limpiar.
  if (huerfanosCosto.length) {
    const porEmpresa = new Map<string, { n: number; monto: number }>();
    for (const r of huerfanosCosto) {
      const k = nombreEmpresa.get(r.empresa_tercerizada_id) ?? "Sin empresa";
      const ya = porEmpresa.get(k) ?? { n: 0, monto: 0 };
      ya.n += 1; ya.monto += Number(r.costo_proveedor ?? 0);
      porEmpresa.set(k, ya);
    }
    console.log(`\n  Por proveedor:`);
    for (const [k, v] of [...porEmpresa.entries()].sort((a, b) => b[1].monto - a[1].monto).slice(0, 10))
      console.log(`    ${k.slice(0, 38).padEnd(40)} ${String(v.n).padStart(4)} serv.  ${fmtMoneda(v.monto).padStart(14)}`);
  }

  // ── 3. Los falsos fletes acordados ────────────────────────────────────────
  console.log(`\n3) FALSOS FLETES ACORDADOS\n${"─".repeat(64)}`);
  if (!conMigracion) {
    console.log(`Sin la migración no hay ninguno marcado.`);
    console.log(`De los ${huerfanosCosto.length} cancelados con costo cargado, los que de verdad`);
    console.log(`correspondan hay que marcarlos a mano — el resto se limpia con el botón.`);
  } else {
    const ff = cancelados.filter(marcado);
    const suma = ff.reduce((a, r) => a + Number(r.costo_proveedor ?? 0), 0);
    console.log(`Marcados .............. ${String(ff.length).padStart(4)} servicio(s)  ${fmtMoneda(suma).padStart(14)}`);
    const sinMotivo = ff.filter((r) => !String(r.falso_flete_motivo ?? "").trim());
    if (sinMotivo.length)
      console.log(`⚠ ${sinMotivo.length} sin motivo escrito: ${sinMotivo.slice(0, 5).map((r) => r.codigo ?? `#${r.id}`).join(", ")}`);
    const yaPagados = ff.filter((r) => r.liquidacion_proveedor_id);
    console.log(`Ya liquidados ......... ${String(yaPagados.length).padStart(4)} servicio(s)`);
  }

  // ── 4. Muestra, para poder ir a mirarlos ──────────────────────────────────
  if (huerfanosCosto.length) {
    console.log(`\n4) MUESTRA (los 12 de mayor importe)\n${"─".repeat(64)}`);
    for (const r of [...huerfanosCosto].sort((a, b) => Number(b.costo_proveedor) - Number(a.costo_proveedor)).slice(0, 12))
      console.log(
        `  ${String(r.codigo ?? `#${r.id}`).padEnd(18)} ${String(r.fecha_servicio).slice(0, 10)}  ` +
        `${fmtMoneda(Number(r.costo_proveedor)).padStart(12)}  ` +
        `${String(nombreEmpresa.get(r.empresa_tercerizada_id) ?? "—").slice(0, 22).padEnd(24)}` +
        `${String(nombreCliente.get(r.cliente_id) ?? "—").slice(0, 22)}`
      );
  }

  console.log(`\n${"═".repeat(64)}`);
  console.log(`Nada de esto se modificó: el script solo lee.\n`);
}

main().catch((e) => { console.error("\n❌", e?.message ?? e, "\n"); process.exit(1); });
