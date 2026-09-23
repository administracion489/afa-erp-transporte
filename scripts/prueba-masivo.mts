// Aplicar al resto del CONTRATO: seis ejes, y uno de ellos puede cobrar el día dos veces.
//
// ─── LO REPORTADO ───────────────────────────────────────────────────────────
//
//   «aquí falta poder cambiar solo PRECIO COSTO, PRECIO VENTA, y todas las
//    variables que se pueden cambiar sin afectar las demás»
//
// El modal ofrecía tres modos EXCLUYENTES (`todo` | `conductor` | `pax`): el precio de
// venta no tenía camino masivo por ningún lado, y el costo del proveedor solo viajaba
// pegado a «Empresa y unidad», o sea reescribiéndole además el bus a todo el contrato.
//
// ─── LO QUE ESTA MATRIZ EXISTE PARA IMPEDIR ─────────────────────────────────
//
// El pax alcanza a los DOS tramos del día a propósito (los asientos son del día). Copiarle
// ese filtro al dinero habría escrito la tarifa en la ida Y en el retorno de cada día del
// contrato: el cobro doble —el error más caro de este ERP— multiplicado por todo el
// contrato y ejecutado con un clic. La sección 2 barre eso como invariante dura, y la 3
// conserva el caso que lo hace sutil: el servicio que el operador ACABA de editar ya no
// está entre los candidatos, pero su hermano sí.
//
// La sección 6 corre el algoritmo VIEJO copiado literal sobre los tres ejes que ya
// existían y exige resultado IDÉNTICO: esto abre ejes nuevos, no afloja los que ya
// funcionaban.
//
// Correr:  npx tsx scripts/prueba-masivo.mts
import {
  planMasivo, tramoDelImporte, conservaSuUnidad, TEXTO_MOTIVO, TEXTO_EJE, EJES_MASIVOS,
  type ServicioMasivo, type Seleccion, type EntradaMasivo, type MotivoMasivo,
} from "../lib/reservas-masivo";
import { normalizarNombreRuta } from "../lib/liquidacion-rutas";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ── El contrato de prueba ───────────────────────────────────────────────────
// Un contrato fijo real: un día es DOS tramos enlazados, ida a las 07:00 y retorno a las
// 17:00, y la tarifa del día va en UNO de los dos.
const EMPRESA_A = 10, EMPRESA_B = 20;

type Op = Partial<ServicioMasivo>;
let seq = 0;
const dia = (
  fecha: string,
  ida: Op = {},
  ret: Op | null = {},
): ServicioMasivo[] => {
  const idIda = ++seq * 2, idRet = idIda + 1;
  const base = (id: number, dir: string, hora: string, o: Op): ServicioMasivo => ({
    id, fecha_servicio: fecha, hora_servicio: hora, direccion_servicio: dir,
    ruta_nombre: "RUTA B/ ENTRADA 07:00", estado: "confirmada",
    tipo_asignacion: "tercerizado", vehiculo_id: null,
    empresa_tercerizada_id: EMPRESA_A, vehiculo_tercero_id: null,
    precio_cliente: 0, costo_proveedor: 0, capacidad_contratada: null,
    reserva_vinculada_id: null, ...o,
  });
  const i = base(idIda, "ida", "07:00", ida);
  if (!ret) return [i];
  const r = base(idRet, "retorno", "17:00", ret);
  // El enlace se escribe en los DOS lados, que es el caso sano.
  i.reserva_vinculada_id = r.id;
  r.reserva_vinculada_id = i.id;
  return [i, r];
};

const PAYLOAD_TER = {
  tipo_asignacion: "tercerizado", tipo: "tercerizada",
  vehiculo_id: null, conductor_id: null,
  empresa_tercerizada_id: EMPRESA_A, vehiculo_tercero_id: 101, conductor_tercero_id: 201,
  costo_proveedor: 400, hora_servicio: "07:00",
};

const SEL_NADA: Seleccion = { asignacion: "no", hora: false, pax: false, precio: false, costo: false };

const entrada = (o: Partial<EntradaMasivo> & { contexto: ServicioMasivo[] }): EntradaMasivo => ({
  universo: o.contexto,
  seleccion: SEL_NADA,
  payload: PAYLOAD_TER,
  horaOriginal: "07:00",
  sentidoEditado: "ida",
  ...o,
});

/** El importe que quedaría en cada servicio después de aplicar el plan. */
const despues = (contexto: ServicioMasivo[], plan: ReturnType<typeof planMasivo>, campo: "precio_cliente" | "costo_proveedor") => {
  const patch = new Map(plan.patches.map(p => [p.id, p.patch]));
  return new Map(contexto.map(t => [
    t.id, Number(patch.get(t.id)?.[campo] ?? t[campo] ?? 0),
  ]));
};

