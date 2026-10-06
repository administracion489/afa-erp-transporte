// Pruebas de CUÁNDO OCURRIÓ una lectura de odómetro (lib/odometro-tiempo.ts + registrarLectura).
// NO tocan la base: un cliente falso en memoria hace de Supabase.
// Uso:  npx tsx scripts/prueba-odometro-tiempo.mts     (sale con código 1 si algo falla)
//
// EL CASO REAL (CTV-370): la nota V70S-00043672 de COESTI imprime 13/09/2026 08:01:57 y
// kilometraje 29,647. Se confirmó desde el panel de revisión del Radar el 05/10/2026 a las 16:25
// y quedó en «Lecturas por revisar» con:
//   «Incoherente con la lectura de las 05:25 (29,612 km), que es posterior»
//   «Comparada con la lectura anterior: 31,265 km · 05/10/2026 07:02»
// Las dos frases eran falsas por el TIEMPO, no por el número: la lectura se ubicó a las 00:00 del
// 13/09 (antes del check-in) y se mostró con la hora del 05/10 (cuándo entró al ERP).

import { instanteLectura, capturaDeRecarga, normalizarHoraVoucher, isoHoraVisible, finDiaLimaTs, capturaDeFechaHora, horaLimaHms } from "../lib/odometro-tiempo";
import { registrarLectura, evaluarLectura, aceptarLectura, corregirHoraLectura, juzgarKmDeRecarga, kmFueraDeSuMomento } from "../lib/odometro";
import { tipoDeRevision } from "../lib/odometro-revision";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── Cliente falso: lo justo que usan contextoOdometro / registrarLectura / aceptarLectura ──
type Fila = Record<string, any>;
function clienteFalso(tablas: Record<string, Fila[]>) {
  let sec = 1000;
  const q = (tabla: string) => {
    let filas = [...(tablas[tabla] ||= [])];
    let modo: "select" | "insert" | "update" = "select";
    let payload: Fila | null = null;
    let limite = Infinity;
    const filtros: ((f: Fila) => boolean)[] = [];
    const orden: [string, boolean][] = [];
    const resolver = () => {
      if (modo === "insert") {
        const nueva = { id: String(++sec), created_at: new Date().toISOString(), ...payload };
        tablas[tabla].push(nueva);
        return { data: nueva, error: null };
      }
      const sel = tablas[tabla].filter((f) => filtros.every((p) => p(f)));
      if (modo === "update") { sel.forEach((f) => Object.assign(f, payload)); return { data: null, error: null }; }
      let r = [...sel];
      for (const [col, asc] of [...orden].reverse()) r.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      return { data: r.slice(0, limite), error: null };
    };
    const b: any = {
      select: () => b,
      insert: (p: Fila) => { modo = "insert"; payload = p; return b; },
      update: (p: Fila) => { modo = "update"; payload = p; return b; },
      eq: (c: string, v: any) => { filtros.push((f) => f[c] === v); return b; },
      neq: (c: string, v: any) => { filtros.push((f) => f[c] !== v); return b; },
      in: (c: string, v: any[]) => { filtros.push((f) => v.includes(f[c])); return b; },
      lte: (c: string, v: any) => { filtros.push((f) => f[c] <= v); return b; },
      gte: (c: string, v: any) => { filtros.push((f) => f[c] >= v); return b; },
      order: (c: string, o?: { ascending?: boolean }) => { orden.push([c, o?.ascending !== false]); return b; },
      limit: (n: number) => { limite = n; return b; },
      maybeSingle: async () => { const r = resolver(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }; },
      single: async () => { const r = resolver(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }; },
      then: (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko),
    };
    void filas;
    return b;
  };
  return { from: q };
}

const lect = (id: string, km: number, fecha: string, capturado_en: string | null, created_at: string, extra: Fila = {}) =>
  ({ id, vehiculo_id: 7, km, fecha, capturado_en, created_at, estado: "aceptada", fuente: "servicio", ...extra });

/** El historial real de la CTV-370 alrededor del 13/09, más la del 05/10 que se coló. */
const historial = () => [
  lect("a", 29540, "2026-09-12", "2026-09-12T21:10:00-05:00", "2026-09-12T21:10:05-05:00", { momento: "checkout" }),
  lect("b", 29612, "2026-09-13", "2026-09-13T05:25:00-05:00", "2026-09-13T05:25:04-05:00", { momento: "checkin" }),
  lect("c", 29790, "2026-09-13", "2026-09-13T21:05:00-05:00", "2026-09-13T21:05:03-05:00", { momento: "checkout" }),
  lect("z", 31265, "2026-10-05", "2026-10-05T07:02:00-05:00", "2026-10-05T07:02:04-05:00", { momento: "checkin" }),
];

