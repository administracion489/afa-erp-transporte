// scripts/prueba-seguros.mts — Matriz de lib/seguros.ts (la vista derivada de /seguros).
//   npx tsx scripts/prueba-seguros.mts
//
// Fija: póliza gana sobre ficha (y una baja vencida no vuelve a la ficha); ficha de respaldo; sin
// dato no se inventa fecha; vehículo sin documentos → sin_soat (nunca verde); el tercero no suma
// prima; la persona cubierta no sale dos veces; `vencimientoPersona` ≡ v_seguro_persona (oráculo
// escrito aparte, copia de la SQL de seguros-03); barrido de fuente/estado coherentes; y el
// lector: una fuente con error queda 'error' y no se juzgan faltantes sobre ella.

import {
  TIPOS_SEGURO, tipoSeguroDe, SCTR_SIN_PRECISAR, estadoDe, DIAS_POR_VENCER, FUENTES_SEGURO,
  filasDeDocumentosVehiculo, filasDeDocumentosTercero, filasDeFichas, filasDePolizas,
  vencimientoPersona, coberturaFaltante, kpisSeguros, CODIGOS_FALTANTE,
  vencimientoFichaOPoliza, TIPO_DE_COLUMNA_FICHA,
  type PersonaFicha, type PolizaRow, type CoberturaRow, type FilaSeguro, type TipoPersona,
} from "../lib/seguros";
import { cargarSeguros, leerPolizasPersonas } from "../lib/seguros-datos";
import { diasEntreFechas } from "../lib/documentos-estado";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);
const HOY = "2026-10-15";
const dir = { vehiculos: new Map([[1, "ABC-123"], [2, "XYZ-999"]]), vehiculosTercero: new Map([[10, "T3R-001"]]), empresasTercero: new Map([[5, "TRANSPORTES SUR"]]) };

sec("1. Tipos");
check(tipoSeguroDe("SOAT") === "soat", "SOAT");
check(tipoSeguroDe("cat afocat") === "cat", "CAT por alias");
check(tipoSeguroDe("SCTR Pensión") === "sctr_pension", "SCTR Pensión");
check(tipoSeguroDe("SCTR") === SCTR_SIN_PRECISAR, "SCTR a secas → sin precisar");
check(tipoSeguroDe("Revisión Técnica (CITV)") === null, "CITV no es seguro");
check(tipoSeguroDe("vida_ley") === "vida_ley", "clave de póliza tal cual");
check(!!TIPOS_SEGURO.soat && !TIPOS_SEGURO[SCTR_SIN_PRECISAR], "sin precisar no es elegible");

sec("2. Estado coherente con días");
check(estadoDe("2026-10-14", HOY).estado === "vencido", "ayer vencido");
check(estadoDe(HOY, HOY).estado === "por_vencer", "hoy por vencer");
check(estadoDe("2026-11-14", HOY).estado === "por_vencer", "30 días por vencer");
check(estadoDe("2026-11-15", HOY).estado === "vigente", "31 días vigente");
check(estadoDe(null, HOY).estado === "sin_fecha" && estadoDe(null, HOY).dias === null, "sin fecha");