// ── 1 · EL EJE QUE NO EXISTÍA ───────────────────────────────────────────────
titulo("1 · El precio de venta y el costo tienen camino masivo propio");
{
  const ctx = [...dia("2026-10-01", { precio_cliente: 500 }), ...dia("2026-10-02", { precio_cliente: 500 })];
  const plan = planMasivo(entrada({
    contexto: ctx, precio: 550,
    seleccion: { ...SEL_NADA, precio: true },
  }));
  ok(plan.ejes.precio.ids.length === 2, "el precio alcanza a las dos idas, que son las que lo llevan");
  ok(plan.ejes.asignacion.ids.length === 0 && plan.ejes.conductor.ids.length === 0
     && plan.ejes.hora.ids.length === 0 && plan.ejes.pax.ids.length === 0,
     "y NO toca unidad, conductor, hora ni pax: por eso es un eje y no un modo");
  ok(plan.patches.every(p => Object.keys(p.patch).join() === "precio_cliente"),
     "el patch lleva UNA columna y nada más", JSON.stringify(plan.patches[0]?.patch));
  ok(plan.dinero.precio?.antes === 1000 && plan.dinero.precio?.despues === 1100,
     "y declara cuánta plata mueve, para poder nombrarla antes de autorizarla",
     JSON.stringify(plan.dinero.precio));

  const soloCosto = planMasivo(entrada({
    contexto: ctx, costo: 380, seleccion: { ...SEL_NADA, costo: true },
  }));
  ok(soloCosto.patches.every(p => Object.keys(p.patch).join() === "costo_proveedor"),
     "el costo del proveedor se corrige SIN reescribirle el bus a todo el contrato");
}

// ── 2 · LA INVARIANTE DURA ──────────────────────────────────────────────────
titulo("2 · Ningún día termina con importe en sus DOS tramos por causa del masivo");
{
  // Barrido: dónde vive hoy el importe × sentido del servicio editado × qué eje está
  // activo × si además se reasigna × si se incluyó el otro horario.
  const dondeVive = ["ida", "retorno", "ninguno", "ambos"] as const;
  let barridos = 0, dobles = 0, casosConEscritura = 0;

  for (const vive of dondeVive) {
    for (const sentidoEditado of ["ida", "retorno"]) {
      for (const otraHora of [false, true]) {
        for (const conAsignacion of [false, true]) {
          for (const lado of ["precio", "costo"] as const) {
            seq = 0;
            const campo = lado === "precio" ? "precio_cliente" : "costo_proveedor";
            const monto = (quien: "ida" | "retorno") =>
              vive === "ambos" || vive === quien ? { [campo]: 500 } : {};
            const ctx = [
              ...dia("2026-10-01", monto("ida"), monto("retorno")),
              ...dia("2026-10-02", monto("ida"), monto("retorno")),
            ];
            const plan = planMasivo(entrada({
              contexto: ctx, sentidoEditado, otraHora,
              precio: lado === "precio" ? 600 : null,
              costo:  lado === "costo"  ? 600 : null,
              seleccion: {
                ...SEL_NADA,
                asignacion: conAsignacion ? "completa" : "no",
                precio: lado === "precio", costo: lado === "costo",
              },
            }));
            const fin = despues(ctx, plan, campo);
            // El día, tramo por tramo: ¿quedaron los dos con importe?
            for (let i = 0; i < ctx.length; i += 2) {
              const a = fin.get(ctx[i].id)!, b = fin.get(ctx[i + 1].id)!;
              const yaEstaba = Number(ctx[i][campo] ?? 0) > 0 && Number(ctx[i + 1][campo] ?? 0) > 0;
              if (a > 0 && b > 0 && !yaEstaba) dobles++;
            }
            if (plan.ejes[lado].ids.length > 0) casosConEscritura++;
            barridos++;
          }
        }
      }
    }
  }
  ok(dobles === 0, `jamás se deja un día con importe en los dos tramos (${barridos} combinaciones)`);
  // El corolario, porque un motor que no escribiera NUNCA cumpliría lo anterior de forma
  // trivial y dejaría la funcionalidad apagada sin que nadie lo note.
  ok(casosConEscritura > 0, "y el importe SÍ se escribe en la mayoría de los casos", casosConEscritura);
}

