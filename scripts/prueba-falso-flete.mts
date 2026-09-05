// Pruebas de la CANCELACIÓN y el FALSO FLETE. NO tocan la base: datos en memoria contra
// el módulo puro de agrupación.
// Uso:  npx tsx scripts/prueba-falso-flete.mts   (sale con código 1 si algo falla)
//
// Lo que fijan, que es lo que cuesta dinero si se rompe:
//
//   · una cancelación vale S/ 0.00 aunque tenga importe cargado — ese importe es
//     justo el que deja el error humano de cancelar sin borrar el costo, y pagarlo
//     por descuido es el error que no se puede deshacer;
//   · solo la marca EXPLÍCITA de falso flete hace que se pague, y solo al PROVEEDOR;
//   · el falso flete SÍ entra al documento (antes se descartaba y el avance acordado no
//     lo pagaba nadie) y nunca se funde con los servicios prestados de su ruta;
//   · "sin costo", "cancelado" y "sin cerrar" dejan de salir con el mismo mensaje: el
//     tercero mandaba a cargarle un costo a un viaje que quizá no ocurrió.
import {
  analizarServicios, agruparServicios, bloqueosDe, totalesValorizacion,
  esFalsoFlete, importeCargado, bloqueoEsTrabajo,
  type ReservaLiq, type CatalogoLiq,
} from "../lib/liquidacion-agrupacion";
import { avisosDe } from "../lib/reservas-pacto";

const cat: CatalogoLiq = {
  placaDe: (r) => (r.vehiculo_id ? `P-${r.vehiculo_id}` : ""),
  capacidadDe: () => 17,
  conductorDe: () => "VÍCTOR CERNA",
  paxContratadoDe: () => 15,
};

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const opts = {
  lado: "proveedor" as const,
  catalogo: cat,
  preciosIncluyenIgv: false,
  igvPct: 18,
  desde: "2026-08-01",
  hasta: "2026-08-31",
};

/** Un día de la RUTA B: ida 05:00 + retorno 15:00, enlazados en los dos sentidos. */
function dia(d: number, over: { ida?: Partial<ReservaLiq>; ret?: Partial<ReservaLiq> } = {}): ReservaLiq[] {
  const fecha = `2026-08-${String(d).padStart(2, "0")}`;
  const idaId = 5000 + d;
  const retId = 6000 + d;
  const base = (id: number, otro: number, sentido: "ida" | "retorno"): ReservaLiq => ({
    id,
    codigo: `OS-2026-00${id}`,
    fecha_servicio: fecha,
    hora_servicio: sentido === "ida" ? "05:00" : "15:00",
    estado: "finalizada",
    cliente_id: 1,
    empresa_tercerizada_id: 9,
    tipo_asignacion: "tercerizado",
    ruta_nombre: sentido === "ida"
      ? "RUTA B/ ENTRADA 05:00/ CHILCA→BSF"
      : "RUTA B/ RETORNO 15:00/ BSF→CHILCA",
    direccion_servicio: sentido,
    reserva_vinculada_id: otro,
    costo_proveedor: 0,
    vehiculo_id: 7,
  });
  return [
    { ...base(idaId, retId, "ida"), costo_proveedor: 664.41, ...(over.ida ?? {}) },
    { ...base(retId, idaId, "retorno"), ...(over.ret ?? {}) },
  ];
}

const cancelado = { estado: "cancelada" };

// ── 1. La cancelación con costo huérfano NO se paga ──────────────────────────
{
  // El caso real: el operador cancela y se olvida de borrar el costo del proveedor.
  const rs = dia(23, { ida: { ...cancelado }, ret: { ...cancelado } });
  const { pares, bloqueadas } = analizarServicios(rs, "proveedor");

  chk("un día cancelado no genera ningún servicio facturable", pares.length === 0,
      `${pares.length} par(es)`);
  chk("los dos tramos quedan fuera", bloqueadas.length === 2);

  const codigos = bloqueadas.flatMap((b) => b.codigos);
  chk("el motivo es la cancelación, NO 'sin costo'",
      codigos.every((c) => c === "cancelado_sin_pago"), codigos.join(","));
  chk("no alimenta el botón de costos faltantes", !codigos.includes("sin_costo"));
  chk("el mensaje nombra el acuerdo que falta",
      /falso flete/i.test(bloqueadas[0]?.motivos[0] ?? ""), bloqueadas[0]?.motivos[0]);
  chk("y NO cuenta como trabajo pendiente", !bloqueoEsTrabajo(codigos));

  // El importe sigue escrito en la fila: la pantalla tiene que poder decirlo para
  // ofrecer limpiarlo, porque ese número sí está pesando en el margen del mes.
  chk("el importe huérfano se puede seguir leyendo",
      importeCargado(rs[0], "proveedor") === 664.41);
}

