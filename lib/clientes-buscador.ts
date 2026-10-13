/**
 * Buscador de clientes (combobox) — módulo PURO: no lee la base ni hace fetch.
 *
 * Reemplaza al `<select>` de clientes de /cotizaciones, que listaba la cartera entera
 * ordenada alfabéticamente y obligaba a desplazarse hasta encontrar a alguien.
 *
 * Reglas:
 *  - LA BÚSQUEDA ES LA DE /clientes (`lib/busqueda-texto.ts`): sin mayúsculas, tildes,
 *    signos ni orden de palabras — «compania hard» encuentra «COMPAÑÍA HARD S.A.C.».
 *    Se busca sobre todo lo que /clientes busca (nombre, empresa, RUC, DNI, correo,
 *    ciudad) más el rótulo, el nombre comercial y el teléfono — así nada que se
 *    encuentre en /clientes deja de encontrarse aquí.
 *  - El TELÉFONO se busca también solo en dígitos y sin el prefijo 51: el mismo número
 *    se teclea «987 654 321», «987654321» o «+51987654321».
 *  - Un cliente BLOQUEADO nunca se ofrece (el `<select>` viejo ya lo filtraba), pero si
 *    coincide con la búsqueda se CUENTA: «no aparece» sin decir que existe y está
 *    bloqueado manda a darlo de alta otra vez. Los inactivos sí se ofrecen.
 *  - Orden: documento exacto (RUC/DNI igual a la consulta) → rótulo que EMPIEZA por la
 *    consulta → más cotizaciones → alfabético (es) → id (orden total).
 *    Consulta vacía: más cotizaciones → alfabético → id.
 */
import { coincideBusqueda, normalizarBusqueda, terminosBusqueda } from "./busqueda-texto";

export type ClienteBuscable = {
  id: number;
  nombre: string;
  empresa?: string | null;
  nombre_comercial?: string | null;
  tipo?: string | null;
  ruc?: string | null;
  dni?: string | null;
  telefono?: string | null;
  email?: string | null;
  ciudad?: string | null;
  estado?: string | null;
};

export type UsoCliente = { cotizaciones: number; ultima: string | null }; // ISO

type CotizacionMin = { cliente_id: number | null; created_at: string };

/* ─────────────────────────── Rótulo y documento ─────────────────────────── */

/**
 * Cómo se llama al cliente en la LISTA y en el selector de /cotizaciones
 * (`nomCl(id)` y el `<option>`): b2b → empresa o, si no hay, nombre; b2c → nombre.
 * Sin respaldo para un nombre vacío: es la regla literal de esas dos pantallas.
 */
export function rotuloCliente(c: ClienteBuscable): string {
  return c.tipo === "b2b" ? (c.empresa || c.nombre) : c.nombre;
}

/**
 * Variante de los PDF de /cotizaciones (`nomCl` dentro de cada plantilla):
 * `cliente?.tipo==="b2b"?(cliente.empresa||cliente.nombre):cliente?.nombre||"—"`.
 * Difiere de `rotuloCliente` en dos cosas, ambas por la precedencia del ternario:
 * sin cliente o b2c con nombre vacío imprime «—»; un b2b con empresa Y nombre vacíos
 * imprime cadena vacía (el «—» solo cuelga de la rama b2c).
 */
export function rotuloClienteDocumento(c: ClienteBuscable | null | undefined): string {
  return c?.tipo === "b2b" ? (c.empresa || c.nombre) : c?.nombre || "—";
}

/** «RUC 20…» / «DNI 4…» (el RUC manda, como en el PDF); null sin documento. */
export function documentoCliente(c: ClienteBuscable): string | null {
  const ruc = String(c.ruc ?? "").trim();
  if (ruc) return `RUC ${ruc}`;
  const dni = String(c.dni ?? "").trim();
  if (dni) return `DNI ${dni}`;
  return null;
}

/* ─────────────────────────── Uso y recientes ─────────────────────────── */

