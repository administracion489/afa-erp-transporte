// ──────────────────────────────────────────────────────────────────────────────
// POST /api/finanzas/importar — Carga masiva de los Google Sheets históricos.
//
// El reparto de trabajo es a propósito:
//   · El NAVEGADOR parsea el archivo (lib/importador/tabular + perfiles-finanzas) y
//     manda las filas ya validadas. Así no hay límite de tamaño de subida ni se
//     bloquea el route con un xlsx de 20 000 filas.
//   · El SERVIDOR resuelve referencias (proveedor por RUC, vehículo por placa,
//     conductor por nombre), deduplica y escribe con service-role.
//
// Cada corrida queda registrada en `importaciones_finanzas` con los ids creados, para
// poder deshacerla si la carga histórica salió mal (DELETE /api/finanzas/importar).
// ──────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { DESTINO_PERFIL } from "@/lib/importador/perfiles-finanzas";
import type { FilaCxP, FilaGastoGeneral, FilaCajaChica, FilaExtracto } from "@/lib/importador/perfiles-finanzas";
import { hashMovimiento } from "@/lib/finanzas/conciliacion";

export const maxDuration = 60;

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/** Tope por corrida. Cargas mayores se parten en varias: el route tiene 60 s. */
const MAX_FILAS = 5000;
/** Tamaño de inserción en bloque (evita URLs y payloads gigantes). */
const LOTE = 200;

type Resumen = {
  perfil: string;
  destino: string;
  leidas: number;
  creadas: number;
  actualizadas: number;
  omitidas: number;
  errores: { fila?: number; motivo: string }[];
  importacion_id?: number;
};

