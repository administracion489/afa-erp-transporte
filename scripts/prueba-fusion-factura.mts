// Pruebas de la FUSIÓN del voucher del Radar con la carga que registró la factura. NO tocan la base:
// datos en memoria contra lib/radar/fusion-factura.ts (puro) y los motores que leen la carga después.
// Uso:  npx tsx scripts/prueba-fusion-factura.mts   (sale con código 1 si algo falla)
//
// EL CASO REAL (Radar IA → Combustible, 22/09/2026): CWQ400, GLP 6.266 gal, S/ 47.31, voucher
// V97T-00001443, conductor Grover Einner Gomez Mozo, odómetro 11,549. La factura F882-0124552
// (emitida el 23/09) ya la había registrado como carga #61, con la fecha de emisión y sin odómetro, y
// el Radar decía «descarta esta fila». Fija:
//
//   1. el caso real: la carga toma del voucher la fecha del despacho, el km, el conductor y la nota;
//   2. lo que NO se fusiona, cada uno con su motivo;
//   3. lo que una persona ya escribió no se pisa, y la plata es siempre la de la factura;
//   4. idempotente;
//   5. después de fusionar: la conciliación la sigue encontrando, el Radar la reconoce por la nota,
//      y «Moverlas a la fecha del despacho» no la toca;
//   6. invariantes por barrido;
//   7. EL ORDEN AL REVÉS (lo preguntó el dueño: «¿primero el Radar y después las facturas?»): el Radar
//      lee el voucher, la factura registra la misma carga DESPUÉS —porque la recarga del Radar quedó con
//      un importe mal leído y no casó con su línea— y la persona corrige y pulsa «Registrar». Antes ese
//      botón insertaba sin mirar: el mismo despacho dos veces. Ahora se vuelve a preguntar al registrar;
//   8. dos recargas del Radar por revisar que podrían ser la misma línea: la factura ya no la registra.
import {
  planDeFusion, yaEstaEnCombustible, preguntaAntesDeRegistrar,
  type CargaDeFactura, type VoucherAFusionar,
} from "../lib/radar/fusion-factura";
import type { CargaRegistrada } from "../lib/radar/album-recargas";
import {
  observacionCargaDeFactura, esCargaDeFactura, esCargaFusionada, planDeLinea, MARCA_CARGA_DE_FACTURA,
  type LineaFactura, type CargaExistente,
} from "../lib/combustible/factura-lineas";
import { cargasPorMover, lineasAlDespacho, MAX_DESFASE, sumarDias } from "../lib/combustible/desfase-factura";
import { buscarCargaRegistrada } from "../lib/radar/album-recargas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const CARGA_61: CargaDeFactura = {
  id: 61, fecha: "2026-09-23", total: 47.31, galones: 6.266, kilometraje: 0, conductor: null, grifo: "COESTI S.A.",
  observaciones: observacionCargaDeFactura("F882-0124552", null), tanque_lleno: null,
};
const VOUCHER: VoucherAFusionar = {
  fecha: "2026-09-22", kilometraje: 11549, conductor: "Grover Einner Gomez Mozo", grifo: null,
  comprobante: "V97T-00001443", cantidad: 6.266, monto: 47.31, tanqueLleno: true, tanqueFuente: "operador",
};
const aplicar = (c: CargaDeFactura, patch: Record<string, unknown>): CargaDeFactura => ({ ...c, ...(patch as Partial<CargaDeFactura>) });

