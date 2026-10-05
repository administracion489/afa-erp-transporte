// lib/combustible/saldo-datos.ts — El que LEE para el saldo de la cuenta de combustible.
// Recibe el cliente de Supabase (navegador o service-role): la pantalla y el cron calculan
// con la MISMA función, así que /combustible y el correo de aviso no pueden decir dos saldos
// distintos. Toda la aritmética vive en lib/combustible/saldo-cuenta.ts (puro).

import { paginarFilas } from "@/lib/huella";
import {
  calcularSaldo, sumarDiasISO, umbralesValidos,
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
  return {
    ...r,
    id: Number(r.id),
    patrones_grifo: Array.isArray(r.patrones_grifo) ? r.patrones_grifo : [],
    rucs: Array.isArray(r.rucs) ? r.rucs : [],
    umbrales: umbralesValidos(r.umbrales),
    incluye_terceros: !!r.incluye_terceros,
    ultimo_umbral_avisado: r.ultimo_umbral_avisado == null ? null : Number(r.ultimo_umbral_avisado),
    facturas_gracia_dias: Number.isFinite(Number(r.facturas_gracia_dias)) ? Number(r.facturas_gracia_dias) : 1,
    facturas_auto_registrar: r.facturas_auto_registrar !== false,
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

/**
 * Calcula el saldo de cada cuenta. Las cargas se piden desde la lectura más antigua que
 * importe (o 30 días para el ritmo), no la tabla entera.
 */
export async function estadoDeCuentas(sb: any, cuentas: FilaCuenta[], hoy: string): Promise<EstadoCuenta[]> {
  if (!cuentas.length) return [];
  const ids = cuentas.map((c) => c.id);
  const { data: movs } = await sb
    .from("combustible_cuenta_movimientos")
    .select("id, cuenta_id, tipo, monto, fecha, created_at")
    .in("cuenta_id", ids)
    .order("fecha", { ascending: true });
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
  const [cargas, { data: pend }, { data: terc }] = await Promise.all([
    paginarFilas(() =>
      sb.from("combustible")
        .select("id, fecha, total, grifo, ruc_proveedor, vehiculo_tercero_id, created_at")
        .gte("fecha", desde)
        .order("id", { ascending: true })
    ),
    sb.from("radar_combustible")
      .select("id, fecha, monto_total, grifo, placa, created_at")
      .eq("estado", "pendiente_revision")
      .is("combustible_id", null)
      .gte("fecha", desde),
    sb.from("vehiculos_tercero").select("placa"),
  ]);
  const norm = (p?: string | null) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const placasTerc = new Set(((terc as any[]) ?? []).map((t) => norm(t.placa)));

  const registradas: CargaCuenta[] = (cargas as any[]).map((c) => ({
    id: c.id, fecha: String(c.fecha).slice(0, 10), creado_en: c.created_at ?? null,
    total: Number(c.total) || 0, grifo: c.grifo, ruc_proveedor: c.ruc_proveedor,
    es_tercero: c.vehiculo_tercero_id != null,
  }));
  const porConfirmar: CargaCuenta[] = ((pend as any[]) ?? [])
    .filter((r) => r.fecha && r.monto_total != null)
    .map((r) => ({
      id: r.id, fecha: String(r.fecha).slice(0, 10), creado_en: r.created_at ?? null,
      total: Number(r.monto_total) || 0, grifo: r.grifo, es_tercero: placasTerc.has(norm(r.placa)),
    }));

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
