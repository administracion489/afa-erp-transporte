// Pruebas de la bandeja «Lecturas por revisar» (lib/odometro-revision.ts).
// NO tocan la base. Uso:  npx tsx scripts/prueba-odometro-revision.mts   (exit 1 si algo falla)
//
// Lo que no se puede aflojar:
//   1. El tipo de problema sale del motivo que escribe el ERP. La sección 1 PRODUCE esos motivos
//      con el motor de verdad (evaluarLectura) y exige que ninguno caiga en «otro»: si alguien
//      cambia una frase en lib/odometro.ts, esto falla en vez de esconder filas en «Otros».
//   2. Ningún filtro pierde ni inventa filas: lo que sale cumple TODOS los filtros, y el conteo de
//      cada opción coincide con lo que de verdad sale al elegirla.

import { tipoDeRevision, filtrarRevision, FILTRO_REVISION_VACIO, TIPOS_REVISION, hayFiltro, type FiltroRevision, type TipoRevision } from "../lib/odometro-revision";
import { evaluarLectura } from "../lib/odometro";
import { elegirOdometro } from "../lib/odometro-seleccion";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const T = (iso: string) => new Date(iso).getTime();
const ref = (km: number, iso: string, extra: Record<string, unknown> = {}) => ({ km, ts: T(iso), horaExacta: true, ...extra });
const ahora = new Date("2026-10-06T12:00:00-05:00");

