// Pruebas del DINERO DE UNA CANCELACIÓN en /programacion. NO tocan la base: datos en
// memoria contra el módulo puro (lib/reservas-cancelacion.ts).
// Uso:  npx tsx scripts/prueba-cancelacion.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN. `reservas-05-falso-flete.sql` puso a salvo el dinero en el CIERRE, pero el
// dinero se escribe en /programacion, y ahí no había nada: se cancelaba un servicio con
// S/ 664.41 de costo cargado y el importe se quedaba escrito — ensuciando `v_costo_servicio`
// y `v_egresos` desde el minuto uno—, mientras el propio aviso decía "márcalo como falso
// flete" sobre una pantalla que no podía marcarlo.
//
// La mitad que MÁS importa de esta matriz es la que impide pasarse de listo. Limpiar todo
// tramo cancelado con importe sería una fuga de dinero de las caras: con la IDA CANCELADA y
// el RETORNO PRESTADO el día SÍ se factura, y su tarifa está escrita justamente en la ida
// caída. Borrarla ahí es borrar el cobro de un día trabajado, en silencio.
import { planDeCancelacion, type EntradaCancelacion } from "../lib/reservas-cancelacion";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

/** El caso real: un tercerizado de S/ 664.41 que se cancela. */
const base = (over: Partial<EntradaCancelacion> = {}): EntradaCancelacion => ({
  estado: "cancelada",
  tipoAsignacion: "tercerizado",
  costo: 664.41,
  precio: 780,
  hermano: null,
  ...over,
});

const retornoPrestado = { id: 8400, codigo: "OS-2026-008400", estado: "finalizada",
  costo_proveedor: 0, precio_cliente: 0 };
const retornoCaido = { id: 8400, codigo: "OS-2026-008400", estado: "cancelada",
  costo_proveedor: 0, precio_cliente: 0 };

// ── 1. El servicio no queda cancelado: no se toca nada ───────────────────────────────
{
  const p = planDeCancelacion(base({ estado: "finalizada" }));
  chk("un servicio prestado no dispara nada",
    p.codigo === "no_cancelada" && !p.pide && Object.keys(p.patch).length === 0, p.codigo);
}

// ── 2. …pero una marca colgada de un servicio que volvió a prestarse se retira ───────
// Misma regla que ya aplica ModalServicios: una marca sobre un servicio prestado no
// describe nada y confundiría al siguiente que lo mire.
{
  const p = planDeCancelacion(base({ estado: "finalizada", falsoFleteActual: true }));
  chk("la marca de falso flete se retira sola al dejar de estar cancelado",
    p.patch.falso_flete === false && p.patch.falso_flete_motivo === null, JSON.stringify(p.patch));
  chk("y NO toca los importes de un servicio que sí se prestó",
    !("costo_proveedor" in p.patch) && !("precio_cliente" in p.patch), JSON.stringify(p.patch));
}

// ── 3. EL LADO QUE NO SE PUEDE AFLOJAR ───────────────────────────────────────────────
// Ida cancelada, retorno PRESTADO, y la tarifa del día escrita en la ida. El día se
// factura. Tocar ese importe es borrar el cobro de un día trabajado.
{
  const p = planDeCancelacion(base({ hermano: retornoPrestado }));
  chk("con el hermano prestado NO se ofrece limpiar nada",
    p.codigo === "importe_del_dia_vivo" && !p.pide, p.codigo);
  chk("y el patch queda VACÍO: el importe del día no se toca",
    Object.keys(p.patch).length === 0, JSON.stringify(p.patch));
}

// ── 4. Día caído entero con importe: hay que decidir, y el default es S/ 0.00 ────────
{
  const p = planDeCancelacion(base({ hermano: retornoCaido }));
  chk("el día caído con importe pide decisión", p.codigo === "decidir" && p.pide, p.codigo);
  chk("sin decidir, el default cae del lado reversible (S/ 0.00)", p.decision === "cero");
  chk("se retiran las dos caras del importe",
    p.patch.costo_proveedor === 0 && p.patch.precio_cliente === 0, JSON.stringify(p.patch));
  chk("con el motivo de acta que corresponde", p.motivo === "correccion_carga", String(p.motivo));
  chk("y no bloquea el guardado", p.bloqueo === null);
}

// ── 5. Un tramo suelto (sin hermano) cancelado es un día caído ───────────────────────
{
  const p = planDeCancelacion(base());
  chk("un servicio sin hermano también se limpia", p.codigo === "decidir" && p.patch.costo_proveedor === 0);
}

