// ──────────────────────────────────────────────────────────────────────────────
// components/tarifario/traslados-pantalla.ts — Lo que la pantalla «Zonas y traslados» decide por
// su cuenta, en PURO (sin base ni React): el orden por sector, cómo se lee un precio tecleado, qué
// alias se rechazan y cómo se arman las filas de la tabla de precios.
//
// QUÉ ZONA, QUÉ VEHÍCULO Y QUÉ PRECIO NO SE DECIDEN AQUÍ: los decide lib/traslados/motor.ts, y esta
// pantalla lo importa. En particular, el precio «heredado» de una subzona que se enseña en gris
// sale de `tarifaDelPar`, la MISMA función con que el cotizador lo busca: si la pantalla tuviera su
// propia regla de herencia, podría decir «usa el de SJL» donde el cotizador deriva.
// Matriz: npx tsx scripts/prueba-tarifario-traslados.mts
// ──────────────────────────────────────────────────────────────────────────────

import {
  claveNombre, esGenerico, nombresDeZona, ordenarCategorias, tarifaDelPar,
  type CategoriaTraslado, type Moneda, type TarifaTraslado, type Zona,
} from "@/lib/traslados/motor";

export type ZonaFila = Zona & { notas?: string | null };
export type TarifaFila = TarifaTraslado & { id: number; notas?: string | null };
export type CategoriaFila = CategoriaTraslado;

export const MONEDAS: readonly Moneda[] = ["PEN", "USD"];
export const SIMBOLO: Record<Moneda, string> = { PEN: "S/", USD: "US$" };

/** Los sectores de Lima en el orden en que se listan. Lo que no tenga sector va a «Otros». */
export const SECTORES = ["Lima Norte", "Lima Centro", "Lima Moderna", "Lima Este", "Lima Sur", "Balnearios del Sur", "Callao"] as const;
export const SECTOR_OTROS = "Otros";
export const SECCION_PUNTOS = "📍 Puntos (geocercas)";

/** Los tres SQL de la migración, en el orden en que se corren. */
export const SQL_TRASLADOS: readonly { archivo: string; que: string }[] = [
  { archivo: "supabase/traslados-01-tablas.sql", que: "las tablas de zonas, vehículos, precios y ajustes" },
  { archivo: "supabase/traslados-02-zonas-lima.sql", que: "los 50 distritos de Lima y Callao y el aeropuerto" },
  { archivo: "supabase/traslados-03-precios-afa.sql", que: "SOLO para AFA: sus vehículos, precios y consideraciones" },
];

// ── Sectores y orden ─────────────────────────────────────────────────────────

export const mapaZonas = (zonas: readonly ZonaFila[]) => new Map(zonas.map((z) => [z.id, z]));

/** El sector con que se agrupa: el suyo; una subzona sin sector, el de su distrito; si no, «Otros». */
export function sectorDe(z: ZonaFila, porId: Map<number, ZonaFila>): string {
  const propio = String(z.sector ?? "").trim();
  if (propio) return propio;
  if (z.tipo === "subzona" && z.padre_id != null) {
    const p = String(porId.get(z.padre_id)?.sector ?? "").trim();
    if (p) return p;
  }
  return SECTOR_OTROS;
}

/** Los siete de Lima primero (en su orden), después los que escribió alguien (alfabético), «Otros» al final. */
export function compararSectores(a: string, b: string): number {
  const rango = (s: string) => {
    const i = (SECTORES as readonly string[]).indexOf(s);
    return i >= 0 ? i : s === SECTOR_OTROS ? 1000 : 500;
  };
  return rango(a) - rango(b) || a.localeCompare(b, "es");
}

/**
 * Orden de una lista de zonas: puntos primero, luego por sector, por el orden del distrito y por su
 * nombre; una subzona va inmediatamente detrás de su distrito (se ordena con el «ancla» del padre).
 */
