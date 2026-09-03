// Que un ítem del AFA-FL-07 sea una RUTA CONTRATADA y no una redacción del nombre.
//
// Los casos salen del documento real LQC-2026-000004 (Compañía Hard Discount, agosto
// 2026), que salió con 30 ítems para 141 servicios. Ninguno es inventado: cada bloque
// nombra el ítem del que se copió.
//
// LA REGLA QUE NO SE PUEDE AFLOJAR, y por la que existe la mitad de este archivo:
// dos servicios con precio unitario distinto NUNCA comparten ítem. El formato imprime
// CANT × P. UNITARIO = TOTAL, así que unir dos tarifas obligaría a inventar un unitario
// que nadie pactó. Se comprueba de tres formas —que no se unan, que la caja no se mueva
// y que agruparServicios lance si alguna vez ocurriera— porque es la única regla del
// módulo cuyo incumplimiento viaja hasta la factura.
//
// Correr:  npx tsx scripts/prueba-agrupacion.mts
import {
  agruparServicios, analizarServicios, sinHoraRuta,
  type LineaAgrupada, type OpcionesAgrupacion, type ReservaLiq,
} from "../lib/liquidacion-agrupacion";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

const OPTS: OpcionesAgrupacion = {
  lado: "cliente",
  catalogo: { placaDe: () => "", capacidadDe: () => null, conductorDe: () => "" },
  preciosIncluyenIgv: false,
  igvPct: 18,
  desde: "2026-08-01",
  hasta: "2026-08-31",
};

// ── Fábrica de fixtures ─────────────────────────────────────────────────────
//
// Coordenadas reales aproximadas de la operación: SANTA ANITA, BSF PUNTA HERMOSA, CHILCA
// y 1RO DE MAYO. `cerca` desplaza un punto unos 30 m para simular el mismo paradero
// guardado con otra lectura de GPS.
const SANTA_ANITA: [number, number] = [-12.0500, -76.9700];
const BSF: [number, number] = [-12.3300, -76.8200];
const CHILCA: [number, number] = [-12.5200, -76.7300];
const MAYO: [number, number] = [-12.2100, -76.9350];
const cerca = (p: [number, number]): [number, number] => [p[0] + 0.0003, p[1]];
/** ~4 km: otro paradero, no el mismo. */
const lejos = (p: [number, number]): [number, number] => [p[0] + 0.036, p[1]];

let idSeq = 0;
type Tramo = { nombre: string; desde: [number, number] | null; hasta: [number, number] | null };

/** Un día de servicio: ida (+ retorno opcional) enlazados, con el importe en la ida. */
function dia(o: {
  ida: Tramo;
  retorno?: Tramo | null;
  precio: number;
  fecha: string;
  hora?: string;
  origen?: string;
  /** Para el caso del retorno suelto: el importe va en el retorno y no hay ida. */
  soloRetorno?: boolean;
}): ReservaLiq[] {
  const paradas = (t: Tramo) =>
    t.desde && t.hasta
      ? [
          { tipo: "inicio", nombre: "O", lat: t.desde[0], lng: t.desde[1] },
          { tipo: "intermedia", nombre: "X", lat: t.desde[0], lng: t.desde[1] },
          { tipo: "destino", nombre: "D", lat: t.hasta[0], lng: t.hasta[1] },
        ]
      : null;
  const base = {
    fecha_servicio: o.fecha,
    hora_servicio: o.hora ?? "06:30",
    estado: "finalizada",
    cliente_id: 1,
    origen_contractual: o.origen ?? "contrato",
  };
  if (o.soloRetorno) {
    const id = ++idSeq;
    return [{ ...base, id, codigo: `S${id}`, ruta_nombre: o.ida.nombre, direccion_servicio: "retorno",
      precio_cliente: o.precio, reserva_vinculada_id: null, paradas_json: paradas(o.ida) } as ReservaLiq];
  }
  const a = ++idSeq;
  const b = o.retorno ? ++idSeq : null;
  const filas: ReservaLiq[] = [
    { ...base, id: a, codigo: `S${a}`, ruta_nombre: o.ida.nombre, direccion_servicio: "ida",
      precio_cliente: o.precio, reserva_vinculada_id: b, paradas_json: paradas(o.ida) } as ReservaLiq,
  ];
  if (o.retorno && b)
    filas.push({ ...base, id: b, codigo: `S${b}`, ruta_nombre: o.retorno.nombre, direccion_servicio: "retorno",
      hora_servicio: "17:00", precio_cliente: 0, reserva_vinculada_id: a,
      paradas_json: paradas(o.retorno) } as ReservaLiq);
  return filas;
}

