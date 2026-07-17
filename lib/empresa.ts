// Utilidades de normalización para el campo `pasajeros.empresa`.
//
// `pasajeros.empresa` es TEXTO LIBRE (no es FK a ninguna tabla). Sin una grafía
// canónica, dos variantes casi idénticas de la misma razón social — por ejemplo
// "SNACKS AMERICA LATINA S.R.L" vs "SNACKS AMERICA LATINA S.R.L." — se cuentan
// como dos empresas distintas en el filtro/agrupación de /pasajeros, esconden
// pasajeros al filtrar e inflan el KPI "Empresas".
//
// Dos capas:
//   • normalizarEmpresa(): lo que se GUARDA. Solo limpia espacios (colapsa
//     repetidos + recorta extremos). Es conservador: nunca fusiona empresas
//     legítimamente distintas, porque dos strings que solo difieren en espacios
//     son la misma entidad.
//   • claveEmpresa(): la CLAVE con la que se AGRUPA/COMPARA en la UI. Es
//     insensible a mayúsculas, espacios y puntuación de sufijo (el punto final
//     de "S.R.L."), de modo que las variantes caen en el mismo grupo aunque
//     alguna se cuele sin normalizar. Nunca se persiste; solo agrupa y compara.

export function normalizarEmpresa(raw?: string | null): string | null {
  if (raw == null) return null;
  const limpio = String(raw).replace(/\s+/g, " ").trim();
  return limpio || null;
}

// Clave de agrupamiento. Minúsculas + espacios colapsados + sin espacios/puntos/
// comas al final. Conserva la puntuación interna ("s.r.l." → "s.r.l", pero
// "e.i.r.l" queda intacto salvo por el sufijo). NO se guarda.
export function claveEmpresa(raw?: string | null): string {
  if (raw == null) return "";
  return String(raw)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[\s.,]+$/g, "");
}

export type GrupoEmpresa = { clave: string; label: string; count: number };

// Agrupa una lista de valores de empresa por su clave canónica. Para cada grupo
// elige como etiqueta la grafía MÁS FRECUENTE (la "lista mayor"), con desempate
// determinista: mayor conteo → grafía más larga (prefiere "S.R.L." con punto) →
// orden alfabético. Devuelve los grupos ordenados por etiqueta. Ignora vacíos/null.
export function agruparEmpresas(valores: Array<string | null | undefined>): GrupoEmpresa[] {
  const buckets = new Map<string, Map<string, number>>();
  for (const v of valores) {
    const label = normalizarEmpresa(v);
    if (!label) continue;
    const k = claveEmpresa(label);
    if (!k) continue;
    let m = buckets.get(k);
    if (!m) { m = new Map(); buckets.set(k, m); }
    m.set(label, (m.get(label) || 0) + 1);
  }

  const grupos: GrupoEmpresa[] = [];
  for (const [clave, m] of buckets) {
    let total = 0;
    let mejor = "";
    let mejorC = -1;
    for (const [graf, c] of m) {
      total += c;
      const gana =
        c > mejorC ||
        (c === mejorC &&
          (graf.length > mejor.length ||
            (graf.length === mejor.length && graf < mejor)));
      if (gana) { mejor = graf; mejorC = c; }
    }
    grupos.push({ clave, label: mejor, count: total });
  }
  grupos.sort((a, b) => a.label.localeCompare(b.label, "es"));
  return grupos;
}
