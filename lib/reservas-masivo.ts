// ──────────────────────────────────────────────────────────────────────────────
// lib/reservas-masivo.ts — QUÉ SE PROPAGA AL RESTO DEL CONTRATO, Y A QUIÉN.
//
// El modal «¿Aplicar a más servicios del contrato?» ofrecía TRES modos excluyentes
// (`todo` | `conductor` | `pax`), o sea tres PAQUETES, y el operador solo podía elegir
// uno entero. Eso dejaba fuera lo que más se corrige:
//
//   · el PRECIO DE VENTA no tenía ningún camino masivo. Ninguno. Renegociar la tarifa
//     de un contrato de 900 días era abrir 900 servicios;
//   · el COSTO DEL PROVEEDOR sí viajaba, pero SOLO pegado a «Empresa y unidad»:
//     para corregir una tarifa pactada había que reescribirle además el vehículo y el
//     conductor a todo el contrato;
//   · y la HORA viajaba sin casilla, escondida dentro de ese mismo paquete.
//
// Acá cada cosa es un EJE con su propio conjunto de destinatarios. Lo que hace que sean
// ejes y no casillas de adorno es que **cada uno filtra distinto**, y sus filtros no son
// intercambiables:
//
//   ASIGNACIÓN → filtra por hora y por unidad. Protege el despacho: no mandarle el bus
//                de la ida al retorno, no pisarle la placa a quien ya tiene una.
//   HORA       → solo los que hoy salen a la hora vieja. Correrle el horario a un
//                servicio que ya salía a otra hora lo desalinearía.
//   PAX        → ni hora ni unidad: los asientos son del CONTRATO. Filtra por RUTA y por
//                la capacidad que cada servicio ya declara (otro móvil tiene la suya).
//   PRECIO y COSTO → ni hora ni unidad tampoco… pero por la razón CONTRARIA, y ahí está
//                todo el peligro de este módulo. Ver abajo.
//
// ─── LA REGLA QUE NO SE PUEDE AFLOJAR ───────────────────────────────────────────
//
//   EL PAX ES DEL DÍA Y SE ESCRIBE EN LOS DOS TRAMOS.
//   EL IMPORTE ES DEL DÍA Y SE ESCRIBE EN UNO SOLO.
//
// Es la misma frase y la conclusión es la contraria. AFA cobra UNA tarifa por la ida y
// el retorno: el importe va en un tramo y el otro queda en S/ 0.00 a propósito, y la
// liquidación lee dos importes como DOS servicios. Copiarle al dinero el filtro del pax
// —que es el que alcanza a los dos tramos— habría escrito la tarifa en la ida y en el
// retorno de cada día del contrato: el cobro doble, el error más caro de este ERP,
// multiplicado por 900 y ejecutado con un clic.
//
// Por eso el dinero NO se decide por servicio: se decide **por DÍA**. `tramoDelImporte`
// elige UN destinatario por día —el que ya lleva el importe; si ninguno, el del mismo
// sentido que el servicio editado— y los demás tramos de ese día quedan fuera con su
// motivo. La invariante que fija la matriz es exactamente esa: ningún día puede terminar
// con importe en sus dos tramos POR CAUSA del masivo.
//
// El ERP ya tenía media regla escrita: al aplicar «Empresa y unidad» a un servicio de
// otro horario, page.tsx borraba `costo_proveedor` del patch («la ida y el retorno se le
// pagan distinto al proveedor»). Era un buen proxy —la hora separa los tramos— pero solo
// un proxy: un contrato cuyo importe vive unas veces en la ida y otras en el retorno lo
// esquiva. Esto es esa misma regla, exacta.
//
// ─── EL SERVICIO EDITADO CUENTA PARA EL DÍA, AUNQUE NO SEA DESTINATARIO ──────────
//
// El masivo se ofrece DESPUÉS de guardar, así que el servicio que el operador acaba de
// tocar ya lleva el precio nuevo y está fuera de la lista de candidatos. Si no se mirara,
// su propio hermano aparecería como un día sin importe y recibiría la tarifa: el cobro
// doble en el ÚNICO día que el operador sí revisó. Por eso el juicio se hace sobre el
// `contexto` (todas las filas del contrato, el editado incluido) y la escritura sobre el
// `universo` (los candidatos). Son dos conjuntos distintos a propósito.
//
// ─── LO QUE NO SE OFRECE, Y POR QUÉ ─────────────────────────────────────────────
//
//   · ESTADO. Cancelar un contrato entero desde acá saltaría `planDeCancelacion`, que es
//     lo único que decide qué pasa con el importe de una cancelación (S/ 0.00 o falso
//     flete con su motivo). Una cancelación masiva sin esa decisión deja 900 importes
//     huérfanos contando en `v_egresos`.
//   · FECHA. Cada servicio tiene la suya; es lo único que los distingue.
//   · OBSERVACIONES. Son de ESE día («el cliente pidió esperar 10 min»). Copiarlas a 900
//     servicios escribe una nota falsa en 899.
//
// Una pantalla que ofrece un control que el sistema no lee es peor que no ofrecerlo; una
// que ofrece uno que el sistema SÍ lee y no debería, es peor todavía.
//
// Matriz: npx tsx scripts/prueba-masivo.mts
// ──────────────────────────────────────────────────────────────────────────────