console.log("\n1 · Los motivos que escribe el motor se clasifican (ninguno cae en «otro»)");
{
  const casos: { nombre: string; esperado: TipoRevision; motivo: string | null }[] = [
    { nombre: "dígito de más", esperado: "digito_de_mas", motivo: evaluarLectura({ kmVigente: 177994, kmNuevo: 15700000, ahora, refAnterior: ref(177994, "2026-09-30T05:41:00-05:00") }).motivo },
    { nombre: "más km que la posterior", esperado: "incoherente_posterior", motivo: evaluarLectura({ kmVigente: 31265, kmNuevo: 29647, ahora, refAnterior: ref(29540, "2026-09-12T21:10:00-05:00"), refPosterior: ref(29612, "2026-09-13T05:25:00-05:00") }).motivo },
    { nombre: "retrocede", esperado: "retroceso", motivo: evaluarLectura({ kmVigente: 204710, kmNuevo: 21333, ahora, refAnterior: ref(204710, "2026-09-19T10:24:00-05:00") }).motivo },
    { nombre: "retroceso leve", esperado: "retroceso", motivo: evaluarLectura({ kmVigente: 29612, kmNuevo: 29610, ahora, refAnterior: ref(29612, "2026-09-13T05:25:00-05:00") }).motivo },
    { nombre: "salto improbable", esperado: "salto_improbable", motivo: evaluarLectura({ kmVigente: 29612, kmNuevo: 33000, horasDesdeUltima: 12, ahora, refAnterior: ref(29612, "2026-09-13T05:25:00-05:00") }).motivo },
    { nombre: "fecha futura", esperado: "fecha_futura", motivo: evaluarLectura({ kmVigente: 1000, kmNuevo: 1010, fechaLectura: "2026-10-09T08:00:00-05:00", ahora }).motivo },
    { nombre: "foto duplicada", esperado: "duplicada", motivo: evaluarLectura({ kmVigente: 29612, kmNuevo: 29612, duplicadoProbable: true, ahora, refAnterior: ref(29612, "2026-09-13T05:25:00-05:00") }).motivo },
  ];
  for (const c of casos) chk(`${c.nombre} → ${c.esperado}`, tipoDeRevision(c.motivo) === c.esperado, c.motivo ?? "(sin motivo)");

  // Las notas que se ANTEPONEN al motivo no lo tapan.
  const conReloj = `Hora ajustada a 05:24: la foto llegó 06:06 pero su kilometraje exige que se tomara antes de la lectura de las 05:25 (29,612 km) · ${casos[2].motivo}`;
  chk("una nota de reloj delante no cambia el tipo", tipoDeRevision(conReloj) === "retroceso");
  // Lo que escribe corregirHoraLectura (lib/odometro.ts) con la hora del voucher.
  chk("hora corregida que cuadra → lista para aceptar", tipoDeRevision("Hora corregida a mano: 08:01 · con esa hora cuadra con las lecturas vecinas") === "lista_para_aceptar");
  chk("hora corregida que no cuadra → su problema real",
    tipoDeRevision(`Hora corregida a mano: 19:00 · Retrocede 27 km frente a la lectura de las 17:53 (29,674 km) (posible manipulación)`) === "retroceso");
  chk("nota del GPS (check-out) → gps", tipoDeRevision("GPS: el odómetro del día (40 km) es menor que lo recorrido por GPS (120 km)") === "gps");
  chk("sin motivo → otro (se ve, no se esconde)", tipoDeRevision(null) === "otro");

  // El dígito repetido que corrige el Radar: el motivo lo compone `elegirOdometro` y acciones.ts le
  // antepone «Corregido por el sistema:». Caía en «Otros» (CTV-370, 09/10/2026).
  const radar = (v: { motivo: string | null }) => `Corregido por el sistema: ${v.motivo}`;
  const comun = { tripIA: null, textoLeido: null, kmDiaMax: 1500, horasDesdeUltima: 24, hayHistorial: true };
  const sinTestigo = elegirOdometro({ ...comun, kmIA: 314482, kmVigente: 31400, vecinas: { anterior: 31400, posterior: null } });
  chk("dígito repetido sin testigo → corregida por el sistema",
    sinTestigo.confirmar === true && tipoDeRevision(radar(sinTestigo)) === "corregida_sistema", radar(sinTestigo));
  // La fila de la captura, tal cual: quedó antes de que un testigo bastara, y evaluarLectura ya
  // dijo que coincide con la anterior → solo espera el clic.
  const captura = "Corregido por el sistema: la IA devolvió 314,482 (6 dígitos, y esta unidad tiene 5): le sobra un dígito REPETIDO. Colapsarlo da 31,482, el único valor posible para esta unidad (lectura anterior 31,482) — confírmalo contra la foto antes de registrarlo · "
    + evaluarLectura({ kmVigente: 31482, kmNuevo: 31482, origenIA: true, ahora, refAnterior: ref(31482, "2026-10-08T16:03:00-05:00") }).motivo;
  chk("la fila de la captura (CTV-370) → lista para aceptar", tipoDeRevision(captura) === "lista_para_aceptar", captura);
  chk("…con «Confirmada» (otra fuente) también",
    tipoDeRevision(`${radar(sinTestigo)} · ${evaluarLectura({ kmVigente: 31482, kmNuevo: 31482, corroborada: true, ahora, refAnterior: ref(31482, "2026-10-08T16:03:00-05:00") }).motivo}`) === "lista_para_aceptar");
  // Lo que hay que arreglar manda sobre «corregida»: la misma foto, o un retroceso.
  const dup = evaluarLectura({ kmVigente: 31482, kmNuevo: 31482, duplicadoProbable: true, ahora, refAnterior: ref(31482, "2026-10-08T16:03:00-05:00") }).motivo;
  chk("dígito repetido + misma foto → duplicada", tipoDeRevision(`${radar(sinTestigo)} · ${dup}`) === "duplicada");
  const retro = evaluarLectura({ kmVigente: 31483, kmNuevo: 31482, ahora, refAnterior: ref(31483, "2026-10-08T16:03:00-05:00") }).motivo;
  chk("dígito repetido + retroceso → retroceso", tipoDeRevision(`${radar(sinTestigo)} · ${retro}`) === "retroceso");
  // El motivo con testigo nunca llega aquí (la lectura entra aceptada), pero si llegara por otra
  // razón no se lee como «lista»: es la otra razón la que manda.
  const conTestigo = elegirOdometro({ ...comun, kmIA: 314482, kmVigente: 31482, vecinas: { anterior: 31482, posterior: null } });
  chk("el motivo con testigo también se reconoce como corrección del sistema",
    conTestigo.testigo === "anterior" && tipoDeRevision(radar(conTestigo)) === "corregida_sistema");
}

type F = Parameters<typeof filtrarRevision>[0][number];
const fila = (id: string, placa: string, fecha: string, km: number, fuente: string, motivo: string, extra: Partial<F> = {}): F => ({
  id, placa, fecha, km, fuente, motivo, created_at: `${fecha}T12:00:00-05:00`, ts: T(`${fecha}T08:00:00-05:00`),
  foto_url: "x", vehiculo_tercero_id: null, ...extra,
});
const bandeja: F[] = [
  fila("1", "CTV-370", "2026-09-13", 29647, "combustible", "Incoherente con la lectura de las 05:25 (29,612 km), que es posterior: el odómetro no puede bajar después"),
  fila("2", "D4V-955", "2026-10-02", 15700000, "checklist", "Salto ×88 (15,700,000): posible dígito de más", { vehiculo_tercero_id: 4 }),
  fila("3", "D4V-955", "2026-10-01", 1570000, "checklist", "Salto ×9 (1,570,000): posible dígito de más", { vehiculo_tercero_id: 4 }),
  fila("4", "CVA-573", "2026-09-28", 21333, "checklist", "Retrocede 183,377 km frente a la lectura de las 10:24 (204,710 km) (posible manipulación)", { foto_url: null }),
  fila("5", "CTV-370", "2026-09-20", 30100, "whatsapp_foto", "Hora corregida a mano: 08:01 · con esa hora cuadra con las lecturas vecinas"),
];

