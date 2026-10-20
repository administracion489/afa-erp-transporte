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
import { zonaConEnvio } from "@/lib/traslados/envio-ia";
import { BUCKETS_PRIVADOS } from "@/lib/storage-privado";

/** `envio_automatico` es de traslados-05: sin esa migración llega `undefined`, que es «no». */
export type ZonaFila = Zona & { notas?: string | null; envio_automatico?: boolean | null };
export type TarifaFila = TarifaTraslado & { id: number; notas?: string | null };
/**
 * Las tres últimas son de traslados-07 (lo que el PDF de la IA enseña de la categoría): sin esa
 * migración llegan `null` y la pantalla lo dice nombrando el SQL. El motor no las lee.
 */
export type CategoriaFila = CategoriaTraslado & {
  foto_externa_url?: string | null;
  foto_interna_url?: string | null;
  descripcion_cliente?: string | null;
};

/** La migración que agrega las fotos y la descripción de la categoría, y las listas Incluye / No incluye. */
export const SQL_FOTOS_CATEGORIA = "supabase/traslados-07-fotos-categoria.sql";

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
 * La descripción para el cliente tal como se GUARDA: espacios y saltos colapsados (el PDF la
 * imprime como un solo párrafo) y sin bordes. Vacía = null: el PDF usa la frase por defecto.
 */
export function descripcionParaGuardar(texto: string | null | undefined): string | null {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
}

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
