// ──────────────────────────────────────────────────────────────────────────────
// lib/reservas-pacto.ts — LA ÚNICA PUERTA por la que se escribe dinero en `reservas`.
//
// Programación escribe reservas por TRES caminos distintos con payloads parecidos:
// guardar el formulario (page.tsx:1432), aplicar al contrato (:1573) y la asignación
// en bloque (:1074). Cada control que se quisiera poner habría que ponerlo tres veces,
// y bastaría olvidar uno para que la regla no exista. Este módulo los unifica.
//
// Qué resuelve, además de unificar:
//
//   · COHERENCIA. Si viene un vehículo de tercero sin empresa, la deriva. Es el mismo
//     arreglo que hace el trigger de nacimiento, pero acá el operador lo ve antes de
//     guardar en vez de descubrirlo después.
//
//   · RECHAZOS CON NOMBRE. Hoy un `.in("id", [50 ids])` que falla rechaza el lote
//     entero y solo dice "error": nadie sabe cuál de los 50 fue. Acá, si el lote falla,
//     se reintenta fila por fila y se devuelve qué se guardó y qué no.
//
//   · DEGRADACIÓN. Las columnas del Pacto (compra_afectacion, cambio_motivo…) solo
//     existen después de correr supabase/pacto-00 y pacto-02. Si todavía no se
//     corrieron, se reintenta sin ellas: el ERP sigue funcionando exactamente como
//     antes y solo se pierde el rastro, no el trabajo del operador.
//
// El acta la escribe Postgres, no este módulo. Acá solo se manda el motivo en el mismo
// UPDATE para que el trigger lo recoja.
// ──────────────────────────────────────────────────────────────────────────────

import { margenServicio, type CodigoAfectacion } from "@/lib/finanzas/afectacion";

/** Columnas que solo existen con las migraciones del Pacto corridas. */
const COLUMNAS_PACTO = [
  "cambio_motivo", "cambio_nota", "compra_afectacion", "venta_afectacion",
] as const;

export type CambioServicio = {
  /** Clave de public.pacto_motivo. El trigger la copia al acta. */
  motivo?: string | null;
  nota?: string | null;
};

export type ResultadoGuardado = {
  ok: boolean;
  guardados: number[];
  rechazos: { id: number; motivo: string }[];
  /** Aviso no bloqueante: se guardó, pero algo quedó a medias. */
  aviso?: string;
};

/**
 * Coherencia de la asignación. Las mismas reglas que aplica el trigger de nacimiento,
 * adelantadas al cliente para que el operador vea el resultado antes de guardar.
 *
 * `vehiculosTercero` permite derivar la empresa desde el vehículo — el arreglo del bug
 * de cotizaciones:1223, donde el servicio queda tercerizado en la calle y "propio" para
 * el ERP, que es un costo que ni siquiera llega al bloque rojo.
 */
export function normalizarAsignacion(
  patch: Record<string, any>,
  vehiculosTercero: { id: number; empresa_id?: number | null }[] = []
): Record<string, any> {
  const p = { ...patch };

  if (!p.empresa_tercerizada_id && p.vehiculo_tercero_id) {
    const v = vehiculosTercero.find((v) => Number(v.id) === Number(p.vehiculo_tercero_id));
    if (v?.empresa_id) p.empresa_tercerizada_id = Number(v.empresa_id);
  }

  // Los campos de tercero solo IMPLICAN tercerizado cuando no hay una intención propia
  // explícita. Si el operador eligió "propio" y asignó unidad o conductor de la flota,
  // manda su decisión y los datos del tercero son residuo que hay que limpiar: si se
  // dejaran, la liquidación le cobraría al proveedor un servicio que nunca prestó.
  // Si en cambio viene "propio" con SOLO un vehículo de tercero, es el origen roto
  // (cotizaciones:1223) y ahí sí gana el dato.
  const tieneRecursoPropio  = !!p.vehiculo_id || !!p.conductor_id;
  const tieneRecursoTercero = !!p.empresa_tercerizada_id || !!p.vehiculo_tercero_id;
  const esTercero = p.tipo_asignacion === "tercerizado"
    || (tieneRecursoTercero && !(p.tipo_asignacion === "propio" && tieneRecursoPropio));

  if (esTercero) {
    p.tipo_asignacion = "tercerizado";
    p.tipo = "tercerizada";
    // Un servicio tercerizado no puede arrastrar unidad ni conductor propios.
    if ("vehiculo_id" in p) p.vehiculo_id = null;
    if ("conductor_id" in p) p.conductor_id = null;
  } else if (p.tipo_asignacion === "propio") {
    p.tipo = "propia";
    if ("empresa_tercerizada_id" in p) p.empresa_tercerizada_id = null;
    if ("vehiculo_tercero_id" in p) p.vehiculo_tercero_id = null;
    if ("conductor_tercero_id" in p) p.conductor_tercero_id = null;
    // La flota propia no le debe nada a un proveedor.
    p.costo_proveedor = 0;
  }
  return p;
}

