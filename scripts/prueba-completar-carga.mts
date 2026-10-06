// Pruebas de la COLA de cargas que registró la factura sin su voucher, y de cómo las completa una
// persona (lib/combustible/completar-carga.ts, puro). NO tocan la base.
// Uso:  npx tsx scripts/prueba-completar-carga.mts   (sale con código 1 si algo falla)
//
// LO PLANTEÓ EL DUEÑO: «cuando el Radar IA falla —WhatsApp elimina la línea, o se queda sin saldo de
// API— la factura registrará el combustible al día siguiente, y el operador deberá registrar a mano el
// odómetro y reconfirmar la fecha del despacho. Para que no se escape ninguna.» Fija:
//
//   1. el caso con la forma real (CWQ400, F882-0124552, emitida el 23/09, despacho el 22/09): entra a
//      la cola, se completa con el km del voucher, la plata no se toca;
//   2. qué entra a la cola y qué no, y la ventana (lo viejo se cuenta, no desaparece);
//   3. la fecha: lo imposible se bloquea, lo raro se pregunta;
//   4. el odómetro: tecleado, «no hay», o el que la carga ya tenía;
//   5. la hora y el conductor, opcionales;
//   6. el rango de km de ese día (referencia, nunca bloquea);
//   7. EL CICLO: completada sale de la cola, «Moverlas a la fecha del despacho» no la vuelve a correr,
//      y si el Radar lee el voucher después, todavía la reconoce para fusionarla;
//   8. invariantes por barrido.
import {
  colaPorCompletar, origenesDeCargas, planDeCompletar, porQueFecha, rangoKmDelDia, kmFueraDelRango,
  faltaOdometroDeFactura, fechaEsDato, etiquetaLectura, KM_MAXIMO,
  type CargaDeFacturaBD, type OrigenDeCarga, type FacturaConCargas, type LecturaOdometroBD, type EntradaCompletar,
} from "../lib/combustible/completar-carga";
import {
  observacionCargaDeFactura, esCargaDeFactura, esCargaFusionada, esCargaCompletada, MARCA_COMPLETADA_A_MANO,
  DIAS_REGISTRO_AUTOMATICO,
} from "../lib/combustible/factura-lineas";
import { cargasPorMover, notaFechaDespacho, sumarDias, MAX_DESFASE } from "../lib/combustible/desfase-factura";
import { planDeFusion, yaEstaEnCombustible } from "../lib/radar/fusion-factura";
import { buscarCargaRegistrada } from "../lib/radar/album-recargas";
import { toleranciaRetroceso } from "../lib/odometro";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const HOY = "2026-09-25";
const OBS_61 = observacionCargaDeFactura("F882-0124552", "V97T-00001443", notaFechaDespacho("2026-09-23", 1));
const CARGA_61: CargaDeFacturaBD = {
  id: 61, fecha: "2026-09-22", kilometraje: 0, total: 47.31, galones: 6.266, unidad: "galones", tipo_combustible: "glp",
  conductor: null, observaciones: OBS_61, placa: "CWQ400", vehiculo: { flota: "propia", id: 12 },
};
const FACTURA_61: FacturaConCargas = {
  factura_id: 501, serie: "F882", numero: "0124552", fecha_emision: "2026-09-23", recibido_en: "2026-09-23T09:30:00Z",
  lineas: [{ n: 1, fecha: "2026-09-23", fecha_origen: "emision", tipo_combustible: "glp", nota_despacho: "V97T-00001443" }],
  conciliacion: [{ n: 1, codigo: "registrar", combustible_id: 61, fecha_origen: "emision", desfase: { emision: "2026-09-23", dias: 1 } }],
};
const ORIGENES = origenesDeCargas([FACTURA_61]);
const ORIGEN_61 = ORIGENES.get(61)!;
const aplicar = (c: CargaDeFacturaBD, patch: Record<string, unknown>): CargaDeFacturaBD => ({ ...c, ...(patch as Partial<CargaDeFacturaBD>) });
const ENT = (o: Partial<EntradaCompletar> = {}): EntradaCompletar => ({ km: 11549, sinOdometro: false, fecha: "2026-09-22", ...o });