console.log("\n1 · El instante de una lectura nunca sale de su día");
{
  const fila = { fecha: "2026-09-13", capturado_en: null, created_at: "2026-10-05T16:25:00-05:00" };
  const i = instanteLectura(fila);
  chk("cargada el 05/10 sin hora → final de SU día (13/09)", i.origen === "fin_del_dia" && i.ts === finDiaLimaTs("2026-09-13"));
  chk("en pantalla: sin hora, no «~16:25»", isoHoraVisible(fila) === null);
  const mismoDia = { fecha: "2026-09-13", capturado_en: null, created_at: "2026-09-13T16:25:00-05:00" };
  chk("insertada el MISMO día → su created_at (aproximado, como antes)", instanteLectura(mismoDia).origen === "insercion");
  chk("con capturado_en manda capturado_en", instanteLectura({ ...fila, capturado_en: "2026-09-13T08:01:57-05:00" }).origen === "capturado");
  chk("sin fecha: comportamiento anterior (created_at)", instanteLectura({ capturado_en: null, created_at: "2026-10-05T16:25:00-05:00" }).origen === "insercion");

  // «Comparada con la lectura anterior»: la viva de mayor instante que no supera al de la sospechosa.
  const vivas = historial();
  const anteriorDe = (ts: (l: any) => number) => {
    const tS = ts(fila); let mejor: any = null;
    for (const v of vivas) if (ts(v) <= tS && (!mejor || ts(v) > ts(mejor))) mejor = v;
    return mejor;
  };
  const viejo = (l: any) => new Date(l.capturado_en || l.created_at).getTime();
  chk("REGRESIÓN: el algoritmo viejo la compara contra el 05/10 07:02 (31,265)", anteriorDe(viejo)?.km === 31265);
  chk("ahora la compara contra una lectura del 13/09", anteriorDe((l) => instanteLectura(l).ts)?.fecha === "2026-09-13");
}

console.log("\n2 · La hora del voucher");
{
  chk("08:01:57", normalizarHoraVoucher("08:01:57") === "08:01:57");
  chk("8:01", normalizarHoraVoucher("8:01") === "08:01:00");
  chk("08:01 p. m.", normalizarHoraVoucher("08:01 p. m.") === "20:01:00");
  chk("12:30 am", normalizarHoraVoucher("12:30 am") === "00:30:00");
  chk("25:00 no es hora", normalizarHoraVoucher("25:00") === null);
  chk("texto no es hora", normalizarHoraVoucher("mañana") === null);

  const v = capturaDeRecarga({ fecha: "2026-09-13", hora: "08:01:57", tsMensaje: "2026-09-13T08:20:00-05:00" });
  chk("con hora impresa: exacta, no tope", v.fuente === "voucher" && !v.horaEsTope && v.capturado_en === new Date("2026-09-13T08:01:57-05:00").toISOString());
  const sinMsg = capturaDeRecarga({ fecha: "2026-09-13", hora: "08:01:57", tsMensaje: null });
  chk("sin mensaje cargado (el caso del panel) igual usa la hora impresa", sinMsg.fuente === "voucher");
  const imposible = capturaDeRecarga({ fecha: "2026-09-13", hora: "18:01", tsMensaje: "2026-09-13T08:20:00-05:00" });
  chk("hora impresa POSTERIOR al envío → mal leída, se cae al mensaje como tope", imposible.fuente === "mensaje" && imposible.horaEsTope);
  const otroDia = capturaDeRecarga({ fecha: "2026-09-13", hora: null, tsMensaje: "2026-09-15T10:00:00-05:00" });
  chk("mensaje de OTRO día no presta su hora", otroDia.fuente === "solo_fecha" && otroDia.capturado_en === null);
  const mismoDia = capturaDeRecarga({ fecha: "2026-09-13", hora: null, tsMensaje: "2026-09-13T10:00:00-05:00" });
  chk("mensaje del mismo día: tope, como antes", mismoDia.fuente === "mensaje" && mismoDia.horaEsTope);
}