// ── 3 · EL SERVICIO EDITADO CUENTA PARA EL DÍA ──────────────────────────────
titulo("3 · El hermano del servicio recién editado NO recibe el importe");
{
  seq = 0;
  // El operador abrió la IDA del 01-10, le puso S/ 550 y guardó. Esa fila ya no está
  // entre los candidatos, pero su retorno sí — y el día ya está cobrado.
  const [ida1, ret1] = dia("2026-10-01", { precio_cliente: 550 }, { precio_cliente: 0 });
  const [ida2, ret2] = dia("2026-10-02", { precio_cliente: 500 }, { precio_cliente: 0 });
  const contexto = [ida1, ret1, ida2, ret2];
  const universo = [ret1, ida2, ret2];   // sin el editado

  const plan = planMasivo(entrada({
    contexto, universo, precio: 550, seleccion: { ...SEL_NADA, precio: true },
  }));
  ok(!plan.ejes.precio.ids.includes(ret1.id),
     "el retorno del día editado queda fuera: su ida ya cobra el día");
  ok(plan.ejes.precio.fuera.some(f => f.motivo === "importe_en_el_otro_tramo"),
     "y lo dice con su código, no en silencio",
     JSON.stringify(plan.ejes.precio.fuera));
  ok(plan.ejes.precio.ids.includes(ida2.id) && !plan.ejes.precio.ids.includes(ret2.id),
     "mientras el otro día sí lo recibe, y solo en su ida");

  // El mismo caso SIN contexto es exactamente el bug que esto evita.
  const sinContexto = planMasivo(entrada({
    contexto: universo, universo, precio: 550, seleccion: { ...SEL_NADA, precio: true },
  }));
  ok(sinContexto.ejes.precio.ids.includes(ret1.id),
     "(y sin el editado a la vista, ese retorno SÍ se llevaría la tarifa: por eso viaja el contexto)");
}

// ── 4 · EL DINERO NO SE ADIVINA ─────────────────────────────────────────────
titulo("4 · Los días que no se pueden decidir se NOMBRAN, no se escriben");
{
  const casos: { que: string; ida: Op; ret: Op | null; esperado: MotivoMasivo | "ok" }[] = [
    { que: "el importe está en la ida", ida: { precio_cliente: 500 }, ret: {}, esperado: "ok" },
    { que: "el importe está en el retorno", ida: {}, ret: { precio_cliente: 500 }, esperado: "importe_en_el_otro_tramo" },
    { que: "los dos tramos ya llevan importe", ida: { precio_cliente: 500 }, ret: { precio_cliente: 500 }, esperado: "dia_ya_duplicado" },
    { que: "el importe quedó en el tramo cancelado", ida: { precio_cliente: 500, estado: "cancelada" }, ret: {}, esperado: "importe_en_tramo_cancelado" },
    { que: "ningún tramo lleva importe", ida: {}, ret: {}, esperado: "ok" },
    { que: "día de un solo tramo", ida: {}, ret: null, esperado: "ok" },
  ];
  for (const c of casos) {
    seq = 0;
    const ctx = dia("2026-10-01", c.ida, c.ret);
    const plan = planMasivo(entrada({
      contexto: ctx, precio: 600, seleccion: { ...SEL_NADA, precio: true },
    }));
    const idaId = ctx[0].id;
    const motivo = plan.ejes.precio.ids.includes(idaId)
      ? "ok" : (plan.ejes.precio.fuera[0]?.motivo ?? "sin_veredicto");
    ok(motivo === c.esperado, `${c.que} → ${c.esperado}`, motivo);
  }

  // Dos tramos vivos, ninguno con importe y sin sentido escrito: no se adivina.
  seq = 0;
  const ciego = dia("2026-10-01", { direccion_servicio: null, ruta_nombre: "RUTA B" },
                                  { direccion_servicio: null, ruta_nombre: "RUTA B", hora_servicio: "07:00" });
  const planCiego = planMasivo(entrada({
    contexto: ciego, precio: 600, seleccion: { ...SEL_NADA, precio: true },
  }));
  ok(planCiego.ejes.precio.ids.length === 0
     && planCiego.ejes.precio.fuera.every(f => f.motivo === "no_se_sabe_que_tramo"),
     "sin sentido ni hora que los distinga, no se escribe nada y se dice por qué");
}