export function compararZonas(a: ZonaFila, b: ZonaFila, porId: Map<number, ZonaFila>): number {
  const ancla = (z: ZonaFila) => (z.tipo === "subzona" && z.padre_id != null ? porId.get(z.padre_id) : undefined) ?? z;
  const aa = ancla(a);
  const ab = ancla(b);
  return (a.tipo === "punto" ? 0 : 1) - (b.tipo === "punto" ? 0 : 1)
    || compararSectores(sectorDe(a, porId), sectorDe(b, porId))
    || (Number(aa.orden) || 0) - (Number(ab.orden) || 0)
    || claveNombre(aa.nombre).localeCompare(claveNombre(ab.nombre), "es")
    || aa.id - ab.id
    || (a.tipo === "subzona" ? 1 : 0) - (b.tipo === "subzona" ? 1 : 0)
    || (Number(a.orden) || 0) - (Number(b.orden) || 0)
    || claveNombre(a.nombre).localeCompare(claveNombre(b.nombre), "es")
    || a.id - b.id;
}

export function ordenarZonas(zonas: readonly ZonaFila[], porId = mapaZonas(zonas)): ZonaFila[] {
  return zonas.slice().sort((a, b) => compararZonas(a, b, porId));
}

/** La sección del buscador: los puntos juntos y primero, el resto por sector. */
export const seccionBuscador = (z: ZonaFila, porId: Map<number, ZonaFila>) =>
  z.tipo === "punto" ? SECCION_PUNTOS : sectorDe(z, porId);

/** ¿La zona coincide con lo buscado? Por su nombre, sus alias y, si es subzona, el nombre de su distrito. */
export function coincideZona(z: ZonaFila, q: string, porId: Map<number, ZonaFila>): boolean {
  const k = claveNombre(q);
  if (!k) return true;
  const nombres = nombresDeZona(z);
  if (z.tipo === "subzona" && z.padre_id != null) {
    const p = porId.get(z.padre_id);
    if (p) nombres.push(...nombresDeZona(p));
  }
  return nombres.some((n) => n.includes(k));
}

/** Nombre corto para una celda estrecha: un alias en siglas (SJL, VES) si lo hay; si no, el nombre. */
export function nombreCorto(z: Pick<Zona, "nombre" | "alias">): string {
  const sigla = (z.alias ?? []).find((a) => /^[A-ZÁÉÍÓÚÑ]{2,5}$/.test(String(a).trim()));
  return sigla ? sigla.trim() : z.nombre;
}

// ── Precios tecleados ────────────────────────────────────────────────────────

export type LecturaPrecio =
  | { tipo: "vacio" }
  | { tipo: "ok"; valor: number }
  | { tipo: "error"; detalle: string };

export const PRECIO_MAX = 1_000_000;

/**
 * Un precio escrito a mano. VACÍO NO ES CERO: una celda vacía significa «sin precio» (y al guardar
 * BORRA la fila), nunca S/ 0.00 — un traslado cotizado en cero se enviaría como gratis.
 * Acepta «120», «120.50», «120,50» y «1,200» (coma de miles con grupos de 3).
 */
export function leerPrecio(texto: string): LecturaPrecio {
  const s = String(texto ?? "").trim().replace(/\s+/g, "").replace(/^(us\$|s\/|\$)/i, "");
  if (!s) return { tipo: "vacio" };
  let n = s;
  if (s.includes(",") && s.includes(".")) n = s.replace(/,/g, "");
  else if (s.includes(",")) n = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(n)) return { tipo: "error", detalle: `«${texto.trim()}» no es un precio: escribe solo el número (p. ej. 120 o 120.50).` };
  const v = Number(n);
  if (!(v > 0)) return { tipo: "error", detalle: "El precio tiene que ser mayor que 0. Para quitarlo, deja la celda vacía." };
  if (v >= PRECIO_MAX) return { tipo: "error", detalle: "Ese precio es demasiado alto: revisa si sobra un dígito." };
  return { tipo: "ok", valor: Math.round(v * 100) / 100 };
}