// ── 1. El caso real ──────────────────────────────────────────────────────────
console.log("\n1. La carga #61 de la factura F882-0124552 y el voucher V97T-00001443");
const p = planDeFusion(CARGA_61, VOUCHER);
{
  chk("se puede fusionar", p.puede && p.codigo === "fusionable", p.detalle);
  chk("la fecha pasa a la del DESPACHO (22/09), no la de emisión (23/09)", p.patch.fecha === "2026-09-22");
  chk("toma el odómetro del voucher", p.patch.kilometraje === 11549);
  chk("y el conductor", p.patch.conductor === "Grover Einner Gomez Mozo");
  chk("el grifo de la factura se queda (COESTI S.A.)", !("grifo" in p.patch));
  const obs = String(p.patch.observaciones);
  chk("queda marcada como fusionada, con la nota de despacho", esCargaFusionada(obs) && obs.includes("Nota V97T-00001443"), obs);
  chk("…y sigue siendo una carga de la factura (la conciliación y el Radar la siguen reconociendo)",
    esCargaDeFactura(obs) && obs.includes(`${MARCA_CARGA_DE_FACTURA} F882-0124552`));
  chk("ya no dice «sin odómetro»", !/sin odómetro/.test(obs));
  chk("galones, precio e importe NO se tocan (los de la factura)", !["galones", "precio_galon", "total", "tipo_combustible", "unidad"].some((k) => k in p.patch));
  chk("el tanque lleno que afirmó la persona va aparte (columna accesoria)", p.patchTanque?.tanque_lleno === true && p.patchTanque?.tanque_lleno_fuente === "operador");
  chk("no cambia de mes, sin avisos", !p.cruzaMes && p.avisos.length === 0, p.avisos.join(" | "));
  chk("la pantalla dice qué cambia, de qué a qué", p.cambios.map((c) => c.campo).join() === "Fecha,Odómetro,Conductor", p.cambios.map((c) => c.campo).join());
}

// ── 2. Lo que no se fusiona ──────────────────────────────────────────────────
console.log("\n2. Lo que NO se fusiona, y por qué");
{
  const delRadar = planDeFusion({ ...CARGA_61, observaciones: "Radar IA · Grupo · ALEX" }, VOUCHER);
  chk("una carga que registró el Radar (o una persona) es un duplicado de verdad: no se fusiona", !delRadar.puede && delRadar.codigo === "no_es_de_factura");
  chk("sin fecha en el voucher, no", planDeFusion(CARGA_61, { ...VOUCHER, fecha: null }).codigo === "sin_fecha");
  chk("con una fecha mal formada, no", planDeFusion(CARGA_61, { ...VOUCHER, fecha: "22/09/2026" }).codigo === "sin_fecha");
  const lejos = planDeFusion(CARGA_61, { ...VOUCHER, fecha: "2025-09-22" });
  chk("el año mal leído (2025) no mueve el gasto de año: fecha_lejana", !lejos.puede && lejos.codigo === "fecha_lejana" && Object.keys(lejos.patch).length === 0, lejos.detalle);
  chk(`a ${MAX_DESFASE} días sí; a ${MAX_DESFASE + 1}, no`,
    planDeFusion(CARGA_61, { ...VOUCHER, fecha: sumarDias("2026-09-23", -MAX_DESFASE) }).puede &&
    !planDeFusion(CARGA_61, { ...VOUCHER, fecha: sumarDias("2026-09-23", -MAX_DESFASE - 1) }).puede);
}

// ── 3. Lo ya escrito no se pisa, y la plata es la de la factura ──────────────
console.log("\n3. Lo que una persona ya escribió, y la plata");
{
  const conKm = planDeFusion({ ...CARGA_61, kilometraje: 11600 }, VOUCHER);
  chk("un km que alguien ya escribió no se pisa: se avisa", !("kilometraje" in conKm.patch) && conKm.avisos.some((a) => /11[.,]?600/.test(a)), conKm.avisos.join(" | "));
  const conChofer = planDeFusion({ ...CARGA_61, conductor: "Otro" }, VOUCHER);
  chk("un conductor ya escrito no se pisa", !("conductor" in conChofer.patch));
  const otroImporte = planDeFusion(CARGA_61, { ...VOUCHER, monto: 50 });
  chk("si el voucher dice otro importe, se queda el de la factura y se avisa",
    otroImporte.puede && !("total" in otroImporte.patch) && otroImporte.avisos.some((a) => a.includes("S/ 50.00") && a.includes("S/ 47.31")));
  const otraCantidad = planDeFusion(CARGA_61, { ...VOUCHER, cantidad: 6.5 });
  chk("si dice otra cantidad, también", !("galones" in otraCantidad.patch) && otraCantidad.avisos.some((a) => a.includes("6.5")));
  const mes = planDeFusion({ ...CARGA_61, fecha: "2026-10-01" }, { ...VOUCHER, fecha: "2026-09-30" });
  chk("del 01/10 al 30/09: cambia de mes, y lo dice", mes.cruzaMes && mes.avisos.some((a) => /cambia de mes/.test(a)));
  const tanqueYa = planDeFusion({ ...CARGA_61, tanque_lleno: false }, VOUCHER);
  chk("un tanque ya declarado no se pisa", tanqueYa.patchTanque === null);
  const sinAfirmar = planDeFusion(CARGA_61, { ...VOUCHER, tanqueFuente: null });
  chk("si nadie afirmó el tanque, no se escribe (ancla por la política)", sinAfirmar.patchTanque === null);
}