// ── 2. Lo mismo del lado CLIENTE, y ahí no hay marca que valga ───────────────
{
  const rs = dia(24, {
    ida: { ...cancelado, precio_cliente: 900, falso_flete: true },
    ret: { ...cancelado },
  });
  const { pares, bloqueadas } = analizarServicios(rs, "cliente");
  chk("al cliente NO se le cobra una cancelación, ni marcada como falso flete",
      pares.length === 0, `${pares.length} par(es)`);
  chk("y el motivo lo dice sin mandar a cargar un precio",
      bloqueadas.every((b) => b.codigos.includes("cancelado_sin_pago")));
}

// ── 3. Con la marca explícita, el falso flete SÍ se paga ────────────────────
{
  // Acuerdo por el avance: el proveedor ya había llegado al punto de origen. El monto
  // acordado (S/ 120) NO es la tarifa completa del servicio.
  const rs = dia(29, {
    ida: { ...cancelado, falso_flete: true, costo_proveedor: 120, falso_flete_motivo: "ya llegó al punto de origen" },
    ret: { ...cancelado },
  });
  const { pares, bloqueadas } = analizarServicios(rs, "proveedor");

  chk("el día marcado sí es un par facturable", pares.length === 1);
  chk("y queda declarado como falso flete", pares[0]?.falsoFlete === true);
  chk("sin fingir que se prestó", pares[0]?.ejecutado === false && pares[0]?.ejecutados.length === 0);
  chk("nada queda bloqueado", bloqueadas.length === 0,
      bloqueadas.map((b) => b.motivos.join("/")).join(" · "));

  const lineas = agruparServicios(pares, opts);
  chk("sale UNA línea", lineas.length === 1, `${lineas.length}`);
  chk("con su tipo propio", lineas[0]?.tipo === "falso_flete", lineas[0]?.tipo);
  chk("cobra el día acordado, no cero", lineas[0]?.cantidad === 1 && lineas[0]?.total_linea === 120,
      `${lineas[0]?.cantidad} × ${lineas[0]?.precio_unitario}`);
  chk("la cantidad cobrada coincide con la 'ejecutada' (si no, el editor pediría un motivo de ajuste)",
      lineas[0]?.cantidad === lineas[0]?.cantidad_ejecutada);
  chk("la descripción lo dice en la primera línea",
      /^FALSO FLETE/.test(lineas[0]?.descripcion ?? ""),
      JSON.stringify((lineas[0]?.descripcion ?? "").split("\n")[0]));

  // Los DOS tramos se reclaman: si no, vuelven al pool el mes siguiente y se pagan otra vez.
  chk("el puente reclama los dos tramos del día",
      (lineas[0]?.reservas ?? []).length === 2, JSON.stringify(lineas[0]?.reservas));
  chk("y cuenta UN servicio, no dos", (lineas[0]?.servicios ?? []).length === 1);
}

// ── 4. Un falso flete NUNCA se funde con los servicios prestados de su ruta ──
{
  // Mismo nombre de ruta y MISMA tarifa: el caso que sí podría colarse.
  const rs = [
    ...dia(3),
    ...dia(4),
    ...dia(12, { ida: { ...cancelado, falso_flete: true }, ret: { ...cancelado } }),
  ];
  const { pares } = analizarServicios(rs, "proveedor");
  const lineas = agruparServicios(pares, opts);

  chk("misma ruta y misma tarifa NO se funden", lineas.length === 2,
      `${lineas.length}: ${lineas.map((l) => `${l.tipo}×${l.cantidad}`).join(", ")}`);
  const serv = lineas.find((l) => l.tipo === "servicio");
  const ff = lineas.find((l) => l.tipo === "falso_flete");
  chk("los prestados quedan en su renglón", serv?.cantidad === 2, `${serv?.cantidad}`);
  chk("y el avance en el suyo", ff?.cantidad === 1, `${ff?.cantidad}`);
  chk("el falso flete va al final del documento",
      lineas[lineas.length - 1]?.tipo === "falso_flete");

  const t = totalesValorizacion(lineas, 18);
  chk("tiene subtotal propio", t.falsos_fletes === 664.41, String(t.falsos_fletes));
  chk("no ensucia el de servicios", t.servicios === 1328.82, String(t.servicios));
  chk("y SUMA, no resta",
      t.subtotal === Math.round((t.servicios + t.falsos_fletes) * 100) / 100, String(t.subtotal));
}

