// Guardar la capacidad contratada de una ruta, sin chocar contra el índice único.
//
// `cliente_ruta` tiene un índice único por (cliente, sede, nombre de ida, nombre de
// retorno). Una ficha SIN ida —y los adicionales del formato son casi siempre servicios de
// solo retorno— sube su retorno al campo principal y deja el otro en null. Si la BÚSQUEDA
// de la ficha existente no usa ese mismo par, la función no encuentra nunca la fila que
// ella misma escribió: inserta la primera vez y todas las siguientes revientan con
//
//     duplicate key value violates unique constraint "uq_cliente_ruta_identidad"
//
// que es exactamente lo que salió en producción al intentar corregir el PAX de los
// adicionales de la RUTA A y la RUTA B. En la práctica: la capacidad de una ruta de solo
// retorno se podía escribir una vez y no corregir jamás.
//
// Se prueba con un Supabase simulado que registra las operaciones, así que se puede
// afirmar lo único que importa: que la segunda vez ACTUALIZA en lugar de insertar.
//
// Correr:  npx tsx scripts/prueba-fichas-ruta.mts
import {
  cargarRutasContratadas, guardarPaxContratado, guardarPaxDeServicios,
  parCanonicoRuta, resolverPaxContratado,
} from "../lib/liquidacion-rutas";
import type { ParServicio, ReservaLiq } from "../lib/liquidacion-agrupacion";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

/**
 * Supabase de mentira con la parte que importa: el índice único de `cliente_ruta`.
 *
 * Rechaza un insert que repita (cliente, sede, ida, retorno) con el MISMO mensaje que
 * Postgres, para que la prueba falle por donde falló la aplicación de verdad.
 */
