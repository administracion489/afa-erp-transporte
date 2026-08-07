// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-agrupacion.ts — De servicios sueltos a las líneas del formato.
//
// El "Formato de Liquidación y Conformidad del Servicio" (AFA-FL-07) NO lista un
// renglón por viaje: lista una línea por combinación de ruta + turno + móvil + tarifa,
// con la CANTIDAD de servicios del periodo. Eso es lo que este módulo calcula, para
// que nadie vuelva a contar "26.00" a mano:
//
//   TRANSPORTE DE PERSONAL CD CALLAO / 50 PAX / DEL 15-06-2026 AL 14-07-2026 /
//   RUTA 1 / TURNO NOCHE / MÓVIL 1        SERV.  26.00  ×  S/ 790.00
//
// Es CÓDIGO PURO (sin Supabase, sin React): recibe las reservas ya leídas y devuelve
// las líneas. Así se puede probar de verdad y reusar desde la página, la API y el
// script de muestra del PDF.
//
// Dos números distintos por línea, a propósito:
//   cantidad_programada → cuántos servicios había en el periodo (cualquier estado)
//   cantidad_ejecutada  → cuántos se finalizaron de verdad
// La cantidad que se cobra arranca en la ejecutada y el operador puede cambiarla
// dejando constancia (decisión del negocio: "ejecutados, pero editable").
// ──────────────────────────────────────────────────────────────────────────────

import { redondear, desdeTotal } from "@/lib/finanzas/dinero";

// ── Entrada ─────────────────────────────────────────────────────────────────

/** Proyección de `reservas` que necesita la agrupación. Nada más: el resto no se lee. */
export type ReservaLiq = {
  id: number;
  codigo?: string | null;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  estado: string | null;
  estado_admin?: string | null;
  estado_proveedor?: string | null;
  cliente_id: number | null;
  cliente_sede_id?: number | null;
  ruta_nombre?: string | null;
  direccion_servicio?: string | null;   // 'ida' | 'retorno'
  /** Enlaza la ida con su retorno: los dos tramos que cubre UNA sola tarifa. */
  reserva_vinculada_id?: number | null;
  origen?: string | null;
  destino?: string | null;
  precio_cliente?: number | null;
  costo_proveedor?: number | null;
  tipo_asignacion?: string | null;
  vehiculo_id?: number | null;
  vehiculo_tercero_id?: number | null;
  conductor_id?: number | null;
  conductor_tercero_id?: number | null;
  empresa_tercerizada_id?: number | null;
  pasajeros_abordados?: number | null;
  hora_real_inicio?: string | null;
  hora_real_fin?: string | null;
  tipo_servicio_detalle?: string | null;
  liquidacion_cliente_id?: number | null;
  liquidacion_proveedor_id?: number | null;
};

/** Datos de apoyo que la página resuelve una sola vez (placas, capacidades, nombres). */
export type CatalogoLiq = {
  placaDe: (r: ReservaLiq) => string;
  capacidadDe: (r: ReservaLiq) => number | null;
  conductorDe: (r: ReservaLiq) => string;
  sedeNombre?: string | null;
};

export type LadoLiquidacion = "cliente" | "proveedor";

// ── Turno, sentido y ruta ───────────────────────────────────────────────────

/**
 * Turno del servicio. Se lee del texto si la operación ya lo escribió (nombre de ruta
 * u observaciones dicen "TURNO NOCHE"); si no, se deriva de la hora programada.
 * Nunca queda vacío: el formato del cliente siempre nombra un turno.
 */
export function turnoDeReserva(r: ReservaLiq): "DÍA" | "NOCHE" | "TARDE" {
  const txt = `${r.ruta_nombre ?? ""}`.toUpperCase();
  if (/TURNO\s*NOCHE|\bNOCHE\b/.test(txt)) return "NOCHE";
  if (/TURNO\s*TARDE|\bTARDE\b/.test(txt)) return "TARDE";
  if (/TURNO\s*D[ÍI]A|\bD[ÍI]A\b/.test(txt)) return "DÍA";

  const h = Number(String(r.hora_servicio ?? "").slice(0, 2));
  if (!Number.isFinite(h)) return "DÍA";
  if (h >= 18 || h < 5) return "NOCHE";
  if (h >= 13) return "TARDE";
  return "DÍA";
}

