// ──────────────────────────────────────────────────────────────────────────────
// components/tarifario/traslados-pantalla.ts — Lo que la pantalla «Zonas y traslados» decide por
// su cuenta, en PURO (sin base ni React): el orden por sector, cómo se lee un precio tecleado, qué
// alias se rechazan y cómo se arman las filas de la tabla de precios. Y, desde cotizaciones-05, qué
// condiciones del PDF del traslado enseñan Ajustes y el Simulador (`condicionesTrasladoIA`,
// `condicionesDelSimulador`): la plantilla la elige `plantillaParaUso`, no esta pantalla. Desde
// cotizaciones-09 la regla del traslado es IDIOMA × MONEDA (cuatro celdas) y la elige
// `plantillaTrasladoIA`; si el inglés está encendido lo dice `inglesDisponible` (`lineasInglesIA`), y
// el idioma que el simulador probó lo dice `idiomaDelSimulador`, con la MISMA detección que el chat
// (`idiomaDelCliente`, lib/idioma-cliente.ts).
//
// QUÉ ZONA, QUÉ VEHÍCULO Y QUÉ PRECIO NO SE DECIDEN AQUÍ: los decide lib/traslados/motor.ts, y esta
// pantalla lo importa. En particular, el precio «heredado» de una subzona que se enseña en gris
// sale de `tarifaDelPar`, la MISMA función con que el cotizador lo busca: si la pantalla tuviera su
// propia regla de herencia, podría decir «usa el de SJL» donde el cotizador deriva.
// Matriz: npx tsx scripts/prueba-tarifario-traslados.mts
// ──────────────────────────────────────────────────────────────────────────────

import {
  claveNombre, esGenerico, monedaDelPedido, nombresDeZona, ordenarCategorias, tarifaDelPar,
  type CategoriaTraslado, type CodigoMoneda, type Moneda, type TarifaTraslado, type Zona,
} from "@/lib/traslados/motor";
import { zonaConEnvio } from "@/lib/traslados/envio-ia";
import { BUCKETS_PRIVADOS } from "@/lib/storage-privado";
import {
  CELDAS_TRASLADO, ETIQUETA_SEGMENTO, esIdPlantillaValido, etiquetaCelda, etiquetaCeldaTraslado, inglesActivo, inglesDisponible, plantillaParaUso,
  plantillaTrasladoIA, SEGMENTOS, SQL_PLANTILLAS_USO, SQL_REGLAS_TRASLADO,
  type CeldaTraslado, type CodigoUso, type InglesTraslado, type PlantillaFila, type ReglaPlantilla, type ReglaTraslado, type Segmento,
} from "@/lib/cotizacion-plantillas";
import { considDeTraslado, MAX_DESCRIPCION_CLIENTE, MAX_RENGLONES_CLIENTE, normalizarDescripcionCliente } from "@/lib/traslados/cotizacion-traslado";
import { idiomaDelCliente, type CodigoIdiomaCliente, type IdiomaCliente } from "@/lib/idioma-cliente";

/** `envio_automatico` es de traslados-05: sin esa migración llega `undefined`, que es «no». */
export type ZonaFila = Zona & { notas?: string | null; envio_automatico?: boolean | null };
export type TarifaFila = TarifaTraslado & { id: number; notas?: string | null };
/**
 * Las tres primeras son de traslados-07 (lo que el PDF de la IA enseña de la categoría): sin esa
 * migración llegan `null` y la pantalla lo dice nombrando el SQL. `descripcion_cliente_en` es de
 * traslados-10 (la descripción EN INGLÉS, aparte: que falte no apaga las fotos). El motor no las lee.
 */
export type CategoriaFila = CategoriaTraslado & {
  foto_externa_url?: string | null;
  foto_interna_url?: string | null;
  descripcion_cliente?: string | null;
  descripcion_cliente_en?: string | null;
};

/** La migración que agrega las fotos y la descripción de la categoría, y las listas Incluye / No incluye. */
export const SQL_FOTOS_CATEGORIA = "supabase/traslados-07-fotos-categoria.sql";
/** La migración que agrega la descripción de la categoría EN INGLÉS (la del PDF de una cotización en inglés). */
export const SQL_DESCRIPCION_INGLES = "supabase/traslados-10-descripcion-ingles.sql";

export const MONEDAS: readonly Moneda[] = ["PEN", "USD"];
export const SIMBOLO: Record<Moneda, string> = { PEN: "S/", USD: "US$" };

/** Los sectores de Lima en el orden en que se listan. Lo que no tenga sector va a «Otros». */
export const SECTORES = ["Lima Norte", "Lima Centro", "Lima Moderna", "Lima Este", "Lima Sur", "Balnearios del Sur", "Callao"] as const;
export const SECTOR_OTROS = "Otros";
export const SECCION_PUNTOS = "📍 Puntos (geocercas)";

/** La migración que agrega los interruptores de la IA del CRM (fase 2). */
export const SQL_COTIZACION_IA = "supabase/traslados-05-cotizacion-ia.sql";