sec("3. Póliza gana sobre ficha; ficha de respaldo; sin dato no inventa");
const juan: PersonaFicha = { clase: "conductor", id: 7, nombre: "JUAN", activo: true, sctr_salud_venc: "2026-12-01", sctr_pension_venc: null, vida_ley: false, vida_ley_venc: "2027-01-01" };
const polizas: PolizaRow[] = [
  { id: 100, tipo: "sctr_salud", aseguradora: "Rimac", fecha_vencimiento: "2027-03-31", prima_total: 1200, cuota_mensual: 100 },
  { id: 101, tipo: "sctr_salud", aseguradora: "Pacífico", fecha_vencimiento: "2027-06-30", prima_total: 0 },
];
const cob: CoberturaRow[] = [{ seguro_id: 100, conductor_id: 7 }, { seguro_id: 101, conductor_id: 7, hasta: "2026-09-30" }];
const v1 = vencimientoPersona(juan, polizas, cob, "sctr_salud");
check(v1.fuente === "poliza" && v1.vencimiento === "2027-03-31" && v1.seguroId === 100, `póliza gana, fin más lejano: ${JSON.stringify(v1)}`);
check(vencimientoPersona(juan, polizas, cob, "sctr_pension").fuente === null, "pensión sin dato → null");
check(vencimientoPersona(juan, polizas, cob, "sctr_pension").vencimiento === null, "no inventa fecha");
check(vencimientoPersona(juan, [], [], "sctr_salud").fuente === "ficha", "ficha de respaldo");
check(vencimientoPersona(juan, [], [], "vida_ley").fuente === null, "vida ley sin casilla no cuenta");
const baja = vencimientoPersona(juan, polizas, [{ seguro_id: 100, conductor_id: 7, hasta: "2026-08-01" }], "sctr_salud");
check(baja.fuente === "poliza" && baja.vencimiento === "2026-08-01", "baja vencida no vuelve a la ficha");
check(vencimientoPersona({ ...juan, clase: "personal" }, polizas, cob, "sctr_salud").fuente === "ficha", "id de conductor no cubre al personal con el mismo id");

sec("4. Persona cubierta no sale dos veces");
const fichas = filasDeFichas([juan], polizas, cob, HOY);
check(fichas.length === 0, `con póliza de salud y sin pensión/vida: 0 filas de ficha (${fichas.length})`);
const fichasSin = filasDeFichas([juan], [], [], HOY);
check(fichasSin.length === 1 && fichasSin[0].tipo === "sctr_salud" && fichasSin[0].fuente === "ficha_conductor", "sin póliza: 1 fila de ficha");
const fp = filasDePolizas(polizas, cob, dir, HOY);
check(fp[0].cubiertos === 1 && fp[0].asegurado.clase === "conductor", "póliza 100 cubre a 1");
check(fp[1].cubiertos === 0, "póliza 101: la cobertura acabó → 0 vigentes");
const falt = coberturaFaltante([], [], [juan], [...fichas, ...fp], HOY, { polizas, coberturas: cob });
check(falt.some((f) => f.codigo === "doble_registro" && !f.alarma), "ficha + póliza → doble_registro sin alarma");
check(falt.some((f) => f.codigo === "sctr_pension_faltante" && f.alarma), "pensión faltante");
check(falt.some((f) => f.codigo === "vida_ley_faltante"), "vida ley faltante");
check(!falt.some((f) => f.codigo === "sctr_salud_faltante"), "salud cubierta");
const inactivo = coberturaFaltante([], [], [{ ...juan, activo: false }], [], HOY);
check(inactivo.length === 0, "persona inactiva no se juzga");

sec("5. Vehículos");
const dv = filasDeDocumentosVehiculo([
  { id: 1, vehiculo_id: 1, tipo: "SOAT", fecha_vencimiento: "2026-09-01" },
  { id: 2, vehiculo_id: 1, tipo: "Revisión Técnica (CITV)", fecha_vencimiento: "2027-01-01" },
], dir, HOY);
check(dv.length === 1, "CITV no entra");
const fv = coberturaFaltante(
  [{ id: 1, placa: "ABC-123", estado: "disponible" }, { id: 2, placa: "XYZ-999", estado: null }, { id: 3, placa: "OFF-000", estado: "inactivo" }],
  [], [], dv, HOY);
