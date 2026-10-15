// ──────────────────────────────────────────────────────────────────────────────
// lib/seguros-datos.ts — El que LEE las fuentes de /seguros y se las da a lib/seguros.ts.
//
// Reglas que no se aflojan:
//  · Cada fuente se lee PAGINADA con orden total (id) y una página que falla deja esa fuente en
//    'error' — NUNCA vacía. Una lista vacía por error se leería como «esta unidad no tiene SOAT».
//  · Una tabla/columna de migración accesoria que falta es 'sin_tabla', no 'error':
//    `seguro_cobertura` (seguros-02) y las accesorias de `seguros` (seguros-01) se sueltan si el
//    error las NOMBRA (lib/columna-faltante.ts); ante otro error no se reintenta.
//  · `faltantes` solo se juzga con las fuentes que lo sostienen leídas: con los documentos o las
//    pólizas en error no se afirma «sin SOAT» de nadie. Lo que no se juzgó queda en `sinJuzgar`.
// ──────────────────────────────────────────────────────────────────────────────

import { columnaFaltante, tablaFaltante } from "./columna-faltante";
import { fechaLima } from "./documentos-estado";
import {
  type FuenteSeguro, type FilaSeguro, type Faltante, type Directorio, type PersonaFicha,
  type PolizaRow, type CoberturaRow, type DocVehiculoRow, type DocTerceroRow, type UnidadFlota,
  filasDeDocumentosVehiculo, filasDeDocumentosTercero, filasDeFichas, filasDePolizas,
  coberturaFaltante, estaActivo,
} from "./seguros";

export type EstadoFuente = "ok" | "sin_tabla" | "error";

export type ResultadoSeguros = {
  filas: FilaSeguro[];
  fuentes: Record<FuenteSeguro, EstadoFuente>;
  /** `seguro_cobertura` aparte de `seguros`: sin seguros-02 las pólizas se ven, sin asegurados */
  coberturas: EstadoFuente;
  faltantes: Faltante[];
  /** qué parte del cumplimiento NO se juzgó y por qué (vacío = se juzgó todo) */
  sinJuzgar: string[];
  /** mensajes para el operador, en español, nombrando la fuente */
  errores: string[];
  hoy: string;
};

type Lectura<T> = { filas: T[]; estado: EstadoFuente; error?: string; soltadas: string[] };

const PAG = 1000;

/**
 * Lee una tabla entera, paginada con orden por id. Si el error nombra una columna de `opcionales`
 * se suelta SOLO esa y se relee desde cero; si la tabla falta → 'sin_tabla'; cualquier otro error
 * → 'error' sin filas (no se conserva lo acumulado: media lista es peor que ninguna aquí).
 */
async function leerTabla<T>(
  db: any, tabla: string, columnas: string[], opcionales: string[] = [],
): Promise<Lectura<T>> {
  let cols = [...columnas];
  const soltadas: string[] = [];
  for (let intento = 0; intento <= opcionales.length; intento++) {
    const todas: T[] = [];
    let fallo: any = null;
    for (let desde = 0; ; desde += PAG) {
      const { data, error } = await db.from(tabla).select(cols.join(",")).order("id", { ascending: true }).range(desde, desde + PAG - 1);
      if (error) { fallo = error; break; }
      todas.push(...((data ?? []) as T[]));
      if (!data || data.length < PAG) break;
    }
    if (!fallo) return { filas: todas, estado: "ok", soltadas };
    if (tablaFaltante(fallo, tabla)) return { filas: [], estado: "sin_tabla", soltadas, error: fallo.message };
    const col = columnaFaltante(fallo);
    if (col && opcionales.includes(col) && cols.includes(col)) { cols = cols.filter((c) => c !== col); soltadas.push(col); continue; }
    return { filas: [], estado: "error", soltadas, error: String(fallo?.message ?? fallo) };
  }
  return { filas: [], estado: "error", soltadas, error: "no se pudo leer" };
}

/**
 * Pólizas de PERSONA (SCTR Salud/Pensión, Vida Ley) y sus coberturas, para quien solo necesita
 * `vencimientoFichaOPoliza` (el tick y el login del conductor, con el cliente service-role).
 * BEST-EFFORT: si falta alguna de las dos tablas o falla cualquier lectura devuelve null, y
 * quien llama se queda con la ficha — exactamente lo de antes. Nunca media lista: una cobertura
 * perdida haría caer a una persona de la póliza a la ficha sin que nadie lo note.
 * `conductorId` acota las coberturas a un conductor (el login).
 */
