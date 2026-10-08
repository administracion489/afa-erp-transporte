// lib/combustible/saldo-datos.ts — El que LEE para el saldo de la cuenta de combustible.
// Recibe el cliente de Supabase (navegador o service-role): la pantalla y el cron calculan
// con la MISMA función, así que /combustible y el correo de aviso no pueden decir dos saldos
// distintos. Toda la aritmética vive en lib/combustible/saldo-cuenta.ts (puro).

import { normalizarDesfaseConfig } from "@/lib/combustible/desfase-factura";
import { faltaAlguna } from "@/lib/columna-faltante";
import {
  calcularSaldo, sumarDiasISO, umbralesValidos, flotaConocida, unidadDeCarga,
  type CuentaCombustible, type Movimiento, type CargaCuenta, type SaldoCuenta,
} from "@/lib/combustible/saldo-cuenta";

export type FilaCuenta = CuentaCombustible & {
  activo: boolean;
  avisar_correos: string | null;
  avisar_telefonos: string | null;
  ultimo_umbral_avisado: number | null;
  ultimo_aviso_en: string | null;
  correo_filtro: string;
  facturas_auto_registrar: boolean;
  facturas_gracia_dias: number;
  /** Días del despacho a la emisión de la factura. null = automático (medido). Migración combustible-04. */
  facturas_desfase_dias: number | null;
  /** La columna anterior no existe (combustible-04 sin correr): el desfase solo puede ser automático. */
  facturas_desfase_sin_migracion: boolean;
};

export type EstadoCuenta = {
  cuenta: FilaCuenta;
  movimientos: Movimiento[];
  saldo: SaldoCuenta;
};

/** `null` en `sinMigracion` = la tabla no existe (combustible-03 sin correr). */
export function faltaTabla(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /does not exist|could not find the table/i.test(err.message || "");
}

export function filaCuenta(r: any): FilaCuenta {
  // `incluye_terceros` (combustible-03) ya no se lee: SOLO descuentan las unidades propias, sea
  // cual sea el valor de la columna (lib/combustible/saldo-cuenta.ts, regla 4).
  const resto = { ...(r ?? {}) };
  delete resto.incluye_terceros;
  return {
    ...resto,
    id: Number(r.id),
    patrones_grifo: Array.isArray(r.patrones_grifo) ? r.patrones_grifo : [],
    rucs: Array.isArray(r.rucs) ? r.rucs : [],
    umbrales: umbralesValidos(r.umbrales),
    ultimo_umbral_avisado: r.ultimo_umbral_avisado == null ? null : Number(r.ultimo_umbral_avisado),
    facturas_gracia_dias: Number.isFinite(Number(r.facturas_gracia_dias)) ? Number(r.facturas_gracia_dias) : 1,
    facturas_auto_registrar: r.facturas_auto_registrar !== false,
    // Sin la migración la columna no llega: automático, que es medir antes de mover nada.
    facturas_desfase_dias: normalizarDesfaseConfig(r.facturas_desfase_dias),
    // `select("*")` trae la clave si y solo si la columna existe (aunque valga null).
    facturas_desfase_sin_migracion: !("facturas_desfase_dias" in (r ?? {})),
  };
}

export async function cargarCuentas(sb: any): Promise<{ cuentas: FilaCuenta[]; sinMigracion: boolean }> {
  const { data, error } = await sb.from("combustible_cuentas").select("*").order("id");
  if (error) {
    if (faltaTabla(error)) return { cuentas: [], sinMigracion: true };
    throw new Error(`combustible_cuentas: ${error.message}`);
  }
  return { cuentas: ((data as any[]) ?? []).map(filaCuenta), sinMigracion: false };
}

type ErrorLectura = { code?: string; message?: string };
type ConsultaPaginable = {
  range: (desde: number, hasta: number) => PromiseLike<{ data: unknown[] | null; error: ErrorLectura | null }>;
};