// ── 1. El caso con la forma real ─────────────────────────────────────────────
console.log("\n1. La carga #61 que registró la factura F882-0124552 sin su voucher");
{
  chk("la factura que la registró se encuentra (registrar → combustible_id)", !!ORIGEN_61 && ORIGEN_61.comprobante === "F882-0124552" && ORIGEN_61.fecha_emision === "2026-09-23");
  const { cola } = colaPorCompletar([CARGA_61], ORIGENES, HOY);
  chk("entra a la cola: le falta el odómetro Y la fecha es deducida", cola.length === 1 && cola[0].falta_km && cola[0].falta_fecha);
  chk("dice de dónde salió la fecha (emitida el 23/09, un día después del despacho)", /23\/09\/2026/.test(cola[0].por_que_fecha) && /1 día/.test(cola[0].por_que_fecha), cola[0].por_que_fecha);
  chk("trae el comprobante y la nota de despacho, para buscar el voucher en WhatsApp", cola[0].comprobante === "F882-0124552" && cola[0].nota_despacho === "V97T-00001443");
  const p = planDeCompletar(CARGA_61, ORIGEN_61, ENT(), HOY);
  chk("se puede completar", p.puede && p.codigo === "completable", p.detalle);
  chk("el odómetro va a la carga", p.patch.kilometraje === 11549);
  chk("…y a lecturas_odometro (registrarLectura), con la fecha del despacho", p.lectura?.km === 11549 && p.lectura?.fecha === "2026-09-22");
  chk("la fecha confirmada igual a la que tenía no se reescribe", !("fecha" in p.patch));
  const obs = String(p.patch.observaciones);
  chk("queda marcada como completada a mano, y sigue siendo una carga de factura", esCargaCompletada(obs) && esCargaDeFactura(obs), obs);
  chk("deja de decir «sin odómetro»", !/ · sin odómetro\b/.test(obs));
  chk("la marca dice el km y que la fecha se confirmó", obs.includes("11,549 km") && /fecha del despacho confirmada \(22\/09\/2026\)/.test(obs), obs);
  chk("la PLATA no se toca: ni galones, ni precio, ni importe, ni tipo", !["galones", "precio_galon", "total", "tipo_combustible", "unidad"].some((k) => k in p.patch));
  chk("no pide confirmación aparte (nada raro)", !p.pideConfirmar && !p.cruzaMes && p.avisos.length === 0, p.avisos.join(" | "));
}