const lineasDe = (rs: ReservaLiq[]): LineaAgrupada[] =>
  agruparServicios(analizarServicios(rs, "cliente").pares, OPTS).filter((l) => l.cantidad > 0);

const caja = (ls: LineaAgrupada[]) => ls.reduce((a, l) => a + l.total_linea, 0);

// ── 1 · La hora dentro del nombre no es una ruta distinta ───────────────────
titulo("1 · La hora no parte el ítem (ítems 1, 3 y 5 del documento real)");
{
  const ruta = (h: string): Tramo => ({ nombre: `RUTA A/ ENTRADA ${h}/ SANTA ANITA→BSF PUNTA HERMOSA`, desde: SANTA_ANITA, hasta: BSF });
  const ret = (h: string): Tramo => ({ nombre: `RUTA A/ RETORNO ${h}/ BSF→SANTA ANITA`, desde: BSF, hasta: SANTA_ANITA });
  const rs = [
    ...dia({ ida: ruta("04:25"), retorno: ret("15:00"), precio: 550, fecha: "2026-08-03", hora: "04:25" }),
    ...dia({ ida: ruta("06:30"), retorno: ret("17:00"), precio: 550, fecha: "2026-08-04", hora: "06:30" }),
    ...dia({ ida: ruta("06:35"), retorno: ret("17:00"), precio: 550, fecha: "2026-08-05", hora: "06:35" }),
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 1, "los tres días salen en UN ítem", `${ls.length} ítem(s)`);
  ok(ls[0]?.cantidad === 3, "con los 3 servicios", ls[0]?.cantidad);
  ok(caja(ls) === 1650, "la caja no se mueve", `S/ ${caja(ls).toFixed(2)}`);
  ok(!/\d{1,2}:\d{2}/.test(sinHoraRuta("RUTA A/ ENTRADA 06:30/ X")), "sinHoraRuta borra el reloj", sinHoraRuta("RUTA A/ ENTRADA 06:30/ X"));
}

