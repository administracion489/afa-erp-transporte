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
  herenciaAutoseleccion, camposDeHerencia, avisoHerencia, patchAutoseleccionDeOperador,
  actualizarAutoseleccion, desmarcadaPorOperador, type FilaAnterior,
} from "../lib/reservas-autoseleccion";
import {
  juzgarAutoseleccion, avisosAutoseleccion, cotizacionesAJuzgar, unirContexto, textoAvisoAutoseleccion,
  type FilaAutoseleccion,
} from "../lib/reservas-autoseleccion-aviso";

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

console.log("\n4. Herencia: solo se hereda el desmarcado de un OPERADOR");
{
  const T = "2026-10-05T20:00:00.000Z";
  const F = (id: number, o: Partial<FilaAnterior> = {}): FilaAnterior => ({
    id, fecha_servicio: "2026-10-06", estado: "finalizada", sentido: "RETORNO",
    permite_autoseleccion: true, autoseleccion_apagada_en: null, movil: null, origen_contractual: "contrato", ...o,
  });
  // El caso 06-10: el retorno nació en false por el default viejo (sin fecha) → NO se hereda.
  const h1 = herenciaAutoseleccion([F(29413, { permite_autoseleccion: false })], "RETORNO");
  ok(h1.codigo === "anterior_sin_registro" && h1.permite === true, "caso 06-10: false sin fecha (default viejo) → nace MARCADO");
  ok(camposDeHerencia(h1).permite_autoseleccion === undefined, "  …y no agrega campos (queda el true de los comunes)");
  // Desmarcado por un operador → se hereda, con la fecha de la decisión ORIGINAL.
  const h2 = herenciaAutoseleccion([F(1, { permite_autoseleccion: false, autoseleccion_apagada_en: T })], "RETORNO");
  ok(h2.codigo === "heredado" && h2.permite === false && h2.apagadaEn === T, "desmarcado por operador → nace DESMARCADO");
  ok(camposDeHerencia(h2).permite_autoseleccion === false && camposDeHerencia(h2).autoseleccion_apagada_en === T, "  …con la fecha original, no la de hoy");
  // Sentidos independientes.
  ok(herenciaAutoseleccion([F(1, { sentido: "IDA", permite_autoseleccion: false, autoseleccion_apagada_en: T })], "RETORNO").codigo === "sin_anterior",
    "una IDA desmarcada no apaga el RETORNO");
  // El último día manda; un cancelado no cuenta.
  ok(herenciaAutoseleccion([
    F(1, { fecha_servicio: "2026-10-05", permite_autoseleccion: false, autoseleccion_apagada_en: T }),
    F(2, { fecha_servicio: "2026-10-06", permite_autoseleccion: true }),
  ], "RETORNO").codigo === "anterior_marcado", "el día más reciente manda (re-marcado después)");
  ok(herenciaAutoseleccion([
    F(1, { fecha_servicio: "2026-10-05", permite_autoseleccion: false, autoseleccion_apagada_en: T }),
    F(2, { fecha_servicio: "2026-10-06", estado: "cancelada", permite_autoseleccion: true }),
  ], "RETORNO").codigo === "heredado", "el último día cancelado no cuenta: se juzga el anterior");
  ok(herenciaAutoseleccion([F(1, { origen_contractual: "adicional", permite_autoseleccion: false, autoseleccion_apagada_en: T })], "RETORNO").codigo === "sin_anterior",
    "un ADICIONAL desmarcado no apaga el contrato");
  // Móviles.
  const mixto = [F(1, { movil: 1, permite_autoseleccion: false, autoseleccion_apagada_en: T }), F(2, { movil: 2, permite_autoseleccion: true })];
  ok(herenciaAutoseleccion(mixto, "RETORNO").codigo === "anterior_mixto", "móviles que no coinciden y móvil desconocido → nace MARCADO");
  ok(herenciaAutoseleccion(mixto, "RETORNO", 1).codigo === "heredado", "móvil 1 conocido → hereda solo el del móvil 1");
  ok(herenciaAutoseleccion(mixto, "RETORNO", 2).codigo === "anterior_marcado", "móvil 2 conocido → marcado");
  ok(herenciaAutoseleccion([], "IDA") .codigo === "sin_anterior", "sin servicio anterior → nace marcado");
  // Textos: solo los que dicen algo.
  ok(avisoHerencia(h2, "RETORNO", 30)?.includes("DESMARCADA") === true, "aviso del heredado nombra el desmarcado");
  ok(avisoHerencia(h1, "RETORNO", 30)?.includes("MARCADOS") === true, "aviso del default viejo dice que nacen marcados");
  ok(avisoHerencia(herenciaAutoseleccion([F(1)], "RETORNO"), "RETORNO", 30) === null, "anterior marcado → sin aviso");
  // Barrido: permite × fecha × estado × origen × sentido × cantidad de filas.
  let combos = 0, heredados = 0, malos = 0;
  const permites = [true, false, null] as const;
  const fechas = [null, T] as const;
  const estados = ["finalizada", "cancelada", "programada"];
  const origenes = ["contrato", "adicional"];
  const sentidos = ["IDA", "RETORNO"] as const;
  for (const p1 of permites) for (const f1 of fechas) for (const e1 of estados) for (const o1 of origenes) for (const s1 of sentidos)
  for (const p2 of permites) for (const f2 of fechas) {
    const filas = [F(1, { permite_autoseleccion: p1, autoseleccion_apagada_en: f1, estado: e1, origen_contractual: o1, sentido: s1 }),
                   F(2, { permite_autoseleccion: p2, autoseleccion_apagada_en: f2 })];
    for (const n of [1, 2]) {
      const usadas = filas.slice(0, n);
      const h = herenciaAutoseleccion(usadas, "RETORNO");
      combos++;
      if ((h.permite === false) !== (h.codigo === "heredado")) malos++;
      if (h.codigo === "heredado") {
        heredados++;
        if (!h.apagadaEn) malos++;
        const grupo = usadas.filter((f) => h.fuente?.ids.includes(f.id));
        if (!grupo.every(desmarcadaPorOperador)) malos++;
      }
      // Sin ninguna fecha en ninguna fila, jamás nace desmarcado.
      if (usadas.every((f) => !f.autoseleccion_apagada_en) && h.permite === false) malos++;
    }
  }
  ok(malos === 0, `barrido de ${combos} combinaciones: solo hereda lo que un operador desmarcó (fallos: ${malos})`);
  ok(heredados > 0, "  …y el barrido sí hereda alguna vez (un motor que nunca heredara cumpliría lo anterior)");
}