export type AvisoPacto = { nivel: "alerta" | "info"; texto: string };

/**
 * El OTRO tramo del día: la ida de este retorno, o el retorno de esta ida.
 * `reservas.reserva_vinculada_id` los enlaza.
 */
export type TramoHermano = {
  id?: number | null;
  codigo?: string | null;
  direccion_servicio?: string | null;
  estado?: string | null;
  /** Acuerdo de pago sobre una cancelación. Ver `avisosDe`: cambia si el día vale algo. */
  falso_flete?: boolean | null;
  precio_cliente?: number | null;
  costo_proveedor?: number | null;
  /**
   * Los asientos CONTRATADOS del día. A diferencia del importe —que va en un tramo y
   * en el otro queda en S/ 0.00 a propósito— este número es el MISMO para los dos: el
   * cliente contrató una ruta de N asientos, no una ida de 15 y un retorno de 20. El
   * generador lo escribe solo en la ida (ver ModalGenerarPrograma), así que sin mirar
   * al hermano un retorno parece no tenerlo. Ver `lib/liquidacion-rutas.ts`.
   */
  capacidad_contratada?: number | null;
  ruta_nombre?: string | null;
} | null;

const esRetorno = (d?: string | null) => String(d ?? "").toLowerCase() === "retorno";
const nombreTramo = (h?: TramoHermano) => (esRetorno(h?.direccion_servicio) ? "el retorno" : "la ida");
const refTramo = (h?: TramoHermano) => h?.codigo ?? (h?.id != null ? `#${h.id}` : "el otro tramo");
const sePresto = (estado?: string | null) => String(estado ?? "").toLowerCase() === "finalizada";
const seCayo = (estado?: string | null) =>
  ["cancelada", "anulada"].includes(String(estado ?? "").toLowerCase());

/**
 * Lo que conviene decirle al operador ANTES de guardar. No bloquea nada: en esta fase
 * la política está en modo `observa` y el bus tiene que salir igual. Es información
 * para que decida, no un peaje.
 *
 * `hermano` es el otro tramo del día, y sin él los avisos MIENTEN. AFA cobra una sola
 * tarifa por la ida y el retorno: el importe va en un tramo y el otro queda en S/ 0.00
 * a propósito. Juzgando cada reserva aislada, todo retorno disparaba "sin costo
 * pactado" — un rojo permanente y falso que además enseñaba a ignorar los rojos de
 * verdad, y que invitaba a "arreglarlo" cargando el importe dos veces.
 */