export async function leerPolizasPersonas(
  db: any, opts: { conductorId?: number } = {},
): Promise<{ polizas: PolizaRow[]; coberturas: CoberturaRow[] } | null> {
  try {
    const pag = async (armar: () => any): Promise<any[] | null> => {
      const todas: any[] = [];
      for (let desde = 0; ; desde += PAG) {
        const { data, error } = await armar().order("id", { ascending: true }).range(desde, desde + PAG - 1);
        if (error) return null;
        todas.push(...(data ?? []));
        if (!data || data.length < PAG) return todas;
      }
    };
    const TIPOS = ["sctr_salud", "sctr_pension", "vida_ley"];
    const [pol, cob] = await Promise.all([
      pag(() => db.from("seguros").select("id,tipo,fecha_vencimiento").in("tipo", TIPOS)),
      pag(() => {
        let q = db.from("seguro_cobertura").select("id,seguro_id,conductor_id,personal_administrativo_id,desde,hasta");
        q = opts.conductorId != null ? q.eq("conductor_id", opts.conductorId)
          : q.or("conductor_id.not.is.null,personal_administrativo_id.not.is.null");
        return q;
      }),
    ]);
    if (!pol || !cob) return null;
    return { polizas: pol as PolizaRow[], coberturas: cob as CoberturaRow[] };
  } catch {
    return null;
  }
}

const peor = (...e: EstadoFuente[]): EstadoFuente => e.includes("error") ? "error" : e.includes("sin_tabla") ? "sin_tabla" : "ok";

/** `db` por defecto: el cliente de navegador (lib/supabase.ts), importado al llamar para que la
 *  matriz pueda inyectar uno falso sin cargar supabase-js. */
