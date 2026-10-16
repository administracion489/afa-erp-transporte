// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/horario-datos.ts — LECTOR (servidor) del horario POR EMPLEADO.
//
// El motor PURO `lib/rrhh/horario.ts` combina el override de un empleado con el horario
// global campo a campo; NO lee la base. Este lector le entrega los datos: trae de
// `empleado_perfil` (rrhh-04) las 4 columnas de horario por usuario y, con ellas y el
// `ConfigRrhh` global (ya resuelto por `cargarConfigRrhh`), arma la config EFECTIVA de cada
// uno para pasársela a `calcularJornada`. Ver CLAUDE.md → "Motor PURO + lector + matriz".
//
// DEGRADACIÓN (rrhh-04 EL DEPLOY NO LA CORRE): las 4 columnas son accesorias. Si el error las
// NOMBRA se suelta SOLO la que nombra y se reintenta —el patrón de `faltaAlguna`/
// `COLUMNAS_OPCIONALES`, no un juego fijo—. Soltadas todas (o si falta la tabla entera,
// rrhh-01), no hay overrides: `sinMigracion:true` y CADA empleado hereda el global, que es
// byte a byte el comportamiento anterior (`horarioEfectivo(null, g) ≡ g`, fijado por la
// matriz de horario.ts). Una lectura que falla por OTRA causa (un CHECK, un permiso, la red)
// NO es "sin override": ABORTA, como manda el resto del ERP —una lectura fallida que se
// toma por "no hay datos" escribe o decide de menos—.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaAlguna, tablaFaltante } from "@/lib/columna-faltante";
import { horarioEfectivo, type OverrideHorario, CAMPOS_HORARIO, type CampoHorario } from "./horario";
import type { ConfigRrhh } from "./tipos";

type SB = { from: (t: string) => any };

/**
 * Los overrides de horario de un conjunto de usuarios, leídos de `empleado_perfil`. El Map
 * trae SOLO a los empleados que declararon algún campo: uno con los 4 en NULL hereda el global
 * y una entrada vacía es indistinguible de no tenerla (`horarioEfectivo({}, g) ≡ g`). Cada
 * valor crudo (el `time` "HH:MM:SS", el int) se pasa SIN normalizar: lo normaliza el motor.
 *
 * `sinMigracion:true` ⇒ no se pudo leer NINGUNA columna de horario (rrhh-04 sin correr, o falta
 * la tabla): overrides vacíos, todos heredan el global.
 */
export async function overridesHorarioDe(
  sb: SB,
  usuarioIds: string[],
): Promise<{ overrides: Map<string, OverrideHorario>; sinMigracion: boolean }> {
  const overrides = new Map<string, OverrideHorario>();
  const ids = [...new Set(usuarioIds)];
  // `.in("usuario_id", [])` es un filtro vacío ambiguo en PostgREST: sin usuarios no hay
  // nada que leer, y no es "falta la migración".
  if (ids.length === 0) return { overrides, sinMigracion: false };

  // Las 4 columnas accesorias de rrhh-04. Se sueltan de a una —LA QUE EL ERROR NOMBRA— hasta
  // que la lectura pase o no quede ninguna. `usuario_id` (de rrhh-01) viaja siempre.
  let columnas: CampoHorario[] = [...CAMPOS_HORARIO];

  for (;;) {
    const { data, error } = await sb
      .from("empleado_perfil")
      .select(["usuario_id", ...columnas].join(", "))
      .in("usuario_id", ids);

    if (error) {
      // La tabla entera falta (rrhh-01 sin correr): sin overrides, todos heredan el global.
      if (tablaFaltante(error, "empleado_perfil")) return { overrides: new Map(), sinMigracion: true };
      // Una de las 4 columnas de rrhh-04 falta: se suelta ESA y se reintenta.
      const falta = faltaAlguna(error, columnas);
      if (falta) {
        columnas = columnas.filter((c) => c !== falta);
        if (columnas.length === 0) return { overrides: new Map(), sinMigracion: true };
        continue;
      }
      // Otra causa (CHECK, permiso, red): una lectura fallida NO es "sin override". Aborta.
      throw error;
    }

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const uid = String(row.usuario_id);
      const ov: OverrideHorario = {};
      for (const c of columnas) {
        const v = row[c];
        if (v != null) (ov as Record<string, unknown>)[c] = v;
      }
      if (Object.keys(ov).length > 0) overrides.set(uid, ov);
    }
    return { overrides, sinMigracion: false };
  }
}

/**
 * La config EFECTIVA de cada usuario: `horarioEfectivo(override ?? null, cfgGlobal)`, lista
 * para `calcularJornada`. El Map trae una entrada por cada usuario pedido (deduplicado); un
 * usuario SIN override recibe una cfg idéntica campo a campo al global (`horarioEfectivo(null,
 * g) ≡ g`), así que su jornada sale byte a byte igual a la de hoy. Sin la migración, todos caen
 * al global (la degradación de `overridesHorarioDe`).
 */
export async function cfgsEfectivasDe(
  sb: SB,
  usuarioIds: string[],
  cfgGlobal: ConfigRrhh,
): Promise<Map<string, ConfigRrhh>> {
  const { overrides } = await overridesHorarioDe(sb, usuarioIds);
  const cfgs = new Map<string, ConfigRrhh>();
  for (const uid of new Set(usuarioIds)) {
    cfgs.set(uid, horarioEfectivo(overrides.get(uid) ?? null, cfgGlobal));
  }
  return cfgs;
}
