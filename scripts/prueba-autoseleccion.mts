// scripts/prueba-autoseleccion.mts — Matriz de lib/reservas-autoseleccion.ts.
// Correr: npx tsx scripts/prueba-autoseleccion.mts
//
// Fija las tres promesas del módulo:
//   1. Todo servicio nuevo nace con permite_autoseleccion = true, y un valor ya puesto no se pisa.
//   2. Si la base no tiene la columna, el servicio se crea igual (sin la casilla); ante CUALQUIER
//      otro error no se reintenta — un reintento ciego podría duplicar el servicio.
//   3. «Elige tu ruta de hoy» no ofrece servicios sin paraderos (el caso «0 paraderos»).

import {
  AUTOSELECCION_AL_NACER, conAutoseleccionAlNacer, sinAutoseleccion,
  insertarServicioNuevo, ofrecibleEnAutoseleccion,
} from "../lib/reservas-autoseleccion";

let fallos = 0, total = 0;
function ok(cond: boolean, nombre: string) {
  total++;
  if (!cond) { fallos++; console.log(`  ✗ ${nombre}`); }
  else console.log(`  ✓ ${nombre}`);
}

console.log("\n1. Nace marcado");
ok(AUTOSELECCION_AL_NACER === true, "el valor al nacer es true");
{
  const f = conAutoseleccionAlNacer({ cliente_id: 1, estado: "pendiente" });
  ok(f.permite_autoseleccion === true, "una fila sin la clave nace en true");
  ok(f.cliente_id === 1 && f.estado === "pendiente", "no toca el resto de la fila");
}
ok(conAutoseleccionAlNacer({ permite_autoseleccion: false }).permite_autoseleccion === false,
  "un false ya puesto (decisión explícita) no se pisa");
{
  const original = { a: 1 };
  conAutoseleccionAlNacer(original);
  ok(!("permite_autoseleccion" in original), "no muta la fila original");
}
{
  const s = sinAutoseleccion({ a: 1, permite_autoseleccion: true });
  ok(!("permite_autoseleccion" in s) && s.a === 1, "sinAutoseleccion quita solo la casilla");
}

console.log("\n2. Inserción con respaldo");
type Llamada = Record<string, unknown>;
function fakeInsert(respuestas: Array<{ data: unknown; error: { code?: string; message?: string } | null }>) {
  const llamadas: Llamada[] = [];
  const fn = async (fila: Llamada) => { llamadas.push(fila); return respuestas[llamadas.length - 1] ?? { data: null, error: { message: "sin respuesta" } }; };
  return { fn, llamadas };
}
{
  const { fn, llamadas } = fakeInsert([{ data: { id: 7 }, error: null }]);
  const r = await insertarServicioNuevo(fn, { cliente_id: 1 });
  ok(llamadas.length === 1, "camino normal: un solo insert");
  ok(llamadas[0].permite_autoseleccion === true, "camino normal: se escribe true");
  ok(!r.error && (r.data as { id?: number } | null)?.id === 7 && r.sinColumna === false, "camino normal: devuelve la fila y sinColumna=false");
}
{
  const { fn, llamadas } = fakeInsert([
    { data: null, error: { code: "PGRST204", message: "Could not find the 'permite_autoseleccion' column of 'reservas' in the schema cache" } },
    { data: { id: 8 }, error: null },
  ]);
  const r = await insertarServicioNuevo(fn, { cliente_id: 1 });
  ok(llamadas.length === 2, "sin la columna (PostgREST): reintenta una vez");
  ok(!("permite_autoseleccion" in llamadas[1]), "el reintento va sin la casilla");
  ok(!r.error && r.sinColumna === true, "el servicio se crea y lo declara (sinColumna)");
}
{
  const { fn, llamadas } = fakeInsert([
    { data: null, error: { code: "42703", message: 'column "permite_autoseleccion" of relation "reservas" does not exist' } },
    { data: { id: 9 }, error: null },
  ]);
  const r = await insertarServicioNuevo(fn, { cliente_id: 1 });
  ok(llamadas.length === 2 && r.sinColumna && !r.error, "sin la columna (Postgres): también reintenta");
}
{
  const { fn, llamadas } = fakeInsert([
    { data: null, error: { code: "PGRST204", message: "Could not find the 'origen_contractual' column of 'reservas' in the schema cache" } },
  ]);
  const r = await insertarServicioNuevo(fn, { cliente_id: 1 });
  ok(llamadas.length === 1 && !!r.error && !r.sinColumna, "si falta OTRA columna no se suelta la casilla: se devuelve el error");
}
{
  const { fn, llamadas } = fakeInsert([{ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }]);
  const r = await insertarServicioNuevo(fn, { cliente_id: 1 });
  ok(llamadas.length === 1 && !!r.error, "ante otro error (UNIQUE, red, CHECK) no se reintenta: no se duplica el servicio");
}

console.log("\n3. Solo se ofrece lo que tiene paraderos");
ok(ofrecibleEnAutoseleccion({ paradas: [{ id: 1 }] }), "con paraderos: se ofrece");
ok(!ofrecibleEnAutoseleccion({ paradas: [] }), "sin paraderos: no se ofrece (el «0 paraderos»)");
ok(!ofrecibleEnAutoseleccion({ paradas: null }), "paradas null: no se ofrece");
ok(!ofrecibleEnAutoseleccion({}), "sin la relación: no se ofrece");
{
  // El caso de la agrupación: dos servicios sin paraderos a la misma hora compartían la clave
  // `hora|` y salía uno solo. Filtrados antes de agrupar, ninguno llega a la clave.
  const lista = [
    { id: 1, hora_servicio: "17:00:00", paradas: [] },
    { id: 2, hora_servicio: "17:00:00", paradas: [] },
    { id: 3, hora_servicio: "17:00:00", paradas: [{ id: 30, lat: -12, lng: -77 }] },
  ];
  const ofrecidos = lista.filter(ofrecibleEnAutoseleccion).map((r) => r.id);
  ok(ofrecidos.length === 1 && ofrecidos[0] === 3, "de tres a la misma hora, solo el que tiene paraderos");
}

console.log(`\n${total - fallos}/${total} ${fallos ? "— FALLA" : "✓"}`);
if (fallos) process.exit(1);