console.log("\n3 · El juicio: lo que vio la pantalla, reproducido");
{
  // Ubicada a las 00:00 del 13/09, el check-in de las 05:25 queda como POSTERIOR.
  const r = evaluarLectura({
    kmVigente: 31265, kmNuevo: 29647, origenIA: true,
    refAnterior: { km: 29540, ts: new Date("2026-09-12T21:10:00-05:00").getTime(), horaExacta: true },
    refPosterior: { km: 29612, ts: new Date("2026-09-13T05:25:00-05:00").getTime(), horaExacta: true },
    ahora: new Date("2026-10-05T16:25:00-05:00"),
  });
  chk("REGRESIÓN: a las 00:00 sale «Incoherente con la lectura de las 05:25»", r.estado === "sospechosa" && /05:25/.test(r.motivo ?? ""));
}

console.log("\n4 · registrarLectura de punta a punta (cliente falso)");
{
  // (a) Con la hora del voucher: entre el check-in de las 05:25 y el check-out de las 21:05.
  const db = { vehiculos: [{ id: 7, kilometraje_actual: 31265 }], lecturas_odometro: historial() as Fila[] };
  const cap = capturaDeRecarga({ fecha: "2026-09-13", hora: "08:01:57", tsMensaje: null });
  const r = await registrarLectura(clienteFalso(db), {
    vehiculo_id: 7, km: 29647, fuente: "combustible", fecha: "2026-09-13",
    capturado_en: cap.capturado_en, horaEsTope: cap.horaEsTope,
  });
  chk("con la hora del voucher: aceptada", r.ok && r.estado === "aceptada", r.motivo ?? "");
  chk("no mueve el vigente (31,265 es mayor)", db.vehiculos[0].kilometraje_actual === 31265);

  // (b) Sin ninguna hora (solo fecha): se ubica en el hueco del día, no a las 00:00.
  const db2 = { vehiculos: [{ id: 7, kilometraje_actual: 31265 }], lecturas_odometro: historial() as Fila[] };
  const r2 = await registrarLectura(clienteFalso(db2), { vehiculo_id: 7, km: 29647, fuente: "combustible", fecha: "2026-09-13" });
  chk("solo fecha: aceptada", r2.ok && r2.estado === "aceptada", r2.motivo ?? "");
  const ins2 = db2.lecturas_odometro.find((f) => f.id === r2.lecturaId)!;
  const t2 = ins2?.capturado_en ? new Date(ins2.capturado_en).getTime() : NaN;
  chk("solo fecha: queda ANTES del check-out de las 21:05 y después del check-in",
    t2 < new Date("2026-09-13T21:05:00-05:00").getTime() && t2 > new Date("2026-09-13T05:25:00-05:00").getTime());
  chk("solo fecha: la nota dice que solo traía fecha", /solo traía fecha/.test(ins2?.motivo ?? ""), ins2?.motivo ?? "");
  chk("solo fecha: sigue en su día", ins2?.fecha === "2026-09-13");

  // (c) Lo que no se aflojó: un km que de verdad retrocede sigue yendo a revisión.
  const db3 = { vehiculos: [{ id: 7, kilometraje_actual: 31265 }], lecturas_odometro: historial() as Fila[] };
  const r3 = await registrarLectura(clienteFalso(db3), {
    vehiculo_id: 7, km: 29500, fuente: "combustible", fecha: "2026-09-13",
    capturado_en: new Date("2026-09-13T08:01:57-05:00").toISOString(), horaEsTope: false,
  });
  chk("retroceso real frente al check-in sigue siendo sospechoso", r3.estado === "sospechosa", r3.motivo ?? "");

  // (d) Y uno mayor que el check-out del mismo día, con hora exacta anterior a él, también.
  const db4 = { vehiculos: [{ id: 7, kilometraje_actual: 31265 }], lecturas_odometro: historial() as Fila[] };
  const r4 = await registrarLectura(clienteFalso(db4), {
    vehiculo_id: 7, km: 29900, fuente: "combustible", fecha: "2026-09-13",
    capturado_en: new Date("2026-09-13T08:01:57-05:00").toISOString(), horaEsTope: false,
  });
  chk("más km que el check-out posterior sigue siendo incoherente", r4.estado === "sospechosa" && /21:05/.test(r4.motivo ?? ""), r4.motivo ?? "");
}