console.log("\n2 · Filtros");
{
  const con = (p: Partial<FiltroRevision>) => filtrarRevision(bandeja, { ...FILTRO_REVISION_VACIO, ...p });
  chk("sin filtros salen todas", con({}).filas.length === 5 && !hayFiltro(FILTRO_REVISION_VACIO));
  chk("placa sin guion ni mayúsculas: «ctv 370»", con({ placa: "ctv 370" }).filas.map((f) => f.id).sort().join() === "1,5");
  chk("placa parcial: «d4v»", con({ placa: "d4v" }).filas.length === 2);
  chk("rango de fechas", con({ desde: "2026-09-20", hasta: "2026-10-01" }).filas.map((f) => f.id).sort().join() === "3,4,5");
  chk("tipo dígito de más", con({ tipo: "digito_de_mas" }).filas.length === 2);
  chk("listas para aceptar", con({ tipo: "lista_para_aceptar" }).filas.map((f) => f.id).join() === "5");
  chk("fuente", con({ fuente: "combustible" }).filas.map((f) => f.id).join() === "1");
  chk("flota tercerizada", con({ flota: "tercero" }).filas.length === 2 && con({ flota: "propia" }).filas.length === 3);
  chk("solo con foto", con({ soloConFoto: true }).filas.length === 4);
  chk("orden por km", con({ orden: "km_desc" }).filas[0].id === "2");
  chk("orden por fecha de la lectura ↑", con({ orden: "fecha_asc" }).filas[0].id === "1");
  chk("orden por placa", con({ orden: "placa" }).filas[0].placa === "CTV-370");

  // El desplegable de tipo se cuenta SIN su propio filtro: con «dígito de más» elegido,
  // todavía dice cuántas hay de los otros tipos, o no habría forma de cambiar de tipo.
  const r = con({ tipo: "digito_de_mas" });
  chk("el conteo por tipo ignora el filtro de tipo", r.porTipo.retroceso === 1 && r.porTipo.digito_de_mas === 2);
  const rp = con({ placa: "ctv" });
  chk("las placas se cuentan sin el filtro de placa", rp.porPlaca.length === 3 && rp.porPlaca[0].placa === "CTV-370" && rp.porPlaca[0].n === 2);
  const rf = con({ placa: "d4v" });
  chk("el conteo por tipo respeta los OTROS filtros", rf.porTipo.digito_de_mas === 2 && rf.porTipo.retroceso === 0);
}

console.log("\n3 · Barrido: nada se pierde ni se inventa, y cada conteo dice la verdad");
{
  const placas = ["", "ctv", "d4v-955", "zzz"];
  const rangos: [string, string][] = [["", ""], ["2026-09-20", ""], ["", "2026-09-28"], ["2026-10-01", "2026-10-02"]];
  const tipos: FiltroRevision["tipo"][] = ["todos", ...TIPOS_REVISION.map((t) => t.codigo)];
  const fuentes = ["todas", "checklist", "combustible"];
  const flotas: FiltroRevision["flota"][] = ["todas", "propia", "tercero"];
  let combos = 0, malos = 0;
  for (const placa of placas) for (const [desde, hasta] of rangos) for (const tipo of tipos)
    for (const fuente of fuentes) for (const flota of flotas) for (const soloConFoto of [false, true]) {
      combos++;
      const f: FiltroRevision = { ...FILTRO_REVISION_VACIO, placa, desde, hasta, tipo, fuente, flota, soloConFoto };
      const r = filtrarRevision(bandeja, f);
      const ids = new Set(r.filas.map((x) => x.id));
      // Sin duplicados y todas vienen de la bandeja.
      if (ids.size !== r.filas.length || r.filas.some((x) => !bandeja.includes(x))) malos++;
      // El conteo del tipo elegido coincide con lo que sale.
      if (tipo !== "todos" && r.porTipo[tipo] !== r.filas.length) malos++;
      // Con «todos», la suma por tipo es exactamente lo que sale.
      if (tipo === "todos" && Object.values(r.porTipo).reduce((a, b) => a + b, 0) !== r.filas.length) malos++;
      if (fuente !== "todas" && (r.porFuente[fuente] ?? 0) !== r.filas.length) malos++;
    }
  chk(`${combos} combinaciones sin pérdidas ni conteos falsos`, malos === 0, `${malos} fallos`);
  // Corolario: un filtro que no recortara nada cumpliría lo anterior. Comprobar que SÍ recorta.
  chk("y los filtros de verdad recortan", filtrarRevision(bandeja, { ...FILTRO_REVISION_VACIO, placa: "zzz" }).filas.length === 0);
}

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