import { sentidoDeReserva, sinHoraRuta } from "@/lib/liquidacion-agrupacion";

/** Las dos caras del dinero. El precio es del CLIENTE, el costo del PROVEEDOR. */
export type LadoDinero = "precio" | "costo";

export type EjeMasivo = "asignacion" | "conductor" | "hora" | "pax" | "precio" | "costo";

/**
 * La asignación es UN objeto, no tres campos sueltos: empresa, unidad y conductor están
 * entrelazados (`normalizarAsignacion` los trata juntos, y mandarle a la empresa B el
 * conductor de la empresa A deja una fila que no describe a nadie). Por eso ese eje es un
 * selector de tres estados y no dos casillas. El resto sí son independientes de verdad.
 */
export type Seleccion = {
  asignacion: "no" | "completa" | "conductor";
  hora: boolean;
  pax: boolean;
  precio: boolean;
  costo: boolean;
};

/** Lo que hace falta saber de un servicio para juzgarlo. Nada de la página. */
export type ServicioMasivo = {
  id: number;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  direccion_servicio?: string | null;
  ruta_nombre?: string | null;
  estado?: string | null;
  tipo_asignacion?: string | null;
  vehiculo_id?: number | null;
  empresa_tercerizada_id?: number | null;
  vehiculo_tercero_id?: number | null;
  precio_cliente?: number | null;
  costo_proveedor?: number | null;
  capacidad_contratada?: number | null;
  reserva_vinculada_id?: number | null;
};

/**
 * Por qué un servicio recibe —o no recibe— lo de un eje. Se DECLARA, no se olfatea: cada
 * código se arregla en otro sitio y la pantalla enruta por código, nunca leyendo el texto.
 */
export type MotivoMasivo =
  /** Lo recibe. */
  | "ok"
  /** El rango de fechas elegido lo deja fuera. */
  | "fuera_de_rango"
  /**
   * Despacho: el servicio YA OCURRIÓ (finalizado, o su fecha ya pasó). Reasignarle la
   * unidad reescribiría el historial, y correrle la hora movería los paraderos contra los
   * que ya se midió si el bus llegó tarde. **Solo frena al despacho**: los asientos
   * contratados y el importe de un servicio pasado se corrigen todo el tiempo — es
   * justo el mes que hay que cerrar.
   */
  | "ya_ocurrio"
  /** Despacho: está EN RUTA ahora mismo. No se le cambia el bus al conductor a media carretera. */
  | "en_ruta"
  /** Sale a otra hora: los filtros de la ASIGNACIÓN existen para no mandarle el bus de la ida al retorno. */
  | "otro_horario"
  /** Ya tiene una unidad asignada y no se marcó sobrescribirla. */
  | "ya_tiene_unidad"
  /** Conductor: no se mezcla un conductor propio con un servicio tercerizado, ni al revés. */
  | "otro_tipo_asignacion"
  /** Conductor o costo: es de OTRA empresa proveedora. Su conductor no cubre esto y su tarifa no es esta. */
  | "otra_empresa"
  /** Hora: hoy no sale a la hora que se está corriendo, así que correrlo lo desalinearía. */
  | "otra_hora_de_origen"
  /** Pax: es de otra ruta del mismo contrato, y los asientos son de cada ruta. */
  | "otra_ruta"
  /** Pax: ya declara otra capacidad — es otro móvil de esta ruta y la suya es correcta. */
  | "otra_capacidad"
  /** Dinero: el importe del día vive en el OTRO tramo. Escribirlo acá cobraría el día dos veces. */
  | "importe_en_el_otro_tramo"
  /** Dinero: los DOS tramos del día ya llevan importe. El día está duplicado desde antes; no se toca. */
  | "dia_ya_duplicado"
  /** Dinero: el importe del día quedó escrito en un tramo CANCELADO. No falta escribirlo: falta moverlo. */
  | "importe_en_tramo_cancelado"
  /** Dinero: el día tiene dos tramos vivos, ninguno lleva importe y nada dice cuál debería. */
  | "no_se_sabe_que_tramo"
  /** Costo: es de la flota propia, y la flota propia no le debe nada a un proveedor. */
  | "flota_propia"
  /** Dinero: ya está dentro de una liquidación emitida. El papel que se mandó no cambia solo. */
  | "ya_liquidado"
  /** Ya dice exactamente eso. Contarlo inflaría el número que autoriza una persona. */
  | "sin_cambio";

export type ResumenEje = {
  /** A quién alcanza. */
  ids: number[];
  /** Por qué queda fuera el resto, agrupado por código y ordenado por cuántos. */
  fuera: { motivo: MotivoMasivo; cuantos: number }[];
};

