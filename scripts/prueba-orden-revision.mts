// Pruebas del ORDEN DE TRABAJO entre el Radar IA y las facturas del correo
// (lib/combustible/orden-revision.ts, puro). NO tocan la base.
// Uso:  npx tsx scripts/prueba-orden-revision.mts   (sale con código 1 si algo falla)
//
// Lo preguntó el dueño: «¿primero reviso el Radar IA —que no quede ninguna recarga observada— y recién
// después las facturas? Si es así, acláralo para que los operadores no tengan problemas». Fija:
//
//   1. los dos pasos, en ese orden, y los avisos de las dos pantallas nombrándolos igual;
//   2. un aviso no afirma lo que no sabe: sin conteo no dice «al día»;
//   3. EL CICLO del filtro «qué facturas esperan al Radar»: el plan que escribe la conciliación
//      (planDeLinea, de verdad), guardado como jsonb, cae en FILTRO_ESPERAN_RADAR — y va como texto;
//   4. qué recarga espera cada factura (facturasQueEsperan);
//   5. la pista de la pestaña de facturas antes de «Registrar esta carga» (pendientesCerca).
import {
  PASOS_REVISION, FILTRO_ESPERAN_RADAR, avisoOrdenEnFacturas, avisoOrdenEnRadar, facturasQueEsperan, pendientesCerca,
  type RecargaPorRevisar,
} from "../lib/combustible/orden-revision";
import { planDeLinea, FILTRO_HISTORICO, type LineaFactura, type CargaExistente, type PlanLinea } from "../lib/combustible/factura-lineas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── 1. Los dos pasos y los avisos ────────────────────────────────────────────
console.log("\n1. Primero el Radar, después las facturas");
{
  chk("son dos pasos y el primero es el Radar", PASOS_REVISION.length === 2 && PASOS_REVISION[0].n === 1 && /Radar IA/.test(PASOS_REVISION[0].donde) && /Facturas/.test(PASOS_REVISION[1].donde));
  const enF = avisoOrdenEnFacturas({ pendientesRadar: 7, lineasEsperando: 3 })!;
  chk("en FACTURAS, con recargas por revisar: pendiente, con el número y la pantalla del paso 1",
    enF.tono === "pendiente" && enF.titulo.includes("7") && enF.titulo.includes(PASOS_REVISION[0].donde), enF.titulo);
  chk("…dice cuántas líneas de factura las esperan, y que desde ahí no se cierran", /3 línea\(s\)/.test(enF.detalle) && /no se pueden cerrar/.test(enF.detalle), enF.detalle);
  chk("…y qué pasa si se hace al revés (habrá que fusionar)", /fusionar/.test(enF.detalle));
  const enF0 = avisoOrdenEnFacturas({ pendientesRadar: 7, lineasEsperando: 0 })!;
  chk("sin líneas esperando no inventa la frase de las líneas", !/línea\(s\)/.test(enF0.detalle));
  const listoF = avisoOrdenEnFacturas({ pendientesRadar: 0, lineasEsperando: 0 })!;
  chk("en FACTURAS, con el Radar al día: listo", listoF.tono === "listo" && /al día/.test(listoF.titulo));
  const listoEsperando = avisoOrdenEnFacturas({ pendientesRadar: 0, lineasEsperando: 2 })!;
  chk("…si aún quedan líneas «En revisión del Radar», dice que se cierran solas en la próxima lectura",
    listoEsperando.tono === "listo" && /2 línea/.test(listoEsperando.detalle) && /próxima lectura/.test(listoEsperando.detalle), listoEsperando.detalle);
  const enR = avisoOrdenEnRadar({ pendientes: 12, conFactura: 4 });
  chk("en el RADAR, con recargas por revisar: pendiente, nombra la pantalla del paso 2", enR.tono === "pendiente" && enR.titulo.includes("12") && enR.detalle.includes(PASOS_REVISION[1].donde), enR.detalle);
  chk("…y cuántas ya tienen su factura esperando", /4 ya tienen su factura esperando/.test(enR.detalle));
  chk("…sin facturas esperando no lo menciona", !/factura esperando/.test(avisoOrdenEnRadar({ pendientes: 12, conFactura: 0 }).detalle));
  const listoR = avisoOrdenEnRadar({ pendientes: 0, conFactura: 0 });
  chk("en el RADAR, sin ninguna por revisar: listo, y manda a las facturas", listoR.tono === "listo" && listoR.detalle.includes(PASOS_REVISION[1].donde), listoR.detalle);
}

// ── 2. No afirmar lo que no se sabe ──────────────────────────────────────────
console.log("\n2. Sin conteo no hay aviso");
chk("si no se pudieron contar las recargas del Radar, la pestaña de facturas no dice nada (ni «al día»)",
  avisoOrdenEnFacturas({ pendientesRadar: null, lineasEsperando: 5 }) === null);