// ── 5 · EL COSTO ES DEL PROVEEDOR ───────────────────────────────────────────
titulo("5 · El costo solo va a quien va a ser servido por ESA empresa");
{
  seq = 0;
  const propio  = dia("2026-10-01", { tipo_asignacion: "propio", empresa_tercerizada_id: null, vehiculo_id: 7 }, null);
  const otraEmp = dia("2026-10-02", { empresa_tercerizada_id: EMPRESA_B }, null);
  const mismaE  = dia("2026-10-03", {}, null);
  const ctx = [...propio, ...otraEmp, ...mismaE];

  const plan = planMasivo(entrada({
    contexto: ctx, costo: 400, seleccion: { ...SEL_NADA, costo: true },
  }));
  ok(plan.ejes.costo.ids.length === 1 && plan.ejes.costo.ids[0] === mismaE[0].id,
     "solo el de la misma empresa proveedora");
  const motivos = new Set(plan.ejes.costo.fuera.map(f => f.motivo));
  ok(motivos.has("flota_propia"), "la flota propia queda fuera con su código: no le debe nada a un proveedor");
  ok(motivos.has("otra_empresa"), "y el de otra empresa también: su tarifa no es esta");

  // …salvo que en la misma tanda se le esté ASIGNANDO esa empresa: ahí sí es suya.
  const conReasignacion = planMasivo(entrada({
    contexto: ctx, costo: 400, otraHora: true, otraUnidad: true,
    seleccion: { ...SEL_NADA, asignacion: "completa", costo: true },
  }));
  ok(conReasignacion.ejes.costo.ids.length === 3,
     "reasignándolos a esa empresa, los tres reciben su tarifa: los ejes se leen juntos",
     JSON.stringify(conReasignacion.ejes.costo.ids));

  // Y el precio del CLIENTE no mira al proveedor: es del cliente, lo opere quien lo opere.
  const planPrecio = planMasivo(entrada({
    contexto: ctx, precio: 900, seleccion: { ...SEL_NADA, precio: true },
  }));
  ok(planPrecio.ejes.precio.ids.length === 3,
     "el precio de venta alcanza a los tres: quién opera el bus no cambia lo que paga el cliente");
}