// ── 6. Cancelado y ya en cero: nada que decidir ──────────────────────────────────────
{
  const p = planDeCancelacion(base({ costo: 0, precio: 0 }));
  chk("cancelado y sin importe no molesta a nadie",
    p.codigo === "sin_importe" && !p.pide && Object.keys(p.patch).length === 0, p.codigo);
}

// ── 7. El acuerdo EXIGE motivo, y eso sí bloquea ─────────────────────────────────────
// Es la única constancia de por qué salió dinero por un viaje que no se prestó.
{
  const p = planDeCancelacion(base({ decision: "falso_flete", montoAcordado: 120 }));
  chk("un falso flete sin motivo NO se puede guardar", p.bloqueo !== null, String(p.bloqueo));
  const q = planDeCancelacion(base({
    decision: "falso_flete", montoAcordado: 120, motivoAcuerdo: "  ",
  }));
  chk("y un motivo en blanco tampoco cuela", q.bloqueo !== null);
}

// ── 8. EL MONTO NO SE HEREDA: marcar y escribir el monto son un solo acto ────────────
// Si el importe se tomara del que ya estaba, se pagarían los S/ 664.41 del servicio
// completo donde el acuerdo eran S/ 120.
{
  const p = planDeCancelacion(base({
    decision: "falso_flete", montoAcordado: 120, motivoAcuerdo: "ya había salido de cochera",
  }));
  chk("se paga el monto ACORDADO, no el que había cargado",
    p.patch.costo_proveedor === 120, String(p.patch.costo_proveedor));
  chk("la marca y su motivo se escriben juntos",
    p.patch.falso_flete === true && p.patch.falso_flete_motivo === "ya había salido de cochera");
  chk("y no bloquea", p.bloqueo === null);

  const vacio = planDeCancelacion(base({
    decision: "falso_flete", montoAcordado: "", motivoAcuerdo: "acuerdo pendiente de monto",
  }));
  chk("con el monto vacío se escribe 0, JAMÁS el importe viejo",
    vacio.patch.costo_proveedor === 0, String(vacio.patch.costo_proveedor));
}

// ── 9. Al cliente no se le cobra la cancelación, ni con acuerdo ──────────────────────
// El avance es un trato entre AFA y el proveedor; el cliente no es parte.
{
  const p = planDeCancelacion(base({
    decision: "falso_flete", montoAcordado: 120, motivoAcuerdo: "avance",
  }));
  chk("el precio al cliente se retira igual con acuerdo de por medio",
    p.patch.precio_cliente === 0, String(p.patch.precio_cliente));
}

// ── 10. La flota propia no tiene proveedor a quien pagarle un avance ────────────────
{
  const p = planDeCancelacion(base({ tipoAsignacion: "propio", costo: 0 }));
  chk("en flota propia no se ofrece el falso flete", !p.ofreceFalsoFlete);
  const q = planDeCancelacion(base({
    tipoAsignacion: "propio", decision: "falso_flete", montoAcordado: 500, motivoAcuerdo: "x",
  }));
  chk("y pedirlo igual NO paga nada: cae a S/ 0.00",
    q.decision === "cero" && q.patch.costo_proveedor === 0 && q.patch.falso_flete !== true,
    JSON.stringify(q.patch));
}

// ── 11. Volver de un acuerdo a "no se paga" retira la marca ─────────────────────────
// Sin esto quedaría `falso_flete = true` con el importe en cero: una fila que dice que hay
// acuerdo y no paga nada, que es justo la que hace dudar de todas las demás.
{
  const p = planDeCancelacion(base({ falsoFleteActual: true, decision: "cero", costo: 120 }));
  chk("al volver a S/ 0.00 se retira la marca",
    p.patch.falso_flete === false && p.patch.falso_flete_motivo === null, JSON.stringify(p.patch));
}

// ── 12. El resumen DICE lo que va a pasar, con los importes a la vista ──────────────
{
  const cero = planDeCancelacion(base({ hermano: retornoCaido }));
  chk("el resumen del cero nombra las dos cifras",
    /664\.41/.test(cero.resumen) && /780\.00/.test(cero.resumen), cero.resumen);
  const ff = planDeCancelacion(base({
    decision: "falso_flete", montoAcordado: 120, motivoAcuerdo: "avance",
  }));
  chk("y el del acuerdo nombra lo que se va a pagar", /120\.00/.test(ff.resumen), ff.resumen);
  chk("el caso que no se toca no anuncia nada",
    planDeCancelacion(base({ hermano: retornoPrestado })).resumen === "");
}