function normaliza(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export async function POST(req: Request) {
  const auth = await verificarUsuarioApi(req, "finanzas");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  // Importar histórico reescribe la contabilidad: solo admin o gerencia.
  if (!["admin", "gerente"].includes(auth.rol)) {
    return NextResponse.json({ error: "Solo un administrador o gerente puede importar." }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  }

  const perfil = String(body?.perfil ?? "");
  const destino = DESTINO_PERFIL[perfil];
  if (!destino) return NextResponse.json({ error: `Perfil desconocido: "${perfil}"` }, { status: 400 });

  const filas: unknown[] = Array.isArray(body?.filas) ? body.filas : [];
  if (!filas.length) return NextResponse.json({ error: "No se recibió ninguna fila." }, { status: 400 });
  if (filas.length > MAX_FILAS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_FILAS} filas por carga (llegaron ${filas.length}). Divide el archivo.` },
      { status: 400 }
    );
  }

  const db = admin();
  const usuario = String(body?.usuario_nombre ?? auth.userId);

  let resumen: Resumen;
  try {
    switch (perfil) {
      case "cxp_oslo":
      case "cxp_tradicional":
        resumen = await importarCxP(db, filas as FilaCxP[], perfil, usuario);
        break;
      case "gastos_generales":
        resumen = await importarGastosGenerales(db, filas as FilaGastoGeneral[], perfil, usuario);
        break;
      case "caja_chica":
        resumen = await importarCajaChica(db, filas as FilaCajaChica[], perfil, usuario, body?.fondo_id ?? null);
        break;
      case "extracto_bcp":
        resumen = await importarExtracto(db, filas as FilaExtracto[], perfil, usuario, body);
        break;
      default:
        return NextResponse.json({ error: `Perfil sin implementación: ${perfil}` }, { status: 400 });
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 500 });
  }

  return NextResponse.json(resumen);
}

// ── Catálogos ─────────────────────────────────────────────────────────────────

/** Resuelve/crea proveedores por RUC (y si no hay RUC, por razón social normalizada). */
async function resolverProveedores(db: any, filas: FilaCxP[], usuario: string) {
  const { data: existentes } = await db
    .from("proveedores")
    .select("id, nombre, razon_social, ruc, cuenta_bancaria, cci, banco, titular_cuenta");

  const porRuc = new Map<string, any>();
  const porNombre = new Map<string, any>();
  for (const p of (existentes as any[]) ?? []) {
    if (p.ruc) porRuc.set(String(p.ruc).replace(/\D/g, ""), p);
    porNombre.set(normaliza(p.razon_social || p.nombre), p);
  }

  const nuevos: any[] = [];
  const vistos = new Set<string>();
  for (const f of filas) {
    const ruc = f.proveedor_ruc ?? "";
    const nombre = f.proveedor_razon_social ?? "";
    if (!nombre) continue;
    const clave = ruc || normaliza(nombre);
    if (vistos.has(clave)) continue;
    if (ruc && porRuc.has(ruc)) continue;
    if (!ruc && porNombre.has(normaliza(nombre))) continue;
    vistos.add(clave);
    nuevos.push({
      nombre: nombre.slice(0, 200),
      razon_social: nombre.slice(0, 200),
      ruc: ruc || null,
      // Los históricos de OSLO son todos transporte tercerizado; el resto entra
      // como "otro" para no falsear el catálogo de tipos.
      tipo: "transporte",
      estado: "activo",
      titular_cuenta: f.titular_cuenta ?? nombre,
      banco: f.banco_destino ?? null,
      cuenta_bancaria: f.cuenta_destino ?? null,
      cci: f.cci_destino ?? null,
      observaciones: `Creado por importación de ${usuario}`,
    });
  }

  if (nuevos.length) {
    for (let i = 0; i < nuevos.length; i += LOTE) {
      const { data } = await db.from("proveedores").insert(nuevos.slice(i, i + LOTE)).select("id, nombre, razon_social, ruc");
      for (const p of (data as any[]) ?? []) {
        if (p.ruc) porRuc.set(String(p.ruc).replace(/\D/g, ""), p);
        porNombre.set(normaliza(p.razon_social || p.nombre), p);
      }
    }
  }

  return (f: FilaCxP): number | null => {
    if (f.proveedor_ruc && porRuc.has(f.proveedor_ruc)) return porRuc.get(f.proveedor_ruc).id;
    const p = porNombre.get(normaliza(f.proveedor_razon_social ?? ""));
    return p?.id ?? null;
  };
}

/** Mapa placa → vehiculo_id (flota propia y de terceros). */
async function mapaPlacas(db: any) {
  const [propios, terceros] = await Promise.all([
    db.from("vehiculos").select("id, placa"),
    db.from("vehiculos_tercero").select("id, placa"),
  ]);
  const m = new Map<string, { id: number; propio: boolean }>();
  for (const v of (propios.data as any[]) ?? []) {
    if (v.placa) m.set(normaliza(v.placa).replace(/[^a-z0-9]/g, ""), { id: v.id, propio: true });
  }
  for (const v of (terceros.data as any[]) ?? []) {
    if (v.placa) {
      const k = normaliza(v.placa).replace(/[^a-z0-9]/g, "");
      if (!m.has(k)) m.set(k, { id: v.id, propio: false });
    }
  }
  return m;
}

// ── Perfil: cuentas por pagar ─────────────────────────────────────────────────

async function importarCxP(db: any, filas: FilaCxP[], perfil: string, usuario: string): Promise<Resumen> {
  const errores: Resumen["errores"] = [];
  const resolverProv = await resolverProveedores(db, filas, usuario);
  const placas = await mapaPlacas(db);

  // Dedupe fiscal: el índice único de documentos_compra es
  // (ruc_emisor, tipo_comprobante, serie, numero). Se consulta lo ya cargado para
  // no depender del error de Postgres, que abortaría el lote entero.
  const rucs = [...new Set(filas.map((f) => f.proveedor_ruc).filter(Boolean))] as string[];
  const yaCargados = new Set<string>();
  for (let i = 0; i < rucs.length; i += 100) {
    const { data } = await db
      .from("documentos_compra")
      .select("ruc_emisor, tipo_comprobante, serie, numero")
      .in("ruc_emisor", rucs.slice(i, i + 100));
    for (const d of (data as any[]) ?? []) {
      yaCargados.add(`${d.ruc_emisor}|${d.tipo_comprobante}|${d.serie}|${d.numero}`);
    }
  }

  const aInsertar: any[] = [];
  const enEsteArchivo = new Set<string>();
  let omitidas = 0;

  filas.forEach((f, i) => {
    const proveedorId = resolverProv(f);
    const clave = f.proveedor_ruc && f.serie && f.numero
      ? `${f.proveedor_ruc}|${f.tipo_comprobante}|${f.serie}|${f.numero}`
      : null;

    if (clave) {
      if (yaCargados.has(clave)) {
        omitidas++;
        errores.push({ fila: i + 2, motivo: `Ya existe la factura ${f.serie}-${f.numero} de ${f.proveedor_razon_social}` });
        return;
      }
      if (enEsteArchivo.has(clave)) {
        omitidas++;
        errores.push({ fila: i + 2, motivo: `Factura ${f.serie}-${f.numero} repetida dentro del archivo` });
        return;
      }
      enEsteArchivo.add(clave);
    }

    const veh = f.vehiculo_placa ? placas.get(normaliza(f.vehiculo_placa).replace(/[^a-z0-9]/g, "")) : undefined;

    aInsertar.push({
      proveedor_id: proveedorId,
      ruc_emisor: f.proveedor_ruc,
      razon_social: f.proveedor_razon_social,
      titular_cuenta: f.titular_cuenta,
      banco_destino: f.banco_destino,
      cuenta_destino: f.cuenta_destino,
      cci_destino: f.cci_destino,
      tipo_comprobante: f.tipo_comprobante,
      serie: f.serie,
      numero: f.numero,
      fecha_emision: f.fecha_emision,
      fecha_vencimiento: f.fecha_vencimiento,
      moneda: f.moneda,
      subtotal: f.subtotal,
      igv: f.igv,
      total: f.total,
      detraccion_pct: f.detraccion_pct,
      detraccion_monto: f.detraccion_monto,
      estado_detraccion: f.estado_detraccion,
      adelanto_1: f.adelanto_1,
      adelanto_2: f.adelanto_2,
      vehiculo_id: veh?.propio ? veh.id : null,
      vehiculo_placa: f.vehiculo_placa,
      codigo_servicio: f.codigo_servicio,
      detalle_servicio: f.detalle_servicio,
      turno: f.turno,
      fecha_servicio: f.fecha_servicio,
      estado_aprobacion: f.estado_aprobacion,
      estado_pago: f.estado_pago,
      nro_operacion_bancaria: f.nro_operacion_bancaria,
      fecha_pago: f.fecha_pago,
      voucher_url: f.voucher_url,
      categoria: f.categoria,
      // `estado_conciliacion` queda 'pendiente': la factura entró por planilla, aún
      // nadie verificó que el servicio facturado se prestó de verdad.
      origen: "importacion",
      observaciones: f.observaciones,
      creado_por: usuario,
    });
  });

  const ids = await insertarEnLotes(db, "documentos_compra", aInsertar, errores);

  const importacionId = await registrarImportacion(db, {
    perfil,
    destino_tabla: "documentos_compra",
    leidas: filas.length,
    creadas: ids.length,
    omitidas,
    errores,
    ids,
    usuario,
  });

  return {
    perfil,
    destino: "documentos_compra",
    leidas: filas.length,
    creadas: ids.length,
    actualizadas: 0,
    omitidas,
    errores,
    importacion_id: importacionId,
  };
}

// ── Perfil: gastos generales / planilla ───────────────────────────────────────

async function importarGastosGenerales(db: any, filas: FilaGastoGeneral[], perfil: string, usuario: string): Promise<Resumen> {
  const errores: Resumen["errores"] = [];
  const aInsertar = filas.map((f) => ({
    categoria: f.categoria,
    beneficiario_nombre: f.beneficiario_nombre,
    documento_identidad: f.documento_identidad,
    concepto: f.concepto,
    descripcion: f.descripcion,
    periodo: f.periodo,
    fecha: f.fecha,
    fecha_vencimiento: f.fecha_vencimiento,
    monto: f.monto,
    moneda: f.moneda,
    banco_destino: f.banco_destino,
    cuenta_destino: f.cuenta_destino,
    cci_destino: f.cci_destino,
    estado_aprobacion: f.estado_aprobacion,
    aprobado_por: f.estado_aprobacion === "aprobado" ? `Importación · ${usuario}` : null,
    fecha_aprobacion: f.estado_aprobacion === "aprobado" ? new Date().toISOString() : null,
    estado_pago: f.estado_pago,
    nro_operacion_bancaria: f.nro_operacion_bancaria,
    fecha_pago: f.fecha_pago,
    comprobante_ref: f.comprobante_ref,
    observaciones: f.observaciones,
    creado_por: usuario,
  }));

  const ids = await insertarEnLotes(db, "gastos_generales", aInsertar, errores);
  const importacionId = await registrarImportacion(db, {
    perfil, destino_tabla: "gastos_generales", leidas: filas.length, creadas: ids.length, omitidas: 0, errores, ids, usuario,
  });

  return { perfil, destino: "gastos_generales", leidas: filas.length, creadas: ids.length, actualizadas: 0, omitidas: 0, errores, importacion_id: importacionId };
}

// ── Perfil: caja chica ────────────────────────────────────────────────────────

/**
 * Los gastos de caja chica cuelgan de una RENDICIÓN. Si el llamador no indica una,
 * se agrupan por responsable y se crea una rendición histórica por persona, ya
 * liquidada: importar un histórico no debe disparar la regla de bloqueo ni dejar a
 * medio mundo con una rendición "abierta" ficticia.
 */
async function importarCajaChica(db: any, filas: FilaCajaChica[], perfil: string, usuario: string, fondoIdFijo: number | null): Promise<Resumen> {
  const errores: Resumen["errores"] = [];
  const placas = await mapaPlacas(db);

  const { data: fondos } = await db.from("caja_chica_fondos").select("id, responsable_nombre, conductor_id, moneda");
  const porResponsable = new Map<string, any>();
  for (const f of (fondos as any[]) ?? []) porResponsable.set(normaliza(f.responsable_nombre), f);

  const { data: conductores } = await db.from("conductores").select("id, nombre");
  const conductorPorNombre = new Map<string, number>();
  for (const c of (conductores as any[]) ?? []) conductorPorNombre.set(normaliza(c.nombre), c.id);

  // Agrupar por responsable.
  const grupos = new Map<string, FilaCajaChica[]>();
  for (const f of filas) {
    const k = normaliza(f.responsable_nombre);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k)!.push(f);
  }

  const idsGastos: number[] = [];
  let creadasRend = 0;

  for (const [clave, grupo] of grupos) {
    let fondo = porResponsable.get(clave);

    // Fondo automático para el responsable que aún no lo tiene.
    if (!fondo && !fondoIdFijo) {
      const nombre = grupo[0].responsable_nombre;
      const conductorId = conductorPorNombre.get(clave) ?? null;
      const { data: nuevo, error } = await db
        .from("caja_chica_fondos")
        .insert({
          nombre: `Caja chica · ${nombre}`,
          responsable_tipo: conductorId ? "conductor" : "otro",
          responsable_nombre: nombre,
          conductor_id: conductorId,
          moneda: grupo[0].moneda || "PEN",
          activo: true,
          observaciones: `Creado por importación histórica de ${usuario}`,
        })
        .select("id, moneda")
        .single();
      if (error || !nuevo) {
        errores.push({ motivo: `No se pudo crear el fondo de "${nombre}": ${error?.message ?? "error desconocido"}` });
        continue;
      }
      fondo = nuevo;
      porResponsable.set(clave, nuevo);
    }

    const fondoId = fondoIdFijo ?? fondo?.id;
    if (!fondoId) {
      errores.push({ motivo: `Sin fondo de caja chica para "${grupo[0].responsable_nombre}"` });
      continue;
    }

    const fechas = grupo.map((g) => g.fecha).sort();
    const total = grupo.reduce((s, g) => s + Number(g.monto || 0), 0);

    // La rendición histórica nace LIQUIDADA: el dinero ya se movió hace meses.
    const { data: rend, error: eRend } = await db
      .from("caja_chica_rendiciones")
      .insert({
        fondo_id: fondoId,
        periodo_desde: fechas[0],
        periodo_hasta: fechas[fechas.length - 1],
        fecha_entrega: fechas[0],
        fecha_limite: fechas[fechas.length - 1],
        monto_asignado: total,
        monto_devuelto: 0,
        moneda: grupo[0].moneda || "PEN",
        estado: "liquidada",
        aprobada_por: `Importación · ${usuario}`,
        fecha_aprobacion: new Date().toISOString(),
        observaciones: "Rendición histórica importada desde Google Sheets",
        creado_por: usuario,
      })
      .select("id")
      .single();

    if (eRend || !rend) {
      errores.push({ motivo: `No se pudo crear la rendición de "${grupo[0].responsable_nombre}": ${eRend?.message ?? ""}` });
      continue;
    }
    creadasRend++;

    const gastos = grupo.map((g) => {
      const veh = g.vehiculo_placa ? placas.get(normaliza(g.vehiculo_placa).replace(/[^a-z0-9]/g, "")) : undefined;
      return {
        rendicion_id: rend.id,
        fecha: g.fecha,
        categoria: g.categoria,
        descripcion: g.descripcion,
        monto: g.monto,
        moneda: g.moneda,
        tipo_comprobante: g.tipo_comprobante,
        ruc_proveedor: g.ruc_proveedor,
        comprobante_serie: g.comprobante_serie,
        comprobante_numero: g.comprobante_numero,
        vehiculo_id: veh?.propio ? veh.id : null,
        conductor_id: conductorPorNombre.get(clave) ?? null,
        // Un histórico ya rendido entra como aprobado: obligar a revisarlo comprobante
        // por comprobante meses después no aporta control, solo ruido.
        estado_revision: "aprobado",
        revisado_por: `Importación · ${usuario}`,
        fecha_revision: new Date().toISOString(),
        origen: "importacion",
        observaciones: g.observaciones,
      };
    });

    const ids = await insertarEnLotes(db, "caja_chica_gastos", gastos, errores);
    idsGastos.push(...ids);
  }

  const importacionId = await registrarImportacion(db, {
    perfil, destino_tabla: "caja_chica_gastos", leidas: filas.length, creadas: idsGastos.length, omitidas: 0, errores, ids: idsGastos, usuario,
  });

  return {
    perfil,
    destino: "caja_chica_gastos",
    leidas: filas.length,
    creadas: idsGastos.length,
    actualizadas: creadasRend,
    omitidas: 0,
    errores,
    importacion_id: importacionId,
  };
}

// ── Perfil: extracto bancario ─────────────────────────────────────────────────

async function importarExtracto(db: any, filas: FilaExtracto[], perfil: string, usuario: string, body: any): Promise<Resumen> {
  const errores: Resumen["errores"] = [];
  const cuentaId = body?.cuenta_tesoreria_id ? Number(body.cuenta_tesoreria_id) : null;
  if (!cuentaId) {
    return { perfil, destino: "extractos_bancarios_movimientos", leidas: filas.length, creadas: 0, actualizadas: 0, omitidas: 0, errores: [{ motivo: "Elige la cuenta de tesorería a la que pertenece el extracto." }] };
  }

  const fechas = filas.map((f) => f.fecha_movimiento).sort();
  const { data: cab, error: eCab } = await db
    .from("extractos_bancarios")
    .insert({
      cuenta_tesoreria_id: cuentaId,
      banco: String(body?.banco ?? "BCP"),
      archivo_nombre: body?.archivo_nombre ?? null,
      periodo_desde: fechas[0] ?? null,
      periodo_hasta: fechas[fechas.length - 1] ?? null,
      filas_leidas: filas.length,
      saldo_final: filas.length ? filas[filas.length - 1].saldo : null,
      importado_por: usuario,
    })
    .select("id")
    .single();
  if (eCab || !cab) throw new Error(`No se pudo registrar el extracto: ${eCab?.message ?? ""}`);

  // Dedupe por hash: re-subir el mismo rango no duplica movimientos.
  const conHash = filas.map((f) => ({ fila: f, hash: hashMovimiento(cuentaId, f) }));
  const hashes = conHash.map((h) => h.hash);
  const existentes = new Set<string>();
  for (let i = 0; i < hashes.length; i += 200) {
    const { data } = await db
      .from("extractos_bancarios_movimientos")
      .select("hash_fila")
      .in("hash_fila", hashes.slice(i, i + 200));
    for (const d of (data as any[]) ?? []) existentes.add(d.hash_fila);
  }

  const vistos = new Set<string>();
  const aInsertar: any[] = [];
  let omitidas = 0;
  for (const { fila, hash } of conHash) {
    if (existentes.has(hash) || vistos.has(hash)) {
      omitidas++;
      continue;
    }
    vistos.add(hash);
    aInsertar.push({
      extracto_id: cab.id,
      cuenta_tesoreria_id: cuentaId,
      fecha_movimiento: fila.fecha_movimiento,
      fecha_valuta: fila.fecha_valuta,
      nro_operacion: fila.nro_operacion,
      descripcion_banco: fila.descripcion_banco,
      monto_cargo: fila.monto_cargo,
      monto_abono: fila.monto_abono,
      saldo: fila.saldo,
      moneda: fila.moneda,
      estado_conciliacion: "no_identificado",
      hash_fila: hash,
    });
  }

  const ids = await insertarEnLotes(db, "extractos_bancarios_movimientos", aInsertar, errores);

  await db
    .from("extractos_bancarios")
    .update({ filas_nuevas: ids.length, filas_duplicadas: omitidas })
    .eq("id", cab.id);

  const importacionId = await registrarImportacion(db, {
    perfil, destino_tabla: "extractos_bancarios_movimientos", leidas: filas.length, creadas: ids.length, omitidas, errores, ids, usuario,
  });

  return {
    perfil,
    destino: "extractos_bancarios_movimientos",
    leidas: filas.length,
    creadas: ids.length,
    actualizadas: 0,
    omitidas,
    errores,
    importacion_id: importacionId,
  };
}

// ── Utilidades comunes ────────────────────────────────────────────────────────

/**
 * Inserta en bloques. Si un bloque falla, reintenta fila por fila para aislar la
 * culpable en vez de perder las 200: un histórico rara vez viene perfecto y el
 * usuario necesita saber CUÁL fila lo rompió.
 */
async function insertarEnLotes(db: any, tabla: string, filas: any[], errores: Resumen["errores"]): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < filas.length; i += LOTE) {
    const bloque = filas.slice(i, i + LOTE);
    const { data, error } = await db.from(tabla).insert(bloque).select("id");
    if (!error) {
      for (const d of (data as any[]) ?? []) ids.push(Number(d.id));
      continue;
    }
    for (let j = 0; j < bloque.length; j++) {
      const { data: uno, error: e1 } = await db.from(tabla).insert(bloque[j]).select("id").single();
      if (e1) errores.push({ fila: i + j + 2, motivo: e1.message });
      else if (uno) ids.push(Number(uno.id));
    }
  }
  return ids;
}

async function registrarImportacion(
  db: any,
  a: { perfil: string; destino_tabla: string; leidas: number; creadas: number; omitidas: number; errores: Resumen["errores"]; ids: number[]; usuario: string }
): Promise<number | undefined> {
  const { data } = await db
    .from("importaciones_finanzas")
    .insert({
      perfil: a.perfil,
      destino_tabla: a.destino_tabla,
      filas_leidas: a.leidas,
      filas_creadas: a.creadas,
      filas_actualizadas: 0,
      filas_con_error: a.errores.length,
      // Se recorta el detalle: un histórico malo puede generar miles de errores y no
      // tiene sentido guardar un jsonb de megabytes.
      errores_json: a.errores.slice(0, 200),
      ids_creados: a.ids.slice(0, 5000),
      importado_por: a.usuario,
    })
    .select("id")
    .single();
  return data?.id ? Number(data.id) : undefined;
}

/**
 * DELETE — deshace una importación completa borrando los ids que creó.
 * Solo funciona mientras nada dependa de esas filas (un pago aplicado, por ejemplo,
 * impide borrar la CxP): en ese caso Postgres rechaza y se informa cuáles quedaron.
 */
export async function DELETE(req: Request) {
  const auth = await verificarUsuarioApi(req, "finanzas");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.rol !== "admin") {
    return NextResponse.json({ error: "Solo un administrador puede deshacer una importación." }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "Falta el id de la importación." }, { status: 400 });

  const db = admin();
  const { data: imp } = await db.from("importaciones_finanzas").select("*").eq("id", id).maybeSingle();
  if (!imp) return NextResponse.json({ error: "La importación no existe." }, { status: 404 });

  const ids: number[] = Array.isArray(imp.ids_creados) ? imp.ids_creados : [];
  if (!ids.length) return NextResponse.json({ error: "Esa importación no dejó filas que borrar." }, { status: 400 });

  let borradas = 0;
  const fallidas: number[] = [];
  for (let i = 0; i < ids.length; i += LOTE) {
    const bloque = ids.slice(i, i + LOTE);
    const { error } = await db.from(imp.destino_tabla).delete().in("id", bloque);
    if (!error) {
      borradas += bloque.length;
      continue;
    }
    for (const unoId of bloque) {
      const { error: e1 } = await db.from(imp.destino_tabla).delete().eq("id", unoId);
      if (e1) fallidas.push(unoId);
      else borradas++;
    }
  }

  if (!fallidas.length) await db.from("importaciones_finanzas").delete().eq("id", id);
  else await db.from("importaciones_finanzas").update({ ids_creados: fallidas }).eq("id", id);

  return NextResponse.json({
    borradas,
    no_borradas: fallidas.length,
    aviso: fallidas.length
      ? `${fallidas.length} fila(s) no se pudieron borrar porque ya tienen movimientos asociados (pagos, conciliaciones o liquidaciones).`
      : null,
  });
}