check(fv.some((f) => f.codigo === "soat_vencido" && f.asegurado.id === 1), "SOAT vencido");
check(fv.some((f) => f.codigo === "sin_soat" && f.asegurado.id === 2), "sin documentos → sin_soat");
check(!fv.some((f) => f.asegurado.id === 3), "inactivo fuera");
const sinFecha = filasDeDocumentosVehiculo([{ id: 9, vehiculo_id: 2, tipo: "CAT", fecha_vencimiento: null }], dir, HOY);
check(coberturaFaltante([{ id: 2, placa: "XYZ-999" }], [], [], sinFecha, HOY)[0]?.codigo === "soat_sin_fecha", "CAT sin fecha");
const polVeh = filasDePolizas([{ id: 200, tipo: "soat", fecha_vencimiento: "2027-05-01", prima_total: 300 }], [{ seguro_id: 200, vehiculo_id: 2 }], dir, HOY);
check(coberturaFaltante([{ id: 2, placa: "XYZ-999" }], [], [], polVeh, HOY).length === 0, "póliza colectiva cubre la unidad");
const doble = [...polVeh, ...filasDeDocumentosVehiculo([{ id: 11, vehiculo_id: 2, tipo: "SOAT", fecha_vencimiento: "2027-05-01" }], dir, HOY)];
const fd = coberturaFaltante([{ id: 2, placa: "XYZ-999" }], [], [], doble, HOY);
check(fd.length === 1 && fd[0].codigo === "doble_registro" && !fd[0].alarma, "SOAT en doc y póliza → doble_registro");

sec("6. Terceros: cumplimiento sí, prima no");
const dt = filasDeDocumentosTercero([
  { id: 1, empresa_id: 5, vehiculo_id: 10, tipo: "SOAT", fecha_vencimiento: "2027-01-01" },
  { id: 2, empresa_id: 5, vehiculo_id: null, tipo: "SCTR", fecha_vencimiento: "2027-01-01" },
], dir, HOY);
check(dt.every((f) => !f.deAfa) && dt[1].asegurado.clase === "empresa_tercero", "tercero no es de AFA; sin placa = empresa");
const ft = coberturaFaltante([], [{ id: 10, placa: "T3R-001", empresa_id: 5, empresa: "TRANSPORTES SUR" }], [], dt, HOY);
check(ft.some((f) => f.codigo === "sctr_salud_faltante" && /sin decir/.test(f.texto)), "SCTR sin precisar no cumple salud y lo dice");
check(ft.some((f) => f.codigo === "sctr_pension_faltante"), "ni pensión");
check(!ft.some((f) => f.codigo === "sin_soat"), "SOAT de tercero ok");
const conPrima: FilaSeguro[] = [...dt.map((f) => ({ ...f, prima: 999, cuota: 99 })), ...fp];
const k = kpisSeguros(conPrima);
check(k.primaTotal === 1200 && k.cuotaTotal === 100, `tercero no suma prima (${k.primaTotal}, ${k.cuotaTotal})`);

