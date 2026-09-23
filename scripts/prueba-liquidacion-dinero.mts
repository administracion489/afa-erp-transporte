// Corregir el dinero del periodo DESDE el cierre: a qué tramo del día se le escribe.
//
// ─── LO PEDIDO ──────────────────────────────────────────────────────────────
//
//   «ahora quiero el costo también se pueda cambiar desde liquidaciones»
//
// Se podía CARGAR el que faltaba (`sinCosto.length > 0`) y nada más: en cuanto no
// faltaba ninguno el botón desaparecía, así que la única pantalla que ve el dinero del
// mes entero no ofrecía corregirlo. Renegociar una tarifa era abrir los servicios de a
// uno desde Programación.
//
// ─── LO QUE ESTA MATRIZ EXISTE PARA IMPEDIR ─────────────────────────────────
//
// Abrir esos dos modales a los importes YA CARGADOS mete la mina más cara de este ERP
// dentro de un botón que aplica un número a 22 servicios de un clic: un día cuya tarifa
// vive en el RETORNO —porque la ida se canceló y el retorno sí corrió— recibiría el
// importe nuevo en la IDA, y el día quedaría cobrado DOS VECES.
//
// La sección 2 barre esa invariante: ningún día termina con importe en sus dos tramos
// por causa del plan. Con su corolario en la 6, porque un motor que no escribiera nunca
// la cumpliría de forma trivial.
//
// La sección 1 corre las DOS originales copiadas literales (`tramoQuePaga` de
// ModalCostos y `tramoQueCobra` de ModalPrecios) sobre la rejilla entera y exige
// resultado idéntico salvo en las dos divergencias DECLARADAS en la cabecera del
// módulo, que comprueba una por una: esto abre un camino nuevo, no afloja el que ya
// funcionaba en todos los cierres cerrados hasta hoy.
//
// Correr:  npx tsx scripts/prueba-liquidacion-dinero.mts
import {
  planDeImportes, tramoQueLlevaElImporte, indiceDelDia, lotesDeEscritura,
  importeDe, campoDe, TEXTO_MOTIVO_DINERO,
  type ServicioDinero, type LadoDinero, type MotivoDinero,
} from "../lib/liquidacion-dinero";
import { sentidoDeReserva } from "../lib/liquidacion-agrupacion";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ── Los originales, copiados LITERALES ──────────────────────────────────────
// components/pactos/ModalCostos.tsx (memo `grupos`), tal cual estaba:
const VIEJO_COSTOS = (a: ServicioDinero, b?: ServicioDinero | null): ServicioDinero => {
  const hecho = (x?: ServicioDinero | null) => String((x as any)?.estado ?? "").toLowerCase() === "finalizada";
  const esRetorno = (x?: ServicioDinero | null) => String(x?.direccion_servicio ?? "").toLowerCase() === "retorno";
  if (!b) return a;
  if (hecho(a) !== hecho(b)) return hecho(a) ? a : b;
  return esRetorno(a) ? b! : a;
};
// app/liquidaciones/ModalPrecios.tsx (memo `grupos`), tal cual estaba:
const VIEJO_PRECIOS = (a: ServicioDinero, b?: ServicioDinero | null): ServicioDinero => {
  const hecho = (r?: ServicioDinero | null) => String(r?.estado ?? "").toLowerCase() === "finalizada";
  if (!b) return a;
  if (hecho(a) !== hecho(b)) return hecho(a) ? a : b;
  return sentidoDeReserva(a as any) === "IDA" ? a : b!;
};

// ── El día de prueba ────────────────────────────────────────────────────────
let seq = 0;
const tramo = (p: Partial<ServicioDinero>): ServicioDinero => ({
  id: ++seq, codigo: `OS-${seq}`, fecha_servicio: "2026-10-01", hora_servicio: "07:00",
  direccion_servicio: "ida", estado: "programada", ...p,
});
/** Un día enlazado por los dos lados, como lo deja `ModalGenerarPrograma`. */
const dia = (ida: Partial<ServicioDinero>, ret: Partial<ServicioDinero> | null): ServicioDinero[] => {
  const i = tramo({ direccion_servicio: "ida", hora_servicio: "07:00", ...ida });
  if (!ret) return [i];
  const r = tramo({ direccion_servicio: "retorno", hora_servicio: "18:00", ...ret });
  i.reserva_vinculada_id = r.id; r.reserva_vinculada_id = i.id;
  return [i, r];
};