// ── 4. Idempotente ───────────────────────────────────────────────────────────
console.log("\n4. Fusionar dos veces no cambia nada");
{
  const despues = aplicar(CARGA_61, p.patch);
  const otra = planDeFusion(despues, VOUCHER);
  chk("la segunda vez: nada que escribir", otra.puede && Object.keys(otra.patch).length === 0, JSON.stringify(otra.patch));
  chk("la marca no se repite", (String(despues.observaciones).match(/Fusionada con el voucher/g) ?? []).length === 1);
}

// ── 5. Después de fusionar ───────────────────────────────────────────────────
console.log("\n5. Después de fusionar, el resto del ERP la sigue reconociendo");
const fusionada = aplicar(CARGA_61, p.patch);
{
  // La conciliación vuelve a pasar por la factura (las parciales se re-miran cada 3 h): la línea de la
  // factura, con su fecha de emisión corrida un día, tiene que seguir casando con la carga #61.
  const linea: LineaFactura = {
    n: 1, descripcion: "GLP-G", cantidad: 6.266, unidad_codigo: "GLL", precio_unitario: 7.55, total: 47.31,
    tipo_combustible: "glp", placa: "CWQ400", fecha: "2026-09-23", fecha_origen: "emision", nota_despacho: null,
  };
  const juzgada = lineasAlDespacho([linea], "2026-09-23", 1).lineas[0] as LineaFactura;
  const reg: CargaExistente = { id: 61, placa: "CWQ400", fecha: fusionada.fecha, total: 47.31, cantidad: 6.266, documento_compra_id: 500, referencia: fusionada.observaciones };
  for (const [nombre, l] of [["con el desfase medido", juzgada], ["sin desfase (la fecha de emisión)", linea]] as const) {
    const pl = planDeLinea({ linea: l, registradas: [reg], radarPendientes: [], tipoComprobante: "factura", documentoId: 500, fuente: "xml_ubl", hoy: "2026-10-06", graciaDias: 1, autoRegistrar: true });
    chk(`la factura la sigue encontrando (${nombre}): no se registra otra vez`, pl.codigo === "ya_registrada", pl.codigo);
  }
  // Un segundo reporte del mismo voucher (alguien lo reenvía) la encuentra por la NOTA.
  const otraVez = buscarCargaRegistrada({ fecha: "2026-09-22", comprobante: "V97T-00001443", monto: 47.31 },
    [{ id: 61, fecha: fusionada.fecha, total: 47.31, observaciones: fusionada.observaciones, misma_unidad: true }]);
  chk("el Radar la reconoce por la nota de despacho", otraVez?.por === "comprobante" && otraVez.id === 61, JSON.stringify(otraVez));
  // «Moverlas a la fecha del despacho» no la toca, aunque su fecha coincidiera con la emisión.
  const mismaFecha = aplicar(CARGA_61, planDeFusion(CARGA_61, { ...VOUCHER, fecha: "2026-09-23" }).patch);
  const mover = cargasPorMover([{
    factura_id: 9, serie: "F882", numero: "0124552", fecha_emision: "2026-09-23",
    lineas: [{ n: 1, fecha: "2026-09-23", tipo_combustible: "glp" }], conciliacion: [{ n: 1, codigo: "registrar", combustible_id: 61 }],
  }], new Map([[61, { id: 61, fecha: mismaFecha.fecha, observaciones: mismaFecha.observaciones, total: 47.31, placa: "CWQ400" }]]), 1);
  chk("«Moverlas» no corre una carga fusionada (su fecha es la del voucher)", mover.length === 0);
  const sinFusionar = cargasPorMover([{
    factura_id: 9, serie: "F882", numero: "0124552", fecha_emision: "2026-09-23",
    lineas: [{ n: 1, fecha: "2026-09-23", tipo_combustible: "glp" }], conciliacion: [{ n: 1, codigo: "registrar", combustible_id: 61 }],
  }], new Map([[61, { id: 61, fecha: "2026-09-23", observaciones: CARGA_61.observaciones, total: 47.31, placa: "CWQ400" }]]), 1);
  chk("…y sin fusionar sí la proponía (la prueba distingue)", sinFusionar.length === 1);
}