export type PlanMasivo = {
  /** Un renglón por eje seleccionado. Los no seleccionados vienen vacíos. */
  ejes: Record<EjeMasivo, ResumenEje>;
  /** El patch final por servicio. Un servicio puede recibir campos de varios ejes. */
  patches: { id: number; patch: Record<string, any> }[];
  /** Los que se llevan la hora nueva: los ÚNICOS a los que se les corren los paraderos. */
  idsConHora: number[];
  /** Cuántos servicios se tocan en total (no la suma de los ejes: uno puede estar en varios). */
  total: number;
  /** Lo que el dinero va a mover, para poder nombrarlo antes de autorizarlo. */
  dinero: { precio: EfectoDinero | null; costo: EfectoDinero | null };
};

/** Lo que cambia de plata, en soles, para el `confirm()`. Un número abstracto no se audita. */
export type EfectoDinero = {
  cuantos: number;
  /** Lo que esos servicios suman HOY. */
  antes: number;
  /** Lo que van a sumar. */
  despues: number;
  /** El importe unitario que se escribe. */
  unitario: number;
};

export type EntradaMasivo = {
  /** Candidatos: lo que queda por operar del contrato, sin el servicio editado. */
  universo: ServicioMasivo[];
  /**
   * TODAS las filas del contrato, el servicio editado incluido y ya con lo que se acaba
   * de guardar. No se escribe sobre él: se usa para saber cómo es cada DÍA. Sin esto, el
   * hermano del servicio recién editado recibiría el importe que ese acaba de recibir.
   */
  contexto: ServicioMasivo[];
  seleccion: Seleccion;
  /** El payload de la asignación, YA normalizado por `normalizarAsignacion`. */
  payload: Record<string, any>;
  /** La hora a la que salía el servicio editado ANTES de guardarlo. */
  horaOriginal: string;
  /** La hora nueva, si cambió. */
  horaNueva?: string | null;
  /** El sentido del servicio editado: decide qué tramo del día lleva el importe cuando ninguno lo lleva. */
  sentidoEditado?: string | null;
  desde?: string | null;
  hasta?: string | null;
  /**
   * Hoy en Perú (ISO). Con ella, los ejes de DESPACHO dejan fuera lo que ya ocurrió y lo
   * declaran (`ya_ocurrio`); sin ella no se juzga la fecha — no se inventa un «hoy» desde
   * el reloj del navegador, que es UTC y adelanta el día a las 19:00 de Lima.
   */
  hoy?: string | null;
  otraHora?: boolean;
  otraUnidad?: boolean;
  pax?: number | null;
  paxAntes?: number | null;
  rutasObjetivo?: string[];
  precio?: number | null;
  costo?: number | null;
  /** Ids ya reclamados por un documento emitido. Best-effort: ausentes = no se pudo mirar. */
  liquidadasCliente?: Set<number>;
  liquidadasProveedor?: Set<number>;
  /** Si el estado del servicio queda completo, un `pendiente` se confirma. */
  estadoPendientes?: string;
};

/** El orden en que se leen en pantalla: primero lo que despacha, después lo que cobra. */
export const EJES_MASIVOS: EjeMasivo[] = ["asignacion", "conductor", "hora", "pax", "precio", "costo"];

const hhmm = (h?: string | null) => String(h ?? "").slice(0, 5);
const num = (n: unknown) => Number(n ?? 0) || 0;
const esCancelada = (e?: string | null) =>
  ["cancelada", "anulada"].includes(String(e ?? "").toLowerCase());

const montoDe = (t: ServicioMasivo, lado: LadoDinero) =>
  num(lado === "precio" ? t.precio_cliente : t.costo_proveedor);

/**
 * ¿Aplicarle la asignación completa le cambia alguna unidad que YA tenía? Copiado en
 * espíritu de `conservaUnidad` (page.tsx): se miran los TRES campos a la vez, no solo el
 * del tipo del payload — un tercerizado tiene `vehiculo_id` en null y miraríamos el campo
 * equivocado, dándolo por libre mientras su empresa sí está puesta.
 */
export function conservaSuUnidad(r: ServicioMasivo, payload: Record<string, any>): boolean {
  const pisa = (actual: number | null | undefined, nuevo: any) =>
    actual !== null && actual !== undefined && actual !== (nuevo ?? null);
  return !pisa(r.vehiculo_id, payload.vehiculo_id)
      && !pisa(r.empresa_tercerizada_id, payload.empresa_tercerizada_id)
      && !pisa(r.vehiculo_tercero_id, payload.vehiculo_tercero_id);
}

