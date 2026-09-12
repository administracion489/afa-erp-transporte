// lib/mantenimiento/ot-factura.ts — La ÚNICA puerta por la que el costo de una orden de trabajo
// llega al libro de mantenimiento, y por la que la factura del taller entra como Cuenta por Pagar.
//
// El motor que decide qué escribir es `lib/mantenimiento/costo-ot.ts` (PURO). Aquí solo se lee la
// base, se llama al motor y se escribe lo que diga — el mismo reparto que `rendimiento-flota` con
// `rendimiento-tipo`, o `retrasos-datos` con `retrasos`.
//
// TODO LO QUE TOCA LAS COLUMNAS NUEVAS REINTENTA SIN ELLAS. `mantenimiento-05-costo-factura-cxp.sql`
// es una migración accesoria y el deploy NO la corre: mientras nadie la ejecute, la pantalla tiene
// que seguir abriendo órdenes de trabajo. Lo que NO se hace es callarlo — el aviso nombra la
// migración, porque un costo que parece guardarse y no se guarda es peor que un error.
import { supabase } from "@/lib/supabase";
import {
  planDeSincronizacion, llaveFiscal, aCentimos,
  type ItemCosto, type PlanSincro,
} from "./costo-ot";
import {
  repartoDeOT, facturasDeOT, tarifaHoraMecanico,
  type LineaCosto, type RepartoOT, type FacturasOT, type InsumosManoObra, type TarifaHora,
} from "./lineas-costo";

const SQL_COSTO = "supabase/mantenimiento-05-costo-factura-cxp.sql";
const SQL_LINEAS = "supabase/mantenimiento-06-lineas-de-costo.sql";

/** ¿El error viene de una columna de esta migración que no se corrió? */
function faltaColumna(msg: string | null | undefined, col: string): boolean {
  const m = String(msg || "").toLowerCase();
  return m.includes(col.toLowerCase()) && (m.includes("does not exist") || m.includes("schema cache"));
}

export type Resultado = { ok: boolean; error?: string; aviso?: string; plan?: PlanSincro };

// ── El costo de un ítem ──────────────────────────────────────────────────────

/**
 * Escribe el costo de un ítem del checklist. Vacío → `null`, que NO es 0: el total de la orden se
 * deriva de los ítems solo cuando alguien tecleó alguno, y un 0 tecleado («esta revisión no costó
 * nada») sí cuenta como tecleado.
 */