export function avisosDe(
  patch: Record<string, any>,
  anterior?: { precio_cliente?: number | null; costo_proveedor?: number | null } | null,
  hermano?: TramoHermano,
  /**
   * Qué cara del dinero juzgar. Programación edita las dos y no pasa nada, que es el
   * comportamiento de siempre. Una pantalla que solo edita una —el modal de servicios
   * de Liquidaciones, que del lado cliente escribe el precio y del lado proveedor el
   * costo— pide solo la suya: si no, al corregir un precio salían en rojo los avisos
   * del costo, que ahí ni se ven ni se pueden arreglar.
   */
  soloJuzgar?: "costo" | "precio"
): AvisoPacto[] {
  const avisos: AvisoPacto[] = [];
  const esTercero = patch.tipo_asignacion === "tercerizado";
  const costo = Number(patch.costo_proveedor ?? 0);
  const precio = Number(patch.precio_cliente ?? 0);
  const costoHermano = Number(hermano?.costo_proveedor ?? 0);
  const precioHermano = Number(hermano?.precio_cliente ?? 0);
  const yo = esRetorno(patch.direccion_servicio) ? "Este retorno" : "Esta ida";

  // ── El importe del día: quién lo lleva ────────────────────────────────────
  const importeDelDia = (
    mio: number, suyo: number, etiqueta: "costo" | "precio", moneda: string
  ) => {
    if (mio > 0 && suyo > 0)
      avisos.push({
        nivel: "alerta",
        texto: `¡Ojo! ${nombreTramo(hermano)} (${refTramo(hermano)}) ya tiene ${etiqueta} por ${moneda} ${suyo.toFixed(2)}. ` +
               `Si dejas los dos, el día se cobra DOS VECES. La tarifa cubre ida y retorno: ponla en un solo tramo.`,
      });
    else if (mio <= 0 && suyo > 0)
      avisos.push({
        nivel: "info",
        texto: `Incluido en ${nombreTramo(hermano)} (${refTramo(hermano)}), que lleva el ${etiqueta} del día: ${moneda} ${suyo.toFixed(2)}. ` +
               `Este tramo va en 0 a propósito.`,
      });
    else if (mio <= 0 && suyo <= 0)
      avisos.push({
        nivel: "alerta",
        texto: `Ni este tramo ni ${nombreTramo(hermano)} (${refTramo(hermano)}) tienen ${etiqueta}: ` +
               `el día entero no se podrá liquidar al cierre.`,
      });
    else if (mio > 0 && seCayo(patch.estado) && sePresto(hermano?.estado))
      // El caso que rompe la regla "el importe va en la ida": si la ida se cancela y el
      // retorno sí se presta, el importe tiene que estar donde hubo servicio.
      avisos.push({
        nivel: "alerta",
        texto: `${yo} está ${String(patch.estado).toLowerCase()} pero lleva el ${etiqueta} del día, y ${nombreTramo(hermano)} ` +
               `(${refTramo(hermano)}) sí se prestó. Mueve el importe al tramo que se ejecutó, o ajústalo a lo que corresponda cobrar.`,
      });
  };

  const juzgaCosto = soloJuzgar !== "precio";
  const juzgaPrecio = soloJuzgar !== "costo";

  /**
   * EL DÍA ENTERO SE CAYÓ Y NADIE ACORDÓ PAGARLO: no falta ningún importe.
   *
   * Sin esto, un día cancelado disparaba "Ni este tramo ni el retorno tienen costo: el
   * día entero no se podrá liquidar al cierre" — cierto y a la vez inútil, porque es
   * exactamente lo que tiene que pasar. Es el mismo rojo falso que ya se corrigió para el
   * retorno en S/ 0.00: uno que no se puede arreglar enseña a ignorar los de al lado, y
   * el de al lado es el que avisa de que el día se está cobrando DOS VECES.
   */
  const diaCaido = seCayo(patch.estado) && (!hermano || seCayo(hermano.estado));
  const conAcuerdo = patch.falso_flete === true || hermano?.falso_flete === true;
  if (diaCaido && !conAcuerdo) {
    avisos.push({
      nivel: "info",
      texto: juzgaPrecio && !juzgaCosto
        ? "Servicio cancelado: no se le cobra al cliente. El importe que tenga cargado no entra a la liquidación."
        : "Servicio cancelado: no se paga ni se cobra. Si el proveedor ya había salido y hay acuerdo por el avance, márcalo como falso flete.",
    });
    return avisos;
  }

  if (esTercero && juzgaCosto) {
    if (hermano) importeDelDia(costo, costoHermano, "costo", "S/");
    else if (costo <= 0)
      avisos.push({
        nivel: "alerta",
        texto: "Servicio tercerizado sin costo pactado. Si se queda así, Finanzas no podrá liquidarlo al cierre.",
      });
  }

  // Simétrico para la venta: un servicio sin precio no se puede facturar, y hasta ahora
  // eso solo se descubría al cerrar el mes, cuando la ruta entera no salía en el formato.
  if (juzgaPrecio) {
    if (hermano) importeDelDia(precio, precioHermano, "precio", "S/");
    else if (precio <= 0)
      avisos.push({
        nivel: "alerta",
        texto: "Servicio sin precio de venta. Si se queda así, no entrará a la liquidación del cliente.",
      });
  }

  const costoAntes = Number(anterior?.costo_proveedor ?? 0);
  if (juzgaCosto && costoAntes > 0 && costo > 0 && costo !== costoAntes && !patch.cambio_motivo)
    avisos.push({
      nivel: "info",
      texto: "Cambió el costo pactado. Elige el motivo para que quede sustentado.",
    });

  // Acá vivía "Subió el precio de venta: se generará un enlace de conformidad para que
  // el cliente lo acepte". Se quitó con el enlace que anunciaba (fase 6, ver
  // supabase/pacto-06-sin-conformidad-de-cambio.sql): la firma del cliente se pide UNA
  // vez por periodo, en la liquidación del cierre, y no servicio por servicio.
  //
  // No se reemplaza por otro aviso. Subir el precio ya pide su motivo en la misma
  // pantalla y queda en el acta de venta; un `info` que solo dijera "esto quedó
  // registrado" es ruido, y el ruido en este panel se paga caro: es el mismo sitio
  // donde sale el aviso de que el día se está cobrando DOS VECES.

  return avisos;
}