// ── 5. Si el día SÍ corrió, el costo vuelve a hacer falta ───────────────────
{
  // La ida se canceló pero el retorno se prestó: al proveedor hay que pagarle.
  const rs = dia(15, { ida: { ...cancelado, costo_proveedor: 0 }, ret: { estado: "finalizada" } });
  const { bloqueadas } = analizarServicios(rs, "proveedor");
  const codigos = bloqueadas.flatMap((b) => b.codigos);
  chk("un día que corrió sigue exigiendo el costo",
      codigos.includes("sin_costo"), codigos.join(","));
  chk("y NO se lo trata como cancelado", !codigos.includes("cancelado_sin_pago"));
  chk("eso sí es trabajo pendiente", bloqueoEsTrabajo(codigos));
}

// ── 6. Lo que nadie cerró no es "sin costo": es un servicio sin cerrar ───────
{
  const rs = dia(20, { ida: { estado: "programada", costo_proveedor: 0 }, ret: { estado: "programada" } });
  const { bloqueadas } = analizarServicios(rs, "proveedor");
  const codigos = bloqueadas.flatMap((b) => b.codigos);
  chk("un día que nadie cerró se nombra por lo que es",
      codigos.every((c) => c === "no_cerrado"), codigos.join(","));
  chk("y NO manda a cargarle un costo a un viaje que quizá no ocurrió",
      !codigos.includes("sin_costo"));
  chk("el mensaje pide revisarlo y cerrarlo",
      /finalizado o cancelado/i.test(bloqueadas[0]?.motivos[0] ?? ""), bloqueadas[0]?.motivos[0]);
  chk("sigue siendo trabajo pendiente (rojo)", bloqueoEsTrabajo(codigos));
}

// ── 7. La marca sobre algo que sí se prestó no significa nada ────────────────
{
  const rs = dia(18, { ida: { falso_flete: true }, ret: {} });   // estado finalizada
  const { pares } = analizarServicios(rs, "proveedor");
  chk("un servicio prestado no es un falso flete aunque lleve la marca",
      pares[0]?.falsoFlete === false && pares[0]?.ejecutado === true);
  chk("`esFalsoFlete` exige que esté cancelado", !esFalsoFlete(rs[0]));

  const lineas = agruparServicios(pares, opts);
  chk("y su línea es un servicio normal", lineas[0]?.tipo === "servicio");
}

// ── 8. Sin la migración reservas-05 todo vale cero, que es el lado seguro ────
{
  const rs = dia(25, {
    ida: { ...cancelado, falso_flete: undefined },   // la columna no existe
    ret: { ...cancelado, falso_flete: undefined },
  });
  const { pares, bloqueadas } = analizarServicios(rs, "proveedor");
  chk("sin la columna, una cancelación no paga nada", pares.length === 0);
  chk("y se explica igual", bloqueadas.every((b) => b.codigos.includes("cancelado_sin_pago")));
}

// ── 9. El diagnóstico por tramo suelto sigue funcionando sin contexto ────────
{
  const suelto: ReservaLiq = {
    id: 1, fecha_servicio: "2026-08-05", hora_servicio: "06:00", estado: "cancelada",
    cliente_id: 1, empresa_tercerizada_id: 9, costo_proveedor: 500,
    ruta_nombre: "RUTA C/ ENTRADA 06:00/ A→B", direccion_servicio: "ida",
  };
  const b = bloqueosDe(suelto, "proveedor");
  chk("un tramo cancelado suelto también se explica bien",
      b.some((x) => x.codigo === "cancelado_sin_pago") && !b.some((x) => x.codigo === "sin_costo"),
      b.map((x) => x.codigo).join(","));
}

// ── 10. Los avisos de Programación dejan de pedir un importe que nadie debe ──
{
  const [ida, ret] = dia(23, { ida: { ...cancelado }, ret: { ...cancelado } });
  const hermano = { ...ret, falso_flete: false };

  const a = avisosDe(
    { ...ida, tipo_asignacion: "tercerizado", costo_proveedor: 0 },
    ida, hermano, "costo"
  );
  chk("un día cancelado NO dispara 'ni este tramo ni el otro tienen costo'",
      !a.some((x) => /no tienen costo|no se podrá liquidar/i.test(x.texto)),
      a.map((x) => x.texto).join(" | "));
  chk("y en su lugar explica la salida",
      a.some((x) => x.nivel === "info" && /falso flete/i.test(x.texto)),
      a.map((x) => x.texto).join(" | "));

  // Con acuerdo, los avisos del dinero vuelven a aplicar: hay un importe que cuidar.
  const conFF = avisosDe(
    { ...ida, tipo_asignacion: "tercerizado", costo_proveedor: 120, falso_flete: true },
    ida, hermano, "costo"
  );
  chk("con falso flete el día vuelve a tener importe que juzgar",
      !conFF.some((x) => /Servicio cancelado: no se paga/i.test(x.texto)));

  // Y el día que SÍ se prestó sigue exigiendo su costo, como siempre.
  const vivo = avisosDe(
    { ...ida, estado: "finalizada", tipo_asignacion: "tercerizado", costo_proveedor: 0 },
    ida, { ...ret, estado: "finalizada" }, "costo"
  );
  chk("un día prestado sin costo sigue en alerta",
      vivo.some((x) => x.nivel === "alerta"), vivo.map((x) => x.texto).join(" | "));
}