/** 'IDA' | 'RETORNO'. Prioriza el campo canónico; cae al nombre de ruta. */
export function sentidoDeReserva(r: ReservaLiq): "IDA" | "RETORNO" {
  const d = String(r.direccion_servicio ?? "").toLowerCase();
  if (d === "retorno") return "RETORNO";
  if (d === "ida") return "IDA";
  return /RETORNO|SALIDA/i.test(String(r.ruta_nombre ?? "")) ? "RETORNO" : "IDA";
}

/**
 * Etiqueta corta de la ruta para la descripción: "RUTA 1", "RUTA B"…
 * El nombre completo trae hora y extremos ("RUTA B/ ENTRADA 05:10/ CHILCA→…") y esos
 * ya se muestran aparte; aquí solo interesa el identificador que el cliente reconoce.
 */
export function etiquetaRuta(r: ReservaLiq): string {
  const m = /\bRUTA\s+([A-Z0-9]{1,3})\b/i.exec(String(r.ruta_nombre ?? ""));
  if (m) return `RUTA ${m[1].toUpperCase()}`;
  const tramo = [r.origen, r.destino].filter(Boolean).join(" → ").toUpperCase();
  return tramo || "RUTA ÚNICA";
}

// ── Servicio facturable: el par IDA + RETORNO ───────────────────────────────
//
// AFA cobra UNA tarifa por los dos tramos del día. Al generar los servicios en lote,
// el importe completo va en la IDA y el RETORNO queda en S/ 0.00 — los dos quedan
// unidos por `reserva_vinculada_id`. Verificado sobre los datos reales de 2026: los
// 210 retornos finalizados están en cero y los 414 vínculos son bidireccionales.
//
// Consecuencia para la liquidación: la unidad que se cobra NO es la reserva, es el
// PAR. Contar reservas facturaría 52 servicios donde el cliente pactó 26.

/** Un servicio facturable: la reserva que lleva la tarifa + los tramos que cubre. */
export type ParServicio = {
  /** La reserva que aporta el importe (normalmente la IDA). */
  cabeza: ReservaLiq;
  /** Tramos incluidos en esa misma tarifa (el RETORNO). Van al Anexo 1 en S/ 0.00. */
  adjuntas: ReservaLiq[];
  /**
   * false = estaba programado pero no se prestó. Suma a la cantidad PROGRAMADA del
   * formato y no a la cobrada: así el cliente lee "26 / 25" y ve qué pasó, en vez de
   * un "25 / 25" que esconde el servicio caído.
   */
  ejecutado: boolean;
};

/** Importe de una reserva según el lado que se esté liquidando. */
function montoDe(r: ReservaLiq, lado: LadoLiquidacion): number {
  return Number((lado === "cliente" ? r.precio_cliente : r.costo_proveedor) ?? 0);
}

/** ¿Están enlazadas como ida/retorno del mismo servicio? */
function sonPar(a: ReservaLiq, b: ReservaLiq): boolean {
  return a.reserva_vinculada_id === b.id || b.reserva_vinculada_id === a.id;
}

// ── Bloqueos: qué NO se puede liquidar todavía ──────────────────────────────

export type Bloqueo = { codigo: string; mensaje: string };

/**
 * Motivos por los que un servicio no debería entrar a una liquidación. La pantalla los
 * muestra en rojo y no deja liquidar el grupo hasta resolverlos: una valorización mal
 * armada se descubre cuando el cliente la rechaza, semanas después.
 *
 * `cubiertaPor` es el par que ya lleva la tarifa: un RETORNO en S/ 0.00 enlazado a una
 * IDA con precio NO está incompleto, está incluido. Sin ese contexto marcaríamos como
 * error la mitad de la operación.
 */
