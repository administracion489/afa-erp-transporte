// ──────────────────────────────────────────────────────────────────────────────
// lib/costeo-servicio.ts — El presupuesto de UN servicio con unidad propia, y su
// comparación contra lo que de verdad se gastó.
//
// Reparto de responsabilidades:
//   · lib/costeo-propio.ts     — la fórmula del costo del vehículo. No lee la base.
//   · lib/costeo-conductor.ts  — el costo empresa por día. No lee la base.
//   · este archivo             — resuelve DE DÓNDE sale cada dato y lo guarda.
//
// Las cascadas siguen el mismo criterio que el PAX contratado en la liquidación:
// se prefiere lo MEDIDO sobre lo parametrizado, y cuando ninguna fuente sabe, no
// se inventa — el renglón sale vacío y la pantalla dice por qué. Cada dato
// declara su origen, porque un estimado que no dice de dónde sale no se puede
// discutir, y lo que no se puede discutir se ignora.
//
// Requiere supabase/costeo-01-planilla-y-presupuesto.sql.
// ──────────────────────────────────────────────────────────────────────────────

import {
  calcularCostoUnidad, type ParametrosUnidad, type PreciosCombustible,
} from "@/lib/costeo-propio";
import {
  costoConductorServicio, type RegimenLaboral, type DatosConductor,
} from "@/lib/costeo-conductor";

export type ReservaCosteable = {
  id: number;
  codigo?: string | null;
  fecha_servicio: string | null;
  ruta_nombre?: string | null;
  vehiculo_id?: number | null;
  conductor_id?: number | null;
  precio_cliente?: number | null;
  estado?: string | null;
};

/** Un renglón del presupuesto, con de dónde salió. */
export type LineaCosto = {
  concepto: string;
  nombre: string;
  monto: number;
  /** Cómo se llegó a ese número. Se guarda y se imprime. */
  base: string;
  /** true = se amortiza; nunca va a tener un comprobante propio de este servicio. */
  imputado: boolean;
  orden: number;
};

export type Presupuesto = {
  lineas: LineaCosto[];
  total: number;
  /** De ese total, cuánto es imputado (conductor y desgaste). */
  totalImputado: number;
  /** Lo comparable contra los egresos reales: total − imputado. */
  totalComparable: number;
  km: number;
  kmFuente: "gps" | "ruta" | "manual" | "";
  dias: number;
  serviciosDelDia: number;
  /** Lo que faltó para poder costear del todo. Se muestra, no se esconde. */
  faltantes: string[];
};

/** Todo lo que hace falta para costear, ya resuelto contra la base. */
export type ContextoCosteo = {
  parametros: ParametrosUnidad | null;
  precios: PreciosCombustible;
  /** Rendimiento medido de la placa, si se pudo calcular. */
  rendimientoMedido: { kmGal: number; cargas: number } | null;
  /** Precio realmente pagado en la última carga de esa unidad. */
  precioUltimaCarga: { precio: number; fecha: string } | null;
  /** Depreciación contable de esa placa, en soles por kilómetro. */
  deprecKm: { valor: number; fuente: "contable" } | null;
  conductor: { datos: DatosConductor; regimen: RegimenLaboral; nombre: string } | null;
  diasConServicio: number;
  serviciosDelDia: number;
  diasLaborablesMes: number;
  kmSugerido: { km: number; fuente: "gps" | "ruta" } | null;
  placa: string;
};

const NOMBRES: Record<string, string> = {
  combustible: "Combustible", peajes: "Peajes", viaticos: "Viáticos del conductor",
  estacionamiento: "Estacionamiento", pernocte: "Pernocte de la unidad",
  conductor: "Conductor", mantenimiento: "Mantenimiento", neumaticos: "Neumáticos",
  depreciacion: "Depreciación", fijos: "Seguros y permisos", multa: "Multas",
  otro: "Otros del servicio",
};