/** Cómo se enseña un precio dentro de un campo: entero sin decimales, si no con dos. */
export const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export const fmtMoneda = (n: number, m: Moneda) =>
  `${SIMBOLO[m]} ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** «2026-10-20» → «20/10/2026». Lo que no es fecha se devuelve tal cual. */
export function fmtFecha(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso ?? "");
}

/** Un entero tecleado: vacío → null; lo que no es entero en el rango → error. */
export function leerEntero(texto: string, min: number, max: number): { tipo: "vacio" } | { tipo: "ok"; valor: number } | { tipo: "error"; detalle: string } {
  const s = String(texto ?? "").trim();
  if (!s) return { tipo: "vacio" };
  if (!/^-?\d+$/.test(s)) return { tipo: "error", detalle: `«${s}» no es un número entero.` };
  const v = Number(s);
  if (v < min || v > max) return { tipo: "error", detalle: `Tiene que estar entre ${min} y ${max}.` };
  return { tipo: "ok", valor: v };
}

// ── Alias ────────────────────────────────────────────────────────────────────

/**
 * Por qué NO se agrega un alias, o null si se puede. Las reglas salen de cómo el motor compara:
 * nombre COMPLETO normalizado, nunca «contiene».
 *  · Un nombre genérico («Lima», «Perú», «Provincia de Lima») no identifica un distrito: Google lo
 *    usa para direcciones de varios (San Isidro, Lince…), y leerlo como uno solo cotizaría el
 *    distrito equivocado. Es la lista NOMBRES_GENERICOS del motor.
 *  · Dos distritos con el mismo nombre o alias harían que el cotizador eligiera el primero que
 *    encuentra; dos subzonas del mismo distrito, igual.
 */
export function motivoAliasInvalido(
  alias: string,
  zona: { id?: number | null; tipo: Zona["tipo"]; padre_id?: number | null; nombre: string },
  actuales: readonly string[],
  zonas: readonly ZonaFila[],
): string | null {
  const a = String(alias ?? "").trim();
  const k = claveNombre(a);
  if (!k) return "Escribe el alias.";
  if (esGenerico(a)) {
    return `«${a}» no se agrega: Google lo usa para direcciones de varios distritos (San Isidro, Lince, Cercado…), y leerlo como uno solo cotizaría el distrito equivocado.`;
  }
  if (claveNombre(zona.nombre) === k || actuales.some((x) => claveNombre(x) === k)) return `«${a}» ya está.`;
  const rivales = zonas.filter((z) => {
    if (zona.id != null && z.id === zona.id) return false;
    if (zona.tipo === "distrito") return z.tipo === "distrito";
    if (zona.tipo === "subzona") return z.tipo === "subzona" && z.padre_id === zona.padre_id;
    return false; // un punto se reconoce por su geocerca, no por el nombre
  });
  const choca = rivales.find((z) => nombresDeZona(z).includes(k));
  if (choca) {
    return zona.tipo === "subzona"
      ? `«${a}» ya identifica a la subzona «${choca.nombre}»: una dirección con ese barrio no sabría a cuál ir.`
      : `«${a}» ya es el nombre o un alias de «${choca.nombre}»: con el mismo nombre en dos distritos, el cotizador elegiría uno al azar.`;
  }
  return null;
}

/** ¿Hay otra zona con el mismo nombre (sin tildes ni mayúsculas)? */
export function nombreRepetido(nombre: string, zonas: readonly ZonaFila[], propioId?: number | null): ZonaFila | null {
  const k = claveNombre(nombre);
  if (!k) return null;
  return zonas.find((z) => z.id !== propioId && claveNombre(z.nombre) === k) ?? null;
}

// ── La tabla de precios de una zona de origen ────────────────────────────────

export const claveCelda = (categoria: string, moneda: Moneda) => `${categoria}|${moneda}`;

export type Heredada = { precio: number; de: string; titulo: string };

export type CeldaPrecio = { exacta: TarifaFila | null; heredada: Heredada | null };

export type FilaPrecio = {
  zona: ZonaFila;
  /** 1 = subzona colgada bajo su distrito, sin precio propio (se enseña lo que hereda). */
  nivel: 0 | 1;
  celdas: Record<string, CeldaPrecio>;
  exactas: TarifaFila[];
  /** La zona de origen consigo misma («dentro de Miraflores»). */
  mismaZona: boolean;
};

export type BloquePrecio =
  | { tipo: "fila"; fila: FilaPrecio }
  | { tipo: "grupo"; clave: string; filas: FilaPrecio[] };

/** La otra punta de una tarifa si toca a `id`; null si no. */
export function otraPunta(t: { zona_a_id: number; zona_b_id: number }, id: number): number | null {
  if (t.zona_a_id === id) return t.zona_b_id;
  if (t.zona_b_id === id) return t.zona_a_id;
  return null;
}

function celdasDe(
  origen: ZonaFila, destino: ZonaFila, cats: readonly CategoriaFila[],
  exactasPar: readonly TarifaFila[], tarifas: readonly TarifaTraslado[], zonas: readonly ZonaFila[],
): Record<string, CeldaPrecio> {
  const out: Record<string, CeldaPrecio> = {};
  for (const c of cats) {
    for (const m of MONEDAS) {
      const exacta = exactasPar.find((t) => t.categoria === c.clave && t.moneda === m) ?? null;
      let heredada: Heredada | null = null;
      if (!exacta || exacta.activo === false) {
        // La herencia la decide el MOTOR, con la misma función con que el cotizador busca el precio.
        const f = tarifaDelPar(origen, destino, c.clave, m, tarifas, zonas);
        if (f && f.nivel === "por_distrito") {
          const usadas: string[] = [];
          if (f.zona_a.id !== origen.id) usadas.push(nombreCorto(f.zona_a));
          if (f.zona_b.id !== destino.id) usadas.push(nombreCorto(f.zona_b));
          const sin = [f.zona_a.id !== origen.id ? origen.nombre : null, f.zona_b.id !== destino.id ? destino.nombre : null].filter(Boolean).join(" y ");
          heredada = {
            precio: Number(f.tarifa.precio_tramo),
            de: usadas.join(" y "),
            titulo: `Usa el precio de ${f.zona_a.nombre} ↔ ${f.zona_b.nombre} (${fmtMoneda(Number(f.tarifa.precio_tramo), m)}): ${sin} no tiene uno propio. Escribe un precio para darle uno.`,
          };
        }
      }
      out[claveCelda(c.clave, m)] = { exacta, heredada };
    }
  }
  return out;
}

/**
 * Las filas de la tabla de una zona de origen: una por zona con la que tiene precio (propio, o
 * heredado si el origen es una subzona), y debajo de cada distrito sus subzonas SIN precio propio,
 * con lo que heredan en gris. Las filas cuyos precios son idénticos se juntan en un grupo
 * («Miraflores · San Isidro · Barranco»), salvo la de la misma zona y las que tienen subzonas debajo.
 */
export function bloquesDePrecios(
  origenId: number,
  zonas: readonly ZonaFila[],
  tarifas: readonly TarifaFila[],
  categorias: readonly CategoriaFila[],
): BloquePrecio[] {
  const porId = mapaZonas(zonas);
  const origen = porId.get(origenId);
  if (!origen) return [];
  const cats = ordenarCategorias(categorias);

  const exactasDe = new Map<number, TarifaFila[]>();
  for (const t of tarifas) {
    const o = otraPunta(t, origenId);
    if (o == null) continue;
    (exactasDe.get(o) ?? exactasDe.set(o, []).get(o)!).push(t);
  }
  const otros = new Set<number>(exactasDe.keys());
  // Si el origen es una subzona, también las zonas con las que su DISTRITO tiene precio: los hereda.
  if (origen.tipo === "subzona" && origen.padre_id != null) {
    for (const t of tarifas) {
      const o = otraPunta(t, origen.padre_id);
      if (o != null) otros.add(o);
    }
  }

  const principales = ordenarZonas([...otros].map((id) => porId.get(id)).filter((z): z is ZonaFila => !!z), porId);
  const filas: FilaPrecio[] = [];
  for (const z of principales) {
    const exactas = exactasDe.get(z.id) ?? [];
    filas.push({ zona: z, nivel: 0, celdas: celdasDe(origen, z, cats, exactas, tarifas, zonas), exactas, mismaZona: z.id === origenId });
    if (z.tipo === "distrito") {
      const hijas = ordenarZonas(zonas.filter((s) => s.tipo === "subzona" && s.padre_id === z.id && !otros.has(s.id) && s.id !== origenId), porId);
      for (const s of hijas) {
        filas.push({ zona: s, nivel: 1, celdas: celdasDe(origen, s, cats, [], tarifas, zonas), exactas: [], mismaZona: false });
      }
    }
  }

  // Agrupar las idénticas: misma firma de precios propios, sin nada heredado y sin hijas debajo.
  const conHijas = new Set(filas.filter((f) => f.nivel === 1).map((f) => f.zona.padre_id));
  const firma = (f: FilaPrecio): string | null => {
    if (f.nivel !== 0 || f.mismaZona || conHijas.has(f.zona.id) || f.exactas.length === 0) return null;
    if (Object.values(f.celdas).some((c) => c.heredada)) return null;
    return f.exactas
      .map((t) => `${t.categoria}|${t.moneda}|${Number(t.precio_tramo).toFixed(2)}|${t.activo === false ? 0 : 1}`)
      .sort()
      .join(";");
  };
  const porFirma = new Map<string, FilaPrecio[]>();
  for (const f of filas) {
    const k = firma(f);
    if (k) (porFirma.get(k) ?? porFirma.set(k, []).get(k)!).push(f);
  }
  const bloques: BloquePrecio[] = [];
  const puestos = new Set<string>();
  for (const f of filas) {
    const k = firma(f);
    const grupo = k ? porFirma.get(k)! : null;
    if (grupo && grupo.length >= 2) {
      if (puestos.has(k!)) continue;
      puestos.add(k!);
      bloques.push({ tipo: "grupo", clave: grupo.map((g) => g.zona.id).join("-"), filas: grupo });
    } else {
      bloques.push({ tipo: "fila", fila: f });
    }
  }
  return bloques;
}

/** Cuántas tarifas (de cualquier categoría y moneda) toca cada zona: para elegir el origen por defecto. */
export function tarifasPorZona(tarifas: readonly { zona_a_id: number; zona_b_id: number }[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of tarifas) {
    m.set(t.zona_a_id, (m.get(t.zona_a_id) ?? 0) + 1);
    if (t.zona_b_id !== t.zona_a_id) m.set(t.zona_b_id, (m.get(t.zona_b_id) ?? 0) + 1);
  }
  return m;
}

// ── Ajustes ──────────────────────────────────────────────────────────────────

/**
 * Las consideraciones son texto libre que escribe una persona, y una de ellas suele nombrar los
 * minutos de espera. Si el número del ajuste y el del texto no coinciden, la cotización diría dos
 * cosas distintas: se avisa (no se corrige: el texto es de quien lo escribió).
 */
export function minutosQueNoCoinciden(consideraciones: readonly string[], esperaMin: number): number[] {
  const out = new Set<number>();
  for (const c of consideraciones) {
    for (const m of String(c).matchAll(/(\d+)\s*min/gi)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n !== esperaMin) out.add(n);
    }
  }
  return [...out];
}

/** Clave de una categoría nueva: MAYÚSCULAS, sin tildes, espacios como «_», solo A-Z, 0-9 y «_». */
export function normalizarClaveCategoria(s: string): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 30);
}