function tiempo(iso: string | null | undefined): number {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : -Infinity;
}

/** ¿`a` es más reciente que `b`? Por instante; si no se entiende, por texto. */
function masReciente(a: string, b: string): boolean {
  const ta = tiempo(a), tb = tiempo(b);
  if (ta !== tb) return ta > tb;
  return a > b;
}

/** Cuántas cotizaciones tiene cada cliente y cuándo fue la última. */
export function usoPorCliente(cotizas: CotizacionMin[]): Map<number, UsoCliente> {
  const m = new Map<number, UsoCliente>();
  for (const c of cotizas) {
    if (c.cliente_id == null) continue;
    const u = m.get(c.cliente_id) ?? { cotizaciones: 0, ultima: null };
    u.cotizaciones++;
    if (c.created_at && (u.ultima == null || masReciente(c.created_at, u.ultima))) u.ultima = c.created_at;
    m.set(c.cliente_id, u);
  }
  return m;
}

/** Los `n` clientes cotizados más recientemente, sin repetir, el más reciente primero. */
export function recientesDe(cotizas: CotizacionMin[], n: number): number[] {
  const lim = Math.max(0, Math.floor(Number(n) || 0));
  if (!lim) return [];
  const uso = usoPorCliente(cotizas);
  return [...uso.entries()]
    .sort(([ia, a], [ib, b]) => {
      const ua = a.ultima ?? "", ub = b.ultima ?? "";
      if (ua !== ub) return masReciente(ua, ub) ? -1 : masReciente(ub, ua) ? 1 : 0;
      return ia - ib;
    })
    .slice(0, lim)
    .map(([id]) => id);
}

/* ─────────────────────────── Búsqueda ─────────────────────────── */

const soloDigitos = (s: string | null | undefined) => String(s ?? "").replace(/\D+/g, "");

/**
 * El teléfono en las formas en que se teclea: crudo, solo dígitos, sin el 51 y con el
 * 51 — guardado «987 654 321» se encuentra con «+51987654321», y guardado
 * «+51 987…» con «987654321».
 */
function formasTelefono(tel: string | null | undefined): string[] {
  const crudo = String(tel ?? "").trim();
  if (!crudo) return [];
  const d = soloDigitos(crudo);
  const nacional = d.length > 9 && d.startsWith("51") ? d.slice(2) : d;
  return [...new Set([crudo, d, nacional, nacional ? `51${nacional}` : ""])].filter(Boolean);
}

/** Todo el texto contra el que se busca un cliente («RUC 2012…» incluido: se teclea así). */
export function textoBuscableCliente(c: ClienteBuscable): string {
  return [
    rotuloCliente(c), c.nombre, c.empresa, c.nombre_comercial,
    documentoCliente(c), c.ruc, c.dni, ...formasTelefono(c.telefono), c.email, c.ciudad,
  ].filter(Boolean).join(" ");
}

/** ¿El cliente coincide con los términos (ya normalizados con `terminosBusqueda`)? */
export function coincideCliente(c: ClienteBuscable, terminos: string[]): boolean {
  return coincideBusqueda(textoBuscableCliente(c), terminos);
}

export const esBloqueado = (c: ClienteBuscable) => c.estado === "bloqueado";

export type ResultadoBusqueda = {
  resultados: ClienteBuscable[];
  /** Bloqueados que coinciden: no se ofrecen, pero se dice que existen. */
  bloqueadosCoinciden: number;
  /** Coincidencias elegibles ANTES de aplicar el límite. */
  total: number;
};