export function bloqueosDe(
  r: ReservaLiq,
  lado: LadoLiquidacion,
  cubiertaPor?: ReservaLiq | null
): Bloqueo[] {
  const b: Bloqueo[] = [];
  if (r.estado !== "finalizada")
    b.push({ codigo: "no_finalizada", mensaje: "El servicio no está finalizado" });

  const cubierta = !!cubiertaPor && montoDe(cubiertaPor, lado) > 0;

  if (lado === "cliente") {
    if (!Number(r.precio_cliente ?? 0) && !cubierta)
      b.push({ codigo: "sin_precio", mensaje: "Sin precio de venta" });
    if (r.liquidacion_cliente_id)
      b.push({ codigo: "ya_liquidada", mensaje: `Ya está en la liquidación #${r.liquidacion_cliente_id}` });
    if (!r.cliente_id)
      b.push({ codigo: "sin_cliente", mensaje: "Sin cliente asignado" });
  } else {
    if (!Number(r.costo_proveedor ?? 0) && !cubierta)
      b.push({ codigo: "sin_costo", mensaje: "Sin costo de proveedor" });
    if (r.liquidacion_proveedor_id)
      b.push({ codigo: "ya_liquidada", mensaje: `Ya está en la liquidación #${r.liquidacion_proveedor_id}` });
    if (!r.empresa_tercerizada_id)
      b.push({ codigo: "sin_empresa", mensaje: "Sin empresa tercerizada" });
  }
  return b;
}

export type AnalisisServicios = {
  /** Servicios facturables listos para valorizar. */
  pares: ParServicio[];
  /** Lo que no puede liquidarse todavía, con el motivo para mostrarlo en rojo. */
  bloqueadas: { r: ReservaLiq; motivos: string[] }[];
  /** Tramos incluidos que no se ejecutaron: no bloquean, pero hay que verlos. */
  avisos: { r: ReservaLiq; mensaje: string }[];
};

/**
 * Separa un conjunto de servicios en unidades facturables y bloqueos.
 *
 * Criterio dentro de un par enlazado:
 *   · uno con importe y el otro en 0  → el primero es la cabeza, el otro va incluido
 *   · los dos con importe             → son dos servicios independientes
 *   · los dos en 0                    → falta el dato: ambos bloqueados
 *
 * Si la cabeza está bloqueada (ya liquidada, sin cliente…), su par también: no tiene
 * sentido cobrar medio servicio.
 */