// ── 6. Barrido ───────────────────────────────────────────────────────────────
console.log("\n6. Barridos");
{
  let casos = 0, roto = 0, fusionables = 0;
  const fechasCarga = ["2026-09-23", "2026-10-01", "2026-12-31"];
  for (const fc of fechasCarga) for (const dv of [-5, -4, -3, -2, -1, 0, 1, 2, 4]) for (const kmC of [0, null, 12000])
    for (const kmV of [null, 0, 11549]) for (const obs of [CARGA_61.observaciones, "Radar IA · x", null]) for (const monto of [47.31, 60, null]) {
      casos++;
      const c: CargaDeFactura = { ...CARGA_61, fecha: fc, kilometraje: kmC, observaciones: obs };
      const v: VoucherAFusionar = { ...VOUCHER, fecha: sumarDias(fc, dv), kilometraje: kmV, monto };
      const r = planDeFusion(c, v);
      if (["galones", "precio_galon", "total", "tipo_combustible", "unidad"].some((k) => k in r.patch)) roto++;
      if (!r.puede && Object.keys(r.patch).length) roto++;
      if (r.puede && !esCargaDeFactura(obs)) roto++;
      if (r.puede && Math.abs(dv) > MAX_DESFASE) roto++;
      if ("kilometraje" in r.patch && kmC != null && kmC > 0) roto++;
      if ("fecha" in r.patch && r.patch.fecha !== v.fecha) roto++;
      if (r.puede) {
        fusionables++;
        const otra = planDeFusion(aplicar(c, r.patch), v);
        if (Object.keys(otra.patch).length) roto++;
      }
    }
  chk(`(${casos}) nunca toca la plata, nunca pisa un km escrito, nunca fusiona lo que no es de factura ni a más de ${MAX_DESFASE} días, y es idempotente`, roto === 0, String(roto));
  chk("y el barrido sí fusiona (un motor que nunca fusionara cumpliría lo de arriba)", fusionables > 0, String(fusionables));
}

