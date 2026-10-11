// lib/combustible/grifo-canonico.ts — Quién es el grifo: UNA identidad por empresa, no una por redacción.
// Módulo PURO (no toca la base): recibe las filas ya leídas y devuelve el nombre que se guarda. Lo
// consumen el Radar (lib/radar/acciones.ts), la conciliación de facturas
// (lib/combustible/facturas-correo.ts) y la vista «🏪 Por grifo» de /combustible. Lo prueba
// scripts/prueba-grifo-canonico.mts. El que lee está en lib/combustible/grifo-canonico-datos.ts.
//
// EL CASO. La misma empresa entraba escrita de varias formas —«COESTI S.A.», «COESTI», «Coesti SA»,
// «CORATI SA COESTI»— y el ERP la trataba como empresas distintas: «Por grifo» la partía en varias
// filas, y el saldo de la cuenta prepago, que reconoce sus cargas por el nombre o el RUC del grifo,
// dependía de que la IA escribiera bien. Y a veces no escribía nada: la nota de la CWZ-371 del
// 11/10/2026 tenía el encabezado «COESTI S.A. - RUC: 20127765279» legible y la carga quedó sin grifo.
//
// LA REGLA: EL RUC MANDA, Y EL NOMBRE QUE SE GUARDA ES EL DE LA FACTURA SUNAT.
//  · El RUC son 11 cifras con dígito verificador: si coincide con el de un vendedor que el ERP ya
//    conoce, no hay parecido que discutir. El nombre canónico de ese RUC es la razón social que trae
//    el XML de su factura electrónica (`radar_facturas.razon_social`): es lo que el propio proveedor
//    declaró ante SUNAT, no lo que alguien tecleó. A falta de factura, el nombre más repetido entre las
//    cargas que ya llevan ese RUC (las que registra la factura llevan esa misma razón social).
//  · Sin RUC, el nombre leído CONTIENE, como palabras completas, la parte distintiva de una razón
//    social conocida (sin la forma societaria): «CORATI SA COESTI» contiene «COESTI» → COESTI S.A.
//    Nunca «contiene» a secas («PRIMAXIMO» no es PRIMAX), y nunca una palabra genérica sola
//    («SERVICENTRO S.A.C.» no se come a todos los servicentros del país).
//  · La marca de la estación NO es la empresa: una estación «Primax» puede operarla COESTI o un
//    concesionario con otro RUC. Por eso «PRIMAX» no se convierte en COESTI S.A. por nombre.
//  · Un RUC leído que contradice al nombre (válido, de OTRO vendedor o desconocido) no se pisa con el
//    nombre: se conserva lo leído. Equivocarse ahí sería atribuirle a un grifo las cargas de otro.
//
// EL CATÁLOGO SE DERIVA DE LOS DATOS, NO DE UNA LISTA EN EL CÓDIGO. Este ERP se vende: los grifos de
// otra empresa son otros, y los RUC y razones sociales que sí son de fiar ya están en la base (las
// facturas del correo, la cuenta prepago, las cargas con RUC). Un grifo nuevo entra solo en cuanto
// llega su primera factura.

import { normEmpresa } from "@/lib/radar/identidad-voucher";

const soloDigitos = (s?: string | null) => String(s ?? "").replace(/\D/g, "");

/**
 * El RUC si es un RUC peruano de verdad: 11 cifras, prefijo de contribuyente (10, 15, 16, 17 o 20) y
 * dígito verificador correcto (módulo 11, pesos 5 4 3 2 7 6 5 4 3 2). Un RUC mal leído en una cifra
 * casi nunca pasa la verificación, así que esto separa una lectura de un número que se parece.
 */
export function rucValido(s?: string | null): string | null {
  const r = soloDigitos(s);
  if (r.length !== 11 || !/^(10|15|16|17|20)/.test(r)) return null;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(r[i]), 0);
  const resto = 11 - (suma % 11);
  const verificador = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return verificador === Number(r[10]) ? r : null;
}

/**
 * Palabras que, solas, no distinguen a ninguna empresa de combustible. Una razón social cuya parte
 * distintiva sea solo esto («GRIFO SERVICENTRO S.A.C.») se reconoce por su RUC, nunca por el nombre.
 */
