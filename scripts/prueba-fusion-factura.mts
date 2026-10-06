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
//   8. dos recargas del Radar por revisar que podrían ser la misma línea: la factura ya no la registra;
//   9. EL DUPLICADO DE UNA CARGA DEL RADAR (lo pidió el dueño sobre la CWZ-371 del 14/08, S/ 224.08: la
//      carga #15 la registró el Radar con la foto del voucher, y la fila nueva traía el tablero y el
//      surtidor): en vez de descartarla, se FUSIONA en el modo «sumar» — enlaza sus fotos y completa lo
//      que falta, sin mover la fecha ni la plata.
import {
  planDeFusion, yaEstaEnCombustible, preguntaAntesDeRegistrar, modoDeFusion,
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
  // (Una carga que registró el Radar o una persona ya NO es «no se fusiona»: se fusiona SUMANDO la
  // evidencia, sin mover su fecha — sección 9.)
  chk("la carga de la factura se fusiona en el modo «factura» (toma la fecha del voucher)", p.modo === "factura" && modoDeFusion(CARGA_61.observaciones) === "factura");
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
      if (r.modo !== modoDeFusion(obs)) roto++;
      if (r.puede && r.modo === "factura" && !esCargaDeFactura(obs)) roto++;
      if (r.puede && r.modo === "factura" && Math.abs(dv) > MAX_DESFASE) roto++;
      if (r.modo === "sumar" && "fecha" in r.patch) roto++;           // sumar nunca mueve la fecha
      if ("kilometraje" in r.patch && kmC != null && kmC > 0) roto++;
      if ("fecha" in r.patch && r.patch.fecha !== v.fecha) roto++;
      if (r.puede) {
        fusionables++;
        const otra = planDeFusion(aplicar(c, r.patch), v);
        if (Object.keys(otra.patch).length) roto++;
      }
    }
  chk(`(${casos}) nunca toca la plata, nunca pisa un km escrito, la fecha solo la mueve una carga de factura (a ≤ ${MAX_DESFASE} días), y es idempotente`, roto === 0, String(roto));
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
  chk("registrada por el Radar (otro reporte del mismo voucher): ya_registrada → FUSIONAR sumando (no descartar)", yaR.codigo === "ya_registrada" && /Radar/.test(yaR.detalle) && /FUSIÓNALA/.test(yaR.detalle) && !/DESCARTA/.test(yaR.detalle), yaR.detalle);
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