// ── 6 · LO QUE YA FUNCIONABA, IDÉNTICO ──────────────────────────────────────
titulo("6 · Los tres ejes que ya existían dan el MISMO resultado que antes");
{
  /** EL ALGORITMO VIEJO, copiado literal de app/programacion/page.tsx (targetsAplicar). */
  const targetsVIEJO = (
    m: { otrasReservas: any[]; payload: any; horaOriginal: string; pax: number | null; paxAntes: number | null; rutasObjetivo: string[] },
    aplicarCampos: "todo" | "conductor" | "pax",
    aplicarScope: "todos" | "rango", aplicarDesde: string, aplicarHasta: string,
    aplicarOtraHora: boolean, aplicarOtraUnidad: boolean,
  ) => {
    const conservaUnidad = (r: any, payload: any) => {
      const pisa = (actual: any, nuevo: any) =>
        actual !== null && actual !== undefined && actual !== (nuevo ?? null);
      return !pisa(r.vehiculo_id, payload.vehiculo_id)
          && !pisa(r.empresa_tercerizada_id, payload.empresa_tercerizada_id)
          && !pisa(r.vehiculo_tercero_id, payload.vehiculo_tercero_id);
    };
    const porId = new Map(m.otrasReservas.map(r => [r.id, r]));
    const cuantos = new Map<number, number>();
    for (const r of m.otrasReservas) {
      const v = Number(r.reserva_vinculada_id ?? 0);
      if (v) cuantos.set(v, (cuantos.get(v) ?? 0) + 1);
    }
    const inverso = new Map<number, any>();
    for (const r of m.otrasReservas) {
      const v = Number(r.reserva_vinculada_id ?? 0);
      if (v && cuantos.get(v) === 1) inverso.set(v, r);
    }
    const de = (r: any) => (r.reserva_vinculada_id ? porId.get(Number(r.reserva_vinculada_id)) : undefined) ?? inverso.get(r.id);
    const motivoPax = (r: any) => {
      if (m.rutasObjetivo.length) {
        const suyas = [normalizarNombreRuta(r.ruta_nombre), normalizarNombreRuta(de(r)?.ruta_nombre)].filter(Boolean);
        if (suyas.length && !suyas.some(e => m.rutasObjetivo.includes(e))) return "otra_ruta";
      }
      const actual = r.capacidad_contratada ?? de(r)?.capacidad_contratada ?? null;
      return actual === null || actual === m.paxAntes || actual === m.pax ? "ok" : "otra_capacidad";
    };
    const soloConductor = aplicarCampos === "conductor";
    const soloPax = aplicarCampos === "pax";
    return m.otrasReservas.filter(r => {
      if (soloPax) {
        if (aplicarScope === "rango") {
          if (!r.fecha_servicio) return false;
          if (aplicarDesde && r.fecha_servicio < aplicarDesde) return false;
          if (aplicarHasta && r.fecha_servicio > aplicarHasta) return false;
        }
        return motivoPax(r) === "ok";
      }
      if (!aplicarOtraHora && (r.hora_servicio?.slice(0, 5) || "") !== m.horaOriginal) return false;
      if (soloConductor) {
        if (r.tipo_asignacion && r.tipo_asignacion !== m.payload.tipo_asignacion) return false;
        if (m.payload.tipo_asignacion === "tercerizado" &&
            r.empresa_tercerizada_id !== m.payload.empresa_tercerizada_id) return false;
      } else if (!aplicarOtraUnidad && !conservaUnidad(r, m.payload)) return false;
      if (aplicarScope === "rango") {
        if (!r.fecha_servicio) return false;
        if (aplicarDesde && r.fecha_servicio < aplicarDesde) return false;
        if (aplicarHasta && r.fecha_servicio > aplicarHasta) return false;
      }
      return true;
    }).map((r: any) => r.id).sort((a: number, b: number) => a - b);
  };

  let barridos = 0, distintos = 0;
  const variantes: Op[] = [
    {}, { vehiculo_tercero_id: 999 }, { empresa_tercerizada_id: EMPRESA_B },
    { tipo_asignacion: "propio", empresa_tercerizada_id: null, vehiculo_id: 5 },
    { capacidad_contratada: 30 }, { ruta_nombre: "RUTA C/ ENTRADA 06:35" },
  ];
  for (const vIda of variantes) {
    for (const vRet of variantes) {
      for (const campos of ["todo", "conductor", "pax"] as const) {
        for (const otraHora of [false, true]) {
          for (const otraUnidad of [false, true]) {
            for (const rango of [false, true]) {
              seq = 0;
              const ctx = [...dia("2026-10-01", vIda, vRet), ...dia("2026-10-05", vIda, vRet)];
              const desde = rango ? "2026-10-01" : null, hasta = rango ? "2026-10-03" : null;
              const viejo = targetsVIEJO(
                { otrasReservas: ctx, payload: PAYLOAD_TER, horaOriginal: "07:00",
                  pax: 15, paxAntes: null, rutasObjetivo: [normalizarNombreRuta("RUTA B/ ENTRADA 07:00")] },
                campos, rango ? "rango" : "todos", desde ?? "", hasta ?? "", otraHora, otraUnidad,
              );
              const plan = planMasivo(entrada({
                contexto: ctx, desde, hasta, otraHora, otraUnidad,
                pax: 15, paxAntes: null,
                rutasObjetivo: [normalizarNombreRuta("RUTA B/ ENTRADA 07:00")],
                seleccion: {
                  ...SEL_NADA,
                  asignacion: campos === "todo" ? "completa" : campos === "conductor" ? "conductor" : "no",
                  pax: campos === "pax",
                },
              }));
              const eje = campos === "todo" ? plan.ejes.asignacion
                        : campos === "conductor" ? plan.ejes.conductor : plan.ejes.pax;
              const nuevo = [...eje.ids].sort((a, b) => a - b);
              if (JSON.stringify(viejo) !== JSON.stringify(nuevo)) {
                distintos++;
                if (distintos <= 3)
                  console.log(`      · ${campos} otraHora=${otraHora} otraUnidad=${otraUnidad} rango=${rango} `
                            + `${JSON.stringify(vIda)}/${JSON.stringify(vRet)}: ${viejo} ≠ ${nuevo}`);
              }
              barridos++;
            }
          }
        }
      }
    }
  }
  ok(distintos === 0, `asignación, conductor y pax alcanzan exactamente a los mismos (${barridos} combinaciones)`);
}