// ── 2. Qué entra a la cola ───────────────────────────────────────────────────
console.log("\n2. Qué entra a la cola, y la ventana");
{
  const base = (id: number, extra: Partial<CargaDeFacturaBD> = {}): CargaDeFacturaBD => ({ ...CARGA_61, id, ...extra });
  const fusionada = base(70, { observaciones: `${OBS_61} · 🔗 Fusionada con el voucher del Radar` });
  const completada = base(71, { observaciones: `${OBS_61} · ✍ ${MARCA_COMPLETADA_A_MANO}: odómetro 11,549 km del voucher` });
  const delRadar = base(72, { observaciones: "Radar IA · Grupo · ALEX · Comprobante V70S-1" });
  const aMano = base(73, { observaciones: "Cargado en grifo" });
  const orig = (id: number, fecha_origen: OrigenDeCarga["fecha_origen"]): [number, OrigenDeCarga] => [id, { ...ORIGEN_61, fecha_origen }];
  const conKmLinea = base(74, { kilometraje: 11549 });
  const conKmEmision = base(75, { kilometraje: 11549 });
  const sinKmManual = base(76);
  const sinFactura = base(77);
  const origenes = new Map<number, OrigenDeCarga>([orig(74, "linea"), orig(75, "emision"), orig(76, "manual")]);
  const { cola } = colaPorCompletar([fusionada, completada, delRadar, aMano, conKmLinea, conKmEmision, sinKmManual, sinFactura], origenes, HOY);
  const ids = cola.map((x) => x.carga.id);
  chk("una FUSIONADA no entra (el voucher ya la completó)", !ids.includes(70));
  chk("una COMPLETADA no entra", !ids.includes(71));
  chk("una del Radar o una a mano no entran (no son de factura)", !ids.includes(72) && !ids.includes(73));
  chk("con km y la fecha de la línea: no le falta nada → no entra", !ids.includes(74));
  chk("con km pero la fecha deducida de la emisión → entra, solo por la fecha", ids.includes(75) && !cola.find((x) => x.carga.id === 75)!.falta_km && cola.find((x) => x.carga.id === 75)!.falta_fecha);
  chk("sin km y la fecha que eligió una persona → entra, solo por el km", ids.includes(76) && cola.find((x) => x.carga.id === 76)!.falta_km && !cola.find((x) => x.carga.id === 76)!.falta_fecha);
  const sf = cola.find((x) => x.carga.id === 77)!;
  chk("sin su factura: se pide la fecha (no se sabe de dónde salió) y lo dice", sf.falta_fecha && /No se encontró la factura/.test(sf.por_que_fecha));
  chk("…y el comprobante y la nota salen de la observación de la carga", sf.comprobante === "F882-0124552" && sf.nota_despacho === "V97T-00001443", `${sf.comprobante} ${sf.nota_despacho}`);
  // La frase describe la fecha que la carga tiene HOY: «Moverlas a la fecha del despacho» pudo correrla
  // después de registrada, con la conciliación todavía diciendo «emisión» sin desfase.
  const sinDesfase: OrigenDeCarga = { ...ORIGEN_61, dias_corridos: 0 };
  chk("movida después por «Moverlas»: la frase dice el día de diferencia que se ve", /1 día\(s\) después del despacho/.test(porQueFecha({ fecha: "2026-09-22" }, sinDesfase)));
  chk("con la fecha de emisión tal cual: lo dice", /Es la fecha de EMISIÓN/.test(porQueFecha({ fecha: "2026-09-23" }, sinDesfase)));
  chk("con otra fecha que alguien puso: pide confirmarla", /confírmala contra el voucher/.test(porQueFecha({ fecha: "2026-09-10" }, sinDesfase)));
  chk("la línea y la persona se nombran", /trae la línea/.test(porQueFecha(CARGA_61, { ...ORIGEN_61, fecha_origen: "linea" })) &&
    /eligió una persona/.test(porQueFecha(CARGA_61, { ...ORIGEN_61, fecha_origen: "manual" })));
  chk("fechaEsDato: la línea y la persona sí; emisión, consolidada y nada, no",
    fechaEsDato("linea") && fechaEsDato("manual") && !fechaEsDato("emision") && !fechaEsDato("consolidada") && !fechaEsDato(null));

  // La ventana: la de hace 45 días se pide; la de hace 46 se CUENTA aparte, no desaparece.
  const borde = base(80, { fecha: sumarDias(HOY, -DIAS_REGISTRO_AUTOMATICO) });
  const vieja = base(81, { fecha: sumarDias(HOY, -DIAS_REGISTRO_AUTOMATICO - 1) });
  const nueva = base(82, { fecha: "2026-09-24" });
  const r = colaPorCompletar([nueva, vieja, borde], new Map(), HOY);
  chk(`la de hace ${DIAS_REGISTRO_AUTOMATICO} días se pide; la de hace ${DIAS_REGISTRO_AUTOMATICO + 1} va a «antiguas»`,
    r.cola.map((x) => x.carga.id).join() === "80,82" && r.antiguas.map((x) => x.carga.id).join() === "81", `${r.cola.map((x) => x.carga.id)} | ${r.antiguas.map((x) => x.carga.id)}`);
  chk("la cola va del despacho más viejo al más nuevo", r.cola[0].carga.id === 80);
  chk("una carga repetida en la entrada sale una sola vez", colaPorCompletar([CARGA_61, CARGA_61], ORIGENES, HOY).cola.length === 1);

  // origenesDeCargas: en una pasada posterior la misma línea queda ya_registrada (por «documento»).
  const pasada2: FacturaConCargas = { ...FACTURA_61, conciliacion: [{ n: 1, codigo: "ya_registrada", casa_con: 61 }] };
  const o2 = origenesDeCargas([pasada2]).get(61);
  chk("ya_registrada → casa_con; el origen de una línea vieja sin fecha_origen se infiere (emisión)", o2?.fecha_origen === "emision", String(o2?.fecha_origen));
  const otra: FacturaConCargas = { ...FACTURA_61, factura_id: 999, serie: "F882", numero: "9", conciliacion: [{ n: 1, codigo: "registrar", combustible_id: 61 }] };
  chk("la primera factura que nombra a una carga gana", origenesDeCargas([FACTURA_61, otra]).get(61)?.factura_id === 501);
  chk("líneas sin carga (revisar, en espera) no inventan nada", origenesDeCargas([{ ...FACTURA_61, conciliacion: [{ n: 1, codigo: "revisar" }] }]).size === 0);
  const tardia = origenesDeCargas([{ ...FACTURA_61, fecha_emision: "2026-09-30", recibido_en: "2026-10-01T21:47:00Z" }]).get(61);
  chk("un cierre de mes (generada después de su fecha) se marca", tardia?.generada_despues === true);
}