export function buscarClientes(
  cl: ClienteBuscable[],
  q: string,
  o?: { uso?: Map<number, UsoCliente>; limite?: number },
): ResultadoBusqueda {
  const terminos = terminosBusqueda(q);
  const qNorm = normalizarBusqueda(q);
  const qDig = soloDigitos(q);
  const uso = o?.uso;

  let bloqueadosCoinciden = 0;
  const elegibles: { c: ClienteBuscable; doc: boolean; prefijo: boolean; usos: number; rotulo: string }[] = [];
  for (const c of cl) {
    if (!coincideCliente(c, terminos)) continue;
    if (esBloqueado(c)) { bloqueadosCoinciden++; continue; }
    const rotulo = rotuloCliente(c) ?? "";
    const doc = !!qDig && (soloDigitos(c.ruc) === qDig || soloDigitos(c.dni) === qDig);
    const prefijo = !!qNorm && normalizarBusqueda(rotulo).startsWith(qNorm);
    elegibles.push({ c, doc, prefijo, usos: uso?.get(c.id)?.cotizaciones ?? 0, rotulo });
  }

  elegibles.sort((a, b) =>
    (Number(b.doc) - Number(a.doc)) ||
    (Number(b.prefijo) - Number(a.prefijo)) ||
    (b.usos - a.usos) ||
    a.rotulo.localeCompare(b.rotulo, "es") ||
    (a.c.id - b.c.id));

  const total = elegibles.length;
  const lim = o?.limite;
  const corte = lim == null || !Number.isFinite(lim) ? total : Math.max(0, Math.floor(lim));
  return { resultados: elegibles.slice(0, corte).map(e => e.c), bloqueadosCoinciden, total };
}

/* ─────────────────────────── Resaltado ─────────────────────────── */

/**
 * Lo que aporta UN carácter del original a la forma normalizada, con la misma regla
 * que `normalizarBusqueda`: sin tildes, minúsculas, el punto desaparece y cualquier
 * otro signo separa (se marca con un espacio).
 */
function fragmento(ch: string): string {
  if (ch === ".") return "";
  const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  let out = "";
  for (const x of base) out += /[a-z0-9]/.test(x) ? x : " ";
  return out;
}

const esMarcaCombinante = (ch: string) => /^[̀-ͯ]$/.test(ch);

/**
 * Rangos `[desde, hasta)` del texto ORIGINAL que coinciden con la consulta, para
 * resaltarlos. Se mapea carácter a carácter (nunca `indexOf` sobre el original), así
 * que «compan» resalta «Compañ» de «Compañía» y «sac» resalta «S.A.C» de «S.A.C.».
 * Busca como `coincideBusqueda` sobre el texto sin espacios, de modo que todo lo que
 * hizo coincidir al cliente se puede resaltar. Ordenados y sin solaparse.
 */
export function tramosResaltados(texto: string, q: string): { desde: number; hasta: number }[] {
  const terminos = terminosBusqueda(q);
  const t = String(texto ?? "");
  if (!terminos.length || !t) return [];

  // Forma «junta»: solo letras y dígitos normalizados, cada uno con su origen.
  let junto = "";
  const origen: { desde: number; hasta: number }[] = [];
  let i = 0;
  for (const ch of t) {
    const len = ch.length; // unidades UTF-16 del code point
    for (const x of fragmento(ch)) {
      if (x === " ") continue;
      junto += x;
      origen.push({ desde: i, hasta: i + len });
    }
    i += len;
  }

  const crudos: { desde: number; hasta: number }[] = [];
  for (const term of terminos) {
    let p = junto.indexOf(term);
    while (p >= 0) {
      const desde = origen[p].desde;
      let hasta = origen[p + term.length - 1].hasta;
      // Un original en forma descompuesta (n + virgulilla) no se parte a la mitad.
      while (hasta < t.length && esMarcaCombinante(t[hasta])) hasta++;
      crudos.push({ desde, hasta });
      p = junto.indexOf(term, p + 1);
    }
  }

  crudos.sort((a, b) => a.desde - b.desde || a.hasta - b.hasta);
  const out: { desde: number; hasta: number }[] = [];
  for (const r of crudos) {
    const ult = out[out.length - 1];
    if (ult && r.desde <= ult.hasta) ult.hasta = Math.max(ult.hasta, r.hasta);
    else out.push({ ...r });
  }
  return out;
}