// ── 7. El orden al revés: la factura registra DESPUÉS de que el Radar leyó el voucher ──
console.log("\n7. La factura registra la carga mientras la recarga del Radar sigue por revisar");
const comoCandidata = (c: CargaDeFactura, misma = true): CargaRegistrada =>
  ({ id: c.id, fecha: c.fecha, total: c.total, observaciones: c.observaciones, misma_unidad: misma });
{
  const V = { fecha: "2026-09-22", comprobante: "V97T-00001443", monto: 47.31 };
  // (a) Cuando el Radar procesó el voucher, la carga no existía: no hubo «posible duplicado», así que
  //     el recuadro de fusión (que antes solo salía con esa marca) no iba a aparecer nunca.
  chk("al procesar no había nada en Combustible: sin «posible duplicado»", buscarCargaRegistrada(V, []) === null);
  // (b) La IA leyó mal el importe y la cantidad (41.31 / 5.266): la línea de la factura no casa con la
  //     recarga por revisar, y pasada la espera la factura la registra sola.
  const linea: LineaFactura = {
    n: 1, descripcion: "GLP-G", cantidad: 6.266, unidad_codigo: "GLL", precio_unitario: 7.55, total: 47.31,
    tipo_combustible: "glp", placa: "CWQ400", fecha: "2026-09-22", fecha_origen: "emision", fecha_alterna: "2026-09-23", nota_despacho: null,
  };
  const malLeida: CargaExistente = { id: "uuid-radar", placa: "CWQ400", fecha: "2026-09-22", total: 41.31, cantidad: 5.266, referencia: "V97T-00001443" };
  const pl = planDeLinea({ linea, registradas: [], radarPendientes: [malLeida], tipoComprobante: "factura", documentoId: null, fuente: "xml_ubl", hoy: "2026-09-25", graciaDias: 1, autoRegistrar: true });
  chk("con el importe mal leído, la factura no la reconoce y la registra (el caso que esto cubre)", pl.codigo === "registrar", pl.codigo);
  // (c) La persona corrige el importe a 47.31 y pulsa «Registrar»: AHORA se vuelve a preguntar.
  const delCorreo: CargaDeFactura = { ...CARGA_61, fecha: "2026-09-22", observaciones: observacionCargaDeFactura("F882-0124552", null, "Fecha del despacho: emitida el 23/09/2026, 1 día(s) antes") };
  const r = yaEstaEnCombustible(V, [comoCandidata(delCorreo)]);
  chk("al registrar la encuentra: es la carga de la factura → FUSIONAR", r.codigo === "fusionar" && r.id === 61, `${r.codigo} ${r.detalle}`);
  const q = preguntaAntesDeRegistrar(r);
  chk("…y el botón pregunta antes de insertar, nombrando la carga y diciendo qué hacer", !!q && q.includes("#61") && /FUSIONAR/.test(q) && /APARTE/.test(q), q ?? "");
  chk("con la fecha de EMISIÓN (sin desfase) también la encuentra", yaEstaEnCombustible(V, [comoCandidata(CARGA_61)]).codigo === "fusionar");
  chk("y sin comprobante, por unidad + día + importe", yaEstaEnCombustible({ ...V, comprobante: null }, [comoCandidata(CARGA_61)]).codigo === "fusionar");

  // Lo que ya está por otra puerta: se descarta, no se fusiona.
  const delRadar: CargaDeFactura = { ...CARGA_61, observaciones: "Radar IA · Grupo AFA · ALEX · Nota V97T-00001443" };
  const yaR = yaEstaEnCombustible(V, [comoCandidata(delRadar)]);
  chk("registrada por el Radar (otro reporte del mismo voucher): ya_registrada → descartar", yaR.codigo === "ya_registrada" && /Radar/.test(yaR.detalle) && /DESCARTA/.test(yaR.detalle), yaR.detalle);
  const yaF = yaEstaEnCombustible(V, [comoCandidata(fusionada)]);
  chk("una carga de factura YA fusionada con otro voucher: ya_registrada, no se vuelve a fusionar", yaF.codigo === "ya_registrada" && /fusionó/.test(yaF.detalle), yaF.detalle);
  const aMano = yaEstaEnCombustible({ ...V, comprobante: null }, [comoCandidata({ ...CARGA_61, fecha: "2026-09-22", observaciones: "Cargada en el grifo" })]);
  chk("tecleada a mano el mismo día y por el mismo importe: ya_registrada", aMano.codigo === "ya_registrada" && /a mano/.test(aMano.detalle), aMano.detalle);
  chk("…y su pregunta deja registrarla igual si de verdad es otra", /¿Registrarla igual/.test(preguntaAntesDeRegistrar(aMano) ?? ""));
  chk("tecleada a mano un día ANTES no se acusa (quien carga S/ 100 diarios no tendría un rojo cada mañana)",
    yaEstaEnCombustible({ ...V, comprobante: null }, [comoCandidata({ ...CARGA_61, observaciones: "Cargada en el grifo" })]).codigo === "libre");

  // Lo que NO es la misma carga sigue pasando sin preguntar: el control no puede volverse paisaje.
  chk("otro importe: libre, sin pregunta", (() => { const x = yaEstaEnCombustible({ ...V, comprobante: null, monto: 60 }, [comoCandidata(CARGA_61)]); return x.codigo === "libre" && preguntaAntesDeRegistrar(x) === null; })());
  chk("una carga de OTRA unidad con el mismo importe, sin comprobante: libre", yaEstaEnCombustible({ ...V, comprobante: null }, [comoCandidata(CARGA_61, false)]).codigo === "libre");
  chk("a dos días de la carga de la factura: libre (no es su desfase)", yaEstaEnCombustible({ ...V, comprobante: null, fecha: "2026-09-20" }, [comoCandidata(CARGA_61)]).codigo === "libre");
  chk("Combustible vacío: libre", yaEstaEnCombustible(V, []).codigo === "libre");

  // Si la base no contesta no se afirma que esté libre.
  const sinLeer = yaEstaEnCombustible(V, null, "timeout");
  chk("sin poder leer Combustible: sin_comprobar, y pregunta", sinLeer.codigo === "sin_comprobar" && /timeout/.test(sinLeer.detalle) && /¿Registrar igual\?/.test(preguntaAntesDeRegistrar(sinLeer) ?? ""));

  // Barrido: la MISMA regla que el procesamiento (buscarCargaRegistrada) — dos reglas para «es la misma
  // carga» terminan contestando distinto.
  let casos = 0, roto = 0;
  const vistos = new Set<string>();
  const origenes = [CARGA_61.observaciones, fusionada.observaciones, "Radar IA · x", "Cargada a mano", null];
  for (const obs of origenes) for (const misma of [true, false]) for (const dd of [-2, -1, 0, 1, 2]) for (const monto of [47.31, 47.9, 60, null])
    for (const comp of ["V97T-00001443", null]) for (const conNota of [true, false]) {
      casos++;
      const c: CargaRegistrada = { id: 61, fecha: sumarDias("2026-09-22", dd), total: 47.31, misma_unidad: misma,
        observaciones: obs == null ? (conNota ? "Nota V97T-00001443" : null) : conNota ? `${obs} · Nota V97T-00001443` : obs };
      const v = { fecha: "2026-09-22", comprobante: comp, monto };
      const x = yaEstaEnCombustible(v, [c]);
      vistos.add(x.codigo);
      const hallada = buscarCargaRegistrada(v, [c]);
      if ((x.codigo === "libre") !== (hallada === null)) roto++;                 // misma regla que el procesamiento
      if ((x.codigo === "libre") !== (preguntaAntesDeRegistrar(x) === null)) roto++; // solo «libre» registra sin preguntar
      if (x.codigo === "fusionar" && !(esCargaDeFactura(c.observaciones) && !esCargaFusionada(c.observaciones))) roto++;
      if (x.codigo !== "libre" && x.id !== 61) roto++;
    }
  chk(`(${casos}) misma regla que el Radar al procesar; solo «libre» registra sin preguntar; solo se fusiona una carga de factura sin fusionar`, roto === 0, String(roto));
  chk("y el barrido recorre los tres veredictos (un control que nunca encontrara nada cumpliría lo de arriba)",
    vistos.has("libre") && vistos.has("fusionar") && vistos.has("ya_registrada"), [...vistos].join(","));
}