type FilaCarga = {
  id: number; fecha: string; total: number | null; grifo: string | null; ruc_proveedor: string | null;
  vehiculo_id: number | null; vehiculo_tercero_id: number | null; created_at: string | null;
  comprobante_serie?: string | null; comprobante_numero?: string | null;
};
type FilaRadar = {
  id: string; fecha: string | null; monto_total: number | null; grifo: string | null; placa: string | null;
  created_at: string | null; vehiculo_id: number | null; vehiculo_tercero_id?: number | null;
};
type FilaUnidad = { id: number; placa: string | null; estado?: string | null };

/**
 * Lee TODAS las filas de una consulta, paginada con orden total, y LANZA ante un error.
 *
 * NO ES `paginarFilas` A PROPÓSITO: aquella conserva lo acumulado cuando una página falla («huella
 * parcial > vacía», que es cierto para el GPS). Para el saldo es al revés: una lista de cargas
 * cortada por un fallo resta de MENOS y el saldo sale MÁS ALTO que el real —el aviso tarde, el
 * error caro de este módulo—, y una flota que no se pudo leer dejaría toda carga «sin unidad». Mejor
 * que la tarjeta diga que no pudo calcular a que enseñe un número equivocado con cara de bueno.
 * `opcionales`: columnas de una migración accesoria; si el error nombra una, se suelta y se reintenta.
 */
async function leerTodas<T>(
  consulta: (columnas: string) => ConsultaPaginable,
  columnas: string[],
  opcionales: string[],
  etiqueta: string,
): Promise<T[]> {
  const PAG = 1000;
  let usar = [...columnas];
  for (;;) {
    const filas: T[] = [];
    let fallo: ErrorLectura | null = null;
    for (let desde = 0; desde < 200_000; desde += PAG) {
      const { data, error } = await consulta(usar.join(", ")).range(desde, desde + PAG - 1);
      if (error) { fallo = error; break; }
      filas.push(...((data ?? []) as T[]));
      if (!data || data.length < PAG) break;
    }
    if (!fallo) return filas;
    const col = faltaAlguna(fallo, opcionales.filter((c) => usar.includes(c)));
    if (!col) throw new Error(`${etiqueta}: ${fallo.message ?? "no se pudo leer"}`);
    usar = usar.filter((c) => c !== col);
  }
}

/**
 * Calcula el saldo de cada cuenta. Las cargas se piden desde la lectura más antigua que
 * importe (o 30 días para el ritmo), no la tabla entera.
 */