/** Margen en vivo del formulario, ya normalizado por afectación. */
export function margenEnVivo(
  precioCliente: number | string,
  costoProveedor: number | string,
  opts: {
    ventaAfectacion?: string | null;
    compraAfectacion?: string | null;
    emiteFactura?: boolean;
    igvPct?: number;
    base?: "neto" | "bruto";
  } = {}
) {
  return margenServicio(Number(precioCliente || 0), Number(costoProveedor || 0), opts);
}

/** El último costo realmente pactado con ese proveedor. El tarifario de compra ya existe. */
export async function sugerirCosto(
  sb: any,
  empresaId: number | null | undefined,
  ruta?: string | null,
  vehiculoTerceroId?: number | null
): Promise<{ costo: number; base: string; dias: number; os: string } | null> {
  if (!empresaId) return null;
  const { data, error } = await sb.rpc("fn_costo_sugerido", {
    p_empresa: Number(empresaId),
    p_ruta: ruta || null,
    p_vehiculo_tercero: vehiculoTerceroId ? Number(vehiculoTerceroId) : null,
  });
  if (error) return null;   // sin supabase/pacto-01 corrido, simplemente no se sugiere
  const fila = Array.isArray(data) ? data[0] : data;
  if (!fila || fila.costo == null) return null;
  return { costo: Number(fila.costo), base: String(fila.base ?? ""), dias: Number(fila.dias ?? 0), os: String(fila.os ?? "") };
}

/**
 * Columnas de `reservas` que solo existen con una migración ACCESORIA corrida, con el
 * archivo que las crea y el nombre de lo que se pierde al soltarlas.
 *
 * PostgREST rechaza el UPDATE ENTERO por una sola columna desconocida. Sin esta red, a
 * un ERP al que le falte un SQL accesorio no se le podría ni reprogramar un bus: el
 * cambio de unidad de las 5 a.m. moriría por un dato del formato de liquidación.
 *
 * Se suelta SOLO la columna que el error nombra, y se dice cuál. El mensaje fijo de
 * antes acusaba siempre a las dos migraciones del Pacto, aunque la que faltara fuera
 * otra — y `sinColumnasPacto` solo quitaba esas cuatro, así que cualquier OTRA columna
 * opcional en el patch reventaba el guardado entero, fila por fila, sin arreglo posible
 * desde la pantalla.
 */
const COLUMNAS_OPCIONALES: Record<string, { sql: string; que: string }> = {
  cambio_motivo:        { sql: "supabase/pacto-02-acta.sql",       que: "el motivo del cambio" },
  cambio_nota:          { sql: "supabase/pacto-02-acta.sql",       que: "la nota del cambio" },
  compra_afectacion:    { sql: "supabase/pacto-00-tributario.sql", que: "la afectación de compra" },
  venta_afectacion:     { sql: "supabase/pacto-00-tributario.sql", que: "la afectación de venta" },
  capacidad_contratada: {
    sql: "supabase/liquidaciones-03-ruta-contratada.sql",
    que: "los PAX contratados",
  },
  falso_flete: {
    sql: "supabase/reservas-05-falso-flete.sql",
    que: "el acuerdo de falso flete (el servicio cancelado se seguirá tratando como S/ 0.00)",
  },
  falso_flete_motivo: {
    sql: "supabase/reservas-05-falso-flete.sql",
    que: "el motivo del falso flete",
  },
};

/**
 * La columna opcional que el error nombra Y que además está en el payload. Las dos
 * condiciones importan: soltar una columna que el error no nombra es tirar el dato del
 * operador por una causa que no era esa.
 */
const columnaCaida = (msg: string, payload: Record<string, any>): string | null => {
  const enPayload = Object.keys(COLUMNAS_OPCIONALES).filter((c) => c in payload);
  const nombrada = enPayload.find((c) => new RegExp(`\\b${c}\\b`, "i").test(msg));
  if (nombrada) return nombrada;
  // PostgREST casi siempre nombra la columna. Cuando no, el mensaje genérico basta para
  // soltar las del Pacto, que es exactamente como se comportaba antes.
  if (/column .* does not exist|schema cache/i.test(msg))
    return enPayload.find((c) => (COLUMNAS_PACTO as readonly string[]).includes(c)) ?? null;
  return null;
};