/** Índice de hermanos por los DOS sentidos del enlace, y solo cuando es inequívoco. */
function indiceDelDia(contexto: ServicioMasivo[]) {
  const porId = new Map(contexto.map(t => [t.id, t]));
  const cuantos = new Map<number, number>();
  for (const t of contexto) {
    const v = Number(t.reserva_vinculada_id ?? 0);
    if (v) cuantos.set(v, (cuantos.get(v) ?? 0) + 1);
  }
  // Con dos filas apuntando a la misma, el enlace está roto de otra forma y elegir una
  // sería adivinar: misma regla que `lib/liquidacion-hermanos.ts`.
  const haciaAtras = new Map<number, ServicioMasivo>();
  for (const t of contexto) {
    const v = Number(t.reserva_vinculada_id ?? 0);
    if (v && cuantos.get(v) === 1) haciaAtras.set(v, t);
  }
  const hermano = (t: ServicioMasivo): ServicioMasivo | null => {
    const v = Number(t.reserva_vinculada_id ?? 0);
    return (v ? porId.get(v) : undefined) ?? haciaAtras.get(t.id) ?? null;
  };
  /** Los tramos de ese día: este y su hermano. Nunca más de dos. */
  const delDia = (t: ServicioMasivo): ServicioMasivo[] => {
    const h = hermano(t);
    return h && h.id !== t.id ? [t, h] : [t];
  };
  return { hermano, delDia };
}

/**
 * QUÉ TRAMO DEL DÍA LLEVA EL IMPORTE. Es la pieza que impide el cobro doble, y por eso
 * devuelve UNO o NINGUNO — nunca "los dos" ni "el que quede".
 *
 * El orden va de la evidencia al juicio:
 *   1. Si el día ya tiene importe en los DOS, está duplicado desde antes: no se toca (el
 *      chip «DÍA 2×» de la lista ya lo denuncia, y arreglarlo desde acá sería taparlo).
 *   2. Si lo lleva UNO, ese es. Aunque sea el retorno: «qué tramo lleva el importe no es
 *      siempre la ida».
 *   3. Si no lo lleva ninguno, el del MISMO SENTIDO que el servicio que el operador acaba
 *      de editar: es la forma que ese contrato ya tiene.
 *   4. Si ni el sentido decide, la hora. Y si tampoco, no se adivina.
 *
 * Un tramo CANCELADO nunca es destinatario: escribirle un importe es justo el huérfano
 * que `lib/reservas-cancelacion.ts` existe para no crear.
 */
export function tramoDelImporte(
  delDia: ServicioMasivo[],
  lado: LadoDinero,
  sentidoPreferido: "IDA" | "RETORNO",
  horaOriginal: string,
): { tramo: ServicioMasivo | null; motivo: MotivoMasivo } {
  const conImporte = delDia.filter(t => montoDe(t, lado) > 0);
  if (conImporte.length > 1) return { tramo: null, motivo: "dia_ya_duplicado" };
  if (conImporte.length === 1) {
    const t = conImporte[0];
    return esCancelada(t.estado)
      ? { tramo: null, motivo: "importe_en_tramo_cancelado" }
      : { tramo: t, motivo: "ok" };
  }
  const vivos = delDia.filter(t => !esCancelada(t.estado));
  if (vivos.length === 0) return { tramo: null, motivo: "no_se_sabe_que_tramo" };
  if (vivos.length === 1) return { tramo: vivos[0], motivo: "ok" };

  const porSentido = vivos.filter(t => sentidoDeReserva(t as any) === sentidoPreferido);
  if (porSentido.length === 1) return { tramo: porSentido[0], motivo: "ok" };
  const porHora = vivos.filter(t => hhmm(t.hora_servicio) === horaOriginal);
  if (porHora.length === 1) return { tramo: porHora[0], motivo: "ok" };
  return { tramo: null, motivo: "no_se_sabe_que_tramo" };
}

/**
 * ¿Este servicio acepta la capacidad que se está propagando? (la regla de `aceptaPax`).
 *
 * LA RUTA SE COMPARA SIN LA HORA, y esa es la corrección que hace que este eje sirva.
 * `normalizarNombreRuta` solo recorta espacios y sube a mayúsculas, y **el nombre lleva
 * la hora DENTRO** («RUTA C/ 04:35- 17:00» contra «RUTA C/ 06:35- 15:00»): comparándolo
 * entero, cada móvil de la misma ruta era «otra ruta» y el eje no alcanzaba a ninguno.
 * Medido en producción sobre el contrato #240: 1 582 de 1 582 candidatos salían
 * `otra_ruta` y el modal ofrecía «Aplicar a 0 servicio(s)».
 *
 * `sinHoraRuta` es el MISMO eje que ya usa `agruparPorRutaContratada` para unir los ítems
 * de una liquidación, y está medido ahí (nombre completo 30 ítems · sin la hora 21): no es
 * un recorte inventado para este módulo.
 *
 * Y ensanchar aquí NO afloja lo caro, porque el guard de verdad es el otro: los asientos
 * de OTRO móvil los protege la CAPACIDAD (`otra_capacidad`), que es exacta y no depende de
 * cómo alguien tecleó el nombre. Un móvil de la misma ruta con 30 asientos contratados
 * sigue quedando fuera; lo que deja de quedar fuera es el que tiene los mismos que el
 * servicio editado, que es justo el que hay que corregir.
 */