sec("7. vencimientoPersona ≡ v_seguro_persona (oráculo literal de la SQL)");
function oraculoVista(p: PersonaFicha, pols: PolizaRow[], cobs: CoberturaRow[], tipo: TipoPersona) {
  const venc_ficha = tipo === "sctr_salud" ? (p.sctr_salud_venc ?? null) : tipo === "sctr_pension" ? (p.sctr_pension_venc ?? null)
    : (p.vida_ley === true ? (p.vida_ley_venc ?? null) : null);
  const cand = cobs.flatMap((sc) => {
    const s = pols.find((x) => x.id === sc.seguro_id);
    if (!s || s.tipo !== tipo) return [];
    const suya = p.clase === "conductor" ? sc.conductor_id === p.id : sc.personal_administrativo_id === p.id;
    const fin = sc.hasta ?? s.fecha_vencimiento ?? null;
    return suya && fin != null ? [{ fin, seguro_id: s.id }] : [];
  }).sort((a, b) => (a.fin < b.fin ? 1 : a.fin > b.fin ? -1 : b.seguro_id - a.seguro_id));
  const pol = cand[0];
  return { vencimiento: pol?.fin ?? venc_ficha, fuente: pol ? "poliza" : venc_ficha != null ? "ficha" : null, seguroId: pol?.seguro_id };
}
const FECHAS = [null, "2026-01-01", "2026-12-31", "2027-06-30"] as const;
const TIPOS: TipoPersona[] = ["sctr_salud", "sctr_pension", "vida_ley"];
let n = 0, iguales = 0;
for (const clase of ["conductor", "personal"] as const)
for (const ficha of FECHAS) for (const vl of [true, false, null])
for (const tipoPol of ["sctr_salud", "vida_ley", "otro"]) for (const vencPol of FECHAS)
for (const hasta of FECHAS) for (const quien of ["conductor", "personal", "nadie"])
for (const tipo of TIPOS) {
  const p: PersonaFicha = { clase, id: 3, nombre: "X", activo: true, sctr_salud_venc: ficha, sctr_pension_venc: ficha, vida_ley: vl, vida_ley_venc: ficha };
  const pols: PolizaRow[] = [{ id: 1, tipo: tipoPol, fecha_vencimiento: vencPol }, { id: 2, tipo: tipoPol, fecha_vencimiento: "2026-12-31" }];
  const cobs: CoberturaRow[] = quien === "nadie" ? [] : [
    quien === "conductor" ? { seguro_id: 1, conductor_id: 3, hasta } : { seguro_id: 1, personal_administrativo_id: 3, hasta },
    quien === "conductor" ? { seguro_id: 2, conductor_id: 3 } : { seguro_id: 2, personal_administrativo_id: 3 },
  ];
  const a = vencimientoPersona(p, pols, cobs, tipo), b = oraculoVista(p, pols, cobs, tipo);
  n++;
  if (a.vencimiento === b.vencimiento && a.fuente === b.fuente && (a.seguroId ?? null) === (b.seguroId ?? null)) iguales++;
  else if (n - iguales <= 3) console.log("    difiere", JSON.stringify({ clase, ficha, vl, tipoPol, vencPol, hasta, quien, tipo, a, b }));
}
check(iguales === n, `TS ≡ vista en ${iguales}/${n}`);

sec("8. Barrido: una fuente por fila y estado coherente con días");
const filasB: FilaSeguro[] = [];
const fechasB = [null, "2025-01-01", HOY, "2026-11-14", "2026-11-15", "2028-01-01"];
fechasB.forEach((f, i) => {
  filasB.push(...filasDeDocumentosVehiculo([{ id: i, vehiculo_id: 1, tipo: "SOAT", fecha_vencimiento: f }], dir, HOY));
  filasB.push(...filasDeDocumentosTercero([{ id: i, empresa_id: 5, vehiculo_id: i % 2 ? 10 : null, tipo: "Vida Ley", fecha_vencimiento: f }], dir, HOY));
  filasB.push(...filasDeFichas([{ clase: i % 2 ? "conductor" : "personal", id: i, nombre: "P", activo: true, sctr_salud_venc: f, sctr_pension_venc: f, vida_ley: true, vida_ley_venc: f }], [], [], HOY));
  filasB.push(...filasDePolizas([{ id: i, tipo: "todo_riesgo", fecha_vencimiento: f }], [], dir, HOY));
});
let malos = 0;
for (const f of filasB) {
  if (!FUENTES_SEGURO.includes(f.fuente)) malos++;
  const d = f.vencimiento ? diasEntreFechas(HOY, f.vencimiento) : null;
  const esperado = d === null ? "sin_fecha" : d < 0 ? "vencido" : d <= DIAS_POR_VENCER ? "por_vencer" : "vigente";
  if (f.dias !== d || f.estado !== esperado) malos++;
}
check(malos === 0 && filasB.length > 20, `barrido ${filasB.length} filas, ${malos} incoherentes`);
check(new Set(filasB.map((f) => f.clave)).size === filasB.length, "claves únicas");
check(new Set(filasB.map((f) => f.estado)).size === 4, "salen los cuatro estados (corolario)");
check(Object.values(CODIGOS_FALTANTE).filter((c) => !c.alarma).length === 1, "solo doble_registro no alarma");