// ── 2 · LA REGLA DURA ───────────────────────────────────────────────────────
titulo("2 · Dos tarifas distintas NUNCA comparten ítem (ítems 2, 3 y 4)");
{
  const ida: Tramo = { nombre: "RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF PUNTA HERMOSA", desde: SANTA_ANITA, hasta: BSF };
  const ret: Tramo = { nombre: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA", desde: BSF, hasta: SANTA_ANITA };
  // Nombre IDÉNTICO y extremos IDÉNTICOS: lo único que los separa es el precio.
  const rs = [
    ...dia({ ida, retorno: ret, precio: 380, fecha: "2026-08-03" }),
    ...dia({ ida, retorno: ret, precio: 550, fecha: "2026-08-04" }),
    ...dia({ ida, retorno: ret, precio: 550, fecha: "2026-08-05" }),
    ...dia({ ida, retorno: ret, precio: 780, fecha: "2026-08-06" }),
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 3, "salen 3 ítems, uno por tarifa", `${ls.length}`);
  const tarifas = ls.map((l) => l.precio_unitario).sort((a, b) => a - b);
  ok(JSON.stringify(tarifas) === "[380,550,780]", "y son 380 / 550 / 780", tarifas.join(" · "));
  ok(ls.every((l) => l.cantidad === (l.precio_unitario === 550 ? 2 : 1)), "con sus cantidades");
  ok(caja(ls) === 380 + 1100 + 780, "la caja no se mueve", `S/ ${caja(ls).toFixed(2)}`);
}

// ── 3 · El nombre autogenerado y el paradero de referencia ──────────────────
titulo("3 · Mismo punto con otro rótulo se une por el mapa (ítems 7-8 y 14-16)");
{
  // Ítem 7 vs 8: el retorno rotulado con el nombre manual y con la dirección geocodificada.
  const idaB: Tramo = { nombre: "RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA", desde: CHILCA, hasta: BSF };
  const rs = [
    ...dia({ ida: idaB, retorno: { nombre: "RUTA B/ RETORNO 15:00/ BSF→CHILCA", desde: BSF, hasta: CHILCA }, precio: 350, fecha: "2026-08-03", hora: "05:10" }),
    ...dia({ ida: idaB, retorno: { nombre: "RUTA B/ RETORNO 15:00/ M5JG+GFG PASILLO D LATERAL SUR BSF, PUNTA HERMOSA 15845, PERÚ→CHILCA 15871, PERÚ", desde: cerca(BSF), hasta: cerca(CHILCA) }, precio: 350, fecha: "2026-08-04", hora: "05:10" }),
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 1, "el retorno con dirección geocodificada NO abre un ítem nuevo", `${ls.length}`);
  ok(ls[0]?.cantidad === 2, "los dos días juntos", ls[0]?.cantidad);

  // Ítem 14 vs 16: 'BSF→1RO DE MAYO' y 'BSF→ALIPIO' son el mismo destino con otro rótulo.
  const idaC: Tramo = { nombre: "RUTA C/ENTRADA 08:40/1RO MAYO→BSF PUNTA HERMOSA", desde: MAYO, hasta: BSF };
  const rs2 = [
    ...dia({ ida: idaC, retorno: { nombre: "RUTA C/RETORNO 19:00/ BSF→1RO DE MAYO", desde: BSF, hasta: MAYO }, precio: 590, fecha: "2026-08-03", hora: "08:40" }),
    ...dia({ ida: idaC, retorno: { nombre: "RUTA C/RETORNO 19:00/ BSF→ALIPIO", desde: BSF, hasta: cerca(MAYO) }, precio: 590, fecha: "2026-08-04", hora: "08:40" }),
  ];
  ok(lineasDe(rs2).length === 1, "'BSF→ALIPIO' y 'BSF→1RO DE MAYO' salen en un ítem", lineasDe(rs2).length);
}

// ── 4 · Dos paraderos DISTINTOS siguen siendo dos rutas ─────────────────────
titulo("4 · El mapa no une lo que está lejos");
{
  const rs = [
    ...dia({ ida: { nombre: "RUTA X/ ENTRADA 06:00/ A→BSF", desde: SANTA_ANITA, hasta: BSF }, precio: 500, fecha: "2026-08-03" }),
    ...dia({ ida: { nombre: "RUTA Y/ ENTRADA 06:00/ B→BSF", desde: lejos(SANTA_ANITA), hasta: BSF }, precio: 500, fecha: "2026-08-04" }),
  ];
  ok(lineasDe(rs).length === 2, "dos orígenes a 4 km siguen siendo dos ítems", lineasDe(rs).length);
}

// ── 5 · El día al que se le cayó el retorno ─────────────────────────────────
titulo("5 · Un día sin retorno no es otra ruta (ítems 9 y 11)");
{
  const ida: Tramo = { nombre: "RUTA B/ ENTRADA 07:00/ CHILCA→BSF PUNTA HERMOSA", desde: CHILCA, hasta: BSF };
  const ret: Tramo = { nombre: "RUTA B/ RETORNO 17:00/ BSF PUNTA HERMOSA→CHILCA", desde: BSF, hasta: CHILCA };
  const rs = [
    ...dia({ ida, retorno: ret, precio: 350, fecha: "2026-08-03", hora: "07:00" }),
    ...dia({ ida, retorno: ret, precio: 350, fecha: "2026-08-04", hora: "07:00" }),
    ...dia({ ida, retorno: null, precio: 350, fecha: "2026-08-05", hora: "07:00" }),   // se canceló el retorno
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 1, "el día sin retorno entra en el mismo ítem", `${ls.length}`);
  ok(ls[0]?.cantidad === 3, "con los 3 servicios", ls[0]?.cantidad);
}

// ── 6 · …salvo cuando no se puede saber a cuál pertenece ────────────────────
titulo("6 · Con dos retornos posibles a la misma tarifa, NO adivina");
{
  const ida: Tramo = { nombre: "RUTA Z/ ENTRADA 07:00/ CHILCA→BSF", desde: CHILCA, hasta: BSF };
  const rs = [
    ...dia({ ida, retorno: { nombre: "RUTA Z/ RETORNO 15:00/ BSF→CHILCA", desde: BSF, hasta: CHILCA }, precio: 350, fecha: "2026-08-03", hora: "07:00" }),
    ...dia({ ida, retorno: { nombre: "RUTA Z/ RETORNO 22:00/ BSF→LURIN", desde: BSF, hasta: lejos(CHILCA) }, precio: 350, fecha: "2026-08-04", hora: "07:00" }),
    ...dia({ ida, retorno: null, precio: 350, fecha: "2026-08-05", hora: "07:00" }),   // ¿de cuál de los dos?
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 3, "el día ambiguo queda en su propio ítem en vez de adivinar", `${ls.length}`);
  ok(caja(ls) === 1050, "y la caja sigue cuadrando", `S/ ${caja(ls).toFixed(2)}`);
}

// ── 7 · Los adicionales, que son solo retorno ───────────────────────────────
titulo("7 · Un servicio de solo retorno también se une (ítems 29 y 30)");
{
  const rs = [
    ...dia({ ida: { nombre: "RUTA C/ RETORNO 19:00/ BSF→PRIMERO DE MAYO", desde: BSF, hasta: MAYO }, precio: 320, fecha: "2026-08-10", origen: "adicional", soloRetorno: true }),
    ...dia({ ida: { nombre: "RUTA C/ RETORNO 21:00/ BSF→PRIMERO DE MAYO", desde: cerca(BSF), hasta: cerca(MAYO) }, precio: 320, fecha: "2026-08-11", origen: "adicional", soloRetorno: true }),
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 1, "dos retornos de la misma ruta y tarifa van juntos", `${ls.length}`);
  ok(ls[0]?.tipo === "adicional", "y siguen siendo adicionales", ls[0]?.tipo);
}

// ── 8 · Contrato y adicional no se mezclan aunque coincida todo ─────────────
titulo("8 · El origen contractual sigue separando (ítems 3 y 25)");
{
  const ida: Tramo = { nombre: "RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF PUNTA HERMOSA", desde: SANTA_ANITA, hasta: BSF };
  const ret: Tramo = { nombre: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA", desde: BSF, hasta: SANTA_ANITA };
  const rs = [
    ...dia({ ida, retorno: ret, precio: 550, fecha: "2026-08-03" }),
    ...dia({ ida, retorno: ret, precio: 550, fecha: "2026-08-04", origen: "adicional" }),
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 2, "mismo nombre, mismos extremos, misma tarifa → siguen siendo 2", `${ls.length}`);
  ok(ls.some((l) => l.tipo === "servicio") && ls.some((l) => l.tipo === "adicional"), "uno de cada tipo");
}

// ── 9 · Sin coordenadas, manda el nombre ────────────────────────────────────
titulo("9 · Sin paradas_json la agrupación sigue funcionando por el nombre");
{
  const rs = [
    ...dia({ ida: { nombre: "RUTA D/ ENTRADA 06:00/ A→B", desde: null, hasta: null }, precio: 400, fecha: "2026-08-03" }),
    ...dia({ ida: { nombre: "RUTA D/ ENTRADA 06:20/ A→B", desde: null, hasta: null }, precio: 400, fecha: "2026-08-04" }),
  ];
  ok(lineasDe(rs).length === 1, "se unen por el nombre sin la hora", lineasDe(rs).length);
}

// ── 10 · El nombre impreso es el más repetido, no el primero ────────────────
titulo("10 · El ítem se rotula con la redacción más usada");
{
  const rs = [
    ...dia({ ida: { nombre: "RUTA E/ ENTRADA 04:00/ RARO→BSF", desde: SANTA_ANITA, hasta: BSF }, precio: 600, fecha: "2026-08-01", hora: "04:00" }),
    ...dia({ ida: { nombre: "RUTA E/ ENTRADA 06:00/ SANTA ANITA→BSF", desde: SANTA_ANITA, hasta: BSF }, precio: 600, fecha: "2026-08-02", hora: "06:00" }),
    ...dia({ ida: { nombre: "RUTA E/ ENTRADA 06:00/ SANTA ANITA→BSF", desde: SANTA_ANITA, hasta: BSF }, precio: 600, fecha: "2026-08-03", hora: "06:00" }),
  ];
  const ls = lineasDe(rs);
  ok(ls.length === 1, "un solo ítem", ls.length);
  ok(ls[0]?.nombre_ida === "RUTA E/ ENTRADA 06:00/ SANTA ANITA→BSF", "imprime el nombre mayoritario", ls[0]?.nombre_ida);
}

// ── 11 · El invariante de caja sobre el documento entero ────────────────────
titulo("11 · Agrupar nunca mueve un sol");
{
  const t = (n: string, d: [number, number] | null, h: [number, number] | null): Tramo => ({ nombre: n, desde: d, hasta: h });
  const rs = [
    ...dia({ ida: t("RUTA A/ ENTRADA 04:25/ SANTA ANITA→BSF", SANTA_ANITA, BSF), retorno: t("RUTA A/ RETORNO 15:00/ BSF→SANTA ANITA", BSF, SANTA_ANITA), precio: 550, fecha: "2026-08-03", hora: "04:25" }),
    ...dia({ ida: t("RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF", SANTA_ANITA, BSF), retorno: t("RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA", BSF, SANTA_ANITA), precio: 550, fecha: "2026-08-04" }),
    ...dia({ ida: t("RUTA A/ ENTRADA 06:35/ SANTA ANITA→BSF", SANTA_ANITA, BSF), retorno: t("RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA", BSF, SANTA_ANITA), precio: 780, fecha: "2026-08-05", hora: "06:35" }),
    ...dia({ ida: t("RUTA B/ ENTRADA 05:10/ CHILCA→BSF", CHILCA, BSF), retorno: t("RUTA B/ RETORNO 15:00/ BSF→CHILCA", BSF, CHILCA), precio: 350, fecha: "2026-08-03", hora: "05:10" }),
    ...dia({ ida: t("RUTA B/ ENTRADA 07:00/ CHILCA→BSF", CHILCA, BSF), retorno: null, precio: 350, fecha: "2026-08-06", hora: "07:00" }),
    ...dia({ ida: t("RUTA C/ RETORNO 19:00/ BSF→MAYO", BSF, MAYO), precio: 320, fecha: "2026-08-07", origen: "adicional", soloRetorno: true }),
  ];
  const ls = lineasDe(rs);
  const esperado = 550 + 550 + 780 + 350 + 350 + 320;
  ok(caja(ls) === esperado, "el total agrupado es el de los servicios sueltos", `S/ ${caja(ls).toFixed(2)} vs S/ ${esperado.toFixed(2)}`);
  ok(ls.reduce((a, l) => a + l.cantidad, 0) === 6, "no se pierde ni se duplica ningún servicio", ls.reduce((a, l) => a + l.cantidad, 0));
  for (const l of ls) {
    const suma = l.cantidad * l.precio_unitario;
    if (Math.abs(suma - l.total_linea) > 0.005) ok(false, `la línea ${l.ruta} cuadra`, `${suma} ≠ ${l.total_linea}`);
  }
  ok(true, "cada línea cumple CANT × P. UNITARIO = TOTAL");
}

// ── 12 · Ningún ítem con dos tarifas, pase lo que pase ──────────────────────
titulo("12 · Ningún ítem reúne dos precios unitarios");
{
  const t = (n: string): Tramo => ({ nombre: n, desde: SANTA_ANITA, hasta: BSF });
  const rs: ReservaLiq[] = [];
  // 40 días de la misma ruta con tarifas alternadas y horas cambiantes: el caso que más
  // oportunidades le da a la unión de equivocarse.
  for (let i = 0; i < 40; i++)
    rs.push(...dia({
      ida: t(`RUTA F/ ENTRADA 0${5 + (i % 3)}:${String((i * 7) % 60).padStart(2, "0")}/ SANTA ANITA→BSF`),
      precio: [430, 550, 780][i % 3],
      fecha: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      hora: `0${5 + (i % 3)}:00`,
    }));
  const ls = lineasDe(rs);
  ok(ls.length === 3, "40 días con 3 tarifas dan exactamente 3 ítems", ls.length);
  const mezcla = ls.filter((l) => {
    const suma = l.cantidad * l.precio_unitario;
    return Math.abs(suma - l.total_linea) > 0.005;
  });
  ok(mezcla.length === 0, "y ninguno mezcla tarifas");
  ok(ls.reduce((a, l) => a + l.cantidad, 0) === 40, "con los 40 servicios repartidos", ls.reduce((a, l) => a + l.cantidad, 0));
}

console.log(fallos ? `\n${fallos} FALLA(S)\n` : "\nTODO OK\n");
process.exit(fallos ? 1 : 0);