export async function estadoDeCuentas(sb: any, cuentas: FilaCuenta[], hoy: string): Promise<EstadoCuenta[]> {
  if (!cuentas.length) return [];
  const ids = cuentas.map((c) => c.id);
  // Sin los movimientos no hay ancla, y «registra el saldo del portal» sobre una lectura que sí
  // existe mandaría a teclear otra vez lo que ya está: se dice que falló.
  const { data: movs, error: eMovs } = await sb
    .from("combustible_cuenta_movimientos")
    .select("id, cuenta_id, tipo, monto, fecha, created_at")
    .in("cuenta_id", ids)
    .order("fecha", { ascending: true });
  if (eMovs) throw new Error(`combustible_cuenta_movimientos: ${eMovs.message}`);
  const movimientos = ((movs as any[]) ?? []).map((m) => ({
    id: Number(m.id), cuenta_id: Number(m.cuenta_id), tipo: m.tipo, monto: Number(m.monto),
    fecha: String(m.fecha).slice(0, 10), creado_en: String(m.created_at ?? ""),
  }));

  const anclas = cuentas
    .map((c) => movimientos.filter((m) => m.cuenta_id === c.id && m.tipo === "lectura").map((m) => m.fecha).sort().pop())
    .filter(Boolean) as string[];
  const desdeRitmo = sumarDiasISO(hoy, -30);
  const desde = [desdeRitmo, ...anclas].sort()[0];

  // Paginado y ORDENADO: sin `order`, `.range()` deja el criterio a Postgres y las páginas
  // pueden solaparse (el defecto que tuvo la propagación de /cotizaciones).
  const [cargas, pend, propias, terceros] = await Promise.all([
    leerTodas<FilaCarga>(
      (cols) => sb.from("combustible").select(cols).gte("fecha", desde).order("id", { ascending: true }),
      ["id", "fecha", "total", "grifo", "ruc_proveedor", "vehiculo_id", "vehiculo_tercero_id", "created_at", "comprobante_serie", "comprobante_numero"],
      // Solo para ENSEÑAR a qué factura está enlazada (finanzas-02): sin ellas el saldo es el mismo.
      ["comprobante_serie", "comprobante_numero"],
      "combustible",
    ),
    leerTodas<FilaRadar>(
      (cols) => sb.from("radar_combustible").select(cols)
        .eq("estado", "pendiente_revision").is("combustible_id", null).gte("fecha", desde)
        .order("created_at", { ascending: true }).order("id", { ascending: true }),
      ["id", "fecha", "monto_total", "grifo", "placa", "created_at", "vehiculo_id", "vehiculo_tercero_id"],
      // radar-ia-combustible-revision.sql: sin ella, la unidad de tercero se reconoce por la placa.
      ["vehiculo_tercero_id"],
      "radar_combustible",
    ),
    // `estado`: una ficha inactiva no vuelve ambigua una placa (unidadDeCarga). Sin la columna,
    // todas cuentan como vigentes.
    leerTodas<FilaUnidad>((cols) => sb.from("vehiculos").select(cols).order("id", { ascending: true }), ["id", "placa", "estado"], ["estado"], "vehiculos"),
    leerTodas<FilaUnidad>((cols) => sb.from("vehiculos_tercero").select(cols).order("id", { ascending: true }), ["id", "placa", "estado"], ["estado"], "vehiculos_tercero"),
  ]);
  const flota = flotaConocida(propias, terceros);

  const registradas: CargaCuenta[] = cargas.map((c) => {
    const u = unidadDeCarga(c, flota);
    return {
      id: c.id, fecha: String(c.fecha).slice(0, 10), creado_en: c.created_at ?? null,
      total: Number(c.total) || 0, grifo: c.grifo, ruc_proveedor: c.ruc_proveedor,
      flota: u.flota, placa: u.placa,
      comprobante: c.comprobante_serie && c.comprobante_numero ? `${c.comprobante_serie}-${c.comprobante_numero}` : null,
    };
  });
  const porConfirmar: CargaCuenta[] = pend
    .filter((r) => r.fecha && r.monto_total != null)
    .map((r) => {
      const u = unidadDeCarga(r, flota);
      return {
        id: r.id, fecha: String(r.fecha).slice(0, 10), creado_en: r.created_at ?? null,
        total: Number(r.monto_total) || 0, grifo: r.grifo, flota: u.flota, placa: u.placa,
      };
    });

  return cuentas.map((cuenta) => {
    const propios = movimientos.filter((m) => m.cuenta_id === cuenta.id);
    return {
      cuenta,
      movimientos: propios,
      saldo: calcularSaldo({ cuenta, movimientos: propios, cargas: registradas, porConfirmar, hoy }),
    };
  });
}

/** Correos «a, b; c» → ["a","b","c"]. Mismo separador que la copia interna del reporte. */
export function correosDeTexto(s?: string | null): string[] {
  return String(s ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter((x) => x.includes("@"));
}

/** Teléfonos: SOLO coma, punto y coma o salto de línea — «+51 966 707 225» lleva espacios
 *  y partirlo por ellos convertiría un número en cuatro. */
export function telefonosDeTexto(s?: string | null): string[] {
  return String(s ?? "").split(/[,;\n]+/).map((x) => x.trim()).filter((x) => x.replace(/\D/g, "").length >= 9);
}