/** Los SQL de la migración, en el orden en que se corren (traslados-05 exige traslados-04). */
export const SQL_TRASLADOS: readonly { archivo: string; que: string }[] = [
  { archivo: "supabase/traslados-01-tablas.sql", que: "las tablas de zonas, vehículos, precios y ajustes" },
  { archivo: "supabase/traslados-02-zonas-lima.sql", que: "los 50 distritos de Lima y Callao y el aeropuerto" },
  { archivo: "supabase/traslados-03-precios-afa.sql", que: "SOLO para AFA: sus vehículos, precios y consideraciones" },
  { archivo: "supabase/traslados-04-tipo-cambio-solo-servidor.sql", que: "que el tipo de cambio y el IGV los escriba solo el servidor (o Tesorería)" },
  { archivo: SQL_COTIZACION_IA, que: "los interruptores de la IA del CRM (cotizar y enviar sola); su último bloque es SOLO para AFA y enciende el envío automático del aeropuerto" },
  { archivo: SQL_FOTOS_CATEGORIA, que: "las fotos y la descripción de cada vehículo para el PDF de la cotización, y las listas Incluye / No incluye" },
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

// ── Envío automático de la cotización (fase 2) ───────────────────────────────
// QUÉ ZONA TIENE ENVÍO LO DECIDE `zonaConEnvio` (lib/traslados/envio-ia.ts), la MISMA función con
// que el agente decide si el PDF sale solo: una subzona hereda de su distrito activo. Aquí solo se
// traduce a lo que se pinta y a las frases de las confirmaciones.

export type EnvioZona =
  | { codigo: "propio" }                     // marcada y activa: sale sola
  | { codigo: "hereda"; distrito: string }   // subzona sin marca propia: hereda de su distrito
  | { codigo: "sin_efecto" }                 // marcada pero inactiva: el cotizador no la reconoce
  | { codigo: "no" };

export function envioDeZona(z: ZonaFila, zonas: readonly ZonaFila[]): EnvioZona {
  const efectivo = zonaConEnvio(z, zonas);
  const propio = z.envio_automatico === true;
  if (efectivo && propio) return { codigo: "propio" };
  if (efectivo) return { codigo: "hereda", distrito: zonas.find((x) => x.id === z.padre_id)?.nombre ?? "su distrito" };
  if (propio) return { codigo: "sin_efecto" };
  return { codigo: "no" };
}

/** Las zonas que tienen marcada la casilla y la aplican (las que se nombran en Ajustes). */
export function zonasConEnvioPropio(zonas: readonly ZonaFila[]): ZonaFila[] {
  return ordenarZonas(zonas.filter((z) => envioDeZona(z, zonas).codigo === "propio"));
}

/** Las subzonas que salen solas sin tener la casilla, porque su distrito la tiene. */
export function subzonasQueHeredan(zonas: readonly ZonaFila[]): ZonaFila[] {
  return zonas.filter((z) => envioDeZona(z, zonas).codigo === "hereda");
}

const listaY = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`);

/** El confirm() de encender el MAESTRO del envío automático: dice qué zonas salen sin revisión. */
export function mensajeEncenderEnvio(x: { zonas: readonly string[]; iaCotiza: boolean }): string {
  const partes = ["¿Encender el envío automático de cotizaciones de traslado?"];
  if (x.zonas.length === 0) {
    partes.push("Ninguna zona tiene marcado «📄 Envío automático de la cotización»: hasta que marques una en la pestaña Zonas, todo seguirá quedando en revisión.");
  } else {
    partes.push(`Las cotizaciones de traslado cuyo recojo o destino sea ${listaY(x.zonas)} saldrán al cliente por WhatsApp SIN que un ejecutivo las revise: el PDF con el precio del tarifario, armado y enviado por el sistema.`);
    partes.push("Las demás seguirán quedando en el inbox del CRM para que un ejecutivo las revise y las envíe.");
  }
  if (!x.iaCotiza) partes.push("Ojo: la casilla «La IA cotiza traslados» está apagada, así que por ahora no sale nada.");
  return partes.join("\n\n");
}

/** El confirm() de encender «La IA cotiza traslados». */
export function mensajeEncenderIA(x: { envioMaestro: boolean; zonas: readonly string[] }): string {
  const partes = [
    "¿Encender la cotización de traslados por la IA del CRM?",
    "La IA cotizará por WhatsApp los traslados simples (un recojo y un destino, solo ida o ida y retorno) con el precio de este tarifario y creará la cotización en /cotizaciones. Lo complejo (TDR, licitaciones, eventos, varios servicios, descuentos) lo pasa a un ejecutivo, y la disponibilidad y la reserva las confirma siempre un ejecutivo.",
  ];
  if (x.envioMaestro && x.zonas.length > 0) {
    partes.push(`Con el envío automático encendido, las de ${listaY(x.zonas)} le llegan al cliente SIN revisión; las demás quedan en el inbox para que un ejecutivo las envíe.`);
  } else {
    partes.push("El envío automático está apagado (o sin zonas marcadas): cada cotización queda en el inbox del CRM para que un ejecutivo la revise y la envíe.");
  }
  return partes.join("\n\n");
}

/**
 * El confirm() de marcar el envío automático en UNA zona: nombra la zona, las subzonas que lo
 * heredan si es un distrito, y si el maestro de Ajustes lo deja salir hoy o no.
 */
export function mensajeEnvioZona(z: { id: number | null; nombre: string; tipo: Zona["tipo"] }, zonas: readonly ZonaFila[], envioMaestro: boolean): string {
  const hijas = z.tipo === "distrito" && z.id != null ? zonas.filter((s) => s.tipo === "subzona" && s.padre_id === z.id && s.activo !== false) : [];
  const donde = hijas.length > 0 ? `«${z.nombre}» (y sus ${hijas.length} subzona${hijas.length === 1 ? "" : "s"}, que lo heredan)` : `«${z.nombre}»`;
  const partes = [
    `¿Marcar el envío automático en ${donde}?`,
    `Las cotizaciones de traslado cuyo recojo o destino esté en ${donde} saldrán al cliente por WhatsApp SIN que un ejecutivo las revise.`,
  ];
  partes.push(envioMaestro
    ? "El envío automático está encendido en Ajustes: aplica desde que guardes."
    : "Hoy el envío automático está apagado en Ajustes: la marca queda guardada y empieza a valer cuando se encienda.");
  return partes.join("\n\n");
}

// ── Las condiciones del PDF del traslado de la IA (cotizaciones-05 y -09) ────
// Desde supabase/cotizaciones-05 las condiciones del PDF del traslado salen de la plantilla de la
// regla «Traslado de la IA × segmento» (lib/traslados/plantilla-traslado-datos.ts), no de Ajustes; y
// desde cotizaciones-09, de la regla IDIOMA × MONEDA (cuatro celdas: castellano o inglés, en soles o
// en dólares). QUÉ PLANTILLA usa cada celda lo decide `plantillaTrasladoIA` (sin cotizaciones-09,
// `plantillaParaUso`): el MISMO motor que usa la IA. QUÉ LISTAS se copian a la fila lo decide
// `considDeTraslado` (lib/traslados/cotizacion-traslado.ts), la MISMA función que usa
// `filaCotizacionTraslado`: la pantalla no tiene su propia copia. La matriz cruza además
// `condicionesTrasladoIA` contra esa fila, celda por celda.
//
// MIENTRAS ALGUNA CELDA CAIGA A LAS LISTAS DE AJUSTES (sin una plantilla que la IA pueda usar),
// esas listas se siguen EDITANDO en Ajustes: las lee la IA (`listasDeAjustesEnUso`). Solo las que no
// lee nadie dejan de ofrecerse y de guardarse.
//
// UNA CELDA «INGLÉS» NUNCA CAE POR SU CUENTA A LAS LISTAS DE AJUSTES (están en castellano): sin una
// plantilla en inglés que sirva, cae a lo que use la celda CASTELLANO de su misma moneda y la
// cotización queda en revisión (`sin_plantilla_idioma`). Por eso las celdas «inglés» no deciden qué
// listas de Ajustes se ofrecen; si su castellano cae a Ajustes, el aviso lo dice así. Con el inglés
// APAGADO (`inglesDisponible`: ninguna celda «inglés» con una plantilla en inglés que sirva), las
// celdas «inglés» no las usa ninguna cotización: se enseñan en gris, nunca en ámbar.

/** Lo que `traslados_config` aporta a las condiciones (las cuatro listas de antes de cotizaciones-05). */
export type ConfigCondiciones = {
  consideraciones: readonly string[];
  consideraciones_usd: readonly string[];
  incluye?: readonly string[] | null;
  no_incluye?: readonly string[] | null;
};

/** Una lista del PDF tal como la copia la IA. `propia: false` = la plantilla no la tiene (NULL): el PDF sale sin ella. */
export type ListaCondicion = { items: string[]; propia: boolean };

/**
 * Cómo resolvió el motor UNA celda de la regla del traslado. Con la regla vieja (sin
 * cotizaciones-09) la celda es un SEGMENTO (`segmento`); con la nueva, IDIOMA × MONEDA (`celda`).
 * `detalle` es la frase entera del motor; `porque`, la misma sin el nombre de la celda delante (la
 * pantalla ya lo pone). `ambar`: contradice lo configurado (o no hay una plantilla que la IA pueda
 * usar). `sinUso`: una celda «inglés» con el inglés apagado — hoy no la usa ninguna cotización.
 */
export type UsoCeldaIA = {
  segmento: Segmento | null;
  celda: CeldaTraslado | null;
  /** Identidad estable: el segmento («empresa») o la celda («en|USD»). */
  clave: string;
  /** Para los títulos: «Empresa», «Inglés · dólares». */
  etiqueta: string;
  /** Para las frases: «empresa», «inglés · dólares». */
  nombre: string;
  /** Se cotiza en dólares: lo que copia de Ajustes lleva las líneas solo para dólares. */
  usd: boolean;
  codigo: CodigoUso;
  detalle: string;
  porque: string;
  ambar: boolean;
  sinUso: boolean;
};

/**
 * Las celdas que comparten la MISMA fuente de condiciones (empresa y particular suelen llevar la
 * misma plantilla; una celda «inglés» sin plantilla en inglés, la de su castellano): se enseñan una
 * vez. `fuente.tipo === "ajustes"`: no hay una plantilla que la IA pueda usar en esas celdas y la IA
 * copia las de `traslados_config` (en dólares, con las de dólares).
 */
export type GrupoCondicionesIA = {
  clave: string;
  fuente: { tipo: "plantilla"; plantilla: PlantillaFila } | { tipo: "ajustes"; usd: boolean };
  usos: UsoCeldaIA[];
  generales: ListaCondicion;
  incluye: ListaCondicion;
  no_incluye: ListaCondicion;
  /**
   * La política de reserva, cambios y cancelación (cotizaciones-06): la que la IA envía al cliente y
   * el PDF imprime. Solo existe en una plantilla: en las listas de Ajustes no hay (`propia: false`).
   */
  reserva: ListaCondicion;
  /**
   * Su resumen (cotizaciones-08): lo que el PDF y el WhatsApp mandan EN LUGAR de la política cuando
   * va el enlace a las condiciones completas. Solo con política; `propia: false` = la plantilla no lo
   * tiene (la política va entera).
   */
  reserva_resumen: ListaCondicion;
};

/**
 * Las líneas de la política Y de su resumen de un grupo: lo que se coteja con la configuración
 * (`politicaContradiceConfig`): el resumen también lo recibe el cliente.
 */
export function lineasPoliticaYResumen(g: Pick<GrupoCondicionesIA, "reserva" | "reserva_resumen">): string[] {
  return [...g.reserva.items, ...g.reserva_resumen.items];
}

/**
 * Los códigos del motor que pintan ámbar: la configuración dice una cosa y la IA hace otra (o falta
 * el SQL). `sin_plantilla_idioma` también: la cotización en inglés sale con condiciones en
 * castellano y queda en revisión (solo cuando el inglés está encendido: si no, la celda no se usa).
 */
const USO_AMBAR: readonly CodigoUso[] = ["regla_inactiva", "regla_no_sirve_ia", "sin_plantilla", "sin_reglas", "sin_plantilla_idioma"];
export const usoEsAmbar = (c: CodigoUso): boolean => USO_AMBAR.includes(c);

const nombreSegmento = (s: Segmento): string => etiquetaCelda({ servicio: "traslado_ia", segmento: s }).split(" · ")[1] ?? s;
/** «inglés · dólares»: la celda sin «Traslado de la IA» delante. */
const nombreCeldaTraslado = (c: CeldaTraslado): string => etiquetaCeldaTraslado(c).split(" · ").slice(1).join(" · ");
const mayuscula = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
/** Sin el «Traslado de la IA · …: » con que el motor empieza la frase. */
const sinPrefijo = (detalle: string, prefijo: string): string => (detalle.startsWith(prefijo) ? detalle.slice(prefijo.length) : detalle);

/** La celda castellano de la misma moneda, adonde cae una celda «inglés» sin plantilla en inglés. */
export const celdaCastellanoDe = (c: CeldaTraslado): CeldaTraslado => ({ idioma: "es", moneda: c.moneda });

/**
 * La frase con que el motor (`plantillaTrasladoIA`) dice, en `sin_plantilla_idioma`, que no hay una
 * plantilla en inglés: lo que va ANTES es por qué no se obedece la celda («sin regla.», «la regla
 * apunta a…»). La matriz exige que toda frase de ese código la traiga.
 */
export const MARCA_SIN_PLANTILLA_INGLES = " No hay una plantilla en inglés que la IA pueda usar.";

/**
 * El porqué de una celda «inglés» sin plantilla en inglés, dicho como lo que es: NO cae a las listas
 * de Ajustes por su cuenta, cae a la celda CASTELLANO de su misma moneda (con lo que esa use: su
 * plantilla, o las listas de Ajustes) y la cotización queda en revisión. El código lo decide el motor;
 * aquí solo se redacta, con la razón que dio el motor delante.
 */
function porqueSinIngles(detalle: string, prefijo: string, celda: CeldaTraslado, plantilla: PlantillaFila | null): string {
  const texto = sinPrefijo(detalle, prefijo);
  const i = texto.indexOf(MARCA_SIN_PLANTILLA_INGLES);
  const razon = i > 0 ? `${texto.slice(0, i)} ` : "";
  const fuente = plantilla ? `plantilla «${plantilla.nombre || plantilla.id}»` : "las listas de Ajustes de traslados";
  return `${razon}No hay una plantilla en inglés que la IA pueda usar: cae a ${nombreCeldaTraslado(celdaCastellanoDe(celda))} (${fuente}), con las condiciones en castellano, y la cotización queda en revisión.`;
}

/**
 * Qué condiciones copia la IA a la fila en cada celda, CON reglas. Dos modos, según la tabla que
 * exista:
 *  · `reglasTraslado` (cotizaciones-09): las cuatro celdas idioma × moneda (`plantillaTrasladoIA`).
 *    Las de inglés con el inglés apagado van con `sinUso` (gris, sin ámbar).
 *  · Sin ella (`reglasTraslado === null`): los tres segmentos de la regla vieja (`plantillaParaUso`),
 *    byte a byte lo de antes. Ahí `extranjero` es SIEMPRE en dólares y los otros dos en soles
 *    (`segmentoDeCliente`: la moneda manda), así que el respaldo de Ajustes de `extranjero` lleva las
 *    líneas de dólares.
 * Sin ninguna regla no se llama: Ajustes edita sus listas como antes.
 */
export function condicionesTrasladoIA(
  plantillas: readonly PlantillaFila[],
  reglas: readonly ReglaPlantilla[] | null,
  config: ConfigCondiciones,
  reglasTraslado: readonly ReglaTraslado[] | null = null,
): GrupoCondicionesIA[] {
  const grupos: GrupoCondicionesIA[] = [];
  const agregar = (uso: UsoCeldaIA, plantilla: PlantillaFila | null, moneda: Moneda) => {
    const clave = plantilla ? `plantilla:${plantilla.id}` : `ajustes:${moneda === "USD" ? "usd" : "pen"}`;
    const ya = grupos.find((g) => g.clave === clave);
    if (ya) { ya.usos.push(uso); return; }
    // Lo que la IA copia a la fila: la MISMA función que usa `filaCotizacionTraslado`.
    const c = considDeTraslado(plantilla, config, moneda);
    const p = plantilla;
    grupos.push({
      clave, fuente: p ? { tipo: "plantilla", plantilla: p } : { tipo: "ajustes", usd: moneda === "USD" }, usos: [uso],
      generales: { items: c.generales, propia: p ? Array.isArray(p.condiciones_generales) : true },
      incluye: { items: c.incluye, propia: p ? Array.isArray(p.condiciones_incluye) : true },
      no_incluye: { items: c.no_incluye, propia: p ? Array.isArray(p.condiciones_no_incluye) : true },
      reserva: { items: c.reserva ?? [], propia: !!p && Array.isArray(p.condiciones_reserva) },
      reserva_resumen: { items: c.reserva_resumen ?? [], propia: !!p && Array.isArray(p.condiciones_reserva_resumen) },
    });
  };

  if (reglasTraslado) {
    const inglesOn = inglesActivo(inglesDisponible(plantillas, reglasTraslado));
    for (const celda of CELDAS_TRASLADO) {
      const u = plantillaTrasladoIA(celda, plantillas, reglasTraslado, { reglas: reglas ?? null, segmento: celda.moneda === "USD" ? "extranjero" : "particular" });
      const nombre = nombreCeldaTraslado(celda);
      const sinUso = celda.idioma === "en" && !inglesOn;
      const prefijo = `${etiquetaCeldaTraslado(celda)}: `;
      const porque = sinUso
        ? "el inglés está apagado: hoy no la usa ninguna cotización (los clientes que escriben en inglés reciben todo en castellano, como hoy)."
        : u.codigo === "regla" ? "por la regla."
          : u.codigo === "sin_plantilla_idioma" ? porqueSinIngles(u.detalle, prefijo, celda, u.plantilla)
            : sinPrefijo(u.detalle, prefijo);
      agregar({
        segmento: null, celda, clave: `${celda.idioma}|${celda.moneda}`, etiqueta: mayuscula(nombre), nombre, usd: celda.moneda === "USD",
        codigo: u.codigo, detalle: u.detalle, porque, ambar: !sinUso && usoEsAmbar(u.codigo), sinUso,
      }, u.plantilla, celda.moneda);
    }
    return grupos;
  }

  for (const segmento of SEGMENTOS) {
    const u = plantillaParaUso({ servicio: "traslado_ia", segmento }, plantillas, reglas);
    const prefijo = `${etiquetaCelda({ servicio: "traslado_ia", segmento })}: `;
    const porque = u.codigo === "regla" ? "por la regla." : sinPrefijo(u.detalle, prefijo);
    const usd = segmento === "extranjero";
    agregar({
      segmento, celda: null, clave: segmento, etiqueta: ETIQUETA_SEGMENTO[segmento], nombre: nombreSegmento(segmento), usd,
      codigo: u.codigo, detalle: u.detalle, porque, ambar: usoEsAmbar(u.codigo), sinUso: false,
    }, u.plantilla, usd ? "USD" : "PEN");
  }
  return grupos;
}

/** «empresa y particular»: las celdas de un grupo que se usan hoy, en minúsculas. */
export function usosTexto(g: Pick<GrupoCondicionesIA, "usos">): string {
  return listaY(g.usos.filter((u) => !u.sinUso).map((u) => u.nombre));
}

/** ¿Todas las celdas de un grupo están sin uso (inglés apagado)? Entonces no se imprime en ningún PDF. */
export const grupoSinUso = (g: Pick<GrupoCondicionesIA, "usos">): boolean => g.usos.length > 0 && g.usos.every((u) => u.sinUso);

/** El enlace al editor de esa plantilla (`?editar=` solo con un id de forma válida: va en la URL). */
export function enlaceEditarPlantilla(id: string | null | undefined): string {
  return id && esIdPlantillaValido(id) ? `/cotizaciones/plantillas?editar=${encodeURIComponent(id)}` : "/cotizaciones/plantillas";
}

/**
 * QUÉ LISTAS DE AJUSTES LEE HOY LA IA, y por tanto se ofrecen y se guardan. `grupos === null` (sin
 * reglas: falta el SQL, o no se pudo comprobar) → las cuatro, en todas las celdas (`usos: null`). Con
 * reglas, solo las de las celdas que caen a Ajustes (sin una plantilla que la IA pueda usar):
 * consideraciones, Incluye y No incluye si cae alguna; las de dólares solo si cae una en dólares. Si
 * no cae ninguna, ninguna: nadie las lee. LAS CELDAS «INGLÉS» NO CUENTAN: nunca caen a Ajustes por su
 * cuenta (caen a su castellano); las que, por caer su castellano a Ajustes, también imprimen estas
 * listas van en `ingles`, para decirlo.
 */
export type UsoListasAjustes = {
  enUso: boolean;
  usd: boolean;
  usos: UsoCeldaIA[] | null;
  /** Cuántas celdas cuentan (los tres segmentos, o las dos de castellano): para decir «las demás». */
  total: number;
  /** Las celdas «inglés» en uso que salen con estas listas (en castellano, en revisión). */
  ingles: UsoCeldaIA[];
};

const cuentaParaAjustes = (u: UsoCeldaIA): boolean => u.celda?.idioma !== "en";

export function listasDeAjustesEnUso(grupos: readonly GrupoCondicionesIA[] | null): UsoListasAjustes {
  if (!grupos) return { enUso: true, usd: true, usos: null, total: 0, ingles: [] };
  const deAjustes = grupos.filter((g) => g.fuente.tipo === "ajustes").flatMap((g) => g.usos);
  const usos = deAjustes.filter(cuentaParaAjustes);
  return {
    enUso: usos.length > 0, usd: usos.some((u) => u.usd), usos,
    total: grupos.flatMap((g) => g.usos).filter(cuentaParaAjustes).length,
    ingles: deAjustes.filter((u) => !cuentaParaAjustes(u) && !u.sinUso),
  };
}

const NOMBRE_MONEDA: Record<Moneda, string> = { PEN: "soles", USD: "dólares" };

/**
 * La línea ámbar sobre las listas editables cuando hay reglas y alguna celda cae a Ajustes: cuáles
 * las usan, que lo demás usa su plantilla y, si las de dólares no las lee nadie, por qué no se
 * ofrecen. Y si una celda «inglés» sale con ellas, que cae a su castellano y queda en revisión. Sin
 * reglas (`usos: null`) o sin celdas que caigan, null (lo dice otra línea).
 */
export function avisoListasAjustes(u: UsoListasAjustes): string | null {
  if (!u.usos || u.usos.length === 0) return null;
  const nuevo = u.usos.some((x) => x.celda != null);
  const todos = u.usos.length >= u.total;
  const nombres = listaY(u.usos.map((x) => x.nombre));
  const partes = [nuevo
    ? `La IA usa estas listas en ${nombres} porque ahí no hay una plantilla que pueda usar (ver arriba): lo que cambies aquí va en el PDF de esas cotizaciones.`
    : `La IA usa estas listas en ${nombres} porque ahí no hay una plantilla que pueda usar (ver arriba): lo que cambies aquí va en el PDF de ${u.usos.length === 1 ? "ese tipo de cliente" : "esos tipos de cliente"}.`,
  ];
  if (!todos) partes.push(nuevo ? "La otra celda usa su plantilla." : "Los demás usan su plantilla.");
  if (!u.usd) partes.push(nuevo ? "Las líneas solo para dólares no se ofrecen: en dólares se usa una plantilla." : "Las líneas solo para dólares no se ofrecen: el tipo de cliente Extranjero usa su plantilla.");
  for (const e of u.ingles) {
    const c = e.celda as CeldaTraslado;
    partes.push(`Una cotización en inglés en ${NOMBRE_MONEDA[c.moneda]} no tiene plantilla en inglés y cae a ${nombreCeldaTraslado(celdaCastellanoDe(c))}: sale con estas mismas listas, en castellano, y queda en revisión.`);
  }
  partes.push("Para que salgan de una plantilla, asígnala en Plantillas PDF.");
  return partes.join(" ");
}

/**
 * Una fuente cuyas consideraciones hablan de otros minutos que la espera gratis: una plantilla
 * (`plantilla`), o las listas de Ajustes (`plantilla: null`, todas las celdas que caen a ellas
 * juntas: son el mismo texto, y avisarlo dos veces sería ruido). `quienes`: las celdas, en minúsculas.
 */
export type EsperaDistinta = { clave: string; plantilla: PlantillaFila | null; quienes: string[]; minutos: number[]; texto: string };

/**
 * `minutosQueNoCoinciden` contra las consideraciones generales que la IA copia de VERDAD (las de la
 * plantilla de cada celda, o las de Ajustes donde no hay plantilla), con la frase que nombra cuál
 * corregir. Con reglas, las listas de Ajustes solo se imprimen donde no hay plantilla: compararlas
 * en todos los casos avisaría de un texto que ningún PDF dice, y callaría el que sí. Una plantilla
 * que solo usan celdas sin uso (el inglés apagado) no la imprime nadie: no se avisa.
 */
export function esperaQueNoCoincideIA(grupos: readonly GrupoCondicionesIA[], esperaMin: number): EsperaDistinta[] {
  const out: EsperaDistinta[] = [];
  const habla = (m: number[]) => m.map((x) => `${x} min`).join(", ");
  for (const g of grupos) {
    if (g.fuente.tipo !== "plantilla" || grupoSinUso(g)) continue;
    const minutos = minutosQueNoCoinciden(g.generales.items, esperaMin);
    if (minutos.length === 0) continue;
    const p = g.fuente.plantilla;
    out.push({
      clave: g.clave, plantilla: p, quienes: g.usos.filter((u) => !u.sinUso).map((u) => u.nombre), minutos,
      texto: `La plantilla «${p.nombre || p.id}» (traslado de la IA · ${usosTexto(g)}) habla de ${habla(minutos)} y la espera gratis dice ${esperaMin} min: el PDF del traslado diría dos cosas distintas. Corrige sus consideraciones en Plantillas PDF, o el número.`,
    });
  }
  const deAjustes = grupos.filter((g) => g.fuente.tipo === "ajustes");
  if (deAjustes.length > 0) {
    const minutos = minutosQueNoCoinciden(deAjustes.flatMap((g) => g.generales.items), esperaMin);
    const quienes = deAjustes.flatMap((g) => g.usos).filter(cuentaParaAjustes).map((u) => u.nombre);
    if (minutos.length > 0 && quienes.length > 0) {
      out.push({
        clave: "ajustes", plantilla: null, quienes, minutos,
        texto: `Las consideraciones de aquí abajo, que la IA usa en ${listaY(quienes)}, hablan de ${habla(minutos)} y la espera gratis dice ${esperaMin} min: el PDF del traslado diría dos cosas distintas. Corrige el texto o el número.`,
      });
    }
  }
  return out;
}

// ── El inglés del traslado de la IA (cotizaciones-09) ─────────────────────────
// SI EL INGLÉS ESTÁ ENCENDIDO LO DICE `inglesDisponible` (el MISMO juicio de la IA): solo una celda
// «Traslado de la IA · inglés» ASIGNADA por una persona a una plantilla en inglés que la IA pueda
// usar. Gris apagado (como hoy: todo en castellano), ámbar a medias (una moneda queda en revisión),
// verde encendido. Es ámbar solo lo que CAMBIA lo que hace el sistema de una forma que hay que mirar.

export type LineasInglesIA = { tono: "gris" | "ambar" | "verde"; titulo: string; lineas: string[] };

export function lineasInglesIA(ingles: InglesTraslado | null | undefined): LineasInglesIA {
  const celda = (moneda: Moneda) => `«${etiquetaCeldaTraslado({ idioma: "en", moneda })}»`;
  if (!ingles) {
    return {
      tono: "gris", titulo: "Inglés: falta el SQL",
      lineas: [`Falta correr ${SQL_REGLAS_TRASLADO} en Supabase → SQL Editor (pegar entero → Run). Hasta entonces la IA cotiza todo en castellano, aunque el cliente escriba en inglés, como hoy.`],
    };
  }
  const detecta = "El idioma lo detecta el sistema en los mensajes del cliente (no la IA).";
  if (!inglesActivo(ingles)) {
    return {
      tono: "gris", titulo: "Inglés apagado",
      lineas: [
        "Ninguna celda «Traslado de la IA · inglés» tiene una plantilla en inglés: los clientes que escriben en inglés reciben todo en castellano, como hoy.",
        `Para encenderlo, asigna una plantilla corporativa en inglés a ${celda("USD")} y a ${celda("PEN")} en Plantillas PDF. Con el inglés encendido, un cliente que escribe en inglés recibe el PDF y los mensajes en inglés y en dólares aunque escriba desde un número peruano, salvo que pida soles.`,
      ],
    };
  }
  if (ingles.PEN && ingles.USD) {
    return {
      tono: "verde", titulo: "Inglés encendido",
      lineas: [
        "Los clientes que escriben en inglés reciben el PDF y los mensajes en inglés: en dólares aunque escriban desde un número peruano, y en soles si los piden.",
        "Los que escriben en otro idioma (portugués, francés, alemán, italiano) reciben inglés, con la moneda de su número salvo que pidan otra.",
        detecta,
      ],
    };
  }
  const on: Moneda = ingles.USD ? "USD" : "PEN";
  const falta: Moneda = on === "USD" ? "PEN" : "USD";
  return {
    tono: "ambar", titulo: `Inglés encendido solo en ${NOMBRE_MONEDA[on]}`,
    lineas: [
      on === "USD"
        ? "Los clientes que escriben en inglés reciben el PDF y los mensajes en inglés, en dólares aunque escriban desde un número peruano."
        : "Un cliente que escribe en inglés se cotiza en dólares salvo que pida soles, y en dólares no hay plantilla en inglés: casi toda cotización en inglés irá con las condiciones en castellano y quedará en revisión.",
      `Una cotización en inglés en ${NOMBRE_MONEDA[falta]} sale con las condiciones de «${etiquetaCeldaTraslado({ idioma: "es", moneda: falta })}» (en castellano) y queda en revisión: asigna una plantilla en inglés a ${celda(falta)} en Plantillas PDF.`,
      detecta,
    ],
  };
}

// ── Lo que dice el Simulador ─────────────────────────────────────────────────

/**
 * Lo que el simulador dice de las condiciones del PDF, desde `respuesta.plantilla` y
 * `respuesta.condiciones` (lib/traslados/api.ts). Valida la forma (viene de la red). Una respuesta
 * que no trae ninguno de los dos (un servidor de antes) → null: no se dice nada, porque callar es
 * mejor que afirmar una fuente que no se sabe. `enlace`: dónde se arregla. Con la regla nueva la
 * respuesta trae la `celda` idioma × moneda, y se nombra esa en vez del segmento.
 */
export type CondicionesSimuladasPantalla = {
  texto: string;
  detalle: string | null;
  nota: string | null;
  ambar: boolean;
  enlace: { tipo: "plantilla"; href: string } | { tipo: "plantillas"; href: string } | { tipo: "ajustes" } | null;
};

const CODIGOS_USO: readonly CodigoUso[] = ["regla", "principal", "regla_inactiva", "regla_no_sirve_ia", "sin_reglas", "sin_plantilla", "sin_plantilla_idioma"];
const esCodigoUso = (x: unknown): x is CodigoUso => typeof x === "string" && (CODIGOS_USO as readonly string[]).includes(x);
const esSegmento = (x: unknown): x is Segmento => typeof x === "string" && (SEGMENTOS as readonly string[]).includes(x);
/** La celda idioma × moneda de la respuesta, solo con los valores EXACTOS del CHECK de cotizaciones-09. */
const celdaDeRespuesta = (x: unknown): CeldaTraslado | null => {
  if (!x || typeof x !== "object") return null;
  const c = x as { idioma?: unknown; moneda?: unknown };
  return (c.idioma === "es" || c.idioma === "en") && (c.moneda === "PEN" || c.moneda === "USD") ? { idioma: c.idioma, moneda: c.moneda } : null;
};
const textoCorto = (x: unknown, max: number): string | null =>
  (typeof x === "string" && x.trim() ? Array.from(x.trim()).slice(0, max).join("") : null);
const enMinuscula = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);

export function condicionesDelSimulador(r: { plantilla?: unknown; condiciones?: unknown } | null | undefined): CondicionesSimuladasPantalla | null {
  if (!r) return null;
  const p = r.plantilla as { id?: unknown; nombre?: unknown; segmento?: unknown; codigo?: unknown; celda?: unknown } | null | undefined;
  const c = r.condiciones as { fuente?: unknown; segmento?: unknown; codigo?: unknown; detalle?: unknown; celda?: unknown } | null | undefined;
  const cond = c && typeof c === "object" && esCodigoUso(c.codigo)
    ? {
      fuente: c.fuente === "plantilla" ? ("plantilla" as const) : ("ajustes" as const), segmento: esSegmento(c.segmento) ? c.segmento : null,
      celda: celdaDeRespuesta(c.celda), codigo: c.codigo, detalle: textoCorto(c.detalle, 400),
    }
    : null;
  const celdaVieja = (s: Segmento) => enMinuscula(etiquetaCelda({ servicio: "traslado_ia", segmento: s }));
  const celdaNueva = (x: CeldaTraslado) => enMinuscula(etiquetaCeldaTraslado(x));
  // Sin cliente del ERP el segmento sale de la moneda: en soles es «particular» (un cliente empresa
  // usaría la celda «empresa», que el simulador no puede probar). Con la regla nueva no hay tipo de
  // cliente: no hay nada que avisar.
  const notaDe = (s: Segmento | null) => (s === "particular"
    ? "El simulador no tiene un cliente del ERP: en soles el segmento es «particular». Un cliente empresa (B2B) ya verificado usaría la regla «Traslado de la IA · empresa»."
    : null);
  const asignar = { tipo: "plantillas" as const, href: "/cotizaciones/plantillas" };

  const pCelda = p && typeof p === "object" ? celdaDeRespuesta(p.celda) : null;
  if (p && typeof p === "object" && typeof p.id === "string" && p.id.trim() && (pCelda || esSegmento(p.segmento)) && esCodigoUso(p.codigo)) {
    const nombre = textoCorto(p.nombre, 120) ?? p.id;
    if (pCelda && p.codigo === "sin_plantilla_idioma") {
      // La cotización va en inglés y las condiciones salen de la plantilla de castellano: en revisión.
      return {
        texto: `Condiciones del PDF: plantilla «${nombre}», en castellano (${celdaNueva(pCelda)} no tiene una plantilla en inglés)`,
        detalle: cond?.detalle ?? null, nota: null, ambar: true, enlace: asignar,
      };
    }
    return {
      texto: `Condiciones del PDF: plantilla «${nombre}» (${pCelda ? celdaNueva(pCelda) : celdaVieja(p.segmento as Segmento)})`,
      // Por la regla no hace falta decir más; si no, la frase del motor dice por qué esa.
      detalle: p.codigo === "regla" ? null : cond?.detalle ?? null,
      nota: pCelda ? null : notaDe(p.segmento as Segmento),
      ambar: usoEsAmbar(p.codigo),
      enlace: { tipo: "plantilla", href: enlaceEditarPlantilla(p.id) },
    };
  }
  if (!cond) return null;
  const nota = cond.celda ? null : notaDe(cond.segmento);
  if (cond.fuente === "plantilla") {
    // La respuesta dice que hay plantilla pero no cuál (no debería pasar): se dice lo que se sabe.
    return { texto: "Condiciones del PDF: las de una plantilla PDF", detalle: cond.detalle, nota, ambar: usoEsAmbar(cond.codigo), enlace: asignar };
  }
  if (cond.codigo === "sin_reglas") {
    return {
      texto: `Condiciones del PDF: las de Ajustes de traslados (falta el SQL ${SQL_PLANTILLAS_USO})`,
      detalle: "Al correrlo, las condiciones del traslado pasan a las plantillas «Traslados (IA)» y se editan en Plantillas PDF.",
      nota: null, ambar: true, enlace: { tipo: "ajustes" },
    };
  }
  if (cond.codigo === "sin_plantilla_idioma" && cond.celda) {
    return {
      texto: `Condiciones del PDF: las de Ajustes de traslados, en castellano (${celdaNueva(cond.celda)} no tiene una plantilla en inglés)`,
      detalle: cond.detalle, nota: null, ambar: true, enlace: asignar,
    };
  }
  if (cond.codigo === "sin_plantilla") {
    return {
      texto: "Condiciones del PDF: las de Ajustes de traslados — hay reglas, pero ninguna plantilla que la IA pueda dibujar",
      detalle: `${cond.detalle ? `${cond.detalle} ` : ""}${cond.celda
        ? `La IA solo dibuja una plantilla activa, de diseño Corporativo y en el idioma de la cotización: asígnale una a ${celdaNueva(cond.celda)} en Plantillas PDF.`
        : "La IA solo dibuja una plantilla activa, de diseño Corporativo y en castellano: asígnale una en Plantillas PDF."}`,
      nota, ambar: true, enlace: asignar,
    };
  }
  return { texto: "Condiciones del PDF: las de Ajustes de traslados", detalle: cond.detalle, nota, ambar: usoEsAmbar(cond.codigo), enlace: { tipo: "ajustes" } };
}

// ── El idioma en el Simulador ────────────────────────────────────────────────
// «Lo que escribió el cliente» se escribe un mensaje por renglón, como se lee un chat: el de abajo es
// el más reciente. Al servidor van (`mensajes_cliente`) en ESE orden, del más antiguo al más reciente
// (POST /api/traslados/simular los da vuelta para `idiomaDelCliente`, que los lee del más reciente al
// más antiguo), y como mucho los 10 últimos de 500 caracteres. Qué idioma se lee lo decide
// `idiomaDelCliente`, la MISMA detección que el chat: aquí solo se usa para habilitar «Pide soles»
// mientras se escribe; lo que vale es lo que contesta el servidor, que además aplica el interruptor
// del inglés.

export const MAX_MENSAJES_SIMULADOR = 10;
export const MAX_CARACTERES_MENSAJE_SIMULADOR = 500;

/** Recorta a `n` unidades de UTF-16 (como cuenta `.length` el servidor) sin partir un emoji. */
function recortarUtf16(t: string, n: number): string {
  if (t.length <= n) return t;
  let s = t.slice(0, n);
  const ultimo = s.charCodeAt(s.length - 1);
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) s = s.slice(0, -1);
  return s;
}

/**
 * Los mensajes del cliente escritos en el simulador (un renglón = un mensaje), en el orden del chat:
 * del más antiguo al más reciente (el de abajo). Los 10 últimos, de 500 unidades como mucho.
 */
export function mensajesDelSimulador(texto: string | null | undefined): string[] {
  return String(texto ?? "")
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-MAX_MENSAJES_SIMULADOR)
    .map((l) => recortarUtf16(l, MAX_CARACTERES_MENSAJE_SIMULADOR));
}

/**
 * El idioma de esos mensajes (en el orden del chat) con la detección del chat (`idiomaDelCliente`,
 * que los lee del más reciente al más antiguo: se dan vuelta). No llevan fecha, así que la ventana de
 * 48 h no deja fuera ninguno (un mensaje sin `created_at` cuenta como reciente): el «ahora» no
 * cambia nada y no se pide.
 */
export function idiomaDeMensajesSimulador(mensajesDelChat: readonly string[]) {
  return idiomaDelCliente([...mensajesDelChat].reverse().map((contenido) => ({ contenido, tipo: "texto" })), Number.NaN);
}

/** «Pide soles» solo tiene sentido si el cliente escribe en inglés u otro idioma: en castellano desde un número extranjero lo ve un ejecutivo. */
export const puedePedirSoles = (i: IdiomaCliente | null | undefined): boolean => i === "en" || i === "otro";

const MONEDA_POR: Record<CodigoMoneda, string> = {
  peru: "número peruano", extranjero: "número extranjero", sin_telefono: "sin número",
  pide_dolares: "pidió dólares", ingles: "cliente en inglés", pide_soles: "pidió soles",
};
const CODIGOS_IDIOMA: readonly (CodigoIdiomaCliente | "ingles_apagado")[] = ["sin_evidencia", "castellano", "ingles", "otro_idioma", "ingles_apagado"];

export type IdiomaSimuladoPantalla = {
  texto: string;
  detalle: string | null;
  tono: "gris" | "azul";
  /** Dónde se enciende el inglés (solo con el inglés apagado). */
  enlace: string | null;
  /** El PDF de ejemplo sale en inglés. */
  ingles: boolean;
};

/**
 * La línea del idioma en el resultado del simulador, desde `respuesta.idioma` (lib/traslados/api.ts →
 * `IdiomaSimulado`). Valida la forma: una respuesta sin ese campo (un servidor de antes) o deforme →
 * null, no se dice nada. Sin mensajes escritos y en castellano sin evidencia tampoco: es lo de siempre.
 * La moneda es la del resultado del MOTOR; su porqué se recalcula con `monedaDelPedido` (la misma
 * función) y solo se nombra si da la misma moneda: nunca se afirma un motivo que no es el del motor.
 */
export function idiomaDelSimulador(
  r: { idioma?: unknown; resultado?: { moneda?: unknown } | null } | null | undefined,
  entrada: { telefono?: string | null; pide_dolares?: boolean; pide_soles?: boolean; mensajes_cliente?: readonly string[] },
): IdiomaSimuladoPantalla | null {
  const i = r?.idioma as { idioma?: unknown; cliente?: unknown; codigo?: unknown; detalle?: unknown } | null | undefined;
  if (!i || typeof i !== "object") return null;
  if (i.idioma !== "es" && i.idioma !== "en") return null;
  const cliente: IdiomaCliente | null = i.cliente === "es" || i.cliente === "en" || i.cliente === "otro" ? i.cliente : null;
  if (i.cliente != null && cliente == null) return null;
  if (typeof i.codigo !== "string" || !(CODIGOS_IDIOMA as readonly string[]).includes(i.codigo)) return null;
  const codigo = i.codigo as CodigoIdiomaCliente | "ingles_apagado";
  const mensajes = Array.isArray(entrada.mensajes_cliente) ? entrada.mensajes_cliente : [];
  const detalle = textoCorto(i.detalle, 400);
  if (mensajes.length === 0 && i.idioma === "es" && codigo === "sin_evidencia") return null;

  if (codigo === "ingles_apagado") {
    // La frase del servidor dice el motivo exacto (sin la regla nueva, sin poder leer las plantillas,
    // o ninguna celda «inglés» asignada); sin ella, la de siempre.
    return {
      texto: "Inglés apagado: no hay plantilla en inglés asignada",
      detalle: detalle ?? `El cliente escribe en ${cliente === "otro" ? "otro idioma" : "inglés"}, pero ninguna celda «Traslado de la IA · inglés» tiene una plantilla en inglés que la IA pueda usar: la cotización sale en castellano y con la moneda de siempre, como hoy.`,
      tono: "gris", enlace: "/cotizaciones/plantillas", ingles: false,
    };
  }
  const en = i.idioma === "en";
  const local = idiomaDeMensajesSimulador(mensajes);
  const n = local.idioma === cliente ? local.decisivos : 0;
  const cuantos = n > 0 ? ` (${n} ${n === 1 ? "mensaje" : "mensajes"})` : cliente == null ? " (ningún mensaje dice el idioma)" : "";
  const idiomaTxt = en ? (cliente === "otro" ? "inglés, porque el cliente escribe en otro idioma" : "inglés") : "castellano";
  const moneda = r?.resultado?.moneda === "PEN" || r?.resultado?.moneda === "USD" ? (r.resultado.moneda as Moneda) : null;
  let monedaTxt = "";
  if (moneda) {
    const m = monedaDelPedido(entrada.telefono ?? null, entrada.pide_dolares === true, {
      idiomaCliente: en && (cliente === "en" || cliente === "otro") ? cliente : null, pideSoles: entrada.pide_soles === true,
    });
    monedaTxt = m.moneda === moneda ? ` · moneda ${moneda} (${MONEDA_POR[m.codigo]})` : ` · moneda ${moneda}`;
  }
  return { texto: `Idioma: ${idiomaTxt}${cuantos}${monedaTxt}`, detalle, tono: en ? "azul" : "gris", enlace: null, ingles: en };
}

// ── Fotos y descripción de la categoría (traslados-07) ───────────────────────
// Las fotos y la descripción que el cliente ve en el PDF de la cotización de traslado. Qué foto es
// un JPEG aceptable lo dice `revisarJpeg` (lib/traslados/fotos-categoria.ts, el mismo control del
// servidor); qué descripción se imprime lo dice `descripcionCategoria` (cotizacion-traslado.ts).
// Aquí solo: qué no se puede leer en el navegador, de dónde viene una foto de la flota, cómo se
// guarda el texto y cómo se dice cada respuesta de la subida.

const MARCAS_HEIF = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/**
 * ¿Es una foto HEIC/HEIF (la del iPhone)? El navegador no la convierte a JPEG, así que se rechaza
 * ANTES de intentarlo, diciendo por qué. Por el tipo, la extensión o la firma (`ftyp` + marca);
 * un AVIF (misma familia, otra marca) sí lo leen los navegadores y no cuenta.
 */
export function esHeic(tipo: string | null | undefined, nombre: string | null | undefined, cabecera?: Uint8Array | null): boolean {
  if (/^image\/hei[cf](-sequence)?$/i.test(String(tipo ?? "").trim())) return true;
  if (/\.(heic|heif)$/i.test(String(nombre ?? "").trim())) return true;
  const b = cabecera ?? null;
  if (!b || b.length < 12) return false;
  const txt = (i: number, n: number) => String.fromCharCode(...Array.from(b.subarray(i, i + n)));
  return txt(4, 4) === "ftyp" && MARCAS_HEIF.has(txt(8, 4).toLowerCase());
}

export const MOTIVO_HEIC = "Es una foto HEIC (la del iPhone) y el navegador no la puede convertir. Elígela desde la galería como JPG o PNG (en el iPhone: Ajustes → Cámara → Formatos → «Más compatible»), o sube una captura de pantalla de la foto.";

/** Caracteres como los cuenta la base (`char_length`): un emoji es uno, no dos. */
export const largoTexto = (t: string): number => Array.from(t).length;

/**
 * La descripción para el cliente tal como se GUARDA: en renglones (cada salto de línea se imprime en
 * el PDF), cada renglón sin espacios de más y sin renglones vacíos. Vacía = null: el PDF usa la frase
 * por defecto. La MISMA limpieza con que la imprime `descripcionCategoria`.
 */
export function descripcionParaGuardar(texto: string | null | undefined): string | null {
  const t = normalizarDescripcionCliente(texto);
  return t ? t : null;
}

/** Por qué no se puede guardar esta descripción (ya limpia), o null si se puede. */
export function motivoDescripcionLarga(nueva: string | null): string | null {
  if (!nueva) return null;
  const n = largoTexto(nueva);
  if (n > MAX_DESCRIPCION_CLIENTE) return `Tiene ${n} caracteres y el máximo es ${MAX_DESCRIPCION_CLIENTE}.`;
  const r = nueva.split("\n").length;
  if (r > MAX_RENGLONES_CLIENTE) return `Tiene ${r} renglones y el máximo es ${MAX_RENGLONES_CLIENTE}.`;
  return null;
}

/** El CHECK viejo (traslados-07, 300 caracteres) rechazó el guardado: falta correr traslados-08. */
export const SQL_DESCRIPCION_LARGA = "supabase/traslados-08-descripcion-larga.sql";
export function esTopeViejoDescripcion(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return !!error && (error.code === "23514" || /check constraint/i.test(String(error.message ?? "")))
    && /traslado_categorias_descripcion_ck/.test(String(error.message ?? ""));
}
export const MOTIVO_TOPE_VIEJO = `La base todavía acepta hasta 300 caracteres. Para guardar una descripción más larga hay que correr ${SQL_DESCRIPCION_LARGA} en el SQL Editor de Supabase (pegar entero → Run).`;

/** De dónde viene una foto de la ficha de una unidad, para saber si se puede copiar a la categoría. */
export type OrigenFoto =
  /** El almacenamiento PÚBLICO del propio Supabase: se baja, se achica y se sube como foto nueva. */
  | { tipo: "copiable"; url: string }
  /** Google Drive: no se puede copiar desde el navegador; se descarga y se sube a mano. */
  | { tipo: "drive"; url: string; miniatura: string | null }
  /** Un bucket privado del proyecto, otro proyecto u otro sitio: tampoco se copia. */
  | { tipo: "otro"; url: string };

const RUTA_PUBLICA_STORAGE = "/storage/v1/object/public/";

/** El origen de una URL de foto de la flota (`vehiculos` / `vehiculos_tercero`), o null si no hay. */
export function origenFoto(url: string | null | undefined, supabaseUrl: string | null | undefined): OrigenFoto | null {
  const crudo = String(url ?? "").trim();
  if (!crudo) return null;
  let u: URL;
  try { u = new URL(crudo); } catch { return { tipo: "otro", url: crudo }; }
  if (/(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/i.test(u.hostname)) {
    const m = crudo.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || crudo.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    return { tipo: "drive", url: crudo, miniatura: m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w400` : null };
  }
  let base: URL | null = null;
  try { base = supabaseUrl ? new URL(supabaseUrl) : null; } catch { base = null; }
  const propio = !!base && u.protocol === "https:" && u.host === base.host && !u.username && !u.password;
  if (propio && u.pathname.startsWith(RUTA_PUBLICA_STORAGE) && !u.pathname.includes("..")) {
    let bucket = "";
    try { bucket = decodeURIComponent(u.pathname.slice(RUTA_PUBLICA_STORAGE.length).split("/")[0] ?? ""); } catch { bucket = ""; }
    if (bucket && !(BUCKETS_PRIVADOS as readonly string[]).includes(bucket)) return { tipo: "copiable", url: crudo };
  }
  return { tipo: "otro", url: crudo };
}