console.log("\n5 · «Aceptar» la que ya quedó mal guardada (la fila real de la pantalla)");
{
  const db = {
    vehiculos: [{ id: 7, kilometraje_actual: 31265 }],
    lecturas_odometro: [
      ...historial(),
      { id: "s", vehiculo_id: 7, km: 29647, fecha: "2026-09-13", capturado_en: null,
        created_at: "2026-10-05T16:25:00-05:00", estado: "sospechosa", fuente: "combustible" },
    ] as Fila[],
  };
  const r = await aceptarLectura(clienteFalso(db), "s");
  const s = db.lecturas_odometro.find((f) => f.id === "s")!;
  const t = s.capturado_en ? new Date(s.capturado_en).getTime() : NaN;
  chk("se acepta", r.ok && s.estado === "aceptada");
  chk("se reubica DENTRO del 13/09, entre el check-in y el check-out (no contra el 05/10)",
    s.fecha === "2026-09-13" && t > new Date("2026-09-13T05:25:00-05:00").getTime() && t < new Date("2026-09-13T21:05:00-05:00").getTime(),
    s.capturado_en ?? "sin capturado_en");
}


console.log("\n6 · Corregir la HORA antes de aceptar (lo que pidió el dueño con la pantalla delante)");
{
  chk("capturaDeFechaHora: 08:01:57 del 13/09 → 13:01:57Z", capturaDeFechaHora("2026-09-13", "08:01:57") === "2026-09-13T13:01:57.000Z");
  chk("capturaDeFechaHora: hora inválida → null", capturaDeFechaHora("2026-09-13", "8 y media") === null);
  chk("horaLimaHms ida y vuelta", horaLimaHms(capturaDeFechaHora("2026-09-13", "08:01:57")) === "08:01:57");

  // El día real de la CTV-370: check-in 05:25 (29,612) y una foto de WhatsApp a las 17:53 (29,674).
  const dia = () => ({
    vehiculos: [{ id: 7, kilometraje_actual: 31265 }],
    lecturas_odometro: [
      ...historial().filter((f) => f.id !== "c"),
      lect("w", 29674, "2026-09-13", "2026-09-13T17:53:00-05:00", "2026-09-13T17:53:09-05:00", { fuente: "whatsapp_foto" }),
      { id: "s", vehiculo_id: 7, km: 29647, fecha: "2026-09-13", capturado_en: null,
        created_at: "2026-10-05T16:25:00-05:00", estado: "sospechosa", fuente: "combustible",
        motivo: "Incoherente con la lectura de las 05:25 (29,612 km), que es posterior" },
    ] as Fila[],
  });

  const db = dia();
  const r = await corregirHoraLectura(clienteFalso(db), "s", "08:01:57");
  const s = db.lecturas_odometro.find((f) => f.id === "s")!;
  chk("con la hora del voucher CUADRA", r.ok && r.cuadra === true, r.motivo ?? r.error ?? "");
  chk("guarda la hora tecleada tal cual", s.capturado_en === "2026-09-13T13:01:57.000Z");
  chk("NO la acepta: la decisión sigue siendo de la persona", s.estado === "sospechosa");
  chk("el motivo dice la hora y el veredicto nuevo", /08:01/.test(s.motivo) && /cuadra/.test(s.motivo), s.motivo);
  chk("no mueve el km vigente", db.vehiculos[0].kilometraje_actual === 31265);
  chk("la bandeja la clasifica como «lista para aceptar»", tipoDeRevision(s.motivo) === "lista_para_aceptar");

  const db2 = dia();
  const r2 = await corregirHoraLectura(clienteFalso(db2), "s", "19:00");
  chk("y la que no cuadra, como su problema real", tipoDeRevision(r2.motivo) === "retroceso");
  chk("una hora que no cuadra lo DICE (retrocede frente a las 17:53)", r2.ok && r2.cuadra === false && /17:53/.test(r2.motivo ?? ""), r2.motivo ?? "");

  const db3 = dia();
  const r3 = await corregirHoraLectura(clienteFalso(db3), "s", "mañana");
  chk("hora inválida: error y no toca nada", !r3.ok && db3.lecturas_odometro.find((f) => f.id === "s")!.capturado_en === null);

  const db4 = dia();
  const r4 = await aceptarLectura(clienteFalso(db4), "s", { hora: "08:01:57" });
  const s4 = db4.lecturas_odometro.find((f) => f.id === "s")!;
  chk("Aceptar con la hora tecleada: aceptada CON esa hora, sin reubicar",
    r4.ok && s4.estado === "aceptada" && s4.capturado_en === "2026-09-13T13:01:57.000Z" && /08:01/.test(s4.motivo), s4.motivo);

  const db5 = dia();
  const r5 = await aceptarLectura(clienteFalso(db5), "s", { hora: "99:99" });
  chk("Aceptar con hora inválida NO acepta", !r5.ok && db5.lecturas_odometro.find((f) => f.id === "s")!.estado === "sospechosa");

  const db6 = dia();
  await aceptarLectura(clienteFalso(db6), "s");
  const s6 = db6.lecturas_odometro.find((f) => f.id === "s")!;
  chk("Aceptar SIN hora sigue como antes: se reubica antes de las 17:53",
    s6.estado === "aceptada" && new Date(s6.capturado_en).getTime() < new Date("2026-09-13T17:53:00-05:00").getTime());
}