// ── 7 · LA HORA SALE DE SU ESCONDITE ────────────────────────────────────────
titulo("7 · La hora es su propio eje, y solo mueve a los que salían a la hora vieja");
{
  seq = 0;
  const ctx = [
    ...dia("2026-10-01", {}, null),
    ...dia("2026-10-02", { hora_servicio: "09:00" }, null),
  ];
  const plan = planMasivo(entrada({
    contexto: ctx, horaNueva: "06:30", seleccion: { ...SEL_NADA, hora: true },
  }));
  ok(plan.ejes.hora.ids.length === 1 && plan.ejes.hora.ids[0] === ctx[0].id,
     "solo el que hoy sale a las 07:00");
  ok(plan.ejes.hora.fuera.some(f => f.motivo === "otra_hora_de_origen"),
     "y el de las 09:00 queda fuera con su código: correrlo lo desalinearía");
  ok(JSON.stringify(plan.idsConHora) === JSON.stringify(plan.ejes.hora.ids),
     "los paraderos se corren EXACTAMENTE a los que se llevan la hora nueva");

  // La asignación ya no arrastra la hora a escondidas.
  const soloAsignacion = planMasivo(entrada({
    contexto: ctx, horaNueva: "06:30", seleccion: { ...SEL_NADA, asignacion: "completa" },
  }));
  ok(soloAsignacion.patches.every(p => !("hora_servicio" in p.patch)),
     "con la casilla de hora apagada, la asignación NO le mueve el horario a nadie");
  ok(soloAsignacion.patches.every(p => !("costo_proveedor" in p.patch)),
     "ni le escribe el costo: los dos tienen su propio eje");
  ok(soloAsignacion.idsConHora.length === 0, "y no se corre ningún paradero");

  // LA EXCEPCIÓN QUE SÍ TIENE QUE VIAJAR: pasar un servicio a la flota PROPIA le borra la
  // deuda con el proveedor. Soltarla dejaría el costo del tercero escrito en un servicio
  // que ahora cubre AFA, y de ahí se va a v_costo_servicio y a v_egresos.
  seq = 0;
  const conCosto = dia("2026-10-01", { costo_proveedor: 400 }, null);
  const aPropia = planMasivo(entrada({
    contexto: conCosto, otraUnidad: true,
    payload: { tipo_asignacion: "propio", tipo: "propia", vehiculo_id: 9, conductor_id: 3,
               empresa_tercerizada_id: null, vehiculo_tercero_id: null, conductor_tercero_id: null,
               costo_proveedor: 0, hora_servicio: "07:00" },
    seleccion: { ...SEL_NADA, asignacion: "completa" },
  }));
  ok(aPropia.patches[0]?.patch.costo_proveedor === 0,
     "al pasarlo a la flota propia, el costo del proveedor SÍ se pone en 0",
     JSON.stringify(aPropia.patches[0]?.patch));
}

// ── 8 · DISJUNTOS Y EXHAUSTIVOS ─────────────────────────────────────────────
titulo("8 · Todo candidato está explicado: o lo recibe, o se dice por qué no");
{
  let barridos = 0, huerfanos = 0, sinTexto = 0;
  const vistos = new Set<MotivoMasivo>();
  for (const vIda of [{}, { precio_cliente: 500 }, { estado: "cancelada", precio_cliente: 500 },
                      { tipo_asignacion: "propio", empresa_tercerizada_id: null },
                      { capacidad_contratada: 30 }] as Op[]) {
    for (const vRet of [{}, { precio_cliente: 500 }, null] as (Op | null)[]) {
      for (const sel of [
        { ...SEL_NADA, asignacion: "completa" as const },
        { ...SEL_NADA, asignacion: "conductor" as const },
        { ...SEL_NADA, hora: true }, { ...SEL_NADA, pax: true },
        { ...SEL_NADA, precio: true }, { ...SEL_NADA, costo: true },
      ]) {
        seq = 0;
        const ctx = [...dia("2026-10-01", vIda, vRet), ...dia("2026-10-09", vIda, vRet)];
        const plan = planMasivo(entrada({
          contexto: ctx, seleccion: sel, horaNueva: "06:30",
          desde: "2026-10-01", hasta: "2026-10-05",
          pax: 15, paxAntes: null, precio: 600, costo: 400,
          rutasObjetivo: [normalizarNombreRuta("RUTA B/ ENTRADA 07:00")],
          liquidadasCliente: new Set<number>([ctx[0].id]),
        }));
        for (const eje of EJES_MASIVOS) {
          const r = plan.ejes[eje];
          if (!r.ids.length && !r.fuera.length) continue;   // eje apagado
          const explicados = r.ids.length + r.fuera.reduce((s, f) => s + f.cuantos, 0);
          if (explicados !== ctx.length) huerfanos++;
          for (const f of r.fuera) {
            vistos.add(f.motivo);
            if (!TEXTO_MOTIVO[f.motivo]) sinTexto++;
          }
        }
        barridos++;
      }
    }
  }
  ok(huerfanos === 0, `ningún candidato queda sin veredicto (${barridos} combinaciones)`);
  ok(sinTexto === 0, "y todo motivo que sale tiene su texto: la pantalla enruta por código");
  ok(vistos.has("ya_liquidado"),
     "un servicio ya dentro de una liquidación emitida no se toca desde acá", [...vistos].join(" · "));
  ok(EJES_MASIVOS.every(e => !!TEXTO_EJE[e]), "los seis ejes tienen rótulo");
  ok(Object.keys(TEXTO_MOTIVO).length >= vistos.size + 1, "y la tabla de textos cubre todos los códigos");
}