function motivoPaxDe(
  r: ServicioMasivo,
  e: EntradaMasivo,
  hermano: (t: ServicioMasivo) => ServicioMasivo | null,
): MotivoMasivo {
  const rutas = (e.rutasObjetivo ?? []).map(sinHoraRuta).filter(Boolean);
  if (rutas.length) {
    const h = hermano(r);
    const suyas = [
      sinHoraRuta(r.ruta_nombre),
      sinHoraRuta(h?.ruta_nombre),
    ].filter(Boolean);
    if (suyas.length && !suyas.some(x => rutas.includes(x))) return "otra_ruta";
  }
  const h = hermano(r);
  const actual = r.capacidad_contratada ?? h?.capacidad_contratada ?? null;
  const pax = e.pax ?? null;
  return actual === null || actual === (e.paxAntes ?? null) || actual === pax
    ? "ok" : "otra_capacidad";
}

/** El costo es del PROVEEDOR: solo lo recibe quien va a ser servido por ESA empresa. */
function motivoCostoEmpresa(
  r: ServicioMasivo, e: EntradaMasivo, recibeAsignacion: boolean,
): MotivoMasivo {
  // Si además se le está aplicando la asignación completa, el servicio PASA a ser de esa
  // empresa: la tarifa que se pactó con ella es la suya. Los ejes se leen juntos, no
  // cada uno contra la foto vieja.
  if (recibeAsignacion) return "ok";
  if (String(r.tipo_asignacion ?? "") !== "tercerizado") return "flota_propia";
  const empresa = e.payload.empresa_tercerizada_id ?? null;
  if (empresa != null && Number(r.empresa_tercerizada_id ?? 0) !== Number(empresa))
    return "otra_empresa";
  return "ok";
}

/** El eje apagado: no alcanza a nadie y no deja a nadie fuera «por un motivo». */
const sinEje = (): ResumenEje => ({ ids: [], fuera: [] });

function resumir(veredictos: { id: number; motivo: MotivoMasivo }[]): ResumenEje {
  const ids = veredictos.filter(v => v.motivo === "ok").map(v => v.id);
  const cuenta = new Map<MotivoMasivo, number>();
  for (const v of veredictos)
    if (v.motivo !== "ok") cuenta.set(v.motivo, (cuenta.get(v.motivo) ?? 0) + 1);
  const fuera = [...cuenta.entries()]
    .map(([motivo, cuantos]) => ({ motivo, cuantos }))
    .sort((a, b) => b.cuantos - a.cuantos || a.motivo.localeCompare(b.motivo));
  return { ids, fuera };
}

/**
 * EL PLAN COMPLETO. Una sola pasada: la pantalla pinta lo mismo que se escribe, porque es
 * literalmente el mismo objeto. Dos motores —uno para contar y otro para guardar—
 * terminan contestando distinto, que es el bug del semáforo de puntualidad.
 */