/** "a, b y c" — el aviso nombra lo que se perdió, no una lista de columnas SQL. */
const enumerar = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ni ${xs[xs.length - 1]}`;

/**
 * Escribe un patch sobre N reservas. ES LA ÚNICA FUNCIÓN QUE DEBE USARSE para guardar
 * cambios de asignación o de dinero desde Programación.
 *
 * Estrategia: un solo UPDATE por lote (rápido, que es como funciona hoy) y, si falla,
 * fila por fila para poder decir CUÁL falló y por qué. Antes, un lote de 50 que
 * reventaba no dejaba rastro de cuál era el problema.
 */
export async function guardarReservas(
  sb: any,
  ids: number[],
  patch: Record<string, any>,
  cambio?: CambioServicio
): Promise<ResultadoGuardado> {
  if (!ids.length) return { ok: true, guardados: [], rechazos: [] };

  // Copia propia: las columnas que la base no tenga se van soltando de acá.
  const payload: Record<string, any> = { ...patch };
  if (cambio?.motivo) payload.cambio_motivo = cambio.motivo;
  if (cambio?.nota) payload.cambio_nota = cambio.nota;

  const guardados: number[] = [];
  const rechazos: { id: number; motivo: string }[] = [];
  let aviso: string | undefined;
  /** Columnas opcionales que hubo que soltar por no existir todavía en la base. */
  const caidas: string[] = [];

  const escribir = async (lote: number[]): Promise<string | null> => {
    // Todo el patch se cayó por columnas inexistentes: no hay nada que escribir, y un
    // update vacío es un 400 que se leería como "no se pudo guardar el servicio".
    if (Object.keys(payload).length === 0) return null;
    const { error } = await sb.from("reservas").update(payload).in("id", lote);
    return error ? String(error.message ?? error) : null;
  };

  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    let err = await escribir(lote);

    // Una migración accesoria no corrió: se guarda lo demás y se DICE qué se perdió.
    // Una por vuelta, porque el error nombra una sola.
    for (let intento = 0; err && intento < Object.keys(COLUMNAS_OPCIONALES).length; intento++) {
      const col = columnaCaida(err, payload);
      if (!col) break;
      delete payload[col];
      if (!caidas.includes(col)) caidas.push(col);
      err = await escribir(lote);
    }

    // El patch se quedó SIN columnas: no se escribió nada. Contarlo como guardado hacía
    // que la pantalla anunciara una escritura que no ocurrió ("15 PAX escritos en 26
    // servicio(s)") y el desmentido viajaba en `aviso`, al final de la misma frase.
    if (Object.keys(payload).length === 0) continue;

    if (!err) { guardados.push(...lote); continue; }

    // El lote falló: fila por fila, para poder nombrar al culpable en vez de decir
    // "error al actualizar 1 lote" y dejar al operador adivinando entre 50 servicios.
    for (const id of lote) {
      const { error } = await sb.from("reservas").update(payload).eq("id", id);
      if (error) rechazos.push({ id, motivo: String(error.message ?? error) });
      else guardados.push(id);
    }
  }

  if (caidas.length) {
    const sqls = [...new Set(caidas.map((c) => COLUMNAS_OPCIONALES[c].sql))];
    aviso = `Se guardó el cambio, pero no ${enumerar(caidas.map((c) => COLUMNAS_OPCIONALES[c].que))}: `
          + `falta${sqls.length > 1 ? "n" : ""} correr ${sqls.join(" y ")}.`;
  }

  return { ok: rechazos.length === 0, guardados, rechazos, aviso };
}

/** Resumen legible de un resultado, para el alert o el toast. */
export function describirResultado(r: ResultadoGuardado): string {
  if (r.ok && !r.aviso) return `${r.guardados.length} servicio(s) actualizado(s).`;
  const partes: string[] = [`${r.guardados.length} servicio(s) actualizado(s).`];
  if (r.rechazos.length) {
    const muestra = r.rechazos.slice(0, 3).map((x) => `#${x.id}: ${x.motivo}`).join("\n");
    partes.push(`\n${r.rechazos.length} rechazado(s):\n${muestra}`);
    if (r.rechazos.length > 3) partes.push(`\n…y ${r.rechazos.length - 3} más.`);
  }
  if (r.aviso) partes.push(`\n${r.aviso}`);
  return partes.join("");
}

export type { CodigoAfectacion };