// ── 9 · LO QUE NO SE ESCRIBE ────────────────────────────────────────────────
titulo("9 · Nunca se propagan estado, fecha ni observaciones");
{
  seq = 0;
  const ctx = [...dia("2026-10-01", { estado: "pendiente" }, null), ...dia("2026-10-02", { estado: "pendiente" }, null)];
  const todo: Seleccion = { asignacion: "completa", hora: true, pax: true, precio: true, costo: true };
  const plan = planMasivo(entrada({
    contexto: ctx, seleccion: todo, horaNueva: "06:30",
    pax: 15, paxAntes: null, precio: 600, costo: 400,
    estadoPendientes: "confirmada",
  }));
  const campos = new Set(plan.patches.flatMap(p => Object.keys(p.patch)));
  ok(!campos.has("fecha_servicio"), "la fecha nunca viaja: es lo único que distingue a un servicio de otro");
  ok(!campos.has("observaciones"), "ni las observaciones: son de ESE día");
  ok(campos.has("estado"), "el pendiente completamente asignado sí se confirma");

  // …pero solo por la asignación completa. Corregir una tarifa no programa ningún bus.
  const soloDinero = planMasivo(entrada({
    contexto: ctx, seleccion: { ...SEL_NADA, precio: true }, precio: 600,
    estadoPendientes: "confirmada",
  }));
  ok(soloDinero.patches.every(p => !("estado" in p.patch)),
     "corregir el precio NO confirma nada: sería mentirle al tablero");
}

// ── 10 · SIN CAMBIO NO ES UN CAMBIO ─────────────────────────────────────────
titulo("10 · El número que autoriza una persona es honesto");
{
  seq = 0;
  const ctx = [
    ...dia("2026-10-01", { precio_cliente: 550 }, null),
    ...dia("2026-10-02", { precio_cliente: 500 }, null),
  ];
  const plan = planMasivo(entrada({
    contexto: ctx, precio: 550, seleccion: { ...SEL_NADA, precio: true },
  }));
  ok(plan.ejes.precio.ids.length === 1,
     "el que ya dice S/ 550 no se cuenta como un servicio que va a cambiar");
  ok(plan.ejes.precio.fuera.some(f => f.motivo === "sin_cambio"), "y se declara como tal");
  ok(plan.dinero.precio?.antes === 500 && plan.dinero.precio?.despues === 550,
     "los soles del aviso son los del cambio REAL", JSON.stringify(plan.dinero.precio));
}