export async function cargarSeguros(dbInyectado?: any, hoy: string = fechaLima()): Promise<ResultadoSeguros> {
  const db = dbInyectado ?? (await import("./supabase")).supabase;
  const COLS_DOC = ["id", "vehiculo_id", "tipo", "numero", "fecha_emision", "fecha_vencimiento", "entidad_emisora", "archivo_url"];
  const COLS_PERSONA = ["id", "nombre", "estado", "sctr_salud_venc", "sctr_pension_venc", "vida_ley", "vida_ley_venc"];
  const [veh, vt, emp, dv, dt, cond, pers, pol, cob] = await Promise.all([
    leerTabla<any>(db, "vehiculos", ["id", "placa", "estado"]),
    leerTabla<any>(db, "vehiculos_tercero", ["id", "placa", "estado", "empresa_id"]),
    leerTabla<any>(db, "empresas_tercerizadas", ["id", "razon_social"]),
    leerTabla<DocVehiculoRow>(db, "documentos_vehiculo", COLS_DOC, ["fecha_emision", "numero", "entidad_emisora", "archivo_url"]),
    leerTabla<DocTerceroRow>(db, "documentos_tercero", ["empresa_id", ...COLS_DOC], ["fecha_emision", "numero", "entidad_emisora", "archivo_url"]),
    leerTabla<any>(db, "conductores", COLS_PERSONA, ["sctr_salud_venc", "sctr_pension_venc", "vida_ley", "vida_ley_venc"]),
    leerTabla<any>(db, "personal_administrativo", COLS_PERSONA, ["sctr_salud_venc", "sctr_pension_venc", "vida_ley", "vida_ley_venc"]),
    leerTabla<PolizaRow>(db, "seguros",
      ["id", "tipo", "aseguradora", "numero_poliza", "titular", "vehiculo_id", "fecha_inicio", "fecha_vencimiento", "prima_total", "cuota_mensual", "archivo_url", "vehiculo_tercero_id", "alcance"],
      ["vehiculo_tercero_id", "alcance"]),
    leerTabla<CoberturaRow>(db, "seguro_cobertura", ["id", "seguro_id", "conductor_id", "personal_administrativo_id", "vehiculo_id", "vehiculo_tercero_id", "desde", "hasta"]),
  ]);

  const errores: string[] = [];
  const nota = (l: Lectura<any>, quien: string, sql?: string) => {
    if (l.estado === "error") errores.push(`No se pudo leer ${quien}: ${l.error}. Esa parte de la pantalla no se muestra; recarga para reintentar.`);
    if (l.estado === "sin_tabla") errores.push(`Falta ${quien}${sql ? ` (corre ${sql} en Supabase → SQL Editor)` : ""}.`);
    if (l.soltadas.length) errores.push(`En ${quien} faltan las columnas ${l.soltadas.join(", ")}${sql ? ` (${sql})` : ""}; se leyó sin ellas.`);
  };
  nota(veh, "la flota propia (vehiculos)"); nota(vt, "la flota tercerizada (vehiculos_tercero)");
  nota(emp, "las empresas tercerizadas"); nota(dv, "los documentos de vehículos"); nota(dt, "los documentos de terceros");
  nota(cond, "las fichas de conductores"); nota(pers, "las fichas del personal administrativo");
  nota(pol, "las pólizas (seguros)", "supabase/seguros-01-base.sql");
  nota(cob, "los asegurados de las pólizas (seguro_cobertura)", "supabase/seguros-02-cobertura.sql");

  const dir: Directorio = {
    vehiculos: new Map(veh.filas.map((v: any) => [Number(v.id), String(v.placa ?? `#${v.id}`)])),
    vehiculosTercero: new Map(vt.filas.map((v: any) => [Number(v.id), String(v.placa ?? `#${v.id}`)])),
    empresasTercero: new Map(emp.filas.map((e: any) => [Number(e.id), String(e.razon_social ?? `Empresa #${e.id}`)])),
    conductores: new Map(cond.filas.map((c: any) => [Number(c.id), String(c.nombre ?? `#${c.id}`)])),
    personal: new Map(pers.filas.map((p: any) => [Number(p.id), String(p.nombre ?? `#${p.id}`)])),
  };

  const aPersona = (clase: "conductor" | "personal") => (r: any): PersonaFicha => ({
    clase, id: Number(r.id), nombre: String(r.nombre ?? `#${r.id}`), activo: estaActivo(r.estado),
    sctr_salud_venc: r.sctr_salud_venc ?? null, sctr_pension_venc: r.sctr_pension_venc ?? null,
    vida_ley: r.vida_ley ?? null, vida_ley_venc: r.vida_ley_venc ?? null,
  });
  const personas = [...cond.filas.map(aPersona("conductor")), ...pers.filas.map(aPersona("personal"))];
  const polizas = pol.filas;
  const coberturas = cob.filas;

  const filas: FilaSeguro[] = [
    ...filasDeDocumentosVehiculo(dv.filas, dir, hoy),
    ...filasDeDocumentosTercero(dt.filas, dir, hoy),
    ...filasDeFichas(personas, polizas, coberturas, hoy),
    ...filasDePolizas(polizas, coberturas, dir, hoy),
  ];

  // Una ficha leída sin columnas de seguro no es una ficha «sin seguro».
  const fichaCond = cond.estado === "ok" && cond.soltadas.length ? "sin_tabla" : cond.estado;
  const fichaPers = pers.estado === "ok" && pers.soltadas.length ? "sin_tabla" : pers.estado;
  const fuentes: Record<FuenteSeguro, EstadoFuente> = {
    documento_vehiculo: dv.estado,
    documento_tercero: dt.estado,
    ficha_conductor: fichaCond,
    ficha_personal: fichaPers,
    poliza: peor(pol.estado, cob.estado),
  };

  // ── Cumplimiento: solo con lo que lo sostiene leído ────────────────────────
  const sinJuzgar: string[] = [];
  const polizasOk = pol.estado !== "error" && cob.estado !== "error";
  const flotaPropia: UnidadFlota[] = veh.estado === "ok" && dv.estado === "ok" && polizasOk
    ? veh.filas.map((v: any) => ({ id: Number(v.id), placa: String(v.placa ?? `#${v.id}`), estado: v.estado })) : [];
  if (veh.estado !== "ok" || dv.estado !== "ok" || !polizasOk) sinJuzgar.push("SOAT/CAT de la flota propia");
  const flotaTercero: UnidadFlota[] = vt.estado === "ok" && dt.estado === "ok" && polizasOk
    ? vt.filas.map((v: any) => ({ id: Number(v.id), placa: String(v.placa ?? `#${v.id}`), estado: v.estado, empresa_id: v.empresa_id, empresa: dir.empresasTercero?.get(Number(v.empresa_id)) ?? null })) : [];
  if (vt.estado !== "ok" || dt.estado !== "ok" || !polizasOk) sinJuzgar.push("SOAT/CAT, SCTR y Vida Ley de la flota tercerizada");
  const personasJuzgables = polizasOk ? personas.filter((p) =>
    (p.clase === "conductor" ? fichaCond : fichaPers) === "ok") : [];
  if (!polizasOk || fichaCond !== "ok") sinJuzgar.push("SCTR y Vida Ley de los conductores");
  if (!polizasOk || fichaPers !== "ok") sinJuzgar.push("SCTR y Vida Ley del personal administrativo");

  const faltantes = coberturaFaltante(flotaPropia, flotaTercero, personasJuzgables, filas, hoy, { polizas, coberturas });

  return { filas, fuentes, coberturas: cob.estado, faltantes, sinJuzgar, errores, hoy };
}