// ── 10 bis. El cierre tampoco puede negar un acuerdo que sí existe ──────────
{
  const rs = dia(26, {
    ida: { ...cancelado, falso_flete: true, costo_proveedor: 0 },
    ret: { ...cancelado },
  });
  const { pares, bloqueadas } = analizarServicios(rs, "proveedor");
  const codigos = bloqueadas.flatMap((b) => b.codigos);

  chk("marcado sin monto no llega a cobrarse", pares.length === 0);
  chk("y NO se le dice 'cancelado sin acuerdo' — el acuerdo existe",
      !codigos.includes("cancelado_sin_pago"), codigos.join(","));
  chk("se dice que falta el monto", codigos.every((c) => c === "falso_flete_sin_monto"),
      codigos.join(","));
  chk("y eso SÍ es trabajo pendiente (rojo)", bloqueoEsTrabajo(codigos));
  chk("el mensaje ofrece las dos salidas",
      /escribe el avance|quítale la marca/i.test(bloqueadas[0]?.motivos[0] ?? ""),
      bloqueadas[0]?.motivos[0]);
}

// ── 11. Marcado pero sin monto: el aviso tiene que decir ESO ────────────────
{
  const [ida, ret] = dia(23, { ida: { ...cancelado }, ret: { ...cancelado } });
  const hermano = { ...ret, falso_flete: false };
  const marcadoSinMonto = {
    ...ida, tipo_asignacion: "tercerizado", costo_proveedor: 0, falso_flete: true,
  };

  const a = avisosDe(marcadoSinMonto, ida, hermano, "costo");
  chk("marcado sin monto NO dice 'el día entero no se podrá liquidar'",
      !a.some((x) => /no se podrá liquidar al cierre/i.test(x.texto)),
      a.map((x) => x.texto).join(" | "));
  chk("dice que falta el monto del avance",
      a.some((x) => x.nivel === "alerta" && /ningún tramo del día lleva monto/i.test(x.texto)),
      a.map((x) => x.texto).join(" | "));

  // Con el monto puesto en un tramo, el otro queda explicado y sin alerta.
  const conMonto = avisosDe(
    { ...marcadoSinMonto, costo_proveedor: 120 }, ida, hermano, "costo"
  );
  chk("con el monto puesto no queda ninguna alerta",
      !conMonto.some((x) => x.nivel === "alerta"), conMonto.map((x) => x.texto).join(" | "));

  const mudo = avisosDe(
    { ...ret, tipo_asignacion: "tercerizado", costo_proveedor: 0, falso_flete: false },
    ret, { ...ida, falso_flete: true, costo_proveedor: 120 }, "costo"
  );
  chk("el tramo mudo del falso flete se explica, no se alarma",
      mudo.every((x) => x.nivel === "info") && mudo.some((x) => /avance del día va en/i.test(x.texto)),
      mudo.map((x) => `${x.nivel}:${x.texto}`).join(" | "));

  // Y el doble pago del avance sigue detectándose.
  const doble = avisosDe(
    { ...marcadoSinMonto, costo_proveedor: 120 }, ida,
    { ...hermano, costo_proveedor: 120 }, "costo"
  );
  chk("dos tramos con monto avisan del pago doble",
      doble.some((x) => x.nivel === "alerta" && /una vez por día|pagará doble/i.test(x.texto)),
      doble.map((x) => x.texto).join(" | "));

  // Del lado venta no se juzga nada: al cliente no se le cobra la cancelación.
  const venta = avisosDe(
    { ...marcadoSinMonto, precio_cliente: 0 }, ida, hermano, "precio"
  );
  chk("del lado venta un día cancelado no levanta alertas",
      !venta.some((x) => x.nivel === "alerta"), venta.map((x) => x.texto).join(" | "));
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