function fakeSb() {
  const filas: any[] = [];
  let secuencia = 0;
  const ops: string[] = [];
  const norm = (s: any) => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  const huella = (f: any) =>
    [f.cliente_id, f.cliente_sede_id ?? 0, norm(f.nombre_ida), norm(f.nombre_retorno)].join("|");

  const api: any = {
    filas, ops,
    from(tabla: string) {
      if (tabla === "reservas") {
        return {
          update(campos: any) {
            return {
              in(_col: string, ids: number[]) {
                ops.push(`reservas.update(${ids.length} ids, pax=${campos.capacidad_contratada})`);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      return {
        // Constructor de consulta encadenable Y esperable, como el de supabase-js: hay
        // llamadas que hacen .select().eq() y otras .select().eq().in() antes de await.
        select() {
          const filtros: ((f: any) => boolean)[] = [];
          const q: any = {
            eq(col: string, v: any) { filtros.push((f) => (f[col] ?? true) === v); return q; },
            in(col: string, vs: any[]) { filtros.push((f) => vs.includes(f[col])); return q; },
            then(res: any) { return Promise.resolve({ data: filas.filter((f) => filtros.every((p) => p(f))), error: null }).then(res); },
          };
          return q;
        },
        insert(campos: any) {
          ops.push("insert");
          if (filas.some((f) => huella(f) === huella(campos)))
            return Promise.resolve({
              error: { message: 'duplicate key value violates unique constraint "uq_cliente_ruta_identidad"' },
            });
          filas.push({ id: ++secuencia, activo: true, ...campos });
          return Promise.resolve({ error: null });
        },
        update(campos: any) {
          return {
            eq(_c: string, id: number) {
              ops.push(`update#${id}`);
              const f = filas.find((x) => x.id === id);
              if (f) Object.assign(f, campos);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return api;
}

// ── 1 · El caso que reventó en producción ───────────────────────────────────
titulo("1 · Una ruta de SOLO RETORNO se puede guardar dos veces");
{
  const sb = fakeSb();
  const ruta = {
    clienteId: 7,
    sedeId: null,
    nombreIda: null,
    nombreRetorno: "RUTA C/ RETORNO 19:00/ M5JG+GFG PASILLO D LATERAL SUR BSF→PRIMERO DE MAYO",
    pax: 10,
  };

  const a = await guardarPaxContratado(sb, ruta);
  ok(a.ok, "la primera vez se guarda", a.error ?? "");
  ok(sb.filas.length === 1, "y crea una ficha", sb.filas.length);
  ok(sb.filas[0].nombre_ida === ruta.nombreRetorno && sb.filas[0].nombre_retorno === null,
    "el retorno sube al campo principal", `ida=${String(sb.filas[0].nombre_ida).slice(0, 24)}… retorno=${sb.filas[0].nombre_retorno}`);

  const b = await guardarPaxContratado(sb, { ...ruta, pax: 4 });
  ok(b.ok, "la SEGUNDA vez también — antes daba 'duplicate key…'", b.error ?? "");
  ok(sb.ops.filter((o: string) => o.startsWith("update")).length === 1, "y lo hace ACTUALIZANDO, no insertando", sb.ops.join(" · "));
  ok(sb.filas.length === 1, "sigue habiendo una sola ficha", sb.filas.length);
  ok(sb.filas[0].pax_contratado === 4, "con la capacidad corregida", sb.filas[0].pax_contratado);
}

// ── 2 · La ruta normal, con sus dos tramos, no cambia ───────────────────────
titulo("2 · La ruta con ida y retorno se sigue guardando igual");
{
  const sb = fakeSb();
  const ruta = {
    clienteId: 7, sedeId: 3,
    nombreIda: "RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF PUNTA HERMOSA",
    nombreRetorno: "RUTA A/ RETORNO 17:00/ BSF→SANTA ANITA",
    pax: 25,
  };
  ok((await guardarPaxContratado(sb, ruta)).ok, "primera vez");
  const b = await guardarPaxContratado(sb, { ...ruta, pax: 30 });
  ok(b.ok, "segunda vez", b.error ?? "");
  ok(sb.filas.length === 1 && sb.filas[0].pax_contratado === 30, "una ficha, capacidad actualizada", `${sb.filas.length} ficha(s), pax=${sb.filas[0]?.pax_contratado}`);
  ok(sb.filas[0].nombre_retorno === ruta.nombreRetorno, "y conserva los dos nombres");
}

// ── 3 · Un espacio de más no crea una segunda ficha ─────────────────────────
titulo("3 · La normalización sigue evitando fichas duplicadas");
{
  const sb = fakeSb();
  await guardarPaxContratado(sb, { clienteId: 7, sedeId: null, nombreIda: null, nombreRetorno: "RUTA B/ RETORNO 15:00/ BSF→CHILCA", pax: 10 });
  const b = await guardarPaxContratado(sb, { clienteId: 7, sedeId: null, nombreIda: null, nombreRetorno: "ruta b/  retorno 15:00/  bsf→chilca", pax: 12 });
  ok(b.ok, "el mismo nombre mal tecleado no revienta", b.error ?? "");
  ok(sb.filas.length === 1, "y no crea una segunda ficha", sb.filas.length);
}

// ── 4 · Dos filas del mismo nombre van a los SERVICIOS ──────────────────────
titulo("4 · Cuando la ficha no puede sostener dos números, se escribe el servicio");
{
  const sb = fakeSb();
  const r = await guardarPaxDeServicios(sb, [11, 22, 33], 4);
  ok(r.ok && r.escritos === 3, "escribe la capacidad en los tres servicios", `${r.escritos} escrito(s)`);
  ok(sb.ops.some((o: string) => o.includes("reservas.update")), "por la tabla reservas", sb.ops.join(" · "));
  ok(sb.filas.length === 0, "y no toca ninguna ficha", sb.filas.length);

  const vacio = await guardarPaxDeServicios(sb, [], 10);
  ok(vacio.ok && vacio.escritos === 0, "sin servicios no hace nada");
}

// ── 5 · EL CICLO COMPLETO: guardar y volver a encontrarlo ───────────────────
//
// Es el caso que llegó desde la web y que las pruebas anteriores no cubrían: la pantalla
// decía "3 ruta(s) fichada(s)" y al recargar volvía a decir "3 ruta(s) sin capacidad
// contratada". La escritura funcionaba; la LECTURA preguntaba por el otro par de nombres.
// Guardar y leer son un solo ciclo: probar solo una mitad deja pasar justo esto.
titulo("5 · Lo guardado se vuelve a encontrar (el fallo de «se guardó pero sigue vacía»)");
{
  const sb = fakeSb();
  const nombreRetorno = "RUTA C/ RETORNO 19:00/ M5JG+GFG PASILLO D LATERAL SUR BSF→PRIMERO DE MAYO";

  // Un servicio de SOLO RETORNO, como los adicionales del formato.
  const tramo = {
    id: 1, codigo: "OS-1", fecha_servicio: "2026-08-13", hora_servicio: "19:00",
    estado: "finalizada", cliente_id: 7, cliente_sede_id: null,
    ruta_nombre: nombreRetorno, direccion_servicio: "retorno", precio_cliente: 320,
  } as ReservaLiq;
  const par: ParServicio = {
    cabeza: tramo, adjuntas: [], ejecutado: true, ejecutados: [tramo], falsoFlete: false,
    sentido: "RETORNO", ida: null, retorno: tramo,
  };

  const g = await guardarPaxContratado(sb, {
    clienteId: 7, sedeId: null, nombreIda: null, nombreRetorno, pax: 10,
  });
  ok(g.ok, "se guarda la ficha", g.error ?? "");

  const catalogo = await cargarRutasContratadas(sb, [7]);
  ok(catalogo.filas.length === 1, "el catálogo trae la ficha", catalogo.filas.length);

  const pax = resolverPaxContratado(par, { catalogo, paxCotizacion: new Map(), sedeId: null });
  ok(pax === 10, "y la cascada LA ENCUENTRA — antes devolvía null y la ruta salía sin PAX", pax);
}

// ── 6 · El par canónico, que es la regla que unifica las dos mitades ────────
titulo("6 · parCanonicoRuta: un tramo suelto siempre se guarda como la ida de su ficha");
{
  const soloRetorno = parCanonicoRuta(null, "RUTA C/ RETORNO 19:00/ BSF→MAYO");
  ok(soloRetorno.ida === "RUTA C/ RETORNO 19:00/ BSF→MAYO" && soloRetorno.retorno === null,
    "el retorno sube al campo principal", JSON.stringify(soloRetorno));

  const completa = parCanonicoRuta("RUTA A/ ENTRADA 06:30/ X→Y", "RUTA A/ RETORNO 17:00/ Y→X");
  ok(completa.ida === "RUTA A/ ENTRADA 06:30/ X→Y" && completa.retorno === "RUTA A/ RETORNO 17:00/ Y→X",
    "la ruta de dos tramos no se toca");

  const soloIda = parCanonicoRuta("RUTA B/ ENTRADA 05:10/ X→Y", null);
  ok(soloIda.ida === "RUTA B/ ENTRADA 05:10/ X→Y" && soloIda.retorno === null, "la de solo ida tampoco");
}

console.log(fallos ? `\n${fallos} FALLA(S)\n` : "\nTODO OK\n");
process.exit(fallos ? 1 : 0);