// ── 3. El ciclo del filtro ───────────────────────────────────────────────────
console.log("\n3. Lo que escribe la conciliación cae en el filtro con que se lee");
// La contención de jsonb (@>) para un arreglo de objetos: cada objeto del filtro está contenido en algún
// elemento del documento (cada clave del filtro, con el mismo valor).
const contiene = (doc: unknown[], filtro: Record<string, unknown>[]) =>
  filtro.every((f) => doc.some((d) => d && typeof d === "object" && Object.entries(f).every(([k, v]) => (d as Record<string, unknown>)[k] === v)));
{
  const linea: LineaFactura = {
    n: 1, descripcion: "GLP-G", cantidad: 6.266, unidad_codigo: "GLL", precio_unitario: 7.55, total: 47.31,
    tipo_combustible: "glp", placa: "CWQ400", fecha: "2026-09-22", nota_despacho: null,
  };
  const enRadar: CargaExistente = { id: "uuid-radar", placa: "CWQ400", fecha: "2026-09-22", total: 47.31, cantidad: 6.266, referencia: "V97T-00001443" };
  const base = { linea, tipoComprobante: "factura", documentoId: null, fuente: "xml_ubl" as const, hoy: "2026-09-25", graciaDias: 1, autoRegistrar: true };
  const espera = planDeLinea({ ...base, registradas: [], radarPendientes: [enRadar] });
  const yaReg = planDeLinea({ ...base, registradas: [{ ...enRadar, id: 61, documento_compra_id: null }], radarPendientes: [] });
  // Lo que se guarda en radar_facturas.conciliacion es el plan entero, pasado por JSON (jsonb).
  const guardado = (planes: PlanLinea[]) => JSON.parse(JSON.stringify(planes)) as unknown[];
  const filtro = JSON.parse(FILTRO_ESPERAN_RADAR.conciliacion) as Record<string, unknown>[];
  chk("la línea que espera al Radar sale en_radar_pendiente (la conciliación real)", espera.codigo === "en_radar_pendiente" && espera.casa_con === "uuid-radar");
  chk("una factura con esa línea CAE en el filtro", contiene(guardado([yaReg, espera]), filtro));
  chk("una factura sin líneas esperando NO cae (la prueba distingue)", !contiene(guardado([yaReg]), filtro));
  chk("el filtro viaja como TEXTO JSON (cs.[…]), no como arreglo (cs.{[object Object]})",
    typeof FILTRO_ESPERAN_RADAR.conciliacion === "string" && FILTRO_ESPERAN_RADAR.conciliacion.startsWith("[") && typeof FILTRO_HISTORICO.conciliacion === "string");
  chk("una factura con una línea esperando queda «parcial», y ese estado está en el filtro", FILTRO_ESPERAN_RADAR.estados.includes("parcial"));
  // Y del plan guardado sale qué recarga espera cada factura.
  const m = facturasQueEsperan([{ serie: "F882", numero: "0124552", conciliacion: guardado([yaReg, espera]) as PlanLinea[] }]);
  chk("del plan guardado sale qué recarga espera: uuid-radar → F882-0124552", m.get("uuid-radar") === "F882-0124552" && m.size === 1);
}

// ── 4. Qué factura espera a cada recarga ─────────────────────────────────────
console.log("\n4. facturasQueEsperan");
{
  const p = (codigo: PlanLinea["codigo"], casa_con?: string): PlanLinea => ({ n: 1, codigo, detalle: "", ...(casa_con ? { casa_con } : {}) });
  const m = facturasQueEsperan([
    { serie: "F882", numero: "1", conciliacion: [p("en_radar_pendiente", "a"), p("ya_registrada", "b"), p("registrar")] },
    { serie: "F882", numero: "2", conciliacion: [p("en_radar_pendiente", "a"), p("en_radar_pendiente")] },
    { serie: null, numero: null, conciliacion: [p("en_radar_pendiente", "c")] },
    { serie: "F882", numero: "3", conciliacion: null },
  ]);
  chk("solo las líneas en_radar_pendiente con su fila del Radar", m.has("a") && !m.has("b") && m.size === 2, [...m.entries()].join(" | "));
  chk("la ambigua (sin casa_con) no se le atribuye a ninguna recarga", ![...m.keys()].includes("undefined"));
  chk("la primera factura que la nombra gana", m.get("a") === "F882-1");
  chk("sin serie, una etiqueta genérica en vez de «null-null»", m.get("c") === "una factura del correo");
  chk("vacío y basura no revientan", facturasQueEsperan([]).size === 0 && facturasQueEsperan([{ conciliacion: "x" as unknown as PlanLinea[] }]).size === 0);
}

// ── 5. La pista antes de «Registrar esta carga» ──────────────────────────────
console.log("\n5. pendientesCerca");
{
  const pend: RecargaPorRevisar[] = [
    { id: "1", placa: "CWQ-400", fecha: "2026-09-20", monto: 41.31 },   // importe mal leído: igual es candidata
    { id: "2", placa: "CWQ400", fecha: "2026-09-26", monto: 47.31 },
    { id: "3", placa: "BUI272", fecha: "2026-09-22", monto: 47.31 },
    { id: "4", placa: "CWQ400", fecha: null, monto: 47.31 },
  ];
  const cerca = pendientesCerca({ placa: "cwq 400", fecha: "2026-09-22" }, pend);
  chk("misma placa (sin importar guion, espacios ni mayúsculas) a ±3 días; sin exigir el importe", cerca.map((r) => r.id).join() === "1", cerca.map((r) => r.id).join());
  chk("a 4 días ya no", !pendientesCerca({ placa: "CWQ400", fecha: "2026-09-22" }, pend).some((r) => r.id === "2"));
  chk("con otra ventana, sí", pendientesCerca({ placa: "CWQ400", fecha: "2026-09-22" }, pend, 4).some((r) => r.id === "2"));
  chk("otra placa no", !cerca.some((r) => r.id === "3"));
  chk("sin placa o sin fecha en la línea, nada (no se adivina)", pendientesCerca({ placa: null, fecha: "2026-09-22" }, pend).length === 0 && pendientesCerca({ placa: "CWQ400", fecha: null }, pend).length === 0);
  chk("una recarga sin fecha no se ofrece", !pendientesCerca({ placa: "CWQ400", fecha: "2026-09-22" }, pend, 30).some((r) => r.id === "4"));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