// ── 3. La fecha ──────────────────────────────────────────────────────────────
console.log("\n3. La fecha: lo imposible se bloquea, lo raro se pregunta");
{
  const despues = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ fecha: "2026-09-24" }), HOY);
  chk("posterior a la emisión de su factura (23/09): se BLOQUEA", !despues.puede && despues.codigo === "despues_de_emision", despues.detalle);
  const futura = planDeCompletar(CARGA_61, null, ENT({ fecha: "2026-09-26" }), HOY);
  chk("posterior a hoy: se bloquea (aun sin factura)", !futura.puede && futura.codigo === "fecha_futura");
  chk("sin fecha, o con una que no existe (30/02): falta_fecha",
    planDeCompletar(CARGA_61, ORIGEN_61, ENT({ fecha: null }), HOY).codigo === "falta_fecha" &&
    planDeCompletar(CARGA_61, ORIGEN_61, ENT({ fecha: "2026-02-30" }), HOY).codigo === "falta_fecha" &&
    planDeCompletar(CARGA_61, ORIGEN_61, ENT({ fecha: "22/09/2026" }), HOY).codigo === "falta_fecha");
  const igualEmision = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ fecha: "2026-09-23" }), HOY);
  chk("el mismo día de la emisión sí se puede (una factura emitida el día del despacho)", igualEmision.puede && igualEmision.patch.fecha === "2026-09-23");
  const corregida = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ fecha: "2026-09-21" }), HOY);
  chk("corregir a dos días antes de la emisión: se escribe, sin preguntar (cabe en el desfase)", corregida.puede && corregida.patch.fecha === "2026-09-21" && !corregida.pideConfirmar);
  chk("…el cambio se nombra de qué a qué, y la marca lo dice", corregida.cambios.some((c) => c.campo === "Fecha" && /22\/09\/2026/.test(c.de) && /21\/09\/2026/.test(c.a)) &&
    /corregida a 21\/09\/2026 \(tenía 22\/09\/2026\)/.test(String(corregida.patch.observaciones)));
  chk("…y la lectura del odómetro va con la fecha corregida", corregida.lectura?.fecha === "2026-09-21");
  const lejos = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ fecha: sumarDias("2026-09-23", -(MAX_DESFASE + 1)) }), HOY);
  chk(`más de ${MAX_DESFASE} días antes de la emisión: se puede, pero se PREGUNTA`, lejos.puede && lejos.pideConfirmar && lejos.avisos.some((a) => /desfase de facturación/.test(a)), lejos.avisos.join(" | "));
  const finDeMes: CargaDeFacturaBD = { ...CARGA_61, fecha: "2026-10-01" };
  const origenOct: OrigenDeCarga = { ...ORIGEN_61, fecha_emision: "2026-10-02" };
  const mes = planDeCompletar(finDeMes, origenOct, ENT({ fecha: "2026-09-30" }), "2026-10-05");
  chk("cambia de mes: se puede, se PREGUNTA, y dice que mueve el gasto en Finanzas", mes.puede && mes.cruzaMes && mes.pideConfirmar && mes.avisos.some((a) => /Finanzas/.test(a)));
}