const GENERICAS = new Set([
  "GRIFO", "GRIFOS", "ESTACION", "ESTACIONES", "SERVICIO", "SERVICIOS", "SERVICENTRO", "SERVICENTROS",
  "COMBUSTIBLE", "COMBUSTIBLES", "PETROLEO", "PETROLEOS", "PETROLERA", "GAS", "GNV", "GLP", "DIESEL",
  "CORPORACION", "INVERSIONES", "NEGOCIACIONES", "NEGOCIACION", "EMPRESA", "COMERCIAL", "COMERCIALIZADORA",
  "DISTRIBUIDORA", "GRUPO", "PERU", "DEL", "DE", "LA", "EL", "LOS", "LAS", "Y", "E", "S", "A", "C",
]);

/** La parte del nombre que identifica a la empresa, o null si no distingue a nadie. */
export function claveDistintiva(nombre?: string | null): string | null {
  const n = normEmpresa(nombre);
  if (n.length < 4) return null;
  const distintivas = n.split(" ").filter((t) => t.length >= 4 && !GENERICAS.has(t) && !/^\d+$/.test(t));
  return distintivas.length ? n : null;
}

export type GrifoConocido = {
  ruc: string;
  /** Razón social canónica. null si del RUC solo se sabe que es de un vendedor (la cuenta prepago). */
  nombre: string | null;
};

export type CatalogoGrifos = {
  porRuc: Map<string, GrifoConocido>;
  /** Las entradas con nombre y clave distintiva, para reconocer un nombre sin RUC. */
  porClave: { clave: string; grifo: GrifoConocido }[];
};

export const CATALOGO_VACIO: CatalogoGrifos = { porRuc: new Map(), porClave: [] };

export type FuentesCatalogo = {
  /** Facturas del correo (`radar_facturas`): la razón social que el emisor declaró ante SUNAT. */
  facturas?: { ruc_emisor?: string | null; razon_social?: string | null }[];
  /** Cuentas de combustible (`combustible_cuentas.rucs`): vendedores seguros, aunque sin nombre. */
  cuentas?: { rucs?: (string | null)[] | null }[];
  /** Cargas con RUC (`combustible.ruc_proveedor` + `grifo`): las que registró una factura llevan su razón social. */
  cargas?: { ruc_proveedor?: string | null; grifo?: string | null }[];
};