const LADOS: LadoDinero[] = ["precio", "costo"];
const ESTADOS = ["programada", "finalizada", "cancelada", "en_curso"];
const DIRECCIONES = ["ida", "retorno", ""];

// ════════════════════════════════════════════════════════════════════════════
titulo("1 · Se EXTRAJO, no se reescribió: las dos originales, literales");
{
  let comparadas = 0, divCancel = 0, divSentido = 0, divOrden = 0, otras = 0;
  const ejemplosOtras: string[] = [];

  for (const lado of LADOS)
  for (const eIda of ESTADOS) for (const eRet of ESTADOS)
  for (const dIda of DIRECCIONES) for (const dRet of DIRECCIONES)
  for (const nIda of ["RUTA A ENTRADA", "RUTA A RETORNO"])
  for (const nRet of ["RUTA A ENTRADA", "RUTA A RETORNO"]) {
    seq = 0;
    // Sin importe en ninguno de los dos: es el ÚNICO camino que los modales recorrían
    // hasta hoy (los alimentaba `sin_costo` / `sin_precio`), y es el que no se afloja.
    const [i, r] = dia(
      { estado: eIda, direccion_servicio: dIda, ruta_nombre: nIda },
      { estado: eRet, direccion_servicio: dRet, ruta_nombre: nRet }
    );
    const nuevo = tramoQueLlevaElImporte([i, r], lado).tramo;
    const viejoC = VIEJO_COSTOS(i, r);
    const viejoP = VIEJO_PRECIOS(i, r);
    comparadas++;

    const hayCancelada = eIda === "cancelada" || eRet === "cancelada";
    const igualC = nuevo?.id === viejoC.id;
    const igualP = nuevo?.id === viejoP.id;
    if (igualC && igualP) continue;

    if (hayCancelada) { divCancel++; continue; }              // divergencia 1, declarada
    // Divergencia 3: ningún candidato es la IDA (día degenerado, los dos dicen vuelta).
    // Las originales devolvían «el segundo»; el motor elige el id menor, que es estable.
    const ningunaIda = sentidoDeReserva(i as any) === "RETORNO" && sentidoDeReserva(r as any) === "RETORNO";
    if (ningunaIda && nuevo?.id === Math.min(i.id, r.id)) { divOrden++; continue; }
    // Divergencia 2: ModalCostos leía el sentido solo de `direccion_servicio`.
    if (igualP && !igualC && (dIda !== "ida" && dIda !== "retorno")) { divSentido++; continue; }
    otras++;
    if (ejemplosOtras.length < 4)
      ejemplosOtras.push(`${lado} ${eIda}/${eRet} ${dIda}|${dRet} ${nIda}|${nRet} → ${nuevo?.id} vs C${viejoC.id} P${viejoP.id}`);
  }

  ok(comparadas === 2 * 4 * 4 * 3 * 3 * 2 * 2, `se barrieron ${comparadas} combinaciones`, comparadas);
  ok(otras === 0, "toda divergencia con las dos originales es una de las TRES declaradas",
     ejemplosOtras.join(" · "));
  ok(divCancel > 0, "y la divergencia 1 existe de verdad: un tramo cancelado deja de recibir dinero", divCancel);
  ok(divSentido > 0, "y la 2 también: el sentido se resuelve con sentidoDeReserva, no con una copia", divSentido);
  ok(divOrden > 0, "y la 3: sin ninguna ida, el destinatario deja de depender del orden", divOrden);
}