// ── 9. El duplicado de una carga del Radar (o a mano): se SUMA la evidencia ───
console.log("\n9. Fusionar el duplicado de una carga del Radar o tecleada: se suma, no se descarta");
{
  // Con la forma del caso real: la carga #15 la registró el Radar de otro reporte, solo con la foto del
  // voucher; la fila nueva trae el tablero (odómetro), el surtidor y la nota.
  const CARGA_15: CargaDeFactura = {
    id: 15, fecha: "2026-08-14", total: 224.08, galones: 9.072, kilometraje: 15339, conductor: null, grifo: "COESTI S.A.",
    observaciones: "Radar IA · Grupo Combustible · JUAN · Comprobante V67T-00015555", tanque_lleno: null,
  };
  const B: VoucherAFusionar = {
    fecha: "2026-08-14", kilometraje: 15339, conductor: "Juan Pérez", grifo: "COESTI S.A.", comprobante: "V67T-00015555",
    cantidad: 9.072, monto: 224.08, tanqueLleno: true, tanqueFuente: "operador",
  };
  chk("modos: carga de factura sin voucher → «factura»; del Radar, a mano, de factura ya fusionada o sin observación → «sumar»",
    modoDeFusion(CARGA_61.observaciones) === "factura" && modoDeFusion(CARGA_15.observaciones) === "sumar" &&
    modoDeFusion("Cargado en el grifo") === "sumar" && modoDeFusion(fusionada.observaciones) === "sumar" && modoDeFusion(null) === "sumar");
  const p15 = planDeFusion(CARGA_15, B);
  chk("la carga del Radar SE PUEDE fusionar (antes: «descarta esta fila» y se perdían las fotos)", p15.puede && p15.codigo === "sumable" && p15.modo === "sumar", p15.detalle);
  chk("dice lo que pasa: la fila queda enlazada, sus fotos pasan a ser evidencia, no se crea otra carga",
    /registró el Radar/.test(p15.detalle) && /fotos/.test(p15.detalle) && /No se crea ninguna carga/.test(p15.detalle), p15.detalle);
  chk("la carga toma lo que le falta (el conductor) y nada más", Object.keys(p15.patch).join() === "conductor" && p15.patch.conductor === "Juan Pérez", JSON.stringify(p15.patch));
  chk("la fecha y la plata no se tocan", !["fecha", "galones", "precio_galon", "total", "tipo_combustible", "unidad"].some((k) => k in p15.patch));
  chk("el mismo km y la misma nota: sin avisos", p15.avisos.length === 0, p15.avisos.join(" | "));
  chk("el tanque que afirmó la persona, si la carga no lo tenía", p15.patchTanque?.tanque_lleno === true);
  chk("fusionarla otra vez no escribe nada (sin marcas repetidas)", Object.keys(planDeFusion(aplicar(CARGA_15, p15.patch), B).patch).length === 0);

  // Lo que la carga no tenía se completa; lo que tenía, no se pisa.
  const aMano: CargaDeFactura = { ...CARGA_15, kilometraje: 0, grifo: null, observaciones: "Cargado en el grifo, voucher en el carro" };
  const pm = planDeFusion(aMano, B);
  chk("a una tecleada sin km: toma el odómetro, el grifo y la nota (para que el próximo reporte la encuentre)",
    pm.puede && pm.patch.kilometraje === 15339 && pm.patch.grifo === "COESTI S.A." && /Nota V67T-00015555/.test(String(pm.patch.observaciones)), JSON.stringify(pm.patch));
  const despues = aplicar(aMano, pm.patch);
  chk("…y después el Radar la reconoce por su comprobante", buscarCargaRegistrada({ fecha: "2026-08-20", comprobante: "V67T-00015555", monto: 1 },
    [{ id: 15, fecha: despues.fecha, total: despues.total, observaciones: despues.observaciones, misma_unidad: false }])?.por === "comprobante");
  const otroKm = planDeFusion(CARGA_15, { ...B, kilometraje: 15400 });
  chk("un km distinto del que ya tiene no se pisa: se avisa", !("kilometraje" in otroKm.patch) && otroKm.avisos.some((a) => /15[.,]?339/.test(a) && /15[.,]?400/.test(a)));
  chk("un conductor ya escrito no se pisa", !("conductor" in planDeFusion({ ...CARGA_15, conductor: "Otro" }, B).patch));

  // Lo que hace sospechar que NO es la misma recarga se dice; nada lo bloquea (decide quien mira las fotos).
  const otraFecha = planDeFusion(CARGA_15, { ...B, fecha: "2026-08-13" });
  chk("otra fecha en el voucher: se puede, la carga CONSERVA la suya, y se avisa", otraFecha.puede && !("fecha" in otraFecha.patch) && otraFecha.avisos.some((a) => /conserva su fecha/.test(a)));
  const otraNota = planDeFusion(CARGA_15, { ...B, comprobante: "V67T-00015556" });
  chk("otra nota de despacho: se avisa que suelen ser DOS despachos", otraNota.avisos.some((a) => /dos notas de despacho distintas/.test(a) && /V67T-00015555 y este voucher de la V67T-00015556/.test(a)), otraNota.avisos.join(" | "));
  const notaDeFila = planDeFusion({ ...aMano, notas: ["V67T-00015555"] }, { ...B, comprobante: "V67T-00099999" });
  chk("…también con la nota que se conoce por las filas del Radar enlazadas (no solo la de la observación)", notaDeFila.avisos.some((a) => /dos notas/.test(a)));
  const otroImporte = planDeFusion(CARGA_15, { ...B, monto: 100 });
  chk("otro importe: se queda el de la carga y se avisa (con «la carga», no «la factura»)",
    !("total" in otroImporte.patch) && otroImporte.avisos.some((a) => /S\/ 100\.00/.test(a) && /la carga/.test(a) && !/factura/.test(a)));

  // Una carga de factura YA fusionada recibe otro reporte del mismo voucher: suma, sin volver a moverla.
  const segunda = planDeFusion(fusionada, { ...VOUCHER, fecha: "2026-09-23" });
  chk("a una carga de factura ya fusionada no se le vuelve a mover la fecha (ya es la del papel)", segunda.modo === "sumar" && !("fecha" in segunda.patch) && segunda.avisos.some((a) => /conserva su fecha/.test(a)));

  // «Ya está en Combustible» ahora manda a fusionar, y el botón Registrar sigue preguntando.
  const ya = yaEstaEnCombustible({ fecha: "2026-08-14", comprobante: null, monto: 224.08 },
    [{ id: 15, fecha: "2026-08-14", total: 224.08, observaciones: CARGA_15.observaciones, misma_unidad: true }]);
  chk("el caso real (misma unidad, día e importe): ya_registrada, por «misma_fecha», y manda a FUSIONAR", ya.codigo === "ya_registrada" && ya.por === "misma_fecha" && /FUSIÓNALA/.test(ya.detalle));
  chk("…y Registrar aparte sigue preguntando", /¿Registrarla igual/.test(preguntaAntesDeRegistrar(ya) ?? ""));

  // Barrido del modo «sumar»: lo que no se puede aflojar.
  let casos = 0, roto = 0, sumables = 0;
  const obsCargas = [CARGA_15.observaciones, "Cargado en el grifo", fusionada.observaciones, null, "Cargado · Nota V67T-00015555"];
  for (const obs of obsCargas) for (const kmC of [0, null, 15339]) for (const chofer of [null, "Ana"]) for (const dv of [-3, -1, 0, 1, 10])
    for (const kmV of [null, 15339, 15400]) for (const monto of [224.08, 100, null]) for (const comp of ["V67T-00015555", "V67T-00015556", null]) {
      casos++;
      const c: CargaDeFactura = { ...CARGA_15, observaciones: obs, kilometraje: kmC, conductor: chofer };
      const v: VoucherAFusionar = { ...B, fecha: sumarDias("2026-08-14", dv), kilometraje: kmV, monto, comprobante: comp };
      const r = planDeFusion(c, v);
      if (r.modo !== "sumar") continue;
      sumables++;
      if (!r.puede) roto++;                                                        // nada lo bloquea: decide la persona
      if (["fecha", "galones", "precio_galon", "total", "tipo_combustible", "unidad"].some((k) => k in r.patch)) roto++;
      if ("kilometraje" in r.patch && kmC != null && kmC > 0) roto++;              // nunca pisa un km
      if ("conductor" in r.patch && chofer) roto++;                                // ni un conductor
      if (dv !== 0 && !r.avisos.some((a) => /conserva su fecha/.test(a))) roto++;  // otra fecha se avisa
      if (Object.keys(planDeFusion(aplicar(c, r.patch), v).patch).length) roto++;  // idempotente
    }
  chk(`(${casos} combinaciones, ${sumables} en modo «sumar») nunca toca la fecha ni la plata, nunca pisa km ni conductor, avisa la otra fecha y es idempotente`,
    roto === 0 && sumables > 0, `${roto} rotos`);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