/** Mediana, no promedio: un tanque a medio llenar mueve la media y no la mediana. */
function mediana(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Rendimiento REAL de una unidad: km entre cargas ÷ galones de la carga.
 *
 * `parametros_costos.rendimiento_1` es un número que alguien tecleó para un TIPO de
 * vehículo. Esto es lo que esa placa consume de verdad. Se usa la mediana de las
 * últimas cargas porque un tanque llenado a medias, o un odómetro anotado al día
 * siguiente, distorsionan el promedio y no la mediana.
 */
export async function rendimientoMedido(
  sb: any, vehiculoId: number, tope = 8
): Promise<{ kmGal: number; cargas: number } | null> {
  if (!vehiculoId) return null;
  const { data } = await sb
    .from("combustible")
    .select("fecha,kilometraje,galones,precio_galon,tipo_combustible")
    .eq("vehiculo_id", vehiculoId)
    .order("kilometraje", { ascending: false })
    .limit(tope + 1);
  const filas = ((data as any[]) ?? []).filter((r) => Number(r.kilometraje) > 0 && Number(r.galones) > 0);
  if (filas.length < 2) return null;

  const rend: number[] = [];
  // Vienen de mayor a menor odómetro: cada fila con la siguiente da un tramo.
  for (let i = 0; i < filas.length - 1; i++) {
    const km = Number(filas[i].kilometraje) - Number(filas[i + 1].kilometraje);
    const gal = Number(filas[i].galones);
    // Un tramo absurdo (odómetro reiniciado, carga sin recorrido) se descarta en
    // vez de contaminar la mediana.
    if (km > 0 && gal > 0 && km / gal < 40) rend.push(km / gal);
  }
  const m = mediana(rend);
  return m ? { kmGal: Math.round(m * 100) / 100, cargas: rend.length } : null;
}

/** Lo que de verdad se pagó por el galón en la última carga de esa unidad. */
export async function precioUltimaCarga(
  sb: any, vehiculoId: number
): Promise<{ precio: number; fecha: string } | null> {
  if (!vehiculoId) return null;
  const { data } = await sb
    .from("combustible")
    .select("fecha,precio_galon")
    .eq("vehiculo_id", vehiculoId)
    .gt("precio_galon", 0)
    .order("fecha", { ascending: false })
    .limit(1);
  const f = ((data as any[]) ?? [])[0];
  return f ? { precio: Number(f.precio_galon), fecha: String(f.fecha) } : null;
}

/**
 * Depreciación contable de esa placa, en soles por kilómetro.
 *
 * Sale de `activos_fijos`, que es lo que ya está asentado contra la cuenta 6811.
 * Usarla hace que el costeo CUADRE con el libro en vez de aproximarlo con un
 * parámetro tecleado. Se reparte sobre los km esperados al año del parámetro:
 * es la vida útil contable expresada en kilómetros.
 */
export async function deprecContableKm(
  sb: any, vehiculoId: number, kmAnio: number
): Promise<{ valor: number; fuente: "contable" } | null> {
  if (!vehiculoId || !(kmAnio > 0)) return null;
  const { data } = await sb
    .from("activos_fijos")
    .select("valor_adquisicion,valor_residual,vida_util_meses")
    .eq("vehiculo_id", vehiculoId)
    .eq("activo", true)
    .limit(1);
  const a = ((data as any[]) ?? [])[0];
  if (!a) return null;
  const meses = Number(a.vida_util_meses ?? 0);
  if (!(meses > 0)) return null;
  const depreciable = Number(a.valor_adquisicion ?? 0) - Number(a.valor_residual ?? 0);
  // Un activo ya depreciado del todo aporta 0, y ese cero es un DATO.
  const kmVida = (meses / 12) * kmAnio;
  return kmVida > 0 ? { valor: Math.max(0, depreciable) / kmVida, fuente: "contable" } : null;
}

/** Km del último presupuesto guardado para la misma ruta. Mejora con el uso. */
async function kmDeRutaConocida(sb: any, rutaNombre: string | null | undefined): Promise<number | null> {
  const ruta = String(rutaNombre ?? "").trim();
  if (!ruta) return null;
  const { data } = await sb
    .from("servicio_costo_estimado")
    .select("km, reservas!inner(ruta_nombre)")
    .eq("reservas.ruta_nombre", ruta)
    .gt("km", 0)
    .order("id", { ascending: false })
    .limit(5);
  const kms = ((data as any[]) ?? []).map((r) => Number(r.km));
  const m = mediana(kms);
  return m ?? null;
}

/** Resuelve todas las cascadas de una reserva. Una sola pasada por la base. */
export async function cargarContextoCosteo(sb: any, r: ReservaCosteable): Promise<ContextoCosteo> {
  const vacio: ContextoCosteo = {
    parametros: null, precios: {}, rendimientoMedido: null, precioUltimaCarga: null,
    deprecKm: null, conductor: null, diasConServicio: 0, serviciosDelDia: 1,
    diasLaborablesMes: 26, kmSugerido: null, placa: "",
  };

  const [vehRes, preciosRes, cfgRes] = await Promise.all([
    r.vehiculo_id
      ? sb.from("vehiculos").select("id,placa,tipo_vehiculo_costeo,capacidad_pasajeros").eq("id", r.vehiculo_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("precios_combustible").select("tipo,precio"),
    sb.from("config_laboral").select("*").eq("id", 1).maybeSingle(),
  ]);

  const veh: any = (vehRes as any)?.data ?? null;
  const precios: PreciosCombustible = {};
  for (const p of (((preciosRes as any)?.data as any[]) ?? [])) precios[p.tipo] = Number(p.precio) || 0;
  const cfg: any = (cfgRes as any)?.data ?? null;

  // Parámetros del TIPO de unidad. Sin ellos no hay costo de vehículo que calcular.
  let parametros: ParametrosUnidad | null = null;
  if (veh?.tipo_vehiculo_costeo) {
    const { data } = await sb.from("parametros_costos").select("*").eq("tipo_vehiculo", veh.tipo_vehiculo_costeo).maybeSingle();
    if (data) parametros = data as ParametrosUnidad;
  }

  const [rend, ultima, deprec, kmRuta] = await Promise.all([
    r.vehiculo_id ? rendimientoMedido(sb, r.vehiculo_id) : Promise.resolve(null),
    r.vehiculo_id ? precioUltimaCarga(sb, r.vehiculo_id) : Promise.resolve(null),
    r.vehiculo_id && parametros ? deprecContableKm(sb, r.vehiculo_id, Number(parametros.km_anio)) : Promise.resolve(null),
    kmDeRutaConocida(sb, r.ruta_nombre),
  ]);

  // ── Conductor ──
  let conductor: ContextoCosteo["conductor"] = null;
  let diasConServicio = 0;
  let serviciosDelDia = 1;
  if (r.conductor_id) {
    const periodo = String(r.fecha_servicio ?? "").slice(0, 7);
    const [plaRes, diasRes] = await Promise.all([
      sb.from("v_conductor_planilla").select("*").eq("conductor_id", r.conductor_id).maybeSingle(),
      periodo
        ? sb.from("v_conductor_dias_servicio").select("fecha_servicio,servicios_del_dia")
            .eq("conductor_id", r.conductor_id).eq("periodo", periodo)
        : Promise.resolve({ data: [] }),
    ]);
    const p: any = (plaRes as any)?.data ?? null;
    if (p) {
      conductor = {
        nombre: String(p.nombre ?? ""),
        datos: {
          tipo_contrato: p.tipo_contrato ?? null,
          sueldo_basico: p.sueldo_basico != null ? Number(p.sueldo_basico) : null,
          honorario_dia: p.honorario_dia != null ? Number(p.honorario_dia) : null,
          tiene_asignacion: !!p.tiene_asignacion,
          rmv: Number(p.rmv ?? 0),
          asignacion_familiar_pct: Number(p.asignacion_familiar_pct ?? 0),
          sctr_mensual: Number(p.sctr_mensual ?? 0),
        },
        regimen: {
          regimen: p.regimen, nombre: String(p.regimen_nombre ?? p.regimen),
          essalud_pct: Number(p.essalud_pct ?? 0), usa_sis: !!p.usa_sis,
          sis_aporte_mensual: Number(p.sis_aporte_mensual ?? 0),
          gratificaciones_sueldos: Number(p.gratificaciones_sueldos ?? 0),
          bonif_extraordinaria_pct: Number(p.bonif_extraordinaria_pct ?? 0),
          cts_sueldos_anio: Number(p.cts_sueldos_anio ?? 0),
          vacaciones_dias: Number(p.vacaciones_dias ?? 30),
        },
      };
    }
    const filas = (((diasRes as any)?.data as any[]) ?? []);
    diasConServicio = filas.length;
    const hoy = filas.find((f) => String(f.fecha_servicio) === String(r.fecha_servicio));
    serviciosDelDia = Math.max(1, Number(hoy?.servicios_del_dia ?? 1));
  }

  return {
    ...vacio,
    parametros,
    precios,
    rendimientoMedido: rend,
    precioUltimaCarga: ultima,
    deprecKm: deprec,
    conductor,
    diasConServicio,
    serviciosDelDia,
    diasLaborablesMes: Number(cfg?.dias_laborables_mes ?? 26),
    kmSugerido: kmRuta ? { km: kmRuta, fuente: "ruta" } : null,
    placa: String(veh?.placa ?? ""),
  };
}

/** Lo que el operador puede tocar en el modal. */
export type EntradaCosteo = {
  km: number;
  kmFuente: "gps" | "ruta" | "manual" | "";
  dias: number;
  peajes: number;
  viaticos: number;
  estacionamiento: number;
  pernocte: number;
  otros: number;
};

/**
 * Arma el presupuesto. Aquí no hay fórmula propia: se llama a los dos motores y
 * se reparte el resultado en renglones con su procedencia.
 */
export function calcularPresupuesto(ctx: ContextoCosteo, e: EntradaCosteo): Presupuesto {
  const faltantes: string[] = [];
  const lineas: LineaCosto[] = [];
  const km = Number(e.km || 0);

  if (!ctx.parametros) faltantes.push("La unidad no tiene tipo de costeo asignado (Vehículos → tipo de costeo).");
  if (!(km > 0)) faltantes.push("Faltan los kilómetros del recorrido.");

  // El rendimiento MEDIDO de esta placa manda sobre el parámetro del tipo.
  const params: ParametrosUnidad | null = ctx.parametros
    ? { ...ctx.parametros, rendimiento_1: ctx.rendimientoMedido?.kmGal ?? ctx.parametros.rendimiento_1 }
    : null;

  // Y el precio realmente pagado manda sobre el de referencia.
  const precios: PreciosCombustible = { ...ctx.precios };
  if (params && ctx.precioUltimaCarga) precios[params.tipo_combustible_1] = ctx.precioUltimaCarga.precio;

  // El conductor se calcula aparte y se INYECTA, para que el motor del vehículo
  // no tenga que saber nada de regímenes laborales.
  const cond = ctx.conductor
    ? costoConductorServicio(ctx.conductor.datos, ctx.conductor.regimen, {
        diasConServicio: ctx.diasConServicio,
        serviciosDelDia: ctx.serviciosDelDia,
        diasLaborablesMes: ctx.diasLaborablesMes,
      })
    : null;
  if (!ctx.conductor) faltantes.push("El servicio no tiene conductor asignado.");
  else if (cond?.falta) faltantes.push(cond.falta);

  const costo = params && km > 0
    ? calcularCostoUnidad(params, precios, {
        km,
        dias: Number(e.dias || 1),
        peajes: 0, otros: 0, pernocte: 0, viaticos: 0,   // van como renglones propios
        costoConductorDia: cond && !cond.falta ? cond.porServicio / Math.max(1, Number(e.dias || 1)) : null,
        deprecKm: ctx.deprecKm?.valor ?? null,
      })
    : null;

  const agregar = (concepto: string, monto: number, base: string, imputado: boolean, orden: number) => {
    lineas.push({ concepto, nombre: NOMBRES[concepto] ?? concepto, monto: Math.round(monto * 100) / 100, base, imputado, orden });
  };

  if (costo) {
    const fuenteRend = ctx.rendimientoMedido
      ? `${ctx.rendimientoMedido.kmGal} km/gal medido en ${ctx.rendimientoMedido.cargas} cargas`
      : `${params!.rendimiento_1} km/gal del parámetro`;
    const fuentePrecio = ctx.precioUltimaCarga
      ? `S/ ${ctx.precioUltimaCarga.precio.toFixed(2)} de la última carga`
      : `S/ ${(precios[params!.tipo_combustible_1] ?? 0).toFixed(2)} de referencia`;
    agregar("combustible", costo.costoCombustible, `${km} km · ${fuenteRend} · ${fuentePrecio}`, false, 10);
    agregar("mantenimiento", costo.costoMantenimiento, `${km} km × S/ ${params!.mantenimiento_km}/km`, false, 70);
    agregar("neumaticos", costo.costoNeumaticos,
      `${params!.n_neumaticos} × S/ ${params!.costo_neumatico} ÷ ${params!.vida_neumatico_km} km`, true, 80);
    agregar("depreciacion", costo.costoDeprec,
      ctx.deprecKm ? `depreciación contable de la placa · S/ ${ctx.deprecKm.valor.toFixed(3)}/km` : "parámetro del tipo de unidad", true, 90);
    agregar("fijos", costo.costoFijosKm, "seguros, SOAT, revisión y permisos prorrateados por km", true, 95);
  }

  if (cond && !cond.falta) agregar("conductor", cond.porServicio, cond.base, true, 60);

  if (Number(e.peajes) > 0)          agregar("peajes", Number(e.peajes), "estimado por el operador", false, 20);
  if (Number(e.viaticos) > 0)        agregar("viaticos", Number(e.viaticos), "estimado por el operador", false, 30);
  if (Number(e.estacionamiento) > 0) agregar("estacionamiento", Number(e.estacionamiento), "estimado por el operador", false, 40);
  if (Number(e.pernocte) > 0)        agregar("pernocte", Number(e.pernocte), "estimado por el operador", false, 50);
  if (Number(e.otros) > 0)           agregar("otro", Number(e.otros), "estimado por el operador", false, 99);

  lineas.sort((a, b) => a.orden - b.orden);
  const total = lineas.reduce((s, l) => s + l.monto, 0);
  const totalImputado = lineas.filter((l) => l.imputado).reduce((s, l) => s + l.monto, 0);

  return {
    lineas,
    total: Math.round(total * 100) / 100,
    totalImputado: Math.round(totalImputado * 100) / 100,
    totalComparable: Math.round((total - totalImputado) * 100) / 100,
    km,
    kmFuente: e.kmFuente,
    dias: Number(e.dias || 1),
    serviciosDelDia: ctx.serviciosDelDia,
    faltantes,
  };
}

// ── Persistencia ──────────────────────────────────────────────────────────────

/** Guarda una versión NUEVA. Las anteriores no se tocan: el desvío se compara contra lo que se planeó ese día. */
export async function guardarPresupuesto(
  sb: any, reservaId: number, p: Presupuesto, opts?: { usuario?: string | null; notas?: string | null; parametros?: any }
): Promise<{ ok: boolean; error?: string; version?: number }> {
  try {
    const { data: prev } = await sb
      .from("servicio_costo_estimado").select("version")
      .eq("reserva_id", reservaId).order("version", { ascending: false }).limit(1);
    const version = Number(((prev as any[]) ?? [])[0]?.version ?? 0) + 1;

    const { data: cab, error } = await sb.from("servicio_costo_estimado").insert({
      reserva_id: reservaId, version,
      km: p.km, km_fuente: p.kmFuente || null, dias: p.dias,
      servicios_del_dia: p.serviciosDelDia,
      parametros_json: opts?.parametros ?? null,
      total_estimado: p.total, total_imputado: p.totalImputado,
      notas: opts?.notas ?? null, creado_por: opts?.usuario ?? null,
    }).select("id").single();
    if (error) throw new Error(error.message);

    const filas = p.lineas.map((l) => ({
      estimado_id: Number(cab.id), concepto: l.concepto, monto: l.monto, base: l.base, orden: l.orden,
    }));
    if (filas.length) {
      const { error: eL } = await sb.from("servicio_costo_estimado_linea").insert(filas);
      if (eL) throw new Error(eL.message);
    }
    return { ok: true, version };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export type RealPorConcepto = { concepto: string; monto: number; n: number };

/**
 * Lo que de VERDAD se gastó en el servicio, por concepto, para poder ponerlo al
 * lado del presupuesto. Sale de `v_egresos`, que es donde ya confluyen los gastos
 * de Seguimiento, el combustible, el mantenimiento y la caja chica.
 */
export async function cargarRealPorConcepto(sb: any, reservaId: number): Promise<RealPorConcepto[]> {
  const { data } = await sb
    .from("v_egresos")
    .select("fuente,concepto,monto,estado,documento_compra_id")
    .eq("reserva_id", reservaId);
  const filas = (((data as any[]) ?? [])).filter(
    (r) => String(r.estado ?? "") !== "anulado" && r.documento_compra_id == null
  );

  const acc = new Map<string, RealPorConcepto>();
  for (const f of filas) {
    // El concepto del presupuesto y la categoría del gasto comparten catálogo, así
    // que la mayoría casa por nombre. `fuente` cubre combustible y mantenimiento,
    // que no vienen de `gastos`.
    const fuente = String(f.fuente ?? "");
    const clave =
      fuente === "combustible" ? "combustible"
      : fuente === "mantenimiento" ? "mantenimiento"
      : String(f.concepto ?? "otro");
    const k = NOMBRES[clave] ? clave : "otro";
    const ya = acc.get(k) ?? { concepto: k, monto: 0, n: 0 };
    ya.monto += Number(f.monto ?? 0);
    ya.n += 1;
    acc.set(k, ya);
  }
  return [...acc.values()].map((r) => ({ ...r, monto: Math.round(r.monto * 100) / 100 }));
}

/** El presupuesto vigente de una reserva, con sus renglones. */
export async function cargarPresupuesto(
  sb: any, reservaId: number
): Promise<{ cabecera: any; lineas: LineaCosto[] } | null> {
  const { data: cab } = await sb
    .from("v_servicio_costo_estimado").select("*").eq("reserva_id", reservaId).maybeSingle();
  if (!cab) return null;
  const { data: ls } = await sb
    .from("servicio_costo_estimado_linea").select("*").eq("estimado_id", cab.id).order("orden");
  const lineas: LineaCosto[] = (((ls as any[]) ?? [])).map((l) => ({
    concepto: String(l.concepto),
    nombre: NOMBRES[String(l.concepto)] ?? String(l.concepto),
    monto: Number(l.monto ?? 0),
    base: String(l.base ?? ""),
    imputado: ["conductor", "neumaticos", "depreciacion", "fijos"].includes(String(l.concepto)),
    orden: Number(l.orden ?? 100),
  }));
  return { cabecera: cab, lineas };
}