// ════════════════════════════════════════════════════════════════════════════
titulo("2 · INVARIANTE DURA · ningún día acaba con importe en sus DOS tramos");
{
  let casos = 0, dobles = 0, escrituras = 0;
  const IMPORTES: [number, number][] = [[0, 0], [500, 0], [0, 500], [400, 600]];

  for (const lado of LADOS)
  for (const [vIda, vRet] of IMPORTES)
  for (const eIda of ESTADOS) for (const eRet of ESTADOS)
  for (const teclearEn of ["ida", "retorno", "ambos"] as const)
  for (const importe of [0, 480]) {
    seq = 0;
    const campo = campoDe(lado);
    const [i, r] = dia(
      { estado: eIda, [campo]: vIda } as any,
      { estado: eRet, [campo]: vRet } as any
    );
    const tecleado = teclearEn === "ida" ? [{ id: i.id, importe }]
      : teclearEn === "retorno" ? [{ id: r.id, importe }]
      : [{ id: i.id, importe }, { id: r.id, importe }];

    const plan = planDeImportes({ lado, contexto: [i, r], tecleado });
    casos++;
    escrituras += plan.escribir.length;

    // Se aplica el plan sobre una copia y se mira el día resultante.
    const despues = [i, r].map(t => {
      const w = plan.escribir.find(x => x.id === t.id);
      return w ? { ...t, [campo]: w.importe } : t;
    }) as ServicioDinero[];
    const conImporteAntes = [i, r].filter(t => importeDe(t, lado) > 0).length;
    const conImporteDespues = despues.filter(t => importeDe(t, lado) > 0).length;

    // El día que YA venía duplicado sigue igual (no se toca, y eso es lo correcto);
    // lo que no puede pasar es que lo duplique el plan.
    if (conImporteDespues > 1 && conImporteAntes <= 1) {
      dobles++;
      if (dobles <= 3)
        console.log(`        ↳ ${lado} ${eIda}/${eRet} ${vIda}|${vRet} teclea ${teclearEn} ${importe}`);
    }
  }

  ok(casos === 2 * 4 * 4 * 4 * 3 * 2, `se barrieron ${casos} combinaciones`, casos);
  ok(dobles === 0, "NINGÚN día pasa a tener importe en sus dos tramos POR CAUSA del plan");
  ok(escrituras > 0, "corolario: el motor SÍ escribe (uno que no escribiera nunca cumpliría lo anterior)", escrituras);
}

// ════════════════════════════════════════════════════════════════════════════
titulo("3 · El día cuya tarifa vive en el RETORNO — la mina del modo periodo");
{
  seq = 0;
  const [i, r] = dia(
    { estado: "cancelada", costo_proveedor: 0 },
    { estado: "finalizada", costo_proveedor: 664.41 }
  );
  const plan = planDeImportes({ lado: "costo", contexto: [i, r], tecleado: [{ id: i.id, importe: 480 }] });
  ok(plan.escribir.length === 1, "se escribe UN solo tramo");
  ok(plan.escribir[0]?.id === r.id,
     "y es el RETORNO, que es quien lleva la tarifa — teclear sobre la ida NO la duplica",
     `escribió en #${plan.escribir[0]?.id}, la ida es #${i.id} y el retorno #${r.id}`);
  ok(plan.escribir[0]?.antes === 664.41, "el «antes» es el del tramo que de verdad cambia");
  ok(plan.requiereMotivo, "y como pisa un importe ya pactado, el acta es obligatoria");

  // El mismo día con la regla VIEJA: el importe se habría ido a la ida.
  ok(VIEJO_COSTOS(i, r).id === r.id || VIEJO_PRECIOS(i, r).id === r.id,
     "(las viejas acertaban acá por el `finalizada`, y por eso la mina es del caso de abajo)");
}
{
  // Ninguno prestado, la ida cancelada: las viejas elegían la CANCELADA.
  seq = 0;
  const [i, r] = dia({ estado: "cancelada" }, { estado: "programada" });
  ok(VIEJO_COSTOS(i, r).id === i.id && VIEJO_PRECIOS(i, r).id === i.id,
     "las dos originales le escribían el importe al tramo CANCELADO");
  ok(tramoQueLlevaElImporte([i, r], "costo").tramo?.id === r.id,
     "el motor se lo escribe al tramo vivo: el importe huérfano deja de nacer");
}