/** Una unidad de la flota con sus fotos, como sugerencia para la categoría. */
export type UnidadFotos = {
  id: number;
  flota: "propia" | "tercerizada";
  placa: string;
  estado: string | null;
  tipo_vehiculo_costeo: string | null;
  foto_externa_url: string | null;
  foto_interna_url: string | null;
};

/**
 * Las unidades que se SUGIEREN para la categoría: las vigentes (estado distinto de «inactivo»)
 * cuya ficha de costeo es la de la categoría y que tienen al menos una foto. Las propias primero,
 * después por placa. Nunca se elige ninguna sola: la foto de un tercero puede mostrar su logo.
 */
export function sugerenciasFlota(unidades: readonly UnidadFotos[], tipoVehiculo: string | null | undefined): UnidadFotos[] {
  const tipo = String(tipoVehiculo ?? "").trim();
  if (!tipo) return [];
  return unidades
    .filter((u) => String(u.tipo_vehiculo_costeo ?? "").trim() === tipo)
    .filter((u) => String(u.estado ?? "").trim().toLowerCase() !== "inactivo")
    .filter((u) => String(u.foto_externa_url ?? "").trim() || String(u.foto_interna_url ?? "").trim())
    .slice()
    .sort((a, b) => (a.flota === b.flota ? 0 : a.flota === "propia" ? -1 : 1) || a.placa.localeCompare(b.placa));
}