console.log("\n9 · El «KM menor» del Radar: contra las lecturas de la fecha del voucher, no contra el km de HOY");
{
  // Lo reportado: «muchas dan KM MENOR AL ACTUAL, y es correcto: revisamos los vouchers días después
  // y el km ya avanzó». El voucher del 13/09 08:01 (29,647 km) contra el vigente de HOY (31,265).
  const db = () => ({ vehiculos: [{ id: 7, kilometraje_actual: 31265 }], lecturas_odometro: historial() as Fila[] });
  const viejo = (km: number, vigente: number) => km < vigente; // la regla de antes (lib/radar/acciones.ts)
  chk("REGRESIÓN: la regla vieja acusaba al voucher del 13/09 porque HOY la unidad tiene 31,265", viejo(29647, 31265));
  const j = await juzgarKmDeRecarga(clienteFalso(db()), { vehiculo_id: 7, km: 29647, fecha: "2026-09-13", hora: "08:01:57" });
  chk("con las lecturas de SU fecha (entre 29,612 de las 05:25 y 29,790 de las 21:05) cuadra: sin aviso", j === null, j ?? "");
  const sinHora = await juzgarKmDeRecarga(clienteFalso(db()), { vehiculo_id: 7, km: 29647, fecha: "2026-09-13" });
  chk("sin hora (solo fecha) también cuadra: se ubica en el hueco del día", sinHora === null, sinHora ?? "");
  const retro = await juzgarKmDeRecarga(clienteFalso(db()), { vehiculo_id: 7, km: 29500, fecha: "2026-09-13", hora: "08:01:57" });
  chk("un retroceso DE VERDAD frente a la lectura anterior a su hora sí se acusa, y la nombra",
    !!retro && /ANTERIOR/.test(retro) && /05:25/.test(retro) && /112/.test(retro), retro ?? "");
  const mayor = await juzgarKmDeRecarga(clienteFalso(db()), { vehiculo_id: 7, km: 29900, fecha: "2026-09-13", hora: "08:01:57" });
  chk("mayor que la lectura POSTERIOR a su hora también (el odómetro no baja después)", !!mayor && /POSTERIOR/.test(mayor) && /21:05/.test(mayor), mayor ?? "");
  const ruido = await juzgarKmDeRecarga(clienteFalso(db()), { vehiculo_id: 7, km: 29600, fecha: "2026-09-13", hora: "08:01:57" });
  chk("12 km menos que la de las 05:25 es ruido de lectura (tolerancia de evaluarLectura): no frena la carga", ruido === null, ruido ?? "");
  const vacia = await juzgarKmDeRecarga(clienteFalso({ vehiculos: [{ id: 7, kilometraje_actual: 31265 }], lecturas_odometro: [] }),
    { vehiculo_id: 7, km: 29647, fecha: "2026-09-13", hora: "08:01:57" });
  chk("sin ninguna lectura con qué comparar, cae al vigente y lo DICE", !!vacia && /no hay lecturas de esa fecha/.test(vacia), vacia ?? "");
  chk("sin datos no acusa", (await juzgarKmDeRecarga(clienteFalso(db()), { vehiculo_id: 7, km: 0, fecha: "2026-09-13" })) === null);
  // El juicio puro, directo.
  const t = (h: string) => new Date(`2026-09-13T${h}-05:00`).getTime();
  chk("puro: entre la anterior y la posterior, nada", kmFueraDeSuMomento(29647, { kmVigente: 31265, anterior: { km: 29612, ts: t("05:25:00") }, posterior: { km: 29790, ts: t("21:05:00") } }) === null);
  chk("puro: la más antigua de la serie (solo posterior, y menor que ella) no se acusa",
    kmFueraDeSuMomento(29000, { kmVigente: 31265, anterior: null, posterior: { km: 29612, ts: t("05:25:00") } }) === null);
}

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