sec("9. Lector: error ≠ vacío; sin_tabla");
function dbFalsa(tablas: Record<string, any[] | { error: any }>) {
  return {
    from(t: string) {
      const q: any = { cols: "", select(c: string) { q.cols = c; return q; }, order() { return q; },
        in() { return q; }, eq() { return q; }, or() { return q; },
        async range(a: number, b: number) {
          const d = tablas[t];
          if (!d) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${t}' in the schema cache` } };
          if (!Array.isArray(d)) return { data: null, error: d.error };
          return { data: d.slice(a, b + 1), error: null };
        } };
      return q;
    },
  };
}
const base = { vehiculos: [{ id: 1, placa: "ABC-123", estado: "disponible" }], vehiculos_tercero: [], empresas_tercerizadas: [], conductores: [], personal_administrativo: [], seguros: [] } as any;
const r1 = await cargarSeguros(dbFalsa({ ...base, documentos_vehiculo: { error: { code: "500", message: "timeout" } }, documentos_tercero: [] }), HOY);
check(r1.fuentes.documento_vehiculo === "error", "fuente con error = 'error'");
check(!r1.faltantes.some((f) => f.codigo === "sin_soat"), "con documentos en error no se afirma sin_soat");
check(r1.sinJuzgar.length > 0 && r1.errores.some((e) => /documentos de vehículos/.test(e)), "lo dice");
check(r1.fuentes.poliza === "sin_tabla", "sin seguro_cobertura → sin_tabla");
const r2 = await cargarSeguros(dbFalsa({ ...base, documentos_vehiculo: [], documentos_tercero: [] }), HOY);
check(r2.faltantes.some((f) => f.codigo === "sin_soat"), "con todo leído, unidad sin docs → sin_soat");