/** Lo que responde /api/traslados/categorias/foto. */
export type RespuestaFoto = { ok?: boolean; codigo?: string; detalle?: string; url?: string | null } | null;

/**
 * El mensaje de una respuesta de la subida (o del quitar) de una foto, enrutado por CÓDIGO.
 * `sinMigracion`: falta traslados-07 (la pantalla pasa a decirlo en ámbar).
 */
export function mensajeRespuestaFoto(status: number, d: RespuestaFoto, accion: "subir" | "quitar" = "subir"): { codigo: string; detalle: string; sinMigracion: boolean } {
  const codigo = String(d?.codigo ?? (status === 401 ? "sin_sesion" : status === 404 && !d ? "sin_despliegue" : "error"));
  const de = (detalle: string, sinMigracion = false) => ({ codigo, detalle, sinMigracion });
  const que = accion === "subir" ? "No se guardó la foto" : "No se quitó la foto";
  if (codigo === "sin_migracion") {
    return de(/traslados-0/.test(d?.detalle ?? "") ? `${que}: ${d?.detalle}` : `${que}: falta correr ${SQL_FOTOS_CATEGORIA} en Supabase (SQL Editor → pegar entero → Run).`, true);
  }
  if (status === 401) return de(`${que}: tu sesión venció o no se pudo verificar. Vuelve a ingresar.`);
  if (status === 403) {
    return de(codigo === "origen"
      ? `${que}: el servidor rechazó la llamada (origen no permitido). Abre el ERP desde su dirección oficial.`
      : `${que}: te falta el permiso del módulo Tarifas (lo da un administrador en Usuarios).`);
  }
  if (codigo === "sin_despliegue") return de(`${que}: la subida de fotos todavía no está desplegada en el servidor (/api/traslados/categorias/foto).`);
  if (codigo === "sin_categoria") return de(`${que}: esta categoría ya no existe en la base (alguien la borró). Pulsa «↻ Recargar».`);
  if (codigo === "cambio_concurrente") return de(`${que}: otra persona cambió esta foto mientras tanto. Pulsa «↻ Recargar» y vuelve a intentarlo.`);
  if (codigo === "tope") return de(`${que}: ${d?.detalle || "demasiadas fotos seguidas; espera un minuto."}`);
  if (status === 413 || status === 422) return de(`${que}: ${d?.detalle || "la foto no es un JPEG que el PDF pueda usar."}`);
  if (status >= 500) return de(`${que}: ${d?.detalle || "el servidor no respondió bien. Vuelve a intentarlo en un momento."}`);
  return de(`${que}: ${d?.detalle || `el servidor respondió ${status}.`}`);
}