// ── 13. "anulada" es una cancelación más ────────────────────────────────────────────
{
  const p = planDeCancelacion(base({ estado: "anulada", hermano: { ...retornoCaido, estado: "anulada" } }));
  chk("anulada se trata igual que cancelada", p.codigo === "decidir" && p.patch.costo_proveedor === 0);
}

// ── 14. El desplegable de la lista pregunta con el MISMO motor ──────────────────────
// /programacion también cancela desde la fila, sin abrir el formulario. Esa rama decide
// si mandar al formulario con `plan.pide`, no con una condición propia — dos definiciones
// de "esto hay que decidirlo" es cómo una de las dos se queda atrás.
{
  chk("con importe cargado, la fila tiene que mandar al formulario",
    planDeCancelacion(base()).pide === true);
  chk("sin importe, la cancelación rápida se queda rápida",
    planDeCancelacion(base({ costo: 0, precio: 0 })).pide === false);
  // El hermano puede estar fuera de la ventana de fechas que la lista trae cargada. Sin
  // él, el plan lee el día como caído y manda al formulario, donde el hermano SÍ se busca
  // en la base. Errar hacia el formulario cuesta un clic; errar hacia el update directo
  // deja el importe huérfano, que es justo lo que se está arreglando.
  chk("sin el hermano a la vista se manda al formulario, no al update directo",
    planDeCancelacion(base({ hermano: null })).pide === true);
}

// ── 15. LA INVARIANTE DURA, sobre una rejilla entera ────────────────────────────────
// "El importe, por sí solo, NO autoriza nada": el plan no puede escribir JAMÁS un costo
// mayor que cero sin que en el mismo patch vayan la marca del acuerdo y su motivo. Es la
// propiedad que hace segura toda la pantalla, así que se comprueba sobre el producto de
// todas las entradas y no sobre tres casos elegidos a mano.
{
  const estados = ["cancelada", "anulada", "finalizada", "programada"];
  const decisiones = [undefined, "cero", "falso_flete"] as const;
  const tipos = ["tercerizado", "propio"];
  const montos = ["", 0, 120, 664.41];
  const motivos = ["", "  ", "avance acordado"];
  const hermanos = [null, retornoCaido, retornoPrestado];
  let n = 0, malos = 0, bloqueados = 0;
  for (const estado of estados)
    for (const decision of decisiones)
      for (const tipoAsignacion of tipos)
        for (const montoAcordado of montos)
          for (const motivoAcuerdo of motivos)
            for (const hermano of hermanos) {
              const p = planDeCancelacion(base({
                estado, decision, tipoAsignacion, montoAcordado, motivoAcuerdo, hermano,
              }));
              n++;
              if (p.bloqueo) { bloqueados++; continue; }   // no se guarda: no cuenta
              const costo = p.patch.costo_proveedor;
              if (typeof costo === "number" && costo > 0) {
                const ok = p.patch.falso_flete === true
                  && typeof p.patch.falso_flete_motivo === "string"
                  && (p.patch.falso_flete_motivo as string).trim() !== "";
                if (!ok) malos++;
              }
            }
  chk(`ningún patch guardable paga sin acuerdo escrito (${n} combinaciones, ${bloqueados} bloqueadas)`,
    malos === 0, malos ? `${malos} pagarían a ciegas` : "");
  chk("y la rejilla es lo bastante grande para significar algo", n >= 500, `${n} casos`);
}

// ── 16. Nunca se toca el importe de un día que sí se prestó, decida lo que decida ────
// El corolario del caso 3, comprobado contra todas las decisiones: ninguna combinación
// puede llegar a borrar la tarifa de un día trabajado.
{
  let tocados = 0;
  for (const decision of [undefined, "cero", "falso_flete"] as const)
    for (const montoAcordado of ["", 120])
      for (const motivoAcuerdo of ["", "avance"]) {
        const p = planDeCancelacion(base({
          hermano: retornoPrestado, decision, montoAcordado, motivoAcuerdo,
        }));
        if (Object.keys(p.patch).length > 0) tocados++;
      }
  chk("con el hermano prestado, ninguna decisión toca el importe", tocados === 0, `${tocados} lo tocaron`);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
