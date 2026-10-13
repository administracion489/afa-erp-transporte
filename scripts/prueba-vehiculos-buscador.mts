// Matriz de lib/vehiculos-buscador.ts. Uso: npx tsx scripts/prueba-vehiculos-buscador.mts
import {
  buscarVehiculos, capacidadVehiculo, chipEstadoVehiculo, coincideVehiculo, nivelVehiculo,
  normalizarPlaca, recientesVehiculos, rotuloVehiculo, seccionesVehiculos, textoBuscableVehiculo,
  usoPorVehiculo, type VehiculoBuscable,
} from "../lib/vehiculos-buscador";
import { terminosBusqueda } from "../lib/busqueda-texto";
import { tramosResaltados } from "../lib/clientes-buscador";

let ok = 0, fallo = 0;
const check = (cond: boolean, nombre: string, detalle?: unknown) => {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { fallo++; console.log(`✗ ${nombre}${detalle !== undefined ? " → " + JSON.stringify(detalle) : ""}`); }
};
const ids = (r: VehiculoBuscable[]) => r.map(v => v.id);
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ── Datos: propios (con equipamiento) y terceros (sin la columna) ── */
const PROPIOS: VehiculoBuscable[] = [
  { id: 1, placa: "BVI-124", categoria: "BUS", marca: "Mercedes-Benz", modelo: "O500", anio: 2019, capacidad_pasajeros: 50, equipamiento: "full_equipo", tipo_vehiculo_costeo: "BUS_50", foto_externa_url: "x" },
  { id: 2, placa: "CWZ-371", categoria: "VAN", marca: "Mercedes-Benz", modelo: "Sprinter", anio: 2022, capacidad_pasajeros: 17, equipamiento: null, tipo_vehiculo_costeo: "SPRINTER_17" },
  { id: 3, placa: "D4V-955", categoria: "BUS", marca: "Yutong", modelo: "ZK6122", anio: 2012, capacidad_pasajeros: 50, equipamiento: "basico", tipo_vehiculo_costeo: "BUS_50_ESTANDAR", foto_interna_url: "y" },
  { id: 4, placa: "A1B-124", categoria: "MINIBUS", marca: "Hyundai", modelo: "County", anio: null, capacidad_pasajeros: null, equipamiento: "full_equipo", tipo_vehiculo_costeo: null },
];
const TERCEROS: VehiculoBuscable[] = [
  { id: 11, placa: "BUI-272", categoria: "BUS", marca: "Scania", modelo: null, capacidad: 50, estado: "disponible", empresa_nombre: "TRANSPORTES ÑAHUI S.A.C.", tipo_vehiculo_costeo: "BUS_50" },
  { id: 12, placa: "CTV-370", categoria: "COASTER", marca: "Toyota", modelo: "Coaster", capacidad: 30, estado: "ocupado", empresa_nombre: "Global Bus Perú", tipo_vehiculo_costeo: "COASTER_30" },
  { id: 13, placa: "XYZ-500", categoria: "VAN", marca: "Hyundai", modelo: "H1", capacidad: 12, estado: "disponible", empresa_nombre: "Global Bus Perú", tipo_vehiculo_costeo: "VAN_12" },
  { id: 14, placa: "ABC-123", categoria: "BUS", marca: "Volvo", modelo: null, capacidad: 45, estado: "mantenimiento", empresa_nombre: null, tipo_vehiculo_costeo: "BUS_50" },
  { id: 15, placa: "BVI-1240", categoria: "BUS", marca: "Volvo", capacidad: 40, estado: "", empresa_nombre: "Otra" },
];
const TODOS = [...PROPIOS, ...TERCEROS];

/* ── 1. Placa normalizada ── */
check(normalizarPlaca("BVI-124") === "bvi124" && normalizarPlaca("bvi 124") === "bvi124" && normalizarPlaca(" Bvi-124 ") === "bvi124", "normalizarPlaca quita mayúsculas, guion y espacios");
for (const q of ["BVI124", "bvi-124", "BVI 124", "bvi124", "Bvi - 124"]) {
  const r = buscarVehiculos(PROPIOS, q);
  check(r.resultados[0]?.id === 1, `«${q}» encuentra BVI-124 primero`, ids(r.resultados));
}
check(igual(ids(buscarVehiculos(PROPIOS, "124").resultados).sort(), [1, 4]), "«124» suelto encuentra BVI-124 y A1B-124", ids(buscarVehiculos(PROPIOS, "124").resultados));