export function planMasivo(e: EntradaMasivo): PlanMasivo {
  const { hermano, delDia } = indiceDelDia(e.contexto.length ? e.contexto : e.universo);
  const sel = e.seleccion;
  const sentidoEditado: "IDA" | "RETORNO" =
    sentidoDeReserva({ direccion_servicio: e.sentidoEditado } as any);

  const enRango = (r: ServicioMasivo) =>
    (!e.desde && !e.hasta) || (
      !!r.fecha_servicio &&
      (!e.desde || r.fecha_servicio >= e.desde) &&
      (!e.hasta || r.fecha_servicio <= e.hasta)
    );

  /**
   * ¿Este servicio ya ocurrió, o está ocurriendo? SOLO lo miran los ejes de DESPACHO.
   *
   * Vivía en la CONSULTA de `/programacion`, que armaba el universo con
   * `estado !== finalizada/en_curso && fecha >= hoy` — un filtro de paquete aplicado antes
   * de que existiera ningún eje, o sea el mismo defecto que los seis ejes vinieron a
   * corregir, sobreviviendo un piso más arriba. Consecuencia medida y reportada: **el PAX
   * de un servicio pasado no se podía corregir en lote por ninguna pantalla**, y el
   * calendario del modal ni siquiera dejaba elegir una fecha anterior a hoy porque su
   * `min` salía de ese mismo universo recortado.
   *
   * Aquí es un veredicto POR EJE y con su código, así que lo que queda fuera se ve y dice
   * por qué. Sin `hoy` no se juzga la fecha: inventarlo desde el reloj del navegador
   * adelantaría el día a las 19:00 de Lima.
   */
  const yaOcurrio = (r: ServicioMasivo): MotivoMasivo | null => {
    const est = String(r.estado ?? "").toLowerCase();
    if (est === "en_curso") return "en_ruta";
    if (est === "finalizada") return "ya_ocurrio";
    if (e.hoy && r.fecha_servicio && r.fecha_servicio < e.hoy) return "ya_ocurrio";
    return null;
  };

  // ── ASIGNACIÓN (completa o solo el conductor) ─────────────────────────────
  // Sus filtros —hora y unidad— protegen el DESPACHO, no el dinero. Se conservan tal cual
  // estaban: este cambio abre ejes nuevos, no afloja los que ya funcionaban.
  const veredictoAsignacion = (r: ServicioMasivo): MotivoMasivo => {
    const ocurrio = yaOcurrio(r);
    if (ocurrio) return ocurrio;
    if (!enRango(r)) return "fuera_de_rango";
    if (!e.otraHora && hhmm(r.hora_servicio) !== e.horaOriginal) return "otro_horario";
    if (sel.asignacion === "conductor") {
      // No se toca la unidad, así que da igual qué placa tenga; pero no se mezcla un
      // conductor propio con servicios tercerizados, ni se le manda el conductor de una
      // empresa proveedora a cubrir los servicios de otra.
      if (r.tipo_asignacion && r.tipo_asignacion !== e.payload.tipo_asignacion) return "otro_tipo_asignacion";
      if (e.payload.tipo_asignacion === "tercerizado"
          && Number(r.empresa_tercerizada_id ?? 0) !== Number(e.payload.empresa_tercerizada_id ?? 0))
        return "otra_empresa";
      return "ok";
    }
    return (!e.otraUnidad && !conservaSuUnidad(r, e.payload)) ? "ya_tiene_unidad" : "ok";
  };
  const vAsignacion = sel.asignacion === "no"
    ? [] : e.universo.map(r => ({ id: r.id, motivo: veredictoAsignacion(r) }));
  const completas   = sel.asignacion === "completa"  ? resumir(vAsignacion) : sinEje();
  const conductores = sel.asignacion === "conductor" ? resumir(vAsignacion) : sinEje();
  const recibeAsignacion = new Set(completas.ids);

  // ── HORA ──────────────────────────────────────────────────────────────────
  // Su filtro es UNO solo y no se parece a los de la asignación: los que hoy salen a la
  // hora vieja. A un servicio que ya salía a otra hora, correrle el horario —y con él sus
  // paraderos, por el mismo delta— lo desalinearía en vez de moverlo. Y tampoco se le
  // corre a lo que ya ocurrió: la hora de un paradero recorrido es contra la que se midió
  // si el bus llegó tarde, y moverla reescribe el veredicto de un tramo que ya pasó.
  const horaNueva = hhmm(e.horaNueva);
  const vHora = e.universo.map(r => ({
    id: r.id,
    motivo: (!sel.hora || !horaNueva || horaNueva === e.horaOriginal) ? ("fuera_de_rango" as MotivoMasivo)
      : (yaOcurrio(r) ?? (
          !enRango(r) ? ("fuera_de_rango" as MotivoMasivo)
          : hhmm(r.hora_servicio) !== e.horaOriginal ? ("otra_hora_de_origen" as MotivoMasivo)
          : ("ok" as MotivoMasivo))),
  }));
  const horas = sel.hora ? resumir(vHora) : sinEje();

  // ── PAX ───────────────────────────────────────────────────────────────────
  // Ni hora, ni unidad, NI LA FECHA: los dos primeros protegen la asignación y el tercero
  // protege el despacho, y los asientos no son ninguna de las dos cosas — son del
  // CONTRATO. Por eso el pax alcanza a los retornos sin marcar nada y alcanza también a
  // los servicios que ya se prestaron: corregir el «de 10 contratados» que el portal le
  // publicó al cliente el 18 de septiembre es, literalmente, el caso de uso.
  const vPax = e.universo.map(r => ({
    id: r.id,
    motivo: !sel.pax ? ("fuera_de_rango" as MotivoMasivo)
      : !enRango(r) ? ("fuera_de_rango" as MotivoMasivo)
      : motivoPaxDe(r, e, hermano),
  }));
  const paxes = sel.pax ? resumir(vPax) : sinEje();

  // ── DINERO ────────────────────────────────────────────────────────────────
  // Tampoco filtra por hora ni por unidad… pero por la razón CONTRARIA al pax: no para
  // alcanzar a los dos tramos, sino para elegir a uno solo con conocimiento del día.
  const planDinero = (lado: LadoDinero, valor: number | null, activo: boolean) => {
    if (!activo || valor == null) return { resumen: sinEje(), efecto: null as EfectoDinero | null };
    const liquidadas = lado === "precio" ? e.liquidadasCliente : e.liquidadasProveedor;
    const vs = e.universo.map(r => {
      let motivo: MotivoMasivo = "ok";
      if (!enRango(r)) motivo = "fuera_de_rango";
      else if (liquidadas?.has(r.id)) motivo = "ya_liquidado";
      else if (lado === "costo") motivo = motivoCostoEmpresa(r, e, recibeAsignacion.has(r.id));
      if (motivo === "ok" && montoDe(r, lado) === valor) motivo = "sin_cambio";
      if (motivo === "ok") {
        const elegido = tramoDelImporte(delDia(r), lado, sentidoEditado, e.horaOriginal);
        if (!elegido.tramo) motivo = elegido.motivo;
        else if (elegido.tramo.id !== r.id) motivo = "importe_en_el_otro_tramo";
      }
      return { id: r.id, motivo };
    });
    const resumen = resumir(vs);
    const porId = new Map(e.universo.map(r => [r.id, r]));
    const antes = resumen.ids.reduce((s, id) => s + montoDe(porId.get(id)!, lado), 0);
    return {
      resumen,
      efecto: (resumen.ids.length
        ? { cuantos: resumen.ids.length, antes, despues: resumen.ids.length * valor, unitario: valor }
        : null) as EfectoDinero | null,
    };
  };
  const dPrecio = planDinero("precio", e.precio ?? null, sel.precio);
  const dCosto  = planDinero("costo",  e.costo  ?? null, sel.costo);

  // ── EL PATCH POR SERVICIO ─────────────────────────────────────────────────
  // Se arma UNA vez, juntando lo que cada eje le toca a ese id. El agrupado por patch
  // idéntico —para mandar un UPDATE por lote en vez de 900— lo hace quien escribe.
  const patches = new Map<number, Record<string, any>>();
  const poner = (id: number, campos: Record<string, any>) =>
    patches.set(id, { ...(patches.get(id) ?? {}), ...campos });

  // La asignación NO arrastra ni la hora ni la TARIFA: los dos tienen su propio eje, y
  // meterlos acá era exactamente lo que impedía corregir un importe sin reescribir el bus.
  //
  // CON UNA EXCEPCIÓN, Y NO ES UN DESCUIDO: al pasar un servicio a la FLOTA PROPIA su
  // `costo_proveedor` tiene que irse a 0. No es escribir una tarifa, es borrar una deuda
  // que dejó de existir — «la flota propia no le debe nada a un proveedor», que es lo que
  // `normalizarAsignacion` ya decide sobre este mismo payload. Soltarlo acá dejaría el
  // costo del proveedor anterior escrito en un servicio que ahora cubre AFA, y de ahí se
  // va derecho a `v_costo_servicio` y a `v_egresos`: el importe huérfano, por otra puerta.
  const deAsignacion = { ...e.payload };
  delete deAsignacion.hora_servicio;
  if (e.payload.tipo_asignacion !== "propio") delete deAsignacion.costo_proveedor;

  for (const id of completas.ids) poner(id, deAsignacion);
  for (const id of conductores.ids)
    poner(id, e.payload.tipo_asignacion === "propio"
      ? { conductor_id: e.payload.conductor_id }
      : { conductor_tercero_id: e.payload.conductor_tercero_id });
  for (const id of horas.ids) poner(id, { hora_servicio: e.horaNueva });
  for (const id of paxes.ids) poner(id, { capacidad_contratada: e.pax ?? null });
  for (const id of dPrecio.resumen.ids) poner(id, { precio_cliente: e.precio });
  for (const id of dCosto.resumen.ids)  poner(id, { costo_proveedor: e.costo });

  // Un pendiente que queda COMPLETAMENTE asignado se confirma, y solo por la asignación
  // completa: corregir unos asientos o una tarifa no programa ningún bus, y confirmar 30
  // servicios sin unidad sería mentirle al tablero.
  if (e.estadoPendientes) {
    const porId = new Map(e.universo.map(r => [r.id, r]));
    for (const id of completas.ids)
      if (String(porId.get(id)?.estado ?? "") === "pendiente")
        poner(id, { estado: e.estadoPendientes });
  }

  const ejes: Record<EjeMasivo, ResumenEje> = {
    asignacion: completas, conductor: conductores, hora: horas,
    pax: paxes, precio: dPrecio.resumen, costo: dCosto.resumen,
  };

  return {
    ejes,
    patches: [...patches.entries()].map(([id, patch]) => ({ id, patch })),
    idsConHora: horas.ids.slice(),
    total: patches.size,
    dinero: { precio: dPrecio.efecto, costo: dCosto.efecto },
  };
}