// ── 11 · EL PAX DE LO QUE YA SE PRESTÓ ──────────────────────────────────────
//
// Reportado desde la pantalla, con el contrato #240 a la vista: «no me permite cambiar
// los PAX de servicios pasados, al colocar fecha para cambio masivo no deja el sistema».
// El modal contaba 1 812 servicios activos y decía «Aplicar a 0 servicio(s)»: 1 582
// `otra_ruta` + 230 `fuera_de_rango`, cero destinatarios.
//
// Eran DOS defectos a la vez, y esta sección fija los dos.
titulo("11 · El PAX alcanza lo ya prestado; el despacho no");
{
  seq = 0;
  // Un contrato con la misma RUTA C en dos horarios (dos móviles) y días ya pasados.
  const ctx = [
    ...dia("2026-09-18", { ruta_nombre: "RUTA C/ 04:35- 17:00", estado: "finalizada" },
                         { ruta_nombre: "RUTA C/ 04:35- 17:00", estado: "finalizada" }),
    ...dia("2026-09-19", { ruta_nombre: "RUTA C/ 06:35- 15:00", estado: "finalizada" },
                         { ruta_nombre: "RUTA C/ 06:35- 15:00", estado: "finalizada" }),
    ...dia("2026-12-01", { ruta_nombre: "RUTA C/ 06:35- 15:00" },
                         { ruta_nombre: "RUTA C/ 06:35- 15:00" }),
  ];
  const base = {
    contexto: ctx, hoy: "2026-09-23",
    pax: 50, paxAntes: null,
    rutasObjetivo: [normalizarNombreRuta("RUTA C/ 04:35- 17:00")],
  };

  const plan = planMasivo(entrada({ ...base, seleccion: { ...SEL_NADA, pax: true } }));
  ok(plan.ejes.pax.ids.length === 6,
     "los SEIS tramos reciben los asientos: los del 18, los del 19 y los de diciembre",
     `${plan.ejes.pax.ids.length} de 6`);
  ok(plan.ejes.pax.fuera.length === 0, "y nada queda fuera",
     JSON.stringify(plan.ejes.pax.fuera));

  // Defecto 1 · el NOMBRE lleva la hora dentro.
  const soloExacto = ctx.filter(r =>
    normalizarNombreRuta(r.ruta_nombre) === normalizarNombreRuta("RUTA C/ 04:35- 17:00"));
  ok(soloExacto.length === 2,
     "con el nombre COMPLETO solo casaban los del 04:35 — cada móvil era «otra ruta»");
  ok(plan.ejes.pax.ids.length > soloExacto.length,
     "comparar sin la hora es lo que hace que el eje alcance a la ruta entera");

  // Defecto 2 · el universo excluía lo pasado y lo finalizado.
  const universoVIEJO = ctx.filter(r =>
    r.estado !== "cancelada" && r.estado !== "finalizada" && r.estado !== "en_curso" &&
    (r.fecha_servicio || "") >= "2026-09-23");
  ok(universoVIEJO.length === 2,
     "el universo viejo dejaba fuera los cuatro tramos ya prestados antes de contarlos");
  const planVIEJO = planMasivo(entrada({
    ...base, contexto: ctx, universo: universoVIEJO, seleccion: { ...SEL_NADA, pax: true },
  }));
  ok(planVIEJO.ejes.pax.ids.length === 2,
     "y con él, corregir el PAX del 18 de septiembre era imposible desde esta pantalla");
}
{
  // Y el guard NO se perdió: sigue frenando al despacho, ahora con su código.
  seq = 0;
  const ctx = [
    ...dia("2026-09-18", { estado: "finalizada" }, null),
    ...dia("2026-09-23", { estado: "en_curso" }, null),
    ...dia("2026-12-01", {}, null),
  ];
  const base = { contexto: ctx, hoy: "2026-09-23", otraUnidad: true, otraHora: true };

  const asign = planMasivo(entrada({ ...base, seleccion: { ...SEL_NADA, asignacion: "completa" } }));
  ok(asign.ejes.asignacion.ids.length === 1,
     "la asignación solo alcanza al de diciembre", asign.ejes.asignacion.ids.length);
  ok(asign.ejes.asignacion.fuera.some(f => f.motivo === "ya_ocurrio"),
     "el ya prestado queda fuera con su código: reasignarlo reescribe el historial");
  ok(asign.ejes.asignacion.fuera.some(f => f.motivo === "en_ruta"),
     "y el que va en ruta también: no se le cambia el bus a media carretera");

  const hora = planMasivo(entrada({
    ...base, horaNueva: "06:30", seleccion: { ...SEL_NADA, hora: true },
  }));
  ok(hora.ejes.hora.ids.length === 1,
     "la hora tampoco se le corre a lo que ya pasó: su paradero es contra el que se midió el retraso",
     hora.ejes.hora.ids.length);

  const pax = planMasivo(entrada({ ...base, pax: 50, seleccion: { ...SEL_NADA, pax: true } }));
  ok(pax.ejes.pax.ids.length === 3,
     "y el PAX sí llega a los tres: los asientos son del CONTRATO, no del despacho",
     pax.ejes.pax.ids.length);
}
{
  // LO QUE NO SE AFLOJA: ensanchar la ruta no pisa los asientos de otro móvil.
  seq = 0;
  const ctx = [
    ...dia("2026-10-01", { ruta_nombre: "RUTA C/ 04:35", capacidad_contratada: 50 }, null),
    ...dia("2026-10-02", { ruta_nombre: "RUTA C/ 06:35", capacidad_contratada: 30 }, null),
    ...dia("2026-10-03", { ruta_nombre: "RUTA A/ 04:35", capacidad_contratada: 50 }, null),
  ];
  const plan = planMasivo(entrada({
    contexto: ctx, pax: 45, paxAntes: 50,
    rutasObjetivo: [normalizarNombreRuta("RUTA C/ 04:35")],
    seleccion: { ...SEL_NADA, pax: true },
  }));
  ok(plan.ejes.pax.ids.length === 1 && plan.ejes.pax.ids[0] === ctx[0].id,
     "el móvil de 30 asientos NO recibe los 45: lo protege la CAPACIDAD, que es exacta",
     JSON.stringify(plan.ejes.pax.ids));
  ok(plan.ejes.pax.fuera.some(f => f.motivo === "otra_capacidad"),
     "y queda fuera con ese código, no con el de la ruta");
  ok(plan.ejes.pax.fuera.some(f => f.motivo === "otra_ruta"),
     "la RUTA A sigue siendo otra ruta: sin la hora no significa sin el nombre");
}

// ── Resultado ───────────────────────────────────────────────────────────────
console.log(`\n${fallos === 0 ? "✓ TODO EN VERDE" : `✗ ${fallos} FALLA(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