// ── 4. El odómetro ───────────────────────────────────────────────────────────
console.log("\n4. El odómetro");
{
  chk("sin km y sin marcar «no hay»: falta_km", planDeCompletar(CARGA_61, ORIGEN_61, ENT({ km: null }), HOY).codigo === "falta_km");
  for (const malo of [0, -5, Number.NaN, KM_MAXIMO + 1]) {
    chk(`«${malo}» no es un odómetro`, planDeCompletar(CARGA_61, ORIGEN_61, ENT({ km: malo }), HOY).codigo === "km_invalido");
  }
  chk("un texto con separadores no se adivina («29,647»): se pide el número limpio",
    planDeCompletar(CARGA_61, ORIGEN_61, { ...ENT(), km: "29,647" as unknown as number }, HOY).codigo === "km_invalido");
  const sin = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ km: null, sinOdometro: true }), HOY);
  chk("«no hay odómetro»: se puede, sin lectura y sin km en la carga", sin.puede && sin.lectura === null && !("kilometraje" in sin.patch));
  const obsSin = String(sin.patch.observaciones);
  chk("…sigue diciendo «sin odómetro» (el rendimiento lo lee así) y la marca dice que no se pudo obtener",
    / · sin odómetro\b/.test(obsSin) && /no hay odómetro \(no se pudo obtener\)/.test(obsSin) && esCargaCompletada(obsSin), obsSin);
  chk("…y avisa que ese tramo no se podrá medir", sin.avisos.some((a) => /no se puede medir/.test(a)));
  const ambos = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ km: 11549, sinOdometro: true }), HOY);
  chk("«no hay» manda sobre un número a medio teclear", ambos.puede && ambos.lectura === null && !("kilometraje" in ambos.patch));
  const conKm: CargaDeFacturaBD = { ...CARGA_61, kilometraje: 11549 };
  const conservar = planDeCompletar(conKm, ORIGEN_61, ENT({ km: null, sinOdometro: true }), HOY);
  chk("«no hay» nunca BORRA un km que la carga ya tenía", conservar.puede && !("kilometraje" in conservar.patch) && /odómetro 11,549 km/.test(String(conservar.patch.observaciones)));
  const confirmar = planDeCompletar(conKm, ORIGEN_61, ENT({ km: null }), HOY);
  chk("con km ya puesto, basta confirmar la fecha: no se pide otro km ni se registra otra lectura", confirmar.puede && confirmar.lectura === null && !("kilometraje" in confirmar.patch));
  const mismo = planDeCompletar(conKm, ORIGEN_61, ENT({ km: 11549 }), HOY);
  chk("el mismo km tecleado otra vez no escribe nada ni duplica la lectura", mismo.puede && mismo.lectura === null && !("kilometraje" in mismo.patch));
  const otro = planDeCompletar(conKm, ORIGEN_61, ENT({ km: 11560 }), HOY);
  chk("otro km sobre uno que ya estaba: se reemplaza, DICIÉNDOLO", otro.patch.kilometraje === 11560 && otro.lectura?.km === 11560 && otro.avisos.some((a) => /ya tenía 11,549 km/.test(a)));
  chk("un km con decimales se redondea (un odómetro no los tiene)", planDeCompletar(CARGA_61, ORIGEN_61, ENT({ km: 11549.6 }), HOY).patch.kilometraje === 11550);
}

