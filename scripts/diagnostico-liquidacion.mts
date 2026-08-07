// Simula el cierre de un periodo con los datos REALES de Supabase, sin tocar nada.
//
// Responde la pregunta que hoy solo se sabe liquidando: ¿qué saldría si cierro este
// mes? Cuántos servicios facturables hay (recordando que una tarifa cubre ida y
// retorno), cómo quedarían las líneas del formato y qué está bloqueado y por qué.
//
// Uso:  npx tsx scripts/diagnostico-liquidacion.mts [desde] [hasta] [cliente|proveedor]
//   ej: npx tsx scripts/diagnostico-liquidacion.mts 2026-07-01 2026-07-31
//
// Solo LEE. Usa la service-role de .env.local para ver todo sin tropezar con RLS.
import fs from "node:fs";
import path from "node:path";
import {
  analizarServicios, agruparServicios,
  type ReservaLiq, type CatalogoLiq, type LadoLiquidacion,
} from "../lib/liquidacion-agrupacion";
import { fmtMoneda } from "../lib/finanzas/dinero";

const RAIZ = process.cwd();
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const DESDE = process.argv[2] ?? "2026-07-01";
const HASTA = process.argv[3] ?? "2026-07-31";
const LADO = (process.argv[4] ?? "cliente") as LadoLiquidacion;