sec("10. Tick doc_vence / login del conductor: póliza gana, ficha de respaldo, clave intacta");
{
  const POL: PolizaRow[] = [{ id: 7, tipo: "sctr_salud", fecha_vencimiento: "2026-10-30" }, { id: 8, tipo: "vida_ley", fecha_vencimiento: "2027-05-01" }];
  const COB: CoberturaRow[] = [{ seguro_id: 7, conductor_id: 1 }, { seguro_id: 8, conductor_id: 2, hasta: "2026-10-20" }];
  const yo = (id: number) => ({ clase: "conductor" as const, id });
  // sin pólizas leídas → el valor CRUDO de la ficha, tal cual
  check(vencimientoFichaOPoliza(yo(1), "sctr_salud_venc", "2026-10-20", null, null).vencimiento === "2026-10-20", "sin tablas: ficha cruda");
  check(vencimientoFichaOPoliza(yo(1), "sctr_salud_venc", "2026-10-20", null, COB).fuente === "ficha", "una de las dos en null: ficha");
  check(vencimientoFichaOPoliza(yo(1), "sctr_salud_venc", "2026-10-20", POL, COB).vencimiento === "2026-10-30", "póliza gana");
  check(vencimientoFichaOPoliza(yo(3), "sctr_salud_venc", "2026-10-20", POL, COB).vencimiento === "2026-10-20", "no cubierto: ficha");
  check(vencimientoFichaOPoliza(yo(2), "vida_ley_venc", "2027-01-01", POL, COB).vencimiento === "2026-10-20", "baja (hasta) gana, no cae a ficha");
  check(vencimientoFichaOPoliza(yo(1), "vencimiento_licencia", "2026-11-01", POL, COB).vencimiento === "2026-11-01", "licencia no es seguro: ficha siempre");
  // la casilla vida_ley no se aplica en este camino (comportamiento de siempre del tick)
  check(vencimientoFichaOPoliza(yo(5), "vida_ley_venc", "2026-10-25", POL, COB).vencimiento === "2026-10-25", "vida ley de ficha sin mirar la casilla");
  check(Object.keys(TIPO_DE_COLUMNA_FICHA).length === 3, "solo tres columnas son seguros");

  // Copia del bucle del bloque 6: qué claves reclama y con qué fecha.
  const DOCS = ["vencimiento_licencia", "sctr_salud_venc", "sctr_pension_venc", "vida_ley_venc"];
  const tick = (conds: any[], pol: PolizaRow[] | null, cob: CoberturaRow[] | null, hoy: string, limite: string) => {
    const out: { clave: string; f: string }[] = [];
    for (const c of conds) for (const campo of DOCS) {
      const f = vencimientoFichaOPoliza({ clase: "conductor", id: c.id }, campo, c[campo], pol, cob).vencimiento;
      if (!f || f < hoy || f > limite) continue;
      out.push({ clave: `${c.id}:${campo}`, f });
    }
    return out;
  };
  const tickViejo = (conds: any[], hoy: string, limite: string) => {
    const out: { clave: string; f: string }[] = [];
    for (const c of conds) for (const campo of DOCS) {
      const f = c[campo];
      if (!f || f < hoy || f > limite) continue;
      out.push({ clave: `${c.id}:${campo}`, f });
    }
    return out;
  };
  const FECHAS = [null, "2026-10-10", "2026-10-15", "2026-10-30", "2026-12-31"];
  let iguales = 0, combos = 0, conPoliza = 0, clavesBien = true;
  for (const a of FECHAS) for (const b of FECHAS) for (const v of FECHAS) for (const pv of FECHAS) {
    const conds = [{ id: 1, vencimiento_licencia: a, sctr_salud_venc: b, sctr_pension_venc: a, vida_ley_venc: v }, { id: 3, sctr_salud_venc: b }];
    const pol: PolizaRow[] = [{ id: 7, tipo: "sctr_salud", fecha_vencimiento: pv }];
    const cob: CoberturaRow[] = [{ seguro_id: 7, conductor_id: 1 }];
    combos++;
    const viejo = JSON.stringify(tickViejo(conds, HOY, "2026-11-14"));
    if (JSON.stringify(tick(conds, null, null, HOY, "2026-11-14")) === viejo) iguales++;
    const nuevo = tick(conds, pol, cob, HOY, "2026-11-14");
    // toda clave sigue con la forma de siempre y pertenece al universo viejo de claves
    for (const x of nuevo) if (!/^\d+:[a-z_]+$/.test(x.clave) || !DOCS.includes(x.clave.split(":")[1])) clavesBien = false;
    if (nuevo.some((x) => x.clave === "1:sctr_salud_venc" && x.f === pv)) conPoliza++;
    // el conductor 3 (sin póliza) sale idéntico
    const solo3 = (l: any[]) => JSON.stringify(l.filter((x) => x.clave.startsWith("3:")));
    if (solo3(nuevo) !== solo3(JSON.parse(viejo))) clavesBien = false;
  }
  check(iguales === combos, `sin pólizas el tick es byte a byte el de antes (${iguales}/${combos})`);
  check(clavesBien, "las claves de envío no cambian de forma ni de universo; el no cubierto, idéntico");
  check(conPoliza > 0, "corolario: con póliza en ventana sí avisa con la fecha de la póliza");

  // Lector best-effort
  const sinTabla = await leerPolizasPersonas(dbFalsa({ seguros: [] }));
  check(sinTabla === null, "falta seguro_cobertura → null (ficha)");
  const conError = await leerPolizasPersonas(dbFalsa({ seguros: { error: { code: "500", message: "x" } }, seguro_cobertura: [] }));
  check(conError === null, "lectura fallida → null, no media lista");
  const bien = await leerPolizasPersonas(dbFalsa({ seguros: POL, seguro_cobertura: COB }));
  check(!!bien && bien.polizas.length === 2 && bien.coberturas.length === 2, "lee las dos");
}

console.log(`\n${fallos === 0 ? "✓" : "✗"} ${ok} ok · ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