// ── 5. La hora y el conductor ────────────────────────────────────────────────
console.log("\n5. La hora del voucher y el conductor, opcionales");
{
  const h = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ hora: "17:08" }), HOY);
  chk("con la hora del voucher, la lectura la lleva (se ubica en su día)", h.lectura?.hora === "17:08" && /hora 17:08/.test(String(h.patch.observaciones)));
  chk("«5:08 pm» se entiende como 17:08 (la misma lectura de hora que el Radar)", planDeCompletar(CARGA_61, ORIGEN_61, ENT({ hora: "5:08 pm" }), HOY).lectura?.hora === "17:08");
  chk("una hora que no es hora se dice, no se ignora", planDeCompletar(CARGA_61, ORIGEN_61, ENT({ hora: "25:99" }), HOY).codigo === "hora_invalida");
  chk("sin hora, la lectura va sin hora", planDeCompletar(CARGA_61, ORIGEN_61, ENT({ hora: "" }), HOY).lectura?.hora === null);
  const c = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ conductor: "  Grover Gomez " }), HOY);
  chk("el conductor se escribe si la carga no lo tiene", c.patch.conductor === "Grover Gomez");
  chk("…y no pisa uno que alguien ya escribió", !("conductor" in planDeCompletar({ ...CARGA_61, conductor: "Otro" }, ORIGEN_61, ENT({ conductor: "Grover" }), HOY).patch));
}

// ── 6. El rango de km del día ────────────────────────────────────────────────
console.log("\n6. El rango de km de ese día (referencia)");
{
  const L = (km: number, fecha: string, hora: string | null, extra: Partial<LecturaOdometroBD> = {}): LecturaOdometroBD => ({
    km, fecha, capturado_en: hora ? `${fecha}T${hora}:00-05:00` : null, created_at: "2026-10-05T12:00:00Z", estado: "aceptada", ...extra,
  });
  const lecturas: LecturaOdometroBD[] = [
    L(11500, "2026-09-21", "20:10", { momento: "checkout" }),
    L(11512, "2026-09-22", "05:25", { momento: "checkin" }),
    L(11600, "2026-09-22", "19:40", { momento: "checkout" }),
    L(11605, "2026-09-23", "05:20", { momento: "checkin" }),
    L(99999, "2026-09-22", "12:00", { estado: "anulada" }),
    L(11000, "2026-09-22", "13:00", { estado: "sospechosa" }),
    L(11590, "2026-09-22", null, { fuente: "combustible" }),
  ];
  const r = rangoKmDelDia(lecturas, "2026-09-22");
  chk("sin la hora de la carga: antes = check-out del día anterior, después = check-in del siguiente",
    r.antes?.km === 11500 && r.despues?.km === 11605, `${r.antes?.km} / ${r.despues?.km}`);
  chk("las del mismo día se enseñan aparte (no acotan sin hora)", r.delDia.map((x) => x.km).sort().join() === "11512,11590,11600");
  chk("las anuladas y las sospechosas no cuentan", ![99999, 11000].some((k) => [r.antes?.km, r.despues?.km, ...r.delDia.map((x) => x.km)].includes(k)));
  chk("cada lectura dice de dónde salió", r.antes?.etiqueta === "check-out del conductor" && r.despues?.etiqueta === "check-in del conductor" &&
    etiquetaLectura({ fuente: "whatsapp_foto" }) === "Radar IA" && etiquetaLectura({ fuente: "combustible" }) === "carga de combustible");
  const conHora = rangoKmDelDia(lecturas, "2026-09-22", "17:08");
  chk("con la hora del voucher (17:08): antes = check-in 05:25, después = check-out 19:40",
    conHora.antes?.km === 11512 && conHora.despues?.km === 11600, `${conHora.antes?.km} / ${conHora.despues?.km}`);
  chk("…y la de solo fecha del mismo día sigue sin ubicarse", conHora.delDia.map((x) => x.km).join() === "11590");
  chk("dentro del rango: nada", kmFueraDelRango(11549, r) === null);
  chk("más que la lectura POSTERIOR: lo dice (el odómetro no baja)", /MÁS que la lectura posterior/.test(kmFueraDelRango(11606, r) ?? ""));
  const tol = toleranciaRetroceso(11500);
  chk(`menos que la ANTERIOR dentro del ruido (${tol} km): nada; más allá, lo dice`,
    kmFueraDelRango(11500 - tol, r) === null && /MENOS que la lectura anterior/.test(kmFueraDelRango(11500 - tol - 1, r) ?? ""));
  chk("con hora, el rango se estrecha: 11,601 ya es más que el check-out de las 19:40", kmFueraDelRango(11601, conHora) != null && kmFueraDelRango(11601, r) === null);
  chk("sin lecturas cerca: nada que decir", kmFueraDelRango(11549, rangoKmDelDia([], "2026-09-22")) === null);
  const p = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ km: 11700 }), HOY, r);
  chk("un km fuera del rango NO bloquea: avisa que la lectura quedará por revisar", p.puede && p.avisos.some((a) => /por revisar/.test(a)), p.avisos.join(" | "));
}