/** El nombre más repetido (por su forma normalizada), devolviendo la redacción más usada de esa forma. */
function masRepetido(nombres: string[]): string | null {
  const porClave = new Map<string, Map<string, number>>();
  for (const bruto of nombres) {
    const n = String(bruto ?? "").trim().replace(/\s+/g, " ");
    const k = normEmpresa(n);
    if (!k) continue;
    const formas = porClave.get(k) ?? new Map<string, number>();
    formas.set(n, (formas.get(n) ?? 0) + 1);
    porClave.set(k, formas);
  }
  let mejor: { total: number; forma: string } | null = null;
  // Orden estable: a igual cantidad gana la clave alfabética, para que dos corridas digan lo mismo.
  for (const k of [...porClave.keys()].sort()) {
    const formas = porClave.get(k)!;
    const total = [...formas.values()].reduce((a, b) => a + b, 0);
    const forma = [...formas.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    if (!mejor || total > mejor.total) mejor = { total, forma };
  }
  return mejor?.forma ?? null;
}

/**
 * Arma el catálogo. Por cada RUC válido, el nombre sale de sus facturas (manda SUNAT) y, si no tiene
 * ninguna, de sus cargas. Un RUC que solo aparece en la cuenta prepago queda sin nombre: sirve para
 * saber que es un vendedor, no para nombrarlo.
 */
export function construirCatalogoGrifos(f: FuentesCatalogo): CatalogoGrifos {
  const deFacturas = new Map<string, string[]>();
  const deCargas = new Map<string, string[]>();
  const rucs = new Set<string>();
  for (const fa of f.facturas ?? []) {
    const r = rucValido(fa.ruc_emisor);
    if (!r) continue;
    rucs.add(r);
    if (fa.razon_social?.trim()) deFacturas.set(r, [...(deFacturas.get(r) ?? []), fa.razon_social]);
  }
  for (const c of f.cuentas ?? []) for (const x of c.rucs ?? []) { const r = rucValido(x); if (r) rucs.add(r); }
  for (const c of f.cargas ?? []) {
    const r = rucValido(c.ruc_proveedor);
    if (!r) continue;
    rucs.add(r);
    if (c.grifo?.trim()) deCargas.set(r, [...(deCargas.get(r) ?? []), c.grifo]);
  }

  const porRuc = new Map<string, GrifoConocido>();
  for (const r of [...rucs].sort()) {
    const nombre = masRepetido(deFacturas.get(r) ?? []) ?? masRepetido(deCargas.get(r) ?? []);
    porRuc.set(r, { ruc: r, nombre });
  }
  const porClave: CatalogoGrifos["porClave"] = [];
  for (const g of porRuc.values()) {
    const clave = claveDistintiva(g.nombre);
    if (clave) porClave.push({ clave, grifo: g });
  }
  return { porRuc, porClave };
}

/** La razón social de un RUC conocido como vendedor de combustible, o null. */
export function grifoPorRuc(cat: CatalogoGrifos, ruc?: string | null): string | null {
  const r = rucValido(ruc);
  return r ? cat.porRuc.get(r)?.nombre ?? null : null;
}

/**
 * El grifo conocido cuyo nombre CONTIENE el leído, como palabras completas. Con dos que calcen, gana
 * el más específico (la clave más larga que contiene a la otra); si siguen siendo dos, ninguno.
 */
export function grifoPorNombre(cat: CatalogoGrifos, nombre?: string | null): GrifoConocido | null {
  const n = ` ${normEmpresa(nombre)} `;
  if (n.trim().length < 4) return null;
  const calzan = cat.porClave.filter((e) => n.includes(` ${e.clave} `));
  if (!calzan.length) return null;
  // Dos claves del MISMO grifo (no pasa: una por RUC) o una contenida en otra → la más larga.
  const especificas = calzan.filter((e) => !calzan.some((o) => o !== e && o.clave.length > e.clave.length && ` ${o.clave} `.includes(` ${e.clave} `)));
  const rucsDistintos = new Set(especificas.map((e) => e.grifo.ruc));
  return rucsDistintos.size === 1 ? especificas[0].grifo : null;
}

export type PorQueGrifo =
  | "ruc"     // el RUC leído es de un vendedor conocido: manda su razón social
  | "nombre"  // sin RUC (o con el mismo RUC), el nombre leído contiene una razón social conocida
  | "leido"   // no se reconoció: se guarda lo que se leyó, limpio
  | "vacio";  // no se leyó grifo ni se pudo deducir

export type ResolucionGrifo = {
  /** El nombre que se guarda en `grifo`. */
  nombre: string | null;
  /** RUC válido del vendedor (el leído, o el del grifo reconocido por nombre). */
  ruc: string | null;
  por: PorQueGrifo;
  /** El nombre guardado difiere del leído (para decirlo, no para alarmar). */
  cambio: boolean;
};

/** Limpia una redacción leída: espacios de más fuera, nada inventado. */
const limpio = (s?: string | null) => {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return t || null;
};

/**
 * El grifo que se guarda a partir de lo leído. Ver la cabecera: el RUC manda, el nombre canónico es el
 * de la factura, y un RUC que contradice al nombre no se pisa.
 */
export function resolverGrifo(leido: { nombre?: string | null; ruc?: string | null }, cat: CatalogoGrifos): ResolucionGrifo {
  const nombreLeido = limpio(leido.nombre);
  const ruc = rucValido(leido.ruc);
  const conCambio = (nombre: string | null, rucFinal: string | null, por: PorQueGrifo): ResolucionGrifo => ({
    nombre,
    ruc: rucFinal,
    por,
    cambio: (nombre ?? "") !== (nombreLeido ?? ""),
  });

  if (ruc) {
    const g = cat.porRuc.get(ruc);
    if (g?.nombre) return conCambio(g.nombre, ruc, "ruc");
  }
  const porNombre = grifoPorNombre(cat, nombreLeido);
  if (porNombre?.nombre && (ruc == null || ruc === porNombre.ruc)) {
    return conCambio(porNombre.nombre, porNombre.ruc, "nombre");
  }
  return conCambio(nombreLeido, ruc, nombreLeido ? "leido" : "vacio");
}

/**
 * La clave con la que se AGRUPA una carga en «Por grifo»: el RUC si lo tiene y es válido; si no, el RUC
 * del grifo que su nombre reconoce; si no, su nombre normalizado. Así «COESTI», «COESTI S.A.» y la
 * carga con RUC 20127765279 caen en la misma fila.
 */
export function claveAgrupacionGrifo(c: { grifo?: string | null; ruc_proveedor?: string | null }, cat: CatalogoGrifos): string | null {
  const r = resolverGrifo({ nombre: c.grifo, ruc: c.ruc_proveedor }, cat);
  if (r.ruc) return `ruc:${r.ruc}`;
  const n = normEmpresa(c.grifo);
  return n ? `nom:${n}` : null;
}
