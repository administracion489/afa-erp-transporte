// ============================================================
// ELIA — Configuración, precios y control de gasto (SOLO servidor).
// Si las tablas de supabase/elia-config.sql no existen todavía,
// todo degrada con valores por defecto: ELIA sigue funcionando,
// solo que sin registro de gasto ni límite.
// ============================================================
import { fechaLima, type SB } from "./herramientas";

// Precios de lista por millón de tokens (USD). Cache: escritura 1.25×in, lectura 0.1×in.
export const PRECIOS_MODELO: Record<
  string,
  { etiqueta: string; entrada: number; salida: number; cacheEscritura: number; cacheLectura: number }
> = {
  "claude-opus-4-8": { etiqueta: "Claude Opus 4.8", entrada: 5, salida: 25, cacheEscritura: 6.25, cacheLectura: 0.5 },
  "claude-sonnet-5": { etiqueta: "Claude Sonnet 5", entrada: 3, salida: 15, cacheEscritura: 3.75, cacheLectura: 0.3 },
  "claude-haiku-4-5": { etiqueta: "Claude Haiku 4.5", entrada: 1, salida: 5, cacheEscritura: 1.25, cacheLectura: 0.1 },
};

export const MODELOS_ELIA = Object.keys(PRECIOS_MODELO);
export const MODELO_DEFECTO = "claude-opus-4-8";

/** Parámetros extra según el modelo (Haiku no soporta thinking adaptativo ni effort). */
export function extrasModelo(modelo: string): Record<string, unknown> {
  if (modelo.startsWith("claude-haiku")) return {};
  return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
}

export type UsoAcumulado = {
  entrada: number;
  salida: number;
  cacheLeidos: number;
  cacheEscritos: number;
  herramientas: number;
  iteraciones: number;
};

export function usoVacio(): UsoAcumulado {
  return { entrada: 0, salida: 0, cacheLeidos: 0, cacheEscritos: 0, herramientas: 0, iteraciones: 0 };
}

export function acumularUso(acc: UsoAcumulado, usage: any) {
  acc.entrada += Number(usage?.input_tokens || 0);
  acc.salida += Number(usage?.output_tokens || 0);
  acc.cacheLeidos += Number(usage?.cache_read_input_tokens || 0);
  acc.cacheEscritos += Number(usage?.cache_creation_input_tokens || 0);
  acc.iteraciones += 1;
}

export function costoUsd(modelo: string, uso: UsoAcumulado): number {
  const p = PRECIOS_MODELO[modelo] ?? PRECIOS_MODELO[MODELO_DEFECTO];
  const usd =
    (uso.entrada * p.entrada +
      uso.salida * p.salida +
      uso.cacheLeidos * p.cacheLectura +
      uso.cacheEscritos * p.cacheEscritura) /
    1_000_000;
  return Math.round(usd * 10000) / 10000; // 4 decimales
}

export type ConfigElia = {
  ok: boolean; // false = tablas aún no creadas (correr supabase/elia-config.sql)
  activa: boolean;
  modelo: string;
  limiteMensualUsd: number; // 0 = sin límite
  avisoPct: number;
  gastoMes: number;
  mensajesMes: number;
  mes: string;
};

export async function cargarConfigElia(sb: SB): Promise<ConfigElia> {
  const mes = fechaLima().slice(0, 7);
  const base: ConfigElia = {
    ok: false,
    activa: true,
    modelo: MODELO_DEFECTO,
    limiteMensualUsd: 0,
    avisoPct: 80,
    gastoMes: 0,
    mensajesMes: 0,
    mes,
  };
  try {
    const { data: cfg, error } = await sb.from("elia_config").select("*").eq("id", 1).maybeSingle();
    if (error || !cfg) return base;
    const modelo = MODELOS_ELIA.includes((cfg as any).modelo) ? (cfg as any).modelo : MODELO_DEFECTO;
    const { data: gasto } = await sb.from("elia_gasto_mensual").select("total_usd, mensajes").eq("mes", mes).maybeSingle();
    return {
      ok: true,
      activa: (cfg as any).activa !== false,
      modelo,
      limiteMensualUsd: Number((cfg as any).limite_mensual_usd || 0),
      avisoPct: Number((cfg as any).aviso_pct || 80),
      gastoMes: Number((gasto as any)?.total_usd || 0),
      mensajesMes: Number((gasto as any)?.mensajes || 0),
      mes,
    };
  } catch {
    return base;
  }
}

/** Registra el uso de una respuesta (detalle + acumulador atómico). Silencioso si faltan las tablas. */
export async function registrarUsoElia(
  sb: SB,
  datos: { usuarioId: string; usuarioNombre: string; modelo: string; uso: UsoAcumulado }
): Promise<void> {
  const mes = fechaLima().slice(0, 7);
  const costo = costoUsd(datos.modelo, datos.uso);
  try {
    await sb.from("elia_uso").insert({
      usuario_id: datos.usuarioId,
      usuario_nombre: datos.usuarioNombre,
      modelo: datos.modelo,
      mes,
      tokens_entrada: datos.uso.entrada,
      tokens_salida: datos.uso.salida,
      tokens_cache_leidos: datos.uso.cacheLeidos,
      tokens_cache_escritos: datos.uso.cacheEscritos,
      herramientas: datos.uso.herramientas,
      iteraciones: datos.uso.iteraciones,
      costo_usd: costo,
    });
    await sb.rpc("elia_sumar_gasto", { p_mes: mes, p_costo: costo });
  } catch {
    // Tablas aún no creadas: ELIA funciona igual, solo no registra.
  }
}