// ── 7. El ciclo ──────────────────────────────────────────────────────────────
console.log("\n7. Después de completarla");
{
  const p = planDeCompletar(CARGA_61, ORIGEN_61, ENT({ hora: "17:08" }), HOY);
  const completa = aplicar(CARGA_61, p.patch);
  chk("sale de la cola", colaPorCompletar([completa], ORIGENES, HOY).cola.length === 0);
  chk("y del aviso del historial de Combustible", faltaOdometroDeFactura(CARGA_61, HOY) && !faltaOdometroDeFactura(completa, HOY));
  chk("completarla otra vez no hace nada (ya_completada)", planDeCompletar(completa, ORIGEN_61, ENT(), HOY).codigo === "ya_completada");

  // «Moverlas a la fecha del despacho» no corre una fecha que confirmó una persona, aunque coincida con
  // la emisión. Una factura emitida el MISMO día del despacho, completada con esa fecha:
  const mismaFecha: CargaDeFacturaBD = { ...CARGA_61, id: 90, fecha: "2026-09-23", observaciones: observacionCargaDeFactura("F882-0124552", "V97T-00001443") };
  const fact90: FacturaConCargas = { ...FACTURA_61, conciliacion: [{ n: 1, codigo: "registrar", combustible_id: 90, fecha_origen: "emision" }] };
  const p90 = planDeCompletar(mismaFecha, origenesDeCargas([fact90]).get(90)!, ENT({ fecha: "2026-09-23" }), HOY);
  const c90 = aplicar(mismaFecha, p90.patch);
  const cargas = (c: CargaDeFacturaBD) => new Map([[c.id, { id: c.id, fecha: c.fecha, observaciones: c.observaciones, total: c.total, placa: c.placa }]]);
  chk("ANTES de completarla, «Moverlas» la proponía (lleva la fecha de emisión)", cargasPorMover([fact90], cargas(mismaFecha), 1).length === 1);
  chk("DESPUÉS, ya no: la fecha la confirmó una persona", cargasPorMover([fact90], cargas(c90), 1).length === 0);

  // Si el Radar vuelve y lee el voucher: sigue siendo una carga de factura sin fusionar → se FUSIONA.
  const cand = [{ id: 61, fecha: completa.fecha, total: completa.total, observaciones: completa.observaciones, misma_unidad: true }];
  const v = yaEstaEnCombustible({ fecha: "2026-09-22", comprobante: "V97T-00001443", monto: 47.31 }, cand);
  chk("el Radar todavía la reconoce para FUSIONARLA (no la registra otra vez)", v.codigo === "fusionar", v.codigo);
  chk("…por la nota de despacho, aunque la fecha confirmada difiera de la del voucher",
    buscarCargaRegistrada({ fecha: "2026-09-19", comprobante: "V97T-00001443", monto: 47.31 }, cand)?.por === "comprobante");
  const fusion = planDeFusion({ id: 61, fecha: completa.fecha, total: 47.31, galones: 6.266, kilometraje: Number(completa.kilometraje), conductor: null, grifo: null, observaciones: completa.observaciones },
    { fecha: "2026-09-21", kilometraje: 11550, conductor: "Grover", grifo: null, comprobante: "V97T-00001443", cantidad: 6.266, monto: 47.31 });
  chk("al fusionarla: el km que tecleó la persona se queda (y se avisa)", fusion.puede && !("kilometraje" in fusion.patch) && fusion.avisos.some((a) => /alguien lo escribió/.test(a)));
  chk("…y si el voucher dice otra fecha, el cambio se nombra «confirmada a mano», no «emisión»",
    fusion.cambios.some((c) => c.campo === "Fecha" && /confirmada a mano/.test(c.de)) && fusion.avisos.some((a) => /la confirmó una persona/.test(a)));
  const fusionada = aplicar(completa, fusion.patch);
  chk("fusionada después de completada: queda con las dos marcas", esCargaFusionada(fusionada.observaciones) && esCargaCompletada(fusionada.observaciones));
}

