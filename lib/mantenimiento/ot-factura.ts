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
  totalDeOT, planDeSincronizacion, llaveFiscal, aCentimos,
  type ItemCosto, type PlanSincro,
} from "./costo-ot";

const SQL_COSTO = "supabase/mantenimiento-05-costo-factura-cxp.sql";

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
  ot: OTParaCosto, items: ItemCosto[], totalTecleado: number | null
): Promise<Resultado> {
  const t = totalDeOT(items, totalTecleado);

  const { error } = await supabase.from("ordenes_trabajo")
    .update({ costo_total: t.total }).eq("id", ot.id);
  if (error) return { ok: false, error: error.message };

  const sincro = await sincronizarLibro({ ...ot, costo_total: t.total }, t.total);
  return { ...sincro, plan: sincro.plan };
}

/**
 * Reescribe la fila de `mantenimiento` de esta OT para que diga lo mismo que la orden.
 *
 * Se llama al guardar el costo, al enlazar una factura y al cerrar. Es idempotente: si la fila ya
 * coincide, `planDeSincronizacion` devuelve `sin_cambio` y no se escribe nada.
 */
export async function sincronizarLibro(ot: OTParaCosto, total: number): Promise<Resultado> {
  let fila: { costo: number | null; kilometraje: number | null; documento_compra_id: number | null } | null = null;

  if (ot.mantenimiento_id) {
    const { data, error } = await supabase.from("mantenimiento")
      .select("costo, kilometraje, documento_compra_id").eq("id", ot.mantenimiento_id).maybeSingle();
    // Sin la columna de la factura la fila se lee igual: el enlace es un extra, el costo no.
    if (error && faltaColumna(error.message, "documento_compra_id")) {
      const r2 = await supabase.from("mantenimiento")
        .select("costo, kilometraje").eq("id", ot.mantenimiento_id).maybeSingle();
      fila = r2.data ? { ...(r2.data as any), documento_compra_id: null } : null;
    } else {
      fila = (data as any) ?? null;
    }
  }

  const plan = planDeSincronizacion(
    { estado: ot.estado, mantenimiento_id: ot.mantenimiento_id, km_cierre: ot.km_cierre, documento_compra_id: ot.documento_compra_id },
    total, fila
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
    if (faltaColumna(error.message, "documento_compra_id")) {
      const { documento_compra_id: _omitido, ...resto } = plan.patch;
      if (Object.keys(resto).length) {
        const r2 = await supabase.from("mantenimiento").update(resto).eq("id", ot.mantenimiento_id);
        if (r2.error) return { ok: false, error: r2.error.message, plan };
      }
      return { ok: true, plan, aviso: `El costo se guardó. El enlace con la factura no: falta correr ${SQL_COSTO}.` };
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
  ot: OTParaCosto, f: DatosFactura
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

  // (3) Enlazar la OT y bajar el enlace al libro.
  const { error: eOt } = await supabase.from("ordenes_trabajo")
    .update({ documento_compra_id: docId }).eq("id", ot.id);
  if (eOt) {
    if (faltaColumna(eOt.message, "documento_compra_id")) {
      return { ok: true, documento_compra_id: docId, accion,
        aviso: `La factura quedó registrada en Cuentas por Pagar, pero no se pudo amarrar a esta orden: falta correr ${SQL_COSTO}.` };
    }
    return { ok: false, error: eOt.message };
  }

  const total = Number(ot.costo_total ?? 0);
  const sincro = await sincronizarLibro({ ...ot, documento_compra_id: docId }, total);
  return { ok: true, documento_compra_id: docId, accion, aviso: sincro.aviso, plan: sincro.plan };
}

/** Enlace firmado para ver una factura del bucket privado. Nunca `getPublicUrl`. */
export async function urlFactura(ruta: string | null | undefined): Promise<string | null> {
  if (!ruta) return null;
  if (/^https?:\/\//i.test(ruta)) return ruta;      // filas viejas que guardaron una URL
  const { data } = await supabase.storage.from("comprobantes").createSignedUrl(ruta, 3600);
  return data?.signedUrl ?? null;
}