/* ── 2. Búsqueda por empresa, marca, capacidad, nivel, ficha, año ── */
check(igual(ids(buscarVehiculos(TERCEROS, "nahui").resultados), [11]), "empresa sin tilde: «nahui» encuentra «ÑAHUI»");
check(igual(ids(buscarVehiculos(TERCEROS, "global bus").resultados), [12, 13]), "empresa con dos palabras", ids(buscarVehiculos(TERCEROS, "global bus").resultados));
check(igual(ids(buscarVehiculos(TERCEROS, "peru global").resultados), [12, 13]), "palabras en cualquier orden y sin tilde");
check(igual(ids(buscarVehiculos(PROPIOS, "mercedes benz").resultados), [1, 2]), "marca con guion «Mercedes-Benz»");
check(igual(ids(buscarVehiculos(PROPIOS, "sprinter").resultados), [2]), "modelo");
check(igual(ids(buscarVehiculos(PROPIOS, "2012").resultados), [3]), "año");
for (const q of ["50p", "50 pax", "50pax", "50 PAX"]) {
  check(igual(ids(buscarVehiculos(PROPIOS, q).resultados), [1, 3]), `capacidad «${q}»`, ids(buscarVehiculos(PROPIOS, q).resultados));
}
check(igual(ids(buscarVehiculos(TERCEROS, "12p").resultados), [13]), "capacidad de tercero («capacidad») «12p»");
check(igual(ids(buscarVehiculos(PROPIOS, "full equipo").resultados).sort(), [1, 2, 4]), "«full equipo»: null cuenta como Full Equipo (default de la columna)", ids(buscarVehiculos(PROPIOS, "full equipo").resultados));
check(igual(ids(buscarVehiculos(PROPIOS, "estandar").resultados), [3]), "«estandar» sin tilde: el básico y su ficha _ESTANDAR", ids(buscarVehiculos(PROPIOS, "estandar").resultados));
check(igual(ids(buscarVehiculos(TERCEROS, "full equipo").resultados), []), "terceros: sin columna equipamiento no se afirma nivel");
check(nivelVehiculo(TERCEROS[0]) === null && nivelVehiculo(PROPIOS[1]) === "full_equipo" && nivelVehiculo(PROPIOS[2]) === "estandar", "nivelVehiculo: undefined → null, null → full_equipo, basico → estandar");
check(igual(ids(buscarVehiculos(TERCEROS, "coaster 30").resultados), [12]), "ficha de costeo «COASTER_30»");
check(igual(ids(buscarVehiculos(TODOS, "sprinter 17").resultados), [2]), "ficha «SPRINTER_17» por palabras");
check(buscarVehiculos(TODOS, "zzz").total === 0, "sin coincidencia: total 0");

/* ── 3. Orden ── */
{
  // «bvi124»: exacta BVI-124 antes que BVI-1240 (prefijo).
  const r = buscarVehiculos(TODOS, "bvi124");
  check(igual(ids(r.resultados), [1, 15]), "placa exacta antes que la que solo empieza igual", ids(r.resultados));
  // «bu»: placas que EMPIEZAN por «bu» (BUI-272) antes que las que contienen «bus» en la categoría.
  const r2 = buscarVehiculos(TODOS, "bu");
  check(r2.resultados[0]?.id === 11, "placa que empieza por la consulta va primero", ids(r2.resultados));
  // Tarifa BUS_50 sobre «bus»: los BUS_50 (1, 11, 14) antes que el resto; luego uso; luego placa.
  const uso = usoPorVehiculo([
    { vehiculo_tercero_id: 14, created_at: "2026-10-01T00:00:00Z" },
    { vehiculo_tercero_id: 14, created_at: "2026-10-02T00:00:00Z" },
    { vehiculo_flota_id: 3, created_at: "2026-10-03T00:00:00Z" },
  ], "vehiculo_tercero_id");
  const r3 = buscarVehiculos(TODOS, "volvo", { tarifaTipo: "BUS_50", uso });
  check(igual(ids(r3.resultados), [14, 15]), "coincide con la tarifa antes que el resto", ids(r3.resultados));
  const r4 = buscarVehiculos(TODOS, "bus", { tarifaTipo: "BUS_50", uso });
  check(igual(ids(r4.resultados).slice(0, 3), [14, 11, 1]), "«bus»: tarifa con uso → tarifa por placa (BUI antes que BVI) → resto", ids(r4.resultados));
  const sinT = buscarVehiculos(TERCEROS, "global", { uso: usoPorVehiculo([{ vehiculo_tercero_id: 13, created_at: "2026-01-01T00:00:00Z" }], "vehiculo_tercero_id") });
  check(igual(ids(sinT.resultados), [13, 12]), "más usado antes que placa alfabética", ids(sinT.resultados));
  const alf = buscarVehiculos(TERCEROS, "global");
  check(igual(ids(alf.resultados), [12, 13]), "sin uso: placa alfabética (CTV antes que XYZ)");
}