console.log("\n5. Lo que escribe un operador");
{
  const ahora = new Date("2026-10-07T12:00:00.000Z");
  const off = patchAutoseleccionDeOperador(false, ahora), on = patchAutoseleccionDeOperador(true, ahora);
  ok(off.permite_autoseleccion === false && off.autoseleccion_apagada_en === ahora.toISOString(), "desmarcar deja la fecha");
  ok(on.permite_autoseleccion === true && on.autoseleccion_apagada_en === null, "marcar la borra");
  const fake = (respuestas: Array<{ error: { code?: string; message?: string } | null }>) => {
    const llamadas: Record<string, unknown>[] = [];
    return { llamadas, fn: async (p: Record<string, unknown>) => { llamadas.push(p); return respuestas[llamadas.length - 1] ?? { error: null }; } };
  };
  {
    const { fn, llamadas } = fake([{ error: { code: "PGRST204", message: "Could not find the 'autoseleccion_apagada_en' column of 'reservas' in the schema cache" } }, { error: null }]);
    const r = await actualizarAutoseleccion(fn, { ...off });
    ok(llamadas.length === 2 && !("autoseleccion_apagada_en" in llamadas[1]) && llamadas[1].permite_autoseleccion === false && r.sinRegistro && !r.error,
      "sin la columna: guarda la casilla igual y lo declara (sinRegistro)");
  }
  {
    const { fn, llamadas } = fake([{ error: { code: "PGRST204", message: "Could not find the 'ruta_nombre' column of 'reservas' in the schema cache" } }]);
    const r = await actualizarAutoseleccion(fn, { ...off, ruta_nombre: "X" });
    ok(llamadas.length === 1 && !!r.error, "si falta OTRA columna no se reintenta");
  }
  {
    const { fn, llamadas } = fake([{ error: { code: "PGRST204", message: "Could not find the 'autoseleccion_apagada_en' column" } }]);
    const r = await actualizarAutoseleccion(fn, { ruta_nombre: "X" });
    ok(llamadas.length === 1 && !!r.error, "un patch sin la fecha no se reintenta");
  }
}