export function analizarServicios(reservas: ReservaLiq[], lado: LadoLiquidacion): AnalisisServicios {
  const porId = new Map<number, ReservaLiq>(reservas.map((r) => [r.id, r]));
  const usadas = new Set<number>();
  const res: AnalisisServicios = { pares: [], bloqueadas: [], avisos: [] };

  const hecho = (r: ReservaLiq) => r.estado === "finalizada";
  // "No finalizado" no es un bloqueo: es un servicio programado que no se prestó, y el
  // formato tiene que mostrarlo en la columna PROG./EJEC. El resto sí impide liquidar.
  const trabas = (r: ReservaLiq, cubiertaPor?: ReservaLiq | null) =>
    bloqueosDe(r, lado, cubiertaPor).filter((b) => b.codigo !== "no_finalizada").map((b) => b.mensaje);
  const bloquear = (r: ReservaLiq, motivos: string[]) => {
    if (motivos.length) res.bloqueadas.push({ r, motivos });
  };

  for (const r of reservas) {
    if (usadas.has(r.id)) continue;

    // El par solo cuenta si está en el mismo conjunto (mismo cliente y periodo).
    const posible = r.reserva_vinculada_id ? porId.get(r.reserva_vinculada_id) : undefined;
    const par = posible && !usadas.has(posible.id) && sonPar(r, posible) ? posible : null;

    if (!par) {
      usadas.add(r.id);
      // Sin precio y con un par que quedó fuera del periodo (típico del servicio
      // nocturno que retorna al día siguiente): decirlo explícitamente, porque
      // "sin precio de venta" mandaría a buscar un dato que no falta.
      if (montoDe(r, lado) <= 0 && r.reserva_vinculada_id) {
        bloquear(r, [`Su tarifa va en el servicio #${r.reserva_vinculada_id}, que no está en este periodo`]);
        continue;
      }
      const motivos = trabas(r);
      if (motivos.length) bloquear(r, motivos);
      else res.pares.push({ cabeza: r, adjuntas: [], ejecutado: hecho(r) });
      continue;
    }

    usadas.add(r.id);
    usadas.add(par.id);
    const mA = montoDe(r, lado);
    const mB = montoDe(par, lado);

    // Los dos cobran: dos servicios facturables distintos que además viajan juntos.
    if (mA > 0 && mB > 0) {
      for (const x of [r, par]) {
        const motivos = trabas(x);
        if (motivos.length) bloquear(x, motivos);
        else res.pares.push({ cabeza: x, adjuntas: [], ejecutado: hecho(x) });
      }
      continue;
    }

    // Ninguno cobra: el precio nunca se cargó. Los dos quedan fuera con su motivo.
    if (mA <= 0 && mB <= 0) {
      bloquear(r, trabas(r));
      bloquear(par, trabas(par));
      continue;
    }

    // El caso normal: uno lleva la tarifa de los dos tramos.
    const cabeza = mA > 0 ? r : par;
    const adjunta = mA > 0 ? par : r;

    const motivosCabeza = trabas(cabeza);
    if (motivosCabeza.length) {
      bloquear(cabeza, motivosCabeza);
      bloquear(adjunta, [`Va con el servicio ${cabeza.codigo ?? "#" + cabeza.id}, que está bloqueado`]);
      continue;
    }

    const motivosAdjunta = trabas(adjunta, cabeza);
    if (motivosAdjunta.length) {
      // El tramo incluido tiene su propio problema (p. ej. ya entró en otra
      // liquidación): la tarifa se cobra igual, pero queda el aviso.
      res.avisos.push({
        r: adjunta,
        mensaje: `${adjunta.direccion_servicio === "retorno" ? "Retorno" : "Tramo"} del ${adjunta.fecha_servicio ?? ""}: ${motivosAdjunta.join(" · ")}`,
      });
      res.pares.push({ cabeza, adjuntas: [], ejecutado: hecho(cabeza) });
      continue;
    }

    // Solo van al puente los tramos realmente prestados: marcar como liquidado algo
    // que no se ejecutó ensuciaría el ciclo del servicio.
    if (!hecho(adjunta) && hecho(cabeza)) {
      res.avisos.push({
        r: adjunta,
        mensaje: `El retorno del ${adjunta.fecha_servicio ?? ""} no se ejecutó, pero la tarifa del día se cobra completa`,
      });
      res.pares.push({ cabeza, adjuntas: [], ejecutado: true });
      continue;
    }

    res.pares.push({
      cabeza,
      adjuntas: hecho(adjunta) ? [adjunta] : [],
      ejecutado: hecho(cabeza),
    });
  }

  return res;
}

/** Avisos que NO bloquean pero conviene ver antes de emitir (van al Anexo 1). */
export function avisosDe(r: ReservaLiq, catalogo: CatalogoLiq): string[] {
  const a: string[] = [];
  if (!catalogo.placaDe(r)) a.push("Sin unidad asignada");
  if (!catalogo.conductorDe(r)) a.push("Sin conductor asignado");
  if (!r.ruta_nombre) a.push("Sin nombre de ruta");
  return a;
}

// ── Precio unitario del formato ─────────────────────────────────────────────

/**
 * Precio que va a la columna "Precio unitario". El formato lista NETOS (el IGV se suma
 * abajo), así que si en el ERP el importe se cargó con IGV incluido hay que extraerlo.
 * La decisión viaja explícita en la liquidación (`precios_incluyen_igv`) porque adivinar
 * aquí desviaría el documento un 18%.
 */