// ════════════════════════════════════════════════════════════════════════════
titulo("4 · `escribir` y `fuera` son DISJUNTOS y EXHAUSTIVOS sobre lo tecleado");
{
  let casos = 0, malos = 0;
  for (const lado of LADOS)
  for (const vIda of [0, 500]) for (const vRet of [0, 500])
  for (const eIda of ESTADOS) for (const eRet of ESTADOS)
  for (const importe of [0, -5, 500, 480]) {
    seq = 0;
    const campo = campoDe(lado);
    const [i, r] = dia({ estado: eIda, [campo]: vIda } as any, { estado: eRet, [campo]: vRet } as any);
    const tecleado = [{ id: i.id, importe }, { id: r.id, importe }];
    const plan = planDeImportes({ lado, contexto: [i, r], tecleado });
    casos++;
    const explicados = new Set([...plan.escribir.map(x => x.idTecleado), ...plan.fuera.map(x => x.id)]);
    const disjunto = plan.escribir.every(x => !plan.fuera.some(f => f.id === x.idTecleado));
    if (explicados.size !== tecleado.length || !disjunto) malos++;
  }
  ok(casos === 2 * 2 * 2 * 4 * 4 * 4, `se barrieron ${casos} combinaciones`, casos);
  ok(malos === 0, "todo id tecleado sale en UNO de los dos, y en uno solo");
  ok(Object.keys(TEXTO_MOTIVO_DINERO).length === 4, "los cuatro motivos tienen texto", Object.keys(TEXTO_MOTIVO_DINERO).join(" · "));
}

// ════════════════════════════════════════════════════════════════════════════
titulo("5 · El acta se exige al PISAR, no al rellenar");
{
  seq = 0;
  const [a] = dia({ estado: "finalizada", costo_proveedor: 0 }, null);
  const rellena = planDeImportes({ lado: "costo", contexto: [a], tecleado: [{ id: a.id, importe: 480 }] });
  ok(!rellena.requiereMotivo, "cargar un costo que FALTA no pide motivo: es el caso de siempre");
  ok(rellena.nuevos === 1 && rellena.pisados === 0, "y se cuenta como nuevo, no como pisado");

  seq = 0;
  const [b] = dia({ estado: "finalizada", costo_proveedor: 664.41 }, null);
  const pisa = planDeImportes({ lado: "costo", contexto: [b], tecleado: [{ id: b.id, importe: 480 }] });
  ok(pisa.requiereMotivo, "cambiar uno ya pactado SÍ lo pide: el acta es la única constancia");
  ok(pisa.pisados === 1 && pisa.nuevos === 0, "y se cuenta como pisado");
  ok(pisa.totalAntes === 664.41 && pisa.totalDespues === 480,
     "la plata se NOMBRA antes de autorizarla: de qué suma a qué suma",
     `${pisa.totalAntes} → ${pisa.totalDespues}`);
}

// ════════════════════════════════════════════════════════════════════════════
titulo("6 · Lo que NO se puede aflojar: el caso de siempre sigue funcionando");
{
  // Veintidós días de la RUTA A sin costo, como llegan hoy por `sinCosto`.
  seq = 0;
  const ctx: ServicioDinero[] = [];
  const idas: number[] = [];
  for (let d = 1; d <= 22; d++) {
    const [i, r] = dia(
      { fecha_servicio: `2026-10-${String(d).padStart(2, "0")}`, estado: "finalizada" },
      { fecha_servicio: `2026-10-${String(d).padStart(2, "0")}`, estado: "finalizada" }
    );
    ctx.push(i, r); idas.push(i.id);
  }
  const plan = planDeImportes({
    lado: "costo", contexto: ctx, tecleado: idas.map(id => ({ id, importe: 480 })),
  });
  ok(plan.escribir.length === 22, "los 22 días reciben su costo", plan.escribir.length);
  ok(plan.escribir.every(x => idas.includes(x.id)), "y todos en la IDA, como hasta hoy");
  ok(!plan.requiereMotivo, "sin pedir motivo: no se pisa nada");
  ok(plan.fuera.length === 0, "y nada queda fuera");

  const lotes = lotesDeEscritura(plan, "costo", { compra_afectacion: "10" });
  ok(lotes.length === 1, "un solo UPDATE para los 22: comparten tarifa", lotes.length);
  ok(lotes[0].ids.length === 22 && lotes[0].patch.costo_proveedor === 480
     && lotes[0].patch.compra_afectacion === "10", "con el patch completo", JSON.stringify(lotes[0].patch));
}

// ════════════════════════════════════════════════════════════════════════════
titulo("7 · Teclear los DOS tramos del mismo día escribe UNA vez");
{
  seq = 0;
  const [i, r] = dia({ estado: "finalizada" }, { estado: "finalizada" });
  const plan = planDeImportes({
    lado: "precio", contexto: [i, r],
    tecleado: [{ id: i.id, importe: 550 }, { id: r.id, importe: 550 }],
  });
  ok(plan.escribir.length === 1, "una sola escritura", plan.escribir.length);
  ok(plan.fuera.some(f => f.id === r.id && f.motivo === "sin_cambio"),
     "y el otro tramo del día sale declarado, no en silencio");
}