/** PostgREST corta en 1000 filas: un mes de operación pasa de eso. */
async function traer(ruta: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${URL}/rest/v1/${ruta}`, { headers: { ...H, Range: `${desde}-${desde + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) break;
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

const COLS =
  "id,codigo,fecha_servicio,hora_servicio,estado,estado_admin,estado_proveedor,cliente_id,cliente_sede_id," +
  "ruta_nombre,direccion_servicio,origen,destino,precio_cliente,costo_proveedor,tipo_asignacion," +
  "vehiculo_id,vehiculo_tercero_id,conductor_id,conductor_tercero_id,empresa_tercerizada_id," +
  "pasajeros_abordados,hora_real_inicio,hora_real_fin,tipo_servicio_detalle," +
  "reserva_vinculada_id,liquidacion_cliente_id,liquidacion_proveedor_id";

const [reservas, clientes, terceros, vehiculos, vehTercero, sedes] = await Promise.all([
  traer(`reservas?select=${COLS}&fecha_servicio=gte.${DESDE}&fecha_servicio=lte.${HASTA}&order=fecha_servicio.asc`),
  traer("clientes?select=id,nombre,empresa"),
  traer("empresas_tercerizadas?select=id,razon_social"),
  traer("vehiculos?select=id,placa,capacidad_pasajeros"),
  traer("vehiculos_tercero?select=id,placa,capacidad"),
  traer("cliente_sedes?select=id,cliente_id,nombre,servicio_contratado,patrones&activo=is.true").catch(() => []),
]);

const nombreCliente = new Map<number, string>(clientes.map((c: any) => [c.id, c.empresa || c.nombre]));
const nombreTercero = new Map<number, string>(terceros.map((t: any) => [t.id, t.razon_social]));
const placas = new Map<string, { placa: string; cap: number | null }>();
for (const v of vehiculos) placas.set("p" + v.id, { placa: v.placa, cap: v.capacidad_pasajeros });
for (const v of vehTercero) placas.set("t" + v.id, { placa: v.placa, cap: v.capacidad });

const catalogo: CatalogoLiq = {
  placaDe: (r) => placas.get((r.vehiculo_tercero_id ? "t" : "p") + (r.vehiculo_tercero_id ?? r.vehiculo_id))?.placa ?? "",
  capacidadDe: (r) => placas.get((r.vehiculo_tercero_id ? "t" : "p") + (r.vehiculo_tercero_id ?? r.vehiculo_id))?.cap ?? null,
  conductorDe: () => "",
};

// Mismo filtro que usa la pantalla /liquidaciones.
const candidatas = (reservas as ReservaLiq[]).filter((r) =>
  LADO === "cliente"
    ? !r.liquidacion_cliente_id && (r.estado_admin === "por_liquidar" || !r.estado_admin)
    : !r.liquidacion_proveedor_id && (r.tipo_asignacion === "tercerizado" || !!r.empresa_tercerizada_id)
);

// Agrupar por contraparte (+ sede cuando exista).
const grupos = new Map<string, { nombre: string; sede: any; filas: ReservaLiq[] }>();
for (const r of candidatas) {
  const id = LADO === "cliente" ? r.cliente_id : r.empresa_tercerizada_id;
  const delCliente = sedes.filter((s: any) => s.cliente_id === r.cliente_id);
  const sede = r.cliente_sede_id
    ? sedes.find((s: any) => s.id === r.cliente_sede_id)
    : delCliente.length === 1
    ? delCliente[0]
    : delCliente.find((s: any) =>
        (s.patrones ?? []).some((p: string) => `${r.ruta_nombre ?? ""} ${r.origen ?? ""} ${r.destino ?? ""}`.toUpperCase().includes(p))
      );
  const clave = `${id ?? "x"}|${sede?.id ?? 0}`;
  const nombre = (LADO === "cliente" ? nombreCliente.get(Number(id)) : nombreTercero.get(Number(id))) ?? `#${id}`;
  const g = grupos.get(clave) ?? { nombre, sede: sede ?? null, filas: [] };
  g.filas.push(r);
  grupos.set(clave, g);
}

console.log("═".repeat(78));
console.log(`SIMULACIÓN DE CIERRE · ${DESDE} → ${HASTA} · lado ${LADO.toUpperCase()}`);
console.log("═".repeat(78));
console.log(`Reservas en el periodo: ${reservas.length} · candidatas a liquidar: ${candidatas.length}\n`);

let totalGeneral = 0, serviciosGeneral = 0, bloqueadasGeneral = 0;

for (const [, g] of [...grupos].sort((a, b) => b[1].filas.length - a[1].filas.length)) {
  const analisis = analizarServicios(g.filas, LADO);
  // Los precios de `reservas` son NETOS: los importes cargados (420, 365, 275…) son
  // los mismos que aparecen como "Precio unitario" en los formatos que el cliente ya
  // firmó, y el IGV se suma abajo. Verificado contra los Excel de CD Callao y CD Trujillo.
  const lineas = agruparServicios(analisis.pares, {
    lado: LADO, catalogo, preciosIncluyenIgv: false, igvPct: 18,
    sede: g.sede?.nombre ?? null, desde: DESDE, hasta: HASTA,
    concepto: g.sede?.servicio_contratado?.replace(/^SERVICIO DE /i, "") || "TRANSPORTE DE PERSONAL",
  }).filter((l) => l.cantidad > 0);

  const total = lineas.reduce((a, l) => a + l.total_linea, 0);
  totalGeneral += total;
  serviciosGeneral += analisis.pares.filter((p) => p.ejecutado).length;
  bloqueadasGeneral += analisis.bloqueadas.length;

  console.log("─".repeat(78));
  console.log(`${g.nombre}${g.sede ? "  ·  " + g.sede.nombre : "  ·  (sin sede)"}`);
  console.log(`  ${g.filas.length} reservas → ${analisis.pares.length} servicios facturables ` +
    `(${analisis.pares.filter((p) => p.adjuntas.length).length} con ida+retorno) · ` +
    `${analisis.bloqueadas.length} bloqueadas · ${analisis.avisos.length} avisos`);

  if (lineas.length) {
    console.log("");
    for (const l of lineas)
      console.log(`   ${String(l.cantidad).padStart(3)} × ${fmtMoneda(l.precio_unitario).padStart(11)} = ${fmtMoneda(l.total_linea).padStart(12)}   ${l.descripcion.slice(0, 68)}`);
    console.log(`   ${" ".repeat(20)}TOTAL SIN IGV = ${fmtMoneda(total).padStart(12)}`);
  } else {
    console.log("   (nada liquidable)");
  }

  if (analisis.bloqueadas.length) {
    const motivos = new Map<string, number>();
    for (const b of analisis.bloqueadas)
      for (const m of b.motivos) motivos.set(m.replace(/#\d+/g, "#…"), (motivos.get(m.replace(/#\d+/g, "#…")) ?? 0) + 1);
    console.log("   Bloqueadas por:");
    for (const [m, n] of [...motivos].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)} × ${m}`);
  }
}

console.log("═".repeat(78));
console.log(`TOTAL: ${serviciosGeneral} servicios facturables · ${fmtMoneda(totalGeneral)} sin IGV · ${bloqueadasGeneral} reservas bloqueadas`);
console.log("═".repeat(78));