export function precioUnitario(
  r: ReservaLiq,
  lado: LadoLiquidacion,
  opts: { preciosIncluyenIgv: boolean; igvPct: number }
): number {
  const bruto = Number((lado === "cliente" ? r.precio_cliente : r.costo_proveedor) ?? 0);
  if (!opts.preciosIncluyenIgv) return redondear(bruto);
  return redondear(desdeTotal(bruto, opts.igvPct).base);
}

// ── Agrupación ──────────────────────────────────────────────────────────────

export type LineaAgrupada = {
  clave: string;
  tipo: "servicio";
  descripcion: string;
  unidad_medida: string;
  cantidad_programada: number;
  cantidad_ejecutada: number;
  cantidad: number;
  precio_unitario: number;
  total_linea: number;
  /** ids de las reservas EJECUTADAS que sustentan la línea (van al Anexo 1). */
  reservas: number[];
  /** ids de todas las del periodo, ejecutadas o no (para el contraste programado/ejecutado). */
  reservas_periodo: number[];
  ruta: string;
  turno: string;
  sentido: string;
  movil: number;
  placas: string[];
  pax: number | null;
  referencia: string;
};

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

/** Fecha 'AAAA-MM-DD' → '15-06-2026' (como se escribe en el formato). */
export function fechaFormato(iso: string | null | undefined): string {
  const s = String(iso ?? "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

/** Letra de la serie del Anexo 1: 1→A, 2→B … 27→AA. */
function serieAnexo(n: number): string {
  let s = "";
  let i = n;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s || "A";
}

export type OpcionesAgrupacion = {
  lado: LadoLiquidacion;
  catalogo: CatalogoLiq;
  preciosIncluyenIgv: boolean;
  igvPct: number;
  /** Nombre de la sede/CD tal como debe leerse en la descripción ('CD CALLAO'). */
  sede?: string | null;
  /** Rango del periodo, para el texto "DEL … AL …". */
  desde?: string | null;
  hasta?: string | null;
  /** Encabezado del servicio; por defecto 'TRANSPORTE DE PERSONAL'. */
  concepto?: string;
};

/**
 * Agrupa los servicios facturables de UNA sede en las líneas del formato.
 *
 * Recibe PARES (ida+retorno = un servicio), no reservas sueltas: así la cantidad que
 * lee el cliente es la que pactó. Ver `analizarServicios`.
 *
 * Clave primaria de agrupación: ruta + turno + sentido + tarifa. La placa NO entra:
 * el cliente contrata "MÓVIL 1", no una unidad, y un reemplazo por avería no debe
 * partir la línea en dos. Pero si dentro de un mismo grupo hay dos servicios el MISMO
 * día (señal de que son dos móviles a la misma tarifa), ahí sí se separa por placa —
 * que es exactamente como el Excel distingue MÓVIL 1 de MÓVIL 2.
 */
export function agruparServicios(
  pares: ParServicio[],
  opts: OpcionesAgrupacion
): LineaAgrupada[] {
  const { catalogo, lado } = opts;

  type Bucket = {
    clave: string;
    ruta: string;
    turno: string;
    sentido: string;
    precio: number;
    filas: ParServicio[];
  };
  const buckets = new Map<string, Bucket>();

  for (const p of pares) {
    const r = p.cabeza;
    const precio = precioUnitario(r, lado, {
      preciosIncluyenIgv: opts.preciosIncluyenIgv,
      igvPct: opts.igvPct,
    });
    const ruta = etiquetaRuta(r);
    const turno = turnoDeReserva(r);
    // Un par cubre los dos tramos: el sentido de la cabeza no debe partir la línea.
    const sentido = p.adjuntas.length ? "IDA Y RETORNO" : sentidoDeReserva(r);
    const clave = [norm(ruta), turno, sentido, precio.toFixed(2)].join("|");
    const b = buckets.get(clave) ?? { clave, ruta, turno, sentido, precio, filas: [] };
    b.filas.push(p);
    buckets.set(clave, b);
  }

  // Segunda pasada: separar por placa los grupos con servicios simultáneos.
  const finales: Bucket[] = [];
  for (const b of buckets.values()) {
    const porFecha = new Map<string, number>();
    for (const p of b.filas) {
      const f = String(p.cabeza.fecha_servicio ?? "");
      porFecha.set(f, (porFecha.get(f) ?? 0) + 1);
    }
    const haySimultaneos = [...porFecha.values()].some((n) => n > 1);
    if (!haySimultaneos) {
      finales.push(b);
      continue;
    }
    const porPlaca = new Map<string, ParServicio[]>();
    for (const p of b.filas) {
      const placa = catalogo.placaDe(p.cabeza) || "SIN UNIDAD";
      (porPlaca.get(placa) ?? porPlaca.set(placa, []).get(placa)!).push(p);
    }
    for (const [placa, filas] of porPlaca)
      finales.push({ ...b, clave: `${b.clave}|${placa}`, filas });
  }

  // Numerar los móviles dentro de cada ruta+turno: móvil 1 es el de mayor capacidad
  // (y a igual capacidad, el de mayor tarifa), igual que en los formatos actuales.
  const porRutaTurno = new Map<string, Bucket[]>();
  for (const b of finales) {
    const k = `${norm(b.ruta)}|${b.turno}|${b.sentido}`;
    (porRutaTurno.get(k) ?? porRutaTurno.set(k, []).get(k)!).push(b);
  }
  const movilDe = new Map<string, number>();
  for (const grupo of porRutaTurno.values()) {
    const conCap = grupo.map((b) => ({
      b,
      cap: Math.max(0, ...b.filas.map((p) => Number(catalogo.capacidadDe(p.cabeza) ?? 0))),
    }));
    conCap.sort((x, y) => y.cap - x.cap || y.b.precio - x.b.precio || x.b.clave.localeCompare(y.b.clave));
    conCap.forEach((x, i) => movilDe.set(x.b.clave, i + 1));
  }

  const lineas: LineaAgrupada[] = [];
  const ordenados = [...finales].sort(
    (a, b) =>
      a.ruta.localeCompare(b.ruta) ||
      a.turno.localeCompare(b.turno) ||
      (movilDe.get(a.clave) ?? 0) - (movilDe.get(b.clave) ?? 0)
  );

  ordenados.forEach((b, idx) => {
    const ejecutados = b.filas.filter((p) => p.ejecutado);
    // Todas las reservas del bucket (cabezas + tramos incluidos): de aquí salen las
    // placas, los pasajeros y el detalle del Anexo 1.
    const todas = b.filas.flatMap((p) => [p.cabeza, ...p.adjuntas]);

    const capacidades = todas.map((r) => Number(catalogo.capacidadDe(r) ?? 0)).filter((n) => n > 0);
    // El "50 PAX / 10 PAX" del formato es el personal que el cliente contrató por móvil,
    // no la capacidad del bus (un bus de 50 puede estar cubriendo una ruta de 10). El
    // máximo embarcado en el periodo es la mejor evidencia de ese número; la capacidad
    // solo entra si todavía no hay manifiestos.
    const embarcados = todas.map((r) => Number(r.pasajeros_abordados ?? 0)).filter((n) => n > 0);
    const pax = embarcados.length
      ? Math.max(...embarcados)
      : capacidades.length
      ? Math.max(...capacidades)
      : null;
    const placas = [...new Set(todas.map((r) => catalogo.placaDe(r)).filter(Boolean))];
    const movil = movilDe.get(b.clave) ?? idx + 1;
    const serie = serieAnexo(idx + 1);
    const cantidad = ejecutados.length;

    lineas.push({
      clave: b.clave,
      tipo: "servicio",
      descripcion: descripcionLinea({
        concepto: opts.concepto,
        sede: opts.sede ?? catalogo.sedeNombre ?? null,
        pax,
        desde: opts.desde ?? null,
        hasta: opts.hasta ?? null,
        ruta: b.ruta,
        turno: b.turno,
        sentido: b.sentido,
        movil,
        totalMoviles: (porRutaTurno.get(`${norm(b.ruta)}|${b.turno}|${b.sentido}`) ?? []).length,
      }),
      unidad_medida: "SERV.",
      cantidad_programada: b.filas.length,
      cantidad_ejecutada: ejecutados.length,
      cantidad,
      precio_unitario: b.precio,
      total_linea: redondear(cantidad * b.precio),
      // Al puente van AMBOS tramos del servicio prestado: los dos quedan liquidados y
      // los dos se ven en el Anexo 1 (el retorno, con importe incluido).
      reservas: ejecutados.flatMap((p) => [p.cabeza.id, ...p.adjuntas.map((a) => a.id)]),
      reservas_periodo: todas.map((r) => r.id),
      ruta: b.ruta,
      turno: b.turno,
      sentido: b.sentido,
      movil,
      placas,
      pax,
      referencia: cantidad
        ? `${serie}-01 a ${serie}-${String(cantidad).padStart(2, "0")}`
        : "—",
    });
  });

  return lineas;
}

/** Arma la descripción con la misma redacción que el cliente ya está acostumbrado a leer. */
export function descripcionLinea(p: {
  concepto?: string;
  sede?: string | null;
  pax?: number | null;
  desde?: string | null;
  hasta?: string | null;
  ruta: string;
  turno: string;
  sentido?: string;
  movil?: number;
  totalMoviles?: number;
}): string {
  const partes = [
    `${p.concepto || "TRANSPORTE DE PERSONAL"}${p.sede ? " " + norm(p.sede) : ""}`,
    p.pax ? `${p.pax} PAX` : null,
    p.desde && p.hasta ? `DEL ${fechaFormato(p.desde)} AL ${fechaFormato(p.hasta)}` : null,
    p.ruta,
    `TURNO ${p.turno}`,
    // El sentido solo aporta cuando el servicio tiene ida y retorno separados.
    p.sentido === "RETORNO" ? "RETORNO" : null,
    // "MÓVIL 1" solo tiene sentido si hay más de un móvil en esa ruta/turno.
    (p.totalMoviles ?? 1) > 1 && p.movil ? `MÓVIL ${p.movil}` : null,
  ].filter(Boolean);
  return partes.join(" / ");
}

// ── Totales de la valorización ──────────────────────────────────────────────

export type LineaMonto = {
  tipo: "servicio" | "adicional" | "penalidad" | "descuento";
  cantidad: number;
  precio_unitario: number;
};

/** ± del importe de una línea según su tipo (las penalidades y descuentos restan). */
export function totalLinea(l: LineaMonto): number {
  const bruto = redondear(Number(l.cantidad ?? 0) * Number(l.precio_unitario ?? 0));
  return l.tipo === "penalidad" || l.tipo === "descuento" ? -bruto : bruto;
}

export type TotalesValorizacion = {
  servicios: number;
  adicionales: number;
  descuentos: number;   // positivo: lo que se resta
  subtotal: number;     // neto sin IGV
  igv: number;
  total: number;
};

export function totalesValorizacion(lineas: LineaMonto[], igvPct: number): TotalesValorizacion {
  let servicios = 0, adicionales = 0, descuentos = 0;
  for (const l of lineas) {
    const m = totalLinea(l);
    if (l.tipo === "servicio") servicios += m;
    else if (l.tipo === "adicional") adicionales += m;
    else descuentos += Math.abs(m);
  }
  const subtotal = redondear(servicios + adicionales - descuentos);
  const igv = redondear(subtotal * (igvPct / 100));
  return {
    servicios: redondear(servicios),
    adicionales: redondear(adicionales),
    descuentos: redondear(descuentos),
    subtotal,
    igv,
    total: redondear(subtotal + igv),
  };
}