/**
 * Qué se está dejando fuera, dicho en la pantalla. Cada texto NOMBRA dónde se arregla:
 * un motivo que solo dice "no aplica" manda a mirar la base.
 */
export const TEXTO_MOTIVO: Record<MotivoMasivo, string> = {
  ok:                         "recibe el cambio",
  fuera_de_rango:             "fuera del rango de fechas elegido",
  ya_ocurrio:                 "ya se prestaron: no se les cambia la unidad ni la hora, pero sus asientos y su importe sí se corrigen",
  en_ruta:                    "están en ruta ahora mismo",
  otro_horario:               "salen a otro horario (marca «incluir otro horario» si también son suyos)",
  ya_tiene_unidad:            "ya tienen otra unidad asignada (marca «sobrescribir la unidad»)",
  otro_tipo_asignacion:       "son del otro tipo de asignación: no se mezcla un conductor propio con un servicio tercerizado",
  otra_empresa:               "son de otra empresa proveedora: su conductor no los cubre y su tarifa no es esta",
  otra_hora_de_origen:        "hoy no salen a las horas que se están corriendo, así que moverlos los desalinearía",
  otra_ruta:                  "son de otras rutas del contrato, y los asientos son de cada ruta",
  otra_capacidad:             "ya declaran otra capacidad: son otro móvil de esta ruta y la suya es correcta",
  importe_en_el_otro_tramo:   "el importe de ese día ya está en el otro tramo — escribirlo acá cobraría el día DOS veces",
  dia_ya_duplicado:           "esos días ya tienen importe en sus dos tramos (chip «DÍA 2×» en la lista): se arregla abriéndolos",
  importe_en_tramo_cancelado: "el importe de ese día quedó escrito en un tramo cancelado: no falta escribirlo, falta moverlo",
  no_se_sabe_que_tramo:       "ese día tiene dos tramos vivos y ninguno lleva importe: nada dice cuál debería llevarlo",
  flota_propia:               "son de la flota propia, y la flota propia no le debe nada a un proveedor",
  ya_liquidado:               "ya están dentro de una liquidación emitida: el importe se corrige desde ese documento",
  sin_cambio:                 "ya dicen exactamente ese importe",
};