console.log("\n6. Aviso ámbar: apagada aquí, encendida en sus vecinos del contrato");
{
  const HOY = "2026-10-07";
  const S = (id: number, o: Partial<FilaAutoseleccion> = {}): FilaAutoseleccion => ({
    id, cotizacion_id: 7, estado: "programada", fecha_servicio: HOY, direccion_servicio: "retorno",
    ruta_nombre: "RUTA A/ RETORNO 17:00", permite_autoseleccion: false, ...o,
  });
  const v1 = juzgarAutoseleccion(S(29413), [S(29400, { fecha_servicio: "2026-10-06", estado: "finalizada", permite_autoseleccion: true }), S(29420, { fecha_servicio: "2026-10-08", permite_autoseleccion: true })], HOY);
  ok(v1.avisa && v1.codigo === "apagada_con_vecinos" && v1.encendidos === 2 && v1.sentido === "RETORNO", "caso 06-10: avisa (2 retornos encendidos)");
  ok(textoAvisoAutoseleccion(v1).detalle.includes("Permitir que pasajeros elijan su paradero"), "el texto usa el rótulo que el operador ve");
  ok(!juzgarAutoseleccion(S(1), [S(2), S(3)], HOY).avisa, "contrato entero apagado: sin evidencia, no avisa (límite declarado)");
  ok(!juzgarAutoseleccion(S(1), [S(2, { direccion_servicio: "ida", ruta_nombre: "RUTA A/ ENTRADA 06:30", permite_autoseleccion: true })], HOY).avisa, "la IDA encendida no dice nada del retorno");
  ok(!juzgarAutoseleccion(S(1), [S(2, { cotizacion_id: 8, permite_autoseleccion: true })], HOY).avisa, "otra cotización no es vecina");
  ok(!juzgarAutoseleccion(S(1), [S(2, { estado: "cancelada", permite_autoseleccion: true })], HOY).avisa, "un vecino cancelado no cuenta");
  ok(juzgarAutoseleccion(S(1, { direccion_servicio: null }), [S(2, { permite_autoseleccion: true })], HOY).avisa, "sentido por nombre (RETORNO) = mismo sentido");
  ok(juzgarAutoseleccion(S(1, { permite_autoseleccion: null }), [S(2, { permite_autoseleccion: true })], HOY).avisa, "null = apagada (/pasajero exige true)");
  ok(juzgarAutoseleccion(S(1, { permite_autoseleccion: undefined }), [S(2, { permite_autoseleccion: true })], HOY).codigo === "sin_dato", "sin la columna no se juzga");
  ok(juzgarAutoseleccion(S(1, { cotizacion_id: null }), [S(2, { permite_autoseleccion: true })], HOY).codigo === "sin_contrato", "sin cotización: sin contrato");
  for (const e of ["cancelada", "finalizada"]) ok(juzgarAutoseleccion(S(1, { estado: e }), [S(2, { permite_autoseleccion: true })], HOY).codigo === "no_vigente", `${e}: no se juzga`);
  ok(juzgarAutoseleccion(S(1, { fecha_servicio: "2026-10-06" }), [S(2, { permite_autoseleccion: true })], HOY).codigo === "no_vigente", "programada de ayer: ya pasó");
  ok(juzgarAutoseleccion(S(1, { fecha_servicio: "2026-10-06", estado: "en_curso" }), [S(2, { permite_autoseleccion: true })], HOY).avisa, "en_curso de ayer: /pasajero aún lo ofrece → se juzga");
  ok(juzgarAutoseleccion(S(1, { permite_autoseleccion: true }), [S(2, { permite_autoseleccion: true })], HOY).codigo === "encendida", "encendida no avisa");
  // Lote = fila por fila.
  const lote = [S(1), S(2, { permite_autoseleccion: true }), S(3, { direccion_servicio: "ida", ruta_nombre: "RUTA A/ ENTRADA" }), S(4, { cotizacion_id: 9 })];
  const mapa = avisosAutoseleccion(lote, HOY);
  ok(lote.every((f) => JSON.stringify(mapa.get(f.id)) === JSON.stringify(juzgarAutoseleccion(f, lote, HOY))), "el lote juzga igual que fila por fila");
  // Independiente de la ventana: lo cargado + los encendidos de fuera = el contrato entero.
  const contrato: FilaAutoseleccion[] = [];
  for (let d = 0; d < 20; d++) {
    const f = `2026-10-${String(d + 1).padStart(2, "0")}`;
    contrato.push(S(100 + d, { fecha_servicio: f, permite_autoseleccion: d % 3 === 0 }));
  }
  const completo = avisosAutoseleccion(contrato, HOY);
  let igual = true;
  for (const [a, b] of [["2026-10-07", "2026-10-10"], ["2026-10-12", "2026-10-20"]]) {
    const ventana = contrato.filter((f) => f.fecha_servicio! >= a && f.fecha_servicio! <= b);
    const fuera = contrato.filter((f) => !ventana.includes(f) && f.permite_autoseleccion === true);
    const parcial = avisosAutoseleccion(unirContexto(ventana, fuera), HOY);
    for (const f of ventana) {
      const x = parcial.get(f.id)!, y = completo.get(f.id)!;
      if (x.codigo !== y.codigo || x.encendidos !== y.encendidos) igual = false;
    }
  }
  ok(igual, "el veredicto no depende del filtro de fechas (ventana + encendidos de fuera = contrato entero)");
  ok(cotizacionesAJuzgar([S(1, { permite_autoseleccion: true })], HOY).length === 0, "todo encendido → no se consulta nada");
  ok(cotizacionesAJuzgar([S(1, { permite_autoseleccion: undefined })], HOY).length === 0, "sin la columna → no se consulta nada");
  ok(JSON.stringify(cotizacionesAJuzgar([S(1)], HOY)) === "[7]", "una apagada vigente → se consulta su contrato");
}

console.log(`\n${total - fallos}/${total} ${fallos ? "— FALLA" : "✓"}`);
if (fallos) process.exit(1);