/* ── 4. Uso y recientes ── */
{
  const cot = [
    { vehiculo_flota_id: 2, vehiculo_tercero_id: null, created_at: "2026-09-01T10:00:00Z" },
    { vehiculo_flota_id: 1, vehiculo_tercero_id: null, created_at: "2026-09-05T10:00:00Z" },
    { vehiculo_flota_id: 2, vehiculo_tercero_id: null, created_at: "2026-10-05T10:00:00Z" },
    { vehiculo_flota_id: null, vehiculo_tercero_id: 12, created_at: "2026-10-06T10:00:00Z" },
    { vehiculo_flota_id: null, vehiculo_tercero_id: null, created_at: "2026-10-07T10:00:00Z" },
  ];
  const u = usoPorVehiculo(cot, "vehiculo_flota_id");
  check(u.get(2)?.cotizaciones === 2 && u.get(2)?.ultima === "2026-10-05T10:00:00Z", "usoPorVehiculo cuenta y toma la última", u.get(2));
  check(!u.has(12) && u.size === 2, "usoPorVehiculo solo mira su campo e ignora null");
  check(igual(recientesVehiculos(cot, "vehiculo_flota_id", 8), [2, 1]), "recientes propios: distintos, el más reciente primero");
  check(igual(recientesVehiculos(cot, "vehiculo_tercero_id", 8), [12]), "recientes terceros");
  check(recientesVehiculos(cot, "vehiculo_flota_id", 0).length === 0, "recientes con n=0");
}

/* ── 5. Secciones con consulta vacía: disjuntas y exhaustivas ── */
{
  const recientes = [12, 11, 3, 99];
  const s = seccionesVehiculos(TODOS, { tarifaTipo: "BUS_50", tarifaNombre: "Bus 50 pax · Full Equipo", recientes });
  const titulos = s.secciones.map(x => x.titulo);
  check(igual(titulos, ["Coinciden con la tarifa (Bus 50 pax · Full Equipo)", "Recientes", "Resto por placa"]), "títulos de sección en orden", titulos);
  check(igual(ids(s.secciones[0].vehiculos).sort(), [1, 11, 14]), "tarifa: las de tipo_vehiculo_costeo = tarifa", ids(s.secciones[0].vehiculos));
  check(igual(ids(s.secciones[1].vehiculos), [12, 3]), "recientes sin repetir las de tarifa y sin ids inexistentes", ids(s.secciones[1].vehiculos));
  const todos = s.secciones.flatMap(x => ids(x.vehiculos));
  check(todos.length === TODOS.length && new Set(todos).size === TODOS.length, "toda unidad aparece una sola vez (sin límite)", todos);
  check(s.total === TODOS.length && s.ocultos === 0, "total = flota, ocultos 0");
  const resto = s.secciones[2].vehiculos.map(v => v.placa);
  check(igual(resto, [...resto].sort((a, b) => a.localeCompare(b, "es"))), "el resto va por placa", resto);

  const sinTarifa = seccionesVehiculos(TODOS, {});
  check(igual(sinTarifa.secciones.map(x => x.titulo), ["Todas por placa"]), "sin tarifa ni recientes: una sola sección «Todas por placa»");
  const sinCoinc = seccionesVehiculos(TODOS, { tarifaTipo: "NO_EXISTE" });
  check(!sinCoinc.secciones.some(x => x.titulo.startsWith("Coinciden")), "sección de tarifa vacía no se pinta");
  const maxR = seccionesVehiculos(TODOS, { recientes: TODOS.map(v => v.id), maxRecientes: 3 });
  check(maxR.secciones[0].titulo === "Recientes" && maxR.secciones[0].vehiculos.length === 3, "recientes respeta el máximo");

  // Barrido: disjuntas y exhaustivas para toda combinación.
  let bien = true, n = 0;
  for (const tarifa of [null, "BUS_50", "SPRINTER_17", "X"]) for (const rec of [[], [1], [11, 1, 2], TODOS.map(v => v.id).reverse()]) for (const maxRecientes of [0, 1, 8]) {
    n++;
    const r = seccionesVehiculos(TODOS, { tarifaTipo: tarifa, recientes: rec, maxRecientes });
    const xs = r.secciones.flatMap(x => ids(x.vehiculos));
    if (xs.length !== TODOS.length || new Set(xs).size !== TODOS.length) bien = false;
    if (r.secciones.some(x => !x.vehiculos.length)) bien = false;
  }
  check(bien, `secciones disjuntas y exhaustivas, sin secciones vacías (barrido de ${n})`);

  // Límite: corta en orden y cuenta los ocultos.
  const l = seccionesVehiculos(TODOS, { tarifaTipo: "BUS_50", recientes, limite: 4 });
  const lids = l.secciones.flatMap(x => ids(x.vehiculos));
  check(lids.length === 4 && igual(lids, todos.slice(0, 4)) && l.ocultos === TODOS.length - 4, "límite corta en el mismo orden y cuenta ocultos", { lids, ocultos: l.ocultos });
  check(seccionesVehiculos(TODOS, { limite: 0 }).secciones.length === 0, "límite 0 no devuelve secciones");
}