/** El rótulo de cada eje. Vive acá para que la pantalla no lo redacte dos veces. */
export const TEXTO_EJE: Record<EjeMasivo, string> = {
  asignacion: "Empresa / unidad y conductor",
  conductor:  "Conductor",
  hora:       "Hora del servicio",
  pax:        "PAX contratados",
  precio:     "Precio de venta",
  costo:      "Costo del proveedor",
};

// ──────────────────────────────────────────────────────────────────────────────
// EL VALOR DE UN EJE SE TECLEA EN EL MODAL, Y UN CAMPO VACÍO NO ESCRIBE NUNCA UN 0
// ──────────────────────────────────────────────────────────────────────────────
//
// Los tres ejes de contrato —PAX, precio de venta y costo del proveedor— solo se
// ofrecían cuando el operador había tocado ESE campo en el formulario antes de guardar.
// Reportado con la pantalla delante: *«ya no me sale para cambiar solo pax, solo precio
// cliente, solo precio proveedor, o check box de cada dato que quiero cambiar»* — con la
// asignación en «No tocarla» y nada más tocado, el modal se quedaba sin una sola casilla
// y remataba en «Aplicar a 0 servicio(s)».
//
// Era el filtro de paquete otra vez, un piso más arriba todavía: lo que se puede cambiar
// en lote lo decidía lo que se había tocado de paso. Ahora el valor se TECLEA en el
// modal, y esta función es la única que dice qué significa lo escrito.
//
// LA REGLA QUE NO SE PUEDE AFLOJAR: **un campo vacío no es un cero y no es un borrado.**
// Un 0 deducido de un campo en blanco pondría 900 servicios en S/ 0.00 —o sin asientos—
// porque nadie escribió nada, que es la forma más barata de perder un contrato entero.
// Vacío NO se aplica, salvo cuando quien abrió el modal DECLARA que vaciar es lo que se
// pidió: hoy solo el PAX, y solo cuando el operador vació ese campo en el formulario
// (el comportamiento que ya existía, con su aviso en pantalla).
export type CodigoValor =
  /** Hay un número escrito y se puede aplicar. */
  | "tecleado"
  /** Vacío Y vaciar está permitido: se aplica, y lo que escribe es un BORRADO. */
  | "vaciar"
  /** Vacío sin permiso para vaciar: no hay nada que aplicar. */
  | "sin_valor"
  /** Hay algo escrito que no es un número utilizable para este eje. */
  | "no_valido";

export type ValorEje = {
  /** Lo que se va a escribir. `null` con `vaciar`; `null` también cuando no se aplica. */
  valor: number | null;
  /** ¿El eje puede marcarse y escribir algo? */
  aplicable: boolean;
  codigo: CodigoValor;
};

/**
 * Lee lo que el operador tecleó para un eje. PURA: no mira la base ni el formulario.
 *
 * `vaciarPermitido` lo declara quien abre el modal — no se deduce de que el campo esté
 * en blanco, porque en blanco es justamente lo que se ve cuando nadie escribió nada.
 * `entero` es para el PAX: medio asiento no existe, y un 0 contratado tampoco.
 */
export function valorTecleado(
  texto: string,
  opts?: { vaciarPermitido?: boolean; entero?: boolean },
): ValorEje {
  const t = String(texto ?? "").trim().replace(",", ".");
  if (t === "")
    return opts?.vaciarPermitido
      ? { valor: null, aplicable: true,  codigo: "vaciar" }
      : { valor: null, aplicable: false, codigo: "sin_valor" };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { valor: null, aplicable: false, codigo: "no_valido" };
  if (opts?.entero && (!Number.isInteger(n) || n <= 0))
    return { valor: null, aplicable: false, codigo: "no_valido" };
  return { valor: n, aplicable: true, codigo: "tecleado" };
}