// ════════════════════════════════════════════════════════════════════════════
titulo("8 · El día duplicado DE ANTES no se tapa");
{
  seq = 0;
  const [i, r] = dia(
    { estado: "finalizada", precio_cliente: 550 },
    { estado: "finalizada", precio_cliente: 550 }
  );
  const plan = planDeImportes({ lado: "precio", contexto: [i, r], tecleado: [{ id: i.id, importe: 600 }] });
  ok(plan.escribir.length === 0, "no se escribe nada");
  ok(plan.fuera[0]?.motivo === "dia_ya_duplicado",
     "y el motivo lo NOMBRA: se arregla en el detalle del servicio, no acá", plan.fuera[0]?.motivo);
}

// ════════════════════════════════════════════════════════════════════════════
titulo("9 · Un día entero caído no recibe dinero");
{
  seq = 0;
  const [i, r] = dia({ estado: "cancelada" }, { estado: "cancelada" });
  const plan = planDeImportes({ lado: "costo", contexto: [i, r], tecleado: [{ id: i.id, importe: 480 }] });
  ok(plan.escribir.length === 0, "no se escribe: sería el importe huérfano");
  ok(plan.fuera[0]?.motivo === "sin_tramo_vivo", "con su código", plan.fuera[0]?.motivo);
}

// ════════════════════════════════════════════════════════════════════════════
titulo("10 · El hermano se resuelve por los DOS sentidos, y solo sin ambigüedad");
{
  seq = 0;
  // Enlace escrito SOLO en el retorno (lo que deja borrar un tramo, o el paso 2 del
  // generador si nadie cerró el ciclo). Seguirlo hacia adelante partiría el día.
  const i = tramo({ direccion_servicio: "ida", estado: "finalizada", costo_proveedor: 480 });
  const r = tramo({ direccion_servicio: "retorno", estado: "finalizada", reserva_vinculada_id: i.id });
  const { delDia } = indiceDelDia([i, r]);
  ok(delDia(i).length === 2, "desde la ida se llega al retorno por el enlace inverso");
  const plan = planDeImportes({ lado: "costo", contexto: [i, r], tecleado: [{ id: r.id, importe: 500 }] });
  ok(plan.escribir.length === 1 && plan.escribir[0].id === i.id,
     "teclear sobre el retorno corrige la IDA, que es quien lleva el importe");

  seq = 0;
  // Dos filas apuntando a la misma: adivinar sería escribir dinero en el tramo ajeno.
  const x = tramo({ direccion_servicio: "ida", estado: "finalizada" });
  const y = tramo({ direccion_servicio: "retorno", estado: "finalizada", reserva_vinculada_id: x.id });
  const z = tramo({ direccion_servicio: "retorno", estado: "finalizada", reserva_vinculada_id: x.id });
  ok(indiceDelDia([x, y, z]).delDia(x).length === 1,
     "con el enlace ambiguo el día se queda solo, no se adivina", indiceDelDia([x, y, z]).delDia(x).length);
}

// ════════════════════════════════════════════════════════════════════════════
titulo("11 · El orden no decide a quién se le escribe dinero");
{
  let distintos = 0;
  for (const eIda of ESTADOS) for (const eRet of ESTADOS)
  for (const dIda of DIRECCIONES) for (const dRet of DIRECCIONES) {
    seq = 0;
    const [i, r] = dia({ estado: eIda, direccion_servicio: dIda }, { estado: eRet, direccion_servicio: dRet });
    const a = tramoQueLlevaElImporte([i, r], "costo").tramo?.id ?? null;
    const b = tramoQueLlevaElImporte([r, i], "costo").tramo?.id ?? null;
    if (a !== b) distintos++;
  }
  ok(distintos === 0, "mismo día, mismo destinatario, entre por donde entre la pantalla", distintos);
}

// ── Resultado ───────────────────────────────────────────────────────────────
console.log(`\n${fallos === 0 ? "✓ TODO EN VERDE" : `✗ ${fallos} FALLA(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