// ── 8. Invariantes por barrido ───────────────────────────────────────────────
console.log("\n8. Invariantes por barrido");
{
  const PLATA = ["galones", "precio_galon", "total", "tipo_combustible", "unidad"];
  const kms: (number | null)[] = [null, 11549, 0, Number.NaN, 11560];
  const fechas = [null, "2026-09-22", "2026-09-21", "2026-09-17", "2026-09-23", "2026-09-24", "2026-09-30", "2026-08-31"];
  const horas = [null, "17:08", "99:99"];
  const kmCarga = [0, 11549];
  const origenes: (OrigenDeCarga | null)[] = [null, ORIGEN_61, { ...ORIGEN_61, fecha_origen: "linea" }, { ...ORIGEN_61, fecha_origen: "manual" }, { ...ORIGEN_61, fecha_origen: "consolidada" }];
  let n = 0, pueden = 0, plata = 0, marca = 0, lectura = 0, fechaMala = 0, confirma = 0, vacio = 0, sinOdo = 0, mes = 0;
  for (const km of kms) for (const so of [false, true]) for (const f of fechas) for (const h of horas) for (const kc of kmCarga) for (const o of origenes) {
    n++;
    const c: CargaDeFacturaBD = { ...CARGA_61, kilometraje: kc };
    const p = planDeCompletar(c, o, { km, sinOdometro: so, fecha: f, hora: h }, HOY);
    if (!p.puede) { if (Object.keys(p.patch).length || p.lectura) vacio++; continue; }
    pueden++;
    if (PLATA.some((k) => k in p.patch)) plata++;
    const obs = String(p.patch.observaciones ?? "");
    if (!esCargaCompletada(obs) || !esCargaDeFactura(obs)) marca++;
    if ((p.lectura != null) !== ("kilometraje" in p.patch) || (p.lectura && p.lectura.km !== p.patch.kilometraje)) lectura++;
    const fin = String(p.patch.fecha ?? c.fecha);
    if (fin > HOY || (o?.fecha_emision && fin > o.fecha_emision)) fechaMala++;
    if (p.pideConfirmar && !p.avisos.length) confirma++;
    const kmFinal = p.patch.kilometraje ?? (kc > 0 ? kc : null);
    if ((kmFinal != null) === / · sin odómetro\b/.test(obs)) sinOdo++;
    if (p.cruzaMes !== (!!p.patch.fecha && String(p.patch.fecha).slice(0, 7) !== c.fecha.slice(0, 7))) mes++;
  }
  chk(`(${n} combinaciones) la plata de la factura no se toca NUNCA`, plata === 0, String(plata));
  chk("toda carga completada queda marcada y sigue siendo de factura", marca === 0, String(marca));
  chk("hay lectura de odómetro ⟺ cambia el km de la carga, y es el mismo número", lectura === 0, String(lectura));
  chk("ninguna fecha final posterior a hoy ni a la emisión de su factura", fechaMala === 0, String(fechaMala));
  chk("toda pregunta lleva su porqué", confirma === 0, String(confirma));
  chk("un plan que no se puede no escribe nada", vacio === 0, String(vacio));
  chk("«sin odómetro» desaparece de la nota ⟺ la carga queda con km", sinOdo === 0, String(sinOdo));
  chk("cruzaMes ⟺ la fecha cambia de mes", mes === 0, String(mes));
  // El corolario: un motor que no dejara completar nunca cumpliría todo lo anterior de forma trivial.
  chk("y SÍ se completa en la mayoría de las combinaciones válidas", pueden > n / 5, `${pueden} de ${n}`);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
