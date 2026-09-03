// ¿Por qué este tramo no encuentra a su hermano? Contra los datos REALES de Supabase.
//
// Contesta, sin desplegar nada y sin tocar la base, la pregunta que solo se podía
// responder con una consulta SQL: "este retorno está en S/ 0.00 y su ida ya tiene el
// precio, ¿por qué el cierre lo pide como si fuera un servicio suelto?".
//
// Uso:  npx tsx scripts/diagnostico-hermanos.mts OS-2026-008400 OS-2026-008550
//       npx tsx scripts/diagnostico-hermanos.mts 2026-08-01 2026-08-31   (todo el periodo)
//
// El veredicto NO se recalcula acá: sale de lib/liquidacion-hermanos.ts, el mismo módulo
// que usa la pantalla. Si dice "se puede enlazar", el botón ámbar de /liquidaciones lo va
// a ofrecer; si dice que no, dice exactamente qué se lo impide.
//
// Solo LEE. Usa la service-role de .env.local para ver todo sin tropezar con RLS.
import fs from "node:fs";
import path from "node:path";
import {
  etiquetaRutaDetalle, sentidoDeReserva, nombreRuta,
  type ReservaLiq,
} from "../lib/liquidacion-agrupacion";
import { indiceHermanos } from "../lib/liquidacion-hermanos";