/* ── 6. Partición de la búsqueda y límite ── */
for (const q of ["", "bus", "124", "global", "50p", "zzz", "full", "mercedes 2019"]) {
  const t = terminosBusqueda(q);
  const r = buscarVehiculos(TODOS, q);
  const no = TODOS.filter(v => !coincideVehiculo(v, t));
  check(r.total === r.resultados.length && r.resultados.length + no.length === TODOS.length && new Set(ids(r.resultados)).size === r.resultados.length,
    `partición «${q}»: resultados ∪ no coinciden = todos (${r.resultados.length}+${no.length})`);
}
{
  const r = buscarVehiculos(TODOS, "", { limite: 3 });
  check(r.resultados.length === 3 && r.total === TODOS.length, "límite 3 y total antes del límite");
  check(igual(ids(r.resultados), ids(buscarVehiculos(TODOS, "").resultados).slice(0, 3)), "el límite corta el mismo orden");
}

/* ── 7. Rótulo, capacidad, estado, resaltado ── */
check(rotuloVehiculo(PROPIOS[0]) === "BVI-124 — BUS Mercedes-Benz O500 2019 (50p)", "rótulo propio", rotuloVehiculo(PROPIOS[0]));
check(rotuloVehiculo(TERCEROS[0]) === "BUI-272 — TRANSPORTES ÑAHUI S.A.C. · BUS Scania (50p)", "rótulo tercero con empresa", rotuloVehiculo(TERCEROS[0]));
check(rotuloVehiculo({ id: 9, placa: "ZZZ-000" }) === "ZZZ-000", "rótulo solo placa");
check(capacidadVehiculo(PROPIOS[3]) === null && capacidadVehiculo(TERCEROS[1]) === 30, "capacidad: null sin dato, la de tercero de «capacidad»");
check(chipEstadoVehiculo(TERCEROS[0]) === null && chipEstadoVehiculo(TERCEROS[4]) === null && chipEstadoVehiculo(PROPIOS[0]) === null, "disponible / vacío / sin estado: sin chip");
check(chipEstadoVehiculo(TERCEROS[1]) === "Ocupado" && chipEstadoVehiculo(TERCEROS[3]) === "Mantenimiento", "estado no operativo: chip con su rótulo");
check(buscarVehiculos(TERCEROS, "mantenimiento").total === 0 && buscarVehiculos(TERCEROS, "volvo").resultados.some(v => v.id === 14), "estado no operativo: se ofrece (no es filtro ni bloqueo)");
{
  const sub = (t: string, q: string) => tramosResaltados(t, q).map(r => t.slice(r.desde, r.hasta));
  check(igual(sub("BVI-124", "bvi124"), ["BVI-124"]), "«bvi124» resalta la placa entera con su guion", sub("BVI-124", "bvi124"));
  check(igual(sub("BVI-124", "124"), ["124"]), "«124» resalta solo el número");
  check(igual(sub("TRANSPORTES ÑAHUI S.A.C.", "nahui"), ["ÑAHUI"]), "«nahui» resalta «ÑAHUI»");
}
check(textoBuscableVehiculo(PROPIOS[0]).includes("bvi124") && textoBuscableVehiculo(PROPIOS[0]).includes("Full Equipo"), "texto buscable incluye placa sin guion y nivel rotulado");
check(!/undefined|null/.test(textoBuscableVehiculo(PROPIOS[3])), "texto buscable sin «null»/«undefined» por datos vacíos", textoBuscableVehiculo(PROPIOS[3]));

console.log(`\n${ok} ok · ${fallo} fallo(s)`);
if (fallo) process.exit(1);
console.log("Todo verde");