// ── 8. Dos recargas del Radar por revisar que podrían ser la misma línea ──────
console.log("\n8. Dos recargas del Radar por revisar casan con la línea: la factura espera");
{
  const linea: LineaFactura = {
    n: 1, descripcion: "GLP-G", cantidad: 13.25, unidad_codigo: "GLL", precio_unitario: 7.55, total: 100,
    tipo_combustible: "glp", placa: "CWQ400", fecha: "2026-09-22", nota_despacho: null,
  };
  const r1: CargaExistente = { id: "uuid-1", placa: "CWQ400", fecha: "2026-09-22", total: 100, cantidad: 13.25, referencia: "" };
  const r2: CargaExistente = { id: "uuid-2", placa: "CWQ400", fecha: "2026-09-22", total: 100, cantidad: 13.25, referencia: "" };
  const base = { linea, registradas: [], tipoComprobante: "factura", documentoId: null, fuente: "xml_ubl" as const, hoy: "2026-09-25", graciaDias: 1, autoRegistrar: true };
  const dos = planDeLinea({ ...base, radarPendientes: [r1, r2] });
  chk("con dos candidatas en el Radar NO se registra desde la factura: espera al Radar", dos.codigo === "en_radar_pendiente" && dos.casa_con == null, `${dos.codigo} ${dos.detalle}`);
  chk("…y lo dice", /Dos recargas del Radar/.test(dos.detalle) && /Radar IA → Combustible/.test(dos.detalle));
  // Lo que pasaba antes: seguir de largo era lo mismo que no ver ninguna recarga del Radar.
  chk("antes seguía de largo y la registraba (sin recargas a la vista sale «registrar»: la prueba distingue)",
    planDeLinea({ ...base, radarPendientes: [] }).codigo === "registrar");
  const una = planDeLinea({ ...base, radarPendientes: [r1] });
  chk("con UNA sigue siendo la de siempre: en revisión del Radar, enlazada a esa fila", una.codigo === "en_radar_pendiente" && una.casa_con === "uuid-1");
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