export async function guardarCostoItem(itemId: number, costo: number | null): Promise<Resultado> {
  const { error } = await supabase.from("checklist_ot")
    .update({ costo: costo === null ? null : aCentimos(costo) }).eq("id", itemId);
  if (error) {
    if (faltaColumna(error.message, "costo")) {
      return { ok: false, error: `Falta correr ${SQL_COSTO} en Supabase: la columna de costo por ítem todavía no existe, así que este número no se guardó.` };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

// ── El costo de la orden, y su viaje al libro ────────────────────────────────

export type OTParaCosto = {
  id: number;
  estado: string | null;
  km_cierre: number | null;
  costo_total: number | null;
  mantenimiento_id: number | null;
  documento_compra_id: number | null;
};

// ── Las líneas de costo ──────────────────────────────────────────────────────

const COLS_LINEA = "id,orden_trabajo_id,tipo,origen,concepto,monto,horas,tarifa_hora,tarifa_fuente,proveedor_id,documento_compra_id,checklist_ot_id,observacion";

export type LineaGuardada = LineaCosto & { orden_trabajo_id: number; tarifa_fuente?: string | null; observacion?: string | null };

/**
 * Las líneas de una orden. **Sin la migración devuelve `[]`, no lanza**: `mantenimiento-06` es
 * accesoria y el deploy no la corre, así que hasta que alguien la ejecute la pantalla tiene que
 * seguir abriendo órdenes — con el comportamiento anterior, que es exactamente el que da un
 * reparto sin líneas.
 */
export async function cargarLineas(otIds: number[]): Promise<LineaGuardada[]> {
  if (!otIds.length) return [];
  const { data, error } = await supabase.from("ot_costo_linea")
    .select(COLS_LINEA).in("orden_trabajo_id", otIds).order("id", { ascending: true });
  if (error) return [];
  return ((data as any[]) ?? []).map(r => ({
    id: r.id, orden_trabajo_id: Number(r.orden_trabajo_id),
    concepto: String(r.concepto ?? ""), tipo: r.tipo, origen: r.origen,
    monto: Number(r.monto || 0),
    horas: r.horas != null ? Number(r.horas) : null,
    tarifa_hora: r.tarifa_hora != null ? Number(r.tarifa_hora) : null,
    tarifa_fuente: r.tarifa_fuente ?? null,
    proveedor_id: r.proveedor_id != null ? Number(r.proveedor_id) : null,
    documento_compra_id: r.documento_compra_id != null ? Number(r.documento_compra_id) : null,
    checklist_ot_id: r.checklist_ot_id != null ? Number(r.checklist_ot_id) : null,
    observacion: r.observacion ?? null,
  }));
}

export type DatosLinea = {
  concepto: string;
  tipo: LineaCosto["tipo"];
  origen: LineaCosto["origen"];
  monto: number;
  horas?: number | null;
  tarifa_hora?: number | null;
  tarifa_fuente?: string | null;
  proveedor_id?: number | null;
  observacion?: string | null;
};

export async function guardarLinea(
  otId: number, datos: DatosLinea, lineaId?: number | string | null
): Promise<Resultado & { id?: number }> {
  const fila = {
    orden_trabajo_id: otId,
    concepto: datos.concepto.trim() || null,
    tipo: datos.tipo, origen: datos.origen,
    monto: aCentimos(Number(datos.monto) || 0),
    horas: datos.horas ?? null,
    tarifa_hora: datos.tarifa_hora ?? null,
    tarifa_fuente: datos.tarifa_fuente ?? null,
    proveedor_id: datos.proveedor_id ?? null,
    observacion: datos.observacion?.trim() || null,
  };
  const q = lineaId
    ? supabase.from("ot_costo_linea").update(fila).eq("id", lineaId).select("id").single()
    : supabase.from("ot_costo_linea").insert(fila).select("id").single();
  const { data, error } = await q;
  if (error) {
    if (/ot_costo_linea/i.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      return { ok: false, error: `Falta correr ${SQL_LINEAS} en Supabase: la tabla de líneas de costo todavía no existe, así que esta línea no se guardó.` };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, id: Number((data as any).id) };
}

export async function borrarLinea(lineaId: number | string): Promise<Resultado> {
  const { error } = await supabase.from("ot_costo_linea").delete().eq("id", lineaId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * LOS INSUMOS PARA VALORIZAR UNA HORA DE CASA, de `v_taller_mano_obra`.
 *
 * La vista publica el sueldo del mecánico y los factores del régimen y **no calcula nada** — la
 * fórmula del costo empresa vive una sola vez, en `lib/costeo-conductor.ts`. Sin la migración
 * devuelve los insumos vacíos, y entonces `tarifaHoraMecanico` dice `sin_tarifa` en vez de
 * inventar un S/hora.
 */
export async function cargarInsumosManoObra(): Promise<InsumosManoObra> {
  const vacio: InsumosManoObra = { tarifa_hora: null, mecanico: null, regimen: null, horas_mes: null };
  const { data, error } = await supabase.from("v_taller_mano_obra").select("*").maybeSingle();
  if (error || !data) return vacio;
  const p: any = data;
  return {
    tarifa_hora: p.tarifa_hora_mecanico != null ? Number(p.tarifa_hora_mecanico) : null,
    horas_mes: p.horas_mes != null ? Number(p.horas_mes) : null,
    mecanico: {
      // Un mecánico de planilla: no hay honorario por día que valga aquí.
      tipo_contrato: "planilla",
      sueldo_basico: p.mecanico_sueldo_basico != null ? Number(p.mecanico_sueldo_basico) : null,
      tiene_asignacion: !!p.tiene_asignacion,
      rmv: Number(p.rmv ?? 0),
      asignacion_familiar_pct: Number(p.asignacion_familiar_pct ?? 0),
      sctr_mensual: Number(p.sctr_mensual ?? 0),
    },
    regimen: p.regimen ? {
      regimen: p.regimen, nombre: String(p.regimen_nombre ?? p.regimen),
      essalud_pct: Number(p.essalud_pct ?? 0), usa_sis: !!p.usa_sis,
      sis_aporte_mensual: Number(p.sis_aporte_mensual ?? 0),
      gratificaciones_sueldos: Number(p.gratificaciones_sueldos ?? 0),
      bonif_extraordinaria_pct: Number(p.bonif_extraordinaria_pct ?? 0),
      cts_sueldos_anio: Number(p.cts_sueldos_anio ?? 0),
      vacaciones_dias: Number(p.vacaciones_dias ?? 30),
    } : null,
  };
}

export async function tarifaDeTaller(): Promise<TarifaHora> {
  return tarifaHoraMecanico(await cargarInsumosManoObra());
}

/**
 * EL REPARTO DE UNA ORDEN, RESUELTO EN UN SOLO SITIO.
 *
 * Las líneas se leen aquí y no se reciben: si cada pantalla las trajera por su cuenta, dos
 * caminos derivarían el mismo importe y el día que uno se quedara atrás el egreso y el S/km
 * dirían cosas distintas. Es la misma razón por la que `guardarCostoOT` no recibe el total.
 */
export async function repartoDeLaOT(
  ot: OTParaCosto, items: ItemCosto[], totalTecleado: number | null,
  lineasYaCargadas?: LineaCosto[]
): Promise<{ reparto: RepartoOT; lineas: LineaCosto[]; facturas: FacturasOT }> {
  const lineas = lineasYaCargadas ?? await cargarLineas([ot.id]);
  const reparto = repartoDeOT(lineas, items, totalTecleado);
  const facturas = facturasDeOT(ot.documento_compra_id, lineas);
  return { reparto, lineas, facturas };
}

/**
 * GUARDA EL COSTO DE LA ORDEN Y LO PROPAGA A LA FILA QUE CUENTA EL DINERO.
 *
 * Los dos pasos son uno solo a propósito. Antes el segundo ocurría únicamente al cerrar, así que
 * una corrección posterior se quedaba en `ordenes_trabajo.costo_total`, que no lo lee nadie más:
 * ni `v_egresos`, ni el margen del servicio, ni el S/km medido de la categoría.
 *
 * `total` NO se recibe: se DERIVA de los ítems y del tecleado con el mismo `totalDeOT` que pinta
 * la pantalla. Recibirlo dejaría que la pantalla mandara un número distinto del que enseña, que
 * es la forma más silenciosa de escribir un importe equivocado.
 */
export async function guardarCostoOT(
  ot: OTParaCosto, items: ItemCosto[], totalTecleado: number | null, lineas?: LineaCosto[]
): Promise<Resultado> {
  const { reparto, facturas } = await repartoDeLaOT(ot, items, totalTecleado, lineas);

  // `ordenes_trabajo.costo_total` guarda el COSTO ENTERO de la orden —lo que costó mantener esa
  // unidad—, que es lo que la pantalla enseña. El reparto entre desembolso e imputado se hace al
  // bajar al libro: ahí es donde la diferencia significa algo (una columna la lee `v_egresos` y
  // la otra no).
  const { error } = await supabase.from("ordenes_trabajo")
    .update({ costo_total: reparto.total }).eq("id", ot.id);
  if (error) return { ok: false, error: error.message };

  return sincronizarLibro({ ...ot, costo_total: reparto.total }, reparto, facturas);
}

/**
 * Reescribe la fila de `mantenimiento` de esta OT para que diga lo mismo que la orden.
 *
 * Se llama al guardar el costo, al enlazar una factura y al cerrar. Es idempotente: si la fila ya
 * coincide, `planDeSincronizacion` devuelve `sin_cambio` y no se escribe nada.
 */
export async function sincronizarLibro(
  ot: OTParaCosto, reparto: RepartoOT, facturas: FacturasOT
): Promise<Resultado> {
  let fila:
    | { costo: number | null; kilometraje: number | null; documento_compra_id: number | null; costo_imputado?: number | null }
    | null = null;

  if (ot.mantenimiento_id) {
    const { data, error } = await supabase.from("mantenimiento")
      .select("costo, costo_imputado, kilometraje, documento_compra_id").eq("id", ot.mantenimiento_id).maybeSingle();
    // Sin las columnas accesorias la fila se lee igual: el enlace y el costo de casa son extras,
    // el desembolso no. Se degrada de la más nueva a la más vieja.
    if (error) {
      const r2 = await supabase.from("mantenimiento")
        .select("costo, kilometraje, documento_compra_id").eq("id", ot.mantenimiento_id).maybeSingle();
      if (r2.error) {
        const r3 = await supabase.from("mantenimiento")
          .select("costo, kilometraje").eq("id", ot.mantenimiento_id).maybeSingle();
        fila = r3.data ? { ...(r3.data as any), documento_compra_id: null } : null;
      } else {
        fila = (r2.data as any) ?? null;
      }
    } else {
      fila = (data as any) ?? null;
    }
  }

  const plan = planDeSincronizacion(
    { estado: ot.estado, mantenimiento_id: ot.mantenimiento_id, km_cierre: ot.km_cierre,
      // Con dos comprobantes ninguno representa a la orden: la columna del libro es escalar.
      documento_compra_id: facturas.principal },
    reparto.desembolsado, fila, reparto.imputado
  );
  if (plan.codigo !== "actualiza") {
    return {
      ok: true, plan,
      aviso: plan.codigo === "sin_ancla"
        ? `El costo quedó guardado en la orden, pero NO llegó al libro de mantenimiento: ${plan.detalle}`
        : undefined,
    };
  }

  const { error } = await supabase.from("mantenimiento").update(plan.patch).eq("id", ot.mantenimiento_id);
  if (error) {
    // Se suelta la columna que el error NOMBRA, no un juego fijo (COLUMNAS_OPCIONALES de
    // lib/reservas-pacto.ts). Y se dice qué se perdió: un costo de casa que parece guardarse y no
    // llega al S/km medido es peor que un error.
    const opcionales: { col: "costo_imputado" | "documento_compra_id"; sql: string; pierde: string }[] = [
      { col: "costo_imputado", sql: SQL_LINEAS, pierde: "el costo de casa (mano de obra propia) no llegó al libro, así que no cuenta para el S/km medido" },
      { col: "documento_compra_id", sql: SQL_COSTO, pierde: "el enlace con la factura no se guardó" },
    ];
    const sueltas = opcionales.filter(s => faltaColumna(error.message, s.col) && plan.patch[s.col] !== undefined);

    if (sueltas.length) {
      const resto = { ...plan.patch };
      for (const s of sueltas) delete resto[s.col];
      if (Object.keys(resto).length) {
        const r2 = await supabase.from("mantenimiento").update(resto).eq("id", ot.mantenimiento_id);
        if (r2.error) return { ok: false, error: r2.error.message, plan };
      }
      return { ok: true, plan,
        aviso: `El desembolso se guardó. Falta correr ${sueltas.map(s => s.sql).join(" y ")}: ${sueltas.map(s => s.pierde).join("; ")}.` };
    }
    return { ok: false, error: error.message, plan };
  }
  return { ok: true, plan };
}

// ── La factura del taller ────────────────────────────────────────────────────

export type DatosFactura = {
  ruc_emisor: string;
  razon_social: string;
  tipo_comprobante: string;      // factura | boleta | recibo_honorarios
  serie: string;
  numero: string;
  fecha_emision: string;         // YYYY-MM-DD
  total: number;
  igv?: number | null;
  proveedor_id?: number | null;  // el taller del directorio, si lo tiene
  vehiculo_placa?: string | null;
  archivo?: File | null;
  /**
   * La línea de costo que esta factura respalda. Con dos proveedores en la misma orden —el
   * repuesto en un sitio, la mano de obra en otro— el comprobante es de la LÍNEA, no de la
   * orden: colgarlo de la orden obligaría a elegir cuál de los dos es «la» factura.
   */
  linea_id?: number | string | null;
};

export type ResultadoFactura = Resultado & {
  documento_compra_id?: number;
  /** `creado` = nació aquí · `existente` = ya estaba registrada y solo se enlazó. */
  accion?: "creado" | "existente";
};

/**
 * LA FACTURA DEL TALLER ENTRA COMO COMPROBANTE DE COMPRA, NO COMO GASTO.
 *
 * Pedir que «se suba a gastos» habría contado el mismo sol dos veces: `v_egresos` ya suma
 * `mantenimiento.costo`. Lo que faltaba es el lado FISCAL — el comprobante que se aprueba, entra
 * a un lote de pago, se concilia con el banco y sustenta el crédito fiscal del IGV. Y no duplica:
 * el propio `v_egresos` declara que «documentos_compra se suma aparte».
 *
 * SE BUSCA ANTES DE CREAR, con la MISMA llave fiscal que usa `conciliarFactura` para las facturas
 * que llegan por correo (`lib/contabilidad/factura-ia.ts`). Sin eso, la factura del taller
 * entraría dos veces —una por Contabilidad y otra desde la OT— y el índice único
 * `(ruc, tipo, serie, numero)` haría reventar la segunda con un error que no dice nada.
 */
export async function registrarFacturaTaller(
  ot: OTParaCosto, f: DatosFactura, items: ItemCosto[] = []
): Promise<ResultadoFactura> {
  const llave = llaveFiscal(f);
  if (!llave) return { ok: false, error: "Faltan el RUC, la serie o el número: sin eso no se puede saber si la factura ya estaba registrada." };

  // (1) ¿Ya existe? Enlazar, jamás insertar de nuevo.
  const { data: prev } = await supabase.from("documentos_compra")
    .select("id")
    .eq("ruc_emisor", f.ruc_emisor.replace(/\D/g, ""))
    .eq("tipo_comprobante", f.tipo_comprobante || "factura")
    .eq("serie", f.serie.trim().toUpperCase())
    .eq("numero", f.numero.trim())
    .limit(1);

  let docId = ((prev as any[]) ?? [])[0]?.id ? Number(((prev as any[]) ?? [])[0].id) : null;
  let accion: "creado" | "existente" = docId ? "existente" : "creado";

  // (2) El archivo va al bucket PRIVADO y se guarda la RUTA, nunca una URL pública: una factura
  //     de taller trae la placa, el RUC de AFA y el domicilio fiscal.
  let ruta: string | null = null;
  if (f.archivo) {
    const ext = (f.archivo.name.split(".").pop() || "pdf").toLowerCase().slice(0, 5);
    ruta = `mantenimiento/ot-${ot.id}/${crypto.randomUUID()}.${ext}`;
    const { error: eUp } = await supabase.storage.from("comprobantes")
      .upload(ruta, f.archivo, { contentType: f.archivo.type || "application/pdf", upsert: false });
    if (eUp) return { ok: false, error: `No se pudo subir la factura: ${eUp.message}` };
  }

  if (!docId) {
    const fila: Record<string, unknown> = {
      ruc_emisor: f.ruc_emisor.replace(/\D/g, ""),
      razon_social: f.razon_social.trim() || null,
      tipo_comprobante: f.tipo_comprobante || "factura",
      serie: f.serie.trim().toUpperCase(),
      numero: f.numero.trim(),
      fecha_emision: f.fecha_emision,
      moneda: "PEN",
      total: aCentimos(f.total),
      igv: aCentimos(Number(f.igv ?? 0)),
      subtotal: aCentimos(aCentimos(f.total) - aCentimos(Number(f.igv ?? 0))),
      categoria: "mantenimiento",
      estado_conciliacion: "pendiente",
      origen: "orden_trabajo",
      proveedor_id: f.proveedor_id ?? null,
      vehiculo_placa: f.vehiculo_placa ?? null,
      voucher_url: ruta,
    };
    const { data, error } = await supabase.from("documentos_compra").insert(fila).select("id").single();
    if (error) {
      if (ruta) { try { await supabase.storage.from("comprobantes").remove([ruta]); } catch { /* el archivo huérfano no bloquea */ } }
      return { ok: false, error: `No se pudo registrar la factura: ${error.message}` };
    }
    docId = Number((data as any).id);
  } else if (ruta) {
    // Ya existía y ahora además tiene su imagen: se completa sin tocar los importes, que son de
    // quien la registró primero.
    await supabase.from("documentos_compra").update({ voucher_url: ruta }).eq("id", docId);
  }

  // (3) Enlazar donde corresponda: a la LÍNEA cuando la factura respalda un renglón concreto
  //     (dos proveedores en la misma orden), a la orden cuando es la única.
  if (f.linea_id) {
    const { error: eLin } = await supabase.from("ot_costo_linea")
      .update({ documento_compra_id: docId }).eq("id", f.linea_id);
    if (eLin) {
      return { ok: true, documento_compra_id: docId, accion,
        aviso: `La factura quedó registrada en Cuentas por Pagar, pero no se pudo amarrar a esa línea: ${eLin.message}` };
    }
  } else {
    const { error: eOt } = await supabase.from("ordenes_trabajo")
      .update({ documento_compra_id: docId }).eq("id", ot.id);
    if (eOt) {
      if (faltaColumna(eOt.message, "documento_compra_id")) {
        return { ok: true, documento_compra_id: docId, accion,
          aviso: `La factura quedó registrada en Cuentas por Pagar, pero no se pudo amarrar a esta orden: falta correr ${SQL_COSTO}.` };
      }
      return { ok: false, error: eOt.message };
    }
  }

  // El enlace que baja al libro se REDERIVA: con la factura nueva pueden ser ya dos, y entonces
  // ninguna representa a la orden.
  const otActualizada = { ...ot, documento_compra_id: f.linea_id ? ot.documento_compra_id : docId };
  const lineas = await cargarLineas([ot.id]);
  const reparto = repartoDeOT(lineas, items, ot.costo_total ?? null);
  const facturas = facturasDeOT(otActualizada.documento_compra_id, lineas);
  const sincro = await sincronizarLibro(otActualizada, reparto, facturas);
  return { ok: true, documento_compra_id: docId, accion, aviso: sincro.aviso ?? (facturas.detalle || undefined), plan: sincro.plan };
}

/** Enlace firmado para ver una factura del bucket privado. Nunca `getPublicUrl`. */
export async function urlFactura(ruta: string | null | undefined): Promise<string | null> {
  if (!ruta) return null;
  if (/^https?:\/\//i.test(ruta)) return ruta;      // filas viejas que guardaron una URL
  const { data } = await supabase.storage.from("comprobantes").createSignedUrl(ruta, 3600);
  return data?.signedUrl ?? null;
}