const RAIZ = process.cwd();
const env = fs.readFileSync(path.join(RAIZ, ".env.local"), "utf8");
const leer = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();
const URL = leer("NEXT_PUBLIC_SUPABASE_URL");
const KEY = leer("SUPABASE_SERVICE_ROLE_KEY") || leer("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const COLS =
  "id,codigo,fecha_servicio,hora_servicio,estado,cliente_id,ruta_nombre,direccion_servicio," +
  "origen,destino,precio_cliente,costo_proveedor,reserva_vinculada_id," +
  "liquidacion_cliente_id,liquidacion_proveedor_id,estado_admin";

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

const args = process.argv.slice(2);
const esFecha = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const rango = args.length === 2 && args.every(esFecha) ? { desde: args[0], hasta: args[1] } : null;
const codigos = rango ? [] : args;

if (!rango && !codigos.length) {
  console.log("Uso: npx tsx scripts/diagnostico-hermanos.mts OS-2026-008400 [OS-…]");
  console.log("     npx tsx scripts/diagnostico-hermanos.mts 2026-08-01 2026-08-31");
  process.exit(1);
}

// ── Los tramos a revisar, y el UNIVERSO donde buscarles el hermano ──────────
//
// El universo tiene que ser el periodo entero y NO solo los tramos preguntados: el
// hermano puede estar fuera del cierre (ya liquidado) o en otra sede, y eso es
// justamente uno de los casos que hay que poder distinguir.
let objetivos: ReservaLiq[];
let universo: ReservaLiq[];

if (rango) {
  universo = (await traer(
    `reservas?select=${COLS}&fecha_servicio=gte.${rango.desde}&fecha_servicio=lte.${rango.hasta}&order=fecha_servicio.asc,id.asc`
  )) as ReservaLiq[];
  // Sin importe por ninguna de las dos caras: los candidatos a "pide un precio que no
  // le corresponde".
  objetivos = universo.filter(
    (r) => !Number(r.precio_cliente ?? 0) && !Number(r.costo_proveedor ?? 0)
  );
} else {
  const lista = codigos.map((c) => `"${c}"`).join(",");
  const pedidos = (await traer(`reservas?select=${COLS}&codigo=in.(${lista})`)) as ReservaLiq[];
  const faltan = codigos.filter((c) => !pedidos.some((r) => r.codigo === c));
  if (faltan.length) console.log(`⚠️  No se encontró: ${faltan.join(", ")}\n`);
  if (!pedidos.length) process.exit(1);
  // El día completo de cada uno: es donde vive su hermano.
  const fechas = [...new Set(pedidos.map((r) => String(r.fecha_servicio).slice(0, 10)))];
  const clientes = [...new Set(pedidos.map((r) => r.cliente_id).filter(Boolean))];
  universo = (await traer(
    `reservas?select=${COLS}&fecha_servicio=in.(${fechas.join(",")})&cliente_id=in.(${clientes.join(",")})&order=id.asc`
  )) as ReservaLiq[];
  objetivos = pedidos;
}

const idx = indiceHermanos(universo);
const porId = new Map(universo.map((r) => [r.id, r]));
const ref = (r: ReservaLiq) => r.codigo ?? `#${r.id}`;
const plata = (r: ReservaLiq) => `venta S/ ${Number(r.precio_cliente ?? 0).toFixed(2)} · costo S/ ${Number(r.costo_proveedor ?? 0).toFixed(2)}`;
/** Quién apunta a esta fila. Es la mitad del enlace que el ERP no miraba. */
const apuntanA = (id: number) => universo.filter((x) => Number(x.reserva_vinculada_id ?? 0) === id);

console.log("═".repeat(88));
console.log(`ENLACE IDA↔RETORNO · ${objetivos.length} tramo(s) a revisar · universo de ${universo.length} reservas`);
console.log("═".repeat(88));

let enlazables = 0, yaBien = 0, sinSalida = 0;

for (const r of objetivos) {
  const { etiqueta, fuente } = etiquetaRutaDetalle(r);
  console.log("");
  console.log("─".repeat(88));
  console.log(`${ref(r)}  ${r.fecha_servicio} ${String(r.hora_servicio ?? "").slice(0, 5)}  ${sentidoDeReserva(r)}`);
  console.log(`   ruta: ${nombreRuta(r)}`);
  console.log(`   ${plata(r)} · estado ${r.estado} · estado_admin ${r.estado_admin ?? "—"}`);
  console.log(`   etiqueta "${etiqueta}" (sale del ${fuente === "nombre" ? "NOMBRE de la ruta" : fuente === "tramo" ? "origen→destino — NO sirve para deducir" : "nada"})`);

  // ── El enlace escrito, por los dos sentidos ──────────────────────────────
  const adelante = Number(r.reserva_vinculada_id ?? 0);
  const destino = adelante ? porId.get(adelante) : null;
  console.log(
    `   enlace →  reserva_vinculada_id = ${adelante || "NULL"}` +
    (adelante ? (destino ? ` (${ref(destino)})` : " — ¡apunta a una reserva que no está en el universo!") : "")
  );
  const atras = apuntanA(r.id);
  console.log(
    `   enlace ←  le apuntan ${atras.length} fila(s)` +
    (atras.length ? `: ${atras.map(ref).join(", ")}` : "")
  );

  const h = idx.de(r);
  if (!h) {
    // ── Por qué no hay hermano ───────────────────────────────────────────
    const libre = (x: ReservaLiq) => !Number(x.reserva_vinculada_id ?? 0) && !apuntanA(x.id).length;
    const mismaLlave = universo.filter(
      (x) =>
        x.id !== r.id &&
        Number(x.cliente_id) === Number(r.cliente_id) &&
        String(x.fecha_servicio).slice(0, 10) === String(r.fecha_servicio).slice(0, 10) &&
        etiquetaRutaDetalle(x).etiqueta === etiqueta
    );
    const sueltas = mismaLlave.filter(libre);
    const contrario = sueltas.filter((x) => sentidoDeReserva(x) !== sentidoDeReserva(r));

    console.log(`   ❌ SIN HERMANO. En ese día y esa ruta hay ${mismaLlave.length} tramo(s) más, ${sueltas.length} sin enlace.`);
    if (fuente !== "nombre")
      console.log(`      · La etiqueta no sale del nombre de la ruta, así que NO se deduce nada (el origen→destino está invertido entre ida y retorno).`);
    else if (!libre(r))
      console.log(`      · Este tramo YA tiene un enlace escrito y apunta a otro sitio: hay que corregirlo en Programación, no deducirlo.`);
    else if (!contrario.length)
      console.log(`      · No hay ningún tramo del sentido contrario libre ese día con esa ruta. Revisa si la ida se escribió con otro nombre de ruta, otra fecha u otro cliente.`);
    else if (contrario.length > 1)
      console.log(
        `      · AMBIGUO: hay ${contrario.length} candidatos del sentido contrario (${contrario.map(ref).join(", ")}). ` +
        `Son dos móviles: el ERP no adivina, hay que enlazarlos a mano en Programación.`
      );
    else
      console.log(`      · El candidato ${ref(contrario[0])} existe pero no quedó emparejado — revisa su enlace.`);
    for (const x of mismaLlave)
      console.log(
        `        ${ref(x).padEnd(16)} ${String(x.hora_servicio ?? "").slice(0, 5)} ${sentidoDeReserva(x).padEnd(7)} ` +
        `vinc=${Number(x.reserva_vinculada_id ?? 0) || "NULL"} ${plata(x)}`
      );
    sinSalida++;
    continue;
  }

  const marca =
    h.procedencia === "enlace" ? "✅ enlazado por los dos lados"
    : h.procedencia === "enlace_a_medias" ? "🟠 ENLACE A MEDIAS (escrito en un solo lado)"
    : "🔵 SIN ENLACE, par deducido sin ambigüedad";
  console.log(`   ${marca}`);
  console.log(`      hermano: ${ref(h.tramo)} ${h.tramo.fecha_servicio} ${String(h.tramo.hora_servicio ?? "").slice(0, 5)} ${sentidoDeReserva(h.tramo)}`);
  console.log(`               ${nombreRuta(h.tramo)}`);
  console.log(`               ${plata(h.tramo)} · estado ${h.tramo.estado}` +
    (h.tramo.liquidacion_cliente_id ? ` · YA está en la liquidación de cliente #${h.tramo.liquidacion_cliente_id}` : ""));

  if (h.procedencia === "enlace") { yaBien++; continue; }
  enlazables++;
  console.log(`      → El botón ámbar "Enlazar ida↔retorno" de /liquidaciones lo va a ofrecer.`);
}

console.log("");
console.log("═".repeat(88));
console.log(`${yaBien} ya enlazado(s) · ${enlazables} reparable(s) desde el botón ámbar · ${sinSalida} sin hermano`);
if (sinSalida) console.log(`Los "sin hermano" se enlazan a mano desde Programación: son los que el ERP no puede deducir sin adivinar.`);
console.log("═".repeat(88));
